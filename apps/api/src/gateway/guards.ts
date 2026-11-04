import type { PaymentRequirementsDto } from "@till/core";

/**
 * Pre-serve guards, evaluated in this order (C8, C9 -- GW-5, GW-6, GW-7):
 *   1. payer not blocked          two served_unsettled in 24h blocks them
 *   2. authorization expiry       must outlast UPSTREAM_TIMEOUT_MS + margin
 *   3. payer balance              must cover the price
 *   4. one in flight per payer    else 429 with Retry-After
 *   5. replay key                 abandoned retries, settled returns 409
 *
 * Every guard needs an accepting and a rejecting test (AGENTS.md "Testing"), and
 * guard 4 needs a concurrency test proving exactly one request proceeds.
 */

export type GuardRejection = {
  readonly status: 409 | 429 | 502;
  readonly reason: string;
  readonly retryAfterSeconds?: number;
};

/**
 * What a guard is asked to judge (C4 wires the call site, C8 fills the list).
 *
 * Everything here is a fact Till derived for itself rather than a fact the request
 * asserted: `payerAccountId` is the account the verified signature binds --
 * `x402/near.ts` refuses a payment whose payer it cannot name -- and
 * `requirements` is our own cached advertisement, never the buyer's `accepted`
 * field. That is what makes a guard a guard: a gate keyed on a payer-supplied
 * value is a gate the payer opens (GW-6, S6).
 */
export type GuardContext = {
  readonly endpointId: string;
  readonly payerAccountId: string;
  /** The advertised price in base units, taken from our requirements. */
  readonly priceAmount: bigint;
  readonly assetContract: string;
  readonly requirements: PaymentRequirementsDto;
};

export type GuardRunner = (context: GuardContext) => Promise<GuardRejection | null>;

/**
 * The default C4 runs with: no guard rejects.
 *
 * This is a placeholder for C8's policy and not a claim that any check passed, so
 * the route logs `guards_pending_c8` on every request that reaches it and C4's
 * roadmap row does not touch GW-5 or GW-6. The reason it is a function rather than
 * four inline `if`s is S6's own conclusion: the one-in-flight rule is *not*
 * something the chain gives us (two delegates from one payer both verify and both
 * submit, measured), so it needs code that can only live here -- a query over
 * `payments` keyed on the payer alone, with `Retry-After` -- and a guard that reads
 * the database has to be awaited. Wiring the awaited call site now is what keeps
 * hard rule 2's order (verify -> guards -> upstream -> settle) in one piece of code
 * instead of being retrofitted around a synchronous handler by C8.
 */
export const guardsPendingC8: GuardRunner = async () => null;
