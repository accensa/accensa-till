import { Hono } from "hono";

import type { Db } from "./db/client.ts";
import type { Env } from "./env.ts";
import { type GatewayRouteDeps, createGatewayRoute } from "./gateway/route.ts";
import { type Logger, newRequestId } from "./lib/logger.ts";
import { type AuthRouteDeps, createAuthRoutes } from "./routes/auth.ts";
import { type DiscrepancyRouteDeps, createDiscrepancyRoutes } from "./routes/discrepancies.ts";
import { type EndpointRouteDeps, createEndpointRoutes } from "./routes/endpoints.ts";
import { type PaymentRouteDeps, createPaymentRoutes } from "./routes/payments.ts";
import { type StatusRouteDeps, createStatusRoutes } from "./routes/status.ts";
import type { X402Near } from "./x402/types.ts";

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
 * `db` and `x402` arrived with C4, which is the first route that needed them
 * (A21's own note: the first route that needs the database takes it as a dep).
 * Both are required rather than optional, so a process cannot boot into an app
 * whose gateway silently answers 500 for want of a handle.
 */

export type AppDeps = {
  readonly env: Env;
  readonly log: Logger;
  readonly db: Db;
  readonly x402: X402Near;
  /**
   * Only the seams, and only for the suite that wants them: `upstream` because the
   * SSRF policy refuses a loopback seller by design and a test needs to proxy to a
   * real in-process server, `guards` because C8's policy is not written yet,
   * `requirements` because C2's cache is a per-process object a test may want to
   * inspect. Everything else the gateway needs comes from the deps above.
   */
  readonly gateway?: Partial<Pick<GatewayRouteDeps, "upstream" | "guards" | "requirements">>;
  /**
   * D4's route needs a seller identity and two reads a test cannot perform: the
   * cookie signature is F1's and the chain is A10's, so both are seams with the
   * shipped default behind them. The DNS seam is the same one the SSRF policy
   * already exposes; production leaves it unset. `provider` is D5's: an `intents`
   * creation asks it for the deposit address it will advertise.
   */
  readonly endpoints?: Partial<
    Pick<EndpointRouteDeps, "session" | "storage" | "resolve" | "provider">
  >;
  /**
   * F1's route reads the chain to turn a signature into an identity, which is the
   * one thing a test cannot do and the one thing A10's accounts would let a live
   * run do. Everything else the auth route needs is already in the deps above.
   */
  readonly auth?: Partial<Pick<AuthRouteDeps, "accessKeys">>;
  /**
   * UI-3's read needs nothing the deps above do not already hold, so the seam is
   * the session alone.
   */
  readonly payments?: Partial<Pick<PaymentRouteDeps, "session">>;
  readonly discrepancies?: Partial<Pick<DiscrepancyRouteDeps, "session">>;
  /**
   * UI-5's header reads the chain as well as the database, and the suite runs
   * offline, so the balance read is a seam the way F1's access-key read is. The
   * session seam is the one every other dashboard route already has.
   */
  readonly status?: Partial<Pick<StatusRouteDeps, "session" | "balance">>;
};

export type Variables = { requestId: string };

export function createApp(deps: AppDeps): Hono<{ Variables: Variables }> {
  const { env, log, db, x402 } = deps;
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
  // are UI-5's, they are scoped to a seller, and they belong on the dashboard
  // header rather than on a probe a container runs without a session.
  // Two paths, one handler: the container healthcheck in docker-compose.yml and
  // ci.yml probe `/healthz`, while the browser only ever speaks `/api/*` (A5).
  app.on("get", ["/healthz", "/api/healthz"], (c) =>
    c.json({ ok: true, network: env.NEAR_NETWORK }),
  );

  /**
   * Mounted by the tasks that own them, in this order. The dashboard routes mount
   * under `/api`, because that is the only path apps/web rewrites onto this
   * process; the gateway stays outside `/api` and outside the session middleware.
   *   routes/auth.ts          A5 / UI-1   wallet signature session  (mounted, F1)
   *   routes/endpoints.ts     D4 / PO-1   creation checks           (mounted, F2)
   *   routes/payments.ts      UI-3        the seller's ledger       (mounted, F3)
   *   routes/discrepancies.ts E2 / UI-4   worklist, resolve, blocks (mounted, F4)
   *   routes/status.ts        UI-5        header balance and last poll (mounted, F5)
   *   routes/swaps.ts         D6 / UI-3   payout leg                (open)
   *   routes/export.ts        LR-7        CSV export (P1)           (open)
   */

  // UI-1, F1. First under `/api` and the only route there that does not require a
  // session: it is the thing that issues one.
  app.route("/api", createAuthRoutes({ db, env, log, ...deps.auth }));

  // D4, PO-1/PO-2. Under `/api` because it is a dashboard route and the browser
  // reaches this process only through the rewrite (A5); the gateway stays outside.
  app.route("/api", createEndpointRoutes({ db, env, log, ...deps.endpoints }));

  // UI-3, F3. The seller's payments, read through the same session as their
  // endpoints: one identity for both halves of the dashboard.
  app.route("/api", createPaymentRoutes({ db, env, log, ...deps.payments }));
  app.route("/api", createDiscrepancyRoutes({ db, env, log, ...deps.discrepancies }));

  // UI-5, F5. The header's two facts, one from the chain and one from the
  // database, answered for the session's seller and for nobody else.
  app.route("/api", createStatusRoutes({ db, env, log, ...deps.status }));

  // C4, GW-1/GW-2. Mounted last and outside `/api` on purpose: a payer is not a
  // session, and `app.route` keeps the request middleware above it (the id the
  // gateway logs is the one this app set). The route path lives in the gateway
  // module, so `/r/:slug` is stated once.
  app.route("/", createGatewayRoute({ env, log, db, x402, ...deps.gateway }));

  return app;
}
