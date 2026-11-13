/**
 * The two cheap defences around wallet sign-in (G7, F1).
 *
 * Both live here rather than in `routes/auth.ts` because both are pure state
 * machines over an injected clock, which is what lets them be tested offline — the
 * route itself needs a database to finish a successful sign-in, and a suite that
 * skipped with the database would leave these untested.
 *
 * **The throttle is a cost bound, not a ban.** `POST /auth/verify` reads
 * `view_access_key_list` from the RPC for every request that carries a valid
 * signature, and nothing before that point needs a database. Without a limit, one
 * loop against the endpoint spends the deployment's RPC quota and its CPU — the
 * endpoint is the only place a stranger reaches NEAR through our config. The global
 * window bounds the whole process (so a rotating set of account ids cannot dodge
 * it), and the per-account window bounds one account's own retries.
 *
 * **The nonce store is what makes a spent challenge spent.** A sign-in challenge is
 * a signed cookie holding a 32-byte nonce, and the wallet's signature covers that
 * nonce. Without a record of what has already been redeemed, a captured challenge
 * cookie plus its signature replays into a second session for the rest of the
 * cookie's five minutes. Hard rule 10 keeps this one process, so an in-memory set is
 * the whole store a deployment has; the entry is dropped at the challenge's own
 * expiry, and a restart empties it (which is the same moment every pending
 * challenge cookie still validates — the limitation is stated here rather than
 * hidden).
 */

export type SignInDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSeconds: number };

export type SignInThrottle = {
  /**
   * Count one request against the process-wide window. Called once per request, at
   * the top, before the body is read -- the point is that the refusal costs nothing.
   */
  tryAcquire(): SignInDecision;
  /**
   * Count one attempt against that account's own window. Deliberately does **not**
   * move the global counter: one request is one request, and counting it twice
   * would halve the advertised global limit and make a global max of 1 impossible.
   */
  tryAcquireFor(accountId: string): SignInDecision;
};

export type SignInThrottleOptions = {
  /** Attempts per window across the whole process. */
  readonly globalMax: number;
  /** Attempts per window for one account id. */
  readonly perAccountMax: number;
  readonly windowMs: number;
  /**
   * How many account ids the per-account windows may track. Reaching it is not a
   * reason to forget the counters (that would let an attacker reset their own by
   * filling the map), so the next unknown id is refused instead.
   */
  readonly maxTrackedAccounts?: number;
  /** Injected in tests so a window can roll over without sleeping. */
  readonly now?: () => number;
};

/** The shipped limits. One sign-in is two requests, so 20/min/account is 10 flows. */
export const SIGN_IN_GLOBAL_MAX = 120;
export const SIGN_IN_PER_ACCOUNT_MAX = 20;
export const SIGN_IN_WINDOW_MS = 60_000;

const DEFAULT_MAX_TRACKED_ACCOUNTS = 4_096;

/**
 * Fixed windows, for the reason `gateway/limits.ts` gives for its own: the promise
 * being made is "at most N in any window", and a fixed window keeps the bookkeeping
 * to one number per counter. A sliding window would smooth the same rate at the cost
 * of a timestamp per attempt, on a route that already fails closed.
 */
export function createSignInThrottle(options: SignInThrottleOptions): SignInThrottle {
  const now = options.now ?? Date.now;
  const maxTracked = options.maxTrackedAccounts ?? DEFAULT_MAX_TRACKED_ACCOUNTS;
  const windowSeconds = Math.max(1, Math.ceil(options.windowMs / 1000));

  let globalStart = now();
  let globalCount = 0;
  const accounts = new Map<string, { start: number; count: number }>();

  function retryAfterSeconds(start: number): number {
    // Never 0: a `Retry-After: 0` invites the retry the limit just refused.
    return Math.max(1, Math.ceil((start + options.windowMs - now()) / 1000));
  }

  function prune(nowMs: number): void {
    for (const [id, entry] of accounts) {
      if (nowMs - entry.start >= options.windowMs) {
        accounts.delete(id);
      }
    }
  }

  return {
    tryAcquire() {
      const at = now();
      if (at - globalStart >= options.windowMs) {
        globalStart = at;
        globalCount = 0;
      }
      if (globalCount >= options.globalMax) {
        return { ok: false, retryAfterSeconds: retryAfterSeconds(globalStart) };
      }
      globalCount += 1;
      return { ok: true };
    },

    tryAcquireFor(accountId) {
      const at = now();
      const entry = accounts.get(accountId);
      if (entry !== undefined) {
        if (at - entry.start >= options.windowMs) {
          accounts.set(accountId, { start: at, count: 1 });
          return { ok: true };
        }
        if (entry.count >= options.perAccountMax) {
          return { ok: false, retryAfterSeconds: retryAfterSeconds(entry.start) };
        }
        entry.count += 1;
        return { ok: true };
      }

      if (accounts.size >= maxTracked) {
        prune(at);
        if (accounts.size >= maxTracked) {
          // Fail closed rather than forget: a cleared map is a reset an attacker
          // controls. The window is short enough that this is a pause, not a ban.
          return { ok: false, retryAfterSeconds: windowSeconds };
        }
      }
      accounts.set(accountId, { start: at, count: 1 });
      return { ok: true };
    },
  };
}

export type SignInNonceStore = {
  /** Whether this nonce has already been redeemed (expired entries read as no). */
  has(nonce: string): boolean;
  /** Record it as redeemed. Called only after the signature and key checks passed. */
  spend(nonce: string): void;
};

export type SignInNonceStoreOptions = {
  /** The sign-in cookie's own lifetime: past it the challenge cannot verify anyway. */
  readonly ttlMs: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
};

const DEFAULT_MAX_NONCES = 10_000;

export function createSignInNonceStore(options: SignInNonceStoreOptions): SignInNonceStore {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_NONCES;
  const spent = new Map<string, number>();

  function prune(at: number): void {
    for (const [nonce, expiresAt] of spent) {
      if (expiresAt <= at) {
        spent.delete(nonce);
      }
    }
  }

  return {
    has(nonce) {
      const expiresAt = spent.get(nonce);
      if (expiresAt === undefined) {
        return false;
      }
      if (expiresAt <= now()) {
        spent.delete(nonce);
        return false;
      }
      return true;
    },
    spend(nonce) {
      const at = now();
      if (spent.size >= maxEntries) {
        prune(at);
        // Every entry left is inside its window and none can be forgotten without
        // re-opening a replay, so the oldest insertion goes: it is the nearest to
        // expiry, and the challenge it guards is the least likely to still be open.
        if (spent.size >= maxEntries) {
          const oldest = spent.keys().next();
          if (!oldest.done) {
            spent.delete(oldest.value);
          }
        }
      }
      spent.set(nonce, at + options.ttlMs);
    },
  };
}
