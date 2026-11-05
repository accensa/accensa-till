import { type Finding, type ReconcileRule, dedupeKeyFor } from "./types.ts";

/**
 * PAYMENT_NOT_SWEPT (LR-3, High): a payment settled on NEAR and nothing was
 * ever swept toward the payout route. Matching is by transaction hash and
 * nothing else (AGENTS.md hard rule 7, LR-2), so a payment that settled without
 * a recorded hash cannot be judged here — that is a data problem, not a
 * reconciliation finding, and the payer-facing reason it is skipped is below.
 *
 * D8: a `direct` payment is skipped by definition. Its pay-to was the seller's
 * own account, so the x402 transfer *was* the payout and no swap will ever carry
 * its hash; treating that as un-swept would flag every direct sale.
 */
export const paymentNotSwept: ReconcileRule = (snapshot) => {
  const findings: Finding[] = [];
  const sweepMs = snapshot.config.sweepWindowSeconds * 1000;
  const sweptHashes = new Set(
    snapshot.swaps.map((swap) => swap.originTxHash).filter((hash) => hash !== null),
  );

  for (const payment of snapshot.payments) {
    if (payment.state !== "settled" || payment.settledAt === null) {
      continue;
    }
    if (payment.payoutMode === "direct") {
      continue;
    }
    if (snapshot.now.getTime() - payment.settledAt.getTime() < sweepMs) {
      continue;
    }
    if (payment.nearTxHash === null) {
      continue;
    }
    if (sweptHashes.has(payment.nearTxHash)) {
      continue;
    }
    findings.push({
      code: "PAYMENT_NOT_SWEPT",
      severity: "high",
      paymentId: payment.id,
      swapId: null,
      dedupeKey: dedupeKeyFor("PAYMENT_NOT_SWEPT", payment.id, null),
      explanation:
        "This payment settled on NEAR and no payout swap references its transaction hash, so it is sitting un-swept.",
      suggestedAction:
        "Check that the payout poller is running and that this route is still active, then trigger a sweep for this payment.",
      details: { nearTxHash: payment.nearTxHash },
    });
  }
  return findings;
};
