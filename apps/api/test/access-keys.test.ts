import { afterEach, describe, expect, it } from "vitest";

import {
  type AccessKeyReader,
  createAccessKeyReader,
  parseAccessKeyList,
} from "../src/services/access-keys.ts";

/**
 * F1's chain read (UI-1). The reader is the boundary between Till and a testnet
 * node, so `fetch` is stubbed and three things are pinned: the request is a public
 * read of *this* account's key list, a node that has not caught up is not reported
 * as an ownership failure, and a list this build cannot read refuses sign-in
 * instead of defaulting to "no keys".
 *
 * No network access, as AGENTS.md requires of the suite.
 */

const FULL = "ed25519:3gkkeh6UDUPu1YWqmRzyh46nSfZTcySJDkKpcPhiYr3x";
const FUNCTION_CALL = "ed25519:7n18sWzSNo7hLYqDR2u28FECexMsmU65tmH9keR8XSPK";

type StubResponse = { status?: number; json?: unknown } | { fails: true };
type Recorded = { url: string; body: string };

const calls: Recorded[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

function stubFetch(outcome: () => StubResponse): AccessKeyReader {
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) });
    const response = outcome();
    if ("fails" in response) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(response.json ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return createAccessKeyReader({ rpcUrl: "https://rpc.stub.test", timeoutMs: 1000 });
}

describe("parseAccessKeyList", () => {
  it("keeps the permission distinction that NEP-413 turns on", () => {
    expect(
      parseAccessKeyList([
        { public_key: FULL, access_key: { permission: "FullAccess" } },
        {
          public_key: FUNCTION_CALL,
          access_key: { permission: { FunctionCall: { receiver_id: "x", method_names: [] } } },
        },
      ]),
    ).toEqual([
      { publicKey: FULL, fullAccess: true },
      { publicKey: FUNCTION_CALL, fullAccess: false },
    ]);
  });

  it("drops rows this build cannot read, without dropping the list", () => {
    // A seller must not be locked out because one row on their account is exotic.
    expect(
      parseAccessKeyList([
        { public_key: FULL, access_key: { permission: "FullAccess" } },
        { public_key: "secp256k1:not-base58-at-all!!!", access_key: { permission: "FullAccess" } },
        { access_key: { permission: "FullAccess" } },
        { public_key: 42, access_key: { permission: "FullAccess" } },
        {},
        null,
      ]),
    ).toEqual([{ publicKey: FULL, fullAccess: true }]);
  });

  it("answers an empty list for a value that is not an array", () => {
    for (const value of [undefined, null, {}, "[]", 7]) {
      expect(parseAccessKeyList(value)).toEqual([]);
    }
  });
});

describe("createAccessKeyReader", () => {
  it("asks the node for a public view of this account's keys", async () => {
    const reader = stubFetch(() => ({
      json: {
        result: { keys: [{ public_key: FULL, access_key: { permission: "FullAccess" } }] },
      },
    }));
    expect(await reader("seller.testnet")).toEqual({
      ok: true,
      keys: [{ publicKey: FULL, fullAccess: true }],
    });

    const [call] = calls;
    expect(call?.url).toBe("https://rpc.stub.test");
    expect(JSON.parse(call?.body ?? "")).toEqual({
      jsonrpc: "2.0",
      id: "till-sign-in",
      method: "query",
      params: {
        request_type: "view_access_key_list",
        account_id: "seller.testnet",
        finality: "final",
      },
    });
    // A read, so nothing that spends or signs rides along with it.
    expect(call?.body).not.toMatch(/secret|private_key|signature/i);
  });

  it("accepts legacy stub result.values as well as RPC result.keys", async () => {
    const reader = stubFetch(() => ({
      json: {
        result: { values: [{ public_key: FULL, access_key: { permission: "FullAccess" } }] },
      },
    }));
    expect(await reader("seller.testnet")).toEqual({
      ok: true,
      keys: [{ publicKey: FULL, fullAccess: true }],
    });
  });

  it("names an account that is not there, in each of the wordings a node uses", async () => {
    for (const error of [
      "contract account.testnet does not exist",
      "oneof: no such account",
      "unknown account account.testnet",
    ]) {
      const reader = stubFetch(() => ({ json: { result: { error } } }));
      expect([await reader("account.testnet"), error]).toEqual([
        { ok: false, reason: "account_missing" },
        error,
      ]);
    }
  });

  it("does not read a lagging node as an ownership failure", async () => {
    // The guard this file exists for: "unreachable state" is our node being behind,
    // and telling a seller their account is wrong would be a 401 attached to a lie.
    const reader = stubFetch(() => ({
      json: { result: { error: "unreachable state, lacks balance" } },
    }));
    expect(await reader("seller.testnet")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses to guess on every other read failure", async () => {
    const outcomes: readonly (() => StubResponse)[] = [
      () => ({ status: 500, json: {} }),
      () => ({ status: 503, json: { error: "too many requests" } }),
      // An HTTP-level failure carries no agreed meaning, so its body is not read
      // for ownership facts even when it happens to name a missing account.
      () => ({ status: 404, json: { error: "contract account.testnet does not exist" } }),
      () => ({ json: { error: { name: "TX_ERROR", code: -32000 } } }),
      () => ({ json: {} }),
      () => ({ json: { result: {} } }),
      () => ({ json: { result: { values: [] } } }),
      () => ({ json: { result: { values: "not a list" } } }),
      () => ({ fails: true }),
    ];
    for (const outcome of outcomes) {
      expect([await stubFetch(outcome)("seller.testnet"), outcome]).toEqual([
        { ok: false, reason: "unavailable" },
        outcome,
      ]);
    }
  });
});
