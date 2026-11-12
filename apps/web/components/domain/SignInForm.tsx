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
  decodeBase64Nonce,
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
  readonly onScanWallet?: () => void;
};

const STEPS = [
  {
    index: "01",
    title: "Request a challenge",
    body: "Till issues a one-time nonce bound to this browser session.",
  },
  {
    index: "02",
    title: "Sign the message",
    body: "Your wallet signs the NEP-413 payload. The key never leaves it.",
  },
  {
    index: "03",
    title: "Session issued",
    body: "Till verifies the signature and sets an HttpOnly session cookie.",
  },
] as const;

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
  onScanWallet,
}: SignInFormViewProps) {
  if (result?.kind === "ok") {
    return (
      <section aria-label="Sign-in complete" className="panel max-w-2xl">
        <div className="border-b border-line bg-coal px-6 py-4">
          <span className="eyebrow flex items-center gap-2 text-mint">
            <span aria-hidden className="h-1.5 w-1.5 bg-mint" />
            Session active
          </span>
        </div>
        <div className="px-6 py-8">
          <h2 className="text-3xl font-semibold tracking-[-0.03em]">Signed In</h2>
          <p className="mt-4 text-sm leading-6 text-muted">
            Authenticated as{" "}
            <strong className="font-mono text-[13px] font-normal text-bone">
              {result.seller.nearAccountId}
            </strong>
            .
          </p>
          <p className="mt-2 text-xs leading-5 text-faint">
            Your session cookie is active. If you are not redirected automatically,{" "}
            <a className="link text-bone" href="/endpoints">
              proceed to Endpoints
            </a>
            .
          </p>
          <a className="btn btn-primary mt-8" href="/endpoints">
            Open the console
            <span aria-hidden>→</span>
          </a>
        </div>
      </section>
    );
  }

  const cliCommand = challenge ? buildCliCommand(challenge, values.accountId) : "";

  return (
    <section
      aria-label="Sign in to Till"
      className="grid border border-line lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]"
    >
      <aside className="flex flex-col justify-between gap-10 border-b border-line bg-coal p-7 lg:border-b-0 lg:border-r lg:p-10">
        <div>
          <p className="eyebrow flex items-center gap-3">
            <span aria-hidden className="h-px w-6 bg-acid" />
            Authentication / NEP-413
          </p>
          <h1 className="mt-5 max-w-sm text-4xl font-semibold leading-[1.02] tracking-[-0.035em] sm:text-5xl">
            Sign in with NEAR
          </h1>
          <p className="mt-5 max-w-sm text-sm leading-6 text-muted">
            Verify account ownership via NEP-413 signed message. No private keys ever touch the
            browser.
          </p>

          <ol className="mt-10 space-y-0 border-t border-line">
            {STEPS.map((step) => (
              <li className="flex gap-5 border-b border-line py-4" key={step.index}>
                <span className="font-mono text-[10px] leading-5 text-acid">{step.index}</span>
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone">
                    {step.title}
                  </p>
                  <p className="mt-1 text-[13px] leading-5 text-muted">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <dl className="grid grid-cols-2 gap-4 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
          <div>
            Signature
            <dd className="mt-1 text-[10px] tracking-[0.1em] text-bone">Ed25519</dd>
          </div>
          <div>
            Session
            <dd className="mt-1 text-[10px] tracking-[0.1em] text-bone">HttpOnly</dd>
          </div>
        </dl>
      </aside>

      <div className="p-7 lg:p-10">
        <div className="flex items-center justify-between gap-4 border-b border-line pb-4">
          <span className="eyebrow">Access request</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
            near:testnet
          </span>
        </div>

        <div className="mt-6 space-y-4">
          {challengeError && (
            <div className="notice-danger" role="alert">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-danger">
                Challenge failed /{" "}
              </span>
              Failed to obtain challenge from Till: {challengeError}
              <button
                className="ml-2 underline underline-offset-4 hover:text-acid"
                onClick={onRefreshChallenge}
                type="button"
              >
                Retry
              </button>
            </div>
          )}

          {result?.kind === "rejected" && (
            <div className="notice-danger" role="alert">
              <strong className="font-mono text-[10px] uppercase tracking-[0.14em] text-danger">
                Sign-in refused:{" "}
              </strong>
              {authErrorMessage(result.error)}
            </div>
          )}

          {result?.kind === "unreachable" && (
            <div className="notice-warn" role="alert">
              <strong className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber">
                Service unreachable:{" "}
              </strong>
              {result.detail}
            </div>
          )}

          {challenge && (
            <div className="border border-line bg-ink">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                  Active Challenge (expires in 5 min)
                </span>
                <button
                  className="font-mono text-[10px] uppercase tracking-[0.1em] text-acid underline underline-offset-4 hover:no-underline"
                  onClick={onRefreshChallenge}
                  type="button"
                >
                  Refresh Nonce
                </button>
              </div>
              <dl className="grid gap-x-4 gap-y-2 px-4 py-3 text-[11px]">
                <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
                  <dt className="font-mono uppercase tracking-[0.1em] text-faint">Recipient</dt>
                  <dd className="break-all font-mono text-muted">{challenge.recipient}</dd>
                </div>
                <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-2">
                  <dt className="font-mono uppercase tracking-[0.1em] text-faint">Nonce</dt>
                  <dd className="break-all font-mono text-muted">{challenge.nonce}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>

        <div className="mt-6 grid grid-cols-2 border border-line">
          <button
            className={`h-10 border-r border-line font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              activeTab === "wallet"
                ? "bg-bone text-ink"
                : "text-muted hover:bg-raised hover:text-bone"
            }`}
            onClick={() => onTabChange("wallet")}
            type="button"
          >
            Browser Wallet
          </button>
          <button
            className={`h-10 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              activeTab === "cli"
                ? "bg-bone text-ink"
                : "text-muted hover:bg-raised hover:text-bone"
            }`}
            onClick={() => onTabChange("cli")}
            type="button"
          >
            CLI / Manual Sign
          </button>
        </div>

        <div className="mt-6">
          {activeTab === "wallet" ? (
            <div>
              {walletAvailable ? (
                <div className="border border-line p-5">
                  <span className="chip chip-live">Wallet found</span>
                  <p className="mt-3 text-sm leading-6 text-muted">
                    In-page NEAR wallet detected. Click below to sign the NEP-413 challenge.
                  </p>
                  <button
                    className="btn btn-primary mt-5 w-full"
                    disabled={busy || !challenge}
                    onClick={onPromptWallet}
                    type="button"
                  >
                    {busy ? "Signing in…" : "Sign In with Wallet"}
                  </button>
                </div>
              ) : (
                <div className="border border-line p-5">
                  <span className="chip chip-warn">No wallet</span>
                  <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-bone">
                    No browser wallet extension detected
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Install a NEAR wallet extension (such as Meteor Wallet or HERE Wallet), or
                    switch to the{" "}
                    <strong className="font-normal text-bone">CLI / Manual Sign</strong> tab to
                    authenticate using testnet credentials.
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      className="btn btn-small"
                      onClick={() => onTabChange("cli")}
                      type="button"
                    >
                      Switch to CLI / Manual Sign
                    </button>
                    {onScanWallet && (
                      <button
                        className="btn btn-small border border-line bg-raised hover:bg-line text-bone"
                        onClick={onScanWallet}
                        type="button"
                      >
                        Scan Again for Wallet
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <form
              aria-label="Manual NEP-413 sign-in form"
              className="space-y-5"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                onSubmitCli();
              }}
            >
              <div>
                <span className="eyebrow">Terminal Command (near-cli-rs)</span>
                <div className="mt-2 border border-line bg-ink">
                  <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
                    <span aria-hidden className="h-1.5 w-1.5 bg-danger" />
                    <span aria-hidden className="h-1.5 w-1.5 bg-amber" />
                    <span aria-hidden className="h-1.5 w-1.5 bg-mint" />
                    <span className="ml-2 font-mono text-[9px] uppercase tracking-[0.14em] text-faint">
                      shell
                    </span>
                  </div>
                  <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-5 text-bone">
                    <code>{cliCommand || "Fetching challenge..."}</code>
                  </pre>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-faint">
                  Run this command in your terminal, then paste the resulting account, public key,
                  and signature below.
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="label" htmlFor="accountId">
                    NEAR Account ID
                  </label>
                  <input
                    className="field"
                    id="accountId"
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      onEdit("accountId", e.target.value)
                    }
                    placeholder="seller.testnet"
                    type="text"
                    value={values.accountId}
                  />
                  {errors.accountId && (
                    <p className="mt-1.5 font-mono text-[10px] text-danger">{errors.accountId}</p>
                  )}
                </div>

                <div>
                  <label className="label" htmlFor="publicKey">
                    Public Key
                  </label>
                  <input
                    className="field"
                    id="publicKey"
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      onEdit("publicKey", e.target.value)
                    }
                    placeholder="ed25519:..."
                    type="text"
                    value={values.publicKey}
                  />
                  {errors.publicKey && (
                    <p className="mt-1.5 font-mono text-[10px] text-danger">{errors.publicKey}</p>
                  )}
                </div>

                <div>
                  <label className="label" htmlFor="signature">
                    Signature (Base64 or ed25519:base58)
                  </label>
                  <input
                    className="field"
                    id="signature"
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      onEdit("signature", e.target.value)
                    }
                    placeholder="base64 signature..."
                    type="text"
                    value={values.signature}
                  />
                  {errors.signature && (
                    <p className="mt-1.5 font-mono text-[10px] text-danger">{errors.signature}</p>
                  )}
                </div>

                <button
                  className="btn btn-primary w-full"
                  disabled={busy || !challenge}
                  type="submit"
                >
                  {busy ? "Verifying…" : "Verify Signature & Sign In"}
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="mt-6 border-t border-line pt-4 font-mono text-[9px] uppercase leading-5 tracking-[0.12em] text-faint">
          Single origin / HttpOnly cookie / no key material stored
        </p>
      </div>
    </section>
  );
}

function checkInjectedWallet(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as unknown as Record<string, unknown>;
  const nightly = win.nightly as Record<string, unknown> | undefined;
  const bitget = win.bitgetWallet as Record<string, unknown> | undefined;
  return Boolean(
    win.near ||
      win.meteorWallet ||
      win.meteor ||
      win.hereWallet ||
      win.here ||
      win.sender ||
      nightly?.near ||
      bitget?.near,
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

  const scanWallet = useCallback(() => {
    if (checkInjectedWallet()) {
      setWalletAvailable(true);
      return true;
    }
    return false;
  }, []);

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

    if (scanWallet()) {
      return;
    }

    // Extensions inject asynchronously after page script execution; poll for 3 seconds
    const interval = setInterval(() => {
      if (scanWallet()) {
        clearInterval(interval);
      }
    }, 300);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      if (!checkInjectedWallet()) {
        setActiveTab("cli");
      }
    }, 3000);

    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [fetchChallenge, scanWallet]);

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
      const win = window as unknown as Record<string, unknown>;
      const nightly = win.nightly as Record<string, unknown> | undefined;
      const provider = (win.near ||
        win.meteorWallet ||
        win.hereWallet ||
        win.sender ||
        nightly?.near) as
        | {
            signMessage?: (params: {
              message: string;
              recipient: string;
              nonce: Uint8Array | number[];
            }) => Promise<{
              accountId: string;
              publicKey: string;
              signature: string;
            }>;
          }
        | undefined;

      if (!provider?.signMessage) {
        setActiveTab("cli");
        return;
      }

      // Convert nonce string to binary array for wallet signMessage
      const nonceBytes = decodeBase64Nonce(challenge.nonce);
      const signed = await provider.signMessage({
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
      onScanWallet={scanWallet}
    />
  );
}
