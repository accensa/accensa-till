import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  NEP413_NONCE_BYTES,
  NEP413_TAG,
  decodeBase58,
  decodeNearSignature,
  decodeSignInNonce,
  encodeNep413Payload,
  hashNep413Payload,
  newSignInNonce,
  noncesEqual,
  parseNearPublicKey,
  verifyNep413Signature,
} from "../nep413.ts";
import {
  ORACLE_NONCE_BASE64URL,
  ORACLE_NONCE_BYTES,
  ORACLE_PUBLIC_KEY,
  ORACLE_TAG_HEX,
  ORACLE_WITHOUT_CALLBACK,
  ORACLE_WITH_CALLBACK,
} from "./oracle.ts";

/**
 * NEP-413 encoding and verification (F1, UI-1).
 *
 * The three golden vectors in `oracle.ts` were printed by `@near-js/signers`, the
 * library a real wallet signs with, so the encoding tests below compare against a
 * second implementation rather than against this one's own output. Without them
 * this file could only prove that `nep413.ts` agrees with itself.
 */

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

describe("the payload encoding", () => {
  it("tags with 2**31 + 413 as a little-endian u32", () => {
    expect(NEP413_TAG).toBe(2 ** 31 + 413);
    // The exact four bytes the library's borsh printed, which is also the trick
    // that makes this payload an invalid transaction and so unspendable.
    expect(hex(Uint8Array.from(Buffer.from(ORACLE_TAG_HEX, "hex")))).toBe("9d010080");
  });

  it("encodes the callbackUrl case byte for byte as the library did", () => {
    expect(
      hex(
        encodeNep413Payload({
          message: ORACLE_WITH_CALLBACK.message,
          recipient: ORACLE_WITH_CALLBACK.recipient,
          nonce: ORACLE_NONCE_BYTES,
          callbackUrl: ORACLE_WITH_CALLBACK.callbackUrl,
        }),
      ),
    ).toBe(ORACLE_WITH_CALLBACK.payloadHex);
  });

  it("encodes the absent callbackUrl as a zero option tag, as the library did", () => {
    expect(
      hex(
        encodeNep413Payload({
          message: ORACLE_WITHOUT_CALLBACK.message,
          recipient: ORACLE_WITHOUT_CALLBACK.recipient,
          nonce: ORACLE_NONCE_BYTES,
        }),
      ),
    ).toBe(ORACLE_WITHOUT_CALLBACK.payloadHex);
    // Read back rather than assumed: the last byte is the option tag and nothing
    // follows it, which is the whole difference between the two vectors.
    const encoded = encodeNep413Payload({
      message: ORACLE_WITHOUT_CALLBACK.message,
      recipient: ORACLE_WITHOUT_CALLBACK.recipient,
      nonce: ORACLE_NONCE_BYTES,
    });
    expect(encoded.at(-1)).toBe(0x00);
  });

  it("hashes the prefix and the payload together, as the library did", () => {
    const withCallback = hashNep413Payload({
      message: ORACLE_WITH_CALLBACK.message,
      recipient: ORACLE_WITH_CALLBACK.recipient,
      nonce: ORACLE_NONCE_BYTES,
      callbackUrl: ORACLE_WITH_CALLBACK.callbackUrl,
    });
    const withoutCallback = hashNep413Payload({
      message: ORACLE_WITHOUT_CALLBACK.message,
      recipient: ORACLE_WITHOUT_CALLBACK.recipient,
      nonce: ORACLE_NONCE_BYTES,
    });
    expect(hex(withCallback)).toBe(ORACLE_WITH_CALLBACK.hashHex);
    expect(hex(withoutCallback)).toBe(ORACLE_WITHOUT_CALLBACK.hashHex);
    // 32 bytes because it is the sha256 of the concatenation, not of the payload
    // alone — the prefix is what a wallet cannot be tricked into leaving out.
    expect(withCallback.length).toBe(32);
    expect(
      hex(
        new Uint8Array(
          createHash("sha256")
            .update(Buffer.from(`${ORACLE_TAG_HEX}${ORACLE_WITH_CALLBACK.payloadHex}`, "hex"))
            .digest(),
        ),
      ),
    ).toBe(ORACLE_WITH_CALLBACK.hashHex);
  });

  it("refuses a nonce that is not the 32 bytes borsh promises", () => {
    expect(NEP413_NONCE_BYTES).toBe(32);
    expect(() =>
      encodeNep413Payload({ message: "a", recipient: "b", nonce: new Uint8Array(31) }),
    ).toThrow(/32 bytes/);
    expect(() =>
      encodeNep413Payload({ message: "a", recipient: "b", nonce: new Uint8Array(33) }),
    ).toThrow(/32 bytes/);
  });
});

describe("signature verification against the wallet library's own output", () => {
  const input = {
    message: ORACLE_WITH_CALLBACK.message,
    recipient: ORACLE_WITH_CALLBACK.recipient,
    nonce: ORACLE_NONCE_BYTES,
    callbackUrl: ORACLE_WITH_CALLBACK.callbackUrl,
    publicKey: ORACLE_PUBLIC_KEY,
    signature: ORACLE_WITH_CALLBACK.signatureBase64,
  };

  it("accepts the signature a real signer produced", () => {
    expect(verifyNep413Signature(input)).toBe(true);
  });

  it("accepts the no-callback vector too, which is Till's own shape", () => {
    expect(
      verifyNep413Signature({
        message: ORACLE_WITHOUT_CALLBACK.message,
        recipient: ORACLE_WITHOUT_CALLBACK.recipient,
        nonce: ORACLE_NONCE_BYTES,
        publicKey: ORACLE_PUBLIC_KEY,
        signature: ORACLE_WITHOUT_CALLBACK.signatureBase64,
      }),
    ).toBe(true);
  });

  it.each([
    ["message", { message: "hi " }],
    ["recipient", { recipient: "myapp.com.evil" }],
    ["callbackUrl", { callbackUrl: "myapp.com/callback/2" }],
  ] as const)("refuses when the %s differs from what was signed", (field, override) => {
    expect(
      verifyNep413Signature({
        ...input,
        nonce: ORACLE_NONCE_BYTES,
        ...override,
      } as Parameters<typeof verifyNep413Signature>[0]),
    ).toBe(false);
  });

  it("refuses a different nonce, which is the replay case the challenge cookie exists for", () => {
    const shifted = Uint8Array.from(ORACLE_NONCE_BYTES, (byte) => byte + 1);
    expect(shifted.length).toBe(32);
    expect(verifyNep413Signature({ ...input, nonce: shifted })).toBe(false);
  });

  it("refuses a signature bit flipped from the real one", () => {
    const bytes = Uint8Array.from(Buffer.from(ORACLE_WITH_CALLBACK.signatureBase64, "base64"));
    const flipped = Uint8Array.from(bytes, (byte, index) => (index === 0 ? byte ^ 1 : byte));
    expect(
      verifyNep413Signature({ ...input, signature: Buffer.from(flipped).toString("base64") }),
    ).toBe(false);
  });

  it("refuses the good signature under a different real key", () => {
    // The second key is a key pair generated the same way by the same library, so
    // this is a well-formed 32-byte ed25519 key rather than a string that fails to
    // parse — which is the only version of this test that proves anything.
    const other = parseNearPublicKey("ed25519:7n18sWzSNo7hLYqDR2u28FECexMsmU65tmH9keR8XSPK");
    expect(other?.type).toBe("ed25519");
    expect(other?.bytes.length).toBe(32);
    expect(
      verifyNep413Signature({
        ...input,
        publicKey: "ed25519:7n18sWzSNo7hLYqDR2u28FECexMsmU65tmH9keR8XSPK",
      }),
    ).toBe(false);
  });

  it("refuses the good signature under a real secp256k1 key", () => {
    const secpKey =
      "secp256k1:5RcPqvYSAn32w5hMc1XCCrTijgXNB4KsCVpudRRzjkESGQGf9quwTgwZryLA93oWzB5WdUck51vo1aLhvxyYsEth";
    expect(parseNearPublicKey(secpKey)?.type).toBe("secp256k1");
    expect(verifyNep413Signature({ ...input, publicKey: secpKey })).toBe(false);
  });
});

describe("key and signature string forms", () => {
  it("parses an ed25519 key to its 32 bytes", () => {
    const parsed = parseNearPublicKey(ORACLE_PUBLIC_KEY);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("ed25519");
    expect(parsed?.bytes.length).toBe(32);
  });

  it("parses a secp256k1 key to its 64 bytes without claiming it is verifiable", () => {
    const parsed = parseNearPublicKey(
      "secp256k1:5RcPqvYSAn32w5hMc1XCCrTijgXNB4KsCVpudRRzjkESGQGf9quwTgwZryLA93oWzB5WdUck51vo1aLhvxyYsEth",
    );
    expect(parsed?.type).toBe("secp256k1");
    expect(parsed?.bytes.length).toBe(64);
    // And the verifier says no to it: the type is known, not supported.
    expect(
      verifyNep413Signature({
        message: "a",
        recipient: "b",
        nonce: ORACLE_NONCE_BYTES,
        publicKey:
          "secp256k1:5RcPqvYSAn32w5hMc1XCCrTijgXNB4KsCVpudRRzjkESGQGf9quwTgwZryLA93oWzB5WdUck51vo1aLhvxyYsEth",
        signature: ORACLE_WITH_CALLBACK.signatureBase64,
      }),
    ).toBe(false);
  });

  it.each([
    ["no prefix", "3gkkeh6UDUPu1YWqmRzyh46nSfZTcySJDkKpcPhiYr3x"],
    ["an unknown type", "secp384r1:3gkkeh6UDUPu1YWqmRzyh46nSfZTcySJDkKpcPhiYr3x"],
    ["base58's forbidden characters", "ed25519:0OIl+/3gkkeh6UDUPu1YWqmRzyh46nSfZTcySJDkKpcPhiYr3x"],
    ["the wrong byte count", "ed25519:3gkkeh6UDUPu1YWqmRzyh46nSfZTcySJDkKpcPhiYr3"],
    ["empty", "ed25519:"],
  ])("rejects %s as a public key", (_name, value) => {
    expect(parseNearPublicKey(value)).toBeNull();
  });

  it("decodes base58 leading zeros, which a magnitude loop alone would lose", () => {
    expect(hex(decodeBase58("1") ?? new Uint8Array())).toBe("00");
    expect(hex(decodeBase58("11") ?? new Uint8Array())).toBe("0000");
    expect(hex(decodeBase58("2") ?? new Uint8Array())).toBe("01");
    expect(hex(decodeBase58("9") ?? new Uint8Array())).toBe("08");
    expect(hex(decodeBase58("A") ?? new Uint8Array())).toBe("09");
    expect(decodeBase58("0")).toBeNull();
  });

  it("decodes only a base64 signature of exactly 64 bytes", () => {
    expect(decodeNearSignature(ORACLE_WITH_CALLBACK.signatureBase64)?.length).toBe(64);
    // The key format's `ed25519:<base58>` spelling is not a signature format the
    // spec offers, so it is refused rather than guessed at.
    expect(decodeNearSignature("ed25519:3gkkeh6UDUPu1YWqmRzyh46nSfZTcySJDkKpcPhiYr3x")).toBeNull();
    expect(decodeNearSignature("not base 64 at all !!")?.length ?? null).toBeNull();
    expect(decodeNearSignature(Buffer.alloc(63).toString("base64"))).toBeNull();
    expect(decodeNearSignature(Buffer.alloc(65).toString("base64"))).toBeNull();
  });
});

describe("the sign-in nonce", () => {
  it("mints 32 random bytes as base64url and differs every time", () => {
    const first = newSignInNonce();
    const second = newSignInNonce();
    expect(first).not.toBe(second);
    expect(first.length).toBe(43);
    expect(decodeSignInNonce(first)?.length).toBe(32);
  });

  it("reads the oracle's nonce bytes back from their base64url form", () => {
    expect(hex(decodeSignInNonce(ORACLE_NONCE_BASE64URL) ?? new Uint8Array())).toBe(
      hex(ORACLE_NONCE_BYTES),
    );
  });

  it("compares by bytes so a re-encoded alphabet still matches", () => {
    const padded = Buffer.from(ORACLE_NONCE_BYTES).toString("base64");
    expect(padded).not.toBe(ORACLE_NONCE_BASE64URL);
    expect(noncesEqual(ORACLE_NONCE_BASE64URL, padded)).toBe(true);
    expect(noncesEqual(ORACLE_NONCE_BASE64URL, newSignInNonce())).toBe(false);
    expect(noncesEqual("short", ORACLE_NONCE_BASE64URL)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["too short", "AAAAAAAA"],
    ["a forbidden character", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA*"],
    ["the wrong length once decoded", "AAAA"],
  ])("rejects %s as a nonce", (_name, value) => {
    expect(decodeSignInNonce(value)).toBeNull();
  });
});
