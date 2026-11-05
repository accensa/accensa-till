import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardErrorSchema,
  discrepancyDtoSchema,
  discrepancyListResponseSchema,
  discrepancyResolveResponseSchema,
  payerBlockClearResponseSchema,
  payerBlockListResponseSchema,
} from "@till/core";

import type { Db } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import { createDiscrepancyRoutes } from "../src/routes/discrepancies.ts";
import { strikesForPayer } from "../src/services/strikes.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * UI-4 (F4): the reconciliation surface a seller works from.
 *
 * Four things are pinned here and nowhere else:
 * - the worklist is this seller's *open* items, ordered by severity then age, with
 *   the order read out of `SEVERITIES` rather than restated (F4a);
 * - a manual resolve closes one row and says so with the row, and answers the same
 *   refusal whether the row is somebody else's or already shut — telling the seller
 *   which of the two it was would say who else has a discrepancy on this cause;
 * - the block list is the same predicate `strikesForPayer` computes, so the screen
 *   cannot show a payer as blocked while the gateway lets them through;
 * - a clear records *who lifted it* from the session, never from the body.
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
    const [present] = await sql`select to_regclass('public.discrepancies') as present`;
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
  // test-built handle is not assignable to it (see payments-route.test.ts).
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
const SELLER = { id: randomUUID(), nearAccountId: `till-f4-mine-${run}.testnet` };
const FOREIGN = { id: randomUUID(), nearAccountId: `till-f4-other-${run}.testnet` };
const BLOCKED_PAYER = `till-f4-blocked-${run}.testnet`;
const SINGLE_PAYER = `till-f4-single-${run}.testnet`;
const FOREIGN_PAYER_ON_FOREIGN = `till-f4-foreignpayer-${run}.testnet`;

const endpointMine = randomUUID();
const endpointForeign = randomUUID();

let env: Env;
let openHigh = "";
let openCritical = "";
let openLow = "";
let resolvedRow = "";
let foreignRow = "";

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

const session: SessionClaims = {
  sellerId: SELLER.id,
  nearAccountId: SELLER.nearAccountId,
};

async function addDiscrepancy(input: {
  readonly sellerId: string;
  readonly code: string;
  readonly severity: string;
  readonly ageHours: number;
  readonly resolvedAgeHours?: number | null;
}): Promise<string> {
  const { sql } = need();
  const id = randomUUID();
  await sql`insert into discrepancies (id, seller_id, code, severity, payment_id, swap_id,
      dedupe_key, explanation, suggested_action, opened_at, resolved_at, resolution)
    values (${id}, ${input.sellerId}, ${input.code}, ${input.severity}, null, null,
      ${`${input.code}:${id}`}, 'A sentence the rule wrote (LR-4).',
      'An action the rule wrote (LR-4).',
      now() - make_interval(hours => ${input.ageHours}::int),
      ${
        input.resolvedAgeHours === null || input.resolvedAgeHours === undefined
          ? sql`null`
          : sql`now() - make_interval(hours => ${input.resolvedAgeHours}::int)`
      },
      ${input.resolvedAgeHours === undefined ? null : "auto"})`;
  return id;
}

async function addStrike(endpointId: string, payer: string, ageHours = 0): Promise<void> {
  const { sql } = need();
  await sql`insert into payments (id, endpoint_id, payer_account_id, amount, asset_contract,
      replay_key, state, verified_at)
    values (${randomUUID()}, ${endpointId}, ${payer}, '10000', 'usdc.testnet',
      ${`f4-${randomUUID()}`}, 'served_unsettled',
      now() - make_interval(hours => ${ageHours}::int))`;
}

function route() {
  return createDiscrepancyRoutes({ db: need().db, env, log: quiet, session: async () => session });
}

function routeWithoutSession() {
  return createDiscrepancyRoutes({
    db: need().db,
    env,
    log: quiet,
    session: async () => null,
  });
}

async function readJson(response: Response): Promise<unknown> {
  return await response.json();
}

const suite = describe.skipIf(handle === null);

suite("GET /api/discrepancies (UI-4, F4)", () => {
  beforeAll(async () => {
    env = loadEnv({
      ...process.env,
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: "x".repeat(32),
      GATEWAY_PUBLIC_URL: "https://gateway.test",
    });
    const { sql } = need();
    for (const seller of [SELLER, FOREIGN]) {
      await sql`insert into sellers (id, near_account_id, display_name)
        values (${seller.id}, ${seller.nearAccountId}, 'F4 fixture')
        on conflict (id) do nothing`;
    }
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode)
      values (${endpointMine}, ${SELLER.id}, ${`f4-mine-${run}`}, 'https://example.test/data',
        '10000', 'usdc.testnet', 'near:testnet', 'direct')
      on conflict (id) do nothing`;
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode)
      values (${endpointForeign}, ${FOREIGN.id}, ${`f4-foreign-${run}`},
        'https://example.test/data', '10000', 'usdc.testnet', 'near:testnet', 'direct')
      on conflict (id) do nothing`;

    openHigh = await addDiscrepancy({
      sellerId: SELLER.id,
      code: "SERVED_NOT_SETTLED",
      severity: "high",
      ageHours: 6,
    });
    openCritical = await addDiscrepancy({
      sellerId: SELLER.id,
      code: "PAYOUT_FAILED",
      severity: "critical",
      ageHours: 2,
    });
    openLow = await addDiscrepancy({
      sellerId: SELLER.id,
      code: "PAYOUT_STUCK",
      severity: "low",
      ageHours: 48,
    });
    resolvedRow = await addDiscrepancy({
      sellerId: SELLER.id,
      code: "PAYMENT_NOT_SWEPT",
      severity: "critical",
      ageHours: 72,
      resolvedAgeHours: 1,
    });
    foreignRow = await addDiscrepancy({
      sellerId: FOREIGN.id,
      code: "ORPHAN_DEPOSIT",
      severity: "critical",
      ageHours: 1,
    });

    await addStrike(endpointMine, BLOCKED_PAYER, 5);
    await addStrike(endpointMine, BLOCKED_PAYER, 1);
    await addStrike(endpointMine, SINGLE_PAYER, 2);
    await addStrike(endpointForeign, FOREIGN_PAYER_ON_FOREIGN, 0);
    await addStrike(endpointForeign, FOREIGN_PAYER_ON_FOREIGN, 0);
  });

  it("refuses a request with no session, in the shape the dashboard parses", async () => {
    const app = routeWithoutSession();
    for (const path of ["/discrepancies", "/payer-blocks"]) {
      const response = await app.request(path);
      expect(response.status).toBe(401);
      expect(dashboardErrorSchema.parse(await readJson(response)).code).toBe("unauthenticated");
    }
    const resolve = await app.request(`/discrepancies/${openHigh}/resolve`, { method: "POST" });
    expect(resolve.status).toBe(401);
    const clear = await app.request(`/payer-blocks/${BLOCKED_PAYER}/clear`, { method: "POST" });
    expect(clear.status).toBe(401);
  });

  it("shows the seller their open items, and nothing else", async () => {
    const listed = discrepancyListResponseSchema.parse(
      await readJson(await route().request("/discrepancies")),
    );
    const ids = listed.discrepancies.map((item) => item.id);

    expect(ids).toContain(openCritical);
    expect(ids).toContain(openHigh);
    expect(ids).toContain(openLow);
    expect(ids).not.toContain(resolvedRow);
    expect(ids).not.toContain(foreignRow);
  });

  it("orders by severity first and age second, the order the page renders", async () => {
    const listed = discrepancyListResponseSchema.parse(
      await readJson(await route().request("/discrepancies")),
    );
    expect(listed.discrepancies.map((item) => item.severity)).toEqual(["critical", "high", "low"]);
    expect(listed.discrepancies.map((item) => item.id)).toEqual([openCritical, openHigh, openLow]);
  });

  it("keeps two same-severity items oldest first, because that is what has been wrong longest", async () => {
    const older = await addDiscrepancy({
      sellerId: SELLER.id,
      code: "PAYOUT_REFUNDED",
      severity: "critical",
      ageHours: 30,
    });
    const listed = discrepancyListResponseSchema.parse(
      await readJson(await route().request("/discrepancies")),
    );
    const ids = listed.discrepancies.map((item) => item.id);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(openCritical));
  });

  it("answers a row the contract refuses as a route failure, not a shorter list", async () => {
    const { sql } = need();
    const rotten = randomUUID();
    await sql`insert into discrepancies (id, seller_id, code, severity, dedupe_key,
        explanation, suggested_action, opened_at)
      values (${rotten}, ${SELLER.id}, 'SERVED_NOT_SETTLED', 'catastrophic',
        ${`rotten-${rotten}`}, 'x', 'y', now())`;

    const response = await route().request("/discrepancies");
    expect(response.status).toBe(500);
    const json = (await readJson(response)) as Record<string, unknown>;
    expect(dashboardErrorSchema.parse(json).code).toBe("discrepancy_unreadable");
    expect("discrepancies" in json).toBe(false);

    await sql`delete from discrepancies where id = ${rotten}`;
  });

  it("sends every row it returns through the contract the web half parses", async () => {
    const listed = discrepancyListResponseSchema.parse(
      await readJson(await route().request("/discrepancies")),
    );
    for (const item of listed.discrepancies) {
      const parsed = discrepancyDtoSchema.parse(item);
      expect(parsed.resolvedAt).toBeNull();
      expect(parsed.explanation.length).toBeGreaterThan(0);
      expect(parsed.suggestedAction.length).toBeGreaterThan(0);
    }
  });
});

suite("POST /api/discrepancies/:id/resolve (UI-4, F4)", () => {
  it("closes the seller's open row and answers the row as it now stands", async () => {
    const target = await addDiscrepancy({
      sellerId: SELLER.id,
      code: "SERVED_NOT_SETTLED",
      severity: "high",
      ageHours: 3,
    });

    const response = await route().request(`/discrepancies/${target}/resolve`, { method: "POST" });
    expect(response.status).toBe(200);
    const closed = discrepancyResolveResponseSchema.parse(await readJson(response)).discrepancy;
    expect(closed.id).toBe(target);
    expect(closed.resolution).toBe("manual");
    expect(closed.resolvedAt).not.toBeNull();

    const listed = discrepancyListResponseSchema.parse(
      await readJson(await route().request("/discrepancies")),
    );
    expect(listed.discrepancies.map((item) => item.id)).not.toContain(target);
  });

  it("refuses a row that is not the seller's, one that is already shut and one that never was", async () => {
    const app = route();
    for (const id of [foreignRow, resolvedRow, randomUUID()]) {
      const response = await app.request(`/discrepancies/${id}/resolve`, { method: "POST" });
      expect(response.status).toBe(404);
      expect(dashboardErrorSchema.parse(await readJson(response)).code).toBe(
        "discrepancy_not_found",
      );
    }
  });

  it("refuses an id that is not an id, in the shape the form reads", async () => {
    const response = await route().request("/discrepancies/not-a-uuid/resolve", {
      method: "POST",
    });
    expect(response.status).toBe(422);
    expect(dashboardErrorSchema.parse(await readJson(response)).code).toBe("invalid_request");
  });

  it("does not close a second row when asked twice for the same one", async () => {
    const target = await addDiscrepancy({
      sellerId: SELLER.id,
      code: "PAYOUT_FAILED",
      severity: "critical",
      ageHours: 1,
    });
    const app = route();
    expect((await app.request(`/discrepancies/${target}/resolve`, { method: "POST" })).status).toBe(
      200,
    );
    expect((await app.request(`/discrepancies/${target}/resolve`, { method: "POST" })).status).toBe(
      404,
    );
  });
});

suite("GET and POST /api/payer-blocks (UI-4, F4)", () => {
  it("lists the payers this seller is holding, with the strikes that still count", async () => {
    const listed = payerBlockListResponseSchema.parse(
      await readJson(await route().request("/payer-blocks")),
    );
    const byPayer = new Map(listed.payerBlocks.map((block) => [block.payerAccountId, block]));

    expect(byPayer.get(BLOCKED_PAYER)?.strikes).toBe(2);
    expect(byPayer.get(BLOCKED_PAYER)?.blocked).toBe(true);
    expect(byPayer.get(BLOCKED_PAYER)?.lastStrikeAt).not.toBeNull();
    expect(byPayer.has(SINGLE_PAYER)).toBe(false);
    expect(byPayer.has(FOREIGN_PAYER_ON_FOREIGN)).toBe(false);
  });

  it("agrees with the rule the gateway itself applies, for every payer it names", async () => {
    const listed = payerBlockListResponseSchema.parse(
      await readJson(await route().request("/payer-blocks")),
    );
    for (const block of listed.payerBlocks) {
      const state = await strikesForPayer(need().db, {
        payerAccountId: block.payerAccountId,
        sellerId: SELLER.id,
      });
      expect(block.strikes).toBe(state.count);
      expect(block.blocked).toBe(state.blocked);
    }
  });

  it("clears the block by the session's account and takes it off the list", async () => {
    const response = await route().request(`/payer-blocks/${BLOCKED_PAYER}/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "talked to them on discord" }),
    });
    expect(response.status).toBe(200);
    const cleared = payerBlockClearResponseSchema.parse(await readJson(response));
    expect(cleared.payerBlocks.map((block) => block.payerAccountId)).not.toContain(BLOCKED_PAYER);

    // The answer a clear gives *is* the read, the same computation rather than a
    // re-statement of it — so a page can redraw from the response alone.
    const listed = payerBlockListResponseSchema.parse(
      await readJson(await route().request("/payer-blocks")),
    );
    expect(cleared.payerBlocks).toEqual(listed.payerBlocks);
  });

  it("records who lifted it from the session, not from anything the body said", async () => {
    const { sql } = need();
    const [row] = await sql`select cleared_by, note from payer_clears
      where payer_account_id = ${BLOCKED_PAYER} and seller_id = ${SELLER.id}
      order by created_at desc limit 1`;
    expect(row?.cleared_by).toBe(SELLER.nearAccountId);
    expect(String(row?.note)).toContain("discord");

    const app = route();
    await app.request(`/payer-blocks/${SINGLE_PAYER}/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clearedBy: "attacker.testnet", note: "forged" }),
    });
    const [second] = await sql`select cleared_by from payer_clears
      where payer_account_id = ${SINGLE_PAYER} and seller_id = ${SELLER.id}
      order by created_at desc limit 1`;
    expect(second?.cleared_by).toBe(SELLER.nearAccountId);
  });

  it("refuses a payer name the chain would not accept and a note past the cap", async () => {
    const hostile = await route().request("/payer-blocks/Not An Account/clear", {
      method: "POST",
    });
    expect(hostile.status).toBe(422);
    expect(dashboardErrorSchema.parse(await readJson(hostile)).code).toBe("invalid_request");

    const long = await route().request(`/payer-blocks/${SINGLE_PAYER}/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "n".repeat(500) }),
    });
    expect(long.status).toBe(422);
  });

  it("answers a stored payer the contract refuses rather than a shorter list", async () => {
    const { sql } = need();
    // Two rows, because the list only ever names a payer at or above the threshold —
    // and a payer name the contract will not take is exactly what the gateway would
    // otherwise be showing a seller as a row they cannot clear.
    await addStrike(endpointMine, "x");
    await addStrike(endpointMine, "x");
    const response = await route().request("/payer-blocks");
    expect(response.status).toBe(500);
    const body = dashboardErrorSchema.parse(await readJson(response));
    expect(body.code).toBe("payer_block_unreadable");
    await sql`delete from payments where payer_account_id = ${"x"}`;
  });
});

suite("createApp mounts the reconciliation surface", () => {
  it("answers /api/discrepancies and /api/payer-blocks from the same app as the rest", async () => {
    const { createApp } = await import("../src/app.ts");
    const app = createApp({
      env,
      log: quiet,
      db: need().db,
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
      discrepancies: { session: async () => session },
    });

    const listed = await app.request("/api/discrepancies");
    expect(listed.status).toBe(200);
    expect(
      discrepancyListResponseSchema.parse(await listed.json()).discrepancies.map((item) => item.id),
    ).toContain(openCritical);

    const blocks = await app.request("/api/payer-blocks");
    expect(blocks.status).toBe(200);
    payerBlockListResponseSchema.parse(await blocks.json());
  });
});

afterAll(async () => {
  if (handle !== null) {
    const { sql } = handle;
    // Child rows first, or the foreign keys answer for the sellers before they can go.
    await sql`delete from discrepancies where seller_id in (${SELLER.id}, ${FOREIGN.id})`;
    await sql`delete from payer_clears where seller_id in (${SELLER.id}, ${FOREIGN.id})`;
    await sql`delete from payments where endpoint_id in (${endpointMine}, ${endpointForeign})`;
    await sql`delete from endpoints where id in (${endpointMine}, ${endpointForeign})`;
    await sql`delete from sellers where id in (${SELLER.id}, ${FOREIGN.id})`;
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
});
