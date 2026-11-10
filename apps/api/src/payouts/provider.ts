import type { BaseUnitAmount } from "@till/core";
import type { SwapState } from "@till/core";

/**
 * The only contract between the app and a payout provider (task D1,
 * ARCHITECTURE.md section 5). Everything above this line is provider-agnostic;
 * only payouts/oneclick/client.ts may talk to the 1Click API (hard rule 5).
 */

export type PrepareRouteInput = {
  readonly destinationChain: string;
  readonly destinationAsset: string;
  readonly destinationAddress: string;
  readonly refundAddress: string;
  /** Per-payment quotes need an amount; a standing route does not. Decided by S2. */
  readonly amount: BaseUnitAmount | null;
};

export type PreparedRoute = {
  /** null for `direct` mode, which performs no swap (PO-6, D8). */
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly quoteRef: string | null;
  readonly minAmountOut: BaseUnitAmount | null;
  readonly deadlineAt: Date | null;
  readonly modeDetail: "standing" | "per_payment" | "direct";
};

export type StatusInput = {
  readonly providerRefs: readonly string[];
};

export type NormalizedSwap = {
  readonly providerRef: string;
  readonly state: SwapState;
  readonly amountIn: BaseUnitAmount | null;
  readonly amountOut: BaseUnitAmount | null;
  readonly refundedAmount: BaseUnitAmount | null;
  /** The match key for reconciliation; absent until S2 says deposits carry it (LR-2). */
  readonly originTxHash: string | null;
  readonly destinationTxHash: string | null;
  /**
   * The provider's own "last time the state was updated" (S5, consequence 2), which is
   * time-in-state. `swaps.last_polled_at` is Till's stamp and moves on every answer, so
   * a swap the provider keeps re-reporting the same way would never age against it and
   * `PAYOUT_STUCK` could not fire. A provider that reports no such time leaves this
   * absent, and the stuck window keeps using the poll stamp rather than a guess.
   */
  readonly providerUpdatedAt?: Date | null;
  /** Raw provider payload, persisted into swaps.raw for diagnosis. */
  readonly raw: unknown;
};

export type SupportedAsset = {
  readonly chain: string;
  readonly asset: string;
  readonly symbol: string;
  /** Hard rule 9: anything other than 6 decimals is refused at creation. */
  readonly decimals: number;
};

export interface PayoutProvider {
  prepareRoute(input: PrepareRouteInput): Promise<PreparedRoute>;
  getStatus(input: StatusInput): Promise<readonly NormalizedSwap[]>;
  listAssets(): Promise<readonly SupportedAsset[]>;
  /**
   * The most refs one pass may ask about, when the provider's status endpoint
   * answers one deposit address per call and is rate-limited per call (S5,
   * consequence 5). `poll-payouts.ts` takes the minimum of this and its own batch
   * size, so the mock, which serves a whole batch from one script, is left alone.
   */
  readonly statusCallsPerPass?: number;
}

/**
 * Terminal states are sticky (PO-4): a status that appears to move a swap out of
 * terminal is logged and ignored by poll-payouts.ts. There is one definition of
 * that list, in @till/core, and it is re-exported here rather than copied — a
 * second list is how `incomplete` ended up terminal in one place and not the
 * other (D1, spike S5).
 */
export { TERMINAL_SWAP_STATES as TERMINAL_STATES } from "@till/core";
