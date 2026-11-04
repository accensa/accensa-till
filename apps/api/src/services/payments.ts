import { sql } from "drizzle-orm";

import { type BaseUnitAmount, type PaymentState, assertPaymentTransition } from "@till/core";

import type { Db } from "../db/client.ts";
import { payments } from "../db/schema.ts";

/**
 * The only writer of the `payments` table (AGENTS.md hard rule 4, C3). Every move
 * goes through `assertPaymentTransition` from @till/core, so the state machine in
 * `packages/core/src/states.ts` is the single definition of what may happen to a
 * payment, and every timestamp is written by the database clock rather than a
 * process that may have a skewed one.
 *
 * GW-4 has one rule that cannot be expressed in a `WHERE` clause alone: the
 * unique `replay_key` is what makes a retried authorization safe, so inserting
 * must not be able to clobber the row a previous request already moved.
 */

export type PaymentRow = typeof payments.$inferSelect;

/**
 * The transaction handle `db.transaction` hands its callback, read off that
 * callback's own parameter so this file names no drizzle internals. A query
 * helper taking it is the difference between Guard 3 reading and writing in one
 * transaction and reading in a transaction it has already left.
 */
type DbOrTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type NewPayment = {
  readonly id: string;
  readonly endpointId: string;
  readonly routeId?: string | null;
  readonly payerAccountId: string;
  readonly amount: BaseUnitAmount;
  readonly assetContract: string;
  readonly replayKey: string;
  readonly delegateExpiresAt?: Date | null;
};

export type OpenResult =
  /** Fresh `verified` row, ours. */
  | { readonly kind: "created"; readonly payment: PaymentRow }
  /**
   * A row with this `replay_key` already exists, so this request is a replay.
   * The caller decides: only `abandoned` may be retried, and a settled or
   * served row answers 409 with the stored receipt (4.2 step 6, GW-4).
   */
  | { readonly kind: "existing"; readonly payment: PaymentRow }
  /**
   * The payer already has a `verified` payment inside the in-flight window, so
   * this authorization may not open a second one (Guard 3, GW-6, D14). The
   * blocking row travels with it: the route needs its id for the log and its
   * `verifiedAt` to compute an honest `Retry-After`.
   */
  | { readonly kind: "in_flight"; readonly blocking: PaymentRow };

/** Guard 3's claim, in whole seconds. Omit it and one payer may open many rows. */
export type InFlightClaim = {
  readonly windowSeconds: number;
};

export type AdvanceFields = {
  readonly nearTxHash?: string | null;
  readonly upstreamStatus?: number | null;
  readonly upstreamMs?: number | null;
};

/** Drizzle reads numeric(78,0) back as a string; base units are bigint at the edge. */
function toColumn(amount: BaseUnitAmount): string {
  return amount.toString();
}

async function byId(db: Db, paymentId: string): Promise<PaymentRow | null> {
  const [row] = await db.select().from(payments).where(sql`${payments.id} = ${paymentId}`).limit(1);
  return row ?? null;
}

/**
 * Insert the `verified` row for a payment that has passed verify and the guards.
 * `on conflict do nothing` plus a re-read is what makes two concurrent requests
 * with one authorization resolve to one row instead of one error (GW-4).
 *
 * With an `InFlightClaim` the insert is also Guard 3 (GW-6): the read for a
 * payer's open payment and the insert happen in one transaction behind an
 * advisory lock on the payer's account id, because S6 measured that two
 * delegates from one payer both pass `verify` and both settle. A guard that read
 * the table and then let the caller insert would be the same race with a `SELECT`
 * in front of it -- two requests both see "none" and both serve. The lock is what
 * makes the answer the one the next request cannot change, and it is per payer,
 * so one payer's traffic cannot serialise another's.
 */
export async function openPayment(
  db: Db,
  input: NewPayment,
  claim?: InFlightClaim,
): Promise<OpenResult> {
  return db.transaction(async (tx) => {
    if (claim !== undefined) {
      // hashtext() is int4 and can collide across payers; a collision costs one
      // payer a little waiting, never a second in-flight row.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.payerAccountId})::int)`);

      const blocking = await inFlightPayment(tx, input.payerAccountId, claim.windowSeconds);
      if (blocking !== null) {
        return { kind: "in_flight", blocking } as const;
      }
    }

    const inserted = await tx
      .insert(payments)
      .values({
        id: input.id,
        endpointId: input.endpointId,
        routeId: input.routeId ?? null,
        payerAccountId: input.payerAccountId,
        amount: toColumn(input.amount),
        assetContract: input.assetContract,
        replayKey: input.replayKey,
        state: "verified",
        delegateExpiresAt: input.delegateExpiresAt ?? null,
        verifiedAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning();

    const [created] = inserted;
    if (created !== undefined) {
      return { kind: "created", payment: created } as const;
    }

    const existing = await byReplayKey(tx, input.replayKey);
    if (existing === null) {
      // The key collided on insert and then vanished: only a delete could do that,
      // and the ledger trigger forbids it, so this is a broken fixture, not a race.
      throw new Error(`payment with replay key ${input.replayKey} disappeared`);
    }
    return { kind: "existing", payment: existing } as const;
  });
}

/**
 * The payer's openest in-flight payment, or `null`. `verified` is the only state
 * that means "being served right now": `abandoned` and `served_unsettled` are
 * finished and must not block a retry (and C9 counts the latter separately).
 *
 * The window is not a niceness bound, it is the rule's own half-life: a `verified`
 * row older than the upstream timeout plus the settlement margin is a row a dead
 * process left behind, and until the sweep job (C10) moves it, it must not turn
 * the payer's next request into a permanent `429`.
 */
export async function inFlightPayment(
  session: Db | DbOrTransaction,
  payerAccountId: string,
  windowSeconds: number,
): Promise<PaymentRow | null> {
  const [row] = await session
    .select()
    .from(payments)
    .where(
      sql`${payments.payerAccountId} = ${payerAccountId} and ${payments.state} = 'verified' and ${payments.verifiedAt} > now() - make_interval(secs => ${windowSeconds}::int)`,
    )
    .orderBy(sql`${payments.verifiedAt} desc`)
    .limit(1);
  return row ?? null;
}

export function findByReplayKey(db: Db, replayKey: string): Promise<PaymentRow | null> {
  return byReplayKey(db, replayKey);
}

function byReplayKey(session: Db | DbOrTransaction, replayKey: string): Promise<PaymentRow | null> {
  return session
    .select()
    .from(payments)
    .where(sql`${payments.replayKey} = ${replayKey}`)
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export function findPayment(db: Db, paymentId: string): Promise<PaymentRow | null> {
  return byId(db, paymentId);
}

/**
 * Move a payment to `to`, refusing anything the state machine disallows.
 *
 * The update is compare-and-set on the state it read: two settle attempts for one
 * payment both pass `assertPaymentTransition` while the row still says `verified`,
 * and only the one whose `WHERE state = 'verified'` still matches writes, so a
 * payment cannot be settled twice and the second caller sees `settled`, not a
 * silent no-op.
 */
export async function advancePayment(
  db: Db,
  paymentId: string,
  to: PaymentState,
  fields: AdvanceFields = {},
): Promise<PaymentRow> {
  const current = await byId(db, paymentId);
  if (current === null) {
    throw new Error(`no payment ${paymentId}`);
  }
  assertPaymentTransition(current.state as PaymentState, to);

  const moved = await db
    .update(payments)
    .set({
      state: to,
      nearTxHash: fields.nearTxHash ?? current.nearTxHash,
      upstreamStatus: fields.upstreamStatus ?? current.upstreamStatus,
      upstreamMs: fields.upstreamMs ?? current.upstreamMs,
      ...(to === "settled" ? { settledAt: sql`now()` } : {}),
    })
    .where(sql`${payments.id} = ${paymentId} and ${payments.state} = ${current.state}`)
    .returning();

  const [row] = moved;
  if (row !== undefined) {
    return row;
  }

  // Someone else moved it between the read and the update. Re-read and refuse
  // through the same gate, so the caller gets the transition that actually lost.
  const raced = await byId(db, paymentId);
  assertPaymentTransition((raced?.state ?? current.state) as PaymentState, to);
  throw new Error(`payment ${paymentId} changed while it was being updated`);
}
