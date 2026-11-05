import { severitySchema } from "@till/core/schemas";
import { describe, expect, it } from "vitest";

import {
  HELD_PAYER_EXPLAINED,
  NO_BLOCKED_PAYER_COPY,
  NO_DISCREPANCY_COPY,
  discrepancyAge,
  severityWords,
} from "../lib/reconcile.ts";

/**
 * The words behind the reconciliation screen (UI-4, F4), checked as text because
 * they are the only thing on that page Till invents: the explanation, the suggested
 * action and the ordering all come from the finding itself (LR-4), and the strikes
 * and thresholds come from the API. What is left is what a seller is told about the
 * state of the screen — so the rule these tests hold is that none of it states a
 * number or a fact the dashboard does not have.
 */

const NOW = Date.parse("2026-11-05T12:00:00.000Z");

describe("the severity badge", () => {
  it("has exactly one word per severity the contract allows", () => {
    const words = severityWords();
    expect(Object.keys(words).sort()).toEqual([...severitySchema.options].sort());
  });

  it("says something different for each, or the badge tells the seller nothing", () => {
    const words = Object.values(severityWords());
    expect(words.every((word) => word.length > 0)).toBe(true);
    expect(new Set(words).size).toBe(words.length);
  });
});

describe("the age of an open item", () => {
  it("names minutes, hours and days in the seller's units", () => {
    expect(discrepancyAge("2026-11-05T11:59:30.000Z", NOW)).toBe("just now");
    expect(discrepancyAge("2026-11-05T11:55:00.000Z", NOW)).toBe("5 min old");
    expect(discrepancyAge("2026-11-05T09:00:00.000Z", NOW)).toBe("3 h old");
    expect(discrepancyAge("2026-11-03T10:00:00.000Z", NOW)).toBe("2 d old");
  });

  it("rounds down, because an item is never older than it was opened as", () => {
    expect(discrepancyAge("2026-11-05T11:59:00.000Z", NOW)).toBe("1 min old");
    expect(discrepancyAge("2026-11-05T11:00:59.000Z", NOW)).toBe("59 min old");
    expect(discrepancyAge("2026-11-05T11:00:00.000Z", NOW)).toBe("1 h old");
    expect(discrepancyAge("2026-11-04T13:00:00.000Z", NOW)).toBe("23 h old");
    expect(discrepancyAge("2026-11-04T11:59:59.000Z", NOW)).toBe("1 d old");
  });

  it("never claims a negative age when the row was opened just after the page", () => {
    // The page's clock and the database's are not the same clock; an item that looks
    // like it opened in the future is this second old, and nothing less honest.
    expect(discrepancyAge("2026-11-05T12:00:30.000Z", NOW)).toBe("just now");
  });
});

describe("the copy a seller reads when there is nothing to do", () => {
  it("says the screen is empty, in a sentence", () => {
    expect(NO_DISCREPANCY_COPY).toMatch(/[a-z]/);
    expect(NO_DISCREPANCY_COPY.endsWith(".")).toBe(true);
    expect(NO_BLOCKED_PAYER_COPY.endsWith(".")).toBe(true);
    // An empty worklist is the good news, so it must not read like a fault: the
    // fault copy lives in the notice, and only a read that failed reaches it.
    expect(NO_DISCREPANCY_COPY.toLowerCase()).not.toContain("error");
    expect(NO_DISCREPANCY_COPY.toLowerCase()).not.toContain("failed");
  });

  it("explains a hold without restating the threshold, which is the API's number", () => {
    expect(HELD_PAYER_EXPLAINED.length).toBeGreaterThan(20);
    // 24 and 2 are `STRIKE_WINDOW_HOURS` and `STRIKE_THRESHOLD` in the API. The
    // dashboard cannot import them (web never imports apps/api), so a copy that
    // repeated them would be a second truth — and C9 can retune them.
    expect(HELD_PAYER_EXPLAINED).not.toMatch(/\d/);
  });
});
