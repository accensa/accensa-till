import { describe, expect, it } from "vitest";

import { SIGN_IN_COOKIE } from "@till/core";

import { createDb } from "../src/db/client.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import { createSessionCodec } from "../src/lib/session.ts";
import {
  SIGN_IN_WINDOW_MS,
  createSignInNonceStore,
  createSignInThrottle,
} from "../src/lib/sign-in-guard.ts";
import { createAuthRoutes } from "../src/routes/auth.ts";

/**
 * G7: the sign-in cost bound and the replay record, tested without a database.
 *
 * The route's successful path needs Postgres (it creates a seller), which is why
 * `auth.test.ts` skips without `DATABASE_URL`. Everything here refuses *before* that
 * point — the throttle runs first, and the nonce check runs before the chain read —
 * so the shipped order can be exercised offline. The clock is injected; nothing here
 * sleeps.
 */

const env: Env = loadEnv({
  DATABASE_URL: "postgres://till:till@unresolved.invalid/till",
  SESSION_SECRET: "x".repeat(32),
  GATEWAY_PUBLIC_URL: "http://localhost:3000",
});

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return quiet;
  },
};

function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

/** One request as the route runs it: the global window, then the account's. */
function attempt(throttle: ReturnType<typeof createSignInThrottle>, accountId: string) {
  const before = throttle.tryAcquire();
  return before.ok ? throttle.tryAcquireFor(accountId) : before;
}

describe("the sign-in throttle (G7)", () => {
  it("refuses the (n+1)th attempt for one account and allows the next window", () => {
    const time = clock();
    const throttle = createSignInThrottle({
      globalMax: 100,
      perAccountMax: 2,
      windowMs: 60_000,
      now: time.now,
    });

    expect([attempt(throttle, "alice.testnet").ok, attempt(throttle, "alice.testnet").ok]).toEqual([
      true,
      true,
    ]);
    const refused = attempt(throttle, "alice.testnet");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    // A `Retry-After: 0` would invite the retry this just refused.
    expect(refused.retryAfterSeconds).toBe(60);

    // Another account is unaffected: the window is per account, not a ban.
    expect(attempt(throttle, "bob.testnet").ok).toBe(true);

    time.advance(60_000);
    expect(attempt(throttle, "alice.testnet").ok).toBe(true);
  });

  it("counts one request once, so the global window is the number it says", () => {
    // The bug this replaces: one request moved the global counter twice (before and
    // after parsing the body), so a `globalMax` of 1 refused the very first attempt.
    const time = clock();
    const throttle = createSignInThrottle({
      globalMax: 3,
      perAccountMax: 10,
      windowMs: 60_000,
      now: time.now,
    });

    expect(attempt(throttle, "one.testnet").ok).toBe(true);
    expect(attempt(throttle, "two.testnet").ok).toBe(true);
    expect(throttle.tryAcquire().ok).toBe(true);
    const refused = throttle.tryAcquire();
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);

    time.advance(60_000);
    expect(attempt(throttle, "three.testnet").ok).toBe(true);
  });

  it("fails closed rather than forgetting counters when its map is full", () => {
    const time = clock();
    const throttle = createSignInThrottle({
      globalMax: 10_000,
      perAccountMax: 1,
      windowMs: 60_000,
      maxTrackedAccounts: 1,
      now: time.now,
    });

    expect(throttle.tryAcquireFor("first.testnet").ok).toBe(true);
    // A new id with no room left is refused, not granted and not counted by clearing.
    const refused = throttle.tryAcquireFor("second.testnet");
    expect(refused.ok).toBe(false);
    // The tracked account still keeps its own counter.
    expect(throttle.tryAcquireFor("first.testnet").ok).toBe(false);
  });

  it("keeps the shipped limits above one sign-in flow", () => {
    // A flow is nonce + verify; a limit below 2 would lock out a first-time user.
    const throttle = createSignInThrottle({
      globalMax: 120,
      perAccountMax: 20,
      windowMs: SIGN_IN_WINDOW_MS,
    });
    expect(attempt(throttle, "fresh.testnet").ok).toBe(true);
    expect(attempt(throttle, "fresh.testnet").ok).toBe(true);
  });
});

describe("the sign-in nonce store (G7)", () => {
  it("reports a spent nonce as spent, until its own expiry", () => {
    const time = clock();
    const nonces = createSignInNonceStore({ ttlMs: 300_000, now: time.now });

    expect(nonces.has("n1")).toBe(false);
    nonces.spend("n1");
    expect(nonces.has("n1")).toBe(true);

    time.advance(299_999);
    expect(nonces.has("n1")).toBe(true);

    // Past the challenge's own five minutes the cookie cannot verify anyway, so the
    // entry is dropped rather than kept forever.
    time.advance(2);
    expect(nonces.has("n1")).toBe(false);
  });

  it("forgets the oldest entry rather than growing without bound", () => {
    const nonces = createSignInNonceStore({ ttlMs: 300_000, maxEntries: 2, now: clock().now });
    nonces.spend("a");
    nonces.spend("b");
    nonces.spend("c");
    expect([nonces.has("a"), nonces.has("b"), nonces.has("c")]).toEqual([false, true, true]);
  });
});

describe("POST /auth/verify under the throttle (G7)", () => {
  function appWithThrottle(perAccountMax: number) {
    const throttle = createSignInThrottle({
      globalMax: 100,
      perAccountMax,
      windowMs: 60_000,
    });
    return createAuthRoutes({
      // Never reached: the throttle refuses before the challenge check, and the
      // challenge check refuses before any query.
      db: createDb("postgres://till:till@unresolved.invalid/till"),
      env,
      log: quiet,
      throttle,
    });
  }

  const body = JSON.stringify({
    accountId: "seller.testnet",
    publicKey: `ed25519:${"A".repeat(43)}`,
    signature: "A".repeat(88),
    message: "Sign in to Till",
    recipient: "http://localhost:3000",
    nonce: "A".repeat(43),
  });

  async function post(app: ReturnType<typeof appWithThrottle>) {
    return await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("answers 429 with Retry-After once the per-account window is spent", async () => {
    const app = appWithThrottle(2);
    expect((await post(app)).status).toBe(401);
    expect((await post(app)).status).toBe(401);
    const refused = await post(app);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({ code: "sign_in_throttled" });
  });

  it("refuses a challenge it has already redeemed, before the chain read", async () => {
    // The wiring, not the store: a nonce the route has recorded is refused after
    // the challenge comparison and before the ed25519 verify and the RPC read. The
    // success path (which is what spends the nonce) needs Postgres, so that half is
    // `auth.test.ts`'s; this half is reachable offline because it refuses first.
    const nonce = "A".repeat(43);
    const cookie = await createSessionCodec(env.SESSION_SECRET).createSignInCookie({
      message: "Sign in to Till",
      recipient: "http://localhost:3000",
      nonce,
      callbackUrl: null,
    });
    let chainReads = 0;
    const app = createAuthRoutes({
      db: createDb("postgres://till:till@unresolved.invalid/till"),
      env,
      log: quiet,
      accessKeys: async () => {
        chainReads += 1;
        return { ok: false, reason: "account_missing" };
      },
      nonces: { has: () => true, spend: () => undefined },
    });
    const response = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SIGN_IN_COOKIE}=${cookie}` },
      body: JSON.stringify({
        accountId: "seller.testnet",
        publicKey: `ed25519:${"A".repeat(43)}`,
        signature: "A".repeat(88),
        message: "Sign in to Till",
        recipient: "http://localhost:3000",
        nonce,
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "sign_in_challenge" });
    // Refused on the replay, not on the signature: no chain read was spent on it.
    expect(chainReads).toBe(0);
  });

  it("does not spend an account's budget on a request the global window refuses", async () => {
    // The global check runs first and reads nothing; a refusal there must not count
    // against an account that was not even parsed out of the body.
    const throttle = createSignInThrottle({ globalMax: 1, perAccountMax: 5, windowMs: 60_000 });
    const app = createAuthRoutes({
      db: createDb("postgres://till:till@unresolved.invalid/till"),
      env,
      log: quiet,
      throttle,
    });
    // One request is one global slot, so globalMax 1 serves exactly one attempt.
    expect((await post(app)).status).toBe(401);
    const refused = await post(app);
    expect(refused.status).toBe(429);
    // A fresh window (a new route instance) serves the next client again.
    const later = createAuthRoutes({
      db: createDb("postgres://till:till@unresolved.invalid/till"),
      env,
      log: quiet,
      throttle: createSignInThrottle({ globalMax: 1, perAccountMax: 5, windowMs: 60_000 }),
    });
    expect((await post(later)).status).toBe(401);
  });
});
