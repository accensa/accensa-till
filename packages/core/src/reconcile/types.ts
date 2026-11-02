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
] as const;
export type DiscrepancyCode = (typeof DISCREPANCY_CODES)[number];

export const P0_DISCREPANCY_CODES: readonly DiscrepancyCode[] = [
  "SERVED_NOT_SETTLED",
  "PAYOUT_REFUNDED",
  "PAYOUT_FAILED",
  "PAYOUT_STUCK",
  "PAYMENT_NOT_SWEPT",
];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type PaymentRow = {
  readonly id: string;
  readonly endpointId: string;
  readonly routeId: string | null;
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
  readonly terminalAt: Date | null;
};

export type ReconcileConfig = {
  /** PAYMENT_NOT_SWEPT window: settled payment with no swap activity after this. */
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

export function dedupeKeyFor(
  code: DiscrepancyCode,
  paymentId: string | null,
  swapId: string | null,
): string {
  return `${code}:${paymentId ?? "none"}:${swapId ?? "none"}`;
}
