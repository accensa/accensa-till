import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import { recordAdjustment, recordSettlement } from "../src/services/ledger.ts";

/**
 * A7 acceptance tests: the append-only ledger trigger (LR-1) and the discrepancy
 * dedupe index (LR-5). Both are database objects, so these run against real
 * Postgres and cannot be faked with mocks — a mock would pass while the trigger
 * stayed missing.
 *
 * They need `DATABASE_URL`. With one reachable they apply apps/api/migrations/
 * when the schema is absent; with none the whole file skips, so CI without a
 * database never reads a green run as A7 evidence.
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
  // max: 1 keeps the migration file (one begin/commit script) on a single
  // connection instead of splitting its transaction across a pool.
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

// Seeded per run: the FKs on ledger_entries and discrepancies point at these.
const ids = {
  sellerId: randomUUID(),
  endpointId: randomUUID(),
  paymentId: randomUUID(),
  nearAccount: `till-a7-${randomUUID().slice(0, 8)}.testnet`,
  slug: `a7-${randomUUID()}`,
  replayKey: `a7-${randomUUID()}`,
} as const;

async function seed(): Promise<void> {
  const { sql } = need();
  await sql`insert into sellers (id, near_account_id, display_name)
    values (${ids.sellerId}, ${ids.nearAccount}, 'A7 fixture')
    on conflict (id) do nothing`;
  await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
      asset_contract, network, payout_mode)
    values (${ids.endpointId}, ${ids.sellerId}, ${ids.slug}, 'https://example.test/data',
      '2500000', 'usdc.testnet', 'near:testnet', 'auto')
    on conflict (id) do nothing`;
  await sql`insert into payments (id, endpoint_id, payer_account_id, amount,
      asset_contract, replay_key, state)
    values (${ids.paymentId}, ${ids.endpointId}, 'buyer.testnet', '2500000',
      'usdc.testnet', ${ids.replayKey}, 'settled')
    on conflict (id) do nothing`;
}

async function newestLedgerId(): Promise<string> {
  const { sql } = need();
  const rows = await sql`select id from ledger_entries
    where seller_id = ${ids.sellerId} order by created_at desc, id desc`;
  const [row] = rows;
  if (row === undefined) {
    throw new Error("fixture wrote no ledger row");
  }
  return row.id as string;
}

/**
 * Writes a settled row through the service and returns its id, so each test
 * probes a row it created itself rather than one an earlier test left behind.
 */
async function settledLedgerRow(): Promise<string> {
  const { db } = need();
  await recordSettlement(
    db,
    {
      sellerId: ids.sellerId,
      amount: 2_500_000n,
      asset: "usdc.testnet",
      paymentId: ids.paymentId,
    },
    "intents",
  );
  return newestLedgerId();
}

async function openDiscrepancy(dedupeKey: string, withPayment: boolean): Promise<void> {
  const { sql } = need();
  const paymentId = withPayment ? ids.paymentId : null;
  await sql`insert into discrepancies (id, seller_id, code, severity, payment_id, swap_id,
      dedupe_key, explanation, suggested_action, opened_at)
    values (${randomUUID()}, ${ids.sellerId}, 'PAYOUT_SHORTFALL', 'warning',
      ${paymentId}, null, ${dedupeKey},
      'swap paid out less than the minimum', 'refund the buyer', now())`;
}

async function openCount(dedupeKey: string): Promise<number> {
  const { sql } = need();
  const [row] = await sql`select count(*)::int as count from discrepancies
    where dedupe_key = ${dedupeKey} and resolved_at is null`;
  return row?.count ?? 0;
}

// describe.skipIf rather than an early return inside each test: a skipped suite
// says "not checked", while a test that returns without asserting says "passed".
const suite = describe.skipIf(handle === null);

suite("ledger append-only trigger (A7, LR-1)", () => {
  beforeAll(seed);

  it("UPDATE on ledger_entries raises", async () => {
    const { sql } = need();
    const target = await settledLedgerRow();

    await expect(sql`update ledger_entries set amount = 1 where id = ${target}`).rejects.toThrow(
      /ledger_entries is append only \(UPDATE is forbidden\)/,
    );

    const [row] = await sql`select amount from ledger_entries where id = ${target}`;
    expect(row?.amount).toBe("2500000");
  });

  it("DELETE on ledger_entries raises and keeps the row", async () => {
    const { sql } = need();
    const target = await settledLedgerRow();

    await expect(sql`delete from ledger_entries where id = ${target}`).rejects.toThrow(
      /ledger_entries is append only \(DELETE is forbidden\)/,
    );

    const [row] = await sql`select id from ledger_entries where id = ${target}`;
    expect(row?.id).toBe(target);
  });

  it("inserting an adjustment row succeeds and leaves history untouched", async () => {
    const { db, sql } = need();
    const before = await settledLedgerRow();

    await recordAdjustment(
      db,
      {
        sellerId: ids.sellerId,
        amount: -2_500_000n,
        asset: "usdc.testnet",
        paymentId: ids.paymentId,
      },
      "compensates the double-counted settlement",
    );

    const [original] =
      await sql`select kind, amount, note from ledger_entries where id = ${before}`;
    expect(original).toEqual({ kind: "payment_in", amount: "2500000", note: null });

    const correction = await sql`select kind, amount, note from ledger_entries
      where seller_id = ${ids.sellerId} and kind = 'adjustment'`;
    expect(correction).toHaveLength(1);
    const [entry] = correction;
    expect(entry).toEqual({
      kind: "adjustment",
      amount: "-2500000",
      note: "compensates the double-counted settlement",
    });
  });
});

suite("discrepancy dedupe (A7, LR-5)", () => {
  beforeAll(seed);

  it("inserting the same open dedupe_key twice yields one row", async () => {
    const key = `PAYOUT_SHORTFALL:${ids.paymentId}`;

    await openDiscrepancy(key, true);
    await expect(openDiscrepancy(key, true)).rejects.toThrow(/discrepancies_open_dedupe/);
    expect(await openCount(key)).toBe(1);
  });

  it("two null-subject findings with the same key still dedupe", async () => {
    // Unique per run, but identical for both inserts: a constant key would make
    // the first insert of a rerun collide with the previous run's open row.
    const key = `ORPHAN_DEPOSIT:none:none:${randomUUID()}`;
    const { sql } = need();

    await openDiscrepancy(key, false);
    await expect(openDiscrepancy(key, false)).rejects.toThrow(/discrepancies_open_dedupe/);
    expect(await openCount(key)).toBe(1);

    // Why LR-5 needs a partial unique index instead of a unique constraint over
    // (dedupe_key, payment_id, swap_id): Postgres treats nulls as distinct, so
    // the causes with no payment or swap id would never dedupe.
    const subjects = await sql`select payment_id, swap_id from discrepancies
      where dedupe_key = ${key}`;
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toEqual({ payment_id: null, swap_id: null });
  });

  it("a resolved discrepancy may be reopened with the same key", async () => {
    const { sql } = need();
    const key = `PAYOUT_STUCK:${randomUUID()}`;

    await openDiscrepancy(key, false);
    await sql`update discrepancies set resolved_at = now(), resolution = 'refunded by hand'
      where dedupe_key = ${key} and resolved_at is null`;
    expect(await openCount(key)).toBe(0);

    await openDiscrepancy(key, false);
    expect(await openCount(key)).toBe(1);

    const [row] = await sql`select count(*)::int as count from discrepancies
      where dedupe_key = ${key}`;
    expect(row?.count).toBe(2);
  });
});

afterAll(async () => {
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});
