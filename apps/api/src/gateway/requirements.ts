import { type PaymentRequirementsDto, nearAccountIdSchema, resourceInfoSchema } from "@till/core";
import type { z } from "zod";

import type { X402Near } from "../x402/types.ts";

/**
 * Build and cache x402 v2 payment requirements per endpoint (C2, GW-1): price,
 * asset, network and pay-to.
 *
 * Two jobs.
 *
 * **Advertise only what we could ourselves verify.** Every refusal below exists
 * because an advertisement is the one thing a seller cannot watch fail: S1's third
 * consequence is that a bad `payTo` is only discovered inside `verify`, on the
 * payer's request, so a wrong row looks like a working endpoint until a stranger
 * pays for it and is refused. So the price must be a positive integer above
 * `MIN_PRICE_BASE_UNITS`, the network must be the one this process registers a
 * facilitator for, and `payTo` must be a NEAR account id. What is *not* checked
 * here is whether that account is storage-registered for the asset, because that
 * is exactly the read S1 says we cannot make about someone else's account — it
 * stays a verify-time refusal, and D4's creation check is where the seller learns
 * about it.
 *
 * **Cache it per endpoint, keyed by what goes into the advertisement**, so an
 * unpaid request costs the one row read that resolved it and nothing else.
 * Invalidation is the content, not a write-path hook: the cache never has to
 * remember to be told, and a row that changed out from under it is a different
 * fingerprint, so it re-derives on the next request. `invalidate()` exists for a
 * caller that wants the entry gone now.
 *
 * The cache cannot call a payout provider, and the way to see that is the type:
 * it is handed `requirements` from the payment layer, no provider, and `advertise`
 * is synchronous, so there is no await on a path that could reach a network. In
 * `intents` mode a route with no standing deposit address is a refusal rather than
 * a `prepareRoute` call — minting an address per unpaid request is the cost this
 * task exists to prevent (ARCHITECTURE.md 4.1), and A17 keeps the payout leg on the
 * mock provider until S2 settles which intents design survives.
 */

/**
 * What a 402 must carry, read out of the shipped client rather than from prose.
 * `getPaymentRequiredResponse` decodes the base64 `PAYMENT-REQUIRED` *response
 * header* and only falls back to the body when `body.x402Version === 1`
 * (`@x402/core` 2.18.0 `dist/esm/chunk-UCXEF6EL.mjs:1088-1096`), and the library's
 * own resource server writes exactly that header and no body field
 * (`:645-653`, `createHTTPPaymentRequiredResponse`). A body-only 402 therefore
 * satisfies `curl` and pays no wallet.
 *
 * We send both: the header is the machine-readable challenge, and the body is the
 * same JSON with `x402Version: 2` in it, which is a value the v1 fallback rejects,
 * so no client can read the two differently.
 */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";

/** The library's own decoder accepts `/^[A-Za-z0-9+/]*={0,2}$/` (`chunk-ABS7D6VX.mjs:86`). */
function encodePaymentRequired(paymentRequired: PaymentRequiredDto): string {
  return Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
}

/** x402 v2's `PaymentRequired`: our one advertised price, plus what it is for. */
export type PaymentRequiredDto = {
  readonly x402Version: 2;
  /** Shown to a human in front of a wallet; the spec puts no meaning in it. */
  readonly error: string;
  readonly resource: z.infer<typeof resourceInfoSchema>;
  readonly accepts: readonly [PaymentRequirementsDto, ...PaymentRequirementsDto[]];
};

/** The complete 402 response, so the route cannot assemble a payable-looking one wrong. */
export type X402Challenge = {
  readonly status: 402;
  readonly headers: { readonly "PAYMENT-REQUIRED": string };
  /** JSON text of the same object the header carries, for a client that has no wallet. */
  readonly body: string;
  readonly paymentRequired: PaymentRequiredDto;
};

/**
 * The rows the gateway resolved for one slug (A7), reduced to what an
 * advertisement needs. Nothing here comes from a payer or a provider: the price
 * floor, the network and the pay-to address are all ours to have wrong, and each
 * has a refusal below for exactly that.
 */
export type RequirementsSource = {
  readonly endpointId: string;
  /** `endpoints.network`. */
  readonly network: string;
  /** `endpoints.asset_contract`: a NEP-141 token account id. */
  readonly assetContract: string;
  /** `endpoints.price_amount`: `numeric(78,0)`, so the driver returns a decimal string. */
  readonly priceAmount: string;
  readonly payoutMode: "direct" | "intents";
  /** `sellers.near_account_id`: the pay-to in `direct` mode (PO-6). */
  readonly sellerNearAccountId: string;
  /** `payout_routes.deposit_address` for a standing intents route; null when it has none. */
  readonly routeDepositAddress: string | null;
  /** The URL the payer is paying for: `GATEWAY_PUBLIC_URL` + `/r/` + slug. */
  readonly gatewayUrl: string;
  /** `endpoints.description`, shown in a paywall. */
  readonly description: string | null;
};

/** Why an endpoint cannot be advertised, in five named cases the route can log. */
export type RequirementsRefusal =
  /** The row pays out on a network this process has no facilitator for. */
  | "network_mismatch"
  /** `intents` mode with no standing deposit address, which we do not go fetch. */
  | "pay_to_unresolved"
  /** A pay-to that is not shaped like a NEAR account id. */
  | "pay_to_invalid"
  /** Below `MIN_PRICE_BASE_UNITS`: a payment that costs more to move than it is worth. */
  | "price_below_floor"
  /** A row our own boundary schemas refuse: non-integer price, unusable URL or description. */
  | "advertisement_invalid";

export type RequirementsResult =
  | {
      readonly ok: true;
      readonly requirements: PaymentRequirementsDto;
      readonly challenge: X402Challenge;
    }
  | { readonly ok: false; readonly reason: RequirementsRefusal; readonly detail: string };

/** `cached` is what a test asserts and what a log line wants; the result is what the route uses. */
export type RequirementsOutcome = {
  readonly cached: boolean;
  readonly result: RequirementsResult;
};

export type RequirementsCache = {
  forEndpoint(source: RequirementsSource): RequirementsOutcome;
  /** Drop one endpoint's entry, or every entry when called with no id. */
  invalidate(endpointId?: string): void;
  readonly size: number;
};

export type RequirementsCacheDeps = {
  /**
   * Only the advertising half of the payment layer (C1). Naming `Pick<>` rather
   * than `X402Near` is the deliberate limit: this module must not be able to
   * verify or settle, and the type says so.
   */
  readonly near: Pick<X402Near, "requirements">;
  /** `env.NEAR_NETWORK`: the single network the facilitator is registered on. */
  readonly network: string;
  /** `env.UPSTREAM_TIMEOUT_MS` and `env.AUTHORIZATION_EXPIRY_MARGIN_MS`, turned into the advertised window. */
  readonly upstreamTimeoutMs: number;
  readonly authorizationExpiryMarginMs: number;
  /** `env.MIN_PRICE_BASE_UNITS`. */
  readonly minPriceBaseUnits: bigint;
  /** A bound on entries, not a policy: see `evictIfNeeded`. */
  readonly maxEntries?: number;
};

/**
 * A window this short would fail Guard 1's own invariant on a config with near-zero
 * timeouts, and 30 s is twice the default demo price's patience; the floor exists
 * so a test config cannot advertise a delegate that expires mid-proxy.
 */
export const MIN_ADVERTISED_TIMEOUT_SECONDS = 30;

/**
 * Slack on top of the timeout the gateway itself imposes, because the window has
 * to outlast the work *and* the settle that follows it. S6 measured that this
 * advertised number is what the payer's client turns into `maxBlockHeight` at
 * `ESTIMATED_BLOCK_SECONDS = 1`, i.e. one second per block, so seconds here are
 * blocks there, and a window shorter than our own upstream timeout means every
 * payment on the endpoint is refused after the seller has already done the work.
 */
export const ADVERTISED_TIMEOUT_SLACK_SECONDS = 15;

const DEFAULT_MAX_ENTRIES = 512;

/**
 * The advertised authorization window, derived from the timeouts the gateway
 * actually enforces rather than set beside them, so the two cannot drift into a
 * configuration where Guard 1 rejects our own challenges. It has no upper clamp on
 * purpose: if a deployment sets a five-minute upstream timeout then delegates
 * really do have to live that long, and quietly advertising 120 s instead would
 * turn the endpoint into one that serves nothing. What a wide window costs is in
 * S6: every second of it is a second a signed delegate stays spendable.
 */
export function advertisedMaxTimeoutSeconds(
  upstreamTimeoutMs: number,
  authorizationExpiryMarginMs: number,
): number {
  const needed = Math.ceil((upstreamTimeoutMs + authorizationExpiryMarginMs) / 1000);
  return Math.max(MIN_ADVERTISED_TIMEOUT_SECONDS, needed + ADVERTISED_TIMEOUT_SLACK_SECONDS);
}

/**
 * The fields an advertisement is made of, in a fixed order. `endpointId` is in it
 * because the entry is keyed by it and a caller swapping two endpoints' rows must
 * not read a hit; the env-level values (network we verify on, window, floor) are
 * not, because they cannot change while the process is up.
 */
function fingerprintOf(source: RequirementsSource): string {
  return JSON.stringify([
    source.endpointId,
    source.network,
    source.assetContract,
    source.priceAmount,
    source.payoutMode,
    source.sellerNearAccountId,
    source.routeDepositAddress,
    source.gatewayUrl,
    source.description,
  ]);
}

function refusal(
  reason: RequirementsRefusal,
  detail: string,
): Extract<RequirementsResult, { ok: false }> {
  return { ok: false, reason, detail };
}

function messageOf(error: unknown): string {
  // A zod failure arrives as `ZodError`, whose `message` is the issue list as JSON:
  // noisy, and it names the field, which is the part a seller needs. Anything else
  // is a bug, and a bug should be readable too.
  return error instanceof Error ? error.message : String(error);
}

export function createRequirementsCache(deps: RequirementsCacheDeps): RequirementsCache {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxTimeoutSeconds = advertisedMaxTimeoutSeconds(
    deps.upstreamTimeoutMs,
    deps.authorizationExpiryMarginMs,
  );
  const entries = new Map<string, { fingerprint: string; result: RequirementsResult }>();

  /**
   * The pay-to for this endpoint, or a refusal. `direct` is the seller's own
   * account and needs no provider (PO-6); `intents` is the route's standing
   * deposit address, and an address the route does not have is not something this
   * path goes out and fetch.
   */
  function payToOf(
    source: RequirementsSource,
  ): { readonly ok: true; readonly payTo: string } | Extract<RequirementsResult, { ok: false }> {
    const payTo =
      source.payoutMode === "direct" ? source.sellerNearAccountId : source.routeDepositAddress;
    if (payTo === null || payTo === "") {
      return refusal(
        "pay_to_unresolved",
        `${source.payoutMode} endpoint ${source.endpointId} has no pay-to address to advertise, and an unpaid request must not go and fetch one`,
      );
    }
    if (!nearAccountIdSchema.safeParse(payTo).success) {
      return refusal(
        "pay_to_invalid",
        `pay-to ${JSON.stringify(payTo)} is not a NEAR account id, so no payer could send a payment to it`,
      );
    }
    return { ok: true, payTo };
  }

  /** Everything about an advertisement that is not the pay-to. Throws only on a row we refuse. */
  function derive(source: RequirementsSource): RequirementsResult {
    if (source.network !== deps.network) {
      return refusal(
        "network_mismatch",
        `endpoint network ${source.network} is not the network this process verifies (${deps.network}); a payment made there would verify as refused forever`,
      );
    }
    const payTo = payToOf(source);
    if (!payTo.ok) {
      return payTo;
    }
    // numeric(78,0) can hold 0 and a negative, because A19's CHECK constraints are
    // still open work, and `BigInt("1.5")` would throw rather than refuse: the
    // integer-string shape is checked before the floor compares it.
    if (!/^\d+$/.test(source.priceAmount)) {
      return refusal(
        "advertisement_invalid",
        `price_amount ${JSON.stringify(source.priceAmount)} is not a base-units integer string`,
      );
    }
    if (BigInt(source.priceAmount) < deps.minPriceBaseUnits) {
      return refusal(
        "price_below_floor",
        `price ${source.priceAmount} is below MIN_PRICE_BASE_UNITS (${deps.minPriceBaseUnits}), so the payment would cost more to move than it is worth`,
      );
    }
    let requirements: PaymentRequirementsDto;
    let resource: PaymentRequiredDto["resource"];
    try {
      // The payment layer is the one place the advertised shape is defined (C1),
      // and its builder validates with `paymentRequirementsSchema`: a positive
      // amount, a v2 network, a scheme we can settle.
      requirements = deps.near.requirements({
        network: source.network,
        assetContract: source.assetContract,
        priceAmount: source.priceAmount,
        payTo: payTo.payTo,
        maxTimeoutSeconds,
      });
      // `description` is `text` in the database and only bounded by the creation
      // DTO, so a hand-inserted row can carry a description the payer's own client
      // schema refuses. Refusing here is the difference between an endpoint that
      // answers 402 and one that answers 402 nothing can pay.
      resource = resourceInfoSchema.parse({
        url: source.gatewayUrl,
        ...(source.description === null || source.description.length === 0
          ? {}
          : { description: source.description }),
        mimeType: "application/json",
      });
    } catch (error) {
      return refusal("advertisement_invalid", messageOf(error));
    }
    const paymentRequired: PaymentRequiredDto = {
      x402Version: 2,
      error: "Payment required",
      resource,
      // One price, never a list: a payer's wallet picks an entry, and an
      // advertisement with two is an endpoint that can be paid the cheaper one.
      accepts: [requirements],
    };
    return {
      ok: true,
      requirements,
      challenge: {
        status: 402,
        headers: { [PAYMENT_REQUIRED_HEADER]: encodePaymentRequired(paymentRequired) },
        body: JSON.stringify(paymentRequired),
        paymentRequired,
      },
    };
  }

  /**
   * Evicts the entry inserted longest ago, not the least recently used, and only
   * when a *new* key is being added — an endpoint whose row changed is replaced in
   * place and must not push a neighbour out. There is no LRU here on purpose: the
   * key is our own `endpoints.id`, so reaching the cap means an installation has
   * that many advertised endpoints, and the thing being bounded is memory, not
   * map growth under an attacker's control.
   */
  function makeRoom(): void {
    const oldest = entries.keys().next();
    if (!oldest.done) {
      entries.delete(oldest.value);
    }
  }

  return {
    forEndpoint(source: RequirementsSource): RequirementsOutcome {
      const fingerprint = fingerprintOf(source);
      const hit = entries.get(source.endpointId);
      if (hit !== undefined && hit.fingerprint === fingerprint) {
        return { cached: true, result: hit.result };
      }
      const result = derive(source);
      if (hit === undefined && entries.size >= maxEntries) {
        makeRoom();
      }
      entries.set(source.endpointId, { fingerprint, result });
      return { cached: false, result };
    },
    invalidate(endpointId?: string): void {
      if (endpointId === undefined) {
        entries.clear();
        return;
      }
      entries.delete(endpointId);
    },
    get size(): number {
      return entries.size;
    },
  };
}
