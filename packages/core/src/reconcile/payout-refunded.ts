import { formatAmount } from "../money.ts";
import { type Finding, type ReconcileRule, dedupeKeyFor } from "./types.ts";

/**
 * PAYOUT_REFUNDED (LR-3, High): the swap to the destination chain was refunded,
 * so the funds are back rather than paid out. Amounts are reported in the
 * finding because the refund may be partial.
 */
export const payoutRefunded: ReconcileRule = (snapshot) => {
  const findings: Finding[] = [];
  for (const swap of snapshot.swaps) {
    if (swap.state !== "refunded") {
      continue;
    }
    findings.push({
      code: "PAYOUT_REFUNDED",
      severity: "high",
      paymentId: swap.paymentId,
      swapId: swap.id,
      dedupeKey: dedupeKeyFor("PAYOUT_REFUNDED", swap.paymentId, swap.id),
      explanation:
        "The payout swap to the destination chain was refunded, so the money did not arrive where the seller asked for it.",
      suggestedAction:
        "Confirm the destination address and asset are supported, then re-route the payout or keep it on NEAR.",
      ...(swap.refundedAmount === null
        ? {}
        : { details: { refundedAmount: formatAmount(swap.refundedAmount) } }),
    });
  }
  return findings;
};
