import { describe, expect, it } from "vitest";
import {
  STABLECOIN_DECIMALS,
  addAmounts,
  formatAmount,
  isShortfall,
  parseAmount,
} from "../money.ts";

/**
 * A6 acceptance: parsing, formatting and the no-float rule. The interesting
 * cases are the ones a `number` would silently round.
 */
describe("parseAmount", () => {
  it("parses display amounts into 6-decimal base units", () => {
    expect(parseAmount("1.25")).toBe(1250000n);
    expect(parseAmount("10")).toBe(10000000n);
    expect(parseAmount("0.000001")).toBe(1n);
    expect(parseAmount("-1.5")).toBe(-1500000n);
    expect(parseAmount(" 2 ")).toBe(2000000n);
  });

  it("honours an explicit decimals argument", () => {
    expect(parseAmount("5", 0)).toBe(5n);
    expect(parseAmount("1.5", 2)).toBe(150n);
  });

  it("keeps precision a float would lose", () => {
    // 9007199254740993.25 is past Number.MAX_SAFE_INTEGER: a `number` cannot
    // hold it, a bigint can (AGENTS.md hard rule 3).
    expect(parseAmount("9007199254740993.25")).toBe(9007199254740993250000n);
    expect(parseAmount("9007199254740993", 0)).toBe(9007199254740993n);
    expect(String(Number("9007199254740993.25"))).not.toBe("9007199254740993.25");
    expect(typeof parseAmount("1")).toBe("bigint");
  });

  it("rejects more decimals than the asset has", () => {
    expect(() => parseAmount("1.2345678")).toThrow(RangeError);
  });

  it("rejects anything that is not a plain decimal amount", () => {
    for (const bad of ["", "abc", "1e9", "1,000", ".5", "1.", "--1", "0x10", "Infinity", "NaN"]) {
      expect(() => parseAmount(bad), bad).toThrow(SyntaxError);
    }
  });

  it("rejects a decimals value it cannot represent", () => {
    expect(() => parseAmount("1", 19)).toThrow(RangeError);
    expect(() => parseAmount("1", -1)).toThrow(RangeError);
  });
});

describe("formatAmount", () => {
  it("formats base units without scientific notation or float rounding", () => {
    expect(formatAmount(1250000n)).toBe("1.25");
    expect(formatAmount(10000000n)).toBe("10");
    expect(formatAmount(1n)).toBe("0.000001");
    expect(formatAmount(0n)).toBe("0");
    expect(formatAmount(-1500000n)).toBe("-1.5");
    expect(formatAmount(5n, 0)).toBe("5");
  });

  it("round-trips every amount it can parse", () => {
    for (const display of ["1.25", "10", "0.000001", "-1.5", "123456.789012"]) {
      expect(formatAmount(parseAmount(display))).toBe(display);
    }
  });

  it("round-trips the whole bigint range it is given", () => {
    const huge = 9007199254740993n * 10n ** BigInt(STABLECOIN_DECIMALS) + 1n;
    expect(parseAmount(formatAmount(huge))).toBe(huge);
  });
});

describe("addAmounts", () => {
  it("sums in integer math", () => {
    expect(addAmounts()).toBe(0n);
    expect(addAmounts(1n, 2n, 3n)).toBe(6n);
    expect(addAmounts(1000000n, -250000n)).toBe(750000n);
  });
});

describe("isShortfall", () => {
  it("compares on integer basis points", () => {
    expect(isShortfall(1000000n, 1000000n, 0)).toBe(false);
    expect(isShortfall(1000000n, 999000n, 100)).toBe(false);
    // exactly at the tolerance is not a shortfall; one unit below is
    expect(isShortfall(1000000n, 990000n, 100)).toBe(false);
    expect(isShortfall(1000000n, 989999n, 100)).toBe(true);
    expect(isShortfall(1000000n, 999000n, 0)).toBe(true);
  });

  it("refuses a tolerance it cannot apply exactly", () => {
    expect(() => isShortfall(1n, 1n, -1)).toThrow(RangeError);
    expect(() => isShortfall(1n, 1n, 1.5)).toThrow(RangeError);
  });
});
