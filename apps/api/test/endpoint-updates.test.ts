import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CreationCheck,
  type EndpointCreateInput,
  type EndpointUpdateInput,
  type PayoutRouteDto,
  baseUnitAmountSchema,
  endpointCreateSchema,
  endpointUpdateRequestSchema,
  endpointUpdateResponseSchema,
  newId,
  payoutRouteDtoSchema,
} from "@till/core";

import { findGatewayEndpoint } from "../src/db/queries/endpoints.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import { PAYMENT_REQUIRED_HEADER, createRequirementsCache } from "../src/gateway/requirements.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import type { PayoutProvider } from "../src/payouts/provider.ts";
import type { PrepareRouteInput, PreparedRoute } from "../src/payouts/provider.ts";
import { createEndpointRoutes } from "../src/routes/endpoints.ts";
import {
  type EndpointCreationDeps,
  type SellerIdentity,
  createEndpoint,
  listEndpoints,
  updateEndpoint,
} from "../src/services/endpoints.ts";
import { recordSettlement } from "../src/services/ledger.ts";
import { advancePayment, openPayment } from "../src/services/payments.ts";
import type { RoutePreparer } from "../src/services/payout-routes.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * D9 (PO-7): what a change to an endpoint's price or payout destination does, and what
 * it cannot do.
 *
 * The requirement is one sentence — *earlier payments keep their original amount and
 * route* — and it is proven against a real database rather than argued from the schema,
 * because the whole mechanism is a snapshot nobody is supposed to reach backwards
 * through: `payments` copies the price and the route from the advertisement at verify
 * time, `payout_routes` refuses an `UPDATE` (D5's trigger), and a change writes only to
 * `endpoints`. Three separate facts in three separate places, so the test reads all
 * three back after a change rather than trusting that they cannot be joined.
 *
 * The other half of the row is the *refusal*. D4's create leaves a failed endpoint
 * inactive with the reasons on the row; an edit has a live paywall to protect, so a
 * change whose checks do not all pass writes nothing and answers with the same list.
 * Both directions are tested, including the part that is easy to get wrong: a refused
 * change asks no provider (B12) and adds no route row.
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
    const [present] = await sql`select to_regclass('public.endpoints') as present`;
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

const PUBLIC = "93.184.216.34";
const run = randomUUID().slice(0, 8);

const SELLER_U: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d9-u-${run}.testnet`,
};
/** The seller that must not be able to reach `SELLER_U`'s rows. */
const SELLER_V: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d9-v-${run}.testnet`,
};
const SELLERS = [SELLER_U, SELLER_V] as const;
const REFUND = `till-d9-refund-${run}.testnet`;

let env: Env;

async function seed(): Promise<void> {
  const { sql } = need();
  env = loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: "x".repeat(32),
    GATEWAY_PUBLIC_URL: "https://gateway.test",
  });
  for (const seller of SELLERS) {
    await sql`insert into sellers (id, near_account_id, display_name)
      values (${seller.id}, ${seller.nearAccountId}, 'D9 fixture')
      on conflict (id) do nothing`;
  }
}

/**
 * A seller of one's own, for every test that counts route rows.
 *
 * D5 dedupes a standing route per seller *and* destination, so a shared fixture
 * seller would make one test's count include the endpoints another test created — and
 * the point of those assertions is how many rows *this* change wrote. The name is
 * unique per tag so the two reasons a route could be reused cannot be confused.
 */
async function addSeller(tag: string): Promise<SellerIdentity> {
  const seller: SellerIdentity = {
    id: randomUUID(),
    nearAccountId: `till-d9-${tag}-${run}.testnet`,
  };
  await need().sql`insert into sellers (id, near_account_id, display_name)
    values (${seller.id}, ${seller.nearAccountId}, 'D9 fixture')`;
  return seller;
}

/**
 * The counting preparer, for the reason D5 counted it: a change that reused the standing
 * route and a change that took a second quote look identical on the row and differ
 * entirely in what they cost.
 */
type PreparerSpy = RoutePreparer & { readonly asked: PrepareRouteInput[] };

function depositQuote(input: PrepareRouteInput): PreparedRoute {
  return {
    depositAddress: `dep-${run}-${input.destinationAddress}`,
    depositMemo: null,
    quoteRef: `quote-${run}-${input.destinationAddress}`,
    minAmountOut: null,
    deadlineAt: null,
    modeDetail: "standing",
  };
}

function preparer(answer?: (input: PrepareRouteInput) => PreparedRoute): PreparerSpy {
  const asked: PrepareRouteInput[] = [];
  return {
    asked,
    async prepareRoute(input) {
      asked.push(input);
      return (answer ?? depositQuote)(input);
    },
  };
}

function creationDeps(
  prep: PreparerSpy = preparer(),
  overrides: Partial<EndpointCreationDeps> = {},
): EndpointCreationDeps & { readonly prep: PreparerSpy } {
  return {
    prep,
    minPriceBaseUnits: 10_000n,
    network: "near:testnet",
    allowInsecureUpstream: false,
    gatewayOrigin: "https://gateway.test",
    gatewayPublicUrl: "https://gateway.test",
    payoutProvider: "mock",
    routePreparer: prep,
    storage: { read: async () => ({ supported: true, registered: true }) },
    resolve: async (hostname) => (hostname === "gateway.test" ? ["8.8.8.8"] : [PUBLIC]),
    slug: () => `d9-${randomUUID()}`,
    ...overrides,
  };
}

function createInput(
  seller: SellerIdentity = SELLER_U,
  overrides: Partial<Record<keyof EndpointCreateInput, unknown>> = {},
): EndpointCreateInput {
  return endpointCreateSchema.parse({
    upstreamUrl: "https://data.seller.test/prices",
    priceAmount: "10000",
    assetContract: "usdc.testnet",
    network: "near:testnet",
    payoutMode: "direct",
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: seller.nearAccountId,
    refundAddress: REFUND,
    ...overrides,
  });
}

/**
 * An intents endpoint on a destination named by the *test*, not by the run: one
 * destination is one standing route (D5), so two tests sharing a destination would
 * share a quote, and a count of asks or of route rows would then be measuring the
 * previous test rather than this one.
 */
function intentsInput(seller: SellerIdentity, tag: string): EndpointCreateInput {
  return createInput(seller, {
    payoutMode: "intents",
    destinationAddress: `dest-${tag}-${run}.testnet`,
  });
}

/**
 * A price as the boundary type wants it. `priceAmount` is a branded base-unit string,
 * and the schema that produces one is the only honest source — writing the literal as
 * `as EndpointCreateInput["priceAmount"]` would let a test assert against a value the
 * API could never receive.
 */
function amount(value: string): EndpointCreateInput["priceAmount"] {
  return baseUnitAmountSchema.parse(value);
}

function failedCodes(checks: readonly CreationCheck[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.code);
}

type UpdateResult = Awaited<ReturnType<typeof updateEndpoint>>;

/**
 * The checks a change answered with. `found: false` is a test failure rather than a
 * value to compare, and an assertion written as `result.found ? result.checks : []`
 * would pass on an empty list when the row was not found at all.
 */
function checksOf(result: UpdateResult): CreationCheck[] {
  if (!result.found) throw new Error("the change found no endpoint, and should have");
  return result.checks;
}

function endpointOf(result: UpdateResult) {
  if (!result.found) throw new Error("the change found no endpoint, and should have");
  return result.endpoint;
}

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

/**
 * One settled payment with its ledger lines, opened the way the gateway opens one:
 * through `openPayment` with the amount and route read off the advertisement, which is
 * the snapshot PO-7 is about, then advanced to `settled` the way the gateway's settle
 * step does it. The mode is the caller's because it decides whether the booking is one
 * line or two (D8).
 *
 * The advance is not decoration. A row left at `verified` while its ledger entries
 * exist contradicts an invariant another suite in this shared database relies on to
 * clean up after itself (C10's sweep deletes the stale `verified` rows it is about to
 * classify), and a payment that never settled is not the thing PO-7 is about anyway.
 */
async function settlePayment(
  seller: SellerIdentity,
  endpointId: string,
  routeId: string | null,
  amount: bigint,
  payer: string,
  payoutMode: "direct" | "intents",
): Promise<string> {
  const paymentId = newId();
  const opened = await openPayment(need().db, {
    id: paymentId,
    endpointId,
    routeId,
    payerAccountId: payer,
    amount,
    assetContract: "usdc.testnet",
    replayKey: `replay-${payer}`,
    delegateExpiresAt: null,
  });
  if (opened.kind !== "created" && opened.kind !== "retried") {
    throw new Error(`the payment refused to open: ${opened.kind}`);
  }
  await recordSettlement(
    need().db,
    { sellerId: seller.id, amount, asset: "usdc.testnet", paymentId, note: "d9 fixture" },
    payoutMode,
  );
  await advancePayment(need().db, paymentId, "settled", { nearTxHash: `tx-${paymentId}` });
  return paymentId;
}

async function paymentRow(paymentId: string) {
  const [row] = await need().sql`select amount, route_id, endpoint_id, state, asset_contract
    from payments where id = ${paymentId}`;
  if (row === undefined) throw new Error("the payment row is gone");
  return row as { amount: string; route_id: string | null; endpoint_id: string; state: string };
}

async function endpointRow(endpointId: string) {
  const [row] = await need().sql`select price_amount, route_id, active, creation_warnings,
      payout_mode, upstream_url, description, asset_contract, network
    from endpoints where id = ${endpointId}`;
  if (row === undefined) throw new Error("the endpoint row is gone");
  return row as {
    price_amount: string;
    route_id: string | null;
    active: boolean;
    creation_warnings: string[];
    payout_mode: string;
    upstream_url: string;
    description: string | null;
    asset_contract: string;
    network: string;
  };
}

async function routeRow(routeId: string): Promise<PayoutRouteDto> {
  const [row] = await need().sql`select id, destination_chain, destination_asset,
      destination_address, refund_address, provider, deposit_address, mode_detail
    from payout_routes where id = ${routeId}`;
  if (row === undefined) throw new Error(`route ${routeId} is gone`);
  // The columns are the database's names and the DTO is the contract's; reading the
  // row back through the schema is the point, so the mapping is spelled out rather
  // than the DTO being bent toward snake_case.
  return payoutRouteDtoSchema.parse({
    id: row.id,
    destinationChain: row.destination_chain,
    destinationAsset: row.destination_asset,
    destinationAddress: row.destination_address,
    refundAddress: row.refund_address,
    provider: row.provider,
    depositAddress: row.deposit_address,
    modeDetail: row.mode_detail,
  });
}

async function routeCount(sellerId: string): Promise<number> {
  const [row] = await need()
    .sql`select count(*)::int as n from payout_routes where seller_id = ${sellerId}`;
  return row?.n ?? -1;
}

async function ledgerLines(paymentId: string): Promise<string[]> {
  const rows = (await need().sql`select kind, amount from ledger_entries
    where payment_id = ${paymentId} order by kind`) as { kind: string; amount: string }[];
  return rows.map((row) => `${row.kind}:${row.amount}`);
}

/**
 * The 402 a payer would be handed for one slug, built from the gateway's own read of the
 * row (C4's join) — so an advertisement is checked against what the change wrote rather
 * than against a fixture that says the same thing.
 */
async function advertised(slug: string) {
  const row = await findGatewayEndpoint(need().db, slug);
  if (row === null) throw new Error(`the gateway cannot read slug ${slug}`);
  if (row.payoutMode !== "direct" && row.payoutMode !== "intents") {
    throw new Error(`unexpected payout mode on the row: ${JSON.stringify(row.payoutMode)}`);
  }
  const cache = createRequirementsCache({
    near: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
    network: "near:testnet",
    upstreamTimeoutMs: 15_000,
    authorizationExpiryMarginMs: 30_000,
    minPriceBaseUnits: 10_000n,
  });
  const { result } = cache.forEndpoint({
    endpointId: row.endpointId,
    network: row.network,
    assetContract: row.assetContract,
    priceAmount: row.priceAmount,
    payoutMode: row.payoutMode,
    sellerNearAccountId: row.sellerNearAccountId,
    routeDepositAddress: row.routeDepositAddress,
    gatewayUrl: `https://gateway.test/r/${row.slug}`,
    description: row.description,
  });
  if (!result.ok) {
    throw new Error(`the endpoint refuses to be advertised: ${result.reason}: ${result.detail}`);
  }
  return result;
}

/**
 * What a v2 client would decode out of the base64 `PAYMENT-REQUIRED` header — the wire
 * shape, not the in-memory object, because "the next payer is charged the new price" is
 * a claim about what leaves the process.
 */
async function termsAt(slug: string): Promise<{ amount: string; payTo: string }> {
  const result = await advertised(slug);
  const header = result.challenge.headers[PAYMENT_REQUIRED_HEADER];
  if (header === undefined) throw new Error("no PAYMENT-REQUIRED header was built");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepts: { payTo: string; amount: string }[];
  };
  const accept = decoded.accepts[0];
  if (accept === undefined) throw new Error("the advertisement carries no accept");
  return { amount: accept.amount, payTo: accept.payTo };
}

const suite = describe.skipIf(handle === null);

suite("a price change leaves the payments already made alone (D9, PO-7)", () => {
  beforeAll(seed);

  it("keeps an earlier payment's amount, route and ledger lines when the price changes", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    const endpointId = created.endpoint.id;
    const routeBefore = (await endpointRow(endpointId)).route_id as string;

    const paymentId = await settlePayment(
      SELLER_U,
      endpointId,
      routeBefore,
      10_000n,
      `payer-a-${run}.testnet`,
      "direct",
    );

    const changed = await updateEndpoint(need().db, deps, SELLER_U, endpointId, {
      priceAmount: amount("25000"),
    });
    expect(changed.found).toBe(true);
    if (!changed.found) return;
    expect(failedCodes(changed.checks)).toEqual([]);
    expect(changed.endpoint.priceAmount).toBe("25000");

    // The endpoint moved. Nothing else did.
    expect((await endpointRow(endpointId)).price_amount).toBe("25000");
    expect(await paymentRow(paymentId)).toMatchObject({
      amount: "10000",
      route_id: routeBefore,
      endpoint_id: endpointId,
    });
    expect(await ledgerLines(paymentId)).toEqual(["payment_in:10000", "payout_out:10000"]);
  });

  it("reuses the standing route for a price-only change and asks the provider for nothing", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    const routeBefore = (await endpointRow(created.endpoint.id)).route_id as string;
    const asksBefore = deps.prep.asked.length;
    const routesBefore = await routeCount(SELLER_U.id);

    const changed = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
      priceAmount: amount("30000"),
      upstreamUrl: "https://data.seller.test/v2",
    });
    expect(failedCodes(checksOf(changed))).toEqual([]);

    const after = await endpointRow(created.endpoint.id);
    expect(after.route_id).toBe(routeBefore);
    expect(after.upstream_url).toBe("https://data.seller.test/v2");
    expect(deps.prep.asked.length).toBe(asksBefore);
    expect(await routeCount(SELLER_U.id)).toBe(routesBefore);
  });

  it("refuses a change below the floor and writes nothing at all", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    const before = await endpointRow(created.endpoint.id);

    const refused = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
      priceAmount: amount("9999"),
    });
    expect(refused.found).toBe(true);
    if (!refused.found) return;
    expect(failedCodes(refused.checks)).toEqual(["price_floor"]);
    // The endpoint the response names is the one that is still live, not the one the
    // body asked for: `9999` here would be a lie about the terms.
    expect(refused.endpoint.priceAmount).toBe("10000");
    expect(refused.endpoint.active).toBe(true);

    expect(await endpointRow(created.endpoint.id)).toEqual(before);
    expect(deps.prep.asked.length).toBe(0);
    expect(await routeCount(SELLER_U.id)).toBe(1);
  });

  it("clears a description with null and keeps the fields the body did not name", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, {
      ...createInput(SELLER_U),
      description: "old price list",
    });
    expect((await endpointRow(created.endpoint.id)).description).toBe("old price list");

    const changed = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
      description: null,
    });
    expect(failedCodes(checksOf(changed))).toEqual([]);
    expect(endpointOf(changed).description).toBeNull();
    expect((await endpointRow(created.endpoint.id)).description).toBeNull();
    expect((await endpointRow(created.endpoint.id)).price_amount).toBe("10000");
  });

  it("lets a seller pause an endpoint whose terms pass, and the gateway stops reading it", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));

    const paused = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
      active: false,
    });
    expect(failedCodes(checksOf(paused))).toEqual([]);
    expect((await endpointRow(created.endpoint.id)).active).toBe(false);

    // The pause wrote the column the gateway's own join reads. What the gateway then
    // answers to a payer — the 404 — is C4's suite; `findGatewayEndpoint` deliberately
    // does not filter on `active`, so what is provable here is that the read sees a
    // paused row that still carries its price, and that pausing cost no new quote.
    const row = await findGatewayEndpoint(need().db, created.endpoint.slug);
    expect([row?.active, row?.priceAmount]).toEqual([false, "10000"]);
    expect(deps.prep.asked.length).toBe(0);
  });

  it("keeps a paused endpoint paused when the change it receives is a price", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, { active: false });

    const edited = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
      priceAmount: amount("20000"),
    });
    expect(failedCodes(checksOf(edited))).toEqual([]);
    // The change landed — the price moved — and it still did not open the paywall.
    // An edit that activated on the side would spend the seller's pause without them.
    expect((await endpointRow(created.endpoint.id)).active).toBe(false);
    expect(endpointOf(edited).active).toBe(false);
    expect((await endpointRow(created.endpoint.id)).price_amount).toBe("20000");

    // Naming `active` is the only way to make the endpoint live again.
    const opened = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
      active: true,
    });
    expect(failedCodes(checksOf(opened))).toEqual([]);
    expect((await endpointRow(created.endpoint.id)).active).toBe(true);
  });

  it("clears the reasons a failed create stored without turning the endpoint on", async () => {
    // D4 leaves an endpoint that failed its checks inactive with the reasons on the row.
    // Repairing those checks through the editor makes the reasons untrue, so they go;
    // but the seller opened the paywall's *absence* on purpose at creation, and only
    // the word `active` ends it (PO-2's `creationWarnings` means "why this is not live",
    // and after this change the answer is "because you said so").
    const seller = await addSeller("reopened");
    const deps = creationDeps();
    const broken = await createEndpoint(need().db, deps, seller, {
      ...intentsInput(seller, "reopened"),
      priceAmount: amount("9999"),
    });
    expect(broken.endpoint.active).toBe(false);
    expect((await endpointRow(broken.endpoint.id)).creation_warnings.length).toBeGreaterThan(0);

    const repaired = await updateEndpoint(need().db, deps, seller, broken.endpoint.id, {
      priceAmount: amount("20000"),
    });
    expect(failedCodes(checksOf(repaired))).toEqual([]);
    const row = await endpointRow(broken.endpoint.id);
    expect([row.price_amount, row.active, row.creation_warnings]).toEqual(["20000", false, []]);

    // And the address the route already holds is still the one advertised, once named.
    const opened = await updateEndpoint(need().db, deps, seller, broken.endpoint.id, {
      active: true,
    });
    expect(failedCodes(checksOf(opened))).toEqual([]);
    expect(deps.prep.asked.length).toBe(1);
    expect(await termsAt(broken.endpoint.slug)).toEqual({
      amount: "20000",
      payTo: `dep-${run}-dest-reopened-${run}.testnet`,
    });
  });
});

suite("a destination change is a new route, and only for payments after it (D9, PO-7)", () => {
  beforeAll(seed);

  it("moves the endpoint to a new route row while an earlier payment keeps the old one", async () => {
    const seller = await addSeller("moved");
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, seller, intentsInput(seller, "one"));
    const oldRouteId = (await endpointRow(created.endpoint.id)).route_id as string;
    const oldRoute = await routeRow(oldRouteId);

    const paymentId = await settlePayment(
      seller,
      created.endpoint.id,
      oldRouteId,
      10_000n,
      `payer-b-${run}.testnet`,
      "intents",
    );

    const changed = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      destinationAddress: `dest-moved-two-${run}.testnet`,
    });
    expect(changed.found).toBe(true);
    if (!changed.found) return;
    expect(failedCodes(changed.checks)).toEqual([]);

    const newRouteId = (await endpointRow(created.endpoint.id)).route_id as string;
    expect(newRouteId).not.toBe(oldRouteId);
    expect(await routeCount(seller.id)).toBe(2);

    // PO-7, read out of the rows: the payment still names the route it was opened on,
    // and that route still says where the money was going when it was.
    expect((await paymentRow(paymentId)).route_id).toBe(oldRouteId);
    expect(await routeRow(oldRouteId)).toEqual(oldRoute);
    expect((await routeRow(newRouteId)).destinationAddress).toBe(`dest-moved-two-${run}.testnet`);
    expect(await ledgerLines(paymentId)).toEqual(["payment_in:10000"]);
  });

  it("advertises the new price and the new deposit address to the next payer", async () => {
    const seller = await addSeller("advert");
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, seller, intentsInput(seller, "advert"));
    expect(await termsAt(created.endpoint.slug)).toEqual({
      amount: "10000",
      payTo: `dep-${run}-dest-advert-${run}.testnet`,
    });

    await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      priceAmount: amount("25000"),
      destinationAddress: `dest-advert-two-${run}.testnet`,
    });

    expect(await termsAt(created.endpoint.slug)).toEqual({
      amount: "25000",
      payTo: `dep-${run}-dest-advert-two-${run}.testnet`,
    });
  });

  it("asks no provider and writes no route for a destination whose shape is broken", async () => {
    const seller = await addSeller("broken");
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, seller, intentsInput(seller, "broken"));
    const routeBefore = (await endpointRow(created.endpoint.id)).route_id as string;
    const asksBefore = deps.prep.asked.length;

    const refused = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      destinationAddress: "Not A Near Account",
    });
    expect(refused.found).toBe(true);
    if (!refused.found) return;
    expect(failedCodes(refused.checks)).toEqual(["destination_address", "deposit_address"]);
    expect(refused.checks.at(-1)?.message).toContain("only once the destination itself is sound");

    // B12: an address the validator already refused is never carried to a quote, and a
    // refused change adds no row — the single standing route is still the creation's.
    expect(deps.prep.asked.length).toBe(asksBefore);
    expect(await routeCount(seller.id)).toBe(1);
    const after = await endpointRow(created.endpoint.id);
    expect(after.route_id).toBe(routeBefore);
    expect(after.price_amount).toBe("10000");
  });

  it("refuses an intents destination the provider will not quote, and keeps the old route", async () => {
    // The creation needs a quote to land at all, so only the *second* ask fails. That
    // is the shape of a provider that has capacity for one corridor and not the next.
    let asks = 0;
    const prep = preparer((input) => {
      asks += 1;
      if (asks === 1) return depositQuote(input);
      throw new Error("no capacity on that corridor");
    });
    const deps = creationDeps(prep);

    const seller = await addSeller("unquoted");
    const created = await createEndpoint(need().db, deps, seller, intentsInput(seller, "unquoted"));
    const routeBefore = (await endpointRow(created.endpoint.id)).route_id as string;

    const refused = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      destinationAddress: `dest-unquoted-two-${run}.testnet`,
    });
    expect(refused.found).toBe(true);
    if (!refused.found) return;
    expect(failedCodes(refused.checks)).toEqual(["deposit_address"]);
    expect(refused.checks.at(-1)?.message).toContain("no capacity on that corridor");
    // The seller is told the provider's own sentence, and the endpoint the response
    // names is still the one that is live on the old terms.
    expect(refused.endpoint.priceAmount).toBe("10000");
    expect(refused.endpoint.active).toBe(true);

    expect((await endpointRow(created.endpoint.id)).route_id).toBe(routeBefore);
    expect(await routeCount(seller.id)).toBe(1);
    expect(prep.asked.length).toBe(2);
  });

  it("asks the provider for nothing when a different field already refuses the change", async () => {
    // The destination here is perfectly sound, so the gate that protects B12 cannot be
    // the address validator: a quote taken for a change the price floor is going to
    // refuse anyway is a provider call paid for and an orphan route row left behind.
    const seller = await addSeller("unneeded");
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, seller, intentsInput(seller, "unneeded"));
    const routeId = (await endpointRow(created.endpoint.id)).route_id as string;

    const refused = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      destinationAddress: `dest-unneeded-two-${run}.testnet`,
      priceAmount: amount("9999"),
    });
    expect(failedCodes(checksOf(refused))).toEqual(["price_floor"]);
    expect(deps.prep.asked.length).toBe(1);
    expect(await routeCount(seller.id)).toBe(1);
    expect((await endpointRow(created.endpoint.id)).route_id).toBe(routeId);
  });

  it("will not let a price change stand in for the destination an endpoint never got", async () => {
    // The destination of an endpoint lives on its route row, not on the endpoint (D5).
    // A create whose destination was refused therefore leaves an endpoint with *no*
    // destination to merge onto, and the tempting bug is a price-only edit that reads
    // `""` for the chain, calls it sound and writes an active-looking endpoint nobody
    // can pay. The refusal has to name every field the seller is missing, which is
    // exactly the set the route row would have carried.
    const seller = await addSeller("routeless");
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, seller, {
      ...intentsInput(seller, "routeless"),
      destinationAddress: "Not A Near Account",
    });
    expect((await endpointRow(created.endpoint.id)).route_id).toBeNull();
    expect(created.endpoint.active).toBe(false);

    const priceOnly = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      priceAmount: amount("20000"),
    });
    expect(failedCodes(checksOf(priceOnly))).toEqual([
      "destination_chain",
      "refund_address",
      "deposit_address",
    ]);
    expect(deps.prep.asked.length).toBe(0);

    // Sent in full, the destination resolves — one ask, and the endpoint is still the
    // inactive one D4 wrote, because an edit does not decide liveness.
    const fixed = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      destinationChain: "near",
      destinationAsset: "usdc",
      destinationAddress: `dest-routeless-two-${run}.testnet`,
      refundAddress: REFUND,
    });
    expect(failedCodes(checksOf(fixed))).toEqual([]);
    expect(deps.prep.asked.length).toBe(1);
    const row = await endpointRow(created.endpoint.id);
    expect(row.route_id).not.toBeNull();
    expect(row.active).toBe(false);
    expect(await routeCount(seller.id)).toBe(1);
  });

  it("resolves a standing route when one account switches from direct to intents", async () => {
    const seller = await addSeller("switch");
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, seller, createInput(seller));
    const directRoute = await routeRow((await endpointRow(created.endpoint.id)).route_id as string);
    expect([directRoute.modeDetail, directRoute.depositAddress]).toEqual(["direct", null]);

    const changed = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
      payoutMode: "intents",
    });
    expect(failedCodes(checksOf(changed))).toEqual([]);

    // D5 keyed the route by `mode_detail`, so the direct row is not reused here and the
    // intents endpoint is never advertised a null pay-to.
    expect(deps.prep.asked.length).toBe(1);
    const expectedDeposit = `dep-${run}-${seller.nearAccountId}`;
    const newRoute = await routeRow((await endpointRow(created.endpoint.id)).route_id as string);
    expect([newRoute.modeDetail, newRoute.depositAddress]).toEqual(["standing", expectedDeposit]);
    expect((await termsAt(created.endpoint.slug)).payTo).toBe(expectedDeposit);
  });
});

suite("whose endpoint a change reaches (D9, PO-7)", () => {
  beforeAll(seed);

  it("answers not-found for another seller's endpoint and writes nothing", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    const before = await endpointRow(created.endpoint.id);

    const intruder = await updateEndpoint(
      need().db,
      creationDeps(),
      SELLER_V,
      created.endpoint.id,
      { priceAmount: amount("999999") },
    );
    expect(intruder).toEqual({ found: false });
    expect(await endpointRow(created.endpoint.id)).toEqual(before);

    // And with terms that would have been refused anyway: the scoping is what answers,
    // so a stranger cannot read another seller's price back out of a check list either.
    const probe = await updateEndpoint(need().db, creationDeps(), SELLER_V, created.endpoint.id, {
      priceAmount: amount("9999"),
    });
    expect(probe).toEqual({ found: false });
  });

  it("cannot be told to move the endpoint, its slug or its token", async () => {
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));

    for (const field of ["id", "slug", "sellerId", "routeId", "network", "assetContract"]) {
      const parsed = endpointUpdateRequestSchema.safeParse({ priceAmount: "20000", [field]: "x" });
      expect([field, parsed.success]).toEqual([field, false]);
    }

    // Refused at the boundary, so the service never sees a token swap: the row keeps the
    // contract it was created on.
    const changed = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
      priceAmount: amount("20000"),
    } satisfies EndpointUpdateInput);
    expect(changed.found).toBe(true);
    expect((await endpointRow(created.endpoint.id)).price_amount).toBe("20000");
    expect((await endpointRow(created.endpoint.id)).asset_contract).toBe("usdc.testnet");
  });
});

const claims: SessionClaims = { sellerId: SELLER_U.id, nearAccountId: SELLER_U.nearAccountId };

function routeApp(deps: EndpointCreationDeps & { readonly prep: PreparerSpy }) {
  const provider = (): PayoutProvider => ({
    prepareRoute: (input) => deps.routePreparer.prepareRoute(input),
    getStatus: async () => {
      throw new Error("the D9 route tests never poll a swap");
    },
    listAssets: async () => [],
  });
  return createEndpointRoutes({
    db: need().db,
    env,
    log: quiet,
    session: async () => claims,
    storage: deps.storage,
    // `exactOptionalPropertyTypes` refuses an explicit `undefined` for an optional
    // field, and the creation deps may legitimately not carry a resolver.
    ...(deps.resolve === undefined ? {} : { resolve: deps.resolve }),
    provider,
  });
}

suite("PATCH /api/endpoints/:id (D9, the edit step)", () => {
  beforeAll(seed);

  it("answers 401 without a session", async () => {
    const app = createEndpointRoutes({ db: need().db, env, log: quiet, session: async () => null });
    const res = await app.request(`/endpoints/${randomUUID()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "20000" }),
    });
    expect(res.status).toBe(401);
  });

  it("refuses a body that changes nothing, and one that names an un-editable field", async () => {
    const deps = creationDeps();
    const app = routeApp(deps);
    const endpoint = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));

    const empty = await app.request(`/endpoints/${endpoint.endpoint.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { code: string }).code).toBe("invalid_request");

    const hostile = await app.request(`/endpoints/${endpoint.endpoint.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "20000", assetContract: "other-token.testnet" }),
    });
    expect(hostile.status).toBe(400);
    const body = (await hostile.json()) as { issues: { path: string; code: string }[] };
    // The offending key is named where a UI can put it next to the input it came from.
    expect(body.issues[0]).toEqual({ path: "assetContract", code: "unrecognized_keys" });
    expect((await endpointRow(endpoint.endpoint.id)).price_amount).toBe("10000");
  });

  it("refuses a new destination the caller did not echo, and writes nothing", async () => {
    const deps = creationDeps();
    const app = routeApp(deps);
    const endpoint = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    const before = await endpointRow(endpoint.endpoint.id);

    const res = await app.request(`/endpoints/${endpoint.endpoint.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destinationAddress: `moved-${run}.testnet` }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; destinationAddress?: string };
    expect(body.code).toBe("destination_not_confirmed");
    expect(body.destinationAddress).toBe(`moved-${run}.testnet`);
    expect(await endpointRow(endpoint.endpoint.id)).toEqual(before);
    expect(deps.prep.asked.length).toBe(0);
  });

  it("answers 422 for an id that is not one, and 404 for one that is not the seller's", async () => {
    const app = routeApp(creationDeps());
    const malformed = await app.request("/endpoints/not-a-uuid", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "20000" }),
    });
    expect(malformed.status).toBe(422);

    const stranger = await app.request(`/endpoints/${randomUUID()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "20000" }),
    });
    expect(stranger.status).toBe(404);
    expect(((await stranger.json()) as { code: string }).code).toBe("endpoint_not_found");
  });

  it("answers 200 with the endpoint and every check, parsed by the shared contract", async () => {
    const deps = creationDeps();
    const app = routeApp(deps);
    const endpoint = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));

    const res = await app.request(`/endpoints/${endpoint.endpoint.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "40000" }),
    });
    expect(res.status).toBe(200);
    const parsed = endpointUpdateResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.endpoint.priceAmount).toBe("40000");
    expect(failedCodes(parsed.data.checks)).toEqual([]);
    expect(parsed.data.checks.map((check) => check.code)).toContain("price_floor");
  });

  it("answers 422 with the reasons when the change does not land, and the row is unchanged", async () => {
    const deps = creationDeps();
    const app = routeApp(deps);
    const endpoint = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    const before = await endpointRow(endpoint.endpoint.id);

    const res = await app.request(`/endpoints/${endpoint.endpoint.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priceAmount: "1" }),
    });
    expect(res.status).toBe(422);
    const parsed = endpointUpdateResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(failedCodes(parsed.data.checks)).toEqual(["price_floor"]);
    expect(parsed.data.endpoint.priceAmount).toBe("10000");

    expect(await endpointRow(endpoint.endpoint.id)).toEqual(before);
    expect(deps.prep.asked.length).toBe(0);
  });
});

suite("what this file cannot show (D9)", () => {
  beforeAll(seed);

  it("keeps a payment's amount a stored fact, not a value read back through the endpoint", async () => {
    // The snapshot is the guarantee, so the tempting failure is a read that joins
    // `endpoints.price_amount` and quietly re-prices history. Re-reading a payment
    // through the dashboard's own query is F3's suite; what is cheap and worth pinning
    // here is that three landed changes move nothing on the payment row.
    const deps = creationDeps();
    const created = await createEndpoint(need().db, deps, SELLER_U, createInput(SELLER_U));
    const routeId = (await endpointRow(created.endpoint.id)).route_id as string;
    const paymentId = await settlePayment(
      SELLER_U,
      created.endpoint.id,
      routeId,
      10_000n,
      `payer-c-${run}.testnet`,
      "direct",
    );
    const before = await paymentRow(paymentId);

    for (const price of ["20000", "50000", "80000"]) {
      const changed = await updateEndpoint(need().db, deps, SELLER_U, created.endpoint.id, {
        priceAmount: amount(price),
      });
      expect(failedCodes(checksOf(changed))).toEqual([]);
    }

    expect(await paymentRow(paymentId)).toEqual(before);
    expect((await endpointRow(created.endpoint.id)).price_amount).toBe("80000");
  });
});

suite(
  "the endpoint the dashboard reads carries the route it pays out through (F2, PO-7's edit step)",
  () => {
    beforeAll(seed);

    it("answers a create with the destination it resolved and the address it advertises", async () => {
      // D5 put these four columns on the route and nowhere else, so the DTO either
      // carries the row or the seller's editor has nothing to show — and D9 refuses a
      // `PATCH` whose `confirmedAddress` does not echo what was shown.
      const seller = await addSeller("dtointents");
      const deps = creationDeps();
      const input = intentsInput(seller, "dto-intents");
      const created = await createEndpoint(need().db, deps, seller, input);

      const routeId = (await endpointRow(created.endpoint.id)).route_id;
      expect(routeId).not.toBeNull();
      // The DTO's route is the row, field for field, read back from the database.
      expect(created.endpoint.route).toEqual(await routeRow(routeId as string));
      expect(created.endpoint.route?.destinationAddress).toBe(input.destinationAddress);
      // And nothing the seller has no use for came along with it: the quote reference,
      // the memo, the deadline and the seller id are Till's columns, not the form's.
      expect(Object.keys(created.endpoint.route ?? {}).sort()).toEqual(
        [
          "depositAddress",
          "destinationAddress",
          "destinationAsset",
          "destinationChain",
          "id",
          "modeDetail",
          "provider",
          "refundAddress",
        ].sort(),
      );
    });

    it("answers a create that never got a route with the null that says so", async () => {
      // A destination whose shape is broken writes no route (B12), so the honest answer
      // is "there is no address yet" rather than an empty string an editor could echo.
      const seller = await addSeller("dto_noroute");
      const deps = creationDeps();
      const created = await createEndpoint(
        need().db,
        deps,
        seller,
        createInput(seller, { payoutMode: "intents", destinationAddress: "not an account" }),
      );

      expect(failedCodes(created.checks)).toContain("destination_address");
      expect(created.endpoint.route).toBeNull();
      expect((await endpointRow(created.endpoint.id)).route_id).toBeNull();
      expect(await routeCount(seller.id)).toBe(0);
    });

    it("lists every endpoint with its own route, in the one read the page makes", async () => {
      const seller = await addSeller("dtolist");
      const deps = creationDeps();
      const direct = await createEndpoint(need().db, deps, seller, createInput(seller));
      const intents = await createEndpoint(
        need().db,
        deps,
        seller,
        intentsInput(seller, "dto-list"),
      );

      const listed = await listEndpoints(need().db, deps, seller.id);
      expect(listed.map((endpoint) => endpoint.slug)).toEqual([
        intents.endpoint.slug,
        direct.endpoint.slug,
      ]);

      const bySlug = new Map(listed.map((endpoint) => [endpoint.slug, endpoint]));
      const listedDirect = bySlug.get(direct.endpoint.slug);
      const listedIntents = bySlug.get(intents.endpoint.slug);
      expect(listedDirect?.route).toEqual(
        await routeRow((await endpointRow(direct.endpoint.id)).route_id as string),
      );
      expect(listedIntents?.route).toEqual(
        await routeRow((await endpointRow(intents.endpoint.id)).route_id as string),
      );
      // `direct` has no address to advertise (PO-6) and the list says so rather than
      // dropping the row or inventing an account.
      expect(listedDirect?.route?.depositAddress).toBeNull();
      expect(listedDirect?.route?.modeDetail).toBe("direct");
      expect(listedIntents?.route?.depositAddress).not.toBeNull();
    });

    it("answers a landed destination change with the route the next payment will use", async () => {
      const seller = await addSeller("dtolanded");
      const deps = creationDeps();
      const created = await createEndpoint(
        need().db,
        deps,
        seller,
        intentsInput(seller, "dto-new"),
      );
      const oldRouteId = (await endpointRow(created.endpoint.id)).route_id as string;
      const routeBefore = await routeRow(oldRouteId);

      const moved = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
        destinationAddress: `dto-moved-${run}.testnet`,
      });
      expect(failedCodes(checksOf(moved))).toEqual([]);

      const newRouteId = (await endpointRow(created.endpoint.id)).route_id as string;
      expect(newRouteId).not.toBe(oldRouteId);
      expect(endpointOf(moved).route).toEqual(await routeRow(newRouteId));
      expect(endpointOf(moved).route?.destinationAddress).toBe(`dto-moved-${run}.testnet`);
      // The old row is still exactly what it was: the endpoint moved, the route did not.
      expect(await routeRow(oldRouteId)).toEqual(routeBefore);
    });

    it("answers a refused change with the destination the endpoint still pays out to", async () => {
      // The one that decides what the form shows after a 422. If the DTO carried the
      // *proposed* route, the seller's next submission would echo an address that is not
      // live, and the address they were charged for is not the one money will reach.
      const seller = await addSeller("dtorefused");
      const deps = creationDeps();
      const input = intentsInput(seller, "dto-refused");
      const created = await createEndpoint(need().db, deps, seller, input);
      const routeId = (await endpointRow(created.endpoint.id)).route_id as string;

      const refused = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
        destinationAddress: `dto-unreachable-${run}.testnet`,
        priceAmount: amount("1"),
      });
      expect(failedCodes(checksOf(refused))).toContain("price_floor");
      expect(endpointOf(refused).route).toEqual(await routeRow(routeId));
      expect(endpointOf(refused).route?.destinationAddress).toBe(input.destinationAddress);
      expect(endpointOf(refused).priceAmount).toBe("10000");
      // No second row for the destination that was never written, and no quote spent.
      expect(await routeCount(seller.id)).toBe(1);
      expect(deps.prep.asked.length).toBe(1);
    });

    it("keeps a price-only change on the same route id, so the echo still matches the row", async () => {
      const seller = await addSeller("dtosame");
      const deps = creationDeps();
      const created = await createEndpoint(
        need().db,
        deps,
        seller,
        intentsInput(seller, "dto-same"),
      );
      const routeId = (await endpointRow(created.endpoint.id)).route_id as string;

      const changed = await updateEndpoint(need().db, deps, seller, created.endpoint.id, {
        priceAmount: amount("25000"),
      });
      expect(failedCodes(checksOf(changed))).toEqual([]);
      expect(endpointOf(changed).route?.id).toBe(routeId);
      // One destination is one standing route (D5): a price is not a new destination, so
      // a price change asks the provider for nothing on the way to handing the row back.
      expect(deps.prep.asked.length).toBe(1);
      expect(await routeCount(seller.id)).toBe(1);
    });
  },
);

afterAll(async () => {
  // No deletes: `ledger_entries` refuses them (A7's append-only trigger) and this run's
  // rows are named by fresh uuidv7 ids, so they collide with nothing. The same reason
  // `payments.test.ts` only closes its connection.
  if (handle !== null) {
    await handle.sql.end({ timeout: 5 });
  }
});
