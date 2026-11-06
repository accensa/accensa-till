import { randomBytes } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  type CreationCheck,
  type CreationCheckCode,
  type EndpointCreateInput,
  type EndpointDto,
  type EndpointUpdateInput,
  baseUnitAmountSchema,
  endpointDtoSchema,
  formatAmount,
  nearAccountIdSchema,
} from "@till/core";

import type { Db } from "../db/client.ts";
import { type PayoutRoute, endpoints } from "../db/schema.ts";
import { type ResolveNames, UpstreamPolicyError, resolveUpstreamTarget } from "../gateway/ssrf.ts";
import { type RoutePreparer, routeById, routeForDestination } from "./payout-routes.ts";

/**
 * Endpoint creation checks (D4, PO-1/PO-2), in the order ARCHITECTURE 11.3 lists
 * them: the upstream URL, the payout account's token registration, the
 * destination's format per chain, and the price floor.
 *
 * Every check answers with a sentence a seller can act on, and any failure leaves
 * the endpoint `active: false` with those sentences stored on the row.
 *
 * The payout route (D5, PO-1) is resolved before the endpoint is written, not inside
 * its transaction: a route belongs to a *destination* and is meant to outlive any one
 * endpoint, so a route left by a creation that failed on the slug is the standing
 * quote the next creation reuses rather than an orphan. `services/payout-routes.ts`
 * owns that decision and what the provider is asked for.
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
  /**
   * D5: the payout provider's quoting half, which is what turns an `intents`
   * destination into a deposit address to advertise. Required rather than optional
   * because an `intents` creation without one cannot be answered at all, and the
   * only honest answer left would be a refusal nobody configured.
   */
  readonly routePreparer: RoutePreparer;
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
  }

  // The `deposit_address` check is not here, and cannot be: whether an intents
  // destination has an address to advertise is a fact about the route
  // `createEndpoint` resolves through the provider (D5), so asking it here would
  // either call a provider from a function meant to be read-only about the input,
  // or answer from a guess. `createEndpoint` appends it to this list.

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
 * The checks that mean the destination itself is unusable. A route is a record of
 * where money was going, so one is written only for a destination worth recording:
 * a mistyped address must not cost a provider quote (B12), while every other failure
 * — a low price, an unreadable storage registration — leaves the destination intact
 * and the route meaningful.
 */
const DESTINATION_CODES: readonly CreationCheckCode[] = [
  "destination_chain",
  "destination_address",
  "refund_address",
  "direct_destination",
];

/**
 * The intents half of the check list, from the route that now exists.
 *
 * It names the address because the address is what the seller's paywall will show a
 * payer, and it says plainly when the provider was the mock: a judge reading
 * `mock-deposit-1` on a screen must not have to guess whether a swap will run
 * (DQ-2).
 */
function depositCheck(route: PayoutRoute, reused: boolean): CreationCheck {
  const simulated =
    route.provider === "mock" ? " The mock provider made this address up; no swap will run." : "";
  // `modeDetail` is named only when the quote is new: a reused route is standing by
  // definition, and "the standing standing address" is what reading the column out
  // unconditionally produced.
  const kind = reused ? "standing" : `newly prepared ${route.modeDetail}`;
  return ok(
    "deposit_address",
    `Payouts on ${route.destinationChain} to ${route.destinationAddress} arrive at ${route.depositAddress}, ` +
      `the ${kind} address for that destination.${simulated}`,
  );
}

/**
 * Resolve the payout route, then write the endpoint with the checks in hand. The
 * endpoint is active only when no check failed; otherwise it keeps the reasons on the
 * row and the gateway ignores it (`active: false` answers 404).
 */
export async function createEndpoint(
  db: Db,
  deps: EndpointCreationDeps,
  seller: SellerIdentity,
  input: EndpointCreateInput,
): Promise<CreatedEndpoint> {
  const checks = await checkEndpointCreation(input, seller, deps);
  const destinationSound = !checks.some(
    (check) => !check.ok && DESTINATION_CODES.includes(check.code),
  );
  let routeId: string | null = null;

  if (!destinationSound) {
    if (input.payoutMode === "intents") {
      checks.push(
        failed(
          "deposit_address",
          "Till asks the payout provider for a deposit address only once the destination itself is sound; fix the address above first.",
        ),
      );
    }
  } else {
    const route = await routeForDestination(
      db,
      { providerName: deps.payoutProvider, preparer: deps.routePreparer },
      seller.id,
      input,
    );
    if (route.ok) {
      routeId = route.route.id;
      if (input.payoutMode === "intents") {
        checks.push(depositCheck(route.route, route.reused));
      }
    } else if (input.payoutMode === "intents") {
      checks.push(
        failed(
          "deposit_address",
          `Till has no address to advertise for this destination: ${route.detail}`,
        ),
      );
    } else {
      // A direct route asks nothing of a provider, so the only way to refuse one is
      // the database itself, and that is a bug rather than a seller's problem.
      throw new Error(`the direct payout route could not be written: ${route.detail}`);
    }
  }

  const warnings = checks.filter((check) => !check.ok).map((check) => check.message);
  const newSlug = deps.slug ?? slug;

  const inserted = await db
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
      routeId,
      active: warnings.length === 0,
      creationWarnings: warnings,
    })
    .returning();
  const [endpoint] = inserted;
  if (endpoint === undefined) {
    throw new Error("endpoint insert returned no row");
  }

  return { endpoint: toDto(endpoint, deps), checks };
}

/**
 * A change that lands and the checks that decided it. `found: false` is the answer
 * for an id that is not this seller's endpoint — one answer for "not there" and
 * "somebody else's", because telling them apart says which rows another seller has
 * (the same rule F4 applies to a discrepancy).
 */
export type EndpointUpdateResult =
  | { readonly found: true; readonly endpoint: EndpointDto; readonly checks: CreationCheck[] }
  | { readonly found: false };

/**
 * The stored terms with the change applied, as a full creation input.
 *
 * `network` and `assetContract` come from the row and cannot come from the change:
 * they are what a payer's signed delegate is denominated in, and the core schema
 * refuses them in a body. The destination is read from the *route*, because those
 * four columns live there and not on the endpoint, which is why an endpoint with no
 * route merges to empty strings — and empty strings fail the destination checks, so
 * a change that needs a destination the row never had is refused rather than
 * invented.
 */
function mergedTerms(
  stored: typeof endpoints.$inferSelect,
  route: PayoutRoute | null,
  input: EndpointUpdateInput,
): EndpointCreateInput {
  // Only `direct` is read as direct. A stored value that is neither word cannot come
  // from Till's own write path, and treating it as `intents` means the destination
  // checks run and most likely fail it, which is the honest answer for a row this
  // process did not write.
  const storedMode = stored.payoutMode === "direct" ? "direct" : "intents";
  // The column is plain text; the input type is a branded base-unit string. Going
  // through `baseUnitAmountSchema` brands it without deciding whether the price is
  // *allowed*: a stored `0` still parses here and is then refused by the price-floor
  // check, which is the check that owns that answer. A value that does not parse at
  // all becomes `0` so the same check says so instead of the merge throwing.
  const storedPrice = baseUnitAmountSchema.safeParse(stored.priceAmount);
  return {
    upstreamUrl: input.upstreamUrl ?? stored.upstreamUrl,
    priceAmount:
      input.priceAmount ??
      (storedPrice.success ? storedPrice.data : baseUnitAmountSchema.parse("0")),
    assetContract: stored.assetContract,
    network: stored.network,
    description: input.description ?? stored.description ?? undefined,
    payoutMode: input.payoutMode ?? storedMode,
    destinationChain: input.destinationChain ?? route?.destinationChain ?? "",
    destinationAsset: input.destinationAsset ?? route?.destinationAsset ?? "",
    destinationAddress: input.destinationAddress ?? route?.destinationAddress ?? "",
    refundAddress: input.refundAddress ?? route?.refundAddress ?? "",
  };
}

/**
 * Change what a live endpoint charges and where it pays out (D9, PO-7).
 *
 * **A change that fails a check is refused, not applied.** D4's rule for a *create*
 * is the opposite — write the row `active: false` with the reasons on it — and the
 * difference is on purpose. A create has nothing to protect: there is no paywall
 * until the row exists. An edit has a live one behind it, and de-activating an
 * endpoint that was earning because somebody typed a bad new address would cost the
 * seller money that was already arriving. So the rule is one sentence: **a change
 * lands only when every check passes on the new terms.** That is also what keeps
 * `active: true` worth reading after this row — an active endpoint is one whose terms
 * all passed the last time they changed.
 *
 * The failing checks are in the response and not on the row. They cannot go on the
 * row: `creation_warnings` means "why this endpoint is not live", and an active
 * endpoint carrying a refused edit's reasons would tell the next reader — and the
 * gateway's own join — something untrue about the live terms.
 *
 * What the write cannot do is reach a payment. `payments.amount`, `route_id` and
 * `asset_contract` were copied from the advertisement at verify time, and nothing here
 * updates the `payments` table, so earlier payments keep the price and the payout they
 * were charged under (PO-7) while the next 402 names the new ones.
 *
 * Two more things a landed change does not do, both because a change is an edit of one
 * field of a form the seller already filled in:
 *
 * - it does not decide whether the endpoint is live. `active` keeps its value unless the
 *   body names it, so repairing a paused endpoint's price does not open the paywall.
 * - it does not ask a provider for anything it cannot use. A quote is taken for a new
 *   destination only when every other check passed, so a change that was going to be
 *   refused for an unrelated reason costs no call and no orphan route row (B12).
 */
export async function updateEndpoint(
  db: Db,
  deps: EndpointCreationDeps,
  seller: SellerIdentity,
  endpointId: string,
  input: EndpointUpdateInput,
): Promise<EndpointUpdateResult> {
  const [stored] = await db
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.id, endpointId), eq(endpoints.sellerId, seller.id)))
    .limit(1);
  if (stored === undefined) return { found: false };

  const route = stored.routeId === null ? null : await routeById(db, stored.routeId);
  const terms = mergedTerms(stored, route, input);
  const checks = await checkEndpointCreation(terms, seller, deps);

  // The route is resolved the way `createEndpoint` resolves it (D5) — from the merged
  // terms, not from what the body happened to name — so an edit cannot end up with a
  // destination its create path would not have taken. A price-only change re-reads the
  // endpoint's own standing row and asks the provider for nothing; a new destination
  // costs exactly one quote.
  //
  // A change that is refused for any *other* reason resolves nothing either: the write
  // below is skipped, so a quote taken here would be a provider call and an orphan
  // route row for terms nobody will ever be charged under (B12), and the failing checks
  // already name what is actually wrong.
  let routeId = stored.routeId;
  const failing = checks.filter((check) => !check.ok);
  const destinationSound = !failing.some((check) => DESTINATION_CODES.includes(check.code));
  if (!destinationSound) {
    if (terms.payoutMode === "intents") {
      checks.push(
        failed(
          "deposit_address",
          "Till asks the payout provider for a deposit address only once the destination itself is sound; fix the address above first.",
        ),
      );
    }
  } else if (failing.length === 0) {
    const resolved = await routeForDestination(
      db,
      { providerName: deps.payoutProvider, preparer: deps.routePreparer },
      seller.id,
      terms,
    );
    if (resolved.ok) {
      routeId = resolved.route.id;
      if (terms.payoutMode === "intents") {
        checks.push(depositCheck(resolved.route, resolved.reused));
      }
    } else if (terms.payoutMode === "intents") {
      checks.push(
        failed(
          "deposit_address",
          `Till has no address to advertise for this destination: ${resolved.detail}`,
        ),
      );
    } else {
      throw new Error(`the direct payout route could not be written: ${resolved.detail}`);
    }
  }

  // The refusal half of "a change lands only when every check passes". Nothing is
  // written: no endpoint update, no warning row, no route rewrite — the live terms
  // stay exactly as they were and the checks explain what the change would have done.
  if (checks.some((check) => !check.ok)) {
    return { found: true, endpoint: toDto(stored, deps), checks };
  }

  const [updated] = await db
    .update(endpoints)
    .set({
      upstreamUrl: terms.upstreamUrl,
      priceAmount: terms.priceAmount,
      payoutMode: terms.payoutMode,
      routeId,
      description:
        input.description === undefined ? stored.description : (input.description ?? null),
      // A change that lands is a clean read of the terms, so the reasons a previous
      // creation stored are no longer true of this row.
      creationWarnings: [],
      // Liveness is not a side effect of an edit. A seller who paused an endpoint and
      // then fixed its price gets a live paywall only if they say so, and a seller who
      // repaired an endpoint that D4 left inactive has to open it on purpose. `active`
      // is in the input precisely so that turning the money on is the named change.
      active: input.active ?? stored.active,
    })
    .where(and(eq(endpoints.id, stored.id), eq(endpoints.sellerId, seller.id)))
    .returning();
  if (updated === undefined) {
    throw new Error("endpoint update matched no row");
  }

  return { found: true, endpoint: toDto(updated, deps), checks };
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
