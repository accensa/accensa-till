/**
 * The seam between the pure rules and the database (E2). Loads a seller's
 * payments, swaps and the database clock into a ReconcileSnapshot, calls
 * runAllRules from @till/core, and hands the findings to
 * services/discrepancies.ts.
 *
 * Runs every RECONCILE_INTERVAL_SECONDS per seller and after any swap status
 * change. No rule logic lives here, and no I/O lives in a rule (hard rule 6).
 */
export async function reconcileSeller(_sellerId: string): Promise<void> {
  throw new Error("not implemented (E2)");
}
