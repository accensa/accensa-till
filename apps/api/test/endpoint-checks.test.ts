import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type EndpointCreateInput, endpointCreateSchema } from "@till/core";

import {
  type CreationCheck,
  type EndpointCreationDeps,
  type TokenStorage,
  TokenStorageError,
  checkEndpointCreation,
  createTokenStorageReader,
  isSupportedDestinationChain,
  isValidDestinationAddress,
} from "../src/services/endpoints.ts";

/**
 * D4 acceptance tests, the half that needs no database: each creation check and
 * the JSON-RPC storage read.
 *
 * The reader is exercised against a loopback node rather than a mocked fetch,
 * because what matters is the shape the node actually sends: a MethodNotFound
 * arrives as HTTP 200 with `result.error`, and an unregistered account arrives as
 * the four bytes `null`. The checks below the reader are driven with an injected
 * fake reader, since only the service decides what a `supported: false` means.
 */

const PUBLIC = "93.184.216.34";
const SELLER = { id: "00000000-0000-4000-8000-000000000001", nearAccountId: "payout.testnet" };

const validCreate = {
  upstreamUrl: "https://data.seller.test/prices",
  priceAmount: "10000",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "direct",
  destinationChain: "near",
  destinationAsset: "usdc",
  destinationAddress: "payout.testnet",
  refundAddress: "refund.testnet",
} as const;

function input(
  overrides: Partial<Record<keyof typeof validCreate, unknown>> = {},
): EndpointCreateInput {
  return endpointCreateSchema.parse({ ...validCreate, ...overrides });
}

function deps(overrides: Partial<EndpointCreationDeps> = {}): EndpointCreationDeps {
  return {
    minPriceBaseUnits: 10_000n,
    network: "near:testnet",
    allowInsecureUpstream: false,
    gatewayOrigin: "https://gateway.test",
    gatewayPublicUrl: "https://gateway.test",
    payoutProvider: "mock",
    storage: { read: async () => ({ supported: true, registered: true }) },
    resolve: async (hostname) => (hostname === "gateway.test" ? ["8.8.8.8"] : [PUBLIC]),
    ...overrides,
  };
}

function codes(checks: readonly CreationCheck[], ok = false): string[] {
  return checks.filter((check) => check.ok === ok).map((check) => check.code);
}

function byCode(checks: readonly CreationCheck[], code: string): CreationCheck | undefined {
  return checks.find((check) => check.code === code);
}

describe("destination address formats (D4, PO-1)", () => {
  it("knows the chains it can validate and refuses to guess the others", () => {
    for (const chain of ["near", "ethereum", "base", "arbitrum", "solana", "bitcoin"]) {
      expect([chain, isSupportedDestinationChain(chain)]).toEqual([chain, true]);
    }
    expect(isSupportedDestinationChain("dogecoin")).toBe(false);
  });

  it("checks NEAR, EVM, Solana and Bitcoin shapes", () => {
    const cases: readonly (readonly [string, string, boolean])[] = [
      ["near", "payout.testnet", true],
      ["near", "Payout.testnet", false],
      ["near", "payout..testnet", false],
      ["ethereum", `0x${"a".repeat(40)}`, true],
      ["ethereum", `0x${"a".repeat(39)}`, false],
      ["ethereum", "payout.testnet", false],
      ["solana", "11111111111111111111111111111111", true],
      ["solana", "0OIl111111111111111111111111111", false],
      ["bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", true],
      ["bitcoin", "bc1notavalidaddress", false],
    ];
    for (const [chain, address, expected] of cases) {
      expect([chain, address, isValidDestinationAddress(chain, address)]).toEqual([
        chain,
        address,
        expected,
      ]);
    }
  });
});

describe("creation checks (D4, PO-1/PO-2)", () => {
  it("passes every check for a direct endpoint that satisfies all of them", async () => {
    const checks = await checkEndpointCreation(input(), SELLER, deps());
    expect(codes(checks, false)).toEqual([]);
    expect(codes(checks, true)).toEqual([
      "network",
      "upstream_url",
      "price_floor",
      "destination_chain",
      "destination_address",
      "refund_address",
      "direct_destination",
      "storage_registration",
    ]);
  });

  it("refuses an endpoint on a network this process does not serve, and does not ask the chain", async () => {
    let reads = 0;
    const checks = await checkEndpointCreation(
      input({ network: "near:mainnet" }),
      SELLER,
      deps({
        network: "near:testnet",
        storage: {
          read: async () => {
            reads += 1;
            return { supported: true, registered: true };
          },
        },
      }),
    );
    expect(codes(checks, false)).toEqual(["network"]);
    expect(reads).toBe(0);
  });

  it("bounds the price at the configured floor, and accepts exactly the floor", async () => {
    const below = await checkEndpointCreation(input({ priceAmount: "9999" }), SELLER, deps());
    expect(byCode(below, "price_floor")).toMatchObject({ ok: false });
    const exactly = await checkEndpointCreation(input({ priceAmount: "10000" }), SELLER, deps());
    expect(byCode(exactly, "price_floor")).toMatchObject({ ok: true });
  });

  it("refuses an upstream URL the request-time SSRF policy would refuse", async () => {
    const loopback = await checkEndpointCreation(
      input({ upstreamUrl: "https://localhost/prices" }),
      SELLER,
      deps(),
    );
    expect(byCode(loopback, "upstream_url")?.message).toContain("host_forbidden");

    const credentials = await checkEndpointCreation(
      input({ upstreamUrl: "https://user:secret@example.com/prices" }),
      SELLER,
      deps(),
    );
    expect(byCode(credentials, "upstream_url")?.message).toContain("credentials_forbidden");
  });

  it("refuses a chain it cannot validate instead of checking the address against the wrong format", async () => {
    const checks = await checkEndpointCreation(
      input({
        payoutMode: "intents",
        destinationChain: "dogecoin",
        destinationAddress: "D7Y55r1KfQhH2fMMJdJfKQZ5i8bC9nN8m",
      }),
      SELLER,
      deps(),
    );
    expect(codes(checks, false)).toEqual(["destination_chain", "deposit_address"]);
  });

  it("validates a destination address against its own chain", async () => {
    const evm = await checkEndpointCreation(
      input({
        payoutMode: "intents",
        destinationChain: "ethereum",
        destinationAddress: `0x${"b".repeat(40)}`,
      }),
      SELLER,
      deps(),
    );
    expect(byCode(evm, "destination_address")).toMatchObject({ ok: true });

    const wrong = await checkEndpointCreation(
      input({
        payoutMode: "intents",
        destinationChain: "ethereum",
        destinationAddress: "payout.testnet",
      }),
      SELLER,
      deps(),
    );
    expect(byCode(wrong, "destination_address")).toMatchObject({ ok: false });
  });

  it("requires the refund account to be a NEAR account id in both modes", async () => {
    for (const payoutMode of ["direct", "intents"] as const) {
      const checks = await checkEndpointCreation(
        input({ payoutMode, refundAddress: "0xNotNear" }),
        SELLER,
        deps(),
      );
      expect([payoutMode, byCode(checks, "refund_address")?.ok]).toEqual([payoutMode, false]);
    }
  });

  it("refuses a direct endpoint whose destination is not the signed-in account", async () => {
    const checks = await checkEndpointCreation(
      input({ destinationAddress: "someone-else.testnet" }),
      SELLER,
      deps(),
    );
    expect(byCode(checks, "direct_destination")).toMatchObject({ ok: false });
  });

  it("leaves an intents endpoint without a deposit address inactive", async () => {
    const checks = await checkEndpointCreation(input({ payoutMode: "intents" }), SELLER, deps());
    expect(byCode(checks, "deposit_address")).toMatchObject({ ok: false });
  });

  it("checks storage for the pay-to in direct mode and for both NEAR accounts in intents mode", async () => {
    const seen: string[] = [];
    const read = async ({ accountId }: { token: string; accountId: string }) => {
      seen.push(accountId);
      return { supported: true, registered: true };
    };

    await checkEndpointCreation(input(), SELLER, deps({ storage: { read } }));
    expect(seen).toEqual([SELLER.nearAccountId]);

    seen.length = 0;
    await checkEndpointCreation(
      input({ payoutMode: "intents" }),
      SELLER,
      deps({ storage: { read } }),
    );
    expect(seen).toEqual([SELLER.nearAccountId, validCreate.refundAddress]);
  });

  it("deduplicates a seller who names their own account as the refund account", async () => {
    const seen: string[] = [];
    await checkEndpointCreation(
      input({ payoutMode: "intents", refundAddress: SELLER.nearAccountId }),
      SELLER,
      deps({
        storage: {
          read: async ({ accountId }) => {
            seen.push(accountId);
            return { supported: true, registered: true };
          },
        },
      }),
    );
    expect(seen).toEqual([SELLER.nearAccountId]);
  });

  it("fails when the account is not registered, passes when the token has no storage, and warns when it cannot tell", async () => {
    const notRegistered = await checkEndpointCreation(
      input(),
      SELLER,
      deps({ storage: { read: async () => ({ supported: true, registered: false }) } }),
    );
    expect(byCode(notRegistered, "storage_registration")).toMatchObject({ ok: false });

    const noStorage = await checkEndpointCreation(
      input(),
      SELLER,
      deps({ storage: { read: async () => ({ supported: false, registered: false }) } }),
    );
    expect(byCode(noStorage, "storage_registration")).toMatchObject({ ok: true });

    const unknown = await checkEndpointCreation(
      input(),
      SELLER,
      deps({
        storage: {
          read: async () => {
            throw new TokenStorageError("rpc_error");
          },
        },
      }),
    );
    expect(byCode(unknown, "storage_unverifiable")).toMatchObject({ ok: false });
  });
});

type Reply = { readonly status: number; readonly body: unknown };

describe("the storage read speaks the node's own shapes (S1, D4)", () => {
  let server: Server;
  let rpcUrl: string;
  let reply: Reply;
  let requests: unknown[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  function bytes(value: unknown): number[] {
    return [...Buffer.from(JSON.stringify(value), "utf8")];
  }

  function resultOf(value: unknown): Reply {
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: "till-endpoint-check",
        result: { result: bytes(value), logs: [], block_height: 1, block_hash: "hash" },
      },
    };
  }

  it("asks the token contract for storage_balance_of at finality", async () => {
    reply = resultOf({ storage_balance: "0", total: "0" });
    const reader = createTokenStorageReader({ rpcUrl });
    await reader.read({ token: "usdc.testnet", accountId: "payout.testnet" });
    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: "till-endpoint-check",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: "usdc.testnet",
          method_name: "storage_balance_of",
          args_base64: Buffer.from(JSON.stringify({ account_id: "payout.testnet" })).toString(
            "base64",
          ),
        },
      },
    ]);
  });

  it("reads a null balance as supported but unregistered, exactly as the scheme does", async () => {
    reply = resultOf(null);
    const storage: TokenStorage = await createTokenStorageReader({ rpcUrl }).read({
      token: "usdc.testnet",
      accountId: "payout.testnet",
    });
    expect(storage).toEqual({ supported: true, registered: false });
  });

  it("reads a MethodNotFound as a token without storage, not as a failed read", async () => {
    reply = {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: "till-endpoint-check",
        result: { error: "wasm execution failed with error: MethodResolveError(MethodNotFound)" },
      },
    };
    expect(
      await createTokenStorageReader({ rpcUrl }).read({
        token: "nft.testnet",
        accountId: "payout.testnet",
      }),
    ).toEqual({ supported: false, registered: false });
  });

  it("treats any other contract error as unknown rather than as 'no storage'", async () => {
    reply = {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: "till-endpoint-check",
        result: { error: "wasm execution failed with error: HostError(GasLimitExceeded)" },
      },
    };
    await expect(
      createTokenStorageReader({ rpcUrl }).read({
        token: "usdc.testnet",
        accountId: "payout.testnet",
      }),
    ).rejects.toMatchObject({ code: "contract_error" });
  });

  it("fails on a transport error and on a body it cannot decode", async () => {
    reply = { status: 500, body: { error: "nope" } };
    await expect(
      createTokenStorageReader({ rpcUrl }).read({
        token: "usdc.testnet",
        accountId: "payout.testnet",
      }),
    ).rejects.toMatchObject({ code: "rpc_error" });

    reply = {
      status: 200,
      body: { jsonrpc: "2.0", id: "till-endpoint-check", result: { result: "not an array" } },
    };
    await expect(
      createTokenStorageReader({ rpcUrl }).read({
        token: "usdc.testnet",
        accountId: "payout.testnet",
      }),
    ).rejects.toMatchObject({ code: "malformed" });

    reply = {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: "till-endpoint-check",
        result: { result: [...Buffer.from("not json", "utf8")], logs: [] },
      },
    };
    await expect(
      createTokenStorageReader({ rpcUrl }).read({
        token: "usdc.testnet",
        accountId: "payout.testnet",
      }),
    ).rejects.toMatchObject({ code: "malformed" });
  });
});
