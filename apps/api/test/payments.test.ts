import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { IllegalPaymentTransition, PAYMENT_STATES, type PaymentState } from "@till/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import {
  advancePayment,
  findByReplayKey,
  findPayment,
  openPayment,
} from "../src/services/payments.ts";

/**
 * C3 acceptance tests. The pure transition matrix lives in
 * `packages/core/src/__tests__/states.test.ts`; this file is about what only a real
 * Postgres can show: that the unique `replay_key` actually collapses two
 * concurrent inserts into one row, that `verified_at` and `settled_at` come from
 * the database clock, and that a compare-and-set on `state` makes a second settle
 * attempt fail instead of writing a second receipt.
 *
 * Needs `DATABASE_URL`; without a reachable database the file skips, so a CI run
 * with no Postgres cannot be read as evidence (same deal as append-only.test.ts).
 */

type Handle = { readonly sql: postgres.Sql; readonly db: ReturnType<typeof createTestDb> };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** `drizzle(sql, { schema })` must keep the schema generic, or the service signatures do not accept it. */
function createTestDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openDatabase(url: string): Promise<Handle> {
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 3 });
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

const ids = {
  sellerId: randomUUID(),
  endpointId: randomUUID(),
  nearAccount: `till-c3-${randomUUID().slice(0, 8)}.testnet`,
  slug: `c3-${randomUUID()}`,
} as const;

/** One endpoint per run; payments hang off it and the FKs have to be satisfied. */
async function seed(): Promise<void> {
  const { sql } = need();
  await sql`insert into sellers (id, near_account_id, display_name)
    values (${ids.sellerId}, ${ids.nearAccount}, 'C3 fixture')
    on conflict (id) do nothing`;
  await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
      asset_contract, network, payout_mode)
    values (${ids.endpointId}, ${ids.sellerId}, ${ids.slug}, 'https://example.test/data',
      '2500000', 'usdc.testnet', 'near:testnet', 'auto')
    on conflict (id) do nothing`;
}

type OpenInput = Parameters<typeof openPayment>[1];

function paymentInput(overrides: Partial<OpenInput> = {}): OpenInput {
  return {
    id: randomUUID(),
    endpointId: ids.endpointId,
    payerAccountId: "buyer.testnet",
    amount: 2_500_000n,
    assetContract: "usdc.testnet",
    replayKey: `c3-${randomUUID()}`,
    ...overrides,
  };
}

async function openFresh(overrides: Partial<OpenInput> = {}) {
  const { db } = need();
  const outcome = await openPayment(db, paymentInput(overrides));
  if (outcome.kind !== "created") {
    throw new Error("fixture replayed a key that was never used");
  }
  return outcome.payment;
}

const suite = describe.skipIf(handle === null);

suite("payments service (C3, GW-2, GW-4)", () => {
  beforeAll(seed);

  it("opens a verified row and stamps verified_at with the database clock", async () => {
    const { sql } = need();
    const payment = await openFresh();

    expect(payment.state).toBe("verified");
    expect(payment.verifiedAt).not.toBeNull();
    expect(payment.settledAt).toBeNull();
    // numeric(78,0) comes back as a string: bigint is the only representation
    // that survives the round trip, and a float here would lose exactness (hard
    // rule 3).
    expect(payment.amount).toBe("2500000");

    const [age] =
      await sql`select (extract(epoch from (now() - verified_at))::int) as age from payments where id = ${payment.id}`;
    expect(age?.age).toBeLessThanOrEqual(5);
  });

  it("replays a second request with the same authorization onto the one row", async () => {
    const { db } = need();
    const input = paymentInput();
    const first = await openPayment(db, input);
    const second = await openPayment(db, input);

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("existing");
    // Narrow by throwing, not by returning: a `return` here would let a mutation
    // that makes either open answer `in_flight` pass the test by running nothing.
    if (first.kind !== "created") {
      throw new Error(`first open returned ${first.kind}`);
    }
    if (second.kind !== "existing") {
      throw new Error(`second open returned ${second.kind}`);
    }
    expect(second.payment.id).toBe(first.payment.id);

    const rows = await findByReplayKey(db, input.replayKey);
    expect(rows?.id).toBe(first.payment.id);
  });

  it("inserts once when two requests with one authorization race", async () => {
    const { db, sql } = need();
    const input = paymentInput();

    const outcomes = await Promise.all([openPayment(db, input), openPayment(db, input)]);
    const created = outcomes.filter((outcome) => outcome.kind === "created");
    expect(created).toHaveLength(1);

    const [count] =
      await sql`select count(*)::int as count from payments where replay_key = ${input.replayKey}`;
    expect(count?.count).toBe(1);
  });

  it("settles: writes the hash, the upstream result and settled_at from the clock", async () => {
    const payment = await openFresh();
    const settled = await advancePayment(need().db, payment.id, "settled", {
      nearTxHash: "tx-hash-c3",
      upstreamStatus: 200,
      upstreamMs: 42,
    });

    expect(settled.state).toBe("settled");
    expect(settled.nearTxHash).toBe("tx-hash-c3");
    expect(settled.upstreamStatus).toBe(200);
    expect(settled.upstreamMs).toBe(42);
    expect(settled.settledAt).not.toBeNull();
  });

  it("abandons without a settlement hash or a settled_at", async () => {
    const payment = await openFresh();
    const abandoned = await advancePayment(need().db, payment.id, "abandoned", {
      upstreamStatus: 502,
      upstreamMs: 15_000,
    });

    expect(abandoned.state).toBe("abandoned");
    expect(abandoned.nearTxHash).toBeNull();
    expect(abandoned.settledAt).toBeNull();
  });

  it("serves unsettled, then settles once the money lands (GW-3)", async () => {
    const payment = await openFresh();
    const served = await advancePayment(need().db, payment.id, "served_unsettled", {
      upstreamStatus: 200,
    });
    expect(served.state).toBe("served_unsettled");
    expect(served.settledAt).toBeNull();

    const settled = await advancePayment(need().db, payment.id, "settled", {
      nearTxHash: "tx-hash-late",
    });
    expect(settled.state).toBe("settled");
    expect(settled.settledAt).not.toBeNull();
  });

  it("refuses every move out of a terminal state, against the row in the database", async () => {
    const { db } = need();
    for (const terminal of ["settled", "abandoned"] as const) {
      const payment = await openFresh();
      await advancePayment(db, payment.id, terminal);

      for (const to of PAYMENT_STATES) {
        await expect(advancePayment(db, payment.id, to as PaymentState)).rejects.toThrow(
          IllegalPaymentTransition,
        );
      }
    }
  });

  it("refuses a move the machine disallows from verified, and leaves the row alone", async () => {
    const { db } = need();
    const payment = await openFresh();

    await expect(advancePayment(db, payment.id, "verified")).rejects.toThrow(
      IllegalPaymentTransition,
    );

    const after = await findPayment(db, payment.id);
    expect(after?.state).toBe("verified");
    expect(after?.settledAt).toBeNull();
  });

  it("settles once when two attempts race, because the update is compare-and-set", async () => {
    const { db, sql } = need();
    const payment = await openFresh();

    const results = await Promise.allSettled([
      advancePayment(db, payment.id, "settled", { nearTxHash: "first" }),
      advancePayment(db, payment.id, "settled", { nearTxHash: "second" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    // Exactly one wins, and the loser throws rather than writing a second
    // receipt. Two winners would be a double settlement; zero would be a lost
    // update. Which one wins is a scheduling detail.
    expect(fulfilled).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status).toBe("rejected");

    const [row] =
      await sql`select state, settled_at is not null as stamped, (count(*))::int as one from payments where id = ${payment.id} group by state, stamped`;
    expect(row).toEqual({ state: "settled", stamped: true, one: 1 });

    const settled = await findPayment(db, payment.id);
    expect(["first", "second"]).toContain(settled?.nearTxHash);
  });

  it("refuses to move a payment that does not exist", async () => {
    await expect(advancePayment(need().db, randomUUID(), "settled")).rejects.toThrow(
      /^no payment /,
    );
  });

  it("returns null rather than throwing for lookups that miss", async () => {
    const { db } = need();
    expect(await findPayment(db, randomUUID())).toBeNull();
    expect(await findByReplayKey(db, `never-used-${randomUUID()}`)).toBeNull();
  });
});

afterAll(async () => {
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});
