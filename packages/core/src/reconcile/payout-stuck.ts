import { isTerminalSwapState } from "../states.ts";
import { type Finding, type ReconcileRule, dedupeKeyFor } from "./types.ts";

/**
 * PAYOUT_STUCK (LR-3, Medium): a swap is still pending or processing, or the
 * provider reported a status we do not recognise (which normalizes to
 * `processing`), beyond the configured window without a poll changing anything.
 *
 * Window comes from config, never hardcoded (AGENTS.md hard rule 12: the caller
 * supplies database time in `snapshot.now`).
 */
export const payoutStuck: ReconcileRule = (snapshot) => {
  const findings: Finding[] = [];
  const stuckMs = snapshot.config.stuckWindowSeconds * 1000;
  for (const swap of snapshot.swaps) {
    if (isTerminalSwapState(swap.state)) {
      continue;
    }
    // A swap we have never polled cannot be judged stale yet.
    if (swap.lastPolledAt === null) {
      continue;
    }
    if (snapshot.now.getTime() - swap.lastPolledAt.getTime() < stuckMs) {
      continue;
    }
    findings.push({
      code: "PAYOUT_STUCK",
      severity: "medium",
      paymentId: swap.paymentId,
      swapId: swap.id,
      dedupeKey: dedupeKeyFor("PAYOUT_STUCK", swap.paymentId, swap.id),
      explanation:
        "The payout swap has been in a non-terminal state past the stuck window, or the provider keeps returning a status we do not recognise.",
      suggestedAction:
        "Check the provider status endpoint for this swap id; if it is still unknown, escalate rather than assuming success.",
    });
  }
  return findings;
};
