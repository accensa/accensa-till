import { incompleteDeposit } from "./incomplete-deposit.ts";
import { orphanDeposit } from "./orphan-deposit.ts";
import { paymentNotSwept } from "./payment-not-swept.ts";
import { payoutFailed } from "./payout-failed.ts";
import { payoutRefunded } from "./payout-refunded.ts";
import { payoutShortfall } from "./payout-shortfall.ts";
import { payoutStuck } from "./payout-stuck.ts";
import { servedNotSettled } from "./served-not-settled.ts";
import type { Finding, ReconcileRule, ReconcileSnapshot } from "./types.ts";

/** Registration point for rules (PROJECT_STRUCTURE.md "Where does new code go"). */
export const RULES: readonly ReconcileRule[] = [
  servedNotSettled,
  payoutRefunded,
  payoutFailed,
  payoutStuck,
  paymentNotSwept,
  payoutShortfall,
  incompleteDeposit,
  orphanDeposit,
];

/**
 * Pure: snapshot in, findings out. Persistence, dedupe against open rows and
 * auto-resolution live in apps/api/src/jobs/reconcile.ts, not here.
 */
export function runAllRules(snapshot: ReconcileSnapshot): readonly Finding[] {
  return RULES.flatMap((rule) => [...rule(snapshot)]);
}

export {
  servedNotSettled,
  payoutRefunded,
  payoutFailed,
  payoutStuck,
  paymentNotSwept,
  payoutShortfall,
  incompleteDeposit,
  orphanDeposit,
};
export * from "./types.ts";
