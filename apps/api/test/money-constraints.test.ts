import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";

/**
 * A19 acceptance tests: the money columns have database CHECK constraints.
 *
 * G6 F1 showed the JSON boundary was the only validator -- a negative price or
 * payment amount parsed, and `numeric(78,0)` accepted it. These tests read the
 * constraints at the database, which is where the last line of defence lives:
 * every insert below goes through raw SQL on purpose, because a service-level
 * test would still pass with the constraint missing.
 *
 * Needs `DATABASE_URL`; without a reachable database the file skips.
 */

type Handle = { readonly sql: postgres.Sql; readonly db: ReturnType<typeof createTestDb> };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
const sellerId = randomUUID();
const endpointId = randomUUID();
const routeId = randomUUID();
const ASSET = "usdc.testnet";

async function seed(): Promise<void> {
  const { sql } = need();
  await sql`insert into sellers (id, near_account_id, display_name)
    values (${sellerId}, ${`till-a19-${run}.testnet`}, 'A19 fixture')
    on conflict (id) do nothing`;
  await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
      asset_contract, network, payout_mode)
    values (${endpointId}, ${sellerId}, ${`a19-${run}`}, 'https://example.test/data',
      '10000', ${ASSET}, 'near:testnet', 'direct')
    on conflict (id) do nothing`;
  await sql`insert into payout_routes (id, seller_id, destination_chain, destination_asset,
      destination_address, refund_address, provider, mode_detail)
    values (${routeId}, ${sellerId}, 'ethereum', 'usdc',
      '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222',
      'mock', 'standing')
    on conflict (id) do nothing`;
}

async function insertPaymentAmount(amount: string): Promise<void> {
  const { sql } = need();
  await sql`insert into payments (id, endpoint_id, payer_account_id, amount, asset_contract,
      replay_key, state)
    values (${randomUUID()}, ${endpointId}, ${`a19-payer-${randomUUID()}.testnet`}, ${amount},
      ${ASSET}, ${`a19-${randomUUID()}`}, 'verified')`;
}

async function insertEndpointPrice(price: string): Promise<void> {
  const { sql } = need();
  await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
      asset_contract, network, payout_mode)
    values (${randomUUID()}, ${sellerId}, ${`a19-price-${randomUUID()}`},
      'https://example.test/data', ${price}, ${ASSET}, 'near:testnet', 'direct')`;
}

async function insertLedger(kind: string, amount: string): Promise<void> {
  const { sql } = need();
  await sql`insert into ledger_entries (id, seller_id, kind, amount, asset)
    values (${randomUUID()}, ${sellerId}, ${kind}, ${amount}, ${ASSET})`;
}

async function insertSwap(amountIn: string | null, refundedAmount: string | null): Promise<void> {
  const { sql } = need();
  await sql`insert into swaps (id, route_id, provider_ref, state, amount_in, refunded_amount, raw)
    values (${randomUUID()}, ${routeId}, ${`a19-swap-${randomUUID()}`}, 'refunded',
      ${amountIn}, ${refundedAmount}, '{}'::jsonb)`;
}

// describe.skipIf rather than an early return inside each test: a skipped suite
// says "not checked", while a test that returns without asserting says "passed".
const suite = describe.skipIf(handle === null);

suite("money CHECK constraints (A19)", () => {
  beforeAll(seed);

  afterAll(async () => {
    await handle?.sql.end({ timeout: 1 }).catch(() => undefined);
  });

  describe("payments.amount", () => {
    it("refuses a negative amount", async () => {
      await expect(insertPaymentAmount("-1")).rejects.toThrow(/payments_amount_non_negative/);
    });

    it("accepts zero and a positive amount", async () => {
      await expect(insertPaymentAmount("0")).resolves.toBeUndefined();
      await expect(insertPaymentAmount("10000")).resolves.toBeUndefined();
    });
  });

  describe("endpoints.price_amount", () => {
    it("refuses a negative price", async () => {
      await expect(insertEndpointPrice("-1")).rejects.toThrow(
        /endpoints_price_amount_non_negative/,
      );
    });

    it("accepts zero, because the floor is config policy and not this constraint", async () => {
      await expect(insertEndpointPrice("0")).resolves.toBeUndefined();
    });
  });

  describe("ledger_entries.amount by kind", () => {
    it.each(["payment_in", "payout_out", "refund_in"])("refuses a negative %s", async (kind) => {
      await expect(insertLedger(kind, "-1")).rejects.toThrow(/ledger_entries_amount_sign_by_kind/);
    });

    it.each(["payment_in", "payout_out", "refund_in"])("accepts a zero %s", async (kind) => {
      await expect(insertLedger(kind, "0")).resolves.toBeUndefined();
    });

    it("accepts a negative adjustment, because a correction is signed", async () => {
      await expect(insertLedger("adjustment", "-2500000")).resolves.toBeUndefined();
      await expect(insertLedger("adjustment", "2500000")).resolves.toBeUndefined();
    });

    it("refuses an unknown kind, so a new kind needs a migration", async () => {
      await expect(insertLedger("payment_sideways", "1")).rejects.toThrow(
        /ledger_entries_amount_sign_by_kind/,
      );
    });
  });

  describe("swaps.refunded_amount", () => {
    it("refuses a refund larger than the amount in", async () => {
      await expect(insertSwap("100", "101")).rejects.toThrow(
        /swaps_refunded_amount_within_amount_in/,
      );
    });

    it("accepts a refund equal to or below the amount in", async () => {
      await expect(insertSwap("100", "100")).resolves.toBeUndefined();
      await expect(insertSwap("100", "25")).resolves.toBeUndefined();
    });

    it("leaves the bound unproven when amount_in is null, and says so", async () => {
      // A provider that reports a refund without an input amount is evidence,
      // not arithmetic; reconcile raises the discrepancy rather than the
      // database dropping the row.
      await expect(insertSwap(null, "25")).resolves.toBeUndefined();
    });

    it("still stores a negative provider amount, which the DTO keeps signed", async () => {
      await expect(insertSwap("-5", null)).resolves.toBeUndefined();
    });
  });
});
