import {
  discrepancyDtoSchema,
  endpointCreateRequestSchema,
  endpointUpdateRequestSchema,
  overviewResponseSchema,
  payerBlockDtoSchema,
  paymentDtoSchema,
} from "@till/core/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api-client.ts";

/**
 * F4's four reads (UI-4): the worklist, a close, the held payers, a clear.
 */
const DISCREPANCY = discrepancyDtoSchema.parse({
  id: "01a1abe0-1111-7000-8000-000000000001",
  sellerId: "01a1abe0-2222-7000-8000-000000000002",
  code: "SERVED_NOT_SETTLED",
  severity: "critical",
  paymentId: "01a1abe0-3333-7000-8000-000000000003",
  swapId: null,
  dedupeKey: "SERVED_NOT_SETTLED:01a1abe0-3333-7000-8000-000000000003:none",
  explanation: "A payer was served and the money never settled.",
  suggestedAction: "Check the payment and refund or re-serve.",
  openedAt: "2026-11-05T10:00:00.000Z",
  resolvedAt: null,
  resolution: null,
});

const HELD = payerBlockDtoSchema.parse({
  payerAccountId: "payer.testnet",
  strikes: 2,
  blocked: true,
  lastStrikeAt: "2026-11-05T14:31:29.315Z",
});

/**
 * The dashboard's reads and actions against the API (UI-2, UI-3, UI-4), run with
 * `fetch` replaced by the answers the API actually gives. The point of every test here
 * is which of the three outcomes an answer becomes: a list, a sign-in prompt, or "Till
 * is not answering". A body that fails `@till/core`'s schema is the third, never the
 * first — an empty list is a claim about the seller, and a parse failure is not.
 */

const ENDPOINT = {
  id: "3b0c8b6a-2b0f-4a11-9c1d-2f4a6b8c0e11",
  slug: "abcdefghij",
  gatewayUrl: "https://gateway.test/r/abcdefghij",
  upstreamUrl: "https://data.seller.test/prices",
  priceAmount: "1250000",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "direct",
  active: true,
  description: null,
  // The route the endpoint pays out through (F2e-a). A direct one has no deposit
  // address to advertise, which is the state the editor has to be able to show.
  route: {
    id: "3b0c8b6a-2b0f-4a11-9c1d-2f4a6b8c0e22",
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: "seller.testnet",
    refundAddress: "seller.testnet",
    provider: "mock",
    depositAddress: null,
    modeDetail: "direct",
  },
  creationWarnings: [],
};

const CHECKS = [
  { code: "network", ok: true, message: "Payments settle on near:testnet." },
  { code: "price_floor", ok: false, message: "The price 0.00001 is below Till's 0.01 minimum." },
];

type Call = { readonly url: string; readonly init: RequestInit };

function record(calls: Call[]): (url: string | URL, init?: RequestInit) => void {
  return (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
  };
}

function stubAnswer(body: string, status = 200, contentType = "application/json"): Call[] {
  const calls: Call[] = [];
  const seen = record(calls);
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    seen(url, init);
    return new Response(body, { status, headers: { "content-type": contentType } });
  });
  return calls;
}

function stubFailure(reason: string): Call[] {
  const calls: Call[] = [];
  const seen = record(calls);
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    seen(url, init);
    throw new TypeError(reason);
  });
  return calls;
}

/** The request the client actually made, or a failure that says it did not make one. */
function first(calls: readonly Call[]): Call {
  const [call] = calls;
  if (call === undefined) {
    throw new Error("the dashboard made no request at all");
  }
  return call;
}

function headerOf(call: Call, name: string): string | undefined {
  return new Headers(call.init.headers ?? undefined).get(name) ?? undefined;
}

function sentBody(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

// Parsed rather than cast, so `priceAmount` is the branded string the request type
// asks for: the money rule applies to a test fixture as much as to a seller.
const REQUEST = endpointCreateRequestSchema.parse({
  upstreamUrl: "https://data.seller.test/prices",
  priceAmount: "1250000",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "direct",
  destinationChain: "near",
  destinationAsset: "usdc",
  destinationAddress: "seller.testnet",
  refundAddress: "seller.testnet",
  confirmedAddress: "seller.testnet",
});

describe("changing an endpoint's terms", () => {
  // Parsed, so `priceAmount` is the branded base-unit string the request type wants.
  const PRICE = endpointUpdateRequestSchema.parse({ priceAmount: "2500000" });
  const DESTINATION = endpointUpdateRequestSchema.parse({
    destinationAddress: "new-payout.testnet",
    confirmedAddress: "new-payout.testnet",
  });

  it("patches the endpoint's own path with the body the diff produced, and nothing else", async () => {
    const calls = stubAnswer(
      json({ endpoint: { ...ENDPOINT, priceAmount: "2500000" }, checks: CHECKS }),
    );
    const changed = await api.updateEndpoint(ENDPOINT.id, PRICE, "till_session=token-value");

    expect(changed.kind).toBe("updated");
    if (changed.kind !== "updated") {
      throw new Error("unreachable");
    }
    expect(changed.result.endpoint.priceAmount).toBe("2500000");
    expect(first(calls).url).toBe(`http://localhost:3000/api/endpoints/${ENDPOINT.id}`);
    expect(first(calls).init.method).toBe("PATCH");
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
    expect(sentBody(first(calls))).toEqual({ priceAmount: "2500000" });
  });

  it("reads a 422 that carries the checks as a refusal, and keeps the terms it says are live", async () => {
    // The two 422s the route can answer are different facts and the seller's next
    // step differs: this one means "nothing was written, here is why", so the endpoint
    // in the body is the one still taking money — including its route.
    const paused = { ...ENDPOINT, active: false, priceAmount: "1250000" };
    stubAnswer(
      json({
        endpoint: paused,
        checks: [
          { code: "price_floor", ok: false, message: "0.0025 is below Till's 0.01 minimum." },
        ],
      }),
      422,
    );
    const refused = await api.updateEndpoint(ENDPOINT.id, PRICE);
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") {
      throw new Error("unreachable");
    }
    expect(refused.result.checks.filter((check) => !check.ok).map((check) => check.code)).toEqual([
      "price_floor",
    ]);
    // The live terms, not the requested ones: a screen that drew the proposed price
    // would tell the seller they are charging something Till refused to write.
    expect(refused.result.endpoint.priceAmount).toBe("1250000");
    expect(refused.result.endpoint.route?.destinationAddress).toBe("seller.testnet");
  });

  it("hands back the unconfirmed-destination refusal with the address the route names", async () => {
    const calls = stubAnswer(
      json({
        code: "destination_not_confirmed",
        message: "Confirm the destination address that was shown to you.",
        destinationAddress: "new-payout.testnet",
      }),
      422,
    );
    const refused = await api.updateEndpoint(ENDPOINT.id, {
      ...DESTINATION,
      confirmedAddress: "something-else.testnet",
    });
    expect(refused.kind).toBe("rejected");
    if (refused.kind !== "rejected") {
      throw new Error("unreachable");
    }
    expect(refused.error.code).toBe("destination_not_confirmed");
    expect(refused.error.destinationAddress).toBe("new-payout.testnet");
    expect(calls).toHaveLength(1);
  });

  it("keeps a body the shared contract refuses out of the seller's list", async () => {
    // 422 with a check code nobody declared is drift in the API; drawing it as a
    // refusal with one failing check would be a claim about money nobody read.
    stubAnswer(
      json({
        endpoint: ENDPOINT,
        checks: [{ code: "brand_new_rule", ok: false, message: "nope" }],
      }),
      422,
    );
    expect((await api.updateEndpoint(ENDPOINT.id, PRICE)).kind).toBe("unreachable");

    stubAnswer(json({ endpoint: { ...ENDPOINT, route: { id: "not-a-uuid" } }, checks: [] }));
    expect((await api.updateEndpoint(ENDPOINT.id, PRICE)).kind).toBe("unreachable");

    stubAnswer("<html>502</html>", 502, "text/html");
    const failed = await api.updateEndpoint(ENDPOINT.id, PRICE);
    expect(failed.kind === "unreachable" ? failed.detail : "").toContain("no readable reason");
  });

  it("says signed out in the API's own words when the session ended mid-edit", async () => {
    stubAnswer(json({ code: "unauthenticated", message: "Sign in to change an endpoint." }), 401);
    const refused = await api.updateEndpoint(ENDPOINT.id, PRICE);
    expect(refused.kind).toBe("rejected");
    expect(refused.kind === "rejected" ? refused.error.code : null).toBe("unauthenticated");
  });

  it("answers not-found without saying whether the endpoint exists at all", async () => {
    // 404 is the route's one answer for "not there" and "somebody else's"; the client
    // passes the sentence through rather than inventing a shorter one here.
    const calls = stubAnswer(
      json({ code: "endpoint_not_found", message: "No endpoint of yours has that id." }),
      404,
    );
    const refused = await api.updateEndpoint("3b0c8b6a-2b0f-4a11-9c1d-2f4a6b8c0e99", PRICE);
    expect(refused.kind === "rejected" ? refused.error.code : null).toBe("endpoint_not_found");
    expect(first(calls).init.method).toBe("PATCH");
  });

  it("reports a dead socket as unreachable rather than as a change that did not land", async () => {
    stubFailure("fetch failed: ECONNREFUSED");
    const refused = await api.updateEndpoint(ENDPOINT.id, PRICE);
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("ECONNREFUSED");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listing the seller's endpoints", () => {
  it("names the API on the server and forwards the session cookie it was given", async () => {
    const calls = stubAnswer(json({ endpoints: [ENDPOINT] }));
    const listed = await api.endpoints("till_session=token-value");

    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") {
      throw new Error("unreachable");
    }
    expect(listed.endpoints.map((endpoint) => endpoint.slug)).toEqual(["abcdefghij"]);
    expect(first(calls).url).toBe("http://localhost:3000/api/endpoints");
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
    expect(first(calls).init.credentials).toBe("same-origin");
    // A dashboard that shows yesterday's endpoints is worse than one that fails.
    expect(first(calls).init.cache).toBe("no-store");
  });

  it("is a relative path in the browser, where next.config.ts moves it onto the API", async () => {
    vi.stubGlobal("window", {});
    const calls = stubAnswer(json({ endpoints: [] }));
    expect((await api.endpoints()).kind).toBe("ok");
    expect(first(calls).url).toBe("/api/endpoints");
    expect(headerOf(first(calls), "cookie")).toBeUndefined();
  });

  it("says signed_out for the 401, which is the only answer that means it", async () => {
    stubAnswer(json({ code: "unauthenticated", message: "Sign in to list endpoints." }), 401);
    expect(await api.endpoints("till_session=expired")).toEqual({ kind: "signed_out" });
  });

  it("refuses to turn a body it cannot read into an empty list", async () => {
    const broken = stubAnswer(json({ endpoints: [{ ...ENDPOINT, id: "not-a-uuid" }] }));
    const listed = await api.endpoints("till_session=token-value");

    expect(listed.kind).toBe("unreachable");
    if (listed.kind === "ok") {
      throw new Error("a body the shared schema refuses must never render as a list");
    }
    expect("endpoints" in listed).toBe(false);
    expect(broken).toHaveLength(1);

    // A 200 with no list at all is the same failure, not the same screen.
    stubAnswer(json({}));
    expect((await api.endpoints()).kind).toBe("unreachable");
  });

  it("reports a server error and a dead socket as unreachable, with what failed", async () => {
    stubAnswer("upstream blew up", 500, "text/plain");
    const errored = await api.endpoints("till_session=token-value");
    expect(errored.kind).toBe("unreachable");
    expect(errored.kind === "unreachable" ? errored.detail : "").toContain("500");

    const calls = stubFailure("fetch failed: ECONNREFUSED");
    const refused = await api.endpoints("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("ECONNREFUSED");
    expect(calls).toHaveLength(1);
  });
});

describe("creating an endpoint", () => {
  it("posts the confirmed body and keeps every check from the answer", async () => {
    const calls = stubAnswer(json({ endpoint: ENDPOINT, checks: CHECKS }), 201);
    const created = await api.createEndpoint(REQUEST);

    expect(created.kind).toBe("created");
    if (created.kind !== "created") {
      throw new Error("unreachable");
    }
    expect(created.result.checks.filter((check) => !check.ok).map((check) => check.code)).toEqual([
      "price_floor",
    ]);
    // A creation that failed a check is still a row, and the seller must be able to
    // tell that from a refusal: 201, active false, the reason in the checks.
    expect(created.result.endpoint.active).toBe(true);

    expect(first(calls).init.method).toBe("POST");
    expect(headerOf(first(calls), "content-type")).toBe("application/json");
    const sent = sentBody(first(calls));
    expect(sent.confirmedAddress).toBe(sent.destinationAddress);
  });

  it("hands back the refusal with the code and the extras the form needs", async () => {
    stubAnswer(
      json({
        code: "destination_not_confirmed",
        message: "Confirm the destination address that was shown to you.",
        destinationAddress: "seller.testnet",
      }),
      422,
    );
    const refused = await api.createEndpoint({ ...REQUEST, confirmedAddress: "other.testnet" });
    expect(refused.kind).toBe("rejected");
    if (refused.kind !== "rejected") {
      throw new Error("unreachable");
    }
    expect(refused.error.code).toBe("destination_not_confirmed");
    expect(refused.error.destinationAddress).toBe("seller.testnet");

    stubAnswer(
      json({
        code: "invalid_request",
        message: "The endpoint could not be created from this body.",
        issues: [{ path: "upstreamUrl", code: "invalid_string" }],
      }),
      400,
    );
    const invalid = await api.createEndpoint(REQUEST);
    expect(invalid.kind === "rejected" ? invalid.error.issues?.[0]?.path : null).toBe(
      "upstreamUrl",
    );
  });

  it("treats a 201 it cannot parse as a failure, not as a creation with no checks", async () => {
    // A check code the shared contract does not know is drift in the API; drawing it
    // as "0 checks" would tell the seller their endpoint is fine when nobody read it.
    stubAnswer(
      json({ endpoint: ENDPOINT, checks: [{ code: "brand_new_rule", ok: true, message: "x" }] }),
      201,
    );
    const created = await api.createEndpoint(REQUEST);
    expect(created.kind).toBe("unreachable");

    stubAnswer(json({ endpoint: { ...ENDPOINT, active: "yes" }, checks: [] }), 201);
    expect((await api.createEndpoint(REQUEST)).kind).toBe("unreachable");
  });

  it("says nothing was understood when the answer is not JSON at all", async () => {
    const calls = stubAnswer("<html>500</html>", 500, "text/html");
    const refused = await api.createEndpoint(REQUEST);
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("no readable reason");
    expect(calls).toHaveLength(1);

    stubFailure("socket closed");
    expect((await api.createEndpoint(REQUEST)).kind).toBe("unreachable");
  });
});

describe("listing the seller's payments", () => {
  // Parsed rather than written out, so `amount` is the branded string the contract
  // asks for and the fixture cannot drift from what the API actually sends.
  const PAYMENT = paymentDtoSchema.parse({
    id: "6f0e2d1c-3b4a-4f5e-8d7c-1a2b3c4d5e6f",
    endpointId: "3b0c8b6a-2b0f-4a11-9c1d-2f4a6b8c0e11",
    routeId: null,
    payerAccountId: "payer.testnet",
    amount: "1250000",
    assetContract: "usdc.testnet",
    network: "near:testnet",
    state: "settled",
    nearTxHash: "7GkP1mYcH3nTzQp9rWvBxLdJsF5uYaOcNeIe8b1fKn2q",
    upstreamStatus: 200,
    upstreamMs: 412,
    verifiedAt: "2026-11-04T10:00:00.000Z",
    settledAt: "2026-11-04T10:00:03.000Z",
    selfPayment: false,
  });

  it("forwards the session and keeps every row it was given", async () => {
    const calls = stubAnswer(json({ payments: [PAYMENT] }));
    const listed = await api.payments("till_session=token-value");

    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") {
      throw new Error("unreachable");
    }
    expect(listed.payments.map((payment) => payment.id)).toEqual([PAYMENT.id]);
    expect(first(calls).url).toBe("http://localhost:3000/api/payments");
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
    expect(first(calls).init.credentials).toBe("same-origin");
    expect(first(calls).init.cache).toBe("no-store");
  });

  it("says signed_out for the 401, which is the only answer that means it", async () => {
    stubAnswer(json({ code: "unauthenticated", message: "Sign in to list payments." }), 401);
    expect(await api.payments("till_session=expired")).toEqual({ kind: "signed_out" });
  });

  it("answers the 500 with the API's own sentence, because the unreadable row is the fact", async () => {
    const calls = stubAnswer(
      json({
        code: "payment_unreadable",
        message: "A payment on record is not one Till can read, so it is not shown at all.",
      }),
      500,
    );
    const refused = await api.payments("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("not one Till can read");
    expect(calls).toHaveLength(1);
  });

  it("says there is no readable reason when the 500 body is not the contract's", async () => {
    stubAnswer("<html>500</html>", 500, "text/html");
    const refused = await api.payments("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("no readable reason");
  });

  it("refuses to turn a list it cannot read into an empty one", async () => {
    stubAnswer(json({ payments: [{ ...PAYMENT, state: "paid_please_ignore" }] }));
    const listed = await api.payments("till_session=token-value");
    expect(listed.kind).toBe("unreachable");
    if (listed.kind === "ok") {
      throw new Error("a state the shared schema refuses must never render as a ledger");
    }
    expect("payments" in listed).toBe(false);

    // A 200 with no list in it is the same failure, not the same screen.
    stubAnswer(json({}));
    expect((await api.payments("till_session=token-value")).kind).toBe("unreachable");
  });

  it("reports a dead socket as unreachable, not as a seller with no payments", async () => {
    const calls = stubFailure("fetch failed: ECONNREFUSED");
    const refused = await api.payments("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("ECONNREFUSED");
    expect(calls).toHaveLength(1);
  });
});

describe("listing the seller's open discrepancies", () => {
  it("forwards the session and keeps every open item it was given", async () => {
    const calls = stubAnswer(json({ discrepancies: [DISCREPANCY] }));
    const listed = await api.discrepancies("till_session=token-value");

    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") {
      throw new Error("unreachable");
    }
    expect(listed.discrepancies.map((item) => item.id)).toEqual([DISCREPANCY.id]);
    expect(first(calls).url).toBe("http://localhost:3000/api/discrepancies");
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
    expect(first(calls).init.credentials).toBe("same-origin");
    expect(first(calls).init.cache).toBe("no-store");
  });

  it("says signed_out for the 401, which is the only answer that means it", async () => {
    stubAnswer(
      json({ code: "unauthenticated", message: "Sign in to see what needs reconciling." }),
      401,
    );
    expect(await api.discrepancies("till_session=expired")).toEqual({ kind: "signed_out" });
  });

  it("answers the 500 with the API's own sentence, because an unreadable row is the fact", async () => {
    const calls = stubAnswer(
      json({
        code: "discrepancy_unreadable",
        message: "A discrepancy on record is not one Till can read, so none are shown.",
      }),
      500,
    );
    const refused = await api.discrepancies("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("not one Till can read");
    expect(calls).toHaveLength(1);
  });

  it("refuses to turn a worklist it cannot read into an empty one", async () => {
    stubAnswer(json({ discrepancies: [{ ...DISCREPANCY, severity: "catastrophic" }] }));
    const listed = await api.discrepancies("till_session=token-value");
    expect(listed.kind).toBe("unreachable");
    if (listed.kind === "ok") {
      throw new Error("a severity the shared schema refuses must never render as a worklist");
    }
    expect("discrepancies" in listed).toBe(false);

    stubAnswer(json({}));
    expect((await api.discrepancies("till_session=token-value")).kind).toBe("unreachable");
  });

  it("reports a dead socket as unreachable, not as a seller with nothing to do", async () => {
    const calls = stubFailure("fetch failed: ECONNREFUSED");
    const refused = await api.discrepancies("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("ECONNREFUSED");
    expect(calls).toHaveLength(1);
  });
});

describe("resolving one discrepancy by hand", () => {
  it("posts to the item's own path and hands back the closed row", async () => {
    const calls = stubAnswer(
      json({
        discrepancy: {
          ...DISCREPANCY,
          resolvedAt: "2026-11-05T12:00:00.000Z",
          resolution: "manual",
        },
      }),
    );
    const closed = await api.resolveDiscrepancy(DISCREPANCY.id, "till_session=token-value");

    expect(closed.kind).toBe("resolved");
    if (closed.kind !== "resolved") {
      throw new Error("unreachable");
    }
    expect(closed.discrepancy.resolution).toBe("manual");
    expect(first(calls).url).toBe(
      `http://localhost:3000/api/discrepancies/${DISCREPANCY.id}/resolve`,
    );
    expect(first(calls).init.method).toBe("POST");
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
  });

  it("keeps the refusal the API wrote, including the one that says the session ended", async () => {
    stubAnswer(
      json({
        code: "discrepancy_not_found",
        message: "That is not one of your open discrepancies.",
      }),
      404,
    );
    const missing = await api.resolveDiscrepancy(DISCREPANCY.id);
    expect(missing.kind).toBe("rejected");
    if (missing.kind !== "rejected") {
      throw new Error("unreachable");
    }
    expect(missing.error.code).toBe("discrepancy_not_found");

    stubAnswer(json({ code: "unauthenticated", message: "Sign in to resolve an item." }), 401);
    const signedOut = await api.resolveDiscrepancy(DISCREPANCY.id);
    expect(signedOut.kind === "rejected" ? signedOut.error.code : null).toBe("unauthenticated");

    stubAnswer(
      json({ code: "invalid_request", message: "The item to resolve is named by its id." }),
      422,
    );
    expect((await api.resolveDiscrepancy("not-a-uuid")).kind).toBe("rejected");
  });

  it("will not call a close a success it cannot read", async () => {
    stubAnswer(json({ discrepancy: { ...DISCREPANCY, code: "BRAND_NEW_CODE" } }));
    const closed = await api.resolveDiscrepancy(DISCREPANCY.id);
    expect(closed.kind).toBe("unreachable");

    stubAnswer("<html>500</html>", 500, "text/html");
    const failed = await api.resolveDiscrepancy(DISCREPANCY.id);
    expect(failed.kind).toBe("unreachable");
    expect(failed.kind === "unreachable" ? failed.detail : "").toContain("no readable reason");

    stubFailure("socket closed");
    expect((await api.resolveDiscrepancy(DISCREPANCY.id)).kind).toBe("unreachable");
  });
});

describe("listing the payers this seller is holding", () => {
  it("forwards the session and keeps every held payer", async () => {
    const calls = stubAnswer(json({ payerBlocks: [HELD] }));
    const listed = await api.payerBlocks("till_session=token-value");

    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") {
      throw new Error("unreachable");
    }
    expect(listed.payerBlocks.map((block) => block.payerAccountId)).toEqual(["payer.testnet"]);
    expect(first(calls).url).toBe("http://localhost:3000/api/payer-blocks");
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
    expect(first(calls).init.cache).toBe("no-store");
  });

  it("says signed_out for the 401 and unreachable for the 500, in the API's words", async () => {
    stubAnswer(json({ code: "unauthenticated", message: "Sign in to see blocked payers." }), 401);
    expect(await api.payerBlocks("till_session=expired")).toEqual({ kind: "signed_out" });

    stubAnswer(
      json({
        code: "payer_block_unreadable",
        message: "A blocked payer on record is not one Till can read, so none are shown.",
      }),
      500,
    );
    const refused = await api.payerBlocks("till_session=token-value");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("not one Till can read");
  });

  it("refuses to turn a list it cannot read into a seller with nothing held", async () => {
    stubAnswer(json({ payerBlocks: [{ ...HELD, payerAccountId: "Payer.testnet" }] }));
    const listed = await api.payerBlocks("till_session=token-value");
    expect(listed.kind).toBe("unreachable");
    if (listed.kind === "ok") {
      throw new Error("an account name the shared schema refuses must never render as a hold");
    }
    expect("payerBlocks" in listed).toBe(false);
  });

  it("reports a dead socket as unreachable", async () => {
    stubFailure("fetch failed: ECONNREFUSED");
    expect((await api.payerBlocks("till_session=token-value")).kind).toBe("unreachable");
  });
});

describe("clearing a payer block", () => {
  it("posts the note it was given to the payer's own path", async () => {
    const calls = stubAnswer(json({ payerBlocks: [] }));
    const cleared = await api.clearPayerBlock(
      "payer.testnet",
      "Refunded by hand.",
      "till_session=token-value",
    );

    expect(cleared.kind).toBe("cleared");
    if (cleared.kind !== "cleared") {
      throw new Error("unreachable");
    }
    expect(cleared.payerBlocks).toEqual([]);
    expect(first(calls).url).toBe("http://localhost:3000/api/payer-blocks/payer.testnet/clear");
    expect(first(calls).init.method).toBe("POST");
    expect(sentBody(first(calls))).toEqual({ note: "Refunded by hand." });
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
  });

  it("sends no note field when the seller did not write one", async () => {
    const calls = stubAnswer(json({ payerBlocks: [HELD] }));
    const cleared = await api.clearPayerBlock("payer.testnet");
    expect(cleared.kind).toBe("cleared");
    expect(sentBody(first(calls))).toEqual({});
  });

  it("answers with the list as it now stands, which is the read the page redraws", async () => {
    stubAnswer(json({ payerBlocks: [HELD] }));
    const cleared = await api.clearPayerBlock("other.testnet");
    expect(
      cleared.kind === "cleared" ? cleared.payerBlocks.map((block) => block.payerAccountId) : null,
    ).toEqual(["payer.testnet"]);
  });

  it("keeps a refusal instead of redrawing the table from a guess", async () => {
    stubAnswer(
      json({
        code: "invalid_request",
        message: "A clear takes a note of 200 characters or fewer.",
      }),
      422,
    );
    const refused = await api.clearPayerBlock("payer.testnet", "x".repeat(201));
    expect(refused.kind === "rejected" ? refused.error.code : null).toBe("invalid_request");

    stubAnswer(json({ code: "unauthenticated", message: "Sign in to clear a block." }), 401);
    expect((await api.clearPayerBlock("payer.testnet")).kind).toBe("rejected");
  });

  it("will not redraw a clear it cannot read", async () => {
    stubAnswer(json({ payerBlocks: [{ ...HELD, strikes: -1 }] }));
    expect((await api.clearPayerBlock("payer.testnet")).kind).toBe("unreachable");

    stubAnswer("<html>500</html>", 500, "text/html");
    const failed = await api.clearPayerBlock("payer.testnet");
    expect(failed.kind === "unreachable" ? failed.detail : "").toContain("no readable reason");

    stubFailure("socket closed");
    expect((await api.clearPayerBlock("payer.testnet")).kind).toBe("unreachable");
  });
});

describe("reading the overview totals", () => {
  // Parsed, so the four non-negative totals and the signed adjustment are exactly what
  // the API is allowed to send — including the negative, which is the one field here
  // whose sign is information (6.1) and must survive the read untouched.
  const OVERVIEW = overviewResponseSchema.parse({
    overview: {
      byAsset: [
        {
          asset: "usdc.testnet",
          settledAmount: "1250000",
          inTransitAmount: "250000",
          paidOutAmount: "1000000",
          refundedAmount: "50000",
          adjustedAmount: "-250000",
        },
      ],
      openDiscrepancies: 1,
      servedUnsettledCount: 2,
    },
  });

  it("forwards the session and keeps every total and sign it was given", async () => {
    const calls = stubAnswer(json(OVERVIEW));
    const listed = await api.overview("till_session=token-value");

    expect(listed.kind).toBe("ok");
    if (listed.kind !== "ok") {
      throw new Error("unreachable");
    }
    expect(listed.overview.byAsset[0]?.adjustedAmount).toBe("-250000");
    expect(listed.overview.openDiscrepancies).toBe(1);
    expect(listed.overview.servedUnsettledCount).toBe(2);
    expect(first(calls).url).toBe("http://localhost:3000/api/overview");
    expect(headerOf(first(calls), "cookie")).toBe("till_session=token-value");
    expect(first(calls).init.credentials).toBe("same-origin");
    expect(first(calls).init.cache).toBe("no-store");
  });

  it("says signed_out for the 401, which is the only answer that means it", async () => {
    stubAnswer(json({ code: "unauthenticated", message: "Sign in to read the overview." }), 401);
    expect(await api.overview("till_session=expired")).toEqual({ kind: "signed_out" });
  });

  it("answers the 500 as unreachable, never as a seller with no totals", async () => {
    const calls = stubAnswer(
      json({
        code: "overview_unreadable",
        message: "An overview on record is not one Till can read, so none is shown.",
      }),
      500,
    );
    const refused = await api.overview("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    // `overview_unreadable` is not in `dashboardErrorSchema`'s codes yet, so the API's
    // sentence cannot be parsed here and the fallback line is what the seller reads.
    // The screen is still honest — an unreadable total is a failure, not an empty book —
    // but the code belongs in core's enum for the same reason `status_unreadable` is.
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain(
      "/api/overview returned 500",
    );
    expect(calls).toHaveLength(1);

    stubAnswer("<html>500</html>", 500, "text/html");
    const unreadable = await api.overview("till_session=token-value");
    expect(unreadable.kind === "unreachable" ? unreadable.detail : "").toContain(
      "no readable reason",
    );
  });

  it("refuses to turn a body it cannot read into a seller with nothing", async () => {
    // `overviewDtoSchema`'s totals are integer strings, so a decimal is a total nobody
    // summed. It has to stay a failure: an overview drawn from it would be a number.
    stubAnswer(
      json({
        overview: {
          ...OVERVIEW.overview,
          byAsset: [{ ...OVERVIEW.overview.byAsset[0], settledAmount: "1250000.5" }],
        },
      }),
    );
    const listed = await api.overview("till_session=token-value");
    expect(listed.kind).toBe("unreachable");
    if (listed.kind === "ok") {
      throw new Error("a total the shared schema refuses must never render as a ledger");
    }
    expect("overview" in listed).toBe(false);

    // A count the schema refuses, and a 200 with no overview in it, are the same failure.
    stubAnswer(json({ overview: { ...OVERVIEW.overview, openDiscrepancies: -2 } }));
    expect((await api.overview("till_session=token-value")).kind).toBe("unreachable");

    stubAnswer(json({}));
    expect((await api.overview("till_session=token-value")).kind).toBe("unreachable");
  });

  it("reports a dead socket as unreachable, not as a seller with no money", async () => {
    const calls = stubFailure("fetch failed: ECONNREFUSED");
    const refused = await api.overview("till_session=token-value");
    expect(refused.kind).toBe("unreachable");
    expect(refused.kind === "unreachable" ? refused.detail : "").toContain("ECONNREFUSED");
    expect(calls).toHaveLength(1);
  });
});
