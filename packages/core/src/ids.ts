import { randomBytes } from "node:crypto";

/**
 * UUID v7 generation (A20).
 *
 * Till needs an id that carries its own creation time, for two reasons: a reader
 * may sort rows by id and be right, and a random v4 primary key scatters every
 * insert through the index while a leading timestamp keeps it appending. v4
 * gives neither, which is why `crypto.randomUUID()` is not the id generator here.
 *
 * The guarantee is exact inside one process and rough across them. The 12 bits
 * beneath the millisecond are a counter, not noise, so ids issued in the same
 * millisecond still sort in issue order; a clock that steps backwards cannot
 * lower an id already handed out, because the generator refuses to go back. But
 * two processes do not share a counter and their clocks differ, so the honest
 * reading is "insertion order to the millisecond".
 *
 * That is why this is not a clock. Every time comparison in Till still reads the
 * database clock (hard rule 12) and every ordering query uses `created_at`; an id
 * is a tiebreaker and an index locality hint, never a timestamp you may assert on.
 */

/** Milliseconds since the epoch, injectable so the monotonic rules are testable. */
export type IdClock = () => number;

/** The 48-bit unix-ms field of v7 runs out in 8925, so any sane clock fits. */
const MAX_TIMESTAMP_MS = 2 ** 48;

/** The sub-millisecond counter is the 12 bits between the timestamp and the version. */
const SEQUENCE_BITS = 12;
const SEQUENCE_MAX = 2 ** SEQUENCE_BITS;

function toHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (const byte of bytes) {
    hex.push(byte.toString(16).padStart(2, "0"));
  }
  const group = (from: number, to: number): string => hex.slice(from, to).join("");
  return `${group(0, 4)}-${group(4, 6)}-${group(6, 8)}-${group(8, 10)}-${group(10, 16)}`;
}

/**
 * Build a generator. Each instance keeps its own last-millisecond and counter, so
 * one per process is the intended use; the default export below is that one.
 */
export function createIdGenerator(now: IdClock = Date.now): () => string {
  let lastMs = -1;
  let sequence = 0;

  return function nextId(): string {
    const ms = Math.floor(now());
    if (!Number.isFinite(ms) || ms < 0 || ms >= MAX_TIMESTAMP_MS) {
      throw new RangeError(`clock is not a unix millisecond in range: ${ms}`);
    }

    if (ms > lastMs) {
      lastMs = ms;
      sequence = 0;
    } else {
      // Same millisecond, or a clock that stepped back: either way the id must
      // still sort above the last one, so the counter moves and the timestamp
      // does not.
      sequence += 1;
      if (sequence >= SEQUENCE_MAX) {
        // 4096 ids in one millisecond: claim the next one rather than wrap the
        // counter, which would restart the ordering and hand out a duplicate.
        lastMs += 1;
        sequence = 0;
      }
    }

    const bytes = randomBytes(16);
    bytes[0] = Math.floor(lastMs / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(lastMs / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(lastMs / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(lastMs / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(lastMs / 2 ** 8) & 0xff;
    bytes[5] = lastMs & 0xff;
    bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
    bytes[7] = sequence & 0xff;
    const variantByte = bytes[8] ?? 0;
    bytes[8] = (variantByte & 0x3f) | 0x80;
    return toHex(bytes);
  };
}

/** The id generator every writer uses, on the process clock. */
export const newId: () => string = createIdGenerator();
