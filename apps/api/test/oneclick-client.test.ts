import { describe, expect, it } from "vitest";

import type { Logger } from "../src/lib/logger.ts";
import {
  ONECLICK_MIN_CALL_GAP_MS,
  ONECLICK_STATUS_CALLS_PER_PASS,
  OneClickClient,
  OneClickError,
  type OneClickFetch,
  type OneClickRequest,
  type OneClickResponse,
  decodeSwapRef,
  encodeSwapRef,
} from "../src/payouts/oneclick/client.ts";
import type { PrepareRouteInput } from "../src/payouts/provider.ts";

/**
 * D3's offline half of the real client (PO-4): what it may say, what it must refuse to
 * say, and what it must refuse to do.
 *
 * Nothing here touches a socket or a clock. `fetchImpl` is injected and records every
 * request the client builds, and `sleep` is injected as a recorder, so the five-second
 * rule and the per-pass call budget are asserted as *numbers the client asked for*
 * rather than as a test that waits (hard rule: no test depends on wall-clock time).
 * `AbortSignal.timeout` still runs, but nothing awaits it, so a fast pass costs no delay.
 *
 * The fixtures come from the recorded contract — `/tmp/oa.yaml`, sha256 `9a2e6766…`, the
 * 200 body of `https://1click.chaindefuser.com/docs/v0/openapi.yaml` fetched 2026-11-10
 * and reproduced in `docs/spikes/S5.md` — with one caveat stated honestly: the spec gives
 * **no whole-body example** for `/v0/status` or `/v0/tokens`, only per-field `example:`
 * values. So these bodies are spec-shaped rather than copied: every field name, required
 * field and enum value follows the schema, and where the schema carries an example the
 * fixture uses it verbatim (the UUID `correlationId`, `amountIn` "1000000", `amountOut`
 * "9950000", `refundedAmount` "1000", the hash `0x123abc456def789`, the EVM deposit
 * address, the memo "1111111", `wNEAR`/`nep141:wrap.near`/24 decimals). Two spec
 * shortcuts are commented at their fixtures: `explorerUrl` has no example in the
 * contract, and `quoteResponse` — required by `GetExecutionStatusResponse` but unread by
 * Till, and a body that cannot be built without the undecided `originAsset` and
 * `depositType` (S2/B8) — is left out.
 *
 * Two of these blocks are about silence rather than answers. A swap the client cannot
 * read is *omitted* from the result, because `poll-payouts.ts` turns an absent ref into a
 * backoff (D10) while a guessed row would move money on a story nobody told; and every
 * refusal is also checked in the negative — a 500 produces no swap, a skipped ref carries
 * no state, a network failure restamps nothing. The one case that must NOT be silent is
 * the live-money boundary: `prepareRoute` refuses, and that refusal is asserted to have
 * made no request at all.
 */

const BASE_URL = "https://1click.test";
/** `Quote.depositAddress`'s own example. */
const DEPOSIT_ADDRESS = "0x76b4c56085ED136a8744D52bE956396624a730E8";
/** `Quote.depositMemo`'s own example. */
const DEPOSIT_MEMO = "1111111";
const REF = `${DEPOSIT_ADDRESS}:${DEPOSIT_MEMO}`;
/** A fake partner credential. It has one job: to be found in a log line if it ever is. */
const FAKE_JWT = "jwt-secret-never-log-me";

/**
 * Real JSON has no `undefined`, so a key carrying it means the provider did not send the
 * key at all. Without this, "status omitted" would test a value the wire cannot produce.
 */
function wireBody(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * `SwapDetails` as the contract shapes it: the four arrays it lists as required, the
 * amounts as base-unit integer strings, plus the `*Formatted` fields Till does not read
 * and must not lose.
 */
function swapDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return wireBody({
    intentHashes: ["0xintent-a"],
    nearTxHashes: ["0xnear-a"],
    originChainTxHashes: [
      { hash: "0x123abc456def789", explorerUrl: "https://etherscan.io/tx/0x123abc456def789" },
      { hash: "0xsecondorigin0000", explorerUrl: "https://etherscan.io/tx/0xsecondorigin0000" },
    ],
    destinationChainTxHashes: [
      { hash: "0xdeadbeefdest0001", explorerUrl: "https://solscan.io/tx/0xdeadbeefdest0001" },
    ],
    amountIn: "1000000",
    amountInFormatted: "1",
    amountOut: "9950000",
    amountOutFormatted: "9.95",
    ...overrides,
  });
}

/**
 * `GetExecutionStatusResponse` minus `quoteResponse`, which Till never reads and which
 * the client's schema therefore does not require — see the header.
 */
function statusBody(status: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const { details = {}, ...rest } = fields;
  return wireBody({
    correlationId: "550e8400-e29b-41d4-a716-446655440000",
    status,
    updatedAt: "2026-11-10T10:00:00.000Z",
    swapDetails: swapDetails(details as Record<string, unknown>),
    ...rest,
  });
}

function routeInput(overrides: Partial<PrepareRouteInput> = {}): PrepareRouteInput {
  return {
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: "seller.near",
    refundAddress: "seller-refund.near",
    amount: 1_000_000n,
    ...overrides,
  };
}

type Stub =
  | { readonly kind: "body"; readonly status: number; readonly body: unknown }
  | { readonly kind: "unreadable"; readonly status: number }
  | { readonly kind: "network"; readonly error: Error };

const httpOk = (body: unknown): Stub => ({ kind: "body", status: 200, body });
const httpRefusal = (status: number): Stub => ({ kind: "body", status, body: {} });
const brokenJson = (): Stub => ({ kind: "unreadable", status: 200 });
const networkDown = (message: string): Stub => ({ kind: "network", error: new Error(message) });

type Call = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signalLive: boolean;
};

type Entry = {
  readonly level: string;
  readonly code: string;
  readonly fields: Record<string, unknown>;
  readonly message: string;
};

type Harness = {
  readonly client: OneClickClient;
  readonly calls: Call[];
  /** Read on demand: the calls a pass has made by the time an assertion runs. */
  readonly urls: string[];
  readonly sleeps: number[];
  /** The order the client asked for calls and waits in, so the gap is placed, not counted. */
  readonly events: string[];
  /** More than one at a time would mean two status calls in flight on a rate-limited API. */
  readonly peakOverlap: () => number;
  readonly entries: Entry[];
  /** Every line the client could have leaked into, flattened for a substring search. */
  readonly logLines: string[];
};

type HarnessOptions = {
  readonly reply?: (url: URL) => Stub;
  readonly jwt?: string;
  readonly minCallGapMs?: number;
  readonly statusCallsPerPass?: number;
};

function harness(options: HarnessOptions = {}): Harness {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const events: string[] = [];
  const entries: Entry[] = [];
  let inFlight = 0;
  let peak = 0;

  const reply = options.reply ?? (() => httpOk(statusBody("SUCCESS")));

  const fetchImpl: OneClickFetch = async (
    url: string,
    init: OneClickRequest,
  ): Promise<OneClickResponse> => {
    const parsed = new URL(url);
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signalLive: init.signal instanceof AbortSignal && !init.signal.aborted,
    });
    events.push(`call:${parsed.pathname}`);
    const stub = reply(parsed);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    // The yield is what makes the overlap assertion mean something: a client that fired
    // its calls before awaiting them would be caught here instead of looking sequential.
    await Promise.resolve();
    inFlight -= 1;
    if (stub.kind === "network") {
      throw stub.error;
    }
    return {
      status: stub.status,
      json: async () => {
        if (stub.kind === "unreadable") {
          throw new SyntaxError("Unexpected end of JSON input");
        }
        return structuredClone(stub.body);
      },
    };
  };

  const push = (level: string) => (fields: Record<string, unknown>, message?: string) => {
    entries.push({ level, code: String(fields.code ?? ""), fields, message: message ?? "" });
  };
  const log: Logger = {
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => log,
  };

  const client = new OneClickClient({
    baseUrl: BASE_URL,
    ...(options.jwt === undefined ? {} : { jwt: options.jwt }),
    fetchImpl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      events.push(`sleep:${ms}`);
    },
    ...(options.minCallGapMs === undefined ? {} : { minCallGapMs: options.minCallGapMs }),
    ...(options.statusCallsPerPass === undefined
      ? {}
      : { statusCallsPerPass: options.statusCallsPerPass }),
    log,
  });

  return {
    client,
    calls,
    get urls() {
      return calls.map((call) => call.url);
    },
    sleeps,
    events,
    peakOverlap: () => peak,
    entries,
    logLines: entries.map((entry) => JSON.stringify(entry)),
  };
}

/** Route a pass's replies by the deposit address the client put in the query. */
function byAddress(map: Record<string, Stub>, fallback: Stub = httpOk(statusBody("SUCCESS"))) {
  return (url: URL): Stub => map[url.searchParams.get("depositAddress") ?? ""] ?? fallback;
}

function codes(h: Harness): string[] {
  return h.entries.map((entry) => entry.code);
}

function fieldsOf(h: Harness, code: string): Record<string, unknown> {
  const entry = h.entries.find((candidate) => candidate.code === code);
  if (entry === undefined) {
    throw new Error(`nothing was logged with code ${code}`);
  }
  return entry.fields;
}

/** `0x` + a 40-hex-character body, so a fake address is shaped like a real one. */
function addressWith(tail: string): string {
  return `0x${tail.padEnd(40, "0")}`;
}

describe("getStatus reads a recorded status into a swap report (D3, PO-4)", () => {
  it("makes one GET to the contract's own path and query", async () => {
    const h = harness();
    await h.client.getStatus({ providerRefs: [REF] });

    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call?.method).toBe("GET");
    const url = new URL(call?.url ?? "");
    expect(url.pathname).toBe("/v0/status");
    // The spec's two query parameters, both spelled the way `/v0/status` names them.
    expect(url.searchParams.get("depositAddress")).toBe(DEPOSIT_ADDRESS);
    expect(url.searchParams.get("depositMemo")).toBe(DEPOSIT_MEMO);
    // The client's own deadline is wired even offline; without it a hung provider would
    // sit inside the poller's row lock forever.
    expect(call?.signalLive).toBe(true);
  });

  it("parses state, money, hashes and the provider's own clock out of a SUCCESS", async () => {
    const h = harness();
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });
    if (swap === undefined) {
      throw new Error("a valid SUCCESS report must be answered");
    }

    expect(swap.providerRef).toBe(REF);
    expect(swap.state).toBe("succeeded");
    expect(swap.amountIn).toBe(1_000_000n);
    expect(swap.amountOut).toBe(9_950_000n);
    // Absent from the body, so absent from the report — not zero, which would book a
    // refund that never happened.
    expect(swap.refundedAmount).toBeNull();
    expect(swap.originTxHash).toBe("0x123abc456def789");
    expect(swap.destinationTxHash).toBe("0xdeadbeefdest0001");
    expect(swap.providerUpdatedAt?.toISOString()).toBe("2026-11-10T10:00:00.000Z");
  });

  it("keeps every amount a bigint, because money never travels as a number (hard rule 3)", async () => {
    const h = harness({
      reply: () =>
        httpOk(
          statusBody("REFUNDED", {
            details: { amountIn: "1000000", refundedAmount: "1000", amountOut: undefined },
          }),
        ),
    });
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });
    if (swap === undefined) {
      throw new Error("a valid REFUNDED report must be answered");
    }

    expect(swap.state).toBe("refunded");
    expect(swap.refundedAmount).toBe(1_000n);
    expect(swap.amountOut).toBeNull();
    for (const amount of [swap.amountIn, swap.amountOut, swap.refundedAmount]) {
      expect(amount === null || typeof amount === "bigint").toBe(true);
    }
  });

  it("takes the first hash of each array, which is the key reconciliation matches on (LR-2, hard rule 7)", async () => {
    // The fixture deliberately reports two origin hashes; a `slice` or a `pop` here would
    // write a hash that is not the deposit and unlink the payment it belongs to.
    const h = harness();
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });
    const raw = swap?.raw as { swapDetails: { originChainTxHashes: { hash: string }[] } };

    expect(swap?.originTxHash).toBe(raw.swapDetails.originChainTxHashes[0]?.hash);
    expect(raw.swapDetails.originChainTxHashes.length).toBe(2);
  });

  it("keeps the payload it was given in raw, including fields it does not read (S5)", async () => {
    // `swaps.raw` exists so a mapping bug stays diagnosable without another poll, which
    // only holds if the fields the client skips survive the parse: the two arrays the
    // contract requires but Till ignores, the `*Formatted` amounts, and a top-level field
    // neither the schema nor the contract mentions.
    const h = harness({
      reply: () => httpOk(statusBody("PROCESSING", { extraUnheardOf: "a field the spec adds" })),
    });
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });
    const raw = swap?.raw as Record<string, unknown>;
    const details = raw?.swapDetails as Record<string, unknown>;

    expect(raw.extraUnheardOf).toBe("a field the spec adds");
    expect(details.intentHashes).toEqual(["0xintent-a"]);
    expect(details.nearTxHashes).toEqual(["0xnear-a"]);
    expect(details.amountInFormatted).toBe("1");
  });

  it("answers with a raw payload that survives the jsonb write (D3)", async () => {
    // `poll-payouts.ts` stores `fields.raw` into `swaps.raw`, a jsonb column, so the
    // value is handed to JSON.stringify by the driver. It cannot serialize a bigint:
    // the parsed shape of this file's schema has every money field converted to one,
    // so persisting that would throw on the way to the database and a real, answered
    // status would never be written. The wire body keeps amounts as integer strings.
    const h = harness({
      reply: () => httpOk(statusBody("SUCCESS", { details: { amountIn: "1000000" } })),
    });
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });
    if (swap === undefined) {
      throw new Error("a valid SUCCESS report must be answered");
    }

    expect(() => JSON.stringify(swap.raw)).not.toThrow();
    // The amount is a bigint for Till and an integer string for the database, in the
    // same answer: the normalized field is what reconciliation sums, `raw` is evidence.
    expect(swap.amountIn).toBe(1_000_000n);
    const evidence = swap.raw as { swapDetails: { amountIn: unknown } };
    expect(evidence.swapDetails.amountIn).toBe("1000000");
  });

  it("reports no hash, and no guess, when the arrays are empty or missing (S5, hard rule 7)", async () => {
    // A confidential swap reports no hash for the swap itself, and every array is empty
    // until the money moves. A fabricated hash would be matched against a payment.
    const h = harness({
      reply: () =>
        httpOk(
          statusBody("PROCESSING", {
            details: { originChainTxHashes: [], destinationChainTxHashes: null },
          }),
        ),
    });
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });

    expect(swap?.originTxHash).toBeNull();
    expect(swap?.destinationTxHash).toBeNull();
  });

  it("answers for a status name it does not know, carrying it to the mapping", async () => {
    // The wire string stays a string in this file's schema on purpose: rejecting a new
    // status would drop the swap, and the mapping's job (map-status.ts) is to make it
    // `processing` so `PAYOUT_STUCK` ages it.
    const h = harness({ reply: () => httpOk(statusBody("DEPOSIT_SEEN_SOMETHING")) });
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });

    expect(swap?.state).toBe("processing");
    expect((swap?.raw as Record<string, unknown>).status).toBe("DEPOSIT_SEEN_SOMETHING");
  });

  it("leaves the provider's clock absent for a timestamp it cannot read", async () => {
    // Then the stuck window keeps using the poll stamp rather than a guess, which is
    // `NormalizedSwap.providerUpdatedAt`'s documented behaviour.
    const h = harness({
      reply: () => httpOk(statusBody("PROCESSING", { updatedAt: "yesterday" })),
    });
    const [swap] = await h.client.getStatus({ providerRefs: [REF] });

    expect(swap?.providerUpdatedAt).toBeNull();
    expect(swap?.state).toBe("processing");
  });

  it("asks about nothing at all for an empty batch", async () => {
    const h = harness();
    expect(await h.client.getStatus({ providerRefs: [] })).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.entries).toEqual([]);
  });
});

describe("the partner credential is a header and never a sentence (AGENTS.md secrets)", () => {
  it("sends `Authorization: Bearer <jwt>` when a jwt is configured", async () => {
    const h = harness({ jwt: FAKE_JWT });
    await h.client.getStatus({ providerRefs: [REF] });

    expect(h.calls[0]?.headers.authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(h.calls[0]?.headers.accept).toBe("application/json");
  });

  it("sends no authorization header when it is not, because keyless is a supported mode", async () => {
    const h = harness();
    await h.client.getStatus({ providerRefs: [REF] });

    // The negative half: an empty string or an inherited value would silently move every
    // keyless caller onto the partner fee tier, or fail with a 401 nobody can explain.
    expect(h.calls[0]?.headers.authorization).toBeUndefined();
    expect(Object.keys(h.calls[0]?.headers ?? {})).toEqual(["accept"]);
  });

  it("never writes the jwt into a log line or an error, however the call fails", async () => {
    const h = harness({
      jwt: FAKE_JWT,
      reply: byAddress({
        [addressWith("a1")]: httpRefusal(500),
        [addressWith("b2")]: brokenJson(),
        [addressWith("c3")]: httpOk(statusBody("PROCESSING", { status: undefined })),
      }),
    });
    await h.client.getStatus({
      providerRefs: [
        `${addressWith("a1")}:1`,
        `${addressWith("b2")}:2`,
        `${addressWith("c3")}:3`,
        "not-a-swap-ref:xyz",
      ],
    });

    // Every failure path the client has logs something, and one of them logs the ref the
    // caller supplied, so this is where a credential would turn up if it were going to.
    expect(codes(h)).toEqual([
      "oneclick_http_status",
      "oneclick_body_unreadable",
      "oneclick_status_unparseable",
      "oneclick_ref_unreadable",
    ]);
    for (const line of h.logLines) {
      expect(line.includes(FAKE_JWT)).toBe(false);
      expect(line.toLowerCase().includes("bearer")).toBe(false);
    }
  });

  it("keeps the credential out of a network error's message, even when it is in the URL", async () => {
    // Some operators put the partner token in the base URL's userinfo. The client's error
    // names the pathname only — `new URL(url).pathname` drops userinfo and query — so
    // neither the bearer token nor the URL credential can reach a log through it.
    const client = new OneClickClient({
      baseUrl: `https://partner:${FAKE_JWT}@1click.test`,
      jwt: FAKE_JWT,
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND 1click.test");
      },
      sleep: async () => undefined,
    });

    const error = await client
      .getStatus({ providerRefs: [REF] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OneClickError);
    const described = `${String(error)}|${JSON.stringify(error)}|${(error as Error).stack ?? ""}`;
    expect(described.includes(FAKE_JWT)).toBe(false);
    expect(described.includes("Bearer")).toBe(false);
    expect(described).toContain("1Click network on /v0/status");
  });
});

describe("one pass respects the provider's five-second gap and its own budget (S5, consequence 5)", () => {
  const refs = [`${addressWith("aa")}:1`, `${addressWith("bb")}:2`, `${addressWith("cc")}:3`];

  it("waits exactly the gap once between calls and never before the first", async () => {
    const h = harness({ minCallGapMs: 5_000 });
    await h.client.getStatus({ providerRefs: refs });

    // Three calls, so two gaps: the budget is per call, the wait is between them.
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([5_000, 5_000]);
    expect(h.events).toEqual([
      "call:/v0/status",
      "sleep:5000",
      "call:/v0/status",
      "sleep:5000",
      "call:/v0/status",
    ]);
    expect(h.peakOverlap()).toBe(1);
    expect(h.urls.map((url) => new URL(url).searchParams.get("depositAddress"))).toEqual([
      addressWith("aa"),
      addressWith("bb"),
      addressWith("cc"),
    ]);
  });

  it("defaults the gap to the number the provider publishes", async () => {
    const h = harness();
    await h.client.getStatus({ providerRefs: refs });

    expect(ONECLICK_MIN_CALL_GAP_MS).toBe(5_000);
    expect(h.sleeps).toEqual([5_000, 5_000]);
  });

  it("waits for none of them when the gap is configured away", async () => {
    const h = harness({ minCallGapMs: 0 });
    await h.client.getStatus({ providerRefs: refs });

    expect(h.sleeps).toEqual([]);
    expect(h.calls).toHaveLength(3);
  });

  it("answers one ref without waiting at all", async () => {
    // The n-1 rule in the negative: a single-call pass that slept first would add five
    // seconds to the poller's row lock for no reason.
    const h = harness({ minCallGapMs: 5_000 });
    await h.client.getStatus({ providerRefs: [refs[0] ?? REF] });

    expect(h.sleeps).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it("asks about the first refs only when the budget is spent, and says so", async () => {
    const h = harness({ statusCallsPerPass: 1 });
    const answers = await h.client.getStatus({ providerRefs: refs });

    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.providerRef).toBe(refs[0]);
    // The refs over the budget are absent, not answered. A row for them with a default
    // state would tell the poller the provider had spoken (D10).
    expect(answers.map((answer) => answer.providerRef)).not.toContain(refs[1]);
    expect(answers.map((answer) => answer.providerRef)).not.toContain(refs[2]);
    expect(codes(h)).toEqual(["oneclick_call_budget"]);
    expect(fieldsOf(h, "oneclick_call_budget")).toMatchObject({ asked: 3, called: 1, skipped: 2 });
  });

  it("publishes the budget it actually enforces, for the poller's claim", () => {
    expect(harness().client.statusCallsPerPass).toBe(ONECLICK_STATUS_CALLS_PER_PASS);
    expect(
      new OneClickClient({ baseUrl: BASE_URL, statusCallsPerPass: 2 }).statusCallsPerPass,
    ).toBe(2);
  });
});

describe("a call the provider refuses is omitted, never guessed (D3, D10)", () => {
  const OTHER = addressWith("dd");

  it("leaves a swap alone on a 5xx and still answers its neighbours", async () => {
    const h = harness({ reply: byAddress({ [DEPOSIT_ADDRESS]: httpRefusal(500) }) });
    const answers = await h.client.getStatus({ providerRefs: [REF, `${OTHER}:7`] });

    expect(answers.map((answer) => answer.providerRef)).toEqual([`${OTHER}:7`]);
    expect(codes(h)).toEqual(["oneclick_http_status"]);
    expect(fieldsOf(h, "oneclick_http_status")).toMatchObject({ path: "/v0/status", status: 500 });
    // The negative the poller depends on: no row means no state, so no ledger line.
    expect(answers.some((answer) => answer.providerRef === REF)).toBe(false);
  });

  it("treats the contract's own 404 the same way, because a 404 is not a state either", async () => {
    // `GetExecutionStatusResponse` documents 404 as "Deposit address not found" — true of
    // a quote that aged out — and the honest reading is "no answer", not `failed`.
    const h = harness({ reply: byAddress({ [DEPOSIT_ADDRESS]: httpRefusal(404) }) });
    expect(await h.client.getStatus({ providerRefs: [REF] })).toEqual([]);
    expect(codes(h)).toEqual(["oneclick_http_status"]);
  });

  it("omits a body that is missing the status the whole response is about", async () => {
    const h = harness({ reply: () => httpOk(statusBody("SUCCESS", { status: undefined })) });
    const answers = await h.client.getStatus({ providerRefs: [REF] });

    expect(answers).toEqual([]);
    expect(codes(h)).toEqual(["oneclick_status_unparseable"]);
    expect(fieldsOf(h, "oneclick_status_unparseable")).toMatchObject({ providerRef: REF });
  });

  it("omits a decimal amount, which the contract forbids and the ledger cannot hold", async () => {
    // `SwapDetails.amountOut` says "Must be an integer string; decimal values like 0.01
    // are invalid". Reading "12.5" as 12 or 13 would book money that is not there either
    // way (hard rule 3), so the answer is refused.
    const h = harness({
      reply: () => httpOk(statusBody("SUCCESS", { details: { amountOut: "12.5" } })),
    });

    expect(await h.client.getStatus({ providerRefs: [REF] })).toEqual([]);
    expect(codes(h)).toEqual(["oneclick_status_unparseable"]);
    expect(fieldsOf(h, "oneclick_status_unparseable").issues).toContain("swapDetails.amountOut");
  });

  it("omits a 200 that carries no readable JSON body", async () => {
    const h = harness({ reply: brokenJson });
    expect(await h.client.getStatus({ providerRefs: [REF] })).toEqual([]);
    expect(codes(h)).toEqual(["oneclick_body_unreadable"]);
  });

  it("omits a reference it cannot decode and asks about the rest", async () => {
    // A ref Till wrote should always decode, so arriving here means a hand-edited row or
    // a provider that changed its address shape. Guessing which half is a colon would
    // write one swap's status onto another's money.
    const h = harness();
    const answers = await h.client.getStatus({ providerRefs: ["near:acct:extra:123", REF] });

    expect(answers.map((answer) => answer.providerRef)).toEqual([REF]);
    expect(codes(h)).toEqual(["oneclick_ref_unreadable"]);
    expect(fieldsOf(h, "oneclick_ref_unreadable").providerRef).toBe("near:acct:extra:123");
    expect(h.calls).toHaveLength(1);
  });

  it("throws when the provider cannot be reached at all, and restsamps nothing", async () => {
    // The one case that is NOT an omission: DNS/TLS/timeout means the whole provider is
    // down, and answering "no comment" per swap would let the poller restamp every row as
    // if it had been read. `poll-payouts.ts` logs this as `poll_provider_failed` and backs
    // off (D10).
    const h = harness({ reply: () => networkDown("socket hang up") });
    const error = await h.client
      .getStatus({ providerRefs: [REF] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OneClickError);
    const detail = (error as OneClickError).detail;
    expect(detail.reason).toBe("network");
    expect(detail.path).toBe("/v0/status");
    expect(String(error)).toContain("1Click network on /v0/status");
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
    expect(h.entries).toEqual([]);
  });

  it("keeps a refused swap out of the answers while still spacing the retry of its neighbour", async () => {
    const h = harness({
      minCallGapMs: 5_000,
      reply: byAddress({ [DEPOSIT_ADDRESS]: httpRefusal(500) }),
    });
    const answers = await h.client.getStatus({ providerRefs: [REF, `${OTHER}:7`] });

    expect(answers).toHaveLength(1);
    // The gap is between calls whether or not the first call was useful, because the rate
    // limit counts requests, not answers.
    expect(h.sleeps).toEqual([5_000]);
    expect(h.peakOverlap()).toBe(1);
  });
});

describe("prepareRoute refuses, because that throw is the money boundary (D3, S2/B8)", () => {
  const cases: readonly [string, PrepareRouteInput][] = [
    ["a per-payment quote", routeInput()],
    ["a standing route, which needs no amount", routeInput({ amount: null })],
    ["another chain and asset", routeInput({ destinationChain: "sol", destinationAsset: "usdt" })],
    [
      "every field the interface allows",
      routeInput({ destinationAddress: "buyer.near", refundAddress: "r.near" }),
    ],
  ];

  it.each(cases)("refuses %s rather than minting a deposit address", async (_label, input) => {
    const h = harness();
    const error = await h.client.prepareRoute(input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OneClickError);
    expect((error as OneClickError).detail.reason).toBe("config");
    // The message has to name the undecided inputs, since a caller that reads only
    // "not implemented" would conclude the work is unfinished rather than unasked.
    expect(String(error)).toContain("originAsset");
    expect(String(error)).toContain("depositType");
    expect(String(error)).toContain("slippageTolerance");
    expect(String(error)).toContain("S2/B8");
    // The live-money check: a quote on this provider mints a real address on a network
    // with no testnet (Q-007), so the refusal must not reach the wire at all.
    expect(h.calls).toEqual([]);
    expect(h.sleeps).toEqual([]);
  });
});

describe("the swap reference is Till's encoding and it round-trips (D3)", () => {
  it("carries a memo and reads both halves back", () => {
    const ref = encodeSwapRef(DEPOSIT_ADDRESS, DEPOSIT_MEMO);
    expect(ref).toBe(`${DEPOSIT_ADDRESS}:${DEPOSIT_MEMO}`);
    expect(decodeSwapRef(ref)).toEqual({
      depositAddress: DEPOSIT_ADDRESS,
      depositMemo: DEPOSIT_MEMO,
    });
  });

  it("leaves the memo off entirely when the quote had none", () => {
    for (const memo of [null, ""]) {
      const ref = encodeSwapRef(DEPOSIT_ADDRESS, memo);
      expect(ref).toBe(DEPOSIT_ADDRESS);
      expect(decodeSwapRef(ref)).toEqual({ depositAddress: DEPOSIT_ADDRESS, depositMemo: null });
    }
  });

  it("keeps a memo's leading zeros, because the provider matches on the string", () => {
    expect(decodeSwapRef(encodeSwapRef(DEPOSIT_ADDRESS, "007"))).toEqual({
      depositAddress: DEPOSIT_ADDRESS,
      depositMemo: "007",
    });
  });

  it("refuses to encode an address containing a colon, rather than shipping a two-split ref", () => {
    // A NEAR account id cannot be a deposit address here: the memo is the last
    // colon-separated group, so an embedded colon would decode into the wrong swap.
    expect(() => encodeSwapRef("seller.near:intents", null)).toThrow(OneClickError);
    try {
      encodeSwapRef("seller.near:intents", null);
    } catch (error) {
      expect((error as OneClickError).detail.reason).toBe("config");
      expect(String(error)).toContain("':'");
    }
    // The negative, so the guard is about the colon and not about the address: the same
    // account id without one is fine.
    expect(encodeSwapRef("seller.near", null)).toBe("seller.near");
  });

  it("refuses to encode a non-numeric memo", () => {
    expect(() => encodeSwapRef(DEPOSIT_ADDRESS, "abc")).toThrow(/non-numeric/);
    expect(() => encodeSwapRef(DEPOSIT_ADDRESS, "12a")).toThrow(/non-numeric/);
    expect(() => encodeSwapRef(DEPOSIT_ADDRESS, "12.5")).toThrow(/non-numeric/);
    // Numeric is allowed, and that is the whole rule the spec's example shows.
    expect(encodeSwapRef(DEPOSIT_ADDRESS, "42")).toBe(`${DEPOSIT_ADDRESS}:42`);
  });

  it("refuses to decode a reference whose last group is not a memo", () => {
    expect(() => decodeSwapRef(`${DEPOSIT_ADDRESS}:abc`)).toThrow(/not a 1Click deposit address/);
    expect(() => decodeSwapRef("a:b:123")).toThrow(/not a 1Click deposit address/);
    expect(() => decodeSwapRef(":123")).toThrow(/not a 1Click deposit address/);
    // An address with no colon at all is the standing case, not a failure.
    expect(decodeSwapRef(DEPOSIT_ADDRESS).depositMemo).toBeNull();
  });

  it("answers the memo-bearing and the memoless ref with the right query", async () => {
    const h = harness();
    await h.client.getStatus({ providerRefs: [DEPOSIT_ADDRESS, REF] });

    const first = new URL(h.calls[0]?.url ?? "");
    const second = new URL(h.calls[1]?.url ?? "");
    expect(first.searchParams.get("depositMemo")).toBeNull();
    expect(second.searchParams.get("depositMemo")).toBe(DEPOSIT_MEMO);
    expect(second.searchParams.get("depositAddress")).toBe(DEPOSIT_ADDRESS);
  });
});

describe("listAssets passes the provider's own catalogue through (D3, hard rule 9)", () => {
  // `TokenResponse`'s required fields, with the contract's example values. The spec also
  // requires `price` and `priceUpdatedAt`, which Till does not read and the client's
  // schema does not demand; they are included so the fixture stays a real 200 body.
  const TOKENS = [
    {
      assetId: "nep141:wrap.near",
      decimals: 24,
      blockchain: "near",
      symbol: "wNEAR",
      price: 2.79,
      priceUpdatedAt: "2025-03-28T12:23:00.070Z",
    },
    {
      assetId: "nep141:usbtc-131-fg68-ckvl",
      decimals: 6,
      blockchain: "eth",
      symbol: "USDC",
      price: 1,
      priceUpdatedAt: "2025-03-28T12:23:00.070Z",
    },
  ];

  it("maps the four fields Till keeps, under the names the interface uses", async () => {
    const h = harness({ reply: () => httpOk(TOKENS) });
    const assets = await h.client.listAssets();

    expect(h.calls).toHaveLength(1);
    const url = new URL(h.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v0/tokens");
    expect(url.search).toBe("");
    expect(assets).toEqual([
      { chain: "near", asset: "nep141:wrap.near", symbol: "wNEAR", decimals: 24 },
      { chain: "eth", asset: "nep141:usbtc-131-fg68-ckvl", symbol: "USDC", decimals: 6 },
    ]);
  });

  it("does not filter to 6 decimals here, because that rule belongs to endpoint creation", async () => {
    // Hard rule 9 is enforced when a route is saved, so a list that quietly dropped the
    // 24-decimal entries would leave the seller unable to see what the provider supports.
    const h = harness({ reply: () => httpOk(TOKENS) });
    const assets = await h.client.listAssets();

    expect(assets.map((asset) => asset.decimals)).toEqual([24, 6]);
    expect(assets.some((asset) => asset.decimals !== 6)).toBe(true);
  });

  it("throws when the body is not the array the contract declares", async () => {
    const h = harness({ reply: () => httpOk({ tokens: TOKENS }) });
    const error = await h.client.listAssets().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OneClickError);
    expect((error as OneClickError).detail.reason).toBe("body");
    expect((error as OneClickError).detail.path).toBe("/v0/tokens");
  });

  it("throws on an entry with no asset id, rather than listing an asset nobody can pay in", async () => {
    const missing = [
      {
        decimals: 6,
        blockchain: "near",
        symbol: "???",
        price: 1,
        priceUpdatedAt: "2025-03-28T12:23:00.070Z",
      },
    ];
    const h = harness({ reply: () => httpOk(missing) });
    const error = await h.client.listAssets().catch((caught: unknown) => caught);

    expect((error as OneClickError).detail.reason).toBe("body");
    expect(String(error)).toContain("/v0/tokens");
    // The negative: an empty catalogue is a well-formed array, so it is not an error and
    // must not be reported as one.
    const empty = harness({ reply: () => httpOk([]) });
    expect(await empty.client.listAssets()).toEqual([]);
  });

  it("throws rather than returning an empty list when the call is refused", async () => {
    // `getStatus` can omit a swap; an asset list has nothing to omit, and answering "no
    // assets" to a 500 would look like a provider that supports nothing.
    const h = harness({ reply: () => httpRefusal(503) });
    const error = await h.client.listAssets().catch((caught: unknown) => caught);

    expect((error as OneClickError).detail.reason).toBe("http");
    expect(h.entries.map((entry) => entry.code)).toEqual(["oneclick_http_status"]);
  });
});
