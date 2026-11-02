/**
 * Poll provider statuses into `swaps` (D6, PO-4).
 *
 * Terminal states are sticky: a poll that reports `processing` for a swap
 * already `succeeded` is logged and dropped, not written. Writes to the ledger
 * for a newly terminal swap go through services/ledger.ts, never from here.
 */
export async function pollPayouts(): Promise<void> {
  throw new Error("not implemented (D6)");
}
