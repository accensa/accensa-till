import http from "node:http";
import https from "node:https";

import type { UpstreamTarget } from "./ssrf.ts";

/**
 * Upstream GET with hard limits (C5, GW-8): no redirects followed, response size
 * capped, time capped, and the socket connects to the address `ssrf.ts` already
 * validated instead of resolving the name again.
 *
 * GW-3 lives with the caller: non-2xx and timeouts abandon the payment, they are
 * never charged. This module only reports what happened.
 */

export type ProxyResult = {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
  readonly elapsedMs: number;
};

export type ProxyErrorCode = "upstream_timeout" | "upstream_too_large" | "upstream_unreachable";

export class UpstreamRequestError extends Error {
  readonly code: ProxyErrorCode;

  constructor(code: ProxyErrorCode, hostname: string) {
    super(`${code} for ${hostname}`);
    this.name = "UpstreamRequestError";
    this.code = code;
  }
}

export type ProxyOptions = {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Buyer headers already filtered by `isForwardableHeader`; never payment material. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
};

/** Hop-by-hop headers (RFC 9110 7.6.1) belong to one connection, not to the chain. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isPaymentHeader(name: string): boolean {
  return name === "payment-signature" || name.startsWith("x-402") || name.startsWith("x-payment");
}

export function isForwardableHeader(rawName: string): boolean {
  const name = rawName.toLowerCase();
  return !HOP_BY_HOP.has(name) && !isPaymentHeader(name) && !name.startsWith("proxy-");
}

function hostHeader(target: UpstreamTarget): string {
  const defaultPort = target.protocol === "https:" ? 443 : 80;
  return target.port === defaultPort ? target.hostname : `${target.hostname}:${target.port}`;
}

function forwardHeaders(
  source: Readonly<Record<string, string>> | undefined,
  target: UpstreamTarget,
): Record<string, string> {
  const out: Record<string, string> = {
    accept: "application/json, */*;q=0.8",
    // identity so the byte cap counts what the seller actually sends.
    "accept-encoding": "identity",
    host: hostHeader(target),
    "user-agent": "till-gateway/0.1",
  };
  for (const [name, value] of Object.entries(source ?? {})) {
    if (isForwardableHeader(name)) {
      out[name.toLowerCase()] = value;
    }
  }
  return out;
}

function toHeaderMap(raw: http.IncomingHttpHeaders): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      map.set(name, value.join(", "));
    } else if (value !== undefined) {
      map.set(name, value);
    }
  }
  return map;
}

type OpenRequest = (
  options: https.RequestOptions,
  onResponse: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

export function getUpstream(target: UpstreamTarget, options: ProxyOptions): Promise<ProxyResult> {
  const started = performance.now();

  return new Promise<ProxyResult>((resolve, reject) => {
    // Both schemes behind one signature: `https.RequestOptions` is a superset of
    // `http.RequestOptions`, so the wider type names either function.
    const open: OpenRequest = target.protocol === "https:" ? https.request : http.request;

    /** Assigned once the deadline timer exists; every rejection path stops it. */
    let stopDeadline = () => {};
    const fail = (code: ProxyErrorCode): void => {
      stopDeadline();
      reject(new UpstreamRequestError(code, target.hostname));
    };

    const request = open(
      {
        method: "GET",
        // The address `ssrf.ts` validated, dialed directly: resolving the name
        // again here is the DNS-rebinding window. The hostname still travels as
        // `Host` and, over https, as the SNI name the certificate is checked
        // against, so virtual hosting and TLS verification keep working.
        hostname: target.address,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: forwardHeaders(options.headers, target),
        // No agent: a pooled socket is another chance to reach a different
        // address than the one that was checked.
        agent: false,
        ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
        timeout: options.timeoutMs,
      },
      (response) => {
        const declared = Number(response.headers["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          request.destroy();
          response.destroy();
          fail("upstream_too_large");
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > options.maxBytes) {
            request.destroy();
            response.destroy();
            fail("upstream_too_large");
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          stopDeadline();
          resolve({
            status: response.statusCode ?? 502,
            headers: toHeaderMap(response.headers),
            body: Buffer.concat(chunks),
            elapsedMs: Math.round(performance.now() - started),
          });
        });
        response.on("error", () => {
          fail("upstream_unreachable");
        });
      },
    );

    // Two clocks, because an idle timeout alone is evadable by a server that
    // trickles one byte a second forever: `timeout` resets on activity, this one
    // is the total budget for the whole exchange.
    const timer = setTimeout(() => {
      request.destroy();
      fail("upstream_timeout");
    }, options.timeoutMs);
    stopDeadline = () => {
      clearTimeout(timer);
    };

    request.on("timeout", () => {
      request.destroy();
      fail("upstream_timeout");
    });
    request.on("error", (error) => {
      fail(
        "code" in error && error.code === "ETIMEDOUT" ? "upstream_timeout" : "upstream_unreachable",
      );
    });
    request.end();
  });
}
