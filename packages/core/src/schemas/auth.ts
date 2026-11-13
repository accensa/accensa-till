import { z } from "zod";

import { boundedArray, nearAccountIdSchema } from "./common.ts";

/**
 * Sign-in wire formats (UI-1, F1). `packages/core` holds them once and both apps
 * import them, so the dashboard cannot post a body the API reads differently
 * (PROJECT_STRUCTURE.md dependency rules).
 *
 * A signature is verified over the bytes it covers, so the fields the wallet
 * signed travel in the request rather than being looked up server-side: the server
 * re-encodes them and compares the nonce it issued. Nothing here is a secret — a
 * public key, a signature over a nonce, and an account name are exactly what a
 * browser is allowed to hold (UI-1's acceptance criterion is that no *key* does).
 */

/**
 * The two cookie names are part of the contract between the two apps, not of the
 * one that sets them: the API issues them (F1) and the dashboard has to know
 * which one to forward on a server-rendered read (UI-2), so a name that differs
 * between the two is a dashboard that is signed out forever.
 */
export const SESSION_COOKIE = "till_session";

/** The sign-in challenge: holds everything the wallet was asked to sign. */
export const SIGN_IN_COOKIE = "till_sign_in";

/** 43 characters is 32 bytes in base64url; the optional padding keeps standard base64 readable too. */ const nonceSchema =
  z
    .string()
    .regex(/^[0-9A-Za-z+/_-]{43}={0,2}$/)
    .describe("base64 of the 32-byte nonce the server issued");

/**
 * `<key-type>:<base58>`; the byte length is checked by the parser, not here. Both
 * NEAR key types parse so a secp256k1 sign-in is refused by name
 * (`key_type_unsupported`) rather than as a generic shape error.
 */
const publicKeySchema = z.string().regex(/^(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,110}$/);

/** Base64 (NEP-413's output interface) or `ed25519:<base58>` (what near-api-js prints). */
const signatureSchema = z
  .string()
  .regex(/^(?:ed25519:)?[0-9A-Za-z+/_=]{64,100}$/)
  .describe("ed25519 signature of the payload hash");

/** Every field is length-bounded: a sign-in body is unauthenticated, so a megabyte of `message` is a free request to hash (C15's shape, one field at a time). */
export const signedMessageRequestSchema = z.object({
  accountId: nearAccountIdSchema,
  publicKey: publicKeySchema,
  signature: signatureSchema,
  message: z.string().min(1).max(200),
  recipient: z.string().min(1).max(100),
  nonce: nonceSchema,
  /** Absent means borsh `option<string>` = None, which changes the hash, so it must be echoed exactly as signed. */
  callbackUrl: z.string().min(1).max(500).optional(),
});
export type SignedMessageRequest = z.infer<typeof signedMessageRequestSchema>;

/** The challenge `POST /auth/nonce` answers: everything the browser must hand to `wallet.signMessage`. */
export const signInChallengeSchema = z.object({
  message: z.string(),
  recipient: z.string(),
  nonce: nonceSchema,
  /** Null when Till does not use a wallet callback, which is the dashboard's case. */
  callbackUrl: z.string().nullable(),
});
export type SignInChallenge = z.infer<typeof signInChallengeSchema>;

export const sellerDtoSchema = z.object({
  id: z.string().uuid(),
  nearAccountId: nearAccountIdSchema,
  displayName: z.string().nullable(),
});
export type SellerDto = z.infer<typeof sellerDtoSchema>;

/** `POST /auth/verify` answers the seller row it signed into; the session itself is the HttpOnly cookie. */
export const signInResultSchema = z.object({
  seller: sellerDtoSchema,
});
export type SignInResult = z.infer<typeof signInResultSchema>;

export const authErrorCodeSchema = z.enum([
  "invalid_json",
  "invalid_request",
  "sign_in_challenge",
  "key_type_unsupported",
  "signature_invalid",
  "access_keys_unavailable",
  "account_not_found",
  "key_not_found",
  "sign_in_throttled",
]);
export type AuthErrorCode = z.infer<typeof authErrorCodeSchema>;

export const authErrorIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
});
export type AuthErrorIssue = z.infer<typeof authErrorIssueSchema>;

export const authErrorSchema = z.object({
  code: authErrorCodeSchema,
  message: z.string(),
  issues: boundedArray(authErrorIssueSchema, 32).optional(),
});
export type AuthError = z.infer<typeof authErrorSchema>;
