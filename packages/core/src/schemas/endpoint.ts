import { z } from "zod";
import {
  boundedArray,
  httpsUrlSchema,
  positiveBaseUnitAmountSchema,
  uuidSchema,
} from "./common.ts";

/**
 * Creation input for an endpoint (PO-1, PO-2). Slug is server-assigned with a
 * random suffix so gateway URLs are not enumerable, and every creation check
 * (token registration, price floor, address format) has to pass before the
 * endpoint is active.
 */
export const endpointCreateSchema = z.object({
  upstreamUrl: httpsUrlSchema,
  priceAmount: positiveBaseUnitAmountSchema,
  assetContract: z.string().min(1),
  network: z.string().min(1),
  description: z.string().max(500).optional(),
  payoutMode: z.enum(["direct", "intents"]),
  destinationChain: z.string().min(1),
  destinationAsset: z.string().min(1),
  destinationAddress: z.string().min(1),
  refundAddress: z.string().min(1),
});
export type EndpointCreateInput = z.infer<typeof endpointCreateSchema>;

export const endpointDtoSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  gatewayUrl: z.string().url(),
  upstreamUrl: httpsUrlSchema,
  priceAmount: positiveBaseUnitAmountSchema,
  assetContract: z.string(),
  network: z.string(),
  payoutMode: z.enum(["direct", "intents"]),
  active: z.boolean(),
  description: z.string().nullable(),
  /**
   * Why an endpoint was left inactive, in the seller's language (PO-2). The
   * checks that fill it are a fixed handful, so 16 is far above what a real
   * creation can produce (C15).
   */
  creationWarnings: boundedArray(z.string(), 16),
});
export type EndpointDto = z.infer<typeof endpointDtoSchema>;

/**
 * A payout route. Immutable: changing destination creates a new row and only
 * affects later payments (PO-7). `depositAddress` and `modeDetail` stay null on
 * `direct` routes; which intents sub-design survives is decided by S2.
 */
export const payoutRouteDtoSchema = z.object({
  id: uuidSchema,
  destinationChain: z.string(),
  destinationAsset: z.string(),
  destinationAddress: z.string(),
  refundAddress: z.string(),
  provider: z.enum(["oneclick", "mock"]),
  depositAddress: z.string().nullable(),
  modeDetail: z.enum(["standing", "per_payment", "direct"]),
});
export type PayoutRouteDto = z.infer<typeof payoutRouteDtoSchema>;
