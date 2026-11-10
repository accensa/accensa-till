import { x402NetworkSchema } from "@till/core";
import { z } from "zod";

/**
 * Every environment variable is validated here and the process refuses to boot
 * on a bad value (A4, ARCHITECTURE.md hard rule 11). Defaults are deliberately
 * the safe ones: mock payouts, testnet, no relayer key required.
 *
 * Never add a real secret to this file or to `.env.example`; see AGENTS.md
 * "Money and secrets safety".
 */

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

/**
 * A number here is reported by key name with no value echoed, which is what
 * `loadEnv`'s contract says and what throwing from a transform used to break: a
 * bad `PORT` produced `expected a positive integer, got abc` with no key in it.
 * `ctx.addIssue` keeps the path, so the names come from the schema (A4, G6).
 */
const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected a positive integer" });
        return z.NEVER;
      }
      return parsed;
    });

/** Basis points in a whole amount: a tolerance this wide tolerates everything. */
const FULL_TOLERANCE_BPS = 10_000;

/**
 * Zero means "any shortfall at all is a shortfall", the strictest reading, so it
 * is allowed; 10000 would leave `payout-shortfall` unable to ever fire, so it is
 * not (G6 F4). `isShortfall` refuses the same range, so a config that got past
 * here cannot disable the rule either.
 */
const toleranceBps = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed >= FULL_TOLERANCE_BPS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected basis points from 0 to ${FULL_TOLERANCE_BPS - 1}`,
        });
        return z.NEVER;
      }
      return parsed;
    });

/**
 * A money or gas amount in base units. Positive only, because both users are
 * floors: `MIN_PRICE_BASE_UNITS=-1` used to boot and turn the price floor into a
 * check that passes anything, and a negative gas cap is one no delegate can meet
 * (G6 F1, PO-2).
 */
const baseUnits = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine((value) => /^(?:0*[1-9]\d*)$/.test(value), "must be a positive base-units integer")
    .transform((value) => BigInt(value));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: positiveInt(3000),
    DATABASE_URL: z.string().min(1),

    NEAR_NETWORK: x402NetworkSchema.default("near:testnet"),
    NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
    /** Never logged, never returned, never committed. A10 records account ids only. */
    RELAYER_ACCOUNT_ID: z.string().min(3).default("relayer.testnet"),
    /**
     * Optional, and an empty value is read as absent so a copied `.env.example`
     * boots. When present it must carry the curve prefix the key parser expects
     * (`ed25519:` or `secp256k1:`), because `x402/near.ts` asserts that shape to the
     * library and the library only discovers a malformed key when it signs — after
     * the payer has been served. A bad key must cost a boot, not a payment (A4).
     */
    RELAYER_SECRET_KEY: z
      .string()
      .optional()
      .refine(
        (value) =>
          value === undefined ||
          value === "" ||
          /^(?:ed25519|secp256k1):[0-9A-Za-z+/=]+$/.test(value),
        "expected a base64 secret key prefixed ed25519: or secp256k1:",
      )
      .transform((value) => (value === undefined || value === "" ? undefined : value)),

    PAYOUT_PROVIDER: z.enum(["mock", "oneclick"]).default("mock"),
    // S5 (docs/spikes/S5.md): the OpenAPI `servers.url` of the 1Click Swap API.
    // Unreachable from this host (HTTP 521), so S4 re-confirms it before D3.
    ONECLICK_BASE_URL: z.string().url().default("https://1click.chaindefuser.com"),
    /** Optional: Q-006 says no key is required, and the fee is higher without one. */
    ONECLICK_JWT: z.string().min(1).optional(),

    SESSION_SECRET: z.string().min(32),
    GATEWAY_PUBLIC_URL: z.string().url(),

    UPSTREAM_TIMEOUT_MS: positiveInt(15_000),
    /** GW-8 response size cap, counted in bytes actually read, not content-length. */
    UPSTREAM_MAX_BYTES: positiveInt(1_048_576),
    AUTHORIZATION_EXPIRY_MARGIN_MS: positiveInt(30_000),
    /**
     * Units are NEAR gas, not yoctoNEAR: the facilitator rejects a payment when the
     * delegate's `ft_transfer` gas exceeds it. That call asks for 3e13 gas, so a
     * smaller cap silently refuses every settlement, not just expensive ones.
     */
    MAX_SPONSORED_GAS: baseUnits("30000000000000"),
    /**
     * GW-10's global sponsored-gas budget, in the same NEAR-gas units as
     * MAX_SPONSORED_GAS. One process reserves one MAX_SPONSORED_GAS per settlement
     * it attempts, so the default is 1,000 settlements at the per-delegate cap. The
     * reservation is never released (limits.ts says why), and the counter resets on
     * restart -- this bounds a process, not a deployment.
     */
    SPONSORED_GAS_BUDGET: baseUnits("30000000000000000"),
    /**
     * GW-10's in-memory request limiter: every `GET /r/:slug` in one process counts
     * against a fixed window, paid or not, because the row lookup and the proxy are
     * the work being bounded. 600 a minute is a burst allowance for one demo host,
     * not a measured production number.
     */
    RATE_LIMIT_REQUESTS: positiveInt(600),
    RATE_LIMIT_WINDOW_MS: positiveInt(60_000),
    /**
     * The floor D4's creation check enforces (PO-2). It is a **configured** value,
     * not a measured one: S7 owns the real minimum-deposit and fee numbers, and
     * it is blocked on a real quote. 0.01 (10000 base units) is the placeholder
     * the check runs with, named as such rather than dressed up as a spike result.
     */
    MIN_PRICE_BASE_UNITS: baseUnits("10000"),

    /**
     * UI-5's balance ceiling: below this the header warns that sponsored gas may
     * stop. YoctoNEAR, so the comparison against the chain's own `amount` is one
     * `bigint` against another. 1 NEAR is not a measured number — a settle costs
     * the facilitator one `ft_transfer` of gas, and the relayer's own balance was
     * unreadable until A10 names an account — so it is a stated default rather
     * than an observation, the same way MIN_PRICE_BASE_UNITS is.
     */
    RELAYER_BALANCE_ALERT_BASE_UNITS: baseUnits("1000000000000000000000000"),

    POLL_INTERVAL_SECONDS: positiveInt(20),
    /**
     * D6's retry ceiling. A provider call that throws pushes each row it was asking
     * about onto `POLL_INTERVAL_SECONDS * 2 ** attempts`, capped here, so a provider
     * that is down is asked about less while it is down rather than more.
     */
    POLL_MAX_BACKOFF_SECONDS: positiveInt(900),
    RECONCILE_INTERVAL_SECONDS: positiveInt(60),
    /**
     * E9's `PAYMENT_NOT_SWEPT` window: a settled `intents` payment with no swap
     * that carries its hash after this is a finding. C11 deleted this knob because
     * nothing read it; E9 is the reader, and ARCHITECTURE 7 asks for the sweep
     * delay to come from the environment rather than from a rule.
     */
    SWEEP_WINDOW_SECONDS: positiveInt(300),
    STUCK_WINDOW_SECONDS: positiveInt(900),
    SHORTFALL_TOLERANCE_BPS: toleranceBps(50),

    /** GW-8 relaxes only for local development; production is https-only. */
    ALLOW_INSECURE_UPSTREAM: booleanish.default("false"),
  })
  .superRefine((value, ctx) => {
    // A budget below one settlement's reservation fits nothing, so every paid
    // request would 429 with the cap "working". Boot is the cheapest place to say
    // that a budget is the wrong shape rather than leave it to the first buyer.
    if (value.SPONSORED_GAS_BUDGET < value.MAX_SPONSORED_GAS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SPONSORED_GAS_BUDGET"],
        message: "must be at least MAX_SPONSORED_GAS, or no settlement fits",
      });
    }
    // D6's ceiling is a ceiling, so it has to sit at or above the interval it is
    // meant to stretch. A smaller value makes a failing swap poll *more often* than
    // a healthy one, which is the opposite of what a provider outage needs.
    if (value.POLL_MAX_BACKOFF_SECONDS < value.POLL_INTERVAL_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["POLL_MAX_BACKOFF_SECONDS"],
        message: "must be at least POLL_INTERVAL_SECONDS, or backoff would poll faster than health",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Fail fast with the offending key names and nothing else. Values are never
 * echoed, because RELAYER_SECRET_KEY and ONECLICK_JWT live in this object.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((issue) => issue.path.join(".")).sort();
    throw new Error(`invalid environment, missing or malformed: ${keys.join(", ")}`);
  }
  return parsed.data;
}
