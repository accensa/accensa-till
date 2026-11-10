import type { PaymentState, SwapState } from "../../states.ts";
import type { PaymentRow, ReconcileConfig, ReconcileSnapshot, SwapRow } from "../types.ts";

/**
 * Fixture builders for rule tests. `now` is fixed so no test reads a clock, and
 * ids are stable strings rather than uuids because rules only compare them.
 * Amounts are bigint base units at 6 decimals, as everywhere else.
 */

export const NOW = new Date("2026-11-02T12:00:00.000Z");

export const CONFIG: ReconcileConfig = {
  sweepWindowSeconds: 300,
  stuckWindowSeconds: 900,
  shortfallToleranceBps: 50,
};

const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

export function payment(overrides: Partial<PaymentRow> & { id: string }): PaymentRow {
  return {
    endpointId: `ep-${overrides.id}`,
    routeId: "route-1",
    // The swap rules' default: a payment that moved through a payout route. A
    // direct payment overrides this and expects no swap (D8).
    payoutMode: "intents",
    amount: 1_000_000n,
    state: "settled" satisfies PaymentState,
    nearTxHash: `tx-${overrides.id}`,
    settledAt: minutesAgo(10),
    verifiedAt: minutesAgo(11),
    ...overrides,
  };
}

export function swap(overrides: Partial<SwapRow> & { id: string }): SwapRow {
  return {
    routeId: "route-1",
    paymentId: null,
    state: "succeeded" satisfies SwapState,
    amountIn: 1_000_000n,
    amountOut: 1_000_000n,
    refundedAmount: null,
    originTxHash: null,
    lastPolledAt: minutesAgo(1),
    // Null by default so the suite below keeps exercising the fallback clock; the
    // provider's own clock has its own tests rather than a changed default.
    providerUpdatedAt: null,
    terminalAt: minutesAgo(2),
    ...overrides,
  };
}

export function snapshot(
  overrides: Partial<ReconcileSnapshot> & { sellerId: string },
): ReconcileSnapshot {
  return {
    now: NOW,
    payments: [],
    swaps: [],
    // Empty by default, which reads as "nothing is booked" rather than "unknown": the
    // settled payments most rule fixtures carry would then hide PAYMENT_UNBOOKED by
    // accident, and a test that wants a payment booked says so (G6·2).
    bookedPaymentIds: [],
    config: CONFIG,
    ...overrides,
  };
}
