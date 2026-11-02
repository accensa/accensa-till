import { type Finding, type ReconcileRule, dedupeKeyFor } from "./types.ts";

/**
 * GW-3 / LR-3: the upstream returned 2xx and the response went out, but
 * settlement never landed. The seller served the work and was not paid, so the
 * relayer absorbed the gas. Critical.
 */
export const servedNotSettled: ReconcileRule = (snapshot) => {
  const findings: Finding[] = [];
  for (const payment of snapshot.payments) {
    if (payment.state !== "served_unsettled") {
      continue;
    }
    findings.push({
      code: "SERVED_NOT_SETTLED",
      severity: "critical",
      paymentId: payment.id,
      swapId: null,
      dedupeKey: dedupeKeyFor("SERVED_NOT_SETTLED", payment.id, null),
      explanation:
        "The buyer's request was answered but the payment never settled, so this call was served without revenue and the relayer paid the gas.",
      suggestedAction:
        "Check whether settlement is still in flight. If it is not, decide whether to retry the settlement or write the request off.",
    });
  }
  return findings;
};
