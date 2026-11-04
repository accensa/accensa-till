import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.ts";
import {
  STRIKE_THRESHOLD,
  STRIKE_WINDOW_HOURS,
  clearPayerBlock,
  strikesForPayer,
} from "../src/services/strikes.ts";

/**
 * C9 acceptance tests (GW-7): the strike count is a query over `payments`, and a
 * seller's clear is a watermark row rather than a rewrite of payment history, so
 * the only thing these tests cannot fake is a real Postgres. Everything here is
 * about scope and time:
 *
 *   - a strike is `served_unsettled`, not `settled`, `abandoned` or `verified`
 *   - the count is per payer *and* per seller, because the block protects one
 *     seller's upstream and a clear must not lift another seller's protection
 *   - the window is 24 hours, so a block can end by itself as well as by a clear
 *   - a clear ends the strikes before it and nothing after it
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
  sellerOne: randomUUID(),
  sellerTwo: randomUUID(),
  endpointOne: randomUUID(),
  endpointTwo: randomUUID(),
  accountOne: `till-c9-one-${run}.testnet`,
  accountTwo: `till-c9-two-${run}.testnet`,
} as const;

const SELLERS = { one: ids.sellerOne, two: ids.sellerTwo } as const;
const ENDPOINTS = { one: ids.endpointOne, two: ids.endpointTwo } as const;

async function seed(): Promise<void> {
  const { sql } = need();
  for (const [sellerId, accountId, endpointId, slug] of [
    [ids.sellerOne, ids.accountOne, ids.endpointOne, `c9-one-${run}`],
    [ids.sellerTwo, ids.accountTwo, ids.endpointTwo, `c9-two-${run}`],
  ] as const) {
    await sql`insert into sellers (id, near_account_id, display_name)
      values (${sellerId}, ${accountId}, 'C9 fixture')
      on conflict (id) do nothing`;
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode)
      values (${endpointId}, ${sellerId}, ${slug}, 'https://example.test/data',
        '10000', 'usdc.testnet', 'near:testnet', 'direct')
      on conflict (id) do nothing`;
  }
}

type StrikeInput = {
  readonly payer: string;
  readonly seller: string;
  readonly state?: string;
  /** Whole hours before now. */
  readonly ageHours?: number;
  readonly verifiedAtNull?: boolean;
};

/** Raw SQL because the service only ever writes `verified` rows (C3's rule). */
async function insertPayment(input: StrikeInput): Promise<string> {
  const { sql } = need();
  const id = randomUUID();
  const endpointId = input.seller === ids.sellerOne ? ids.endpointOne : ids.endpointTwo;
  const ageHours = input.ageHours ?? 0;
  await sql`insert into payments (id, endpoint_id, payer_account_id, amount, asset_contract,
      replay_key, state, verified_at)
    values (${id}, ${endpointId}, ${input.payer}, '10000', 'usdc.testnet',
      ${`c9-${randomUUID()}`}, ${input.state ?? "served_unsettled"},
      ${
        input.verifiedAtNull === true
          ? sql`null`
          : sql`now() - make_interval(hours => ${ageHours}::int)`
      })`;
  return id;
}

const suite = describe.skipIf(handle === null);

suite("payer strikes (C9, GW-7)", () => {
  beforeAll(seed);

  it("names the policy the design documents: two unsettled serves in twenty-four hours", () => {
    expect(STRIKE_THRESHOLD).toBe(2);
    expect(STRIKE_WINDOW_HOURS).toBe(24);
  });

  it("counts only this payer's served_unsettled rows at this seller's endpoints", async () => {
    const payer = `c9-scope-${run}.testnet`;
    const otherPayer = `c9-other-${run}.testnet`;
    await insertPayment({ payer, seller: ids.sellerOne, state: "served_unsettled" });
    await insertPayment({ payer, seller: ids.sellerOne, state: "served_unsettled" });
    await insertPayment({ payer, seller: ids.sellerOne, state: "settled" });
    await insertPayment({ payer, seller: ids.sellerOne, state: "abandoned" });
    await insertPayment({ payer, seller: ids.sellerOne, state: "verified" });
    await insertPayment({ payer: otherPayer, seller: ids.sellerOne });
    await insertPayment({ payer, seller: ids.sellerTwo });

    const atOne = await strikesForPayer(need().db, {
      payerAccountId: payer,
      sellerId: ids.sellerOne,
    });
    expect(atOne).toEqual({ count: 2, blocked: true });

    const atTwo = await strikesForPayer(need().db, {
      payerAccountId: payer,
      sellerId: ids.sellerTwo,
    });
    expect(atTwo).toEqual({ count: 1, blocked: false });

    const stranger = await strikesForPayer(need().db, {
      payerAccountId: otherPayer,
      sellerId: ids.sellerOne,
    });
    expect(stranger).toEqual({ count: 1, blocked: false });
  });

  it("does not count a served_unsettled row without a verified_at, because nothing dates it", async () => {
    const payer = `c9-undated-${run}.testnet`;
    await insertPayment({ payer, seller: ids.sellerOne, verifiedAtNull: true });
    await insertPayment({ payer, seller: ids.sellerOne, verifiedAtNull: true });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 0, blocked: false });
  });

  it("blocks at the threshold and not one strike before it", async () => {
    const payer = `c9-threshold-${run}.testnet`;
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 1 });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 1, blocked: false });
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 2 });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 2, blocked: true });
  });

  it("stops counting a strike once it leaves the window, so a block can end by itself", async () => {
    const payer = `c9-window-${run}.testnet`;
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 25 });
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 26 });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 0, blocked: false });

    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 23 });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 1, blocked: false });
  });

  it("counts only strikes recorded after the seller's last clear", async () => {
    const payer = `c9-clear-${run}.testnet`;
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 2 });
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 1 });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 2, blocked: true });

    await clearPayerBlock(need().db, {
      payerAccountId: payer,
      sellerId: ids.sellerOne,
      clearedBy: "seller-one.testnet",
      note: "buyer explained the failed settle; one more chance",
    });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 0, blocked: false });

    // A strike after the clear counts again -- the clear is a watermark, not an
    // instruction to forget the payer forever.
    await insertPayment({ payer, seller: ids.sellerOne });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 1, blocked: false });
    await insertPayment({ payer, seller: ids.sellerOne });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 2, blocked: true });

    // And the next clear is what lifts the new count, not the first one.
    await clearPayerBlock(need().db, {
      payerAccountId: payer,
      sellerId: ids.sellerOne,
      clearedBy: "seller-one.testnet",
    });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 0, blocked: false });
  });

  it("keeps a clear to the seller that wrote it", async () => {
    const payer = `c9-tenancy-${run}.testnet`;
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 1 });
    await insertPayment({ payer, seller: ids.sellerOne, ageHours: 2 });
    await insertPayment({ payer, seller: ids.sellerTwo, ageHours: 1 });
    await insertPayment({ payer, seller: ids.sellerTwo, ageHours: 2 });

    await clearPayerBlock(need().db, {
      payerAccountId: payer,
      sellerId: ids.sellerOne,
      clearedBy: "seller-one.testnet",
    });

    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerOne }),
    ).toEqual({ count: 0, blocked: false });
    expect(
      await strikesForPayer(need().db, { payerAccountId: payer, sellerId: ids.sellerTwo }),
    ).toEqual({ count: 2, blocked: true });
  });

  it("appends clears with who did it rather than overwriting the last one", async () => {
    const payer = `c9-audit-${run}.testnet`;
    await clearPayerBlock(need().db, {
      payerAccountId: payer,
      sellerId: ids.sellerOne,
      clearedBy: "first-operator.testnet",
      note: "first",
    });
    await clearPayerBlock(need().db, {
      payerAccountId: payer,
      sellerId: ids.sellerOne,
      clearedBy: "second-operator.testnet",
    });
    const rows = await need().sql`select cleared_by, note from payer_clears
      where payer_account_id = ${payer} and seller_id = ${ids.sellerOne}
      order by created_at, id`;
    expect(rows).toEqual([
      { cleared_by: "first-operator.testnet", note: "first" },
      { cleared_by: "second-operator.testnet", note: null },
    ]);
  });
});

afterAll(async () => {
  await handle?.sql.end({ timeout: 1 }).catch(() => undefined);
});
