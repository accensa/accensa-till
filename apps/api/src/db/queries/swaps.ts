import { type SwapDto, swapDtoSchema } from "@till/core";
import { desc, eq } from "drizzle-orm";

import type { Db } from "../client.ts";
import { payoutRoutes, swaps } from "../schema.ts";

/**
 * The seller's payout leg, newest first (UI-3, D6).
 *
 * The dashboard could show money in and not money out: `GET /api/payments` answers
 * the ledger's `payment_in` side, and a swap that refunded, stalled or never matched
 * a payment was visible only in the reconcile worklist — a *finding*, not the thing
 * the finding is about. `SwapTimeline.tsx` and `swapDtoSchema` already existed for
 * this read; only the query was missing.
 *
 * Scope is the join, not the request: `swaps` has no seller column, and the only path
 * to one is `swaps.route_id -> payout_routes.seller_id`. That is also why this is an
 * `innerJoin` rather than a `leftJoin`: a swap whose route is gone cannot be
 * attributed to anybody, and answering it to a dashboard would be answering for
 * another tenant. The read lives here rather than in `services/swaps.ts` because that
 * module owns the *writer* of the payment/swap link (LR-2), and a query next to it
 * would be a second thing to reason about when asking what may move a swap.
 *
 * Read-only by fact: the swap row is written by `poll-payouts` and by nothing else,
 * so a dashboard route that could write one would be a second way to claim money
 * moved. Amounts stay base-unit strings (hard rule 3) so no `number` touches a
 * payout on the way to the browser.
 */

/** One page. UI-3 renders a timeline, and an unbounded read is a slow first paint. */
export const SWAP_LIST_LIMIT = 200;

export async function listSwapsForSeller(
  db: Db,
  sellerId: string,
  limit = SWAP_LIST_LIMIT,
): Promise<SwapDto[]> {
  const rows = await db
    .select({
      id: swaps.id,
      routeId: swaps.routeId,
      paymentId: swaps.paymentId,
      providerRef: swaps.providerRef,
      state: swaps.state,
      amountIn: swaps.amountIn,
      amountOut: swaps.amountOut,
      refundedAmount: swaps.refundedAmount,
      originTxHash: swaps.originTxHash,
      destinationTxHash: swaps.destinationTxHash,
      lastPolledAt: swaps.lastPolledAt,
      terminalAt: swaps.terminalAt,
    })
    .from(swaps)
    .innerJoin(payoutRoutes, eq(payoutRoutes.id, swaps.routeId))
    .where(eq(payoutRoutes.sellerId, sellerId))
    .orderBy(desc(swaps.createdAt))
    .limit(Math.min(limit, SWAP_LIST_LIMIT));

  // The schema is the contract: a row the DTO refuses is a row Till cannot read, so
  // it throws and the route answers an error rather than a shorter list. A missing
  // payout reads as a payout that never happened, which is the one thing a seller
  // must not be told about money that may have moved.
  return rows.map((row) =>
    swapDtoSchema.parse({
      id: row.id,
      routeId: row.routeId,
      paymentId: row.paymentId,
      providerRef: row.providerRef,
      state: row.state,
      amountIn: row.amountIn,
      amountOut: row.amountOut,
      refundedAmount: row.refundedAmount,
      originTxHash: row.originTxHash,
      destinationTxHash: row.destinationTxHash,
      lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
      terminalAt: row.terminalAt?.toISOString() ?? null,
    }),
  );
}
