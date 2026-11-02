import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createDb } from "./db/client.ts";
import { loadEnv } from "./env.ts";
import { createLogger, newRequestId } from "./lib/logger.ts";

/**
 * HTTP entry point (A4). Boot order is deliberate: `loadEnv` throws before
 * anything listens, so a missing variable kills the process instead of
 * surfacing as a 500 later.
 *
 * TODO(A4): the acceptance check is "server refuses to start with a missing env
 * var and `/healthz` returns 200". That test runs against this file once A2
 * gives us a way to run it.
 */

const env = loadEnv();
const log = createLogger({ service: "api" });
const db = createDb(env.DATABASE_URL);

const app = new Hono();

app.use("*", async (c, next) => {
  const requestId = newRequestId();
  c.set("requestId", requestId);
  await next();
  const seconds = (performance.now() / 1000).toFixed(3);
  log.info({ requestId, method: c.req.method, path: c.req.path, status: c.res.status, seconds });
});

// 11.2: health reports liveness only. The relayer balance and last-poll checks
// belong to UI-5, which needs the provider, so they are not faked here.
app.get("/healthz", (c) => c.json({ ok: true, network: env.NEAR_NETWORK }));

/**
 * Mounted by the tasks that own them, in this order:
 *   routes/auth.ts        A5 / UI-1  wallet signature session
 *   routes/endpoints.ts   D4 / PO-1  creation checks
 *   routes/payments.ts    C4 / UI-3
 *   routes/swaps.ts       D6 / UI-3
 *   routes/discrepancies.ts E2 / UI-4
 *   routes/export.ts      LR-7 (P1)
 *   gateway/route.ts      C4 / GW-1  /r/:slug, outside the session middleware
 */

// TODO(D6, E2, C10): start the timer loops from here once they exist:
//   startLoop({ name: "poll-payouts", seconds: env.POLL_INTERVAL_SECONDS, run: pollPayouts })
//   startLoop({ name: "reconcile", seconds: env.RECONCILE_INTERVAL_SECONDS, run: reconcile })
//   sweepStaleOnBoot()   // C10, runs once before serving

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, provider: env.PAYOUT_PROVIDER }, "api listening");
});

export { app, db, env, log };
