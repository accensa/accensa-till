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
