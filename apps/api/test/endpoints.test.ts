import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type EndpointCreateInput, endpointCreateSchema } from "@till/core";

import { createApp } from "../src/app.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import type { SessionClaims } from "../src/lib/session.ts";
import { createEndpointRoutes } from "../src/routes/endpoints.ts";
import {
  type CreationCheck,
  type EndpointCreationDeps,
  type SellerIdentity,
  TokenStorageError,
  createEndpoint,
  listEndpoints,
} from "../src/services/endpoints.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * D4 acceptance tests, the half that needs a real database (PO-1/PO-2).
 *
 * The checks themselves are exercised in `endpoint-checks.test.ts` with fakes.
 * What is pinned here is what a check *does*: an endpoint that failed one is
 * written `active: false` with the seller-facing sentences persisted on the row,
 * a passing one is written active, and the payout route arrives in the same
 * transaction — a failed insert must not leave a route nobody owns.
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
const SELLERS = [SELLER_A, SELLER_B, SELLER_C, SELLER_R] as const;
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
    storage: { read: async () => ({ supported: true, registered: true }) },
    resolve: async () => [PUBLIC],
    slug: () => `d4-${randomUUID()}`,
    ...overrides,
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

  it("refuses an intents endpoint for want of a deposit address, and records the standing route shape", async () => {
    const created = await createEndpoint(
      need().db,
      creationDeps(),
      SELLER_A,
      createInput(SELLER_A, { payoutMode: "intents" }),
    );
    expect(created.endpoint.active).toBe(false);
    expect(failedCodes(created.checks)).toEqual(["deposit_address"]);

    const { sql } = need();
    const [endpoint] = await sql`select route_id from endpoints where id = ${created.endpoint.id}`;
    const [route] =
      await sql`select mode_detail from payout_routes where id = ${endpoint?.route_id}`;
    expect(route?.mode_detail).toBe("standing");
  });

  it("rolls the payout route back with the endpoint when the slug collides", async () => {
    const fixedSlug = `d4-fixed-${run}`;
    const deps = creationDeps({ slug: () => fixedSlug });
    const input = createInput(SELLER_C);

    await createEndpoint(need().db, deps, SELLER_C, input);
    await expect(createEndpoint(need().db, deps, SELLER_C, input)).rejects.toThrow();

    const { sql } = need();
    const [routes] = await sql`select count(*)::int as count from payout_routes
      where seller_id = ${SELLER_C.id}`;
    const [endpoints] = await sql`select count(*)::int as count from endpoints
      where seller_id = ${SELLER_C.id}`;
    expect([routes?.count, endpoints?.count]).toEqual([1, 1]);
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
      resolve: async () => [PUBLIC],
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
        resolve: async () => [PUBLIC],
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
