import {
  type BaseUnitAmount,
  PAYMENT_STATES,
  type PaymentRow,
  type PaymentState,
  type ReconcileConfig,
  type ReconcileSnapshot,
  type SwapRow,
  baseUnitAmountSchema,
  normalizeSwapState,
  runAllRules,
} from "@till/core";
import { asc, desc, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { endpoints, payments, payoutRoutes, sellers, swaps } from "../db/schema.ts";
import type { Logger } from "../lib/logger.ts";
import { writeFindings } from "../services/discrepancies.ts";

/**
 * The reconcile loop (E9, LR-2, LR-3): the seam between the pure rules and the
 * database. It loads one seller's payments, swaps and the database clock into a
 * `ReconcileSnapshot`, calls `runAllRules`, and hands the findings to
 * `services/discrepancies.ts`. No rule logic lives here, and no I/O lives in a
 * rule (hard rule 6).
 *
 * Four decisions shape the file.
 *
 * - **The claim is per seller, and it is held across the write.** `FOR UPDATE OF
 *   sellers SKIP LOCKED` on the seller's own row is what makes two overlapping
 *   runs one run: the other pass skips that seller rather than waiting, so the
 *   assumption E8 recorded — "one run at a time per seller" — is supplied by the
 *   caller rather than hoped for. `writeFindings` runs inside *this* transaction,
 *   because a claim released before the write is a claim that proved nothing. The
 *   partial unique index on `(seller_id, dedupe_key) where resolved_at is null` is
 *   the second defence and stays there: it stops a duplicate row, it does not stop
 *   two passes deciding to close each other's work, and only the lock does that.
 * - **A pass has one clock, taken from the database.** `now()` is read in the same
 *   statement that claims the row (hard rule 12), and inside one transaction it is
 *   that transaction's start instant, so no two rules in one pass are aged against
 *   different times. Rows a concurrent writer commits after that instant are still
 *   visible, which can only make a window read *younger* — a finding arrives a pass
 *   later, never early.
 * - **A snapshot that cannot see everything is `partial`, and a partial pass opens
 *   findings and closes none.** Auto-resolution reads the findings list as
 *   exhaustive: a cause that is absent has cleared. That is only true if every row
 *   the seller has was in the snapshot, so the two ways it can fail — more rows than
 *   the read cap, and rows this build cannot interpret — both turn off auto-close
 *   instead of being truncated or defaulted. The alternative was to refuse the
 *   seller's pass outright, which makes one unreadable row an outage for that
 *   seller's whole reconciliation, and to auto-close on a partial list, which
 *   silently shuts live findings. A stale row lingering until a complete pass is the
 *   cheap half of that trade; a true finding nobody can see is not cheap.
 * - **A payment's payout mode comes from the route the payment carries, not from
 *   its endpoint.** PO-7's rule is that a payment keeps the terms it was opened
 *   under, and `endpoints.payout_mode` is a live, editable field (D9). Reading it
 *   for an old payment would let one edit silence `PAYMENT_NOT_SWEPT` on money
 *   already taken — the same drift D9 was written to prevent, arriving in the
 *   reader instead of the writer.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Rows read per side of one seller's snapshot, and so the point where a pass
 * becomes partial. 5 000 payments is a day of a busy demo seller and a few
 * hundred kilobytes per pass; the number is a bound, not a measured limit, and
 * exceeding it costs auto-close rather than correctness.
 */
export const DEFAULT_SNAPSHOT_MAX_ROWS = 5_000;

export type ReconcileDeps = {
  readonly db: Db;
  /** `env.SWEEP_WINDOW_SECONDS`, `env.STUCK_WINDOW_SECONDS`, `env.SHORTFALL_TOLERANCE_BPS`. */
  readonly config: ReconcileConfig;
  /**
   * Only these sellers (the poll loop's "after a status change" run). Absent means
   * every seller, which is what the interval pass asks for.
   */
  readonly sellerIds?: readonly string[];
  readonly snapshotMaxRows?: number;
  readonly log?: Logger;
};

/**
 * Every field is one this file's tests read. `sellers` counts the sellers this
 * pass claimed and wrote for, `skipped` the ones another run was holding, and
 * `partial` the claimed sellers whose snapshot could not see everything — so a
 * caller can tell "nothing was open" from "nothing was closed because we could not
 * tell".
 */
export type ReconcileResult = {
  readonly sellers: number;
  readonly skipped: number;
  readonly findings: number;
  readonly opened: number;
  readonly closed: number;
  readonly partial: number;
};

/** One seller's pass: either it was ours, or it was not. */
type SellerPass =
  | { readonly claimed: false }
  | {
      readonly claimed: true;
      readonly findings: number;
      readonly opened: number;
      readonly closed: number;
      readonly partial: boolean;
    };

/**
 * The same three-way distinction D6 draws at the provider boundary: `null` is
 * "the column is empty", which the rules read as an absent amount, and
 * `undefined` is "what is stored is not an integer of base units", which is not a
 * row these rules may judge. A `numeric(78,0)` column cannot hold `1.5`, so this
 * is a check on a row this build did not write rather than on arithmetic.
 */
function amountOf(value: string | null): BaseUnitAmount | null | undefined {
  if (value === null) {
    return null;
  }
  return baseUnitAmountSchema.safeParse(value).success ? BigInt(value) : undefined;
}

/**
 * `direct` paid the seller's own account, so no swap was ever owed for it, and
 * every other mode moved through a route. `mode_detail` is the payment's own
 * snapshot (D5 wrote it at verify time), so it answers before the endpoint does.
 */
function payoutModeOf(
  routeMode: string | null,
  endpointMode: string,
): { readonly mode: "direct" | "intents"; readonly fromEndpoint: boolean } {
  if (routeMode !== null) {
    return { mode: routeMode === "direct" ? "direct" : "intents", fromEndpoint: false };
  }
  // Only the word `direct` reads as direct, which is the rule
  // `services/endpoints.ts` already applies to the same column: a value neither
  // word describes did not come from Till's write path, and treating it as
  // `intents` keeps the swap rules looking rather than assuming the sale needed
  // no sweep.
  return { mode: endpointMode === "direct" ? "direct" : "intents", fromEndpoint: true };
}

/**
 * Every seller, oldest first. The interval pass asks for all of them, because the
 * causes that clear without a status change — a swap that arrived late, a payer that
 * finally settled — have no other way of being noticed.
 */
export async function allSellerIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: sellers.id })
    .from(sellers)
    .orderBy(asc(sellers.createdAt), asc(sellers.id));
  return rows.map((row) => row.id);
}

export async function reconcileSellers(deps: ReconcileDeps): Promise<ReconcileResult> {
  const { db, log } = deps;
  const maxRows = deps.snapshotMaxRows ?? DEFAULT_SNAPSHOT_MAX_ROWS;

  // The list is read outside the passes on purpose: it says who *might* need this
  // run, and the claim inside each pass says who was free. A seller created after
  // this read is picked up by the next one.
  const targets =
    deps.sellerIds === undefined ? await allSellerIds(db) : [...new Set(deps.sellerIds)];

  const result = { sellers: 0, skipped: 0, findings: 0, opened: 0, closed: 0, partial: 0 };
  for (const sellerId of targets) {
    const pass = await reconcileOne(db, sellerId, deps.config, maxRows, log);
    if (!pass.claimed) {
      result.skipped += 1;
      continue;
    }
    result.sellers += 1;
    result.findings += pass.findings;
    result.opened += pass.opened;
    result.closed += pass.closed;
    if (pass.partial) {
      result.partial += 1;
    }
  }
  return result;
}

/**
 * One seller, one transaction: claim, read, judge, write. A seller another pass
 * holds is skipped, and a seller nobody holds is not touched by anyone else until
 * this transaction ends — which is what makes `runAllRules`' output safe to treat
 * as the whole story for auto-resolution.
 */
async function reconcileOne(
  db: Db,
  sellerId: string,
  config: ReconcileConfig,
  maxRows: number,
  log?: Logger,
): Promise<SellerPass> {
  return db.transaction(async (tx) => {
    // The clock rides on the claim so one pass cannot hold a lock and then ask the
    // database what time it is, which would age one rule against a later instant
    // than another. Inside one transaction `now()` is that transaction's start
    // instant, whichever row it is read from.
    //
    // The cast is not decoration: a bare `sql<Date>` of an expression arrives from
    // the driver as a *string*, because the timestamp parser only ever sees a
    // column's own type, and `now()` in a select list is an expression. Milliseconds
    // as `float8` is the one shape the driver hands over as a number, so the Date is
    // built here rather than hoped for.
    const held: readonly { id: string; clockMs: number }[] = await tx
      .select({
        id: sellers.id,
        clockMs: sql<number>`(extract(epoch from now()) * 1000)::float8`,
      })
      .from(sellers)
      .where(eq(sellers.id, sellerId))
      .limit(1)
      .for("update", { of: sellers, skipLocked: true });

    const claimed = held[0];
    if (claimed === undefined) {
      log?.warn(
        { code: "reconcile_seller_locked", sellerId },
        "another reconcile pass holds this seller, so the seller was skipped and not queued (E9)",
      );
      return { claimed: false };
    }

    const read = await readSnapshot(tx, sellerId, new Date(claimed.clockMs), config, maxRows);
    const findings = runAllRules(read.snapshot);
    const written = await writeFindings(tx, sellerId, findings, { autoClose: !read.partial });

    // PO-7's caveat, said out loud. A payment with no route row is judged by the
    // endpoint's *live* mode, which D9 lets an owner edit after the money was taken,
    // so the answer is weaker than the one the route snapshot gives. It is still an
    // answer the seller's data supports, which is why this is a warning about
    // provenance and not a partial snapshot: nothing was hidden from the pass.
    if (read.detail.paymentsWithoutRoute > 0) {
      log?.warn(
        {
          code: "reconcile_route_snapshot_missing",
          sellerId,
          payments: read.detail.paymentsWithoutRoute,
        },
        "some payments carry no route, so their payout mode was read from the editable endpoint field (PO-7)",
      );
    }

    if (read.partial) {
      log?.warn(
        {
          code: "reconcile_snapshot_partial",
          sellerId,
          payments: read.snapshot.payments.length,
          swaps: read.snapshot.swaps.length,
          ...read.detail,
          findings: findings.length,
          closed: 0,
        },
        "this pass could not see every row, so it opened findings and closed none (LR-5)",
      );
    } else if (written.opened + written.closed > 0) {
      log?.info(
        {
          code: "reconcile_pass",
          sellerId,
          findings: findings.length,
          opened: written.opened,
          closed: written.closed,
        },
        "reconciliation changed the seller's open discrepancies",
      );
    }

    return {
      claimed: true,
      findings: findings.length,
      opened: written.opened,
      closed: written.closed,
      partial: read.partial,
    };
  });
}

/** What a pass could not see, and how many rows the seeing was done over. */
type SnapshotDetail = {
  readonly paymentsTruncated: number;
  readonly swapsTruncated: number;
  readonly unusablePayments: number;
  readonly unusableSwaps: number;
  /** Payments judged by the endpoint's live mode rather than their own route (PO-7). */
  readonly paymentsWithoutRoute: number;
};

type SnapshotRead = {
  readonly snapshot: ReconcileSnapshot;
  /** Something this pass could not see, so its findings list is not exhaustive. */
  readonly partial: boolean;
  /** What made it partial, for the log line and nothing else. */
  readonly detail: SnapshotDetail;
};

/**
 * The seller's rows, as the rules ask for them.
 *
 * Newest money first when the read has to stop: a capped pass that kept the
 * *oldest* rows would report a seller's history and never its live problems, and
 * the whole point of the loop is to be current. The order is complete enough to be
 * reproducible — `created_at` with the id as tiebreaker, never the id alone,
 * because a UUID v7 prefix is an insertion hint and not a timestamp (hard rule 12).
 */
async function readSnapshot(
  tx: Tx,
  sellerId: string,
  clock: Date,
  config: ReconcileConfig,
  maxRows: number,
): Promise<SnapshotRead> {
  const paymentRows = await tx
    .select({
      id: payments.id,
      endpointId: payments.endpointId,
      routeId: payments.routeId,
      amount: payments.amount,
      state: payments.state,
      nearTxHash: payments.nearTxHash,
      settledAt: payments.settledAt,
      verifiedAt: payments.verifiedAt,
      routeMode: payoutRoutes.modeDetail,
      endpointMode: endpoints.payoutMode,
    })
    .from(payments)
    .innerJoin(endpoints, eq(endpoints.id, payments.endpointId))
    // Left, because `payments.route_id` is nullable and the endpoint's mode is the
    // fallback answer; an inner join here would drop exactly the rows that need one.
    .leftJoin(payoutRoutes, eq(payoutRoutes.id, payments.routeId))
    .where(eq(endpoints.sellerId, sellerId))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(maxRows + 1);

  const swapRows = await tx
    .select({
      id: swaps.id,
      routeId: swaps.routeId,
      paymentId: swaps.paymentId,
      state: swaps.state,
      amountIn: swaps.amountIn,
      amountOut: swaps.amountOut,
      refundedAmount: swaps.refundedAmount,
      originTxHash: swaps.originTxHash,
      lastPolledAt: swaps.lastPolledAt,
      providerUpdatedAt: swaps.providerUpdatedAt,
      terminalAt: swaps.terminalAt,
    })
    .from(swaps)
    .innerJoin(payoutRoutes, eq(payoutRoutes.id, swaps.routeId))
    .where(eq(payoutRoutes.sellerId, sellerId))
    .orderBy(desc(swaps.createdAt), desc(swaps.id))
    .limit(maxRows + 1);

  const paymentsTruncated = paymentRows.length > maxRows;
  const swapsTruncated = swapRows.length > maxRows;

  const snapshotPayments: PaymentRow[] = [];
  let unusablePayments = 0;
  let paymentsWithoutRoute = 0;
  for (const row of paymentRows.slice(0, maxRows)) {
    const amount = amountOf(row.amount);
    // `verifiedAt` is the age every window rule measures from, and the column is
    // nullable while the rule's row is not. A payment with no verified time has no
    // age, and defaulting it to the clock would make it permanently young — silent
    // by arithmetic rather than by decision.
    if (amount === null || amount === undefined || row.verifiedAt === null) {
      unusablePayments += 1;
      continue;
    }
    if (!isPaymentState(row.state)) {
      unusablePayments += 1;
      continue;
    }
    const mode = payoutModeOf(row.routeMode, row.endpointMode);
    if (mode.fromEndpoint) {
      paymentsWithoutRoute += 1;
    }
    snapshotPayments.push({
      id: row.id,
      endpointId: row.endpointId,
      routeId: row.routeId,
      amount,
      state: row.state,
      nearTxHash: row.nearTxHash,
      settledAt: row.settledAt,
      verifiedAt: row.verifiedAt,
      payoutMode: mode.mode,
    });
  }

  const snapshotSwaps: SwapRow[] = [];
  let unusableSwaps = 0;
  for (const row of swapRows.slice(0, maxRows)) {
    const amountIn = amountOf(row.amountIn);
    const amountOut = amountOf(row.amountOut);
    const refundedAmount = amountOf(row.refundedAmount);
    if (amountIn === undefined || amountOut === undefined || refundedAmount === undefined) {
      unusableSwaps += 1;
      continue;
    }
    snapshotSwaps.push({
      id: row.id,
      routeId: row.routeId,
      paymentId: row.paymentId,
      // D6 stores the mapped value, and re-mapping here means a status some other
      // writer left in the column is read by the same table of meanings rather than
      // as a state this build never promised anything about.
      state: normalizeSwapState(row.state),
      amountIn,
      amountOut,
      refundedAmount,
      originTxHash: row.originTxHash,
      lastPolledAt: row.lastPolledAt,
      providerUpdatedAt: row.providerUpdatedAt,
      terminalAt: row.terminalAt,
    });
  }

  const partial = paymentsTruncated || swapsTruncated || unusablePayments > 0 || unusableSwaps > 0;

  return {
    snapshot: { sellerId, now: clock, payments: snapshotPayments, swaps: snapshotSwaps, config },
    partial,
    detail: {
      paymentsTruncated: paymentsTruncated ? 1 : 0,
      swapsTruncated: swapsTruncated ? 1 : 0,
      unusablePayments,
      unusableSwaps,
      paymentsWithoutRoute,
    },
  };
}

/**
 * A payment state the state machine does not list is not a payment these rules can
 * judge: every payment rule asks by equality, so an unknown word matches nothing
 * and would read as "no finding here" — which is the one answer a reader cannot
 * tell apart from a cleared cause.
 */
function isPaymentState(value: string): value is PaymentState {
  return (PAYMENT_STATES as readonly string[]).includes(value);
}
