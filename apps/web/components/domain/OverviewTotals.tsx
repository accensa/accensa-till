import type { OverviewResult } from "../../lib/api-client.ts";
import { type OverviewLine, overviewView } from "../../lib/overview.ts";

/**
 * The overview table (UI-6, F6): one row per asset Till has ever settled, each stating
 * the five totals and what they leave held, under the sentences that say whether the
 * read happened at all.
 *
 * A server component with nothing to hydrate, so the numbers are in the first paint and
 * a seller with JavaScript off still reads them. Every comparison and every sentence
 * lives in `overviewView`, which is what lets them be asserted without a browser; this
 * file's only jobs are to mark which line is an alert and to lay the rows out. It adds
 * no total of its own — the acceptance rule for UI-6 is that these figures equal the
 * ledger rows they summarise, and a column computed here would equal nothing.
 *
 * `role="alert"` goes on a warned line and on nothing else. An unknown is Till's own
 * outage rather than the seller's bookkeeping, and announcing it as an alert is how a
 * dropped read becomes a fire alarm.
 */
export type OverviewTotalsProps = {
  readonly result: OverviewResult;
};

const COLUMNS = ["Settled", "In transit", "Paid out", "Refunded", "Adjusted", "Net held"] as const;

export function OverviewTotals({ result }: OverviewTotalsProps) {
  const { lines, rows } = overviewView(result);

  return (
    <section>
      <div className="space-y-3">
        {lines.map((line) => (
          <p
            className={
              line.tone === "warn"
                ? "notice-warn"
                : line.tone === "unknown"
                  ? "notice-muted"
                  : "text-sm leading-6 text-muted"
            }
            key={line.text}
            role={line.tone === "warn" ? "alert" : undefined}
          >
            {line.tone === "warn" ? (
              <span aria-hidden className="mr-2 font-mono text-[10px] uppercase tracking-[0.16em]">
                Action /
              </span>
            ) : null}
            {line.text}
          </p>
        ))}
      </div>
      {rows.length === 0 ? null : <AssetTotalsTable rows={rows} />}
    </section>
  );
}

/**
 * Amounts are the strings `overviewView` formatted through `displayAmount`, so a cell
 * whose wire value could not be read renders as the em dash that helper returns rather
 * than as a `0` a seller would subtract from their expectations.
 */
function AssetTotalsTable({
  rows,
}: {
  readonly rows: ReturnType<typeof overviewView>["rows"];
}) {
  return (
    <div className="panel mt-8 overflow-x-auto">
      <div className="panel-head">
        <span className="eyebrow">Ledger totals</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
          Decimal units · 6 dp
        </span>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Asset</th>
            {COLUMNS.map((column) => (
              <th className="text-right" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t" key={row.asset}>
              <td>
                <span className="chip chip-muted">{row.asset}</span>
              </td>
              <td className="text-right font-mono tabular-nums text-muted">{row.settled}</td>
              <td className="text-right font-mono tabular-nums text-muted">{row.inTransit}</td>
              <td className="text-right font-mono tabular-nums text-muted">{row.paidOut}</td>
              <td className="text-right font-mono tabular-nums text-muted">{row.refunded}</td>
              <td className="text-right font-mono tabular-nums text-muted">{row.adjusted}</td>
              <td className="text-right font-mono text-base tabular-nums text-acid">
                {row.netHeld}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
