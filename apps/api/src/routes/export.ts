/**
 * Ledger CSV export (LR-7, P1). Decimal units, one row per ledger entry, opens in a spreadsheet.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";

import { SESSION_COOKIE, formatAmount } from "@till/core";

import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import { type SessionClaims, createSessionCodec } from "../lib/session.ts";
import { type LedgerExportRow, listLedgerForExport } from "../services/ledger.ts";

export type ExportSessionReader = (cookie: string | undefined) => Promise<SessionClaims | null>;

export type ExportRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  readonly session?: ExportSessionReader;
};

/**
 * Neutralizes spreadsheet formula injection (CSV injection) while preserving
 * valid numeric signs for amounts.
 */
export function escapeCsvField(value: string, isNumeric = false): string {
  let v = value;
  if (!isNumeric && /^[=+\-@\t\r]/.test(v)) {
    // Spreadsheet safety: prepend single quote to neutralize formula injection
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v) || v.startsWith(" ") || v.endsWith(" ")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Converts ledger rows into standard RFC 4180 CSV with CRLF line endings.
 * Amounts are converted from base unit strings (numeric 78,0) to human-readable
 * decimal units using formatAmount (e.g. 1250000 -> 1.25).
 */
export function formatLedgerCsv(rows: readonly LedgerExportRow[]): string {
  const header = "id,created_at,kind,amount,asset,payment_id,swap_id,note";
  const lines = [header];

  for (const row of rows) {
    const decimalAmount = formatAmount(BigInt(row.amount));
    const line = [
      escapeCsvField(row.id),
      escapeCsvField(row.createdAt.toISOString()),
      escapeCsvField(row.kind),
      escapeCsvField(decimalAmount, true),
      escapeCsvField(row.asset),
      escapeCsvField(row.paymentId ?? ""),
      escapeCsvField(row.swapId ?? ""),
      escapeCsvField(row.note ?? ""),
    ].join(",");
    lines.push(line);
  }

  return `${lines.join("\r\n")}\r\n`;
}

export function createExportRoutes(deps: ExportRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const read: ExportSessionReader =
    deps.session ??
    (async (cookie) =>
      cookie === undefined || cookie === "" ? null : await codec.verifySessionCookie(cookie));

  const app = new Hono();

  const handleExport = async (c: import("hono").Context) => {
    const seller = await read(getCookie(c, SESSION_COOKIE));
    if (seller === null) {
      return c.json({ code: "unauthenticated", message: "Sign in to export the ledger." }, 401);
    }

    try {
      const rows = await listLedgerForExport(db, seller.sellerId);
      const csv = formatLedgerCsv(rows);

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="ledger.csv"',
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      log.error({
        code: "ledger_export_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        {
          code: "ledger_export_failed",
          message: "The ledger could not be exported.",
        },
        500,
      );
    }
  };

  app.get("/export/ledger.csv", handleExport);
  app.get("/ledger.csv", handleExport);

  return app;
}
