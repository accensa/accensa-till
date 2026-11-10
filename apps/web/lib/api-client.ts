import {
  type DashboardError,
  type DiscrepancyDto,
  type EndpointCreateRequest,
  type EndpointCreateResponse,
  type EndpointDto,
  type EndpointUpdateRequest,
  type EndpointUpdateResponse,
  type OverviewDto,
  type PayerBlockDto,
  type PaymentDto,
  type StatusDto,
  dashboardErrorSchema,
  discrepancyListResponseSchema,
  discrepancyResolveResponseSchema,
  endpointCreateResponseSchema,
  endpointListResponseSchema,
  endpointUpdateResponseSchema,
  overviewResponseSchema,
  payerBlockClearResponseSchema,
  payerBlockListResponseSchema,
  paymentListResponseSchema,
  statusResponseSchema,
} from "@till/core/schemas";

/**
 * Typed fetch for the dashboard (PROJECT_STRUCTURE.md: web never imports from
 * api). Every response is parsed with the shared schema before it is used, so a
 * drift in the API is a thrown parse error here rather than `undefined` two
 * components later.
 *
 * Paths go to /api/*. In the browser that is the rewrite in next.config.ts, which
 * keeps the session cookie first-party; on the server there is no origin to be
 * relative to, so the same path is named against `API_ORIGIN` and the caller's
 * session cookie is forwarded by hand. The cookie is `HttpOnly`, so a page that
 * renders server-side is the only place that can read it — and the only thing it
 * can do with it is hand it to the API that signed it.
 */

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3000";

function requestUrl(path: string): string {
  return typeof window === "undefined" ? `${API_ORIGIN}${path}` : path;
}

/** `no-store` because a dashboard that shows yesterday's endpoints is worse than one that fails. */
function fetchOptions(cookie: string | undefined): RequestInit {
  return {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
  };
}

/**
 * A read that could not be understood. Split from a refusal because the seller's
 * next step differs: a refusal names something to fix, this one names nothing, and
 * inventing a reason would be the dashboard lying about Till's state.
 */
export type Unreachable = { readonly kind: "unreachable"; readonly detail: string };

export type EndpointListResult =
  | { readonly kind: "ok"; readonly endpoints: readonly EndpointDto[] }
  | { readonly kind: "signed_out" }
  | Unreachable;

export type EndpointCreateResult =
  | { readonly kind: "created"; readonly result: EndpointCreateResponse }
  | { readonly kind: "rejected"; readonly error: DashboardError }
  | Unreachable;

/**
 * The same three answers for the payment list (UI-3, F3). A `500`
 * `payment_unreadable` is a refusal Till is telling the seller about, so it comes
 * back as `unreachable` carrying the API's own sentence rather than one written
 * here — the rule that decided it is in the route, and a second copy in the
 * dashboard could only disagree with it.
 */
export type PaymentListResult =
  | { readonly kind: "ok"; readonly payments: readonly PaymentDto[] }
  | { readonly kind: "signed_out" }
  | Unreachable;

/**
 * The open worklist (UI-4, F4). `unreachable` rather than an empty list when the read
 * fails or a row is unreadable: a seller who reads a missing item as a resolved one
 * stops looking, which is why the route answers `500 discrepancy_unreadable` at all.
 */
export type DiscrepancyListResult =
  | { readonly kind: "ok"; readonly discrepancies: readonly DiscrepancyDto[] }
  | { readonly kind: "signed_out" }
  | Unreachable;

/**
 * The payers this seller is holding, with the same three answers and the same reason
 * for them.
 */
export type PayerBlockListResult =
  | { readonly kind: "ok"; readonly payerBlocks: readonly PayerBlockDto[] }
  | { readonly kind: "signed_out" }
  | Unreachable;

/**
 * A close, an answer that names the row it closed. `rejected` carries the API's code
 * and sentence — including the one that says the session ended, because an action has
 * to report that to the hand that pressed the button rather than redirect it.
 */
export type DiscrepancyResolveResult =
  | { readonly kind: "resolved"; readonly discrepancy: DiscrepancyDto }
  | { readonly kind: "rejected"; readonly error: DashboardError }
  | Unreachable;

/** A clear, answered by the list as it now stands — the same read the table shows. */
export type PayerBlockClearResult =
  | { readonly kind: "cleared"; readonly payerBlocks: readonly PayerBlockDto[] }
  | { readonly kind: "rejected"; readonly error: DashboardError }
  | Unreachable;

/**
 * An edit of a live endpoint's terms (D9, PO-7's UI half). Four answers, and the two
 * 422s are not the same fact:
 *
 * - `updated` — the write happened and the checks all passed on the new terms.
 * - `refused` — nothing was written. The body is the endpoint *as it stands*, route
 *   included, so the seller reads the price and the payout address still in force
 *   beside the reasons the change was not. Drawing this as `rejected` would lose the
 *   live terms; drawing it as `updated` would tell the seller they are charging
 *   something Till refused to write.
 * - `rejected` — the request itself was refused (`destination_not_confirmed`, a body
 *   the schema rejects, an id that is not yours, a session that ended).
 * - `unreachable` — an answer Till's own contract cannot read.
 */
export type EndpointUpdateResult =
  | { readonly kind: "updated"; readonly result: EndpointUpdateResponse }
  | { readonly kind: "refused"; readonly result: EndpointUpdateResponse }
  | { readonly kind: "rejected"; readonly error: DashboardError }
  | Unreachable;

/**
 * Till's own two header facts (UI-5, F5), with the same three answers. `unreachable`
 * rather than a half-status because a header that shows one fact and drops the other
 * reads as a dropped fact that is fine; `signed_out` is separate from it because the
 * sign-in screen shares the layout and must not be shown as a broken read.
 */
export type StatusResult =
  | { readonly kind: "ok"; readonly status: StatusDto }
  | { readonly kind: "signed_out" }
  | Unreachable;

/**
 * Till's own totals by asset (UI-6, F6), the same three answers as the status read.
 * `unreachable` rather than an overview with no rows in it: `byAsset: []` is a claim
 * that the ledger holds nothing, and a seller who reads a failed totals query as that
 * claim stops looking for money that is still theirs. The route says the same thing by
 * answering `500 overview_unreadable`.
 */
export type OverviewResult =
  | { readonly kind: "ok"; readonly overview: OverviewDto }
  | { readonly kind: "signed_out" }
  | Unreachable;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export const api = {
  /**
   * The relayer balance and the last successful provider poll, both with the
   * threshold the header judges them against. Read with the page's session, since
   * the poll half is scoped to the seller the cookie names.
   */
  status: async (cookie?: string): Promise<StatusResult> => {
    let response: Response;
    try {
      response = await fetch(requestUrl("/api/status"), fetchOptions(cookie));
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401) {
      return { kind: "signed_out" };
    }
    if (!response.ok) {
      const refusal = dashboardErrorSchema.safeParse(await readJson(response));
      return {
        kind: "unreachable",
        detail: refusal.success
          ? refusal.data.message
          : `/api/status returned ${response.status} with no readable reason`,
      };
    }
    const parsed = statusResponseSchema.safeParse(await readJson(response));
    return parsed.success
      ? { kind: "ok", status: parsed.data.status }
      : { kind: "unreachable", detail: "/api/status answered a body Till's own schema refuses" };
  },

  /**
   * The overview totals, read with the page's session. The scope is the API's — the
   * ledger query is scoped to the seller the cookie names — so nothing here can ask
   * for another seller's money, and nothing here adds a total of its own.
   */
  overview: async (cookie?: string): Promise<OverviewResult> => {
    let response: Response;
    try {
      response = await fetch(requestUrl("/api/overview"), fetchOptions(cookie));
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401) {
      return { kind: "signed_out" };
    }
    if (!response.ok) {
      const refusal = dashboardErrorSchema.safeParse(await readJson(response));
      return {
        kind: "unreachable",
        detail: refusal.success
          ? refusal.data.message
          : `/api/overview returned ${response.status} with no readable reason`,
      };
    }
    const parsed = overviewResponseSchema.safeParse(await readJson(response));
    return parsed.success
      ? { kind: "ok", overview: parsed.data.overview }
      : { kind: "unreachable", detail: "/api/overview answered a body Till's own schema refuses" };
  },

  /**
   * The seller's own endpoints, newest first. Absent, expired or forged — the API
   * decides, and every one of those is a 401 the dashboard answers by sending the
   * seller to sign-in, because it cannot read the cookie to tell them apart.
   */
  endpoints: async (cookie?: string): Promise<EndpointListResult> => {
    let response: Response;
    try {
      response = await fetch(requestUrl("/api/endpoints"), fetchOptions(cookie));
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401) {
      return { kind: "signed_out" };
    }
    if (!response.ok) {
      return { kind: "unreachable", detail: `/api/endpoints returned ${response.status}` };
    }
    const parsed = endpointListResponseSchema.safeParse(await readJson(response));
    return parsed.success
      ? { kind: "ok", endpoints: parsed.data.endpoints }
      : { kind: "unreachable", detail: "/api/endpoints answered a body Till's own schema refuses" };
  },

  /**
   * Create one endpoint (UI-2, PO-2). The API answers `201` with every creation
   * check whether or not the endpoint went active, and a refusal with the code
   * that names what the seller must do — so nothing here throws: the caller shows
   * whichever of the three it got.
   */
  createEndpoint: async (
    request: EndpointCreateRequest,
    cookie?: string,
  ): Promise<EndpointCreateResult> => {
    let response: Response;
    try {
      response = await fetch(requestUrl("/api/endpoints"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const payload = await readJson(response);
    if (response.status === 201) {
      const created = endpointCreateResponseSchema.safeParse(payload);
      return created.success
        ? { kind: "created", result: created.data }
        : {
            kind: "unreachable",
            detail: "/api/endpoints answered a creation Till's own schema refuses",
          };
    }
    const refused = dashboardErrorSchema.safeParse(payload);
    return refused.success
      ? { kind: "rejected", error: refused.data }
      : {
          kind: "unreachable",
          detail: `/api/endpoints returned ${response.status} with no readable reason`,
        };
  },

  /**
   * Change one endpoint's terms (D9, PO-7's UI half). The body is the *diff* —
   * `buildEditBody` in `lib/endpoint-edit.ts` decides what goes in it — so this
   * function never adds a field of its own, and in particular never sends `active`:
   * liveness is the pause control's own body, because a price save that opened the
   * paywall would be the dashboard spending the seller's pause without them.
   */
  updateEndpoint: async (
    endpointId: string,
    request: EndpointUpdateRequest,
    cookie?: string,
  ): Promise<EndpointUpdateResult> => {
    const path = `/api/endpoints/${encodeURIComponent(endpointId)}`;
    let response: Response;
    try {
      response = await fetch(requestUrl(path), {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const payload = await readJson(response);
    // The check list first, because a refused change answers 422 with the live
    // endpoint beside it, and that pair is the more useful of the two shapes to read.
    const changed = endpointUpdateResponseSchema.safeParse(payload);
    if (changed.success && (response.status === 200 || response.status === 422)) {
      return response.status === 200
        ? { kind: "updated", result: changed.data }
        : { kind: "refused", result: changed.data };
    }
    const refused = dashboardErrorSchema.safeParse(payload);
    return refused.success
      ? { kind: "rejected", error: refused.data }
      : {
          kind: "unreachable",
          detail: `${path} returned ${response.status} with no readable reason`,
        };
  },

  /**
   * The seller's payments (UI-3, F3), read with the session the page was rendered
   * under. The scope is the API's — it joins through the seller's own endpoints —
   * so nothing here can ask for another seller's money.
   */
  payments: async (cookie?: string): Promise<PaymentListResult> => {
    let response: Response;
    try {
      response = await fetch(requestUrl("/api/payments"), fetchOptions(cookie));
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401) {
      return { kind: "signed_out" };
    }
    if (!response.ok) {
      const refusal = dashboardErrorSchema.safeParse(await readJson(response));
      return {
        kind: "unreachable",
        detail: refusal.success
          ? refusal.data.message
          : `/api/payments returned ${response.status} with no readable reason`,
      };
    }
    const parsed = paymentListResponseSchema.safeParse(await readJson(response));
    return parsed.success
      ? { kind: "ok", payments: parsed.data.payments }
      : { kind: "unreachable", detail: "/api/payments answered a body Till's own schema refuses" };
  },
  /**
   * The seller's open discrepancies (UI-4, F4), in the order the API answered them:
   * severity first, then age, both read from core's `SEVERITIES`. The page renders
   * that order rather than computing one, so a screen cannot put `low` above
   * `critical` because somebody retyped a rank table.
   */
  discrepancies: async (cookie?: string): Promise<DiscrepancyListResult> => {
    let response: Response;
    try {
      response = await fetch(requestUrl("/api/discrepancies"), fetchOptions(cookie));
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401) {
      return { kind: "signed_out" };
    }
    if (!response.ok) {
      const refusal = dashboardErrorSchema.safeParse(await readJson(response));
      return {
        kind: "unreachable",
        detail: refusal.success
          ? refusal.data.message
          : `/api/discrepancies returned ${response.status} with no readable reason`,
      };
    }
    const parsed = discrepancyListResponseSchema.safeParse(await readJson(response));
    return parsed.success
      ? { kind: "ok", discrepancies: parsed.data.discrepancies }
      : {
          kind: "unreachable",
          detail: "/api/discrepancies answered a body Till's own schema refuses",
        };
  },

  /**
   * Close one item by hand (LR-5). The item is named by its id and the seller by the
   * cookie, and the API answers with the row as it now stands: `resolvedAt` and
   * `resolution` are what tell the seller the cause can come back.
   */
  resolveDiscrepancy: async (
    discrepancyId: string,
    cookie?: string,
  ): Promise<DiscrepancyResolveResult> => {
    const path = `/api/discrepancies/${encodeURIComponent(discrepancyId)}/resolve`;
    let response: Response;
    try {
      response = await fetch(requestUrl(path), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(cookie === undefined ? {} : { cookie }),
        },
      });
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const payload = await readJson(response);
    if (response.ok) {
      const closed = discrepancyResolveResponseSchema.safeParse(payload);
      return closed.success
        ? { kind: "resolved", discrepancy: closed.data.discrepancy }
        : { kind: "unreachable", detail: `${path} answered a close Till's own schema refuses` };
    }
    const refused = dashboardErrorSchema.safeParse(payload);
    return refused.success
      ? { kind: "rejected", error: refused.data }
      : {
          kind: "unreachable",
          detail: `${path} returned ${response.status} with no readable reason`,
        };
  },

  /**
   * The payers this seller is holding. The predicate is C9's — the same window, the
   * same threshold and the same clear watermark the gateway blocks on — so the table
   * cannot show a payer the gateway would still serve, or hide one it would refuse.
   */
  payerBlocks: async (cookie?: string): Promise<PayerBlockListResult> => {
    let response: Response;
    try {
      response = await fetch(requestUrl("/api/payer-blocks"), fetchOptions(cookie));
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 401) {
      return { kind: "signed_out" };
    }
    if (!response.ok) {
      const refusal = dashboardErrorSchema.safeParse(await readJson(response));
      return {
        kind: "unreachable",
        detail: refusal.success
          ? refusal.data.message
          : `/api/payer-blocks returned ${response.status} with no readable reason`,
      };
    }
    const parsed = payerBlockListResponseSchema.safeParse(await readJson(response));
    return parsed.success
      ? { kind: "ok", payerBlocks: parsed.data.payerBlocks }
      : {
          kind: "unreachable",
          detail: "/api/payer-blocks answered a body Till's own schema refuses",
        };
  },

  /**
   * Lift one payer's hold. The answer is the whole list rather than the cleared
   * payer's row, because after a watermark "how many strikes count" is a query and a
   * claimed `lastStrikeAt` here would be a guess about whatever the payer did meanwhile
   * — so the table is redrawn from the read it just got.
   */
  clearPayerBlock: async (
    payerAccountId: string,
    note?: string,
    cookie?: string,
  ): Promise<PayerBlockClearResult> => {
    const path = `/api/payer-blocks/${encodeURIComponent(payerAccountId)}/clear`;
    let response: Response;
    try {
      response = await fetch(requestUrl(path), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(cookie === undefined ? {} : { cookie }),
        },
        // No `clearedBy`: who lifted this is the session's fact, and a field here
        // would be a field a request could forge.
        body: JSON.stringify(note === undefined ? {} : { note }),
      });
    } catch (error) {
      return {
        kind: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const payload = await readJson(response);
    if (response.ok) {
      const cleared = payerBlockClearResponseSchema.safeParse(payload);
      return cleared.success
        ? { kind: "cleared", payerBlocks: cleared.data.payerBlocks }
        : { kind: "unreachable", detail: `${path} answered a clear Till's own schema refuses` };
    }
    const refused = dashboardErrorSchema.safeParse(payload);
    return refused.success
      ? { kind: "rejected", error: refused.data }
      : {
          kind: "unreachable",
          detail: `${path} returned ${response.status} with no readable reason`,
        };
  },
};
