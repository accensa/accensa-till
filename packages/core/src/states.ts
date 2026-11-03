/**
 * State machines for payments and swaps (C3, PO-4). Terminal swap states are
 * sticky: a provider status that appears to move a swap out of terminal is
 * ignored by the caller, not thrown away here, so it can be logged.
 */

export const PAYMENT_STATES = ["verified", "abandoned", "settled", "served_unsettled"] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const SWAP_STATES = [
  "pending",
  "processing",
  "succeeded",
  "refunded",
  "failed",
  "incomplete",
] as const;
export type SwapState = (typeof SWAP_STATES)[number];

/**
 * Terminal for a swap means the provider declared it terminal, so nothing may
 * move it again (PO-4).
 *
 * `incomplete` is deliberately absent (D1, from spike S5): the 1Click status enum
 * only declares `SUCCESS`, `REFUNDED` and `FAILED` terminal, and an
 * `INCOMPLETE_DEPOSIT` can still resolve. Keeping it here would have made the
 * state where money arrives short invisible to `payout-stuck.ts`, so the smaller
 * of the two fixes S5 offered is the one taken: it is not terminal, and PAYOUT_STUCK
 * fires on it after the window like any other unresolved swap.
 */
export const TERMINAL_SWAP_STATES: readonly SwapState[] = ["succeeded", "refunded", "failed"];

export function isTerminalSwapState(state: SwapState): boolean {
  return TERMINAL_SWAP_STATES.includes(state);
}

/**
 * Anything the provider reports that we do not recognise stays `processing`
 * (PO-4), which lets PAYOUT_STUCK fire after the window instead of guessing.
 */
export function normalizeSwapState(raw: string): SwapState {
  return (SWAP_STATES as readonly string[]).includes(raw) ? (raw as SwapState) : "processing";
}

const PAYMENT_TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  // GW-2: verified -> settled on 2xx after settle; verified -> abandoned on
  // non-2xx, timeout or guard rejection.
  // GW-3 / SERVED_NOT_SETTLED: served_unsettled -> settled once settlement lands.
  verified: ["settled", "abandoned", "served_unsettled"],
  served_unsettled: ["settled"],
  abandoned: [],
  settled: [],
};

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export class IllegalPaymentTransition extends Error {
  constructor(
    readonly from: PaymentState,
    readonly to: PaymentState,
  ) {
    super(`payment cannot move ${from} -> ${to}`);
    this.name = "IllegalPaymentTransition";
  }
}

export function assertPaymentTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransitionPayment(from, to)) {
    throw new IllegalPaymentTransition(from, to);
  }
}

/**
 * A swap only ever moves forward (PO-4). Terminal states are sticky, and the
 * poller is expected to log and ignore a provider status that disagrees with
 * them rather than let it rewrite history — this table is what "disagree" means.
 *
 * A swap that has never been polled may already be terminal, which is why
 * `pending` reaches every other state: the first status the provider returns is
 * the transition, not a confirmation of one we watched happen.
 */
const SWAP_TRANSITIONS: Record<SwapState, readonly SwapState[]> = {
  pending: ["processing", "succeeded", "refunded", "failed", "incomplete"],
  processing: ["succeeded", "refunded", "failed", "incomplete"],
  // S5: the provider does not declare INCOMPLETE_DEPOSIT terminal, so it may
  // still resolve into one that it does declare.
  incomplete: ["succeeded", "refunded", "failed"],
  succeeded: [],
  refunded: [],
  failed: [],
};

export function canTransitionSwap(from: SwapState, to: SwapState): boolean {
  return SWAP_TRANSITIONS[from].includes(to);
}

export class IllegalSwapTransition extends Error {
  constructor(
    readonly from: SwapState,
    readonly to: SwapState,
  ) {
    super(`swap cannot move ${from} -> ${to}`);
    this.name = "IllegalSwapTransition";
  }
}

export function assertSwapTransition(from: SwapState, to: SwapState): void {
  if (!canTransitionSwap(from, to)) {
    throw new IllegalSwapTransition(from, to);
  }
}
