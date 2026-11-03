import { SWAP_STATES } from "@till/core";
import { describe, expect, it } from "vitest";

import type {
  NormalizedSwap,
  PayoutProvider,
  PrepareRouteInput,
  PreparedRoute,
  SupportedAsset,
} from "../src/payouts/provider.ts";

/**
 * D1's "type tests": the contract is the only place the app and a provider meet,
 * so what matters is not that these names exist but that the shapes cannot be
 * misread — a missing value is `null`, never `undefined`, because a swap we have
 * not polled and a swap the provider says has no output are different facts and
 * both have to survive a JSON round trip into `swaps.raw`.
 *
 * `@ts-expect-error` lines are the assertions here: if one of them stops being an
 * error, tsc fails the file for being unused, so a widening of the contract cannot
 * pass unnoticed.
 */

const swap: NormalizedSwap = {
  providerRef: "ref-1",
  state: "processing",
  amountIn: 2_500_000n,
  // The provider has not told us the output yet: null, not absent.
  amountOut: null,
  refundedAmount: null,
  // Unmatched is a fact about our join, not an absent field (LR-2).
  originTxHash: null,
  destinationTxHash: null,
  raw: { status: "PROCESSING" },
};

const route: PreparedRoute = {
  depositAddress: "buyer.testnet",
  depositMemo: null,
  quoteRef: null,
  minAmountOut: 2_490_000n,
  deadlineAt: new Date("2026-11-04T00:00:00.000Z"),
  modeDetail: "standing",
};

/** The `direct` mode shape (PO-6): no swap, so no deposit address at all. */
const directRoute: PreparedRoute = {
  depositAddress: null,
  depositMemo: null,
  quoteRef: null,
  minAmountOut: null,
  deadlineAt: null,
  modeDetail: "direct",
};

const asset: SupportedAsset = {
  chain: "near:mainnet",
  asset: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  symbol: "USDC",
  decimals: 6,
};

const input: PrepareRouteInput = {
  destinationChain: "eip155:1",
  destinationAsset: "usdc",
  destinationAddress: "0x0000000000000000000000000000000000000000",
  refundAddress: "seller.testnet",
  // A standing route needs no amount; a per-payment quote does (S2 decides).
  amount: null,
};

describe("payout provider contract (D1, PO-4)", () => {
  it("keeps money as bigint base units, never a string or a number", () => {
    expect(typeof swap.amountIn).toBe("bigint");
    expect(typeof route.minAmountOut).toBe("bigint");
    // Hard rule 3: a float amount is not assignable to the contract.
    // @ts-expect-error amountIn is BaseUnitAmount, not number
    const floatAmount: NormalizedSwap = { ...swap, amountIn: 2500000.5 };
    // JavaScript keeps the value: only the type stops it, which is why the check
    // lives here rather than in a runtime guard someone would forget to call.
    expect(typeof floatAmount.amountIn).toBe("number");
  });

  it("refuses a state outside the normalized enum", () => {
    // The provider's own SCREAMING_SNAKE value must not reach this type: the
    // mapping is D3's job, and a raw status stored as if it were ours would make
    // `isTerminalSwapState` answer for a string we never defined.
    // @ts-expect-error the provider's raw status is not one of our states
    const raw: NormalizedSwap = { ...swap, state: "INCOMPLETE_DEPOSIT" };
    expect(SWAP_STATES as readonly string[]).not.toContain(raw.state);
  });

  it("requires every field, so a provider cannot omit one and have it read as no-data", () => {
    // @ts-expect-error originTxHash is part of the contract even when null
    const omitted: NormalizedSwap = {
      providerRef: "ref-1",
      state: "processing",
      amountIn: null,
      amountOut: null,
      refundedAmount: null,
      destinationTxHash: null,
      raw: {},
    };
    expect(omitted).not.toHaveProperty("originTxHash");
    expect(swap).toHaveProperty("originTxHash");
  });

  it("distinguishes direct mode from a swap route by modeDetail, not by a missing address", () => {
    expect(directRoute.depositAddress).toBeNull();
    expect(directRoute.modeDetail).toBe("direct");
    expect(route.modeDetail).toBe("standing");
    // @ts-expect-error "instant" is not one of the three modes
    const badMode: PreparedRoute = { ...route, modeDetail: "instant" };
    // As with money: only the compiler refuses a fourth mode, so the value sails
    // through at runtime and no code may branch on the string loosely.
    expect(badMode.modeDetail).toBe("instant");
  });

  it("describes the interface with exactly the three operations the app calls", () => {
    // An interface leaves no runtime trace, so the shape is checked through a
    // stub that only compiles if these three signatures are the whole contract.
    const stub: PayoutProvider = {
      prepareRoute: async () => route,
      getStatus: async () => [swap],
      listAssets: async () => [asset],
    };
    expect(Object.keys(stub)).toEqual(["prepareRoute", "getStatus", "listAssets"]);
  });
});
