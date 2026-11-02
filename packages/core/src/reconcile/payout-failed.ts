import { type Finding, type ReconcileRule, dedupeKeyFor } from "./types.ts";

/**
 * PAYOUT_FAILED (LR-3, High): the swap reached a terminal failed state. Unlike
 * a refund this does not put funds back in a known place, so the seller's
 * balance is unclear until the provider detail is read.
 */
export const payoutFailed: ReconcileRule = (snapshot) => {
  const findings: Finding[] = [];
  for (const swap of snapshot.swaps) {
    if (swap.state !== "failed") {
      continue;
    }
    findings.push({
      code: "PAYOUT_FAILED",
      severity: "high",
      paymentId: swap.paymentId,
      swapId: swap.id,
      dedupeKey: dedupeKeyFor("PAYOUT_FAILED", swap.paymentId, swap.id),
      explanation:
        "The payout swap ended in a failed state, so the payment was taken but the payout did not complete.",
      suggestedAction:
        "Open the swap on the provider explorer to find where the funds are, then retry or write it off with an adjustment entry.",
    });
  }
  return findings;
};
