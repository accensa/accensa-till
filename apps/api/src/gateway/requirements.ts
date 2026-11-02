/**
 * Build and cache x402 v2 payment requirements per endpoint (C2, GW-1): price,
 * asset, network and pay-to. Cached because an unpaid request must not reach a
 * provider, and invalidated when the endpoint or its route changes.
 *
 * payTo depends on spike S1 — whether an Intents deposit address can be a payTo
 * at all — so this cannot be finished before docs/spikes/S1.md exists.
 */
export const REQUIREMENTS_CACHE_TTL_SECONDS = 60;
