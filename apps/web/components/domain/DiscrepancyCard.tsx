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
  critical: "text-danger",
  high: "text-amber",
  medium: "text-acid",
  low: "text-muted",
};

const SEVERITY_EDGE: Readonly<Record<DiscrepancyDto["severity"], string>> = {
  critical: "border-l-danger",
  high: "border-l-amber",
  medium: "border-l-acid",
  low: "border-l-line-bright",
};

export function DiscrepancyCard({
  discrepancy,
  nowMs,
  onResolve,
  busy = false,
}: DiscrepancyCardProps) {
  return (
    <article
      className={`border border-l-2 border-line bg-panel ${SEVERITY_EDGE[discrepancy.severity]}`}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3">
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.14em] ${SEVERITY_CLASS[discrepancy.severity]}`}
        >
          {severityWords()[discrepancy.severity]}
        </span>
        <code className="font-mono text-[11px] text-bone">{discrepancy.code}</code>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
          {discrepancyAge(discrepancy.openedAt, nowMs)} — opened {displayDate(discrepancy.openedAt)}
        </span>
      </header>

      <div className="px-4 py-4">
        <p className="max-w-3xl text-sm leading-6 text-bone">{discrepancy.explanation}</p>
        <p className="mt-3 max-w-3xl border-l border-line-bright pl-3 text-sm leading-6 text-muted">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-acid">
            Suggested /{" "}
          </span>
          {discrepancy.suggestedAction}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-faint">
          {discrepancy.paymentId === null
            ? "No payment named on this item"
            : `Payment ${discrepancy.paymentId}`}
          {discrepancy.swapId === null ? null : ` · swap ${discrepancy.swapId}`}
        </p>
        <button
          className="btn btn-small ml-auto"
          disabled={busy}
          onClick={() => onResolve(discrepancy.id)}
          type="button"
        >
          {busy ? "Closing…" : "Resolve"}
        </button>
      </div>
    </article>
  );
}
