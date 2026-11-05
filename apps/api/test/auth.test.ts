import { generateKeyPairSync, randomBytes, sign as signEd25519 } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import type { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Nep413Payload,
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  decodeSignInNonce,
  hashNep413Payload,
  newSignInNonce,
} from "@till/core";

import { createApp } from "../src/app.ts";
import * as schema from "../src/db/schema.ts";
import { type Env, loadEnv } from "../src/env.ts";
import type { Logger } from "../src/lib/logger.ts";
import { SIGN_IN_MAX_AGE_SECONDS, createSessionCodec } from "../src/lib/session.ts";
import { SIGN_IN_MESSAGE, createAuthRoutes } from "../src/routes/auth.ts";
import type { AccessKeyList, AccessKeyReader } from "../src/services/access-keys.ts";
import { createX402Near } from "../src/x402/near.ts";

/**
 * F1's sign-in routes (UI-1, A5): a wallet signature in, an HTTP-only session
 * cookie out, with no secret in the browser.
 *
 * The keypair is generated here and signed with `node:crypto`, so the signature the
 * route accepts is not produced by the code under test. Only the payload encoding is
 * shared, and that is pinned against library-measured vectors in
 * `packages/core/src/auth/__tests__/nep413.test.ts`.
 *
 * The chain read is the one thing no offline suite can perform — F1's A10 half — so
 * `accessKeys` is injected. That injection is deliberately account-aware, like the
 * chain: a signature proves a key was used, and only the key list says whose the key
 * is. Together with the challenge comparison this is what makes a self-reported
 * verify request unable to lie.
 *
 * Needs `DATABASE_URL`; without a reachable database the file skips.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function createTestDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

type Handle = { readonly sql: postgres.Sql; readonly db: ReturnType<typeof createTestDb> };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openDatabase(url: string): Promise<Handle> {
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 3 });
  try {
    await sql`select 1`;
    const [present] = await sql`select to_regclass('public.sellers') as present`;
    if (present !== undefined && present.present === null) {
      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
      }
    }
  } catch (error) {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    throw error;
  }
  return { sql, db: createTestDb(sql) };
}

let handle: Handle | null = null;
let skipReason = "DATABASE_URL is not set";
const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl !== "") {
  try {
    handle = await openDatabase(databaseUrl);
  } catch (error) {
    skipReason = `database from DATABASE_URL is unusable: ${message(error)}`;
  }
}

function need(): Handle {
  if (handle === null) {
    throw new Error(`unreachable: the suite should have skipped for "${skipReason}"`);
  }
  return handle;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Only to spell a test key the way NEAR spells keys. */
function toBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  let text = "";
  while (value > 0n) {
    text = `${BASE58[Number(value % 58n)] ?? "?"}${text}`;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    text = `1${text}`;
  }
  return text;
}

type Wallet = {
  readonly accountId: string;
  readonly publicKey: string;
  /** What a wallet does: ed25519 over the 32-byte NEP-413 hash, base64 the result. */
  sign(payload: Nep413Payload): { publicKey: string; signature: string };
};

function createWallet(accountId: string): Wallet {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spelling = `ed25519:${toBase58(
    new Uint8Array(publicKey.export({ type: "spki", format: "der" }).subarray(-32)),
  )}`;
  return {
    accountId,
    publicKey: spelling,
    sign: (payload) => ({
      publicKey: spelling,
      signature: Buffer.from(
        signEd25519(null, Buffer.from(hashNep413Payload(payload)), privateKey),
      ).toString("base64"),
    }),
  };
}

const run = randomUUID().slice(0, 8);
const ACCOUNT = `till-f1-${run}.testnet`;
const RECIPIENT = "http://localhost:3001";
const SECRET_MATERIAL = "f1-session-secret-material-0000000000";
/** A real secp256k1 NEAR key: Till refuses that key type before it verifies. */
const SECP_KEY =
  "secp256k1:5RcPqvYSAn32w5hMc1XCCrTijgXNB4KsCVpudRRzjkESGQGf9quwTgwZryLA93oWzB5WdUck51vo1aLhvxyYsEth";

let env: Env;
let wallet: Wallet;
const foreignCodec = createSessionCodec(`${SECRET_MATERIAL}-other`);

const quiet: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

/** Captures every line the route logs, so log hygiene is an assertion. */
function recordingLogger(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const collect =
    (level: string): Logger["info"] =>
    (fields, msg) => {
      lines.push(JSON.stringify({ level, fields, message: msg }));
    };
  const log: Logger = {
    info: collect("info"),
    warn: collect("warn"),
    error: collect("error"),
    child: () => log,
  };
  return { log, lines };
}

const fullAccessOf = (publicKey: string): AccessKeyList => ({
  ok: true,
  keys: [{ publicKey, fullAccess: true }],
});

/**
 * A key list in the chain's image: it answers for one account only, and every
 * other account simply is not there.
 */
function fakeReader(list: AccessKeyList, owner: string = ACCOUNT) {
  const seen: string[] = [];
  const reader: AccessKeyReader = async (accountId) => {
    seen.push(accountId);
    return accountId === owner ? list : { ok: false, reason: "account_missing" };
  };
  return { reader, seen };
}

async function seed(): Promise<void> {
  env = loadEnv({
    ...process.env,
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: SECRET_MATERIAL,
    GATEWAY_PUBLIC_URL: RECIPIENT,
    NEAR_NETWORK: "near:testnet",
  });
  wallet = createWallet(ACCOUNT);
}

type App = Pick<Hono, "request">;

type Challenge = {
  message: string;
  recipient: string;
  nonce: string;
  callbackUrl: string | null;
};

/** The nonce step: the challenge a wallet is shown, plus the cookie that remembers it. */
async function issueNonce(app: App) {
  const response = await app.request("/auth/nonce", { method: "POST" });
  const setCookie = response.headers.getSetCookie()[0] ?? "";
  const token = /till_sign_in=([^;]*)/.exec(setCookie)?.[1] ?? "";
  return { response, setCookie, token, challenge: (await response.json()) as Challenge };
}

function signedFor(challenge: Challenge, signer: Wallet): Record<string, unknown> {
  const nonceBytes = decodeSignInNonce(challenge.nonce);
  if (nonceBytes === null) {
    throw new Error("the challenge nonce is not 32 bytes of base64url");
  }
  const signed = signer.sign({
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: nonceBytes,
    ...(challenge.callbackUrl === null || challenge.callbackUrl === undefined
      ? {}
      : { callbackUrl: challenge.callbackUrl }),
  });
  return {
    accountId: signer.accountId,
    ...signed,
    message: challenge.message,
    recipient: challenge.recipient,
    nonce: challenge.nonce,
    ...(challenge.callbackUrl === null || challenge.callbackUrl === undefined
      ? {}
      : { callbackUrl: challenge.callbackUrl }),
  };
}

/** The body an honest wallet sends for a challenge. */
function honestBody(challenge: Challenge): Record<string, unknown> {
  return signedFor(challenge, wallet);
}

function verifyRequest(
  app: App,
  challenge: Challenge,
  options: { token?: string; body?: Record<string, unknown> } = {},
) {
  return app.request("/auth/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SIGN_IN_COOKIE}=${options.token ?? ""}`,
    },
    body: JSON.stringify(options.body ?? honestBody(challenge)),
  });
}

function routeApp(options: { accessKeys?: AccessKeyList; log?: Logger } = {}) {
  const { reader, seen } = fakeReader(options.accessKeys ?? fullAccessOf(wallet.publicKey));
  return {
    seen,
    app: createAuthRoutes({ db: need().db, env, log: options.log ?? quiet, accessKeys: reader }),
  };
}

/** Sign in through the full app and hand back the session cookie it issued. */
async function signInThroughApp(reader: AccessKeyReader) {
  const app = createApp({
    env,
    log: quiet,
    db: need().db,
    x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
    auth: { accessKeys: reader },
  });
  const issued = await app.request("/api/auth/nonce", { method: "POST" });
  const token = /till_sign_in=([^;]*)/.exec(issued.headers.getSetCookie()[0] ?? "")?.[1] ?? "";
  const challenge = (await issued.json()) as Challenge;
  const response = await app.request("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SIGN_IN_COOKIE}=${token}` },
    body: JSON.stringify(signedFor(challenge, wallet)),
  });
  const session =
    /till_session=([^;]*)/.exec(
      response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`)) ?? "",
    )?.[1] ?? "";
  return { app, token, session, response };
}

const suite = describe.skipIf(handle === null);

suite("POST /auth/nonce issues a challenge and remembers it", () => {
  beforeAll(seed);

  it("names this origin, binds the message, and sets a five-minute http-only cookie", async () => {
    const { app } = routeApp();
    const { response, challenge, setCookie, token } = await issueNonce(app);

    expect(response.status).toBe(200);
    expect(challenge).toEqual({
      message: SIGN_IN_MESSAGE,
      recipient: RECIPIENT,
      nonce: expect.stringMatching(/^[0-9A-Za-z_-]{43}$/),
      callbackUrl: null,
    });
    expect(decodeSignInNonce(challenge.nonce)?.length).toBe(32);
    expect(token.length).toBeGreaterThan(40);

    expect(setCookie.startsWith(`${SIGN_IN_COOKIE}=`)).toBe(true);
    for (const attribute of ["Max-Age=300", "Path=/api", "HttpOnly", "SameSite=Strict"]) {
      expect(setCookie).toContain(attribute);
    }
    // NODE_ENV is not production here, and a cookie marked Secure would never be
    // set over local http at all.
    expect(setCookie).not.toContain("Secure");
    expect(SIGN_IN_MAX_AGE_SECONDS).toBe(300);
    // A signed copy of a public challenge, and no secret inside it.
    expect(token).not.toContain(SECRET_MATERIAL);
  });

  it("mints a fresh nonce and a fresh cookie per request", async () => {
    const { app } = routeApp();
    const first = await issueNonce(app);
    const second = await issueNonce(app);
    expect(first.challenge.nonce).not.toBe(second.challenge.nonce);
    expect(first.token).not.toBe(second.token);
  });

  it("stays reachable at /api/auth/nonce, which is where the dashboard sends it", async () => {
    const app = createApp({
      env,
      log: quiet,
      db: need().db,
      x402: createX402Near({ network: "near:testnet", maxSponsoredGas: 30_000_000_000_000n }),
      auth: { accessKeys: fakeReader(fullAccessOf(wallet.publicKey)).reader },
    });
    const response = await app.request("/api/auth/nonce", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()[0]?.startsWith(`${SIGN_IN_COOKIE}=`)).toBe(true);
  });

  it("needs neither a session nor a body, because it is the thing that issues one", async () => {
    const { app } = routeApp();
    expect((await app.request("/auth/nonce", { method: "POST" })).status).toBe(200);
  });
});

suite("POST /auth/verify turns a signature into a session", () => {
  beforeAll(seed);

  it("accepts a full-access key's signature and issues only a seller id and account", async () => {
    const { app, seen } = routeApp();
    const { challenge, token } = await issueNonce(app);
    const response = await verifyRequest(app, challenge, { token });
    const payload = (await response.json()) as { seller: { id: string; nearAccountId: string } };

    expect(response.status).toBe(200);
    expect(seen).toEqual([ACCOUNT]);
    expect(payload.seller).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      nearAccountId: ACCOUNT,
      displayName: null,
    });

    const cookies = response.headers.getSetCookie();
    const sessionLine = cookies.find((line) => line.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(sessionLine).toContain("Max-Age=43200");
    expect(sessionLine).toContain("Path=/api");
    // The challenge is spent as far as the browser is concerned.
    expect(
      cookies.some((line) => line.startsWith(`${SIGN_IN_COOKIE}=;`) && line.includes("Max-Age=0")),
    ).toBe(true);

    // UI-1's acceptance criterion, read off what a browser ends up holding.
    expect(JSON.stringify(payload)).not.toMatch(/signature|secret|private/i);
    expect(sessionLine).not.toContain(SECRET_MATERIAL);
    const session = /=[^;]*/.exec(sessionLine)?.[0]?.slice(1) ?? "";
    expect(await createSessionCodec(SECRET_MATERIAL).verifySessionCookie(session)).toEqual({
      sellerId: payload.seller.id,
      nearAccountId: ACCOUNT,
    });
  });

  it("creates the seller once and gives the same id to the next sign-in", async () => {
    const { app } = routeApp();
    const firstIssued = await issueNonce(app);
    const first = await verifyRequest(app, firstIssued.challenge, { token: firstIssued.token });
    const secondIssued = await issueNonce(app);
    const second = await verifyRequest(app, secondIssued.challenge, {
      token: secondIssued.token,
    });
    const a = (await first.json()) as { seller: { id: string } };
    const b = (await second.json()) as { seller: { id: string } };

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(b.seller.id).toBe(a.seller.id);

    const { sql } = need();
    const rows = await sql`select id, near_account_id, display_name from sellers
      where near_account_id = ${ACCOUNT}`;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ near_account_id: ACCOUNT, display_name: null });
  });

  it("hands the issued cookie to /api/endpoints, which is the point of signing in", async () => {
    const reader = fakeReader(fullAccessOf(wallet.publicKey));
    const { app, session, token } = await signInThroughApp(reader.reader);
    expect(session.length).toBeGreaterThan(40);

    const listed = await app.request("/api/endpoints", {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect([listed.status, await listed.json()]).toEqual([200, { endpoints: [] }]);

    expect((await app.request("/api/endpoints")).status).toBe(401);

    // A token minted for one purpose does not serve the other, checked through the
    // route rather than the codec.
    const challengeAsSession = await app.request("/api/endpoints", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(challengeAsSession.status).toBe(401);

    const forged = await createSessionCodec(`${SECRET_MATERIAL}-other`).createSessionCookie({
      sellerId: randomUUID(),
      nearAccountId: ACCOUNT,
    });
    const foreignSession = await app.request("/api/endpoints", {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });
    expect(foreignSession.status).toBe(401);
  });

  it("refuses a body that invents any part of the challenge, before reading the chain", async () => {
    for (const override of [
      { nonce: newSignInNonce() },
      { message: "Sign in to Till, please" },
      { recipient: "http://attacker.test" },
      { callbackUrl: "https://attacker.test/done" },
    ]) {
      const { app, seen } = routeApp();
      const { challenge, token } = await issueNonce(app);
      const response = await verifyRequest(app, challenge, {
        token,
        body: { ...honestBody(challenge), ...override },
      });
      expect([override, response.status, (await response.json()) as { code: string }]).toEqual([
        override,
        401,
        { code: "sign_in_challenge", message: expect.any(String) },
      ]);
      expect(seen).toEqual([]);
    }
  });

  it("binds the signature to the account through the key list, not through the body", async () => {
    // The account id is not inside what the wallet signs, so a valid signature plus a
    // claimed account is only ever worth the chain's answer about that account.
    const { app, seen } = routeApp();
    const { challenge, token } = await issueNonce(app);
    const claimed = `someone-else-${run}.testnet`;
    const response = await verifyRequest(app, challenge, {
      token,
      body: { ...honestBody(challenge), accountId: claimed },
    });
    expect([response.status, (await response.json()) as { code: string }]).toEqual([
      401,
      { code: "account_not_found", message: expect.any(String) },
    ]);
    expect(seen).toEqual([claimed]);
  });

  it("refuses when there is no challenge, a foreign one, or an expired one", async () => {
    const { app } = routeApp();
    const { challenge, token } = await issueNonce(app);

    const absent = await verifyRequest(app, challenge);
    expect([absent.status, (await absent.json()) as { code: string }]).toEqual([
      401,
      { code: "sign_in_challenge", message: expect.any(String) },
    ]);
    expect((await verifyRequest(app, challenge, { token: "" })).status).toBe(401);
    expect((await verifyRequest(app, challenge, { token: "not.a.jwt" })).status).toBe(401);
    expect(token.length).toBeGreaterThan(40);

    // A cookie this process never issued, carrying the very fields the body does.
    const forgedToken = await foreignCodec.createSignInCookie({
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: challenge.nonce,
      callbackUrl: null,
    });
    const forged = await verifyRequest(app, challenge, { token: forgedToken });
    expect([forged.status, (await forged.json()) as { code: string }]).toEqual([
      401,
      { code: "sign_in_challenge", message: expect.any(String) },
    ]);

    const expiredToken = await createSessionCodec(SECRET_MATERIAL, {
      signInMaxAgeSeconds: -1,
    }).createSignInCookie({
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: challenge.nonce,
      callbackUrl: null,
    });
    const expired = await verifyRequest(app, challenge, { token: expiredToken });
    expect([expired.status, (await expired.json()) as { code: string }]).toEqual([
      401,
      { code: "sign_in_challenge", message: expect.any(String) },
    ]);
  });

  it("refuses a signature that does not cover this payload", async () => {
    const { app, seen } = routeApp();
    const { challenge, token } = await issueNonce(app);
    const elsewhere = wallet.sign({
      message: challenge.message,
      recipient: "http://attacker.test",
      nonce: decodeSignInNonce(challenge.nonce) ?? new Uint8Array(),
    });
    const response = await verifyRequest(app, challenge, {
      token,
      body: { ...honestBody(challenge), signature: elsewhere.signature },
    });
    expect([response.status, (await response.json()) as { code: string }]).toEqual([
      401,
      { code: "signature_invalid", message: expect.any(String) },
    ]);
    expect(seen).toEqual([]);

    // The same payload signed by a key this seller does not own, presented under
    // this seller's own key: a wrong signature, not a wrong account.
    const rival = createWallet(ACCOUNT);
    const rivalSignature = rival.sign({
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: decodeSignInNonce(challenge.nonce) ?? new Uint8Array(),
    }).signature;
    const swapped = await verifyRequest(app, challenge, {
      token,
      body: { ...honestBody(challenge), signature: rivalSignature },
    });
    expect([swapped.status, (await swapped.json()) as { code: string }]).toEqual([
      401,
      { code: "signature_invalid", message: expect.any(String) },
    ]);
    expect(seen).toEqual([]);
  });

  it("refuses a valid signature from a key the claimed account does not have", async () => {
    // The case the chain read exists for: a correct NEP-413 signature, correctly
    // bound to the issued challenge, from a key nobody's account carries. Nothing
    // about the crypto is wrong here, so ownership is the only thing left to check.
    const { app, seen } = routeApp();
    const { challenge, token } = await issueNonce(app);
    const rival = createWallet(ACCOUNT);
    const response = await verifyRequest(app, challenge, {
      token,
      body: signedFor(challenge, rival),
    });
    expect([response.status, (await response.json()) as { code: string }]).toEqual([
      401,
      { code: "key_not_found", message: expect.any(String) },
    ]);
    expect(seen).toEqual([ACCOUNT]);
  });

  it("refuses a key type Till does not verify, and a key with no type at all", async () => {
    const { app, seen } = routeApp();
    const { challenge, token } = await issueNonce(app);
    const secp = await verifyRequest(app, challenge, {
      token,
      body: { ...honestBody(challenge), publicKey: SECP_KEY },
    });
    expect([secp.status, (await secp.json()) as { code: string }]).toEqual([
      401,
      { code: "key_type_unsupported", message: expect.any(String) },
    ]);

    // The schema asks for `ed25519:` or `secp256k1:` first, so a bare key is a bad
    // request rather than an unsupported curve.
    const bare = await verifyRequest(app, challenge, {
      token,
      body: { ...honestBody(challenge), publicKey: wallet.publicKey.replace("ed25519:", "") },
    });
    expect([bare.status, (await bare.json()) as { code: string }]).toMatchObject([
      400,
      { code: "invalid_request", message: expect.any(String) },
    ]);
    expect(seen).toEqual([]);
  });

  it("answers the chain's outcomes with three different statuses", async () => {
    const outcomes: readonly {
      readonly list: AccessKeyList;
      readonly code: string;
      readonly status: number;
    }[] = [
      { list: { ok: false, reason: "account_missing" }, code: "account_not_found", status: 401 },
      { list: { ok: false, reason: "unavailable" }, code: "access_keys_unavailable", status: 503 },
      // In the list as a function-call key, and not in the list at all: one code for
      // both, because which keys an account carries is not information to hand out.
      {
        list: { ok: true, keys: [{ publicKey: wallet.publicKey, fullAccess: false }] },
        code: "key_not_found",
        status: 401,
      },
      {
        list: fullAccessOf(`ed25519:${toBase58(randomBytes(32))}`),
        code: "key_not_found",
        status: 401,
      },
      { list: { ok: true, keys: [] }, code: "key_not_found", status: 401 },
    ];

    for (const outcome of outcomes) {
      const { app } = routeApp({ accessKeys: outcome.list });
      const { challenge, token } = await issueNonce(app);
      const response = await verifyRequest(app, challenge, { token });
      expect([outcome.code, response.status, (await response.json()) as { code: string }]).toEqual([
        outcome.code,
        outcome.status,
        { code: outcome.code, message: expect.any(String) },
      ]);
    }
  });

  it("refuses a body that is not JSON, and one the schema refuses", async () => {
    const { app, seen } = routeApp();
    const { challenge, token } = await issueNonce(app);

    const notJson = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SIGN_IN_COOKIE}=${token}` },
      body: "{not json",
    });
    expect([notJson.status, (await notJson.json()) as { code: string }]).toEqual([
      400,
      { code: "invalid_json", message: expect.any(String) },
    ]);

    const oversized = await verifyRequest(app, challenge, {
      token,
      body: { ...honestBody(challenge), message: "x".repeat(300) },
    });
    expect(oversized.status).toBe(400);
    const rejected = (await oversized.json()) as { code: string; issues: unknown[] };
    expect(rejected.code).toBe("invalid_request");
    // The body says which field failed and why, so a UI can point at it.
    expect(rejected.issues).toContainEqual({ path: "message", code: "too_big" });

    const noKey = await verifyRequest(app, challenge, {
      token,
      body: {
        accountId: ACCOUNT,
        signature: "A".repeat(64),
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: challenge.nonce,
      },
    });
    expect([noKey.status, (await noKey.json()) as { code: string }]).toMatchObject([
      400,
      { code: "invalid_request", message: expect.any(String) },
    ]);
    expect(seen).toEqual([]);
  });

  it("logs a code and an account, and never the credential material", async () => {
    const recorder = recordingLogger();
    const { app } = routeApp({
      log: recorder.log,
      accessKeys: { ok: false, reason: "unavailable" },
    });
    const { challenge, token } = await issueNonce(app);
    const response = await verifyRequest(app, challenge, { token });
    expect(response.status).toBe(503);

    const refused = recorder.lines.join("\n");
    expect(refused).toContain("access_keys_unavailable");
    expect(refused).toContain(ACCOUNT);
    expect(refused).not.toContain(wallet.publicKey);
    expect(refused).not.toContain(token);
    expect(refused).not.toContain(SECRET_MATERIAL);
    expect(refused).not.toMatch(/"signature"/);

    // The success line is held to the same rule: a sign-in log is the one an
    // operator reads most often, and the key and signature are not diagnostics.
    const success = recordingLogger();
    const okApp = routeApp({ log: success.log }).app;
    const okIssued = await issueNonce(okApp);
    expect((await verifyRequest(okApp, okIssued.challenge, { token: okIssued.token })).status).toBe(
      200,
    );
    const lines = success.lines.join("\n");
    expect(lines).toContain("signed_in");
    expect(lines).not.toContain(wallet.publicKey);
    expect(lines).not.toContain(okIssued.token);
    expect(lines).not.toMatch(/"signature"/);
  });

  it("keeps a spent challenge usable until its own expiry, because there is no session store", async () => {
    // Pinned as F1's known limitation rather than presented as a feature: a captured
    // challenge cookie replays for the rest of its five minutes. Deleting it from the
    // browser is what the route does; revoking it is what no store backs.
    const { app } = routeApp();
    const { challenge, token } = await issueNonce(app);
    const first = await verifyRequest(app, challenge, { token });
    const second = await verifyRequest(app, challenge, { token });
    expect([first.status, second.status]).toEqual([200, 200]);
  });
});

afterAll(async () => {
  if (handle === null) {
    return;
  }
  const { sql } = handle;
  await sql`delete from sellers where near_account_id = ${ACCOUNT}`;
  await sql.end({ timeout: 5 }).catch(() => undefined);
});
