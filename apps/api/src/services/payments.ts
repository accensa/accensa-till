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
  | { readonly kind: "existing"; readonly payment: PaymentRow };

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
 */
export async function openPayment(db: Db, input: NewPayment): Promise<OpenResult> {
  const inserted = await db
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
    return { kind: "created", payment: created };
  }

  const existing = await findByReplayKey(db, input.replayKey);
  if (existing === null) {
    // The key collided on insert and then vanished: only a delete could do that,
    // and the ledger trigger forbids it, so this is a broken fixture, not a race.
    throw new Error(`payment with replay key ${input.replayKey} disappeared`);
  }
  return { kind: "existing", payment: existing };
}

export function findByReplayKey(db: Db, replayKey: string): Promise<PaymentRow | null> {
  return db
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
