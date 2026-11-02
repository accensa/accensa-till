/**
 * Our own x402 surface types (C1) so `@fastnear/*` types stay inside x402/near.ts.
 * A payment authorization here carries only what guards and the ledger need.
 */
export type PaymentAuthorization = {
  readonly replayKey: string;
  readonly payerAccountId: string;
  readonly expiresAt: Date | null;
};
