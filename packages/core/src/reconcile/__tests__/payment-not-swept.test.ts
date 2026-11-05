import { describe, expect, it } from "vitest";

import { paymentNotSwept } from "../payment-not-swept.ts";
import { CONFIG, NOW, payment, snapshot, swap } from "./fixtures.ts";

/**
 * E7: `PAYMENT_NOT_SWEPT` (LR-3, High). A settled payment whose transaction
 * hash no swap carries is money that reached Till and never moved toward the
 * seller. Matching is by hash and nothing else (LR-2), so a payment with no
 * recorded hash is a data problem rather than a finding, and a `direct` payment
 * is skipped by definition because its pay-to already was the seller (D8).
 */
function at(
  overrides: Parameters<typeof payment>[0],
  swaps: readonly Parameters<typeof swap>[0][] = [],
) {
  return paymentNotSwept(
    snapshot({
      sellerId: "seller-1",
      payments: [payment(overrides)],
      swaps: swaps.map((entry) => swap(entry)),
    }),
  );
}

describe("PAYMENT_NOT_SWEPT (E7, LR-3)", () => {
  it("fires for a settled payment whose hash matches no swap", () => {
    const findings = at({ id: "pay-1" });

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe("PAYMENT_NOT_SWEPT");
    expect(finding?.severity).toBe("high");
    expect(finding?.paymentId).toBe("pay-1");
    expect(finding?.swapId).toBeNull();
    expect(finding?.dedupeKey).toBe("PAYMENT_NOT_SWEPT:pay-1:none");
    expect(finding?.details).toEqual({ nearTxHash: "tx-pay-1" });
    expect(finding?.explanation.length).toBeGreaterThan(0);
    expect(finding?.suggestedAction.length).toBeGreaterThan(0);
  });

  it("stays silent when a swap carries the same origin hash", () => {
    expect(at({ id: "pay-2" }, [{ id: "swap-2", originTxHash: "tx-pay-2" }])).toEqual([]);
  });

  it("still fires when the swaps it can see carry other hashes", () => {
    const findings = at({ id: "pay-3" }, [{ id: "swap-3", originTxHash: "tx-someone-else" }]);
    expect(findings.map((finding) => finding.paymentId)).toEqual(["pay-3"]);
  });

  it("does not judge a payment with no recorded hash, because there is nothing to match", () => {
    expect(at({ id: "pay-4", nearTxHash: null })).toEqual([]);
  });

  it("does not judge a payment that has not settled", () => {
    for (const state of ["verified", "served_unsettled", "abandoned"] as const) {
      expect(at({ id: `pay-${state}`, state })).toEqual([]);
    }
    // The state alone does not say when the sweep became due, and the window
    // cannot be aged without settled_at.
    expect(at({ id: "pay-undated", settledAt: null })).toEqual([]);
  });

  it("uses the configured window rather than a literal", () => {
    const inside = new Date(NOW.getTime() - 4 * 60_000);
    const boundary = new Date(NOW.getTime() - CONFIG.sweepWindowSeconds * 1000);

    expect(at({ id: "pay-recent", settledAt: inside })).toEqual([]);
    // Exactly at the window is due: the rule skips only ages strictly below it.
    expect(at({ id: "pay-boundary", settledAt: boundary })).toHaveLength(1);
  });

  it("reports one finding per un-swept payment, keyed by that payment", () => {
    const findings = paymentNotSwept(
      snapshot({
        sellerId: "seller-1",
        payments: [payment({ id: "pay-a" }), payment({ id: "pay-b" }), payment({ id: "pay-c" })],
        swaps: [swap({ id: "swap-a", originTxHash: "tx-pay-b" })],
      }),
    );

    expect(findings.map((finding) => finding.dedupeKey)).toEqual([
      "PAYMENT_NOT_SWEPT:pay-a:none",
      "PAYMENT_NOT_SWEPT:pay-c:none",
    ]);
  });

  it("stays silent for a direct payment, whose pay-to was the seller (D8)", () => {
    // The same settled payment, with no swap referencing its hash, judged in both
    // modes: `intents` is un-swept and fires, `direct` paid the seller in the same
    // transfer and has nothing to sweep. A rule that lost the mode check would
    // flag every direct sale, so the pair is the assertion.
    const inMode = (payoutMode: "direct" | "intents") =>
      paymentNotSwept(
        snapshot({
          sellerId: "seller-1",
          payments: [payment({ id: `pay-${payoutMode}`, payoutMode })],
        }),
      );

    expect(inMode("intents").map((finding) => finding.code)).toEqual(["PAYMENT_NOT_SWEPT"]);
    expect(inMode("direct")).toEqual([]);
  });
});
