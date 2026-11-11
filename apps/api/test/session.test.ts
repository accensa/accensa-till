import { hkdfSync } from "node:crypto";

import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  SESSION_MAX_AGE_SECONDS,
  SIGN_IN_MAX_AGE_SECONDS,
  cookieOptions,
  createSessionCodec,
} from "../src/lib/session.ts";

/**
 * F1's signed cookies (A5, UI-1). No database and no network: what is pinned here
 * is the codec's own contract — a token is accepted only for its purpose, only by
 * the secret that minted it, only while it is unexpired and untouched, and only
 * with claims of the shape the routes then rely on.
 *
 * Every rejection is asserted as `null` rather than a throw, because that is the
 * contract the routes were written against: a dashboard request with a stale
 * cookie is the ordinary case, and a codec that throws moves the failure to
 * whichever caller forgot a `try`.
 *
 * Expiry is tested by minting a token whose lifetime is already negative, never by
 * sleeping — AGENTS.md forbids a suite that depends on wall-clock time.
 */

const SECRET = "abcdefghijklmnopqrstuvwxyz012345"; // 32 chars, env.ts's minimum
const OTHER_SECRET = "abcdefghijklmnopqrstuvwxyz012346";

const CLAIMS = {
  sellerId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  nearAccountId: "seller.testnet",
};

const CHALLENGE = {
  message: "Sign in to Till",
  recipient: "http://localhost:3001",
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  callbackUrl: null,
};

/** The same derivation lib/session.ts does, so a test can hand-write a token. */
function derivedKey(secret: string, info: string): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), "till-signed-cookies", info, 32),
  );
}

async function rawToken(
  key: Uint8Array,
  claims: Record<string, unknown>,
  algorithm = "HS256",
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: algorithm, typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

describe("the session cookie", () => {
  const codec = createSessionCodec(SECRET);

  it("round-trips the seller identity and nothing else", async () => {
    const token = await codec.createSessionCookie(CLAIMS);
    expect(await codec.verifySessionCookie(token)).toEqual(CLAIMS);
    // Three segments, and no secret material in the readable ones.
    expect(token.split(".")).toHaveLength(3);
    expect(Buffer.from(token).toString("utf8")).not.toContain(SECRET);
  });

  it("refuses a token from another secret, an empty one and garbage", async () => {
    const token = await codec.createSessionCookie(CLAIMS);
    const foreign = createSessionCodec(OTHER_SECRET);
    expect(await foreign.verifySessionCookie(token)).toBeNull();
    expect(await codec.verifySessionCookie("")).toBeNull();
    expect(await codec.verifySessionCookie("not.a.jwt")).toBeNull();
    expect(await codec.verifySessionCookie(`${token}x`)).toBeNull();
  });

  it("refuses a tampered payload whose signature still matches the old bytes", async () => {
    const token = await codec.createSessionCookie(CLAIMS);
    const [header, payload, signature] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined) {
      throw new Error("a session token is three dot-separated segments");
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub: string;
    };
    claims.sub = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
    const tampered = [
      header,
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      signature,
    ].join(".");
    expect(await codec.verifySessionCookie(tampered)).toBeNull();
  });

  it("refuses an expired token, minted with a negative lifetime", async () => {
    const expired = createSessionCodec(SECRET, { sessionMaxAgeSeconds: -60 });
    const token = await expired.createSessionCookie(CLAIMS);
    expect(await codec.verifySessionCookie(token)).toBeNull();
  });

  it("refuses a session token presented as a sign-in challenge, and the reverse", async () => {
    const session = await codec.createSessionCookie(CLAIMS);
    const challenge = await codec.createSignInCookie(CHALLENGE);
    expect(await codec.verifySignInCookie(session)).toBeNull();
    expect(await codec.verifySessionCookie(challenge)).toBeNull();
  });

  it("signs with a key derived per purpose, not with the configured secret", async () => {
    // A token that is correctly signed, correctly purposed and correctly shaped,
    // but with SESSION_SECRET used directly as the HMAC key: the one construction
    // an HS256 secret shared between purposes makes possible. Refusing it is what
    // HKDF buys, so this is the test that the split is load-bearing.
    const lookalike = await rawToken(derivedKey(SECRET, "unused"), {
      purpose: "session",
      sub: CLAIMS.sellerId,
      acct: CLAIMS.nearAccountId,
    });
    expect(await codec.verifySessionCookie(lookalike)).toBeNull();
  });

  it("refuses an algorithm other than HS256 for the same claims", async () => {
    const token = await rawToken(derivedKey(SECRET, "till-session-cookie"), {
      purpose: "session",
      sub: CLAIMS.sellerId,
      acct: CLAIMS.nearAccountId,
    });
    expect(await codec.verifySessionCookie(token)).toEqual(CLAIMS);

    const strong = await rawToken(
      derivedKey(SECRET, "till-session-cookie"),
      {
        purpose: "session",
        sub: CLAIMS.sellerId,
        acct: CLAIMS.nearAccountId,
      },
      "HS512",
    );
    expect(await codec.verifySessionCookie(strong)).toBeNull();

    const unsigned = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ purpose: "session", sub: CLAIMS.sellerId, acct: CLAIMS.nearAccountId }),
      ).toString("base64url"),
      "",
    ].join(".");
    expect(await codec.verifySessionCookie(unsigned)).toBeNull();
  });

  it("refuses a signed token whose claims are not a seller id and an account", async () => {
    for (const claims of [
      { purpose: "session", sub: "not-a-uuid", acct: CLAIMS.nearAccountId },
      { purpose: "session", sub: CLAIMS.sellerId, acct: "Not A Near Account" },
      { purpose: "session", sub: CLAIMS.sellerId },
      { purpose: "session", acct: CLAIMS.nearAccountId },
    ]) {
      const token = await rawToken(derivedKey(SECRET, "till-session-cookie"), { ...claims });
      expect(await codec.verifySessionCookie(token)).toBeNull();
    }
  });
});

describe("the sign-in challenge cookie", () => {
  const codec = createSessionCodec(SECRET);

  it("round-trips what the wallet was told to sign", async () => {
    const token = await codec.createSignInCookie(CHALLENGE);
    expect(await codec.verifySignInCookie(token)).toEqual(CHALLENGE);
  });

  it("keeps a callback url, and distinguishes none from empty", async () => {
    const withCallback = { ...CHALLENGE, callbackUrl: "https://dashboard.seller.test/done" };
    expect(await codec.verifySignInCookie(await codec.createSignInCookie(withCallback))).toEqual(
      withCallback,
    );
    expect(await codec.verifySignInCookie(await codec.createSignInCookie(CHALLENGE))).toEqual(
      CHALLENGE,
    );
  });

  it("refuses an expired challenge, and one from another secret", async () => {
    const token = await codec.createSignInCookie(CHALLENGE);
    expect(await createSessionCodec(OTHER_SECRET).verifySignInCookie(token)).toBeNull();
    const expired = createSessionCodec(SECRET, { signInMaxAgeSeconds: -1 });
    expect(await codec.verifySignInCookie(await expired.createSignInCookie(CHALLENGE))).toBeNull();
  });

  it("refuses a challenge whose claims have been dropped or retyped", async () => {
    for (const claims of [
      { purpose: "sign_in", rcpt: CHALLENGE.recipient, nonce: CHALLENGE.nonce },
      { purpose: "sign_in", msg: CHALLENGE.message, nonce: CHALLENGE.nonce },
      { purpose: "sign_in", msg: CHALLENGE.message, rcpt: CHALLENGE.recipient },
      { purpose: "sign_in", msg: 1, rcpt: CHALLENGE.recipient, nonce: CHALLENGE.nonce },
      { purpose: "sign_in", msg: CHALLENGE.message, rcpt: CHALLENGE.recipient, nonce: 2 },
    ]) {
      const token = await rawToken(derivedKey(SECRET, "till-sign-in-challenge"), { ...claims });
      expect(await codec.verifySignInCookie(token)).toBeNull();
    }
    // A `cb` that is neither null nor a string cannot be compared with the body,
    // so it is a rejection rather than an assumption.
    const objectCallback = await rawToken(derivedKey(SECRET, "till-sign-in-challenge"), {
      purpose: "sign_in",
      msg: CHALLENGE.message,
      rcpt: CHALLENGE.recipient,
      nonce: CHALLENGE.nonce,
      cb: { url: "https://attacker.test" },
    });
    expect(await codec.verifySignInCookie(objectCallback)).toBeNull();
  });
});

describe("cookie attributes (A5)", () => {
  it("scopes both cookies to /, http-only, Strict, and for their own lifetime", () => {
    expect(cookieOptions(SIGN_IN_MAX_AGE_SECONDS, false)).toEqual({
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 300,
      secure: false,
    });
    expect(cookieOptions(SESSION_MAX_AGE_SECONDS, true)).toEqual({
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 60 * 60 * 12,
      secure: true,
    });
  });

  it("puts the two lifetimes a route depends on in the constants", () => {
    expect([SIGN_IN_MAX_AGE_SECONDS, SESSION_MAX_AGE_SECONDS]).toEqual([300, 43200]);
  });
});
