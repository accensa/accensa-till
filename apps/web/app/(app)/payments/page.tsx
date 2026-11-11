import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";

import { PaymentTable } from "../../../components/domain/PaymentTable.tsx";
import { SessionNotice } from "../../../components/domain/SessionNotice.tsx";
import { api } from "../../../lib/api-client.ts";

/**
 * Payments (UI-3, F3).
 *
 * Read the same way the endpoints page reads its list: the session cookie is
 * `HttpOnly`, so only a server render can hand it back to the API that signed it,
 * and the API decides which payments are this seller's by joining through their own
 * endpoints. Nothing here names a seller, so nothing here can ask for another
 * seller's money.
 *
 * `served_unsettled` rows are what the reconciliation view (UI-4) exists for; this
 * table names them and leaves the action there.
 */
export default async function PaymentsPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token === undefined) {
    return (
      <section>
        <h1>Payments</h1>
        <SessionNotice kind="no-session" />
      </section>
    );
  }

  const listed = await api.payments(`${SESSION_COOKIE}=${token}`);

  if (listed.kind === "ok") {
    return (
      <section>
        <div className="flex items-center justify-between mb-4">
          <h1>Payments</h1>
          <a
            className="text-sm underline hover:text-blue-600"
            download="ledger.csv"
            href="/api/export/ledger.csv"
          >
            Export Ledger (CSV)
          </a>
        </div>
        <PaymentTable payments={listed.payments} />
      </section>
    );
  }

  return (
    <section>
      <h1>Payments</h1>
      {listed.kind === "signed_out" ? (
        <SessionNotice kind="session-refused" />
      ) : (
        <SessionNotice detail={listed.detail} kind="unreachable" />
      )}
    </section>
  );
}
