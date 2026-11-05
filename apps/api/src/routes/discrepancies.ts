/**
 * Reconciliation surface (UI-4, F4): the open items, a manual close, and the payers
 * this seller is holding.
 *
 * Read-only apart from the two actions the seller is allowed to take, and each of
 * them is scoped by the session rather than by anything the request says: the item id
 * is looked up *within* the seller's rows, and a clear records the signed-in account
 * as its author. There is no body field for either, so a dashboard cannot be talked
 * into closing somebody else's item or signing a clear it did not make.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import {
  type DiscrepancyDto,
  SESSION_COOKIE,
  nearAccountIdSchema,
  payerBlockClearRequestSchema,
  uuidSchema,
} from "@till/core";

import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import { type SessionClaims, createSessionCodec } from "../lib/session.ts";
import { listOpenDiscrepanciesForSeller, resolveManually } from "../services/discrepancies.ts";
import { clearPayerBlock, listBlockedPayersForSeller } from "../services/strikes.ts";

export type DiscrepancySessionReader = (
  cookie: string | undefined,
) => Promise<SessionClaims | null>;

export type DiscrepancyRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  /** F1's signed-cookie check by default; a test injects a seller instead. */
  readonly session?: DiscrepancySessionReader;
};

export function createDiscrepancyRoutes(deps: DiscrepancyRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const read: DiscrepancySessionReader =
    deps.session ??
    (async (cookie) =>
      cookie === undefined || cookie === "" ? null : await codec.verifySessionCookie(cookie));

  const app = new Hono();

  app.get("/discrepancies", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json(
        { code: "unauthenticated", message: "Sign in to see what needs reconciling." },
        401,
      );
    }

    let items: DiscrepancyDto[];
    try {
      items = await listOpenDiscrepanciesForSeller(db, seller.sellerId);
    } catch (error) {
      // UI-3's rule one table later: a row the contract refuses is a fault in Till's
      // data, so it is an error with a code and not a worklist with one item fewer.
      // A seller who reads a missing item as a resolved one stops looking.
      log.error({
        code: "discrepancy_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "discrepancy_unreadable",
          message: "A discrepancy on record is not one Till can read, so none are shown.",
        },
        500,
      );
    }

    return c.json({ discrepancies: items });
  });

  app.post("/discrepancies/:id/resolve", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to resolve an item." }, 401);
    }

    const id = c.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return c.json(
        { code: "invalid_request", message: "The item to resolve is named by its id." },
        422,
      );
    }

    const resolved = await resolveManually(db, seller.sellerId, id);
    if (resolved === null) {
      // One refusal for "not yours", "already closed" and "never was": which of the
      // three it was would say whether another seller has an open item on this cause.
      return c.json(
        {
          code: "discrepancy_not_found",
          message: "That is not one of your open discrepancies.",
        },
        404,
      );
    }

    return c.json({ discrepancy: resolved });
  });

  app.get("/payer-blocks", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to see blocked payers." }, 401);
    }

    try {
      return c.json({ payerBlocks: await listBlockedPayersForSeller(db, seller.sellerId) });
    } catch (error) {
      log.error({
        code: "payer_block_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "payer_block_unreadable",
          message: "A blocked payer on record is not one Till can read, so none are shown.",
        },
        500,
      );
    }
  });

  app.post("/payer-blocks/:payerAccountId/clear", async (c) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to clear a block." }, 401);
    }

    const payerAccountId = c.req.param("payerAccountId");
    if (!nearAccountIdSchema.safeParse(payerAccountId).success) {
      return c.json(
        { code: "invalid_request", message: "The payer is named by its NEAR account id." },
        422,
      );
    }

    // No `clearedBy` is read from the body, and none is needed: the session signed
    // this, and that is the fact the audit trail asks for.
    const body: unknown = await c.req.json().catch(() => null);
    const note = payerBlockClearRequestSchema.safeParse(body ?? {});
    if (!note.success) {
      return c.json(
        { code: "invalid_request", message: "A clear takes a note of 200 characters or fewer." },
        422,
      );
    }

    await clearPayerBlock(db, {
      payerAccountId,
      sellerId: seller.sellerId,
      clearedBy: seller.nearAccountId,
      ...(note.data.note === undefined ? {} : { note: note.data.note }),
    });

    // The answer *is* the read, not a restatement of one payer's row: after a
    // watermark the strikes that count are a query, and a claimed `lastStrikeAt`
    // here would be a guess about whatever the payer did in the meantime.
    try {
      return c.json({ payerBlocks: await listBlockedPayersForSeller(db, seller.sellerId) });
    } catch (error) {
      log.error({
        code: "payer_block_unreadable",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "payer_block_unreadable",
          message: "A blocked payer on record is not one Till can read, so none are shown.",
        },
        500,
      );
    }
  });

  return app;
}
