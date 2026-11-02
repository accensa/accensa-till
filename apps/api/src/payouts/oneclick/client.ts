/**
 * The only code that calls the 1Click API (AGENTS.md hard rule 5, D3). Keeps the
 * raw response for swaps.raw and never lets a provider type cross this boundary.
 *
 * Blocked on S3 (partner key lead time), S5 (full status enum) and S1/S2 (deposit
 * address shape). Until those exist this is a boundary, not an implementation.
 */
export const ONECLICK_TIMEOUT_MS = 10_000;
