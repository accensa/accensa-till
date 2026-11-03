import { describe, expect, it } from "vitest";

import {
  IllegalPaymentTransition,
  PAYMENT_STATES,
  type PaymentState,
  SWAP_STATES,
  TERMINAL_SWAP_STATES,
  assertPaymentTransition,
  canTransitionPayment,
  isTerminalSwapState,
  normalizeSwapState,
} from "../states.ts";

/**
 * C3's Done-when is "every allowed and every forbidden move", so the payment
 * matrix is enumerated rather than sampled: 4 states make 16 ordered pairs, 4 of
 * them legal, and a test that only checked the happy path would let
 * `settled -> verified` through the door.
 */
const ALLOWED: readonly [PaymentState, PaymentState][] = [
  ["verified", "settled"],
  ["verified", "abandoned"],
  ["verified", "served_unsettled"],
  ["served_unsettled", "settled"],
];

function isAllowed(from: PaymentState, to: PaymentState): boolean {
  return ALLOWED.some(([a, b]) => a === from && b === to);
}

describe("payment state machine (C3, GW-2, GW-4)", () => {
  const pairs: [PaymentState, PaymentState][] = PAYMENT_STATES.flatMap((from) =>
    PAYMENT_STATES.map((to) => [from, to] as [PaymentState, PaymentState]),
  );

  it("enumerates all sixteen ordered pairs, so the matrix below is complete", () => {
    expect(pairs).toHaveLength(16);
    expect(pairs).toHaveLength(PAYMENT_STATES.length ** 2);
  });

  it.each(pairs)("handles %s -> %s exactly as the table says", (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(isAllowed(from, to));
    if (isAllowed(from, to)) {
      expect(() => assertPaymentTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertPaymentTransition(from, to)).toThrow(IllegalPaymentTransition);
    }
  });

  it("names the illegal move in the error, so a log says which guard fired", () => {
    expect(() => assertPaymentTransition("settled", "verified")).toThrow(
      "payment cannot move settled -> verified",
    );
  });

  it("keeps the two terminal states terminal, including for themselves", () => {
    for (const state of ["settled", "abandoned"] as const) {
      for (const to of PAYMENT_STATES) {
        expect(canTransitionPayment(state, to)).toBe(false);
      }
    }
  });
});

describe("swap states (D1, PO-4)", () => {
  it("keeps succeeded, refunded and failed terminal", () => {
    for (const state of ["succeeded", "refunded", "failed"] as const) {
      expect(isTerminalSwapState(state)).toBe(true);
    }
  });

  it("keeps pending and processing non-terminal", () => {
    for (const state of ["pending", "processing"] as const) {
      expect(isTerminalSwapState(state)).toBe(false);
    }
  });

  // `incomplete` is deliberately not asserted here: D1 (from spike S5) is the open
  // question of whether the provider treats INCOMPLETE_DEPOSIT as terminal, and a
  // test that pinned either answer would pre-empt that decision.

  it.each(SWAP_STATES)("agrees about %s between the list and the predicate", (state) => {
    expect(TERMINAL_SWAP_STATES.includes(state)).toBe(isTerminalSwapState(state));
  });

  it("maps an unrecognised provider status to processing rather than guessing", () => {
    expect(normalizeSwapState("WAITING_FOR_COUNTERPARTY")).toBe("processing");
    expect(normalizeSwapState("")).toBe("processing");
    expect(normalizeSwapState("succeeded")).toBe("succeeded");
  });
});
