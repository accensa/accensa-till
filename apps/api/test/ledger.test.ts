import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@till/core";

import * as schema from "../src/db/schema.ts";
import {
  endpoints,
  ledgerEntries,
  payments,
  payoutRoutes,
  sellers,
  swaps,
} from "../src/db/schema.ts";
import {
  recordAdjustment,
  recordPayoutOut,
  recordRefundIn,
  recordSettlement,
} from "../src/services/ledger.ts";

/**
 * E1's acceptance test (LR-1): the ledger books **one entry per event**, and the
 * service is the only way to book one.
 *
 * The counting is per fixture row, never per table: `ledger_entries` on the shared
 * database holds every other suite's money, so a count that is not filtered by the
 * payment or the swap this file minted would be measuring what ran before it.
 *
 * Everything here is the service's own surface. What the *caller* must guarantee —
 * that a swap reporting `succeeded` twice is one event and not two — belongs to the
 * poller (D6) and is tested there, because the writer's job is the opposite: to
 * append, so that a second event is a second row rather than an edit nobody can
 * audit. A7 proved `UPDATE` and `DELETE` raise on this table; these tests prove the
 * four kinds are what a correct system writes, and that the database — not the
 * writer's memory — decides their signs.
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
const ids = {
  sellerId: randomUUID(),
  endpointId: randomUUID(),
  routeId: randomUUID(),
  nearAccount: `till-e1-${run}.testnet`,
  slug: `e1-${randomUUID()}`,
} as const;

const ASSET = "usdc.testnet";
const PRICE = "2500000";

/** A payment this file owns. The ledger only needs the row to exist for its foreign key. */
async function newPayment(): Promise<string> {
  const { db } = need();
  const [row] = await db
    .insert(payments)
    .values({
      endpointId: ids.endpointId,
      routeId: ids.routeId,
      payerAccountId: "buyer.testnet",
      amount: PRICE,
      assetContract: ASSET,
      replayKey: `e1-${randomUUID()}`,
      state: "settled",
      verifiedAt: new Date(),
    })
    .returning({ id: payments.id });
  if (row === undefined) {
    throw new Error("fixture wrote no payment row");
  }
  return row.id;
}

/** A swap this file owns, for the two kinds a payout produces. */
async function newSwap(): Promise<string> {
  const { db } = need();
  const [row] = await db
    .insert(swaps)
    .values({
      routeId: ids.routeId,
      providerRef: `e1-ref-${randomUUID()}`,
      state: "succeeded",
      raw: { simulated: true },
    })
    .returning({ id: swaps.id });
  if (row === undefined) {
    throw new Error("fixture wrote no swap row");
  }
  return row.id;
}

type Booked = {
  readonly payment_in: number;
  readonly payout_out: number;
  readonly refund_in: number;
  readonly adjustment: number;
  readonly rows: readonly { kind: string; amount: string; note: string | null }[];
};

/** What was booked against one payment, or one swap — never the whole table. */
async function bookedBy(column: "payment_id" | "swap_id", target: string): Promise<Booked> {
  const { db } = need();
  const where =
    column === "payment_id"
      ? eq(ledgerEntries.paymentId, target)
      : eq(ledgerEntries.swapId, target);
  const rows = await db
    .select({
      kind: ledgerEntries.kind,
      amount: ledgerEntries.amount,
      note: ledgerEntries.note,
    })
    .from(ledgerEntries)
    .where(where)
    .orderBy(ledgerEntries.createdAt, ledgerEntries.id);

  return {
    payment_in: rows.filter((row) => row.kind === "payment_in").length,
    payout_out: rows.filter((row) => row.kind === "payout_out").length,
    refund_in: rows.filter((row) => row.kind === "refund_in").length,
    adjustment: rows.filter((row) => row.kind === "adjustment").length,
    rows: rows.map((row) => ({ kind: row.kind, amount: row.amount, note: row.note })),
  };
}

const byPayment = (id: string) => bookedBy("payment_id", id);
const bySwap = (id: string) => bookedBy("swap_id", id);

async function sellerRows(): Promise<number> {
  const { db } = need();
  const rows = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.sellerId, ids.sellerId));
  return rows.length;
}

async function seed(): Promise<void> {
  const { db } = need();
  await db
    .insert(sellers)
    .values({ id: ids.sellerId, nearAccountId: ids.nearAccount, displayName: "E1 fixture" })
    .onConflictDoNothing();
  await db
    .insert(payoutRoutes)
    .values({
      id: ids.routeId,
      sellerId: ids.sellerId,
      destinationChain: "near",
      destinationAsset: "usdc",
      destinationAddress: `dest-${run}.testnet`,
      refundAddress: `refund-${run}.testnet`,
      provider: "mock",
      modeDetail: "standing",
    })
    .onConflictDoNothing();
  await db
    .insert(endpoints)
    .values({
      id: ids.endpointId,
      sellerId: ids.sellerId,
      slug: ids.slug,
      upstreamUrl: "https://example.test/data",
      priceAmount: PRICE,
      assetContract: ASSET,
      network: "near:testnet",
      payoutMode: "intents",
      routeId: ids.routeId,
    })
    .onConflictDoNothing();
}

afterAll(async () => {
  // No deletes. The ledger refuses its own DELETE (A7's trigger, the whole point of
  // the table), and a payment a ledger row points at is refused by the foreign key,
  // and then the endpoint that payment was sold from. The rows stay, exactly as
  // append-only.test.ts leaves its own, which is why every assertion above is
  // filtered by a fixture id minted in this run rather than counting the table.
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});

// describe.skipIf rather than an early return inside each test: a skipped suite says
// "not checked", while a test that returns without asserting says "passed".
const suite = describe.skipIf(handle === null);

suite("the ledger books one entry per event (E1, LR-1)", () => {
  beforeAll(seed);

  it("an intents settlement books the payment and no payout, because none has happened", async () => {
    const { db } = need();
    const paymentId = await newPayment();

    await recordSettlement(
      db,
      { sellerId: ids.sellerId, amount: 2_500_000n, asset: ASSET, paymentId },
      "intents",
    );

    expect(await byPayment(paymentId)).toMatchObject({
      payment_in: 1,
      payout_out: 0,
      refund_in: 0,
      adjustment: 0,
    });
  });

  it("a direct settlement books the pair that the same transfer caused, and nothing else", async () => {
    const { db } = need();
    const paymentId = await newPayment();

    await recordSettlement(
      db,
      { sellerId: ids.sellerId, amount: 2_500_000n, asset: ASSET, paymentId },
      "direct",
    );

    const lines = await byPayment(paymentId);
    expect(lines).toMatchObject({ payment_in: 1, payout_out: 1, refund_in: 0, adjustment: 0 });
    // The payout line has to say why it exists, or the ledger reads as money in and
    // money out for a swap nobody made.
    expect(lines.rows.find((row) => row.kind === "payout_out")?.note).toContain("x402 transfer");
  });

  it("a swap reaching succeeded books one payout_out against the swap", async () => {
    const { db } = need();
    const swapId = await newSwap();

    await recordPayoutOut(db, {
      sellerId: ids.sellerId,
      amount: 999_500n,
      asset: "usdc",
      swapId,
      note: "mock: the swap landed at the seller's destination",
    });

    expect(await bySwap(swapId)).toMatchObject({ payment_in: 0, payout_out: 1, refund_in: 0 });
  });

  it("a swap reaching refunded books one refund_in for the amount that came back", async () => {
    const { db } = need();
    const swapId = await newSwap();

    await recordRefundIn(db, {
      sellerId: ids.sellerId,
      amount: 1_000_000n,
      asset: "usdc",
      swapId,
      note: "mock: the swap failed and the deposit returned to the payer",
    });

    const lines = await bySwap(swapId);
    expect(lines).toMatchObject({ payout_out: 0, refund_in: 1 });
    expect(lines.rows[0]?.amount).toBe("1000000");
  });

  it("two events on one swap are two rows, because the ledger appends and does not decide", async () => {
    const { db } = need();
    const swapId = await newSwap();
    const entry = { sellerId: ids.sellerId, asset: "usdc", swapId };

    await recordPayoutOut(db, { ...entry, amount: 400_000n });
    await recordPayoutOut(db, { ...entry, amount: 600_000n });

    const lines = await bySwap(swapId);
    expect(lines.payout_out).toBe(2);
    expect(lines.rows.map((row) => row.amount)).toEqual(["400000", "600000"]);
  });

  it("a correction is a compensating row and the number it corrects still reads as it was", async () => {
    const { db } = need();
    const paymentId = await newPayment();

    await recordSettlement(
      db,
      { sellerId: ids.sellerId, amount: 2_500_000n, asset: ASSET, paymentId },
      "intents",
    );
    await recordAdjustment(
      db,
      { sellerId: ids.sellerId, amount: -500_000n, asset: ASSET, paymentId },
      "e1: the provider reported half a unit less",
    );

    const lines = await byPayment(paymentId);
    expect(lines).toMatchObject({ payment_in: 1, adjustment: 1 });
    expect(lines.rows.find((row) => row.kind === "payment_in")?.amount).toBe(PRICE);
    expect(lines.rows.find((row) => row.kind === "adjustment")?.amount).toBe("-500000");
  });

  it("refuses money flowing the wrong way at the column, not in the writer's memory", async () => {
    const { db } = need();
    const swapId = await newSwap();

    await expect(
      recordPayoutOut(db, { sellerId: ids.sellerId, amount: -1n, asset: "usdc", swapId }),
    ).rejects.toThrow(/ledger_entries_amount_sign_by_kind|non-negative/);

    expect(await bySwap(swapId)).toMatchObject({ payout_out: 0 });
  });

  it("keeps a signed adjustment, because there the sign is the correction", async () => {
    const { db } = need();
    const paymentId = await newPayment();

    await recordAdjustment(
      db,
      { sellerId: ids.sellerId, amount: -2_500_000n, asset: ASSET, paymentId },
      "e1: full reversal of a payment the payer never made",
    );

    expect(await byPayment(paymentId)).toMatchObject({ payment_in: 0, adjustment: 1 });
  });

  it("books a sum past Number.MAX_SAFE_INTEGER without rounding it", async () => {
    const { db } = need();
    const huge = 12_345_678_901_234_567_890_123_456_789n;
    const paymentId = await newPayment();

    await recordSettlement(
      db,
      { sellerId: ids.sellerId, amount: huge, asset: ASSET, paymentId },
      "intents",
    );

    const lines = await byPayment(paymentId);
    expect(lines.rows[0]?.amount).toBe(huge.toString());
    expect(lines.rows[0]?.amount).not.toContain("e");
  });

  it("anchors every line to a payment that exists, rather than to a string a caller invented", async () => {
    const { db } = need();
    const invented = randomUUID();

    await expect(
      recordSettlement(
        db,
        { sellerId: ids.sellerId, amount: 1n, asset: ASSET, paymentId: invented },
        "intents",
      ),
    ).rejects.toThrow(/payments_id_fkey|foreign key/);

    expect(await byPayment(invented)).toMatchObject({ payment_in: 0 });
  });

  it("leaves no room for a fifth kind: the whitelist is the column's, and it decides", async () => {
    const { sql } = need();
    const paymentId = await newPayment();

    // The id is minted here and not left to the column: `id()` carries
    // `$defaultFn(newId)`, which drizzle applies on the way out, so a raw SQL
    // insert that omits it would be refused by the not-null constraint and the
    // test would prove nothing about the whitelist.
    await expect(
      sql`insert into ledger_entries (id, seller_id, kind, amount, asset, payment_id)
        values (${newId()}, ${ids.sellerId}, 'transfer', 1, ${ASSET}, ${paymentId})`,
    ).rejects.toThrow(/ledger_entries_amount_sign_by_kind|check constraint/);
  });

  it("writes through one seam: every row this file booked came from the service", async () => {
    const { db } = need();
    const before = await sellerRows();
    const paymentId = await newPayment();

    await recordSettlement(
      db,
      { sellerId: ids.sellerId, amount: 2_500_000n, asset: ASSET, paymentId },
      "intents",
    );

    expect(await sellerRows()).toBe(before + 1);
  });
});
