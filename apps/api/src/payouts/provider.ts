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
}

/**
 * Terminal states are sticky (PO-4): a status that appears to move a swap out of
 * terminal is logged and ignored by poll-payouts.ts. Kept here so both providers
 * and the poller agree on what "terminal" means.
 */
export const TERMINAL_STATES: readonly SwapState[] = [
  "succeeded",
  "refunded",
  "failed",
  "incomplete",
];
