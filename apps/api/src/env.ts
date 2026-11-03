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

const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") {
        return fallback;
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`expected a positive integer, got ${value}`);
      }
      return parsed;
    });

const baseUnits = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .refine((value) => /^-?\d+$/.test(value), "must be an integer base-units string")
    .transform((value) => BigInt(value));

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: positiveInt(3000),
  DATABASE_URL: z.string().min(1),

  NEAR_NETWORK: z.string().default("near:testnet"),
  NEAR_RPC_URL: z.string().url().default("https://rpc.testnet.near.org"),
  /** Never logged, never returned, never committed. A10 records account ids only. */
  RELAYER_ACCOUNT_ID: z.string().min(3).default("relayer.testnet"),
  RELAYER_SECRET_KEY: z.string().min(1).optional(),

  PAYOUT_PROVIDER: z.enum(["mock", "oneclick"]).default("mock"),
  // S5 (docs/spikes/S5.md): the OpenAPI `servers.url` of the 1Click Swap API.
  // Unreachable from this host (HTTP 521), so S4 re-confirms it before D3.
  ONECLICK_BASE_URL: z.string().url().default("https://1click.chaindefuser.com"),
  /** Optional: Q-006 says no key is required, and the fee is higher without one. */
  ONECLICK_JWT: z.string().min(1).optional(),

  SESSION_SECRET: z.string().min(32),
  GATEWAY_PUBLIC_URL: z.string().url(),

  UPSTREAM_TIMEOUT_MS: positiveInt(15_000),
  AUTHORIZATION_EXPIRY_MARGIN_MS: positiveInt(30_000),
  /**
   * Units are NEAR gas, not yoctoNEAR: the facilitator rejects a payment when the
   * delegate's `ft_transfer` gas exceeds it. That call asks for 3e13 gas, so a
   * smaller cap silently refuses every settlement, not just expensive ones.
   */
  MAX_SPONSORED_GAS: baseUnits("30000000000000"),
  /** Set from spike S7 measurements, not guessed (PO-2). */
  MIN_PRICE_BASE_UNITS: baseUnits("10000"),

  POLL_INTERVAL_SECONDS: positiveInt(20),
  RECONCILE_INTERVAL_SECONDS: positiveInt(60),
  SWEEP_WINDOW_SECONDS: positiveInt(300),
  STUCK_WINDOW_SECONDS: positiveInt(900),
  SHORTFALL_TOLERANCE_BPS: positiveInt(50),

  /** GW-8 relaxes only for local development; production is https-only. */
  ALLOW_INSECURE_UPSTREAM: booleanish.default("false"),
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
