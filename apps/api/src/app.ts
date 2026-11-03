import { Hono } from "hono";

import type { Env } from "./env.ts";
import { type Logger, newRequestId } from "./lib/logger.ts";

/**
 * The HTTP app, built from injected dependencies (A21).
 *
 * This is the split that makes a route testable. Until now `server.ts` read the
 * environment, opened the database and called `serve()` at import time, so the
 * only way to exercise a handler was to start a process and bind a port — which
 * is a boot test, not a route test, and G6 named it as the structural blocker on
 * every route the F and C phases are about to add. Here nothing reads
 * `process.env` and nothing listens: a test builds the app with a fake env and a
 * recording logger, then calls `app.request(path)`.
 *
 * No `db` in the deps, on purpose (G6's own complaint was a field nobody reads).
 * The first route that needs the database takes it, and the mount table below
 * says which task owns which route.
 */

export type AppDeps = {
  readonly env: Env;
  readonly log: Logger;
};

export type Variables = { requestId: string };

export function createApp(deps: AppDeps): Hono<{ Variables: Variables }> {
  const { env, log } = deps;
  const app = new Hono<{ Variables: Variables }>();

  app.use("*", async (c, next) => {
    const requestId = newRequestId();
    c.set("requestId", requestId);
    const startedAt = performance.now();
    await next();
    // Duration of this request only. `performance.now()` is time since process
    // start, so the first request would otherwise log the boot time as its latency.
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(3);
    log.info({ requestId, method: c.req.method, path: c.req.path, status: c.res.status, seconds });
  });

  // 11.2: health reports liveness only. The relayer balance and last-poll checks
  // belong to UI-5, which needs the provider, so they are not faked here.
  // Two paths, one handler: the container healthcheck in docker-compose.yml and
  // ci.yml probe `/healthz`, while the browser only ever speaks `/api/*` (A5).
  app.on("get", ["/healthz", "/api/healthz"], (c) =>
    c.json({ ok: true, network: env.NEAR_NETWORK }),
  );

  /**
   * Mounted by the tasks that own them, in this order. The dashboard routes mount
   * under `/api`, because that is the only path apps/web rewrites onto this
   * process; the gateway stays outside `/api` and outside the session middleware.
   *   routes/auth.ts        A5 / UI-1  wallet signature session
   *   routes/endpoints.ts   D4 / PO-1  creation checks
   *   routes/payments.ts    C4 / UI-3
   *   routes/swaps.ts       D6 / UI-3
   *   routes/discrepancies.ts E2 / UI-4
   *   routes/export.ts      LR-7 (P1)
   *   gateway/route.ts      C4 / GW-1  /r/:slug, outside the session middleware
   */

  return app;
}
