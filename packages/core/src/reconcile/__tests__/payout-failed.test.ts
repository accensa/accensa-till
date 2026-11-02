import { describe, it } from "vitest";

// TODO(C3/E1): build fixtures that fires when a swap ends failed, plus the negative case.
// Rule is implemented in ../payout-failed.ts; this test has not been written yet, so it is todo, not pass.
describe("PAYOUT_FAILED", () => {
  it.todo("fires when a swap ends failed");
  it.todo("stays silent for a terminal succeeded swap");
});
