import { and, eq } from "drizzle-orm";

import type { EndpointCreateInput } from "@till/core";

import type { Db } from "../db/client.ts";
import { type PayoutRoute, payoutRoutes } from "../db/schema.ts";
import type { PayoutProvider, PreparedRoute } from "../payouts/provider.ts";

/**
 * The one writer of `payout_routes` (D5, PO-1). A route is the answer to one
 * question — where does money for this destination come to rest — and it is written
 * once and never again: `payout_routes` refuses an `UPDATE` at the database
 * (migration `0007_payout_routes_immutable.sql`), so a payment that points at a
 * route reads the payout it actually had (PO-7, red-team B9) rather than the seller's
 * latest edit.
 *
 * Three decisions live here:
 *
 * - **One standing route per destination and mode.** The lookup before the provider
 *   call is what B12 ("quote spam") turns on: a quote is the thing that costs, not
 *   the row. Two endpoints on the same destination share the one deposit address,
 *   which is also what 4.5's standing design means. `payout_routes_destination_key`
 *   is the same rule as an index, for the case where two creations race and neither
 *   lookup saw the other. The mode is part of it because a `direct` route has no
 *   deposit address to give an `intents` endpoint, and one address shared across both
 *   modes would advertise an endpoint the gateway then refuses to charge.
 * - **The provider is part of the key.** A `mock-deposit-*` address handed to an
 *   `oneclick` route would advertise a fake account as a real one, which is the one
 *   mistake DQ-2 exists to prevent.
 * - **`direct` asks for nothing.** Its pay-to is the seller's own account (PO-6), so
 *   there is no quote to take; the route row is still written because a payment
 *   snapshots *where it was going to*, and a direct sale has that fact too.
 *
 * The route is resolved *before* the endpoint insert rather than inside its
 * transaction, which inverts one of D4's guarantees on purpose. D4 wrapped both
 * inserts so a failed endpoint could not leave a route "nobody owned"; now that a
 * route belongs to a *destination* and is meant to outlive any one endpoint, a route
 * left behind by a failed creation is not an orphan — it is the standing quote the
 * next creation for that destination reuses instead of paying for twice.
 */

/** Only the quoting half of a provider: this module cannot poll or list assets. */
export type RoutePreparer = Pick<PayoutProvider, "prepareRoute">;

export type PayoutRouteDeps = {
  /** `env.PAYOUT_PROVIDER`, stored on the row as the provider that answered. */
  readonly providerName: "mock" | "oneclick";
  readonly preparer: RoutePreparer;
};

/** The fields a route is keyed by, out of the creation input. */
export type RouteDestination = Pick<
  EndpointCreateInput,
  "payoutMode" | "destinationChain" | "destinationAsset" | "destinationAddress" | "refundAddress"
>;

export type PayoutRouteResolution =
  | {
      readonly ok: true;
      readonly route: PayoutRoute;
      /** False only when this call is the one that asked the provider for the quote. */
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly detail: string };

function refusal(detail: string): PayoutRouteResolution {
  return { ok: false, detail };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The destination as the row stores it. `services/endpoints.ts` compares chains
 * case-insensitively, so a route saved with whatever the seller typed would key one
 * destination twice — `NEAR` and `near` — and take a second quote for the second
 * spelling.
 */
function chainOf(destination: RouteDestination): string {
  return destination.destinationChain.toLowerCase();
}

/**
 * The route shape that answers this mode: `direct` writes its own (no quote, no
 * deposit address), `intents` wants the standing quote a provider prepared.
 *
 * Splitting the lookup by mode is what keeps a `direct` route — whose deposit
 * address is null by definition — from being handed to an `intents` endpoint, which
 * would advertise null as the address a payer's money is meant to arrive at.
 */
function expectedModeDetail(payoutMode: RouteDestination["payoutMode"]): "direct" | "standing" {
  return payoutMode === "direct" ? "direct" : "standing";
}

/**
 * The standing route for this destination, if there is one.
 *
 * `mode_detail` is the read version of what `payout_routes_destination_key` enforces
 * — the same rule written twice for different reasons: the index for the race, this
 * read to avoid asking a provider a question the database can answer. Keeping the two
 * in step matters more than either one alone, so this is the one place in the file
 * that repeats the index's column list, `per_payment` rows included on neither side
 * (a per-payment quote is S2's other design and is deliberately not deduped here).
 */
function findStandingRoute(
  db: Db,
  deps: PayoutRouteDeps,
  sellerId: string,
  destination: RouteDestination,
): Promise<PayoutRoute | null> {
  return db
    .select()
    .from(payoutRoutes)
    .where(
      and(
        eq(payoutRoutes.sellerId, sellerId),
        eq(payoutRoutes.provider, deps.providerName),
        eq(payoutRoutes.destinationChain, chainOf(destination)),
        eq(payoutRoutes.destinationAsset, destination.destinationAsset),
        eq(payoutRoutes.destinationAddress, destination.destinationAddress),
        eq(payoutRoutes.refundAddress, destination.refundAddress),
        eq(payoutRoutes.modeDetail, expectedModeDetail(destination.payoutMode)),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function routeForDestination(
  db: Db,
  deps: PayoutRouteDeps,
  sellerId: string,
  destination: RouteDestination,
): Promise<PayoutRouteResolution> {
  const standing = await findStandingRoute(db, deps, sellerId, destination);
  if (standing !== null) {
    return { ok: true, route: standing, reused: true };
  }

  let prepared: PreparedRoute;
  if (destination.payoutMode === "direct") {
    prepared = {
      depositAddress: null,
      depositMemo: null,
      quoteRef: null,
      minAmountOut: null,
      deadlineAt: null,
      modeDetail: "direct",
    };
  } else {
    try {
      // `amount: null` is the standing ask: the price of a payment that has not
      // happened yet is not a thing to quote against, and S2 has not ruled that the
      // per-payment design wins. The provider's own `modeDetail` is what gets
      // stored, so a provider that answers with a deadline gets a deadline.
      prepared = await deps.preparer.prepareRoute({
        destinationChain: chainOf(destination),
        destinationAsset: destination.destinationAsset,
        destinationAddress: destination.destinationAddress,
        refundAddress: destination.refundAddress,
        amount: null,
      });
    } catch (error) {
      return refusal(`the payout provider refused to prepare a route: ${messageOf(error)}`);
    }
    if (prepared.depositAddress === null || prepared.depositAddress === "") {
      // Not a cosmetic check. A route with no deposit address would be stored,
      // linked and then refused at the gateway as `pay_to_unresolved` — the seller
      // would be shown an active endpoint that no payer can ever be charged on.
      return refusal(
        "the payout provider answered an intents route with no deposit address to advertise",
      );
    }
  }

  const inserted = await db
    .insert(payoutRoutes)
    .values({
      sellerId,
      destinationChain: chainOf(destination),
      destinationAsset: destination.destinationAsset,
      destinationAddress: destination.destinationAddress,
      refundAddress: destination.refundAddress,
      provider: deps.providerName,
      depositAddress: prepared.depositAddress,
      depositMemo: prepared.depositMemo,
      quoteRef: prepared.quoteRef,
      deadlineAt: prepared.deadlineAt,
      modeDetail: prepared.modeDetail,
    })
    .onConflictDoNothing()
    .returning();

  const [row] = inserted;
  if (row !== undefined) {
    return { ok: true, route: row, reused: false };
  }

  // The index refused us: another creation was preparing the same destination while
  // we were. Its quote is the one that stands, and the one we throw away is the
  // price of the race — bounded by there being one race per destination.
  const winner = await findStandingRoute(db, deps, sellerId, destination);
  if (winner === null) {
    throw new Error(
      "payout route insert was refused by a conflict, and the row it conflicted with is not there",
    );
  }
  return { ok: true, route: winner, reused: true };
}
