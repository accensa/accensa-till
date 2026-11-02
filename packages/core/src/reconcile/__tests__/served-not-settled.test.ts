import { describe, expect, it } from "vitest";
import { servedNotSettled } from "../served-not-settled.ts";
import { payment, snapshot } from "./fixtures.ts";

/**
 * Pattern required by AGENTS.md "Testing": one fixture that produces the
 * discrepancy, one that must not.
 */
describe("SERVED_NOT_SETTLED", () => {
  it("fires when a payment was served but never settled", () => {
    const findings = servedNotSettled(
      snapshot({
        sellerId: "seller-1",
        payments: [payment({ id: "pay-1", state: "served_unsettled" })],
      }),
    );

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe("SERVED_NOT_SETTLED");
    expect(finding?.severity).toBe("critical");
    expect(finding?.dedupeKey).toBe("SERVED_NOT_SETTLED:pay-1:none");
    expect(finding?.explanation.length).toBeGreaterThan(0);
    expect(finding?.suggestedAction.length).toBeGreaterThan(0);
  });

  it("stays silent for a settled payment", () => {
    const findings = servedNotSettled(
      snapshot({ sellerId: "seller-1", payments: [payment({ id: "pay-2", state: "settled" })] }),
    );

    expect(findings).toHaveLength(0);
  });
});
