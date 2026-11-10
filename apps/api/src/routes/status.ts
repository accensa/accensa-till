/**
 * The header status surface (UI-5, F5): the relayer's balance and the last
 * successful provider poll, each with the threshold the dashboard judges it
 * against.
 *
 * The route states facts and never opinions. Whether `500000` yoctoNEAR is a
 * warning, and whether a forty-minute-old answer is stale, are sentences the
 * dashboard writes — which is why `alertBelow` and `staleAfterSeconds` travel
 * beside the values they measure instead of a `lowBalance: boolean` the web half
 * would have to second-guess. A seller reading the header is the one who decides
 * what to do about it, so they get the numbers.
 *
 * A balance read that fails is still a 200, because the header's job is to say
 * "unknown" out loud; a body this application cannot describe in its own contract
 * is a 500 with a code, for the reason F3 and F4 give: an absent field reads as
 * nothing to report.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import {
  type RelayerBalanceDto,
  SESSION_COOKIE,
  type StatusDto,
  payoutPollDtoSchema,
  relayerBalanceDtoSchema,
} from "@till/core";

import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import { type SessionClaims, createSessionCodec } from "../lib/session.ts";
import {
  type RelayerBalanceReader,
  createRelayerBalanceReader,
  readSellerPoll,
} from "../services/status.ts";

export type StatusSessionReader = (cookie: string | undefined) => Promise<SessionClaims | null>;

export type StatusRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  /** F1's signed-cookie check by default; a test injects a seller instead. */
  readonly session?: StatusSessionReader;
  /**
   * The chain read, injected by every test because the suite runs offline. The
   * shipped reader is a public `view_account` against `NEAR_RPC_URL`.
   */
  readonly balance?: RelayerBalanceReader;
};

/**
 * Five intervals, not a configured window. `POLL_INTERVAL_SECONDS` is what the
 * loop promises and the header observes, so a second knob could only disagree
 * with it — the same reasoning C10's sweep and GW-7's expiry check apply, and the
 * slack is what keeps one skipped pass off the seller's screen as an alarm.
 */
const STALE_INTERVALS = 5;

export function createStatusRoutes(deps: StatusRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const read: StatusSessionReader =
    deps.session ??
    (async (cookie) =>
      cookie === undefined || cookie === "" ? null : await codec.verifySessionCookie(cookie));
  const readBalance = deps.balance ?? createRelayerBalanceReader({ rpcUrl: env.NEAR_RPC_URL });

  const app = new Hono();

  app.get("/status", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json(
        { code: "unauthenticated", message: "Sign in to read Till's own status." },
        401,
      );
    }

    try {
      // The two reads are independent and neither is allowed to black out the
      // other: a relayer whose chain is unreachable still has swaps to report on,
      // and the header must show both halves of that difference.
      const [balance, poll] = await Promise.all([
        readBalance(env.RELAYER_ACCOUNT_ID),
        readSellerPoll(db, seller.sellerId),
      ]);

      const relayer: RelayerBalanceDto = relayerBalanceDtoSchema.parse(
        balance.ok
          ? {
              accountId: env.RELAYER_ACCOUNT_ID,
              network: env.NEAR_NETWORK,
              state: "ok",
              amount: balance.amount.toString(),
              alertBelow: env.RELAYER_BALANCE_ALERT_BASE_UNITS.toString(),
            }
          : {
              accountId: env.RELAYER_ACCOUNT_ID,
              network: env.NEAR_NETWORK,
              state: balance.reason,
              amount: null,
              alertBelow: env.RELAYER_BALANCE_ALERT_BASE_UNITS.toString(),
            },
      );

      const payouts: StatusDto["payouts"] = payoutPollDtoSchema.parse({
        provider: env.PAYOUT_PROVIDER,
        state: poll.state,
        swaps: poll.swaps,
        lastPolledAt: poll.lastPolledAt,
        ageSeconds: poll.ageSeconds,
        staleAfterSeconds: env.POLL_INTERVAL_SECONDS * STALE_INTERVALS,
      });

      return c.json({ status: { relayer, payouts } });
    } catch (error) {
      // The detail stays in the log: this is Till's own config or its own rows, and
      // a seller can do nothing with a Zod path or a chain error message.
      log.error({
        code: "status_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "status_unreadable",
          message: "Till cannot describe its own status, so the header shows nothing about it.",
        },
        500,
      );
    }
  });

  return app;
}
