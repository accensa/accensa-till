import { type OverviewDto, overviewDtoSchema } from "@till/core/schemas";
import { describe, expect, it } from "vitest";

import { assetRow, netHeldBase, overviewView } from "../lib/overview.ts";

/**
 * The rules behind UI-6's overview (F6), tested as functions. Two things here can be
 * wrong without anyone noticing, and both mislead a seller about money:
 *
 * - a correction that reads as nothing, which is `adjustedAmount` clamped to zero or
 *   blanked out; and
 * - an absence that reads as a clean book, which is a failed read or a signed-out
 *   session drawing the same screen as an empty ledger.
 *
 * The arithmetic is checked past `Number.MAX_SAFE_INTEGER` because the DTO carries
 * six-decimal base units, so 9.007e9 USDC is a balance a busy account can reach and the
 * point at which a `Number` version of `lib/overview.ts` starts being quietly wrong
 * (hard rule 3).
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

/** Parsed rather than cast, so an ordinary fixture cannot drift from what the API sends. */
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

function overviewOf(rows: readonly Row[], counts: Partial<OverviewDto> = {}): OverviewDto {
  return {
    byAsset: [...rows],
    openDiscrepancies: counts.openDiscrepancies ?? 0,
    servedUnsettledCount: counts.servedUnsettledCount ?? 0,
  };
}

const ok = (rows: readonly Row[], counts?: Partial<OverviewDto>) =>
  overviewView({ kind: "ok", overview: overviewOf(rows, counts ?? {}) });

const textOf = (result: Parameters<typeof overviewView>[0]): string =>
  overviewView(result)
    .lines.map((line) => line.text)
    .join(" ");

describe("the held figure, on bigint (UI-6)", () => {
  it("is settled plus adjusted, minus what left as payouts and refunds", () => {
    // 1.25 settled, a 0.25 correction taken back, 1.00 paid out, 0.05 refunded.
    expect(netHeldBase(parsedRow({ adjustedAmount: "-250000" }))).toBe(-50000n);
  });

  it("stays exact past the point a float starts rounding", () => {
    // 9007199254740993 is 2^53 + 1: `Number` collapses it to ...992, so a float
    // subtraction lands on ...991 and prints a held figure two units wrong with the
    // confidence of a number nobody measured.
    const held = parsedRow({
      settledAmount: "9007199254740993",
      paidOutAmount: "1",
      refundedAmount: "0",
    });
    expect(netHeldBase(held)).toBe(9007199254740992n);
    expect(ok([held]).rows[0]?.netHeld).toBe("9007199254.740992");
  });

  it("goes negative when the corrections outweigh what settled", () => {
    // Legitimate: an adjustment can claw back more than the asset has in, and the minus
    // is the fact. Clamping it would be the dashboard hiding a debit.
    expect(
      netHeldBase(
        parsedRow({
          settledAmount: "1000000",
          adjustedAmount: "-1500000",
          paidOutAmount: "0",
          refundedAmount: "0",
        }),
      ),
    ).toBe(-500000n);
  });

  it("refuses to invent a held figure out of amounts it cannot read", () => {
    // Unbranded literals on purpose: the schema refuses these over HTTP, so the only way
    // one reaches here is a DTO assembled where it did not run. `netHeldBase` answers
    // null rather than throwing, because a throwing cell takes the whole page down.
    expect(netHeldBase({ ...DEFAULT_ROW, settledAmount: "12.5" })).toBeNull();
    expect(netHeldBase({ ...DEFAULT_ROW, refundedAmount: "" })).toBeNull();
    expect(netHeldBase({ ...DEFAULT_ROW, adjustedAmount: "1e6" })).toBeNull();
  });

  it("does not subtract the in-transit figure, which is not this asset's money", () => {
    // Core's comment on `inTransitAmount`: it is counted from the payments, and a
    // cross-chain payout arrives later in the destination asset. Folding it in here would
    // make the held column equal no set of ledger rows at all.
    expect(netHeldBase(parsedRow({ inTransitAmount: "0" }))).toBe(
      netHeldBase(parsedRow({ inTransitAmount: "999999999" })),
    );
  });
});

describe("a correction that is not zero (UI-6)", () => {
  it("renders a negative adjustment with its minus sign", () => {
    expect(ok([parsedRow({ adjustedAmount: "-250000" })]).rows[0]?.adjusted).toBe("-0.25");
  });

  it("neither clamps it to zero nor blanks it out", () => {
    const adjusted = ok([parsedRow({ adjustedAmount: "-1" })]).rows[0]?.adjusted;
    expect(adjusted).not.toBe("0");
    expect(adjusted).not.toBe("—");
    expect(adjusted).toBe("-0.000001");
  });

  it("keeps a positive adjustment positive, so the sign is the whole correction", () => {
    expect(ok([parsedRow({ adjustedAmount: "250000" })]).rows[0]?.adjusted).toBe("0.25");
  });

  it("carries the correction into the held figure instead of dropping it", () => {
    // 1.25 settled, 1.00 paid out and 0.05 refunded, then -0.25 and -0.30 of correction.
    expect(ok([parsedRow({ adjustedAmount: "-250000" })]).rows[0]?.netHeld).toBe("-0.05");
    expect(ok([parsedRow({ adjustedAmount: "-300000" })]).rows[0]?.netHeld).toBe("-0.1");
  });
});

describe("an amount that is not an amount (UI-6)", () => {
  it("shows a malformed total as a dash, never as a plausible number", () => {
    const formatted = assetRow({
      ...DEFAULT_ROW,
      settledAmount: "1.5x",
      refundedAmount: "",
      adjustedAmount: "",
    });
    expect([formatted.settled, formatted.refunded, formatted.adjusted, formatted.netHeld]).toEqual([
      "—",
      "—",
      "—",
      "—",
    ]);
    // The cells that were readable stay readable: a dash is about one amount, not about
    // the row, and a vanished row would claim an asset the seller does not have.
    expect(formatted.inTransit).toBe("0.25");
    expect(formatted.paidOut).toBe("1");
  });

  it("formats every row it could read beside one it could not", () => {
    const view = ok([
      parsedRow(),
      parsedRow({
        asset: "eurc.testnet",
        settledAmount: "300",
        inTransitAmount: "0",
        paidOutAmount: "0",
        refundedAmount: "0",
      }),
    ]);
    expect(view.rows.map((r) => [r.asset, r.netHeld])).toEqual([
      ["usdc.testnet", "0.2"],
      ["eurc.testnet", "0.0003"],
    ]);
    expect(view.rows[1]?.paidOut).toBe("0");
  });
});

describe("the states that are not a table (UI-6)", () => {
  it("says a seller with no settled payment has none, and says what that means", () => {
    const view = ok([]);
    expect(view.rows).toHaveLength(0);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]?.tone).toBe("ok");
    expect(textOf({ kind: "ok", overview: overviewOf([]) })).toMatch(/No settled payment/);
    expect(view.alert).toBe(false);
  });

  it("words a signed-out seller as their own sentence, with no figures in it", () => {
    const view = overviewView({ kind: "signed_out" });
    expect(view.rows).toHaveLength(0);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0]?.tone).toBe("unknown");
    expect(textOf({ kind: "signed_out" })).toMatch(/sign in/i);
    // Not the empty-ledger sentence: "no session" and "the ledger is empty" are different
    // facts, and the second is a claim about the seller's money that nobody read.
    expect(textOf({ kind: "signed_out" })).not.toMatch(/No settled payment/);
  });

  it("words an unreachable read differently from a signed-out one", () => {
    const down = textOf({
      kind: "unreachable",
      detail: "An overview on record is not one Till can read, so none is shown.",
    });
    expect(down).not.toBe(textOf({ kind: "signed_out" }));
    expect(down).toMatch(/could not be reached/);
    // The API's own sentence rides along, because the unreadable totals are the fact.
    expect(down).toContain("not one Till can read");
    expect(overviewView({ kind: "unreachable", detail: "x" }).lines[0]?.tone).toBe("unknown");
  });

  it("never draws either failure as an empty ledger", () => {
    for (const result of [
      { kind: "signed_out" } as const,
      { kind: "unreachable", detail: "socket closed" } as const,
    ]) {
      const view = overviewView(result);
      expect(textOf(result)).not.toMatch(/No settled payment|no totals to add up/);
      expect(view.rows).toHaveLength(0);
      // Neither is a warning about the seller's book: both are facts about Till.
      expect(view.alert).toBe(false);
    }
  });

  it("raises an alert for open discrepancies and for served-but-unsettled calls", () => {
    expect(ok([parsedRow()]).alert).toBe(false);

    const discrepancies = ok([parsedRow()], { openDiscrepancies: 2 });
    expect(discrepancies.alert).toBe(true);
    expect(discrepancies.lines.some((line) => line.text.includes("2 open discrepancies"))).toBe(
      true,
    );

    const unsettled = ok([parsedRow()], { servedUnsettledCount: 1 });
    expect(unsettled.alert).toBe(true);
    expect(unsettled.lines.some((line) => line.text.includes("1 served call"))).toBe(true);
  });

  it("states the asset count it was given rather than one of its own", () => {
    expect(ok([parsedRow(), parsedRow({ asset: "eurc.testnet" })]).lines[0]?.text).toContain(
      "2 assets",
    );
    expect(ok([parsedRow()]).lines[0]?.text).toContain("1 asset");
  });

  it("says nothing about thresholds it was not given", () => {
    // UI-6 owns no ceiling and no interval; a warning invented here would be the
    // dashboard judging the seller's book by a rule Till never set.
    expect(
      textOf({ kind: "ok", overview: overviewOf([parsedRow({ settledAmount: "1" })]) }),
    ).not.toMatch(/Warning:|below/);
  });
});
