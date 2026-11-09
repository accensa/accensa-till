import { describe, expect, it } from "vitest";

import {
  DEFAULT_SIMULATE_CONFIG,
  SCENARIOS,
  SIMULATIONS,
  driveScenario,
  scenarioFor,
} from "../src/payouts/mock/scenarios.ts";

/**
 * D2's other half: the whole payout flow runs offline with `PAYOUT_PROVIDER=mock`
 * (PO-5), and each scripted outcome ends in the state and the discrepancy the
 * scenario says it must. `pnpm simulate` prints exactly this table for a human;
 * these tests are why it can be trusted to.
 *
 * Several cases below are expected to fail the scenario's own claim — an
 * unmatchable deposit, a short fill, a stuck window nobody configured. A driver
 * that only ever reports success proves nothing, so `ok === false` is asserted as
 * carefully as `ok === true`.
 */

const ONE = 1_000_000n;
const AT = new Date("2026-11-03T12:00:00.000Z");

function codesOf(findings: readonly { code: string }[]): readonly string[] {
  return findings.map((finding) => finding.code);
}

const EVERY_OUTCOME = Object.keys(SCENARIOS) as readonly (keyof typeof SCENARIOS)[];

describe("the offline payout flow reaches every scripted outcome (D2, PO-5)", () => {
  it("names the four payout outcomes plus the gateway case it cannot script", () => {
    expect(SIMULATIONS).toEqual(["succeed", "refund", "fail", "stall", "empty-payer"]);
    expect(EVERY_OUTCOME).toEqual(["succeed", "refund", "fail", "stall"]);
  });

  it("drives every outcome to the state and finding it claims", async () => {
    for (const name of EVERY_OUTCOME) {
      const driven = await driveScenario(name, { at: AT });
      expect(driven.scenario.name).toBe(name);
      expect(driven.ok, driven.problems.join("; ")).toBe(true);
      expect(driven.trajectory.at(-1)).toBe(driven.scenario.expectedState);
      expect(codesOf(driven.findings)).toEqual(
        driven.scenario.expectedFinding === null ? [] : [driven.scenario.expectedFinding],
      );
    }
  });

  it("succeed matches the payment to the swap by transaction hash and reports nothing", async () => {
    const driven = await driveScenario("succeed", { at: AT });
    expect(driven.swapRow.paymentId).toBe(driven.paymentRow.id);
    expect(driven.swapRow.originTxHash).toBe(driven.paymentRow.nearTxHash);
    expect(driven.swapRow.terminalAt).not.toBeNull();
    expect(driven.findings).toHaveLength(0);
  });

  it("refund becomes PAYOUT_REFUNDED with the dedupe key the storage index needs", async () => {
    const driven = await driveScenario("refund", { at: AT });
    expect(codesOf(driven.findings)).toEqual(["PAYOUT_REFUNDED"]);
    const [finding] = driven.findings;
    expect(finding?.dedupeKey).toBe("PAYOUT_REFUNDED:pay-1:swap-1");
    expect(finding?.severity).toBe("high");
    expect(driven.swapRow.refundedAmount).toBe(ONE);
  });

  it("fail becomes PAYOUT_FAILED and leaves the money unaccounted for", async () => {
    const driven = await driveScenario("fail", { at: AT });
    expect(codesOf(driven.findings)).toEqual(["PAYOUT_FAILED"]);
    expect(driven.swapRow.amountOut).toBeNull();
    expect(driven.swapRow.refundedAmount).toBeNull();
  });

  it("stall keeps polling, never reaches a terminal state, and ages into PAYOUT_STUCK", async () => {
    const driven = await driveScenario("stall", { at: AT });
    expect(driven.trajectory).toEqual(["processing", "processing", "processing"]);
    expect(driven.swapRow.terminalAt).toBeNull();
    expect(codesOf(driven.findings)).toEqual(["PAYOUT_STUCK"]);
    expect(driven.findings[0]?.severity).toBe("medium");
  });

  it("advances the simulated clock by the poll interval rather than reading the wall clock", async () => {
    const driven = await driveScenario("stall", { at: AT, pollIntervalSeconds: 60 });
    expect(driven.swapRow.lastPolledAt?.getTime()).toBe(AT.getTime() + 3 * 60_000);
  });
});

describe("the driver refuses to look clean when the numbers are not (LR-2, LR-5, LR-6)", () => {
  it("takes the stuck window from config, so no case depends on a constant", async () => {
    const driven = await driveScenario("stall", {
      at: AT,
      config: { ...DEFAULT_SIMULATE_CONFIG, stuckWindowSeconds: 2000 },
    });
    expect(driven.findings).toHaveLength(0);
    expect(driven.ok).toBe(false);
    expect(driven.problems.join(" ")).toMatch(/expected PAYOUT_STUCK, the engine reported nothing/);
  });

  it("does not match two absent transaction hashes to each other (LR-2)", async () => {
    const driven = await driveScenario("succeed", {
      at: AT,
      script: { outcome: "succeed", amountIn: ONE },
    });
    expect(driven.paymentRow.nearTxHash).toBeNull();
    expect(driven.swapRow.originTxHash).toBeNull();
    // Absence is not a match. Linked here, an untraceable deposit would look
    // reconciled and no rule would ever speak of it again.
    expect(driven.swapRow.paymentId).toBeNull();
  });

  it("reports a settled payment no swap references as PAYMENT_NOT_SWEPT", async () => {
    const driven = await driveScenario("succeed", {
      at: AT,
      script: { outcome: "succeed", amountIn: ONE, originTxHash: null },
      paymentTxHash: "near-tx-that-no-swap-reports",
    });
    expect(driven.swapRow.paymentId).toBeNull();
    expect(codesOf(driven.findings)).toEqual(["PAYMENT_NOT_SWEPT"]);
    expect(driven.ok).toBe(false);
    expect(driven.problems.join(" ")).toMatch(/expected a clean payout, got PAYMENT_NOT_SWEPT/);
  });

  it("calls a short fill a shortfall instead of a success (LR-6)", async () => {
    const driven = await driveScenario("succeed", {
      at: AT,
      script: {
        outcome: "succeed",
        amountIn: ONE,
        amountOut: 900_000n,
        originTxHash: "mock-tx-succeed",
      },
    });
    expect(codesOf(driven.findings)).toEqual(["PAYOUT_SHORTFALL"]);
    expect(driven.ok).toBe(false);
  });

  it("gives each finding its own dedupe key, so none is silently dropped", async () => {
    const driven = await driveScenario("succeed", {
      at: AT,
      script: { outcome: "succeed", amountIn: ONE, amountOut: 100_000n },
      paymentTxHash: "near-tx-unique-to-the-payment",
    });
    const keys = driven.findings.map((finding) => finding.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...codesOf(driven.findings)].sort()).toEqual(["PAYMENT_NOT_SWEPT", "PAYOUT_SHORTFALL"]);
    expect(driven.ok).toBe(false);
  });

  it("produces the same answer twice, because the clock it uses is given to it", async () => {
    const first = await driveScenario("stall", { at: AT });
    const second = await driveScenario("stall", { at: AT });
    expect(second.findings).toEqual(first.findings);
    expect(second.swapRow).toEqual(first.swapRow);
  });

  it("points the empty payer at the guard that refuses it, instead of faking a payout outcome", async () => {
    expect(() => scenarioFor("empty-payer")).toThrow(/not a payout outcome/);
    expect(() => scenarioFor("empty-payer")).toThrow(/pnpm demo/);
    await expect(driveScenario("empty-payer", { at: AT })).rejects.toThrow(/gateway guard/);
  });

  it("pins what each scenario claims, so a new case cannot arrive unasserted", () => {
    const claims = Object.entries(SCENARIOS).map(
      ([name, scenario]) =>
        [name, scenario.expectedState, scenario.expectedFinding, scenario.outcome] as const,
    );
    expect(claims).toEqual([
      ["succeed", "succeeded", null, "succeed"],
      ["refund", "refunded", "PAYOUT_REFUNDED", "refund"],
      ["fail", "failed", "PAYOUT_FAILED", "fail"],
      ["stall", "processing", "PAYOUT_STUCK", "stall"],
    ]);
  });
});
