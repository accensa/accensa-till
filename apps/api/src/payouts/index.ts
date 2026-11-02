import type { Env } from "../env.ts";
import type { PayoutProvider } from "./provider.ts";

/**
 * Provider selection (D1). `mock` is the default everywhere including tests;
 * `oneclick` requires ONECLICK_JWT and must never be used by a demo run the
 * human did not ask for (AGENTS.md "Money and secrets safety").
 */
export function createProvider(env: Env): PayoutProvider {
  if (env.PAYOUT_PROVIDER === "mock") {
    throw new Error("not implemented (D2)");
  }
  throw new Error("not implemented (D3)");
}
