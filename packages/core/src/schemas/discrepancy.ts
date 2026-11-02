import { z } from "zod";
import { DISCREPANCY_CODES, SEVERITIES } from "../reconcile/types.ts";

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
