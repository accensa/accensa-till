import { describe, it } from "vitest";

// TODO(C3/E1): build fixtures that fires when a swap reaches refunded, plus the negative case.
// Rule is implemented in ../payout-refunded.ts; this test has not been written yet, so it is todo, not pass.
describe("PAYOUT_REFUNDED", () => {
  it.todo("fires when a swap reaches refunded");
  it.todo("stays silent when the swap succeeded");
});
