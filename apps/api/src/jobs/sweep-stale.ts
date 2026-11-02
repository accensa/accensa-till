/**
 * Restart recovery (C10). A payment left `verified` when the process died is
 * abandoned after SWEEP_WINDOW_SECONDS — but the chain is consulted first,
 * because a settlement may have landed while we were down. Abandoning one that
 * actually settled would lose the revenue silently and corrupt the ledger.
 */
export async function sweepStaleOnBoot(): Promise<void> {
  throw new Error("not implemented (C10)");
}
