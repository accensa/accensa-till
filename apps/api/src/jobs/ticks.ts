import type { ReconcileConfig } from "@till/core";

import type { Db } from "../db/client.ts";
import type { Logger } from "../lib/logger.ts";
import { type PollStatusSource, pollPayouts } from "./poll-payouts.ts";
import { reconcileSellers } from "./reconcile.ts";

/**
 * The two timer ticks (D6, E9) — the work, separated from the scheduling.
 *
 * `server.ts` is the only file in the process that reads the environment, opens a
 * socket and calls `setInterval` (A21's split, applied to jobs), and that makes it
 * unimportable: booting it in a test would bind a port and start a timer. So the
 * body of each tick lives here, takes its dependencies as arguments, and the entry
 * point is the two lines that wire them to `startLoop`.
 *
 * This is where E9's "runs after status changes" exists as code rather than as a
 * comment. Nothing in `reconcile.ts` knows the poller exists, and nothing in
 * `poll-payouts.ts` knows reconciliation exists; this file is the only place that
 * holds both, which is what keeps the dependency one-way and lets a test call the
 * poll tick and watch a discrepancy appear without a reconcile interval ever
 * having fired.
 *
 * Clock discipline (hard rule 12) is unaffected: neither function reads a wall
 * clock, and the timestamps each writes come from the database.
 */

export type PollTickDeps = {
  readonly db: Db;
  readonly statusSource: PollStatusSource;
  /** `env.POLL_INTERVAL_SECONDS`: the base of a row's retry gap, as well as its interval. */
  readonly pollSeconds: number;
  readonly maxBackoffSeconds: number;
  readonly config: ReconcileConfig;
  readonly log?: Logger;
};

export type ReconcileTickDeps = {
  readonly db: Db;
  readonly config: ReconcileConfig;
  /**
   * Absent means every seller, which is the interval pass's question. A caller that
   * knows which sellers changed — the poll tick below — names them instead, which is
   * both less work and the reason a status change reaches the dashboard inside one
   * poll rather than one reconcile interval. A test names them too, for a blunter
   * reason: a shared database holds thousands of leftover sellers, and sweeping all
   * of them makes the assertion about how long the machine took (hard rule 12).
   */
  readonly sellerIds?: readonly string[];
  readonly log?: Logger;
};

/**
 * Poll, then reconcile exactly the sellers whose money this pass moved.
 *
 * The second half is unconditional and inside the same tick (hard rule 10 — no
 * queue): a status change is the event that makes a seller's open discrepancies
 * wrong, so waiting for the next reconcile interval would leave the dashboard
 * describing money that has already moved. A pass that claimed rows and disagreed
 * with every one of them names nobody, so a provider that lies costs no reconcile
 * work.
 */
export async function pollTick(deps: PollTickDeps): Promise<void> {
  const { db, log } = deps;
  const polled = await pollPayouts({
    db,
    provider: deps.statusSource,
    pollSeconds: deps.pollSeconds,
    maxBackoffSeconds: deps.maxBackoffSeconds,
    ...(log === undefined ? {} : { log }),
  });
  if (polled.claimed > 0) {
    log?.info({ loop: "poll-payouts", ...polled }, "payout statuses polled");
  }
  if (polled.movedSellers.length > 0) {
    await reconcileTick({
      db,
      config: deps.config,
      sellerIds: polled.movedSellers,
      ...(log === undefined ? {} : { log }),
    });
  }
}

/**
 * One reconcile pass, logged. Over every seller when `sellerIds` is absent, and over
 * the sellers named by the poll tick when they are not.
 *
 * The interval form is the half that closes causes which cleared without a status
 * change — a payment whose swap arrived late, a payer that finally settled — and the
 * reason a seller with no swaps at all still gets looked at. It is one transaction
 * per seller, so a deployment with more sellers than one interval can hold is caught
 * by `startLoop` dropping the overlap rather than queueing it: the next tick resumes
 * from the database, which decides nothing about what is due, so every seller is
 * eventually reached and no tick stacks.
 */
export async function reconcileTick(deps: ReconcileTickDeps): Promise<void> {
  const reconciled = await reconcileSellers({
    db: deps.db,
    config: deps.config,
    ...(deps.sellerIds === undefined ? {} : { sellerIds: deps.sellerIds }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
  if (reconciled.opened + reconciled.closed + reconciled.partial > 0) {
    deps.log?.info(
      { loop: "reconcile", ...reconciled },
      "reconciliation changed open discrepancies",
    );
  }
}
