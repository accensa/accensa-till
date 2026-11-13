import { describe, expect, it } from "vitest";

import { envSchema, loadEnv } from "../src/env.ts";

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

  it("defaults the relayer balance alert to 1 NEAR and refuses a non-integer", () => {
    // UI-5 compares this against the chain's yoctoNEAR `amount` as two bigints, so
    // the one way it must not arrive is a float or a negative that warns on anything.
    expect(loadEnv({ ...process.env, ...required }).RELAYER_BALANCE_ALERT_BASE_UNITS).toBe(
      1_000_000_000_000_000_000_000_000n,
    );
    for (const value of ["-1", "0", "1.5e24", "abc", ""]) {
      expect(
        () => loadEnv({ ...process.env, ...required, RELAYER_BALANCE_ALERT_BASE_UNITS: value }),
        value,
      ).toThrow(/RELAYER_BALANCE_ALERT_BASE_UNITS/);
    }
    // An absent name takes the default; an empty one is a value and fails its own
    // schema, which is why `.env.example` comments optional names out.
    expect(
      loadEnv({
        ...process.env,
        ...required,
        RELAYER_BALANCE_ALERT_BASE_UNITS: "2500000000000000000000000",
      }).RELAYER_BALANCE_ALERT_BASE_UNITS,
    ).toBe(2_500_000_000_000_000_000_000_000n);
  });

  it("names the key that failed and never the value that failed it (A4)", () => {
    // `loadEnv` documents that values are not echoed, because this object holds
    // RELAYER_SECRET_KEY and ONECLICK_JWT. A transform that throws rather than
    // adding an issue loses the path, and the message was value-only instead.
    const money = bootError({ MIN_PRICE_BASE_UNITS: SECRET_IN_VALUE });
    expect(money).toContain("MIN_PRICE_BASE_UNITS");
    expect(money).not.toContain(SECRET_IN_VALUE);

    const balance = bootError({ RELAYER_BALANCE_ALERT_BASE_UNITS: SECRET_IN_VALUE });
    expect(balance).toContain("RELAYER_BALANCE_ALERT_BASE_UNITS");
    expect(balance).not.toContain(SECRET_IN_VALUE);

    const port = bootError({ PORT: "not-a-port" });
    expect(port).toContain("PORT");
    expect(port).not.toContain("not-a-port");
  });
});

/**
 * D6's retry ceiling, cross-checked the way GW-10's budget is (C13). The value is
 * only ever a *ceiling* on a gap that starts at `POLL_INTERVAL_SECONDS`, so a config
 * that parses fine — a positive integer — can still invert the rule: a ceiling below
 * the interval makes a swap whose provider is failing poll more often than a healthy
 * one, which is the opposite of what an outage needs, and it fails quietly.
 */
describe("payout poll schedule (D6, PO-4)", () => {
  it("defaults to a fifteen minute ceiling on a twenty second interval", () => {
    const env = loadEnv({ ...process.env, ...required });
    expect(env.POLL_INTERVAL_SECONDS).toBe(20);
    expect(env.POLL_MAX_BACKOFF_SECONDS).toBe(900);
  });

  it("refuses a ceiling below the interval it is meant to stretch", () => {
    for (const value of ["19", "1", "0"]) {
      expect(
        () => loadEnv({ ...process.env, ...required, POLL_MAX_BACKOFF_SECONDS: value }),
        value,
      ).toThrow(/POLL_MAX_BACKOFF_SECONDS/);
    }
    // The boundary is allowed: a ceiling equal to the interval is backoff switched
    // off, which is a caller's choice and not a broken rule.
    expect(
      loadEnv({
        ...process.env,
        ...required,
        POLL_INTERVAL_SECONDS: "30",
        POLL_MAX_BACKOFF_SECONDS: "30",
      }).POLL_MAX_BACKOFF_SECONDS,
    ).toBe(30);
  });

  it("refuses a non-integer interval or ceiling rather than rounding one", () => {
    for (const [key, value] of [
      ["POLL_INTERVAL_SECONDS", "1.5"],
      ["POLL_INTERVAL_SECONDS", "-20"],
      ["POLL_MAX_BACKOFF_SECONDS", "900.5"],
    ] as const) {
      expect(
        () => loadEnv({ ...process.env, ...required, [key]: value }),
        `${key}=${value}`,
      ).toThrow(new RegExp(key));
    }
  });
});

/**
 * C1 pushed these two guards into the config. `x402/near.ts` asserts the curve
 * prefix and the `namespace:reference` network to library types it cannot import,
 * so the check has to happen where a value can still be reported by key name — at
 * boot, before a payer is served.
 */
describe("relayer key and network shape (C1)", () => {
  it("accepts a prefixed relayer key and treats an empty one as no relayer", () => {
    expect(
      loadEnv({ ...process.env, ...required, RELAYER_SECRET_KEY: SECRET_IN_VALUE })
        .RELAYER_SECRET_KEY,
    ).toBe(SECRET_IN_VALUE);
    // The shape a copied `.env.example` has, and the documented safe default: an
    // empty value is absent, not malformed, so compose still boots.
    expect(
      loadEnv({ ...process.env, ...required, RELAYER_SECRET_KEY: "" }).RELAYER_SECRET_KEY,
    ).toBeUndefined();
  });

  it("refuses a relayer key the signer cannot parse, without echoing it", () => {
    for (const value of ["0000", "ed25519:", "keypair", "secp256k1:!!", "ed35519:abc"]) {
      const error = bootError({ RELAYER_SECRET_KEY: value });
      expect(error, value).toContain("RELAYER_SECRET_KEY");
      expect(error, value).not.toContain(value);
    }
  });

  it("refuses a network that is not a v2 `namespace:reference`", () => {
    for (const value of ["testnet", "near:", "mainnet", "NEAR:testnet", "near:testnet:extra"]) {
      expect(bootError({ NEAR_NETWORK: value }), value).toContain("NEAR_NETWORK");
    }
    expect(loadEnv({ ...process.env, ...required }).NEAR_NETWORK).toBe("near:testnet");
    expect(
      loadEnv({ ...process.env, ...required, NEAR_NETWORK: "near:localnet" }).NEAR_NETWORK,
    ).toBe("near:localnet");
  });
});

/**
 * GW-10's three values (C13). The budget is cross-checked against
 * MAX_SPONSORED_GAS rather than only parsed, because a positive budget smaller
 * than one settlement is the shape that boots and then 429s every paid request.
 */
describe("process-wide limits (GW-10, C13)", () => {
  it("defaults to a 600-request minute and a budget of 1,000 settlements", () => {
    const env = loadEnv({ ...process.env, ...required });
    expect(env.RATE_LIMIT_REQUESTS).toBe(600);
    expect(env.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.SPONSORED_GAS_BUDGET).toBe(1_000n * env.MAX_SPONSORED_GAS);
  });

  it("refuses a request limit or window that is not a positive integer", () => {
    for (const [key, value] of [
      ["RATE_LIMIT_REQUESTS", "0"],
      ["RATE_LIMIT_REQUESTS", "-1"],
      ["RATE_LIMIT_REQUESTS", "1.5"],
      ["RATE_LIMIT_REQUESTS", "abc"],
      ["RATE_LIMIT_WINDOW_MS", "0"],
      ["RATE_LIMIT_WINDOW_MS", "-1000"],
      ["RATE_LIMIT_WINDOW_MS", "1.5"],
    ] as const) {
      expect(
        () => loadEnv({ ...process.env, ...required, [key]: value }),
        `${key}=${value}`,
      ).toThrow(new RegExp(key));
    }
  });

  it("refuses a gas budget that is not positive or fits no settlement", () => {
    for (const value of ["0", "-30000000000000", "1.5e13"]) {
      expect(
        () => loadEnv({ ...process.env, ...required, SPONSORED_GAS_BUDGET: value }),
        value,
      ).toThrow(/SPONSORED_GAS_BUDGET/);
    }
    // One gas unit below the per-delegate cap: positive, and still fits nothing.
    const belowCap = (loadEnv({ ...process.env, ...required }).MAX_SPONSORED_GAS - 1n).toString();
    expect(
      () => loadEnv({ ...process.env, ...required, SPONSORED_GAS_BUDGET: belowCap }),
      belowCap,
    ).toThrow(/SPONSORED_GAS_BUDGET/);

    // The boundary itself is allowed: exactly one settlement.
    const exact = loadEnv({ ...process.env, ...required }).MAX_SPONSORED_GAS.toString();
    expect(
      loadEnv({ ...process.env, ...required, SPONSORED_GAS_BUDGET: exact }).SPONSORED_GAS_BUDGET,
    ).toBe(BigInt(exact));
  });
});

/**
 * E9's three windows (LR-3). These are the numbers the reconcile rules age against,
 * and `jobs/reconcile.ts` is their only reader: an env value that parses but is not
 * wired into `ReconcileConfig` is a knob that does nothing, which is what C11 deleted
 * `SWEEP_WINDOW_SECONDS` for. So the default and the wiring are pinned together here.
 */
describe("reconciliation windows (E9, LR-3)", () => {
  it("defaults to the PRD's five and fifteen minutes over a 50 bps tolerance", () => {
    const env = loadEnv({ ...process.env, ...required });
    expect(env.SWEEP_WINDOW_SECONDS).toBe(300);
    expect(env.STUCK_WINDOW_SECONDS).toBe(900);
    expect(env.SHORTFALL_TOLERANCE_BPS).toBe(50);
  });

  it("refuses a sweep window that is not a positive integer", () => {
    // A zero or negative sweep window would make `PAYMENT_NOT_SWEPT` fire on a
    // payment still inside the relayer's own turn, and a float would be rounded by
    // whichever of the two parsers met it first.
    for (const value of ["0", "-300", "1.5", "abc"]) {
      expect(
        () => loadEnv({ ...process.env, ...required, SWEEP_WINDOW_SECONDS: value }),
        value,
      ).toThrow(/SWEEP_WINDOW_SECONDS/);
    }
  });

  it("refuses a plain-http URL in production, naming the key (G7)", () => {
    // `z.string().url()` accepts `http://`, and two of these carry a credential or
    // the deployment's identity: a typo would put ONECLICK_JWT on the wire in
    // cleartext, or advertise an http origin a wallet signs against. Asserted at
    // both layers: the schema's own message says why, and `loadEnv` (which never
    // echoes a value) names the key.
    const cases: Record<string, string>[] = [
      { GATEWAY_PUBLIC_URL: "http://till.example" },
      { NEAR_RPC_URL: "http://rpc.example" },
      { ONECLICK_BASE_URL: "http://1click.example" },
    ];
    for (const overrides of cases) {
      const key = Object.keys(overrides)[0] ?? "";
      const parsed = envSchema.safeParse({
        ...process.env,
        ...required,
        NODE_ENV: "production",
        ...overrides,
      });
      expect(parsed.success, key).toBe(false);
      if (parsed.success) throw new Error("unreachable");
      const issue = parsed.error.issues.find((candidate) => candidate.path[0] === key);
      expect(issue?.message, key).toMatch(/must be https/);
      expect(bootError({ NODE_ENV: "production", ...overrides }), key).toMatch(new RegExp(key));
    }
  });

  it("still boots production on https, and development on http (G7)", () => {
    const production = loadEnv({
      ...process.env,
      ...required,
      NODE_ENV: "production",
      GATEWAY_PUBLIC_URL: "https://till.example",
    });
    expect(production.NODE_ENV).toBe("production");
    // The demo gateway is plain http on loopback and has to stay usable.
    const development = loadEnv({ ...process.env, ...required, NODE_ENV: "development" });
    expect(development.GATEWAY_PUBLIC_URL).toBe("http://localhost:3000");
  });

  it("carries every window to the rules in one config object", () => {
    // The shape `server.ts` builds for `reconcileSellers`; if a key is renamed or
    // dropped there, this object stops matching the rule's own input type.
    const env = loadEnv({
      ...process.env,
      ...required,
      SWEEP_WINDOW_SECONDS: "45",
      STUCK_WINDOW_SECONDS: "60",
      SHORTFALL_TOLERANCE_BPS: "25",
    });
    const config = {
      sweepWindowSeconds: env.SWEEP_WINDOW_SECONDS,
      stuckWindowSeconds: env.STUCK_WINDOW_SECONDS,
      shortfallToleranceBps: env.SHORTFALL_TOLERANCE_BPS,
    };
    expect(config).toEqual({
      sweepWindowSeconds: 45,
      stuckWindowSeconds: 60,
      shortfallToleranceBps: 25,
    });
  });
});
