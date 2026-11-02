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

export const TERMINAL_SWAP_STATES: readonly SwapState[] = [
  "succeeded",
  "refunded",
  "failed",
  "incomplete",
];

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
