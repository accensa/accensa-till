/**
 * Wallet-signature sign-in (UI-1). Flow: ask the wallet to sign a nonce message,
 * POST it to routes/auth.ts, receive the signed HTTP-only cookie. No secret is
 * ever stored in the browser (UI-1 acceptance criteria).
 */
export default function SignInPage() {
  return (
    <section>
      <h1>Sign in with your NEAR wallet</h1>
      <p>Not implemented (UI-1). Needs apps/api/src/routes/auth.ts and lib/session.ts.</p>
    </section>
  );
}
