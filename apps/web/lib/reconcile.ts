import type { DiscrepancyDto } from "@till/core/schemas";

/**
 * The words behind the reconciliation screen (UI-4, F4), as plain functions so they
 * are testable without a browser — the same split `payments.ts` makes.
 *
 * These are the only sentences on the page that Till's dashboard writes. A finding's
 * explanation and suggested action arrive as text from the rule that raised it (LR-4),
 * and the strikes and thresholds are computed in the API, so copy here must not
 * restate either: a second truth is one that can disagree.
 */

/**
 * One phrase per severity, in the seller's terms rather than the enum's.
 *
 * Typed by `DiscrepancyDto["severity"]` — the wire contract, not a list written out
 * here — so a severity added in core is a compile error rather than a badge that
 * renders `undefined`.
 */
export function severityWords(): Readonly<Record<DiscrepancyDto["severity"], string>> {
  return {
    critical: "Needs you now",
    high: "Needs you today",
    medium: "Needs a look",
    low: "Worth knowing",
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long the item has been open, rounded down.
 *
 * `nowMs` is a parameter and not a `Date.now()` call for the same reason the reconcile
 * rules take `now` from the database: a page that reads its own clock cannot be
 * tested against a fixed row, and the two clocks are not the same clock anyway. An
 * item that looks like it opened in the future is this second old — "0 min ago" or a
 * negative age would be the page claiming knowledge it does not have.
 */
export function discrepancyAge(openedAt: string, nowMs: number): string {
  const ageMs = nowMs - Date.parse(openedAt);
  if (!Number.isFinite(ageMs) || ageMs < MINUTE_MS) {
    return "just now";
  }
  if (ageMs < HOUR_MS) {
    return `${Math.floor(ageMs / MINUTE_MS)} min old`;
  }
  if (ageMs < DAY_MS) {
    return `${Math.floor(ageMs / HOUR_MS)} h old`;
  }
  return `${Math.floor(ageMs / DAY_MS)} d old`;
}

/** An empty worklist is the good news, so it is not drawn with the fault's wording. */
export const NO_DISCREPANCY_COPY =
  "Nothing to reconcile — every serve Till has a record of matches what settled.";

/** No payer is held, which is the same kind of news. */
export const NO_BLOCKED_PAYER_COPY = "No payer is being held.";

/**
 * What a hold means, with no number in it: `STRIKE_WINDOW_HOURS` and
 * `STRIKE_THRESHOLD` live in the API and C9 can retune them, so the screen says
 * "while they still count" and lets each row state its own count.
 */
export const HELD_PAYER_EXPLAINED =
  "A payer that bought, was served and never settled is held here while its unpaid serves still count. Lifting a hold lets that payer buy from you again, and records who lifted it.";
