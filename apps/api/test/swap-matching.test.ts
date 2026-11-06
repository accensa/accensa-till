import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import { endpoints, payments, payoutRoutes, sellers, swaps } from "../src/db/schema.ts";
import { linkSwapByHash } from "../src/services/swaps.ts";

/**
 * E2's acceptance test (LR-2, D13): a payment and a swap are put together by
 * transaction hash and by nothing else.
 *
 * The requirement's own test is negative — "no amount-and-time matching anywhere in
 * the code" — and a grep for that is only worth what it costs if a test could fail
 * when the grep is wrong. So both halves are run. The behavioural one is below: a
 * swap and a payment that agree on amount, asset and timestamps but not on the hash
 * are **not** linked, and two that agree on the hash and differ on everything else
 * **are**. A fixture that held amount and time constant could not tell those apart,
 * which is why the amount, the sums and the stamps vary from case to case here.
 *
 * Every assertion names rows this run minted: the scratch database holds the other
 * suites' payments, and the candidate query has no limit, so a hash borrowed from
 * an earlier run would report somebody else's payment as ambiguous.
 */

type Handle = { readonly sql: postgres.Sql; readonly db: ReturnType<typeof createTestDb> };

function createTestDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openDatabase(url: string): Promise<Handle> {
  // max: 1 keeps the migration files on the connection that ran their transaction.
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 3 });
  try {
    await sql`select 1`;
    const [present] = await sql`select to_regclass('public.ledger_entries') as present`;
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
const ASSET = "usdc.testnet";

/** One seller's own endpoint and standing route: the scope a candidate search lives in. */
type Fixture = {
  readonly label: string;
  readonly sellerId: string;
  readonly endpointId: string;
  readonly routeId: string;
};

function mint(label: string): Fixture {
  return { label, sellerId: randomUUID(), endpointId: randomUUID(), routeId: randomUUID() };
}

const home = mint("home");
const stranger = mint("stranger");

async function seedFixture(fixture: Fixture): Promise<void> {
  const { db } = need();
  await db.insert(sellers).values({
    id: fixture.sellerId,
    nearAccountId: `till-e2-${fixture.label}-${run}.testnet`,
    displayName: `E2 fixture ${fixture.label}`,
  });
  await db
    .insert(payoutRoutes)
    .values({
      id: fixture.routeId,
      sellerId: fixture.sellerId,
      destinationChain: "near",
      destinationAsset: "usdc",
      destinationAddress: `dest-${fixture.label}-${run}.testnet`,
      refundAddress: `refund-${fixture.label}-${run}.testnet`,
      provider: "mock",
      modeDetail: "standing",
    })
    .onConflictDoNothing();
  await db
    .insert(endpoints)
    .values({
      id: fixture.endpointId,
      sellerId: fixture.sellerId,
      slug: `e2-${fixture.label}-${randomUUID()}`,
      upstreamUrl: "https://example.test/data",
      priceAmount: "2500000",
      assetContract: ASSET,
      network: "near:testnet",
      payoutMode: "intents",
      routeId: fixture.routeId,
    })
    .onConflictDoNothing();
}

/** A payment carrying `hash`, with the amount and the stamps this case asks for. */
async function newPayment(
  fixture: Fixture,
  hash: string | null,
  fields: { amount?: string; state?: string; verifiedAt?: Date; settledAt?: Date | null } = {},
): Promise<string> {
  const { db } = need();
  const state = fields.state ?? "settled";
  const [row] = await db
    .insert(payments)
    .values({
      endpointId: fixture.endpointId,
      routeId: fixture.routeId,
      payerAccountId: "buyer.testnet",
      amount: fields.amount ?? "2500000",
      assetContract: ASSET,
      replayKey: `e2-${randomUUID()}`,
      state,
      nearTxHash: hash,
      verifiedAt: fields.verifiedAt ?? new Date("2026-11-01T10:00:00.000Z"),
      settledAt:
        fields.settledAt ?? (state === "settled" ? new Date("2026-11-01T10:01:00.000Z") : null),
    })
    .returning({ id: payments.id });
  if (row === undefined) {
    throw new Error("fixture wrote no payment row");
  }
  return row.id;
}

/** A swap carrying `hash`, optionally already pointing at a payment. */
async function newSwap(
  fixture: Fixture,
  hash: string | null,
  fields: { paymentId?: string | null; amountIn?: string } = {},
): Promise<string> {
  const { db } = need();
  const [row] = await db
    .insert(swaps)
    .values({
      routeId: fixture.routeId,
      providerRef: `e2-ref-${randomUUID()}`,
      paymentId: fields.paymentId ?? null,
      state: "succeeded",
      amountIn: fields.amountIn ?? "1",
      originTxHash: hash,
      raw: { simulated: true },
    })
    .returning({ id: swaps.id });
  if (row === undefined) {
    throw new Error("fixture wrote no swap row");
  }
  return row.id;
}

/** What the row holds now, read past the service so a written link is observed. */
async function linkOf(swapId: string): Promise<string | null> {
  const { db } = need();
  const [row] = await db
    .select({ paymentId: swaps.paymentId })
    .from(swaps)
    .where(eq(swaps.id, swapId));
  return row?.paymentId ?? null;
}

/**
 * A promise the test opens by hand, so another connection can be made to hold a row
 * until the call under test is standing on it. Returned as an object rather than a
 * `let release` assigned inside the executor: TypeScript's flow analysis cannot see
 * that assignment, so calling it is a type error before it is anything else.
 */
function handGate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Wait until the database says the matcher's UPDATE is blocked on a lock.
 *
 * This is a retry with a loud failure, not a timing assumption: the assertion below
 * it is a fact read out of `pg_stat_activity`, and if the wait never appears the test
 * throws rather than passing on a race it did not create. The statement text carries
 * `$1` placeholders, so the shape is what identifies it, and the shape is not ambiguous
 * either: `update "swaps"` appears nowhere else in the tree except `services/swaps.ts`
 * itself, and `vitest.config.ts` runs files in sequence, so no other suite can be
 * writing a swap while this one waits.
 */
async function waitForBlockedLink(observer: postgres.Sql): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await observer`select count(*)::int as waiting from pg_stat_activity
        where pid <> pg_backend_pid()
          and datname = current_database()
          and wait_event_type = 'Lock'
          and query ~ '^update "swaps"'`;
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the matcher never stood on the holder's row lock");
}

async function seed(): Promise<void> {
  await seedFixture(home);
  await seedFixture(stranger);
}

afterAll(async () => {
  // No deletes: the rows this file writes are payments and swaps, and a ledger suite
  // on the same database may point at one of them. Every assertion is scoped to an id
  // minted above instead.
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});

// describe.skipIf rather than an early return inside each test: a skipped suite says
// "not checked", while a test that returns without asserting says "passed".
const suite = describe.skipIf(handle === null);

suite("payments match swaps by transaction hash (E2, LR-2)", () => {
  beforeAll(seed);

  it("links a swap to the payment that carries its hash", async () => {
    const { db } = need();
    const hash = `tx-${randomUUID()}`;
    const paymentId = await newPayment(home, hash);
    const swapId = await newSwap(home, hash);

    expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "linked", paymentId });
    expect(await linkOf(swapId)).toBe(paymentId);
  });

  it("ignores the amount: the same hash links two different sums", async () => {
    const { db } = need();
    const hash = `tx-${randomUUID()}`;
    const paymentId = await newPayment(home, hash, { amount: "7" });
    const swapId = await newSwap(home, hash, { amountIn: "999999999" });

    expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "linked", paymentId });
  });

  it("ignores the clock: a payment settled years before the swap still links", async () => {
    const { db } = need();
    const hash = `tx-${randomUUID()}`;
    const paymentId = await newPayment(home, hash, {
      verifiedAt: new Date("2020-02-29T23:59:59.000Z"),
      settledAt: new Date("2020-03-01T00:00:00.000Z"),
    });
    const swapId = await newSwap(home, hash);

    expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "linked", paymentId });
  });

  it("links nothing when only the amount, the asset and the stamps agree", async () => {
    // The pair an amount-and-time matcher would join, and the reason the rule is
    // refused: every field a heuristic could read is identical here, and the two rows
    // are not the same money.
    const { db } = need();
    const at = new Date("2026-11-01T10:00:00.000Z");
    await newPayment(home, `tx-${randomUUID()}`, {
      amount: "2500000",
      verifiedAt: at,
      settledAt: at,
    });
    const swapId = await newSwap(home, `tx-${randomUUID()}`, { amountIn: "2500000" });

    expect(await linkSwapByHash(db, swapId)).toEqual({
      kind: "unlinked",
      reason: "no_candidate",
      candidates: [],
    });
    expect(await linkOf(swapId)).toBeNull();
  });

  it("refuses to match on a hash that is missing, blank or whitespace", async () => {
    const { db } = need();
    // A payment with no hash is the wrong half of this: `null = null` is never true
    // in SQL, but an `is null` matcher would happily join it to a hashless swap.
    await newPayment(home, null);

    for (const hash of [null, "", "   "]) {
      const swapId = await newSwap(home, hash);
      expect(await linkSwapByHash(db, swapId)).toEqual({
        kind: "unlinked",
        reason: "no_origin_hash",
        candidates: [],
      });
      expect(await linkOf(swapId)).toBeNull();
    }
  });

  it("reports a hash no payment carries as unmatched rather than guessing", async () => {
    const { db } = need();
    await newPayment(home, `tx-${randomUUID()}`);
    const swapId = await newSwap(home, `tx-${randomUUID()}`);

    expect(await linkSwapByHash(db, swapId)).toEqual({
      kind: "unlinked",
      reason: "no_candidate",
      candidates: [],
    });
  });

  it("links nothing when two payments of one seller share the hash", async () => {
    const { db } = need();
    const hash = `tx-${randomUUID()}`;
    const first = await newPayment(home, hash, { amount: "2500000" });
    const second = await newPayment(home, hash, { amount: "1" });
    const swapId = await newSwap(home, hash);

    const outcome = await linkSwapByHash(db, swapId);
    if (outcome.kind !== "unlinked" || outcome.reason !== "ambiguous") {
      throw new Error(`expected an ambiguous hash, got ${JSON.stringify(outcome)}`);
    }
    expect([...outcome.candidates].sort()).toEqual([first, second].sort());
    expect(await linkOf(swapId)).toBeNull();
  });

  it("does not reach across a seller to link another seller's payment", async () => {
    const { db } = need();
    const hash = `tx-${randomUUID()}`;
    await newPayment(stranger, hash);
    const swapId = await newSwap(home, hash);

    expect(await linkSwapByHash(db, swapId)).toEqual({
      kind: "unlinked",
      reason: "no_candidate",
      candidates: [],
    });
    expect(await linkOf(swapId)).toBeNull();
  });

  it("is blind to which route the payment came from, once the seller agrees", async () => {
    // PO-7's shape: a payment keeps the route it was opened under, and the swap that
    // moves that money can be created after the destination moved. Scoping the join by
    // route would drop exactly this pair.
    const { db, sql } = need();
    const hash = `tx-${randomUUID()}`;
    const paymentId = await newPayment(home, hash);
    await sql`update payments set route_id = null where id = ${paymentId}`;
    const swapId = await newSwap(home, hash);

    expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "linked", paymentId });
  });

  it("never re-points a swap that is linked, even when the candidate set turns ambiguous", async () => {
    const { db } = need();
    const hash = `tx-${randomUUID()}`;
    const first = await newPayment(home, hash);
    const swapId = await newSwap(home, hash);

    expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "linked", paymentId: first });

    // A second payment now carries the same hash. The swap must not move, and must
    // not be second-guessed into an ambiguity it has already resolved.
    await newPayment(home, hash, { amount: "1" });
    expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "already_linked", paymentId: first });
    expect(await linkOf(swapId)).toBe(first);
  });

  it("reports the link a swap already holds without searching for a candidate", async () => {
    const { db } = need();
    const paymentId = await newPayment(home, `tx-${randomUUID()}`);
    const swapId = await newSwap(home, null, { paymentId });

    expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "already_linked", paymentId });
  });

  it("links a payment whatever the state machine says about it", async () => {
    // The join is identity; what a state means is the rules' decision. An `abandoned`
    // row can keep its hash (C10's sweep leaves one when the chain says the transfer
    // failed) and a `served_unsettled` row never got one in the first place, so both
    // are pairs a reconciler has to be able to see rather than pairs Till hides.
    // `verified` is deliberately not seeded here: C10's boot sweep deletes stale
    // `verified` rows on a shared database and would take this fixture with it.
    const { db } = need();
    for (const state of ["settled", "served_unsettled", "abandoned"]) {
      const hash = `tx-${randomUUID()}`;
      const paymentId = await newPayment(home, hash, { state, amount: "2500000" });
      const swapId = await newSwap(home, hash, { amountIn: "2499000" });

      expect(await linkSwapByHash(db, swapId)).toEqual({ kind: "linked", paymentId });
    }
  });

  it("refuses a swap that does not exist rather than inventing a link", async () => {
    const { db } = need();
    const missing = randomUUID();

    await expect(linkSwapByHash(db, missing)).rejects.toThrow(/^no swap /);
  });

  // The last argument is this test's own budget, larger than vitest's default on purpose:
  // the helper below retries for two seconds and then names which precondition failed, and
  // under the five-second default that message races the built-in timeout, so a stall would
  // read as "test timed out" instead of the diagnosis the helper exists to give.
  it("reports the link that won the race rather than writing its own", async () => {
    // The write is compare-and-set on `payment_id is null`, and this is the version of
    // the race that makes that predicate observable. A second connection writes a link
    // on the swap and holds it *uncommitted*; the matcher cannot see that write (MVCC),
    // so it reads no link, chooses its own candidate, and its own UPDATE then stands on
    // the holder's row lock. Only once that wait is confirmed does the holder commit:
    // the matcher's UPDATE matches no row, and it reports the winner's link rather than
    // claiming one it wrote.
    //
    // Deleting `isNull(swaps.paymentId)` from the service's write makes it overwrite the
    // winner and answer `linked`, which fails both assertions below. That mutant is what
    // this test exists to catch, which is why the wait is confirmed rather than assumed.
    //
    // Two gates, not one. `lockHeld` says the holder's UPDATE has run, so the row is
    // locked and the matcher can be released against it; `holdOpen` says the test has
    // watched the matcher block and the holder may commit. Awaiting the gate *inside*
    // the callback is what keeps the transaction open: chaining it with `.then` on
    // `begin()` runs after the COMMIT, which has already released the lock. Releasing
    // the matcher before `lockHeld` fires is a coin toss about which UPDATE the database
    // sees first, and the matcher simply wins and links (observed).
    const { db, sql } = need();
    const hash = `tx-${randomUUID()}`;
    const mine = await newPayment(home, hash, { amount: "2500000" });
    // A payment carrying a *different* hash. The holder's link need not be one of this
    // swap's candidates — it stands for any writer that got there first, and all the
    // predicate under test cares about is that the row already points somewhere. Reuse
    // `hash` here and the matcher's own candidate set turns ambiguous, so it refuses to
    // write and never reaches the lock at all.
    const theirs = await newPayment(home, `tx-${randomUUID()}`);
    const swapId = await newSwap(home, hash);

    // That the matcher means to write `mine` is checked rather than assumed: a second
    // unlinked swap carrying the same hash links to it, which is only possible if the
    // candidate set for `hash` holds exactly one payment.
    const witness = await newSwap(home, hash);
    expect(await linkSwapByHash(db, witness)).toEqual({ kind: "linked", paymentId: mine });

    const holder = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 3 });
    const observer = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 3 });
    const lockHeld = handGate();
    const holdOpen = handGate();
    const racing = holder.begin(async (tx) => {
      await tx`update swaps set payment_id = ${theirs} where id = ${swapId}`;
      lockHeld.open();
      await holdOpen.promise;
    });

    try {
      await lockHeld.promise;
      // The holder has the row locked and its link uncommitted, so whatever the
      // matcher reads for `payment_id` here is null.
      const linked = linkSwapByHash(db, swapId);
      await waitForBlockedLink(observer);

      holdOpen.open();
      await racing;

      expect(await linked).toEqual({ kind: "already_linked", paymentId: theirs });
      const [row] = await sql`select payment_id from swaps where id = ${swapId}`;
      expect(row?.payment_id).toBe(theirs);
      expect(row?.payment_id).not.toBe(mine);
    } finally {
      // Opening the gate is unconditional: a failed assertion above must not leave a
      // transaction holding a row for whatever suite runs next on this database. The
      // begin() is started outside the try so that this cleanup names the same promise.
      holdOpen.open();
      await racing.catch(() => undefined);
      await holder.end({ timeout: 5 }).catch(() => undefined);
      await observer.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 20_000);
});
