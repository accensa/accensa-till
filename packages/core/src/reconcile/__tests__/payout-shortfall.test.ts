import { describe, expect, it } from "vitest";

import { payoutShortfall } from "../payout-shortfall.ts";
import { dedupeKeyFor } from "../types.ts";
import { CONFIG, snapshot, swap } from "./fixtures.ts";

/**
 * E10: `PAYOUT_SHORTFALL` (LR-6, High). The swap landed and moved the money, but
 * delivered materially less than it took in — past SHORTFALL_TOLERANCE_BPS. The
 * comparison in `money.ts` is integer (`out * 10000 < in * (10000 - bps)`), so the
 * fixtures below straddle the boundary with one base unit on each side: that is
 * where an off-by-one in the `<=` would hide.
 */
function one(overrides: Parameters<typeof swap>[0]) {
  return payoutShortfall(snapshot({ sellerId: "seller-1", swaps: [swap(overrides)] }));
}

describe("PAYOUT_SHORTFALL (E10, LR-6)", () => {
  it("fires when a succeeded swap delivers materially less than it took in", () => {
    const findings = one({
      id: "swap-1",
      paymentId: "pay-1",
      state: "succeeded",
      amountIn: 1_000_000n,
      amountOut: 500_000n,
    });

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe("PAYOUT_SHORTFALL");
    expect(finding?.severity).toBe("high");
    expect(finding?.paymentId).toBe("pay-1");
    expect(finding?.swapId).toBe("swap-1");
    expect(finding?.dedupeKey).toBe(dedupeKeyFor("PAYOUT_SHORTFALL", "pay-1", "swap-1"));
    expect(finding?.explanation.length).toBeGreaterThan(0);
    expect(finding?.suggestedAction.length).toBeGreaterThan(0);
  });

  it("draws the tolerance line at the boundary, one base unit on each side", () => {
    // CONFIG tolerates 50 bps of a 1_000_000n fill, so 995_000n is exactly the
    // ceiling. 994_999n is the largest amount that is still short; one unit more
    // is inside tolerance. A `<=` instead of `<` would flag 995_000n too.
    expect(one({ id: "swap-short", paymentId: "pay-s", amountOut: 994_999n })).toHaveLength(1);
    expect(one({ id: "swap-exact", paymentId: "pay-e", amountOut: 995_000n })).toHaveLength(0);
  });

  it("stays silent when the fill is inside the tolerance", () => {
    expect(one({ id: "swap-2", paymentId: "pay-2", amountOut: 999_000n })).toHaveLength(0);
    // A clean 1:1 fill and any over-delivery are never a shortfall.
    expect(one({ id: "swap-par", paymentId: "pay-par", amountOut: 1_000_000n })).toHaveLength(0);
    expect(one({ id: "swap-over", paymentId: "pay-over", amountOut: 1_000_500n })).toHaveLength(0);
  });

  it("still fires for a short swap that is not linked to a payment, keyed with none", () => {
    const findings = one({
      id: "swap-3",
      paymentId: null,
      amountIn: 1_000_000n,
      amountOut: 500_000n,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.paymentId).toBeNull();
    expect(findings[0]?.swapId).toBe("swap-3");
    expect(findings[0]?.dedupeKey).toBe("PAYOUT_SHORTFALL:none:swap-3");
  });

  it("stays silent for every state that is not a succeeded swap", () => {
    // `incomplete` is in this list on purpose (D1): the provider does not declare it
    // terminal, so reporting it here would hide it from PAYOUT_STUCK, and a failed or
    // refunded swap has no delivered amount to be short about.
    for (const state of ["pending", "processing", "refunded", "failed", "incomplete"] as const) {
      expect(
        one({ id: `swap-${state}`, state, amountIn: 1_000_000n, amountOut: 500_000n }),
      ).toHaveLength(0);
    }
  });

  it("stays silent when either amount is unknown, because an unknown number is not a shortfall", () => {
    expect(
      one({ id: "swap-no-in", paymentId: "pay-4", amountIn: null, amountOut: 500_000n }),
    ).toHaveLength(0);
    expect(
      one({ id: "swap-no-out", paymentId: "pay-5", amountIn: 1_000_000n, amountOut: null }),
    ).toHaveLength(0);
  });

  it("obeys the configured tolerance rather than a constant", () => {
    const withTolerance = (shortfallToleranceBps: number, amountOut: bigint) =>
      payoutShortfall(
        snapshot({
          sellerId: "seller-1",
          config: { ...CONFIG, shortfallToleranceBps },
          swaps: [swap({ id: "swap-6", paymentId: "pay-6", amountIn: 1_000_000n, amountOut })],
        }),
      );

    // Zero tolerance counts any loss: the 995_000n fill that the default 50 bps lets
    // through is a shortfall when the tolerance drops to nothing.
    expect(withTolerance(0, 995_000n)).toHaveLength(1);
    expect(withTolerance(0, 999_999n)).toHaveLength(1);
    expect(withTolerance(0, 1_000_000n)).toHaveLength(0);
    // 9_999 bps is the widest tolerance that still means something — 10_000 throws
    // (MAX_TOLERANCE_BPS is exclusive), which is money.ts's own test. At 9_999 bps even
    // a half-delivered fill is inside tolerance, so the rule reads the config, not a hard-coded bps.
    expect(withTolerance(9_999, 500_000n)).toHaveLength(0);
    expect(withTolerance(9_999, 0n)).toHaveLength(1);
  });

  it("gives one finding per short swap", () => {
    const findings = payoutShortfall(
      snapshot({
        sellerId: "seller-1",
        swaps: [
          swap({ id: "swap-a", paymentId: "pay-a", amountIn: 1_000_000n, amountOut: 500_000n }),
          swap({ id: "swap-b", paymentId: "pay-b", amountIn: 1_000_000n, amountOut: 999_000n }),
          swap({ id: "swap-c", paymentId: "pay-c", amountIn: 1_000_000n, amountOut: 994_999n }),
          swap({ id: "swap-d", paymentId: null, amountIn: 1_000_000n, amountOut: 500_000n }),
        ],
      }),
    );

    expect(findings.map((finding) => finding.dedupeKey)).toEqual([
      "PAYOUT_SHORTFALL:pay-a:swap-a",
      "PAYOUT_SHORTFALL:pay-c:swap-c",
      "PAYOUT_SHORTFALL:none:swap-d",
    ]);
  });
});
