import { z } from "zod";
import { baseUnitAmountSchema, uuidSchema } from "./common.ts";

/**
 * Ledger entry kinds (ARCHITECTURE.md 6.1). `ledger_entries` is append only, so
 * a correction is a new `adjustment` row rather than an edit.
 *
 * Signed on purpose (G6 F1): an `adjustment` that claws revenue back is a negative
 * row, so this field uses `baseUnitAmountSchema`, not the positive one.
 */
export const ledgerKindSchema = z.enum(["payment_in", "payout_out", "refund_in", "adjustment"]);

export const ledgerEntryDtoSchema = z.object({
  id: uuidSchema,
  sellerId: uuidSchema,
  kind: ledgerKindSchema,
  amount: baseUnitAmountSchema,
  asset: z.string(),
  paymentId: uuidSchema.nullable(),
  swapId: uuidSchema.nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type LedgerEntryDto = z.infer<typeof ledgerEntryDtoSchema>;
