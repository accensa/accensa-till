import type { Finding, ReconcileRule } from "./types.ts";

/**
 * ORPHAN_DEPOSIT (LR-6, P1, Medium): funds arrived at a route with no payment
 * that explains them.
 *
 * BLOCKED ON S2 for the same reason as INCOMPLETE_DEPOSIT: it can only be
 * judged once deposits are enumerable per route and can be matched by origin
 * hash. Returning an empty list is deliberate — a wrong match here would hide
 * real money, and LR-2 forbids amount-and-time matching as a fallback.
 */
export const orphanDeposit: ReconcileRule = (_snapshot): readonly Finding[] => {
  return [];
};
