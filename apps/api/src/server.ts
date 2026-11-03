import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { loadEnv } from "./env.ts";
import { createLogger } from "./lib/logger.ts";

/**
 * HTTP entry point (A4), and the only file in this process that reads the
 * environment or opens a socket (A21). Boot order is deliberate: `loadEnv`
 * throws before anything listens, so a missing variable kills the process
 * instead of surfacing as a 500 later.
 *
 * The app itself lives in `app.ts`, so routes are tested with `app.request()`
 * rather than by booting this file and binding a port.
 *
 * No database handle here yet: `createDb` used to run at boot and only feed an
 * export nobody imported, which is G6's "field nobody reads" in a different
 * place. The first route that needs Postgres takes it as a dep (C4, D4).
 */

const env = loadEnv();
const log = createLogger({ service: "api" });

const app = createApp({ env, log });

// TODO(D6, E2, C10): start the timer loops from here once they exist:
//   startLoop({ name: "poll-payouts", seconds: env.POLL_INTERVAL_SECONDS, run: pollPayouts })
//   startLoop({ name: "reconcile", seconds: env.RECONCILE_INTERVAL_SECONDS, run: reconcile })
//   sweepStaleOnBoot()   // C10, runs once before serving

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, provider: env.PAYOUT_PROVIDER }, "api listening");
});
