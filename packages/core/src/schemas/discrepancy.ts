import { z } from "zod";
import { DISCREPANCY_CODES, SEVERITIES } from "../reconcile/types.ts";
import { boundedArray, nearAccountIdSchema, timestampSchema } from "./common.ts";

/**
 * Discrepancy codes are SCREAMING_SNAKE_CASE and identical in code, database
 * and UI copy keys (PROJECT_STRUCTURE.md naming). The canonical list lives in
 * reconcile/types.ts so a rule cannot invent a code the schema rejects.
 */

export const discrepancyCodeSchema = z.enum(DISCREPANCY_CODES);
export type DiscrepancyCodeValue = z.infer<typeof discrepancyCodeSchema>;

export const severitySchema = z.enum(SEVERITIES);

/** A persisted discrepancy as the dashboard sees it (UI-4). */
export const discrepancyDtoSchema = z.object({
  id: z.string().uuid(),
  sellerId: z.string().uuid(),
  code: discrepancyCodeSchema,
  severity: severitySchema,
  paymentId: z.string().uuid().nullable(),
  swapId: z.string().uuid().nullable(),
  dedupeKey: z.string(),
  explanation: z.string(),
  suggestedAction: z.string(),
  openedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  /** auto when the cause cleared on its own, manual when a human closed it. */
  resolution: z.enum(["auto", "manual"]).nullable(),
});
export type DiscrepancyDto = z.infer<typeof discrepancyDtoSchema>;

/**
 * The open worklist (UI-4). The API answers it sorted by severity then age, and the
 * page renders that order rather than deciding one: `severityRank` is what both read.
 */
export const discrepancyListResponseSchema = z.object({
  discrepancies: boundedArray(discrepancyDtoSchema, 256),
});
export type DiscrepancyListResponse = z.infer<typeof discrepancyListResponseSchema>;

/**
 * What a manual resolve answers: the row as it now stands, closed and by whom. The
 * seller does not get a bare `204`, because the row's own `resolvedAt` and
 * `resolution` are the two facts that tell them the cause could come back (LR-5).
 */
export const discrepancyResolveResponseSchema = z.object({
  discrepancy: discrepancyDtoSchema,
});
export type DiscrepancyResolveResponse = z.infer<typeof discrepancyResolveResponseSchema>;

/**
 * A payer this seller is holding. `strikes` is what still counts — inside the
 * window and after this seller's latest clear — not a lifetime total, and the list
 * is only ever payers at or above the threshold, so `blocked` is redundant as data
 * and kept as the field the row can assert on rather than a page-wide constant.
 */
export const payerBlockDtoSchema = z.object({
  payerAccountId: nearAccountIdSchema,
  strikes: z.number().int().nonnegative(),
  blocked: z.boolean(),
  lastStrikeAt: timestampSchema.nullable(),
});
export type PayerBlockDto = z.infer<typeof payerBlockDtoSchema>;

export const payerBlockListResponseSchema = z.object({
  payerBlocks: boundedArray(payerBlockDtoSchema, 256),
});
export type PayerBlockListResponse = z.infer<typeof payerBlockListResponseSchema>;

/**
 * What a clear answers: the list as it now stands. It is the same shape as the read
 * for one reason — it is the same computation. Answering the *single* payer's state
 * instead would need `lastStrikeAt`, and the only honest way to compute that after a
 * watermark is another pass over the same aggregate, while a concurrent strike would
 * make a claimed `null` a lie. The page redraws the table from the answer rather than
 * refetching it.
 */
export const payerBlockClearResponseSchema = z.object({
  payerBlocks: boundedArray(payerBlockDtoSchema, 256),
});
export type PayerBlockClearResponse = z.infer<typeof payerBlockClearResponseSchema>;

/**
 * The body a clear accepts: a note for the audit trail and nothing else. `cleared_by`
 * is deliberately absent — who lifted a block is the session's fact, not the caller's
 * (UI-4), and a field here would be a field a request could forge.
 */
export const payerBlockClearRequestSchema = z.object({
  note: z.string().max(200).optional(),
});
export type PayerBlockClearRequest = z.infer<typeof payerBlockClearRequestSchema>;
