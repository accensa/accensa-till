import { isShortfall } from "../money.ts";
import { type Finding, type ReconcileRule, dedupeKeyFor } from "./types.ts";

/**
 * PAYOUT_SHORTFALL (LR-6, P1, High): the swap landed but delivered materially
 * less than it took in, beyond SHORTFALL_TOLERANCE_BPS.
 *
 * Runs on terminal `succeeded` swaps only. Swaps missing either amount are
 * skipped: an unknown number is not a shortfall.
 */
export const payoutShortfall: ReconcileRule = (snapshot) => {
  const findings: Finding[] = [];
  for (const swap of snapshot.swaps) {
    if (swap.state !== "succeeded") {
      continue;
    }
    if (swap.amountIn === null || swap.amountOut === null) {
      continue;
    }
    if (!isShortfall(swap.amountIn, swap.amountOut, snapshot.config.shortfallToleranceBps)) {
      continue;
    }
    findings.push({
      code: "PAYOUT_SHORTFALL",
      severity: "high",
      paymentId: swap.paymentId,
      swapId: swap.id,
      dedupeKey: dedupeKeyFor("PAYOUT_SHORTFALL", swap.paymentId, swap.id),
      explanation:
        "The payout arrived, but materially less than the amount that went in was delivered to the destination.",
      suggestedAction:
        "Compare the quote and the fill for this swap on the provider explorer before accepting the difference as fee.",
    });
  }
  return findings;
};
