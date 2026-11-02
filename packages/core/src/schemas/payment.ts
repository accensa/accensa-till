import { z } from "zod";
import { PAYMENT_STATES } from "../states.ts";
import { baseUnitAmountSchema, nearAccountIdSchema, uuidSchema } from "./common.ts";

/** A payment as the dashboard sees it (UI-3: every row links its NEAR transaction). */
export const paymentDtoSchema = z.object({
  id: uuidSchema,
  endpointId: uuidSchema,
  routeId: uuidSchema.nullable(),
  payerAccountId: nearAccountIdSchema,
  amount: baseUnitAmountSchema,
  assetContract: z.string(),
  state: z.enum(PAYMENT_STATES),
  nearTxHash: z.string().nullable(),
  upstreamStatus: z.number().int().nullable(),
  upstreamMs: z.number().int().nonnegative().nullable(),
  verifiedAt: z.string().datetime(),
  settledAt: z.string().datetime().nullable(),
  /** True when the seller's own account paid, so a test does not read as revenue (UI-3). */
  selfPayment: z.boolean(),
});
export type PaymentDto = z.infer<typeof paymentDtoSchema>;

/**
 * The 402 body a payer receives (GW-1 acceptance: price, asset, network and
 * pay-to all present). Shape mirrors x402 v2 requirements.
 */
export const paymentRequirementsSchema = z.object({
  scheme: z.literal("near-address"),
  network: z.string(),
  amount: baseUnitAmountSchema,
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  output: z.object({
    contentType: z.string(),
    description: z.string(),
  }),
});
export type PaymentRequirementsDto = z.infer<typeof paymentRequirementsSchema>;
