import {
  type DiscrepancyDto,
  type Finding,
  SEVERITIES,
  dedupeKeyFor,
  discrepancyDtoSchema,
} from "@till/core";
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { discrepancies } from "../db/schema.ts";

/**
 * Persists what the pure rules found (E8, LR-4, LR-5). This is the only writer of
 * `discrepancies`: rules are pure and never touch the table, and the dashboard
 * closes rows through `resolveManually` rather than an UPDATE of its own.
 *
 * Two decisions live here rather than in the caller:
 *
 * - The dedupe key is recomputed from the code and subject ids. A rule that
 *   hand-wrote one could book the same cause twice or collide two causes; the
 *   key is this module's responsibility, and `dedupeKeyFor` is its only shape.
 * - An open row is left untouched when its cause fires again, so `opened_at` is
 *   the first observation and the row is not churned by every run. A resolved
 *   row is allowed to reopen (LR-5), so a cause that returns — after a manual
 *   close as much as after an auto one — gets a fresh row rather than silence.
 *
 * Auto-resolution is scoped to the seller and to the findings handed in: the
 * caller passes the result of a full `runAllRules` snapshot, so an open cause
 * that no longer appears has cleared. Overlapping runs for one seller are E9's
 * problem — it serialises them with `SKIP LOCKED` — and this function assumes
 * one run at a time per seller.
 *
 * E9 is why the body is a second function (`writeFindings`) rather than one: the
 * reconcile pass claims the seller row `FOR UPDATE SKIP LOCKED` and must still be
 * holding that claim when the findings land, so it hands its own transaction in.
 * A single exported function could either wrap in a transaction (releasing the
 * claim) or not (leaving E8's callers to guess), and a caller that guesses wrong
 * loses the guarantee the claim exists to give. So the wrapper is explicit about
 * which door it is: `persistFindings` opens a transaction of its own,
 * `writeFindings` runs inside one that is already open.
 */

/** drizzle's transaction handle: the same `Tx` shape the ledger and swap writers take. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Bounded at the read as well as in the contract (C15): the page renders what it is given. */
export const DISCREPANCY_LIST_LIMIT = 256;

export type PersistFindingsResult = {
  readonly opened: number;
  readonly closed: number;
};

export type PersistFindingsOptions = {
  /**
   * Close open causes the findings do not name. Default `true`, and E9 sets it to
   * `false` for a pass whose snapshot is **partial** — the rules could not see
   * everything the seller has, so an absent cause is not evidence of a cleared one.
   * Turning this off costs a stale row lingering until a complete pass; turning it
   * on for a partial snapshot would silently shut a live finding, which is the
   * failure mode the row exists to prevent.
   */
  readonly autoClose?: boolean;
};

export async function persistFindings(
  db: Db,
  sellerId: string,
  findings: readonly Finding[],
  options: PersistFindingsOptions = {},
): Promise<PersistFindingsResult> {
  return db.transaction((tx) => writeFindings(tx, sellerId, findings, options));
}

/** The same write, inside a transaction the caller already holds. */
export async function writeFindings(
  tx: Tx,
  sellerId: string,
  findings: readonly Finding[],
  options: PersistFindingsOptions = {},
): Promise<PersistFindingsResult> {
  const keys = [...new Set(findings.map((finding) => keyOf(finding)))];

  const opened: { id: string }[] = [];
  for (const finding of findings) {
    const inserted = await tx
      .insert(discrepancies)
      .values({
        sellerId,
        code: finding.code,
        severity: finding.severity,
        paymentId: finding.paymentId,
        swapId: finding.swapId,
        dedupeKey: keyOf(finding),
        explanation: finding.explanation,
        suggestedAction: finding.suggestedAction,
        details: finding.details ?? null,
        openedAt: sql`now()`,
      })
      .onConflictDoNothing({
        target: [discrepancies.sellerId, discrepancies.dedupeKey],
        where: sql`${discrepancies.resolvedAt} is null`,
      })
      .returning({ id: discrepancies.id });
    opened.push(...inserted);
  }

  if (options.autoClose === false) {
    // A partial pass opens and never closes, so `closed` is a fact about this write
    // rather than a number that quietly means "nothing needed closing".
    return { opened: opened.length, closed: 0 };
  }

  const closed = await tx
    .update(discrepancies)
    .set({ resolvedAt: sql`now()`, resolution: "auto" })
    .where(
      keys.length === 0
        ? and(eq(discrepancies.sellerId, sellerId), isNull(discrepancies.resolvedAt))
        : and(
            eq(discrepancies.sellerId, sellerId),
            isNull(discrepancies.resolvedAt),
            notInArray(discrepancies.dedupeKey, keys),
          ),
    )
    .returning({ id: discrepancies.id });

  return { opened: opened.length, closed: closed.length };
}

/**
 * Manual resolution from the dashboard (UI-4).
 *
 * It answers the closed row rather than a boolean, because the screen redraws that
 * card with its `resolvedAt` and `resolution` and a caller that then re-reads the
 * list is asking the database a second question to find out what the first one did.
 * `null` is still the whole of the refusal: one answer for "not yours", "already
 * shut" and "never was", because which of the three it was says who else has an open
 * item on this cause.
 */
export async function resolveManually(
  db: Db,
  sellerId: string,
  discrepancyId: string,
): Promise<DiscrepancyDto | null> {
  const resolved = await db
    .update(discrepancies)
    .set({ resolvedAt: sql`now()`, resolution: "manual" })
    .where(
      and(
        eq(discrepancies.id, discrepancyId),
        eq(discrepancies.sellerId, sellerId),
        isNull(discrepancies.resolvedAt),
      ),
    )
    .returning();
  const [row] = resolved;
  if (row === undefined) {
    return null;
  }
  return toDiscrepancyDto(row);
}

/**
 * The open worklist, severity first and then oldest first (UI-4).
 *
 * The order is `SEVERITIES` translated into SQL, not a rank table the query keeps
 * beside the enum: a page that sorted `high` above `critical` because somebody typed
 * the list twice would look correct and read wrong. `else` is the length of the
 * array, so a severity nobody defined sorts last and is then refused by the contract
 * rather than silently ranked.
 *
 * Only open rows, because this is a worklist and not a history: a cause that
 * resolved and came back is a *new* row (LR-5), and the closed ones are the audit
 * trail, which UI-7 (F7) owns.
 */
export async function listOpenDiscrepanciesForSeller(
  db: Db,
  sellerId: string,
  limit = DISCREPANCY_LIST_LIMIT,
): Promise<DiscrepancyDto[]> {
  const rows = await db
    .select()
    .from(discrepancies)
    .where(and(eq(discrepancies.sellerId, sellerId), isNull(discrepancies.resolvedAt)))
    .orderBy(severityOrder, asc(discrepancies.openedAt))
    .limit(Math.min(limit, DISCREPANCY_LIST_LIMIT));

  return rows.map((row) => toDiscrepancyDto(row));
}

const severityOrder = sql`case ${sql.join(
  SEVERITIES.map(
    (severity, index) => sql`when ${discrepancies.severity} = ${severity} then ${index}`,
  ),
  sql.raw(" "),
)} else ${String(SEVERITIES.length)} end`;

/** Every row crosses the dashboard's contract on its way out, as F3's do. */
function toDiscrepancyDto(row: typeof discrepancies.$inferSelect): DiscrepancyDto {
  return discrepancyDtoSchema.parse({
    id: row.id,
    sellerId: row.sellerId,
    code: row.code,
    severity: row.severity,
    paymentId: row.paymentId,
    swapId: row.swapId,
    dedupeKey: row.dedupeKey,
    explanation: row.explanation,
    suggestedAction: row.suggestedAction,
    openedAt: row.openedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolution: row.resolution,
  });
}

function keyOf(finding: Finding): string {
  return dedupeKeyFor(finding.code, finding.paymentId, finding.swapId);
}
