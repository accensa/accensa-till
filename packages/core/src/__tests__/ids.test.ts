import { describe, expect, it } from "vitest";

import { createIdGenerator, newId } from "../ids.ts";

/**
 * A20. The claim being pinned is "an id sorts by insertion time", which is the
 * only reason to leave v4 behind — so every monotonic rule gets a test, and the
 * two ways it is *not* true (across processes, and as a timestamp) are said
 * plainly rather than implied.
 */

const T0 = 1_780_000_000_000;

/** The 48-bit unix-ms field, read back out of the leading hex. */
function msOf(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

function sequenceOf(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(12, 16), 16) & 0x0fff;
}

function isStrictlyAscending(ids: readonly string[]): boolean {
  for (let i = 1; i < ids.length; i += 1) {
    if (nth(ids, i) <= nth(ids, i - 1)) {
      return false;
    }
  }
  return true;
}

function nth(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`the batch has no id at ${index}`);
  }
  return id;
}

describe("uuid v7 shape (A20)", () => {
  it("is a well-formed v7 uuid, version and variant bits in place", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.length).toBe(36);
  });

  it("carries the clock in the leading 48 bits", () => {
    const gen = createIdGenerator(() => T0);
    expect(msOf(gen())).toBe(T0);
    // The version nibble sits where a v4 would put random bits, which is what
    // makes the prefix a legal, sortable integer rather than noise.
    expect(gen().charAt(14)).toBe("7");
  });

  it("leaves 62 random bits below the counter, so two generators do not collide", () => {
    const seen = new Set<string>();
    for (const gen of [createIdGenerator(() => T0), createIdGenerator(() => T0)]) {
      for (let i = 0; i < 2_000; i += 1) {
        seen.add(gen());
      }
    }
    expect(seen.size).toBe(4_000);
  });

  it("refuses a clock that is not a unix millisecond", () => {
    for (const bad of [Number.NaN, -1, -T0, Number.POSITIVE_INFINITY, 2 ** 48]) {
      expect(() => createIdGenerator(() => bad)()).toThrow(RangeError);
    }
  });

  it("runs on the process clock by default", () => {
    const before = Date.now();
    const id = newId();
    const after = Date.now();
    expect(msOf(id) >= before && msOf(id) <= after).toBe(true);
  });
});

describe("id ordering (A20)", () => {
  it("sorts in issue order inside one frozen millisecond", () => {
    // The whole point of the counter: with v4-style randomness here, a batch of
    // ids written in the same millisecond would sort in any order at all.
    const gen = createIdGenerator(() => T0);
    const ids = Array.from({ length: 200 }, () => gen());
    expect(isStrictlyAscending(ids)).toBe(true);
    expect(msOf(nth(ids, 0))).toBe(T0);
    expect(ids.map((id) => sequenceOf(id))).toEqual(ids.map((_id, i) => i));
  });

  it("sorts across milliseconds, including the step from one to the next", () => {
    let ms = T0;
    const gen = createIdGenerator(() => ms);
    const sameMs = [gen(), gen()];
    ms = T0 + 1;
    const middle = gen();
    ms = T0 + 5_000;
    const late = gen();
    expect(isStrictlyAscending([...sameMs, middle, late])).toBe(true);
    expect([msOf(middle), msOf(late)]).toEqual([T0 + 1, T0 + 5_000]);
  });

  it("refuses to lower an id when the clock steps backwards", () => {
    // NTP correction or a container restart. A generator that trusted the clock
    // would hand out an id sorting below one it already issued, and the id's
    // claim to order by insertion would be false without any error to show it.
    let ms = T0;
    const gen = createIdGenerator(() => ms);
    const early = gen();
    ms = T0 + 120;
    const late = gen();
    ms = T0 - 5_000;
    const afterBackstep = gen();
    expect(isStrictlyAscending([early, late, afterBackstep])).toBe(true);
    expect(msOf(afterBackstep)).toBe(msOf(late));
    expect(sequenceOf(afterBackstep)).toBe(sequenceOf(late) + 1);
  });

  it("keeps counting when a millisecond holds more ids than the counter has bits", () => {
    // 4096 in one millisecond: wrapping the sequence would restart the ordering
    // and repeat an id outright, since the timestamp field would not move.
    const gen = createIdGenerator(() => T0);
    const ids = Array.from({ length: 5_000 }, () => gen());
    expect(isStrictlyAscending(ids)).toBe(true);
    expect(new Set(ids).size).toBe(5_000);
    expect(msOf(nth(ids, 4_096))).toBe(T0 + 1);
    expect(sequenceOf(nth(ids, 4_096))).toBe(0);
  });

  it("orders a whole ledger-sized batch, which is what the primary key wants", () => {
    const gen = createIdGenerator(() => T0);
    const ids = Array.from({ length: 20_000 }, () => gen());
    expect(isStrictlyAscending(ids)).toBe(true);
    // Sorted by the database the same way, because the layout is big-endian and
    // the string form keeps that order.
    expect([...ids].sort()).toEqual(ids);
  });
});
