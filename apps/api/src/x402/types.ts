import type { PaymentRequirementsDto } from "@till/core";

/**
 * Our own x402 surface types (C1) so `@fastnear/*` types stay inside x402/near.ts.
 * A payment authorization here carries only what guards and the ledger need.
 */
export type PaymentAuthorization = {
  readonly replayKey: string;
  readonly payerAccountId: string;
  /**
   * When the delegation stops being spendable, if that is knowable here. It is
   * not: a NEAR delegate expires at a *block height* set by the payer's signer,
   * and reading it back would mean decoding Borsh NEP-366 ourselves, which is the
   * crypto C14 refused to hand-roll. The scheme enforces it on chain at every
   * verify and settle, so this is null by fact, not by omission, and anything
   * wall-clock (the sweep job) works from `verifiedAt`.
   */
  readonly expiresAt: Date | null;
};

/** Why a payment was refused, in three kinds the route can map to statuses. */
export type X402FailureKind =
  /** Till cannot verify anything: no relayer key and no injected signer. */
  | "unconfigured"
  /** The body is not a payment we can attempt: bad shape, bad version, bad size. */
  | "malformed"
  /** A well-formed payment the scheme refused (forged, expired, wrong amount). */
  | "invalid"
  /** The verifier itself failed, so nothing may be treated as paid. */
  | "error";

export type VerifyOutcome =
  | { readonly ok: true; readonly authorization: PaymentAuthorization }
  | { readonly ok: false; readonly kind: X402FailureKind; readonly reason: string };

export type SettleOutcome =
  | { readonly ok: true; readonly nearTxHash: string; readonly payerAccountId: string | null }
  | {
      /**
       * A failed settlement can still carry a transaction hash: the outer relayer
       * transaction lands while the inner `ft_transfer` reverts. It is not a
       * settlement, but it is the one thing a seller can look up, so it travels
       * with the failure.
       */
      readonly ok: false;
      readonly kind: X402FailureKind;
      readonly reason: string;
      readonly nearTxHash?: string;
    };

/** What it takes to advertise a price to a payer (GW-1). */
export type RequirementsInput = {
  readonly network: string;
  /** NEP-141 token account id. */
  readonly assetContract: string;
  /** Base units as a decimal string, never scaled by token decimals. */
  readonly priceAmount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
};

/**
 * The chain reads the verifier needs, declared here rather than imported (hard
 * rule 1). `x402/near.ts` passes an object of this shape to the facilitator,
 * which duck-types it, so a test can hand one in without importing the library
 * at all — that is what makes GW-2's refusal paths testable offline.
 *
 * Every read must resolve against finality and a failure must surface as a throw
 * or a `null`, because the scheme treats both as "refuse the payment".
 */
export type NearViewSigner = {
  getRelayerIds(): readonly string[];
  getCurrentBlockHeight(network: string): Promise<bigint>;
  viewAccount(input: {
    network: string;
    accountId: string;
  }): Promise<{ codeHash: string } | null>;
  viewAccessKey(input: {
    network: string;
    accountId: string;
    publicKey: string;
  }): Promise<{ nonce: bigint; permissionKind: "FullAccess" | "FunctionCall" | "Unknown" } | null>;
  ftBalanceOf(input: { network: string; token: string; accountId: string }): Promise<bigint>;
  storageBalanceOf(input: {
    network: string;
    token: string;
    accountId: string;
  }): Promise<{ supported: false } | { supported: true; registered: boolean }>;
  submitSignedDelegateAction(input: {
    network: string;
    relayerId: string;
    signedDelegateAction: string;
  }): Promise<{
    transaction: string;
    innerReceipt: { kind: "success"; value: string } | { kind: "failure"; error: string };
  }>;
};

/**
 * What the chain says about a settlement hash Till recorded but did not finish
 * booking (C10). `unknown` is a verdict, not an error: a node that cannot answer
 * must not be read as either outcome, because both readings move money in the
 * ledger or hand a paid row to a retry.
 */
export type SettlementVerdict = "settled" | "failed" | "unknown";

export type X402Near = {
  /** False when no relayer key was configured, which is the testnet-default state. */
  readonly configured: boolean;
  requirements(input: RequirementsInput): PaymentRequirementsDto;
  /** Takes the raw request body: it is untrusted, so this is where it is shaped. */
  verify(body: unknown, requirements: PaymentRequirementsDto): Promise<VerifyOutcome>;
  settle(body: unknown, requirements: PaymentRequirementsDto): Promise<SettleOutcome>;
  /**
   * The boot sweep's one chain read (C10): given the hash a settle returned, did
   * the transaction land and did every receipt in it succeed? Only `settled` is
   * evidence of money moving; `unknown` leaves the row alone for the next boot.
   */
  settlementStatus(nearTxHash: string): Promise<SettlementVerdict>;
};
