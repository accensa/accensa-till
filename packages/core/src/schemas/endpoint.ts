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
 * What the dashboard sends to `POST /api/endpoints` (UI-2, PO-2): the creation
 * input plus the address the seller was shown, echoed back. The route refuses a
 * create whose echo does not match, so a UI bug that submits a value nobody
 * confirmed is a `422` rather than a payout route to a stranger.
 */
export const endpointCreateRequestSchema = endpointCreateSchema.extend({
  confirmedAddress: z.string().min(1),
});
export type EndpointCreateRequest = z.infer<typeof endpointCreateRequestSchema>;

/**
 * The creation checks, named by what failed rather than by a prose string the UI
 * would have to match. `apps/api` owns the order they run in and the sentence each
 * one carries; this is the list both sides agree exists, so a check code that is
 * emitted but not declared here is a parse error in a test rather than an
 * unmapped code in the dashboard.
 */
export const creationCheckCodeSchema = z.enum([
  "network",
  "upstream_url",
  "price_floor",
  "destination_chain",
  "destination_address",
  "refund_address",
  "direct_destination",
  "deposit_address",
  "storage_registration",
  "storage_unverifiable",
]);
export type CreationCheckCode = z.infer<typeof creationCheckCodeSchema>;

export const creationCheckSchema = z.object({
  code: creationCheckCodeSchema,
  ok: z.boolean(),
  /** Seller-facing: says what failed and what to do about it. */
  message: z.string().max(400),
});
export type CreationCheck = z.infer<typeof creationCheckSchema>;

/**
 * `GET /api/endpoints` and `POST /api/endpoints` answers. A creation always
 * answers `201` with every check, including the ones that failed, because an
 * endpoint left inactive must explain itself (PO-2). Nine checks is the most
 * `checkEndpointCreation` can emit for one endpoint — one per rule, two storage
 * accounts at most — so 32 is a ceiling, not an expectation (C15).
 */
export const endpointListResponseSchema = z.object({
  endpoints: boundedArray(endpointDtoSchema, 256),
});
export const endpointCreateResponseSchema = z.object({
  endpoint: endpointDtoSchema,
  checks: boundedArray(creationCheckSchema, 32),
});
export type EndpointCreateResponse = z.infer<typeof endpointCreateResponseSchema>;

/**
 * The refusal shapes `/api/endpoints` answers, as one schema rather than four,
 * because the dashboard's job is to say *why* in the seller's words and it can
 * only do that if the code and its extras arrive typed. Deliberately not
 * `strict()`: a field added to a refusal must not break the dashboard that is
 * trying to explain a failure.
 */
export const endpointIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
});
export const dashboardErrorSchema = z.object({
  code: z.enum(["unauthenticated", "invalid_json", "invalid_request", "destination_not_confirmed"]),
  message: z.string(),
  /** Per-field refusals, for the form to put next to the input they came from. */
  issues: boundedArray(endpointIssueSchema, 32).optional(),
  /** Sent with `destination_not_confirmed`: the address the seller has to echo. */
  destinationAddress: z.string().optional(),
});
export type DashboardError = z.infer<typeof dashboardErrorSchema>;

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
