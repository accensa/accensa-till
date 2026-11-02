import { baseUnitAmountSchema, formatAmount, toBaseUnits } from "@till/core";

/**
 * Base units arrive over the wire as decimal strings (schemas/common.ts) and are
 * parsed to bigint through the branded schema — never through `Number`, and never
 * with a cast, which is what keeps AGENTS.md hard rule 3 enforceable at the edge
 * where a human sees the money.
 */
export function displayAmount(amount: string, decimals = 6): string {
  const parsed = baseUnitAmountSchema.safeParse(amount);
  if (!parsed.success) {
    // A malformed amount must not render as a plausible number.
    return "—";
  }
  return formatAmount(toBaseUnits(parsed.data), decimals);
}

/** "1.25 USDC" — the symbol is display-only; the asset contract id is the truth. */
export function displayAmountWithSymbol(amount: string, symbol: string): string {
  return `${displayAmount(amount)} ${symbol}`;
}

export function displayDate(iso: string | null): string {
  if (iso === null) {
    return "—";
  }
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}
