/**
 * Endpoint creation checks (D4, PO-1/PO-2): token storage registration at the
 * payout address, price floor from MIN_PRICE_BASE_UNITS, per-chain address
 * format, and showing the destination back to the seller for confirmation.
 *
 * A failed check leaves the endpoint inactive with a message the seller can act
 * on — creation never half-succeeds.
 */
export function createEndpoint(): never {
  throw new Error("not implemented (D4)");
}
