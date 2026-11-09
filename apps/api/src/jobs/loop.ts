import type { Logger } from "../lib/logger.ts";

/**
 * Timer loop helper (D6). Claims work with `for update skip locked` so two loops
 * — two processes, or a tick that outlived its interval — never touch the same
 * swap, applies backoff on provider errors, and treats a tick that is still
 * running as a skip rather than a queue.
 *
 * One process, one Postgres (AGENTS.md hard rule 10): no queue library here.
 *
 * The two halves of that doc comment are enforced in two different places, which is
 * worth saying because the split is easy to lose. What lives here is the *in-process*
 * half: one `setInterval` per loop, and a tick that is still running when the next one
 * fires is dropped rather than queued. Queuing is the failure mode that turns a slow
 * provider into an unbounded backlog of ticks, each of which re-asks about the same
 * rows; a dropped tick asks about them on the next one, because `poll-payouts.ts`
 * decides what is due from the database and not from anything this helper remembers.
 * The cross-process half is the row lock, and no helper can supply it.
 *
 * The first tick waits one interval rather than firing at boot. That is deliberate:
 * C10's sweep runs before the port opens because a stale `verified` row blocks its
 * payer *now*, while an unpolled swap is already covered by the stuck window, which
 * is minutes wide. Firing at boot would ask a provider a question about rows that a
 * restart has not changed.
 *
 * The `AbortSignal` is handed to `run` and `pollPayouts` does not watch it: its unit
 * of work is one status call plus one transaction, and cutting that in half would
 * leave a claimed batch unlocked with nothing written, which costs the same interval
 * it saves. It exists for the loop's own bookkeeping -- a stop is not a pause, and a
 * run that could take notice of one is allowed to leave early.
 */
export type LoopSpec = {
  readonly name: string;
  readonly seconds: number;
  readonly run: (signal: AbortSignal) => Promise<void>;
  /**
   * Optional so a caller that has no logger (a test, a script) still gets a loop;
   * every event this helper emits is about the loop rather than the work, so this is
   * the only thing the loop needs.
   */
  readonly log?: Logger;
};

/** Stops the loop: no further ticks, and the in-flight one is aborted. */
export type StopLoop = () => void;

export function startLoop(spec: LoopSpec): StopLoop {
  const controller = new AbortController();
  let ticking = false;

  const timer = setInterval(() => {
    if (ticking) {
      spec.log?.warn(
        { code: "loop_tick_skipped", loop: spec.name, intervalSeconds: spec.seconds },
        "the previous tick of this loop is still running, so this one was dropped and not queued",
      );
      return;
    }
    ticking = true;
    void spec
      .run(controller.signal)
      .catch((error: unknown) => {
        // A tick that throws does not end the loop: the next interval asks again,
        // and a provider that comes back mid-deployment comes back to a running
        // poller rather than to a process whose payout tracking stopped silently.
        spec.log?.error(
          {
            code: "loop_tick_failed",
            loop: spec.name,
            error: error instanceof Error ? error.message : String(error),
          },
          "a tick of this loop threw; the loop keeps running",
        );
      })
      .finally(() => {
        ticking = false;
      });
  }, spec.seconds * 1000);

  // A scheduled loop must not be the reason a process cannot exit. The HTTP server
  // keeps the process alive while it is listening; this timer should not keep it
  // alive once the server is gone, and it should not hold a test runner open either.
  timer.unref();

  return () => {
    clearInterval(timer);
    controller.abort();
  };
}
