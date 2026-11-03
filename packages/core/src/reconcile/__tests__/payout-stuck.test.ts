import { describe, expect, it } from "vitest";

import { normalizeSwapState } from "../../states.ts";
import { payoutStuck } from "../payout-stuck.ts";
import { CONFIG, NOW, snapshot, swap } from "./fixtures.ts";

/**
 * E6: `PAYOUT_STUCK` (LR-3, Medium) with fixtures for both directions, as AGENTS.md
 * "Testing" requires. The window comes from config, so the fixtures move
 * `lastPolledAt` rather than the clock: `now` is the database time the caller
 * supplied and a test that read a real clock would pass or fail on when it ran.
 *
 * Three cases are load-bearing beyond the arithmetic:
 * - a status the provider has never heard of, which normalizes to `processing`
 *   and must be reported rather than treated as progress (PO-4);
 * - `incomplete`, which D1 took out of the terminal list precisely so this rule
 *   can still see it — the one state where money arrives short;
 * - a swap nobody has polled yet, which is not stale, just new.
 */

const STUCK_MS = CONFIG.stuckWindowSeconds * 1000;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function stuckIn(state: string, polledMsAgo = STUCK_MS + 60_000) {
  return payoutStuck(
    snapshot({
      sellerId: "seller-1",
      swaps: [
        swap({
          id: "swap-1",
          paymentId: "pay-1",
          state: normalizeSwapState(state),
          lastPolledAt: ago(polledMsAgo),
        }),
      ],
    }),
  );
}

describe("PAYOUT_STUCK (E6, LR-3)", () => {
  it("fires past the stuck window for a non-terminal swap", () => {
    const findings = stuckIn("processing");

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.code).toBe("PAYOUT_STUCK");
    expect(finding?.severity).toBe("medium");
    expect(finding?.paymentId).toBe("pay-1");
    expect(finding?.swapId).toBe("swap-1");
    expect(finding?.dedupeKey).toBe("PAYOUT_STUCK:pay-1:swap-1");
    expect(finding?.explanation.length).toBeGreaterThan(0);
    expect(finding?.suggestedAction.length).toBeGreaterThan(0);
  });

  it("fires at exactly the window, so the boundary is documented and not accidental", () => {
    expect(
      payoutStuck(
        snapshot({
          sellerId: "seller-1",
          swaps: [swap({ id: "swap-boundary", state: "pending", lastPolledAt: ago(STUCK_MS) })],
        }),
      ),
    ).toHaveLength(1);
  });

  it("stays silent inside the window", () => {
    expect(stuckIn("processing", 60_000)).toHaveLength(0);
  });

  it("stays silent for a swap nobody has polled", () => {
    // A swap written by the gateway and not yet reached by the poller is new, not
    // stuck; calling it stuck on creation would open a finding for every payment.
    const findings = payoutStuck(
      snapshot({
        sellerId: "seller-1",
        swaps: [swap({ id: "swap-new", state: "pending", lastPolledAt: null, terminalAt: null })],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("reports the status the provider invented, because unknown normalizes to processing", () => {
    // PO-4: an unrecognised status is not a state we understand, and the rule must
    // say so after the window instead of letting it look like movement.
    expect(normalizeSwapState("PENDING_KYC_REVIEW")).toBe("processing");
    const findings = stuckIn("PENDING_KYC_REVIEW");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.dedupeKey).toBe("PAYOUT_STUCK:pay-1:swap-1");
  });

  it("reports an incomplete swap, which is the money-arriving-short case (D1)", () => {
    // The whole point of taking `incomplete` out of TERMINAL_SWAP_STATES: with it
    // terminal, this rule skipped the one status where the seller is paid less and
    // nobody was told.
    const findings = payoutStuck(
      snapshot({
        sellerId: "seller-1",
        swaps: [
          swap({
            id: "swap-incomplete",
            paymentId: "pay-3",
            state: "incomplete",
            amountIn: 1_000_000n,
            amountOut: 900_000n,
            lastPolledAt: ago(STUCK_MS + 60_000),
          }),
        ],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("PAYOUT_STUCK");
    expect(findings[0]?.swapId).toBe("swap-incomplete");
  });

  it("stays silent for every swap the provider declared terminal, however old", () => {
    for (const state of ["succeeded", "refunded", "failed"] as const) {
      const findings = payoutStuck(
        snapshot({
          sellerId: "seller-1",
          swaps: [swap({ id: `swap-${state}`, state, lastPolledAt: ago(86_400_000) })],
        }),
      );
      expect(findings).toHaveLength(0);
    }
  });

  it("gives one finding per stuck swap, keyed on the payment when there is one", () => {
    const findings = payoutStuck(
      snapshot({
        sellerId: "seller-1",
        swaps: [
          swap({
            id: "swap-a",
            paymentId: "pay-a",
            state: "processing",
            lastPolledAt: ago(STUCK_MS + 1),
          }),
          swap({
            id: "swap-b",
            state: "pending",
            paymentId: null,
            lastPolledAt: ago(STUCK_MS + 1),
          }),
        ],
      }),
    );

    // LR-5 dedupes open findings on this string, so the no-payment half has to say
    // "none" rather than collapse onto another finding.
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.dedupeKey)).toEqual([
      "PAYOUT_STUCK:pay-a:swap-a",
      "PAYOUT_STUCK:none:swap-b",
    ]);
  });

  it("honours a configured window instead of a hardcoded one", () => {
    // Same fixture, four-minute window: hard rule 12 says the window is config, so
    // a swap idle for five minutes is stuck under it and not stuck under 900 s.
    const idle = swap({ id: "swap-short", state: "processing", lastPolledAt: ago(300_000) });
    expect(payoutStuck(snapshot({ sellerId: "seller-1", swaps: [idle] })).length).toBe(0);
    expect(
      payoutStuck(
        snapshot({
          sellerId: "seller-1",
          swaps: [idle],
          config: { ...CONFIG, stuckWindowSeconds: 240 },
        }),
      ),
    ).toHaveLength(1);
  });
});
