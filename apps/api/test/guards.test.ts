import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type PaymentRequirementsDto, paymentRequirementsSchema } from "@till/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import { type GuardContext, createGuards, inFlightWindowSeconds } from "../src/gateway/guards.ts";
import { advancePayment, openPayment } from "../src/services/payments.ts";

/**
 * C8 acceptance tests (GW-5, GW-6): the pre-serve guards, and the claim that makes
 * Guard 3 a gate rather than an opinion.
 *
 * The split the tests have to respect is S6's measurement. Guard 3's *read* cannot
 * be the guarantee -- two requests both see "none" and both serve -- so the
 * guarantee is the read-plus-insert done in one transaction behind a per-payer
 * advisory lock, which is what `openPayment`'s third argument is. The race tests
 * therefore run on a pool of more than one connection: with `max: 1` the pool would
 * serialise them by itself and the test would prove nothing about the lock.
 *
 * Needs `DATABASE_URL`; without a reachable database the file skips.
 */

const UPSTREAM_TIMEOUT_MS = 2000;
const MARGIN_MS = 30_000;
const WINDOW = inFlightWindowSeconds(UPSTREAM_TIMEOUT_MS, MARGIN_MS);

type Handle = { readonly sql: postgres.Sql; readonly db: ReturnType<typeof createTestDb> };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function createTestDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openDatabase(url: string): Promise<Handle> {
  // `max` above 1 on purpose: the concurrency tests need two live connections or
  // the pool is the only thing making them sequential.
  const sql = postgres(url, { max: 8, idle_timeout: 5, connect_timeout: 3 });
  try {
    await sql`select 1`;
    const [present] = await sql`select to_regclass('public.payments') as present`;
    if (present !== undefined && present.present === null) {
      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
      }
    }
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    throw error;
  }
  return { sql, db: createTestDb(sql) };
}

let handle: Handle | null = null;
let skipReason = "DATABASE_URL is not set";
const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl !== "") {
  try {
    handle = await openDatabase(databaseUrl);
  } catch (error) {
    skipReason = `database from DATABASE_URL is unusable: ${message(error)}`;
  }
}

function need(): Handle {
  if (handle === null) {
    throw new Error(`unreachable: the suite should have skipped for "${skipReason}"`);
  }
  return handle;
}

const run = randomUUID().slice(0, 8);
const ids = {
  sellerId: randomUUID(),
  endpointOne: randomUUID(),
  endpointTwo: randomUUID(),
  nearAccount: `till-c8-${run}.testnet`,
  slugOne: `c8-one-${run}`,
  slugTwo: `c8-two-${run}`,
} as const;

const PAYER = `c8-payer-${run}.testnet`;
const OTHER_PAYER = `c8-other-${run}.testnet`;

async function seed(): Promise<void> {
  const { sql } = need();
  await sql`insert into sellers (id, near_account_id, display_name)
    values (${ids.sellerId}, ${ids.nearAccount}, 'C8 fixture')
    on conflict (id) do nothing`;
  for (const [endpointId, slug] of [
    [ids.endpointOne, ids.slugOne],
    [ids.endpointTwo, ids.slugTwo],
  ] as const) {
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode)
      values (${endpointId}, ${ids.sellerId}, ${slug}, 'https://example.test/data',
        '10000', 'usdc.testnet', 'near:testnet', 'direct')
      on conflict (id) do nothing`;
  }
}

/** Two endpoints, so a test can show the gate is keyed on the payer and not the row. */
const ENDPOINTS = { one: ids.endpointOne, two: ids.endpointTwo };

function requirementsOf(maxTimeoutSeconds: number): PaymentRequirementsDto {
  return paymentRequirementsSchema.parse({
    scheme: "exact",
    network: "near:testnet",
    amount: "10000",
    asset: "usdc.testnet",
    payTo: ids.nearAccount,
    maxTimeoutSeconds,
    extra: {},
  });
}

function contextFor(
  input: {
    readonly payer?: string;
    readonly endpointId?: string;
    readonly maxTimeoutSeconds?: number;
  } = {},
): GuardContext {
  return {
    endpointId: input.endpointId ?? ENDPOINTS.one,
    payerAccountId: input.payer ?? PAYER,
    priceAmount: 10_000n,
    assetContract: "usdc.testnet",
    requirements: requirementsOf(input.maxTimeoutSeconds ?? WINDOW + 15),
  };
}

function guardsRunner() {
  return createGuards({
    db: need().db,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    authorizationExpiryMarginMs: MARGIN_MS,
  });
}

type InsertedPayment = {
  readonly id: string;
  readonly payer: string;
  readonly replayKey: string;
};

/**
 * A payment row in a chosen state, as old as the test asks. Written with raw SQL
 * because the service only ever inserts `verified` rows and only moves them forward;
 * a fixture that needs "a row a dead process left behind an hour ago" cannot get it
 * through the door the code uses.
 */
async function insertPayment(input: {
  readonly payer?: string;
  readonly state: string;
  readonly ageSeconds?: number;
  readonly endpointId?: string;
}): Promise<InsertedPayment> {
  const { sql } = need();
  const row: InsertedPayment = {
    id: randomUUID(),
    payer: input.payer ?? PAYER,
    replayKey: `c8-${randomUUID()}`,
  };
  const ageSeconds = input.ageSeconds ?? 0;
  await sql`insert into payments (id, endpoint_id, payer_account_id, amount, asset_contract,
      replay_key, state, verified_at)
    values (${row.id}, ${input.endpointId ?? ENDPOINTS.one}, ${row.payer}, '10000',
      'usdc.testnet', ${row.replayKey}, ${input.state},
      now() - make_interval(secs => ${ageSeconds}::int))`;
  return row;
}

function openInputFor(input: {
  readonly payer?: string;
  readonly endpointId?: string;
  readonly replayKey?: string;
}) {
  return {
    id: randomUUID(),
    endpointId: input.endpointId ?? ENDPOINTS.one,
    payerAccountId: input.payer ?? PAYER,
    amount: 10_000n,
    assetContract: "usdc.testnet",
    replayKey: input.replayKey ?? `c8-${randomUUID()}`,
  };
}

async function countRows(payer: string): Promise<number> {
  const { sql } = need();
  const [row] =
    await sql`select count(*)::int as n from payments where payer_account_id = ${payer}`;
  return row?.n ?? 0;
}

const suite = describe.skipIf(handle === null);

suite("guards (C8, GW-5, GW-6)", () => {
  beforeAll(seed);

  afterAll(async () => {
    const { sql } = need();
    await sql`delete from payments where payer_account_id in (${PAYER}, ${OTHER_PAYER})`;
    await sql`delete from endpoints where id in (${ENDPOINTS.one}, ${ENDPOINTS.two})`;
    await sql`delete from sellers where id = ${ids.sellerId}`;
    await sql.end({ timeout: 1 }).catch(() => undefined);
  });

  it("lets a payer with nothing in flight through every guard", async () => {
    const rejection = await guardsRunner()(contextFor({ payer: `clean-${run}.testnet` }));
    expect(rejection).toBeNull();
  });

  it("refuses an authorization window shorter than the gateway's own timeout", async () => {
    // Guard 1 is a belt: the advertised window is derived from these same two env
    // values, so a running process cannot fail it. The test hands the guard the
    // short window directly, which is the shape the rule has to survive -- the day
    // `maxTimeoutSeconds` becomes a column, a silent short window must stop the
    // request rather than serve an answer that cannot be settled.
    const rejection = await guardsRunner()(contextFor({ maxTimeoutSeconds: WINDOW - 1 }));
    expect(rejection).toEqual({ status: 503, reason: "window_too_short" });
  });

  it("429s a payer whose previous payment is still in flight, and says when to return", async () => {
    const blocker = await insertPayment({ state: "verified" });
    const rejection = await guardsRunner()(contextFor());
    expect(rejection?.status).toBe(429);
    expect(rejection?.reason).toBe("payer_in_flight");
    expect(rejection?.retryAfterSeconds).toBe(WINDOW);
    await need().sql`delete from payments where id = ${blocker.id}`;
  });

  it("does not turn a dead process's leftover row into a permanent ban", async () => {
    // A `verified` row older than the upstream timeout plus the settlement margin
    // cannot be a live request. Until C10's sweep moves it to `abandoned`, an
    // unbounded gate would be a ban, which is a different rule than the one written.
    const stale = await insertPayment({ state: "verified", ageSeconds: WINDOW + 3_600 });
    const rejection = await guardsRunner()(contextFor());
    expect(rejection).toBeNull();
    await need().sql`delete from payments where id = ${stale.id}`;
  });

  it("blocks on `verified` only, not on the states that are finished", async () => {
    for (const state of ["settled", "abandoned", "served_unsettled"]) {
      const row = await insertPayment({ state });
      const rejection = await guardsRunner()(contextFor());
      expect(rejection, `state ${state}`).toBeNull();
      await need().sql`delete from payments where id = ${row.id}`;
    }
  });

  it("keys the gate on the payer, not on the endpoint", async () => {
    const blocker = await insertPayment({ state: "verified", endpointId: ENDPOINTS.one });
    // The same payer, a different endpoint: still one in flight.
    const blocked = await guardsRunner()(contextFor({ endpointId: ENDPOINTS.two }));
    expect(blocked?.reason).toBe("payer_in_flight");
    // A different payer, the same endpoint: unaffected.
    const other = await guardsRunner()(
      contextFor({ payer: `${OTHER_PAYER}`, endpointId: ENDPOINTS.one }),
    );
    expect(other).toBeNull();
    await need().sql`delete from payments where id = ${blocker.id}`;
  });

  it("refuses the second of two concurrent authorizations at the insert, not at the read", async () => {
    // The race Guard 3 exists for: two delegates from one payer, two different
    // authorizations, both verified, nothing in the table yet. S6 measured that the
    // scheme settles both, so this is the only place the second one can be stopped.
    const { db } = need();
    const claim = { windowSeconds: WINDOW };
    const outcomes = await Promise.all([
      openPayment(db, openInputFor({ payer: PAYER }), claim),
      openPayment(db, openInputFor({ payer: PAYER }), claim),
    ]);

    const kinds = outcomes.map((outcome) => outcome.kind).sort();
    expect(kinds).toEqual(["created", "in_flight"]);
    expect(await countRows(PAYER)).toBe(1);

    const blocked = outcomes.find((outcome) => outcome.kind === "in_flight");
    if (blocked?.kind !== "in_flight") {
      throw new Error("the loser of the race was not the in-flight answer");
    }
    expect(blocked.blocking.payerAccountId).toBe(PAYER);

    await need().sql`delete from payments where payer_account_id = ${PAYER}`;
  });

  it("does not serialise two different payers through the same lock", async () => {
    const { db } = need();
    const claim = { windowSeconds: WINDOW };
    const outcomes = await Promise.all([
      openPayment(db, openInputFor({ payer: PAYER }), claim),
      openPayment(db, openInputFor({ payer: OTHER_PAYER }), claim),
    ]);
    expect(outcomes.every((outcome) => outcome.kind === "created")).toBe(true);

    await need().sql`delete from payments where payer_account_id in (${PAYER}, ${OTHER_PAYER})`;
  });

  it("waits for the payer's open transaction instead of serving a second payment", async () => {
    // The race Guard 3 is really for, made deterministic: `Promise.all` above can
    // still interleave favourably by luck of the event loop, and a mutation that
    // deletes the advisory lock passes it. Here a second connection holds the
    // payer's lock with an **uncommitted** row -- exactly the window where a read
    // says "nothing in flight" and an insert then books a second one.
    //
    // Without `pg_advisory_xact_lock` the claim reads nothing, inserts its own row
    // and returns `created`: two in-flight payments for one payer, which is S6's
    // finding arriving in the code that was written to prevent it.
    const { db, sql } = need();
    const holderPayer = `c8-race-${run}.testnet`;
    const held = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${holderPayer})::int)`;
      await tx`insert into payments (id, endpoint_id, payer_account_id, amount, asset_contract,
          replay_key, state, verified_at)
        values (${randomUUID()}, ${ENDPOINTS.one}, ${holderPayer}, '10000', 'usdc.testnet',
          ${`c8-held-${randomUUID()}`}, 'verified', now())`;
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    // Let the holder reach its uncommitted-insert phase before the claim starts.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const outcome = await openPayment(db, openInputFor({ payer: holderPayer }), {
      windowSeconds: WINDOW,
    });
    await held;

    expect(outcome.kind).toBe("in_flight");
    expect(await countRows(holderPayer)).toBe(1);

    await sql`delete from payments where payer_account_id = ${holderPayer}`;
  });

  it("lets the payer through once the previous payment is answered", async () => {
    const { db } = need();
    const first = await openPayment(db, openInputFor({ payer: PAYER }), {
      windowSeconds: WINDOW,
    });
    if (first.kind !== "created") {
      throw new Error(`expected a created row, got ${first.kind}`);
    }
    await advancePayment(db, first.payment.id, "settled", { nearTxHash: `tx-${run}` });

    const second = await openPayment(db, openInputFor({ payer: PAYER }), {
      windowSeconds: WINDOW,
    });
    expect(second.kind).toBe("created");

    await need().sql`delete from payments where payer_account_id = ${PAYER}`;
  });

  it("answers a replay of an authorization that is still being served with the in-flight 429", async () => {
    // Not the 409: the first request has not finished, so there is no answer to
    // replay yet. The claim's read sees the live row before the unique key does.
    const { db } = need();
    const input = openInputFor({ payer: PAYER });
    const first = await openPayment(db, input, { windowSeconds: WINDOW });
    expect(first.kind).toBe("created");

    const again = await openPayment(db, input, { windowSeconds: WINDOW });
    expect(again.kind).toBe("in_flight");

    // And once it is abandoned, the same key is a replay with no receipt, which is
    // C4's answer and C7's to improve.
    await advancePayment(db, input.id, "abandoned", {});
    const after = await openPayment(db, input, { windowSeconds: WINDOW });
    expect(after.kind).toBe("existing");

    await need().sql`delete from payments where payer_account_id = ${PAYER}`;
  });
});
