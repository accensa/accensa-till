import { z } from "zod";
import { PAYMENT_STATES } from "../states.ts";
import {
  boundedArray,
  nearAccountIdSchema,
  positiveBaseUnitAmountSchema,
  uuidSchema,
} from "./common.ts";

/** A payment as the dashboard sees it (UI-3: every row links its NEAR transaction). */
export const paymentDtoSchema = z.object({
  id: uuidSchema,
  endpointId: uuidSchema,
  routeId: uuidSchema.nullable(),
  payerAccountId: nearAccountIdSchema,
  amount: positiveBaseUnitAmountSchema,
  assetContract: z.string(),
  /**
   * The endpoint's own network (same shape as `endpointDtoSchema.network`, so the
   * payment row cannot invent a stricter rule than the row it belongs to). Carried
   * because UI-3's Done-when is a link per transaction, and a link needs to know
   * which chain the hash is on — the dashboard has no `NEAR_NETWORK` of its own.
   */
  network: z.string().min(1),
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
 * The seller's payment list (UI-3). Bounded at the read as well as the schema
 * (C15): the dashboard renders every row it is given, so an unbounded list is an
 * unbounded page.
 */
export const paymentListResponseSchema = z.object({
  payments: boundedArray(paymentDtoSchema, 256),
});
export type PaymentListResponse = z.infer<typeof paymentListResponseSchema>;

/**
 * x402 v2's `Network`: a chain namespace and a reference joined by one colon
 * (`near:testnet`, `eip155:84532`). The library types it as
 * `` `${string}:${string}` `` and its own schema rejects a bare `testnet`, so
 * checking the shape here is what turns a mis-set `NEAR_NETWORK` into a refusal
 * at boot rather than a settlement failure after the payer has been served.
 * Namespaces are not enumerated: the spec's rule is the colon, and a future
 * chain id is not our decision to forbid.
 */
export const x402NetworkSchema = z
  .string()
  .regex(/^[a-z0-9]{2,24}:[A-Za-z0-9._-]{1,40}$/, "expected a v2 network like `near:testnet`");

/**
 * The 402 body a payer receives (GW-1 acceptance: price, asset, network and
 * pay-to all present). This is x402 v2's `PaymentRequirements` for the NEAR
 * `exact` scheme, field for field: the payer's wallet picks a requirement by
 * comparing `scheme` and `network` strings, so the names are the counterparty's
 * and not ours to invent (C1). `amount` is base units as a decimal string, which
 * is what the scheme expects and what `parsePrice` would scale by the token's
 * decimals if we handed it anything else.
 */
export const paymentRequirementsSchema = z.object({
  scheme: z.literal("exact"),
  network: x402NetworkSchema,
  amount: positiveBaseUnitAmountSchema,
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  /** NEAR exact carries none: the relayer is facilitator-local (spec §3). */
  extra: z.record(z.string(), z.unknown()),
});
export type PaymentRequirementsDto = z.infer<typeof paymentRequirementsSchema>;

/**
 * x402 v2's `ResourceInfo`: what the buyer says the payment is for. It is an
 * object, not the bare URL string v1 put in `PaymentRequirements.resource`, and
 * the verifier the body is handed to types it that way too.
 *
 * We never read it — the price comes from our own cached requirements, never
 * from this field — but it is bounded here because it is forwarded on, and an
 * unbounded `tags` array or 4 MiB `description` costs us nothing to refuse.
 */
/**
 * Exported because the gateway advertises this shape as well as parses it (C2,
 * GW-1): the resource a payer sends back has the same bounds as the one we send
 * out, and a second definition of a wire bound is how the two drift.
 */
export const resourceInfoSchema = z.object({
  url: z.string().url().max(2048),
  description: z.string().max(2000).optional(),
  mimeType: z.string().max(128).optional(),
  serviceName: z.string().max(128).optional(),
  tags: boundedArray(z.string().max(128), 32).optional(),
  iconUrl: z.string().url().max(2048).optional(),
});

/**
 * The payment body a buyer posts (GW-2). `signedDelegateAction` is a base64
 * Borsh NEP-366 `SignedDelegate` holding exactly one `ft_transfer`; it is passed
 * to the scheme untouched and everything in it is re-derived on chain, so this
 * schema's job is to bound what reaches the verifier, not to interpret it.
 *
 * `accepted` is what the buyer *claims* it was asked to pay. The verifier is
 * handed our own cached requirements rather than this field, so a payer cannot
 * widen a price by editing it (GW-2).
 */
export const paymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  resource: resourceInfoSchema.optional(),
  accepted: paymentRequirementsSchema,
  payload: z.object({
    /** A signed delegate is ~330 bytes; 4 KiB is room for the scheme's own growth. */
    signedDelegateAction: z.string().min(64).max(4096),
  }),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentPayloadInput = z.infer<typeof paymentPayloadSchema>;
