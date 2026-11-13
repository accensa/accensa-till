import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { type PaymentRequirementsDto, paymentPayloadSchema } from "@till/core";

import {
  ADVERTISED_TIMEOUT_SLACK_SECONDS,
  MIN_ADVERTISED_TIMEOUT_SECONDS,
  PAYMENT_REQUIRED_HEADER,
  type RequirementsCacheDeps,
  type RequirementsSource,
  advertisedMaxTimeoutSeconds,
  createRequirementsCache,
} from "../src/gateway/requirements.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * C2 acceptance: what an unpaid request gets back (GW-1).
 *
 * Nothing here calls a provider or a chain, and that is the point rather than an
 * oversight of the suite: `createRequirementsCache` is handed the advertising half
 * of the payment layer and no `PayoutProvider`, and `forEndpoint` is synchronous,
 * so the two tests named "cannot" below check the shape that makes a provider call
 * impossible instead of counting that none happened.
 *
 * The wire format is not asserted from the spec prose either. It is asserted
 * against what the shipped client reads — the base64 `PAYMENT-REQUIRED` header and
 * the regex its decoder refuses (`@x402/core` 2.18.0
 * `dist/esm/chunk-UCXEF6EL.mjs:1088-1096`, `chunk-ABS7D6VX.mjs:86`) — because a
 * 402 that only puts requirements in the body is a 402 that `curl` can read and no
 * wallet can pay.
 *
 * What is *not* proven here: that a real wallet pays this challenge end to end
 * (A10's accounts, C4's route), or that the advertised `payTo` is storage-registered
 * for the asset. S1 established that the second is not knowable from our side,
 * which is why it stays a verify-time refusal and why nothing in this file claims
 * otherwise.
 */

const NETWORK = "near:testnet";
const SELLER = "seller.testnet";
const TOKEN = "usdc.testnet";
const GATEWAY_URL = "https://till.example/r/7f3a9c";
/** env's own default floor, so a test that clears it clears the real one. */
const FLOOR = 10_000n;
const PRICE = "1000000";

function depsFor(overrides: Partial<RequirementsCacheDeps> = {}): RequirementsCacheDeps {
  return {
    near: createX402Near({ network: NETWORK, maxSponsoredGas: 30_000_000_000_000n }),
    network: NETWORK,
    upstreamTimeoutMs: 15_000,
    authorizationExpiryMarginMs: 30_000,
    minPriceBaseUnits: FLOOR,
    payoutProvider: "mock",
    ...overrides,
  };
}

function sourceFor(overrides: Partial<RequirementsSource> = {}): RequirementsSource {
  return {
    endpointId: "0199b3f0-0000-7000-8000-000000000001",
    network: NETWORK,
    assetContract: TOKEN,
    priceAmount: PRICE,
    payoutMode: "direct",
    sellerNearAccountId: SELLER,
    routeDepositAddress: null,
    routeProvider: null,
    gatewayUrl: GATEWAY_URL,
    description: "Quote of the day, in USD",
    ...overrides,
  };
}

/** The advertised half of the payment layer, with the derivation counted. */
function countingNear() {
  const real = createX402Near({ network: NETWORK, maxSponsoredGas: 30_000_000_000_000n });
  const calls: RequirementsInputLike[] = [];
  return {
    calls,
    near: {
      requirements(input: RequirementsInputLike): PaymentRequirementsDto {
        calls.push(input);
        return real.requirements(input);
      },
    },
  };
}

type RequirementsInputLike = Parameters<ReturnType<typeof createX402Near>["requirements"]>[number];

function okRequirements(
  cache: ReturnType<typeof createRequirementsCache>,
  source: RequirementsSource,
) {
  const { result } = cache.forEndpoint(source);
  if (!result.ok) {
    throw new Error(`expected an advertisement, got ${result.reason}: ${result.detail}`);
  }
  return result;
}

function decode(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("the advertisement a payer must answer (GW-1)", () => {
  const cache = createRequirementsCache(depsFor());

  it("carries the price, asset, network and pay-to from the endpoint's own rows", () => {
    const { requirements } = okRequirements(cache, sourceFor());
    expect(requirements).toMatchObject({
      scheme: "exact",
      network: NETWORK,
      amount: PRICE,
      asset: TOKEN,
      payTo: SELLER,
    });
  });

  it("reaches 402 through the header a v2 client reads, and its decoder accepts it", () => {
    const { challenge } = okRequirements(cache, sourceFor());
    expect(challenge.status).toBe(402);
    const header = challenge.headers[PAYMENT_REQUIRED_HEADER];
    // The shipped decoder's own regex: a header that fails it throws
    // "Invalid payment required header" in the client, i.e. an endpoint that 402s
    // and is never paid.
    expect(/^[A-Za-z0-9+/]*={0,2}$/.test(header)).toBe(true);
    const decoded = decode(header);
    expect(decoded.x402Version).toBe(2);
    expect((decoded.accepts as PaymentRequirementsDto[])[0]?.payTo).toBe(SELLER);
    expect(decoded.resource).toMatchObject({ url: GATEWAY_URL });
  });

  it("sends the same object in the body and never claims v1 there", () => {
    const { challenge } = okRequirements(cache, sourceFor());
    const body = JSON.parse(challenge.body) as Record<string, unknown>;
    expect(body).toEqual(decode(challenge.headers[PAYMENT_REQUIRED_HEADER]));
    // The client's body fallback fires only on `body.x402Version === 1`
    // (chunk-UCXEF6EL.mjs:1093), so a v2 body cannot be mistaken for a v1 one.
    expect(body.x402Version).toBe(2);
  });

  it("advertises exactly one price, because a wallet picks one entry from a list", () => {
    const { challenge } = okRequirements(cache, sourceFor());
    expect(challenge.paymentRequired.accepts).toHaveLength(1);
  });

  it("names the resource so the payer sees what it is buying", () => {
    const { challenge } = okRequirements(cache, sourceFor());
    expect(challenge.paymentRequired.resource).toEqual({
      url: GATEWAY_URL,
      description: "Quote of the day, in USD",
      mimeType: "application/json",
    });
  });

  it("omits an empty description instead of shipping a field nothing displays", () => {
    const { challenge } = okRequirements(cache, sourceFor({ description: null }));
    expect("description" in challenge.paymentRequired.resource).toBe(false);
  });

  it("is a requirements object a buyer can echo back in a payable payload", () => {
    const { requirements } = okRequirements(cache, sourceFor());
    const parsed = paymentPayloadSchema.safeParse({
      x402Version: 2,
      accepted: requirements,
      payload: { signedDelegateAction: "A".repeat(120) },
    });
    expect(parsed.success).toBe(true);
  });

  it("advertises a window that outlasts the gateway's own timeouts (Guard 1, S6)", () => {
    const { requirements } = okRequirements(cache, sourceFor());
    const needed = Math.ceil(
      (depsFor().upstreamTimeoutMs + depsFor().authorizationExpiryMarginMs) / 1000,
    );
    expect(requirements.maxTimeoutSeconds).toBeGreaterThanOrEqual(needed);
    expect(requirements.maxTimeoutSeconds).toBe(60);
  });
});

describe("what Till refuses to advertise", () => {
  it("refuses an endpoint on a network it cannot verify (GW-1)", () => {
    const cache = createRequirementsCache(depsFor());
    const { result } = cache.forEndpoint(sourceFor({ network: "near:mainnet" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("network_mismatch");
    expect(result.detail).toContain("near:mainnet");
    expect(result.detail).toContain(NETWORK);
  });

  it("refuses an intents endpoint with no standing deposit address, instead of fetching one", () => {
    const cache = createRequirementsCache(depsFor());
    const { result } = cache.forEndpoint(
      sourceFor({ payoutMode: "intents", routeDepositAddress: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("pay_to_unresolved");
  });

  it("treats an empty deposit address as no deposit address", () => {
    const cache = createRequirementsCache(depsFor());
    const { result } = cache.forEndpoint(
      sourceFor({ payoutMode: "intents", routeDepositAddress: "" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("pay_to_unresolved");
  });

  it("advertises a standing deposit address as the pay-to in intents mode", () => {
    const cache = createRequirementsCache(depsFor());
    const { requirements } = okRequirements(
      cache,
      sourceFor({
        payoutMode: "intents",
        routeDepositAddress: "deposits.intents.testnet",
        routeProvider: "mock",
      }),
    );
    expect(requirements.payTo).toBe("deposits.intents.testnet");
  });

  it("refuses to advertise a deposit address another provider minted (G7, D5)", () => {
    // The one config change that used to be silently wrong: `payout_routes` is
    // immutable and keyed by provider, so flipping PAYOUT_PROVIDER to `oneclick`
    // mints nothing new and leaves every existing intents endpoint advertising
    // `mock-deposit-N` -- a NEAR-account-shaped name with no account behind it. A
    // payer's ft_transfer reverts after the seller has already served.
    const cache = createRequirementsCache(depsFor({ payoutProvider: "oneclick" }));
    const { result } = cache.forEndpoint(
      sourceFor({
        payoutMode: "intents",
        routeDepositAddress: "mock-deposit-1",
        routeProvider: "mock",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("route_provider_mismatch");
    expect(result.detail).toContain("oneclick");
    expect(result.detail).toContain("mock");
  });

  it("still advertises a direct endpoint when the provider changed, because it needs no route", () => {
    // `direct` pays the seller's own account (PO-6), so a stale route row cannot
    // make it wrong and refusing it would take a working paywall offline.
    const cache = createRequirementsCache(depsFor({ payoutProvider: "oneclick" }));
    const { requirements } = okRequirements(cache, sourceFor({ routeProvider: "mock" }));
    expect(requirements.payTo).toBe(SELLER);
  });

  it("refuses a pay-to that cannot be a NEAR account id in either mode", () => {
    // What this guard catches, stated exactly: a shape that no NEAR account can
    // have. A lowercase 40-character hex string passes, and it should — NEAR
    // implicit accounts are hex, so an address pasted from another chain is only
    // refused when it carries uppercase, a separator or a length the grammar rules
    // out. Whether a well-shaped account *exists*, and is registered for the asset,
    // is the verify-time read S1 named, and D4's creation check is where it belongs.
    const cache = createRequirementsCache(depsFor());
    const cases = [
      sourceFor({ sellerNearAccountId: "0x8F3A9C1D4E7B2A5F" }),
      sourceFor({ payoutMode: "intents", routeDepositAddress: "USDC-deposit-1" }),
      sourceFor({ payoutMode: "intents", routeDepositAddress: "deposit address" }),
      sourceFor({ payoutMode: "intents", routeDepositAddress: ".leading-dot" }),
    ];
    for (const source of cases) {
      const { result } = cache.forEndpoint(source);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("pay_to_invalid");
    }
  });

  it("refuses a price below the floor and accepts one exactly at it (PO-2, S7)", () => {
    const cache = createRequirementsCache(depsFor());
    const below = cache.forEndpoint(sourceFor({ priceAmount: "9999" }));
    expect(below.result.ok).toBe(false);
    if (below.result.ok) throw new Error("unreachable");
    expect(below.result.reason).toBe("price_below_floor");
    // The comparison is `<`, so the floor itself is advertisable: pinning it here is
    // what stops a later >= from silently turning the minimum price into an
    // endpoint that cannot be sold.
    expect(okRequirements(cache, sourceFor({ priceAmount: "10000" })).requirements.amount).toBe(
      "10000",
    );
  });

  it("refuses a price the database can hold but a payment cannot be (A19 is open)", () => {
    const cache = createRequirementsCache(depsFor());
    for (const priceAmount of ["-5", "0", "1.5", ""]) {
      const { result } = cache.forEndpoint(sourceFor({ priceAmount }));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      // Zero is below the floor, which says the same thing in seller's words;
      // the rest are not integers at all.
      expect(["price_below_floor", "advertisement_invalid"]).toContain(result.reason);
      if (priceAmount === "-5" || priceAmount === "1.5") {
        expect(result.reason).toBe("advertisement_invalid");
      }
      if (priceAmount === "0") {
        expect(result.reason).toBe("price_below_floor");
      }
    }
  });

  it("refuses a description or URL a payer's own client schema would reject", () => {
    const cache = createRequirementsCache(depsFor());
    const long = cache.forEndpoint(sourceFor({ description: "x".repeat(5_000) }));
    const badUrl = cache.forEndpoint(sourceFor({ gatewayUrl: "not-a-url" }));
    for (const { result } of [long, badUrl]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.reason).toBe("advertisement_invalid");
    }
    if (long.result.ok) throw new Error("unreachable");
    expect(long.result.detail).toContain("description");
  });

  it("keeps a zero-or-negative floor from ever being reached by config, not by luck", () => {
    // env.ts refuses MIN_PRICE_BASE_UNITS below 1, so the cache's job is only the
    // comparison. This pins that a floor of 1 advertises the smallest positive
    // price rather than turning the check off.
    const cache = createRequirementsCache(depsFor({ minPriceBaseUnits: 1n }));
    expect(okRequirements(cache, sourceFor({ priceAmount: "1" })).requirements.amount).toBe("1");
  });
});

describe("the per-endpoint cache (GW-1: an unpaid request costs one row read)", () => {
  it("re-derives nothing while the endpoint is unchanged", () => {
    const counter = countingNear();
    const cache = createRequirementsCache(depsFor({ near: counter.near }));
    const first = cache.forEndpoint(sourceFor());
    const second = cache.forEndpoint(sourceFor());
    expect([first.cached, second.cached]).toEqual([false, true]);
    expect(counter.calls).toHaveLength(1);
    if (!(first.result.ok && second.result.ok)) throw new Error("unreachable");
    expect(second.result.requirements).toBe(first.result.requirements);
    expect(second.result.challenge).toBe(first.result.challenge);
  });

  it("re-advertises the moment the price changes, without being told to", () => {
    const counter = countingNear();
    const cache = createRequirementsCache(depsFor({ near: counter.near }));
    cache.forEndpoint(sourceFor());
    const changed = cache.forEndpoint(sourceFor({ priceAmount: "2000000" }));
    expect(counter.calls).toHaveLength(2);
    expect(changed.cached).toBe(false);
    if (!changed.result.ok) throw new Error("unreachable");
    expect(changed.result.requirements.amount).toBe("2000000");
    expect(decode(changed.result.challenge.headers[PAYMENT_REQUIRED_HEADER]).accepts).toEqual([
      expect.objectContaining({ amount: "2000000" }),
    ]);
  });

  it("re-advertises when the pay-to moves, which is the field a payer acts on", () => {
    const cache = createRequirementsCache(depsFor());
    cache.forEndpoint(sourceFor());
    const moved = cache.forEndpoint(sourceFor({ sellerNearAccountId: "other.testnet" }));
    expect(moved.cached).toBe(false);
    if (!moved.result.ok) throw new Error("unreachable");
    expect(moved.result.requirements.payTo).toBe("other.testnet");
  });

  it("keeps one entry per endpoint, not one entry per request", () => {
    const cache = createRequirementsCache(depsFor());
    const a = cache.forEndpoint(sourceFor({ endpointId: "0199b3f0-0000-7000-8000-00000000000a" }));
    const b = cache.forEndpoint(sourceFor({ endpointId: "0199b3f0-0000-7000-8000-00000000000b" }));
    expect([a.cached, b.cached]).toEqual([false, false]);
    expect(cache.size).toBe(2);
    expect(
      cache.forEndpoint(sourceFor({ endpointId: "0199b3f0-0000-7000-8000-00000000000a" })).cached,
    ).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("drops one endpoint on request and all of them on an empty call", () => {
    const cache = createRequirementsCache(depsFor());
    const idA = "0199b3f0-0000-7000-8000-00000000000a";
    const idB = "0199b3f0-0000-7000-8000-00000000000b";
    cache.forEndpoint(sourceFor({ endpointId: idA }));
    cache.forEndpoint(sourceFor({ endpointId: idB }));
    cache.invalidate(idA);
    expect(cache.size).toBe(1);
    expect(cache.forEndpoint(sourceFor({ endpointId: idA })).cached).toBe(false);
    expect(cache.forEndpoint(sourceFor({ endpointId: idB })).cached).toBe(true);
    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  it("caches a refusal too, and forgets it as soon as the row is fixed", () => {
    const counter = countingNear();
    const cache = createRequirementsCache(depsFor({ near: counter.near }));
    const broken = sourceFor({ priceAmount: "7" });
    const first = cache.forEndpoint(broken);
    const second = cache.forEndpoint(broken);
    expect([first.cached, second.cached]).toEqual([false, true]);
    expect(counter.calls).toHaveLength(0);
    const fixed = cache.forEndpoint(sourceFor());
    expect(fixed.cached).toBe(false);
    expect(fixed.result.ok).toBe(true);
    expect(counter.calls).toHaveLength(1);
  });

  it("bounds its memory at maxEntries, evicting the oldest entry", () => {
    const cache = createRequirementsCache(depsFor({ maxEntries: 2 }));
    const sources = ["01", "02", "03"].map((suffix) =>
      sourceFor({ endpointId: `0199b3f0-0000-7000-8000-0000000000${suffix}` }),
    );
    for (const source of sources) {
      cache.forEndpoint(source);
    }
    expect(cache.size).toBe(2);
    expect(cache.forEndpoint(sources[0] as RequirementsSource).cached).toBe(false);
    expect(cache.forEndpoint(sources[2] as RequirementsSource).cached).toBe(true);
  });

  it("cannot reach a provider: the dependency set has nothing that could", () => {
    const deps = depsFor();
    expect(Object.keys(deps).sort()).toEqual(
      [
        "authorizationExpiryMarginMs",
        "minPriceBaseUnits",
        "near",
        "network",
        "payoutProvider",
        "upstreamTimeoutMs",
      ].sort(),
    );
    // And the path is synchronous, so there is no await that could become a call.
    const cache = createRequirementsCache(deps);
    expect(cache.forEndpoint(sourceFor())).not.toBeInstanceOf(Promise);
  });

  it("never verifies, settles or touches the payment layer's other half", () => {
    // `Pick<X402Near, "requirements">` is the compile-time limit; this is the
    // runtime one. A full payment layer is handed in, with the two money-moving
    // methods replaced by spies that would succeed, and an advertisement of every
    // shape must not reach either. Mutating `derive` to call `verify` — the
    // plausible slip in C4, where the route wants the payer checked here — fails
    // this test rather than settling a payment twice.
    const real = createX402Near({ network: NETWORK, maxSponsoredGas: 30_000_000_000_000n });
    const reached: string[] = [];
    const spyingNear = {
      requirements: real.requirements,
      async verify(body: unknown, requirements: PaymentRequirementsDto) {
        reached.push("verify");
        return real.verify(body, requirements);
      },
      async settle(body: unknown, requirements: PaymentRequirementsDto) {
        reached.push("settle");
        return real.settle(body, requirements);
      },
    };
    const cache = createRequirementsCache(depsFor({ near: spyingNear }));
    const { result } = cache.forEndpoint(sourceFor());
    if (!result.ok) throw new Error("unreachable");
    cache.forEndpoint(sourceFor({ priceAmount: "2000000" }));
    cache.forEndpoint(sourceFor({ network: "near:mainnet" }));
    cache.forEndpoint(sourceFor({ priceAmount: "7" }));
    cache.forEndpoint(sourceFor());
    expect(reached).toEqual([]);
    expect(result.challenge.status).toBe(402);
  });
});

describe("the challenge over HTTP (the shape C4 returns)", () => {
  it("arrives as a 402 whose header a wallet reads and whose body a person reads", async () => {
    // Not the gateway route — that is C4, and hard rule 2's order belongs there.
    // This is the one thing C2's Done-when asks that an in-memory assertion cannot
    // show: that the challenge survives an HTTP framework at all, with the header
    // name intact and the JSON parseable on the other side of a response.
    const cache = createRequirementsCache(depsFor());
    const { result } = cache.forEndpoint(sourceFor());
    if (!result.ok) throw new Error("unreachable");
    const app = new Hono();
    app.get("/r/:slug", (c) =>
      c.body(result.challenge.body, result.challenge.status, {
        "Content-Type": "application/json",
        [PAYMENT_REQUIRED_HEADER]: result.challenge.headers[PAYMENT_REQUIRED_HEADER],
      }),
    );
    const response = await app.request("/r/7f3a9c");
    expect(response.status).toBe(402);
    const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(header).not.toBeNull();
    const decoded = decode(header as string);
    expect((decoded.accepts as PaymentRequirementsDto[])[0]).toMatchObject({
      amount: PRICE,
      asset: TOKEN,
      network: NETWORK,
      payTo: SELLER,
    });
    expect(await response.json()).toEqual(decoded);
  });
});

describe("the advertised authorization window (S6, GW-5)", () => {
  it("is the gateway's own timeouts plus slack", () => {
    expect(advertisedMaxTimeoutSeconds(15_000, 30_000)).toBe(45 + ADVERTISED_TIMEOUT_SLACK_SECONDS);
    expect(advertisedMaxTimeoutSeconds(90_000, 5_000)).toBe(95 + ADVERTISED_TIMEOUT_SLACK_SECONDS);
  });

  it("rounds a fractional need up rather than down", () => {
    // 40 001 ms needs 41 s, and the floor does not apply once 41 + slack clears it.
    expect(advertisedMaxTimeoutSeconds(40_001, 0)).toBe(41 + ADVERTISED_TIMEOUT_SLACK_SECONDS);
  });

  it("never goes below the floor, and never clamps a slow config", () => {
    expect(advertisedMaxTimeoutSeconds(0, 0)).toBe(MIN_ADVERTISED_TIMEOUT_SECONDS);
    expect(advertisedMaxTimeoutSeconds(1_001, 0)).toBe(MIN_ADVERTISED_TIMEOUT_SECONDS);
    // A five-minute upstream is env-legal, and advertising 120 s for it would make
    // Guard 1 refuse every payment on the endpoint. The window has to be honest.
    expect(advertisedMaxTimeoutSeconds(300_000, 60_000)).toBe(375);
  });

  it("is what the cache actually advertises, derived from its own deps", () => {
    const cache = createRequirementsCache(depsFor({ upstreamTimeoutMs: 90_000 }));
    const { result } = cache.forEndpoint(sourceFor());
    if (!result.ok) throw new Error("unreachable");
    expect(result.requirements.maxTimeoutSeconds).toBe(advertisedMaxTimeoutSeconds(90_000, 30_000));
  });
});
