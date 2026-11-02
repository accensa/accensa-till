/**
 * Scripted provider (D2, PO-5) with the same interface as the real one:
 * succeed, refund, fail, stall. Every reconciliation rule and both demo failure
 * cases are driven from here so the full flow runs offline.
 *
 * The script comes from scripts/simulate.ts, not from a hidden default, so a
 * demo cannot accidentally claim a mocked outcome was real.
 */
export const MOCK_OUTCOMES = ["succeed", "refund", "fail", "stall"] as const;
export type MockOutcome = (typeof MOCK_OUTCOMES)[number];
