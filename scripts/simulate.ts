/**
 * Scripted failures against the mock provider (D2): succeed, refund, fail,
 * stall, and an empty-account payer. The demo and every reconciliation rule test
 * drive their "money moved without an audit trail" cases from here, so a failure
 * mode can be shown on demand instead of waiting for one to happen.
 *
 * Each simulated outcome must be labelled as simulated on screen and in the
 * README (DQ-2) — the line between mocked and real is the thing a judge is most
 * likely to be misled by.
 */
export const SIMULATIONS = ["succeed", "refund", "fail", "stall", "empty-payer"] as const;
