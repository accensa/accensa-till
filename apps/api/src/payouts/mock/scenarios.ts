import {
  type DiscrepancyCode,
  type Finding,
  type PaymentRow,
  type ReconcileConfig,
  type SwapRow,
  type SwapState,
  isTerminalSwapState,
  runAllRules,
} from "@till/core";
import type { NormalizedSwap, PreparedRoute } from "../provider.ts";
import { MOCK_OUTCOMES, type MockOutcome, MockProvider, type MockScript } from "./provider.ts";

/**
 * The offline payout flow (D2, PO-5): script one outcome, run the provider
 * against it, turn what comes back into the rows the reconciliation engine
 * reads, and see which discrepancy the engine reports.
 *
 * Nothing here touches a network or a database, so `PAYOUT_PROVIDER=mock` runs
 * the whole money path on a laptop with no keys (DQ-1). The clock is simulated
 * and said out loud: the driver advances its own time instead of reading the
 * wall clock, so a demo of a stuck payout is reproducible (hard rule 12).
 */

export const SIMULATIONS = [...MOCK_OUTCOMES, "empty-payer"] as const;
export type SimulationName = (typeof SIMULATIONS)[number];

/** Mirrors the default of POLL_INTERVAL_SECONDS in env.ts; the driver never reads env. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 20;

export const DEFAULT_SIMULATE_CONFIG: ReconcileConfig = {
  sweepWindowSeconds: 300,
  stuckWindowSeconds: 900,
  shortfallToleranceBps: 50,
};

/** Every scenario scripts one deposit of 1.00 USDC, the size the demo prices an endpoint at. */
const ONE_UNIT = 1_000_000n;

function txHash(label: string): string {
  return `mock-tx-${label}`;
}

export type Scenario = {
  readonly name: SimulationName;
  /** What the screen says this case is, so a demo is not a row of ids. */
  readonly label: string;
  readonly outcome: MockOutcome;
  readonly script: MockScript;
  readonly polls: number;
  /**
   * Simulated minutes between the last poll and the reconcile pass. A stalled
   * payout needs the stuck window to elapse; without this the case would have to
   * wait in real time to show anything.
   */
  readonly idleMinutes: number;
  readonly expectedState: SwapState;
  /** The discrepancy this case must produce, or null when it must stay clean. */
  readonly expectedFinding: DiscrepancyCode | null;
};

/**
 * The four outcomes named in D2, each with the one thing it exists to show.
 * `empty-payer` is deliberately absent: it is a gateway guard (GW-7, C8), not a
 * provider outcome, and pretending otherwise would put a mock where a real
 * behaviour belongs.
 */
export const SCENARIOS: Readonly<Record<Exclude<SimulationName, "empty-payer">, Scenario>> = {
  succeed: {
    name: "succeed",
    label: "the payout swapped and landed at the seller's destination",
    outcome: "succeed",
    script: {
      outcome: "succeed",
      amountIn: ONE_UNIT,
      amountOut: ONE_UNIT,
      originTxHash: txHash("succeed"),
    },
    polls: 1,
    idleMinutes: 0,
    expectedState: "succeeded",
    expectedFinding: null,
  },
  refund: {
    name: "refund",
    label: "the swap failed and the deposit came back to the payer",
    outcome: "refund",
    script: { outcome: "refund", amountIn: ONE_UNIT, originTxHash: txHash("refund") },
    polls: 1,
    idleMinutes: 0,
    expectedState: "refunded",
    expectedFinding: "PAYOUT_REFUNDED",
  },
  fail: {
    name: "fail",
    label: "the swap failed and the money is still with the provider",
    outcome: "fail",
    script: { outcome: "fail", amountIn: ONE_UNIT, originTxHash: txHash("fail") },
    polls: 1,
    idleMinutes: 0,
    expectedState: "failed",
    expectedFinding: "PAYOUT_FAILED",
  },
  stall: {
    name: "stall",
    label: "the deposit was seen, then nothing changed for longer than the stuck window",
    outcome: "stall",
    script: { outcome: "stall", amountIn: ONE_UNIT, originTxHash: txHash("stall") },
    polls: 3,
    idleMinutes: 16,
    expectedState: "processing",
    expectedFinding: "PAYOUT_STUCK",
  },
};

export function scenarioFor(name: SimulationName): Scenario {
  if (name === "empty-payer") {
    // Not a gap in the product: C8 shipped, and an empty account is refused inside
    // the payment verification itself (PRD 8.6). It is a gap in what *this* script
    // can show, because that refusal needs a gateway, a chain read and a payment row,
    // and none of those belong in a provider-only driver. Step 5 of `pnpm demo` is
    // where it happens, against the shipped scheme.
    throw new Error(
      "gateway guard, not a payout outcome (C8, GW-7): an account whose balance is below the price is refused when the payment is verified — see step 5 of `pnpm demo`",
    );
  }
  return SCENARIOS[name];
}

export type DrivenScenario = {
  readonly scenario: Scenario;
  readonly route: PreparedRoute;
  /** One state per poll, in order, so a demo can show the status history. */
  readonly trajectory: readonly SwapState[];
  readonly lastStatus: NormalizedSwap;
  readonly swapRow: SwapRow;
  readonly paymentRow: PaymentRow;
  readonly findings: readonly Finding[];
  /** The scenario stated what this outcome must look like; the demo checks it. */
  readonly ok: boolean;
  readonly problems: readonly string[];
};

export type DriveOptions = {
  /** Where the simulated clock starts. Fixed so two runs produce the same findings. */
  readonly at?: Date;
  readonly pollIntervalSeconds?: number;
  readonly config?: ReconcileConfig;
  /**
   * Replace the scripted deposit. Used to drive the two cases the four outcomes
   * cannot show: a swap whose hash matches nothing, and a swap that fills short
   * (LR-2, LR-6).
   */
  readonly script?: MockScript;
  /**
   * The settlement hash the payment really carries. It defaults to what the
   * script reports, and a caller may set it apart to show a deposit that cannot
   * be traced back to the payment it came from.
   */
  readonly paymentTxHash?: string | null;
};

export async function driveScenario(
  name: SimulationName,
  options: DriveOptions = {},
): Promise<DrivenScenario> {
  const scenarioInput = scenarioFor(name);
  const script = options.script ?? scenarioInput.script;
  const at = options.at ?? new Date("2026-11-03T12:00:00.000Z");
  const pollIntervalSeconds = options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const config = options.config ?? DEFAULT_SIMULATE_CONFIG;

  const provider = new MockProvider([script], { clock: () => at });
  const route = await provider.prepareRoute({
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: "mock-seller-destination",
    refundAddress: "mock-seller-refund",
    amount: script.amountIn,
  });
  const ref = route.quoteRef;
  if (ref === null) {
    throw new Error(`mock: scenario ${scenarioInput.name} produced a route with no quote ref`);
  }

  const trajectory: SwapState[] = [];
  let lastStatus: NormalizedSwap | undefined;
  for (let poll = 0; poll < scenarioInput.polls; poll += 1) {
    const [status] = await provider.getStatus({ providerRefs: [ref] });
    if (status === undefined) {
      throw new Error(`mock: no status returned for ${ref}`);
    }
    lastStatus = status;
    trajectory.push(status.state);
  }
  if (lastStatus === undefined) {
    throw new Error(`mock: scenario ${scenarioInput.name} polls nothing`);
  }

  const lastPolledAt = new Date(at.getTime() + scenarioInput.polls * pollIntervalSeconds * 1000);
  const now = new Date(lastPolledAt.getTime() + scenarioInput.idleMinutes * 60_000);
  const terminal = isTerminalSwapState(lastStatus.state);

  // An explicit null means "this payment has no recorded hash", which is
  // different from not mentioning it.
  const paymentTxHash =
    options.paymentTxHash === undefined ? (script.originTxHash ?? null) : options.paymentTxHash;

  const paymentRow: PaymentRow = {
    id: "pay-1",
    endpointId: "ep-1",
    routeId: "route-1",
    amount: script.amountIn,
    state: "settled",
    // These scenarios exercise the swap path, which only exists in `intents`.
    payoutMode: "intents",
    nearTxHash: paymentTxHash,
    settledAt: new Date(at.getTime() - 10 * 60_000),
    verifiedAt: new Date(at.getTime() - 11 * 60_000),
  };

  const swapRow: SwapRow = {
    id: "swap-1",
    routeId: "route-1",
    // Matching is by transaction hash and nothing else (LR-2), so two absent
    // hashes are not a match: a swap that reports none stays unlinked, which is
    // what makes PAYMENT_NOT_SWEPT fire on the payment instead of looking settled.
    paymentId:
      lastStatus.originTxHash !== null && lastStatus.originTxHash === paymentRow.nearTxHash
        ? paymentRow.id
        : null,
    state: lastStatus.state,
    amountIn: lastStatus.amountIn,
    amountOut: lastStatus.amountOut,
    refundedAmount: lastStatus.refundedAmount,
    originTxHash: lastStatus.originTxHash,
    lastPolledAt,
    // The mock reports no clock of its own, so these scenarios age on the poll.
    providerUpdatedAt: null,
    terminalAt: terminal ? lastPolledAt : null,
  };

  const findings = runAllRules({
    sellerId: "seller-1",
    now,
    payments: [paymentRow],
    swaps: [swapRow],
    // Every scenario starts from a sale that was booked: what they exercise is the
    // payout leg, and `PAYMENT_UNBOOKED` (G6·2) would answer all of them with a
    // missing ledger line they never set out to model.
    bookedPaymentIds: [paymentRow.id],
    config,
  });

  const problems: string[] = [];
  if (lastStatus.state !== scenarioInput.expectedState) {
    problems.push(
      `state is ${lastStatus.state}, the scenario expected ${scenarioInput.expectedState}`,
    );
  }
  const codes = findings.map((finding) => finding.code);
  if (scenarioInput.expectedFinding === null) {
    if (codes.length > 0) {
      problems.push(`expected a clean payout, got ${codes.join(", ")}`);
    }
  } else if (!codes.includes(scenarioInput.expectedFinding)) {
    problems.push(
      `expected ${scenarioInput.expectedFinding}, the engine reported ${codes.join(", ") || "nothing"}`,
    );
  }
  const dedupeKeys = new Set(findings.map((finding) => finding.dedupeKey));
  if (dedupeKeys.size !== findings.length) {
    problems.push("two findings share a dedupe key, so one would never be stored");
  }

  return {
    scenario: scenarioInput,
    route,
    trajectory,
    lastStatus,
    swapRow,
    paymentRow,
    findings,
    ok: problems.length === 0,
    problems,
  };
}
