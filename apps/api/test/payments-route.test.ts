import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type PaymentDto,
  dashboardErrorSchema,
  paymentDtoSchema,
  paymentListResponseSchema,
} from "@till/core";

import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import { createPaymentRoutes } from "../src/routes/payments.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * UI-3 (F3): the payment list a seller reads.
 *
 * Three things are pinned here and nowhere else: the rows a seller sees are the
 * ones on *their* endpoints (a payment row carries no seller id, so the join is
 * the scope), a payment the seller made to themselves is flagged rather than
 * counted as revenue, and every row carries what the dashboard needs to link a
 * transaction — the endpoint's network and the hash, with no link invented when
 * the hash is missing.
 *
 * Needs `DATABASE_URL`; without a reachable database the file skips.
 */

type Handle = { readonly sql: postgres.Sql; readonly db: Db };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

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
  // `Db` is the app's own schema-typed alias; drizzle's inferred generic from a
  // test-built handle is not assignable to it, so the same cast the other database
  // suites use names the type rather than loosening the route's.
  return { sql, db: drizzle(sql, { schema }) as unknown as Db };
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
const MINE = { id: randomUUID(), nearAccountId: `till-f3-mine-${run}.testnet` };
const OTHER = { id: randomUUID(), nearAccountId: `till-f3-other-${run}.testnet` };
const STRANGER = `till-f3-stranger-${run}.testnet`;

let env: Env;
let mineEndpoint = "";
let otherEndpoint = "";
let settledId = "";
let selfId = "";
let foreignId = "";

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const claims: SessionClaims = { sellerId: MINE.id, nearAccountId: MINE.nearAccountId };

async function addEndpoint(sellerId: string, slug: string, network: string): Promise<string> {
  const { db } = need();
  const [row] = await db
    .insert(schema.endpoints)
    .values({
      sellerId,
      slug,
      upstreamUrl: "https://data.seller.test/prices",
      priceAmount: "10000",
      assetContract: "usdc.testnet",
      network,
      payoutMode: "direct",
      active: true,
      description: "F3 fixture",
      creationWarnings: [],
    })
    .returning({ id: schema.endpoints.id });
  const id = row?.id;
  if (id === undefined) {
    throw new Error("fixture endpoint was not returned");
  }
  return id;
}

async function addPayment(
  key: string,
  endpointId: string,
  payer: string,
  state: string,
  nearTxHash: string | null,
): Promise<string> {
  const { db } = need();
  const [row] = await db
    .insert(schema.payments)
    .values({
      endpointId,
      payerAccountId: payer,
      amount: "10000",
      assetContract: "usdc.testnet",
      replayKey: `f3-${key}-${run}`,
      state,
      nearTxHash,
      upstreamStatus: state === "settled" ? 200 : null,
      upstreamMs: 12,
      verifiedAt: new Date(),
      settledAt: state === "settled" ? new Date() : null,
    })
    .returning({ id: schema.payments.id });
  if (row === undefined) {
    throw new Error(`fixture payment ${key} was not returned`);
  }
  return row.id;
}

async function listOnce(
  app: ReturnType<typeof routeApp>,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request("/payments");
  return { status: response.status, body: await response.json() };
}

function routeApp(session: SessionClaims | null) {
  return createPaymentRoutes({ db: need().db, env, log: quiet, session: async () => session });
}

// Every case in here needs a database, and a suite that cannot reach one skips
// rather than failing: the file's own header promises that, and CI runs without
// `DATABASE_URL`.
const suite = describe.skipIf(handle === null);

suite("GET /api/payments (UI-3, F3)", () => {
  beforeAll(async () => {
    env = loadEnv({
      ...process.env,
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: "x".repeat(32),
      GATEWAY_PUBLIC_URL: "https://gateway.test",
    });
    const { sql } = need();
    for (const seller of [MINE, OTHER]) {
      await sql`insert into sellers (id, near_account_id, display_name)
        values (${seller.id}, ${seller.nearAccountId}, 'F3 fixture')
        on conflict (id) do nothing`;
    }
    mineEndpoint = await addEndpoint(MINE.id, `f3-mine-${run}`, "near:testnet");
    otherEndpoint = await addEndpoint(OTHER.id, `f3-other-${run}`, "near:mainnet");
    settledId = await addPayment("settled", mineEndpoint, STRANGER, "settled", `tx-${run}-settled`);
    selfId = await addPayment("self", mineEndpoint, MINE.nearAccountId, "verified", null);
    foreignId = await addPayment(
      "foreign",
      otherEndpoint,
      STRANGER,
      "settled",
      `tx-${run}-foreign`,
    );
  });

  afterAll(async () => {
    if (handle === null) {
      return;
    }
    const { db } = need();
    await db.delete(schema.payments).where(eq(schema.payments.endpointId, mineEndpoint));
    await db.delete(schema.payments).where(eq(schema.payments.endpointId, otherEndpoint));
    await db.delete(schema.endpoints).where(eq(schema.endpoints.id, mineEndpoint));
    await db.delete(schema.endpoints).where(eq(schema.endpoints.id, otherEndpoint));
    await handle.sql.end({ timeout: 5 }).catch(() => undefined);
  });

  it("refuses a request with no session, in the shape the dashboard parses", async () => {
    const { status, body } = await listOnce(routeApp(null));
    expect(status).toBe(401);
    expect(dashboardErrorSchema.parse(body)).toMatchObject({ code: "unauthenticated" });
  });

  it("shows the seller only the payments on their own endpoints", async () => {
    const { status, body } = await listOnce(routeApp(claims));
    expect(status).toBe(200);
    const parsed = paymentListResponseSchema.parse(body);
    const ids = parsed.payments.map((payment) => payment.id);
    expect(ids).toContain(settledId);
    expect(ids).toContain(selfId);
    expect(ids).not.toContain(foreignId);
  });

  it("flags the payment the signed-in account made to itself, and only that one", async () => {
    const { body } = await listOnce(routeApp(claims));
    const byId = new Map<string, PaymentDto>(
      paymentListResponseSchema.parse(body).payments.map((payment) => [payment.id, payment]),
    );
    expect(byId.get(selfId)?.selfPayment).toBe(true);
    expect(byId.get(settledId)?.selfPayment).toBe(false);
  });

  it("carries the endpoint's network and hash so the row can link, and keeps a missing hash missing", async () => {
    const { body } = await listOnce(routeApp(claims));
    const parsed = paymentListResponseSchema.parse(body);
    const settled = parsed.payments.find((payment) => payment.id === settledId);
    expect(settled?.network).toBe("near:testnet");
    expect(settled?.nearTxHash).toBe(`tx-${run}-settled`);
    expect(parsed.payments.find((payment) => payment.id === selfId)?.nearTxHash).toBeNull();
  });

  it("answers a body the dashboard's own schema refuses as a route failure, not an empty list", async () => {
    // The state column holds the machine's words; a row written by an older
    // migration or a hand-inserted probe with an unknown state must not be sent
    // to the dashboard as if it were a payment in a state Till understands.
    const { db } = need();
    const [row] = await db
      .insert(schema.payments)
      .values({
        endpointId: mineEndpoint,
        payerAccountId: STRANGER,
        amount: "10000",
        assetContract: "usdc.testnet",
        replayKey: `f3-junk-${run}`,
        state: "paid_please_ignore",
        verifiedAt: new Date(),
      })
      .returning({ id: schema.payments.id });
    expect(row).toBeDefined();
    try {
      const { status, body } = await listOnce(routeApp(claims));
      expect(status).toBe(500);
      expect(dashboardErrorSchema.parse(body).code).toBe("payment_unreadable");
      expect(body).toMatchObject({ code: "payment_unreadable" });
    } finally {
      if (row !== undefined) {
        await db.delete(schema.payments).where(eq(schema.payments.id, row.id));
      }
    }
  });

  it("sends every row it returns through the contract the web half parses", async () => {
    const { body } = await listOnce(routeApp(claims));
    const parsed = paymentListResponseSchema.parse(body);
    expect(parsed.payments.length).toBeGreaterThan(1);
    for (const payment of parsed.payments) {
      expect(paymentDtoSchema.safeParse(payment).success).toBe(true);
    }
  });

  it("is mounted at /api/payments by createApp", async () => {
    const app = createApp({
      env,
      log: quiet,
      db: need().db,
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
      payments: { session: async () => claims },
    });

    const response = await app.request("/api/payments");
    expect(response.status).toBe(200);
    const parsed = paymentListResponseSchema.parse(await response.json());
    expect(parsed.payments.map((payment) => payment.id)).toContain(settledId);
  });
});
