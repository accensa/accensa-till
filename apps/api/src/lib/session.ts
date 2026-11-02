/**
 * Signed session cookie via jose (UI-1, A5). HTTP-only, SameSite=Strict, single
 * origin, carrying only the seller id. The signature is verified on every
 * dashboard request; there is no sessions table (cut as overengineered, so a
 * logout is a cookie delete).
 *
 * SESSION_SECRET is validated at boot (env.ts) and must never be logged —
 * lib/logger.ts redacts it by key name.
 */
export const SESSION_COOKIE = "till_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

export type SessionClaims = {
  readonly sellerId: string;
  readonly nearAccountId: string;
};

export function createSessionCookie(_claims: SessionClaims): Promise<string> {
  throw new Error("not implemented (UI-1)");
}

export function verifySessionCookie(_token: string): Promise<SessionClaims | null> {
  throw new Error("not implemented (UI-1)");
}
