import type { BaseUnitAmount } from "@till/core";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { ledgerEntries } from "../db/schema.ts";

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

/**
 * The kind that says a settlement reached the ledger, named once because two files
 * have to agree on it: this module writes it beside every settled payment, and
 * `jobs/reconcile.ts` reads it back to decide whether a settled payment is booked
 * (G6·2). A string that drifts between the writer and that reader silences
 * `PAYMENT_UNBOOKED` for every payment in the seller's book.
 */
export const SETTLEMENT_LEDGER_KIND = "payment_in" satisfies LedgerKind;

export type PayoutMode = "direct" | "intents";

export type LedgerWrite = {
  readonly sellerId: string;
  readonly kind: LedgerKind;
  readonly amount: BaseUnitAmount;
  readonly asset: string;
  readonly paymentId?: string | null;
  readonly swapId?: string | null;
  readonly note?: string | null;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Drizzle types a numeric(78,0) column as a string; base units arrive as bigint
 * and are serialised here so no caller has to remember the convention. The
 * writer accepts the transaction as well as the handle so a settlement's lines
 * can be one atomic write.
 */
async function insert(db: Db | Tx, entry: LedgerWrite): Promise<void> {
  await db.insert(ledgerEntries).values({
    sellerId: entry.sellerId,
    kind: entry.kind,
    amount: entry.amount.toString(),
    asset: entry.asset,
    paymentId: entry.paymentId ?? null,
    swapId: entry.swapId ?? null,
    note: entry.note ?? null,
  });
}

/**
 * GW-2 + D8: a settled payment books its `payment_in`, and in `direct` mode it
 * books the `payout_out` in the same transaction. There is no swap in that mode:
 * the x402 transfer paid the seller's own account, so the payout is the same
 * money moving once, and a ledger showing money in without the matching out
 * would read as an unpaid seller. `intents` books only the payment; its payout
 * belongs to D6 and arrives when the swap succeeds.
 */
export async function recordSettlement(
  db: Db | Tx,
  entry: Omit<LedgerWrite, "kind">,
  payoutMode: PayoutMode,
): Promise<void> {
  const write = async (tx: Db | Tx) => {
    await insert(tx, { ...entry, kind: SETTLEMENT_LEDGER_KIND });
    if (payoutMode === "direct") {
      await insert(tx, {
        ...entry,
        kind: "payout_out",
        note: "direct: the x402 transfer paid the seller's own account",
      });
    }
  };

  if ("transaction" in db && typeof db.transaction === "function") {
    await db.transaction(write);
  } else {
    await write(db);
  }
}

/**
 * D6: a swap reaching `succeeded` writes one `payout_out`.
 *
 * The kind is the function's, not the caller's: a `LedgerWrite` whose `kind` this
 * parameter overrode would let a caller type `refund_in` and get a payout, which is
 * the one mistake a ledger is supposed to make impossible.
 *
 * `Db | Tx` is D6's: the poller writes a swap's terminal state and its ledger line in
 * the same transaction it claimed the row in, so a payout that reached terminal has a
 * line or the state change did not commit -- never a terminal swap nobody booked.
 */
export function recordPayoutOut(db: Db | Tx, entry: Omit<LedgerWrite, "kind">): Promise<void> {
  return insert(db, { ...entry, kind: "payout_out" });
}

/** D6: a swap reaching `refunded` writes one `refund_in`. */
export function recordRefundIn(db: Db | Tx, entry: Omit<LedgerWrite, "kind">): Promise<void> {
  return insert(db, { ...entry, kind: "refund_in" });
}

/** The only permitted way to fix a wrong number: add a compensating row. */
export function recordAdjustment(
  db: Db,
  entry: Omit<LedgerWrite, "kind">,
  note: string,
): Promise<void> {
  return insert(db, { ...entry, kind: "adjustment", note });
}

export type LedgerExportRow = {
  readonly id: string;
  readonly createdAt: Date;
  readonly kind: LedgerKind;
  readonly amount: string;
  readonly asset: string;
  readonly paymentId: string | null;
  readonly swapId: string | null;
  readonly note: string | null;
};

export const DEFAULT_LEDGER_EXPORT_LIMIT = 10_000;

/**
 * LR-7 (F7): read ledger entries for a seller, ordered newest-first, for CSV export.
 */
export async function listLedgerForExport(
  db: Db,
  sellerId: string,
  limit = DEFAULT_LEDGER_EXPORT_LIMIT,
): Promise<LedgerExportRow[]> {
  const rows = await db
    .select({
      id: ledgerEntries.id,
      createdAt: ledgerEntries.createdAt,
      kind: ledgerEntries.kind,
      amount: ledgerEntries.amount,
      asset: ledgerEntries.asset,
      paymentId: ledgerEntries.paymentId,
      swapId: ledgerEntries.swapId,
      note: ledgerEntries.note,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.sellerId, sellerId))
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id))
    .limit(limit);

  return rows as LedgerExportRow[];
}
