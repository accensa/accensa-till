/**
 * The overview surface (UI-6, F6): the seller's totals per asset, the count of
 * what is open in the worklist, and the count of sales served without settling.
 *
 * Every number here is computed by the query in `services/overview.ts` and echoed
 * unchanged, which is what makes the page's acceptance rule checkable: the screen
 * adds nothing, subtracts nothing and converts nothing, so what a seller reads is
 * the sum they could run themselves. A dashboard that derived the totals from the
 * payment list would be a second implementation of the ledger, and the second one
 * is always the one that drifts.
 *
 * The seller is never named by the request: the session decides whose money this
 * is, exactly as `GET /payments` and `GET /status` do, and the scoping joins are in
 * the service.
 *
 * A total the contract refuses is a 500 with a code rather than a shorter list, for
 * the reason F3 and F4 give: an absent asset row reads as "nothing in that token",
 * which is the one sentence an overview must not say about money it has.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { type OverviewDto, SESSION_COOKIE } from "@till/core";

import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import { type SessionClaims, createSessionCodec } from "../lib/session.ts";
import { readSellerOverview } from "../services/overview.ts";

export type OverviewSessionReader = (cookie: string | undefined) => Promise<SessionClaims | null>;

export type OverviewRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  /**
   * F1's signed-cookie check by default. A test injects a seller instead of
   * minting a cookie, the seam every other dashboard read already has.
   */
  readonly session?: OverviewSessionReader;
};

export function createOverviewRoutes(deps: OverviewRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const read: OverviewSessionReader =
    deps.session ??
    (async (cookie) =>
      cookie === undefined || cookie === "" ? null : await codec.verifySessionCookie(cookie));

  const app = new Hono();

  app.get("/overview", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json(
        { code: "unauthenticated", message: "Sign in to read your money's totals." },
        401,
      );
    }

    let overview: OverviewDto;
    try {
      overview = await readSellerOverview(db, seller.sellerId);
    } catch (error) {
      // The detail stays in the log: this is Till's own arithmetic over its own
      // rows, and a seller can do nothing with a Zod path.
      log.error({
        code: "overview_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "overview_unreadable",
          message:
            "Till cannot describe its own totals, so the overview shows no numbers rather than partial ones.",
        },
        500,
      );
    }

    return c.json({ overview });
  });

  return app;
}
