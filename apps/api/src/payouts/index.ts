import type { Env } from "../env.ts";
import { MockProvider, type MockScript } from "./mock/provider.ts";
import { OneClickClient } from "./oneclick/client.ts";
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
  // D3's offline half: statuses and assets are read from the recorded contract,
  // while `prepareRoute` refuses, because S2/B8 have not decided the quote's
  // originAsset, depositType or slippageTolerance. So a real provider can poll but
  // cannot mint a deposit address, which is the live-money boundary (AGENTS.md).
  return new OneClickClient({
    baseUrl: env.ONECLICK_BASE_URL,
    jwt: env.ONECLICK_JWT,
    minCallGapMs: env.ONECLICK_MIN_CALL_GAP_MS,
    statusCallsPerPass: env.ONECLICK_STATUS_CALLS_PER_PASS,
  });
}
