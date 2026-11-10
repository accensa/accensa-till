import { describe, expect, it } from "vitest";

import { paymentUnbooked } from "../payment-unbooked.ts";
import { NOW, payment, snapshot } from "./fixtures.ts";

/**
 * G6·2: `PAYMENT_UNBOOKED` (Critical). The gateway settles a payment and books the
 * `payment_in` line in two separate transactions, so a throw, an exhausted pool or a
 * death between them leaves money taken and a ledger that never heard of it — a shape
 * no other rule can see, because the sweep asks about `verified` rows and
 * `payment-not-swept.ts` asks about swaps.
 *
 * The window is part of the rule rather than decoration: the book happens in the same
 * request as the settle, so a payment settled a moment ago is a race, and one settled
 * longer than `sweepWindowSeconds` ago is a hole.
 */

/** CONFIG's sweep window is 300 s, so "older" means any minute count above five. */
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

function one(overrides: Parameters<typeof payment>[0], booked: readonly string[] = []) {
  return paymentUnbooked(
    snapshot({ sellerId: "seller-1", payments: [payment(overrides)], bookedPaymentIds: booked }),
  );
}

describe("PAYMENT_UNBOOKED (G6·2)", () => {
  it("fires for a settled payment the ledger has never heard of", () => {
    const findings = one({ id: "pay-1" });

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe("PAYMENT_UNBOOKED");
    expect(finding?.severity).toBe("critical");
    expect(finding?.paymentId).toBe("pay-1");
    expect(finding?.swapId).toBeNull();
    expect(finding?.dedupeKey).toBe("PAYMENT_UNBOOKED:pay-1:none");
    expect(finding?.details).toEqual({
      amount: "1000000",
      settledAt: minutesAgo(10).toISOString(),
      nearTxHash: "tx-pay-1",
    });
  });

  it("says nothing once the line exists, which is the whole question it asks", () => {
    // The negative case, and the only one that keeps the positive case honest: a rule
    // that read `bookedPaymentIds` as an ignore-list, or never read it at all, passes
    // the first test and this one only if the membership check is real.
    expect(one({ id: "pay-1" }, ["pay-1"])).toEqual([]);
    // An id that is not this payment's says nothing about this payment.
    expect(one({ id: "pay-1" }, ["pay-2"])).toHaveLength(1);
  });

  it("fires for a direct payment too, because booking is not a payout-mode question", () => {
    // The deliberate difference from PAYMENT_NOT_SWEPT, which skips `direct` because no
    // swap was ever owed. `recordSettlement` writes `payment_in` for every mode (D8), so
    // skipping direct here would leave the commonest sale in the demo unjudged.
    expect(one({ id: "pay-direct", payoutMode: "direct" })).toHaveLength(1);
  });

  it("waits out the window, because the book rides in the settle's own request", () => {
    // Inside the window: nothing. At the window and past it: the finding.
    expect(one({ id: "pay-1", settledAt: minutesAgo(1) })).toEqual([]);
    expect(one({ id: "pay-1", settledAt: minutesAgo(5) })).toHaveLength(1);
    expect(one({ id: "pay-1", settledAt: minutesAgo(60) })).toHaveLength(1);
  });

  it("judges only settled payments, and only ones with a settle time to age on", () => {
    for (const state of ["verified", "abandoned", "served_unsettled"] as const) {
      expect(one({ id: "pay-1", state })).toEqual([]);
    }
    // No settle time is no age, and an un-ageable row is not a finding: defaulting it to
    // the clock would report every payment that has never settled.
    expect(one({ id: "pay-1", settledAt: null })).toEqual([]);
  });

  it("names the payment even when its hash is missing", () => {
    // A settled row with no hash is a data problem for PAYMENT_NOT_SWEPT and not a
    // reason to lose the ledger finding: the money and the missing line are both facts.
    const findings = one({ id: "pay-1", nearTxHash: null });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.details).toEqual({
      amount: "1000000",
      settledAt: minutesAgo(10).toISOString(),
    });
  });

  it("reports one finding per unbooked payment and none for its booked sibling", () => {
    const findings = paymentUnbooked(
      snapshot({
        sellerId: "seller-1",
        payments: [payment({ id: "pay-a" }), payment({ id: "pay-b" }), payment({ id: "pay-c" })],
        bookedPaymentIds: ["pay-b"],
      }),
    );

    expect(findings.map((finding) => finding.paymentId)).toEqual(["pay-a", "pay-c"]);
  });

  it("carries copy a seller can act on, with no code words in it", () => {
    const finding = one({ id: "pay-1" })[0];
    expect(finding?.explanation.length).toBeGreaterThan(20);
    expect(finding?.suggestedAction.length).toBeGreaterThan(20);
    expect(finding?.explanation).not.toContain("_");
    // LR-1: the way to fix a ledger is a new row that says it is a correction, never a
    // write that pretends the missing event happened on time.
    expect(finding?.suggestedAction.toLowerCase()).toContain("adjustment");
  });
});
