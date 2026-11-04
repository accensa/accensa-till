import { eq } from "drizzle-orm";

import type { Db } from "../client.ts";
import { endpoints, payoutRoutes, sellers } from "../schema.ts";

/**
 * Read helpers for the endpoints table (A7). Queries only: writes go through
 * services/, and anything touching the ledger goes through services/ledger.ts
 * (hard rule 4). Money comes back as numeric strings and is converted with
 * `toBaseUnits` from @till/core at the edge of this module.
 */

/**
 * Everything one paywalled slug needs, in one read (C4, GW-2).
 *
 * The join is the point. An advertisement is only honest if the pay-to it names is
 * the pay-to the payout leg will actually use, and that address lives on a
 * different table from the price — `sellers.near_account_id` for a `direct`
 * endpoint, `payout_routes.deposit_address` for an `intents` one. A route that read
 * the price first and then went looking for the seller would have two chances to
 * disagree with itself, and the disagreement would surface inside `verify` on a
 * stranger's paid request (S1). One join, one row, one moment in time.
 *
 * `routeId` travels because `payments.route_id` snapshots it (PO-7): a payment must
 * record the route it was actually served under, not the route the seller has
 * edited by the time the dashboard reads the row back.
 */
export type GatewayEndpoint = {
  readonly endpointId: string;
  readonly sellerId: string;
  readonly slug: string;
  readonly network: string;
  readonly assetContract: string;
  /** `numeric(78,0)`, so a decimal string. */
  readonly priceAmount: string;
  /** `direct` | `intents` in the schema's own words; anything else is refused at the route. */
  readonly payoutMode: string;
  readonly sellerNearAccountId: string;
  readonly routeId: string | null;
  readonly routeDepositAddress: string | null;
  readonly upstreamUrl: string;
  readonly description: string | null;
  readonly active: boolean;
};

/**
 * The one lookup the gateway makes: slug -> the row it will advertise, charge and
 * proxy against.
 *
 * Deliberately does *not* filter on `active`. A paused endpoint and an unknown slug
 * both answer `404` to a payer, so nothing is leaked either way, but they are not
 * the same thing to the seller reading the log, and `active: false` on a row that
 * still has a price is a state the D-phase creation checks can put an endpoint in
 * on purpose (a failed check leaves it inactive with a message).
 */
export function findGatewayEndpoint(db: Db, slug: string): Promise<GatewayEndpoint | null> {
  return (
    db
      .select({
        endpointId: endpoints.id,
        sellerId: endpoints.sellerId,
        slug: endpoints.slug,
        network: endpoints.network,
        assetContract: endpoints.assetContract,
        priceAmount: endpoints.priceAmount,
        payoutMode: endpoints.payoutMode,
        sellerNearAccountId: sellers.nearAccountId,
        routeId: payoutRoutes.id,
        routeDepositAddress: payoutRoutes.depositAddress,
        upstreamUrl: endpoints.upstreamUrl,
        description: endpoints.description,
        active: endpoints.active,
      })
      .from(endpoints)
      .innerJoin(sellers, eq(endpoints.sellerId, sellers.id))
      // A `direct` endpoint has no route at all, and a read that required one could
      // not advertise PO-6's own account. A `left` join is what keeps the one mode
      // from being refused for the other mode's shape.
      .leftJoin(payoutRoutes, eq(endpoints.routeId, payoutRoutes.id))
      .where(eq(endpoints.slug, slug))
      .limit(1)
      .then((rows) => rows[0] ?? null)
  );
}
