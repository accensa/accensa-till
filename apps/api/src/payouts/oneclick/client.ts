import { z } from "zod";

import type { BaseUnitAmount } from "@till/core";

import type { Logger } from "../../lib/logger.ts";
import type {
  NormalizedSwap,
  PayoutProvider,
  PrepareRouteInput,
  PreparedRoute,
  StatusInput,
  SupportedAsset,
} from "../provider.ts";
import { mapOneClickStatus } from "./map-status.ts";

/**
 * The only code that calls the 1Click API (hard rule 5, D3).
 *
 * What this file is allowed to know is the recorded contract and nothing else: every
 * path, field name, required list and enum below comes from the OpenAPI spec fetched
 * from `https://1click.chaindefuser.com/docs/v0/openapi.yaml` on 2026-11-10 (the
 * `200` body, sha256 `9a2e6766...`), reproduced in `docs/spikes/S5.md` and summarised
 * in `docs/ARCHITECTURE.md` section 5. Nothing here was inferred from a real swap,
 * because none has been made: no quote has been posted, no deposit address has ever
 * been minted, and there is no testnet (Q-007).
 *
 * The half that is NOT implemented is `prepareRoute`, and that is a missing input
 * rather than unfinished code — see the throw for the reason and the task that owns
 * it. `getStatus` and `listAssets` are complete and tested offline against recorded
 * fixtures, which is what lets the live half be a switch of configuration rather than
 * a rewrite.
 */

export const ONECLICK_TIMEOUT_MS = 10_000;

/**
 * The one number the provider publishes for a partner ID ("1 request every 5 seconds")
 * — from the Explorer API page, not the swap API, so it is a floor to respect rather
 * than a confirmed limit for `/v0/status` (S5, consequence 5 and open question 3).
 */
export const ONECLICK_MIN_CALL_GAP_MS = 5_000;

/**
 * Status calls one `getStatus` pass may make. `/v0/status` takes one deposit address,
 * so a provider call per swap is the shape of the API and the pass budget is the only
 * place a burst can be bounded. `jobs/poll-payouts.ts` holds row locks for the whole
 * call, which makes the product `statusCallsPerPass x minCallGapMs` the pass's worst
 * case; four calls behind a five-second gap is one pass of a 20-second interval.
 */
export const ONECLICK_STATUS_CALLS_PER_PASS = 4;

/** Paths under the base URL, verbatim from the spec's `paths` keys. */
const QUOTE_PATH = "/v0/quote";
const STATUS_PATH = "/v0/status";
const TOKENS_PATH = "/v0/tokens";

/**
 * A base-unit integer string as the spec describes it ("Must be an integer string;
 * decimal values like `0.01` are invalid"). Signed, because A19 keeps whatever the
 * provider reported and lets reconciliation raise the discrepancy rather than
 * rounding or refusing a number at the boundary.
 */
const BASE_UNITS = /^-?\d+$/;

const amountSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value))
  .refine((value) => BASE_UNITS.test(value), "not an integer of base units");

/** Optional money field: absent, null or "" all mean "not reported yet". */
const optionalAmount = z
  .union([amountSchema, z.null(), z.undefined()])
  .optional()
  .transform((value) => (value === undefined || value === null ? null : BigInt(value)));

/** A hash, or nothing. An empty string from a JSON field is "not reported". */
const optionalText = z
  .union([z.string(), z.null(), z.undefined()])
  .optional()
  .transform((value) => (typeof value === "string" && value.trim() !== "" ? value : null));

/** `TransactionDetails`: `hash` and `explorerUrl` are both required by the spec. */
const transactionDetailsSchema = z
  .object({
    hash: z.string(),
    explorerUrl: z.string(),
  })
  .passthrough();

/**
 * `SwapDetails`, the fields Till reads. The spec requires the two hash arrays and
 * `intentHashes`/`nearTxHashes`, but the recorded caveat is that a confidential swap
 * reports no hash for the swap itself, so the reads below are all optional and a
 * missing hash is stored as "not reported", never as a guess (hard rule 7).
 */
const swapDetailsSchema = z
  .object({
    amountIn: optionalAmount,
    amountOut: optionalAmount,
    refundedAmount: optionalAmount,
    originChainTxHashes: z.array(transactionDetailsSchema).nullish(),
    destinationChainTxHashes: z.array(transactionDetailsSchema).nullish(),
  })
  .passthrough();

/**
 * `GetExecutionStatusResponse`. `status` stays the raw wire string here: mapping it
 * is `map-status.ts`'s job, and a value outside the seven is a thing this file must
 * be able to carry to that mapping rather than reject.
 */
const statusResponseSchema = z
  .object({
    correlationId: z.string(),
    status: z.string(),
    updatedAt: z.string(),
    swapDetails: swapDetailsSchema,
  })
  .passthrough();

/** `TokenResponse`'s required fields (the spec also requires price/priceUpdatedAt). */
const tokenResponseSchema = z
  .object({
    assetId: z.string(),
    decimals: z.number(),
    blockchain: z.string(),
    symbol: z.string(),
  })
  .passthrough();

export type OneClickRequest = {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
};

export type OneClickResponse = {
  readonly status: number;
  json(): Promise<unknown>;
};

/** Injectable so the tests are offline and deterministic (no network, no timers). */
export type OneClickFetch = (url: string, init: OneClickRequest) => Promise<OneClickResponse>;

export type OneClickClientOptions = {
  readonly baseUrl: string;
  /** Sent as `Authorization: Bearer <jwt>`, the spec's `JWT-auth` scheme. Optional: the API serves keyless callers at a higher fee. */
  readonly jwt?: string | undefined;
  readonly fetchImpl?: OneClickFetch;
  readonly timeoutMs?: number;
  readonly minCallGapMs?: number;
  readonly statusCallsPerPass?: number;
  /** Waits between the calls of one pass. Tests inject a recorder instead of sleeping. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: Logger;
};

/**
 * A provider call that could not be completed. The message names the path and the
 * status and never the credential, because an error message is a log line and
 * `ONECLICK_JWT` must not reach one (AGENTS.md "Money and secrets safety").
 */
export class OneClickError extends Error {
  constructor(
    readonly detail: {
      readonly path: string;
      readonly status?: number;
      readonly reason: "network" | "http" | "body" | "config";
      readonly message: string;
    },
  ) {
    super(
      `1Click ${detail.reason} on ${detail.path}${detail.status === undefined ? "" : ` (${detail.status})`}: ${detail.message}`,
    );
    this.name = "OneClickError";
  }
}

/**
 * `swaps.provider_ref` for one swap.
 *
 * `/v0/status` identifies a swap by the quote's `depositAddress`, plus the
 * `depositMemo` when the quote returned one, and `StatusInput` carries one string per
 * swap, so both halves travel inside the ref. That encoding is Till's, not the
 * provider's, and it is deliberately narrow: the memo is the last colon-separated
 * group and only when it is all digits (the spec's example is `1111111`), and an
 * address may not contain a colon at all. Anything else throws rather than decoding
 * into the wrong swap — a mis-parsed ref is a status written onto somebody else's
 * money.
 */
export function encodeSwapRef(depositAddress: string, depositMemo: string | null): string {
  if (depositAddress.includes(":")) {
    throw new OneClickError({
      path: STATUS_PATH,
      reason: "config",
      message: "a deposit address containing ':' cannot be used as a swap reference",
    });
  }
  if (depositMemo === null || depositMemo === "") {
    return depositAddress;
  }
  if (!/^\d+$/.test(depositMemo)) {
    throw new OneClickError({
      path: STATUS_PATH,
      reason: "config",
      message: "a non-numeric deposit memo cannot be encoded into a swap reference",
    });
  }
  return `${depositAddress}:${depositMemo}`;
}

export function decodeSwapRef(ref: string): { depositAddress: string; depositMemo: string | null } {
  const split = ref.lastIndexOf(":");
  if (split === -1) {
    return { depositAddress: ref, depositMemo: null };
  }
  const memo = ref.slice(split + 1);
  const address = ref.slice(0, split);
  if (!/^\d+$/.test(memo) || address.includes(":") || address === "") {
    throw new OneClickError({
      path: STATUS_PATH,
      reason: "body",
      message: `swap reference ${ref} is not a 1Click deposit address this client can read`,
    });
  }
  return { depositAddress: address, depositMemo: memo };
}

/** First hash of an array the spec allows to be empty until the money moves. */
function firstHash(entries: readonly { hash: string }[] | null | undefined): string | null {
  const first = entries?.[0]?.hash;
  return typeof first === "string" && first.trim() !== "" ? first : null;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OneClickClient implements PayoutProvider {
  readonly #base: URL;
  readonly #jwt: string | undefined;
  readonly #fetch: OneClickFetch;
  readonly #timeoutMs: number;
  readonly #minCallGapMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: Logger | undefined;

  /**
   * What one pass may ask about, published so the wiring can bound the claim instead
   * of letting the poller claim refs this client would then have to refuse to ask
   * about. Reads it as `min(batchSize, statusCallsPerPass)`.
   */
  readonly statusCallsPerPass: number;

  constructor(options: OneClickClientOptions) {
    this.#base = new URL(options.baseUrl);
    this.#jwt = options.jwt;
    this.#fetch =
      options.fetchImpl ??
      ((url, init) =>
        fetch(url, init).then((response) => ({
          status: response.status,
          json: () => response.json() as Promise<unknown>,
        })));
    this.#timeoutMs = options.timeoutMs ?? ONECLICK_TIMEOUT_MS;
    this.#minCallGapMs = options.minCallGapMs ?? ONECLICK_MIN_CALL_GAP_MS;
    this.statusCallsPerPass = options.statusCallsPerPass ?? ONECLICK_STATUS_CALLS_PER_PASS;
    this.#sleep = options.sleep ?? realSleep;
    this.#log = options.log;
  }

  /**
   * Not implemented, and the reason is a missing input rather than missing code.
   *
   * `QuoteRequest` requires twelve fields, three of which Till does not currently
   * decide anywhere: `originAsset` (which stablecoin contract the deposit arrives in —
   * the endpoint knows it, `PrepareRouteInput` does not carry it), `depositType`
   * (`ORIGIN_CHAIN` versus an `INTENTS` account id, which is precisely the standing-
   * address question S2 and B8 were scoped to and have not answered), and
   * `slippageTolerance`, which is a number nobody has set for Till.
   *
   * Inventing those three would post a real quote against a real deposit address on a
   * provider with no testnet, and the payment path would then advertise an address
   * nobody chose. So the route stays refused: `PAYOUT_PROVIDER=oneclick` can poll and
   * read assets, cannot mint a destination, and says so. This throw is the live-money
   * boundary, and it is the line AGENTS.md means by "never send a mainnet transaction
   * unless the human asked for that specific action".
   */
  async prepareRoute(_input: PrepareRouteInput): Promise<PreparedRoute> {
    throw new OneClickError({
      path: QUOTE_PATH,
      reason: "config",
      message:
        "Till has never posted a 1Click quote: originAsset, depositType and slippageTolerance are undecided (S2/B8), so no deposit address may be minted (D3)",
    });
  }

  /**
   * One `GET /v0/status` per reference, spaced by `minCallGapMs`.
   *
   * A reference this client cannot answer is left out of the result rather than
   * reported with a guessed state, which is the rule `poll-payouts.ts` already handles
   * (D10: an unanswered ref backs off, and a silent provider never becomes a stalled
   * swap). That covers a non-2xx for one swap, a body that does not match the
   * contract, and a ref beyond this pass's call budget.
   *
   * A call that cannot be made at all (DNS, TLS, timeout) throws instead: the whole
   * provider is unreachable, which is the provider-outage path the poller logs as
   * `poll_provider_failed`, and pretending otherwise would restamp every row as
   * answered.
   */
  async getStatus(input: StatusInput): Promise<readonly NormalizedSwap[]> {
    const asked = input.providerRefs;
    const budget = Math.min(asked.length, this.statusCallsPerPass);
    if (asked.length > budget) {
      this.#log?.warn(
        {
          code: "oneclick_call_budget",
          asked: asked.length,
          called: budget,
          skipped: asked.length - budget,
        },
        "1Click status call budget reached, the remaining swaps were not asked about",
      );
    }

    const answers: NormalizedSwap[] = [];
    for (const [index, ref] of asked.slice(0, budget).entries()) {
      if (index > 0 && this.#minCallGapMs > 0) {
        await this.#sleep(this.#minCallGapMs);
      }
      const decoded = this.#decode(ref);
      if (decoded === null) {
        continue;
      }
      const body = await this.#get(STATUS_PATH, decoded);
      if (body === null) {
        continue;
      }
      const parsed = statusResponseSchema.safeParse(body);
      if (!parsed.success) {
        this.#log?.error(
          {
            code: "oneclick_status_unparseable",
            providerRef: ref,
            issues: parsed.error.issues.map((issue) => issue.path.join(".")),
          },
          "1Click status response does not match the recorded contract, swap left as it was",
        );
        continue;
      }
      answers.push(this.#normalize(ref, parsed.data, body));
    }
    return answers;
  }

  /**
   * `GET /v0/tokens`. Every field is passed through as the provider names it, and the
   * 6-decimal rule (hard rule 9) is left to the caller that enforces it at endpoint
   * creation, so this list is the provider's answer rather than Till's filter.
   */
  async listAssets(): Promise<readonly SupportedAsset[]> {
    const body = await this.#get(TOKENS_PATH, new URLSearchParams());
    if (body === null) {
      throw new OneClickError({
        path: TOKENS_PATH,
        reason: "http",
        message: "the token list could not be read",
      });
    }
    const parsed = z.array(tokenResponseSchema).safeParse(body);
    if (!parsed.success) {
      throw new OneClickError({
        path: TOKENS_PATH,
        reason: "body",
        message: `token list does not match the recorded contract (${parsed.error.issues[0]?.message ?? "unknown"})`,
      });
    }
    return parsed.data.map((token) => ({
      chain: token.blockchain,
      asset: token.assetId,
      symbol: token.symbol,
      decimals: token.decimals,
    }));
  }

  #decode(ref: string): URLSearchParams | null {
    let decoded: { depositAddress: string; depositMemo: string | null };
    try {
      decoded = decodeSwapRef(ref);
    } catch (error) {
      this.#log?.error(
        { code: "oneclick_ref_unreadable", providerRef: ref, error: errorMessage(error) },
        "swap reference is not a 1Click deposit address, the swap was not asked about",
      );
      return null;
    }
    const search = new URLSearchParams({ depositAddress: decoded.depositAddress });
    if (decoded.depositMemo !== null) {
      search.set("depositMemo", decoded.depositMemo);
    }
    return search;
  }

  async #get(path: string, search: URLSearchParams): Promise<unknown | null> {
    const url = new URL(`${path}?${search.toString()}`, this.#base).toString();
    return this.#request("GET", url);
  }

  async #request(method: "GET" | "POST", url: string, body?: string): Promise<unknown | null> {
    const path = new URL(url).pathname;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#jwt !== undefined) {
      headers.authorization = `Bearer ${this.#jwt}`;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: OneClickResponse;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new OneClickError({
        path,
        reason: "network",
        message: errorMessage(error),
      });
    }

    if (response.status < 200 || response.status >= 300) {
      this.#log?.warn(
        { code: "oneclick_http_status", path, status: response.status },
        "1Click refused a call, the swap was left exactly as it was",
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      this.#log?.error(
        { code: "oneclick_body_unreadable", path, error: errorMessage(error) },
        "1Click answered without a JSON body",
      );
      return null;
    }
    return parsed;
  }

  #normalize(
    ref: string,
    body: z.infer<typeof statusResponseSchema>,
    payload: unknown,
  ): NormalizedSwap {
    const details = body.swapDetails;
    return {
      providerRef: ref,
      state: mapOneClickStatus(body.status),
      amountIn: details.amountIn,
      amountOut: details.amountOut,
      refundedAmount: details.refundedAmount,
      originTxHash: firstHash(details.originChainTxHashes),
      destinationTxHash: firstHash(details.destinationChainTxHashes),
      // S5, consequence 2: `updatedAt` is "last time the state was updated", which is
      // time-in-state. `last_polled_at` is our own last answer and resets every pass,
      // so a swap polled forever would never age against it. Persisted, and read by
      // `payout-stuck.ts` in preference to the poll stamp.
      providerUpdatedAt: parseTime(body.updatedAt),
      // The provider payload, unchanged, into `swaps.raw`, so a mapping bug stays
      // diagnosable without another poll. That is the bytes as they arrived rather
      // than the parsed shape on purpose: every money field in `parsed.data` is a
      // `bigint` after `amountSchema`, and `swaps.raw` is a jsonb column, so
      // serializing the parsed shape throws "Do not know how to serialize a BigInt"
      // and the answer would never be persisted at all.
      raw: payload,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseTime(value: string): Date | null {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}
