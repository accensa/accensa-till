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

const TONE_CLASS: Readonly<Record<OverviewLine["tone"], string>> = {
  ok: "opacity-60",
  warn: "text-red-700 font-semibold",
  unknown: "text-amber-700",
};

const COLUMNS = ["Settled", "In transit", "Paid out", "Refunded", "Adjusted", "Net held"] as const;

export function OverviewTotals({ result }: OverviewTotalsProps) {
  const { lines, rows } = overviewView(result);

  return (
    <section>
      {lines.map((line) => (
        <p
          className={`text-sm ${TONE_CLASS[line.tone]}`}
          key={line.text}
          role={line.tone === "warn" ? "alert" : undefined}
        >
          {line.text}
        </p>
      ))}
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
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left opacity-70">
            <th className="py-1 pr-4 font-medium">Asset</th>
            {COLUMNS.map((column) => (
              <th className="py-1 pr-4 font-medium" key={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t" key={row.asset}>
              <td className="py-2 pr-4 align-top">
                <code>{row.asset}</code>
              </td>
              <td className="py-2 pr-4 align-top">{row.settled}</td>
              <td className="py-2 pr-4 align-top">{row.inTransit}</td>
              <td className="py-2 pr-4 align-top">{row.paidOut}</td>
              <td className="py-2 pr-4 align-top">{row.refunded}</td>
              <td className="py-2 pr-4 align-top">{row.adjusted}</td>
              <td className="py-2 font-medium align-top">{row.netHeld}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
