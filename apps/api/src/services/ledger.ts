import type { BaseUnitAmount } from "@till/core";
import type { Db } from "../db/client.ts";
import { ledgerEntries } from "../db/schema.ts";
import type { Logger } from "../lib/logger.ts";

/**
 * The only module allowed to insert into `ledger_entries` (AGENTS.md hard rule
 * 4, E1). Enforcement is two-layered on purpose: a database trigger blocks
 * UPDATE and DELETE, and `scripts/check-boundaries.sh` fails CI if any other
 * file imports the table for a write.
 *
 * Entries are per asset with no cross-asset balance (6.1). A correction is a new
 * `adjustment` row, never an edit.
 */

export type LedgerKind = "payment_in" | "payout_out" | "refund_in" | "adjustment";

export type LedgerWrite = {
  readonly sellerId: string;
  readonly kind: LedgerKind;
  readonly amount: BaseUnitAmount;
  readonly asset: string;
  readonly paymentId?: string | null;
  readonly swapId?: string | null;
  readonly note?: string | null;
};

/**
 * Drizzle types a numeric(78,0) column as a string; base units arrive as bigint
 * and are serialised here so no caller has to remember the convention.
 */
async function insert(db: Db, entry: LedgerWrite): Promise<void> {
  await db.insert(ledgerEntries).values({
    id: crypto.randomUUID(),
    sellerId: entry.sellerId,
    kind: entry.kind,
    amount: entry.amount.toString(),
    asset: entry.asset,
    paymentId: entry.paymentId ?? null,
    swapId: entry.swapId ?? null,
    note: entry.note ?? null,
  });
}

/** GW-2: a settled payment writes exactly one `payment_in`. */
export function recordPaymentSettled(db: Db, entry: LedgerWrite): Promise<void> {
  return insert(db, { ...entry, kind: "payment_in" });
}

/** D6: a swap reaching `succeeded` writes one `payout_out`. */
export function recordPayoutOut(db: Db, entry: LedgerWrite): Promise<void> {
  return insert(db, { ...entry, kind: "payout_out" });
}

/** D6: a swap reaching `refunded` writes one `refund_in`. */
export function recordRefundIn(db: Db, entry: LedgerWrite): Promise<void> {
  return insert(db, { ...entry, kind: "refund_in" });
}

/** The only permitted way to fix a wrong number: add a compensating row. */
export function recordAdjustment(db: Db, entry: LedgerWrite, note: string): Promise<void> {
  return insert(db, { ...entry, kind: "adjustment", note });
}

/**
 * UI-6 "in transit" is settled payments minus terminal swaps, computed by query
 * (6.1). TODO(E4): implement with a single grouped query and a test that it
 * equals the ledger rows it summarises.
 */
export function inTransitAmount(_db: Db, _sellerId: string): Promise<BaseUnitAmount> {
  throw new Error("not implemented (E4)");
}

/** Guard used by tests: prove the trigger rejects a rewrite attempt. */
export async function assertLedgerIsAppendOnly(db: Db, log: Logger): Promise<void> {
  const [first] = await db.select({ id: ledgerEntries.id }).limit(1);
  if (first === undefined) {
    log.warn({}, "append-only check skipped: ledger is empty");
    return;
  }
  // A7's integration test performs the UPDATE here and expects it to raise.
  // Left unimplemented in the scaffold because a try/catch that swallows the
  // error would make the check worthless.
  throw new Error("not implemented (A7): run UPDATE ledger_entries and expect it to raise");
}
