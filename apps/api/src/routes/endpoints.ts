import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { SESSION_COOKIE, endpointCreateRequestSchema } from "@till/core";

import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { ResolveNames } from "../gateway/ssrf.ts";
import type { Logger } from "../lib/logger.ts";
import { type SessionClaims, createSessionCodec } from "../lib/session.ts";
import {
  type EndpointCreationDeps,
  type TokenStorageReader,
  createEndpoint,
  createTokenStorageReader,
  listEndpoints,
} from "../services/endpoints.ts";

/**
 * Dashboard endpoint create and list (UI-2, D4/D5). Requires a session.
 *
 * The confirmation step lives here rather than in the service: a create request
 * must carry `confirmedAddress` equal to the `destinationAddress` the seller was
 * shown. The service can then assume the destination was displayed, and a UI bug
 * that submits a value the seller never saw is a `422` rather than a payout route.
 *
 * Creation always answers `201` with the endpoint and every check: an endpoint
 * that failed a check is written `active: false` with the reasons on the row, so
 * one failed check does not hide the next and a reload still explains itself.
 */

export type EndpointSessionReader = (cookie: string | undefined) => Promise<SessionClaims | null>;

export type EndpointRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  /**
   * The shipped default is F1's signed-cookie check. A test injects a seller
   * instead of minting a cookie, which is the reason this is a seam at all.
   */
  readonly session?: EndpointSessionReader;
  readonly storage?: TokenStorageReader;
  /** Test seam for the SSRF check's DNS read. */
  readonly resolve?: ResolveNames;
};

export function createEndpointRoutes(deps: EndpointRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const read: EndpointSessionReader =
    deps.session ??
    (async (cookie) =>
      cookie === undefined || cookie === "" ? null : await codec.verifySessionCookie(cookie));
  const creationDeps: EndpointCreationDeps = {
    minPriceBaseUnits: env.MIN_PRICE_BASE_UNITS,
    network: env.NEAR_NETWORK,
    allowInsecureUpstream: env.ALLOW_INSECURE_UPSTREAM,
    gatewayOrigin: env.GATEWAY_PUBLIC_URL,
    gatewayPublicUrl: env.GATEWAY_PUBLIC_URL,
    payoutProvider: env.PAYOUT_PROVIDER,
    storage: deps.storage ?? createTokenStorageReader({ rpcUrl: env.NEAR_RPC_URL }),
    resolve: deps.resolve,
  };

  const app = new Hono();

  app.get("/endpoints", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to list endpoints." }, 401);
    }
    return c.json({ endpoints: await listEndpoints(db, creationDeps, seller.sellerId) });
  });

  app.post("/endpoints", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to create an endpoint." }, 401);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ code: "invalid_json", message: "The request body is not JSON." }, 400);
    }
    const parsed = endpointCreateRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_request",
          message: "The endpoint could not be created from this body.",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        },
        400,
      );
    }

    const request = parsed.data;
    if (request.confirmedAddress !== request.destinationAddress) {
      return c.json(
        {
          code: "destination_not_confirmed",
          message: "Confirm the destination address that was shown to you.",
          destinationAddress: request.destinationAddress,
        },
        422,
      );
    }

    const created = await createEndpoint(
      db,
      creationDeps,
      {
        id: seller.sellerId,
        nearAccountId: seller.nearAccountId,
      },
      request,
    );

    log.info(
      {
        code: "endpoint_created",
        endpointId: created.endpoint.id,
        active: created.endpoint.active,
        warnings: created.endpoint.creationWarnings.length,
      },
      "dashboard endpoint created",
    );

    return c.json({ endpoint: created.endpoint, checks: created.checks }, 201);
  });

  return app;
}
