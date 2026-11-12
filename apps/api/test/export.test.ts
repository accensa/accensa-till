import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "@till/core";

import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import { createExportRoutes, escapeCsvField, formatLedgerCsv } from "../src/routes/export.ts";
import {
  type LedgerExportRow,
  recordAdjustment,
  recordSettlement,
} from "../src/services/ledger.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * LR-7 (F7): ledger CSV export in decimal units.
 *
 * Pinned here:
 * 1. Pure CSV formatting: RFC 4180 CRLF, decimal amounts (1250000 -> 1.25),
 *    safe formula neutralization, and correct quoting.
 * 2. Route behaviour: 401 on unauthenticated requests, 200 with text/csv
 *    and attachment headers on authenticated requests, and strictly scoped
 *    to the session seller's ledger entries only.
 */

describe("escapeCsvField and formatLedgerCsv (LR-7 pure unit tests)", () => {
  it("leaves standard alphanumeric strings unquoted", () => {
    expect(escapeCsvField("payment_in")).toBe("payment_in");
    expect(escapeCsvField("usdc.testnet")).toBe("usdc.testnet");
  });

  it("quotes fields containing commas, double quotes, or newlines", () => {
    expect(escapeCsvField("hello,world")).toBe('"hello,world"');
    expect(escapeCsvField('say "hello"')).toBe('"say ""hello"""');
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralizes formula injection characters for text fields", () => {
    expect(escapeCsvField("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
    expect(escapeCsvField("+12345")).toBe("'+12345");
    expect(escapeCsvField("@admin")).toBe("'@admin");
  });

  it("preserves negative signs on numeric amounts", () => {
    expect(escapeCsvField("-1.25", true)).toBe("-1.25");
  });

  it("formats an empty ledger with just the header and CRLF", () => {
    const csv = formatLedgerCsv([]);
    expect(csv).toBe("id,created_at,kind,amount,asset,payment_id,swap_id,note\r\n");
  });

  it("formats ledger rows with decimal units and CRLF endings", () => {
    const now = new Date("2026-11-11T12:00:00.000Z");
    const rows: LedgerExportRow[] = [
      {
        id: "entry-1",
        createdAt: now,
        kind: "payment_in",
        amount: "1250000",
        asset: "usdc.testnet",
        paymentId: "pay-1",
        swapId: null,
        note: null,
      },
      {
        id: "entry-2",
        createdAt: now,
        kind: "adjustment",
        amount: "-250000",
        asset: "usdc.testnet",
        paymentId: null,
        swapId: null,
        note: "reconciled adjustment, note with comma",
      },
    ];

    const csv = formatLedgerCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("id,created_at,kind,amount,asset,payment_id,swap_id,note");
    expect(lines[1]).toBe("entry-1,2026-11-11T12:00:00.000Z,payment_in,1.25,usdc.testnet,pay-1,,");
    expect(lines[2]).toBe(
      'entry-2,2026-11-11T12:00:00.000Z,adjustment,-0.25,usdc.testnet,,,"reconciled adjustment, note with comma"',
    );
  });
});

type Handle = { readonly sql: postgres.Sql; readonly db: Db };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
  return { sql, db: drizzle(sql, { schema }) };
}

let handle: Handle | null = null;
let skipReason = "no DATABASE_URL set";

const rawUrl = process.env.DATABASE_URL;
if (rawUrl !== undefined && rawUrl !== "") {
  try {
    handle = await openDatabase(rawUrl);
  } catch (error) {
    skipReason = `cannot connect to database: ${error instanceof Error ? error.message : String(error)}`;
    handle = null;
  }
}

function need(): Handle {
  if (handle === null) {
    throw new Error(`unreachable: the suite should have skipped for "${skipReason}"`);
  }
  return handle;
}

const run = randomUUID().slice(0, 8);
const MINE = { id: randomUUID(), nearAccountId: `till-f7-mine-${run}.testnet` };
const OTHER = { id: randomUUID(), nearAccountId: `till-f7-other-${run}.testnet` };

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const claims: SessionClaims = { sellerId: MINE.id, nearAccountId: MINE.nearAccountId };

describe.skipIf(handle === null)("export routes (LR-7, F7)", () => {
  let env: Env;
  let endpointId = "";
  let paymentId = "";

  beforeAll(async () => {
    const { db } = need();
    env = loadEnv({
      ...process.env,
      DATABASE_URL: rawUrl ?? "",
      SESSION_SECRET: "x".repeat(32),
      GATEWAY_PUBLIC_URL: "https://gateway.test",
    });

    await db.insert(schema.sellers).values([
      { id: MINE.id, nearAccountId: MINE.nearAccountId },
      { id: OTHER.id, nearAccountId: OTHER.nearAccountId },
    ]);

    const [ep] = await db
      .insert(schema.endpoints)
      .values({
        sellerId: MINE.id,
        slug: `f7-${run}`,
        upstreamUrl: "https://seller.test/data",
        priceAmount: "1250000",
        assetContract: "usdc.testnet",
        network: "near:testnet",
        payoutMode: "direct",
        active: true,
      })
      .returning({ id: schema.endpoints.id });
    if (ep === undefined) throw new Error("endpoint was not created");
    endpointId = ep.id;

    const [pm] = await db
      .insert(schema.payments)
      .values({
        endpointId,
        payerAccountId: `payer-${run}.testnet`,
        amount: "1250000",
        assetContract: "usdc.testnet",
        state: "settled",
        replayKey: `rep-f7-${run}`,
        nearTxHash: `tx-f7-${run}`,
      })
      .returning({ id: schema.payments.id });
    if (pm === undefined) throw new Error("payment was not created");
    paymentId = pm.id;

    // Record settlement for MINE seller
    await recordSettlement(
      db,
      {
        sellerId: MINE.id,
        amount: 1_250_000n,
        asset: "usdc.testnet",
        paymentId,
      },
      "direct",
    );

    // Record an adjustment for OTHER seller (should NOT show up in MINE export)
    await recordAdjustment(
      db,
      {
        sellerId: OTHER.id,
        amount: 500_000n,
        asset: "usdc.testnet",
      },
      "foreign adjustment",
    );
  });

  afterAll(async () => {
    // No deletes: the ledger refuses its own DELETE (A7 trigger) and payments has
    // a foreign key from ledger_entries. The rows stay, scoped by run UUID.
    if (handle !== null) {
      await handle.sql.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  it("refuses export requests with no session cookie", async () => {
    const app = createApp({
      db: need().db,
      env,
      log: quiet,
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
      export: { session: async () => null },
    });

    const res = await app.request("/api/export/ledger.csv");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ code: "unauthenticated" });
  });

  it("returns 200 text/csv scoped to the session seller with decimal amounts", async () => {
    const app = createApp({
      db: need().db,
      env,
      log: quiet,
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
      export: { session: async () => claims },
    });

    const res = await app.request("/api/export/ledger.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="ledger.csv"');

    const csvText = await res.text();
    expect(csvText).toContain("id,created_at,kind,amount,asset,payment_id,swap_id,note");
    // MINE direct settlement wrote 1.25 payment_in and 1.25 payout_out
    expect(csvText).toContain("payment_in,1.25,usdc.testnet");
    expect(csvText).toContain("payout_out,1.25,usdc.testnet");
    // OTHER seller's adjustment must NOT be present
    expect(csvText).not.toContain("foreign adjustment");
  });

  it("also serves the export on /ledger.csv and /api/ledger.csv", async () => {
    const app = createApp({
      db: need().db,
      env,
      log: quiet,
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
      export: { session: async () => claims },
    });

    const res1 = await app.request("/ledger.csv");
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toContain("text/csv");

    const res2 = await app.request("/api/ledger.csv");
    expect(res2.status).toBe(200);
    expect(res2.headers.get("content-type")).toContain("text/csv");
  });
});
