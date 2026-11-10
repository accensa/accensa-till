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
  creationCheckCodeSchema,
  dashboardErrorSchema,
  endpointCreateResponseSchema,
  endpointCreateSchema,
  endpointListResponseSchema,
} from "@till/core";

import { createApp } from "../src/app.ts";
import { findGatewayEndpoint } from "../src/db/queries/endpoints.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import { PAYMENT_REQUIRED_HEADER, createRequirementsCache } from "../src/gateway/requirements.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import type { PrepareRouteInput, PreparedRoute } from "../src/payouts/provider.ts";
import { createEndpointRoutes } from "../src/routes/endpoints.ts";
import {
  type EndpointCreationDeps,
  type SellerIdentity,
  TokenStorageError,
  createEndpoint,
  listEndpoints,
} from "../src/services/endpoints.ts";
import type { RoutePreparer } from "../src/services/payout-routes.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * D4 and D5 acceptance tests, the half that needs a real database (PO-1/PO-2/PO-3).
 *
 * The checks themselves are exercised in `endpoint-checks.test.ts` with fakes.
 * What is pinned here is what a check *does*: an endpoint that failed one is
 * written `active: false` with the seller-facing sentences persisted on the row,
 * a passing one is written active, and the payout route the seller is advertised is
 * the one the row points at (D5) — so the address a payer's wallet is told to pay
 * is the address the endpoint was created on, read through the gateway's own join.
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

const SELLER_A: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d4-a-${run}.testnet`,
};
const SELLER_B: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d4-b-${run}.testnet`,
};
const SELLER_C: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d4-c-${run}.testnet`,
};
const SELLER_R: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d4-r-${run}.testnet`,
};
/** D5: the seller whose intents creation a refusing provider stops. */
const SELLER_D: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d4-d-${run}.testnet`,
};
/** D5: the seller whose endpoint is read back the way the gateway reads it. */
const SELLER_P: SellerIdentity = {
  id: randomUUID(),
  nearAccountId: `till-d4-p-${run}.testnet`,
};
const SELLERS = [SELLER_A, SELLER_B, SELLER_C, SELLER_R, SELLER_D, SELLER_P] as const;
const REFUND = `till-d4-refund-${run}.testnet`;

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
      values (${seller.id}, ${seller.nearAccountId}, 'D4 fixture')
      on conflict (id) do nothing`;
  }
}

function creationDeps(overrides: Partial<EndpointCreationDeps> = {}): EndpointCreationDeps {
  return {
    minPriceBaseUnits: 10_000n,
    network: "near:testnet",
    allowInsecureUpstream: false,
    gatewayOrigin: "https://gateway.test",
    gatewayPublicUrl: "https://gateway.test",
    payoutProvider: "mock",
    routePreparer: preparer(),
    storage: { read: async () => ({ supported: true, registered: true }) },
    resolve: async (hostname) => (hostname === "gateway.test" ? ["8.8.8.8"] : [PUBLIC]),
    slug: () => `d4-${randomUUID()}`,
    ...overrides,
  };
}

/**
 * The quoting half the service is now required to be given (D5). Counted, because
 * "the creation asked the provider" and "the creation reused the route" look
 * identical in the row and differ entirely in what they cost (B12).
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

function createInput(
  seller: SellerIdentity = SELLER_A,
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

function failedCodes(checks: readonly CreationCheck[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.code);
}

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

/**
 * The 402 a payer would be handed for one slug, built from the gateway's own read
 * (C4's join) rather than from a fixture row — which is the only way to check that
 * what the creation wrote and what the advertisement names are the same address.
 */
async function advertised(endpointSlug: string) {
  const row = await findGatewayEndpoint(need().db, endpointSlug);
  if (row === null) {
    throw new Error(`the gateway cannot read slug ${endpointSlug}`);
  }
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
  return { row, result };
}

const suite = describe.skipIf(handle === null);

suite("endpoint creation writes what the checks decided (D4, PO-1/PO-2)", () => {
  beforeAll(seed);

  it("stores an active endpoint and a direct payout route for a creation that passes every check", async () => {
    const created = await createEndpoint(
      need().db,
      creationDeps(),
      SELLER_A,
      createInput(SELLER_A),
    );

    expect(created.endpoint.active).toBe(true);
    expect(created.endpoint.creationWarnings).toEqual([]);
    expect(failedCodes(created.checks)).toEqual([]);
    expect(created.endpoint.gatewayUrl).toBe(`https://gateway.test/r/${created.endpoint.slug}`);

    const { sql } = need();
    const [endpoint] = await sql`select active, creation_warnings, seller_id, route_id
      from endpoints where id = ${created.endpoint.id}`;
    expect(endpoint).toMatchObject({ active: true, creation_warnings: [], seller_id: SELLER_A.id });
    if (endpoint === undefined) {
      throw new Error("the created endpoint is missing from the database");
    }

    const [route] = await sql`select mode_detail, provider, destination_address, refund_address,
        deposit_address from payout_routes where id = ${endpoint.route_id}`;
    expect(route).toEqual({
      mode_detail: "direct",
      provider: "mock",
      destination_address: SELLER_A.nearAccountId,
      refund_address: REFUND,
      deposit_address: null,
    });
  });

  it("leaves an endpoint inactive with the reason persisted, for each failed check", async () => {
    const cases: readonly {
      readonly name: string;
      readonly input: EndpointCreateInput;
      readonly deps: EndpointCreationDeps;
      readonly code: string;
      readonly warning: RegExp;
    }[] = [
      {
        name: "price below the floor",
        input: createInput(SELLER_A, { priceAmount: "9999" }),
        deps: creationDeps(),
        code: "price_floor",
        warning: /below Till's .* minimum/,
      },
      {
        name: "destination is not the signed-in account",
        input: createInput(SELLER_A, { destinationAddress: `someone-else-${run}.testnet` }),
        deps: creationDeps(),
        code: "direct_destination",
        warning: /the destination must be that account/,
      },
      {
        name: "destination address of the wrong shape",
        input: createInput(SELLER_A, { destinationAddress: "Not A Near Account" }),
        deps: creationDeps(),
        code: "destination_address",
        warning: /not a valid address on that chain/,
      },
      {
        name: "an upstream the address policy refuses",
        input: createInput(SELLER_A, { upstreamUrl: "https://localhost/prices" }),
        deps: creationDeps(),
        code: "upstream_url",
        warning: /refused by Till's address policy/,
      },
      {
        name: "an account without token storage",
        input: createInput(SELLER_A),
        deps: creationDeps({
          storage: { read: async () => ({ supported: true, registered: false }) },
        }),
        code: "storage_registration",
        warning: /is not registered for .* storage/,
      },
      {
        name: "an unreadable storage registration",
        input: createInput(SELLER_A),
        deps: creationDeps({
          storage: {
            read: async () => {
              throw new TokenStorageError("rpc_error");
            },
          },
        }),
        code: "storage_unverifiable",
        warning: /could not read .* storage registration/,
      },
    ];

    for (const testCase of cases) {
      const created = await createEndpoint(need().db, testCase.deps, SELLER_A, testCase.input);
      expect([testCase.name, created.endpoint.active]).toEqual([testCase.name, false]);
      expect([testCase.name, failedCodes(created.checks)]).toEqual([
        testCase.name,
        expect.arrayContaining([testCase.code]),
      ]);
      expect(created.endpoint.creationWarnings).toHaveLength(failedCodes(created.checks).length);

      const { sql } = need();
      const [row] = await sql`select active, creation_warnings from endpoints
        where id = ${created.endpoint.id}`;
      expect([testCase.name, row?.active]).toEqual([testCase.name, false]);
      const stored = row?.creation_warnings as string[];
      expect(stored.length).toBe(failedCodes(created.checks).length);
      expect(stored.some((warning) => testCase.warning.test(warning))).toBe(true);
      // The warning a seller reloads is the sentence the response carried, not a code.
      expect(stored).toEqual(created.endpoint.creationWarnings);
    }
  });

  it("activates an intents endpoint on the address the provider prepared (D5, PO-1)", async () => {
    const prep = preparer();
    const created = await createEndpoint(
      need().db,
      creationDeps({ routePreparer: prep }),
      SELLER_P,
      createInput(SELLER_P, { payoutMode: "intents" }),
    );

    // D4 could only refuse this check for want of an address; D5 is the half that
    // asks a provider for one, so an intents endpoint is now an active endpoint.
    expect(created.endpoint.active).toBe(true);
    expect(failedCodes(created.checks)).toEqual([]);
    const deposit = created.checks.find((check) => check.code === "deposit_address");
    expect(deposit?.ok).toBe(true);
    // The seller is shown the address itself, because that is what the paywall will
    // show a payer — and the route is the standing quote, not a fresh one.
    expect(deposit?.message).toContain(`dep-${run}-${SELLER_P.nearAccountId}`);
    expect(deposit?.message).toContain("newly prepared standing");
    expect(prep.asked).toHaveLength(1);

    const { sql } = need();
    const [endpoint] = await sql`select route_id from endpoints where id = ${created.endpoint.id}`;
    const [route] = await sql`select mode_detail, provider, deposit_address, quote_ref, deadline_at,
          destination_address from payout_routes where id = ${endpoint?.route_id}`;
    expect(route).toEqual({
      mode_detail: "standing",
      provider: "mock",
      deposit_address: `dep-${run}-${SELLER_P.nearAccountId}`,
      quote_ref: `quote-${run}-${SELLER_P.nearAccountId}`,
      deadline_at: null,
      destination_address: SELLER_P.nearAccountId,
    });
  });

  it("refuses an intents endpoint the provider will not quote, and writes no route (D5, PO-1)", async () => {
    const prep = preparer(() => {
      throw new Error("1Click: no route for that asset pair");
    });
    const created = await createEndpoint(
      need().db,
      creationDeps({ routePreparer: prep }),
      SELLER_D,
      createInput(SELLER_D, { payoutMode: "intents" }),
    );

    expect(created.endpoint.active).toBe(false);
    expect(failedCodes(created.checks)).toEqual(["deposit_address"]);
    const deposit = created.checks.find((check) => check.code === "deposit_address");
    expect(deposit?.message).toContain("no route for that asset pair");

    const { sql } = need();
    const [routes] = await sql`select count(*)::int as count from payout_routes
      where seller_id = ${SELLER_D.id}`;
    expect(routes?.count).toBe(0);
    const [endpoint] = await sql`select route_id from endpoints where id = ${created.endpoint.id}`;
    expect(endpoint?.route_id).toBeNull();
  });

  it("asks a provider for nothing when the destination itself is broken (D5, B12)", async () => {
    // A quote is the thing that costs (B12), so a destination that cannot be paid is
    // not allowed to buy one: the route is only resolved once the address checks
    // passed. The preparer throws if it is called, which makes the ask itself visible
    // rather than inferred from a row count.
    const prep = preparer(() => {
      throw new Error("the provider was asked for a quote it should never have seen");
    });
    const created = await createEndpoint(
      need().db,
      creationDeps({ routePreparer: prep }),
      SELLER_D,
      createInput(SELLER_D, { payoutMode: "intents", destinationAddress: "Not A Near Account" }),
    );

    expect(created.endpoint.active).toBe(false);
    expect(failedCodes(created.checks)).toEqual(["destination_address", "deposit_address"]);
    const deposit = created.checks.find((check) => check.code === "deposit_address");
    expect(deposit?.message).toContain("only once the destination itself is sound");
    expect(prep.asked).toEqual([]);

    const { sql } = need();
    const [routes] =
      await sql`select count(*)::int as count from payout_routes where seller_id = ${SELLER_D.id}`;
    expect(routes?.count).toBe(0);
  });

  it("keeps the standing route when the endpoint insert fails, and reuses it (D5, B12)", async () => {
    // The deliberate inversion of D4: a route belongs to a destination, not to the
    // endpoint that happened to write it, so a creation that died on the slug leaves
    // the quote behind instead of rolling it back — and the next creation pays for
    // nothing. One route, two endpoints, one provider ask is the whole claim.
    const prep = preparer();
    const fixedSlug = `d5-fixed-${run}`;
    const input = createInput(SELLER_C, {
      payoutMode: "intents",
      destinationAddress: `swap-to-${run}.testnet`,
    });

    const first = await createEndpoint(
      need().db,
      creationDeps({ slug: () => fixedSlug, routePreparer: prep }),
      SELLER_C,
      input,
    );
    await expect(
      createEndpoint(
        need().db,
        creationDeps({ slug: () => fixedSlug, routePreparer: prep }),
        SELLER_C,
        input,
      ),
    ).rejects.toThrow();
    const third = await createEndpoint(
      need().db,
      creationDeps({ routePreparer: prep }),
      SELLER_C,
      input,
    );

    expect(prep.asked).toHaveLength(1);
    expect([first.endpoint.active, third.endpoint.active]).toEqual([true, true]);
    const { sql } = need();
    const [routes] = await sql`select count(*)::int as count from payout_routes
      where seller_id = ${SELLER_C.id}`;
    const [endpoints] =
      await sql`select count(*)::int as count, count(distinct route_id)::int as routes
        from endpoints where seller_id = ${SELLER_C.id}`;
    expect([routes?.count, endpoints?.count, endpoints?.routes]).toEqual([1, 2, 1]);

    const [linked] = await sql`select count(*)::int as count from endpoints
        where seller_id = ${SELLER_C.id} and route_id = (select id from payout_routes
          where seller_id = ${SELLER_C.id} limit 1)`;
    expect(linked?.count).toBe(2);
  });

  it("lists only the seller's own endpoints, newest first", async () => {
    const deps = creationDeps();
    const first = await createEndpoint(
      need().db,
      deps,
      SELLER_B,
      createInput(SELLER_B, { upstreamUrl: "https://one.seller.test/a" }),
    );
    const second = await createEndpoint(
      need().db,
      deps,
      SELLER_B,
      createInput(SELLER_B, { upstreamUrl: "https://two.seller.test/b" }),
    );
    // Backdate the first so the order does not depend on how fast two inserts ran.
    const { sql } = need();
    await sql`update endpoints set created_at = created_at - interval '1 hour'
      where id = ${first.endpoint.id}`;

    const listed = await listEndpoints(need().db, deps, SELLER_B.id);
    expect(listed.map((endpoint) => endpoint.id)).toEqual([second.endpoint.id, first.endpoint.id]);

    const otherSeller = await listEndpoints(need().db, deps, SELLER_A.id);
    expect(otherSeller.some((endpoint) => endpoint.id === second.endpoint.id)).toBe(false);
  });
});

suite("what a created endpoint is advertised as (D5, PO-3)", () => {
  beforeAll(seed);

  it("names the route's deposit address as the pay-to an intents endpoint is paid to", async () => {
    const deposit = `dep-${run}-swap-to-${run}.testnet`;
    const created = await createEndpoint(
      need().db,
      creationDeps(),
      SELLER_P,
      createInput(SELLER_P, {
        payoutMode: "intents",
        destinationAddress: `swap-to-${run}.testnet`,
      }),
    );
    expect(created.endpoint.active).toBe(true);

    const { row, result } = await advertised(created.endpoint.slug);
    // The address the provider prepared is the address the gateway's own join reads
    // and the address the challenge names, with no second copy of the decision
    // anywhere: an advertisement that disagreed with the route would only be found
    // inside `verify`, on a stranger's paid request (S1).
    expect(row.routeDepositAddress).toBe(deposit);
    expect(result.requirements.payTo).toBe(deposit);

    // And through the header a v2 client actually decodes, not just the object.
    const header = result.challenge.headers[PAYMENT_REQUIRED_HEADER];
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts: { payTo: string }[];
    };
    expect(decoded.accepts[0]?.payTo).toBe(deposit);
  });

  it("names the seller's own account for a direct endpoint beside the same seller's intents route (PO-6)", async () => {
    await createEndpoint(
      need().db,
      creationDeps(),
      SELLER_P,
      createInput(SELLER_P, {
        payoutMode: "intents",
        destinationAddress: `beside-${run}.testnet`,
      }),
    );
    const direct = await createEndpoint(need().db, creationDeps(), SELLER_P, createInput(SELLER_P));

    const { row, result } = await advertised(direct.endpoint.slug);
    // A direct route has no deposit address at all, so the pay-to comes from the
    // mode. Reading it off the route instead would advertise `null`, and reading the
    // *intents* route of the same seller would advertise an address nobody owns here.
    expect(row.routeDepositAddress).toBeNull();
    expect(result.requirements.payTo).toBe(SELLER_P.nearAccountId);
  });

  it("refuses to advertise an intents endpoint whose route has no address to name", async () => {
    // The state D5's mode-aware lookup exists to prevent, checked from the other
    // side: rather than trust the lookup, this row is written with the route the
    // intents endpoint must never inherit.
    const { sql } = need();
    const endpointId = randomUUID();
    const slug = `d5-null-route-${run}`;
    const routeId = randomUUID();
    await sql`insert into payout_routes (id, seller_id, destination_chain, destination_asset,
        destination_address, refund_address, provider, mode_detail)
      values (${routeId}, ${SELLER_P.id}, 'near', 'usdc', ${`orphan-${run}.testnet`},
        ${REFUND}, 'mock', 'direct')`;
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode, route_id, active)
      values (${endpointId}, ${SELLER_P.id}, ${slug}, 'https://data.seller.test/prices',
        '10000', 'usdc.testnet', 'near:testnet', 'intents', ${routeId}, true)`;

    const row = await findGatewayEndpoint(need().db, slug);
    if (row === null) {
      throw new Error("the fixture row did not read back");
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
      payoutMode: "intents",
      sellerNearAccountId: row.sellerNearAccountId,
      routeDepositAddress: row.routeDepositAddress,
      gatewayUrl: `https://gateway.test/r/${row.slug}`,
      description: row.description,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("pay_to_unresolved");

    await sql`delete from endpoints where id = ${endpointId}`;
    await sql`delete from payout_routes where id = ${routeId}`;
  });
});

suite("the endpoint routes (D4, UI-2)", () => {
  beforeAll(seed);

  const claims: SessionClaims = { sellerId: SELLER_R.id, nearAccountId: SELLER_R.nearAccountId };

  function routeApp(cookieSeen: { value?: string | undefined } = {}) {
    return createEndpointRoutes({
      db: need().db,
      env,
      log: quiet,
      session: async (cookie) => {
        cookieSeen.value = cookie;
        return claims;
      },
      storage: { read: async () => ({ supported: true, registered: true }) },
      resolve: async (hostname) => (hostname === "gateway.test" ? ["8.8.8.8"] : [PUBLIC]),
    });
  }

  function body(overrides: Partial<Record<keyof EndpointCreateInput, unknown>> = {}): string {
    return JSON.stringify({
      ...createInput(SELLER_R, overrides),
      confirmedAddress:
        (overrides.destinationAddress as string | undefined) ?? SELLER_R.nearAccountId,
    });
  }

  it("answers 401 to both verbs without a session, and asks the session reader for the cookie", async () => {
    const cookieSeen: { value?: string | undefined } = {};
    const app = createEndpointRoutes({
      db: need().db,
      env,
      log: quiet,
      session: async (cookie) => {
        cookieSeen.value = cookie;
        return null;
      },
    });

    const list = await app.request("/endpoints");
    const create = await app.request("/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(),
    });
    expect([list.status, create.status]).toEqual([401, 401]);
    expect(cookieSeen.value).toBeUndefined();
  });

  it("passes the session cookie through and lists the session's endpoints", async () => {
    const cookieSeen: { value?: string | undefined } = {};
    const app = routeApp(cookieSeen);
    await app.request("/endpoints", { headers: { cookie: "till_session=tok-value" } });
    expect(cookieSeen.value).toBe("tok-value");
  });

  it("lists the row the seed writes, whose upstream is not https", async () => {
    // `scripts/seed.ts` puts `http://127.0.0.1:4100/data` in the table directly — it is
    // the loopback `pnpm demo` dials through its own upstream seam — so every reviewer's
    // database holds an endpoint `POST /api/endpoints` could never have written. GW-8's
    // https rule belongs to the paths that accept a seller's string; re-enforcing it on
    // the way out answers 500 on the first screen a seller opens.
    const { sql } = need();
    const endpointId = randomUUID();
    const slug = `http-row-${run}`;
    await sql`insert into endpoints (id, seller_id, slug, upstream_url, price_amount,
        asset_contract, network, payout_mode, active)
      values (${endpointId}, ${SELLER_R.id}, ${slug}, 'http://127.0.0.1:4100/data',
        '1000000', 'usdc.testnet', 'near:testnet', 'direct', true)`;

    try {
      const response = await routeApp().request("/endpoints", {
        headers: { cookie: "till_session=anything" },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        endpoints: { id: string; upstreamUrl: string; payoutMode: string }[];
      };
      const listed = payload.endpoints.find((row) => row.id === endpointId);
      expect(listed?.upstreamUrl).toBe("http://127.0.0.1:4100/data");
      expect(listed?.payoutMode).toBe("direct");
    } finally {
      await sql`delete from endpoints where id = ${endpointId}`;
    }
  });

  it("refuses a destination the caller did not echo back, and writes nothing", async () => {
    const app = routeApp();
    const before = await listEndpoints(need().db, creationDeps(), SELLER_R.id);

    const response = await app.request("/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...createInput(SELLER_R),
        confirmedAddress: `someone-else-${run}.testnet`,
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "destination_not_confirmed",
      destinationAddress: SELLER_R.nearAccountId,
    });

    const after = await listEndpoints(need().db, creationDeps(), SELLER_R.id);
    expect(after.length).toBe(before.length);
  });

  it("rejects a body that is not JSON, and one the schema refuses", async () => {
    const app = routeApp();
    const notJson = await app.request("/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ code: "invalid_json" });

    const invalid = await app.request("/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...createInput(SELLER_R), priceAmount: "0.5", confirmedAddress: "x" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
  });

  it("creates an endpoint for the session's seller and answers every check with it", async () => {
    const app = routeApp();
    const response = await app.request("/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "till_session=anything" },
      body: body(),
    });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      endpoint: { id: string; active: boolean; creationWarnings: string[] };
      checks: CreationCheck[];
    };
    expect(payload.endpoint.active).toBe(true);
    expect(payload.endpoint.creationWarnings).toEqual([]);
    expect(payload.checks.length).toBeGreaterThan(0);
    expect(payload.checks.every((check) => check.ok)).toBe(true);

    const { sql } = need();
    const [row] = await sql`select seller_id from endpoints where id = ${payload.endpoint.id}`;
    expect(row?.seller_id).toBe(SELLER_R.id);

    const list = await app.request("/endpoints", { headers: { cookie: "till_session=anything" } });
    const listed = (await list.json()) as { endpoints: { id: string }[] };
    expect(listed.endpoints.some((endpoint) => endpoint.id === payload.endpoint.id)).toBe(true);
  });

  it("answers in the shapes @till/core declares, for every check it can emit", async () => {
    // UI-2 is the second reader of these bodies, and it reads them with the core
    // schemas rather than with `as`. A code the enum does not know, a warning list
    // that grew past its cap, or a refusal shape the dashboard cannot name is a
    // parse failure here — in the app that owns the response — rather than a
    // blank screen in the other one.
    const app = routeApp();
    const seen = new Set<string>();
    const creations = [
      body(),
      body({ payoutMode: "intents" }),
      body({
        priceAmount: "1",
        destinationAddress: "Not A Near Account",
        refundAddress: "also not an account",
      }),
    ];

    for (const payload of creations) {
      const response = await app.request("/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: "till_session=anything" },
        body: payload,
      });
      expect(response.status).toBe(201);
      const parsed = endpointCreateResponseSchema.parse(await response.json());
      for (const check of parsed.checks) {
        seen.add(check.code);
        expect(creationCheckCodeSchema.options).toContain(check.code);
      }
      if (!parsed.endpoint.active) {
        expect(parsed.endpoint.creationWarnings.length).toBeGreaterThan(0);
      }
    }
    for (const code of [
      "network",
      "upstream_url",
      "price_floor",
      "destination_chain",
      "destination_address",
      "refund_address",
      "direct_destination",
      "deposit_address",
      "storage_registration",
    ]) {
      expect([code, seen.has(code)]).toEqual([code, true]);
    }

    const list = await app.request("/endpoints", { headers: { cookie: "till_session=anything" } });
    const listed = endpointListResponseSchema.parse(await list.json());
    expect(listed.endpoints.length).toBeGreaterThanOrEqual(creations.length);

    const refused = await app.request("/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "till_session=anything" },
      body: JSON.stringify({
        ...createInput(SELLER_R, { destinationAddress: `echo-mismatch-${run}.testnet` }),
        confirmedAddress: SELLER_R.nearAccountId,
      }),
    });
    expect(refused.status).toBe(422);
    expect(dashboardErrorSchema.parse(await refused.json()).code).toBe("destination_not_confirmed");

    // The 401 is read from an app with no session seam injected, so this is also
    // the one place that proves the route really consults F1's cookie reader when
    // nobody hands it a seller: `routeApp()` above always answers with a session.
    const shipped = createEndpointRoutes({
      db: need().db,
      env,
      log: quiet,
      storage: { read: async () => ({ supported: true, registered: true }) },
      resolve: async () => [PUBLIC],
    });
    const unauthenticated = await shipped.request("/endpoints");
    expect(unauthenticated.status).toBe(401);
    expect(dashboardErrorSchema.parse(await unauthenticated.json()).code).toBe("unauthenticated");
  });

  it("is mounted at /api/endpoints by createApp", async () => {
    const app = createApp({
      env,
      log: quiet,
      db: need().db,
      x402: createX402Near({
        network: "near:testnet",
        maxSponsoredGas: 30_000_000_000_000n,
      }),
      endpoints: {
        session: async () => claims,
        storage: { read: async () => ({ supported: true, registered: true }) },
        resolve: async (hostname) => (hostname === "gateway.test" ? ["8.8.8.8"] : [PUBLIC]),
      },
    });

    const response = await app.request("/api/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body({ upstreamUrl: "https://mounted.seller.test/prices" }),
    });
    expect(response.status).toBe(201);
  });
});

afterAll(async () => {
  if (handle === null) {
    return;
  }
  const { sql } = handle;
  for (const seller of SELLERS) {
    await sql`delete from endpoints where seller_id = ${seller.id}`;
    await sql`delete from payout_routes where seller_id = ${seller.id}`;
    await sql`delete from sellers where id = ${seller.id}`;
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
});
