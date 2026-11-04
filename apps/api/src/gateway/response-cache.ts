import type { ProxyResult } from "./proxy.ts";

/**
 * GW-9's short-lived store for a paid answer that may never have reached its
 * buyer (C12). A retry carrying the same authorization finds its row `settled`
 * and would otherwise get a `409` and a receipt; if the seller's answer is still
 * here, the retry gets that answer instead, with the receipt that proves it was
 * paid for.
 *
 * Only a settled 2xx is ever stored. An `abandoned` row is retried through its
 * payment (C7) and an unknown authorization is a new payment (GW-4), so neither
 * belongs here. `served_unsettled` is deliberately absent too: the money may not
 * have moved, and a second delivery for one authorization is not on offer.
 *
 * In memory, like the GW-10 counters: a restart loses the cache and a retry
 * falls back to the `409` + receipt that named this limitation before C12. The
 * bounds are what keep that honest -- the TTL is the requirement's five minutes,
 * the entry cap its 256 KB, and the total cap is ours so a burst of paid
 * requests cannot hold the process's memory hostage.
 */

/** Five minutes, from GW-9. */
export const RESPONSE_CACHE_TTL_MS = 5 * 60_000;
/** 256 KB, from GW-9: larger answers fall back to the `409` + receipt. */
export const RESPONSE_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
/** 32 MiB of bodies, which is 128 maximum-size entries. */
export const RESPONSE_CACHE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** A bound on the map itself, for many tiny answers. */
export const RESPONSE_CACHE_MAX_ENTRIES = 1_024;

/** The part of a served answer worth replaying: no `elapsedMs`, which is history. */
export type CachedResponse = {
  readonly status: number;
  readonly headers: ProxyResult["headers"];
  readonly body: Uint8Array;
};

export type ResponseCache = {
  /** The stored answer, or `null` when absent or expired. An expired entry is removed. */
  get(replayKey: string): CachedResponse | null;
  /** Store one answer. False means it was larger than the entry cap and was not kept. */
  set(replayKey: string, response: CachedResponse): boolean;
  /** Entries currently held, after expired ones met by `get` are gone. */
  readonly size: number;
};

export function createResponseCache(options?: {
  readonly ttlMs?: number;
  readonly maxEntryBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxEntries?: number;
  /** A seam for the TTL tests, so five minutes does not have to pass. */
  readonly now?: () => number;
}): ResponseCache {
  const ttlMs = options?.ttlMs ?? RESPONSE_CACHE_TTL_MS;
  const maxEntryBytes = options?.maxEntryBytes ?? RESPONSE_CACHE_MAX_ENTRY_BYTES;
  const maxTotalBytes = options?.maxTotalBytes ?? RESPONSE_CACHE_MAX_TOTAL_BYTES;
  const maxEntries = options?.maxEntries ?? RESPONSE_CACHE_MAX_ENTRIES;
  const now = options?.now ?? Date.now;

  // Insertion order is the eviction order: a Map is enough at this size, and
  // recency would need a second structure for a five-minute cache.
  const entries = new Map<
    string,
    { readonly response: CachedResponse; readonly expiresAt: number }
  >();
  let totalBytes = 0;

  const remove = (replayKey: string): void => {
    const entry = entries.get(replayKey);
    if (entry === undefined) {
      return;
    }
    entries.delete(replayKey);
    totalBytes -= entry.response.body.byteLength;
  };

  return {
    get(replayKey) {
      const entry = entries.get(replayKey);
      if (entry === undefined) {
        return null;
      }
      if (now() >= entry.expiresAt) {
        remove(replayKey);
        return null;
      }
      return entry.response;
    },

    set(replayKey, response) {
      if (response.body.byteLength > maxEntryBytes) {
        return false;
      }
      // Re-setting a key moves it to the end, which is the order eviction reads.
      remove(replayKey);
      entries.set(replayKey, { response, expiresAt: now() + ttlMs });
      totalBytes += response.body.byteLength;

      while (entries.size > maxEntries || totalBytes > maxTotalBytes) {
        const oldest = entries.keys().next().value;
        // The new entry alone fits both caps (`maxEntryBytes` is enforced above
        // and must not exceed the total), so this only stops a bad option pair.
        if (oldest === undefined || oldest === replayKey) {
          break;
        }
        remove(oldest);
      }
      return true;
    },

    get size() {
      return entries.size;
    },
  };
}
