import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";

import { PageHeader } from "../../../components/domain/PageHeader.tsx";
import { ReconcileActions } from "../../../components/domain/ReconcileActions.tsx";
import { SessionNotice } from "../../../components/domain/SessionNotice.tsx";
import { api } from "../../../lib/api-client.ts";

/**
 * Reconciliation (UI-4, F4).
 *
 * Both lists are read here rather than in the browser for one reason: the session
 * cookie is `HttpOnly`, so a server render is the only thing that can hand it back to
 * the API that signed it. The scope is the API's — every query goes through the
 * seller's own rows — so nothing on this page can name another seller's money or
 * another seller's blocked payer.
 *
 * `nowMs` is read once, for the ages. The worklist's order is not read here at all:
 * the API answers it severity-first from core's `SEVERITIES`, and a second sort would
 * be a second truth about what is most urgent.
 */
export default async function ReconciliationPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  const header = (
    <PageHeader
      description="Open findings, ordered by severity and age, then the payers Till is holding. Every sentence here is the rule's own — the dashboard invents none of it."
      index="04 / Reconciliation"
      title="Reconciliation"
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

  const cookie = `${SESSION_COOKIE}=${token}`;
  const [listed, blocked] = await Promise.all([api.discrepancies(cookie), api.payerBlocks(cookie)]);

  return (
    <section>
      {header}
      <ReconcileActions blocked={blocked} listed={listed} nowMs={Date.now()} />
    </section>
  );
}
