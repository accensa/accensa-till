import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";

import {
  type BaseUnitAmount,
  type SwapState,
  baseUnitAmountSchema,
  canTransitionSwap,
  isTerminalSwapState,
  normalizeSwapState,
} from "@till/core";

import type { Db } from "../db/client.ts";
import { payments, payoutRoutes, swaps } from "../db/schema.ts";
import type { Logger } from "../lib/logger.ts";
import type { NormalizedSwap, PayoutProvider } from "../payouts/provider.ts";
import { recordPayoutOut, recordRefundIn } from "../services/ledger.ts";
import { linkSwapByHash } from "../services/swaps.ts";

/**
 * Poll provider statuses into `swaps` (D6, PO-4).
 *
 * Three rules decide the whole shape of this file, and each of them is a refusal to
 * do something a poller easily could:
 *
 * - **Terminal is sticky** (PO-4, D1). A status that reports a terminal swap as
 *   still running is logged and dropped: the state, the amounts and the raw payload
 *   are all left exactly as they were, because a provider that contradicts its own
 *   history is wrong about something and Till does not get to decide which half to
 *   believe. The same table of allowed moves (`canTransitionSwap`) judges a
 *   non-terminal regression like `processing -> pending`, so there is one definition
 *   of "disagree" rather than a special case for terminal rows.
 * - **One ledger line per transition into terminal, not per report** (LR-1, E1). The
 *   payout is an event and a status is a reading of it, so a swap that answers
 *   `succeeded` on five polls books one `payout_out`. The claim holds the row, so
 *   "did this pass move it into terminal?" is answered by the write itself rather
 *   than by a second read.
 * - **An answer that is not there is not a state** (D2, DQ-2). A ref the provider
 *   did not answer for, or one it answered with a value that is not an integer of
 *   base units, leaves the row's story alone and reschedules it. A poller that
 *   defaults to `processing` would quietly turn a silent provider into a stalled
 *   swap, which is the difference between an outage and a false finding.
 *
 * Two loops never poll the same swap (the Done-when), which is two guarantees and
 * not one. `FOR UPDATE OF swaps SKIP LOCKED` makes two passes running at the same
 * moment claim disjoint sets, and the stamp this pass commits makes a pass that
 * starts after the first one finished leave the same rows alone until each row's own
 * gap has passed. The gap is per ref (`next_poll_at`) rather than per pass because
 * S5 asked D3 for that specifically: one provider call covers a whole batch, so a
 * row whose answer is already known has to be excluded by its own due time.
 *
 * The provider call is made while the claimed rows are locked, which holds those
 * rows for the duration of one status call for at most `batchSize` refs. The
 * alternative -- stamp, commit, then poll and write -- releases the lock early and
 * loses the guarantee: a second loop would claim the same refs mid-call, and a
 * process that died between the call and the write would leave rows stamped as
 * polled with nothing written. The batch bound is what keeps that trade bounded.
 *
 * Clock discipline (hard rule 12): every timestamp here is `now()` from the
 * database, and only durations are computed in application code.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type PollStatusSource = Pick<PayoutProvider, "getStatus"> &
  Partial<Pick<PayoutProvider, "statusCallsPerPass">>;

export type PollDeps = {
  readonly db: Db;
  readonly provider: PollStatusSource;
  /** `env.POLL_INTERVAL_SECONDS`: the gap between two looks at one ref. */
  readonly pollSeconds: number;
  /** `env.POLL_MAX_BACKOFF_SECONDS`: the ceiling for the exponential retry gap. */
  readonly maxBackoffSeconds: number;
  /** Refs one provider call asks about, and so rows one pass holds locked. */
  readonly batchSize?: number;
  readonly log?: Logger;
};

/**
 * Six counts and one list, and every one of them is read by this file's tests, so
 * none is decoration: `claimed` is what the lock handed out, `moved` is what
 * actually changed state, `terminal` is the transitions that are now events (E1's
 * question), `booked` the ledger lines written for them, `ignored` the statuses
 * dropped as disagreements, `retried` the rows pushed onto a longer gap by a
 * provider that threw, and `movedSellers` whose money that was.
 */
export type PollResult = {
  readonly claimed: number;
  readonly moved: number;
  readonly terminal: number;
  readonly booked: number;
  readonly ignored: number;
  readonly retried: number;
  /**
   * The sellers whose swaps this pass actually changed, sorted so a caller can
   * assert it without depending on row order. E9 reconciles exactly these right
   * away, because "a status changed" is the event that makes a seller's open
   * discrepancies wrong, and waiting for the next interval tick to notice would
   * leave the dashboard describing money that has already moved (ARCHITECTURE 7).
   * A pass that claimed rows and disagreed with all of them names nobody.
   */
  readonly movedSellers: readonly string[];
};

/**
 * One status call per pass, for at most this many refs. A number that is too high
 * makes the held locks outlive the interval, which is the failure `startLoop`'s
 * overlap skip is there to survive; too low and a backlog waits several passes.
 * 25 is a single call's worth of refs for a hackathon-scale queue.
 */
export const DEFAULT_POLL_BATCH_SIZE = 25;

/** The result's own counts, mutable while one pass is running. */
type Counts = { -readonly [K in keyof Omit<PollResult, "movedSellers">]: PollResult[K] };

/** A provider answer this module is willing to write, after the boundary check. */
type Answer = {
  readonly state: SwapState;
  readonly amountIn: BaseUnitAmount | null;
  readonly amountOut: BaseUnitAmount | null;
  readonly refundedAmount: BaseUnitAmount | null;
  readonly originTxHash: string | null;
  readonly destinationTxHash: string | null;
  /** The provider's own time-in-state, when it reports one (S5, consequence 2). */
  readonly providerUpdatedAt: Date | null;
  readonly raw: unknown;
};

type Claimed = {
  readonly id: string;
  readonly providerRef: string;
  readonly state: string;
  readonly originTxHash: string | null;
  readonly terminalAt: Date | null;
  readonly pollAttempts: number;
  /** The last provider-reported time-in-state, kept until a report replaces it. */
  readonly providerUpdatedAt: Date | null;
  readonly sellerId: string;
  readonly destinationAsset: string;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `undefined` and `null` mean different things to an amount, and the difference is
 * the whole check: `null` is "the provider has not reported this yet", which is
 * storable, and `undefined` is "what came back is not an integer of base units",
 * which is a payload this module refuses to convert. `Number(1.5)` would otherwise
 * become `numeric(78,0)` rounded by Postgres, and a silently rounded payout is a
 * reconciliation finding that no longer describes money (hard rule 3).
 */
function amountOf(value: unknown): BaseUnitAmount | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = baseUnitAmountSchema.safeParse(String(value));
  return parsed.success ? BigInt(parsed.data) : undefined;
}

/** An empty string from a JSON field is "not reported", not "an empty hash". */
function hashOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

type Read =
  | { readonly ok: true; readonly answer: Answer }
  | { readonly ok: false; readonly detail: string };

function readAnswer(reported: NormalizedSwap): Read {
  const amountIn = amountOf(reported.amountIn);
  const amountOut = amountOf(reported.amountOut);
  const refundedAmount = amountOf(reported.refundedAmount);
  if (amountIn === undefined || amountOut === undefined || refundedAmount === undefined) {
    const field =
      amountIn === undefined
        ? "amountIn"
        : amountOut === undefined
          ? "amountOut"
          : "refundedAmount";
    return { ok: false, detail: `${field} is not an integer of base units` };
  }
  return {
    ok: true,
    answer: {
      // PO-4's mapping, run on the wire value rather than trusted from the type:
      // a status name this build does not know is `processing`, which keeps it
      // visible to PAYOUT_STUCK instead of letting it pose as progress or finish.
      state: normalizeSwapState(String(reported.state)),
      amountIn,
      amountOut,
      refundedAmount,
      originTxHash: hashOf(reported.originTxHash),
      destinationTxHash: hashOf(reported.destinationTxHash),
      providerUpdatedAt: reported.providerUpdatedAt ?? null,
      raw: reported.raw,
    },
  };
}

/**
 * What a report says the ledger should do, read once.
 *
 * A terminal `succeeded` or `refunded` is an event with an amount, and `E1` says one
 * ledger line per event -- so an amount that is missing is not a zero booking, it is a
 * report that cannot be booked at all. `failed` moves no money and is a rule's
 * business (E5), not the ledger's, which is why it is `nothing` by design rather than
 * by absence.
 */
type Bookable =
  | { readonly kind: "payout"; readonly amount: BaseUnitAmount }
  | { readonly kind: "refund"; readonly amount: BaseUnitAmount }
  | { readonly kind: "nothing" };

function bookableOf(to: SwapState, fields: Answer): Bookable {
  if (to === "succeeded" && fields.amountOut !== null) {
    return { kind: "payout", amount: fields.amountOut };
  }
  if (to === "refunded" && fields.refundedAmount !== null) {
    return { kind: "refund", amount: fields.refundedAmount };
  }
  return { kind: "nothing" };
}

/** The next look at a row that answered: one interval, retries cleared. */ function nextGap(
  pollSeconds: number,
) {
  return sql`now() + make_interval(secs => ${pollSeconds}::int)`;
}

/** The same gap the retry pass writes, as a value a log line can name. */
function retryGap(pollSeconds: number, attempts: number, maxBackoffSeconds: number) {
  return sql`now() + make_interval(secs => ${backoffSeconds(pollSeconds, attempts, maxBackoffSeconds)}::int)`;
}

/**
 * The retry gap for one row: `pollSeconds * 2 ** attempts`, capped. The exponent is
 * the row's own stored attempt count, so a provider that has been failing for one
 * swap for an hour is asked about once a quarter-hour rather than three times a
 * minute, and a row that answers goes back to the plain interval.
 */
export function backoffSeconds(
  pollSeconds: number,
  attempts: number,
  maxBackoffSeconds: number,
): number {
  const doubled = pollSeconds * 2 ** attempts;
  return Math.min(maxBackoffSeconds, Number.isFinite(doubled) ? doubled : maxBackoffSeconds);
}

/**
 * Which token a refund came back in, which is the payment's question and not the
 * route's. A refund is the deposit returning, and the deposit was the payer's
 * stablecoin, recorded on the payment (`payments.asset_contract`) — the route only
 * knows where money was *going*. With no link there is no asset to name, so this
 * returns null and the caller books nothing rather than storing a guess: an
 * unmatched refund is already what `PAYOUT_REFUNDED` (E4) reports, and a wrong asset
 * on its ledger line would make that finding unfixable.
 *
 * The other side, `payout_out`, does have an asset in the row already — the route's
 * destination asset — because a payout is money arriving somewhere, and 6.1's
 * "entries are per asset, there is no cross-asset balance" is what makes an intents
 * swap's two lines read as two tokens rather than a net that quietly converted one
 * into the other.
 */
async function refundAssetOf(tx: Tx, paymentId: string | null): Promise<string | null> {
  if (paymentId === null) {
    return null;
  }
  const rows = await tx
    .select({ asset: payments.assetContract })
    .from(payments)
    .where(eq(payments.id, paymentId));
  return rows[0]?.asset ?? null;
}

export async function pollPayouts(deps: PollDeps): Promise<PollResult> {
  const { db, log } = deps;
  // D3/S5 consequence 5: a provider whose status endpoint takes one deposit
  // address per call publishes how many calls one pass may make, and claiming more
  // rows than that would hold locks on refs this pass never asks about. `min` and
  // not `??` because a caller's smaller batch stays smaller.
  const batchSize = Math.min(
    deps.batchSize ?? DEFAULT_POLL_BATCH_SIZE,
    deps.provider.statusCallsPerPass ?? DEFAULT_POLL_BATCH_SIZE,
  );
  // The public shape publishes these as read-only; the pass fills them in as it goes.
  const counts: Counts = { claimed: 0, moved: 0, terminal: 0, booked: 0, ignored: 0, retried: 0 };
  // Distinct, because one seller with three swaps that all moved is one seller for
  // E9, and a duplicated id would ask the reconcile pass to lock it twice.
  const movedSellers = new Set<string>();

  await db.transaction(async (tx) => {
    // The annotation is the check that the claim query still answers what the loop
    // reads off it; drizzle's inference and this type are not allowed to drift.
    const claimed: readonly Claimed[] = await tx
      .select({
        id: swaps.id,
        providerRef: swaps.providerRef,
        state: swaps.state,
        originTxHash: swaps.originTxHash,
        terminalAt: swaps.terminalAt,
        pollAttempts: swaps.pollAttempts,
        providerUpdatedAt: swaps.providerUpdatedAt,
        sellerId: payoutRoutes.sellerId,
        destinationAsset: payoutRoutes.destinationAsset,
      })
      .from(swaps)
      .innerJoin(payoutRoutes, eq(payoutRoutes.id, swaps.routeId))
      // The rows with work left. `terminal_at is null` is the terminal test, stated
      // as a column rather than as a list of states, so this query cannot drift out
      // of step with D1's list in @till/core (see the index comment in schema.ts).
      .where(
        and(
          isNull(swaps.terminalAt),
          or(isNull(swaps.nextPollAt), lte(swaps.nextPollAt, sql`now()`)),
        ),
      )
      .orderBy(asc(swaps.createdAt), asc(swaps.id))
      .limit(batchSize)
      .for("update", { of: swaps, skipLocked: true });

    counts.claimed = claimed.length;
    if (claimed.length === 0) {
      return;
    }

    let reported: readonly NormalizedSwap[];
    try {
      reported = await deps.provider.getStatus({
        providerRefs: claimed.map((row) => row.providerRef),
      });
    } catch (error) {
      let longestGap = 0;
      for (const row of claimed) {
        const attempts = row.pollAttempts + 1;
        longestGap = Math.max(
          longestGap,
          backoffSeconds(deps.pollSeconds, attempts, deps.maxBackoffSeconds),
        );
        await tx
          .update(swaps)
          .set({
            pollAttempts: attempts,
            nextPollAt: retryGap(deps.pollSeconds, attempts, deps.maxBackoffSeconds),
          })
          .where(eq(swaps.id, row.id));
        counts.retried += 1;
      }
      // No `last_polled_at`: that column answers "when did the provider last talk
      // to us" (UI-5), and a call that threw did not.
      log?.error(
        {
          code: "poll_provider_failed",
          swaps: claimed.length,
          retryGapSeconds: longestGap,
          error: message(error),
        },
        "payout status call failed, swaps rescheduled on the retry gap",
      );
      return;
    }

    const byRef = new Map(reported.map((answer) => [String(answer.providerRef), answer]));

    for (const row of claimed) {
      const schedule = { pollAttempts: 0, nextPollAt: nextGap(deps.pollSeconds) };

      const answer = byRef.get(row.providerRef);
      if (answer === undefined) {
        if (row.terminalAt === null && isTerminalSwapState(normalizeSwapState(row.state))) {
          // D10, PO-4: a row already terminal but unstamped has no answer left to
          // wait for, and A7's trigger forbids deleting it, so the pass that
          // claimed it converges the stamp itself instead of rescheduling a poll
          // that can never change anything. Stamping is not a transition: state,
          // amounts and payload stay, and an existing stamp is never rewritten.
          await tx.update(swaps).set({ terminalAt: sql`now()` }).where(eq(swaps.id, row.id));
        } else {
          // The provider was asked and did not answer for this ref. Nothing about
          // the swap's story is now known, but the row backs off on the same
          // attempt-based gap a thrown call does (D10): rescheduled on the plain
          // interval it is due again next pass, older than everything newer than
          // it, and the batch never moves on.
          const attempts = row.pollAttempts + 1;
          await tx
            .update(swaps)
            .set({
              pollAttempts: attempts,
              nextPollAt: retryGap(deps.pollSeconds, attempts, deps.maxBackoffSeconds),
            })
            .where(eq(swaps.id, row.id));
        }
        log?.warn(
          { code: "poll_ref_unanswered", swapId: row.id, providerRef: row.providerRef },
          "payout provider did not answer for a swap it was asked about",
        );
        continue;
      }

      const read = readAnswer(answer);
      if (!read.ok) {
        await tx.update(swaps).set(schedule).where(eq(swaps.id, row.id));
        log?.error(
          {
            code: "poll_answer_unusable",
            swapId: row.id,
            providerRef: row.providerRef,
            detail: read.detail,
          },
          "payout provider answer refused at the boundary, swap left as it was",
        );
        continue;
      }
      const fields = read.answer;

      // The stored state is read through the same mapping as the provider's, so a
      // value some other writer put in `swaps.state` cannot be treated as a known
      // state just because it is in our own database.
      const from = normalizeSwapState(row.state);
      const to = fields.state;

      if (isTerminalSwapState(from)) {
        counts.ignored += 1;
        log?.warn(
          {
            code: "poll_status_ignored_terminal",
            swapId: row.id,
            providerRef: row.providerRef,
            stored: from,
            reported: to,
          },
          "payout status disagreed with a terminal swap and was dropped (PO-4)",
        );
        // Sticky means the status changes nothing. `terminal_at` is not part of the
        // status: a row whose state is terminal and whose stamp is missing is a row
        // that reached terminal before this column was filled, and converging the
        // schedule is what stops it being polled every pass forever.
        await tx
          .update(swaps)
          .set({
            ...schedule,
            lastPolledAt: sql`now()`,
            ...(row.terminalAt === null ? { terminalAt: sql`now()` } : {}),
          })
          .where(eq(swaps.id, row.id));
        continue;
      }

      const regressed = to !== from && !canTransitionSwap(from, to);
      if (regressed) {
        counts.ignored += 1;
        log?.warn(
          {
            code: "poll_status_regression",
            swapId: row.id,
            providerRef: row.providerRef,
            stored: from,
            reported: to,
          },
          "payout status would have moved a swap backwards and was dropped (PO-4)",
        );
        await tx
          .update(swaps)
          .set({ ...schedule, lastPolledAt: sql`now()` })
          .where(eq(swaps.id, row.id));
        continue;
      }

      const becameTerminal = to !== from && isTerminalSwapState(to);
      const bookable = bookableOf(to, fields);

      // G6 (2026-11-10): a report that finishes a swap with no amount to book is
      // refused rather than written and stamped. `payout_out` and `refund_in` are one
      // ledger line for one event (E1), so a `succeeded` with a null `amountOut` books
      // nothing -- and the terminal stamp used to be written in the same pass, which
      // took the row out of the claim query forever: never booked, never asked again,
      // and named by no rule either (`payout-shortfall.ts` skips a null amount). Left
      // where it was, the row stays visible: a later report may still carry the
      // amount, and `PAYOUT_STUCK` fires on it if none ever does.
      //
      // `becameTerminal` already narrows `to` to the three terminal states, and a
      // `failed` is terminal with nothing to book by design, so this is exactly the
      // two reports that finish a swap and carry no amount.
      if (becameTerminal && bookable.kind === "nothing" && to !== "failed") {
        await tx
          .update(swaps)
          .set({ ...schedule, lastPolledAt: sql`now()` })
          .where(eq(swaps.id, row.id));
        log?.error(
          {
            code: "poll_payout_unbooked",
            swapId: row.id,
            providerRef: row.providerRef,
            reported: to,
          },
          "a terminal payout report carried no amount, so the swap kept its state and will be asked again",
        );
        continue;
      }

      const writes = {
        amountIn: fields.amountIn?.toString() ?? null,
        amountOut: fields.amountOut?.toString() ?? null,
        refundedAmount: fields.refundedAmount?.toString() ?? null,
        // A hash is never erased by a report that does not carry one. S5 recorded
        // that the provider's hash arrays are empty until the money moves, so a
        // null here means "not reported yet" and overwriting the value the link was
        // built from would unlink a swap that is already matched.
        originTxHash: fields.originTxHash ?? row.originTxHash,
        destinationTxHash: fields.destinationTxHash,
        // A provider that stops reporting its update time does not reset the swap's
        // age: the last one it gave is still the best statement of time-in-state, and
        // dropping it would make PAYOUT_STUCK judge the row on the poll stamp again.
        providerUpdatedAt: fields.providerUpdatedAt ?? row.providerUpdatedAt,
        raw: fields.raw,
        ...schedule,
        lastPolledAt: sql`now()`,
        ...(becameTerminal ? { terminalAt: sql`now()` } : {}),
      };

      if (to === from) {
        await tx.update(swaps).set(writes).where(eq(swaps.id, row.id));
      } else {
        await tx
          .update(swaps)
          .set({ ...writes, state: to })
          .where(eq(swaps.id, row.id));
        counts.moved += 1;
        movedSellers.add(row.sellerId);
        if (becameTerminal) {
          counts.terminal += 1;
        }
      }

      // E2's join, called from the loop that first makes a hash available. Every
      // answer is linked, not only a terminal one: the deposit hash can arrive on a
      // `processing` report, and the point of the link is that it does not depend on
      // which side of the payout resolved first.
      const link = await linkSwapByHash(tx, row.id);
      const paymentId = link.kind === "unlinked" ? null : link.paymentId;
      if (link.kind === "unlinked" && link.reason === "ambiguous") {
        log?.warn(
          { code: "poll_link_ambiguous", swapId: row.id, candidates: link.candidates },
          "two payments carry the hash this swap reports, so the link is left for reconciliation (LR-2)",
        );
      }

      if (!becameTerminal) {
        continue;
      }

      // The guard above is what makes a terminal `succeeded`/`refunded` reach here
      // carrying its amount, so the amount is read once rather than tested twice.
      if (bookable.kind === "payout") {
        await recordPayoutOut(tx, {
          sellerId: row.sellerId,
          amount: bookable.amount,
          asset: row.destinationAsset,
          paymentId,
          swapId: row.id,
          note: `intents payout for swap ${row.providerRef}`,
        });
        counts.booked += 1;
      } else if (bookable.kind === "refund") {
        // The asset a refund came back in is a fact about the payment, not about the
        // destination chain, so it is read off the link (E4) and a missing link is a
        // refusal rather than a guess.
        const asset = await refundAssetOf(tx, paymentId);
        if (asset === null) {
          log?.error(
            {
              code: "poll_refund_unbooked",
              swapId: row.id,
              providerRef: row.providerRef,
              paymentId,
            },
            "a refunded swap gave no link to name its asset, so no ledger line was written",
          );
        } else {
          await recordRefundIn(tx, {
            sellerId: row.sellerId,
            amount: bookable.amount,
            asset,
            paymentId,
            swapId: row.id,
            note: `deposit refunded for swap ${row.providerRef}`,
          });
          counts.booked += 1;
        }
      }
      // `failed` books nothing (E1): a failure has moved no money, and PAYOUT_FAILED
      // (E5) is the rule that reports it.
    }
  });

  return { ...counts, movedSellers: [...movedSellers].sort() };
}
