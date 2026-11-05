import { hkdfSync } from "node:crypto";
import { nearAccountIdSchema, uuidSchema } from "@till/core";
import { SignJWT, jwtVerify } from "jose";

/**
 * Signed cookies via jose (UI-1, A5, F1). HTTP-only, SameSite=Strict, single
 * origin, and carrying no secret: the session holds only the seller id and the
 * account name it signed in with. The signature is verified on every dashboard
 * request, and there is no sessions table (cut as overengineered, so a logout is
 * a cookie delete).
 *
 * SESSION_SECRET is validated at boot (env.ts) and must never be logged —
 * lib/logger.ts redacts it by key name.
 *
 * Two cookies are signed by one configured secret, and one secret used directly
 * for two purposes is the classic way to make them interchangeable, so the key is
 * split with HKDF (RFC 5869) per purpose before it reaches jose. A session token
 * is therefore not a valid sign-in challenge even in a code path that forgot to
 * look at the `purpose` claim — which is the second, cheaper check kept on top.
 */

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

/**
 * Five minutes: long enough to approve a wallet prompt, short enough that an
 * unused challenge is not a durable credential.
 */
export const SIGN_IN_MAX_AGE_SECONDS = 300;

const KEY_LENGTH_BYTES = 32;
const HKDF_SALT = "till-signed-cookies";
const HKDF_INFO = { session: "till-session-cookie", signIn: "till-sign-in-challenge" };
const ALGORITHM = "HS256";

export type SessionClaims = {
  readonly sellerId: string;
  readonly nearAccountId: string;
};

/**
 * Everything Till issued the wallet to sign, remembered in the cookie so the
 * verify request cannot invent any of it. `nonce` is base64url of 32 bytes.
 */
export type SignInClaims = {
  readonly message: string;
  readonly recipient: string;
  readonly nonce: string;
  readonly callbackUrl: string | null;
};

export type SessionCodec = {
  createSessionCookie(claims: SessionClaims): Promise<string>;
  verifySessionCookie(token: string): Promise<SessionClaims | null>;
  createSignInCookie(claims: SignInClaims): Promise<string>;
  verifySignInCookie(token: string): Promise<SignInClaims | null>;
};

/**
 * The two lifetimes, and the only reason they are settable: a test that wants an
 * expired cookie mints one with a negative lifetime rather than sleeping, because
 * AGENTS.md forbids a suite that depends on wall-clock time. Production passes
 * nothing and gets the constants above.
 */
export type SessionCodecOptions = {
  readonly sessionMaxAgeSeconds?: number;
  readonly signInMaxAgeSeconds?: number;
};

/**
 * Domain separation, not secrecy: the salt and info strings are fixed and public,
 * and their only job is that two purposes never share a derived key.
 */
function derivedKey(secret: string, info: string): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), HKDF_SALT, info, KEY_LENGTH_BYTES),
  );
}

async function sign(
  key: Uint8Array,
  purpose: string,
  payload: Record<string, string | null>,
  maxAgeSeconds: number,
): Promise<string> {
  return await new SignJWT({ purpose, ...payload })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
    .setIssuedAt()
    // A number, not a `+N seconds` string, because a negative lifetime is how a
    // test mints an expired token; only the numeric form survives that.
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAgeSeconds)
    .sign(key);
}

/**
 * Any rejection is `null`, never a throw: a stale, tampered or foreign-signed
 * cookie is the ordinary case on a public route, and a caller that has to catch is
 * a caller that will eventually forget to.
 */
async function read(
  key: Uint8Array,
  token: string,
  purpose: string,
): Promise<Record<string, unknown> | null> {
  try {
    // jose validates `exp` itself, so an expired token never reaches the purpose
    // check. Nothing here reads a clock: expiry is the token's, not ours.
    const { payload } = await jwtVerify(token, key, { algorithms: [ALGORITHM] });
    return payload.purpose === purpose ? payload : null;
  } catch {
    return null;
  }
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function createSessionCodec(
  secret: string,
  options: SessionCodecOptions = {},
): SessionCodec {
  const sessionKey = derivedKey(secret, HKDF_INFO.session);
  const signInKey = derivedKey(secret, HKDF_INFO.signIn);
  const sessionMaxAge = options.sessionMaxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
  const signInMaxAge = options.signInMaxAgeSeconds ?? SIGN_IN_MAX_AGE_SECONDS;

  return {
    async createSessionCookie(claims) {
      return await sign(
        sessionKey,
        "session",
        { sub: claims.sellerId, acct: claims.nearAccountId },
        sessionMaxAge,
      );
    },

    async verifySessionCookie(token) {
      const payload = await read(sessionKey, token, "session");
      if (payload === null) {
        return null;
      }
      const sellerId = stringClaim(payload.sub);
      const nearAccountId = stringClaim(payload.acct);
      // The signature already proves where these came from; the shape check is
      // here so a token minted by an older build of this same secret cannot hand
      // a route an `undefined` seller id.
      if (
        sellerId === null ||
        nearAccountId === null ||
        !uuidSchema.safeParse(sellerId).success ||
        !nearAccountIdSchema.safeParse(nearAccountId).success
      ) {
        return null;
      }
      return { sellerId, nearAccountId };
    },

    async createSignInCookie(claims) {
      return await sign(
        signInKey,
        "sign_in",
        {
          msg: claims.message,
          rcpt: claims.recipient,
          nonce: claims.nonce,
          cb: claims.callbackUrl,
        },
        signInMaxAge,
      );
    },

    async verifySignInCookie(token) {
      const payload = await read(signInKey, token, "sign_in");
      if (payload === null) {
        return null;
      }
      const message = stringClaim(payload.msg);
      const recipient = stringClaim(payload.rcpt);
      const nonce = stringClaim(payload.nonce);
      if (message === null || recipient === null || nonce === null) {
        return null;
      }
      const callbackUrl = payload.cb;
      if (callbackUrl !== null && typeof callbackUrl !== "string") {
        return null;
      }
      return { message, recipient, nonce, callbackUrl };
    },
  };
}

/**
 * Both cookies are scoped to `/api`, which is both the whole dashboard surface and
 * strictly narrower than the origin: a buyer's request hits `/r/:slug`, so with
 * this path the session cookie is never sent to the gateway at all (G6 F2's class
 * of problem, removed rather than filtered). `secure` follows NODE_ENV so a local
 * http dashboard can still set the cookie, while a production deploy cannot serve
 * it over plain http.
 */
export function cookieOptions(maxAgeSeconds: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "Strict" as const,
    path: "/api",
    maxAge: maxAgeSeconds,
    secure,
  };
}
