import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createApp } from "../apps/api/src/app.ts";
import { type Db, closeDb, createDb } from "../apps/api/src/db/client.ts";
import * as schema from "../apps/api/src/db/schema.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { getUpstream } from "../apps/api/src/gateway/proxy.ts";
import type { UpstreamTarget } from "../apps/api/src/gateway/ssrf.ts";
import type { PollStatusSource } from "../apps/api/src/jobs/poll-payouts.ts";
import { pollTick, reconcileTick } from "../apps/api/src/jobs/ticks.ts";
import type { Logger } from "../apps/api/src/lib/logger.ts";
import { createProvider } from "../apps/api/src/payouts/index.ts";
import type { MockOutcome, MockScript } from "../apps/api/src/payouts/mock/provider.ts";
import { type NormalizedSwap, TERMINAL_STATES } from "../apps/api/src/payouts/provider.ts";
import { listOpenDiscrepanciesForSeller } from "../apps/api/src/services/discrepancies.ts";
import { listPaymentsForSeller } from "../apps/api/src/services/payments.ts";
import { routeById } from "../apps/api/src/services/payout-routes.ts";
import { listBlockedPayersForSeller } from "../apps/api/src/services/strikes.ts";
import { createPayerFetch, createX402Near } from "../apps/api/src/x402/near.ts";
import type { NearViewSigner } from "../apps/api/src/x402/types.ts";
import { startDemoUpstream } from "./demo-upstream.ts";
import {
  DEMO_ASSET_CONTRACT,
  DEMO_DESTINATION_ADDRESS,
  DEMO_DESTINATION_ASSET,
  DEMO_DESTINATION_CHAIN,
  DEMO_ENDPOINT_SLUG,
  DEMO_PRICE_BASE_UNITS,
  DEMO_SELLER_ACCOUNT,
  seedDemo,
} from "./seed.ts";

/**
 * `pnpm demo` (DQ-1, G1): the PRD section 8 walk, run and asserted.
 *
 * Everything it prints is something it checked. Each of the six steps ends in an
 * assertion against a response or the database, and the process exits non-zero when
 * one of them fails, so the demo cannot pass by leaving a step out — and the `demo`
 * job in ci.yml runs this exact file on a fresh database on every push.
 *
 * Three surfaces are SIMULATED, and each says so in the output (DQ-2), because the
 * line between "this happened" and "this was scripted" is the thing a judge is most
 * likely to be misled by:
 *
 * - **The chain.** `createX402Near` is given its `signer` seam — the seven chain
 *   reads the scheme makes, answered here — next to a loopback JSON-RPC stub that
 *   the payer's own client signs against. The delegate the gateway verifies is
 *   genuinely signed by `@fastnear`'s signer over an advertisement it really
 *   received; what is invented is the answer to "did the transfer land", because
 *   nothing was submitted and no key exists. Production never passes that seam, so
 *   this is the only place the whole paid path can run with no keys (A10 owes the
 *   funded testnet half).
 * - **The payout provider.** `PAYOUT_PROVIDER=mock` quotes the seeded route, and
 *   every swap status this run polls carries `raw.simulated = true`, the marker the
 *   shipped mock writes for its own statuses (D2).
 * - **The loopback upstream.** `resolveUpstreamTarget` refuses a loopback address
 *   for every seller whatever `ALLOW_INSECURE_UPSTREAM` says (C5: that knob is about
 *   http versus https, never about the address), so the demo reaches its own
 *   upstream through `app.ts`'s `gateway.upstream` seam while the shipped
 *   `getUpstream` does the dialling. The policy is not relaxed, it is bypassed at
 *   one call site — which is printed in the run's header, not hidden.
 *
 * What is *not* simulated: the gateway route, the payment layer's verification, the
 * guards, the ledger writers, the poll loop, the reconciliation rules and the
 * dashboard's own reads. Those are the product, and this exercises them the way a
 * seller's request would.
 *
 * Env: `DATABASE_URL` (a database the run may write to — see the poll batch note in
 * step 3), `SESSION_SECRET`, and optionally `GATEWAY_PUBLIC_URL`, which is replaced
 * by the origin the demo actually binds.
 *
 * Two constraints a reader adding a step needs before the first red line:
 *
 * - This directory is not a workspace package, so `pnpm -r typecheck` would never see
 *   this file. The root `typecheck` script runs `tsc -p tsconfig.scripts.json` over
 *   `scripts/` for exactly that reason.
 * - A script may not import a bare specifier (`drizzle-orm`, `zod`, `@till/core`):
 *   only `apps/api` and `packages/*` install them, and Node resolves an import
 *   relative to the importing file, so `tsx scripts/demo.ts` fails on the first such
 *   line. That is why everything below goes through `apps/api`'s own services and
 *   `schema.*` reads with the filtering done in JavaScript.
 */

// --- The simulated chain ---------------------------------------------------------------------

const TOKEN = DEMO_ASSET_CONTRACT;
const RELAYER = "relayer.testnet";
/** The throwaway key `test/gateway.test.ts` already ships: nothing it signs can move money. */
const PAYER_KEY = "ed25519:3C8DxNwqJ5rP4nFBEhKZKvXWMBcpPvjGqPgn2sTQxXWJ";
const NO_CONTRACT = "11111111111111111111111111111111";
const HAS_CONTRACT = "7BCKZH9Znj1iMAhRMLTR81vXATMiKh3KZbLK7MF3KtU4";
const BASE_BLOCK_HEIGHT = 123_456_789;
const BLOCK_HASH = "FG25p2pNTtW8fBuPqMfvv5f6YQqJn7XwEw5o6oPzb8Kq";
/** Ten of the token, so no step fails on a balance except the one that is about it. */
const DEFAULT_BALANCE = 10_000_000n;
const PRICED = BigInt(DEMO_PRICE_BASE_UNITS);

/** This run's label, in every settlement hash the stub hands out. See `nextTransaction`. */
const RUN_ID = randomUUID().slice(0, 8);

/**
 * Where this run's simulated chain starts: `BASE_BLOCK_HEIGHT` plus the run label. A
 * NEP-366 delegate carries the height it expires at, so a second run that started at
 * the same height would sign byte-identical payments to the first one's, and identical
 * bytes are an identical `replay_key` — which the gateway answers with 409, correctly
 * refusing to spend one authorization twice. A real chain never repeats a height; the
 * stub starts a different one per run for the same reason.
 */
const START_BLOCK_HEIGHT = BASE_BLOCK_HEIGHT + Number.parseInt(RUN_ID, 16);

export type SimChain = {
  readonly signer: NearViewSigner;
  readonly rpcUrl: string;
  /**
   * What the chain answers for one account's token balance. The empty-account step
   * sets `0n`, which `verify` refuses at `balance < amount` — so the refusal this
   * demo shows happens inside the shipped scheme, not in a fake of it.
   */
  setBalance(accountId: string, amount: bigint): void;
  /** Whether the next submitted delegate reports its inner receipt as landing. */
  setSettlement(outcome: "success" | "failure"): void;
  close(): Promise<void>;
};

/**
 * The chain as the verifier sees it, plus the JSON-RPC endpoint the payer signs
 * against — the same two stubs `test/gateway.test.ts` uses, field for field, so the
 * demo runs the shape the suite already proves the scheme accepts.
 *
 * The block height advances on every read rather than sitting still, and that is not
 * decoration: a NEP-366 delegate carries the height it expires at, so with a fixed
 * height two payments from one payer are the same bytes, and the same bytes are the
 * same `replay_key` — which the gateway answers with `409`, correctly refusing to
 * spend one authorization twice. Advancing the height is what lets step 6 mint a
 * second and third payment from the same account, and `START_BLOCK_HEIGHT` is what
 * lets a second run of this file mint its own payments at all.
 */
async function startSimChain(): Promise<SimChain> {
  const balances = new Map<string, bigint>();
  let height = START_BLOCK_HEIGHT;
  let submitted = 0;
  let settlement: "success" | "failure" = "success";

  const nextHeight = (): number => {
    height += 1;
    return height;
  };

  const rpc = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const call = JSON.parse(body) as { method: string };
      let result: unknown = {};
      if (call.method === "query") {
        result = {
          block_height: nextHeight(),
          block_hash: BLOCK_HASH,
          nonce: 7,
          permission_kind: "FullAccess",
        };
      } else if (call.method === "block") {
        result = {
          header: {
            height: nextHeight(),
            hash: BLOCK_HASH,
            prev_hash: BLOCK_HASH,
            timestamp: "2026-11-09T00:00:00.000000000Z",
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
      } else if (call.method === "tx") {
        // C10's sweep question. Nothing in this walk asks it, and answering
        // `unknown` rather than a verdict is what keeps a sweep from booking money
        // this file never settled.
        result = { status: "Unknown", receipts_outcome: [] };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await listen(rpc, 0);

  const signer: NearViewSigner = {
    getRelayerIds: () => [RELAYER],
    getCurrentBlockHeight: async () => BigInt(height),
    viewAccount: async ({ accountId }) =>
      accountId === TOKEN ? { codeHash: HAS_CONTRACT } : { codeHash: NO_CONTRACT },
    viewAccessKey: async () => ({ nonce: 7n, permissionKind: "FullAccess" }),
    ftBalanceOf: async ({ accountId }) => balances.get(accountId) ?? DEFAULT_BALANCE,
    storageBalanceOf: async () => ({ supported: false }),
    submitSignedDelegateAction: async () => {
      if (settlement === "failure") {
        // The shape of "the relayer transaction landed and the `ft_transfer` inside
        // it reverted", which is what a payer who cannot pay looks like from the
        // seller's side. No hash comes back, because a settlement that failed has no
        // receipt to open in an explorer — and that is what makes the row
        // un-sweepable rather than merely un-booked.
        submitted += 1;
        return {
          transaction: "",
          innerReceipt: {
            kind: "failure",
            error: "Action #1 kind: FunctionCall error: The transaction has expired",
          },
        };
      }
      submitted += 1;
      // The run id is in the hash because a second run on the same database must not
      // produce a payment that carries the first run's hash: `linkSwapByHash` matches
      // on it per seller and refuses an ambiguous match (LR-2), so reused hashes would
      // make step 3 fail for a reason that has nothing to do with what it checks.
      const transaction = `sim-${RUN_ID}-${String(submitted)}`;
      return { transaction, innerReceipt: { kind: "success", value: "" } };
    },
  };

  return {
    signer,
    rpcUrl: originOf(rpc),
    setBalance: (accountId, amount) => {
      balances.set(accountId, amount);
    },
    setSettlement: (outcome) => {
      settlement = outcome;
    },
    close: () => closeServer(rpc),
  };
}

// --- The payout statuses ---------------------------------------------------------------------

/** What each scripted outcome reports once it resolves (the shipped mock's table). */
const RESOLVED: Record<MockOutcome, NormalizedSwap["state"]> = {
  succeed: "succeeded",
  refund: "refunded",
  fail: "failed",
  stall: "processing",
};

/**
 * Statuses for the swaps this run created, keyed by refs this run named.
 *
 * It answers only for refs it scripted and stays silent about every other, which is
 * D6's `poll_ref_unanswered` path. A source that threw on an unknown ref would push
 * the *whole claimed batch* onto the retry gap (poll-payouts.ts), including the swap
 * the demo is waiting for — D2's refusal is right for `pnpm simulate`, where one
 * provider answers one script, and wrong for a shared table.
 *
 * What silence cost before D10, measured on 2026-11-09 rather than assumed: an
 * unanswered row was rescheduled on the plain poll interval, so it was due again on
 * the next pass and stayed older than this run's swap. With more than
 * `DEFAULT_POLL_BATCH_SIZE` of them in the table the batch filled before this run's
 * ref was reached and step 3 failed on `state pending` — which is why the count is
 * printed above the assertion, and why D10 exists.
 *
 * The ref is the demo's own and not the mock's `mock-quote-N` because
 * `swaps.provider_ref` is globally unique and a rerun would collide. Everything else
 * about the answer — including `raw.simulated` — is the shipped mock's shape
 * (`payouts/mock/provider.ts`), so what lands in the table is what the mock itself
 * would have written.
 */
export class DemoStatusSource implements PollStatusSource {
  readonly #scripted = new Map<string, MockScript>();
  readonly #polls = new Map<string, number>();

  script(providerRef: string, script: MockScript): void {
    this.#scripted.set(providerRef, script);
  }

  async getStatus(input: {
    readonly providerRefs: readonly string[];
  }): Promise<readonly NormalizedSwap[]> {
    const answers: NormalizedSwap[] = [];
    for (const ref of input.providerRefs) {
      const script = this.#scripted.get(ref);
      if (script === undefined) {
        continue;
      }
      const poll = (this.#polls.get(ref) ?? 0) + 1;
      this.#polls.set(ref, poll);
      const resolved = poll >= (script.resolvesOnPoll ?? 1);
      const state = resolved ? RESOLVED[script.outcome] : "processing";
      answers.push({
        providerRef: ref,
        state,
        amountIn: script.amountIn,
        amountOut: state === "succeeded" ? (script.amountOut ?? script.amountIn) : null,
        refundedAmount: state === "refunded" ? (script.refundedAmount ?? script.amountIn) : null,
        originTxHash: script.originTxHash ?? null,
        destinationTxHash: state === "succeeded" ? `sim-out-${ref}` : null,
        raw: { simulated: true, provider: "mock", outcome: script.outcome, poll },
      });
    }
    return answers;
  }
}

// --- The process plumbing --------------------------------------------------------------------

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the demo's server is not listening on a TCP port");
  }
  return address.port;
}

function originOf(server: Server): string {
  return `http://127.0.0.1:${portOf(server)}`;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Serves the app over a socket, because the buyer in step 2 is a *child process*
 * paying with `fetch`, which cannot reach an in-process handler.
 *
 * The builder is handed the origin the socket bound to rather than the other way
 * round: `GATEWAY_PUBLIC_URL` is what the advertisement's `resource` is built from
 * (requirements.ts), so the app cannot be built until the port is known, and a demo
 * that pointed a payer at a port it never bound would be advertising a lie. Port 0
 * means the operating system chooses, because 3000 is taken on any machine already
 * running the API.
 *
 * `@hono/node-server` is what `server.ts` binds with and is not resolvable from
 * `scripts/` (the root `node_modules` holds four dev dependencies and no runtime
 * ones), so the request and response translation is written here instead of
 * borrowed. It is deliberately small: the demo's traffic is GETs, and everything the
 * gateway decides — status, headers, the payment receipt — crosses this boundary
 * unchanged, which is what makes the assertions downstream mean something.
 */
async function serveApp<App extends { fetch(request: Request): Response | Promise<Response> }>(
  build: (origin: string) => App,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        for (const one of Array.isArray(value) ? value : [value]) {
          if (one !== undefined) {
            headers.append(name, one);
          }
        }
      }
      const method = req.method ?? "GET";
      // The demo's own traffic is GETs; a body is forwarded anyway so that a step
      // which posts cannot find the seam missing one.
      const withBody = method !== "GET" && method !== "HEAD";
      const response = await app.fetch(
        new Request(new URL(req.url ?? "/", url), {
          method,
          headers,
          ...(withBody ? { body: new Uint8Array(Buffer.concat(chunks)) } : {}),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await listen(server, 0);
  const url = originOf(server);
  const app = build(url);
  return { url, close: () => closeServer(server) };
}

/** The buyer's half of the paid path: the shipped client, signing what was advertised. */
function payerFetch(rpcUrl: string, accountId: string): typeof globalThis.fetch {
  return createPayerFetch({
    accountId,
    secretKey: PAYER_KEY,
    network: "near:testnet",
    rpcUrl,
  });
}

/**
 * Runs `scripts/demo-agent.ts` as its own process — the script the README tells a
 * reviewer to type. Step 2 is only worth asserting if it is the real one: an
 * in-process copy would prove the payment layer and prove nothing about the agent.
 */
function runDemoAgent(env: Record<string, string>, url: string): Promise<string> {
  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  const agent = fileURLToPath(new URL("./demo-agent.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [agent, url], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(`${out}\n[exit ${String(code)}]`);
    });
  });
}

/**
 * The gateway's logs, buffered instead of printed.
 *
 * A demo transcript is six steps of prose and assertions; a JSON line per request
 * would bury it. They are kept rather than dropped because `check` prints the last few
 * when something fails, and the gateway's own codes (`SERVED_NOT_SETTLED`,
 * `payer_blocked`, `poll_ref_unanswered`) are the fastest read on why a step did not
 * behave as claimed.
 */
function bufferingLogger(): {
  readonly logger: Logger;
  tail(count: number): string[];
} {
  const lines: string[] = [];
  const record = (level: string, fields: Record<string, unknown>, message?: string): void => {
    const code = typeof fields.code === "string" ? ` ${fields.code}` : "";
    const id = typeof fields.requestId === "string" ? ` ${fields.requestId.slice(0, 8)}` : "";
    lines.push(`${level}${id}${code} ${message ?? ""}`.trim());
  };
  const logger: Logger = {
    info: (fields, message) => {
      record("info", fields, message);
    },
    warn: (fields, message) => {
      record("warn", fields, message);
    },
    error: (fields, message) => {
      record("error", fields, message);
    },
    child: () => logger,
  };
  return { logger, tail: (count) => lines.slice(-count) };
}

// --- The report ------------------------------------------------------------------------------

let failures = 0;
const gatewayLog = bufferingLogger();

function step(title: string): void {
  console.log(`\n${title}`);
}

function detail(line: string): void {
  console.log(`  ·        ${line}`);
}

/**
 * The one assertion primitive. A step that cannot assert — because a fixture or a
 * dependency is missing — is a failure and not a skip: a demo that prints its way
 * through with the checks switched off is the thing DQ-1 exists to prevent.
 */
function check(label: string, ok: boolean, evidence = ""): void {
  if (ok) {
    console.log(`  ok       ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAILED   ${label}${evidence === "" ? "" : ` — ${evidence}`}`);
  for (const line of gatewayLog.tail(4)) {
    console.error(`           ${line}`);
  }
}

// --- The buyers -------------------------------------------------------------------------------

const AGENT_PAYER = "demo-agent-payer.testnet";
/** A second buyer, so the refund is about a distinct payment and not the first again. */
const REFUND_PAYER = "demo-refund-payer.testnet";
/** The buyer with nothing in its account (PRD 8.6's other half). */
const EMPTY_PAYER = "demo-empty-payer.testnet";

type PaymentRow = Awaited<ReturnType<typeof listPaymentsForSeller>>[number];
type LedgerRow = Awaited<ReturnType<typeof allLedgerRows>>[number];
type SwapRow = Awaited<ReturnType<typeof allSwapRows>>[number];
type SellerRef = { readonly id: string; readonly nearAccountId: string };

/** What one gateway call cost: the status, what it said, and the row it left behind if any. */
type Call = {
  readonly status: number;
  readonly body: string;
  readonly row: PaymentRow | null;
  readonly threw: string | null;
};

// --- The run ---------------------------------------------------------------------------------

export async function runDemo(): Promise<number> {
  const env = loadEnv({
    ...process.env,
    GATEWAY_PUBLIC_URL: process.env.GATEWAY_PUBLIC_URL ?? "http://127.0.0.1:3000",
  });
  const db = createDb(env.DATABASE_URL);
  const chain = await startSimChain();
  const upstream = await startDemoUpstream({ port: 0 });
  const statuses = new DemoStatusSource();

  const x402 = createX402Near({
    network: env.NEAR_NETWORK,
    maxSponsoredGas: env.MAX_SPONSORED_GAS,
    signer: chain.signer,
  });
  if (!x402.configured) {
    throw new Error("the demo's payment layer is not configured, so nothing can be verified");
  }
  const api = await serveApp((origin) =>
    createApp({
      env: { ...env, GATEWAY_PUBLIC_URL: origin },
      log: gatewayLog.logger,
      db,
      x402,
      gateway: {
        // The loopback bypass, in one call site, stated out loud in the header. The
        // origin is the demo's own live upstream rather than the stored
        // `endpoints.upstream_url` because that row was seeded by a previous run, on a
        // port that process has since closed.
        upstream: async (call) => {
          const url = new URL(call.url);
          const target: UpstreamTarget = {
            origin: upstream.url,
            hostname: "127.0.0.1",
            port: upstream.port,
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
      },
    }),
  );

  try {
    console.log(
      "SIMULATED run — the chain, the payout provider and the loopback upstream are scripted (DQ-2).",
    );
    console.log(
      "The gateway, the payment verification, the guards, the ledger, the poll loop and the",
    );
    console.log("reconciliation rules are the shipped code, running for real against Postgres.");
    console.log("");
    console.log(`gateway  ${api.url}`);
    console.log(`chain    ${chain.rpcUrl}  (loopback JSON-RPC stub: no keys, no money moved)`);
    console.log(
      `upstream ${upstream.url}/data  (the SSRF policy would refuse this address; the seam dials it)`,
    );
    console.log(
      `run      ${RUN_ID}  (labels this run's settlement hashes, and starts the chain at block ${String(START_BLOCK_HEIGHT)})`,
    );

    // --- 1. A seller with a live paywalled endpoint and an empty ledger (PRD 8.1)
    step("1. the seller: one live paywalled endpoint, and no money in yet");
    const seeded = await seedDemo({
      db,
      payoutProvider: env.PAYOUT_PROVIDER,
      preparer: createProvider(env, []),
      upstreamUrl: `${upstream.url}/data`,
    });
    const seller: SellerRef = { id: seeded.sellerId, nearAccountId: DEMO_SELLER_ACCOUNT };
    detail(
      seeded.created
        ? `seeded seller=${DEMO_SELLER_ACCOUNT} slug=${seeded.slug} price=${seeded.priceAmount}`
        : `reusing the endpoint this database already had (slug ${seeded.slug})`,
    );
    check(
      "the seeded endpoint is priced at the demo's price",
      seeded.priceAmount === DEMO_PRICE_BASE_UNITS,
      `price is ${seeded.priceAmount}`,
    );
    check(
      "its payout route has a deposit address to advertise",
      seeded.depositAddress !== "",
      "the route carries no deposit address",
    );

    const ledgerBefore = new Set((await allLedgerRows(db)).map((row) => row.id));
    const paymentsBefore = new Set((await listPaymentsForSeller(db, seller)).map((row) => row.id));

    const unpaid = await fetch(`${api.url}/r/${seeded.slug}`, {
      headers: { accept: "application/json" },
    });
    check("an unpaid request answers 402", unpaid.status === 402, `got ${unpaid.status}`);
    const advertised = decodeChallenge(unpaid);
    check(
      "and the 402 carries the six fields a payer signs against",
      advertised !== null,
      "no decodable PAYMENT-REQUIRED header or body",
    );
    if (advertised !== null) {
      check(
        "it names the exact scheme on near:testnet",
        advertised.scheme === "exact" && advertised.network === "near:testnet",
        `${advertised.scheme} on ${advertised.network}`,
      );
      check(
        "its amount is the endpoint's price in base units",
        advertised.amount === DEMO_PRICE_BASE_UNITS,
        `advertised ${advertised.amount}`,
      );
      check(
        "its asset is the seeded token",
        advertised.asset === DEMO_ASSET_CONTRACT,
        `advertised ${advertised.asset}`,
      );
      check(
        "its pay-to is the payout route's deposit address",
        advertised.payTo === seeded.depositAddress,
        `pay-to ${advertised.payTo}, route ${seeded.depositAddress}`,
      );
      check(
        "its timeout window is a positive number of seconds",
        advertised.maxTimeoutSeconds > 0,
        String(advertised.maxTimeoutSeconds),
      );
    }
    check(
      "the 402 cost the seller nothing: not one byte dialled upstream",
      (upstream.hits()["/data"] ?? 0) === 0,
      `the upstream answered ${String(upstream.hits()["/data"] ?? 0)} requests`,
    );
    check(
      "and the seller's ledger is empty for this run",
      (await ledgerSince(db, ledgerBefore)).length === 0,
      "a ledger entry was written before anything was paid",
    );

    // --- 2. The agent hits it, gets the 402, pays, and gets the data (PRD 8.2)
    step("2. the buyer: a 402, a signed NEAR delegate, and the data");
    const agentOutput = await runDemoAgent(
      {
        GATEWAY_PUBLIC_URL: api.url,
        NEAR_NETWORK: "near:testnet",
        NEAR_RPC_URL: chain.rpcUrl,
        DEMO_PAYER_ACCOUNT_ID: AGENT_PAYER,
        DEMO_PAYER_SECRET_KEY: PAYER_KEY,
      },
      `${api.url}/r/${seeded.slug}`,
    );
    for (const line of agentOutput
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(0, 10)) {
      detail(line);
    }
    check(
      "scripts/demo-agent.ts paid and exited 0",
      agentOutput.endsWith("[exit 0]"),
      "the agent exited non-zero",
    );

    const paidRows = await newPayments(db, seller, paymentsBefore);
    check(
      "exactly one payment row is this run's",
      paidRows.length === 1,
      `${paidRows.length} rows`,
    );
    const first = paidRows[0];
    if (first === undefined) {
      return summary();
    }
    check("it is settled", first.state === "settled", first.state);
    check("it is the agent's account", first.payerAccountId === AGENT_PAYER, first.payerAccountId);
    check(
      "it carries the settlement hash the receipt carried",
      typeof first.nearTxHash === "string" && first.nearTxHash.startsWith(`sim-${RUN_ID}-`),
      String(first.nearTxHash),
    );

    // --- 3. The payment shows, then the payout arrives on another chain (PRD 8.3)
    step("3. the money: booked once in, and not yet out");
    const afterPay = await ledgerSince(db, ledgerBefore);
    const ins = afterPay.filter((row) => row.kind === "payment_in");
    check("exactly one payment_in", ins.length === 1, `${ins.length} lines`);
    const [paymentIn] = ins;
    check(
      "for the price, in the token the payer sent, against this payment",
      ins.length === 1 &&
        paymentIn !== undefined &&
        BigInt(paymentIn.amount) === PRICED &&
        paymentIn.asset === DEMO_ASSET_CONTRACT &&
        paymentIn.paymentId === first.id,
      ins.map((row) => `${row.amount} ${row.asset}`).join(", ") || "nothing",
    );
    check(
      "and no payout_out yet: the provider has not been asked about the deposit",
      !afterPay.some((row) => row.kind === "payout_out"),
      "a payout was booked before any status reported one",
    );

    // `""` is what a seeded endpoint with no route reports (SeedResult has no route to
    // name), and asking the database for a uuid called `""` is an error rather than an
    // absence — so the absence is decided here, where the check can report it.
    const route = seeded.routeId === "" ? null : await routeById(db, seeded.routeId);
    check(
      "the route pays out on another chain than the payment came from",
      route?.destinationChain === DEMO_DESTINATION_CHAIN &&
        route.destinationAsset === DEMO_DESTINATION_ASSET,
      `${String(route?.destinationChain)}/${String(route?.destinationAsset)}`,
    );

    if (first.nearTxHash !== null) {
      const foreign = await unclaimedForeignSwaps(db);
      if (foreign > 0) {
        detail(
          `${String(foreign)} older swap(s) in this database are still unclaimed; the poller takes the 25 oldest, so a very dirty DATABASE_URL can starve this run's swap`,
        );
      }
      const swapRef = await writeSwap(db, seeded, statuses, first.nearTxHash, "succeed");
      await drive(db, statuses, env, swapRef);
      const swap = await swapByRef(db, swapRef);
      check(
        "the polled swap reached its scripted terminal state",
        swap?.state === "succeeded",
        `state ${String(swap?.state)}`,
      );
      check(
        "the poller matched it to the payment by transaction hash, and nothing else",
        swap?.paymentId === first.id,
        `payment_id ${String(swap?.paymentId)} for payment ${first.id}`,
      );
      check(
        "the row is marked simulated in the raw provider payload",
        swap !== null && (swap.raw as { simulated?: boolean }).simulated === true,
        "raw.simulated is not true",
      );
      const afterPayout = await ledgerSince(db, ledgerBefore);
      const out = afterPayout.filter((row) => row.kind === "payout_out");
      check("the payout books exactly one payout_out", out.length === 1, `${out.length} lines`);
      check(
        `on the destination asset (${DEMO_DESTINATION_CHAIN}/${DEMO_DESTINATION_ASSET})`,
        out.some((row) => row.asset === DEMO_DESTINATION_ASSET),
        out.map((row) => row.asset).join(", ") || "nothing",
      );
      check(
        "the two lines name two different tokens, which is the cross-chain part",
        out.some((row) => row.asset !== DEMO_ASSET_CONTRACT) &&
          ins.some((row) => row.asset === DEMO_ASSET_CONTRACT),
        "both lines are in the same asset",
      );
      check(
        "and the dashboard's payment read still shows the payment, settled",
        (await newPayments(db, seller, paymentsBefore)).some(
          (row) => row.id === first.id && row.state === "settled",
        ),
        "the payment row is gone from the seller's list",
      );
    }

    // --- 4 and 5. A simulated refund, and reconciliation raising it (PRD 8.4, 8.5)
    step("4. a refund, and the discrepancy reconciliation opens for it");
    const refund = await payOnce({
      api,
      chain,
      db,
      seller,
      slug: seeded.slug,
      payer: REFUND_PAYER,
    });
    check(
      "a second buyer is served, and its payment settled",
      refund.row !== null && refund.row.state === "settled",
      `status ${refund.status}, state ${String(refund.row?.state)}${refund.threw === null ? "" : `, threw ${refund.threw}`}`,
    );
    const refundHash = refund.row?.nearTxHash ?? null;
    if (refundHash !== null && refund.row !== null) {
      const refundRow = refund.row;
      const refundRef = await writeSwap(db, seeded, statuses, refundHash, "refund");
      await drive(db, statuses, env, refundRef);
      const refunded = await swapByRef(db, refundRef);
      check(
        "the swap reports refunded",
        refunded?.state === "refunded",
        `state ${String(refunded?.state)}`,
      );
      const ledger = await ledgerSince(db, ledgerBefore);
      const refunds = ledger.filter((row) => row.kind === "refund_in");
      const [refundIn] = refunds;
      check(
        "the deposit coming back books one refund_in",
        refunds.length === 1,
        `${refunds.length} lines`,
      );
      check(
        "in the token the deposit was made in, not the destination's",
        refundIn !== undefined &&
          refundIn.asset === DEMO_ASSET_CONTRACT &&
          refundIn.paymentId === refundRow.id,
        refunds.map((row) => `${row.amount} ${row.asset}`).join(", ") || "nothing",
      );
      const open = await listOpenDiscrepanciesForSeller(db, seeded.sellerId);
      const finding = open.find(
        (row) => row.code === "PAYOUT_REFUNDED" && row.swapId === refunded?.id,
      );
      check(
        "reconciliation opens PAYOUT_REFUNDED for this swap",
        finding !== undefined,
        open.map((row) => row.code).join(", ") || "nothing open",
      );
      if (finding !== undefined) {
        check(
          "with an explanation and a suggested action, not just a code",
          finding.explanation.length > 0 && finding.suggestedAction.length > 0,
          `${finding.explanation} / ${finding.suggestedAction}`,
        );
        detail(`explanation ${finding.explanation}`);
        detail(`action      ${finding.suggestedAction}`);
      }
    }

    // --- 6a. The empty account, refused before the seller is dialled (PRD 8.6)
    step("5. the empty account: refused before it can cost the seller anything");
    chain.setBalance(EMPTY_PAYER, 0n);
    const hitsBeforeEmpty = upstream.hits()["/data"] ?? 0;
    const empty = await payOnce({ api, chain, db, seller, slug: seeded.slug, payer: EMPTY_PAYER });
    check(
      "a payer whose balance is below the price is not served",
      empty.status === 402,
      `answered ${empty.status}${empty.threw === null ? "" : ` (threw ${empty.threw})`}`,
    );
    check(
      "and the re-challenge says why: the balance, not the signature",
      empty.body.includes("insufficient_funds"),
      empty.body.slice(0, 160) || "no body",
    );
    check(
      "and the seller's upstream never saw the request",
      (upstream.hits()["/data"] ?? 0) === hitsBeforeEmpty,
      "the upstream was dialled for an unpaid request",
    );
    check(
      "and no payment row was opened for it",
      empty.row === null,
      `a row in state ${String(empty.row?.state)} was written for a payment that never verified`,
    );

    // --- 6b. Served without settling, then blocked (PRD 8.6)
    step("6. a buyer served without settling, and the block that follows");
    const strikePayer = `strike-${RUN_ID}.testnet`;
    detail(`a fresh payer for this run: ${strikePayer}`);
    chain.setSettlement("failure");
    const hitsBeforeStrikes = upstream.hits()["/data"] ?? 0;
    const served: number[] = [];
    const strikeRows: PaymentRow[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const call = await payOnce({ api, chain, db, seller, slug: seeded.slug, payer: strikePayer });
      served.push(call.status);
      if (call.row !== null) {
        strikeRows.push(call.row);
      }
    }
    check(
      "both attempts are served with 200 even though settlement failed",
      served.every((status) => status === 200),
      served.join(", "),
    );
    check(
      "the seller was dialled for each of them",
      (upstream.hits()["/data"] ?? 0) === hitsBeforeStrikes + 2,
      `hits went from ${hitsBeforeStrikes} to ${String(upstream.hits()["/data"] ?? 0)}`,
    );

    const third = await payOnce({ api, chain, db, seller, slug: seeded.slug, payer: strikePayer });
    check(
      "the third is refused 403 payer_blocked, not another 402",
      third.status === 403 && third.body.includes("payer_blocked"),
      `got ${third.status}${third.threw === null ? "" : ` (threw ${third.threw})`}: ${third.body.slice(0, 120)}`,
    );
    detail(
      "Two strikes in 24 hours block the third request (GW-7), and that is the number PRD 8.6 states: one strike would block a payer whose single failure was the gateway's own.",
    );

    check(
      "both strikes are stored as served_unsettled",
      strikeRows.length === 2 && strikeRows.every((row) => row.state === "served_unsettled"),
      strikeRows.map((row) => row.state).join(", ") || "no rows",
    );
    const struck = await ledgerSince(db, ledgerBefore);
    check(
      "and neither of them books revenue",
      !struck.some((entry) => strikeRows.some((row) => row.id === entry.paymentId)),
      `${String(struck.filter((entry) => strikeRows.some((row) => row.id === entry.paymentId)).length)} ledger lines were written for money that did not move`,
    );

    await reconcileTick({
      db,
      config: reconcileConfigOf(env),
      sellerIds: [seeded.sellerId],
      log: gatewayLog.logger,
    });
    const openNow = await listOpenDiscrepanciesForSeller(db, seeded.sellerId);
    const findings = openNow.filter(
      (row) => row.code === "SERVED_NOT_SETTLED" && strikeRows.some((p) => p.id === row.paymentId),
    );
    check(
      "reconciliation opens SERVED_NOT_SETTLED for each of them",
      findings.length === strikeRows.length,
      `${findings.length} of ${strikeRows.length} strikes`,
    );
    if (findings[0] !== undefined) {
      detail(`explanation ${findings[0].explanation}`);
      detail(`action      ${findings[0].suggestedAction}`);
    }
    const blocked = await listBlockedPayersForSeller(db, seeded.sellerId);
    check(
      "and the payer is on the seller's blocked list, with its strike count",
      blocked.some((row) => row.payerAccountId === strikePayer && row.strikes >= 2),
      blocked.map((row) => `${row.payerAccountId}=${String(row.strikes)}`).join(", ") ||
        "nobody blocked",
    );
    chain.setSettlement("success");

    return summary();
  } finally {
    await api.close();
    await upstream.close();
    await chain.close();
    await closeDb(db);
  }
}

function summary(): number {
  console.log("");
  if (failures === 0) {
    console.log("PRD section 8 ran and every assertion held.");
    return 0;
  }
  console.error(`${failures} assertion(s) failed.`);
  return 1;
}

// --- One paid call, and the row it left behind ------------------------------------------------

/**
 * Pay once through the shipped client and read back what the gateway wrote.
 *
 * The row is found by diffing the seller's payments rather than by searching for the
 * payer: `listPaymentsForSeller` is the read the dashboard uses (UI-3), so asserting
 * through it checks the same path a seller looks at, and a run that left no new row is
 * reported as one instead of as a null the caller has to notice.
 */
async function payOnce(input: {
  readonly api: { readonly url: string };
  readonly chain: SimChain;
  readonly db: Db;
  readonly seller: SellerRef;
  readonly slug: string;
  readonly payer: string;
}): Promise<Call> {
  const before = new Set(
    (await listPaymentsForSeller(input.db, input.seller)).map((row) => row.id),
  );
  let status = 0;
  let body = "";
  let threw: string | null = null;
  try {
    const response = await payerFetch(input.chain.rpcUrl, input.payer)(
      `${input.api.url}/r/${input.slug}`,
      { headers: { accept: "application/json" } },
    );
    status = response.status;
    // The refusal reason is in the body (`rechallenge` writes it into
    // `paymentRequired.error`), so a step that asserts *why* a payer was refused has
    // to keep it rather than only the status code.
    body = (await response.text()).slice(0, 400);
  } catch (error) {
    // Not a 402: `@x402/fetch` throws when it cannot parse the challenge or cannot
    // build a payload, which is a different failure from being refused, and the
    // assertions below say so rather than rounding it to one.
    threw = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .slice(0, 160);
  }
  const after = await listPaymentsForSeller(input.db, input.seller);
  const [row] = after.filter((payment) => !before.has(payment.id));
  return { status, body, row: row ?? null, threw };
}

// --- Database reads the demo needs and the app does not expose --------------------------------

/**
 * The two tables the demo asserts across, read whole and filtered here.
 *
 * No operator can be imported into a script (`drizzle-orm` is not in the root
 * `node_modules`), and there is no shipped read for `ledger_entries` by payment —
 * UI-6's in-transit aggregate is F6's and refuses until then — so the filter runs in
 * JavaScript. That is affordable because a CI database holds one run's rows; on a
 * database with a history it is a few thousand rows read once per assertion, which is
 * the right trade against reaching into drizzle's private session for a SQL fragment.
 */
async function allLedgerRows(db: Db) {
  return db.select().from(schema.ledgerEntries);
}

async function allSwapRows(db: Db) {
  return db.select().from(schema.swaps);
}

function ledgerSince(db: Db, before: ReadonlySet<string>): Promise<LedgerRow[]> {
  return allLedgerRows(db).then((rows) => rows.filter((row) => !before.has(row.id)));
}

function newPayments(
  db: Db,
  seller: SellerRef,
  before: ReadonlySet<string>,
): Promise<PaymentRow[]> {
  return listPaymentsForSeller(db, seller).then((rows) =>
    rows.filter((row) => !before.has(row.id)),
  );
}

async function swapByRef(db: Db, providerRef: string): Promise<SwapRow | null> {
  const rows = await allSwapRows(db);
  return rows.find((row) => row.providerRef === providerRef) ?? null;
}

/**
 * How many swaps this run did not create are waiting for a poll.
 *
 * The claim is the 25 oldest unclaimed rows (`FOR UPDATE ... SKIP LOCKED`), so on a
 * database with a long history of unfinished swaps this run's own swap would not be
 * reached, and the honest thing is to say so in the output rather than let the
 * assertion fail with a message about a state nobody polled.
 */
async function unclaimedForeignSwaps(db: Db): Promise<number> {
  const rows = await allSwapRows(db);
  return rows.filter(
    (row) => row.terminalAt === null && !row.providerRef.startsWith(`demo-swap-${RUN_ID}`),
  ).length;
}

/**
 * The deposit the provider saw, as the row D3 would write when it reports one.
 *
 * `state` starts at `pending` because the first status the poller gets back *is* the
 * transition (states.ts: `pending` reaches every other state), and `origin_tx_hash`
 * is left out because the hash is what the status reports, not what the row was
 * opened with — writing it here would let the demo pass by pre-linking the swap
 * instead of proving the poller links it.
 */
async function writeSwap(
  db: Db,
  seeded: { readonly routeId: string },
  statuses: DemoStatusSource,
  originTxHash: string,
  outcome: MockOutcome,
): Promise<string> {
  const providerRef = `demo-swap-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  statuses.script(providerRef, {
    outcome,
    amountIn: PRICED,
    originTxHash,
  });
  await db.insert(schema.swaps).values({
    routeId: seeded.routeId,
    providerRef,
    state: "pending",
    amountIn: PRICED.toString(),
    minAmountOut: PRICED.toString(),
    raw: { simulated: true, provider: "mock", outcome, note: "written by scripts/demo.ts" },
  });
  return providerRef;
}

/**
 * The shipped loop, run until this step's swap has been answered, then reconciled.
 *
 * That second half is E9's wiring, and the demo asserting a discrepancy right after
 * it is the proof the two loops are connected rather than merely both present.
 *
 * The loop is why this drives more than one pass. A pass claims the 25 oldest *due*
 * swaps, so on a database the suites have written to — every `swaps` row they leave
 * behind is a row A7's trigger forbids deleting — a single pass spends its whole
 * budget on rows this run did not create, and step 3 would fail on `state pending`
 * for a swap nobody polled. D10 makes each pass move that wall: an unanswered row is
 * rescheduled on the attempt-based gap rather than left due forever, so the backlog
 * drains 25 rows a pass and this run's swap is reached. The cap is the honest half:
 * past `MAX_DRIVE_PASSES` the assertions still fail, because a demo that polls
 * forever would hide a poller that never answers.
 */
const MAX_DRIVE_PASSES = 20;

async function drive(
  db: Db,
  statuses: DemoStatusSource,
  env: ReturnType<typeof loadEnv>,
  swapRef: string,
) {
  const config = reconcileConfigOf(env);
  let passes = 0;
  for (;;) {
    passes += 1;
    await pollTick({
      db,
      statusSource: statuses,
      pollSeconds: env.POLL_INTERVAL_SECONDS,
      maxBackoffSeconds: env.POLL_MAX_BACKOFF_SECONDS,
      config,
      log: gatewayLog.logger,
    });
    const row = await swapByRef(db, swapRef);
    if (row !== null && TERMINAL_STATES.some((state) => state === row.state)) {
      detail(`polled to a terminal state in ${String(passes)} ${passes === 1 ? "pass" : "passes"}`);
      return;
    }
    if (passes >= MAX_DRIVE_PASSES) {
      detail(
        `still unanswered after ${String(MAX_DRIVE_PASSES)} passes — the backlog ahead of this run is longer than ${String(MAX_DRIVE_PASSES * 25)} swaps`,
      );
      return;
    }
  }
}

function reconcileConfigOf(env: ReturnType<typeof loadEnv>) {
  return {
    sweepWindowSeconds: env.SWEEP_WINDOW_SECONDS,
    stuckWindowSeconds: env.STUCK_WINDOW_SECONDS,
    shortfallToleranceBps: env.SHORTFALL_TOLERANCE_BPS,
  };
}

/** The advertisement, out of the header the protocol carries it in. */
function decodeChallenge(response: Response): {
  readonly scheme: string;
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
} | null {
  const header = response.headers.get("payment-required");
  if (header === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const accepts = (parsed as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return null;
  }
  const first = accepts[0] as Record<string, unknown>;
  return {
    scheme: String(first.scheme ?? ""),
    network: String(first.network ?? ""),
    amount: String(first.amount ?? ""),
    asset: String(first.asset ?? ""),
    payTo: String(first.payTo ?? ""),
    maxTimeoutSeconds: Number(first.maxTimeoutSeconds ?? 0),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  runDemo()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
