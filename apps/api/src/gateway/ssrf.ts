/**
 * SSRF validation (C5, GW-8): resolve once, reject private, loopback, link-local
 * and reserved ranges, connect to the validated IP, and refuse a self-loop back
 * to the gateway itself. https only outside local dev (ALLOW_INSECURE_UPSTREAM).
 *
 * Tests must cover private ranges, a redirect, a DNS-rebinding case and a
 * self-loop before this is trusted.
 */
export function assertUpstreamSafe(_url: string): void {
  throw new Error("not implemented (C5)");
}
