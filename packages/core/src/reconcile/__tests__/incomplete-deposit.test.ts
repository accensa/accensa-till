import { describe, it } from "vitest";

// BLOCKED ON S2: ../incomplete-deposit.ts returns no findings until docs/spikes/S2.md fixes the deposit
// shape, so there is nothing to assert yet (ARCHITECTURE.md hard rule 13).
describe("INCOMPLETE_DEPOSIT", () => {
  it.todo("a deposit smaller than the price it covers");
  it.todo("no finding when amounts match");
});
