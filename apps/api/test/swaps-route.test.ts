import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { swapDtoSchema } from "@till/core";

import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import { createSwapRoutes } from "../src/routes/swaps.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * UI-3 / D6 (F8): the payout leg a seller reads.
 *
 * The dashboard used to show money in and nothing out: `routes/swaps.ts` was a
 * one-line stub, so a swap that refunded, stalled or never matched a payment was
 * visible only in the reconcile worklist. What is pinned here is the scope — a swap
 * carries no seller id, and the `payout_routes` join is the only thing that decides
 * whose payout it is — plus the shape the timeline component already expects.
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
    const [present] = await sql`select to_regclass('public.swaps') as present`;
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
const MINE = { id: randomUUID(), nearAccountId: `till-f8-mine-${run}.testnet` };
const OTHER = { id: randomUUID(), nearAccountId: `till-f8-other-${run}.testnet` };

let env: Env;

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const claims: SessionClaims = { sellerId: MINE.id, nearAccountId: MINE.nearAccountId };

/** A route row is the only path from a swap to a seller, so each fixture needs one. */
async function addRoute(sellerId: string, key: string): Promise<string> {
  const { db } = need();
  const [row] = await db
    .insert(schema.payoutRoutes)
    .values({
      sellerId,
      destinationChain: "ethereum",
      destinationAsset: "0xa0b8",
      destinationAddress: `0x${key}${run}`,
      refundAddress: `refund-${key}-${run}.testnet`,
      provider: "mock",
      depositAddress: `mock-deposit-${key}-${run}`,
      modeDetail: "standing",
    })
    .returning({ id: schema.payoutRoutes.id });
  if (row === undefined) {
    throw new Error(`fixture route ${key} was not returned`);
  }
  return row.id;
}

async function addSwap(
  routeId: string,
  key: string,
  state: string,
  fields: { paymentId?: string; refundedAmount?: string; originTxHash?: string } = {},
): Promise<string> {
  const { db } = need();
  const [row] = await db
    .insert(schema.swaps)
    .values({
      routeId,
      paymentId: fields.paymentId ?? null,
      providerRef: `f8-${key}-${run}`,
      state,
      amountIn: "10000",
      amountOut: state === "succeeded" ? "9990" : null,
      refundedAmount: fields.refundedAmount ?? null,
      originTxHash: fields.originTxHash ?? null,
      lastPolledAt: new Date(),
      terminalAt: state === "succeeded" || state === "refunded" ? new Date() : null,
      raw: { fixture: key },
    })
    .returning({ id: schema.swaps.id });
  if (row === undefined) {
    throw new Error(`fixture swap ${key} was not returned`);
  }
  return row.id;
}

function routeApp(session: SessionClaims | null) {
  return createSwapRoutes({ db: need().db, env, log: quiet, session: async () => session });
}

async function listOnce(
  app: ReturnType<typeof routeApp>,
): Promise<{ status: number; body: unknown }> {
  const response = await app.request("/swaps");
  return { status: response.status, body: await response.json() };
}

const suite = describe.skipIf(handle === null);

suite("GET /api/swaps (UI-3, D6, F8)", () => {
  let mineSuccess = "";
  let mineRefunded = "";
  let foreignSuccess = "";

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
        values (${seller.id}, ${seller.nearAccountId}, 'F8 fixture')
        on conflict (id) do nothing`;
    }
    const mineRoute = await addRoute(MINE.id, "mine");
    const otherRoute = await addRoute(OTHER.id, "other");
    mineSuccess = await addSwap(mineRoute, "success", "succeeded", {
      originTxHash: `tx-${run}-mine`,
    });
    mineRefunded = await addSwap(mineRoute, "refunded", "refunded", { refundedAmount: "10000" });
    foreignSuccess = await addSwap(otherRoute, "foreign", "succeeded");
  });

  afterAll(async () => {
    if (handle === null) {
      return;
    }
    const { sql } = need();
    // Swaps first (FK to the route), then the routes, then the sellers.
    await sql`delete from swaps where provider_ref like ${`f8-%-${run}`}`;
    await sql`delete from payout_routes where refund_address like ${`refund-%-${run}.testnet`}`;
    for (const seller of [MINE, OTHER]) {
      await sql`delete from sellers where id = ${seller.id}`;
    }
  });

  it("refuses an unsigned request", async () => {
    const { status, body } = await listOnce(routeApp(null));
    expect(status).toBe(401);
    expect(body).toMatchObject({ code: "unauthenticated" });
  });

  it("answers the seller's own payouts and nobody else's", async () => {
    const { status, body } = await listOnce(routeApp(claims));
    expect(status).toBe(200);
    const parsed = body as { swaps: unknown[] };
    const ids = parsed.swaps.map((row) => (row as { id: string }).id);
    expect(ids).toContain(mineSuccess);
    expect(ids).toContain(mineRefunded);
    // The scope is the route join, not a filter the caller can influence.
    expect(ids).not.toContain(foreignSuccess);
  });

  it("carries the state, the amounts and the hashes the timeline renders", async () => {
    const { body } = await listOnce(routeApp(claims));
    const parsed = (body as { swaps: unknown[] }).swaps.map((row) => swapDtoSchema.parse(row));
    const refunded = parsed.find((row) => row.state === "refunded");
    expect(refunded?.refundedAmount).toBe("10000");
    expect(refunded?.terminalAt).not.toBeNull();
    const success = parsed.find((row) => row.originTxHash === `tx-${run}-mine`);
    expect(success?.amountOut).toBe("9990");
    // An unmatched swap is an orphan candidate, not another seller's payout (LR-2).
    expect(success?.paymentId).toBeNull();
  });

  it("is mounted at /api/swaps by createApp", async () => {
    const app = createApp({
      env,
      log: quiet,
      db: need().db,
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
      swaps: { session: async () => claims },
    });
    const response = await app.request("/api/swaps");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ swaps: expect.any(Array) });
  });
});
