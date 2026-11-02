/**
 * Upstream GET with hard limits (C5, GW-8): no redirects followed, response size
 * capped, UPSTREAM_TIMEOUT_MS enforced, and the socket connects to the already
 * validated address from ssrf.ts rather than resolving the name again.
 *
 * GW-3 lives with the caller: non-2xx and timeouts abandon the payment, they are
 * never charged.
 */
export type ProxyResult = {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyBytes: number;
  readonly elapsedMs: number;
};
