import { describe, expect, it } from "vitest";

import { createResponseCache } from "../src/gateway/response-cache.ts";

function answer(bytes: number) {
  return {
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    body: new Uint8Array(bytes),
  };
}

function clock(start = 0) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("paid response cache (GW-9)", () => {
  it("replays a stored answer until the five-minute boundary, then forgets it", () => {
    const time = clock(1_000);
    const cache = createResponseCache({ ttlMs: 5 * 60_000, now: time.now });
    const stored = answer(11);

    expect(cache.set("authorization-1", stored)).toBe(true);
    expect(cache.get("authorization-1")).toBe(stored);

    time.advance(5 * 60_000 - 1);
    expect(cache.get("authorization-1")).toBe(stored);

    // At exactly the TTL the entry is expired; the boundary is not a free second.
    time.advance(1);
    expect(cache.get("authorization-1")).toBeNull();
    expect(cache.size).toBe(0);
  });

  it("refuses an answer larger than the entry cap instead of truncating it", () => {
    const cache = createResponseCache({ maxEntryBytes: 4 });

    expect(cache.set("too-large", answer(5))).toBe(false);
    expect(cache.get("too-large")).toBeNull();
    expect(cache.size).toBe(0);

    // The cap is inclusive: four bytes is a four-byte answer.
    expect(cache.set("fits", answer(4))).toBe(true);
    expect(cache.get("fits")?.body.byteLength).toBe(4);
  });

  it("evicts the oldest insertion when the total byte cap is reached", () => {
    const cache = createResponseCache({ maxEntryBytes: 100, maxTotalBytes: 10 });

    expect(cache.set("first", answer(6))).toBe(true);
    expect(cache.set("second", answer(6))).toBe(true);

    expect(cache.get("first")).toBeNull();
    expect(cache.get("second")).not.toBeNull();
  });

  it("evicts the oldest insertion when the entry cap is reached", () => {
    const cache = createResponseCache({ maxEntries: 2, maxEntryBytes: 100 });

    cache.set("first", answer(1));
    cache.set("second", answer(1));
    cache.set("third", answer(1));

    expect(cache.get("first")).toBeNull();
    expect(cache.get("second")).not.toBeNull();
    expect(cache.get("third")).not.toBeNull();
  });

  it("re-setting a key replaces the answer and refreshes its eviction position", () => {
    const cache = createResponseCache({ maxEntries: 2, maxEntryBytes: 100 });

    cache.set("first", answer(1));
    cache.set("second", answer(1));
    cache.set("first", answer(3));

    expect(cache.get("first")?.body.byteLength).toBe(3);

    // `first` was moved to the end, so the untouched `second` is the one evicted.
    cache.set("third", answer(1));
    expect(cache.get("first")).not.toBeNull();
    expect(cache.get("second")).toBeNull();
    expect(cache.get("third")).not.toBeNull();
  });
});
