import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IllegalPaymentTransition,
  PAYMENT_STATES,
  type PaymentState,
  canTransitionPayment,
} from "@till/core";
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
 * C7 (GW-4) added the other half of that story here, because it is the same three
 * facts in reverse: a retried authorization finds the abandoned row and moves it
 * back rather than making a second one, the reopen is compare-and-set so two retries
 * serve once, and a row that carries any evidence of a chain move cannot be reopened
 * at all.
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

/**
 * A promise the test opens by hand, so another connection can be made to hold a row
 * until the request under test is standing on it. Returned as an object rather than
 * a `let release: (() => void) | null` assigned inside the executor: TypeScript's
 * flow analysis cannot see that assignment, so calling it is a type error before it
 * is anything else.
 */
function handGate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
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

  it("refuses every move out of `settled`, against the row in the database", async () => {
    const { db } = need();
    const payment = await openFresh();
    await advancePayment(db, payment.id, "settled", { nearTxHash: "tx-terminal" });

    for (const to of PAYMENT_STATES) {
      await expect(advancePayment(db, payment.id, to as PaymentState)).rejects.toThrow(
        IllegalPaymentTransition,
      );
    }
  });

  it("moves an abandoned row back to verified and refuses every other move out of it (C7, GW-4)", async () => {
    // The state-machine half of the retry, read from the row rather than from the
    // table: `abandoned -> verified` is the one edge C7 opened, and the two that
    // would cost money -- straight to `settled`, or to `served_unsettled` -- stay
    // refused. `advancePayment` itself is not the reopen path (see the test below);
    // this one asks the machine, through the service, what it makes of each move.
    const { db } = need();
    const payment = await openFresh();
    await advancePayment(db, payment.id, "abandoned", { upstreamStatus: 502 });

    expect(canTransitionPayment("abandoned", "verified")).toBe(true);
    for (const to of ["abandoned", "settled", "served_unsettled"] as const) {
      await expect(advancePayment(db, payment.id, to)).rejects.toThrow(IllegalPaymentTransition);
    }
    const after = await findPayment(db, payment.id);
    expect(after?.state).toBe("abandoned");
  });

  it("reopens an abandoned row as the same row, with a fresh stamp and no stale answer (C7, GW-4)", async () => {
    const { db, sql } = need();
    const input = paymentInput();
    const first = await openPayment(db, input);
    if (first.kind !== "created") {
      throw new Error(`first open returned ${first.kind}`);
    }
    await advancePayment(db, first.payment.id, "abandoned", {
      upstreamStatus: 502,
      upstreamMs: 15_000,
    });
    const before = await findPayment(db, first.payment.id);

    // A retry carries the same authorization, so the same `replay_key`, and a fresh
    // row id from the route's `newId()`: the service must find the old row, not the
    // id, and must not be able to insert a second one.
    const retry = await openPayment(
      db,
      paymentInput({ replayKey: input.replayKey, id: randomUUID() }),
    );
    if (retry.kind !== "retried") {
      throw new Error(`retry returned ${retry.kind}`);
    }
    expect(retry.payment.id).toBe(first.payment.id);
    expect(retry.payment.state).toBe("verified");
    expect(retry.payment.upstreamStatus).toBeNull();
    expect(retry.payment.upstreamMs).toBeNull();
    expect(retry.payment.nearTxHash).toBeNull();
    expect(retry.payment.settledAt).toBeNull();
    // `verified_at` moves. Guard 3's window and C10's sweep both measure age from
    // it, so a retry that kept the failed attempt's stamp would have a live request
    // timed out of a dead one -- and the sweep would abandon a payment the payer is
    // waiting on. Two statements a few milliseconds apart cannot share a stamp.
    const after = await findPayment(db, first.payment.id);
    expect(
      (after?.verifiedAt ?? new Date(0)).getTime() > (before?.verifiedAt ?? new Date(0)).getTime(),
    ).toBe(true);

    const [row] =
      await sql`select (extract(epoch from (now() - verified_at))::int) as age, upstream_status
        from payments where replay_key = ${input.replayKey}`;
    expect(row?.age).toBeLessThanOrEqual(5);
    const [count] =
      await sql`select (count(*))::int as count from payments where replay_key = ${input.replayKey}`;
    expect(count?.count).toBe(1);
  });

  it("will not reopen an abandoned row that shows money moved (C7, GW-4's double-spend guard)", async () => {
    const { db, sql } = need();
    // No route branch writes a hash into an abandoned row, so this state is built
    // here on purpose: it is what C10's sweep leaves when the chain says the settle
    // landed while the process was dead. Re-serving it would be a second
    // settlement for one signature, which is the argument C3 left for this row.
    for (const which of ["hash", "stamp"] as const) {
      const input = paymentInput();
      const first = await openPayment(db, input);
      if (first.kind !== "created") {
        throw new Error(`first open returned ${first.kind}`);
      }
      await advancePayment(db, first.payment.id, "abandoned", { upstreamStatus: 502 });
      if (which === "hash") {
        await sql`update payments set near_tx_hash = 'tx-evidence-of-a-chain-move'
          where id = ${first.payment.id}`;
      } else {
        await sql`update payments set settled_at = now() where id = ${first.payment.id}`;
      }

      const retry = await openPayment(db, paymentInput({ replayKey: input.replayKey }));
      expect([which, retry.kind]).toEqual([which, "existing"]);
      if (retry.kind !== "existing") {
        throw new Error(`retry returned ${retry.kind}`);
      }
      expect(retry.payment.id).toBe(first.payment.id);
      expect(retry.payment.state).toBe("abandoned");

      const rows =
        which === "hash"
          ? await sql`select near_tx_hash as kept from payments where id = ${first.payment.id}`
          : await sql`select settled_at is not null as kept from payments where id = ${first.payment.id}`;
      // The evidence survives: refusing the retry must not quietly wipe the hash
      // that reconcile needs, or the stamp the sweep wrote.
      expect([which, rows[0]?.kept]).toEqual([
        which,
        which === "hash" ? "tx-evidence-of-a-chain-move" : true,
      ]);
      const [count] =
        await sql`select count(*)::int as count from payments where replay_key = ${input.replayKey}`;
      expect(count?.count).toBe(1);
    }
  });

  it("reopens once when two retries of one abandoned authorization arrive together (C7, GW-4)", async () => {
    const { db, sql } = need();
    const input = paymentInput();
    const first = await openPayment(db, input);
    if (first.kind !== "created") {
      throw new Error(`first open returned ${first.kind}`);
    }
    await advancePayment(db, first.payment.id, "abandoned", { upstreamStatus: 502 });

    const outcomes = await Promise.all([
      openPayment(db, paymentInput({ replayKey: input.replayKey })),
      openPayment(db, paymentInput({ replayKey: input.replayKey })),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === "retried")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "existing")).toHaveLength(1);

    const [count] =
      await sql`select count(*)::int as count from payments where replay_key = ${input.replayKey}`;
    expect(count?.count).toBe(1);
  });

  it("reopens the row the writer that moved it first actually moved, mid-window (C7's compare-and-set)", async () => {
    // What the Promise.all test above cannot reach, and why: this file's pool is
    // `max: 1`, so two "concurrent" calls are a queue and the second only reads the
    // row the first left. A second connection with an uncommitted UPDATE does not
    // help either -- measured, and the retry's INSERT on the same unique key waits on
    // that transaction (`wait_event: transactionid`), so by the time the service reads
    // again the other writer has already committed and the reuse predicate is never
    // exercised. A `SELECT ... FOR UPDATE` holds the row without touching the index,
    // which leaves exactly the window the compare-and-set is for: the service has read
    // `abandoned`, its UPDATE is now blocked on the lock, and the holder moves the row
    // and commits underneath it. With `and state = 'abandoned'` the waking statement
    // re-checks its predicate, matches nothing and answers `existing`; without it the
    // same retry takes a row over that someone else already reopened, and the seller
    // is dialled twice for one payment. That difference is what this test asserts, and
    // dropping the predicate from the service is what kills it (mutation m4).
    const { db, sql } = need();
    const input = paymentInput();
    const first = await openPayment(db, input);
    if (first.kind !== "created") {
      throw new Error(`first open returned ${first.kind}`);
    }
    await advancePayment(db, first.payment.id, "abandoned", { upstreamStatus: 502 });

    const other = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 3 });
    const hold = handGate();
    try {
      const holder = other.begin(async (tx) => {
        await tx`select id from payments where replay_key = ${input.replayKey} for update`;
        await hold.promise;
        await tx`update payments set state = 'verified' where replay_key = ${input.replayKey}`;
      });
      // The holder has the lock before the retry starts, and the retry is issued and
      // reaches its blocked UPDATE before the holder is allowed to move the row.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const raced = openPayment(db, paymentInput({ replayKey: input.replayKey }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      hold.open();
      await holder;

      const outcome = await raced;
      expect(outcome.kind).toBe("existing");
      if (outcome.kind !== "existing") {
        throw new Error(`retry returned ${outcome.kind}`);
      }
      // The row the winner holds is the one writer that moved it first, and the
      // blocked retry did not restamp it.
      expect(outcome.payment.state).toBe("verified");
      expect(outcome.payment.id).toBe(first.payment.id);
      const [row] =
        await sql`select (select (count(*))::int from payments where replay_key = ${input.replayKey}) as rows from payments where replay_key = ${input.replayKey}`;
      expect(row?.rows).toBe(1);
    } finally {
      hold.open();
      await other.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  it("will not hand a settled or served row back to a replay (C7, GW-4)", async () => {
    const { db } = need();
    for (const state of ["settled", "served_unsettled"] as const) {
      const input = paymentInput();
      const first = await openPayment(db, input);
      if (first.kind !== "created") {
        throw new Error(`first open returned ${first.kind}`);
      }
      await advancePayment(db, first.payment.id, state, {
        ...(state === "settled" ? { nearTxHash: `tx-${state}` } : {}),
      });

      const retry = await openPayment(db, paymentInput({ replayKey: input.replayKey }));
      expect([state, retry.kind]).toEqual([state, "existing"]);
      if (retry.kind !== "existing") {
        throw new Error(`retry returned ${retry.kind}`);
      }
      expect([state, retry.payment.state]).toEqual([state, state]);
    }
  });

  it("keeps one abandoned row to the endpoint that opened it (C7, GW-4)", async () => {
    // A delegate binds payer, relayer, nonce and the transfer, and nothing per
    // endpoint, so two of one seller's endpoints at one price can present the same
    // signed action. The retry must not move endpoint A's row and then serve
    // endpoint B's upstream under it: `replay_key` is unique, so B gets a replay and
    // A's row stays as A left it.
    const { db, sql } = need();
    const other = randomUUID();
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode)
      values (${other}, ${ids.sellerId}, ${`c7-${randomUUID()}`}, 'https://example.test/other',
        '2500000', 'usdc.testnet', 'near:testnet', 'auto')`;

    const input = paymentInput();
    const first = await openPayment(db, input);
    if (first.kind !== "created") {
      throw new Error(`first open returned ${first.kind}`);
    }
    await advancePayment(db, first.payment.id, "abandoned", { upstreamStatus: 502 });

    const retry = await openPayment(db, {
      ...input,
      replayKey: input.replayKey,
      endpointId: other,
    });
    expect(retry.kind).toBe("existing");
    const after = await findPayment(db, first.payment.id);
    expect(after?.state).toBe("abandoned");
    expect(after?.endpointId).toBe(input.endpointId);

    const [count] =
      await sql`select count(*)::int as count from payments where replay_key = ${input.replayKey}`;
    expect(count?.count).toBe(1);
  });

  it("refuses to move a payment back to verified except through openPayment (C7)", async () => {
    // The generic advance is how every *outcome* is written; letting it also write
    // the opening move would put `REUSE_GUARD` behind the caller's good manners.
    const { db } = need();
    const input = paymentInput();
    const first = await openPayment(db, input);
    if (first.kind !== "created") {
      throw new Error(`first open returned ${first.kind}`);
    }
    await advancePayment(db, first.payment.id, "abandoned", { upstreamStatus: 502 });

    await expect(advancePayment(db, first.payment.id, "verified")).rejects.toThrow(
      /may only move back to verified through openPayment/,
    );
    const after = await findPayment(db, first.payment.id);
    expect(after?.state).toBe("abandoned");
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
