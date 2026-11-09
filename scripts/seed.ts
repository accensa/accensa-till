import { fileURLToPath } from "node:url";

import { closeDb, createDb } from "../apps/api/src/db/client.ts";
import { findGatewayEndpoint } from "../apps/api/src/db/queries/endpoints.ts";
import * as schema from "../apps/api/src/db/schema.ts";
import { loadEnv } from "../apps/api/src/env.ts";
import { createProvider } from "../apps/api/src/payouts/index.ts";
import { type RoutePreparer, routeForDestination } from "../apps/api/src/services/payout-routes.ts";
import { findOrCreateSeller } from "../apps/api/src/services/sellers.ts";
import { DEMO_UPSTREAM_PORT } from "./demo-upstream.ts";

/**
 * `pnpm seed` (DQ-1): one demo seller, one endpoint and one payout route, so a
 * fresh clone has something to point the agent at. Idempotent — rerunning it on a
 * seeded database must not create a second copy of the demo endpoint.
 *
 * Three things about this file are decisions a reader should not have to guess:
 *
 * - **The endpoint row is written here, not created through `services/endpoints.ts`.**
 *   Its upstream is the demo's own loopback server, and `resolveUpstreamTarget`
 *   refuses a loopback address for every seller by design (C5, GW-8), so the
 *   shipped creation checks would leave the row `active: false` and the gateway
 *   would answer 404 for it. Those checks have their own suite
 *   (`test/endpoint-checks.test.ts`); what a seed needs is a live paywall to point
 *   a payer at, and the gateway reaches the loopback origin through the `upstream`
 *   seam `app.ts` exposes for exactly that (see `scripts/demo.ts`).
 * - **The route is created through `services/payout-routes.ts`.** It is the one
 *   writer of `payout_routes` (D5, PO-1), it is what asks the provider for a
 *   deposit address, and its lookup-by-destination is what makes rerunning this
 *   file cost no second quote.
 * - **The destination is on Ethereum.** PRD section 8 asks to show the payout
 *   landing on another chain from the NEAR payment, and entries are per asset with
 *   no cross-asset balance (ARCHITECTURE 6.1), so the two ledger lines the demo
 *   books name two different tokens.
 */

/** The seeded seller. A name, not a key: nothing signs as this account. */
export const DEMO_SELLER_ACCOUNT = "demo-seller.testnet";
/** The slug the demo agent and the README's curl both use. */
export const DEMO_ENDPOINT_SLUG = "demo";
/** 1.00 USDC at 6 decimals (hard rule 3: base units, never a float). */
export const DEMO_PRICE_BASE_UNITS = "1000000";
/** The NEP-141 token the paywall charges in — the testnet stablecoin. */
export const DEMO_ASSET_CONTRACT = "usdc.testnet";
export const DEMO_DESTINATION_CHAIN = "eth";
export const DEMO_DESTINATION_ASSET = "usdc";
/** A well-formed EVM destination, so D4's own address rule would pass it. */
export const DEMO_DESTINATION_ADDRESS = "0x742d35cc662dd0c4f8e3f1b0a4b1e6a4d9d01f2c";

export type DbHandle = Parameters<typeof findGatewayEndpoint>[0];

export type SeedResult = {
  readonly sellerId: string;
  readonly endpointId: string;
  readonly slug: string;
  readonly routeId: string;
  readonly depositAddress: string;
  readonly priceAmount: string;
  /** False when the slug already had an endpoint and this run wrote nothing. */
  readonly created: boolean;
};

export type SeedInput = {
  readonly db: DbHandle;
  /** `env.PAYOUT_PROVIDER`, stored on the route as the provider that answered. */
  readonly payoutProvider: "mock" | "oneclick";
  /**
   * The quoting half of the provider (D5). `main` passes the shipped
   * `createProvider(env, [])`, and `scripts/demo.ts` passes the instance it will
   * also read scripted statuses from; naming it here rather than building a mock
   * inside means a `PAYOUT_PROVIDER=oneclick` seed reaches D3's refusal instead of
   * quietly writing a mock route under a `oneclick` label.
   */
  readonly preparer: RoutePreparer;
  readonly slug?: string;
  /** Where an upstream is listening; the gateway dials exactly this. */
  readonly upstreamUrl?: string;
};

/**
 * One seller, one route, one active endpoint. Safe to run twice: the second run
 * finds the slug already there and reports what it found instead of writing.
 */
export async function seedDemo(input: SeedInput): Promise<SeedResult> {
  const slug = input.slug ?? DEMO_ENDPOINT_SLUG;
  const seller = await findOrCreateSeller(input.db, DEMO_SELLER_ACCOUNT);
  const seeded = await findGatewayEndpoint(input.db, slug);
  if (seeded !== null) {
    return {
      sellerId: seeded.sellerId,
      endpointId: seeded.endpointId,
      slug,
      routeId: seeded.routeId ?? "",
      depositAddress: seeded.routeDepositAddress ?? "",
      priceAmount: seeded.priceAmount,
      created: false,
    };
  }

  const resolved = await routeForDestination(
    input.db,
    { providerName: input.payoutProvider, preparer: input.preparer },
    seller.id,
    {
      payoutMode: "intents",
      destinationChain: DEMO_DESTINATION_CHAIN,
      destinationAsset: DEMO_DESTINATION_ASSET,
      destinationAddress: DEMO_DESTINATION_ADDRESS,
      refundAddress: DEMO_SELLER_ACCOUNT,
    },
  );
  if (!resolved.ok) {
    throw new Error(`seed: the payout route could not be written: ${resolved.detail}`);
  }
  const route = resolved.route;

  const [endpoint] = await input.db
    .insert(schema.endpoints)
    .values({
      sellerId: seller.id,
      slug,
      upstreamUrl: input.upstreamUrl ?? `http://127.0.0.1:${DEMO_UPSTREAM_PORT}/data`,
      priceAmount: DEMO_PRICE_BASE_UNITS,
      assetContract: DEMO_ASSET_CONTRACT,
      network: "near:testnet",
      description: "Demo prices endpoint (seeded by scripts/seed.ts)",
      payoutMode: "intents",
      routeId: route.id,
      active: true,
      creationWarnings: [],
    })
    .returning();
  if (endpoint === undefined) {
    throw new Error(`seed: the demo endpoint insert returned no row for slug ${slug}`);
  }

  return {
    sellerId: seller.id,
    endpointId: endpoint.id,
    slug,
    routeId: route.id,
    depositAddress: route.depositAddress ?? "",
    priceAmount: endpoint.priceAmount,
    created: true,
  };
}

async function main(): Promise<number> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  try {
    const seeded = await seedDemo({
      db,
      payoutProvider: env.PAYOUT_PROVIDER,
      preparer: createProvider(env, []),
    });
    const url = `${env.GATEWAY_PUBLIC_URL.replace(/\/+$/, "")}/r/${seeded.slug}`;
    console.log(
      seeded.created
        ? `seeded   seller=${seeded.sellerId} endpoint=${seeded.endpointId}`
        : `already  seeded endpoint=${seeded.endpointId}, nothing written`,
    );
    console.log(`paywall  ${url}`);
    console.log(`price    ${seeded.priceAmount} base units of ${DEMO_ASSET_CONTRACT}`);
    console.log(
      `deposit  ${seeded.depositAddress} (made up by the mock provider; no swap will run)`,
    );
    console.log(
      `payout   ${DEMO_DESTINATION_CHAIN}/${DEMO_DESTINATION_ASSET} -> ${DEMO_DESTINATION_ADDRESS}`,
    );
    console.log("");
    console.log("Run `pnpm demo` for the whole PRD section 8 walk, or:");
    console.log("  pnpm --filter @till/api dev   # the gateway");
    console.log("  tsx scripts/demo-upstream.ts  # the seller's API");
    console.log("  tsx scripts/demo-agent.ts     # the buyer");
    return 0;
  } finally {
    await closeDb(db);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
