import type { Env } from "../env.ts";
import { MockProvider, type MockScript } from "./mock/provider.ts";
import type { PayoutProvider } from "./provider.ts";

/**
 * Provider selection (D1, D2). `mock` is the default everywhere including tests;
 * `oneclick` requires ONECLICK_JWT and must never be used by a demo run the
 * human did not ask for (AGENTS.md "Money and secrets safety").
 *
 * The mock's script is a required argument, not something read from the
 * environment: whoever starts a flow says what each payout is going to do, so no
 * run can present an outcome nobody chose (DQ-2).
 */
export function createProvider(env: Env, scripts: readonly MockScript[]): PayoutProvider {
  if (env.PAYOUT_PROVIDER === "mock") {
    return new MockProvider(scripts);
  }
  // Blocked on S1, S2, S3 and S5, and on A11 for a key — see D3.
  throw new Error("not implemented (D3)");
}
