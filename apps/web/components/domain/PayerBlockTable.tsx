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
    return <p className="text-sm opacity-70">{NO_BLOCKED_PAYER_COPY}</p>;
  }

  return (
    <div className="mt-4">
      <p className="text-sm opacity-70">{HELD_PAYER_EXPLAINED}</p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left opacity-70">
              <th className="py-1 pr-4 font-medium">Payer</th>
              <th className="py-1 pr-4 font-medium">Unpaid serves</th>
              <th className="py-1 pr-4 font-medium">Last one</th>
              <th className="py-1 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {payerBlocks.map((block) => (
              <tr className="border-t" key={block.payerAccountId}>
                <td className="py-2 pr-4 align-top">
                  <code>{block.payerAccountId}</code>
                </td>
                <td className="py-2 pr-4 align-top">
                  {block.strikes} unpaid serves{block.blocked ? null : " — already released"}
                </td>
                <td className="py-2 pr-4 align-top">{displayDate(block.lastStrikeAt)}</td>
                <td className="py-2 align-top">
                  {block.blocked ? (
                    <button
                      type="button"
                      className="border px-3 py-1 text-sm disabled:opacity-50"
                      disabled={busyPayer === block.payerAccountId}
                      onClick={() => onClear(block.payerAccountId)}
                    >
                      {busyPayer === block.payerAccountId ? "Clearing…" : "Clear"}
                    </button>
                  ) : (
                    <span className="opacity-60">nothing to clear</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
