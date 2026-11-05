import { endpointCreateRequestSchema } from "@till/core/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../lib/api-client.ts";

/**
 * The dashboard's two reads against `/api/endpoints` (UI-2), run with `fetch`
 * replaced by the answers the API actually gives. The point of every test here is
 * which of the three outcomes an answer becomes: a list, a sign-in prompt, or "Till
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
