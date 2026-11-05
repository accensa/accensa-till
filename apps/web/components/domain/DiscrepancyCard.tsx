import type { DiscrepancyDto } from "@till/core/schemas";

import { displayDate } from "../../lib/format.ts";
import { discrepancyAge, severityWords } from "../../lib/reconcile.ts";

/**
 * One open item (UI-4, F4).
 *
 * The explanation and the suggested action are printed exactly as the rule that
 * raised them wrote them (LR-4: the engine names the cause and the fix, and the UI
 * invents none of it), which is why this file takes the whole DTO and rewrites
 * nothing. What it adds is only the ordering word and the age — both derived from
 * fields on the row, neither a claim about the money.
 *
 * Presentational on purpose: `busy` and `onResolve` come from `ReconcileActions`, so
 * the card can be drawn by a test with a fixed clock and no fetch, and a page that
 * never re-renders it still cannot resolve an item twice.
 */
export type DiscrepancyCardProps = {
  readonly discrepancy: DiscrepancyDto;
  /** The page's read time, passed in: the age is measured against it, not against a clock here. */
  readonly nowMs: number;
  readonly onResolve: (discrepancyId: string) => void;
  readonly busy?: boolean;
};

const SEVERITY_CLASS: Readonly<Record<DiscrepancyDto["severity"], string>> = {
  critical: "text-red-700 font-semibold",
  high: "text-amber-700 font-semibold",
  medium: "text-amber-700",
  low: "opacity-70",
};

export function DiscrepancyCard({
  discrepancy,
  nowMs,
  onResolve,
  busy = false,
}: DiscrepancyCardProps) {
  return (
    <article className="border p-4">
      <header className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className={SEVERITY_CLASS[discrepancy.severity]}>
          {severityWords()[discrepancy.severity]}
        </span>
        <code>{discrepancy.code}</code>
        <span className="opacity-60">
          {discrepancyAge(discrepancy.openedAt, nowMs)} — opened {displayDate(discrepancy.openedAt)}
        </span>
      </header>

      <p className="mt-2 text-sm">{discrepancy.explanation}</p>
      <p className="mt-1 text-sm">
        <span className="font-semibold">Suggested: </span>
        {discrepancy.suggestedAction}
      </p>

      <p className="mt-1 text-xs opacity-60">
        {discrepancy.paymentId === null
          ? "No payment named on this item"
          : `Payment ${discrepancy.paymentId}`}
        {discrepancy.swapId === null ? null : ` · swap ${discrepancy.swapId}`}
      </p>

      <button
        type="button"
        className="mt-3 border px-3 py-1 text-sm disabled:opacity-50"
        disabled={busy}
        onClick={() => onResolve(discrepancy.id)}
      >
        {busy ? "Closing…" : "Resolve"}
      </button>
    </article>
  );
}
