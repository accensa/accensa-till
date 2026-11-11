import type { PayerBlockDto } from "@till/core/schemas";

import { displayDate } from "../../lib/format.ts";
import { HELD_PAYER_EXPLAINED, NO_BLOCKED_PAYER_COPY } from "../../lib/reconcile.ts";

/**
 * The payers this seller is holding (UI-4, F4).
 *
 * The list is the gateway's own predicate read back — the same window, the same
 * threshold, the same per-payer clear watermark C9 blocks on — so a row here means
 * "the gateway is refusing this payer today", not "it did something once". That is
 * also why the count is printed as the row's own number rather than a page-wide
 * threshold: the only figure the dashboard has permission to state is the one it read.
 *
 * Presentational like the card: `busyPayer` and `onClear` come from
 * `ReconcileActions`, so the row that is mid-flight cannot be pressed twice while the
 * others stay usable.
 */
export type PayerBlockTableProps = {
  readonly payerBlocks: readonly PayerBlockDto[];
  /** The payer whose clear is in flight, or `null`. */
  readonly busyPayer: string | null;
  readonly onClear: (payerAccountId: string) => void;
};

export function PayerBlockTable({ payerBlocks, busyPayer, onClear }: PayerBlockTableProps) {
  if (payerBlocks.length === 0) {
    return (
      <div className="panel flex flex-col gap-2 p-6">
        <span className="chip chip-live w-fit">Clear</span>
        <p className="text-sm leading-6 text-muted">{NO_BLOCKED_PAYER_COPY}</p>
      </div>
    );
  }

  return (
    <div className="panel overflow-x-auto">
      <p className="border-b border-line px-4 py-3 text-[12px] leading-5 text-muted">
        {HELD_PAYER_EXPLAINED}
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Payer</th>
            <th>Unpaid serves</th>
            <th>Last one</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {payerBlocks.map((block) => (
            <tr className="border-t border-line" key={block.payerAccountId}>
              <td>
                <code className="text-[12px] text-bone">{block.payerAccountId}</code>
              </td>
              <td className="font-mono text-[12px] tabular-nums text-amber">
                {block.strikes} unpaid serves
                {block.blocked ? null : <span className="text-muted"> — already released</span>}
              </td>
              <td className="whitespace-nowrap font-mono text-[11px] text-muted">
                {displayDate(block.lastStrikeAt)}
              </td>
              <td>
                {block.blocked ? (
                  <button
                    className="btn btn-small"
                    disabled={busyPayer === block.payerAccountId}
                    onClick={() => onClear(block.payerAccountId)}
                    type="button"
                  >
                    {busyPayer === block.payerAccountId ? "Clearing…" : "Clear"}
                  </button>
                ) : (
                  <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">
                    nothing to clear
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
