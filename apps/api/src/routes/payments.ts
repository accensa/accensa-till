/**
 * Dashboard payment list (UI-3). Every row exposes its NEAR tx hash for linking.
 *
 * Read-only by fact rather than by omission: the payment row is written by the
 * gateway's own sequence and the state machine refuses moves from anywhere else,
 * so a dashboard route that could write one would be a second path into the ledger
 * (hard rule 4). The seller id is never taken from the request — `GET /payments`
 * answers for the account the session names, and the join in
 * `listPaymentsForSeller` is the scope.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { type PaymentDto, SESSION_COOKIE } from "@till/core";

import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import { type SessionClaims, createSessionCodec } from "../lib/session.ts";

import { listPaymentsForSeller } from "../services/payments.ts";

export type PaymentSessionReader = (cookie: string | undefined) => Promise<SessionClaims | null>;

export type PaymentRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  /**
   * F1's signed-cookie check by default. A test injects a seller instead of
   * minting a cookie, the same seam D4's route uses.
   */
  readonly session?: PaymentSessionReader;
};

export function createPaymentRoutes(deps: PaymentRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const read: PaymentSessionReader =
    deps.session ??
    (async (cookie) =>
      cookie === undefined || cookie === "" ? null : await codec.verifySessionCookie(cookie));

  const app = new Hono();

  app.get("/payments", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to list payments." }, 401);
    }

    let payments: PaymentDto[];
    try {
      payments = await listPaymentsForSeller(db, {
        id: seller.sellerId,
        nearAccountId: seller.nearAccountId,
      });
    } catch (error) {
      // A stored row the contract refuses is a fault in Till's own data, so it is
      // an error with a code rather than a shorter list: the seller would otherwise
      // read a missing payment as one that never happened. The row's contents are
      // not echoed, and the detail stays in the log.
      log.error({
        code: "payment_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "payment_unreadable",
          message: "A payment on record is not one Till can read, so it is not shown at all.",
        },
        500,
      );
    }

    return c.json({ payments });
  });

  return app;
}
