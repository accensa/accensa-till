import {
  type DashboardError,
  type DiscrepancyDto,
  type EndpointCreateRequest,
  type EndpointCreateResponse,
  type EndpointDto,
  type HealthDto,
  type PaymentDto,
  dashboardErrorSchema,
  discrepancyDtoSchema,
  endpointCreateResponseSchema,
  endpointListResponseSchema,
  healthDtoSchema,
  paymentListResponseSchema,
} from "@till/core/schemas";
import type { z } from "zod";

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

async function get<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
  const response = await fetch(requestUrl(path), fetchOptions(undefined));
  if (response.status === 401) {
    throw new Error("session missing or expired — sign in again (UI-1)");
  }
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return schema.parse(await response.json());
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export const api = {
  health: (): Promise<HealthDto> => get("/api/health", healthDtoSchema),

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
  discrepancies: (): Promise<readonly DiscrepancyDto[]> =>
    get("/api/discrepancies", discrepancyDtoSchema.array()),
};
