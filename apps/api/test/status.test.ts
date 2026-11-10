import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dashboardErrorSchema, statusResponseSchema } from "@till/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import { createStatusRoutes } from "../src/routes/status.ts";
import {
  type RelayerBalanceReader,
  createRelayerBalanceReader,
  readSellerPoll,
} from "../src/services/status.ts";

/**
 * UI-5 (F5): the two numbers the header shows and the two thresholds they are
 * judged against.
 *
 * Three files' worth of behaviour, and the split is the point:
 *
 * - **the chain read** (a bare `view_account`, the `access-keys.ts` shape) is
 *   tested with `fetch` stubbed, because the suite must run offline and because
 *   what is being pinned is which refusal becomes which state. A node that times
 *   out must not become a balance of zero; a zero balance is a fact and a failed
 *   look is not.
 * - **the database read** runs on real Postgres, because `ageSeconds` is the
 *   database's clock minus the database's column (hard rule 12) and the seller
 *   scope is a join through `payout_routes`. Both are things a fake cannot show.
 * - **the route** answers for the session's seller and for nobody else.
 *
 * Needs `DATABASE_URL`; without a reachable database the halves that need it skip.
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

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

// --- the chain read, with fetch stubbed ----------------------------------------------

type Stub = { status?: number; json?: unknown; throws?: boolean };

const realFetch = globalThis.fetch;
const calls: { url: string; body: string }[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

function stubReader(outcome: Stub): RelayerBalanceReader {
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    if (outcome.throws === true) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(outcome.json ?? {}), {
      status: outcome.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return createRelayerBalanceReader({ rpcUrl: "https://rpc.stub.test", timeoutMs: 1000 });
}

describe("the relayer balance read (UI-5)", () => {
  it("asks the node for this account, with nothing that spends or signs", async () => {
    const reader = stubReader({ json: { result: { amount: "1500000000000000000000000" } } });
    expect(await reader("relayer.testnet")).toEqual({
      ok: true,
      amount: 1_500_000_000_000_000_000_000_000n,
    });

    const [call] = calls;
    expect(call?.url).toBe("https://rpc.stub.test");
    expect(JSON.parse(call?.body ?? "")).toEqual({
      jsonrpc: "2.0",
      id: "till-header-status",
      method: "query",
      params: { request_type: "view_account", account_id: "relayer.testnet", finality: "final" },
    });
    expect(call?.body).not.toMatch(/secret|private_key|signature/i);
  });

  it("keeps the balance a bigint all the way, including past a float's reach", async () => {
    // 1e24 yoctoNEAR is exact only in integers: `Number` would land it on a
    // neighbouring value, and the header compares this against a threshold.
    const reader = stubReader({ json: { result: { amount: "1000000000000000000000001" } } });
    const read = await reader("relayer.testnet");
    expect(read).toEqual({ ok: true, amount: 1_000_000_000_000_000_000_000_001n });
  });

  it("names an account that is not there, in each wording a node uses", async () => {
    for (const error of [
      "contract account relayer.testnet does not exist",
      "no such account",
      "unknown account relayer.testnet",
    ]) {
      const reader = stubReader({ json: { error: { name: "HANDLER_ERROR", cause: { error } } } });
      expect([error, await reader("relayer.testnet")]).toEqual([
        error,
        { ok: false, reason: "account_missing" },
      ]);
    }
  });

  it("does not turn a lagging or broken node into a missing account", async () => {
    // The false statement this refuses: "your relayer is not on this network" is
    // something a seller would go and fix, and it is wrong when our node is behind.
    const reader = stubReader({
      json: { error: { cause: { error: "unreachable state, lacks balance" } } },
    });
    expect(await reader("relayer.testnet")).toEqual({ ok: false, reason: "unreadable" });
  });

  it("refuses rather than guesses on every other failure", async () => {
    const outcomes: readonly Stub[] = [
      { status: 500, json: {} },
      // An HTTP-level failure carries no agreed meaning, so its body is not read
      // for a balance even when it happens to name a missing account.
      { status: 404, json: { error: { cause: { error: "contract does not exist" } } } },
      { json: {} },
      { json: { result: {} } },
      { json: { result: { amount: 1_000_000n } } },
      // A balance that is not an integer of yoctoNEAR is not a balance. Zeroing it
      // here would be the reassuring number UI-5 exists to stop.
      { json: { result: { amount: "" } } },
      { json: { result: { amount: "1.5e24" } } },
      { json: { result: { amount: "-1" } } },
      { throws: true },
    ];
    for (const outcome of outcomes) {
      expect(await stubReader(outcome)("relayer.testnet")).toEqual({
        ok: false,
        reason: "unreadable",
      });
    }
  });
});

// --- the database read, on real Postgres ---------------------------------------------

const run = randomUUID().slice(0, 8);
const mine = { id: randomUUID(), routeId: randomUUID(), near: `till-f5-mine-${run}.testnet` };
const theirs = {
  id: randomUUID(),
  routeId: randomUUID(),
  near: `till-f5-theirs-${run}.testnet`,
};

async function seedSellers(): Promise<void> {
  const { sql } = need();
  for (const seller of [mine, theirs]) {
    await sql`insert into sellers (id, near_account_id, display_name)
      values (${seller.id}, ${seller.near}, 'F5 fixture')
      on conflict (id) do nothing`;
    await sql`insert into payout_routes (id, seller_id, destination_chain, destination_asset,
        destination_address, refund_address, provider, mode_detail)
      values (${seller.routeId}, ${seller.id}, 'near', 'usdc',
        ${`dest-${seller.near}`}, ${`refund-${seller.near}`}, 'mock', 'standing')
      on conflict (id) do nothing`;
  }
}

/** One of the seller's swaps, answered or not, answered how long ago. */
async function newSwap(input: {
  readonly routeId: string;
  readonly answeredSecondsAgo?: number | null;
}): Promise<string> {
  const { sql } = need();
  const id = randomUUID();
  await sql`insert into swaps (id, route_id, provider_ref, state, raw, last_polled_at)
    values (${id}, ${input.routeId}, ${`f5-${id}`}, 'processing', '{}'::jsonb,
      ${
        input.answeredSecondsAgo === null || input.answeredSecondsAgo === undefined
          ? sql`null`
          : sql`now() - make_interval(secs => ${input.answeredSecondsAgo}::int)`
      })`;
  return id;
}

async function newDiscrepancy(sellerId: string): Promise<string> {
  const { sql } = need();
  const id = randomUUID();
  await sql`insert into discrepancies (id, seller_id, code, severity, dedupe_key,
      explanation, suggested_action, opened_at)
    values (${id}, ${sellerId}, 'PAYOUT_STUCK', 'high', ${`f5:${id}`},
      'A payout has not moved.', 'Check the swap.', now())`;
  return id;
}

const suite = describe.skipIf(handle === null);

suite("readSellerPoll (UI-5, D6)", () => {
  beforeAll(seedSellers);

  it("says 'no payouts tracked yet' for a seller with no swaps", async () => {
    const fresh = randomUUID();
    const { db, sql } = need();
    await db
      .insert(schema.sellers)
      .values({ id: fresh, nearAccountId: `till-f5-none-${run}.testnet` });
    expect(await readSellerPoll(db, fresh)).toEqual({
      state: "no_swaps",
      swaps: 0,
      lastPolledAt: null,
      ageSeconds: null,
    });
    await sql`delete from sellers where id = ${fresh}`;
  });

  it("separates a swap that has never been answered from one that was", async () => {
    const swap = await newSwap({ routeId: mine.routeId });
    expect(await readSellerPoll(need().db, mine.id)).toEqual({
      // "never polled" is the alarming one and must not read like "nothing yet":
      // a swap exists and the provider has not answered for it once.
      state: "never_polled",
      swaps: 1,
      lastPolledAt: null,
      ageSeconds: null,
    });
    await need().sql`delete from swaps where id = ${swap}`;
  });

  it("ages the answer by the database clock, not by this process's", async () => {
    const swap = await newSwap({ routeId: mine.routeId, answeredSecondsAgo: 300 });
    const poll = await readSellerPoll(need().db, mine.id);
    expect(poll.state).toBe("polled");
    expect(poll.swaps).toBe(1);
    // The row was stamped `now() - 300s` by Postgres, so the age the same database
    // reports is 300 give or take a second of wall clock between the two calls.
    if (poll.ageSeconds === null) {
      throw new Error("unreachable: a polled swap answers an age");
    }
    expect(poll.ageSeconds).toBeGreaterThanOrEqual(299);
    expect(poll.ageSeconds).toBeLessThanOrEqual(301);
    expect(poll.lastPolledAt).not.toBeNull();
    await need().sql`delete from swaps where id = ${swap}`;
  });

  it("takes the newest answer across the seller's own swaps", async () => {
    const oldSwap = await newSwap({ routeId: mine.routeId, answeredSecondsAgo: 900 });
    const newSwapId = await newSwap({ routeId: mine.routeId, answeredSecondsAgo: 5 });
    const poll = await readSellerPoll(need().db, mine.id);
    expect([poll.state, poll.swaps]).toEqual(["polled", 2]);
    if (poll.ageSeconds === null) {
      throw new Error("unreachable");
    }
    expect(poll.ageSeconds).toBeLessThan(60);
    await need().sql`delete from swaps where id in (${oldSwap}, ${newSwapId})`;
  });

  it("keeps another seller's swaps out of these numbers", async () => {
    // Both directions, because one leak is enough: B's answer is one second old and
    // would make A's stale answer look fresh, while A's is over an hour old and
    // would make B's fresh one look stale. `max` is scoped or it is a global.
    const fresh = await newSwap({ routeId: theirs.routeId, answeredSecondsAgo: 1 });
    const stale = await newSwap({ routeId: mine.routeId, answeredSecondsAgo: 4_000 });

    const a = await readSellerPoll(need().db, mine.id);
    const b = await readSellerPoll(need().db, theirs.id);
    if (a.ageSeconds === null || b.ageSeconds === null) {
      throw new Error("unreachable: both sellers have an answer");
    }
    expect(a.ageSeconds).toBeGreaterThan(3_000);
    expect(b.ageSeconds).toBeLessThan(60);

    await need().sql`delete from swaps where id in (${fresh}, ${stale})`;
  });

  it("counts only the seller's own swaps", async () => {
    const mineSwap = await newSwap({ routeId: mine.routeId });
    const theirsSwap = await newSwap({ routeId: theirs.routeId });
    expect((await readSellerPoll(need().db, mine.id)).swaps).toBe(1);
    expect((await readSellerPoll(need().db, theirs.id)).swaps).toBe(1);
    await need().sql`delete from swaps where id in (${mineSwap}, ${theirsSwap})`;
  });
});

// --- the route ------------------------------------------------------------------------

const session: SessionClaims = { sellerId: mine.id, nearAccountId: mine.near };

const READER_1_5_NEAR: RelayerBalanceReader = async () => ({
  ok: true,
  amount: 1_500_000_000_000_000_000_000_000n,
});
const READER_POOR: RelayerBalanceReader = async () => ({ ok: true, amount: 500_000n });
const READER_DOWN: RelayerBalanceReader = async () => ({ ok: false, reason: "unreadable" });

let env: Env;

function envWith(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: "x".repeat(32),
    GATEWAY_PUBLIC_URL: "https://gateway.test",
    ...overrides,
  });
}

function route(overrides: {
  readonly balance: RelayerBalanceReader;
  readonly session?: SessionClaims | null;
  readonly env?: Env;
}) {
  const claims = overrides.session === null ? null : (overrides.session ?? session);
  return createStatusRoutes({
    db: need().db,
    env: overrides.env ?? env,
    log: quiet,
    balance: overrides.balance,
    session: async () => claims,
  });
}

async function bodyOf(response: Response): Promise<unknown> {
  return await response.json();
}

/** What a seller gets back, or the failure that says the route did not answer. */
async function statusOf(overrides: Parameters<typeof route>[0]) {
  const response = await route(overrides).request("/status");
  return { response, status: statusResponseSchema.safeParse(await bodyOf(response)) };
}

suite("GET /api/status (UI-5, F5)", () => {
  beforeAll(async () => {
    env = envWith();
    await seedSellers();
  });

  it("refuses a request with no session, in the shape the dashboard parses", async () => {
    const response = await route({
      balance: READER_1_5_NEAR,
      session: null,
    }).request("/status");
    expect(response.status).toBe(401);
    expect(dashboardErrorSchema.parse(await bodyOf(response)).code).toBe("unauthenticated");
  });

  it("answers the relayer's account, network, balance and the threshold it is judged against", async () => {
    const { response, status } = await statusOf({ balance: READER_1_5_NEAR });
    expect(response.status).toBe(200);
    if (!status.success) {
      throw new Error("unreachable: the route answered outside its own contract");
    }
    expect(status.data.status.relayer).toEqual({
      accountId: "relayer.testnet",
      network: "near:testnet",
      state: "ok",
      // A decimal string across the boundary, never a JSON number (hard rule 3).
      amount: "1500000000000000000000000",
      alertBelow: "1000000000000000000000000",
    });
  });

  it("reports a poor relayer as a balance, not as a failure", async () => {
    const { status } = await statusOf({ balance: READER_POOR });
    if (!status.success) {
      throw new Error("unreachable");
    }
    expect(status.data.status.relayer.state).toBe("ok");
    expect(status.data.status.relayer.amount).toBe("500000");
  });

  it("reports an unreadable balance as its own state, with no number attached", async () => {
    // The whole point of the UI-5 shape: a header that showed 0 here would tell the
    // seller their relayer is broke when nobody managed to look.
    const { status } = await statusOf({ balance: READER_DOWN });
    if (!status.success) {
      throw new Error("unreachable");
    }
    expect(status.data.status.relayer).toEqual({
      accountId: "relayer.testnet",
      network: "near:testnet",
      state: "unreadable",
      amount: null,
      alertBelow: "1000000000000000000000000",
    });
  });

  it("derives the staleness window from the poll interval rather than a second knob", async () => {
    const seven = envWith({ POLL_INTERVAL_SECONDS: "7" });
    const { status } = await statusOf({ balance: READER_1_5_NEAR, env: seven });
    if (!status.success) {
      throw new Error("unreachable");
    }
    expect(status.data.status.payouts.staleAfterSeconds).toBe(35);
    expect(status.data.status.payouts.provider).toBe("mock");
  });

  it("names the balance threshold from the environment, defaulted at 1 NEAR", async () => {
    expect(env.RELAYER_BALANCE_ALERT_BASE_UNITS).toBe(1_000_000_000_000_000_000_000_000n);
    const configured = envWith({ RELAYER_BALANCE_ALERT_BASE_UNITS: "2500000000000000000000000" });
    const { status } = await statusOf({ balance: READER_1_5_NEAR, env: configured });
    if (!status.success) {
      throw new Error("unreachable");
    }
    expect(status.data.status.relayer.alertBelow).toBe("2500000000000000000000000");
  });

  it("answers the session's seller and no other's", async () => {
    // Seller B has a swap answered one second ago and a discrepancy of its own; seller
    // A has a swap that has never been answered. Neither of B's rows may move A's
    // header, and a balance read is not a scope: the same reader answers both.
    const swapB = await newSwap({ routeId: theirs.routeId, answeredSecondsAgo: 1 });
    const discrepancyB = await newDiscrepancy(theirs.id);
    const swapA = await newSwap({ routeId: mine.routeId });

    const asA = await statusOf({
      balance: READER_DOWN,
      session: { sellerId: mine.id, nearAccountId: mine.near },
    });
    const asB = await statusOf({
      balance: READER_DOWN,
      session: { sellerId: theirs.id, nearAccountId: theirs.near },
    });
    if (!asA.status.success || !asB.status.success) {
      throw new Error("unreachable");
    }
    expect(asA.status.data.status.payouts).toMatchObject({ state: "never_polled", swaps: 1 });
    expect(asB.status.data.status.payouts).toMatchObject({ state: "polled", swaps: 1 });

    await need().sql`delete from swaps where id in (${swapA}, ${swapB})`;
    await need().sql`delete from discrepancies where id = ${discrepancyB}`;
  });

  it("answers a body its own contract refuses as a coded failure, not a partial header", async () => {
    // A relayer account id the chain schema will not take is a fault in Till's config,
    // and a header that silently dropped the balance would read as "nothing to report".
    const broken = envWith({ RELAYER_ACCOUNT_ID: "Not An Account" });
    const response = await route({ balance: READER_1_5_NEAR, env: broken }).request("/status");
    expect(response.status).toBe(500);
    expect(dashboardErrorSchema.parse(await bodyOf(response)).code).toBe("status_unreadable");
  });
});

suite("createApp mounts the header status", () => {
  it("answers /api/status from the same app as the rest of the dashboard", async () => {
    const { createApp } = await import("../src/app.ts");
    const app = createApp({
      env,
      log: quiet,
      db: need().db,
      x402: (await import("../src/x402/near.ts")).createX402Near({
        network: "near:testnet",
        maxSponsoredGas: 30_000_000_000_000n,
      }),
      status: { session: async () => session, balance: READER_1_5_NEAR },
    });

    const response = await app.request("/api/status");
    expect(response.status).toBe(200);
    statusResponseSchema.parse(await bodyOf(response));
  });
});

afterAll(async () => {
  if (handle === null) {
    return;
  }
  // Rows this file mints are named by the ids it minted them with, so the cleanup
  // cannot touch another suite's fixture on a shared database. Child rows first:
  // the foreign keys would otherwise answer for the sellers before they could go.
  const { sql } = handle;
  await sql`delete from swaps where route_id in (${mine.routeId}, ${theirs.routeId})`;
  await sql`delete from discrepancies where seller_id in (${mine.id}, ${theirs.id})`;
  await sql`delete from payout_routes where id in (${mine.routeId}, ${theirs.routeId})`;
  await sql`delete from sellers where id in (${mine.id}, ${theirs.id})`;
  await sql.end({ timeout: 5 }).catch(() => undefined);
});
