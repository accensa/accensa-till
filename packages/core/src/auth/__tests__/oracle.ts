import { Buffer } from "node:buffer";

/**
 * Golden NEP-413 vectors, measured rather than transcribed.
 *
 * Produced on 2026-11-05 by the `@near-js/signers` KeyPairSigner that is already
 * in this workspace's lockfile — the same code path a real wallet takes — run with
 * `KeyPair.fromRandom("ed25519")`, nonce `[0..31]` and account `oracle.testnet`.
 * The library's own borsh output and sha256 are printed next to the signature so
 * each claim below has a second source: this file is what makes `nep413.ts`'s
 * encoding a measurement of interop instead of a reading of the spec, which
 * matters because the live half of F1 (A10) is the only other chance to check it.
 */

export const ORACLE_NONCE_BYTES = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));

/** The u32 little-endian encoding of 2**31 + 413, as the library's borsh printed it. */
export const ORACLE_TAG_HEX = "9d010080";

export const ORACLE_PUBLIC_KEY = "ed25519:3gkkeh6UDUPu1YWqmRzyh46nSfZTcySJDkKpcPhiYr3x";

/** With `callbackUrl`, so borsh writes the option tag `01` then the string. */
export const ORACLE_WITH_CALLBACK = {
  accountId: "oracle.testnet",
  message: "hi",
  recipient: "myapp.com",
  callbackUrl: "myapp.com/callback",
  payloadHex:
    "020000006869000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f090000006d796170702e636f6d01120000006d796170702e636f6d2f63616c6c6261636b",
  hashHex: "c9ce5de288f7de6d83e2303e56c7615949da83867ea33c0747ed45c47ef50148",
  signatureBase64:
    "mphy5qmGA4EE1XVEgLI5NQhFkxV/oYM6YVrXNcmbxEt7KkbXanqlxklALnoGfO9T5jdsNHV7Wj3h0F2MvzZKBw==",
} as const;

/** Without it: the option tag is `00` and nothing follows, which is Till's own flow. */
export const ORACLE_WITHOUT_CALLBACK = {
  accountId: "oracle.testnet",
  message: "Sign in to Till",
  recipient: "http://localhost:3001",
  payloadHex:
    "0f0000005369676e20696e20746f2054696c6c000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f15000000687474703a2f2f6c6f63616c686f73743a3330303100",
  hashHex: "187c9a77dc04cf70e6a4f3b531e593de3659bc81b07aada65831bb095b8adc2b",
  signatureBase64:
    "UMhQwhOshl+jxLCjJgdRJ4LIzWig98mmNPUsfeC05eaeUZ/o+Vdk4jou9cfBE+kapvhDTEUr5jbDCWJo7Zl/AQ==",
} as const;

export const ORACLE_NONCE_BASE64URL = Buffer.from(ORACLE_NONCE_BYTES).toString("base64url");
