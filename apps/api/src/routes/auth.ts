/**
 * Wallet-signature sign-in (UI-1, A5): verify a NEAR message signature, then
 * issue a signed HTTP-only cookie via lib/session.ts. No secret ever reaches
 * the browser, and there is no sessions table (cut as overengineered).
 */
