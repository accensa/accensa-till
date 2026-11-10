import { type OverviewDto, baseUnitAmountSchema } from "@till/core/schemas";

import type { OverviewResult } from "./api-client.ts";
import { displayAmount } from "./format.ts";

/**
 * The overview's sentences and per-asset figures (UI-6, F6), as a plain function over
 * the API result so they are assertable without a browser — the same split
 * `header-status.ts` makes.
 *
 * Nothing measured happens here. The five totals per asset, the open discrepancy count
 * and the served-unsettled count all arrive from the ledger query in the API; this file
 * words them and does one piece of presentation arithmetic (`netHeld` below). Retuning
 * what the API sums changes what a seller reads without changing a line here.
 *
 * Four states, and the last two are the reason the read has three answers. A seller
 * who cannot reach Till and a seller who has never been paid both have no rows, and the
 * dashboard must not give them the same screen: an absence drawn as "nothing to report"
 * is the dashboard lying about Till's numbers (AGENTS.md, and the rule every other read
 * here follows). So `empty` is a fact about the ledger, `unreachable` a fact about Till,
 * `signed_out` a fact about the session, and each carries its own sentence.
 */

/** `ok` states a fact, `warn` states one the seller can act on, `unknown` states that nobody looked. */
export type OverviewTone = "ok" | "warn" | "unknown";

export type OverviewLine = { readonly tone: OverviewTone; readonly text: string };

/**
 * The five wire strings a row is made of, before the branding the DTO puts on them.
 *
 * A row off HTTP is `OverviewDto["byAsset"][number]` and satisfies this; an unbranded
 * literal does too, which is how a test can name a malformed amount without a cast
 * (`displayAmount` is what then refuses it, and that refusal is the behaviour being
 * pinned rather than a hypothetical).
 */
export type OverviewAmounts = {
  readonly settledAmount: string;
  readonly inTransitAmount: string;
  readonly paidOutAmount: string;
  readonly refundedAmount: string;
  readonly adjustedAmount: string;
};

export type OverviewAssetRow = {
  readonly asset: string;
  /** The five totals, formatted for a screen. A malformed one arrives as `—`, never as a number. */
  readonly settled: string;
  readonly inTransit: string;
  readonly paidOut: string;
  readonly refunded: string;
  readonly adjusted: string;
  /** What Till still holds for this asset; `—` when the four figures it is made of cannot be read. */
  readonly netHeld: string;
};

export type OverviewView = {
  readonly lines: readonly OverviewLine[];
  /** Empty for every state but `report`. The lines say why, so an empty table is never the whole answer. */
  readonly rows: readonly OverviewAssetRow[];
  /** True when a line crosses something the seller can act on — never for `unknown`. */
  readonly alert: boolean;
};

/**
 * A base-unit string to `bigint`, or `null` when it is not one.
 *
 * `BigInt` would throw on `"1.5x"`, and a throwing render takes the whole dashboard
 * down over one bad cell. The row already shows `—` for an unreadable amount
 * (`displayAmount`); this is the same decision made before the arithmetic rather than
 * after it, so a figure that cannot be parsed cannot become a figure that is merely wrong.
 */
function baseUnits(amount: string): bigint | null {
  const parsed = baseUnitAmountSchema.safeParse(amount);
  return parsed.success ? BigInt(parsed.data) : null;
}

/**
 * `settled + adjusted - paidOut - refunded`, on `bigint` (hard rule 3).
 *
 * Not through `Number`, and not through a float rescale: the DTO carries six-decimal
 * base units, so a seller with more than 2^53 units of them — 9.007e9 USDC, reachable
 * by a busy mainnet account — would have their held figure silently rounded. The sign
 * is kept, because `adjustedAmount` may be negative and its sign *is* the correction
 * (6.1); clamping it to zero would drop the only half of the row that says which way
 * Till moved.
 */
export function netHeldBase(row: OverviewAmounts): bigint | null {
  const settled = baseUnits(row.settledAmount);
  const adjusted = baseUnits(row.adjustedAmount);
  const paidOut = baseUnits(row.paidOutAmount);
  const refunded = baseUnits(row.refundedAmount);
  // `inTransitAmount` is deliberately absent. It is counted from the payments, not from
  // the ledger (overview.ts in core says why: the payout arrives later, in a different
  // asset), so folding it in would subtract a number that is not this asset's money.
  return settled === null || adjusted === null || paidOut === null || refunded === null
    ? null
    : settled + adjusted - paidOut - refunded;
}

export function assetRow(row: OverviewAmounts & { readonly asset: string }): OverviewAssetRow {
  const held = netHeldBase(row);
  return {
    asset: row.asset,
    settled: displayAmount(row.settledAmount),
    inTransit: displayAmount(row.inTransitAmount),
    paidOut: displayAmount(row.paidOutAmount),
    refunded: displayAmount(row.refundedAmount),
    adjusted: displayAmount(row.adjustedAmount),
    netHeld: held === null ? "—" : displayAmount(held.toString()),
  };
}

/**
 * `1 asset` / `3 open discrepancies`.
 *
 * Both forms are passed rather than one general pluraliser: the two nouns this file
 * counts are `asset`/`assets` and `discrepancy`/`discrepancies`, and a rule that turns a
 * `y` into `ies` would be an untested guess about the next noun added here.
 */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function reportLines(overview: OverviewDto): readonly OverviewLine[] {
  const lines: OverviewLine[] = [
    {
      tone: "ok",
      text: `Totals for ${plural(overview.byAsset.length, "asset", "assets")}, summed by Till's own ledger queries. What is in transit is not yet yours to spend.`,
    },
  ];
  // One line each, and only when non-zero: these two counts are the seller's open work,
  // and a totals table that quietly sits above them reads as a clean book.
  if (overview.openDiscrepancies > 0) {
    lines.push({
      tone: "warn",
      text: `Warning: ${plural(overview.openDiscrepancies, "open discrepancy", "open discrepancies")} still unresolved, so at least one figure below matches no set of ledger rows Till agrees with.`,
    });
  }
  if (overview.servedUnsettledCount > 0) {
    lines.push({
      tone: "warn",
      text: `Warning: ${plural(overview.servedUnsettledCount, "served call", "served calls")} settled no payment, so the money for them is not in these totals.`,
    });
  }
  return lines;
}

export function overviewView(result: OverviewResult): OverviewView {
  if (result.kind === "ok") {
    const rows = result.overview.byAsset.map(assetRow);
    if (rows.length > 0) {
      const lines = reportLines(result.overview);
      return { lines, rows, alert: lines.some((line) => line.tone === "warn") };
    }
    // Its own state rather than a table with no rows in it: this is the one screen that
    // can honestly say "the ledger is empty", and it has to say so out loud, because
    // every failure below also produces zero rows.
    return {
      lines: [
        {
          tone: "ok",
          text: "No settled payment on record, so Till has no totals to add up. Nothing has bought a call from this account yet.",
        },
      ],
      rows,
      alert: false,
    };
  }

  const text =
    result.kind === "signed_out"
      ? "No session yet, so Till cannot add up its own ledger — sign in to see the totals by asset."
      : `Till could not be reached, so this page claims nothing about its numbers (${result.detail}).`;
  return {
    lines: [{ tone: "unknown", text }],
    rows: [],
    alert: false,
  };
}
