import { describe, expect, it } from "vitest";

import { runAllRules } from "../index.ts";
import { P0_DISCREPANCY_CODES, SEVERITIES, dedupeKeyFor } from "../types.ts";
import { NOW, payment, snapshot, swap } from "./fixtures.ts";

/**
 * E8, LR-4: the copy the dashboard shows comes from the finding, so a rule that
 * fires with an empty explanation or a missing suggested action has no other
 * layer to catch it. One snapshot triggers every P0 code at once — the five
 * rules are independent, and this test is about what all of them are required
 * to say, not about any one rule's condition.
 */
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

describe("LR-4 copy on every P0 finding (E8)", () => {
  const findings = runAllRules(
    snapshot({
      sellerId: "seller-1",
      payments: [
        // SERVED_NOT_SETTLED: answered, never settled.
        payment({ id: "pay-served", state: "served_unsettled" }),
        // PAYMENT_NOT_SWEPT: settled past the window, and no swap carries this hash.
        payment({ id: "pay-un-swept" }),
      ],
      swaps: [
        swap({ id: "swap-refunded", state: "refunded", refundedAmount: null }),
        swap({ id: "swap-failed", state: "failed" }),
        swap({ id: "swap-stuck", state: "processing", lastPolledAt: minutesAgo(20) }),
      ],
    }),
  );

  it("every P0 code fires and no other code does", () => {
    const codes = [...new Set(findings.map((finding) => finding.code))].sort();
    expect(codes).toEqual([...P0_DISCREPANCY_CODES].sort());
  });

  it("each finding carries plain-language copy and the LR-5 dedupe key", () => {
    for (const finding of findings) {
      expect(finding.explanation.trim().length, finding.code).toBeGreaterThan(20);
      expect(finding.suggestedAction.trim().length, finding.code).toBeGreaterThan(20);
      expect(finding.explanation).not.toContain("_");
      expect(SEVERITIES).toContain(finding.severity);
      expect(finding.dedupeKey).toBe(dedupeKeyFor(finding.code, finding.paymentId, finding.swapId));
    }
  });
});
