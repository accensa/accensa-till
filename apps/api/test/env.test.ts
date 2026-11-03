import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env.ts";

/**
 * Two defaults that were wrong in a way no boot would show: a 1Click base URL
 * belonging to a different product, and a sponsored-gas cap four orders of
 * magnitude below the gas the payment call itself requests. Both fail only on
 * the first real settlement, so they are pinned here instead.
 *
 * The refusals below are the G6 half: a config value that is a number is also a
 * boundary, and `MIN_PRICE_BASE_UNITS=-1` and `SHORTFALL_TOLERANCE_BPS=20000`
 * both booted, each switching a guard off without saying so.
 */

const required = {
  DATABASE_URL: "postgres://till:till@localhost:5432/till",
  SESSION_SECRET: "x".repeat(32),
  GATEWAY_PUBLIC_URL: "http://localhost:3000",
};

const FT_TRANSFER_GAS = 30_000_000_000_000n;

/** Shaped like a real secret, so an error message that echoed it would be caught. */
// Zeros rather than a plausible key: this is a public repo and a secret-shaped
// literal in a test is a finding waiting to be filed against it.
const SECRET_IN_VALUE = "ed25519:000000000000000000000000000000000000000000000000000000000000";

function bootError(overrides: Record<string, string>): string {
  try {
    loadEnv({ ...process.env, ...required, ...overrides });
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "";
}

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

describe("environment refusals (G6 F1, F4)", () => {
  it("refuses a negative or zero money and gas config", () => {
    // Both are base-unit strings, and the old `/^-?\d+$/` accepted a minus, so
    // MIN_PRICE_BASE_UNITS=-1 booted and turned the price floor into a check that
    // passes anything, and MAX_SPONSORED_GAS=-1 a cap no delegate can meet.
    for (const [key, value] of [
      ["MIN_PRICE_BASE_UNITS", "-1"],
      ["MIN_PRICE_BASE_UNITS", "-1000000"],
      ["MIN_PRICE_BASE_UNITS", "0"],
      ["MAX_SPONSORED_GAS", "-30000000000000"],
      ["MAX_SPONSORED_GAS", "0"],
    ] as const) {
      expect(
        () => loadEnv({ ...process.env, ...required, [key]: value }),
        `${key}=${value}`,
      ).toThrow(new RegExp(key));
    }
  });

  it("refuses a shortfall tolerance wide enough to blind the rule", () => {
    // 10000 bps tolerates the whole amount, so `payout-shortfall` could never fire;
    // 20000 booted before this guard. And 0, the strictest setting `isShortfall`
    // documents as valid, was refused by the shared positive-integer parser.
    for (const value of ["10000", "10001", "20000", "-5", "1.5", "abc"]) {
      expect(
        () => loadEnv({ ...process.env, ...required, SHORTFALL_TOLERANCE_BPS: value }),
        value,
      ).toThrow(/SHORTFALL_TOLERANCE_BPS/);
    }
    expect(
      loadEnv({ ...process.env, ...required, SHORTFALL_TOLERANCE_BPS: "0" })
        .SHORTFALL_TOLERANCE_BPS,
    ).toBe(0);
    expect(
      loadEnv({ ...process.env, ...required, SHORTFALL_TOLERANCE_BPS: "9999" })
        .SHORTFALL_TOLERANCE_BPS,
    ).toBe(9999);
  });

  it("names the key that failed and never the value that failed it (A4)", () => {
    // `loadEnv` documents that values are not echoed, because this object holds
    // RELAYER_SECRET_KEY and ONECLICK_JWT. A transform that throws rather than
    // adding an issue loses the path, and the message was value-only instead.
    const money = bootError({ MIN_PRICE_BASE_UNITS: SECRET_IN_VALUE });
    expect(money).toContain("MIN_PRICE_BASE_UNITS");
    expect(money).not.toContain(SECRET_IN_VALUE);

    const port = bootError({ PORT: "not-a-port" });
    expect(port).toContain("PORT");
    expect(port).not.toContain("not-a-port");
  });
});
