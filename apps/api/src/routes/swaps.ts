/**
 * Dashboard payout timeline (UI-3, D6). Read-only: the swap row is written by
 * `poll-payouts` and by nothing else, so a route that could write one would be a
 * second way to claim money moved.
 *
 * The seller id is never taken from the request — `GET /api/swaps` answers for the
 * account the session names, and the `payout_routes` join in `listSwapsForSeller` is
 * the scope. A swap the join cannot attribute is not shown to anybody.
 */
import { SESSION_COOKIE } from "@till/core";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import type { Db } from "../db/client.ts";
import { listSwapsForSeller } from "../db/queries/swaps.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import { type SessionClaims, createSessionCodec } from "../lib/session.ts";

export type SwapSessionReader = (cookie: string | undefined) => Promise<SessionClaims | null>;

export type SwapRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  /** F1's signed-cookie check by default; a test injects a seller instead. */
  readonly session?: SwapSessionReader;
};

export function createSwapRoutes(deps: SwapRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const read: SwapSessionReader =
    deps.session ??
    (async (cookie) =>
      cookie === undefined || cookie === "" ? null : await codec.verifySessionCookie(cookie));

  const app = new Hono();

  app.get("/swaps", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to list payouts." }, 401);
    }

    try {
      return c.json({ swaps: await listSwapsForSeller(db, seller.sellerId) });
    } catch (error) {
      // A row the schema refuses is a fault in Till's own data. Answering with a
      // shorter list would read as "that payout never happened", which is the one
      // thing a seller must not be told about money that may have moved.
      log.error({
        code: "swap_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "swap_unreadable",
          message: "A payout on record is not one Till can read, so it is not shown at all.",
        },
        500,
      );
    }
  });

  return app;
}
