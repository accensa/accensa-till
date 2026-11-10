import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { payoutRoutes, swaps } from "../db/schema.ts";

/**
 * The two facts the dashboard header shows (UI-5, F5): what is in the relayer
 * account that pays sponsored gas, and when the payout provider last answered.
 *
 * Neither read is allowed to fail into a number. `access-keys.ts` set the shape
 * for the chain half — a bare JSON-RPC `fetch` with the refusal carried as data,
 * so a test can stub the transport and the route never has to catch a throw to
 * find out what happened. Hard rule 1 keeps `@fastnear/*` in `x402/near.ts`, and
 * a header needs no signer and no transaction, only a public `view_account` of
 * the configured account.
 *
 * For the poll half the column to read is `swaps.last_polled_at`, which D6's loop
 * stamps **only on a pass that got an answer** — `jobs/poll-payouts.ts` says so
 * where it declines to write it after a provider call throws. That is exactly
 * UI-5's question, "when did the provider last talk to us", so `terminal_at`,
 * `next_poll_at` and `poll_attempts` are not consulted: the first says the row
 * finished, the other two say what is scheduled, and none of them says the
 * provider answered.
 *
 * Clock discipline (hard rule 12): the age is `now() - max(last_polled_at)`, both
 * sides read inside Postgres, so a header cannot age a swap against this process's
 * clock and agree with nothing else on screen.
 */

const READ_TIMEOUT_MS = 5_000;

/**
 * The same two wordings `access-keys.ts` recognises, and the same refusal to add
 * a third: "unreachable state" is a node that has not caught up, and calling that
 * a missing account would tell an operator to go and create a relayer they
 * already have.
 */
const MISSING_ACCOUNT = /does not exist|no such account|unknown account/i;

export type RelayerBalance =
  | { readonly ok: true; readonly amount: bigint }
  | { readonly ok: false; readonly reason: "account_missing" | "unreadable" };

export type RelayerBalanceReader = (accountId: string) => Promise<RelayerBalance>;

/**
 * A chain balance is an unsigned integer of yoctoNEAR delivered as a string.
 * Anything else — a JSON number, a float, a negative, an empty field — is refused
 * rather than coerced, because `Number(1e24)` is not 1e24 and a header that
 * rounded a relayer's balance could round it across the alert threshold.
 */
export function parseYoctoNear(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

function unavailable(detail: unknown): RelayerBalance {
  return typeof detail === "string" && MISSING_ACCOUNT.test(detail)
    ? { ok: false, reason: "account_missing" }
    : { ok: false, reason: "unreadable" };
}

export function createRelayerBalanceReader(options: {
  readonly rpcUrl: string;
  readonly timeoutMs?: number;
}): RelayerBalanceReader {
  return async (accountId: string) => {
    let body: unknown;
    try {
      const response = await fetch(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "till-header-status",
          method: "query",
          params: {
            request_type: "view_account",
            account_id: accountId,
            finality: "final",
          },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS),
      });
      // An HTTP-level failure carries no agreed meaning, so its body is not read
      // for a balance even when it happens to name a missing account.
      if (!response.ok) {
        return { ok: false, reason: "unreadable" };
      }
      body = await response.json();
    } catch {
      return { ok: false, reason: "unreadable" };
    }

    const parsed = body as {
      error?: unknown;
      result?: { amount?: unknown; error?: unknown };
    };
    if (parsed.error !== undefined) {
      return unavailable(JSON.stringify(parsed.error));
    }
    if (parsed.result === undefined) {
      return { ok: false, reason: "unreadable" };
    }
    if (parsed.result.error !== undefined) {
      return unavailable(JSON.stringify(parsed.result.error));
    }
    const amount = parseYoctoNear(parsed.result.amount);
    // A result that came back without a balance is not a zero balance: the second
    // one is a relayer that cannot pay for gas and the first is a read we do not trust.
    return amount === null ? { ok: false, reason: "unreadable" } : { ok: true, amount };
  };
}

export type SellerPoll = {
  readonly state: "no_swaps" | "never_polled" | "polled";
  readonly swaps: number;
  /** ISO-8601 UTC, formatted by Postgres (see `strikes.ts` for why not by the driver). */
  readonly lastPolledAt: string | null;
  readonly ageSeconds: number | null;
};

/**
 * The newest provider answer among this seller's swaps, and how old it is.
 *
 * The scope is the join `swaps -> payout_routes.seller_id`, which is how D6's own
 * claim query names a row's owner. It is access control, not a filter on the
 * answer: a seller's header must not be made fresh by another seller's poll, and
 * must not be made stale by one either.
 */
export async function readSellerPoll(db: Db, sellerId: string): Promise<SellerPoll> {
  const rows = await db
    .select({
      swaps: sql<number>`count(*)::int`,
      answered: sql<number>`count(${swaps.lastPolledAt})::int`,
      lastPolledAt: sql<string | null>`to_char(max(${swaps.lastPolledAt}) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      // `greatest` rather than the raw difference: a row whose stamp is ahead of
      // `now()` is a clock stepped backwards, and a negative age would be refused
      // by the contract and black out the header over it.
      ageSeconds: sql<
        number | null
      >`greatest(0, floor(extract(epoch from now() - max(${swaps.lastPolledAt}))))::int`,
    })
    .from(swaps)
    .innerJoin(payoutRoutes, eq(payoutRoutes.id, swaps.routeId))
    .where(eq(payoutRoutes.sellerId, sellerId));

  const row = rows[0];
  const total = row?.swaps ?? 0;
  if (total === 0) {
    return { state: "no_swaps", swaps: 0, lastPolledAt: null, ageSeconds: null };
  }
  // Rows exist and none has ever been answered. This is D6 not having run, or a
  // provider that has never replied, and it is not the same sentence as "you have
  // no payouts" — which is why the count is kept.
  if ((row?.answered ?? 0) === 0) {
    return { state: "never_polled", swaps: total, lastPolledAt: null, ageSeconds: null };
  }
  return {
    state: "polled",
    swaps: total,
    lastPolledAt: row?.lastPolledAt ?? null,
    ageSeconds: row?.ageSeconds ?? null,
  };
}
