/**
 * NEAR access-key reads for sign-in (UI-1, F1).
 *
 * A signature proves a key was used; only the chain says whether that key belongs
 * to the account that claims it. This is that read, and it is the whole reason
 * F1's Done-when needs a network: Till would otherwise accept a sign-in from any
 * ed25519 key its caller happens to hold.
 *
 * A plain JSON-RPC `query` rather than a library call, for the same two reasons
 * `createTokenStorageReader` gives: hard rule 1 keeps `@fastnear/*` in
 * `x402/near.ts`, and this needs no key, no signer and no transaction — a public
 * read of a list.
 */

import { parseNearPublicKey } from "@till/core";

export type NearAccessKey = {
  readonly publicKey: string;
  readonly fullAccess: boolean;
};

/**
 * Three outcomes, and the difference between the last two is what a seller is
 * told. `unavailable` is never reported as "you do not own that account": an RPC
 * that timed out must not read like an ownership failure.
 */
export type AccessKeyList =
  | { readonly ok: true; readonly keys: readonly NearAccessKey[] }
  | { readonly ok: false; readonly reason: "account_missing" | "unavailable" };

export type AccessKeyReader = (accountId: string) => Promise<AccessKeyList>;

const LIST_TIMEOUT_MS = 5_000;

/**
 * The shapes the RPC uses for an account that is not there. `unreachable state` is
 * deliberately *not* in this list: that one is a node that has not caught up, and
 * reading it as an ownership failure would tell a seller their account is wrong
 * when our node is.
 */
const MISSING_ACCOUNT = /does not exist|no such account|unknown account/i;

function classifyError(blob: string): AccessKeyList {
  return MISSING_ACCOUNT.test(blob)
    ? { ok: false, reason: "account_missing" }
    : { ok: false, reason: "unavailable" };
}

type RpcAccessKeyRow = {
  public_key?: unknown;
  access_key?: { permission?: unknown };
};

/**
 * `permission` is the string `"FullAccess"` or an object naming one
 * `FunctionCall` grant. NEP-413 requires a full-access key to sign a message — a
 * function-call key cannot sign this payload at all — so the distinction is kept
 * and the route refuses on it rather than accepting any key in the list.
 */
export function parseAccessKeyList(values: unknown): readonly NearAccessKey[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const keys: NearAccessKey[] = [];
  for (const row of values as RpcAccessKeyRow[]) {
    if (typeof row?.public_key !== "string") {
      continue;
    }
    // Skip a row whose key this build cannot parse rather than failing the whole
    // list: one exotic entry must not block a seller whose key is fine.
    if (parseNearPublicKey(row.public_key) === null) {
      continue;
    }
    keys.push({
      publicKey: row.public_key,
      fullAccess: row.access_key?.permission === "FullAccess",
    });
  }
  return keys;
}

export function createAccessKeyReader(options: {
  readonly rpcUrl: string;
  readonly timeoutMs?: number;
}): AccessKeyReader {
  return async (accountId: string) => {
    let body: unknown;
    try {
      const response = await fetch(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "till-sign-in",
          method: "query",
          params: {
            request_type: "view_access_key_list",
            account_id: accountId,
            finality: "final",
          },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? LIST_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { ok: false, reason: "unavailable" };
      }
      body = await response.json();
    } catch {
      return { ok: false, reason: "unavailable" };
    }

    const parsed = body as {
      error?: unknown;
      result?: { error?: unknown; keys?: unknown; values?: unknown };
    };
    if (parsed.error !== undefined || parsed.result === undefined) {
      return classifyError(JSON.stringify(parsed.error ?? ""));
    }
    if (parsed.result.error !== undefined) {
      return classifyError(JSON.stringify(parsed.result.error));
    }
    const keys = parseAccessKeyList(parsed.result.keys ?? parsed.result.values);
    // A list that came back empty or unparseable is not "no full-access key", it is
    // a read we do not trust, and refusing sign-in on it is the honest answer.
    return keys.length > 0 ? { ok: true, keys } : { ok: false, reason: "unavailable" };
  };
}
