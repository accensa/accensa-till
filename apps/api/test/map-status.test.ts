import { describe, expect, it } from "vitest";

import {
  SWAP_STATES,
  TERMINAL_SWAP_STATES,
  canTransitionSwap,
  normalizeSwapState,
} from "@till/core";

import {
  ONECLICK_STATUSES,
  TERMINAL_ONECLICK_STATUSES,
  isTerminalOneClickStatus,
  mapOneClickStatus,
} from "../src/payouts/oneclick/map-status.ts";

/**
 * D3's first half (S5, consequence 1): the provider's seven status names read as
 * Till's six swap states, and nothing else.
 *
 * This table is the reason `map-status.ts` is a file and not a call to
 * `normalizeSwapState`. Lowercasing `INCOMPLETE_DEPOSIT` yields `incomplete`, which
 * is a real state Till has decided is *not* terminal (D1) — so a lowercase-and-hope
 * mapping would file a short payout as finished and `PAYOUT_STUCK` would never see
 * it. S5's consequence 1 spells that out and consequence 3 says why the mapping has
 * to be a decision per name rather than a rule over strings: two of the seven
 * (`INCOMPLETE_DEPOSIT`, `FAILED`) have no state in common with the shape of their
 * own word, and one (`KNOWN_DEPOSIT_TX`) is a *new* provider fact that must not move
 * a swap backwards.
 *
 * The fixtures are the spec's own words, not invented ones. `docs/spikes/S5.md`
 * copies the `status` enum out of the recorded OpenAPI document (fetched 2026-11-02,
 * re-diffed value for value against the live spec on 2026-11-10), and
 * `ONECLICK_STATUSES` is that list; the first test is therefore the diff itself.
 */

describe("mapOneClickStatus (D3, S5 consequence 1)", () => {
  it("knows exactly the seven names the recorded spec publishes, in the spec's own order", () => {
    expect(ONECLICK_STATUSES).toEqual([
      "KNOWN_DEPOSIT_TX",
      "PENDING_DEPOSIT",
      "INCOMPLETE_DEPOSIT",
      "PROCESSING",
      "SUCCESS",
      "REFUNDED",
      "FAILED",
    ]);
    // S5 re-diffed these against the Go, TypeScript and Rust generated clients and they
    // agree. The shape is asserted too because the wire is case-significant: a lowercase
    // rewrite of this list would map all seven through the unknown branch.
    for (const status of ONECLICK_STATUSES) {
      expect(/^[A-Z][A-Z0-9_]*$/.test(status)).toBe(true);
    }
  });

  it("maps each name to the state D1's table says it is", () => {
    expect(mapOneClickStatus("PENDING_DEPOSIT")).toBe("pending");
    expect(mapOneClickStatus("KNOWN_DEPOSIT_TX")).toBe("processing");
    expect(mapOneClickStatus("INCOMPLETE_DEPOSIT")).toBe("incomplete");
    expect(mapOneClickStatus("PROCESSING")).toBe("processing");
    expect(mapOneClickStatus("SUCCESS")).toBe("succeeded");
    expect(mapOneClickStatus("REFUNDED")).toBe("refunded");
    expect(mapOneClickStatus("FAILED")).toBe("failed");
  });

  it("covers every one of the seven, so a name missing from the table cannot pass unnoticed", () => {
    // The cheapest way this file can rot is a provider status nobody noticed: a name
    // absent from the table falls through to `processing`, which is the right *answer*
    // and the wrong *silence*. So the table is walked against the published list rather
    // than trusted to match it, and every result has to be a state the poller accepts --
    // an invented word would be quietly rewritten two files away.
    expect(ONECLICK_STATUSES).toHaveLength(7);
    for (const status of ONECLICK_STATUSES) {
      expect(SWAP_STATES as readonly string[]).toContain(mapOneClickStatus(status));
    }
    // `processing` is reached twice by design (the two in-flight deposit names) and
    // never by a fallthrough: everything else has exactly one state of its own.
    expect(
      ONECLICK_STATUSES.filter((status) => mapOneClickStatus(status) === "processing"),
    ).toEqual(["KNOWN_DEPOSIT_TX", "PROCESSING"]);
    expect(ONECLICK_STATUSES.filter((status) => mapOneClickStatus(status) === "pending")).toEqual([
      "PENDING_DEPOSIT",
    ]);
  });

  it("keeps KNOWN_DEPOSIT_TX out of pending, because a seen deposit is progress", () => {
    // S5 consequence 1's trap: `KNOWN_DEPOSIT_TX` reads like "we know about the
    // deposit", which is how the first draft of this mapping put it in `pending` --
    // and `pending -> pending` is allowed while `processing -> pending` is a
    // regression the poller drops (PO-4). A swap already `processing` that the
    // provider now says has money on origin would have been refused as backwards.
    expect(mapOneClickStatus("KNOWN_DEPOSIT_TX")).toBe("processing");
  });

  it("maps an unknown or missing name to processing and never to a terminal state", () => {
    // PO-4's rule at the provider's own boundary, with the shapes the wire actually
    // carries: a renamed status, an empty body, a non-string, a lowercase mistake.
    const unknowns = ["", "PENDING_KYC_REVIEW", "success", "SUCCESS ", "DONE", "null", "succeeded"];
    for (const unknown of unknowns) {
      expect(mapOneClickStatus(unknown)).toBe("processing");
      // The case that would be a money bug: nothing unknown may read as finished, and a
      // state word of Till's own arriving on the wire is not a status either.
      expect(isTerminalOneClickStatus(unknown)).toBe(false);
    }
    expect(isTerminalOneClickStatus("INCOMPLETE_DEPOSIT")).toBe(false);
  });

  it("is an explicit switch and not a pass through the library's guard (S5, consequence 3)", () => {
    // The "simplification" this test exists to stop: `SWAP_STATES` is lowercase and the
    // wire is `SCREAMING_SNAKE_CASE`, so handing the provider's word to
    // `normalizeSwapState` answers `processing` for all seven and looks completely legal.
    // A suite that only checked the unknown cases would stay green while every settled
    // payout read as in flight forever.
    expect(mapOneClickStatus("SUCCESS")).toBe("succeeded");
    expect(normalizeSwapState("SUCCESS")).toBe("processing");
    expect(normalizeSwapState("REFUNDED")).toBe("processing");
    expect(normalizeSwapState("INCOMPLETE_DEPOSIT")).toBe("processing");
    for (const state of SWAP_STATES) {
      expect(mapOneClickStatus(state)).toBe("processing");
    }
  });
});

describe("TERMINAL_ONECLICK_STATUSES (D3, S5 consequence 1 and D1)", () => {
  it("is exactly SUCCESS, REFUNDED and FAILED", () => {
    expect(TERMINAL_ONECLICK_STATUSES).toEqual(["SUCCESS", "REFUNDED", "FAILED"]);
  });

  it("agrees with @till/core's terminal list, which is the one definition (D1)", () => {
    // Not a copy of the list: each provider name is mapped through this file's own
    // table and the result is checked against core's, so a change on either side that
    // makes them disagree is a failing test rather than a silent one.
    const mapped = ONECLICK_STATUSES.filter((status) =>
      (TERMINAL_SWAP_STATES as readonly string[]).includes(mapOneClickStatus(status)),
    ).map((status) => mapOneClickStatus(status));
    expect([...new Set(mapped)].sort()).toEqual([...TERMINAL_SWAP_STATES].sort());
    for (const status of TERMINAL_ONECLICK_STATUSES) {
      expect(isTerminalOneClickStatus(status)).toBe(true);
    }
  });

  it("leaves INCOMPLETE_DEPOSIT non-terminal so the short-payout case stays visible", () => {
    // The whole reason `incomplete` is out of `TERMINAL_SWAP_STATES`: money arrives
    // short, the provider keeps answering, and `PAYOUT_STUCK` / `payout-shortfall`
    // have to be able to see the row. Terminal here would file it and stop looking.
    expect(mapOneClickStatus("INCOMPLETE_DEPOSIT")).toBe("incomplete");
    expect(TERMINAL_SWAP_STATES).not.toContain("incomplete");
    expect(isTerminalOneClickStatus("INCOMPLETE_DEPOSIT")).toBe(false);
    // And it is only safe to keep it open because the state can still be settled later:
    // the transition table lets a short deposit reach any state the provider does call
    // final, so refusing to close it here does not strand the row.
    for (const state of ["succeeded", "refunded", "failed"] as const) {
      expect(canTransitionSwap("incomplete", state)).toBe(true);
    }
    expect(
      canTransitionSwap(mapOneClickStatus("INCOMPLETE_DEPOSIT"), mapOneClickStatus("SUCCESS")),
    ).toBe(true);
  });
});
