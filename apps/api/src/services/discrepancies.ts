import { type Finding, dedupeKeyFor } from "@till/core";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";

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
 */

export type PersistFindingsResult = {
  readonly opened: number;
  readonly closed: number;
};

export async function persistFindings(
  db: Db,
  sellerId: string,
  findings: readonly Finding[],
): Promise<PersistFindingsResult> {
  const keys = [...new Set(findings.map((finding) => keyOf(finding)))];

  return db.transaction(async (tx) => {
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
  });
}

/** Manual resolution from the dashboard (UI-4). Answers false when no open row matched. */
export async function resolveManually(
  db: Db,
  sellerId: string,
  discrepancyId: string,
): Promise<boolean> {
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
    .returning({ id: discrepancies.id });
  return resolved.length === 1;
}

function keyOf(finding: Finding): string {
  return dedupeKeyFor(finding.code, finding.paymentId, finding.swapId);
}
