import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalNearSigner } from "@fastnear/x402/node";
import { paymentPayloadSchema } from "@till/core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createApp } from "../src/app.ts";
import type { Db } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import { guardsPendingC8, inFlightWindowSeconds } from "../src/gateway/guards.ts";
import { type ProxyResult, getUpstream } from "../src/gateway/proxy.ts";
import { PAYMENT_REQUIRED_HEADER } from "../src/gateway/requirements.ts";
import {
  LEGACY_PAYMENT_SIGNATURE_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createGatewayRoute,
} from "../src/gateway/route.ts";
import type { UpstreamTarget } from "../src/gateway/ssrf.ts";
import type { Logger } from "../src/lib/logger.ts";
import { clearPayerBlock } from "../src/services/strikes.ts";
import { createX402Near } from "../src/x402/near.ts";
import type { NearViewSigner, RequirementsInput, X402Near } from "../src/x402/types.ts";

/**
 * C4 acceptance: the gateway's paid request, end to end, offline.
 *
 * What is real, and why each piece had to be:
 *
 * - **Postgres.** The route's promises are about rows: a payment is inserted before
 *   the upstream is dialed, `verified_at` is the database clock, `abandoned` is what
 *   a refused response leaves behind, and exactly one `payment_in` is written per
 *   settled payment. An in-memory fake would be asserting my own bookkeeping rather
 *   than the ledger's. The file skips without `DATABASE_URL`, like `payments.test.ts`.
 * - **The upstream.** A real `node:http` server on `127.0.0.1` dialed by the real
 *   `getUpstream`, because what the route consumes is what the proxy *returns*: a
 *   status, a header map with payment and hop-by-hop headers already stripped, the
 *   bytes, and the elapsed time that lands in `upstream_ms`. C5's own suite reached
 *   its server the same way -- by building the `UpstreamTarget` instead of resolving
 *   one, since `ssrf.ts` refuses loopback by design. The last test goes through the
 *   *default* seam to show that refusal is what a real boot does.
 * - **The payment layer.** Usually a script, because the route's job at that step is
 *   to branch on a result and a script can hand back every kind the union allows --
 *   but the happy path and the wrong-price path run the real `createX402Near` over a
 *   genuine NEP-366 delegate minted against a loopback JSON-RPC stub, so those two
 *   assertions are the shipped scheme's own accept and refuse.
 *
 * Not proven, and owed to A10: that a real relayer submits, that a real `ft_transfer`
 * lands, and that the hash this suite stores is one a block explorer can open. That
 * is the "integration test on testnet" half of the Done-when, and it is the reason
 * this row is `[~]` rather than `[x]`.
 */

const PAYER = "gateway-payer.testnet";
const TOKEN = "usdc.testnet";
const RELAYER = "relayer.testnet";
/** A throwaway key, never a funded one: nothing here can move money. */
const PAYER_KEY = "ed25519:3C8DxNwqJ5rP4nFBEhKZKvXWMBcpPvjGqPgn2sTQxXWJ";
const NO_CONTRACT = "11111111111111111111111111111111";
const HAS_CONTRACT = "7BCKZH9Znj1iMAhRMLTR81vXATMiKh3KZbLK7MF3KtU4";
const BLOCK_HEIGHT = 123_456_789;
const BLOCK_HASH = "FG25p2pNTtW8fBuPqMfvv5f6YQqJn7XwEw5o6oPzb8Kq";
const PRICE = "10000";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `x402/near.ts` hashes the delegate it is given; the tests key their rows the same way. */
function replayKeyOf(delegateAction: string): string {
  return createHash("sha256").update(delegateAction).digest("hex");
}

// --- Postgres ------------------------------------------------------------------------------

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

// --- The seller's upstream -----------------------------------------------------------------

const UPSTREAM = {
  data: "/data",
  notFound: "/not-found",
  unavailable: "/unavailable",
  dropped: "/dropped",
  hold: "/hold",
  moved: "/moved",
  slow: "/slow",
  flaky: "/flaky",
} as const;

/**
 * The `/hold` route answers only when the test lets it, which is how a paid request
 * is made to occupy the "row inserted, seller not yet answered" window that Guard 3
 * is about. Without it every concurrent test would be a test of the event loop.
 */
let releaseHold: (() => void) | null = null;

/**
 * C7 needs one endpoint that is both a failure and a success: the first attempt has
 * to leave an `abandoned` row and the retry of the *same* authorization has to be
 * servable, and a retry at a different endpoint is a different payment (see the
 * cross-endpoint test). So the seller's behaviour on `/flaky` is a switch the test
 * throws between the two halves.
 */
let flakyFails = false;

let upstreamServer: Server;
let upstreamPort = 0;
/** Every request the seller actually received, in order. A guard that refuses must add nothing. */
const sellerHits: string[] = [];

beforeAll(async () => {
  upstreamServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    sellerHits.push(path);
    if (path === UPSTREAM.hold) {
      new Promise<void>((resolve) => {
        releaseHold = resolve;
      }).then(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ price: 4213, unit: "eur", path }));
      });
      return;
    }
    if (path === UPSTREAM.data) {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        // Both must be gone by the time the buyer sees the answer: a cookie written
        // on the gateway origin is G6 F2, `x-402-version` is payment material.
        "set-cookie": "session=from-the-seller; Path=/",
        "x-402-version": "2",
      });
      response.end(JSON.stringify({ price: 4213, unit: "eur", path }));
      return;
    }
    if (path === UPSTREAM.notFound) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "no such record" }));
      return;
    }
    if (path === UPSTREAM.unavailable) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("the seller is down");
      return;
    }
    if (path === UPSTREAM.dropped) {
      // Half a body and then the socket goes: the proxy's `upstream_unreachable`,
      // which the route has to read as "nothing was served".
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"price":');
      response.destroy();
      return;
    }
    if (path === UPSTREAM.moved) {
      // C6's case. `location` is the whole answer, and it must survive the response
      // filter; the seller's own `set-cookie` must not.
      response.writeHead(302, {
        location: `${UPSTREAM.data}?moved=1`,
        "content-type": "text/plain",
        "set-cookie": "from-a-redirect=1; Path=/",
      });
      response.end("moved");
      return;
    }
    if (path === UPSTREAM.flaky) {
      if (flakyFails) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("the seller is having a moment");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ price: 4213, unit: "eur", path }));
      return;
    }
    if (path === UPSTREAM.slow) {
      // Outlives `UPSTREAM_TIMEOUT_MS` (2000 in `envFor`) without ever answering, so
      // the route sees the proxy's timeout rather than a status.
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ price: 4213, unit: "eur", path }));
        }
      }, 3_000);
      return;
    }
    response.writeHead(418, { "content-type": "text/plain" });
    response.end("teapot");
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstreamServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    upstreamServer.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  if (handle !== null) {
    await handle.sql.end({ timeout: 1 }).catch(() => undefined);
  }
});

// --- Seeded rows ---------------------------------------------------------------------------

type Fixture = {
  readonly sellerId: string;
  readonly sellerAccount: string;
  readonly endpointId: string;
  readonly slug: string;
  readonly routeId: string;
  readonly depositAddress: string | null;
};

const fixtures = new Map<string, Fixture>();

function fixture(name: string): Fixture {
  const found = fixtures.get(name);
  if (found === undefined) {
    throw new Error(`fixture ${name} was never inserted`);
  }
  return found;
}

type FixtureInput = {
  readonly name: string;
  readonly payoutMode: "direct" | "intents";
  /** Absent or `null` means the route has no standing deposit address. */
  readonly depositAddress?: string | null;
  readonly priceAmount?: string;
  readonly network?: string;
  readonly active?: boolean;
  /** A payout mode the schema has no meaning for, written straight past the union. */
  readonly rawPayoutMode?: string;
  /** Which of the upstream's behaviours this endpoint is wired to. */
  readonly path?: keyof typeof UPSTREAM;
};

async function insertFixture(input: FixtureInput): Promise<Fixture> {
  const { sql } = need();
  const short = randomUUID().slice(0, 8);
  const sellerId = randomUUID();
  const endpointId = randomUUID();
  const routeId = randomUUID();
  const slug = `c4-${input.name}-${short}`;
  const sellerAccount = `c4-${input.name}-${short}.testnet`;
  const depositAddress =
    typeof input.depositAddress === "string" ? `dep-${short}-${input.depositAddress}` : null;

  await sql`insert into sellers (id, near_account_id, display_name)
    values (${sellerId}, ${sellerAccount}, ${`C4 ${input.name}`})`;
  await sql`insert into payout_routes (id, seller_id, destination_chain, destination_asset,
      destination_address, refund_address, provider, deposit_address, mode_detail)
    values (${routeId}, ${sellerId}, 'near', ${TOKEN}, ${`0x${short}${short}`},
      ${`0xrefund${short}`}, 'mock', ${depositAddress}, 'standing')`;
  await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
      asset_contract, network, description, payout_mode, route_id, active)
    values (${endpointId}, ${sellerId}, ${slug},
      ${`http://127.0.0.1:${upstreamPort}${UPSTREAM[input.path ?? "data"]}`},
      ${input.priceAmount ?? PRICE}, ${TOKEN}, ${input.network ?? "near:testnet"},
      ${"EUR prices from the seller"}, ${input.rawPayoutMode ?? input.payoutMode}, ${routeId},
      ${input.active ?? true})`;

  const created: Fixture = {
    sellerId,
    sellerAccount,
    endpointId,
    slug,
    routeId,
    depositAddress,
  };
  fixtures.set(input.name, created);
  return created;
}

/** Point one fixture's endpoint at another of the upstream's routes. */

// --- Env, logger ---------------------------------------------------------------------------

function envFor(): Env {
  return loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: "x".repeat(32),
    GATEWAY_PUBLIC_URL: "http://gateway.test",
    NEAR_NETWORK: "near:testnet",
    // Local dev only. It relaxes https-vs-http, not the address policy, which is
    // what the last test in the file proves.
    ALLOW_INSECURE_UPSTREAM: "true",
    UPSTREAM_TIMEOUT_MS: "2000",
    AUTHORIZATION_EXPIRY_MARGIN_MS: "30000",
    MIN_PRICE_BASE_UNITS: "10000",
  });
}

type Recorded = { readonly logger: Logger; readonly lines: Record<string, unknown>[] };

function recordingLogger(): Recorded {
  const lines: Record<string, unknown>[] = [];
  const record = (level: string) => (fields: Record<string, unknown>) => {
    lines.push({ level, ...fields });
  };
  const build = (extra: Record<string, unknown>): Logger => ({
    info: (fields) => record("info")({ ...extra, ...fields }),
    warn: (fields) => record("warn")({ ...extra, ...fields }),
    error: (fields) => record("error")({ ...extra, ...fields }),
    child: (more) => build({ ...extra, ...more }),
  });
  return { logger: build({}), lines };
}

// --- The payment layer, scripted ------------------------------------------------------------

type Script = {
  readonly verify?: "ok" | "invalid" | "malformed" | "unconfigured" | "error";
  readonly settle?: "ok" | "invalid" | "error";
  readonly payer?: string;
  readonly replayKey?: string;
  readonly hash?: string;
};

type Call = "verify" | "settle";

/**
 * Only the branch the route reads. `requirements` is the real helper's shape (the
 * same `accepted` schema, so the DTO the route hands around is a genuine one) with
 * none of its chain reads, and `verify`/`settle` return whichever outcome the test
 * named -- including the two the route must not treat as a payment (`unconfigured`,
 * `error`), which is the C1 contract this suite is on the receiving end of.
 */
function scriptedX402(script: Script, calls: Call[] = []): X402Near {
  return {
    configured: true,
    requirements: (input: RequirementsInput) =>
      paymentPayloadSchema.shape.accepted.parse({
        scheme: "exact",
        network: input.network,
        amount: input.priceAmount,
        asset: input.assetContract,
        payTo: input.payTo,
        maxTimeoutSeconds: input.maxTimeoutSeconds,
        extra: {},
      }),
    async verify() {
      calls.push("verify");
      const kind = script.verify ?? "ok";
      if (kind === "ok") {
        return {
          ok: true,
          authorization: {
            replayKey: script.replayKey ?? randomUUID(),
            payerAccountId: script.payer ?? PAYER,
            expiresAt: null,
          },
        };
      }
      return { ok: false, kind, reason: `scripted_${kind}` };
    },
    async settle() {
      calls.push("settle");
      const kind = script.settle ?? "ok";
      if (kind === "ok") {
        return {
          ok: true,
          nearTxHash: script.hash ?? `tx-${randomUUID().slice(0, 8)}`,
          payerAccountId: script.payer ?? PAYER,
        };
      }
      return {
        ok: false,
        kind: kind === "error" ? "error" : "invalid",
        reason: `scripted_${kind}`,
      };
    },
    // The route never asks; the boot sweep does, and it owns that query's tests.
    async settlementStatus() {
      return "unknown" as const;
    },
  };
}

// --- The payment layer, shipped --------------------------------------------------------------

let rpc: Server;
let rpcUrl = "";

beforeAll(async () => {
  rpc = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body) as { method: string };
      let result: unknown = {};
      if (call.method === "query") {
        result = {
          block_height: BLOCK_HEIGHT,
          block_hash: BLOCK_HASH,
          nonce: 7,
          permission_kind: "FullAccess",
        };
      } else if (call.method === "block") {
        result = {
          header: {
            height: BLOCK_HEIGHT,
            hash: BLOCK_HASH,
            prev_hash: BLOCK_HASH,
            timestamp: "2026-11-04T00:00:00.000000000Z",
            timestamp_nanosec: "0",
            epoch_id: BLOCK_HASH,
            next_epoch_id: BLOCK_HASH,
            approval_masks: [[], []],
            signature: "ed25519:11111111111111111111111111111111",
            rank: 0,
          },
          author_id: RELAYER,
          next_bps: null,
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as { port: number }).port}`;
});

afterAll(() => {
  rpc.close();
});

/** The chain as the verifier sees it: everything healthy, so only the payment decides. */
function fakeChain(payerBalance = 1_000_000n): NearViewSigner {
  return {
    getRelayerIds: () => [RELAYER],
    getCurrentBlockHeight: async () => BigInt(BLOCK_HEIGHT + 5),
    viewAccount: async ({ accountId }) =>
      accountId === TOKEN ? { codeHash: HAS_CONTRACT } : { codeHash: NO_CONTRACT },
    viewAccessKey: async () => ({ nonce: 7n, permissionKind: "FullAccess" }),
    ftBalanceOf: async () => payerBalance,
    storageBalanceOf: async () => ({ supported: false }),
    submitSignedDelegateAction: async () => ({
      transaction: `real-${randomUUID().slice(0, 8)}`,
      innerReceipt: { kind: "success", value: "" },
    }),
  };
}

function shippedX402(payerBalance?: bigint): X402Near {
  return createX402Near({
    network: "near:testnet",
    maxSponsoredGas: 30_000_000_000_000n,
    signer: fakeChain(payerBalance),
  });
}

/** What a payer's wallet does with the advertisement: sign for exactly what it says. */
async function mintPayment(requirements: {
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
}): Promise<{ body: unknown; delegate: string }> {
  const client = createLocalNearSigner({
    accountId: PAYER,
    secretKey: PAYER_KEY,
    rpcUrls: { "near:testnet": rpcUrl },
  });
  const accepted = {
    scheme: "exact",
    network: "near:testnet",
    asset: TOKEN,
    amount: requirements.amount,
    payTo: requirements.payTo,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    extra: {},
  };
  const signedDelegateAction = await client.createSignedDelegateAction({
    x402Version: 2,
    paymentRequirements: accepted as never,
  });
  return {
    delegate: signedDelegateAction,
    body: {
      x402Version: 2,
      resource: { url: "http://gateway.test/r/prices", mimeType: "application/json" },
      accepted,
      payload: { signedDelegateAction },
    },
  };
}

// --- Calling the route ----------------------------------------------------------------------

/** A body shaped like a real v2 payload; the script decides whether it verifies. */
function payloadFor(payTo: string, amount = PRICE, delegate = "A".repeat(86)): unknown {
  return {
    x402Version: 2,
    resource: { url: "http://gateway.test/r/prices", mimeType: "application/json" },
    accepted: {
      scheme: "exact",
      network: "near:testnet",
      amount,
      asset: TOKEN,
      payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { signedDelegateAction: delegate },
  };
}

function paymentHeaderValue(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

type Built = {
  readonly route: ReturnType<typeof createGatewayRoute>;
  readonly lines: Record<string, unknown>[];
  readonly env: Env;
};

/**
 * The route under test. `upstream` is the seam C4 needs and the one thing a test may
 * not fake: `getUpstream` itself is the shipped function, only pointed at the
 * address the SSRF policy would refuse to hand back. Passing `defaultUpstream: true`
 * leaves the seam out entirely and runs the policy.
 */
function buildRoute(input: {
  readonly x402: X402Near;
  readonly guards?: Parameters<typeof createGatewayRoute>[0]["guards"];
  readonly defaultUpstream?: boolean;
  /** C10's ordering test watches the writes; every other case uses the real handle. */
  readonly db?: Db;
}): Built {
  const recorded = recordingLogger();
  const env = envFor();
  const route = createGatewayRoute({
    env,
    log: recorded.logger,
    db: input.db ?? need().db,
    x402: input.x402,
    ...(input.guards === undefined ? {} : { guards: input.guards }),
    ...(input.defaultUpstream === true
      ? {}
      : {
          upstream: async (call) => {
            const url = new URL(call.url);
            const target: UpstreamTarget = {
              origin: url.origin,
              hostname: url.hostname,
              port: Number(url.port || "80"),
              protocol: "http:",
              address: "127.0.0.1",
              family: 4,
              pathname: url.pathname,
              search: url.search,
            };
            return getUpstream(target, {
              timeoutMs: env.UPSTREAM_TIMEOUT_MS,
              maxBytes: env.UPSTREAM_MAX_BYTES,
              headers: call.headers,
            });
          },
        }),
  });
  return { route, lines: recorded.lines, env };
}

type CallInput = {
  readonly x402: X402Near;
  readonly payment?: unknown;
  readonly legacy?: boolean;
  readonly guards?: Parameters<typeof createGatewayRoute>[0]["guards"];
  readonly defaultUpstream?: boolean;
  readonly headers?: Record<string, string>;
  /** Ask for a slug other than this fixture's, which is how a miss is tested. */
  readonly slug?: string;
  readonly db?: Db;
};

async function call(name: string, input: CallInput) {
  const built = buildRoute({
    x402: input.x402,
    ...(input.guards === undefined ? {} : { guards: input.guards }),
    ...(input.defaultUpstream === undefined ? {} : { defaultUpstream: input.defaultUpstream }),
    ...(input.db === undefined ? {} : { db: input.db }),
  });
  const target = fixture(name);
  const headers = new Headers(input.headers);
  if (input.payment !== undefined) {
    headers.set(
      input.legacy ? LEGACY_PAYMENT_SIGNATURE_HEADER : PAYMENT_SIGNATURE_HEADER,
      paymentHeaderValue(input.payment),
    );
  }
  const response = await built.route.request(`/r/${input.slug ?? target.slug}`, { headers });
  return { response, lines: built.lines, route: built.route };
}

// --- Assertions that read the database back -------------------------------------------------

type PaymentLite = {
  readonly id: string;
  readonly state: string;
  readonly amount: string;
  readonly payer: string;
  readonly nearTxHash: string | null;
  readonly upstreamStatus: number | null;
  readonly upstreamMs: number | null;
  readonly verifiedAt: string | null;
  readonly settledAt: string | null;
  readonly routeId: string | null;
  /** True when `verified_at` is a live timestamp within a minute of the database's `now()`. */
  readonly verifiedIsLive: boolean;
};

async function paymentByReplayKey(replayKey: string): Promise<PaymentLite | null> {
  const { sql } = need();
  const [row] = await sql<
    {
      id: string;
      state: string;
      amount: string;
      payer: string;
      near_tx_hash: string | null;
      upstream_status: number | null;
      upstream_ms: number | null;
      verified_at: string | null;
      settled_at: string | null;
      route_id: string | null;
      verified_is_live: boolean | null;
    }[]
  >`select id, state, amount::text as amount, payer_account_id as payer, near_tx_hash,
      upstream_status, upstream_ms, verified_at, settled_at, route_id,
      -- Same reading C3's suite uses (payments.test.ts): the row's stamp is seconds
      -- from the database's own now(). It proves the route stamped the row during
      -- this request; the clock source is openPayment's claim, not a new one here.
      (verified_at is not null and abs(extract(epoch from (now() - verified_at))) < 5)
        as verified_is_live
    from payments where replay_key = ${replayKey}`;
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    state: row.state,
    amount: row.amount,
    payer: row.payer,
    nearTxHash: row.near_tx_hash,
    upstreamStatus: row.upstream_status,
    upstreamMs: row.upstream_ms,
    verifiedAt: row.verified_at,
    settledAt: row.settled_at,
    routeId: row.route_id,
    verifiedIsLive: row.verified_is_live ?? false,
  };
}

/**
 * How many rows one authorization made. GW-4's promise is the number `1`, and a
 * retry that inserted a second row would still serve happily and still write one
 * ledger line, so this is the assertion that catches it.
 */
async function paymentCountByReplayKey(replayKey: string): Promise<number> {
  const { sql } = need();
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from payments where replay_key = ${replayKey}`;
  return Number(row?.n ?? "0");
}

/** The ledger lines a payment produced, by replay key -- the tests all have one. */
async function ledgerOf(replayKey: string): Promise<{ kind: string; amount: string }[]> {
  const payment = await paymentByReplayKey(replayKey);
  if (payment === null) {
    throw new Error(`no payment behind replay key ${replayKey}`);
  }
  const { sql } = need();
  return sql<{ kind: string; amount: string }[]>`
    select kind, amount::text as amount from ledger_entries where payment_id = ${payment.id}`;
}

async function countPayments(endpointId: string, state: string): Promise<number> {
  const { sql } = need();
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from payments where endpoint_id = ${endpointId} and state = ${state}`;
  return Number(row?.n ?? "0");
}

/**
 * A payment that is being served right now, for the payer the route will next
 * present an authorization for. Inserted directly because the only way to leave a
 * row in `verified` through the code is to stop mid-request, which a test should
 * not do to a real database.
 */
async function insertVerifiedPayment(input: {
  readonly endpointId: string;
  readonly payer?: string;
}): Promise<{ id: string; replayKey: string }> {
  const { sql } = need();
  const row = { id: randomUUID(), replayKey: `c8-verified-${randomUUID()}` };
  await sql`insert into payments (id, endpoint_id, payer_account_id, amount, asset_contract,
      replay_key, state, verified_at)
    values (${row.id}, ${input.endpointId}, ${input.payer ?? PAYER}, ${PRICE}, ${TOKEN},
      ${row.replayKey}, 'verified', now())`;
  return row;
}

/** Decode the 402 the way the shipped client does: base64 header, then JSON. */
function decodeChallenge(response: Response): {
  error: string;
  x402Version: number;
  resource: { url: string };
  accepts: {
    amount: string;
    asset: string;
    network: string;
    payTo: string;
    maxTimeoutSeconds: number;
  }[];
} {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (header === null) {
    throw new Error("no PAYMENT-REQUIRED header on the challenge");
  }
  expect(header).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

function decodeReceipt(response: Response): {
  success: boolean;
  transaction: string;
  network: string;
} {
  const header = response.headers.get(PAYMENT_RESPONSE_HEADER);
  if (header === null) {
    throw new Error("no PAYMENT-RESPONSE header on the receipt");
  }
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

const suite = describe.skipIf(handle === null);

suite("the gateway paid request (C4, GW-2)", () => {
  beforeAll(async () => {
    await insertFixture({ name: "direct", payoutMode: "direct" });
    await insertFixture({ name: "intents", payoutMode: "intents", depositAddress: "standing" });
    await insertFixture({ name: "unresolved", payoutMode: "intents", depositAddress: null });
    await insertFixture({ name: "cheap", payoutMode: "direct", priceAmount: "9999" });
    await insertFixture({ name: "wrongnet", payoutMode: "direct", network: "near:mainnet" });
    await insertFixture({ name: "paused", payoutMode: "direct", active: false });
    await insertFixture({ name: "badmode", payoutMode: "direct", rawPayoutMode: "auto" });
    // One endpoint per upstream behaviour, so a test that needs the seller to fail
    // does not have to move `direct` out from under the tests that run after it.
    await insertFixture({ name: "missing", payoutMode: "direct", path: "notFound" });
    await insertFixture({ name: "unavailable", payoutMode: "direct", path: "unavailable" });
    await insertFixture({ name: "deadsocket", payoutMode: "direct", path: "dropped" });
    await insertFixture({ name: "hold", payoutMode: "direct", path: "hold" });
    await insertFixture({ name: "moved", payoutMode: "direct", path: "moved" });
    await insertFixture({ name: "slow", payoutMode: "direct", path: "slow" });
    await insertFixture({ name: "flaky", payoutMode: "direct", path: "flaky" });
  });

  it("answers an unpaid request with the 402 a v2 payer can act on, and costs nothing", async () => {
    const target = fixture("direct");
    const calls: Call[] = [];
    const { response } = await call("direct", { x402: scriptedX402({}, calls) });

    expect(response.status).toBe(402);
    const challenge = decodeChallenge(response);
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts).toHaveLength(1);
    expect(challenge.accepts[0]).toMatchObject({
      amount: PRICE,
      asset: TOKEN,
      network: "near:testnet",
      payTo: target.sellerAccount,
    });
    expect(challenge.resource.url).toBe(`http://gateway.test/r/${target.slug}`);
    // The body is the same object, so a client with no wallet reads the same price.
    expect(await response.json()).toEqual(challenge);

    // The free half of the endpoint: no verify, no settle, no upstream, no row.
    expect(calls).toEqual([]);
    expect(await countPayments(target.endpointId, "verified")).toBe(0);
    expect(await countPayments(target.endpointId, "settled")).toBe(0);
  });

  it("serves the upstream body, settles, and stores the settlement hash (the Done-when, offline)", async () => {
    const target = fixture("direct");
    const replayKey = randomUUID();
    const hash = "near-tx-gateway-001";
    const calls: Call[] = [];
    const { response, lines } = await call("direct", {
      x402: scriptedX402({ settle: "ok", hash, replayKey }, calls),
      payment: payloadFor(target.sellerAccount),
      headers: { "x-buyer-note": "prices please", "user-agent": "till-agent/1" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ price: 4213, unit: "eur" });
    expect(calls).toEqual(["verify", "settle"]);

    // The receipt, in the shape the shipped client's `settleResponse` demands.
    const receipt = decodeReceipt(response);
    expect([receipt.success, receipt.transaction, receipt.network]).toEqual([
      true,
      hash,
      "near:testnet",
    ]);

    // What the seller sent arrives; the two things that must not, do not.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-402-version")).toBeNull();

    const payment = await paymentByReplayKey(replayKey);
    expect(payment?.state).toBe("settled");
    expect(payment?.nearTxHash).toBe(hash);
    expect(payment?.amount).toBe(PRICE);
    expect(payment?.payer).toBe(PAYER);
    expect(payment?.routeId).toBe(target.routeId);
    expect(payment?.upstreamStatus).toBe(200);
    expect(typeof payment?.upstreamMs).toBe("number");
    expect(payment?.verifiedIsLive).toBe(true);
    expect(payment?.settledAt).not.toBeNull();
    expect(await ledgerOf(replayKey)).toEqual([{ kind: "payment_in", amount: PRICE }]);
    expect(lines.filter((line) => line.code === "served")).toHaveLength(1);
  });

  it("takes the pay-to from the route when the endpoint pays out through Intents", async () => {
    const target = fixture("intents");
    const { response } = await call("intents", { x402: scriptedX402({}, []) });
    expect(response.status).toBe(402);
    expect(decodeChallenge(response).accepts[0]?.payTo).toBe(target.depositAddress);
  });

  it("refuses to advertise a row it could not settle, and names the rule that fired", async () => {
    const cases = [
      ["unresolved", "pay_to_unresolved"],
      ["cheap", "price_below_floor"],
      ["wrongnet", "network_mismatch"],
    ] as const;
    for (const [name, code] of cases) {
      const target = fixture(name);
      const calls: Call[] = [];
      const { response, lines } = await call(name, {
        x402: scriptedX402({}, calls),
        payment: payloadFor("someone.testnet"),
      });
      expect([name, response.status]).toEqual([name, 503]);
      expect(await response.json()).toMatchObject({ error: code });
      // Not a challenge: asking a stranger to pay for a row Till has just
      // established it cannot honour is how S1's bad advertisement gets paid for.
      expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
      expect(calls).toEqual([]);
      expect(lines.some((line) => line.code === code)).toBe(true);
      expect(await countPayments(target.endpointId, "verified")).toBe(0);
    }
  });

  it("404s an unknown slug and a paused endpoint alike, and 503s a payout mode it cannot read", async () => {
    // A slug nobody owns: the lookup fails, and nothing else runs.
    const unknown = await call("direct", {
      x402: scriptedX402({}, []),
      slug: "c4-no-such-endpoint",
    });
    const paused = await call("paused", { x402: scriptedX402({}, []) });
    expect([unknown.response.status, paused.response.status]).toEqual([404, 404]);
    expect(await unknown.response.json()).toMatchObject({ error: "endpoint_not_found" });
    expect(await paused.response.json()).toMatchObject({ error: "endpoint_not_found" });
    // A paused row is not a broken row, so neither gets an advertisement either.
    expect(paused.response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();

    const badmode = await call("badmode", { x402: scriptedX402({}, []) });
    expect(badmode.response.status).toBe(503);
    expect(await badmode.response.json()).toMatchObject({ error: "endpoint_misconfigured" });
    // `direct` would have been the guess, and a guess here is money to the wrong
    // account, so the answer is a refusal and no advertisement at all.
    expect(badmode.response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
  });

  it("re-challenges a payment the scheme refused, at the price it already named", async () => {
    for (const kind of ["invalid", "malformed"] as const) {
      const target = fixture("direct");
      const calls: Call[] = [];
      const { response } = await call("direct", {
        x402: scriptedX402({ verify: kind }, calls),
        payment: payloadFor(target.sellerAccount),
      });
      expect([kind, response.status]).toEqual([kind, 402]);
      expect(calls).toEqual(["verify"]);
      const challenge = decodeChallenge(response);
      expect(challenge.error).toBe(`scripted_${kind}`);
      expect(challenge.accepts[0]?.amount).toBe(PRICE);
      expect(challenge.accepts[0]?.payTo).toBe(target.sellerAccount);
      expect(await countPayments(target.endpointId, "verified")).toBe(0);
    }
  });

  it("answers 503 when the verifier could not run, and does not ask for a new signature", async () => {
    for (const kind of ["unconfigured", "error"] as const) {
      const target = fixture("direct");
      const calls: Call[] = [];
      const { response } = await call("direct", {
        x402: scriptedX402({ verify: kind }, calls),
        payment: payloadFor(target.sellerAccount),
      });
      expect([kind, response.status]).toEqual([kind, 503]);
      // A challenge here would be a re-challenge for a problem in our own process.
      expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
      expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
      expect(calls).toEqual(["verify"]);
    }
  });

  it("402s a payment header that is not readable, before the verifier is consulted", async () => {
    const target = fixture("direct");
    const calls: Call[] = [];
    const built = buildRoute({ x402: scriptedX402({}, calls) });
    const response = await built.route.request(`/r/${target.slug}`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: "this is not base64 json" },
    });
    expect(response.status).toBe(402);
    expect(decodeChallenge(response).error).toBe("payment_header_undecodable");
    expect(calls).toEqual([]);
  });

  it("answers a replayed authorization with 409 and its stored receipt, and never serves twice", async () => {
    const replayKey = randomUUID();
    const hash = "near-tx-replay-001";
    const first = await call("direct", {
      x402: scriptedX402({ settle: "ok", hash, replayKey }, []),
      payment: payloadFor(fixture("direct").sellerAccount),
    });
    expect(first.response.status).toBe(200);

    const calls: Call[] = [];
    const second = await call("direct", {
      x402: scriptedX402({ settle: "ok", hash: "a-second-hash", replayKey }, calls),
      payment: payloadFor(fixture("direct").sellerAccount),
    });
    expect(second.response.status).toBe(409);
    // 4.4's answer: the buyer lost the response, not the money, so the receipt is on
    // the refusal and the hash is the one already stored.
    const receipt = decodeReceipt(second.response);
    expect([receipt.success, receipt.transaction]).toEqual([true, hash]);
    expect(await second.response.json()).toMatchObject({ error: "payment_replay" });
    expect(calls).toEqual(["verify"]);
    expect(await paymentByReplayKey(replayKey)).toMatchObject({
      state: "settled",
      nearTxHash: hash,
    });
    // One `payment_in` for one authorization, after two requests (GW-4).
    expect(await ledgerOf(replayKey)).toHaveLength(1);
  });

  it("409s a replayed authorization whose payment never settled, and hands out no receipt", async () => {
    const replayKey = randomUUID();
    // Its own payer: C9 counts served_unsettled rows, and a payer shared with
    // another test would carry strikes into whichever ran second.
    const payer = "unsettled-replay.testnet";
    const first = await call("direct", {
      x402: scriptedX402({ settle: "invalid", replayKey, payer }, []),
      payment: payloadFor(fixture("direct").sellerAccount),
    });
    expect(first.response.status).toBe(200);
    expect(await paymentByReplayKey(replayKey)).toMatchObject({ state: "served_unsettled" });

    const second = await call("direct", {
      x402: scriptedX402({ settle: "ok", hash: "near-tx-arrived-later", replayKey, payer }, []),
      payment: payloadFor(fixture("direct").sellerAccount),
    });
    expect(second.response.status).toBe(409);
    // A receipt is a claim that money moved. `served_unsettled` says it did not, so
    // the refusal names the state and carries no `PAYMENT-RESPONSE` header.
    expect(second.response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    expect(await second.response.json()).toMatchObject({
      detail: expect.stringContaining("served_unsettled"),
    });
    // And the refused retry settled nothing of its own.
    expect(await ledgerOf(replayKey)).toEqual([]);
  });

  it("refuses the same authorization on a second endpoint, because one payment is one payment", async () => {
    const replayKey = randomUUID();
    const served = await call("direct", {
      x402: scriptedX402({ settle: "ok", hash: "near-tx-cross-001", replayKey }, []),
      payment: payloadFor(fixture("direct").sellerAccount),
    });
    expect(served.response.status).toBe(200);

    const calls: Call[] = [];
    const reused = await call("intents", {
      x402: scriptedX402({ settle: "ok", replayKey }, calls),
      payment: payloadFor(fixture("intents").sellerAccount),
    });
    expect(reused.response.status).toBe(409);
    // A delegate is bound to payer, relayer, nonce and `ft_transfer` and to nothing
    // per-endpoint, so the second endpoint's upstream is never dialed and its row
    // count never rises.
    expect(calls).toEqual(["verify"]);
    expect(await countPayments(fixture("intents").endpointId, "settled")).toBe(0);
  });

  it("retries an abandoned payment with the same authorization, serves it and charges once (C7, GW-4)", async () => {
    const target = fixture("flaky");
    const replayKey = randomUUID();
    flakyFails = true;
    let firstRowId = "";
    try {
      const firstCalls: Call[] = [];
      const first = await call("flaky", {
        x402: scriptedX402({ settle: "ok", hash: "near-tx-never-minted", replayKey }, firstCalls),
        payment: payloadFor(target.sellerAccount),
      });
      expect(first.response.status).toBe(502);
      const abandoned = await paymentByReplayKey(replayKey);
      expect(abandoned?.state).toBe("abandoned");
      expect(abandoned?.upstreamStatus).toBe(503);
      expect(abandoned?.nearTxHash).toBeNull();
      expect(firstCalls).toEqual(["verify"]);
      expect(await ledgerOf(replayKey)).toEqual([]);
      firstRowId = abandoned?.id ?? "";

      // The retry. Same signature, same replay key, and the seller is awake now.
      flakyFails = false;
      const secondCalls: Call[] = [];
      const second = await call("flaky", {
        x402: scriptedX402({ settle: "ok", hash: "near-tx-second-half", replayKey }, secondCalls),
        payment: payloadFor(target.sellerAccount),
      });
      expect(second.response.status).toBe(200);
      expect(await second.response.json()).toMatchObject({ price: 4213 });
      const retried = await paymentByReplayKey(replayKey);
      // One authorization, one row: the retry moved the abandoned row back rather
      // than inserting a second one, so the id the *first* attempt wrote is the id
      // that is now settled. A second row would settle too and still write one
      // ledger line, which is why this is an id and not a count.
      expect(retried?.id).toBe(firstRowId);
      expect(await paymentCountByReplayKey(replayKey)).toBe(1);
      expect(retried).toMatchObject({
        state: "settled",
        nearTxHash: "near-tx-second-half",
        // Attempt one's 503 is gone: the row describes the attempt being served.
        upstreamStatus: 200,
      });
      expect(retried?.settledAt).not.toBeNull();
      // The retry re-stamped `verified_at` from the database clock, so Guard 3's
      // window and C10's sweep both measure this attempt, not the failed one.
      expect(retried?.verifiedIsLive).toBe(true);
      // Money moved once, and only after the second attempt's own 2xx.
      expect(secondCalls).toEqual(["verify", "settle"]);
      expect(await ledgerOf(replayKey)).toEqual([{ kind: "payment_in", amount: PRICE }]);
      expect(decodeReceipt(second.response).transaction).toBe("near-tx-second-half");
      expect(second.lines.some((line) => line.code === "payment_retried")).toBe(true);
    } finally {
      flakyFails = false;
    }
  });

  it("will not reopen an abandoned row for a payment the scheme refuses (C7, GW-4)", async () => {
    // Hard rule 2's order is what makes the retry safe, so it is asserted rather than
    // assumed: verify runs at step 4 and the row is touched at step 6. A second
    // attempt the scheme refuses therefore leaves the abandoned row exactly as the
    // first attempt left it, dials nobody and settles nothing.
    const target = fixture("flaky");
    const replayKey = randomUUID();
    flakyFails = true;
    try {
      const first = await call("flaky", {
        x402: scriptedX402({ settle: "ok", replayKey }, []),
        payment: payloadFor(target.sellerAccount),
      });
      expect(first.response.status).toBe(502);
      const before = await paymentByReplayKey(replayKey);

      const calls: Call[] = [];
      const second = await call("flaky", {
        x402: scriptedX402({ verify: "invalid", replayKey }, calls),
        payment: payloadFor(target.sellerAccount),
      });
      expect(second.response.status).toBe(402);
      expect(calls).toEqual(["verify"]);
      const after = await paymentByReplayKey(replayKey);
      expect(after?.id).toBe(before?.id);
      expect(after?.state).toBe("abandoned");
      expect(after?.upstreamStatus).toBe(503);
      expect(await ledgerOf(replayKey)).toEqual([]);
    } finally {
      flakyFails = false;
    }
  });

  it("refuses to reopen an abandoned row that carries a settlement hash (C7, GW-4)", async () => {
    // The double-spend half of GW-4, and the state no route branch can write today
    // because no abandonment path calls `settle`. C10's sweep is the writer that can:
    // it abandons stale rows *after* reading the chain, and a row whose money moved
    // while the process was dead is precisely the one a retry must never serve. So
    // the guard is a predicate in the update, and it is tested by making the state by
    // hand rather than by arguing it cannot happen.
    const target = fixture("flaky");
    const replayKey = randomUUID();
    const hash = "near-tx-landed-while-we-were-dead";
    flakyFails = true;
    try {
      const first = await call("flaky", {
        x402: scriptedX402({ settle: "ok", replayKey }, []),
        payment: payloadFor(target.sellerAccount),
      });
      expect(first.response.status).toBe(502);
      const { sql } = need();
      const row = await paymentByReplayKey(replayKey);
      if (row === null) {
        throw new Error("no abandoned row to put a settlement hash on");
      }
      await sql`update payments set near_tx_hash = ${hash} where id = ${row.id}`;

      flakyFails = false;
      const calls: Call[] = [];
      const second = await call("flaky", {
        x402: scriptedX402({ settle: "ok", hash: "near-tx-second-half", replayKey }, calls),
        payment: payloadFor(target.sellerAccount),
      });
      expect(second.response.status).toBe(409);
      expect(await second.response.json()).toMatchObject({ error: "payment_replay" });
      // No receipt either: `settled` is the state that earns one, and this row is not
      // settled -- it is money that moved without a receipt we can stand behind, which
      // is E2's discrepancy and C10's problem, not a second free call for the payer.
      expect(second.response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
      expect(calls).toEqual(["verify"]);
      const after = await paymentByReplayKey(replayKey);
      expect(after?.state).toBe("abandoned");
      expect(after?.nearTxHash).toBe(hash);
      expect(after?.settledAt).toBeNull();
      expect(await paymentCountByReplayKey(replayKey)).toBe(1);
      expect(await ledgerOf(replayKey)).toEqual([]);
    } finally {
      flakyFails = false;
    }
  });

  it("passes a 4xx through and abandons the payment without charging", async () => {
    const target = fixture("missing");
    const calls: Call[] = [];
    const replayKey = randomUUID();
    const { response, lines } = await call("missing", {
      x402: scriptedX402({ settle: "ok", replayKey }, calls),
      payment: payloadFor(target.sellerAccount),
    });
    expect(response.status).toBe(404);
    // The seller's own answer, because it is about the record they do not have, not
    // about Till. A 4xx still buys nothing though: see the row and the ledger below.
    expect(await response.json()).toMatchObject({ error: "no such record" });
    expect(calls).toEqual(["verify"]);
    const payment = await paymentByReplayKey(replayKey);
    expect(payment?.state).toBe("abandoned");
    expect(payment?.upstreamStatus).toBe(404);
    expect(payment?.nearTxHash).toBeNull();
    expect(payment?.settledAt).toBeNull();
    expect(await ledgerOf(replayKey)).toEqual([]);
    expect(lines.some((line) => line.outcome === "not_charged")).toBe(true);
  });

  it("answers 502 for a 5xx and for a dead socket, and settles neither", async () => {
    for (const name of ["unavailable", "deadsocket"] as const) {
      const target = fixture(name);
      const calls: Call[] = [];
      const replayKey = randomUUID();
      const { response } = await call(name, {
        x402: scriptedX402({ settle: "ok", replayKey }, calls),
        payment: payloadFor(target.sellerAccount),
      });
      // §2 step 8: a 5xx or a timeout is 502, not the seller's page.
      expect([name, response.status]).toEqual([name, 502]);
      expect(await response.json()).toMatchObject({ error: "upstream_failed" });
      expect(calls).toEqual(["verify"]);
      const payment = await paymentByReplayKey(replayKey);
      expect(payment?.state).toBe("abandoned");
      expect(payment?.nearTxHash).toBeNull();
      expect(await ledgerOf(replayKey)).toEqual([]);
    }
  });

  it("passes a seller's 3xx through with an absolute Location and charges nothing (C6)", async () => {
    const target = fixture("moved");
    const calls: Call[] = [];
    const replayKey = randomUUID();
    const { response } = await call("moved", {
      x402: scriptedX402({ settle: "ok", replayKey }, calls),
      payment: payloadFor(target.sellerAccount),
    });

    // The decision C4 left to C6: a 3xx is the seller's answer about the resource,
    // not a failure of theirs, so the buyer gets the seller's status. The body is
    // theirs too, and tiny -- a redirect's whole content is the `Location`.
    expect(response.status).toBe(302);
    // Relative on the wire, absolute on the way out. Forwarded verbatim, the buyer
    // would resolve `/data?moved=1` against the *gateway* origin and get a `404` from
    // Till (RFC 9110 7.3.2 tells a proxy not to do that); rewritten against the
    // endpoint's own upstream it is the target the seller chose. Till never follows
    // it, so this is the buyer's browser dialling the seller, not our proxy.
    expect(response.headers.get("location")).toBe(
      `http://127.0.0.1:${upstreamPort}${UPSTREAM.data}?moved=1`,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toBe("moved");
    // Nothing was delivered, so nothing moved: no settle, no ledger line, and the
    // row says `abandoned` with the seller's status on it.
    expect(calls).toEqual(["verify"]);
    const payment = await paymentByReplayKey(replayKey);
    expect(payment?.state).toBe("abandoned");
    expect(payment?.upstreamStatus).toBe(302);
    expect(payment?.nearTxHash).toBeNull();
    expect(payment?.settledAt).toBeNull();
    expect(await ledgerOf(replayKey)).toEqual([]);
  });

  it("settles on a 2xx and on nothing else, across all six shapes a seller can answer (C6, GW-3)", async () => {
    // The requirement as one table rather than as five tests that each check the
    // half they care about: what the payer sees, what the row says, whether the
    // settlement was called at all, and whether the ledger has a line. A redirect and
    // a timeout belong in the same column as a 5xx, which is the whole rule.
    const cases = [
      { name: "direct", status: 200, state: "settled", charged: true },
      { name: "moved", status: 302, state: "abandoned", charged: false },
      { name: "missing", status: 404, state: "abandoned", charged: false },
      { name: "unavailable", status: 502, state: "abandoned", charged: false },
      { name: "deadsocket", status: 502, state: "abandoned", charged: false },
      { name: "slow", status: 502, state: "abandoned", charged: false },
    ] as const;

    for (const shape of cases) {
      const target = fixture(shape.name);
      const calls: Call[] = [];
      const replayKey = randomUUID();
      const { response } = await call(shape.name, {
        x402: scriptedX402({ settle: "ok", replayKey }, calls),
        payment: payloadFor(target.sellerAccount),
      });
      const payment = await paymentByReplayKey(replayKey);
      const ledger = await ledgerOf(replayKey);
      // One tuple per row, so a shape that serves without booking (or the reverse)
      // cannot pass by asserting its own half only.
      expect([
        shape.name,
        response.status,
        payment?.state,
        payment?.settledAt !== null,
        calls,
        ledger.map((entry) => entry.kind),
      ]).toEqual([
        shape.name,
        shape.status,
        shape.state,
        shape.charged,
        shape.charged ? ["verify", "settle"] : ["verify"],
        shape.charged ? ["payment_in"] : [],
      ]);
    }
  });

  it("serves anyway when settlement fails after a 2xx, and marks the payment served_unsettled", async () => {
    const target = fixture("direct");
    const calls: Call[] = [];
    const replayKey = randomUUID();
    const { response, lines } = await call("direct", {
      // C9 counts this state, so this test owns its payer rather than inheriting
      // the suite's default one.
      x402: scriptedX402({ settle: "invalid", replayKey, payer: "unsettled-serve.testnet" }, calls),
      payment: payloadFor(target.sellerAccount),
    });
    // The payer paid for an answer that exists. Withholding it would move the
    // seller's loss onto the buyer, so the response goes out and the row says so.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ price: 4213 });
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    expect(calls).toEqual(["verify", "settle"]);
    const payment = await paymentByReplayKey(replayKey);
    expect(payment?.state).toBe("served_unsettled");
    expect(payment?.settledAt).toBeNull();
    expect(payment?.nearTxHash).toBeNull();
    expect(await ledgerOf(replayKey)).toEqual([]);
    expect(lines.some((line) => line.code === "SERVED_NOT_SETTLED")).toBe(true);
  });

  it("blocks a payer after two unsettled serves, and a seller clear restores access (C9, GW-7)", async () => {
    const target = fixture("direct");
    const payer = `c9-e2e-${randomUUID().slice(0, 8)}.testnet`;

    // Two answers went out and the money did not. Each is a strike, and the second
    // is the threshold -- measured here through the route, not just the query.
    for (const replayKey of [randomUUID(), randomUUID()]) {
      const served = await call("direct", {
        x402: scriptedX402({ settle: "invalid", replayKey, payer }, []),
        payment: payloadFor(target.sellerAccount),
      });
      expect(served.response.status).toBe(200);
      expect((await paymentByReplayKey(replayKey))?.state).toBe("served_unsettled");
    }

    // The third attempt verifies and is then refused: `verify` ran, so the payer is
    // one we could name, and nothing downstream of the guard ran at all.
    const blockedKey = randomUUID();
    const blockedCalls: Call[] = [];
    const hits = sellerHits.length;
    const blocked = await call("direct", {
      x402: scriptedX402({ settle: "ok", replayKey: blockedKey, payer }, blockedCalls),
      payment: payloadFor(target.sellerAccount),
    });
    expect(blocked.response.status).toBe(403);
    expect((await blocked.response.json()) as unknown).toMatchObject({ error: "payer_blocked" });
    // The exit is a seller's clear, so there is no date to promise.
    expect(blocked.response.headers.get("retry-after")).toBeNull();
    expect(blockedCalls).toEqual(["verify"]);
    expect(await paymentByReplayKey(blockedKey)).toBeNull();
    expect(sellerHits).toHaveLength(hits);

    await clearPayerBlock(need().db, {
      payerAccountId: payer,
      sellerId: target.sellerId,
      clearedBy: "c9-operator.testnet",
      note: "seller accepted the explanation for the failed settles",
    });

    // The same payer, the same seller, and now a paid answer: the clear lifted the
    // block without rewriting either strike.
    const afterKey = randomUUID();
    const afterCalls: Call[] = [];
    const after = await call("direct", {
      x402: scriptedX402({ settle: "ok", replayKey: afterKey, payer }, afterCalls),
      payment: payloadFor(target.sellerAccount),
    });
    expect(after.response.status).toBe(200);
    expect(afterCalls).toEqual(["verify", "settle"]);
    expect((await paymentByReplayKey(afterKey))?.state).toBe("settled");
    expect(after.response.headers.get(PAYMENT_RESPONSE_HEADER)).not.toBeNull();
  });

  it("inserts the verified row before the upstream is dialed, and it is still verified during", async () => {
    const target = fixture("direct");
    const replayKey = randomUUID();
    const states: (string | null)[] = [];
    const built = buildRoute({ x402: scriptedX402({ settle: "ok", replayKey }, []) });
    const routeWithProbe = createGatewayRoute({
      env: built.env,
      log: recordingLogger().logger,
      db: need().db,
      x402: scriptedX402({ settle: "ok", replayKey }, []),
      upstream: async (input) => {
        // Read the table from inside the call: the row exists already and still says
        // `verified`, because settle has not run. This is hard rule 2 in one probe.
        const during = await paymentByReplayKey(replayKey);
        states.push(during?.state ?? null);
        const url = new URL(input.url);
        return getUpstream(
          {
            origin: url.origin,
            hostname: url.hostname,
            port: Number(url.port),
            protocol: "http:",
            address: "127.0.0.1",
            family: 4,
            pathname: url.pathname,
            search: url.search,
          },
          {
            timeoutMs: built.env.UPSTREAM_TIMEOUT_MS,
            maxBytes: built.env.UPSTREAM_MAX_BYTES,
            headers: input.headers,
          },
        );
      },
    });
    const response = await routeWithProbe.request(`/r/${target.slug}`, {
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: paymentHeaderValue(payloadFor(target.sellerAccount)),
      },
    });
    expect(states).toEqual(["verified"]);
    expect(response.status).toBe(200);
    // And after, the same row says settled: the probe and the settle are one row.
    expect(await paymentByReplayKey(replayKey)).toMatchObject({ state: "settled" });
    // Two requests with one authorization cannot both insert: the second call in this
    // test reused the key, so the table holds one row for it.
    const { sql } = need();
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from payments where replay_key = ${replayKey}`;
    expect(count?.n).toBe("1");
  });

  it("runs the guards before the upstream, and carries 429 with Retry-After out", async () => {
    const target = fixture("direct");
    const dialed: string[] = [];
    const calls: Call[] = [];
    const built = buildRoute({ x402: scriptedX402({}, []) });
    const route = createGatewayRoute({
      env: built.env,
      log: recordingLogger().logger,
      db: need().db,
      x402: scriptedX402({ verify: "ok" }, calls),
      guards: async () => ({ status: 429, reason: "one_in_flight", retryAfterSeconds: 20 }),
      upstream: async (input) => {
        dialed.push(input.url);
        return getUpstream(
          {
            origin: "http://127.0.0.1",
            hostname: "127.0.0.1",
            port: upstreamPort,
            protocol: "http:",
            address: "127.0.0.1",
            family: 4,
            pathname: UPSTREAM.data,
            search: "",
          },
          { timeoutMs: 2000, maxBytes: 1_048_576, headers: input.headers },
        );
      },
    });
    const response = await route.request(`/r/${target.slug}`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentHeaderValue(payloadFor(target.sellerAccount)) },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("20");
    expect(await response.json()).toMatchObject({ error: "one_in_flight", retryAfterSeconds: 20 });
    expect(dialed).toEqual([]);
    // Guarded after verify, so the guard sees a payment; before the row, so nothing
    // is left in `verified` for the sweep (C10) to wonder about.
    expect(calls).toEqual(["verify"]);
    expect(await countPayments(target.endpointId, "verified")).toBe(0);
  });

  it("hands the guard the payer and price we derived, never the ones the request claimed", async () => {
    const target = fixture("direct");
    const seen: { payer: string; amount: string; endpointId: string }[] = [];
    const built = buildRoute({ x402: scriptedX402({}, []) });
    const route = createGatewayRoute({
      env: built.env,
      log: recordingLogger().logger,
      db: need().db,
      x402: scriptedX402({ verify: "ok", payer: "who-the-signature-binds.testnet" }, []),
      guards: async (context) => {
        seen.push({
          payer: context.payerAccountId,
          amount: context.priceAmount.toString(),
          endpointId: context.endpointId,
        });
        return null;
      },
      upstream: async (input) => {
        const url = new URL(input.url);
        return getUpstream(
          {
            origin: url.origin,
            hostname: url.hostname,
            port: Number(url.port),
            protocol: "http:",
            address: "127.0.0.1",
            family: 4,
            pathname: url.pathname,
            search: url.search,
          },
          { timeoutMs: 2000, maxBytes: 1_048_576, headers: input.headers },
        );
      },
    });
    const response = await route.request(`/r/${target.slug}`, {
      headers: {
        // A body claiming one yocto and somebody else's pay-to.
        [PAYMENT_SIGNATURE_HEADER]: paymentHeaderValue(payloadFor("attacker.testnet", "1")),
      },
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      payer: "who-the-signature-binds.testnet",
      amount: PRICE,
      endpointId: target.endpointId,
    });
  });

  it("accepts the v1 header name as well as v2's", async () => {
    const target = fixture("direct");
    const calls: Call[] = [];
    const { response } = await call("direct", {
      x402: scriptedX402({ settle: "ok", hash: "near-tx-legacy-001" }, calls),
      payment: payloadFor(target.sellerAccount),
      legacy: true,
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["verify", "settle"]);
  });

  it("serves through the shipped verifier over a genuine signed delegate", async () => {
    const target = fixture("direct");
    // The wallet's view: ask, read the advertisement, sign for exactly what it says.
    const unpaid = await call("direct", { x402: shippedX402() });
    expect(unpaid.response.status).toBe(402);
    const advertised = decodeChallenge(unpaid.response).accepts[0];
    if (advertised === undefined) {
      throw new Error("the advertisement carried no price");
    }

    const minted = await mintPayment(advertised);
    const replayKey = replayKeyOf(minted.delegate);
    const paid = await call("direct", { x402: shippedX402(), payment: minted.body });

    expect(paid.response.status).toBe(200);
    expect(await paid.response.json()).toMatchObject({ price: 4213 });
    const receipt = decodeReceipt(paid.response);
    expect([receipt.success, receipt.transaction.startsWith("real-")]).toEqual([true, true]);

    const payment = await paymentByReplayKey(replayKey);
    expect(payment?.state).toBe("settled");
    expect(payment?.payer).toBe(PAYER);
    expect(payment?.amount).toBe(PRICE);
    expect(payment?.nearTxHash).toBe(receipt.transaction);
    expect(await ledgerOf(replayKey)).toEqual([{ kind: "payment_in", amount: PRICE }]);
  });

  it("402s a genuine delegate signed for the wrong price, and the seller is never called", async () => {
    const target = fixture("direct");
    const unpaid = await call("direct", { x402: shippedX402() });
    const advertised = decodeChallenge(unpaid.response).accepts[0];
    if (advertised === undefined) {
      throw new Error("the advertisement carried no price");
    }
    // Correctly signed, wrongly priced: half what was advertised.
    const minted = await mintPayment({ ...advertised, amount: "5000" });
    const calls: Call[] = [];
    const paid = await call("direct", {
      x402: shippedX402(),
      payment: minted.body,
      guards: async () => {
        calls.push("settle");
        return null;
      },
    });
    expect(paid.response.status).toBe(402);
    const challenge = decodeChallenge(paid.response);
    expect(challenge.error).toContain("amount_mismatch");
    // The advertised price is unchanged by the attempt.
    expect(challenge.accepts[0]?.amount).toBe(PRICE);
    expect(calls).toEqual([]);
    expect(await countPayments(target.endpointId, "verified")).toBe(0);
  });

  it("mounts under createApp, outside /api, with the request id the app stamped", async () => {
    const target = fixture("direct");
    const recorded = recordingLogger();
    const app = createApp({
      env: envFor(),
      log: recorded.logger,
      db: need().db,
      x402: scriptedX402({}, []),
    });
    const unpaid = await app.request(`/r/${target.slug}`);
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get(PAYMENT_REQUIRED_HEADER)).not.toBeNull();

    const access = recorded.lines.find((line) => line.path === `/r/${target.slug}`);
    expect(typeof access?.requestId).toBe("string");
    const gateway = recorded.lines.find((line) => line.code === "payment_required");
    // The gateway logs with the id the app's middleware set, which is the only
    // reason a payer's 402 can be found in the log by the line the access log has.
    expect(gateway?.requestId).toBe(access?.requestId);
    expect(gateway?.slug).toBe(target.slug);
  });

  it("429s a paid request from a payer already being served, and never dials the seller", async () => {
    const target = fixture("direct");
    const blocker = await insertVerifiedPayment({ endpointId: target.endpointId });
    const hits = sellerHits.length;
    const openRows = await countPayments(target.endpointId, "verified");
    const calls: Call[] = [];
    const { response } = await call("direct", {
      x402: scriptedX402({ settle: "ok", replayKey: randomUUID() }, calls),
      payment: payloadFor(target.sellerAccount),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(inFlightWindowSeconds(2000, 30_000)));
    expect((await response.json()) as unknown).toMatchObject({ error: "payer_in_flight" });
    // The order is the guard: verify passed, so the payer holds a valid
    // authorization, and the answer is still "not yet" before any byte of the
    // seller's response is bought (GW-6, and S6's reason it cannot be trusted
    // downstream -- the chain would only refuse this payment *after* it was served).
    expect(calls).toEqual(["verify"]);
    expect(sellerHits).toHaveLength(hits);
    // One row: the payer's live payment. The refused authorization booked nothing.
    // Read as a delta, because the scratch database outlives a run and an absolute
    // count would be a claim about the machine rather than about this request.
    expect(await countPayments(target.endpointId, "verified")).toBe(openRows);

    await need().sql`delete from payments where id = ${blocker.id}`;
  });

  it("lets exactly one of two authorizations that arrive together reach the seller", async () => {
    // The case the pre-serve read cannot answer on its own: both requests skip it
    // (`guardsPendingC8`, which is the shape of a race in which neither has
    // inserted yet), so the only thing that can stop the second is the claim
    // `openPayment` takes in a transaction behind the payer's advisory lock. Delete
    // that third argument and this test sees two 200s and two rows -- S6's finding
    // arriving in the route written to prevent it.
    const target = fixture("hold");
    const keyA = `c8-together-a-${randomUUID()}`;
    const keyB = `c8-together-b-${randomUUID()}`;

    const startedA = call("hold", {
      guards: guardsPendingC8,
      x402: scriptedX402({ settle: "ok", replayKey: keyA }, []),
      payment: payloadFor(target.sellerAccount),
    });
    const startedB = call("hold", {
      guards: guardsPendingC8,
      x402: scriptedX402({ settle: "ok", replayKey: keyB }, []),
      payment: payloadFor(target.sellerAccount),
    });

    // Let both reach the claim before the seller is allowed to answer.
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (releaseHold === null) {
      throw new Error("the holding seller never received the first request");
    }
    releaseHold();
    const [a, b] = await Promise.all([startedA, startedB]);

    expect([a.response.status, b.response.status].sort()).toEqual([200, 429]);
    // The winner was served, so its response body is taken; the loser's is read
    // here because this 429 comes from the claim rather than from the guard's read
    // (`guardsPendingC8` is injected precisely so the guard cannot answer), and it
    // is the only place that says when to come back.
    const refused = a.response.status === 429 ? a : b;
    expect(refused.response.headers.get("retry-after")).toBe(
      String(inFlightWindowSeconds(2000, 30_000)),
    );
    expect((await refused.response.json()) as unknown).toMatchObject({
      error: "payer_in_flight",
      retryAfterSeconds: inFlightWindowSeconds(2000, 30_000),
    });
    const rowA = await paymentByReplayKey(keyA);
    const rowB = await paymentByReplayKey(keyB);
    // Exactly one payment exists: the refused authorization booked nothing.
    expect([rowA !== null, rowB !== null].sort()).toEqual([false, true]);
    // Nothing to clean up: the winner settled and owns a `payment_in`, and the
    // append-only ledger is the point of the exercise, not an obstacle to it.
  });

  it("serves that payer again once the in-flight payment has been answered", async () => {
    const target = fixture("direct");
    const blocker = await insertVerifiedPayment({ endpointId: target.endpointId });
    const first = await call("direct", {
      x402: scriptedX402({ settle: "ok", replayKey: randomUUID() }, []),
      payment: payloadFor(target.sellerAccount),
    });
    expect(first.response.status).toBe(429);

    await need().sql`update payments set state = 'settled' where id = ${blocker.id}`;
    const replayKey = randomUUID();
    const second = await call("direct", {
      x402: scriptedX402({ settle: "ok", replayKey }, []),
      payment: payloadFor(target.sellerAccount),
    });
    expect(second.response.status).toBe(200);
    expect((await paymentByReplayKey(replayKey))?.state).toBe("settled");

    // Only the fixture's own blocker row is removed: the second payment wrote a
    // `payment_in`, and `ledger_entries` is append-only, so neither the line nor
    // the row it belongs to can be deleted by anyone, including a test.
    await need().sql`delete from payments where id = ${blocker.id}`;
  });

  it("refuses an underfunded authorization before the seller is dialled (Guard 2's ordering)", async () => {
    // S6 measured that the balance check already exists inside `verify`
    // (`ft_balance_of` on the account the signature binds, refused at
    // `balance < amount`), so C8's contribution to GW-5 is *when*: the answer must
    // arrive before the proxied bytes, not after them. The chain stub here holds
    // one yocto less than the price, which is the boundary the scheme draws.
    const target = fixture("direct");
    const unpaid = await call("direct", { x402: shippedX402() });
    const advertised = decodeChallenge(unpaid.response).accepts[0];
    if (advertised === undefined) {
      throw new Error("the advertisement carried no price");
    }
    const minted = await mintPayment(advertised);
    const hits = sellerHits.length;
    const openRows = await countPayments(target.endpointId, "verified");
    const settledRows = await countPayments(target.endpointId, "settled");
    const paid = await call("direct", {
      x402: shippedX402(BigInt(PRICE) - 1n),
      payment: minted.body,
    });

    expect(paid.response.status).toBe(402);
    // The scheme's own code, not a string this suite invented: `verify` calls
    // `ft_balance_of` on the account the signature binds and refuses at
    // `balance < amount`.
    expect(decodeChallenge(paid.response).error).toContain("insufficient_funds");
    expect(sellerHits).toHaveLength(hits);
    expect(await countPayments(target.endpointId, "verified")).toBe(openRows);
    expect(await countPayments(target.endpointId, "settled")).toBe(settledRows);
  });

  it("through the default seam a loopback seller is refused, which is what the seam is for", async () => {
    const target = fixture("direct");
    const replayKey = randomUUID();
    const { response } = await call("direct", {
      x402: scriptedX402({ settle: "ok", replayKey }, []),
      payment: payloadFor(target.sellerAccount),
      defaultUpstream: true,
    });
    // No override: the shipped SSRF policy runs, and `127.0.0.1` is not a seller.
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; detail: string };
    expect(body.error).toBe("upstream_failed");
    expect(body.detail).toContain("address_forbidden");
    const payment = await paymentByReplayKey(replayKey);
    expect(payment?.state).toBe("abandoned");
    expect(await ledgerOf(replayKey)).toEqual([]);
  });

  it("stamps the settlement hash on the verified row before the terminal move (C10)", async () => {
    // The boot sweep can only recover a payment whose process died after `settle`
    // returned if the hash was written while the row was still `verified`. A real
    // crash cannot be staged in-process, so this watches the two writes instead:
    // hash first, state second. Removing the early write makes the first update the
    // terminal one, and the sweep would have no evidence to ask the chain about.
    const updates: Record<string, unknown>[] = [];
    const hash = `tx-order-${randomUUID()}`;
    const real = need().db;
    const watched = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "update") {
          return (...args: Parameters<Db["update"]>) => {
            const builder = target.update(...args);
            return new Proxy(builder, {
              get(inner, key) {
                if (key === "set") {
                  return (values: Record<string, unknown>) => {
                    updates.push({ ...values });
                    return (inner as unknown as { set(value: unknown): unknown }).set(values);
                  };
                }
                const value = Reflect.get(inner, key) as unknown;
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;

    const target = fixture("direct");
    const { response } = await call("direct", {
      x402: scriptedX402({ settle: "ok", hash }),
      payment: payloadFor(target.sellerAccount),
      db: watched,
    });
    expect(response.status).toBe(200);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ nearTxHash: hash });
    expect(updates[1]).toMatchObject({ state: "settled", nearTxHash: hash });
  });
});
