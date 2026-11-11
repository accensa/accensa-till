import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";

import { PageHeader } from "../../../components/domain/PageHeader.tsx";
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

  const header = (
    <PageHeader
      description="Every verified payment, newest first. Each hash links to the chain it settled on; a test from your own wallet is not revenue."
      index="03 / Ledger"
      title="Payments"
    />
  );

  if (token === undefined) {
    return (
      <section>
        {header}
        <SessionNotice kind="no-session" />
      </section>
    );
  }

  const listed = await api.payments(`${SESSION_COOKIE}=${token}`);

  if (listed.kind === "ok") {
    return (
      <section>
        <PageHeader
          actions={
            <a className="btn btn-outline-acid" download="ledger.csv" href="/api/export/ledger.csv">
              <span aria-hidden>↓</span>
              Export ledger (CSV)
            </a>
          }
          description="Every verified payment, newest first. Each hash links to the chain it settled on; a test from your own wallet is not revenue."
          index="03 / Ledger"
          title="Payments"
        />
        <PaymentTable payments={listed.payments} />
      </section>
    );
  }

  return (
    <section>
      {header}
      {listed.kind === "signed_out" ? (
        <SessionNotice kind="session-refused" />
      ) : (
        <SessionNotice detail={listed.detail} kind="unreachable" />
      )}
    </section>
  );
}
