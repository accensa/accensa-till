import { describe, expect, it } from "vitest";

import { createRequestLimiter, createSponsoredGasBudget } from "../src/gateway/limits.ts";

/** An injected clock, so a window can be crossed without a test that sleeps. */
function clock(start: number) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("request limiter (GW-10)", () => {
  it("counts requests in a fixed window and refuses past the cap", () => {
    const time = clock(1_000);
    const limiter = createRequestLimiter({ maxRequests: 2, windowMs: 1_000, now: time.now });

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    // A refusal is not a count: the window is still full, not fuller.
    expect(limiter.tryAcquire()).toBe(false);

    time.advance(1_000);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("rolls over at the window boundary, not a millisecond before", () => {
    const time = clock(0);
    const limiter = createRequestLimiter({ maxRequests: 1, windowMs: 60_000, now: time.now });
    expect(limiter.tryAcquire()).toBe(true);

    time.advance(59_999);
    expect(limiter.tryAcquire()).toBe(false);

    time.advance(1);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it("never answers a Retry-After below one second", () => {
    const time = clock(0);
    const limiter = createRequestLimiter({ maxRequests: 1, windowMs: 60_000, now: time.now });
    limiter.tryAcquire();

    expect(limiter.retryAfterSeconds()).toBe(60);
    time.advance(59_500);
    expect(limiter.retryAfterSeconds()).toBe(1);
    // Exactly at the boundary the window has not been re-read yet, and `0` would
    // be a header a client reads as "retry now".
    time.advance(500);
    expect(limiter.retryAfterSeconds()).toBe(1);
  });
});

describe("sponsored-gas budget (GW-10)", () => {
  it("reserves one settlement's cap at a time and refuses the one that would overrun", () => {
    const gas = createSponsoredGasBudget({ budget: 90n, perSettlement: 30n });

    expect(gas.hasCapacity()).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      expect(gas.reserve()).toBe(true);
    }
    expect(gas.reserved).toBe(90n);
    expect(gas.hasCapacity()).toBe(false);

    // The refusal leaves the budget where it was: a failed reservation is not gas
    // that was spent, and it must not creep the counter past the cap either.
    expect(gas.reserve()).toBe(false);
    expect(gas.reserved).toBe(90n);
  });

  it("treats hasCapacity as a read, not a reservation", () => {
    const gas = createSponsoredGasBudget({ budget: 30n, perSettlement: 30n });

    expect(gas.hasCapacity()).toBe(true);
    expect(gas.hasCapacity()).toBe(true);
    expect(gas.reserved).toBe(0n);

    expect(gas.reserve()).toBe(true);
    expect(gas.hasCapacity()).toBe(false);
  });

  it("allows an exact fit and refuses a budget that fits no settlement", () => {
    const exact = createSponsoredGasBudget({ budget: 30n, perSettlement: 30n });
    expect(exact.reserve()).toBe(true);
    expect(exact.reserved).toBe(30n);

    // env.ts refuses this at boot; the budget still has to behave, because a test
    // or a future caller can construct it directly.
    const none = createSponsoredGasBudget({ budget: 10n, perSettlement: 30n });
    expect(none.hasCapacity()).toBe(false);
    expect(none.reserve()).toBe(false);
    expect(none.reserved).toBe(0n);
  });
});
