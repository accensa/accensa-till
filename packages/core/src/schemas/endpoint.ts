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

/**
 * At least one editable field has to be present. `null` counts as a change — it is
 * how a seller clears a description — while an absent key does not. The confirmation
 * echo is not itself a change: a body carrying only `confirmedAddress` proposes
 * nothing.
 */
function changesOneField(body: Record<string, unknown>): boolean {
  return Object.entries(body).some(
    ([key, value]) => value !== undefined && key !== "confirmedAddress",
  );
}

/**
 * What a seller may change on an endpoint that already exists (D9, PO-7).
 *
 * Every field is optional and at least one has to be present, because an empty
 * change is a write of the same values, a fresh set of check messages and a log
 * line for an edit that did not happen.
 *
 * The list is deliberately short and the object is `strict()`, so the fields that
 * are *not* here are refused by name rather than silently dropped:
 *
 * - `network` and `assetContract` are what a payer's signed delegate is
 *   denominated in. Re-stating them under a live slug would make the endpoint's
 *   past payments disagree with it about the token they were paid in, and the
 *   reconciliation joins read that column per payment.
 * - `id`, `slug` and `sellerId` are not a seller's to choose. A body that could
 *   name one could change somebody else's endpoint or move it to another account,
 *   and zod's default is to ignore unknown keys — which is exactly the failure mode
 *   that turns a caller assuming it was honoured into a bug.
 * - `routeId` is not settable at all: a route is resolved from the destination, and
 *   an editor that could point an endpoint at an arbitrary route row would bypass
 *   the whole of PO-7.
 *
 * A destination may be changed partly (`destinationAddress` alone): `apps/api` merges
 * it onto the stored row, because the seller is editing one field of a form they
 * already filled in, not resubmitting a creation.
 */
const endpointUpdateFields = z
  .object({
    upstreamUrl: httpsUrlSchema.optional(),
    priceAmount: positiveBaseUnitAmountSchema.optional(),
    description: z.string().max(500).nullish(),
    payoutMode: z.enum(["direct", "intents"]).optional(),
    destinationChain: z.string().min(1).optional(),
    destinationAsset: z.string().min(1).optional(),
    destinationAddress: z.string().min(1).optional(),
    refundAddress: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const endpointUpdateSchema = endpointUpdateFields.refine(changesOneField, {
  message: "at least one field has to change",
});
export type EndpointUpdateInput = z.infer<typeof endpointUpdateSchema>;

/**
 * A change that names a new destination address has to carry the echo create
 * already requires (`confirmedAddress`): the address is where the seller's money
 * will come to rest, and a body the UI assembled without showing it is a `422`, not
 * a payout route to a stranger. The value itself is compared in the route, which is
 * where both the proposed and the confirmed strings are in hand.
 */
export const endpointUpdateRequestSchema = endpointUpdateFields
  .extend({ confirmedAddress: z.string().min(1).optional() })
  .refine(changesOneField, {
    message: "at least one field has to change",
  });
export type EndpointUpdateRequest = z.infer<typeof endpointUpdateRequestSchema>;

/**
 * A payout route. Immutable: changing destination creates a new row and only
 * affects later payments (PO-7). `depositAddress` and `modeDetail` stay null on
 * `direct` routes; which intents sub-design survives is decided by S2.
 *
 * Declared before `endpointDtoSchema` because that DTO is built with a reference
 * to it at module evaluation, and a `const` below would still be in its own
 * temporal dead zone when the object is assembled.
 */
export const payoutRouteDtoSchema = z.object({
  id: uuidSchema,
  // `.min(1)` on the four destination fields states D5's invariant at the
  // boundary: a route is only written once `checkEndpointCreation` called the
  // destination sound, so an empty one on a read back is a bug, not a state.
  destinationChain: z.string().min(1),
  destinationAsset: z.string().min(1),
  destinationAddress: z.string().min(1),
  refundAddress: z.string().min(1),
  provider: z.enum(["oneclick", "mock"]),
  depositAddress: z.string().nullable(),
  modeDetail: z.enum(["standing", "per_payment", "direct"]),
});
export type PayoutRouteDto = z.infer<typeof payoutRouteDtoSchema>;

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
   * The endpoint's own payout route, or `null` when it has none (D5). Required
   * rather than optional on purpose: the destination lives on that row, so a
   * dashboard that cannot see it cannot show it, and D9 refuses a `PATCH` whose
   * `confirmedAddress` does not echo what was shown. A read that forgot the join
   * would otherwise render empty destination fields for a seller to "confirm".
   */
  route: payoutRouteDtoSchema.nullable(),
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
 * What `PATCH /api/endpoints/:id` answers (D9, PO-7): the same shape as a create,
 * because the seller needs the same thing either way — the endpoint as it now stands
 * and every check with its sentence. It is an alias rather than a second definition
 * so the two cannot drift into different responses that the dashboard reads
 * identically.
 */
export const endpointUpdateResponseSchema = endpointCreateResponseSchema;
export type EndpointUpdateResponse = EndpointCreateResponse;

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
  code: z.enum([
    "unauthenticated",
    "invalid_json",
    "invalid_request",
    "destination_not_confirmed",
    // UI-3: a stored payment the contract refuses. Named here so the dashboard can
    // show the sentence rather than the shorter list it got.
    "payment_unreadable",
    // UI-4, same rule one table later: the reconciliation reads answer with a code
    // rather than a shorter worklist. `discrepancy_not_found` is the resolve
    // refusal for a row that is not this seller's *or* is already closed, and both
    // mean one answer here, because telling them apart says which rows another
    // seller has.
    "discrepancy_unreadable",
    "discrepancy_not_found",
    "payer_block_unreadable",
    // UI-5, same rule again: a header whose own facts the contract will not take is
    // a refusal with a code, not a header that dropped a line. A seller who reads a
    // missing balance as a balance of nothing is reading an absence as a fact.
    "status_unreadable",
    // D9, UI-2's edit step: an id that is not this seller's endpoint. Deliberately
    // one answer for "not there" and "somebody else's", for the same reason
    // `discrepancy_not_found` is: distinguishing them says which rows another
    // seller has.
    "endpoint_not_found",
  ]),
  message: z.string(),
  /** Per-field refusals, for the form to put next to the input they came from. */
  issues: boundedArray(endpointIssueSchema, 32).optional(),
  /** Sent with `destination_not_confirmed`: the address the seller has to echo. */
  destinationAddress: z.string().optional(),
});
export type DashboardError = z.infer<typeof dashboardErrorSchema>;
