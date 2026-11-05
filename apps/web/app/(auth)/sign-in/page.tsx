/**
 * Wallet-signature sign-in (UI-1). The flow the server already implements: POST
 * /api/auth/nonce, ask the wallet to sign the message that comes back (NEP-413, an
 * ed25519 *full-access* key), POST the signature to /api/auth/verify, and the
 * session cookie arrives HTTP-only — no secret is ever stored in the browser.
 *
 * What is missing is the wallet connection itself. `near-api-js` alone cannot prompt
 * a browser wallet, so this needs a wallet-selector package, and AGENTS.md makes that
 * the human's call: F8 in ROADMAP.md.
 */
export default function SignInPage() {
  return (
    <section>
      <h1>Sign in with your NEAR wallet</h1>
      <p>
        The server half is built and tested (F1: routes/auth.ts, lib/session.ts, and the NEP-413
        verifier in packages/core). This page still needs a wallet to prompt (F8), so it does not
        pretend to sign anyone in.
      </p>
    </section>
  );
}
