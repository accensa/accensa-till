/**
 * Money is integer base units end to end (AGENTS.md hard rule 3, D9). Never a
 * float, never `number`. Payout assets are 6-decimal stablecoins only.
 */

export const STABLECOIN_DECIMALS = 6;

/**
 * Basis points in a whole amount. Used as an exclusive ceiling: a tolerance of
 * this much tolerates the entire payment, so it can find no shortfall (G6 F4).
 */
export const MAX_TOLERANCE_BPS = 10_000;

export type BaseUnitAmount = bigint;

function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`unsupported decimals: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

/**
 * "1.25" -> 1250000n at 6 decimals. Rejects anything a float would round.
 *
 * Signed by design, and not a place to put the G6 F1 positivity rule: this is the
 * inverse of `formatAmount`, which formats negatives, so the round trip
 * `parseAmount(formatAmount(x))` only holds for the whole bigint range if both ends
 * accept the sign. Positivity is enforced where the value crosses a boundary.
 */
export function parseAmount(display: string, decimals = STABLECOIN_DECIMALS): BaseUnitAmount {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(display.trim());
  if (match === null) {
    throw new SyntaxError(`not an amount: ${display}`);
  }
  const [, sign = "", whole, fraction = ""] = match;
  const [intPart, fracPart] = [whole, fraction] as const;
  if (intPart === undefined) {
    throw new SyntaxError(`not an amount: ${display}`);
  }
  if (fracPart !== undefined && fracPart.length > decimals) {
    throw new RangeError(`${display} has more than ${decimals} decimal places`);
  }
  const padded = (fracPart ?? "").padEnd(decimals, "0");
  const base = BigInt(intPart) * pow10(decimals) + BigInt(padded || "0");
  return sign === "-" ? -base : base;
}

/** 1250000n -> "1.25". Trailing zeros trimmed; no float involved. */
export function formatAmount(base: BaseUnitAmount, decimals = STABLECOIN_DECIMALS): string {
  if (decimals === 0) {
    return base.toString();
  }
  const unit = pow10(decimals);
  const negative = base < 0n;
  const abs = negative ? -base : base;
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac === "" ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

export function addAmounts(...amounts: readonly BaseUnitAmount[]): BaseUnitAmount {
  return amounts.reduce((total, amount) => total + amount, 0n);
}

/**
 * Shortfall test without multiplying by a float tolerance:
 * out < in * (1 - bps/10000)  <=>  out * 10000 < in * (10000 - bps)
 *
 * The ceiling is where a whole amount ends, exclusive: at 10000 bps the tolerance *is*
 * the amount and nothing can be a shortfall, and past it `10000 - bps` goes negative, so
 * the comparison would report a shortfall only for a payment below zero. Either way the
 * rule stops working in silence, which is why an out-of-range tolerance throws (G6 F4).
 */
export function isShortfall(
  amountIn: BaseUnitAmount,
  amountOut: BaseUnitAmount,
  toleranceBps: number,
): boolean {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps >= MAX_TOLERANCE_BPS) {
    throw new RangeError(
      `toleranceBps must be an integer from 0 to ${MAX_TOLERANCE_BPS - 1}: ${toleranceBps}`,
    );
  }
  return amountOut * 10000n < amountIn * BigInt(MAX_TOLERANCE_BPS - toleranceBps);
}
