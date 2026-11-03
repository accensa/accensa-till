import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../src/lib/logger.ts";

/**
 * G6 F3: redaction was keyed on a fixed list of names, so two shapes leaked
 * anyway. A credential under a name that is not on the list (`openai_api_key`,
 * `signing_key`) printed whole, and a credential *inside* a value printed whole
 * too, because `url: "postgres://till:pw@host"` is a key called `url`.
 *
 * The accepting half matters as much: a logger that redacts everything is a logger
 * nobody reads, so ordinary fields must survive untouched.
 */

function logged(fields: Record<string, unknown>, message?: string): Record<string, unknown> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  let line: unknown;
  try {
    createLogger({ service: "api" }).info(fields, message);
    // Read the call before restoring: mockRestore also clears the recorded calls.
    line = write.mock.calls.at(-1)?.[0];
  } finally {
    write.mockRestore();
  }
  if (typeof line !== "string") {
    throw new Error("the logger wrote nothing");
  }
  return JSON.parse(line) as Record<string, unknown>;
}

function leaks(fields: Record<string, unknown>, secret: string, message?: string): boolean {
  const json = JSON.stringify(logged(fields, message));
  return json.includes(secret);
}

// Zeros rather than a plausible key, so a public repo holds no credential-shaped
// literal. The redaction pattern only needs alphanumerics after the colon.
const SECRET = "ed25519:000000000000000000000000000000000000000000000000000000000000";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0aWxsIn0.rQY3Tz1xVYwXj9ZQ7bQm1k";
const PASSWORD = "sup3rs3cret";
const DATABASE_URL = `postgres://till:${PASSWORD}@db.internal:5432/till`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("key-name redaction (A4, G6 F3)", () => {
  it("redacts every name the environment actually uses", () => {
    for (const key of [
      "RELAYER_SECRET_KEY",
      "ONECLICK_JWT",
      "SESSION_SECRET",
      "DATABASE_URL",
      "authorization",
      "cookie",
    ]) {
      const fields = logged({ [key]: "leak-me" });
      expect([key, fields[key]]).toEqual([key, "[redacted]"]);
    }
  });

  it("redacts credential-ish names that were not on the list", () => {
    for (const key of [
      "api_key",
      "openai_api_key",
      "ApiKey",
      "private_key",
      "ed25519_private_key",
      "access_key",
      "mnemonic",
      "seed_phrase",
      "passphrase",
      "jwt",
      "oneclick_jwt",
      "payment_signature",
    ]) {
      expect([key, leaks({ [key]: "leak-me" }, "leak-me")]).toEqual([key, false]);
    }
  });

  it("redacts inside nested objects and arrays, not only at the top level", () => {
    const nested = logged({
      request: { headers: { authorization: "Bearer abc", accept: "application/json" } },
      attempts: [{ token: "t-1" }, { apiKey: "k-1" }],
    });
    const json = JSON.stringify(nested);
    expect(json).not.toContain("Bearer abc");
    expect(json).not.toContain("t-1");
    expect(json).not.toContain("k-1");
    // the ordinary sibling of a redacted field stays readable
    expect(JSON.stringify(nested.request)).toContain("application/json");
  });
});

describe("value-shape redaction (G6 F3)", () => {
  it("redacts the password carried inside a URL under a harmless key", () => {
    const fields = logged({ url: DATABASE_URL, upstream: DATABASE_URL });
    expect(JSON.stringify(fields)).not.toContain(PASSWORD);
    // the host and the database name stay, so the line is still useful
    expect(String(fields.url)).toContain("db.internal:5432/till");
  });

  it("redacts a bearer scheme, a NEAR full access key and a JWT inside a message", () => {
    for (const [secret, message] of [
      [SECRET, `relayer signed with ${SECRET}`],
      [JWT, `provider refused the key ${JWT}`],
      ["abc123", "retry with Authorization: Bearer abc123"],
      ["xyz789", "upstream said: Basic xyz789"],
    ] as const) {
      expect([secret, leaks({ path: "/r/prices" }, secret, message)]).toEqual([secret, false]);
    }
  });

  it("leaves ordinary values alone, including a url with no credentials", () => {
    const fields = logged({
      message: undefined,
      path: "/r/prices-7f3a",
      status: 200,
      elapsedMs: 41,
      url: "https://data.seller.test/prices",
      gatewayUrl: "http://localhost:3000",
      seller: "till.seller.testnet",
      settled: true,
    });
    expect(fields).toMatchObject({
      path: "/r/prices-7f3a",
      status: 200,
      elapsedMs: 41,
      url: "https://data.seller.test/prices",
      gatewayUrl: "http://localhost:3000",
      seller: "till.seller.testnet",
      settled: true,
    });
  });
});
