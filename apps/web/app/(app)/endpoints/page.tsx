import { SESSION_COOKIE } from "@till/core/schemas";
import { cookies } from "next/headers";

import { CreateEndpointForm } from "../../../components/domain/CreateEndpointForm.tsx";
import { EndpointList } from "../../../components/domain/EndpointCard.tsx";
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

  if (token === undefined) {
    return (
      <section>
        <h1>Endpoints</h1>
        <SessionNotice kind="no-session" />
      </section>
    );
  }

  const listed = await api.endpoints(`${SESSION_COOKIE}=${token}`);

  if (listed.kind === "ok") {
    return (
      <section>
        <h1>Endpoints</h1>
        <EndpointList endpoints={listed.endpoints} />
        <h2 className="mt-6 font-semibold">Create an endpoint</h2>
        <CreateEndpointForm />
      </section>
    );
  }

  return (
    <section>
      <h1>Endpoints</h1>
      {listed.kind === "signed_out" ? (
        <SessionNotice kind="session-refused" />
      ) : (
        <SessionNotice detail={listed.detail} kind="unreachable" />
      )}
    </section>
  );
}
