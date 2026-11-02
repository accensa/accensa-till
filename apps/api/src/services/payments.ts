/**
 * Payment state transitions (C3, GW-2/GW-4) — the only place that moves a
 * payment, always through assertPaymentTransition in @till/core, always writing
 * the DB clock into verified_at / settled_at.
 */
export function transitionPayment(): never {
  throw new Error("not implemented (C3)");
}
