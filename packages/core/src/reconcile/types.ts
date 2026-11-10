/**
 * Types for the reconciliation engine (section 7). Rules are pure: no database,
 * HTTP or clock access, so every input they need arrives in the snapshot and
 * `now` is the database clock, not `Date.now()` (AGENTS.md hard rules 6 and 12).
 */

import type { BaseUnitAmount } from "../money.ts";
import type { PaymentState, SwapState } from "../states.ts";

export const DISCREPANCY_CODES = [
  "SERVED_NOT_SETTLED",
  "PAYOUT_REFUNDED",
  "PAYOUT_FAILED",
  "PAYOUT_STUCK",
  "PAYMENT_NOT_SWEPT",
  "PAYOUT_SHORTFALL",
  "INCOMPLETE_DEPOSIT",
  "ORPHAN_DEPOSIT",
  "PAYMENT_UNBOOKED",
] as const;
export type DiscrepancyCode = (typeof DISCREPANCY_CODES)[number];

export const P0_DISCREPANCY_CODES: readonly DiscrepancyCode[] = [
  "SERVED_NOT_SETTLED",
  "PAYOUT_REFUNDED",
  "PAYOUT_FAILED",
  "PAYOUT_STUCK",
  "PAYMENT_NOT_SWEPT",
  // G6·2: the seller was paid and the book of record does not say so, so every
  // balance the dashboard shows for that payment is short by exactly its amount.
  "PAYMENT_UNBOOKED",
];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type PaymentRow = {
  readonly id: string;
  readonly endpointId: string;
  readonly routeId: string | null;
  /**
   * D8: `direct` pays the seller's own account in the same x402 transfer, so there
   * is no swap to sweep and its absence is not a finding. `intents` moves through
   * a payout route and is the only mode a swap rule should judge.
   */
  readonly payoutMode: "direct" | "intents";
  readonly amount: BaseUnitAmount;
  readonly state: PaymentState;
  readonly nearTxHash: string | null;
  readonly settledAt: Date | null;
  readonly verifiedAt: Date;
};

export type SwapRow = {
  readonly id: string;
  readonly routeId: string;
  readonly paymentId: string | null;
  readonly state: SwapState;
  readonly amountIn: BaseUnitAmount | null;
  readonly amountOut: BaseUnitAmount | null;
  readonly refundedAmount: BaseUnitAmount | null;
  readonly originTxHash: string | null;
  readonly lastPolledAt: Date | null;
  /**
   * S5, consequence 2: the provider's own clock for this swap, read off its status
   * payload, so a stuck payout is aged on when the money last moved rather than on
   * when Till last asked. Null for a provider that does not report one — the mock
   * among them (D3) — and every reader falls back to `lastPolledAt` for those.
   */
  readonly providerUpdatedAt: Date | null;
  readonly terminalAt: Date | null;
};

export type ReconcileConfig = {
  /**
   * PAYMENT_NOT_SWEPT window: settled payment with no swap activity after this.
   *
   * PAYMENT_UNBOOKED (G6·2) ages on the same number rather than on a knob of its own.
   * The two questions are different — "did anything move" and "was the money booked" —
   * but both are "the settle happened long enough ago that the writer has had its
   * turn", and the gateway books in the request that settles, so a window that is wide
   * enough not to read a millisecond's race as a finding is wide enough for both.
   */
  readonly sweepWindowSeconds: number;
  /** PAYOUT_STUCK window for a swap still processing or in an unknown state. */
  readonly stuckWindowSeconds: number;
  /** PAYOUT_SHORTFALL tolerance, basis points of amountIn (LR-6, D11). */
  readonly shortfallToleranceBps: number;
};

export type ReconcileSnapshot = {
  readonly sellerId: string;
  /** Database time, supplied by the caller. */
  readonly now: Date;
  readonly payments: readonly PaymentRow[];
  readonly swaps: readonly SwapRow[];
  /**
   * The payments of this seller that have their settlement booked — a `payment_in`
   * row in `ledger_entries` naming them (G6·2). A list rather than a set of amounts
   * because the rule judges existence, not the number: whether the amount on the line
   * is right is the ledger's own CHECK constraints and A19's business, and a rule that
   * re-derived balances would disagree with the balance read for a reason nobody could
   * explain to a seller.
   *
   * Required, and empty means "nothing is booked" rather than "unknown": a reader that
   * cannot answer the question has to say so by marking the pass partial, the way
   * E9's row cap does, because the alternative default silences the finding for every
   * settled payment in the snapshot.
   */
  readonly bookedPaymentIds: readonly string[];
  readonly config: ReconcileConfig;
};

export type Finding = {
  readonly code: DiscrepancyCode;
  readonly severity: Severity;
  readonly paymentId: string | null;
  readonly swapId: string | null;
  /** code plus subject ids; the partial unique index dedupes open rows on this (LR-5). */
  readonly dedupeKey: string;
  readonly explanation: string;
  readonly suggestedAction: string;
  readonly details?: Record<string, string>;
};

export type ReconcileRule = (snapshot: ReconcileSnapshot) => readonly Finding[];

/**
 * Where a severity sits in the worklist. The order is `SEVERITIES` itself, written
 * most-urgent-first, and this is the only reading of it: the dashboard's sort (F4)
 * builds its SQL from here rather than keeping a rank table of its own, so a screen
 * cannot list `high` above `critical` because somebody retyped the list.
 *
 * Throws on a word that is not a severity. The parameter is the enum, so the only
 * way to reach it is a value that came from outside TypeScript — a stored row, a
 * provider string — which is exactly when a silent `undefined` rank would reorder
 * the page.
 */
export function severityRank(severity: Severity): number {
  const rank = SEVERITIES.indexOf(severity);
  if (rank === -1) {
    throw new RangeError(`unknown severity: ${String(severity)}`);
  }
  return rank;
}

export function dedupeKeyFor(
  code: DiscrepancyCode,
  paymentId: string | null,
  swapId: string | null,
): string {
  return `${code}:${paymentId ?? "none"}:${swapId ?? "none"}`;
}
