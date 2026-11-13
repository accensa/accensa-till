import { createHash } from "node:crypto";

import { type PaymentRequirementsDto, paymentPayloadSchema } from "@till/core";

import { createNearPaymentFetch } from "@fastnear/x402";
import { createNearFacilitator } from "@fastnear/x402/facilitator";
import { createLocalNearSigner } from "@fastnear/x402/node";
import { createNearResourceServer } from "@fastnear/x402/server";

import type {
  NearViewSigner,
  RequirementsInput,
  SettleOutcome,
  SettlementVerdict,
  VerifyOutcome,
  X402FailureKind,
  X402Near,
} from "./types.ts";

/**
 * The ONLY module that may import @fastnear x402 packages (AGENTS.md hard rule
 * 1, C1). verify, settle and requirement helpers, with our own types in
 * x402/types.ts so library shapes never leak into services or routes.
 *
 * Everything cryptographic stays inside the library: the signature, the access
 * key, the block-height expiry, the gas cap, the `ft_transfer` arguments and the
 * NEP-145 storage check are all the scheme's own decisions, re-derived against
 * chain state on every call. What is ours is the wiring, the shape of what we
 * advertise, the replay key the ledger stores, and turning a
 * `{isValid, invalidReason}` result into a value a route cannot misread as paid.
 */

/** The scheme id the payer's wallet selects on; it is not ours to rename (C1). */
export const X402_SCHEME = "exact";

/**
 * Library argument types, derived rather than imported. `@x402/core` is not a
 * dependency of this app, so naming it directly would fail under pnpm's
 * isolation — which is the same proof C14 recorded for `@near-js/crypto`.
 */
type ResourceServer = ReturnType<typeof createNearResourceServer>;
type VerifyPaymentArgs = Parameters<ResourceServer["verifyPayment"]>;
type SettlePaymentArgs = Parameters<ResourceServer["settlePayment"]>;
type FacilitatorRegistration = Parameters<typeof createNearFacilitator>[0]["registrations"][number];

/**
 * The library's `PaymentPayload`, and the relayer entry inside its facilitator
 * config, both derived from functions we may import rather than named from
 * packages we may not. `@x402/core` and `@near-js/crypto` are not dependencies of
 * this app, so importing either would fail under pnpm's isolation — the same
 * proof C14 recorded.
 */
type PaymentPayloadArg = VerifyPaymentArgs[0] | SettlePaymentArgs[0];
type PaymentRequirementsArg = VerifyPaymentArgs[1] | SettlePaymentArgs[1];
type RelayerEntry = Extract<
  FacilitatorRegistration["signer"],
  { relayers: readonly unknown[] }
>["relayers"][number];

/**
 * Our requirements DTO against the library's `PaymentRequirements`. The two
 * differ in exactly one field: `network` is `` `${string}:${string}` `` there and
 * a validated string here, and `paymentRequirementsSchema` is what proves the
 * value has a colon. The assertion is checked by that schema one call earlier,
 * not by the compiler, which is why it lives in a named function instead of at
 * both call sites.
 */
function toLibraryRequirements(dto: PaymentRequirementsDto): PaymentRequirementsArg {
  return dto as unknown as PaymentRequirementsArg;
}

export type X402NearConfig = {
  /** `near:testnet` or `near:mainnet`; anything else leaves the server unusable. */
  readonly network: string;
  /** A delegate asking more than this cannot be sponsored, so it is refused. */
  readonly maxSponsoredGas: bigint;
  /**
   * Production: the relayer that submits and pays for the delegate. Needs A10's
   * funded testnet account, and until then it is absent and `configured` is false.
   */
  readonly relayer?: { accountId: string; secretKey: string };
  /** Where the relayer's RPC reads go (env `NEAR_RPC_URL`). */
  readonly rpcUrl?: string;
  /**
   * Test seam: the chain reads, answered by us. The facilitator duck-types this
   * (hard rule 1 keeps the library's own signer type out of `types.ts`), so the
   * whole verification path can run over a genuine signed delegate with no chain
   * and no money. Production never passes it.
   */
  readonly signer?: NearViewSigner;
  /**
   * The deadline one `verify` or `settle` gets, in milliseconds. Both calls reach
   * a network (RPC and, for verify, `ft_balance_of`) and neither is bounded by
   * anything the route owns, so this is the bound. A test sets it low to prove the
   * refusal without waiting ten seconds; production takes the default.
   */
  readonly actionTimeoutMs?: number;
};

/**
 * GW-2: a paid request must not wait on an RPC forever.
 *
 * Every other network call in the paid path has its own deadline — the upstream
 * proxy (`UPSTREAM_TIMEOUT_MS`), the boot sweep's `tx` read (`SETTLEMENT_STATUS_
 * TIMEOUT_MS`). These two did not, which made a slow node the one failure mode
 * that hangs a payer's request instead of answering it: the request has already
 * passed the challenge, so nothing upstream of it will time out either. Ten
 * seconds is longer than a healthy NEAR RPC read by an order of magnitude (S6
 * measured the FastNear RPC at under a second) and shorter than a payer's
 * patience, so a timeout here is a real fault rather than a slow moment.
 */
const X402_ACTION_TIMEOUT_MS = 10_000;

function reasonOf(response: {
  invalidReason?: string;
  errorReason?: string;
  errorMessage?: string;
}): string {
  // The code stays first and greppable (`invalid_exact_near_payload_signature`),
  // because the route maps it to a status; the message is kept behind it, because
  // `settlement_failed` on its own tells a seller nothing.
  const code = response.invalidReason ?? response.errorReason ?? "rejected_by_scheme";
  const detail = response.errorMessage;
  return detail === undefined || detail.length === 0 || detail === code
    ? code
    : `${code}: ${detail}`;
}

/**
 * A stable identity for one authorization (GW-4). The library has its own
 * duplicate key for its settlement cache, but it is not re-exported from the
 * entry points we are allowed to use, and the ledger needs a column that means
 * "this exact signed delegate, once". Hashing the base64 body is that: same
 * payment, same key; any change, different key.
 */
function replayKeyOf(signedDelegateAction: string): string {
  return createHash("sha256").update(signedDelegateAction).digest("hex");
}

/**
 * The one place a signer reaches the library. `signer` is either the relayer
 * account the library reads chain state for, or the fake a test hands in; both
 * satisfy the same seven-method shape, and only the first exists in production.
 */
function buildServer(
  config: X402NearConfig,
  signer: FacilitatorRegistration["signer"],
): ResourceServer {
  return createNearResourceServer({
    facilitators: createNearFacilitator({
      registrations: [
        {
          network: config.network as FacilitatorRegistration["network"],
          signer,
          // No `settlementCache`: the scheme builds its own in-process one when
          // none is passed, and the class cannot be reached through these entry
          // points anyway — `@fastnear/x402/facilitator` re-exports it in its
          // `.d.ts` and not in its runtime. Its `finally { release(key) }` means
          // it only covers requests in flight together, and the rest is covered
          // twice over: the payer's on-chain access-key nonce, and the ledger's
          // unique `replay_key` with the compare-and-set on `payments.state`.
          maxSponsoredGas: config.maxSponsoredGas,
        },
      ],
    }),
  });
}

/**
 * C10's boot sweep needs one question answered by the chain: the hash a settle
 * returned, did that transaction land and did every receipt in it succeed? The
 * answer decides whether a stale `verified` row is revenue to book or a payment
 * to abandon, so "cannot tell" is its own verdict rather than an error a caller
 * might read as either.
 *
 * The RPC call lives here rather than in the job because this is the module that
 * owns chain reads (hard rule 1 keeps `@fastnear/*` in one file, and this one
 * plain JSON-RPC `tx` needs no key, only the signer account id the transaction
 * was submitted under — the relayer, or a test's signer seam).
 */
const SETTLEMENT_STATUS_TIMEOUT_MS = 5_000;

function statusKind(status: unknown): "success" | "failure" | "other" {
  if (typeof status !== "object" || status === null) {
    return "other";
  }
  if ("Failure" in status) {
    return "failure";
  }
  return "SuccessValue" in status || "SuccessReceiptId" in status ? "success" : "other";
}

/**
 * A delegate action is wrapped: the outer relayer transaction can report success
 * while the inner `ft_transfer` receipt failed. Both are "not settled" for the
 * ledger, so any failed receipt in the outcome list outranks the outer status.
 */
function anyReceiptFailed(result: unknown): boolean {
  const outcomes = (result as { receipts_outcome?: unknown }).receipts_outcome;
  if (!Array.isArray(outcomes)) {
    return false;
  }
  return outcomes.some(
    (entry) =>
      statusKind((entry as { outcome?: { status?: unknown } }).outcome?.status) === "failure",
  );
}

async function settlementVerdict(
  rpcUrl: string | undefined,
  signerAccountId: string | undefined,
  nearTxHash: string,
): Promise<SettlementVerdict> {
  if (rpcUrl === undefined || signerAccountId === undefined) {
    return "unknown";
  }
  let result: unknown;
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "till-sweep",
        method: "tx",
        params: [nearTxHash, signerAccountId, "FINAL"],
      }),
      signal: AbortSignal.timeout(SETTLEMENT_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) {
      return "unknown";
    }
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined || body.result === undefined) {
      return "unknown";
    }
    result = body.result;
  } catch {
    return "unknown";
  }
  if (anyReceiptFailed(result)) {
    return "failed";
  }
  const status = (result as { status?: unknown }).status;
  const kind = statusKind(status);
  return kind === "failure" ? "failed" : kind === "success" ? "settled" : "unknown";
}

export function createX402Near(config: X402NearConfig): X402Near {
  const relayer = config.relayer;
  const actionTimeoutMs = config.actionTimeoutMs ?? X402_ACTION_TIMEOUT_MS;
  let server: ResourceServer | null = null;

  if (config.signer !== undefined) {
    // Hard rule 1 keeps the library's own signer type out of `types.ts`, so our
    // mirror of the seven methods is structurally compatible rather than nominal.
    server = buildServer(config, config.signer as FacilitatorRegistration["signer"]);
  } else if (relayer !== undefined) {
    server = buildServer(config, {
      relayers: [
        {
          accountId: relayer.accountId,
          // The library types `secretKey` as the template-literal union
          // `ed25519:${string}` | `secp256k1:${string}`, and naming that type means
          // importing `@near-js/crypto`, which is not a dependency of this app
          // (C14's isolation proof). An env string cannot be checked against a type
          // we cannot import, so the assertion happens here once and `env.ts` is
          // what makes it true: `RELAYER_SECRET_KEY` must carry a curve prefix, so
          // a mistyped key fails the process at boot instead of reaching this line.
          // A *missing* key is not a boot failure: `server.ts` reports
          // `configured: false` and the gateway answers 503 to a payer (C1, C4).
          secretKey: relayer.secretKey as RelayerEntry["secretKey"],
        },
      ],
      ...(config.rpcUrl === undefined ? {} : { rpcUrls: { [config.network]: config.rpcUrl } }),
    });
  }

  /**
   * Built directly rather than through the library's `buildPaymentRequirements`.
   * That path runs a price through `parsePrice`, which multiplies a decimal
   * string by the token's 6 decimals, and its `MoneyParser` hook receives a
   * `number` — a float on the money path, which AGENTS.md rule 3 forbids. Given
   * an `AssetAmount` it returns it verbatim, so building the object ourselves and
   * validating it with our own schema is both the shorter path and the one that
   * cannot rescale a price. The scheme's own `enhancePaymentRequirements` returns
   * NEAR requirements unchanged, so nothing is skipped.
   */
  function requirements(input: RequirementsInput): PaymentRequirementsDto {
    return paymentPayloadSchema.shape.accepted.parse({
      scheme: X402_SCHEME,
      network: input.network,
      amount: input.priceAmount,
      asset: input.assetContract,
      payTo: input.payTo,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      extra: {},
    });
  }

  function malformed(reason: string): VerifyOutcome {
    return { ok: false, kind: "malformed", reason };
  }

  /**
   * The one place a library promise is given a deadline. A rejection is what the
   * caller already maps to `{ ok: false, kind: "error" }`, so a timeout fails
   * closed exactly like a thrown RPC error: the route refuses rather than chal-
   * lenges, and never serves on a verdict it did not receive.
   */
  async function withDeadline<T>(work: Promise<T>, action: "verify" | "settle"): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`x402 ${action} timed out after ${actionTimeoutMs} ms`)),
        actionTimeoutMs,
      );
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      // Node keeps the process alive for a pending timer, and this one would
      // outlive a fast answer by the whole timeout if it were not cleared.
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async function attempt(
    body: unknown,
    requirementsDto: PaymentRequirementsDto,
    action: "verify" | "settle",
  ): Promise<{ ok: false; kind: X402FailureKind; reason: string } | { ok: true; data: unknown }> {
    if (server === null) {
      return {
        ok: false,
        kind: "unconfigured",
        reason: "no relayer configured, so nothing can be verified or settled",
      };
    }
    const parsed = paymentPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        kind: "malformed",
        reason: `payment body is invalid: ${parsed.error.issues[0]?.code ?? "unknown"}`,
      };
    }
    // The buyer's own `accepted` is dropped and replaced by the requirements we
    // serve, in both positions of the call. Measured, not assumed: `verify` reads
    // *both* arguments and cross-checks five fields of `payload.accepted` against
    // `requirements` — scheme, network, asset, payTo, amount, in that order before
    // the signature is even looked at (`@x402/near/dist/cjs/exact/facilitator/
    // index.js:262-279`), then checks the signed `ft_transfer` arguments against
    // `requirements` again. So a payer widening the price in `accepted` was already
    // refused by the library, and making both positions our value is what keeps the
    // *refusal* ours: the strong `ft_transfer`-against-our-price rule fires instead
    // of the shallow field-consistency one. Mutating this line to pass the buyer's
    // object through breaks one test, and it breaks on the refusal code, not on
    // acceptance — which is the difference between this being a guard and being a
    // belt. (GW-2) The assertion is the documented boundary — `@x402/core` is not a
    // dependency of this app, so `PaymentPayload` and `ResourceInfo` can only be
    // reached through `Parameters<>`, and zod's optional-`undefined` output is not
    // structurally identical to that `exactOptionalPropertyTypes` shape.
    const payload = { ...parsed.data, accepted: requirementsDto } as unknown as PaymentPayloadArg;
    const requirementsArg = toLibraryRequirements(requirementsDto);
    try {
      if (action === "verify") {
        return {
          ok: true,
          data: await withDeadline(server.verifyPayment(payload, requirementsArg), "verify"),
        };
      }
      return {
        ok: true,
        data: await withDeadline(server.settlePayment(payload, requirementsArg), "settle"),
      };
    } catch (error) {
      // A verifier that could not run is not a payment that failed: the route must
      // not re-challenge, and must certainly not serve. Fail closed, say why.
      return {
        ok: false,
        kind: "error",
        reason: `x402 ${action} failed: ${(error as Error).message}`,
      };
    }
  }

  return {
    configured: server !== null,
    requirements,
    settlementStatus(nearTxHash: string): Promise<SettlementVerdict> {
      // The relayer signed the outer transaction, so its id is what `tx` needs.
      // The test seam stands in for it when no key is configured.
      const signerAccountId = relayer?.accountId ?? config.signer?.getRelayerIds()[0];
      return settlementVerdict(config.rpcUrl, signerAccountId, nearTxHash);
    },
    async verify(body: unknown, requirementsDto: PaymentRequirementsDto): Promise<VerifyOutcome> {
      const result = await attempt(body, requirementsDto, "verify");
      if (!result.ok) {
        return { ok: false, kind: result.kind, reason: result.reason };
      }
      const response = result.data as Awaited<ReturnType<ResourceServer["verifyPayment"]>>;
      if (!response.isValid) {
        return { ok: false, kind: "invalid", reason: reasonOf(response) };
      }
      // `payer` is optional in the library's response. An unknown payer is not a
      // payment we can attribute or guard (self-payment, UI-3), so it is refused.
      if (typeof response.payer !== "string" || response.payer.length === 0) {
        return { ok: false, kind: "invalid", reason: "verified_without_payer_identity" };
      }
      const payload = paymentPayloadSchema.parse(body);
      return {
        ok: true,
        authorization: {
          replayKey: replayKeyOf(payload.payload.signedDelegateAction),
          payerAccountId: response.payer,
          expiresAt: null,
        },
      };
    },
    async settle(body: unknown, requirementsDto: PaymentRequirementsDto): Promise<SettleOutcome> {
      const result = await attempt(body, requirementsDto, "settle");
      if (!result.ok) {
        return { ok: false, kind: result.kind, reason: result.reason };
      }
      const response = result.data as Awaited<ReturnType<ResourceServer["settlePayment"]>>;
      const transaction = typeof response.transaction === "string" ? response.transaction : "";
      if (!response.success) {
        // A failed settlement can still carry a hash, and the two cases mean
        // different things to a seller: the outer relayer transaction landing
        // while the inner `ft_transfer` reverts (`settlement_failed` plus a hash)
        // is a receipt to look up, while `duplicate_settlement` is not. The hash
        // travels with the reason so the route can store it without ever calling
        // this settled — a ledger entry written here would book revenue that did
        // not arrive.
        return {
          ok: false,
          kind: "invalid",
          reason: reasonOf(response),
          ...(transaction.length > 0 ? { nearTxHash: transaction } : {}),
        };
      }
      if (transaction.length === 0) {
        // Reported success with nothing to point at. The state machine needs a
        // hash to match the payout against, so this is refused rather than
        // recorded as settled with a null.
        return { ok: false, kind: "error", reason: "settle_succeeded_without_transaction_hash" };
      }
      return {
        ok: true,
        nearTxHash: transaction,
        payerAccountId: typeof response.payer === "string" ? response.payer : null,
      };
    },
  };
}

/**
 * C11: the buyer side of the same scheme, and it lives here only because hard
 * rule 1 keeps every `@fastnear` import in this file. The demo agent is the one
 * program that pays Till rather than serving it; wrapping `@fastnear/x402`'s
 * reference client signer means the payer half is executed by the shipped
 * library too, not re-signed by hand.
 *
 * The key is a testnet payer's, supplied by the caller and never logged here.
 * Without A10's funded payer there is nothing this can do, which is the honest
 * state the agent script reports instead of inventing a payment.
 */
export type PayerConfig = {
  readonly accountId: string;
  readonly secretKey: string;
  /** `near:testnet` or `near:mainnet`. */
  readonly network: string;
  /** RPC endpoint override; the library defaults to the public one per network. */
  readonly rpcUrl?: string;
};

export function createPayerFetch(config: PayerConfig): typeof globalThis.fetch {
  const signer = createLocalNearSigner({
    accountId: config.accountId,
    // `KeyPairString` is the library's own branded type and is not importable
    // under pnpm's isolation; the value is the `ed25519:...` string env.ts
    // already shape-checks at boot for the relayer.
    secretKey: config.secretKey as Parameters<typeof createLocalNearSigner>[0]["secretKey"],
    ...(config.rpcUrl === undefined ? {} : { rpcUrls: { [config.network]: config.rpcUrl } }),
  });
  return createNearPaymentFetch({
    signer,
    network: config.network as NonNullable<Parameters<typeof createNearPaymentFetch>[0]["network"]>,
  });
}
