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
