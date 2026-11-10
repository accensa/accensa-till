import { type OverviewDto, overviewDtoSchema } from "@till/core/schemas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewTotals } from "../components/domain/OverviewTotals.tsx";
import type { OverviewResult } from "../lib/api-client.ts";

/**
 * The overview screen (UI-6, F6), rendered and read as the text a seller is served, the
 * way `render-payments.test.tsx` and `header.test.tsx` read theirs. There is no browser
 * framework in this repository and adding one is a human dependency decision (hard rule
 * 10), so the markup is the surface.
 *
 * What is pinned is the markup that can lie: a correction that prints as zero, a
 * malformed amount that prints as a number, and a failed read that prints as the same
 * empty screen as a ledger with nothing in it. The arithmetic is `overview.test.ts`'s;
 * this file is about what reaches the page.
 */

const DEFAULT_ROW = {
  asset: "usdc.testnet",
  settledAmount: "1250000",
  inTransitAmount: "250000",
  paidOutAmount: "1000000",
  refundedAmount: "50000",
  adjustedAmount: "0",
};

type Row = OverviewDto["byAsset"][number];
type WireRow = { readonly [K in keyof typeof DEFAULT_ROW]: string };

function parsedRow(overrides: Partial<WireRow> = {}): Row {
  const parsed = overviewDtoSchema.safeParse({
    byAsset: [{ ...DEFAULT_ROW, ...overrides }],
    openDiscrepancies: 0,
    servedUnsettledCount: 0,
  });
  if (!parsed.success) {
    throw new Error("a fixture the contract refuses is a broken test, not a screen");
  }
  const [first] = parsed.data.byAsset;
  if (first === undefined) {
    throw new Error("the fixture parsed no rows");
  }
  return first;
}

/**
 * A row whose amounts are branded by assertion rather than by the schema.
 *
 * `overviewDtoSchema` refuses `"1.5x"` and `""` over HTTP, so a cell like this only
 * reaches a screen when a DTO is assembled where the schema did not run. It is built
 * rather than imagined because the em dash is the whole answer to it, and a dash is only
 * evidence once it is actually on the page.
 */
function rawRow(amounts: WireRow): Row {
  return {
    asset: amounts.asset,
    settledAmount: amounts.settledAmount as Row["settledAmount"],
    inTransitAmount: amounts.inTransitAmount as Row["inTransitAmount"],
    paidOutAmount: amounts.paidOutAmount as Row["paidOutAmount"],
    refundedAmount: amounts.refundedAmount as Row["refundedAmount"],
    adjustedAmount: amounts.adjustedAmount as Row["adjustedAmount"],
  };
}

function overviewOf(rows: readonly Row[], counts: Partial<OverviewDto> = {}): OverviewDto {
  return {
    byAsset: [...rows],
    openDiscrepancies: counts.openDiscrepancies ?? 0,
    servedUnsettledCount: counts.servedUnsettledCount ?? 0,
  };
}

function markup(result: OverviewResult): string {
  return renderToStaticMarkup(<OverviewTotals result={result} />);
}

function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The data cells in the order the table prints them.
 *
 * Read out of the markup rather than from `overviewView` because the point is the column
 * order a seller reads left to right: an amount in the wrong column is a different total,
 * and no amount of unit-testing the helper would notice.
 */
function cells(html: string): string[][] {
  return [...html.matchAll(/<tr class="border-t"[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => words(cell[1] ?? "")),
  );
}

const OK_RESULT: OverviewResult = { kind: "ok", overview: overviewOf([parsedRow()]) };

describe("the per-asset table (UI-6, F6)", () => {
  it("prints the ledger's five totals and the figure they leave, in decimal units", () => {
    expect(cells(markup(OK_RESULT))).toEqual([
      ["usdc.testnet", "1.25", "0.25", "1", "0.05", "0", "0.2"],
    ]);
    // The base units the wire carries never reach a seller's eye.
    expect(markup(OK_RESULT)).not.toContain("1250000");
  });

  it("heads every column, so a number is not a guess about which total it is", () => {
    const page = markup(OK_RESULT);
    for (const heading of [
      "Asset",
      "Settled",
      "In transit",
      "Paid out",
      "Refunded",
      "Adjusted",
      "Net held",
    ]) {
      expect(page).toContain(heading);
    }
  });

  it("gives every asset its own row and says how many there are", () => {
    const page = markup({
      kind: "ok",
      overview: overviewOf([parsedRow(), parsedRow({ asset: "eurc.testnet" })]),
    });
    expect(words(page)).toContain("2 assets");
    expect(cells(page).map((row) => row[0])).toEqual(["usdc.testnet", "eurc.testnet"]);
  });

  it("prints a correction's minus sign, in its own cell and in the held figure", () => {
    // 1.25 settled, 1.00 paid out, 0.05 refunded, and a 0.25 correction taken back: the
    // correction is a subtraction, so the held column has to move with it.
    expect(
      cells(
        markup({ kind: "ok", overview: overviewOf([parsedRow({ adjustedAmount: "-250000" })]) }),
      ),
    ).toEqual([["usdc.testnet", "1.25", "0.25", "1", "0.05", "-0.25", "-0.05"]]);

    // Past zero: a correction that outweighs the asset is a debit Till has to show, not
    // a cell it gets to round up to nothing.
    expect(
      cells(
        markup({ kind: "ok", overview: overviewOf([parsedRow({ adjustedAmount: "-300000" })]) }),
      ),
    ).toEqual([["usdc.testnet", "1.25", "0.25", "1", "0.05", "-0.3", "-0.1"]]);
  });

  it("prints an amount it cannot read as a dash, never as a plausible number", () => {
    const page = markup({
      kind: "ok",
      overview: overviewOf([rawRow({ ...DEFAULT_ROW, settledAmount: "1.5x", refundedAmount: "" })]),
    });
    expect(cells(page)).toEqual([["usdc.testnet", "—", "0.25", "1", "—", "0", "—"]]);
    // The unreadable string is not print money, and no zero stands in for it.
    expect(page).not.toContain("1.5x");
  });

  it("keeps the readable cells of a broken row on the page", () => {
    // Dropping the row would tell the seller they hold no such asset, which is a far
    // bigger claim than the dash makes.
    const page = markup({
      kind: "ok",
      overview: overviewOf([rawRow({ ...DEFAULT_ROW, paidOutAmount: "one million" })]),
    });
    expect(cells(page)).toEqual([["usdc.testnet", "1.25", "0.25", "—", "0.05", "0", "—"]]);
  });
});

describe("what the screen says when it cannot show a table (UI-6, F6)", () => {
  it("sends a signed-out seller to sign in without touching their numbers", () => {
    const page = markup({ kind: "signed_out" });
    expect(page).not.toContain("<table");
    expect(words(page)).toMatch(/sign in/i);
    expect(words(page)).not.toMatch(/No settled payment|usdc/);
    expect(page).not.toContain('role="alert"');
  });

  it("quotes why an unreadable read failed, and claims nothing about the ledger", () => {
    const page = markup({
      kind: "unreachable",
      detail: "An overview on record is not one Till can read, so none is shown.",
    });
    expect(page).not.toContain("<table");
    expect(words(page)).toContain("not one Till can read");
    expect(words(page)).toMatch(/claims nothing/);
    // The sentence the signed-out seller reads is not the one this seller reads.
    expect(words(page)).not.toMatch(/sign in/i);
  });

  it("says an empty ledger is empty, which is a third thing", () => {
    const page = markup({ kind: "ok", overview: overviewOf([]) });
    expect(page).not.toContain("<table");
    expect(words(page)).toMatch(/No settled payment on record/);
    expect(words(page)).not.toMatch(/sign in|could not be reached|claims nothing/i);
  });

  it("raises an alert only over the two counts the seller can act on", () => {
    expect(markup(OK_RESULT)).not.toContain('role="alert"');

    const work = markup({
      kind: "ok",
      overview: overviewOf([parsedRow()], { openDiscrepancies: 3, servedUnsettledCount: 1 }),
    });
    expect(work).toContain('role="alert"');
    expect(words(work)).toContain("3 open discrepancies");
    expect(words(work)).toContain("1 served call settled no payment");
    // The table is still there under the warning: the totals were read, the work is open.
    expect(work).toContain("<table");

    expect(markup({ kind: "unreachable", detail: "socket closed" })).not.toContain('role="alert"');
  });
});
