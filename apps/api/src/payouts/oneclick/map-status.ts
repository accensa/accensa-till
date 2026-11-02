/**
 * Provider status -> NormalizedSwapState (D3, PO-4). Unknown values map to
 * `processing` rather than guessing, which is what lets PAYOUT_STUCK fire after
 * the window. The exhaustive list comes from docs/spikes/S5.md (task S5), so the
 * switch below is intentionally not written yet — inventing statuses here would
 * silently swallow real ones.
 */
export const STATUS_MAP_PLACEHOLDER = true;
