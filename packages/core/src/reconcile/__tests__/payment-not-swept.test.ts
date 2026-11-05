import { describe, expect, it } from "vitest";

import { paymentNotSwept } from "../payment-not-swept.ts";
import { payment, snapshot } from "./fixtures.ts";

// TODO(C3/E1): build fixtures that fires for a settled payment whose hash matches no swap, plus the negative case.
// Rule is implemented in ../payment-not-swept.ts; this test has not been written yet, so it is todo, not pass.
describe("PAYMENT_NOT_SWEPT", () => {
  it.todo("fires for a settled payment whose hash matches no swap");
  it.todo("stays silent when a swap carries the same origin hash");

  it("stays silent for a direct payment, whose pay-to was the seller (D8)", () => {
    // The same settled payment, with no swap referencing its hash, judged in both
    // modes: `intents` is un-swept and fires, `direct` paid the seller in the same
    // transfer and has nothing to sweep. A rule that lost the mode check would
    // flag every direct sale, so the pair is the assertion.
    const at = (payoutMode: "direct" | "intents") =>
      paymentNotSwept(
        snapshot({
          sellerId: "seller-1",
          payments: [payment({ id: `pay-${payoutMode}`, payoutMode })],
        }),
      );

    expect(at("intents").map((finding) => finding.code)).toEqual(["PAYMENT_NOT_SWEPT"]);
    expect(at("direct")).toEqual([]);
  });
});
