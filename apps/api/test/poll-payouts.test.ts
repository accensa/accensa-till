import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BaseUnitAmount, SwapState } from "@till/core";

import * as schema from "../src/db/schema.ts";
import { ledgerEntries, payments, payoutRoutes, sellers, swaps } from "../src/db/schema.ts";
import { type PollStatusSource, backoffSeconds, pollPayouts } from "../src/jobs/poll-payouts.ts";
import type { Logger } from "../src/lib/logger.ts";
import { MockProvider, type MockScript } from "../src/payouts/mock/provider.ts";
import type { NormalizedSwap } from "../src/payouts/provider.ts";

/**
 * D6's acceptance test (PO-4): provider statuses are polled into `swaps` by one loop
 * that never re-tells a finished story and never races itself.
 *
 * The two halves of the Done-when are run separately, because they are different
 * claims about different things:
 *
 * - *a simulated status regression is ignored*: a provider that answers `processing`
 *   for a swap already `succeeded` changes nothing — not the state, not the amounts,
 *   not the raw payload, and above all not the ledger. That case has to be scripted by
 *   hand, since the mock provider D2 wrote cannot regress (its outcomes only move
 *   forwards), so the suite answers `getStatus` itself for most cases.
 * - *two loops never process the same swap*: two passes running at the same moment,
 *   one of them standing inside its provider call while the other tries to claim the
 *   same rows. Each ref is then asked about once, by one loop.
 *
 * The rest of the file is what the loop is for rather than what it must not do: the
 * transition into terminal is the first production caller of `recordPayoutOut` and
 * `recordRefundIn` (E1 closed the writers, this opens the event source) and the first
 * caller of `linkSwapByHash` (E2 closed the join), so the ledger and link assertions
 * below are those two rows' evidence that anything actually calls them.
 *
 * Every count assertion depends on the due set being exactly this test's own rows, and
 * the claim is global by design — one process polls every swap that is due. `silence`
 * below is what makes that true on a scratch database shared with the other suites.
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
  // max: 10 so two concurrent passes really do get two connections, which is the
  // case the SKIP LOCKED half of this file is about.
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
/** The token the payer paid in, which is not the token the payout arrives in. */
const PAYMENT_ASSET = "usdc.testnet";
const DESTINATION_ASSET = "usdc";
const POLL_SECONDS = 20;

const home = {
  sellerId: randomUUID(),
  routeId: randomUUID(),
  label: "home",
};

async function seed(): Promise<void> {
  const { db } = need();
  await db.insert(sellers).values({
    id: home.sellerId,
    nearAccountId: `till-d6-${home.label}-${run}.testnet`,
    displayName: `D6 fixture ${home.label}`,
  });
  await db.insert(payoutRoutes).values({
    id: home.routeId,
    sellerId: home.sellerId,
    destinationChain: "near",
    destinationAsset: DESTINATION_ASSET,
    destinationAddress: `dest-${run}.testnet`,
    refundAddress: `refund-${run}.testnet`,
    provider: "mock",
    depositAddress: `mock-deposit-${run}`,
    quoteRef: `mock-quote-${run}`,
    modeDetail: "standing",
  });
}

/**
 * Take every existing swap out of the due set.
 *
 * The claim predicate is `terminal_at is null and the row's own gap has passed`, and
 * `pollPayouts` is a global loop on purpose, so the leftover rows the other suites
 * delete nothing would otherwise be counted as this pass's work. `terminal_at` is the
 * column to stamp because nothing else reads it yet — not the ledger, not the
 * reconciliation rules (which build their own snapshots), not a route — and every row
 * a test then mints is created after this call, so it is never affected.
 */
async function silence(): Promise<void> {
  const { sql } = need();
  await sql`update swaps set terminal_at = now() where terminal_at is null`;
}

/** A swap this file owns, in whatever state and schedule the case asks for. */
async function newSwap(fields: {
  state?: string;
  terminalAt?: Date | null;
  nextPollAt?: Date | null;
  pollAttempts?: number;
  originTxHash?: string | null;
  amountIn?: string | null;
  amountOut?: string | null;
  raw?: unknown;
}): Promise<{ id: string; providerRef: string }> {
  const { db } = need();
  const providerRef = `d6-ref-${randomUUID()}`;
  const [row] = await db
    .insert(swaps)
    .values({
      routeId: home.routeId,
      providerRef,
      state: fields.state ?? "pending",
      terminalAt: fields.terminalAt ?? null,
      nextPollAt: fields.nextPollAt ?? null,
      pollAttempts: fields.pollAttempts ?? 0,
      originTxHash: fields.originTxHash ?? null,
      amountIn: fields.amountIn ?? null,
      amountOut: fields.amountOut ?? null,
      raw: fields.raw ?? { simulated: true, seeded: "before the poll" },
    })
    .returning({ id: swaps.id });
  if (row === undefined) {
    throw new Error("fixture wrote no swap row");
  }
  return { id: row.id, providerRef };
}

/** A settled payment carrying `hash`: what the link is made from. */
async function newPayment(hash: string | null): Promise<string> {
  const { db } = need();
  const endpointId = randomUUID();
  await db.insert(schema.endpoints).values({
    id: endpointId,
    sellerId: home.sellerId,
    slug: `d6-${randomUUID()}`,
    upstreamUrl: "https://example.test/data",
    priceAmount: "1000000",
    assetContract: PAYMENT_ASSET,
    network: "near:testnet",
    payoutMode: "intents",
    routeId: home.routeId,
  });
  const [row] = await db
    .insert(payments)
    .values({
      endpointId,
      routeId: home.routeId,
      payerAccountId: "buyer.testnet",
      amount: "1000000",
      assetContract: PAYMENT_ASSET,
      replayKey: `d6-${randomUUID()}`,
      state: "settled",
      nearTxHash: hash,
      verifiedAt: new Date("2026-11-01T10:00:00.000Z"),
      settledAt: new Date("2026-11-01T10:01:00.000Z"),
    })
    .returning({ id: payments.id });
  if (row === undefined) {
    throw new Error("fixture wrote no payment row");
  }
  return row.id;
}

type SwapRow = {
  readonly state: string;
  readonly amountIn: string | null;
  readonly amountOut: string | null;
  readonly refundedAmount: string | null;
  readonly originTxHash: string | null;
  readonly destinationTxHash: string | null;
  readonly paymentId: string | null;
  readonly raw: unknown;
  readonly lastPolledAt: Date | null;
  readonly terminalAt: Date | null;
  readonly pollAttempts: number;
};

async function swapRow(id: string): Promise<SwapRow> {
  const { db } = need();
  const [row] = await db.select().from(swaps).where(eq(swaps.id, id));
  if (row === undefined) {
    throw new Error(`no swap ${id}`);
  }
  return row;
}

/**
 * Seconds until this row is due again, on the database clock (hard rule 12), so the
 * gap is judged as the interval it is rather than as a timestamp the test would have
 * to compare with its own wall clock.
 */
async function gapSeconds(id: string): Promise<number> {
  const { sql } = need();
  const [row] = await sql`select extract(epoch from (next_poll_at - now()))::int as secs
      from swaps where id = ${id}`;
  return row?.secs ?? -1;
}

/** Seconds since the row was last answered, negative when it never was. */
async function polledSecondsAgo(id: string): Promise<number | null> {
  const { sql } = need();
  const [row] = await sql`select extract(epoch from (now() - last_polled_at))::int as secs
      from swaps where id = ${id}`;
  return row?.secs ?? null;
}

type Line = {
  readonly kind: string;
  readonly amount: string;
  readonly asset: string;
  readonly paymentId: string | null;
  readonly swapId: string | null;
};

/** What was booked against one swap, never the whole table. */
async function bookedLines(swapId: string): Promise<readonly Line[]> {
  const { db } = need();
  return db
    .select({
      kind: ledgerEntries.kind,
      amount: ledgerEntries.amount,
      asset: ledgerEntries.asset,
      paymentId: ledgerEntries.paymentId,
      swapId: ledgerEntries.swapId,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.swapId, swapId))
    .orderBy(ledgerEntries.createdAt, ledgerEntries.id);
}

/**
 * A provider the test answers by hand. Most of the requirement is about answers a
 * real provider gives and D2's mock cannot — a terminal swap reported as still
 * running, an unknown status name, a float where an integer belongs — and a mock
 * that could only tell the truth would test the poller's happy path and nothing that
 * has to be refused.
 */
function fakeProvider(onAsk: (refs: readonly string[]) => Promise<readonly NormalizedSwap[]>): {
  readonly source: PollStatusSource;
  readonly asked: string[][];
} {
  const asked: string[][] = [];
  return {
    asked,
    source: {
      getStatus: async (input) => {
        asked.push([...input.providerRefs]);
        return onAsk(input.providerRefs);
      },
    },
  };
}

/**
 * The amount and hash fields are typed as the provider's own normalized shape, so
 * every value goes through `BigInt` here. The two cases that need something the type
 * refuses — a status name outside the enum and a float amount — pass a value that is
 * cast at the call site instead, and that cast is the test: the boundary being checked
 * is what arrives over the wire at runtime, which `tsc` has already agreed to by the
 * time this function is called.
 */
function answer(
  ref: string,
  fields: {
    state?: string;
    amountIn?: string | null;
    amountOut?: string | null | number;
    refundedAmount?: string | null;
    originTxHash?: string | null;
    destinationTxHash?: string | null;
    raw?: unknown;
  } = {},
): NormalizedSwap {
  const units = (value: string | null | undefined): BaseUnitAmount | null =>
    value === null || value === undefined ? null : BigInt(value);
  return {
    providerRef: ref,
    state: (fields.state ?? "processing") as SwapState,
    amountIn: units(fields.amountIn),
    amountOut:
      typeof fields.amountOut === "number"
        ? // Deliberately not an integer: `1.5n` is not a thing, and the point is what
          // a provider that ignored hard rule 3 would send.
          (String(fields.amountOut) as unknown as BaseUnitAmount)
        : units(fields.amountOut),
    refundedAmount: units(fields.refundedAmount),
    originTxHash: fields.originTxHash ?? null,
    destinationTxHash: fields.destinationTxHash ?? null,
    raw: fields.raw ?? { simulated: true, polled: "by the test" },
  };
}

/** Answers every ref asked about with the same report. */
function always(fields: Parameters<typeof answer>[1]) {
  return async (refs: readonly string[]) => refs.map((ref) => answer(ref, fields));
}

/** A logger that keeps what was said, because four of these tests are about a refusal being *reported*. */
type Entry = {
  readonly level: string;
  readonly code: string;
  readonly fields: Record<string, unknown>;
};

function recordingLog(): { readonly log: Logger; readonly entries: Entry[] } {
  const entries: Entry[] = [];
  const push = (level: string) => (fields: Record<string, unknown>) => {
    entries.push({ level, code: String(fields.code ?? ""), fields });
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

/**
 * D2's provider holding one script, at a reference this table has not used yet.
 *
 * The mock numbers its refs from one per instance (`mock-quote-1`, `mock-quote-2`, …)
 * and `swaps.provider_ref` is unique, while this file deletes nothing — so on a second
 * run of this suite the first ref it prepares belongs to a row the first run left
 * behind, and the insert would fail on the unique index. The honest fix is to reach an
 * unused index rather than to rename the ref in front of the provider: the earlier
 * routes are prepared with the same script and simply never asked about, which keeps
 * this case polling D2's real answers (states, amounts, hashes, `mock-out-` destination)
 * through the same interface the loop uses in production.
 */
async function scriptedMock(
  script: MockScript,
): Promise<{ readonly provider: MockProvider; readonly quoteRef: string }> {
  const [taken] = await need()
    .sql`select coalesce(max((split_part(provider_ref, '-', 3))::int), 0) as highest
      from swaps
      where provider_ref ~ '^mock-quote-[0-9]+$'`;
  const target = (taken?.highest ?? 0) + 1;
  const provider = new MockProvider(Array.from({ length: target }, () => script));
  let quoteRef: string | null = null;
  for (let index = 0; index < target; index += 1) {
    quoteRef = (
      await provider.prepareRoute({
        destinationChain: "near",
        destinationAsset: DESTINATION_ASSET,
        destinationAddress: `dest-${run}.testnet`,
        refundAddress: `refund-${run}.testnet`,
        amount: null,
      })
    ).quoteRef;
  }
  if (quoteRef === null) {
    throw new Error("the mock prepared a route with no ref to poll");
  }
  return { provider, quoteRef };
}

function poll(deps: {
  provider: PollStatusSource;
  batchSize?: number;
  maxBackoffSeconds?: number;
  log?: Logger;
}) {
  const { db } = need();
  return pollPayouts({
    db,
    provider: deps.provider,
    pollSeconds: POLL_SECONDS,
    maxBackoffSeconds: deps.maxBackoffSeconds ?? 900,
    ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
}

afterAll(async () => {
  // No deletes: a swap a ledger line points at cannot be removed (A7's append-only
  // table holds the foreign key), and the payments this file mints are other suites'
  // candidate rows. Every assertion is scoped to an id minted above instead.
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});

const suite = describe.skipIf(handle === null);

suite("the payout poller polls, refuses and reschedules (D6, PO-4)", () => {
  beforeAll(seed);
  beforeEach(silence);

  it("writes what the provider answered and calls it a poll", async () => {
    const hash = `tx-${randomUUID()}`;
    const { id, providerRef } = await newSwap({ state: "pending" });
    const provider = fakeProvider(
      always({ state: "processing", amountIn: "1000000", originTxHash: hash }),
    );

    const polled = await poll({ provider: provider.source });

    expect(polled).toEqual({
      claimed: 1,
      moved: 1,
      terminal: 0,
      booked: 0,
      ignored: 0,
      retried: 0,
    });
    expect(provider.asked).toEqual([[providerRef]]);
    const row = await swapRow(id);
    expect(row.state).toBe("processing");
    expect(row.amountIn).toBe("1000000");
    expect(row.originTxHash).toBe(hash);
    expect(row.lastPolledAt).not.toBeNull();
    expect(row.terminalAt).toBeNull();
    expect(row.pollAttempts).toBe(0);
    // The row's own next gap, on the database clock: due in about a poll interval,
    // and not before it.
    expect(await gapSeconds(id)).toBeGreaterThan(0);
  });

  it("does not ask again about a swap whose own gap has not passed", async () => {
    const first = fakeProvider(always({ state: "processing" }));
    await newSwap({ state: "pending" });
    expect((await poll({ provider: first.source })).claimed).toBe(1);

    const second = fakeProvider(always({ state: "succeeded", amountOut: "1" }));
    const polled = await poll({ provider: second.source });

    expect(polled.claimed).toBe(0);
    expect(second.asked).toEqual([]);
  });

  it("asks again once the gap has passed", async () => {
    const { id } = await newSwap({
      state: "processing",
      nextPollAt: new Date(Date.now() - 60_000),
    });
    const provider = fakeProvider(always({ state: "processing" }));

    expect((await poll({ provider: provider.source })).claimed).toBe(1);
    expect(await gapSeconds(id)).toBeGreaterThan(0);
  });

  it("bounds one pass to its batch", async () => {
    const refs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      refs.push((await newSwap({ state: "pending" })).providerRef);
    }
    const provider = fakeProvider(always({ state: "processing" }));

    const polled = await poll({ provider: provider.source, batchSize: 2 });

    expect(polled.claimed).toBe(2);
    expect(provider.asked.length).toBe(1);
    if (provider.asked[0] === undefined) {
      throw new Error("the pass made no provider call");
    }
    expect(provider.asked[0].length).toBe(2);
    expect(refs.length).toBe(3);
  });

  it("two loops at once never process the same swap", async () => {
    // The case the Done-when names. `slow` claims the rows and stands inside its
    // provider call, so its transaction still holds every one of them locked; the
    // second pass then runs against the same table and must not be handed a single
    // row. The row lock is the only thing that makes this true — the gap does not,
    // because the first pass has not committed its stamp yet — so a claim that
    // forgot `skip locked` shows up here as the second loop asking about refs the
    // first one is already answering.
    const refs = [
      (await newSwap({ state: "pending" })).providerRef,
      (await newSwap({ state: "pending" })).providerRef,
      (await newSwap({ state: "pending" })).providerRef,
      (await newSwap({ state: "pending" })).providerRef,
    ];

    const holding = handGate();
    const release = handGate();
    const askedByFirst: string[][] = [];
    const first: PollStatusSource = {
      getStatus: async (input) => {
        askedByFirst.push([...input.providerRefs]);
        holding.open();
        await release.promise;
        return input.providerRefs.map((ref) =>
          answer(ref, { state: "succeeded", amountOut: "500000" }),
        );
      },
    };
    const second = fakeProvider(always({ state: "succeeded", amountOut: "500000" }));

    const racing = poll({ provider: first });
    try {
      await holding.promise;
      const concurrent = await poll({ provider: second.source });

      expect(concurrent.claimed).toBe(0);
      expect(second.asked).toEqual([]);

      release.open();
      const won = await racing;
      expect(won.claimed).toBe(refs.length);
      expect(askedByFirst.flat().sort()).toEqual([...refs].sort());
      expect(askedByFirst.flat().length).toBe(new Set(askedByFirst.flat()).size);
    } finally {
      release.open();
      await racing.catch(() => undefined);
    }
  });

  it("leaves a terminal swap out of the claim entirely", async () => {
    const { id } = await newSwap({ state: "succeeded", terminalAt: new Date() });
    const provider = fakeProvider(always({ state: "processing" }));

    const polled = await poll({ provider: provider.source });

    expect(polled.claimed).toBe(0);
    expect(provider.asked).toEqual([]);
    // Untouched, including the schedule: a terminal row is not rescheduled, because
    // nothing asked it anything.
    const row = await swapRow(id);
    expect(row.state).toBe("succeeded");
    expect(row.lastPolledAt).toBeNull();
  });

  it("ignores a simulated status regression on a terminal swap", async () => {
    // PO-4's own sentence, and the reason the row is seeded terminal but *unstamped*:
    // the claim predicate would otherwise never hand this row over, and the sticky
    // rule would be untestable. A row that reads `succeeded` with no `terminal_at` is
    // exactly what a swap that reached terminal before this loop existed looks like,
    // so the disagreement is reached the way it is reached in a real database: by a
    // terminal row being polled.
    const { log, entries } = recordingLog();
    const { id } = await newSwap({
      state: "succeeded",
      terminalAt: null,
      amountIn: "1000000",
      amountOut: "950000",
      originTxHash: "tx-kept",
      raw: { simulated: true, kept: "the succeeded payload" },
    });
    const before = await swapRow(id);
    const provider = fakeProvider(always({ state: "processing", amountIn: "7", amountOut: null }));

    const polled = await poll({ provider: provider.source, log });

    expect(polled.ignored).toBe(1);
    expect(polled.moved).toBe(0);
    const row = await swapRow(id);
    expect(row.state).toBe(before.state);
    expect(row.amountIn).toBe("1000000");
    expect(row.amountOut).toBe("950000");
    expect(row.originTxHash).toBe("tx-kept");
    expect(row.raw).toEqual(before.raw);
    // Convergence, not a rewrite: the stamp the row was missing gets filled so the
    // next pass does not claim it again, and that is the only column that moves.
    expect(row.terminalAt).not.toBeNull();
    expect(codes(entries)).toEqual(["poll_status_ignored_terminal"]);
    expect(await bookedLines(id)).toEqual([]);
  });

  it("ignores a backwards move that is not terminal either", async () => {
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "processing", amountIn: "1000000" });
    const provider = fakeProvider(always({ state: "pending", amountIn: "3" }));

    const polled = await poll({ provider: provider.source, log });

    expect(polled.ignored).toBe(1);
    const row = await swapRow(id);
    expect(row.state).toBe("processing");
    expect(row.amountIn).toBe("1000000");
    expect(codes(entries)).toEqual(["poll_status_regression"]);
  });

  it("treats the same status twice as progress, not a regression", async () => {
    // `canTransitionSwap` has no self-edge — processing -> processing is not in the
    // table — and a poller that read the table alone would log a disagreement on every
    // routine poll of a stalled swap, which is what D2's `stall` outcome is.
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "processing", amountIn: "1000000" });
    const provider = fakeProvider(always({ state: "processing", amountIn: "1000000" }));

    const polled = await poll({ provider: provider.source, log });

    expect(polled).toMatchObject({ claimed: 1, moved: 0, ignored: 0 });
    expect(codes(entries)).toEqual([]);
    expect((await swapRow(id)).state).toBe("processing");
  });

  it("maps a status name it does not know to processing, never to finished", async () => {
    const { id } = await newSwap({ state: "pending" });
    const provider = fakeProvider(always({ state: "MOCK_VICTORIOUS" }));

    const polled = await poll({ provider: provider.source });

    expect(polled).toMatchObject({ moved: 1, terminal: 0, booked: 0 });
    expect((await swapRow(id)).state).toBe("processing");
  });

  it("books one payout_out when a swap succeeds, in the destination's asset", async () => {
    const hash = `tx-${randomUUID()}`;
    const paymentId = await newPayment(hash);
    const { id } = await newSwap({ state: "pending", originTxHash: hash });
    const provider = fakeProvider(
      always({
        state: "succeeded",
        amountIn: "1000000",
        amountOut: "950000",
        destinationTxHash: "dst-1",
      }),
    );

    const polled = await poll({ provider: provider.source });

    expect(polled).toMatchObject({ moved: 1, terminal: 1, booked: 1 });
    const row = await swapRow(id);
    expect(row.state).toBe("succeeded");
    expect(row.terminalAt).not.toBeNull();
    expect(row.paymentId).toBe(paymentId);
    expect(await bookedLines(id)).toEqual([
      {
        kind: "payout_out",
        amount: "950000",
        asset: DESTINATION_ASSET,
        paymentId,
        swapId: id,
      },
    ]);
  });

  it("books one line for a payout that keeps reporting itself as finished", async () => {
    // E1 left this question open: is a repeated `succeeded` one event or two? D6's
    // answer is one, because the payout is the transition and the status is a reading
    // of it — so a second pass over a terminal row must not append a second line.
    // The row is unstamped again to reach the sticky path rather than the claim
    // filter, which is the other half of the same answer.
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "pending" });
    const succeeded = always({ state: "succeeded", amountOut: "900000" });

    expect((await poll({ provider: fakeProvider(succeeded).source })).booked).toBe(1);
    // Take the stamp back off, which is what a row that reached terminal before this
    // column existed looks like. `silence` cannot do it here: it only ever stamps rows
    // whose stamp is missing, so this row would stay out of the claim and the test
    // would show the filter working rather than the sticky rule.
    await need().sql`update swaps set terminal_at = null, next_poll_at = null where id = ${id}`;

    const again = await poll({ provider: fakeProvider(succeeded).source, log });

    expect(again).toMatchObject({ claimed: 1, moved: 0, booked: 0, ignored: 1 });
    expect(await bookedLines(id)).toHaveLength(1);
    expect(codes(entries)).toEqual(["poll_status_ignored_terminal"]);
  });

  it("books a refund in the payment's asset, not the destination's", async () => {
    const hash = `tx-${randomUUID()}`;
    const paymentId = await newPayment(hash);
    const { id } = await newSwap({ state: "processing", originTxHash: hash });
    const provider = fakeProvider(
      always({ state: "refunded", amountIn: "1000000", refundedAmount: "1000000" }),
    );

    const polled = await poll({ provider: provider.source });

    expect(polled).toMatchObject({ terminal: 1, booked: 1 });
    expect(await bookedLines(id)).toEqual([
      {
        kind: "refund_in",
        amount: "1000000",
        asset: PAYMENT_ASSET,
        paymentId,
        swapId: id,
      },
    ]);
  });

  it("refuses to book a refund it cannot name an asset for", async () => {
    // The asset a refund came back in is a fact about the payment, and with no link
    // there is no payment to read it off. A guessed asset would make E4's finding
    // unfixable, so the line is not written and the reason is logged.
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "processing" });
    const provider = fakeProvider(always({ state: "refunded", refundedAmount: "1000000" }));

    const polled = await poll({ provider: provider.source, log });

    expect(polled).toMatchObject({ terminal: 1, booked: 0 });
    expect((await swapRow(id)).state).toBe("refunded");
    expect(await bookedLines(id)).toEqual([]);
    expect(codes(entries)).toEqual(["poll_refund_unbooked"]);
  });

  it("refuses to book a succeeded swap that reports no payout amount", async () => {
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "pending" });
    const provider = fakeProvider(always({ state: "succeeded", amountOut: null }));

    const polled = await poll({ provider: provider.source, log });

    expect(polled).toMatchObject({ terminal: 1, booked: 0 });
    expect((await swapRow(id)).state).toBe("succeeded");
    expect(await bookedLines(id)).toEqual([]);
    expect(codes(entries)).toEqual(["poll_payout_unbooked"]);
  });

  it("books nothing for a failure, which is a rule's business and not the ledger's", async () => {
    const { id } = await newSwap({ state: "pending" });
    const provider = fakeProvider(always({ state: "failed" }));

    const polled = await poll({ provider: provider.source });

    expect(polled).toMatchObject({ terminal: 1, booked: 0 });
    expect((await swapRow(id)).state).toBe("failed");
    expect(await bookedLines(id)).toEqual([]);
  });

  it("links the swap it polled to the payment that carries its hash", async () => {
    // E2 closed the join and said D6's loop was the caller. This is that call.
    const hash = `tx-${randomUUID()}`;
    const paymentId = await newPayment(hash);
    const { id } = await newSwap({ state: "processing" });
    const provider = fakeProvider(always({ state: "processing", originTxHash: hash }));

    await poll({ provider: provider.source });

    const row = await swapRow(id);
    expect(row.paymentId).toBe(paymentId);
    expect(row.originTxHash).toBe(hash);
  });

  it("leaves one hash shared by two payments unlinked and says which two", async () => {
    const { log, entries } = recordingLog();
    const hash = `tx-${randomUUID()}`;
    const first = await newPayment(hash);
    const second = await newPayment(hash);
    const { id } = await newSwap({ state: "processing" });
    const provider = fakeProvider(always({ state: "processing", originTxHash: hash }));

    const polled = await poll({ provider: provider.source, log });

    expect(polled).toMatchObject({ claimed: 1, booked: 0 });
    const row = await swapRow(id);
    expect(row.paymentId).toBeNull();
    // The hash is still written: refusing to *choose* between two payments is not a
    // reason to lose the evidence that a payment has to be reconciled against.
    expect(row.originTxHash).toBe(hash);
    expect(codes(entries)).toContain("poll_link_ambiguous");
    const warning = entries.find((entry) => entry.code === "poll_link_ambiguous");
    // Both ids, in whichever order the join read them: the names are the finding, and
    // the order of two rows that share a hash is not a fact.
    expect(warning?.fields.candidates).toEqual([first, second].sort());
  });

  it("does not unlink a swap because a report stopped carrying the hash", async () => {
    // S5: the provider's hash arrays are empty until the money moves, so a null hash
    // means "not reported yet" and overwriting the recorded one would destroy the
    // only evidence the join has.
    const hash = `tx-${randomUUID()}`;
    const { id } = await newSwap({ state: "processing", originTxHash: hash });
    const provider = fakeProvider(always({ state: "processing", originTxHash: null }));

    await poll({ provider: provider.source });

    expect((await swapRow(id)).originTxHash).toBe(hash);
  });

  it("writes nothing when the provider throws, and stops asking so often", async () => {
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "pending", amountIn: "1000000" });
    const provider = fakeProvider(async () => {
      throw new Error("1Click said 500");
    });

    const polled = await poll({ provider: provider.source, log });

    expect(polled).toMatchObject({ claimed: 1, moved: 0, booked: 0, retried: 1 });
    const row = await swapRow(id);
    expect(row.state).toBe("pending");
    expect(row.amountIn).toBe("1000000");
    // The column answers "when did the provider last talk to us" (UI-5), and a call
    // that threw did not.
    expect(row.lastPolledAt).toBeNull();
    expect(row.pollAttempts).toBe(1);
    expect(await gapSeconds(id)).toBeGreaterThanOrEqual(POLL_SECONDS * 2 - 1);
    expect(codes(entries)).toEqual(["poll_provider_failed"]);
  });

  it("doubles the retry gap per attempt, caps it, and clears it on an answer", async () => {
    const { id } = await newSwap({ state: "pending", pollAttempts: 3 });
    const failing = fakeProvider(async () => {
      throw new Error("still down");
    });

    await poll({ provider: failing.source, maxBackoffSeconds: 900 });
    expect((await swapRow(id)).pollAttempts).toBe(4);
    expect(await gapSeconds(id)).toBeGreaterThanOrEqual(POLL_SECONDS * 16 - 1);

    await need().sql`update swaps set next_poll_at = now() - interval '1 hour' where id = ${id}`;
    await poll({
      provider: fakeProvider(async () => {
        throw new Error("still down");
      }).source,
      maxBackoffSeconds: 45,
    });
    expect(await gapSeconds(id)).toBeLessThanOrEqual(46);

    await need().sql`update swaps set next_poll_at = now() - interval '1 hour' where id = ${id}`;
    const healthy = fakeProvider(always({ state: "processing" }));
    expect((await poll({ provider: healthy.source })).retried).toBe(0);
    const row = await swapRow(id);
    expect(row.pollAttempts).toBe(0);
    expect(row.lastPolledAt).not.toBeNull();
    expect(await polledSecondsAgo(id)).toBeGreaterThanOrEqual(0);
  });

  it("leaves a ref the provider did not answer for exactly as it was", async () => {
    // D2's refusal, on the poller's side: an absent answer is not a state, and a
    // poller that defaulted it to `processing` would turn a silent provider into a
    // stalled swap and a false reconciliation finding.
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "pending", raw: { simulated: true, kept: true } });
    const provider = fakeProvider(async () => []);

    const polled = await poll({ provider: provider.source, log });

    expect(polled).toMatchObject({ claimed: 1, moved: 0, ignored: 0 });
    const row = await swapRow(id);
    expect(row.state).toBe("pending");
    expect(row.raw).toEqual({ simulated: true, kept: true });
    expect(row.lastPolledAt).toBeNull();
    expect(codes(entries)).toEqual(["poll_ref_unanswered"]);
  });

  it("refuses an amount that is not an integer of base units", async () => {
    const { log, entries } = recordingLog();
    const { id } = await newSwap({ state: "pending" });
    const provider = fakeProvider(always({ state: "succeeded", amountOut: 1.5 }));

    const polled = await poll({ provider: provider.source, log });

    expect(polled).toMatchObject({ moved: 0, booked: 0 });
    const row = await swapRow(id);
    expect(row.state).toBe("pending");
    expect(row.amountOut).toBeNull();
    expect(codes(entries)).toEqual(["poll_answer_unusable"]);
  });

  it("runs the scripted mock provider end to end, still marked as simulated", async () => {
    // The same loop against D2's provider rather than a stand-in, so PO-5's offline
    // flow includes the poller: quote, swap row, poll, terminal, ledger.
    const hash = `tx-${randomUUID()}`;
    const { provider: mock, quoteRef } = await scriptedMock({
      outcome: "succeed",
      amountIn: 1_000_000n,
      amountOut: 990_000n,
      originTxHash: hash,
    });
    const paymentId = await newPayment(hash);
    const [inserted] = await need()
      .db.insert(swaps)
      .values({
        routeId: home.routeId,
        providerRef: quoteRef,
        state: "pending",
        raw: { simulated: true },
      })
      .returning({ id: swaps.id });
    if (inserted === undefined) {
      throw new Error("fixture wrote no swap row");
    }

    const polled = await poll({ provider: mock });

    expect(polled).toMatchObject({ claimed: 1, moved: 1, terminal: 1, booked: 1 });
    const row = await swapRow(inserted.id);
    expect(row.state).toBe("succeeded");
    expect(row.amountOut).toBe("990000");
    expect(row.destinationTxHash).toBe(`mock-out-${quoteRef}`);
    expect(row.paymentId).toBe(paymentId);
    expect(row.raw).toMatchObject({ simulated: true, provider: "mock", outcome: "succeed" });
    const [line] = await bookedLines(inserted.id);
    expect(line?.kind).toBe("payout_out");
    expect(line?.amount).toBe("990000");
  });
});

describe("the retry gap is a doubling with a ceiling (D6)", () => {
  it("doubles per attempt and stops at the ceiling", () => {
    expect(backoffSeconds(20, 1, 900)).toBe(40);
    expect(backoffSeconds(20, 4, 900)).toBe(320);
    expect(backoffSeconds(20, 30, 900)).toBe(900);
    expect(backoffSeconds(20, 1_000, 900)).toBe(900);
  });

  it("never asks about a failing swap sooner than a healthy one", () => {
    // The shape env's own guard protects: an attempt count of 0 is the first retry,
    // so it has to be at least the interval.
    expect(backoffSeconds(20, 0, 900)).toBe(20);
  });
});
