import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";

import { OverviewTotals } from "../../components/domain/OverviewTotals.tsx";
import { SessionNotice } from "../../components/domain/SessionNotice.tsx";
import { api } from "../../lib/api-client.ts";

/**
 * Overview (UI-6, F6).
 *
 * Read the same way the payments page reads its list: the session cookie is `HttpOnly`,
 * so only a server render can hand it back to the API that signed it, and the API
 * decides which ledger rows are this seller's. Nothing here names a seller or sums a
 * column, so the screen cannot show another seller's money or a total Till's query did
 * not produce — UI-6's acceptance rule is that these figures equal the ledger rows they
 * summarise.
 *
 * The three non-list branches are the point of the page as much as the table is. A
 * refused session and an unreadable ledger get `SessionNotice`, never the overview with
 * no rows in it, because an empty table is a claim about the seller's money and neither
 * of those facts supports it.
 */
export default async function OverviewPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token === undefined) {
    return (
      <section>
        <h1>Overview</h1>
        <SessionNotice kind="no-session" />
      </section>
    );
  }

  const listed = await api.overview(`${SESSION_COOKIE}=${token}`);

  if (listed.kind === "ok") {
    return (
      <section>
        <div className="flex items-center justify-between mb-4">
          <h1>Overview</h1>
          <a
            className="text-sm underline hover:text-blue-600"
            download="ledger.csv"
            href="/api/export/ledger.csv"
          >
            Export Ledger (CSV)
          </a>
        </div>
        <OverviewTotals result={listed} />
      </section>
    );
  }

  return (
    <section>
      <h1>Overview</h1>
      {listed.kind === "signed_out" ? (
        <SessionNotice kind="session-refused" />
      ) : (
        <SessionNotice detail={listed.detail} kind="unreachable" />
      )}
    </section>
  );
}
