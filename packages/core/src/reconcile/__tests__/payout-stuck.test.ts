import { describe, it } from "vitest";

// TODO(C3/E1): build fixtures that fires past the stuck window for a non-terminal swap, plus the negative case.
// Rule is implemented in ../payout-stuck.ts; this test has not been written yet, so it is todo, not pass.
describe("PAYOUT_STUCK", () => {
  it.todo("fires past the stuck window for a non-terminal swap");
  it.todo("stays silent inside the window and for a never-polled swap");
});
