import { describe, expect, it } from "vitest";

import {
  IllegalPaymentTransition,
  IllegalSwapTransition,
  PAYMENT_STATES,
  type PaymentState,
  SWAP_STATES,
  type SwapState,
  TERMINAL_SWAP_STATES,
  assertPaymentTransition,
  assertSwapTransition,
  canTransitionPayment,
  canTransitionSwap,
  isTerminalSwapState,
  normalizeSwapState,
} from "../states.ts";

/**
 * C3's Done-when is "every allowed and every forbidden move", so the payment
 * matrix is enumerated rather than sampled: 4 states make 16 ordered pairs, and a
 * test that only checked the happy path would let `settled -> verified` through
 * the door. C7 added exactly one edge (`abandoned -> verified`), which is why the
 * enumeration is worth its five lines: the new edge is allowed and the fifteen
 * around it are still refused, all asserted from this table.
 */
const ALLOWED: readonly [PaymentState, PaymentState][] = [
  ["verified", "settled"],
  ["verified", "abandoned"],
  ["verified", "served_unsettled"],
  ["served_unsettled", "settled"],
  // C7, GW-4: an abandoned payment may be retried with the same authorization.
  ["abandoned", "verified"],
];

function isAllowed(from: PaymentState, to: PaymentState): boolean {
  return ALLOWED.some(([a, b]) => a === from && b === to);
}

/** D1's half of the same discipline: the swap machine enumerated, not sampled. */
const SWAP_ALLOWED: readonly [SwapState, SwapState][] = [
  ["pending", "processing"],
  ["pending", "succeeded"],
  ["pending", "refunded"],
  ["pending", "failed"],
  ["pending", "incomplete"],
  ["processing", "succeeded"],
  ["processing", "refunded"],
  ["processing", "failed"],
  ["processing", "incomplete"],
  ["incomplete", "succeeded"],
  ["incomplete", "refunded"],
  ["incomplete", "failed"],
];

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

  it("keeps `settled` terminal against every state, including itself", () => {
    for (const to of PAYMENT_STATES) {
      expect(canTransitionPayment("settled", to)).toBe(false);
    }
  });

  it("gives `abandoned` exactly one way out, and it is not a settlement (C7, GW-4)", () => {
    // The retry edge C7 opens is the only door out of `abandoned`. In particular
    // `abandoned -> settled` stays refused: a row that is being retried has to go
    // back through `verified`, which is where a fresh chain read happens, and a
    // jump straight to money would let an old failure settle on a new request's
    // say-so. `abandoned -> served_unsettled` is refused for the same reason --
    // nothing was served.
    expect(PAYMENT_STATES.filter((to) => canTransitionPayment("abandoned", to))).toEqual([
      "verified",
    ]);
  });

  it("keeps `served_unsettled` moving only toward settlement (C7)", () => {
    // No edge back to `verified`: a replay must not earn a second delivery for
    // money that may already have moved. E2's sweep settles it, the route does not.
    expect(PAYMENT_STATES.filter((to) => canTransitionPayment("served_unsettled", to))).toEqual([
      "settled",
    ]);
  });

  it("allows exactly the five named edges, so no edge arrives unannounced", () => {
    const allowed = PAYMENT_STATES.flatMap((from) =>
      PAYMENT_STATES.filter((to) => canTransitionPayment(from, to)).map((to) => `${from} -> ${to}`),
    );
    expect(allowed).toHaveLength(ALLOWED.length);
    expect(allowed.sort()).toEqual(ALLOWED.map(([from, to]) => `${from} -> ${to}`).sort());
  });
});

describe("swap states (D1, PO-4, S5)", () => {
  const pairs: [SwapState, SwapState][] = SWAP_STATES.flatMap((from) =>
    SWAP_STATES.map((to) => [from, to] as [SwapState, SwapState]),
  );

  it("keeps exactly the three provider-declared states terminal, and `incomplete` out", () => {
    expect(TERMINAL_SWAP_STATES).toEqual(["succeeded", "refunded", "failed"]);
    // S5: the provider does not declare INCOMPLETE_DEPOSIT terminal, and it is the
    // one state where money arrives short. Leaving it here hid it from
    // payout-stuck.ts, so the decision is asserted rather than implied.
    expect(isTerminalSwapState("incomplete")).toBe(false);
  });

  it("enumerates all thirty-six ordered pairs of swap states", () => {
    expect(pairs).toHaveLength(36);
    expect(pairs).toHaveLength(SWAP_STATES.length ** 2);
  });

  it.each(pairs)("handles %s -> %s exactly as the table says", (from, to) => {
    expect(canTransitionSwap(from, to)).toBe(SWAP_ALLOWED.some(([a, b]) => a === from && b === to));
    if (SWAP_ALLOWED.some(([a, b]) => a === from && b === to)) {
      expect(() => assertSwapTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertSwapTransition(from, to)).toThrow(IllegalSwapTransition);
    }
  });

  it.each(TERMINAL_SWAP_STATES)("keeps %s sticky, including against itself", (from) => {
    for (const to of SWAP_STATES) {
      expect(canTransitionSwap(from, to)).toBe(false);
    }
  });

  it("lets an incomplete swap resolve, because the provider may still move it", () => {
    for (const to of ["succeeded", "refunded", "failed"] as const) {
      expect(canTransitionSwap("incomplete", to)).toBe(true);
    }
    // but it cannot go backwards into a state the poller would call fresh.
    expect(canTransitionSwap("incomplete", "pending")).toBe(false);
    expect(canTransitionSwap("incomplete", "incomplete")).toBe(false);
  });

  it("reaches a terminal state on the first poll from either open state", () => {
    for (const from of ["pending", "processing"] as const) {
      for (const to of TERMINAL_SWAP_STATES) {
        expect(canTransitionSwap(from, to)).toBe(true);
      }
    }
  });

  it("names the illegal move in the error", () => {
    expect(() => assertSwapTransition("succeeded", "processing")).toThrow(
      "swap cannot move succeeded -> processing",
    );
  });

  it.each(SWAP_STATES)("agrees about %s between the list and the predicate", (state) => {
    expect(TERMINAL_SWAP_STATES.includes(state)).toBe(isTerminalSwapState(state));
  });

  it("maps an unrecognised provider status to processing rather than guessing", () => {
    expect(normalizeSwapState("WAITING_FOR_COUNTERPARTY")).toBe("processing");
    expect(normalizeSwapState("")).toBe("processing");
    // normalizeSwapState knows our state names, not the provider's SCREAMING_SNAKE
    // enum, so a raw status lands here as unknown until the client maps it (D3).
    // Guessing `incomplete` from "INCOMPLETE_DEPOSIT" would be the same silent
    // money-losing mistake S5 found, made in the other direction.
    expect(normalizeSwapState("INCOMPLETE_DEPOSIT")).toBe("processing");
    expect(normalizeSwapState("succeeded")).toBe("succeeded");
  });
});
