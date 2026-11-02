import type { Hono } from "hono";

/**
 * GET /r/:slug — the public gateway (C4, GW-1/GW-2).
 *
 * Order is fixed by AGENTS.md hard rule 2 and cannot be changed here:
 * resolve endpoint -> requirements -> verify -> guards -> proxy -> settle.
 * Settlement happens only after a 2xx (GW-3), and the response carries the
 * receipt header. Unpaid requests get 402; a replayed settled payment gets 409
 * with its receipt; a second concurrent paid request gets 429 with Retry-After.
 *
 * Not implemented. See gateway/requirements.ts, guards.ts and proxy.ts.
 */
export function createGatewayRoute(): Hono {
  throw new Error("not implemented (C4)");
}
