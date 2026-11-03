import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env.ts";

/**
 * Two defaults that were wrong in a way no boot would show: a 1Click base URL
 * belonging to a different product, and a sponsored-gas cap four orders of
 * magnitude below the gas the payment call itself requests. Both fail only on
 * the first real settlement, so they are pinned here instead.
 */

const required = {
  DATABASE_URL: "postgres://till:till@localhost:5432/till",
  SESSION_SECRET: "x".repeat(32),
  GATEWAY_PUBLIC_URL: "http://localhost:3000",
};

const FT_TRANSFER_GAS = 30_000_000_000_000n;

describe("environment defaults (S5, Q-006)", () => {
  it("caps sponsored gas at or above the gas an ft_transfer delegate asks for", () => {
    const env = loadEnv({ ...process.env, ...required });
    expect(env.MAX_SPONSORED_GAS >= FT_TRANSFER_GAS).toBe(true);
  });

  it("names the 1Click swap host, not a different vendor's gateway", () => {
    const env = loadEnv({ ...process.env, ...required });
    expect(env.ONECLICK_BASE_URL).toBe("https://1click.chaindefuser.com");
  });

  it("boots with no payout key and no relayer key, the compose shape (Q-006, DQ-1)", () => {
    const env = loadEnv({ ...process.env, ...required });
    expect(env.PAYOUT_PROVIDER).toBe("mock");
    expect(env.ONECLICK_JWT).toBeUndefined();
    expect(env.RELAYER_SECRET_KEY).toBeUndefined();
  });

  it("refuses to boot on a gas cap that is not an integer, so it cannot become a float", () => {
    expect(() => loadEnv({ ...process.env, ...required, MAX_SPONSORED_GAS: "1.5e13" })).toThrow(
      /MAX_SPONSORED_GAS/,
    );
  });
});
