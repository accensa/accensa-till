import type { PayoutPollDto, RelayerBalanceDto } from "@till/core/schemas";

import type { StatusResult } from "./api-client.ts";

/**
 * The header's two sentences (UI-5, F5), as a plain function so the warning is
 * assertable without a browser — the same split `payments.ts` and `reconcile.ts` make.
 *
 * Nothing measured happens here. `alertBelow` and `staleAfterSeconds` arrive beside
 * the values they judge, the poll age arrives already counted against the database's
 * clock, and the balance arrives in yoctoNEAR, so this file compares and words those
 * facts and owns no threshold, no interval and no clock of its own. Retuning
 * `RELAYER_BALANCE_ALERT_BASE_UNITS` or `POLL_INTERVAL_SECONDS` changes what a seller
 * reads without changing a line here.
 *
 * Three tones, and the third is the reason the contract changed shape. `warn` is a
 * fact past a threshold; `unknown` is Till's own inability to look. The old DTO could
 * not carry the second one, so an unreachable RPC arrived as a balance of `0` — a
 * sentence that sends a seller to top up a relayer that may be full.
 */

/** `ok` states the fact, `warn` states it past a threshold, `unknown` states that nobody looked. */
export type HeaderTone = "ok" | "warn" | "unknown";

export type HeaderLine = { readonly tone: HeaderTone; readonly text: string };

export type HeaderView = {
  readonly lines: readonly HeaderLine[];
  /** True when a line crosses a threshold the seller can act on — never for `unknown`. */
  readonly alert: boolean;
};

/** YoctoNEAR per NEAR, as a digit count. Used only to place a decimal point. */
const YOCTO_DECIMALS = 24;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * YoctoNEAR to NEAR, exactly.
 *
 * Written on the decimal string instead of through `displayAmount`: that helper
 * rescales through `Number`, which is fine for a six-decimal token and would word two
 * balances one yoctoNEAR apart identically — the pair UI-5 exists to tell apart. Money
 * stays `bigint` here as it does everywhere else (hard rule 3).
 */
function formatNear(baseUnits: string): string {
  const digits = baseUnits.padStart(YOCTO_DECIMALS + 1, "0");
  const cut = digits.length - YOCTO_DECIMALS;
  const whole = digits.slice(0, cut).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(cut).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

function unit(count: number, name: string): string {
  return `${count} ${name}${count === 1 ? "" : "s"}`;
}

/**
 * A duration in whole seconds, in the one unit a seller reads.
 *
 * Floored, never rounded: 299 s is still "4 minutes", because an age that rounds up
 * claims the answer is younger than it is.
 */
function humanAge(seconds: number): string {
  if (seconds >= DAY_SECONDS) {
    return unit(Math.floor(seconds / DAY_SECONDS), "day");
  }
  if (seconds >= HOUR_SECONDS) {
    return unit(Math.floor(seconds / HOUR_SECONDS), "hour");
  }
  if (seconds >= MINUTE_SECONDS) {
    return unit(Math.floor(seconds / MINUTE_SECONDS), "minute");
  }
  return unit(seconds, "second");
}

function relayerLine(relayer: RelayerBalanceDto): HeaderLine {
  const ceiling = `${formatNear(relayer.alertBelow)} NEAR`;
  if (relayer.state === "unreadable") {
    return {
      tone: "unknown",
      text: `Relayer balance unknown: the chain RPC did not answer for ${relayer.accountId} on ${relayer.network}.`,
    };
  }
  if (relayer.state === "account_missing") {
    return {
      tone: "warn",
      text: `Warning: relayer account ${relayer.accountId} is not on ${relayer.network}, so Till cannot sponsor any gas.`,
    };
  }
  if (relayer.amount === null) {
    // `ok` without an amount is a payload the API's schema refuses, so this line is
    // only reachable for a `StatusDto` built somewhere else. It reads as unknown,
    // because the alternative is a balance of nothing.
    return {
      tone: "unknown",
      text: `Relayer balance unknown: no amount came with the read for ${relayer.accountId}.`,
    };
  }
  const shown = `${formatNear(relayer.amount)} NEAR`;
  // `bigint` against `bigint`, and at the ceiling: "below" is the operator's word, and
  // a relayer sitting exactly on it has not crossed anything.
  return BigInt(relayer.amount) < BigInt(relayer.alertBelow)
    ? {
        tone: "warn",
        text: `Warning: ${shown} in the relayer, under the ${ceiling} Till alerts below.`,
      }
    : { tone: "ok", text: `Relayer balance ${shown}, alerts below ${ceiling}.` };
}

function pollLine(polls: PayoutPollDto): HeaderLine {
  if (polls.state === "no_swaps") {
    return {
      tone: "ok",
      text: `No payouts tracked yet, so there is no ${polls.provider} poll to age.`,
    };
  }
  if (polls.state === "never_polled") {
    return {
      tone: "warn",
      text: `Warning: ${polls.swaps} payout swap${
        polls.swaps === 1 ? "" : "s"
      } have never been answered by ${polls.provider}, so what the screen says about them is what the last write left.`,
    };
  }
  if (polls.lastPolledAt === null || polls.ageSeconds === null) {
    return {
      tone: "unknown",
      text: `Provider poll unknown: ${polls.provider} has swaps on record and no answer time to age.`,
    };
  }
  const age = humanAge(polls.ageSeconds);
  const window = humanAge(polls.staleAfterSeconds);
  return polls.ageSeconds > polls.staleAfterSeconds
    ? {
        tone: "warn",
        text: `Warning: ${polls.provider} last answered ${age} ago, past the ${window} Till treats as silent.`,
      }
    : {
        tone: "ok",
        text: `${polls.provider} last answered ${age} ago; ${window} without an answer is treated as silent.`,
      };
}

export function headerView(result: StatusResult): HeaderView {
  if (result.kind === "ok") {
    const lines = [relayerLine(result.status.relayer), pollLine(result.status.payouts)];
    return { lines, alert: lines.some((line) => line.tone === "warn") };
  }
  // One line each, and neither a warning: a header that cannot ask is not evidence
  // that something is wrong with the seller's relayer or with a provider.
  const text =
    result.kind === "signed_out"
      ? "No session yet, so Till cannot say what its relayer holds or when a provider last answered — sign in to see them."
      : `Till could not be reached, so the header claims nothing about its state (${result.detail}).`;
  return { lines: [{ tone: "unknown", text }], alert: false };
}
