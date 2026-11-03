import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF validation (C5, GW-8, ARCHITECTURE.md 8.4). The gateway only ever
 * connects to an upstream the seller configured, so a hostname that resolves to
 * an internal address is the attack: it turns Till into a proxy into the
 * provider's network, the cloud metadata service, or the gateway itself.
 *
 * The rule that makes this hold is that the address is validated *and then
 * pinned*: `resolveUpstreamTarget` returns the one IP the socket must use, and
 * `proxy.ts` connects to it without resolving the name a second time. Checking
 * first and resolving again later is exactly the DNS-rebinding window.
 */

export type UpstreamErrorCode =
  | "url_unparseable"
  | "scheme_unsupported"
  | "https_required"
  | "credentials_forbidden"
  | "host_forbidden"
  | "dns_failed"
  | "no_addresses"
  | "address_forbidden"
  | "self_loop";

/** `reason` is safe to log: it carries a code and a hostname, never a path, query or credential. */
export class UpstreamPolicyError extends Error {
  readonly code: UpstreamErrorCode;

  constructor(code: UpstreamErrorCode, hostname = "") {
    super(`${code}${hostname === "" ? "" : ` for ${hostname}`}`);
    this.name = "UpstreamPolicyError";
    this.code = code;
  }
}

/** The address `proxy.ts` must dial. `address` is already validated. */
export type UpstreamTarget = {
  readonly origin: string;
  readonly hostname: string;
  readonly port: number;
  readonly protocol: "http:" | "https:";
  readonly address: string;
  readonly family: 4 | 6;
  readonly pathname: string;
  readonly search: string;
};

export type ResolveNames = (hostname: string) => Promise<readonly string[]>;

export type UpstreamPolicy = {
  /** GW-8: plain http is refused unless the operator says this is local dev. */
  readonly allowInsecure: boolean;
  /** The gateway's own public origin, refused as an upstream (self-loop). */
  readonly gatewayOrigin?: string | undefined;
  readonly resolve?: ResolveNames;
};

/** Hostnames that can only ever resolve internally, by name rather than by record. */
function isForbiddenHostName(hostname: string): boolean {
  if (!hostname.includes(".")) {
    return true;
  }
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan")
  );
}

/**
 * Eight 16-bit groups, or undefined when the text is not an IPv6 address.
 * Expands the `::` shorthand, turns a trailing dotted-quad into its two groups,
 * and drops a `%eth0` zone id, which carries no meaning for an outbound connect.
 */
function expandIpv6(input: string): readonly number[] | undefined {
  const address = (input.split("%")[0] ?? "").toLowerCase();
  if (address === "" || isIP(address) !== 6) {
    return undefined;
  }

  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  const embedded = tail.includes(".") ? ipv4Octets(tail) : undefined;
  const head = embedded === undefined ? address : address.slice(0, lastColon);
  const [e0 = 0, e1 = 0, e2 = 0, e3 = 0] = embedded ?? [];
  const trailing = embedded === undefined ? [] : [(e0 << 8) | e1, (e2 << 8) | e3];

  const parse = (text: string): number[] =>
    text === ""
      ? []
      : text
          .split(":")
          .filter((group) => group !== "")
          .map((group) => Number.parseInt(group, 16));

  const shorthand = head.indexOf("::");
  if (shorthand === -1) {
    const groups = [...parse(head), ...trailing];
    return groups.length === 8 ? groups : undefined;
  }
  const left = parse(head.slice(0, shorthand));
  const right = [...parse(head.slice(shorthand + 2)), ...trailing];
  const missing = 8 - left.length - right.length;
  if (missing < 1) {
    return undefined;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv4Octets(input: string): readonly number[] | undefined {
  if (isIP(input) !== 4) {
    return undefined;
  }
  const parts = input.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length === 4 && parts.every((p) => p !== undefined && Number.isInteger(p))
    ? parts
    : undefined;
}

/**
 * Everything that is not publicly routable, or is reserved and should never be
 * reached from a seller's URL: loopback, RFC 1918, RFC 6598 carrier-grade NAT,
 * link-local (which is where the cloud metadata services live), the
 * documentation and benchmarking blocks, multicast and the remaining reserved
 * space. IPv6 unique-local, link-local, multicast, documentation and the
 * transition mechanisms are refused too, because 6to4 and Teredo carry an
 * embedded IPv4 address that would otherwise slip past the checks above.
 */
export function isForbiddenAddress(input: string): boolean {
  const address = (input.split("%")[0] ?? "").toLowerCase();
  const v4 = ipv4Octets(address);
  if (v4 !== undefined) {
    const [a = 0, b = 0, c = 0] = v4;
    if (a === 0) return true;
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  const groups = expandIpv6(address);
  if (groups === undefined || groups.length !== 8) {
    // Not a parsable literal. A caller that reached here with a *name* is the
    // normal path; this branch only answers for the literal path.
    return false;
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0] = groups;
  if (groups.every((group) => group === 0)) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    // v4-mapped: ::ffff:a.b.c.d, checked as the IPv4 it carries.
    const embedded = `${(groups[6] ?? 0) >> 8}.${(groups[6] ?? 0) & 0xff}.${(groups[7] ?? 0) >> 8}.${(groups[7] ?? 0) & 0xff}`;
    return isForbiddenAddress(embedded);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  if (g0 === 0x2002 || g0 === 0x3ffe) return true;
  if (g0 === 0x2001 && (g1 & 0xff00) === 0x0000) return true;
  if (g0 === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0) {
    // ::1 and any other address whose only significant bits sit in the last
    // two groups of the compatibility space.
    return true;
  }
  return false;
}

const defaultResolve: ResolveNames = async (hostname) => {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
};

/**
 * Validate a seller-configured upstream URL and return the address to pin.
 * Throws `UpstreamPolicyError` for anything refused.
 */
export async function resolveUpstreamTarget(
  rawUrl: string,
  policy: UpstreamPolicy,
): Promise<UpstreamTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamPolicyError("url_unparseable");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UpstreamPolicyError("scheme_unsupported", url.hostname);
  }
  if (url.protocol === "http:" && !policy.allowInsecure) {
    throw new UpstreamPolicyError("https_required", url.hostname);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UpstreamPolicyError("credentials_forbidden", url.hostname);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // An IP literal is judged by its address, not by name rules: `::1` has no dot
  // in it, and treating literals as single-label hostnames would report the
  // wrong reason for the most important case.
  if (isIP(hostname) === 0 && isForbiddenHostName(hostname)) {
    throw new UpstreamPolicyError("host_forbidden", hostname);
  }

  const gatewayOrigin =
    policy.gatewayOrigin === undefined ? undefined : new URL(policy.gatewayOrigin).origin;
  // Strings, so a URL naming the gateway's own public IP instead of its hostname
  // is not caught here. Logged as G4's residual risk: closing it means resolving
  // `gatewayOrigin`, which costs a DNS call on every validated URL.
  if (gatewayOrigin === url.origin) {
    throw new UpstreamPolicyError("self_loop", hostname);
  }

  const literal = isIP(hostname);
  const addresses =
    literal === 0
      ? await (policy.resolve ?? defaultResolve)(hostname).catch(() => {
          throw new UpstreamPolicyError("dns_failed", hostname);
        })
      : [hostname];
  if (addresses.length === 0) {
    throw new UpstreamPolicyError("no_addresses", hostname);
  }

  // Every record must be public. Filtering the bad ones and connecting to a
  // good one would let a name with one internal and one external record keep
  // working, which is the rebinding shape.
  for (const address of addresses) {
    // And every record must be an address. `isForbiddenAddress` cannot judge
    // text it fails to parse — it returns false — so a resolver that answered
    // with a name, a bracketed literal or an empty string would sail through
    // and then be pinned as the address to dial. (G4)
    if (isIP(address.split("%")[0] ?? "") === 0 || isForbiddenAddress(address)) {
      throw new UpstreamPolicyError("address_forbidden", hostname);
    }
  }

  const [address = hostname] = addresses;
  return {
    origin: url.origin,
    hostname,
    port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
    protocol: url.protocol,
    address: address ?? hostname,
    family: isIP(address ?? hostname) === 6 ? 6 : 4,
    pathname: url.pathname,
    search: url.search,
  };
}
