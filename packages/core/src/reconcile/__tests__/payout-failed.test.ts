import { describe, expect, it } from "vitest";

import { payoutFailed } from "../payout-failed.ts";
import { snapshot, swap } from "./fixtures.ts";

/**
 * E5: `PAYOUT_FAILED` (LR-3, High). Where a refund puts the money back somewhere
 * known, a failure leaves it unaccounted for, so the finding has to reach the
 * seller even when the payment link is missing — a failed swap with no matched
 * payment is still a seller problem, and the rule must not silently require one.
 */
function one(overrides: Parameters<typeof swap>[0]) {
  return payoutFailed(snapshot({ sellerId: "seller-1", swaps: [swap(overrides)] }));
}

describe("PAYOUT_FAILED (E5, LR-3)", () => {
  it("fires when a swap ends failed", () => {
    const findings = one({ id: "swap-1", paymentId: "pay-1", state: "failed" });

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe("PAYOUT_FAILED");
    expect(finding?.severity).toBe("high");
    expect(finding?.paymentId).toBe("pay-1");
    expect(finding?.swapId).toBe("swap-1");
    expect(finding?.dedupeKey).toBe("PAYOUT_FAILED:pay-1:swap-1");
    expect(finding?.explanation.length).toBeGreaterThan(0);
    expect(finding?.suggestedAction.length).toBeGreaterThan(0);
  });

  it("stays silent for a terminal succeeded swap", () => {
    expect(one({ id: "swap-2", state: "succeeded" })).toHaveLength(0);
  });

  it("stays silent for every state that is not failed", () => {
    // `refunded` is reported by its own rule, and `incomplete` is not terminal at
    // all (D1) — firing here for either would double-count or hide a real finding.
    for (const state of ["pending", "processing", "refunded", "incomplete"] as const) {
      expect(one({ id: `swap-${state}`, state })).toHaveLength(0);
    }
  });

  it("fires for a failed swap that never matched a payment", () => {
    // LR-2 says an unmatched swap is a fact about our join, not an absence of a
    // problem: the key carries "none" so LR-5 still dedupes it once.
    const findings = one({ id: "swap-3", paymentId: null, state: "failed" });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.paymentId).toBeNull();
    expect(findings[0]?.dedupeKey).toBe("PAYOUT_FAILED:none:swap-3");
  });

  it("gives one finding per failed swap", () => {
    const findings = payoutFailed(
      snapshot({
        sellerId: "seller-1",
        swaps: [
          swap({ id: "swap-a", paymentId: "pay-a", state: "failed" }),
          swap({ id: "swap-b", state: "succeeded" }),
          swap({ id: "swap-c", state: "failed" }),
        ],
      }),
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.swapId)).toEqual(["swap-a", "swap-c"]);
  });

  it("carries no invented details", () => {
    // Where PAYOUT_REFUNDED reports an amount, a failure has no trustworthy number
    // yet, and putting one here would read as a fact.
    expect(one({ id: "swap-4", state: "failed", amountOut: null })[0]?.details).toBeUndefined();
  });
});
