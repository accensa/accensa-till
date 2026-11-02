import { describe, it } from "vitest";

// BLOCKED ON S2: ../orphan-deposit.ts returns no findings until docs/spikes/S2.md fixes the deposit
// shape, so there is nothing to assert yet (ARCHITECTURE.md hard rule 13).
describe("ORPHAN_DEPOSIT", () => {
  it.todo("funds with no payment explaining them");
  it.todo("no finding when every deposit matches a payment hash");
});
