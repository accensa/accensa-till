import { z } from "zod";

/**
 * Wire formats for the two types that cannot cross a JSON boundary unchanged:
 * ids, and money. Amounts travel as decimal strings and are parsed to bigint at
 * the edge, never through `Number` (AGENTS.md hard rule 3).
 */

export const uuidSchema = z.string().uuid();

/** Base units as a plain integer string, e.g. "1250000". */
export const baseUnitAmountSchema = z
  .string()
  .regex(/^-?\d+$/)
  .brand<"BaseUnitAmountString">();

/**
 * A money field where a negative or a zero is not information but an attack
 * (G6 F1): an endpoint price, and the amount a payment asks a payer to send.
 *
 * Scoped deliberately. `baseUnitAmountSchema` stays the right type for a ledger
 * `adjustment`, whose sign is the correction, and for a swap amount read back
 * from the provider, where an absurd value has to reach the reconciler rather than
 * be rejected at the door. Neither can carry that reasoning in a `bigint` column,
 * so the boundary that can is here.
 *
 * One regex, not `baseUnitAmountSchema.refine(BigInt(x) > 0n)`: zod v3 still runs a
 * refinement after the check beneath it has failed, so `BigInt("1.5")` threw a
 * SyntaxError out of `safeParse` instead of reporting an invalid amount.
 */
export const positiveBaseUnitAmountSchema = z
  .string()
  .regex(/^(?:0*[1-9]\d*)$/)
  .brand<"BaseUnitAmountString">();

/**
 * An array at the JSON boundary, with a hard length cap.
 *
 * Two parts, and the first one is the reason this exists instead of a plain
 * `.max()`. zod v3 parses every element before it checks the array's own
 * constraints, so an uncapped or `.max()`-only array fed 200 000 wrong-typed
 * elements produces one issue object per element — 200 001 issues and an
 * 11.5 MB `error.format()`, measured. That is the shape of the advisory C14
 * declined to take zod 4.6.6 for, and on v3 the fix has to be ours: the
 * preprocess step runs before the elements are looked at and hands the element
 * schema at most `max + 1` entries, so both the work and the issue count are
 * bounded by the cap whoever is parsing what.
 *
 * The slice only ever fires on an array that is already being refused, so no
 * accepted payload is trimmed. Over-cap input still reports the cap rather than
 * a type error, which is why the value is not simply replaced with `null`.
 */
export function boundedArray<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess(
    (value) => (Array.isArray(value) && value.length > max ? value.slice(0, max + 1) : value),
    z.array(item).max(max),
  );
}

export function toBaseUnits(amount: z.infer<typeof baseUnitAmountSchema>): bigint {
  return BigInt(amount);
}

export function fromBaseUnits(amount: bigint): z.infer<typeof baseUnitAmountSchema> {
  return amount.toString() as z.infer<typeof baseUnitAmountSchema>;
}

export const nullableTimestampSchema = z.string().datetime().nullable();
export const timestampSchema = z.string().datetime();

/** A NEAR account id: alice.near, or alice.bob.near. */
export const nearAccountIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/);

/** https only outside local dev (GW-8). */
export const httpsUrlSchema = z.string().url().startsWith("https://");
