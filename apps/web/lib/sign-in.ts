import {
  type AuthError,
  type AuthErrorCode,
  type SignInChallenge,
  type SignedMessageRequest,
  signedMessageRequestSchema,
} from "@till/core/schemas";

/**
 * Sign-in business logic and formatting (UI-1, F1, F8).
 * Pure functions: no DOM, no fetch, no browser globals, so vitest can run
 * the logic completely offline.
 */

export type SignInFormField = "accountId" | "publicKey" | "signature";

export type SignInFormValues = Readonly<Record<SignInFormField, string>>;

export type SignInFieldErrors = Partial<Record<SignInFormField, string>>;

export const emptySignInForm: SignInFormValues = {
  accountId: "",
  publicKey: "",
  signature: "",
};

export const AUTH_CODE_DESCRIPTIONS: Readonly<Record<AuthErrorCode, string>> = {
  sign_in_challenge:
    "The challenge expired or does not match this server. Request a fresh challenge.",
  key_type_unsupported: "Till verifies ed25519 signatures; this key is not an ed25519 NEAR key.",
  signature_invalid: "That signature does not cover this message, nonce, and key.",
  access_keys_unavailable:
    "Till could not read this account's access keys from the RPC. Try again in a moment.",
  account_not_found: "This account does not exist on the configured NEAR network.",
  key_not_found:
    "That key is not a full-access key of this account, and NEP-413 sign-in requires one.",
  invalid_request:
    "The sign-in payload was rejected. Verify account format, public key, and signature.",
  invalid_json: "The server received an unreadable payload.",
  sign_in_throttled:
    "Too many sign-in attempts for now. Wait a moment, then request a new challenge.",
};

/**
 * Decodes a base64 / base64url encoded nonce string into bytes in browser environments
 * without relying on Node's Buffer or node:crypto.
 */
export function decodeBase64Nonce(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function authErrorMessage(error: AuthError): string {
  return AUTH_CODE_DESCRIPTIONS[error.code] ?? error.message;
}

/**
 * Formats the exact command an operator or seller can run in their terminal with
 * `near-cli-rs` to sign the NEP-413 challenge directly with their local credentials.
 */
export function buildCliCommand(challenge: SignInChallenge, accountId?: string): string {
  const acct = accountId && accountId.trim().length > 0 ? accountId.trim() : "<account.testnet>";
  return `near account sign-message ${acct} "${challenge.message}" --recipient "${challenge.recipient}" --nonce "${challenge.nonce}"`;
}

export type ValidateSignInResult =
  | { readonly ok: true; readonly request: SignedMessageRequest }
  | { readonly ok: false; readonly errors: SignInFieldErrors };

/**
 * Validates the manual form inputs against the active server challenge.
 */
export function validateSignInInput(
  values: SignInFormValues,
  challenge: SignInChallenge,
): ValidateSignInResult {
  const errors: SignInFieldErrors = {};

  const trimmedAccount = values.accountId.trim();
  const trimmedKey = values.publicKey.trim();
  const trimmedSig = values.signature.trim();

  if (!trimmedAccount) {
    errors.accountId = "NEAR Account ID is required (e.g. seller.testnet)";
  }
  if (!trimmedKey) {
    errors.publicKey = "Public key is required (e.g. ed25519:...)";
  }
  if (!trimmedSig) {
    errors.signature = "Signature is required";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const candidate = {
    accountId: trimmedAccount,
    publicKey: trimmedKey,
    signature: trimmedSig,
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: challenge.nonce,
    ...(challenge.callbackUrl ? { callbackUrl: challenge.callbackUrl } : {}),
  };

  const parsed = signedMessageRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as SignInFormField;
      if (field && field in emptySignInForm && !errors[field]) {
        errors[field] = issue.message;
      }
    }
    return { ok: false, errors };
  }

  return { ok: true, request: parsed.data };
}
