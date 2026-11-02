import { describe, it } from "vitest";

// TODO(C3/E1): build fixtures that fires for a settled payment whose hash matches no swap, plus the negative case.
// Rule is implemented in ../payment-not-swept.ts; this test has not been written yet, so it is todo, not pass.
describe("PAYMENT_NOT_SWEPT", () => {
  it.todo("fires for a settled payment whose hash matches no swap");
  it.todo("stays silent when a swap carries the same origin hash");
});
