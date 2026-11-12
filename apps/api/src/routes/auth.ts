import {
  type AuthErrorCode,
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  decodeSignInNonce,
  newSignInNonce,
  noncesEqual,
  parseNearPublicKey,
  signInResultSchema,
  signedMessageRequestSchema,
  verifyNep413Signature,
} from "@till/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { Db } from "../db/client.ts";
import type { Env } from "../env.ts";
import type { Logger } from "../lib/logger.ts";
import {
  SESSION_MAX_AGE_SECONDS,
  SIGN_IN_MAX_AGE_SECONDS,
  cookieOptions,
  createSessionCodec,
} from "../lib/session.ts";
import {
  type AccessKeyList,
  type AccessKeyReader,
  createAccessKeyReader,
} from "../services/access-keys.ts";
import { findOrCreateSeller } from "../services/sellers.ts";

/**
 * Wallet-signature sign-in (UI-1, A5, F1).
 *
 * Two routes, no database write in the first and no session in either — they are
 * the entrance, so they cannot be behind the thing they issue.
 *
 * `POST /auth/nonce` mints a 32-byte challenge and returns the exact payload the
 * wallet must sign, while keeping a copy of it in its own signed cookie. That is
 * what makes the verify request safe to be self-reported: the five fields the
 * signature covers arrive in the body, and every one of them is compared against
 * what *this process* issued minutes earlier. A body that invents a recipient, a
 * message or a nonce fails on comparison rather than on trust.
 *
 * `POST /auth/verify` then asks the chain whether the key that signed is a
 * full-access key **of the account it claims** (NEP-413 requires full access, and
 * only the chain can answer), and nothing before that step costs more than a
 * sha256 and an ed25519 verify. That order is the rate limit: an attacker
 * hammering this route cannot make it read the RPC without first producing a
 * signature valid for their own key.
 *
 * The session cookie it issues is the only credential a browser ends up holding,
 * and it carries a seller id and an account name — no key, no secret (UI-1's
 * acceptance criterion).
 */

export const SIGN_IN_MESSAGE = "Sign in to Till";

export type { AuthErrorCode };

export type AuthRouteDeps = {
  readonly db: Db;
  readonly env: Env;
  readonly log: Logger;
  /** The one thing a test cannot do: read the chain. */
  readonly accessKeys?: AccessKeyReader;
};

/** The origin signatures are bound to, from the one configured public URL (A4). */
function recipientOf(gatewayPublicUrl: string): string {
  return new URL(gatewayPublicUrl).origin;
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
  const { db, env, log } = deps;
  const codec = createSessionCodec(env.SESSION_SECRET);
  const readAccessKeys = deps.accessKeys ?? createAccessKeyReader({ rpcUrl: env.NEAR_RPC_URL });
  const secure = env.NODE_ENV === "production";

  const app = new Hono();

  app.post("/auth/nonce", async (c) => {
    const challenge = {
      message: SIGN_IN_MESSAGE,
      recipient: recipientOf(env.GATEWAY_PUBLIC_URL),
      nonce: newSignInNonce(),
      callbackUrl: null,
    };
    setCookie(
      c,
      SIGN_IN_COOKIE,
      await codec.createSignInCookie(challenge),
      cookieOptions(SIGN_IN_MAX_AGE_SECONDS, secure),
    );
    // The challenge is public by design: it names this origin and expires in five
    // minutes, and the only thing it proves to a reader is that someone is about
    // to sign it.
    log.info({ code: "sign_in_challenge_issued", recipient: challenge.recipient }, "sign-in nonce");
    return c.json(challenge);
  });

  app.post("/auth/verify", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      // 400, not 401: nothing about the caller's identity failed, the body is just
      // not readable, and `invalid_request` below answers the same way.
      return refuse(c, log, "invalid_json", "The request body is not JSON.", undefined, 400);
    }
    const parsed = signedMessageRequestSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_request",
          message: "The signed message could not be read from this body.",
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        },
        400,
      );
    }
    const request = parsed.data;

    const issued = await codec.verifySignInCookie(getCookie(c, SIGN_IN_COOKIE) ?? "");
    if (issued === null) {
      return refuse(
        c,
        log,
        "sign_in_challenge",
        "No valid sign-in challenge on this browser; request one and sign that.",
        request.accountId,
      );
    }
    if (
      issued.message !== request.message ||
      issued.recipient !== request.recipient ||
      !noncesEqual(issued.nonce, request.nonce) ||
      (issued.callbackUrl ?? null) !== (request.callbackUrl ?? null)
    ) {
      return refuse(
        c,
        log,
        "sign_in_challenge",
        "The signed message does not match the challenge Till issued.",
        request.accountId,
      );
    }

    const publicKey = parseNearPublicKey(request.publicKey);
    if (publicKey === null || publicKey.type !== "ed25519") {
      // Named before the signature step, because "your wallet signed this with a
      // key type Till does not verify" is a different fix than "that signature is
      // wrong", and a seller cannot tell which it is from outside.
      return refuse(
        c,
        log,
        "key_type_unsupported",
        "Till verifies ed25519 signatures; this key is not an ed25519 NEAR key.",
        request.accountId,
      );
    }

    if (
      !verifyNep413Signature({
        message: request.message,
        recipient: request.recipient,
        nonce: decodeSignInNonce(request.nonce) ?? new Uint8Array(),
        ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
        publicKey: request.publicKey,
        signature: request.signature,
      })
    ) {
      return refuse(
        c,
        log,
        "signature_invalid",
        "That signature does not cover this message and key.",
        request.accountId,
      );
    }

    const keys: AccessKeyList = await readAccessKeys(request.accountId);
    if (!keys.ok) {
      return keys.reason === "account_missing"
        ? refuse(
            c,
            log,
            "account_not_found",
            `${request.accountId} is not an account on ${env.NEAR_NETWORK}.`,
            request.accountId,
          )
        : refuse(
            c,
            log,
            "access_keys_unavailable",
            "Till could not read this account's access keys; try again.",
            request.accountId,
            503,
          );
    }
    const listed = keys.keys.find((key) => {
      const candidate = parseNearPublicKey(key.publicKey);
      // Bytes, not strings: the wallet's own spelling of its key is not the point,
      // the key is.
      return (
        candidate !== null &&
        candidate.type === publicKey.type &&
        Buffer.from(candidate.bytes).equals(publicKey.bytes)
      );
    });
    if (listed === undefined || !listed.fullAccess) {
      // One code for both "not in the list" and "in the list as a function-call
      // key": which keys an account carries is not information to give out.
      return refuse(
        c,
        log,
        "key_not_found",
        "That key is not a full-access key of this account, and NEP-413 needs one.",
        request.accountId,
      );
    }

    const seller = await findOrCreateSeller(db, request.accountId);
    setCookie(
      c,
      SESSION_COOKIE,
      await codec.createSessionCookie({
        sellerId: seller.id,
        nearAccountId: seller.nearAccountId,
      }),
      cookieOptions(SESSION_MAX_AGE_SECONDS, secure),
    );
    // The challenge is spent. It could still be replayed by anyone holding a copy
    // until its own expiry — with no sessions table there is nothing to mark it
    // used, and that five-minute window is stated as a limitation rather than
    // fixed by a store — but deleting it keeps the browser from sending a stale
    // cookie on every later request.
    deleteCookie(c, SIGN_IN_COOKIE, { path: "/", secure });

    log.info({ code: "signed_in", accountId: seller.nearAccountId }, "wallet sign-in");
    return c.json(signInResultSchema.parse({ seller }));
  });

  app.post("/auth/sign-out", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
    log.info({ code: "signed_out" }, "wallet sign-out");
    return c.json({ ok: true });
  });

  return app;
}

function refuse(
  c: Context,
  log: Logger,
  code: AuthErrorCode,
  message: string,
  accountId?: string,
  status: 401 | 400 | 503 = 401,
) {
  // Never the signature, the public key or a cookie: a refusal line is a log an
  // operator reads, and none of those values help them once the code is named.
  log.warn({ code, accountId: accountId ?? null }, "sign-in refused");
  return c.json({ code, message }, status);
}
