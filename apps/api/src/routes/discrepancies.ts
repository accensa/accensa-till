/**
 * Reconciliation view endpoint (UI-4): open discrepancies ordered by severity
 * then age, with the explanation and suggested action that came out of the rule
 * (LR-4). Resolving by hand writes `resolution = 'manual'`; anything the cause
 * clearing closes itself stays `auto` (E3).
 */
export const DISCREPANCY_LIST_LIMIT_DEFAULT = 50;
