import type { SwapState } from "@till/core";

/**
 * Provider status -> `SwapState` (D3, PO-4).
 *
 * The seven values below are copied from the recorded contract, not inferred: they are
 * the `GetExecutionStatusResponse.status` enum in `docs/spikes/S5.md`, re-diffed against
 * the live `https://1click.chaindefuser.com/docs/v0/openapi.yaml` on 2026-11-10, and the
 * same seven appear in the Go, TypeScript and Rust generated clients. Case is significant
 * on the wire.
 *
 * This is an explicit switch rather than a call to `normalizeSwapState` (S5, consequence
 * 3): `SWAP_STATES` is lowercase and the wire is `SCREAMING_SNAKE_CASE`, so handing the
 * library a provider value maps *all seven* to `processing` — including `SUCCESS` — and
 * every settled payout would look in flight forever. The mapping is this file's job;
 * `normalizeSwapState` stays what it is, the guard for a value already in our own column.
 *
 * Unknown values map to `processing` rather than guessing (PO-4), which is what keeps an
 * unrecognised status visible to `PAYOUT_STUCK` instead of letting it pose as progress or
 * as a finish.
 */
export const ONECLICK_STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export type OneClickStatus = (typeof ONECLICK_STATUSES)[number];

/**
 * The three the provider itself declares terminal, in its own words
 * (`.../1click-api/quickstart/signed-intent-execution`: "Poll until `status` reaches a
 * terminal state (`SUCCESS`, `REFUNDED`, or `FAILED`)"). `INCOMPLETE_DEPOSIT` is not one
 * of them, which is why D1 left `incomplete` out of `TERMINAL_SWAP_STATES`.
 */
export const TERMINAL_ONECLICK_STATUSES: readonly OneClickStatus[] = [
  "SUCCESS",
  "REFUNDED",
  "FAILED",
];

/**
 * The mapping table S5 recorded, one row per wire value.
 *
 * `KNOWN_DEPOSIT_TX` -> `processing` is deliberate (S5's table): the deposit has arrived
 * and work has started, so reporting it as `pending` would read as a backwards move and
 * `poll-payouts.ts` would drop the answer as a regression.
 */
const STATUS_TO_STATE: Record<OneClickStatus, SwapState> = {
  PENDING_DEPOSIT: "pending",
  KNOWN_DEPOSIT_TX: "processing",
  PROCESSING: "processing",
  SUCCESS: "succeeded",
  REFUNDED: "refunded",
  FAILED: "failed",
  INCOMPLETE_DEPOSIT: "incomplete",
};

export function mapOneClickStatus(raw: string): SwapState {
  return (STATUS_TO_STATE as Record<string, SwapState>)[raw] ?? "processing";
}

/** True for the states this mapping can produce that the provider calls final. */
export function isTerminalOneClickStatus(raw: string): boolean {
  return (TERMINAL_ONECLICK_STATUSES as readonly string[]).includes(raw);
}
