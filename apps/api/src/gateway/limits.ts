/**
 * The two global bounds GW-10 asks for, in memory and per process (C13).
 *
 * Both are deliberately counters rather than distributed limits: ARCHITECTURE 8.1
 * asks for "global and per-payer sponsored-gas caps" and O11 calls the request
 * limiter "a global in-memory cap", so a deployment with N processes has N of
 * each. What a single process must not do is spend without a ceiling, and that is
 * what these two answer. They reset on restart, which is why neither is a billing
 * record -- the ledger is.
 */

/**
 * A fixed-window request counter. Fixed rather than sliding because the bound is
 * the process, not a payer: `maxRequests` in any window is the promise, and a
 * sliding window's extra memory and bookkeeping buys a smoother same-rate burst
 * that no requirement here asks for.
 */
export type RequestLimiter = {
  /** Count this request, or answer false when the window is already full. */
  tryAcquire(): boolean;
  /** Whole seconds until the window rolls over, never below 1 for a `Retry-After`. */
  retryAfterSeconds(): number;
};

/**
 * `now` is a seam so the window can be tested without a clock or a sleep. The
 * default is `Date.now`; production passes nothing.
 */
export function createRequestLimiter(options: {
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly now?: () => number;
}): RequestLimiter {
  const now = options.now ?? Date.now;
  let windowStart = now();
  let used = 0;

  return {
    tryAcquire() {
      const at = now();
      if (at - windowStart >= options.windowMs) {
        windowStart = at;
        used = 0;
      }
      if (used >= options.maxRequests) {
        return false;
      }
      used += 1;
      return true;
    },
    retryAfterSeconds() {
      const remaining = windowStart + options.windowMs - now();
      return Math.max(1, Math.ceil(remaining / 1000));
    },
  };
}

/**
 * The global sponsored-gas budget. Each settlement reserves `perSettlement`, the
 * cap the delegate is held to (`MAX_SPONSORED_GAS`), because the actual gas is not
 * known until the transaction lands. Reserving the cap is the conservative
 * reading: the budget can be exhausted early, never overrun.
 *
 * `reserve` is all-or-nothing and never returns its gas. A settlement that is
 * attempted may have spent it -- S6 could not establish that a failed delegate
 * costs nothing -- so the only honest reservation is one held until the process
 * restarts. That is also why the route calls `reserve` only where it is about to
 * settle: aborting a request before that point never makes the budget a lie.
 */
export type SponsoredGasBudget = {
  /** True while one more settlement still fits. A read, not a reservation. */
  hasCapacity(): boolean;
  /** Take one settlement's worth, or answer false when it would exceed the budget. */
  reserve(): boolean;
  readonly reserved: bigint;
  readonly budget: bigint;
  readonly perSettlement: bigint;
};

export function createSponsoredGasBudget(options: {
  readonly budget: bigint;
  readonly perSettlement: bigint;
}): SponsoredGasBudget {
  let reserved = 0n;

  return {
    hasCapacity: () => reserved + options.perSettlement <= options.budget,
    reserve: () => {
      if (reserved + options.perSettlement > options.budget) {
        return false;
      }
      reserved += options.perSettlement;
      return true;
    },
    get reserved() {
      return reserved;
    },
    budget: options.budget,
    perSettlement: options.perSettlement,
  };
}
