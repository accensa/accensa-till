import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env.ts";
import { createProvider } from "../src/payouts/index.ts";
import {
  MOCK_OUTCOMES,
  type MockOutcome,
  MockProvider,
  type MockScript,
} from "../src/payouts/mock/provider.ts";
import { OneClickClient } from "../src/payouts/oneclick/client.ts";
import type { PayoutProvider, PrepareRouteInput, PreparedRoute } from "../src/payouts/provider.ts";

/**
 * D2's acceptance tests for the mock provider (PO-5). The point of a mock in a
 * money system is that it can only say what it was told to say, so most of these
 * tests aim at the refusals: no script left, a reference that was never issued,
 * an outcome outside the four. A provider that fills those in with `succeeded`
 * would make every demo green and every conclusion false (DQ-2).
 */

const ONE = 1_000_000n;

const routeInput = (overrides: Partial<PrepareRouteInput> = {}): PrepareRouteInput => ({
  destinationChain: "near",
  destinationAsset: "usdc",
  destinationAddress: "seller.near",
  refundAddress: "seller-refund.near",
  amount: ONE,
  ...overrides,
});

function script(outcome: MockOutcome, overrides: Partial<MockScript> = {}): MockScript {
  return { outcome, amountIn: ONE, ...overrides };
}

function refOf(route: PreparedRoute): string {
  if (route.quoteRef === null) {
    throw new Error("the mock must hand back a quote reference to poll");
  }
  return route.quoteRef;
}

/** The quote reference is the provider ref the poller will use (D1, D6). */
async function prepare(provider: MockProvider, overrides: Partial<PrepareRouteInput> = {}) {
  const route = await provider.prepareRoute(routeInput(overrides));
  return { route, ref: refOf(route) };
}

describe("the mock scripts exactly the four outcomes (D2, PO-5)", () => {
  it("names the four outcomes and nothing else", () => {
    expect(MOCK_OUTCOMES).toEqual(["succeed", "refund", "fail", "stall"]);
  });

  it("succeed reports the destination hash and the full amount out", async () => {
    const provider = new MockProvider([script("succeed", { originTxHash: "tx-a" })]);
    const { ref } = await prepare(provider);
    const [swap] = await provider.getStatus({ providerRefs: [ref] });
    expect(swap?.state).toBe("succeeded");
    expect(swap?.amountIn).toBe(ONE);
    expect(swap?.amountOut).toBe(ONE);
    expect(swap?.refundedAmount).toBeNull();
    expect(swap?.originTxHash).toBe("tx-a");
    expect(swap?.destinationTxHash).toBe(`mock-out-${ref}`);
  });

  it("refund reports what came back and no amount out", async () => {
    const provider = new MockProvider([
      script("refund", { originTxHash: "tx-b", refundedAmount: 250_000n }),
    ]);
    const { ref } = await prepare(provider);
    const [swap] = await provider.getStatus({ providerRefs: [ref] });
    expect(swap?.state).toBe("refunded");
    expect(swap?.amountOut).toBeNull();
    expect(swap?.refundedAmount).toBe(250_000n);
    expect(swap?.destinationTxHash).toBeNull();
  });

  it("fail reports neither an amount out nor a refund, so the money is unaccounted", async () => {
    const provider = new MockProvider([script("fail", { originTxHash: "tx-c" })]);
    const { ref } = await prepare(provider);
    const [swap] = await provider.getStatus({ providerRefs: [ref] });
    expect(swap?.state).toBe("failed");
    expect(swap?.amountOut).toBeNull();
    expect(swap?.refundedAmount).toBeNull();
    expect(swap?.destinationTxHash).toBeNull();
  });

  it("stall stays non-terminal so payout-stuck can age it", async () => {
    const provider = new MockProvider([script("stall")]);
    const { ref } = await prepare(provider);
    const [swap] = await provider.getStatus({ providerRefs: [ref] });
    expect(swap?.state).toBe("processing");
    expect(swap?.amountIn).toBe(ONE);
    expect(swap?.amountOut).toBeNull();
  });

  it("keeps every reported amount a bigint or null, never a number (hard rule 3)", async () => {
    for (const outcome of MOCK_OUTCOMES) {
      const provider = new MockProvider([script(outcome)]);
      const { ref } = await prepare(provider);
      const [swap] = await provider.getStatus({ providerRefs: [ref] });
      if (swap === undefined) {
        throw new Error(`no status for ${outcome}`);
      }
      for (const amount of [swap.amountIn, swap.amountOut, swap.refundedAmount]) {
        expect(amount === null || typeof amount === "bigint").toBe(true);
      }
    }
  });

  it("refuses a fifth outcome, and a float amount, at compile time", () => {
    // @ts-expect-error "settled" is not one of the four scripted outcomes
    const notAnOutcome: MockScript = { outcome: "settled", amountIn: ONE };
    // @ts-expect-error base units are bigint, never a float
    const floatAmount: MockScript = { outcome: "succeed", amountIn: 1.5 };
    // The values survive at runtime — only the compiler refuses them, which is
    // what makes these assertions fail loudly if the types ever loosen.
    expect(notAnOutcome.outcome).toBe("settled");
    expect(floatAmount.amountIn).toBe(1.5);
  });
});

describe("the mock refuses to invent an outcome (DQ-2)", () => {
  it("mints a route that has no outcome scripted, and refuses to report a status for it", async () => {
    // D5 separated the two halves of this. Preparing a route is what endpoint
    // creation does while there is still no payment to script an outcome for, so it
    // succeeds; the state a poller reads is the part that must have been chosen, and
    // a mock that answered `succeeded` for a quote nobody scripted is DQ-2's exact
    // worry.
    const provider = new MockProvider([]);
    const route = await provider.prepareRoute(routeInput({ amount: null }));
    expect(route.depositAddress).toMatch(/^mock-deposit-\d+$/);
    expect(route.modeDetail).toBe("standing");
    // No script also means no floor: a number here would be a quote the caller never
    // asked for, and reconciliation would read it as a shortfall threshold nobody set.
    expect(route.minAmountOut).toBeNull();
    await expect(provider.getStatus({ providerRefs: [refOf(route)] })).rejects.toThrow(
      /nothing was ever scripted/,
    );
  });

  it("throws for a reference it never issued, rather than returning a made-up swap", async () => {
    const provider = new MockProvider([script("succeed")]);
    await expect(provider.getStatus({ providerRefs: ["mock-quote-9"] })).rejects.toThrow(
      /refusing to invent an outcome/,
    );
  });

  it("does not honour references from another provider instance", async () => {
    const scripted = new MockProvider([script("succeed")]);
    const { ref } = await prepare(scripted);
    const other = new MockProvider([script("succeed")]);
    await expect(other.getStatus({ providerRefs: [ref] })).rejects.toThrow(/never issued/);
  });

  it("issues one distinct reference per route and applies each route's own script", async () => {
    const provider = new MockProvider([script("succeed"), script("fail")]);
    const first = await provider.prepareRoute(routeInput());
    const second = await provider.prepareRoute(routeInput());
    expect(first.quoteRef).toBe("mock-quote-1");
    expect(second.quoteRef).toBe("mock-quote-2");
    expect(first.depositAddress).not.toBe(second.depositAddress);
    const statuses = await provider.getStatus({
      providerRefs: [refOf(first), refOf(second)],
    });
    expect(statuses.map((status) => status.state)).toEqual(["succeeded", "failed"]);
  });

  it("marks every raw payload simulated, because swaps.raw is kept for diagnosis", async () => {
    const provider = new MockProvider([script("refund")]);
    const { ref } = await prepare(provider);
    const [swap] = await provider.getStatus({ providerRefs: [ref] });
    expect(swap?.raw).toEqual({
      simulated: true,
      provider: "mock",
      outcome: "refund",
      poll: 1,
      status: "MOCK_REFUND",
    });
  });
});

describe("polling the mock behaves like a provider with a history", () => {
  it("stays processing for a stall across thirty polls", async () => {
    const provider = new MockProvider([script("stall")]);
    const { ref } = await prepare(provider);
    for (let poll = 0; poll < 30; poll += 1) {
      const [swap] = await provider.getStatus({ providerRefs: [ref] });
      expect(swap?.state).toBe("processing");
      expect(swap?.raw).toMatchObject({ poll: poll + 1 });
    }
  });

  it("repeats a terminal status on every later poll, so a re-poll cannot regress it", async () => {
    const provider = new MockProvider([script("succeed", { originTxHash: "tx-a" })]);
    const { ref } = await prepare(provider);
    const [first] = await provider.getStatus({ providerRefs: [ref] });
    const [second] = await provider.getStatus({ providerRefs: [ref] });
    if (first === undefined || second === undefined) {
      throw new Error("the mock returned no status");
    }
    expect(second.state).toBe(first.state);
    expect(second.amountOut).toBe(first.amountOut);
    expect(second.destinationTxHash).toBe(first.destinationTxHash);
    expect(second).toEqual({ ...first, raw: { ...(first.raw as object), poll: 2 } });
  });

  it("holds an outcome back until its scripted poll, showing processing first", async () => {
    const provider = new MockProvider([script("succeed", { resolvesOnPoll: 3 })]);
    const { ref } = await prepare(provider);
    const states: string[] = [];
    for (let poll = 0; poll < 3; poll += 1) {
      const [swap] = await provider.getStatus({ providerRefs: [ref] });
      states.push(swap?.state ?? "none");
    }
    expect(states).toEqual(["processing", "processing", "succeeded"]);
  });

  it("answers one entry per requested reference, in order", async () => {
    const provider = new MockProvider([script("succeed"), script("refund")]);
    const a = await provider.prepareRoute(routeInput());
    const b = await provider.prepareRoute(routeInput());
    const statuses = await provider.getStatus({ providerRefs: [refOf(b), refOf(a)] });
    expect(statuses.map((status) => status.providerRef)).toEqual([refOf(b), refOf(a)]);
  });
});

describe("routes the mock prepares are shaped for both intents designs", () => {
  it("gives a per-payment quote a deadline read from the injected clock", async () => {
    const at = new Date("2026-11-03T12:00:00.000Z");
    const provider = new MockProvider([script("succeed")], { clock: () => at });
    const { route } = await prepare(provider);
    expect(route.modeDetail).toBe("per_payment");
    expect(route.deadlineAt?.getTime()).toBe(at.getTime() + 90_000);
    expect(route.depositAddress).toBe("mock-deposit-1");
    expect(route.depositMemo).toBeNull();
  });

  it("treats a standing route, which quotes without an amount, as having no deadline", async () => {
    const provider = new MockProvider([script("succeed")]);
    const { route } = await prepare(provider, { amount: null });
    expect(route.modeDetail).toBe("standing");
    expect(route.deadlineAt).toBeNull();
  });

  it("defaults the quote floor to the whole deposit, and lets a script lower it", async () => {
    const plain = new MockProvider([script("succeed")]);
    const strict = await prepare(plain);
    expect(strict.route.minAmountOut).toBe(ONE);
    const tolerant = new MockProvider([
      script("succeed", { minAmountOut: 995_000n, amountOut: 900_000n }),
    ]);
    const { route } = await prepare(tolerant);
    expect(route.minAmountOut).toBe(995_000n);
  });

  it("lists only 6-decimal assets, because payouts are stablecoin-only (hard rule 9)", async () => {
    const assets = await new MockProvider([]).listAssets();
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(asset.decimals).toBe(6);
    }
  });
});

describe("provider selection", () => {
  const required = {
    DATABASE_URL: "postgres://till:till@localhost:5432/till",
    SESSION_SECRET: "x".repeat(32),
    GATEWAY_PUBLIC_URL: "http://localhost:3000",
  };

  it("builds the mock for the default environment, with the script the caller supplied", () => {
    const env = loadEnv({ ...process.env, ...required });
    expect(env.PAYOUT_PROVIDER).toBe("mock");
    const provider: PayoutProvider = createProvider(env, [script("succeed")]);
    expect(provider).toBeInstanceOf(MockProvider);
  });

  it("selects the real provider, which can poll and read assets but cannot mint a deposit address (D3)", async () => {
    const env = loadEnv({ ...process.env, ...required, PAYOUT_PROVIDER: "oneclick" });
    const provider = createProvider(env, []);
    expect(provider).toBeInstanceOf(OneClickClient);
    // The live-money boundary, in the test that names it: the quote's originAsset,
    // depositType and slippageTolerance are undecided (S2/B8), so no address may be
    // issued and no mainnet movement can be advertised by a poller that is otherwise
    // wired up. A passing getStatus half must never come with a working prepareRoute.
    await expect(
      provider.prepareRoute({
        destinationChain: "near",
        destinationAsset: "usdc.testnet",
        destinationAddress: "seller.near",
        refundAddress: "refund.near",
        amount: null,
      }),
    ).rejects.toThrow(/undecided \(S2\/B8\)/);
  });

  it("publishes the real provider's per-pass call bound so the poller can size its claim (S5)", () => {
    const env = loadEnv({ ...process.env, ...required, PAYOUT_PROVIDER: "oneclick" });
    const provider = createProvider(env, []);
    expect(provider.statusCallsPerPass).toBe(env.ONECLICK_STATUS_CALLS_PER_PASS);
    // The mock answers a whole batch from one script, so it publishes nothing and
    // the poller keeps its own default rather than a rate limit it does not have.
    // Read through the interface: the bound is `PayoutProvider`'s optional member,
    // and a mock that does not have it is still a `PayoutProvider`.
    const scriptless: PayoutProvider = new MockProvider([]);
    expect(scriptless.statusCallsPerPass).toBeUndefined();
  });

  it("leaves a mock with no script unusable rather than cheerful", async () => {
    const env = loadEnv({ ...process.env, ...required });
    const provider = createProvider(env, []);
    await expect(provider.getStatus({ providerRefs: ["mock-quote-1"] })).rejects.toThrow(
      /never issued/,
    );
  });
});
