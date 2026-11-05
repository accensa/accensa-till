import {
  createHash,
  createPublicKey,
  verify as ed25519Verify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * NEP-413 signed messages (UI-1, F1): the off-chain signature a NEAR wallet
 * produces to prove it holds an account's key, which is how a seller signs in to
 * the dashboard without a password and without spending gas.
 *
 * Why this is hand-rolled. The serialization is three borsh rules and one sha256,
 * and the one cryptographic step we cannot write — ed25519 verify — is in
 * `node:crypto`. `@near-js/crypto` would do it too, but C14 recorded that it is
 * not a dependency of `apps/api` and importing a transitive one under pnpm's
 * isolation is a build that works by luck (the same reasoning `x402/near.ts`
 * carries for its key type). The encoding here is taken from the installed
 * `@near-js/signers` implementation rather than from memory, field by field:
 *
 *   hash = sha256( borsh<u32>(2**31 + 413) ++ borsh<Payload>{
 *            message: string, nonce: u8[32], recipient: string, callbackUrl: option<string> })
 *   signature = ed25519 over those 32 hash bytes, taken as the message
 *
 * That last line is NEAR's own convention, not pure ed25519 of the JSON: a
 * transaction signature is an ed25519 signature of a sha256 hash (NEP-413, "NEAR
 * Signatures"), and `@near-js/signers` signs `sha256(serializedMessage)` as the
 * message bytes. Verifying against the pre-hashed digest instead would accept
 * nothing a real wallet produced.
 */

/** `2**31 + 413`: makes the payload an invalid transaction, so a signed message can never be replayed as one. */
export const NEP413_TAG = 2147484061;
export const NEP413_NONCE_BYTES = 32;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** SPKI prefix that wraps a raw ed25519 key so `createPublicKey` accepts it (RFC 8410). */
const ED25519_SPKI_PREFIX = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
] as const;
const ED25519_SIGNATURE_BYTES = 64;

export type Nep413Payload = {
  readonly message: string;
  readonly recipient: string;
  readonly nonce: Uint8Array;
  readonly callbackUrl?: string | undefined;
};

export type SignedNep413Message = Nep413Payload & {
  readonly publicKey: string;
  readonly signature: string;
};

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Borsh integers are little endian, and a string is its byte length as u32 then its utf8 bytes. */
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function borshString(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "utf8"));
  return concat([u32(bytes.length), bytes]);
}

function borshNonce(value: Uint8Array): Uint8Array {
  if (value.length !== NEP413_NONCE_BYTES) {
    throw new Error(`nonce must be ${NEP413_NONCE_BYTES} bytes, got ${value.length}`);
  }
  return value;
}

/** Borsh `option<T>` is a one-byte tag: absent is `0x00`, present is `0x01` then the value. */
function borshOptionString(value: string | undefined): Uint8Array {
  return value === undefined
    ? new Uint8Array([0x00])
    : concat([new Uint8Array([0x01]), borshString(value)]);
}

export function encodeNep413Payload(payload: Nep413Payload): Uint8Array {
  return concat([
    borshString(payload.message),
    borshNonce(payload.nonce),
    borshString(payload.recipient),
    borshOptionString(payload.callbackUrl),
  ]);
}

export function hashNep413Payload(payload: Nep413Payload): Uint8Array {
  const signed = concat([u32(NEP413_TAG), encodeNep413Payload(payload)]);
  return new Uint8Array(createHash("sha256").update(signed).digest());
}

/**
 * Base58 with the bitcoin alphabet, which is what a NEAR key string carries. Only
 * decoding is needed here: a public key arrives from a wallet and a signature may
 * arrive in either encoding, and nothing in this path is ever serialized back.
 */
export function decodeBase58(value: string): Uint8Array | null {
  if (value === "") {
    return new Uint8Array(0);
  }
  let magnitude = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) {
      return null;
    }
    magnitude = magnitude * 58n + BigInt(index);
  }
  const littleEndian: number[] = [];
  while (magnitude > 0n) {
    littleEndian.push(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  // Leading `1`s encode leading zero bytes, and the big-int loop cannot see them
  // because 0x00 contributes nothing to a magnitude.
  const zeros = /^1*/.exec(value)?.[0].length ?? 0;
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...littleEndian.reverse()]);
}

export type NearPublicKey = {
  readonly type: "ed25519" | "secp256k1";
  readonly bytes: Uint8Array;
};

/**
 * `<key-type>:<base58-bytes>` as NEP-413 states it. A secp256k1 key is parsed
 * rather than rejected so the caller can say *why* it was refused: verifying one
 * needs ECDSA recovery over a 64-byte r||s, and no NEAR wallet signs a sign-in
 * with such a key, so Till refuses it instead of half-implementing it.
 */
export function parseNearPublicKey(value: string): NearPublicKey | null {
  const separator = value.indexOf(":");
  if (separator < 0) {
    return null;
  }
  const type = value.slice(0, separator);
  if (type !== "ed25519" && type !== "secp256k1") {
    return null;
  }
  const bytes = decodeBase58(value.slice(separator + 1));
  if (bytes === null) {
    return null;
  }
  const expected = type === "ed25519" ? 32 : 64;
  return bytes.length === expected ? { type, bytes } : null;
}

/**
 * NEP-413's output interface says the signature is base64, and that is the one
 * form accepted: a public key is base58 because the *key* format says so, and
 * guessing that the signature follows the same convention would be an
 * unmeasured branch. If A10's wallet turns out to send `ed25519:<base58>` here,
 * the fix is this function plus a vector, not a verifier change.
 */
export function decodeNearSignature(value: string): Uint8Array | null {
  if (!/^[0-9A-Za-z+/]+={0,2}$/.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  return bytes.length === ED25519_SIGNATURE_BYTES ? bytes : null;
}

function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(concat([Uint8Array.from(ED25519_SPKI_PREFIX), publicKey])),
      format: "der",
      type: "spki",
    });
    return ed25519Verify(undefined, message, key, signature);
  } catch {
    // A malformed key or signature is a refusal, not a 500: this function's only
    // honest answer about anything it cannot parse is `false`.
    return false;
  }
}

/**
 * True only when `signature` is an ed25519 signature of this exact payload by this
 * exact key. Nothing here knows about accounts: whether the key belongs to the
 * signer is a chain read, and it is `services/access-keys.ts` that answers it.
 */
export function verifyNep413Signature(input: SignedNep413Message): boolean {
  const publicKey = parseNearPublicKey(input.publicKey);
  if (publicKey === null || publicKey.type !== "ed25519") {
    return false;
  }
  const signature = decodeNearSignature(input.signature);
  if (signature === null) {
    return false;
  }
  let payload: Uint8Array;
  try {
    payload = hashNep413Payload(input);
  } catch {
    return false;
  }
  return verifyEd25519(publicKey.bytes, payload, signature);
}

/**
 * A sign-in nonce: 32 random bytes, base64url on the wire. The fixed length is the
 * borsh `u8[32]` requirement, and base64url survives both a cookie value and a
 * JSON body without escaping, which standard base64's `+/` would not.
 */
export function newSignInNonce(): string {
  return randomBytes(NEP413_NONCE_BYTES).toString("base64url");
}

/** Accepts base64url and standard base64, padded or not, and requires the 32 bytes borsh wants. */
export function decodeSignInNonce(value: string): Uint8Array | null {
  if (!/^[0-9A-Za-z+/_-]{43}={0,2}$/.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  return bytes.length === NEP413_NONCE_BYTES ? bytes : null;
}

/**
 * Compare two nonce strings by their bytes, so a wallet that re-encoded the
 * challenge it was handed in a different base64 alphabet is still recognised. The
 * bytes are what the signature covers, and this is a signature verification path,
 * not a secret comparison — but a constant-time compare costs nothing here.
 */
export function noncesEqual(a: string, b: string): boolean {
  const left = decodeSignInNonce(a);
  const right = decodeSignInNonce(b);
  if (left === null || right === null) {
    return false;
  }
  return timingSafeEqual(left, right);
}
