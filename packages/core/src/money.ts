/**
 * Money is integer base units end to end (AGENTS.md hard rule 3, D9). Never a
 * float, never `number`. Payout assets are 6-decimal stablecoins only.
 */

export const STABLECOIN_DECIMALS = 6;

export type BaseUnitAmount = bigint;

function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`unsupported decimals: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

/** "1.25" -> 1250000n at 6 decimals. Rejects anything a float would round. */
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
 */
export function isShortfall(
  amountIn: BaseUnitAmount,
  amountOut: BaseUnitAmount,
  toleranceBps: number,
): boolean {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0) {
    throw new RangeError(`toleranceBps must be a non-negative integer: ${toleranceBps}`);
  }
  return amountOut * 10000n < amountIn * BigInt(10000 - toleranceBps);
}
