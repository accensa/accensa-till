"use client";

import type { SignInChallenge } from "@till/core/schemas";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useState } from "react";

import { type VerifySignInResult, api } from "../../lib/api-client.ts";
import {
  type SignInFieldErrors,
  type SignInFormField,
  type SignInFormValues,
  authErrorMessage,
  buildCliCommand,
  emptySignInForm,
  validateSignInInput,
} from "../../lib/sign-in.ts";

/**
 * Browser wallet sign-in (UI-1, F1, F8).
 *
 * Implements NEP-413 signature authentication:
 * 1. Requests a fresh challenge nonce from `POST /api/auth/nonce`.
 * 2. Prompts an injected browser wallet (Meteor, HERE, Sender, etc.) OR
 *    provides copyable CLI instructions for local developer testnet keys.
 * 3. Submits the NEP-413 payload to `POST /api/auth/verify`.
 * 4. The server validates the signature and confirms on-chain that the key has
 *    full access to the claimed account, then issues the HttpOnly `till_session` cookie.
 *
 * `SignInFormView` renders the view without side effects for offline static testing.
 * `SignInForm` wraps the state, network requests, and wallet detection.
 */

export type SignInFormViewProps = {
  readonly challenge: SignInChallenge | null;
  readonly challengeError: string | null;
  readonly values: SignInFormValues;
  readonly errors: SignInFieldErrors;
  readonly result: VerifySignInResult | null;
  readonly busy: boolean;
  readonly walletAvailable: boolean;
  readonly activeTab: "wallet" | "cli";
  readonly onTabChange: (tab: "wallet" | "cli") => void;
  readonly onEdit: (field: SignInFormField, value: string) => void;
  readonly onSubmitCli: () => void;
  readonly onPromptWallet: () => void;
  readonly onRefreshChallenge: () => void;
};

export function SignInFormView({
  challenge,
  challengeError,
  values,
  errors,
  result,
  busy,
  walletAvailable,
  activeTab,
  onTabChange,
  onEdit,
  onSubmitCli,
  onPromptWallet,
  onRefreshChallenge,
}: SignInFormViewProps) {
  if (result?.kind === "ok") {
    return (
      <section aria-label="Sign-in complete" className="max-w-xl space-y-4">
        <h2 className="text-xl font-semibold">Signed In</h2>
        <p className="text-sm text-emerald-700">
          Authenticated as <strong>{result.seller.nearAccountId}</strong>.
        </p>
        <p className="text-xs opacity-70">
          Your session cookie is active. If you are not redirected automatically,{" "}
          <a href="/endpoints" className="underline">
            proceed to Endpoints
          </a>
          .
        </p>
      </section>
    );
  }

  const cliCommand = challenge ? buildCliCommand(challenge, values.accountId) : "";

  return (
    <section aria-label="Sign in to Till" className="max-w-xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Sign in with NEAR</h2>
        <p className="text-sm opacity-70">
          Verify account ownership via NEP-413 signed message. No private keys ever touch the
          browser.
        </p>
      </div>

      {challengeError && (
        <div role="alert" className="border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          Failed to obtain challenge from Till: {challengeError}
          <button
            type="button"
            onClick={onRefreshChallenge}
            className="ml-2 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {result?.kind === "rejected" && (
        <div role="alert" className="border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <strong>Sign-in refused:</strong> {authErrorMessage(result.error)}
        </div>
      )}

      {result?.kind === "unreachable" && (
        <div
          role="alert"
          className="border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800"
        >
          <strong>Service unreachable:</strong> {result.detail}
        </div>
      )}

      {challenge && (
        <div className="rounded border bg-gray-50 p-3 text-xs space-y-1">
          <div className="flex justify-between items-center">
            <span className="font-semibold text-gray-700">Active Challenge (expires in 5 min)</span>
            <button
              type="button"
              onClick={onRefreshChallenge}
              className="text-xs text-blue-600 underline hover:no-underline"
            >
              Refresh Nonce
            </button>
          </div>
          <div className="grid grid-cols-[80px_1fr] gap-x-2 text-gray-600">
            <span className="opacity-70">Recipient:</span>
            <code className="break-all">{challenge.recipient}</code>
            <span className="opacity-70">Nonce:</span>
            <code className="break-all">{challenge.nonce}</code>
          </div>
        </div>
      )}

      <div className="border-b flex gap-4 text-sm font-medium">
        <button
          type="button"
          onClick={() => onTabChange("wallet")}
          className={`pb-2 border-b-2 ${
            activeTab === "wallet"
              ? "border-black text-black"
              : "border-transparent text-gray-500 hover:text-black"
          }`}
        >
          Browser Wallet
        </button>
        <button
          type="button"
          onClick={() => onTabChange("cli")}
          className={`pb-2 border-b-2 ${
            activeTab === "cli"
              ? "border-black text-black"
              : "border-transparent text-gray-500 hover:text-black"
          }`}
        >
          CLI / Manual Sign
        </button>
      </div>

      {activeTab === "wallet" ? (
        <div className="space-y-4">
          {walletAvailable ? (
            <div className="space-y-3">
              <p className="text-sm">
                In-page NEAR wallet detected. Click below to sign the NEP-413 challenge.
              </p>
              <button
                type="button"
                onClick={onPromptWallet}
                disabled={busy || !challenge}
                className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {busy ? "Signing in…" : "Sign In with Wallet"}
              </button>
            </div>
          ) : (
            <div className="space-y-3 rounded border border-gray-200 p-4 text-sm">
              <p className="font-medium text-gray-800">No browser wallet extension detected</p>
              <p className="text-xs text-gray-600">
                Install a NEAR wallet extension (such as Meteor Wallet or HERE Wallet), or switch to
                the <strong>CLI / Manual Sign</strong> tab to authenticate using testnet
                credentials.
              </p>
              <button
                type="button"
                onClick={() => onTabChange("cli")}
                className="text-xs underline text-blue-600"
              >
                Switch to CLI / Manual Sign
              </button>
            </div>
          )}
        </div>
      ) : (
        <form
          aria-label="Manual NEP-413 sign-in form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmitCli();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Terminal Command (near-cli-rs)
            </span>
            <pre className="overflow-x-auto rounded bg-gray-900 p-3 text-xs text-green-400">
              <code>{cliCommand || "Fetching challenge..."}</code>
            </pre>
            <p className="text-xs text-gray-500">
              Run this command in your terminal, then paste the resulting account, public key, and
              signature below.
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <label htmlFor="accountId" className="block text-xs font-semibold text-gray-700">
                NEAR Account ID
              </label>
              <input
                id="accountId"
                type="text"
                placeholder="seller.testnet"
                value={values.accountId}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onEdit("accountId", e.target.value)}
                className="mt-1 block w-full rounded border px-3 py-1.5 text-sm"
              />
              {errors.accountId && <p className="mt-1 text-xs text-red-600">{errors.accountId}</p>}
            </div>

            <div>
              <label htmlFor="publicKey" className="block text-xs font-semibold text-gray-700">
                Public Key
              </label>
              <input
                id="publicKey"
                type="text"
                placeholder="ed25519:..."
                value={values.publicKey}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onEdit("publicKey", e.target.value)}
                className="mt-1 block w-full rounded border px-3 py-1.5 text-sm"
              />
              {errors.publicKey && <p className="mt-1 text-xs text-red-600">{errors.publicKey}</p>}
            </div>

            <div>
              <label htmlFor="signature" className="block text-xs font-semibold text-gray-700">
                Signature (Base64 or ed25519:base58)
              </label>
              <input
                id="signature"
                type="text"
                placeholder="base64 signature..."
                value={values.signature}
                onChange={(e: ChangeEvent<HTMLInputElement>) => onEdit("signature", e.target.value)}
                className="mt-1 block w-full rounded border px-3 py-1.5 text-sm"
              />
              {errors.signature && <p className="mt-1 text-xs text-red-600">{errors.signature}</p>}
            </div>

            <button
              type="submit"
              disabled={busy || !challenge}
              className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Verify Signature & Sign In"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function SignInForm() {
  const [challenge, setChallenge] = useState<SignInChallenge | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [values, setValues] = useState<SignInFormValues>(emptySignInForm);
  const [errors, setErrors] = useState<SignInFieldErrors>({});
  const [result, setResult] = useState<VerifySignInResult | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"wallet" | "cli">("wallet");
  const [walletAvailable, setWalletAvailable] = useState<boolean>(false);

  const fetchChallenge = useCallback(async () => {
    setChallengeError(null);
    const res = await api.requestNonce();
    if (res.kind === "ok") {
      setChallenge(res.challenge);
    } else {
      setChallengeError(res.detail);
    }
  }, []);

  useEffect(() => {
    void fetchChallenge();

    // Detect browser wallet extension presence
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        near?: unknown;
        meteor?: unknown;
        here?: unknown;
        sender?: unknown;
      };
      if (win.near || win.meteor || win.here || win.sender) {
        setWalletAvailable(true);
      } else {
        // Default to CLI tab if no extension is installed
        setActiveTab("cli");
      }
    }
  }, [fetchChallenge]);

  const handleEdit = (field: SignInFormField, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const handleCliSubmit = async () => {
    if (!challenge) {
      await fetchChallenge();
      return;
    }

    const validated = validateSignInInput(values, challenge);
    if (!validated.ok) {
      setErrors(validated.errors);
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const verifyRes = await api.verifySignIn(validated.request);
      setResult(verifyRes);
      if (verifyRes.kind === "ok" && typeof window !== "undefined") {
        window.location.assign("/endpoints");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleWalletPrompt = async () => {
    if (!challenge) {
      await fetchChallenge();
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const win = window as unknown as {
        near?: {
          signMessage?: (params: {
            message: string;
            recipient: string;
            nonce: Uint8Array | number[];
          }) => Promise<{
            accountId: string;
            publicKey: string;
            signature: string;
          }>;
        };
      };

      if (!win.near?.signMessage) {
        setActiveTab("cli");
        return;
      }

      // Convert nonce string to binary array for wallet signMessage
      const nonceBytes = Buffer.from(challenge.nonce, "base64");
      const signed = await win.near.signMessage({
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: Array.from(nonceBytes),
      });

      const verifyRes = await api.verifySignIn({
        accountId: signed.accountId,
        publicKey: signed.publicKey,
        signature: signed.signature,
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: challenge.nonce,
        ...(challenge.callbackUrl ? { callbackUrl: challenge.callbackUrl } : {}),
      });

      setResult(verifyRes);
      if (verifyRes.kind === "ok" && typeof window !== "undefined") {
        window.location.assign("/endpoints");
      }
    } catch (err) {
      setResult({
        kind: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SignInFormView
      challenge={challenge}
      challengeError={challengeError}
      values={values}
      errors={errors}
      result={result}
      busy={busy}
      walletAvailable={walletAvailable}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onEdit={handleEdit}
      onSubmitCli={handleCliSubmit}
      onPromptWallet={handleWalletPrompt}
      onRefreshChallenge={fetchChallenge}
    />
  );
}
