import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

import type { Db } from "./db/client.ts";
import type { Env } from "./env.ts";
import { type GatewayRouteDeps, createGatewayRoute } from "./gateway/route.ts";
import { type Logger, newRequestId } from "./lib/logger.ts";
import { type AuthRouteDeps, createAuthRoutes } from "./routes/auth.ts";
import { type DiscrepancyRouteDeps, createDiscrepancyRoutes } from "./routes/discrepancies.ts";
import { type EndpointRouteDeps, createEndpointRoutes } from "./routes/endpoints.ts";
import { type ExportRouteDeps, createExportRoutes } from "./routes/export.ts";
import { type OverviewRouteDeps, createOverviewRoutes } from "./routes/overview.ts";
import { type PaymentRouteDeps, createPaymentRoutes } from "./routes/payments.ts";
import { type StatusRouteDeps, createStatusRoutes } from "./routes/status.ts";
import { type SwapRouteDeps, createSwapRoutes } from "./routes/swaps.ts";
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
   * UI-3's reads need nothing the deps above do not already hold, so the seam is
   * the session alone — one per side of the ledger (payments in, swaps out).
   */
  readonly payments?: Partial<Pick<PaymentRouteDeps, "session">>;
  readonly swaps?: Partial<Pick<SwapRouteDeps, "session">>;
  readonly discrepancies?: Partial<Pick<DiscrepancyRouteDeps, "session">>;
  /**
   * UI-5's header reads the chain as well as the database, and the suite runs
   * offline, so the balance read is a seam the way F1's access-key read is. The
   * session seam is the one every other dashboard route already has.
   */
  readonly status?: Partial<Pick<StatusRouteDeps, "session" | "balance">>;
  /**
   * UI-6's totals are one database read and nothing else, so the seam is the
   * session alone — and the numbers themselves stay where they are computed, in the
   * query, rather than becoming something this process assembles.
   */
  readonly overview?: Partial<Pick<OverviewRouteDeps, "session">>;
  /**
   * LR-7's ledger export is one database read and CSV serialization, so the seam
   * is the session alone.
   */
  readonly export?: Partial<Pick<ExportRouteDeps, "session">>;
};

export type Variables = { requestId: string };

/**
 * The largest dashboard request body Till will read (G7).
 *
 * Every `/api` handler that takes a body parses it into memory with `c.req.json()`,
 * and none of them had a ceiling: the biggest real one is a signed-message or
 * endpoint-create payload of a few kilobytes. 64 KB is ~10× the largest shape the
 * schemas accept, so a legitimate client never sees this, while a 200 MB body that
 * used to be parsed (or OOM-killed the process) is refused before it is read. That
 * matters beyond availability: `SPONSORED_GAS_BUDGET` lives in process memory, so a
 * crash-loop is a gas cap that resets with the process (limits.ts states the
 * in-memory limitation; this is what keeps an anonymous request from reaching it).
 */
export const MAX_DASHBOARD_BODY_BYTES = 64 * 1024;

/** Methods that change state, and therefore the ones the origin check covers. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Whether a request's `Origin` is this deployment's own.
 *
 * Compared by parsing rather than by string equality, because `https://till.app`
 * and `https://till.app/` are the same origin to a browser and different strings to
 * `===`, and a refusal on a trailing slash would be a dashboard that cannot save.
 * An unparseable header is a refusal: nothing legitimate sends one.
 */
function isOwnOrigin(origin: string, publicUrl: string): boolean {
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

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

  // G7: response headers. `crossOriginResourcePolicy` is off on purpose -- the paid
  // endpoint answers a buyer's own server, and a policy aimed at browser subresource
  // loads has no business on that response. No `contentSecurityPolicy` either: this
  // process serves JSON and CSV, never HTML, so a CSP for it would be decoration
  // rather than a defence (the middleware only sets one when asked).
  app.use(
    "*",
    secureHeaders({
      crossOriginResourcePolicy: false,
      removePoweredBy: true,
    }),
  );

  /**
   * G7: the origin check on every state-changing dashboard route.
   *
   * The session cookie is `SameSite=Strict` (lib/session.ts), which already stops a
   * cross-site form POST from carrying it. This is the second lock on the same door,
   * and it is the one that survives a future cookie change: `PATCH /api/endpoints/:id`
   * can point a payout at another address, so a mutating request whose `Origin` says
   * "another site" is refused even if a browser is eventually persuaded to send it.
   *
   * An absent header is allowed: curl, the demo scripts and every test in this suite
   * are not browsers and send none. A browser always sends one on a non-GET request,
   * so the only clients this can refuse are the ones it exists to refuse.
   */
  app.use("/api/*", async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method)) {
      return next();
    }
    const origin = c.req.header("origin");
    if (origin === undefined) {
      return next();
    }
    if (!isOwnOrigin(origin, env.GATEWAY_PUBLIC_URL)) {
      log.warn({ code: "origin_refused", origin, path: c.req.path }, "dashboard 403");
      return c.json(
        {
          code: "origin_refused",
          message: "This request came from another origin, and it changes state.",
        },
        403,
      );
    }
    return next();
  });

  // G7: the body ceiling, before any route that parses a body. 413 rather than 400
  // so a client can tell "too large" from "malformed", and the message carries the
  // limit because a seller debugging an upload should not have to read our source.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_DASHBOARD_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            code: "payload_too_large",
            message: `The request body is larger than ${MAX_DASHBOARD_BODY_BYTES} bytes.`,
          },
          413,
        ),
    }),
  );

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
   *   routes/swaps.ts         D6 / UI-3   payout leg                  (mounted, F8)
   *   routes/discrepancies.ts E2 / UI-4   worklist, resolve, blocks (mounted, F4)
   *   routes/status.ts        UI-5        header balance and last poll (mounted, F5)
   *   routes/overview.ts      UI-6        ledger-equal totals         (mounted, F6)
   *   routes/export.ts        LR-7        CSV export (P1)             (mounted, F7)
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
  // D6 / UI-3's other half: the seller's payouts, scoped by the same session.
  app.route("/api", createSwapRoutes({ db, env, log, ...deps.swaps }));
  app.route("/api", createDiscrepancyRoutes({ db, env, log, ...deps.discrepancies }));

  // UI-5, F5. The header's two facts, one from the chain and one from the
  // database, answered for the session's seller and for nobody else.
  app.route("/api", createStatusRoutes({ db, env, log, ...deps.status }));

  // UI-6, F6. The overview's totals, answered for the session's seller by one
  // transaction over the ledger, the payments and the worklist.
  app.route("/api", createOverviewRoutes({ db, env, log, ...deps.overview }));

  // LR-7, F7. The ledger CSV export in decimal units for spreadsheets.
  app.route("/api", createExportRoutes({ db, env, log, ...deps.export }));
  app.route("/", createExportRoutes({ db, env, log, ...deps.export }));

  // C4, GW-1/GW-2. Mounted last and outside `/api` on purpose: a payer is not a
  // session, and `app.route` keeps the request middleware above it (the id the
  // gateway logs is the one this app set). The route path lives in the gateway
  // module, so `/r/:slug` is stated once.
  app.route("/", createGatewayRoute({ env, log, db, x402, ...deps.gateway }));

  return app;
}
