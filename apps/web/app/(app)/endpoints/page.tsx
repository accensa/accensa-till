import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";

import { CreateEndpointForm } from "../../../components/domain/CreateEndpointForm.tsx";
import { EndpointList } from "../../../components/domain/EndpointCard.tsx";
import { PageHeader } from "../../../components/domain/PageHeader.tsx";
import { SessionNotice } from "../../../components/domain/SessionNotice.tsx";
import { api } from "../../../lib/api-client.ts";

/**
 * Endpoints: list and create (UI-2, PO-1/PO-2).
 *
 * The list is read while rendering on the server, because the session cookie is
 * `HttpOnly` (F1) and no browser script may see it: the page hands the cookie to
 * the API that signed it and gets that seller's own endpoints back. The create form
 * runs in the browser, where the same cookie rides along on its own.
 *
 * What the read answers picks the screen, and the three answers are three
 * sentences — here are your endpoints, you are not signed in, Till is not
 * answering. Which is why the read returns a typed union instead of throwing: an
 * exception would have to be drawn as one of them anyway.
 */
export default async function EndpointsPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  const header = (
    <PageHeader
      description="Paywalled GET routes. Each one is checked before it takes money, and its slug is the only name a buyer sees."
      index="02 / Paywall"
      title="Endpoints"
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

  const listed = await api.endpoints(`${SESSION_COOKIE}=${token}`);

  if (listed.kind === "ok") {
    return (
      <section>
        {header}
        <div className="space-y-12">
          <div>
            <div className="mb-4 flex items-end justify-between gap-4 border-b border-line pb-3">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
                Your paywalls
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                {listed.endpoints.length} total
              </span>
            </div>
            <EndpointList endpoints={listed.endpoints} />
          </div>

          <div>
            <div className="mb-4 flex items-end justify-between gap-4 border-b border-line pb-3">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
                New endpoint
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
                Checked on save
              </span>
            </div>
            <CreateEndpointForm />
          </div>
        </div>
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
