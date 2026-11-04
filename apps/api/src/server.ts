import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { createDb } from "./db/client.ts";
import { loadEnv } from "./env.ts";
import { inFlightWindowSeconds } from "./gateway/guards.ts";
import { sweepStaleOnBoot } from "./jobs/sweep-stale.ts";
import { createLogger } from "./lib/logger.ts";
import { createX402Near } from "./x402/near.ts";

/**
 * HTTP entry point (A4), and the only file in this process that reads the
 * environment or opens a socket (A21). Boot order is deliberate: `loadEnv`
 * throws before anything listens, so a missing variable kills the process
 * instead of surfacing as a 500 later.
 *
 * The app itself lives in `app.ts`, so routes are tested with `app.request()`
 * rather than by booting this file and binding a port.
 *
 * `createDb` is here because C4's gateway is the first route that needs Postgres,
 * and `createX402Near` because it is the first route that needs the payment layer.
 * Both are built from the validated env and handed to `createApp` (A21), so no
 * module under `src/` other than this one opens a socket or reaches a chain.
 *
 * The relayer is optional and its absence is not an error: with no
 * `RELAYER_SECRET_KEY` the payment layer reports `configured: false`, every
 * advertisement still goes out, and the gateway answers `503` the moment a payer
 * actually tries to pay (C1, C4). A testnet-default boot is therefore a process
 * that can show a paywall and cannot settle, which is exactly what A10 is for.
 */

const env = loadEnv();
const log = createLogger({ service: "api" });
const db = createDb(env.DATABASE_URL);

const x402 = createX402Near({
  network: env.NEAR_NETWORK,
  maxSponsoredGas: env.MAX_SPONSORED_GAS,
  ...(env.RELAYER_SECRET_KEY === undefined
    ? {}
    : { relayer: { accountId: env.RELAYER_ACCOUNT_ID, secretKey: env.RELAYER_SECRET_KEY } }),
  rpcUrl: env.NEAR_RPC_URL,
});

if (!x402.configured) {
  log.warn(
    { relayerAccountId: env.RELAYER_ACCOUNT_ID },
    "no relayer key: the gateway can advertise but not settle (A10)",
  );
}

const app = createApp({ env, log, db, x402 });

// C10: recovery runs before the port opens, so no request can race the sweep.
// The window is Guard 3's own, because that is the rule that decides when a
// `verified` row stopped meaning "being served right now".
const swept = await sweepStaleOnBoot({
  db,
  windowSeconds: inFlightWindowSeconds(env.UPSTREAM_TIMEOUT_MS, env.AUTHORIZATION_EXPIRY_MARGIN_MS),
  probe: (hash) => x402.settlementStatus(hash),
  log,
});
if (swept.abandoned + swept.recovered + swept.unproven > 0) {
  log.info({ ...swept }, "boot sweep finished");
}

// TODO(D6, E2): start the timer loops from here once they exist:
//   startLoop({ name: "poll-payouts", seconds: env.POLL_INTERVAL_SECONDS, run: pollPayouts })
//   startLoop({ name: "reconcile", seconds: env.RECONCILE_INTERVAL_SECONDS, run: reconcile })

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  log.info({ port: info.port, provider: env.PAYOUT_PROVIDER }, "api listening");
});
