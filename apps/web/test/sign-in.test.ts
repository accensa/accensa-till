import type { SignInChallenge } from "@till/core/schemas";
import { describe, expect, it } from "vitest";

import { authErrorMessage, buildCliCommand, validateSignInInput } from "../lib/sign-in.ts";

const CHALLENGE: SignInChallenge = {
  message: "Sign in to Till",
  recipient: "http://localhost:3000",
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  callbackUrl: null,
};

describe("sign-in logic and formatting (UI-1, F8)", () => {
  it("formats the exact near-cli-rs command with challenge details", () => {
    const cmd = buildCliCommand(CHALLENGE, "seller.testnet");
    expect(cmd).toBe(
      'near account sign-message seller.testnet "Sign in to Till" --recipient "http://localhost:3000" --nonce "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="',
    );

    const fallbackCmd = buildCliCommand(CHALLENGE);
    expect(fallbackCmd).toContain("<account.testnet>");
  });

  it("validates empty inputs and reports required field errors", () => {
    const res = validateSignInInput({ accountId: "", publicKey: "", signature: "" }, CHALLENGE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.accountId).toBeDefined();
      expect(res.errors.publicKey).toBeDefined();
      expect(res.errors.signature).toBeDefined();
    }
  });

  it("validates malformed keys and signatures with schema errors", () => {
    const res = validateSignInInput(
      {
        accountId: "valid-account.testnet",
        publicKey: "invalid-key-shape",
        signature: "too-short",
      },
      CHALLENGE,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.publicKey).toBeDefined();
      expect(res.errors.signature).toBeDefined();
    }
  });

  it("accepts valid inputs and constructs the SignedMessageRequest payload", () => {
    const res = validateSignInInput(
      {
        accountId: "till-seller-dev.testnet",
        publicKey: "ed25519:6E83hnHGhxRczfTksXQz69E5k17w8o95BjhW7qY6F7pA",
        signature:
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      CHALLENGE,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.request.accountId).toBe("till-seller-dev.testnet");
      expect(res.request.publicKey).toBe("ed25519:6E83hnHGhxRczfTksXQz69E5k17w8o95BjhW7qY6F7pA");
      expect(res.request.message).toBe("Sign in to Till");
      expect(res.request.recipient).toBe("http://localhost:3000");
      expect(res.request.nonce).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    }
  });

  it("translates refusal codes into clear operator explanations", () => {
    expect(authErrorMessage({ code: "sign_in_challenge", message: "expired" })).toContain(
      "The challenge expired",
    );
    expect(authErrorMessage({ code: "key_not_found", message: "not full access" })).toContain(
      "full-access key",
    );
    expect(authErrorMessage({ code: "signature_invalid", message: "bad sig" })).toContain(
      "That signature does not cover",
    );
    expect(authErrorMessage({ code: "key_type_unsupported", message: "secp256k1" })).toContain(
      "ed25519",
    );
  });
});
