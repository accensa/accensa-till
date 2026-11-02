import { describe, it } from "vitest";

/**
 * A7 acceptance tests. These are `todo`, not passing: they need a real Postgres
 * (docker compose) and the generated migration, neither of which exists in the
 * scaffold. They are the evidence lines A7 must fill in before it can be `[x]`.
 *
 * The first is the point of the trigger: the ledger is append only, and
 * corrections are `adjustment` rows (ARCHITECTURE.md 6.1, LR-1).
 */
describe("ledger append-only trigger (A7, LR-1)", () => {
  it.todo("UPDATE on ledger_entries raises");
  it.todo("DELETE on ledger_entries raises");
  it.todo("inserting an adjustment row succeeds");
});

describe("discrepancy dedupe (A7, LR-5)", () => {
  it.todo("inserting the same open dedupe_key twice yields one row");
  it.todo("two null-subject findings with the same key still dedupe (partial unique index)");
  it.todo("a resolved discrepancy may be reopened with the same key");
});
