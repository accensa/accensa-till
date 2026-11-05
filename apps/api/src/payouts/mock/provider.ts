import type { BaseUnitAmount, SwapState } from "@till/core";
import type {
  NormalizedSwap,
  PayoutProvider,
  PrepareRouteInput,
  PreparedRoute,
  StatusInput,
  SupportedAsset,
} from "../provider.ts";

/**
 * Scripted provider (D2, PO-5) with the same interface as the real one: succeed,
 * refund, fail, stall. `scenarios.ts` drives each of them as far as the
 * reconciliation rules, so the payout flow runs offline.
 *
 * The script is supplied by the caller — `scripts/simulate.ts` or a test — and
 * never by a hidden default. A poll for a reference this provider never issued, or
 * for one it issued with no outcome scripted, throws instead of reporting a state:
 * a mock that quietly fabricated `succeeded` is exactly the line DQ-2 says a judge
 * must not be misled over. Preparing a route is the other half, and D5 separated it
 * from that rule — see `prepareRoute`.
 */

export const MOCK_OUTCOMES = ["succeed", "refund", "fail", "stall"] as const;
export type MockOutcome = (typeof MOCK_OUTCOMES)[number];

/**
 * One deposit and what the provider will report about it. Amounts are base units
 * at 6 decimals, bigint, as everywhere else (hard rule 3).
 */
export type MockScript = {
  readonly outcome: MockOutcome;
  /** The deposit the buyer's settled payment turned into. */
  readonly amountIn: BaseUnitAmount;
  /**
   * What lands at the destination. Only reported for `succeed`; set it below
   * `minAmountOut` to demonstrate PAYOUT_SHORTFALL (LR-6) from this same shape.
   */
  readonly amountOut?: BaseUnitAmount;
  /** The quote's floor recorded on the route. Defaults to the whole deposit. */
  readonly minAmountOut?: BaseUnitAmount;
  /** What comes back for `refund`. Defaults to the whole deposit. */
  readonly refundedAmount?: BaseUnitAmount;
  /**
   * Polls before the outcome appears. 1 reports it on the first status call; a
   * larger number shows intermediate `processing` polls first. `stall` ignores
   * it — a stalled swap never resolves.
   */
  readonly resolvesOnPoll?: number;
  /**
   * The settlement transaction hash reconciliation matches on (LR-2). Omit it to
   * produce a swap no payment can claim, which is how an un-swept payment and an
   * unmatched deposit are demonstrated.
   */
  readonly originTxHash?: string | null;
};

export type MockProviderOptions = {
  /** Used only for a quote deadline. No state or amount reads the clock. */
  readonly clock?: () => Date;
};

/** A standing quote has no deadline in either intents design (S2). */
const QUOTE_TTL_MS = 90_000;

function refFor(index: number): string {
  return `mock-quote-${index}`;
}

/**
 * Shaped like a NEAR account id, so a route built on it passes the same advertisement
 * checks a real one does, and not resolvable as one, so a mocked pay-to can never be
 * paid by mistake (DQ-2). The word `mock` in it is the label.
 */
function depositFor(index: number): string {
  return `mock-deposit-${index}`;
}

/** What each scripted outcome reports once it resolves. `stall` resolves to nothing. */
const RESOLVED_STATE: Record<MockOutcome, SwapState> = {
  succeed: "succeeded",
  refund: "refunded",
  fail: "failed",
  stall: "processing",
};

function statusFor(outcome: MockOutcome, state: SwapState): string {
  // The mock speaks our normalized names; the real provider's SCREAMING_SNAKE
  // enum belongs to D3 and map-status.ts, and normalizeSwapState must not be
  // handed those values (see the note in packages/core/src/states.ts tests).
  return state === "processing"
    ? `MOCK_PENDING_${outcome.toUpperCase()}`
    : `MOCK_${outcome.toUpperCase()}`;
}

export class MockProvider implements PayoutProvider {
  readonly #scripts: readonly MockScript[];
  readonly #clock: () => Date;
  readonly #issued = new Map<string, MockScript | null>();
  readonly #polls = new Map<string, number>();
  #next = 0;

  constructor(scripts: readonly MockScript[], options: MockProviderOptions = {}) {
    this.#scripts = scripts;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * A quote is not an outcome, and D5 is what separated them: endpoint creation asks
   * for a deposit address to advertise while there is still no payment to script an
   * outcome *for*. So a route is always minted, and what stays refused is the state
   * nobody chose — `getStatus` on a reference with no script attached throws rather
   * than reporting one (DQ-2).
   */
  async prepareRoute(input: PrepareRouteInput): Promise<PreparedRoute> {
    const index = this.#next + 1;
    this.#next = index;
    const ref = refFor(index);
    const script = this.#scripts[index - 1] ?? null;
    this.#issued.set(ref, script);
    return {
      depositAddress: depositFor(index),
      depositMemo: null,
      quoteRef: ref,
      // With no script there is no floor either: picking a number here would be
      // inventing a quote the caller never asked for (DQ-2).
      minAmountOut: script === null ? null : (script.minAmountOut ?? script.amountIn),
      deadlineAt: input.amount === null ? null : new Date(this.#clock().getTime() + QUOTE_TTL_MS),
      modeDetail: input.amount === null ? "standing" : "per_payment",
    };
  }

  async getStatus(input: StatusInput): Promise<readonly NormalizedSwap[]> {
    return input.providerRefs.map((ref) => this.#swapFor(ref));
  }

  async listAssets(): Promise<readonly SupportedAsset[]> {
    return MOCK_ASSETS;
  }

  #swapFor(ref: string): NormalizedSwap {
    if (!this.#issued.has(ref)) {
      throw new Error(
        `mock: getStatus asked for ${ref}, which this provider never issued; refusing to invent an outcome (D2)`,
      );
    }
    const script = this.#issued.get(ref);
    if (script === null) {
      throw new Error(
        `mock: ${ref} was prepared as a route and nothing was ever scripted for it; a payout must state what happens to it (D2, DQ-2)`,
      );
    }
    if (script === undefined) {
      throw new Error(`unreachable: ${ref} is issued but reads back as no script at all`);
    }
    const poll = (this.#polls.get(ref) ?? 0) + 1;
    this.#polls.set(ref, poll);
    const state = this.#stateFor(script, poll);
    return {
      providerRef: ref,
      state,
      amountIn: script.amountIn,
      amountOut: state === "succeeded" ? (script.amountOut ?? script.amountIn) : null,
      refundedAmount: state === "refunded" ? (script.refundedAmount ?? script.amountIn) : null,
      originTxHash: script.originTxHash ?? null,
      destinationTxHash: state === "succeeded" ? `mock-out-${ref}` : null,
      // Persisted into swaps.raw verbatim, and marked so a diagnosis can never
      // read a mocked payload as a provider response.
      raw: {
        simulated: true,
        provider: "mock",
        outcome: script.outcome,
        poll,
        status: statusFor(script.outcome, state),
      },
    };
  }

  #stateFor(script: MockScript, poll: number): SwapState {
    if (poll < (script.resolvesOnPoll ?? 1)) {
      return "processing";
    }
    return RESOLVED_STATE[script.outcome];
  }
}

/**
 * The mock's own asset codes, all 6 decimals so hard rule 9 holds whatever
 * consults this list (D4). These are not contract ids, and a real route must be
 * checked against the provider's list, not this one.
 */
const MOCK_ASSETS: readonly SupportedAsset[] = [
  { chain: "near", asset: "usdc", symbol: "USDC", decimals: 6 },
  { chain: "eth", asset: "usdc", symbol: "USDC", decimals: 6 },
  { chain: "base", asset: "usdc", symbol: "USDC", decimals: 6 },
];
