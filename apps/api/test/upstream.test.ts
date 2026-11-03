import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ProxyOptions,
  UpstreamRequestError,
  getUpstream,
  isForwardableHeader,
} from "../src/gateway/proxy.ts";
import {
  UpstreamPolicyError,
  type UpstreamTarget,
  isForbiddenAddress,
  resolveUpstreamTarget,
} from "../src/gateway/ssrf.ts";

/**
 * C5 acceptance tests (GW-8): the upstream address policy and the proxy limits.
 *
 * The policy is tested with an injected resolver, because what matters is which
 * addresses a name may return and a test must not depend on public DNS. The
 * limits are tested against a real loopback server, addressed by the IP the
 * policy would have pinned and named as the seller's host: a mocked socket
 * cannot prove that a size cap holds against a chunked body, or that a slow-drip
 * upstream is actually stopped.
 */

const PUBLIC = "93.184.216.34";
const FORBIDDEN: readonly (readonly [string, string])[] = [
  ["127.0.0.1", "loopback"],
  ["127.53.1.1", "loopback, not only 127.0.0.1"],
  ["10.10.10.10", "RFC 1918"],
  ["172.16.0.1", "RFC 1918, upper half"],
  ["192.168.1.1", "RFC 1918"],
  ["169.254.169.254", "link-local, where the cloud metadata services live"],
  ["100.64.0.1", "carrier-grade NAT"],
  ["0.0.0.0", "this network"],
  ["255.255.255.255", "broadcast"],
  ["198.18.0.1", "benchmarking"],
  ["224.0.0.1", "multicast"],
  ["240.0.0.1", "reserved"],
  ["::1", "IPv6 loopback"],
  ["0:0:0:0:0:0:0:1", "IPv6 loopback written long"],
  ["fe80::1", "IPv6 link-local"],
  ["fd12:3456::1", "IPv6 unique local, upper half of /7"],
  ["fc00::1", "IPv6 unique local, lower half"],
  ["ff02::1", "IPv6 multicast"],
  ["2001:db8::1", "IPv6 documentation"],
  ["2002:c000:0201::1", "6to4, which carries 192.0.2.1 inside it"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata address"],
];

function policyFor(
  overrides: Partial<{
    allowInsecure: boolean;
    gatewayOrigin: string;
    resolve: () => Promise<readonly string[]>;
  }> = {},
) {
  const { resolve, ...rest } = overrides;
  return { allowInsecure: false, resolve: resolve ?? (async () => [PUBLIC]), ...rest };
}

async function refused(
  url: string,
  overrides: Parameters<typeof policyFor>[0] = {},
): Promise<UpstreamPolicyError> {
  try {
    await resolveUpstreamTarget(url, policyFor(overrides));
  } catch (error) {
    expect(error, `refusing ${url}`).toBeInstanceOf(UpstreamPolicyError);
    return error as UpstreamPolicyError;
  }
  throw new Error(`expected ${url} to be refused, it was accepted`);
}

describe("upstream address policy (C5, GW-8)", () => {
  it("accepts a public https name and pins the address it validated", async () => {
    const target = await resolveUpstreamTarget("https://data.seller.test/prices?unit=eur", {
      allowInsecure: false,
      resolve: async () => [PUBLIC, "2606:2800:220:1:248:1893:25c8:1946"],
    });
    expect(target).toEqual({
      origin: "https://data.seller.test",
      hostname: "data.seller.test",
      port: 443,
      protocol: "https:",
      address: PUBLIC,
      family: 4,
      pathname: "/prices",
      search: "?unit=eur",
    });
  });

  it("refuses every internal range, as a literal and as a record", async () => {
    for (const [address, why] of FORBIDDEN) {
      expect([why, isForbiddenAddress(address)]).toEqual([why, true]);
      const host = address.includes(":") ? `[${address}]` : address;
      const error = await refused(`https://${host}/data`);
      expect([why, error.code]).toEqual([why, "address_forbidden"]);
    }
  });

  it("accepts the public addresses it is supposed to", async () => {
    for (const address of [
      PUBLIC,
      "8.8.8.8",
      "2606:2800:220:1:248:1893:25c8:1946",
      "2001:4860::8888",
    ]) {
      expect([address, isForbiddenAddress(address)]).toEqual([address, false]);
    }
    // A v4-mapped public address must stay reachable, or the check has become a
    // refusal of IPv6 generally.
    const target = await resolveUpstreamTarget("https://v6.seller.test/data", {
      allowInsecure: false,
      resolve: async () => ["::ffff:93.184.216.34"],
    });
    expect(target.address).toBe("::ffff:93.184.216.34");
  });

  it("refuses a name whose records mix a public and an internal address, instead of picking the safe one", async () => {
    // The DNS-rebinding shape: one good record to pass a naive check, one bad
    // record to connect to. Filtering would leave the attack one TTL away.
    const error = await refused("https://rebind.test/data", {
      resolve: async () => [PUBLIC, "169.254.169.254"],
    });
    expect(error.code).toBe("address_forbidden");
  });

  it("normalizes the obfuscated IPv4 forms before judging them", async () => {
    for (const url of [
      "https://127.0.0.1/data",
      "https://2130706433/data",
      "https://0x7f.0.0.1/data",
    ]) {
      const error = await refused(url);
      expect([url, error.code]).toEqual([url, "address_forbidden"]);
    }
  });

  it("refuses by name: localhost, single-label, and the internal suffixes", async () => {
    for (const url of [
      "https://localhost/data",
      "https://api.localhost/data",
      "https://metadata.google.internal/data",
      "https://printer/data",
    ]) {
      const error = await refused(url);
      expect([url, error.code]).toEqual([url, "host_forbidden"]);
    }
  });

  it("refuses anything that is not an http(s) GET target", async () => {
    expect((await refused("file:///etc/passwd")).code).toBe("scheme_unsupported");
    expect((await refused("gopher://8.8.8.8:70/")).code).toBe("scheme_unsupported");
    expect((await refused("not a url")).code).toBe("url_unparseable");
    expect((await refused("https://user:sekret@data.seller.test/")).code).toBe(
      "credentials_forbidden",
    );
  });

  it("refuses plain http unless the operator says this is local development", async () => {
    expect((await refused("http://data.seller.test/")).code).toBe("https_required");
    const allowed = await resolveUpstreamTarget("http://data.seller.test/", {
      allowInsecure: true,
      resolve: async () => [PUBLIC],
    });
    expect(allowed.protocol).toBe("http:");
  });

  it("refuses the gateway's own origin, which is a paid request to ourselves", async () => {
    const error = await refused("https://till.example/r/prices", {
      gatewayOrigin: "https://till.example",
    });
    expect(error.code).toBe("self_loop");
  });

  it("reports a name that does not resolve rather than connecting nowhere", async () => {
    expect((await refused("https://gone.seller.test/", { resolve: async () => [] })).code).toBe(
      "no_addresses",
    );
    const broken = await refused("https://broken.seller.test/", {
      resolve: async () => {
        throw new Error("SERVFAIL");
      },
    });
    expect(broken.code).toBe("dns_failed");
  });
});

type Seen = { path: string; headers: Record<string, string | string[] | undefined> };

let server: Server | undefined;
let port = 0;
const seen: Seen[] = [];
const routes = new Map<string, (res: ServerResponse) => void>();

function targetFor(overrides: Partial<UpstreamTarget> = {}): UpstreamTarget {
  return {
    origin: `http://upstream.test:${port}`,
    hostname: "upstream.test",
    port,
    protocol: "http:",
    address: "127.0.0.1",
    family: 4,
    pathname: "/data",
    search: "",
    ...overrides,
  };
}

const optionsFor = (overrides: Partial<ProxyOptions> = {}): ProxyOptions => ({
  timeoutMs: 300,
  maxBytes: 65_536,
  ...overrides,
});

async function requestFailure(promise: Promise<unknown>): Promise<UpstreamRequestError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UpstreamRequestError);
    return error as UpstreamRequestError;
  }
  throw new Error("expected the request to fail, it succeeded");
}

function lastSeen(): Seen {
  const entry = seen.at(-1);
  if (entry === undefined) {
    throw new Error("the upstream saw no request");
  }
  return entry;
}

beforeAll(async () => {
  const created = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: { ...req.headers } });
    const handler = routes.get(req.url ?? "");
    if (handler === undefined) {
      res.writeHead(404).end("unrouted");
      return;
    }
    handler(res);
  });
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  port = (created.address() as AddressInfo).port;

  routes.set("/data", (res) => {
    res.writeHead(200, { "content-type": "application/json", "x-marker": "seller" });
    res.end('{"prices":[1,2,3]}');
  });
  routes.set("/redirect", (res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/data` });
    res.end();
  });
  routes.set("/declared-too-big", (res) => {
    res.writeHead(200, { "content-length": "500000" });
    res.end("never read");
  });
  routes.set("/chunked-huge", (res) => {
    res.writeHead(200);
    for (let i = 0; i < 64; i += 1) {
      res.write(Buffer.alloc(4096, 0x61));
    }
    res.end();
  });
  routes.set("/silent", () => {
    // The socket stays open and nothing is answered.
  });
  routes.set("/trickle", (res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write("a"), 20);
    res.on("close", () => clearInterval(timer));
  });
  routes.set("/half-a-body", (res) => {
    res.writeHead(200);
    res.write("start");
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe("proxy limits (C5, GW-8)", () => {
  it("fetches a 200 and returns the status, the body and the headers", async () => {
    const result = await getUpstream(targetFor(), optionsFor());
    expect(result.status).toBe(200);
    expect(Buffer.from(result.body).toString("utf8")).toBe('{"prices":[1,2,3]}');
    expect(result.body.byteLength).toBe(Buffer.byteLength('{"prices":[1,2,3]}'));
    expect(result.headers.get("x-marker")).toBe("seller");
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("does not follow a redirect, and never asks the second path", async () => {
    const before = seen.length;
    const result = await getUpstream(targetFor({ pathname: "/redirect" }), optionsFor());
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("/data");
    expect(seen.length).toBe(before + 1);
    expect(lastSeen().path).toBe("/redirect");
  });

  it("stops on the declared size before reading, and on the real size when there is no header", async () => {
    const declared = await requestFailure(
      getUpstream(targetFor({ pathname: "/declared-too-big" }), optionsFor()),
    );
    expect(declared.code).toBe("upstream_too_large");

    const streamed = await requestFailure(
      getUpstream(targetFor({ pathname: "/chunked-huge" }), optionsFor({ maxBytes: 8_192 })),
    );
    expect(streamed.code).toBe("upstream_too_large");
  });

  it("times out when the upstream never answers", async () => {
    const started = performance.now();
    const error = await requestFailure(
      getUpstream(targetFor({ pathname: "/silent" }), optionsFor()),
    );
    expect(error.code).toBe("upstream_timeout");
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("times out a slow-drip upstream that keeps resetting the idle clock", async () => {
    // /trickle writes a byte every 20 ms, so an idle timeout never fires. Only
    // the total-budget clock stops it, which is the reason there are two.
    const error = await requestFailure(
      getUpstream(targetFor({ pathname: "/trickle" }), optionsFor()),
    );
    expect(error.code).toBe("upstream_timeout");
  });

  it("times out a response whose body never finishes", async () => {
    const error = await requestFailure(
      getUpstream(targetFor({ pathname: "/half-a-body" }), optionsFor()),
    );
    expect(error.code).toBe("upstream_timeout");
  });

  it("reports an unreachable upstream when the connection is refused", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const gonePort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const error = await requestFailure(getUpstream(targetFor({ port: gonePort }), optionsFor()));
    expect(error.code).toBe("upstream_unreachable");
  });

  it("dials the pinned address while presenting the seller's hostname", async () => {
    await getUpstream(targetFor({ hostname: "data.seller.test" }), optionsFor());
    expect(lastSeen().headers.host).toBe(`data.seller.test:${port}`);
    expect(lastSeen().path).toBe("/data");
  });

  it("forwards content negotiation but no hop-by-hop or payment material", async () => {
    await getUpstream(
      targetFor(),
      optionsFor({
        headers: {
          "accept-language": "en",
          "x-request-id": "req-1",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "proxy-authorization": "Basic zzz",
          "x-payment": "eyJhbGciOi",
          "x-402-payment-response": "yes",
          "payment-signature": "sig",
        },
      }),
    );
    const headers = lastSeen().headers;
    expect(headers["accept-language"]).toBe("en");
    expect(headers["x-request-id"]).toBe("req-1");
    expect(headers["user-agent"]).toBe("till-gateway/0.1");
    for (const name of [
      "proxy-authorization",
      "transfer-encoding",
      "x-payment",
      "x-402-payment-response",
      "payment-signature",
    ]) {
      expect([name, headers[name]]).toEqual([name, undefined]);
    }
  });

  it("isForwardableHeader keeps the ordinary and drops the two forbidden families", () => {
    expect(isForwardableHeader("Accept")).toBe(true);
    expect(isForwardableHeader("if-none-match")).toBe(true);
    expect(isForwardableHeader("Cookie")).toBe(true);
    expect(isForwardableHeader("Upgrade-Insecure-Requests")).toBe(true);
    expect(isForwardableHeader("Connection")).toBe(false);
    expect(isForwardableHeader("Keep-Alive")).toBe(false);
    expect(isForwardableHeader("Proxy-Authorization")).toBe(false);
    expect(isForwardableHeader("X-402-Version")).toBe(false);
    expect(isForwardableHeader("X-Payment-Receipt")).toBe(false);
  });
});
