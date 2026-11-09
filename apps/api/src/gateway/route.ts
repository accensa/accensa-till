import { Hono } from "hono";

import { newId } from "@till/core";

import type { Db } from "../db/client.ts";
import { findGatewayEndpoint } from "../db/queries/endpoints.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import { recordSettlement } from "../services/ledger.ts";
import {
  type PaymentRow,
  advancePayment,
  openPayment,
  recordSettlementHash,
} from "../services/payments.ts";
import type { X402Near } from "../x402/types.ts";
import {
  type GuardRejection,
  type GuardRunner,
  createGuards,
  inFlightWindowSeconds,
} from "./guards.ts";
import {
  type RequestLimiter,
  type SponsoredGasBudget,
  createRequestLimiter,
  createSponsoredGasBudget,
} from "./limits.ts";
import {
  type ProxyResult,
  UpstreamRequestError,
  getUpstream,
  isForwardableHeader,
} from "./proxy.ts";
import {
  PAYMENT_REQUIRED_HEADER,
  type RequirementsCache,
  type RequirementsSource,
  type X402Challenge,
  createRequirementsCache,
} from "./requirements.ts";
import { type ResponseCache, createResponseCache } from "./response-cache.ts";
import { UpstreamPolicyError, resolveUpstreamTarget } from "./ssrf.ts";

/**
 * GET /r/:slug -- the public gateway (C4, GW-2).
 *
 * The order is the product (AGENTS.md hard rule 2): resolve the endpoint, build the
 * advertisement, verify, guards, proxy, settle -- and settle only on a 2xx (GW-3).
 * Each step is reached only when the one before it said yes, so nothing paid for is
 * served on a payment nobody verified and nothing is booked as revenue on an answer
 * the seller did not give.
 *
 * It is one function rather than a chain of middleware on purpose: the payment's
 * state is a local, and six handlers sharing `c.set` would let a later one read a
 * step it never waited for. Hard rule 2 is easier to keep when it is a list of
 * statements.
 *
 * What a payer gets:
 *   200  the upstream body, with `PAYMENT-RESPONSE` carrying the settlement hash.
 *        A retry within five minutes of a settled response whose delivery may have
 *        been lost gets the cached body and the same receipt (GW-9).
 *   402  no payment, or a payment the scheme refused: a re-challenge whose only
 *        change is the reason, so a retry costs one new signature and not a new
 *        price (4.2 step 2).
 *   404  unknown slug, or an endpoint the seller paused.
 *   409  this authorization has already been answered once (GW-4).
 *   429  a guard, the process-wide request limiter or the sponsored-gas budget
 *        said not yet (GW-10).
 *   502  the upstream failed. The payment is abandoned and never charged (GW-3).
 *   503  Till could not decide: a row that cannot be advertised, or a verifier that
 *        could not run. Challenging instead would ask a stranger to pay for
 *        something we have not established we can verify.
 */

/** v2's payment header, named as the shipped encoder names it. */
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
/** v1's name for the same thing. `X-PAYMENT: Bearer <base64>` is still what some clients send. */
export const LEGACY_PAYMENT_SIGNATURE_HEADER = "X-PAYMENT";
/**
 * The receipt. Read from the shipped library rather than invented:
 * `createSettlementHeaders` writes `{"PAYMENT-RESPONSE": base64(SettleResponse)}`
 * (`@x402/core` 2.18.0 `chunk-UCXEF6EL.mjs:660-664`) and the client's
 * `getPaymentSettleResponse` reads that name, then `X-PAYMENT-RESPONSE` for v1
 * (`:1104-1112`). What it decodes is `SettleResponse` -- `success`, `transaction`
 * and `network` required, `payer` optional (`x402Client-*.d.mts:1236-1246`) -- so
 * the hash this row is asked to carry is the library's `transaction`, which is the
 * same string `payments.near_tx_hash` holds and the reconciler joins swaps on
 * (LR-2). `success` is not decoration: the schema requires it.
 */
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Standard base64 of the JSON, the one encoding the shipped decoder regex accepts. */
function encodeHeaderValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** The upstream call, behind the one seam C4 needs: see `GatewayRouteDeps.upstream`. */
export type OpenUpstream = (input: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}) => Promise<ProxyResult>;

export type GatewayLimits = {
  readonly requests: RequestLimiter;
  readonly sponsoredGas: SponsoredGasBudget;
};

export type GatewayRouteDeps = {
  readonly env: Env;
  readonly log: Logger;
  readonly db: Db;
  readonly x402: X402Near;
  /**
   * The test seams, and why each is a seam rather than a fake.
   *
   * `upstream`: `resolveUpstreamTarget` refuses a loopback address by design (C5),
   * so the only way to proxy real bytes to a real server inside one process is to
   * build the `UpstreamTarget` directly -- which is exactly how `test/upstream.test.ts`
   * tested `getUpstream` itself. The default is the shipped pair, and C4's suite
   * asserts that a request going through the *default* refuses a loopback upstream,
   * so the seam cannot quietly become the production path.
   *
   * `guards`: the shipped policy is `createGuards` and it reads the `payments` table,
   * so a test that wants the paid path with the guards open says so by injecting
   * `guardsPendingC8` rather than by not wiring a database.
   *
   * `limits`: GW-10's counters are per route instance, which is what makes them
   * testable without time or a restart. Production builds both from env; a test
   * that wants a window or a budget already spent injects the counter it means.
   *
   * `responses`: GW-9's cache, a seam for the same reason -- a test that wants the
   * cache miss, or the five minutes to have passed, injects the cache it means.
   */
  readonly upstream?: OpenUpstream;
  readonly guards?: GuardRunner;
  readonly requirements?: RequirementsCache;
  readonly limits?: GatewayLimits;
  readonly responses?: ResponseCache;
};

/** Variables `createApp` sets on every request; declared locally to keep app.ts unimported. */
type GatewayEnv = { Variables: { requestId: string } };

type Refusal = {
  readonly status: 403 | 404 | 405 | 409 | 429 | 502 | 503;
  readonly code: string;
  readonly detail: string;
  readonly retryAfterSeconds?: number;
  readonly headers?: Record<string, string>;
};

function refuse(refusal: Refusal): Response {
  const body: Record<string, unknown> = { error: refusal.code, detail: refusal.detail };
  if (refusal.retryAfterSeconds !== undefined) {
    body.retryAfterSeconds = refusal.retryAfterSeconds;
  }
  return new Response(JSON.stringify({ ...body }), {
    status: refusal.status,
    headers: {
      "content-type": "application/json",
      ...(refusal.retryAfterSeconds === undefined
        ? {}
        : { "retry-after": String(refusal.retryAfterSeconds) }),
      ...refusal.headers,
    },
  });
}

/** The 402, assembled in one place so no branch can send a body the header contradicts. */
function challengeResponse(challenge: X402Challenge): Response {
  return new Response(challenge.body, {
    status: 402,
    headers: {
      "content-type": "application/json",
      [PAYMENT_REQUIRED_HEADER]: challenge.headers[PAYMENT_REQUIRED_HEADER],
    },
  });
}

/**
 * The same advertisement with a reason in `error`. Price, asset, network and pay-to
 * are untouched, because a payer whose signature was refused has to mint one
 * payment against the requirement it was already shown, not guess which field
 * moved. Re-encoding is one line and it is here rather than in `requirements.ts`
 * because the rebuild is a response-shaping decision, and the cache's contract is
 * the advertisement.
 */
function rechallenge(challenge: X402Challenge, reason: string): X402Challenge {
  const paymentRequired = { ...challenge.paymentRequired, error: reason };
  return {
    status: 402,
    headers: { [PAYMENT_REQUIRED_HEADER]: encodeHeaderValue(paymentRequired) },
    body: JSON.stringify(paymentRequired),
    paymentRequired,
  };
}

/** What the buyer sent, as the object `verify` expects, or `null` when it is not readable. */
function decodePaymentHeader(raw: string): unknown | null {
  // The shipped decoder strips an optional `Bearer ` and then parses
  // (`chunk-UCXEF6EL.mjs:1225-1231`), so both shapes are the same header here.
  const value = raw.replace(/^Bearer\s+/i, "").trim();
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The buyer's headers, minus hop-by-hop, minus payment material, minus proxies. */
function forwardableHeaders(source: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  source.forEach((value, name) => {
    if (isForwardableHeader(name)) {
      out[name.toLowerCase()] = value;
    }
  });
  return out;
}

function describeUpstreamError(error: unknown): string {
  if (error instanceof UpstreamRequestError) {
    return error.code;
  }
  if (error instanceof UpstreamPolicyError) {
    return `upstream_refused_${error.code}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createGatewayRoute(deps: GatewayRouteDeps): Hono<GatewayEnv> {
  const { env, log, db, x402 } = deps;
  const guards =
    deps.guards ??
    createGuards({
      db,
      upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
      authorizationExpiryMarginMs: env.AUTHORIZATION_EXPIRY_MARGIN_MS,
    });
  const inFlightWindow = inFlightWindowSeconds(
    env.UPSTREAM_TIMEOUT_MS,
    env.AUTHORIZATION_EXPIRY_MARGIN_MS,
  );

  const upstream: OpenUpstream =
    deps.upstream ??
    (async (input) => {
      const target = await resolveUpstreamTarget(input.url, {
        allowInsecure: env.ALLOW_INSECURE_UPSTREAM,
        gatewayOrigin: env.GATEWAY_PUBLIC_URL,
      });
      return getUpstream(target, {
        timeoutMs: env.UPSTREAM_TIMEOUT_MS,
        maxBytes: env.UPSTREAM_MAX_BYTES,
        headers: input.headers,
      });
    });

  const requirements =
    deps.requirements ??
    createRequirementsCache({
      near: x402,
      network: env.NEAR_NETWORK,
      upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
      authorizationExpiryMarginMs: env.AUTHORIZATION_EXPIRY_MARGIN_MS,
      minPriceBaseUnits: env.MIN_PRICE_BASE_UNITS,
    });

  // GW-10. Both counters live as long as this route, which is the process in
  // production and one test in the suite; that is the "in-memory" in O11.
  const limits: GatewayLimits = deps.limits ?? {
    requests: createRequestLimiter({
      maxRequests: env.RATE_LIMIT_REQUESTS,
      windowMs: env.RATE_LIMIT_WINDOW_MS,
    }),
    sponsoredGas: createSponsoredGasBudget({
      budget: env.SPONSORED_GAS_BUDGET,
      perSettlement: env.MAX_SPONSORED_GAS,
    }),
  };

  // GW-9. Also per route, and therefore per process in a boot. Its bounds are the
  // requirement's five minutes and 256 KB, plus a total-size cap of its own.
  const responses = deps.responses ?? createResponseCache();

  const route = new Hono<GatewayEnv>();

  /**
   * C20, GW-2: the paywall is a GET, and any other method is refused before the
   * resolve, the limiter, `verify` and `settle` -- no row read, no upstream dial, no
   * ledger line, and no `PAYMENT-REQUIRED` challenge, because a method nobody can
   * pay for gets no price to pay. GW-10's limiter does not cover the refusal: the
   * refusal does no work worth bounding.
   *
   * Two call sites, because Hono cannot route a HEAD to a HEAD handler --
   * `hono-base.js` dispatches a HEAD as a GET and answers `new Response(null, …)`.
   * That is why the paid path saw HEADs at all: it verified a genuine delegate,
   * settled real money, and dropped the body, so the buyer who then asked for the
   * artifact collided with their own replay key on a `409`. The method stays
   * readable from the request inside the GET handler, so HEAD is refused there; the
   * rest reach the registration below instead of Hono's plain-text `404`, which a
   * client cannot name as a policy.
   */
  const refuseMethod = (requestLog: Logger, method: string): Response => {
    requestLog.warn({ code: "method_not_allowed", method }, "gateway 405");
    return refuse({
      status: 405,
      code: "method_not_allowed",
      detail: "this endpoint serves GET only",
      headers: { Allow: "GET" },
    });
  };

  route.get("/r/:slug", async (c) => {
    const requestId = c.get("requestId");
    const slug = c.req.param("slug");
    const requestLog = log.child({ requestId, slug });

    // C20: Hono rewrites a HEAD into this handler and empties the answer after it,
    // but the request it hands the context still says HEAD, so this is where a HEAD
    // can still be seen.
    if (c.req.method !== "GET") {
      return refuseMethod(requestLog, c.req.method);
    }

    // 0. The process-wide request limit (GW-10), before the row read: the bound
    //    is on the work, and a limiter that ran after the SELECT would put the
    //    database under exactly the load it exists to bound. Every request counts,
    //    paid or not, because the 402's own lookup and advertisement are work too.
    if (!limits.requests.tryAcquire()) {
      const retryAfterSeconds = limits.requests.retryAfterSeconds();
      requestLog.warn({ code: "rate_limited", retryAfterSeconds }, "gateway 429");
      return refuse({
        status: 429,
        code: "rate_limited",
        detail: "this gateway has reached its request limit for now",
        retryAfterSeconds,
      });
    }

    // 1. Resolve. One join, so the price and the pay-to come from the same moment.
    const row = await findGatewayEndpoint(db, slug);
    if (row === null || !row.active) {
      requestLog.info({ code: "endpoint_not_found" }, "gateway 404");
      return refuse({ status: 404, code: "endpoint_not_found", detail: "no such endpoint" });
    }

    // A payout mode outside the two the schema means is not treated as `direct`.
    // Guessing would send money to the seller's own account on a row that meant a
    // route, so it is refused here rather than at settlement. A19 constrained the
    // money columns, not this text column, so this refusal is the only guard.
    if (row.payoutMode !== "direct" && row.payoutMode !== "intents") {
      requestLog.warn(
        { code: "endpoint_misconfigured", payoutMode: row.payoutMode },
        "gateway 503",
      );
      return refuse({
        status: 503,
        code: "endpoint_misconfigured",
        detail: `payout mode ${row.payoutMode} is not one Till can resolve a pay-to from`,
      });
    }

    // 2. The advertisement, or the reason there is not one.
    const source: RequirementsSource = {
      endpointId: row.endpointId,
      network: row.network,
      assetContract: row.assetContract,
      priceAmount: row.priceAmount,
      payoutMode: row.payoutMode,
      sellerNearAccountId: row.sellerNearAccountId,
      routeDepositAddress: row.routeDepositAddress,
      gatewayUrl: `${env.GATEWAY_PUBLIC_URL.replace(/\/+$/, "")}/r/${row.slug}`,
      description: row.description,
    };
    const outcome = requirements.forEndpoint(source);
    if (!outcome.result.ok) {
      // Nothing was asked of the payer and no byte reached the seller. This is ours
      // to say and ours to log at warn: S1's point is that a broken advertisement is
      // otherwise discovered inside `verify`, on somebody's money.
      requestLog.warn(
        { code: outcome.result.reason, detail: outcome.result.detail },
        "gateway refused to advertise",
      );
      return refuse({ status: 503, code: outcome.result.reason, detail: outcome.result.detail });
    }
    const { requirements: advertised, challenge } = outcome.result;

    // 3. No payment yet: the answer is the challenge, and nothing else runs. No row,
    //    no guards, no upstream -- which is what makes the 402 free (C2, GW-1).
    const paymentHeader =
      c.req.header(PAYMENT_SIGNATURE_HEADER) ?? c.req.header(LEGACY_PAYMENT_SIGNATURE_HEADER);
    if (paymentHeader === undefined || paymentHeader.length === 0) {
      requestLog.info({ code: "payment_required" }, "gateway 402");
      return challengeResponse(challenge);
    }

    const body = decodePaymentHeader(paymentHeader);
    if (body === null) {
      requestLog.info({ code: "payment_header_undecodable" }, "gateway 402");
      return challengeResponse(rechallenge(challenge, "payment_header_undecodable"));
    }

    // 4. Verify. `advertised` is what we would charge, never the buyer's `accepted`
    //    claim -- and `verify` replaces that field again on the way in (C1, GW-2).
    const verified = await x402.verify(body, advertised);
    if (!verified.ok) {
      // `unconfigured` and `error` are the verifier failing, not the payment
      // failing. A new challenge would ask a stranger for a second signature to fix
      // our own process, and serving would be worse (C1's contract: fail closed).
      if (verified.kind === "unconfigured" || verified.kind === "error") {
        requestLog.error(
          { code: verified.kind, detail: verified.reason },
          "gateway 503: verifier unavailable",
        );
        return refuse({ status: 503, code: verified.kind, detail: verified.reason });
      }
      requestLog.info({ code: verified.reason, kind: verified.kind }, "gateway 402");
      return challengeResponse(rechallenge(challenge, verified.reason));
    }
    const { authorization } = verified;

    // 5. Guards, before any byte goes upstream (C8). A rejection here is a refusal
    //    of a payment that verified, so it is logged with the payer and never with a
    //    reason that reads like the payer's signature was wrong.
    const rejection: GuardRejection | null = await guards({
      endpointId: row.endpointId,
      sellerId: row.sellerId,
      payerAccountId: authorization.payerAccountId,
      priceAmount: BigInt(advertised.amount),
      assetContract: advertised.asset,
      requirements: advertised,
    });
    if (rejection !== null) {
      requestLog.warn(
        { code: rejection.reason, status: rejection.status },
        "gateway rejected by pre-serve guard",
      );
      return refuse({
        status: rejection.status,
        code: rejection.reason,
        detail: `rejected by pre-serve guard: ${rejection.reason}`,
        ...(rejection.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: rejection.retryAfterSeconds }),
      });
    }

    // 5b. The global sponsored-gas budget (GW-10). The read happens here, after
    //     the guards and before the row, so exhaustion costs this payer nothing
    //     and leaves no `verified` row for Guard 3 to answer. The budget is a
    //     process lifetime, not a window, so there is no `Retry-After` to give.
    if (!limits.sponsoredGas.hasCapacity()) {
      requestLog.warn(
        {
          code: "sponsored_gas_exhausted",
          reserved: limits.sponsoredGas.reserved.toString(),
          budget: limits.sponsoredGas.budget.toString(),
        },
        "gateway 429: sponsored-gas budget spent",
      );
      return refuse({
        status: 429,
        code: "sponsored_gas_exhausted",
        detail: "this gateway has spent its sponsored-gas budget",
      });
    }

    // 6. The row. `replay_key` is this authorization's identity, so a retried request
    //    finds the payment it already made instead of making a second one (GW-4).
    const opened = await openPayment(
      db,
      {
        id: newId(),
        endpointId: row.endpointId,
        routeId: row.routeId,
        payerAccountId: authorization.payerAccountId,
        amount: BigInt(advertised.amount),
        assetContract: advertised.asset,
        replayKey: authorization.replayKey,
        // Not knowable here, and null by fact rather than omission (S6): a NEP-366
        // delegate expires at a block height the payer's signer chose.
        delegateExpiresAt: null,
      },
      { windowSeconds: inFlightWindow },
    );

    if (opened.kind === "in_flight") {
      // Guard 3's authoritative half (GW-6): the payer already has an unanswered
      // payment, and this one would have been a second delegate on one access key,
      // which S6 measured as two verifications and one chain refusal that arrives
      // *after* the seller served. Nothing was inserted, nothing was called.
      requestLog.info(
        { code: "payer_in_flight", blockingPaymentId: opened.blocking.id },
        "gateway refused a second in-flight payment",
      );
      return refuse({
        status: 429,
        code: "payer_in_flight",
        detail: "this payer already has a paid request in flight",
        retryAfterSeconds: inFlightWindow,
      });
    }

    if (opened.kind === "existing") {
      // C7, GW-4: this is the branch a replay lands in when its row may not be
      // taken back over -- `settled` (money moved, and 4.4 says hand the receipt
      // back), `served_unsettled` (served, money not yet confirmed, and a second
      // delivery for one authorization is not on offer), or an `abandoned` row that
      // carries a hash or a `settled_at`, which `services/payments.ts` refuses to
      // reuse for exactly that reason. A `verified` row normally never gets here:
      // Guard 3's in-flight read answers 429 above. The receipt travels only when
      // the row is `settled`, because a receipt is a claim that money moved.
      const stored = opened.payment;
      const receipt =
        stored.state === "settled" && stored.nearTxHash !== null
          ? {
              [PAYMENT_RESPONSE_HEADER]: encodeHeaderValue({
                success: true,
                transaction: stored.nearTxHash,
                network: env.NEAR_NETWORK,
                payer: stored.payerAccountId,
              }),
            }
          : {};

      // C12, GW-9: a paid answer that may never have reached its buyer is replayed
      // for five minutes when its authorization comes back. Only a `settled` row is
      // eligible -- the cache is filled on the serve path after that state is booked
      // -- and the receipt is rebuilt from the row rather than stored with the body,
      // so the hash a replayed answer names is the one the ledger holds. A miss,
      // including one after the TTL, falls through to the 409 and receipt below.
      if (stored.state === "settled" && stored.nearTxHash !== null) {
        const cached = responses.get(authorization.replayKey);
        if (cached !== null) {
          requestLog.info(
            {
              code: "payment_replayed_from_cache",
              paymentId: stored.id,
              bytes: cached.body.byteLength,
            },
            "gateway replayed a cached paid response",
          );
          return responseOf(cached, stored.nearTxHash);
        }
      }

      requestLog.info(
        {
          code: "payment_replay",
          paymentId: stored.id,
          state: stored.state,
          withReceipt: Object.keys(receipt).length > 0,
        },
        "gateway refused a replayed authorization",
      );
      return refuse({
        status: 409,
        code: "payment_replay",
        detail: `this authorization was already answered, its payment is ${stored.state}`,
        headers: receipt,
      });
    }

    if (opened.kind === "retried") {
      // GW-4's retry, and the reason it is a log line rather than a silent
      // fall-through: one authorization made one row, that row bought nothing, and
      // this request is now serving the same row. The payer verified again on the
      // way in, so the fresh chain read is what re-opened it, not this branch's
      // word that the last attempt failed.
      requestLog.info(
        { code: "payment_retried", paymentId: opened.payment.id },
        "gateway retried an abandoned payment with the same authorization",
      );
    }

    const payment = opened.payment;

    // 7. Proxy.
    let served: ProxyResult;
    try {
      served = await upstream({
        url: row.upstreamUrl,
        headers: forwardableHeaders(c.req.raw.headers),
      });
    } catch (error) {
      // Nothing was served, so nothing is charged (GW-3). The state is the proof.
      const detail = describeUpstreamError(error);
      requestLog.warn(
        { code: "upstream_failed", paymentId: payment.id, detail, outcome: "not_charged" },
        "abandoned an unanswered payment",
      );
      await advancePayment(db, payment.id, "abandoned", {}).catch((error_: unknown) =>
        requestLog.error(
          { code: "abandon_failed", paymentId: payment.id, error: String(error_) },
          "abandonment did not land",
        ),
      );
      return refuse({ status: 502, code: "upstream_failed", detail });
    }

    // 8. GW-3, the only gate on settlement. A 4xx is the seller's answer and a 5xx is
    //    their failure; neither is money and neither is charged. What the buyer sees
    //    is ARCHITECTURE.md §2 step 8: the upstream's own status for a 4xx, `502` for
    //    a 5xx or a timeout. C6 closed the case C4 left open -- a 3xx is the seller's
    //    answer, not their failure -- and the matrix is asserted as one table in
    //    `test/gateway.test.ts`. The rule lives here because the order does.
    if (served.status < 200 || served.status > 299) {
      requestLog.warn(
        {
          code: "upstream_rejected",
          paymentId: payment.id,
          status: served.status,
          outcome: "not_charged",
        },
        "abandoned a payment the upstream refused",
      );
      await advancePayment(db, payment.id, "abandoned", {
        upstreamStatus: served.status,
        upstreamMs: served.elapsedMs,
      }).catch((error: unknown) =>
        requestLog.error(
          { code: "abandon_failed", paymentId: payment.id, error: String(error) },
          "abandonment did not land",
        ),
      );
      if (served.status >= 300 && served.status <= 499) {
        // C6 settled the case C4 left open: a 3xx is the seller's own answer about
        // where the resource is, not a failure of theirs, so the buyer gets it -- and
        // `Location` is the whole content of that answer, so withholding it to avoid
        // leaking seller internals would leak nothing and hide the redirect. Till
        // still never *follows* it (C5's rule): fetching the target here would dial a
        // second, unvalidated address on the seller's say-so and serve bytes this
        // payment never bought. The row is `abandoned` like any other non-2xx, because
        // nothing was delivered.
        return responseOf(rewriteLocation(served, row.upstreamUrl));
      }
      // The seller's 5xx body is theirs: forwarding it would put their stack trace,
      // their framework's error page, their version headers in front of the buyer.
      return refuse({
        status: 502,
        code: "upstream_failed",
        detail: `upstream_responded_${served.status}`,
      });
    }

    // 9. Settle, book, serve. A settlement that fails after a 2xx still serves: the
    //    payer paid for an answer that exists, and withholding it would turn a
    //    seller's loss into the buyer's. C9 counts that as a strike; the
    //    `SERVED_NOT_SETTLED` discrepancy is E2's write path and is not faked here,
    //    so this row logs it instead.
    //
    //    The gas is reserved before the one call that may spend it (GW-10). The
    //    budget can fill between the check above and here, so this is the atomic
    //    answer; a refusal abandons the row like any other non-chargeable answer,
    //    because the seller worked but no money moved and nothing may be served.
    if (!limits.sponsoredGas.reserve()) {
      requestLog.warn(
        {
          code: "sponsored_gas_exhausted",
          paymentId: payment.id,
          outcome: "not_charged",
          reserved: limits.sponsoredGas.reserved.toString(),
          budget: limits.sponsoredGas.budget.toString(),
        },
        "gateway 429: sponsored-gas budget spent",
      );
      await advancePayment(db, payment.id, "abandoned", {
        upstreamStatus: served.status,
        upstreamMs: served.elapsedMs,
      }).catch((error: unknown) =>
        requestLog.error(
          { code: "abandon_failed", paymentId: payment.id, error: String(error) },
          "abandonment did not land",
        ),
      );
      return refuse({
        status: 429,
        code: "sponsored_gas_exhausted",
        detail: "this gateway has spent its sponsored-gas budget",
      });
    }

    const settled = await x402.settle(body, advertised);
    if (!settled.ok) {
      requestLog.error(
        {
          code: "SERVED_NOT_SETTLED",
          paymentId: payment.id,
          reason: settled.reason,
          hash: settled.nearTxHash ?? null,
        },
        "served without settling",
      );
      await advancePayment(db, payment.id, "served_unsettled", {
        upstreamStatus: served.status,
        upstreamMs: served.elapsedMs,
        ...(settled.nearTxHash === undefined ? {} : { nearTxHash: settled.nearTxHash }),
      }).catch((error: unknown) =>
        requestLog.error(
          { code: "state_write_failed", paymentId: payment.id, error: String(error) },
          "served_unsettled did not land",
        ),
      );
      return responseOf(served);
    }

    // C10: the hash is evidence, and evidence is written before the state that
    // depends on it. A crash between the settle and the terminal move used to leave
    // a `verified` row the boot sweep could not tell from an unpaid one; with the
    // hash on the row, the sweep asks the chain and books what landed. Best-effort:
    // the terminal move below writes the same value, so a failure here costs the
    // recovery hint, not the booking.
    await recordSettlementHash(db, payment.id, settled.nearTxHash).catch((error: unknown) =>
      requestLog.warn(
        { code: "settlement_hash_not_recorded", paymentId: payment.id, error: String(error) },
        "settlement hash not stamped before booking",
      ),
    );

    // `advancePayment` is compare-and-set on the state it read (C3), so a row some
    // other writer already moved throws rather than taking a second receipt.
    let booked: PaymentRow;
    try {
      booked = await advancePayment(db, payment.id, "settled", {
        nearTxHash: settled.nearTxHash,
        upstreamStatus: served.status,
        upstreamMs: served.elapsedMs,
      });
    } catch (error) {
      requestLog.error(
        { code: "settlement_race", paymentId: payment.id, error: String(error) },
        "settled without booking",
      );
      return responseOf(served, settled.nearTxHash);
    }

    try {
      // D8: in `direct` mode the seller's own account was the pay-to, so the same
      // transfer is the payout and both lines are written together. `intents`
      // writes only the payment; its payout arrives with D6's swap.
      await recordSettlement(
        db,
        {
          sellerId: row.sellerId,
          amount: BigInt(booked.amount),
          asset: booked.assetContract,
          paymentId: booked.id,
        },
        row.payoutMode,
      );
    } catch (error) {
      // The money is in and the answer is on its way. A missing line is ours to
      // chase, and the sweep and reconcile rows will see the payment without it.
      requestLog.error(
        { code: "ledger_write_failed", paymentId: payment.id, error: String(error) },
        "settled payment not booked",
      );
    }

    // C12, GW-9: keep the answer for five minutes, keyed by the authorization, so a
    // buyer whose connection dropped before this `Response` reached it can retry.
    // `set` owns the bounds and returns false only for a body over 256 KB; that is
    // the documented fallback to the `409` + receipt, so it is logged, not silent.
    if (!responses.set(authorization.replayKey, served)) {
      requestLog.info(
        { code: "response_not_cached", paymentId: payment.id, bytes: served.body.byteLength },
        "a paid response was too large to cache for a retry",
      );
    }

    requestLog.info(
      {
        code: "served",
        paymentId: payment.id,
        hash: settled.nearTxHash,
        upstreamStatus: served.status,
        upstreamMs: served.elapsedMs,
      },
      "gateway served a paid request",
    );
    return responseOf(served, settled.nearTxHash);
  });

  /**
   * C20: the methods Hono does route by name, so they reach a handler instead of
   * Hono's default `404`. HEAD is not among them -- see `refuseMethod`.
   */
  route.on(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"], "/r/:slug", (c) =>
    refuseMethod(
      log.child({ requestId: c.get("requestId"), slug: c.req.param("slug") }),
      c.req.method,
    ),
  );

  /**
   * A proxy that forwards a relative `Location` verbatim hands the buyer a path on
   * *our* origin, which is RFC 9110 7.3.2's objection and, here, a `404` on the
   * gateway. Till never follows the redirect (C5), so the answer only means anything
   * if its target is the seller's own; resolving against `upstreamUrl` cannot put the
   * buyer anywhere the seller did not already choose to send them.
   */
  function rewriteLocation(served: ProxyResult, upstreamUrl: string): ProxyResult {
    const location = served.headers.get("location");
    if (location === undefined) {
      return served;
    }
    let absolute: string;
    try {
      absolute = new URL(location, upstreamUrl).toString();
    } catch {
      return served;
    }
    const headers = new Map(served.headers);
    headers.set("location", absolute);
    return { ...served, headers };
  }

  /** The seller's answer, with the payment headers already stripped by `proxy.ts`. */
  function responseOf(
    served: Pick<ProxyResult, "status" | "headers" | "body">,
    nearTxHash?: string,
  ): Response {
    const headers = new Headers();
    for (const [name, value] of served.headers) {
      headers.set(name, value);
    }
    if (nearTxHash !== undefined) {
      headers.set(
        PAYMENT_RESPONSE_HEADER,
        encodeHeaderValue({
          success: true,
          transaction: nearTxHash,
          network: env.NEAR_NETWORK,
        }),
      );
    }
    return new Response(served.body, { status: served.status, headers });
  }

  return route;
}
