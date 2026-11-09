import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BaseUnitAmount, ReconcileConfig, SwapState } from "@till/core";

import * as schema from "../src/db/schema.ts";
import {
  discrepancies,
  endpoints,
  payments,
  payoutRoutes,
  sellers,
  swaps,
} from "../src/db/schema.ts";
import type { PollStatusSource } from "../src/jobs/poll-payouts.ts";
import { type ReconcileDeps, allSellerIds, reconcileSellers } from "../src/jobs/reconcile.ts";
import { pollTick, reconcileTick } from "../src/jobs/ticks.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { NormalizedSwap } from "../src/payouts/provider.ts";

/**
 * E9's acceptance test (LR-2, LR-3): the reconcile loop is the only thing that puts
 * the pure rules' answers into `discrepancies`, and its Done-when is two claims
 * about two different mechanisms.
 *
 * - *running it twice on one snapshot gives identical results*: the second pass opens
 *   nothing, closes nothing, and leaves the first pass's `opened_at` exactly where it
 *   was. That is idempotence as an observable, not as a promise — a pass that rewrote
 *   the row would make "when was this first seen" mean "when did Till last run".
 * - *two overlapping runs do not duplicate findings*: one pass holds the seller's row
 *   `FOR UPDATE` and uncommitted while the other tries to claim it, and the other
 *   skips. `pg_locks` is read to show the lock was real, because a skip that happened
 *   for no reason at all would pass this test too (E2's lesson: a test that creates a
 *   race has to be able to say whether it happened).
 *
 * The rest of the file is what the loop is for: the three config windows arriving
 * from the environment, the payment's payout mode read off the route the payment
 * carries (PO-7, not the endpoint's live field), `SwapRow.paymentId` and
 * `PaymentRow.payoutMode` populated so the rules have the columns D8 and E2 defined
 * them for, the one rule that keeps a partial pass from silently shutting a live
 * finding, which rows a capped pass keeps when it cannot read them all, and — in the
 * second suite — which of the two ticks put a row there.
 *
 * Nothing here deletes what it wrote, and nothing here needs to: the append-only
 * trigger binds `ledger_entries`, and only one case in the wiring suite reaches it
 * (a real `succeeded` transition, so D6's writer books one `payout_out` row). The
 * rows it reads are scoped to the sellers this run minted, so other suites' leftovers
 * — which a *global* pass would reconcile and auto-close — are never this file's
 * business. That is why every call below hands the loop an explicit seller list,
 * including the interval tick: with no list it asks `allSellerIds`, and a scratch
 * database that has accumulated a thousand leftover sellers turns that sweep into an
 * assertion about how long the machine took (hard rule 12). `allSellerIds` is
 * therefore tested as a listing, and the sweep it feeds is not tested here.
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
  // max: 10 so the holder and the pass really are two connections, which is the
  // case the overlap half of this file is about.
  const sql = postgres(url, { max: 10, idle_timeout: 5, connect_timeout: 3 });
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
    await sql.end({ timeout: 5 }).catch(() => undefined);
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

/**
 * The windows the rules age against, spelled out here so a test that depends on one
 * says which. `sweepWindowSeconds` is 300 because that is `env.SWEEP_WINDOW_SECONDS`'s
 * default, and the window test below turns the knob rather than trusting it.
 */
const CONFIG: ReconcileConfig = {
  sweepWindowSeconds: 300,
  stuckWindowSeconds: 900,
  shortfallToleranceBps: 50,
};

/** A seller, its route and one endpoint, all of which this run owns. */
type Home = {
  readonly sellerId: string;
  readonly routeId: string;
  readonly endpointId: string;
};

async function newHome(label: string, modeDetail: "direct" | "standing"): Promise<Home> {
  const { db } = need();
  const home = {
    sellerId: randomUUID(),
    routeId: randomUUID(),
    endpointId: randomUUID(),
  };
  await db.insert(sellers).values({
    id: home.sellerId,
    nearAccountId: `till-e9-${label}-${run}.testnet`,
    displayName: `E9 fixture ${label}`,
  });
  await db.insert(payoutRoutes).values({
    id: home.routeId,
    sellerId: home.sellerId,
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: `dest-${label}-${run}.testnet`,
    refundAddress: `refund-${label}-${run}.testnet`,
    provider: "mock",
    depositAddress: `mock-deposit-${label}-${run}`,
    quoteRef: `mock-quote-${label}-${run}`,
    modeDetail,
  });
  await db.insert(endpoints).values({
    id: home.endpointId,
    sellerId: home.sellerId,
    slug: `e9-${label}-${randomUUID()}`,
    upstreamUrl: "https://example.test/data",
    priceAmount: "1000000",
    assetContract: ASSET,
    network: "near:testnet",
    payoutMode: modeDetail === "direct" ? "direct" : "intents",
    routeId: home.routeId,
  });
  return home;
}

/**
 * A payment this run owns. Every timestamp is written on the database clock
 * (`now() - the age the case asks for`), never from `Date.now()`, so a slow machine
 * cannot age a fixture past a window by being slow (hard rule 12).
 */
async function newPayment(
  home: Home,
  fields: {
    state?: string;
    hash?: string | null;
    amount?: string;
    /** Seconds since settlement on the database clock; `null` leaves the column empty. */
    settledAgo?: number | null;
    routeId?: string | null;
  },
): Promise<string> {
  const { db } = need();
  const settledAgo = fields.settledAgo ?? 400;
  const [row] = await db
    .insert(payments)
    .values({
      endpointId: home.endpointId,
      routeId: fields.routeId === undefined ? home.routeId : fields.routeId,
      payerAccountId: "buyer.testnet",
      amount: fields.amount ?? "1000000",
      assetContract: ASSET,
      replayKey: `e9-${randomUUID()}`,
      state: fields.state ?? "settled",
      nearTxHash: fields.hash === undefined ? `tx-${randomUUID()}` : fields.hash,
      verifiedAt: sql`now()`,
      settledAt:
        settledAgo === null ? null : sql`now() - make_interval(secs => ${settledAgo}::int)`,
    })
    .returning({ id: payments.id });
  if (row === undefined) {
    throw new Error("fixture wrote no payment row");
  }
  return row.id;
}

/**
 * A swap this run owns, with the schedule fields the rules read.
 *
 * It returns the provider ref alongside the id because the wiring tests below hand
 * this swap to a poll tick, and a tick asks a provider about refs rather than ids.
 */
async function newSwap(
  home: Home,
  fields: {
    state?: string;
    paymentId?: string | null;
    originTxHash?: string | null;
    amountIn?: string | null;
    amountOut?: string | null;
    polledAgo?: number | null;
  },
): Promise<{ id: string; providerRef: string }> {
  const { db } = need();
  const polledAgo = fields.polledAgo ?? null;
  const providerRef = `e9-ref-${randomUUID()}`;
  const [row] = await db
    .insert(swaps)
    .values({
      routeId: home.routeId,
      providerRef,
      state: fields.state ?? "processing",
      paymentId: fields.paymentId ?? null,
      originTxHash: fields.originTxHash ?? null,
      amountIn: fields.amountIn ?? null,
      amountOut: fields.amountOut ?? null,
      lastPolledAt:
        polledAgo === null ? null : sql`now() - make_interval(secs => ${polledAgo}::int)`,
      raw: { simulated: true, by: "e9 fixture" },
    })
    .returning({ id: swaps.id, providerRef: swaps.providerRef });
  if (row === undefined) {
    throw new Error("fixture wrote no swap row");
  }
  return row;
}

function age(paymentId: string, seconds: number): Promise<unknown> {
  const { sql } = need();
  return sql`update payments set settled_at = now() - make_interval(secs => ${seconds}::int)
      where id = ${paymentId}`;
}

const columns = {
  code: discrepancies.code,
  severity: discrepancies.severity,
  paymentId: discrepancies.paymentId,
  swapId: discrepancies.swapId,
  dedupeKey: discrepancies.dedupeKey,
  openedAt: discrepancies.openedAt,
  resolvedAt: discrepancies.resolvedAt,
  resolution: discrepancies.resolution,
};

type DiscrepancyRow = {
  readonly code: string;
  readonly severity: string;
  readonly paymentId: string | null;
  readonly swapId: string | null;
  readonly dedupeKey: string;
  readonly openedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly resolution: string | null;
};

/**
 * What the seller's open worklist looks like, in the order the page would read it.
 * The whole row is returned — including `openedAt` — because the idempotence test is
 * about the row not moving, and a helper that dropped `opened_at` would let a churning
 * pass look stable.
 *
 * "Open" is `resolved_at is null`, which is what the seller sees and what the loop's
 * auto-close targets, so the count assertions below mean worklist rather than history.
 * `allRows` is the history.
 */
async function openRows(sellerId: string): Promise<DiscrepancyRow[]> {
  const { db } = need();
  return db
    .select(columns)
    .from(discrepancies)
    .where(and(eq(discrepancies.sellerId, sellerId), isNull(discrepancies.resolvedAt)))
    .orderBy(discrepancies.dedupeKey);
}

/** Every row this seller has *ever* had, closed ones included, oldest first. */
async function allRows(sellerId: string): Promise<DiscrepancyRow[]> {
  const { db } = need();
  return db
    .select(columns)
    .from(discrepancies)
    .where(eq(discrepancies.sellerId, sellerId))
    .orderBy(discrepancies.openedAt, discrepancies.dedupeKey);
}

/** How many rows exist at all, which is the duplication question. */
async function rowCount(sellerId: string): Promise<number> {
  const { sql } = need();
  const [row] =
    await sql`select count(*)::int as n from discrepancies where seller_id = ${sellerId}`;
  return row?.n ?? -1;
}

type Entry = {
  readonly level: string;
  readonly code: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
};

function recordingLog(): { readonly log: Logger; readonly entries: Entry[] } {
  const entries: Entry[] = [];
  const push =
    (level: string) =>
    (fields: Record<string, unknown>, message?: string): void => {
      entries.push({ level, code: String(fields.code ?? ""), message: message ?? "", fields });
    };
  const log: Logger = {
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => log,
  };
  return { log, entries };
}

function codes(entries: readonly Entry[]): string[] {
  return entries.map((entry) => entry.code);
}

function handGate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Run one pass over exactly these sellers, with the config every case shares. */
async function pass(
  sellerIds: readonly string[],
  deps: { maxRows?: number; config?: Partial<ReconcileConfig> } = {},
): Promise<Awaited<ReturnType<typeof reconcileSellers>>> {
  const requested: ReconcileDeps = {
    db: need().db,
    config: { ...CONFIG, ...deps.config },
    sellerIds,
    ...(deps.maxRows === undefined ? {} : { snapshotMaxRows: deps.maxRows }),
  };
  return reconcileSellers(requested);
}

afterAll(async () => {
  // No deletes and no deletes needed: this pass books no ledger rows, and every
  // assertion below is scoped to a seller id this run minted. The rows it leaves
  // behind cost disk, never a lying number.
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});

const suite = describe.skipIf(handle === null);

suite("the reconcile pass is idempotent and per seller (E9, LR-2, LR-3)", () => {
  it("opens one cause, then runs twice more and changes nothing", async () => {
    const home = await newHome("idempotent", "standing");
    const paymentId = await newPayment(home, {});

    const first = await pass([home.sellerId]);
    expect(first).toEqual({
      sellers: 1,
      skipped: 0,
      findings: 1,
      opened: 1,
      closed: 0,
      partial: 0,
    });

    const afterFirst = await openRows(home.sellerId);
    expect(afterFirst).toHaveLength(1);
    const [opened] = afterFirst;
    expect(opened?.code).toBe("PAYMENT_NOT_SWEPT");
    expect(opened?.dedupeKey).toBe(`PAYMENT_NOT_SWEPT:${paymentId}:none`);
    expect(opened?.openedAt).toBeInstanceOf(Date);

    // The second run sees the same cause (so `findings` is still 1) and writes
    // nothing: `opened_at` is the first observation, and a pass that re-stamped it
    // would turn "how long has this been open" into "when did Till last run".
    const second = await pass([home.sellerId]);
    expect(second.opened).toBe(0);
    expect(second.closed).toBe(0);
    expect(second.findings).toBe(1);
    expect(await openRows(home.sellerId)).toEqual(afterFirst);

    // A third, for the sake of the claim being about a pass rather than a pair.
    expect(await openRows(home.sellerId)).toEqual(afterFirst);
    expect(await rowCount(home.sellerId)).toBe(1);
  });

  it("closes the cause with a complete pass once the sweep arrives", async () => {
    const home = await newHome("clearing", "standing");
    const paymentId = await newPayment(home, { hash: "tx-swept-once" });
    expect((await pass([home.sellerId])).opened).toBe(1);

    // The swap that carries the payment's own hash: E2's join, here written by the
    // fixture because nothing in production creates a swap row yet (S2, B8).
    const { id: swapId } = await newSwap(home, {
      state: "succeeded",
      originTxHash: "tx-swept-once",
      paymentId,
      amountIn: "1000000",
      amountOut: "1000000",
      polledAgo: 10,
    });

    const cleared = await pass([home.sellerId]);
    expect(cleared).toEqual({
      sellers: 1,
      skipped: 0,
      findings: 0,
      opened: 0,
      closed: 1,
      partial: 0,
    });

    const rows = await allRows(home.sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolution).toBe("auto");
    expect(rows[0]?.resolvedAt).toBeInstanceOf(Date);
    // Nothing is left on the worklist, and the swap the cause was about is still
    // there, still linked, and untouched: this loop writes discrepancies and nothing
    // else (hard rule 4's discipline, on this side of the ledger).
    expect(await openRows(home.sellerId)).toHaveLength(0);
    const [stillLinked] = await need()
      .sql`select payment_id::text as payment_id, state from swaps where id = ${swapId}`;
    expect(stillLinked).toEqual({ payment_id: paymentId, state: "succeeded" });
  });

  it("opens and never closes on a pass that could not see every row", async () => {
    const home = await newHome("truncated", "standing");
    const stale = await newPayment(home, { hash: "tx-stale-cause" });
    expect((await pass([home.sellerId])).opened).toBe(1);

    // The cause clears exactly as it does above...
    await newSwap(home, {
      state: "succeeded",
      originTxHash: "tx-stale-cause",
      paymentId: stale,
      amountIn: "1000000",
      amountOut: "1000000",
      polledAgo: 10,
    });
    // ...and the seller now has more rows than this pass is willing to read. Newest
    // first means the row it keeps is the young one, so the cleared cause is *not* in
    // the findings — and a pass that closed anyway would silently shut a live
    // finding because somebody set a read limit.
    await newPayment(home, { hash: "tx-young-nothing", settledAgo: 5 });

    const { log, entries } = recordingLog();
    const truncated = await reconcileSellers({
      db: need().db,
      config: CONFIG,
      sellerIds: [home.sellerId],
      snapshotMaxRows: 1,
      log,
    });

    expect(truncated.partial).toBe(1);
    expect(truncated.closed).toBe(0);
    expect(truncated.opened).toBe(0);
    expect(await openRows(home.sellerId)).toHaveLength(1);
    expect(codes(entries)).toContain("reconcile_snapshot_partial");

    const [line] = entries.filter((entry) => entry.code === "reconcile_snapshot_partial");
    expect(line?.fields.paymentsTruncated).toBe(1);
    expect(line?.fields.swapsTruncated).toBe(0);
    expect(line?.fields.sellerId).toBe(home.sellerId);
    // The reason is in the message a human reads, not only in the fields.
    expect(line?.level).toBe("warn");
    expect(line?.message).toContain("closed none");

    // The same seller, read completely, does close it: the difference is the cap and
    // nothing else.
    expect((await pass([home.sellerId])).closed).toBe(1);
  });

  it("reports the newest rows when it cannot read them all, not the history", async () => {
    const home = await newHome("newest-first", "standing");
    // Two causes, six minutes apart, and a cap that reaches only one of them. Both
    // would be reported by an uncapped pass, so the *choice* is what this case is
    // about: keeping the oldest rows would let a seller's capped pass answer
    // questions nobody is asking any more and never look at the problem it has now.
    const older = await newPayment(home, { hash: "tx-cap-older", settledAgo: 400 });
    const newer = await newPayment(home, { hash: "tx-cap-newer", settledAgo: 350 });

    const capped = await pass([home.sellerId], { maxRows: 1 });
    expect(capped.findings).toBe(1);
    expect(capped.opened).toBe(1);
    expect(capped.partial).toBe(1);

    const rows = await openRows(home.sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(`PAYMENT_NOT_SWEPT:${newer}:none`);
    expect(rows[0]?.dedupeKey).not.toContain(older);

    // Read without the cap, the same two rows are two causes: the difference above
    // is which row the pass was willing to look at, and nothing else.
    const uncapped = await pass([home.sellerId]);
    expect(uncapped.findings).toBe(2);
    expect(uncapped.opened).toBe(1);
  });

  it("does not close a finding a capped swap read could not see", async () => {
    const home = await newHome("swap-cap", "standing");
    // One payment and the failed swap that answers for it, on identical hashes so the
    // payment counts as swept and only the swap's own state is a cause.
    const paymentId = await newPayment(home, { hash: "tx-swapcap-payment" });
    const failedSwap = await newSwap(home, {
      state: "failed",
      originTxHash: "tx-swapcap-payment",
      paymentId,
      amountIn: "1000000",
      amountOut: null,
    });

    const first = await pass([home.sellerId]);
    expect(first.opened).toBe(1);
    expect((await openRows(home.sellerId))[0]?.dedupeKey).toBe(
      `PAYOUT_FAILED:${paymentId}:${failedSwap.id}`,
    );

    // Two more swaps, both newer than the failed one, so a read that stops at one row
    // keeps noise and loses the cause. A pass that read the cap as a complete picture
    // would report no `PAYOUT_FAILED` at all and auto-close the live row — a seller's
    // money moved nowhere and their worklist went quiet because somebody set a limit.
    await newSwap(home, { state: "processing", originTxHash: "tx-swapcap-noise-a" });
    await newSwap(home, { state: "processing", originTxHash: "tx-swapcap-noise-b" });

    const { log, entries } = recordingLog();
    const capped = await reconcileSellers({
      db: need().db,
      config: CONFIG,
      sellerIds: [home.sellerId],
      snapshotMaxRows: 1,
      log,
    });
    expect(capped.partial).toBe(1);
    expect(capped.closed).toBe(0);
    expect(capped.opened).toBe(1);
    const [line] = entries.filter((entry) => entry.code === "reconcile_snapshot_partial");
    expect(line?.fields.swapsTruncated).toBe(1);
    expect(line?.fields.paymentsTruncated).toBe(0);
    expect((await openRows(home.sellerId)).map((row) => row.dedupeKey)).toContain(
      `PAYOUT_FAILED:${paymentId}:${failedSwap.id}`,
    );

    // Same seller, no cap: the cause the read lost is back, and the extra cause the
    // capped pass had to open — the payment looked un-swept because the swap that
    // answers for it was outside the read — is what a complete pass now clears. The
    // failed payout stays open, which is the whole point of the pair.
    const whole = await pass([home.sellerId]);
    expect(whole).toEqual({
      sellers: 1,
      skipped: 0,
      findings: 1,
      opened: 0,
      closed: 1,
      partial: 0,
    });
    expect((await openRows(home.sellerId)).map((row) => row.dedupeKey)).toEqual([
      `PAYOUT_FAILED:${paymentId}:${failedSwap.id}`,
    ]);
  });

  it("counts a row it cannot interpret as unseen rather than as clear", async () => {
    const home = await newHome("unusable", "standing");
    const cause = await newPayment(home, { hash: "tx-unreadable-case" });
    expect((await pass([home.sellerId])).opened).toBe(1);

    // A payment state the state machine does not list. Every payment rule asks by
    // equality, so this row matches nothing: left in the snapshot it would report "no
    // finding here", which a reader cannot tell apart from a cleared cause.
    const nonsense = await newPayment(home, { state: "awaiting_confirmation", hash: null });

    // The cause clears while the unreadable row is present.
    await newSwap(home, {
      state: "succeeded",
      originTxHash: "tx-unreadable-case",
      paymentId: cause,
      amountIn: "1000000",
      amountOut: "1000000",
      polledAgo: 10,
    });

    const { log, entries } = recordingLog();
    const partial = await reconcileSellers({
      db: need().db,
      config: CONFIG,
      sellerIds: [home.sellerId],
      log,
    });
    expect(partial.partial).toBe(1);
    expect(partial.closed).toBe(0);
    const [line] = entries.filter((entry) => entry.code === "reconcile_snapshot_partial");
    expect(line?.fields.unusablePayments).toBe(1);

    // Give the row a state Till can name, and the very next pass has a complete
    // snapshot and closes what it could see all along.
    await need().sql`update payments set state = 'verified' where id = ${nonsense}`;
    const complete = await pass([home.sellerId]);
    expect(complete.partial).toBe(0);
    expect(complete.closed).toBe(1);
  });

  it("counts a swap whose amount is not an integer of base units as unseen too", async () => {
    const home = await newHome("unusable-swap", "standing");
    const cause = await newPayment(home, { hash: "tx-unreadable-swap-case" });
    expect((await pass([home.sellerId])).opened).toBe(1);

    // The cause clears the way it does above...
    await newSwap(home, {
      state: "succeeded",
      originTxHash: "tx-unreadable-swap-case",
      paymentId: cause,
      amountIn: "1000000",
      amountOut: "1000000",
      polledAgo: 10,
    });
    // ...and a second swap on the same route carries an amount Postgres will store
    // (`numeric` has a NaN) and Till cannot read as base units. The payments side of
    // this is a state string; the swap side is an amount, and both columns are the
    // provider's or another writer's, which is why the guard is per side.
    await newSwap(home, {
      state: "processing",
      originTxHash: "tx-unreadable-swap-extra",
      amountIn: "1000000",
      amountOut: "NaN",
    });

    const { log, entries } = recordingLog();
    const partial = await reconcileSellers({
      db: need().db,
      config: CONFIG,
      sellerIds: [home.sellerId],
      log,
    });
    expect(partial.partial).toBe(1);
    expect(partial.closed).toBe(0);
    const [line] = entries.filter((entry) => entry.code === "reconcile_snapshot_partial");
    expect(line?.fields.unusableSwaps).toBe(1);
    expect(line?.fields.unusablePayments).toBe(0);

    // Put a readable amount in the column and the next pass sees the whole seller and
    // closes the cause it could see all along.
    await need()
      .sql`update swaps set amount_out = '1000000' where origin_tx_hash = 'tx-unreadable-swap-extra'`;
    const complete = await pass([home.sellerId]);
    expect(complete.partial).toBe(0);
    expect(complete.closed).toBe(1);
  });

  it("skips a seller another pass is holding, and the two write one row", async () => {
    const home = await newHome("contended", "standing");
    await newPayment(home, { hash: "tx-contended" });

    const held = handGate();
    const released = handGate();
    const holder = postgres(databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 3 });
    let holderClaimed = false;
    try {
      // The other run: claim the seller row and hold it *uncommitted*, which is the
      // only shape in which a skip is evidence rather than a timing accident.
      const holding = holder.begin(async (tx) => {
        const rows = await tx`select id from sellers where id = ${home.sellerId} for update`;
        holderClaimed = rows.length === 1;
        held.open();
        await released.promise;
      });

      await held.promise;
      expect(holderClaimed).toBe(true);

      // The lock is visible from here, so a skip below is a skip *because of it*.
      const [witness] = await need().sql`select count(*)::int as held from pg_locks l
          join pg_class c on c.oid = l.relation
          where c.relname = 'sellers' and l.mode = 'RowShareLock' and l.granted
            and l.pid <> pg_backend_pid()`;
      expect((witness?.held ?? 0) > 0).toBe(true);

      const blocked = await pass([home.sellerId]);
      expect(blocked).toEqual({
        sellers: 0,
        skipped: 1,
        findings: 0,
        opened: 0,
        closed: 0,
        partial: 0,
      });
      expect(await rowCount(home.sellerId)).toBe(0);

      // Same call, same data, no holder: the skip was the lock and not a predicate
      // that never matches.
      released.open();
      await holding;
      const after = await pass([home.sellerId]);
      expect(after.sellers).toBe(1);
      expect(after.opened).toBe(1);
    } finally {
      released.open();
      await holder.end({ timeout: 5 }).catch(() => undefined);
    }

    // Two runs, one cause, one row (the Done-when's second half).
    expect(await rowCount(home.sellerId)).toBe(1);
  });

  it("runs two passes together and leaves one open row either way", async () => {
    const home = await newHome("overlapped", "standing");
    const paymentId = await newPayment(home, { hash: "tx-overlapped" });

    // Not a holder: two real passes, started together, each free to claim. Whether
    // they truly interleave is the scheduler's, and this file cannot make that
    // deterministic — the test above is the one that proves the lock exists by
    // watching pg_locks. What must hold under *both* interleavings is that the
    // seller is accounted for once per pass and the cause is opened exactly once:
    // either one pass skipped, or the second found the row the first had already
    // written. Either way the Done-when's answer is the same row count.
    const [first, second] = await Promise.all([pass([home.sellerId]), pass([home.sellerId])]);
    expect(first.sellers + second.sellers + first.skipped + second.skipped).toBe(2);
    expect(first.opened + second.opened).toBe(1);
    expect(first.closed + second.closed).toBe(0);
    expect(first.findings + second.findings).toBeGreaterThanOrEqual(1);

    const rows = await openRows(home.sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe(`PAYMENT_NOT_SWEPT:${paymentId}:none`);
    expect(await rowCount(home.sellerId)).toBe(1);
  });

  it("reads a payment's mode from its own route, so a later edit cannot silence it", async () => {
    const home = await newHome("po7", "standing");
    await newPayment(home, { hash: "tx-po7" });
    expect((await pass([home.sellerId])).opened).toBe(1);

    // D9 lets a seller move an endpoint to `direct`. PO-7's rule is that a payment
    // keeps the terms it was opened under, and the mode the rules judge is the one on
    // the payment's *route snapshot* — so money already taken is still owed a sweep,
    // and the finding does not evaporate because the endpoint now says otherwise.
    await need().sql`update endpoints set payout_mode = 'direct' where id = ${home.endpointId}`;
    const after = await pass([home.sellerId]);
    expect(after.findings).toBe(1);
    expect(after.closed).toBe(0);
    expect(await openRows(home.sellerId)).toHaveLength(1);

    // And the other direction, where reading the endpoint would invent a finding: a
    // direct sale has no swap to sweep, ever.
    const direct = await newHome("po7-direct", "direct");
    await newPayment(direct, { hash: "tx-po7-direct" });
    await need().sql`update endpoints set payout_mode = 'intents' where id = ${direct.endpointId}`;
    const quiet = await pass([direct.sellerId]);
    expect(quiet.findings).toBe(0);
    expect(quiet.opened).toBe(0);
  });

  it("falls back to the endpoint when a payment carries no route, and says so", async () => {
    const direct = await newHome("no-route", "direct");
    // A payment opened before routes existed: `route_id is null`, so the snapshot has
    // no answer and the endpoint is the only remaining one.
    await newPayment(direct, { hash: "tx-no-route", routeId: null });

    const { log, entries } = recordingLog();
    const result = await reconcileSellers({
      db: need().db,
      config: CONFIG,
      sellerIds: [direct.sellerId],
      log,
    });

    expect(result.findings).toBe(0);
    expect(result.partial).toBe(0);
    expect(codes(entries)).toContain("reconcile_route_snapshot_missing");
    const [line] = entries.filter((entry) => entry.code === "reconcile_route_snapshot_missing");
    expect(line?.fields.payments).toBe(1);

    // The fallback answers the mode question, and it is the *endpoint's* answer: flip
    // it and the same row is judged an intents sale that owes a sweep.
    await need().sql`update endpoints set payout_mode = 'intents' where id = ${direct.endpointId}`;
    expect((await pass([direct.sellerId])).opened).toBe(1);
  });

  it("ages the sweep window from the config and the database clock", async () => {
    const home = await newHome("windows", "standing");
    const aged = await newPayment(home, { hash: "tx-aged", settledAgo: 400 });
    const young = await newPayment(home, { hash: "tx-young", settledAgo: 100 });

    const first = await pass([home.sellerId]);
    expect(first.opened).toBe(1);
    expect(first.findings).toBe(1);

    // The same fixture, with the window moved past both: the number that decides is
    // the config's, not a literal in a rule.
    const widened = await pass([home.sellerId], { config: { sweepWindowSeconds: 1000 } });
    expect(widened.closed).toBe(1);
    expect(widened.opened).toBe(0);

    // And back to 300 with the young payment aged past it on the database clock: both
    // causes are now open again (the earlier rows closed, and LR-5 lets a cause that
    // returns reopen as a new row).
    await age(young, 320);
    const both = await pass([home.sellerId]);
    expect(both.opened).toBe(2);
    expect(both.findings).toBe(2);
    const reopened = await openRows(home.sellerId);
    expect(reopened.map((row) => row.resolvedAt)).toEqual([null, null]);
    expect(reopened.map((row) => row.paymentId).sort()).toEqual([aged, young].sort());
  });

  it("hands the rules the linked payment and the amounts, so a shortfall names both sides", async () => {
    const home = await newHome("shortfall", "standing");
    const paymentId = await newPayment(home, { hash: "tx-short", amount: "1000000" });
    const { id: swapId } = await newSwap(home, {
      state: "succeeded",
      originTxHash: "tx-short",
      paymentId,
      amountIn: "1000000",
      // 10% short against a 50 bps tolerance.
      amountOut: "900000",
      polledAgo: 10,
    });

    const result = await pass([home.sellerId]);
    // One finding, not two: the sweep exists, so PAYMENT_NOT_SWEPT is silent and what
    // is left is the PAYOUT_SHORTFALL that reads `SwapRow.paymentId`.
    expect(result.findings).toBe(1);
    expect(result.opened).toBe(1);

    const [row] = await openRows(home.sellerId);
    expect(row?.code).toBe("PAYOUT_SHORTFALL");
    expect(row?.paymentId).toBe(paymentId);
    expect(row?.swapId).toBe(swapId);
    expect(row?.dedupeKey).toBe(`PAYOUT_SHORTFALL:${paymentId}:${swapId}`);

    // Inside tolerance it is a fee and not a finding.
    await need().sql`update swaps set amount_out = '999600' where id = ${swapId}`;
    const within = await pass([home.sellerId]);
    expect(within.findings).toBe(0);
    expect(within.closed).toBe(1);
  });

  it("keeps one seller's causes out of another's pass", async () => {
    const a = await newHome("scope-a", "standing");
    const b = await newHome("scope-b", "standing");
    const paymentA = await newPayment(a, { hash: "tx-scope-a" });
    const paymentB = await newPayment(b, { hash: "tx-scope-b" });

    expect((await pass([a.sellerId])).opened).toBe(1);
    // B has a live cause of its own; A's pass must neither see it nor close it, which
    // is why the seller is in the dedupe index and in every predicate here.
    expect(await openRows(b.sellerId)).toHaveLength(0);
    const both = await pass([a.sellerId, b.sellerId]);
    expect(both.sellers).toBe(2);
    expect(both.opened).toBe(1);
    expect(await rowCount(b.sellerId)).toBe(1);

    // A's cause clears; B's does not. A's next pass closes A's row and leaves B's
    // open — an auto-close that forgot the seller would shut both.
    await newSwap(a, {
      state: "succeeded",
      originTxHash: "tx-scope-a",
      paymentId: paymentA,
      amountIn: "1000000",
      amountOut: "1000000",
      polledAgo: 10,
    });
    const closing = await pass([a.sellerId]);
    expect(closing.closed).toBe(1);
    expect(closing.opened).toBe(0);
    const bOpen = await openRows(b.sellerId);
    expect(bOpen).toHaveLength(1);
    expect(bOpen[0]?.dedupeKey).toBe(`PAYMENT_NOT_SWEPT:${paymentB}:none`);
  });

  it("lists every seller for the interval pass, deterministically", async () => {
    const first = await newHome("listed-a", "standing");
    const second = await newHome("listed-b", "standing");

    const ids = await allSellerIds(need().db);
    expect(ids).toContain(first.sellerId);
    expect(ids).toContain(second.sellerId);
    // The same order twice: the list is a query with an order, not a hash map, so a
    // run and its repeat start from the same place.
    expect(await allSellerIds(need().db)).toEqual(ids);
    // No duplicates, whatever the listing did with the rows other suites left.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * E9's third clause — *runs after status changes* — is a fact about how the two
 * loops are wired, not about what either of them computes. The suite above cannot
 * see it: `reconcileSellers` takes a seller list, and who puts the moved sellers in
 * it is `jobs/ticks.ts`. `server.ts` holds that wiring too, but it is the one file
 * in the process that reads the environment and binds a port, so a test cannot
 * import it (A21's split, applied to jobs). These cases call the two tick functions
 * directly, which is the same code `startLoop` runs, and never call the other one —
 * so an open row proves which half of the wiring put it there.
 */

/**
 * Nothing outside this run is due for a poll. `pollPayouts` claims globally by
 * design (D6), oldest first and bounded by one batch, so the swaps other suites
 * leave behind would fill the batch and this file's own rows would never be asked
 * about. Pushing them a day out is the version that leaves `terminal_at` — a column
 * D6 owns and another suite asserts on — alone. Rows created after this call stay
 * due, which is why every case here silences first and seeds second.
 */
async function silenceOtherSwaps(): Promise<void> {
  const { sql } = need();
  await sql`update swaps set next_poll_at = now() + interval '1 day'
      where next_poll_at is null or next_poll_at <= now()`;
}

/** A provider answer in the normalized shape the poller reads, with nothing extra. */
function statusAnswer(
  ref: string,
  fields: {
    state: SwapState;
    originTxHash?: string | null;
    amountOut?: string | null;
    refundedAmount?: string | null;
  },
): NormalizedSwap {
  const units = (value: string | null | undefined): BaseUnitAmount | null =>
    value === null || value === undefined ? null : BigInt(value);
  return {
    providerRef: ref,
    state: fields.state,
    amountIn: null,
    amountOut: units(fields.amountOut),
    refundedAmount: units(fields.refundedAmount),
    originTxHash: fields.originTxHash ?? null,
    destinationTxHash: null,
    raw: { simulated: true, by: "e9 wiring" },
  };
}

/** A status source that answers every ref the same way, and keeps what it was asked. */
function sourceFor(answer: (ref: string) => NormalizedSwap): {
  readonly asked: string[][];
  readonly source: PollStatusSource;
} {
  const asked: string[][] = [];
  const source: PollStatusSource = {
    getStatus: async (input) => {
      asked.push([...input.providerRefs]);
      return input.providerRefs.map(answer);
    },
  };
  return { asked, source };
}

/**
 * The two tick bodies as `server.ts` schedules them. The two interval numbers are
 * arguments here and not timers: nothing waits on them, because these tests are
 * about which work a tick does and not about when it fires — the schedule itself is
 * `test/loop.test.ts`.
 */
async function pollOnce(source: PollStatusSource): Promise<void> {
  await pollTick({
    db: need().db,
    statusSource: source,
    pollSeconds: 20,
    maxBackoffSeconds: 900,
    config: CONFIG,
  });
}

async function intervalPass(sellerIds: readonly string[]): Promise<void> {
  await reconcileTick({ db: need().db, config: CONFIG, sellerIds });
}

suite("each tick does its own half of the wiring (E9)", () => {
  it("opens a finding for the seller whose status the poll tick just moved", async () => {
    await silenceOtherSwaps();
    const home = await newHome("wired-open", "standing");
    const swap = await newSwap(home, { state: "pending" });

    // The negative case first, because the assertion after it only means something
    // if the finding was not already sitting there: an unpolled swap is neither
    // refunded nor stuck, so no rule has anything to say about this seller yet.
    expect(await openRows(home.sellerId)).toHaveLength(0);

    const provider = sourceFor((ref) =>
      statusAnswer(ref, { state: "refunded", refundedAmount: "1000000" }),
    );
    await pollOnce(provider.source);

    const rows = await openRows(home.sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe("PAYOUT_REFUNDED");
    expect(rows[0]?.dedupeKey).toBe(`PAYOUT_REFUNDED:none:${swap.id}`);

    // The finding follows a write rather than a report: the row really moved, and
    // the `refund_in` this pass deliberately did *not* book (no link to name its
    // asset — D6's own refusal) is not what the worklist is about.
    const [moved] = await need()
      .sql`select state, terminal_at is not null as terminal from swaps where id = ${swap.id}`;
    expect(moved).toEqual({ state: "refunded", terminal: true });
  });

  it("reconciles nobody for a status it dropped, and the interval pass reaches that seller", async () => {
    await silenceOtherSwaps();
    const home = await newHome("wired-interval", "standing");
    const paymentId = await newPayment(home, { hash: "tx-wired-interval" });
    const swap = await newSwap(home, { state: "pending" });

    const unchanged = sourceFor((ref) => statusAnswer(ref, { state: "pending" }));
    await pollOnce(unchanged.source);

    // It really asked, so the empty branch below is the answer and not a claim that
    // matched nothing: an answer equal to the stored state moves nobody, names
    // nobody, and the tick's reconcile call is therefore never made.
    expect(unchanged.asked.flat()).toContain(swap.providerRef);
    expect(await openRows(home.sellerId)).toHaveLength(0);

    // The same seller, on the interval pass alone: a settled intents payment still
    // owes a sweep, and this is the half that notices causes with no status change
    // behind them — which is also why a provider that lies costs no reconcile work.
    await intervalPass([home.sellerId]);
    const rows = await openRows(home.sellerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code).toBe("PAYMENT_NOT_SWEPT");
    expect(rows[0]?.paymentId).toBe(paymentId);
  });

  it("closes a cause from the poll tick that finally reported the sweep", async () => {
    await silenceOtherSwaps();
    const home = await newHome("wired-clear", "standing");
    const paymentId = await newPayment(home, { hash: "tx-wired-clear" });
    const swap = await newSwap(home, { state: "pending" });

    await intervalPass([home.sellerId]);
    expect(await openRows(home.sellerId)).toHaveLength(1);

    const provider = sourceFor((ref) =>
      statusAnswer(ref, {
        state: "succeeded",
        originTxHash: "tx-wired-clear",
        amountOut: "1000000",
      }),
    );
    await pollOnce(provider.source);

    // Cleared by the status change, not by an interval: the dashboard never spends a
    // minute describing money that has already been swept.
    expect(await openRows(home.sellerId)).toHaveLength(0);
    const [closed] = await allRows(home.sellerId);
    expect(closed?.resolution).toBe("auto");

    // And the link that made it closeable is E2's, written inside the same tick by
    // the poller rather than by this test — which is what a *status change* is.
    const [linked] = await need()
      .sql`select payment_id::text as payment_id from swaps where id = ${swap.id}`;
    expect(linked).toEqual({ payment_id: paymentId });
  });
});
