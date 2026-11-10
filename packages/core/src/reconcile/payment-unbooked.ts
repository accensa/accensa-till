import { type Finding, type ReconcileRule, dedupeKeyFor } from "./types.ts";

/**
 * PAYMENT_UNBOOKED (G6·2, Critical): the money is in, the row says `settled`, and the
 * ledger has no entry for it.
 *
 * This is the one discrepancy the gateway can create itself. `advancePayment` moves a
 * payment to `settled` by compare-and-set and *then* `recordSettlement` writes the
 * `payment_in` line, in a second transaction. If that second call throws — the insert
 * hits a CHECK, the pool is exhausted, the process dies between the two — the buyer was
 * served, the chain says paid, and the seller's balance is short by exactly that
 * payment's amount with nothing naming it. A ledger that is missing an event is worse
 * than a ledger that never got one, because every total read off it looks complete.
 *
 * Nothing else in the build sees this shape, which is what made it a finding rather than
 * a note:
 *
 * - `jobs/sweep-stale.ts` asks the chain only about `verified` rows, and this row is
 *   already past that.
 * - `payment-not-swept.ts` asks whether a *swap* carries the hash, not whether a ledger
 *   line exists, so it reports the same payment for a different reason and stays silent
 *   about this one whenever a swap does exist.
 * - E9's snapshot read payments, swaps and per-seller balances, never the individual
 *   lines, so a balance computed from a missing line agrees with itself.
 *
 * So the rule needs a read of its own — `snapshot.bookedPaymentIds`, the seller's
 * payments that have a `payment_in` row — and the window is the reason it can ask for
 * one without crying wolf: the gateway books in the same request that settles, so
 * anything still unbooked a sweep window after settling is a hole rather than a race.
 *
 * Deliberate choices:
 *
 * - **Both payout modes.** `direct` is skipped by `payment-not-swept.ts` because no swap
 *   was ever owed for it, but `recordSettlement` books `payment_in` for every mode, so
 *   a direct sale with no line is exactly as unbooked as an intents one.
 * - **Existence, not arithmetic.** Whether the amount on the line is *right* is A19's
 *   CHECK constraints and the ledger's own tests; this rule answers the one question no
 *   other layer can, which is whether there is a line at all.
 * - **No auto-heal.** The suggested action is a compensating adjustment, never a write
 *   from here: LR-1's whole point is that a missing row is added by a new row that says
 *   it is a correction.
 */
export const paymentUnbooked: ReconcileRule = (snapshot) => {
  const findings: Finding[] = [];
  const windowMs = snapshot.config.sweepWindowSeconds * 1000;
  const booked = new Set(snapshot.bookedPaymentIds);

  for (const payment of snapshot.payments) {
    if (payment.state !== "settled" || payment.settledAt === null) {
      continue;
    }
    if (snapshot.now.getTime() - payment.settledAt.getTime() < windowMs) {
      continue;
    }
    if (booked.has(payment.id)) {
      continue;
    }
    const details: Record<string, string> = {
      amount: payment.amount.toString(),
      settledAt: payment.settledAt.toISOString(),
    };
    if (payment.nearTxHash !== null) {
      details.nearTxHash = payment.nearTxHash;
    }
    findings.push({
      code: "PAYMENT_UNBOOKED",
      severity: "critical",
      paymentId: payment.id,
      swapId: null,
      dedupeKey: dedupeKeyFor("PAYMENT_UNBOOKED", payment.id, null),
      explanation:
        "The buyer paid and this sale is recorded as settled, but the ledger holds no entry for it, so the seller's balance is short by exactly this amount.",
      suggestedAction:
        "Confirm the transfer on the chain explorer, then book a compensating adjustment for this payment. Never edit or re-run the settlement write.",
      details,
    });
  }
  return findings;
};
