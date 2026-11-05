import { randomBytes } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import {
  type CreationCheck,
  type CreationCheckCode,
  type EndpointCreateInput,
  type EndpointDto,
  endpointDtoSchema,
  formatAmount,
  nearAccountIdSchema,
} from "@till/core";

import type { Db } from "../db/client.ts";
import { endpoints, payoutRoutes } from "../db/schema.ts";
import { type ResolveNames, UpstreamPolicyError, resolveUpstreamTarget } from "../gateway/ssrf.ts";

/**
 * Endpoint creation checks (D4, PO-1/PO-2), in the order ARCHITECTURE 11.3 lists
 * them: the upstream URL, the payout account's token registration, the
 * destination's format per chain, and the price floor.
 *
 * Every check answers with a sentence a seller can act on, and any failure leaves
 * the endpoint `active: false` with those sentences stored on the row. Creation
 * itself is one transaction: the payout route and the endpoint exist together or
 * not at all, so a failed insert cannot leave a half-configured seller.
 *
 * The confirmation step is the HTTP layer's, not this one's: the route refuses a
 * creation whose caller did not echo the destination it was shown back.
 */

export type SellerIdentity = {
  readonly id: string;
  readonly nearAccountId: string;
};

/**
 * The answer of `storage_balance_of` on a NEP-141 token, shaped like the rule
 * `@x402/near` runs inside `verify` (S1): a token that does not implement the
 * method reports `supported: false` and the registration rule is skipped.
 */
export type TokenStorage = {
  readonly supported: boolean;
  readonly registered: boolean;
};

export type TokenStorageReader = {
  read(input: { readonly token: string; readonly accountId: string }): Promise<TokenStorage>;
};

export type TokenStorageErrorCode = "rpc_error" | "contract_error" | "malformed";

export class TokenStorageError extends Error {
  readonly code: TokenStorageErrorCode;

  constructor(code: TokenStorageErrorCode) {
    super(`storage registration could not be read: ${code}`);
    this.name = "TokenStorageError";
    this.code = code;
  }
}

export type EndpointCreationDeps = {
  readonly minPriceBaseUnits: bigint;
  /** The network this process serves; an endpoint on another one cannot be paid here. */
  readonly network: string;
  readonly allowInsecureUpstream: boolean;
  readonly gatewayOrigin: string;
  readonly gatewayPublicUrl: string;
  readonly payoutProvider: "mock" | "oneclick";
  readonly storage: TokenStorageReader;
  /** Test seam for the SSRF check's DNS read; production uses the resolver. */
  readonly resolve?: ResolveNames | undefined;
  /**
   * Test seam for the server-assigned slug. Production's is 72 random bits; a
   * test that wants the unique index to fire injects a constant.
   */
  readonly slug?: (() => string) | undefined;
};

/**
 * The same set the x402 scheme refuses at `verify` time. Every difference from
 * the library is deliberate: the failure is found at creation rather than on a
 * stranger's paid request, and the seller is told which account to register.
 */
const METHOD_NOT_FOUND = /MethodNotFound|MethodResolveError|MethodEmptyName/i;
const STORAGE_CHECK_TIMEOUT_MS = 5_000;

/**
 * A plain JSON-RPC `query` rather than the library's own `storageBalanceOf`.
 * Hard rule 1 keeps `@fastnear/*` in `x402/near.ts`, and the check needs only a
 * public read: no key, no signer, no payment. The shape is the one S1 recorded.
 */
export function createTokenStorageReader(options: {
  readonly rpcUrl: string;
  readonly timeoutMs?: number;
}): TokenStorageReader {
  return {
    async read({ token, accountId }) {
      const response = await fetch(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "till-endpoint-check",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: token,
            method_name: "storage_balance_of",
            args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString("base64"),
          },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? STORAGE_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new TokenStorageError("rpc_error");
      }
      const body = (await response.json()) as {
        error?: unknown;
        result?: { error?: unknown; result?: unknown };
      };
      if (body.error !== undefined || body.result === undefined) {
        throw new TokenStorageError("rpc_error");
      }
      // A NEP-141 contract without `storage_balance_of` answers HTTP 200 with
      // `result.error` naming MethodResolveError; that is "no storage", not a
      // failed read, and it is the one case the registration rule skips.
      if (typeof body.result.error === "string") {
        if (METHOD_NOT_FOUND.test(body.result.error)) {
          return { supported: false, registered: false };
        }
        throw new TokenStorageError("contract_error");
      }
      if (!Array.isArray(body.result.result)) {
        throw new TokenStorageError("malformed");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(body.result.result as number[]).toString("utf8"));
      } catch {
        throw new TokenStorageError("malformed");
      }
      return { supported: true, registered: decoded !== null };
    },
  };
}

const EVM_CHAINS = new Set([
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "avalanche",
  "bsc",
  "gnosis",
  "aurora",
  "linea",
  "scroll",
  "zksync",
]);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BITCOIN_ADDRESS = /^(?:bc1[02-9ac-hj-np-z]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

/** The chains this build can check, and the format it checks for each. */
export function isSupportedDestinationChain(chain: string): boolean {
  return chain === "near" || chain === "solana" || chain === "bitcoin" || EVM_CHAINS.has(chain);
}

/**
 * Format only. A well-formed address on the wrong chain is not detectable here
 * (11.3), which is why the seller is shown the destination back before creation.
 */
export function isValidDestinationAddress(chain: string, address: string): boolean {
  if (chain === "near") {
    return nearAccountIdSchema.safeParse(address).success;
  }
  if (EVM_CHAINS.has(chain)) {
    return EVM_ADDRESS.test(address);
  }
  if (chain === "solana") {
    return SOLANA_ADDRESS.test(address);
  }
  if (chain === "bitcoin") {
    return BITCOIN_ADDRESS.test(address);
  }
  return false;
}

function ok(code: CreationCheckCode, message: string): CreationCheck {
  return { code, ok: true, message };
}

function failed(code: CreationCheckCode, message: string): CreationCheck {
  return { code, ok: false, message };
}

function destinationChain(input: EndpointCreateInput): string {
  return input.destinationChain.toLowerCase();
}

async function upstreamCheck(
  input: EndpointCreateInput,
  deps: EndpointCreationDeps,
): Promise<CreationCheck> {
  try {
    await resolveUpstreamTarget(input.upstreamUrl, {
      allowInsecure: deps.allowInsecureUpstream,
      gatewayOrigin: deps.gatewayOrigin,
      ...(deps.resolve === undefined ? {} : { resolve: deps.resolve }),
    });
    return ok("upstream_url", "The upstream URL is reachable under Till's address policy.");
  } catch (error) {
    if (error instanceof UpstreamPolicyError) {
      return failed(
        "upstream_url",
        `The upstream URL is refused by Till's address policy (${error.code}); use a public https origin.`,
      );
    }
    throw error;
  }
}

/**
 * The accounts whose NEP-145 storage the payment token needs. `direct` pays the
 * seller's own account; `intents` refunds land on the NEAR side, so both the
 * seller and the refund account are checked there (11.3). The set is deduped
 * because a seller may name their own account as the refund account.
 */
function accountsToCheck(input: EndpointCreateInput, seller: SellerIdentity): readonly string[] {
  const accounts =
    input.payoutMode === "direct"
      ? [seller.nearAccountId]
      : [seller.nearAccountId, input.refundAddress];
  return [...new Set(accounts)];
}

async function storageChecks(
  input: EndpointCreateInput,
  seller: SellerIdentity,
  deps: EndpointCreationDeps,
): Promise<CreationCheck[]> {
  const checks: CreationCheck[] = [];
  for (const accountId of accountsToCheck(input, seller)) {
    let storage: TokenStorage;
    try {
      storage = await deps.storage.read({ token: input.assetContract, accountId });
    } catch {
      checks.push(
        failed(
          "storage_unverifiable",
          `Till could not read ${accountId}'s ${input.assetContract} storage registration; try again before activating.`,
        ),
      );
      continue;
    }
    if (!storage.supported) {
      checks.push(
        ok(
          "storage_registration",
          `${input.assetContract} does not manage storage, so ${accountId} needs no registration.`,
        ),
      );
      continue;
    }
    checks.push(
      storage.registered
        ? ok(
            "storage_registration",
            `${accountId} is registered for ${input.assetContract} storage.`,
          )
        : failed(
            "storage_registration",
            `${accountId} is not registered for ${input.assetContract} storage; register it first or payments would be refused.`,
          ),
    );
  }
  return checks;
}

/**
 * Every check, in one place, so the route can show all of them rather than the
 * first failure and the seller does not fix one thing to discover the next.
 */
export async function checkEndpointCreation(
  input: EndpointCreateInput,
  seller: SellerIdentity,
  deps: EndpointCreationDeps,
): Promise<CreationCheck[]> {
  const checks: CreationCheck[] = [];

  checks.push(
    input.network === deps.network
      ? ok("network", `Payments settle on ${deps.network}.`)
      : failed(
          "network",
          `This process serves ${deps.network}, so an endpoint on ${input.network} cannot settle here.`,
        ),
  );

  checks.push(await upstreamCheck(input, deps));

  const price = BigInt(input.priceAmount);
  checks.push(
    price >= deps.minPriceBaseUnits
      ? ok(
          "price_floor",
          `The price is at or above the ${formatAmount(deps.minPriceBaseUnits)} minimum.`,
        )
      : failed(
          "price_floor",
          `The price ${formatAmount(price)} is below Till's ${formatAmount(deps.minPriceBaseUnits)} minimum.`,
        ),
  );

  const chain = destinationChain(input);
  if (!isSupportedDestinationChain(chain)) {
    checks.push(
      failed(
        "destination_chain",
        `Till cannot validate a ${input.destinationChain} address; supported chains are near, solana, bitcoin and the EVM chains.`,
      ),
    );
  } else {
    checks.push(ok("destination_chain", `The destination chain ${chain} is supported.`));
    checks.push(
      isValidDestinationAddress(chain, input.destinationAddress)
        ? ok("destination_address", `The ${chain} destination address is well formed.`)
        : failed(
            "destination_address",
            `The ${chain} destination address is not a valid address on that chain.`,
          ),
    );
  }

  checks.push(
    nearAccountIdSchema.safeParse(input.refundAddress).success
      ? ok("refund_address", "The refund account is a NEAR account id.")
      : failed(
          "refund_address",
          "The refund account must be a NEAR account id; refunds land on NEAR.",
        ),
  );

  if (input.payoutMode === "direct") {
    checks.push(
      input.destinationAddress === seller.nearAccountId
        ? ok(
            "direct_destination",
            `Direct payments go to the signed-in account ${seller.nearAccountId}.`,
          )
        : failed(
            "direct_destination",
            `A direct endpoint pays the signed-in account ${seller.nearAccountId}; the destination must be that account.`,
          ),
    );
  } else {
    // S2 decides the standing-versus-per-payment shape, and D5 creates the route
    // through the provider. Until that exists an intents endpoint has no deposit
    // address to advertise, so creation says so instead of pretending it can serve.
    checks.push(
      failed(
        "deposit_address",
        "An intents endpoint needs a provider deposit address; none has been prepared yet.",
      ),
    );
  }

  if (input.network === deps.network) {
    checks.push(...(await storageChecks(input, seller, deps)));
  }

  return checks;
}

function slug(): string {
  // 72 bits, URL-safe, and not derived from the seller or the time: a slug is the
  // public name of a paywall and enumerating them must not reveal one another.
  return randomBytes(9).toString("base64url");
}

function gatewayUrl(base: string, endpointSlug: string): string {
  return `${base.replace(/\/+$/, "")}/r/${endpointSlug}`;
}

function toDto(row: typeof endpoints.$inferSelect, deps: EndpointCreationDeps): EndpointDto {
  return endpointDtoSchema.parse({
    id: row.id,
    slug: row.slug,
    gatewayUrl: gatewayUrl(deps.gatewayPublicUrl, row.slug),
    upstreamUrl: row.upstreamUrl,
    priceAmount: row.priceAmount,
    assetContract: row.assetContract,
    network: row.network,
    payoutMode: row.payoutMode,
    active: row.active,
    description: row.description,
    creationWarnings: row.creationWarnings,
  });
}

export type CreatedEndpoint = {
  readonly endpoint: EndpointDto;
  readonly checks: CreationCheck[];
};

/**
 * Run the checks, then write the route and the endpoint in one transaction. The
 * endpoint is active only when no check failed; otherwise it keeps the reasons
 * on the row and the gateway ignores it (`active: false` answers 404).
 */
export async function createEndpoint(
  db: Db,
  deps: EndpointCreationDeps,
  seller: SellerIdentity,
  input: EndpointCreateInput,
): Promise<CreatedEndpoint> {
  const checks = await checkEndpointCreation(input, seller, deps);
  const warnings = checks.filter((check) => !check.ok).map((check) => check.message);
  const newSlug = deps.slug ?? slug;

  const endpoint = await db.transaction(async (tx) => {
    const [route] = await tx
      .insert(payoutRoutes)
      .values({
        sellerId: seller.id,
        destinationChain: input.destinationChain,
        destinationAsset: input.destinationAsset,
        destinationAddress: input.destinationAddress,
        refundAddress: input.refundAddress,
        provider: deps.payoutProvider,
        depositAddress: null,
        depositMemo: null,
        quoteRef: null,
        deadlineAt: null,
        modeDetail: input.payoutMode === "direct" ? "direct" : "standing",
      })
      .returning();
    if (route === undefined) {
      throw new Error("payout route insert returned no row");
    }

    const [row] = await tx
      .insert(endpoints)
      .values({
        sellerId: seller.id,
        slug: newSlug(),
        upstreamUrl: input.upstreamUrl,
        priceAmount: input.priceAmount,
        assetContract: input.assetContract,
        network: input.network,
        description: input.description ?? null,
        payoutMode: input.payoutMode,
        routeId: route.id,
        active: warnings.length === 0,
        creationWarnings: warnings,
      })
      .returning();
    if (row === undefined) {
      throw new Error("endpoint insert returned no row");
    }
    return row;
  });

  return { endpoint: toDto(endpoint, deps), checks };
}

export async function listEndpoints(
  db: Db,
  deps: EndpointCreationDeps,
  sellerId: string,
): Promise<EndpointDto[]> {
  const rows = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.sellerId, sellerId))
    .orderBy(desc(endpoints.createdAt));
  return rows.map((row) => toDto(row, deps));
}
