import type { PaymentRequirementsDto } from "@till/core";

import type { Db } from "../db/client.ts";
import { inFlightPayment } from "../services/payments.ts";
import { strikesForPayer } from "../services/strikes.ts";

/**
 * Pre-serve guards, in the order the route evaluates them (C8, C9 -- GW-5, GW-6,
 * GW-7). The numbers are ARCHITECTURE 4.2's, not this file's evaluation order.
 *
 *   Guard 4  strikes (C9)         two served_unsettled in 24h blocks them   (this file)
 *   Guard 1  authorization expiry must outlast UPSTREAM_TIMEOUT_MS + margin (this file)
 *   Guard 2  payer balance        must cover the price                      (inside `verify`)
 *   Guard 3  one in flight        else 429 with Retry-After                 (here and at the insert)
 *   replay key                    abandoned retried, settled 409            (C7, in the route)
 *
 * The strike block is answered first although 4.2 numbers it last: it needs no
 * configuration to evaluate, and a misconfigured window must not convert a
 * blocked payer's `403` into a `503` that reads like our outage rather than their
 * record.
 *
 * Two of these are not policy this file writes, and saying so is the point of the
 * comments rather than an excuse: a guard listed here and not run is how a review
 * mistake becomes a security one.
 */

/**
 * A guard's answer. `402` is deliberately not a choice: a guard runs *after* the
 * payment verified, so a rejection that sent a fresh challenge would ask a payer
 * who holds a valid authorization to sign a second one for our decision
 * (C4's 503-not-402 rule, read the other way round).
 */
export type GuardRejection = {
  readonly status: 403 | 409 | 429 | 502 | 503;
  readonly reason: string;
  readonly retryAfterSeconds?: number;
};

/**
 * What a guard is asked to judge (C4 wires the call site, C8 fills the list).
 *
 * Everything here is a fact Till derived for itself rather than a fact the request
 * asserted: `payerAccountId` is the account the verified signature binds --
 * `x402/near.ts` refuses a payment whose payer it cannot name -- and
 * `requirements` is our own cached advertisement, never the buyer's `accepted`
 * field. That is what makes a guard a guard: a gate keyed on a payer-supplied
 * value is a gate the payer opens (GW-6, S6).
 */
export type GuardContext = {
  readonly endpointId: string;
  /**
   * The endpoint's seller, because C9's block is per (payer, seller): the loss a
   * strike measures is the seller who served, and a clear must not travel between
   * tenants.
   */
  readonly sellerId: string;
  readonly payerAccountId: string;
  /** The advertised price in base units, taken from our requirements. */
  readonly priceAmount: bigint;
  readonly assetContract: string;
  readonly requirements: PaymentRequirementsDto;
};

export type GuardRunner = (context: GuardContext) => Promise<GuardRejection | null>;

/**
 * How long a `verified` row is taken for a live payment rather than a relic.
 *
 * It is the same window Guard 1 advertises the authorization for, with no slack
 * and no floor: a request that is still upstream cannot have exceeded the timeout,
 * and the margin is what the settlement after it gets. A `verified` row older than
 * both is a process that died, and until C10's sweep moves it to `abandoned` it
 * must not turn this payer's every next request into a `429` for the rest of the
 * deployment. That is the difference between a rate limit and a ban, and the sweep
 * job is what makes this window a bound rather than a workaround.
 */
export function inFlightWindowSeconds(
  upstreamTimeoutMs: number,
  authorizationExpiryMarginMs: number,
): number {
  return Math.ceil((upstreamTimeoutMs + authorizationExpiryMarginMs) / 1000);
}

export type GuardDeps = {
  readonly db: Db;
  readonly upstreamTimeoutMs: number;
  readonly authorizationExpiryMarginMs: number;
};

/**
 * The shipped policy (C8). `null` means every guard said yes; nothing here is
 * reached before `verify`, and the route calls this before the upstream.
 */
export function createGuards(deps: GuardDeps): GuardRunner {
  const windowSeconds = inFlightWindowSeconds(
    deps.upstreamTimeoutMs,
    deps.authorizationExpiryMarginMs,
  );

  return async (context) => {
    // Guard 4, strikes (GW-7). Two payments served and not settled inside 24
    // hours, at this seller, is the measured shape of "pay from an account that
    // cannot settle": `verify` does not hold funds (S6), so the seller loses one
    // answer per attempt, and nothing downstream counts them.
    //
    // `403` rather than `402`: this payer already holds a valid authorization and
    // cannot fix the refusal by signing another one. No `Retry-After` either -- the
    // documented exit is the seller's clear, so a date would be a promise the
    // header cannot keep.
    const strikes = await strikesForPayer(deps.db, {
      payerAccountId: context.payerAccountId,
      sellerId: context.sellerId,
    });
    if (strikes.blocked) {
      return {
        status: 403,
        reason: "payer_blocked",
      };
    }

    // Guard 1, the authorization window (GW-5).
    //
    // ARCHITECTURE 4.2 step 3 asks for "reject if the authorization's window is
    // shorter than the upstream timeout plus a margin". The authorization's own
    // window cannot be read here: it is `max_block_height` inside a Borsh-encoded
    // NEP-366 delegate, and C1 returns `expiresAt: null` by fact rather than by
    // omission. What can be read is the window we advertised, which S6 measured is
    // exactly what the payer's client turns into `maxBlockHeight` at one block per
    // second -- so the comparison is real, and it is a **belt**: with the
    // advertisement derived from these same two env values, a running process
    // cannot fail it, and what it catches is the day someone makes the window a
    // per-endpoint column and forgets Guard 1 existed. It is here, tested with an
    // injected short window, so that day this refuses the request instead of
    // serving an answer and then failing to settle it.
    if (context.requirements.maxTimeoutSeconds < windowSeconds) {
      return {
        status: 503,
        reason: "window_too_short",
      };
    }

    // Guard 2, the payer's balance: **already enforced, and not by this file.**
    // S6 read it out of the scheme -- `verify` calls `ft_balance_of` on
    // `delegate.senderId`, the account the signature binds, and refuses at
    // `balance < amount` (`@x402/near/dist/cjs/exact/facilitator/index.js:418`),
    // which `x402.test.ts` executes at the boundary: exactly the price verifies,
    // one yocto below does not. What the gateway adds is *when*, and that is the
    // route's ordering, tested by a mutation that moves the guard and the upstream
    // call past each other. Re-reading the balance here would be a chain call per
    // request to ask a question the same request just answered, so it is not run,
    // and the row says so instead of shipping a duplicate.
    //
    // What verify does *not* do is hold the funds, which is why Guard 4 (C9's
    // strikes) exists at all.

    // Guard 3, one payment in flight per payer (GW-6, D14).
    //
    // This read is the polite half of the rule: it answers a payer who is clearly
    // already being served with a `429` and no transaction. It is *not* the
    // guarantee -- two requests arriving together both see "none" here, and S6
    // measured that the chain will not sort them out either (two delegates from one
    // payer both verify and both submit). The guarantee is `openPayment`'s claim,
    // which takes the same read inside a transaction behind an advisory lock on the
    // payer's account id and inserts in that same transaction; the route turns its
    // `in_flight` answer into the same `429`. Keyed on the payer alone, because the
    // ledger's `replay_key` only collapses one authorization repeated, not two
    // different ones spend at once.
    const blocking = await inFlightPayment(deps.db, context.payerAccountId, windowSeconds);
    if (blocking !== null) {
      return {
        status: 429,
        reason: "payer_in_flight",
        retryAfterSeconds: windowSeconds,
      };
    }

    return null;
  };
}

/**
 * The default C4 ran with before C8's policy existed: no guard rejects.
 *
 * Kept because a test that wants the paid path without the guards has to say so
 * out loud rather than arrange it by not importing a database.
 */
export const guardsPendingC8: GuardRunner = async () => null;
