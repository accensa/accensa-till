import { describe, expect, it } from "vitest";

import { payoutRefunded } from "../payout-refunded.ts";
import { CONFIG, snapshot, swap } from "./fixtures.ts";

/**
 * E4: `PAYOUT_REFUNDED` (LR-3, High). A refund is the case where the seller still
 * has the money but it did not reach the destination chain, so the finding has to
 * say how much came back — that is what makes a partial refund visible instead of
 * reading as a success.
 */
function one(overrides: Parameters<typeof swap>[0]) {
  return payoutRefunded(snapshot({ sellerId: "seller-1", swaps: [swap(overrides)] }));
}

describe("PAYOUT_REFUNDED (E4, LR-3)", () => {
  it("fires when a swap reaches refunded", () => {
    const findings = one({ id: "swap-1", paymentId: "pay-1", state: "refunded" });

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe("PAYOUT_REFUNDED");
    expect(finding?.severity).toBe("high");
    expect(finding?.paymentId).toBe("pay-1");
    expect(finding?.swapId).toBe("swap-1");
    expect(finding?.dedupeKey).toBe("PAYOUT_REFUNDED:pay-1:swap-1");
    expect(finding?.explanation.length).toBeGreaterThan(0);
    expect(finding?.suggestedAction.length).toBeGreaterThan(0);
  });

  it("stays silent when the swap succeeded", () => {
    expect(one({ id: "swap-2", state: "succeeded" })).toHaveLength(0);
  });

  it("stays silent for every state that is not a refund", () => {
    // `incomplete` belongs in this list on purpose (D1): it is not terminal and it
    // is not a refund, and reporting it here would hide it from PAYOUT_STUCK.
    for (const state of ["pending", "processing", "failed", "incomplete"] as const) {
      expect(one({ id: `swap-${state}`, state })).toHaveLength(0);
    }
  });

  it("reports the refunded amount in display units, because a partial refund must show", () => {
    const findings = one({
      id: "swap-3",
      paymentId: "pay-3",
      state: "refunded",
      amountIn: 1_000_000n,
      refundedAmount: 250_000n,
    });

    expect(findings[0]?.details).toEqual({ refundedAmount: "0.25" });
  });

  it("omits the detail rather than inventing a zero when the provider gave no amount", () => {
    const findings = one({ id: "swap-4", state: "refunded", refundedAmount: null });
    expect(findings[0]?.details).toBeUndefined();
  });

  it("gives one finding per refunded swap", () => {
    const findings = payoutRefunded(
      snapshot({
        sellerId: "seller-1",
        swaps: [
          swap({ id: "swap-a", paymentId: "pay-a", state: "refunded" }),
          swap({ id: "swap-b", state: "succeeded" }),
          swap({ id: "swap-c", paymentId: null, state: "refunded" }),
        ],
      }),
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.dedupeKey)).toEqual([
      "PAYOUT_REFUNDED:pay-a:swap-a",
      "PAYOUT_REFUNDED:none:swap-c",
    ]);
  });

  it("does not read the window or the clock it was not given", () => {
    // A refund is terminal and factual: unlike PAYOUT_STUCK it must not depend on
    // config or on how long ago the swap was polled.
    const stale = swap({
      id: "swap-old",
      state: "refunded",
      lastPolledAt: new Date(Date.parse("2020-01-01T00:00:00.000Z")),
    });
    const findings = payoutRefunded(
      snapshot({
        sellerId: "seller-1",
        swaps: [stale],
        config: { ...CONFIG, stuckWindowSeconds: 1 },
      }),
    );
    expect(findings).toHaveLength(1);
  });
});
