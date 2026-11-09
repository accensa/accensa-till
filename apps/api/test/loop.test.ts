import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type LoopSpec, startLoop } from "../src/jobs/loop.ts";
import type { Logger } from "../src/lib/logger.ts";

/**
 * D6's other half of "two loops never process the same swap" (PO-4).
 *
 * The row lock in `poll-payouts.ts` separates two *processes*; this file is about one
 * process whose tick outlives its interval, which the lock cannot answer — a second
 * `pollPayouts` from the same timer would be a new transaction asking about whatever
 * the first one has already committed. So the guarantee here is that the tick is
 * dropped, and the tests are written against that distinction:
 *
 * - a tick still running when the next interval fires means the second one never
 *   starts, and nothing queues behind it (a backlog of ticks each re-asking about the
 *   same rows is the failure this exists to prevent),
 * - a tick that throws is logged and the loop keeps its schedule, since a provider that
 *   comes back mid-deployment has to be found by a running poller rather than by a
 *   restart,
 * - `stop` really stops it, and takes the in-flight tick's signal with it.
 *
 * Timers are faked, so none of this waits twenty seconds or depends on a wall clock
 * (hard rule 12): every assertion is about what the loop did after the clock was
 * advanced by a stated amount.
 */

const SECONDS = 20;
const INTERVAL_MS = SECONDS * 1000;

type Entry = { readonly level: string; readonly code: string };

function recordingLog(): { readonly log: Logger; readonly entries: Entry[] } {
  const entries: Entry[] = [];
  const push = (level: string) => (fields: Record<string, unknown>) => {
    entries.push({ level, code: String(fields.code ?? "") });
  };
  const log: Logger = {
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => log,
  };
  return { log, entries };
}

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A loop whose ticks the test controls, plus what it did. */
function ticks(run: (signal: AbortSignal, ordinal: number) => Promise<void>) {
  const started: AbortSignal[] = [];
  const spec: LoopSpec = {
    name: "under-test",
    seconds: SECONDS,
    run: async (signal) => {
      started.push(signal);
      await run(signal, started.length);
    },
  };
  return { spec, started };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a loop ticks on its interval, drops overlaps and survives failures", () => {
  it("waits one interval before the first tick, then ticks once per interval", async () => {
    const { spec, started } = ticks(async () => {});
    const { log } = recordingLog();
    const stop = startLoop({ ...spec, log });
    try {
      // Boot fires nothing: an unpolled swap is covered by the stuck window, which is
      // minutes wide, while the first tick of a restarting process would ask a
      // provider a question about rows the restart changed nothing about.
      expect(started.length).toBe(0);

      await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
      expect(started.length).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(started.length).toBe(1);

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(started.length).toBe(2);
    } finally {
      stop();
    }
  });

  it("drops a tick that overlaps instead of queueing it", async () => {
    // The Done-when's second sentence, in-process: `pollPayouts` is still standing
    // inside its provider call when the next interval fires. Queued rather than
    // dropped, that second tick would run right after the first and ask about the
    // same rows again; dropped, the rows are asked about on the tick after, because
    // what is due is decided by the database and not by anything this helper keeps.
    const held = gate();
    const released = gate();
    const { spec, started } = ticks(async (_signal, ordinal) => {
      if (ordinal === 1) {
        held.open();
        await released.promise;
      }
    });
    const { log, entries } = recordingLog();
    const stop = startLoop({ ...spec, log });
    try {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await held.promise;
      expect(started.length).toBe(1);

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(started.length).toBe(1);
      expect(entries).toEqual([{ level: "warn", code: "loop_tick_skipped" }]);

      // Dropped, not wedged: the flag is cleared by the tick that was running, so the
      // next interval works again.
      released.open();
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(started.length).toBe(2);
      expect(entries.map((entry) => entry.code)).toEqual(["loop_tick_skipped"]);
    } finally {
      released.open();
      stop();
    }
  });

  it("keeps its schedule when a tick throws", async () => {
    // A poller whose loop died quietly is a system that stops tracking payouts while
    // every route still advertises one, so the throw is reported and the interval is
    // not given back to the timer.
    const { spec, started } = ticks(async (_signal, ordinal) => {
      if (ordinal === 1) {
        throw new Error("provider said 500");
      }
    });
    const { log, entries } = recordingLog();
    const stop = startLoop({ ...spec, log });
    try {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(started.length).toBe(1);
      expect(entries).toEqual([{ level: "error", code: "loop_tick_failed" }]);

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(started.length).toBe(2);
    } finally {
      stop();
    }
  });

  it("stops on the returned handle and aborts the tick's signal", async () => {
    const held = gate();
    const released = gate();
    const { spec, started } = ticks(async () => {
      held.open();
      await released.promise;
    });
    const stop = startLoop(spec);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await held.promise;
    expect(started.length).toBe(1);
    expect(started[0]?.aborted).toBe(false);

    stop();
    // A second `stop` is not asked to do anything, but the in-flight tick's signal is
    // what a run that could take notice of one would leave on: a stop is not a pause.
    released.open();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5);
    expect(started.length).toBe(1);
    expect(started[0]?.aborted).toBe(true);
  });
});
