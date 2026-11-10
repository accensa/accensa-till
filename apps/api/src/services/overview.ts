import { type OverviewDto, overviewDtoSchema } from "@till/core";
import { and, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import {
  discrepancies,
  endpoints,
  ledgerEntries,
  payments,
  payoutRoutes,
  swaps,
} from "../db/schema.ts";
import { intentsModeSql } from "./payout-mode.ts";

/**
 * The seller's overview totals (UI-6, F6).
 *
 * The acceptance rule is that these totals *equal the ledger rows they summarise*,
 * so four of the five per-asset numbers are a `sum` over `ledger_entries` filtered
 * to one `kind` each — a seller can re-derive any of them with one `SELECT` and see
 * the same digits. The reads run in one transaction, because a screen that shows
 * `settled` from one instant and `in transit` from another is two screens.
 *
 * `inTransitAmount` is the exception, and the reason is 6.1's own rule that there is
 * no cross-asset balance: an `intents` payout moves money *out* in the destination
 * asset, so the `payment_in` and its `payout_out` sit in two different rows of the
 * `asset` column and subtracting one from the other per asset measures nothing about
 * either. It is therefore counted over the payments, as 6.1 words it — settled
 * payments with no swap in a terminal state — and it belongs to the asset the money
 * was received in, because that is the only asset the seller is owed anything for.
 *
 * Three consequences of that definition, each of which is a wrong number if
 * handled the other way:
 *
 * - **`direct` payments are never in transit.** PO-6 + D8: their pay-to was the
 *   seller's own account, so the x402 transfer *was* the payout and `payout_out` was
 *   booked in the settlement's own transaction. Counting them would advertise money
 *   in flight that has already landed, for every direct sale in the book. The mode
 *   is `services/payout-mode.ts`'s rule, in its SQL form, so the overview and E9
 *   cannot answer differently for the same row.
 * - **A swap counts when it is terminal, not when it is linked.** `swaps.payment_id`
 *   is null until E2's matcher runs, and hard rule 7 makes the transaction hash the
 *   only match key, so the read is on `origin_tx_hash` and the terminal test is
 *   `terminal_at is not null` — D6 keeps that column filled, and restating D1's
 *   terminal list in SQL is the duplication S5 was written against.
 * - **A settled payment with no hash is in transit.** Nothing can ever be shown to
 *   have left for it, so the honest reading is "we have not seen the payout", not
 *   "there is nothing on the way". G6·2's `PAYMENT_UNBOOKED` is the finding that
 *   says so; the total just declines to claim the money arrived somewhere.
 *
 * An asset can appear here and not in the ledger at all — that is precisely an
 * unbooked settlement — so the two reads are unioned rather than one driving the
 * other, and a row with `settledAmount` of `0` beside a non-zero `inTransitAmount`
 * is the screen saying that out loud instead of dropping the asset.
 */

/** A per-asset total, as the database returns it: an integer of base units in text. */
const ledgerTotal = (kind: string) =>
  sql<string>`coalesce(sum(${ledgerEntries.amount}) filter (where ${ledgerEntries.kind} = ${kind}), 0)::text`;

/**
 * One row on its way to the contract: the same shape as `OverviewDto`'s asset row,
 * with the money unbranded, because a `BRAND<"BaseUnitAmountString">` is what
 * `overviewDtoSchema.parse` hands out and a query result may not claim one.
 */
type TotalsRow = {
  asset: string;
  settledAmount: string;
  inTransitAmount: string;
  paidOutAmount: string;
  refundedAmount: string;
  adjustedAmount: string;
};

const ZERO_ROW = (asset: string): TotalsRow => ({
  asset,
  settledAmount: "0",
  inTransitAmount: "0",
  paidOutAmount: "0",
  refundedAmount: "0",
  adjustedAmount: "0",
});
export async function readSellerOverview(db: Db, sellerId: string): Promise<OverviewDto> {
  const totals = await db.transaction(async (tx) => {
    const ledgerRows = await tx
      .select({
        asset: ledgerEntries.asset,
        settled: ledgerTotal("payment_in"),
        paidOut: ledgerTotal("payout_out"),
        refunded: ledgerTotal("refund_in"),
        adjusted: ledgerTotal("adjustment"),
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.sellerId, sellerId))
      .groupBy(ledgerEntries.asset);

    const transitRows = await tx
      .select({
        asset: payments.assetContract,
        inTransit: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
      })
      .from(payments)
      .innerJoin(endpoints, eq(endpoints.id, payments.endpointId))
      // Left, for the same reason E9's snapshot read is: a payment with no route
      // still needs an answer, and the endpoint's mode is that answer.
      .leftJoin(payoutRoutes, eq(payoutRoutes.id, payments.routeId))
      .where(
        and(
          eq(endpoints.sellerId, sellerId),
          eq(payments.state, "settled"),
          intentsModeSql(payoutRoutes.modeDetail, endpoints.payoutMode),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(swaps)
              .where(and(eq(swaps.originTxHash, payments.nearTxHash), isNotNull(swaps.terminalAt))),
          ),
        ),
      )
      .groupBy(payments.assetContract);

    const openRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(discrepancies)
      .where(and(eq(discrepancies.sellerId, sellerId), isNull(discrepancies.resolvedAt)));

    const servedRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .innerJoin(endpoints, eq(endpoints.id, payments.endpointId))
      .where(and(eq(endpoints.sellerId, sellerId), eq(payments.state, "served_unsettled")));

    const byAsset = new Map<string, TotalsRow>(
      ledgerRows.map((row) => [
        row.asset,
        {
          ...ZERO_ROW(row.asset),
          settledAmount: row.settled,
          paidOutAmount: row.paidOut,
          refundedAmount: row.refunded,
          adjustedAmount: row.adjusted,
        },
      ]),
    );
    for (const row of transitRows) {
      const existing = byAsset.get(row.asset) ?? ZERO_ROW(row.asset);
      byAsset.set(row.asset, { ...existing, inTransitAmount: row.inTransit });
    }

    // Sorted by asset rather than by either read's order: the two groups come back
    // in whatever order their plans pick, and a screen that reorders a seller's
    // money between refreshes cannot be read.
    return {
      byAsset: [...byAsset.values()].sort((a, b) => (a.asset < b.asset ? -1 : 1)),
      openDiscrepancies: openRows[0]?.n ?? 0,
      servedUnsettledCount: servedRows[0]?.n ?? 0,
    };
  });

  // Parsed here rather than at the route so a total the contract refuses is the same
  // coded failure either way: `0` for a number that is not there is the lie UI-5's
  // F5 contract was written to make impossible, and a silently dropped asset row
  // would be that lie per-asset.
  return overviewDtoSchema.parse(totals);
}
