/**
 * Pre-serve guards, evaluated in this order (C8, C9 — GW-5, GW-6, GW-7):
 *   1. payer not blocked          two served_unsettled in 24h blocks them
 *   2. authorization expiry       must outlast UPSTREAM_TIMEOUT_MS + margin
 *   3. payer balance              must cover the price
 *   4. one in flight per payer    else 429 with Retry-After
 *   5. replay key                 abandoned retries, settled returns 409
 *
 * Every guard needs an accepting and a rejecting test (AGENTS.md "Testing"), and
 * guard 6 needs a concurrency test proving exactly one request proceeds.
 */
export type GuardRejection = {
  readonly status: 409 | 429 | 502;
  readonly reason: string;
  readonly retryAfterSeconds?: number;
};
