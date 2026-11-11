import type { SignInChallenge } from "@till/core/schemas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SignInFormView, type SignInFormViewProps } from "../components/domain/SignInForm.tsx";
import { emptySignInForm } from "../lib/sign-in.ts";

const CHALLENGE: SignInChallenge = {
  message: "Sign in to Till",
  recipient: "http://localhost:3000",
  nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  callbackUrl: null,
};

const NOOP = () => {};

function renderView(overrides: Partial<SignInFormViewProps> = {}): string {
  const props: SignInFormViewProps = {
    challenge: CHALLENGE,
    challengeError: null,
    values: emptySignInForm,
    errors: {},
    result: null,
    busy: false,
    walletAvailable: false,
    activeTab: "cli",
    onTabChange: NOOP,
    onEdit: NOOP,
    onSubmitCli: NOOP,
    onPromptWallet: NOOP,
    onRefreshChallenge: NOOP,
    ...overrides,
  };
  return renderToStaticMarkup(<SignInFormView {...props} />);
}

describe("sign-in form rendering (UI-1, F8)", () => {
  it("renders active challenge details and CLI command in CLI mode", () => {
    const html = renderView({ activeTab: "cli" });
    expect(html).toContain("Sign in with NEAR");
    expect(html).toContain("http://localhost:3000");
    expect(html).toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(html).toContain("near account sign-message");
    expect(html).toContain("Verify Signature &amp; Sign In");
  });

  it("indicates when no browser extension is detected in wallet tab", () => {
    const html = renderView({ activeTab: "wallet", walletAvailable: false });
    expect(html).toContain("No browser wallet extension detected");
    expect(html).toContain("Switch to CLI / Manual Sign");
  });

  it("shows prompt button when browser extension is detected in wallet tab", () => {
    const html = renderView({ activeTab: "wallet", walletAvailable: true });
    expect(html).toContain("In-page NEAR wallet detected");
    expect(html).toContain("Sign In with Wallet");
  });

  it("displays field errors on form inputs", () => {
    const html = renderView({
      activeTab: "cli",
      errors: {
        accountId: "NEAR Account ID is required",
        publicKey: "Public key is required",
        signature: "Signature is required",
      },
    });
    expect(html).toContain("NEAR Account ID is required");
    expect(html).toContain("Public key is required");
    expect(html).toContain("Signature is required");
  });

  it("renders sign-in refusal alerts", () => {
    const html = renderView({
      result: {
        kind: "rejected",
        error: {
          code: "key_not_found",
          message: "That key is not a full-access key of this account.",
        },
      },
    });
    expect(html).toContain("Sign-in refused:");
    expect(html).toContain("full-access key");
  });

  it("renders unreachable service errors", () => {
    const html = renderView({
      result: {
        kind: "unreachable",
        detail: "connection refused on port 3000",
      },
    });
    expect(html).toContain("Service unreachable:");
    expect(html).toContain("connection refused on port 3000");
  });

  it("renders signed-in confirmation when authentication succeeds", () => {
    const html = renderView({
      result: {
        kind: "ok",
        seller: {
          id: "01a1abe0-2222-7000-8000-000000000002",
          nearAccountId: "till-seller-dev.testnet",
          displayName: null,
        },
      },
    });
    expect(html).toContain("Signed In");
    expect(html).toContain("till-seller-dev.testnet");
    expect(html).toContain("proceed to Endpoints");
  });
});
