import { type PayerBlockDto, payerBlockDtoSchema } from "@till/core";
import { eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { endpoints, payerClears, payments } from "../db/schema.ts";

/**
 * C9 (GW-7): a strike is a payment served and not settled. The count is a query
 * over `payments`, not a column somebody remembers to increment -- the row is the
 * fact, and a counter beside it would be a second truth to keep honest.
 *
 * A block is per payer *and* per seller. The loss a strike measures is the seller's
 * (an answer went out and the money did not), so the seller whose endpoints served
 * is the seller who may lift it. A payer blocked here is not blocked at another
 * seller, and clearing here does not clear there.
 *
 * The clear is an appended watermark, not a rewrite of payment history: `payments`
 * is append-only evidence (PO-7) and a clear that deleted or re-stated a strike
 * would lose the record that the loss happened. A strike counts only if it is
 * newer than the seller's latest clear for this payer.
 */

export const STRIKE_WINDOW_HOURS = 24;
export const STRIKE_THRESHOLD = 2;

export type StrikeScope = {
  readonly payerAccountId: string;
  readonly sellerId: string;
};

export type StrikeState = {
  /** Strikes still inside the window and after the latest clear. */
  readonly count: number;
  readonly blocked: boolean;
};

/**
 * The strikes that still count, and whether they reach the threshold.
 *
 * Every time comparison reads the database clock: a process with a skewed clock
 * must not be able to move a strike out of the window (or a clear's watermark
 * past one). The watermark subquery uses `max`, so clearing twice is the same as
 * clearing once for the count, while both rows remain in `payer_clears` as the
 * audit trail.
 */
export async function strikesForPayer(db: Db, scope: StrikeScope): Promise<StrikeState> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(payments)
    .innerJoin(endpoints, eq(endpoints.id, payments.endpointId))
    .where(sql`
      ${payments.payerAccountId} = ${scope.payerAccountId}
      and ${endpoints.sellerId} = ${scope.sellerId}
      and ${payments.state} = 'served_unsettled'
      and ${payments.verifiedAt} is not null
      and ${payments.verifiedAt} > now() - make_interval(hours => ${STRIKE_WINDOW_HOURS}::int)
      and ${payments.verifiedAt} > coalesce(
        (select max(${payerClears.createdAt}) from ${payerClears}
          where ${payerClears.payerAccountId} = ${scope.payerAccountId}
            and ${payerClears.sellerId} = ${scope.sellerId}),
        '-infinity'::timestamptz
      )
    `);
  const count = row?.count ?? 0;
  return { count, blocked: count >= STRIKE_THRESHOLD };
}

export type ClearInput = StrikeScope & {
  readonly clearedBy: string;
  readonly note?: string | undefined;
};

/**
 * Lift the block by recording who lifted it, and when the database says it
 * happened. Deliberately not an update: there is nothing to update, and the prior
 * clears stay visible.
 */
export async function clearPayerBlock(db: Db, input: ClearInput): Promise<void> {
  await db.insert(payerClears).values({
    payerAccountId: input.payerAccountId,
    sellerId: input.sellerId,
    clearedBy: input.clearedBy,
    note: input.note ?? null,
  });
}

/**
 * Every payer this seller is currently holding (UI-4).
 *
 * This is `strikesForPayer`'s predicate, grouped: the same window, the same
 * threshold and the same per-payer watermark subquery, with only the literal payer
 * replaced by the row's own. Two functions that each decided when a strike counts
 * would be two rules, and the dashboard would show a payer as blocked while the
 * gateway was serving them — so the constants are imported, never restated, and
 * `discrepancies-route.test.ts` asserts the list and the rule agree payer by payer.
 *
 * Only payers at or above the threshold come back. One with a single strike is not a
 * thing the seller can act on, and a list of payers who are *not* blocked would read
 * as a list of problems.
 */
export async function listBlockedPayersForSeller(
  db: Db,
  sellerId: string,
): Promise<PayerBlockDto[]> {
  const rows = await db
    .select({
      payerAccountId: payments.payerAccountId,
      strikes: sql<number>`count(*)::int`,
      /**
       * Formatted by Postgres rather than handed over as a `Date`, because a plain
       * column comes back parsed while an aggregate comes back as text — `max` of a
       * `timestamptz` arrives as "2026-11-05 14:31:53.301428+00", which is not the
       * contract's ISO shape and not something to `new Date()` into submission.
       * Asking for the format is one line and cannot drift with the driver.
       */
      lastStrikeAt: sql<string | null>`to_char(max(${payments.verifiedAt}) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(payments)
    .innerJoin(endpoints, eq(endpoints.id, payments.endpointId))
    .where(sql`
      ${endpoints.sellerId} = ${sellerId}
      and ${payments.state} = 'served_unsettled'
      and ${payments.verifiedAt} is not null
      and ${payments.verifiedAt} > now() - make_interval(hours => ${STRIKE_WINDOW_HOURS}::int)
      and ${payments.verifiedAt} > coalesce(
        (select max(${payerClears.createdAt}) from ${payerClears}
          where ${payerClears.payerAccountId} = ${payments.payerAccountId}
            and ${payerClears.sellerId} = ${sellerId}),
        '-infinity'::timestamptz
      )
    `)
    .groupBy(payments.payerAccountId)
    .having(sql`count(*) >= ${STRIKE_THRESHOLD}`)
    .orderBy(sql`max(${payments.verifiedAt}) desc`);

  return rows.map((row) =>
    payerBlockDtoSchema.parse({
      payerAccountId: row.payerAccountId,
      strikes: row.strikes,
      blocked: row.strikes >= STRIKE_THRESHOLD,
      lastStrikeAt: row.lastStrikeAt,
    }),
  );
}
