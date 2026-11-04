import { type Server, createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLocalNearSigner } from "@fastnear/x402/node";

import { createX402Near } from "../src/x402/near.ts";
import type { NearViewSigner, RequirementsInput } from "../src/x402/types.ts";

/**
 * C1 acceptance: the x402 surface, tested against the real scheme.
 *
 * Nothing here talks to a chain. The payer's signed delegate is minted by the
 * library's own client signer pointed at a loopback JSON-RPC stub, and the chain
 * reads the facilitator needs are answered by a `NearViewSigner` we control. That
 * is enough to run the whole `@x402/near` verification path — signature, access
 * key, block height, gas cap, `ft_transfer` arguments, NEP-145 storage — over a
 * genuine payment, so the refusals below are the scheme's own decisions, not
 * mocks of them.
 *
 * What is therefore *not* proven: that a real relayer can submit, that a real
 * `ft_transfer` lands, or that the deposit balances exist. Those need A10's
 * funded testnet accounts and are recorded as owed on this row, not claimed.
 *
 * The library import is the payer's role, not our seller code: only
 * `src/x402/near.ts` touches `@fastnear/*` in production paths (hard rule 1), and
 * a test that cannot mint a payment could not test the verifier at all.
 */

const PAYER = "payer.testnet";
const SELLER = "seller.testnet";
const TOKEN = "usdc.testnet";
const RELAYER = "relayer.testnet";
/** A throwaway key, never a funded one: nothing here can move money. */
const PAYER_KEY = "ed25519:3C8DxNwqJ5rP4nFBEhKZKvXWMBcpPvjGqPgn2sTQxXWJ";
/** The all-zero code hash is what NEAR reports for a plain account. */
const NO_CONTRACT = "11111111111111111111111111111111";
const HAS_CONTRACT = "7BCKZH9Znj1iMAhRMLTR81vXATMiKh3KZbLK7MF3KtU4";
const BLOCK_HEIGHT = 123_456_789;
const BLOCK_HASH = "FG25p2pNTtW8fBuPqMfvv5f6YQqJn7XwEw5o6oPzb8Kq";

/** The client signer's two RPC reads: `view_access_key` and the final block. */
let rpc: Server;
let rpcUrl = "";

beforeAll(async () => {
  rpc = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      let result: unknown = {};
      if (call.method === "query") {
        result = {
          block_height: BLOCK_HEIGHT,
          block_hash: BLOCK_HASH,
          nonce: 7,
          permission_kind: "FullAccess",
        };
      } else if (call.method === "block") {
        result = {
          header: {
            height: BLOCK_HEIGHT,
            hash: BLOCK_HASH,
            prev_hash: BLOCK_HASH,
            timestamp: "2026-11-03T00:00:00.000000000Z",
            timestamp_nanosec: "0",
            epoch_id: BLOCK_HASH,
            next_epoch_id: BLOCK_HASH,
            approval_masks: [[], []],
            signature: "ed25519:11111111111111111111111111111111",
            rank: 0,
          },
          author_id: RELAYER,
          next_bps: null,
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as { port: number }).port}`;
});

afterAll(() => {
  rpc.close();
});

function requirementsFor(overrides: Partial<RequirementsInput> = {}): RequirementsInput {
  return {
    network: "near:testnet",
    assetContract: TOKEN,
    priceAmount: "10000",
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    ...overrides,
  };
}

/** Mint a real signed delegate for these requirements, as the payer would. */
async function mintPayment(input: RequirementsInput): Promise<unknown> {
  const client = createLocalNearSigner({
    accountId: PAYER,
    secretKey: PAYER_KEY,
    rpcUrls: { "near:testnet": rpcUrl },
  });
  const requirements = {
    scheme: "exact",
    network: input.network,
    asset: input.assetContract,
    amount: input.priceAmount,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: {},
  };
  const signedDelegateAction = await client.createSignedDelegateAction({
    x402Version: 2,
    paymentRequirements: requirements as never,
  });
  return {
    x402Version: 2,
    resource: { url: "https://till.example/r/prices-7f3a", mimeType: "application/json" },
    accepted: requirements,
    payload: { signedDelegateAction },
  };
}

type SignerKnobs = {
  readonly blockHeight?: bigint;
  readonly accessKey?: {
    nonce: bigint;
    permissionKind: "FullAccess" | "FunctionCall" | "Unknown";
  } | null;
  /** The payer's own account row: `false` answers `null`, i.e. delete-account. */
  readonly senderExists?: boolean;
  readonly tokenCodeHash?: string;
  readonly storage?: { supported: false } | { supported: true; registered: boolean };
  readonly ftBalance?: bigint;
  readonly submit?:
    | { transaction: string; innerReceipt: { kind: "success"; value: string } }
    | {
        transaction: string;
        innerReceipt: { kind: "failure"; error: string };
      };
  readonly failOn?: "height";
};

/**
 * The chain, as the verifier sees it. Every read answers what a healthy testnet
 * would, so a refusal below can only come from the payment itself.
 */
function fakeChain(knobs: SignerKnobs = {}): { signer: NearViewSigner; submits: string[] } {
  const submits: string[] = [];
  const signer: NearViewSigner = {
    getRelayerIds: () => [RELAYER],
    getCurrentBlockHeight: async () => {
      if (knobs.failOn === "height") {
        throw new Error("rpc unreachable");
      }
      return knobs.blockHeight ?? BigInt(BLOCK_HEIGHT + 5);
    },
    viewAccount: async ({ accountId }) =>
      accountId === TOKEN
        ? { codeHash: knobs.tokenCodeHash ?? HAS_CONTRACT }
        : knobs.senderExists === false
          ? null
          : { codeHash: NO_CONTRACT },
    viewAccessKey: async () =>
      knobs.accessKey === undefined ? { nonce: 7n, permissionKind: "FullAccess" } : knobs.accessKey,
    ftBalanceOf: async () => knobs.ftBalance ?? 1_000_000n,
    storageBalanceOf: async () => knobs.storage ?? { supported: false },
    submitSignedDelegateAction: async ({ signedDelegateAction }) => {
      submits.push(signedDelegateAction);
      return (
        knobs.submit ?? {
          transaction: "test-tx-hash",
          innerReceipt: { kind: "success", value: "" },
        }
      );
    },
  };
  return { signer, submits };
}

function x402For(knobs: SignerKnobs = {}, maxSponsoredGas = 30_000_000_000_000n) {
  return createX402Near({
    network: "near:testnet",
    maxSponsoredGas,
    signer: fakeChain(knobs).signer,
  });
}

describe("requirements (GW-1)", () => {
  const near = x402For();

  it("advertises the scheme name the payer's wallet matches on", () => {
    const body = near.requirements(requirementsFor());
    expect(body.scheme).toBe("exact");
    expect(body.network).toBe("near:testnet");
    expect(body.payTo).toBe(SELLER);
    expect(body.asset).toBe(TOKEN);
  });

  it("keeps the price in base units, unscaled", () => {
    // The money hazard: the library's own `parsePrice` runs a decimal string
    // through `convertToTokenAmount` at 6 decimals, so "10000" would become
    // "10000000000" — a ten-figure overcharge advertised to a payer. The
    // requirements are built directly, so the amount must survive unchanged.
    expect(near.requirements(requirementsFor({ priceAmount: "10000" })).amount).toBe("10000");
    expect(near.requirements(requirementsFor({ priceAmount: "9007199254740993" })).amount).toBe(
      "9007199254740993",
    );
  });

  it("refuses to advertise a price that is not positive", () => {
    for (const priceAmount of ["-1", "0", "1.5", "abc"]) {
      expect(() => near.requirements(requirementsFor({ priceAmount }))).toThrow();
    }
  });

  it("refuses to advertise a network the library cannot name", () => {
    // `PaymentRequirements.network` is `${string}:${string}` in the types, and a
    // bare `testnet` would otherwise travel all the way to the delegate check.
    for (const network of ["testnet", "near:", "NEAR:testnet"]) {
      expect(() => near.requirements(requirementsFor({ network }))).toThrow();
    }
  });
});

describe("verify accepts a genuine payment (GW-2)", () => {
  it("returns the payer and a replay key, and nothing about expiry it cannot know", async () => {
    const near = x402For();
    const requirements = near.requirements(requirementsFor());
    const body = await mintPayment(requirementsFor());

    const result = await near.verify(body, requirements);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.authorization.payerAccountId).toBe(PAYER);
    expect(result.authorization.expiresAt).toBeNull();
    // sha256 hex of the signed delegate: stable for a replay, distinct per payment.
    expect(result.authorization.replayKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives two payments of the same price two different replay keys", async () => {
    const near = x402For();
    const requirements = near.requirements(requirementsFor());
    const first = await near.verify(await mintPayment(requirementsFor()), requirements);
    const second = await near.verify(
      await mintPayment(requirementsFor({ maxTimeoutSeconds: 61 })),
      requirements,
    );
    if (!first.ok || !second.ok) throw new Error("both should verify");
    expect(first.authorization.replayKey).not.toBe(second.authorization.replayKey);
  });
});

describe("verify refuses, and says which rule fired (GW-2, G6)", () => {
  const requirements = x402For().requirements(requirementsFor());

  it("refuses a payment whose body is not a payment at all", async () => {
    const near = x402For();
    for (const body of [null, undefined, "a string", {}, { x402Version: 1 }, []]) {
      const result = await near.verify(body, requirements);
      expect([JSON.stringify(body), result.ok, result.ok ? "" : result.kind]).toEqual([
        JSON.stringify(body),
        false,
        "malformed",
      ]);
    }
  });

  it("refuses v1's resource string, because the delegate behind it is never read", async () => {
    // A genuine v2 body carries `resource: {url, …}`. A client that posts the v1
    // shape is on a protocol we do not speak, and the difference has to be
    // reported as malformed rather than passed to the verifier and answered with
    // the scheme's own refusal, which a route would map to a re-challenge.
    const genuine = (await mintPayment(requirementsFor())) as Record<string, unknown>;
    const result = await x402For().verify(
      { ...genuine, resource: "https://till.example/r/prices-7f3a" },
      requirements,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("malformed");
  });

  it("refuses a forged delegate, however slightly it was changed", async () => {
    const near = x402For();
    const body = (await mintPayment(requirementsFor())) as {
      payload: { signedDelegateAction: string };
    };
    // One byte of the signature: the payer, the amount and the payee all still
    // read correctly, so only the cryptographic check can catch this.
    const last = body.payload.signedDelegateAction.slice(-8, -7);
    const flipped = last === "A" ? "B" : "A";
    body.payload.signedDelegateAction =
      body.payload.signedDelegateAction.slice(0, -8) +
      flipped +
      body.payload.signedDelegateAction.slice(-7);

    const result = await near.verify(body, requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a forged payment must never verify");
    expect(result.kind).toBe("invalid");
    expect(result.reason).toContain("signature");
  });

  it("refuses a payment that underpays the advertised price", async () => {
    const near = x402For();
    const cheap = await mintPayment(requirementsFor({ priceAmount: "5000" }));
    const result = await near.verify(cheap, requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("invalid");
    expect(result.reason).toContain("amount");
  });

  it("refuses a payment sent to somebody else's account", async () => {
    const near = x402For();
    const elsewhere = await mintPayment(requirementsFor({ payTo: "attacker.testnet" }));
    const result = await near.verify(elsewhere, requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("invalid");
    // The rule that fires is the strong one: the `ft_transfer` argument inside the
    // signed delegate is compared to `payTo`, so a payer cannot redirect the
    // transfer by editing the requirements it echoes back.
    expect(result.reason).toContain("recipient_mismatch");
  });

  it("refuses a delegate past its block-height expiry", async () => {
    // Signed at height 123456789 with a 60 s timeout, so a verifier asked at a
    // height past that bound must fail closed (spec §5).
    const near = x402For({ blockHeight: BigInt(BLOCK_HEIGHT + 10_000) });
    const body = await mintPayment(requirementsFor());
    const result = await near.verify(body, requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("expired");
  });

  it("refuses when the payer's access key is gone or not usable", async () => {
    // Two different rules, both fail-closed: a key that no longer exists on the
    // account, and a key whose permission the scheme does not recognise.
    const cases = [
      [null, "access_key_not_found"],
      [{ nonce: 7n, permissionKind: "Unknown" } as const, "unsupported_access_key_permission"],
      [{ nonce: 7n, permissionKind: "FunctionCall" } as const, "function_call_key_not_allowed"],
    ] as const;
    for (const [accessKey, expected] of cases) {
      const result = await x402For({ accessKey }).verify(
        await mintPayment(requirementsFor()),
        requirements,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`unreachable for ${expected}`);
      expect([expected, result.kind]).toEqual([expected, "invalid"]);
      expect([expected, result.reason]).toEqual([expected, expect.stringContaining(expected)]);
    }
  });

  it("refuses a payment from a payer account that no longer exists", async () => {
    // A delegate stays verifiable for its whole `max_block_height` window, and a
    // delete-account inside that window is a real sequence: the signature is still
    // valid and the access key read is answered from the delegate, so the refusal
    // can only come from re-deriving the sender against the chain.
    const result = await x402For({ senderExists: false }).verify(
      await mintPayment(requirementsFor()),
      requirements,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("invalid");
    expect(result.reason).toContain("sender_account_not_found");
  });

  it("refuses a payment whose nonce the payer's account has already spent (S6)", async () => {
    // The rule is `delegate.nonce <= accessKey.nonce` (`dist/cjs/exact/facilitator/
    // index.js:375`): the client mints at the nonce the RPC reports plus one (the
    // stub answers 7, so the delegate carries 8), and the scheme refuses anything
    // not strictly above the key's current nonce. Read the direction of that
    // carefully — it is the *access key read* that has to have moved, which on a
    // real chain means a previous delegate has already been executed. So this is a
    // refusal of a payment whose nonce has landed, not of one merely in flight; the
    // next test is the one that shows what that leaves for the gateway to do.
    const body = await mintPayment(requirementsFor());
    const spent = await x402For({ accessKey: { nonce: 8n, permissionKind: "FullAccess" } }).verify(
      body,
      requirements,
    );
    expect(spent.ok).toBe(false);
    if (spent.ok) throw new Error("a spent nonce must never verify");
    expect(spent.reason).toContain("nonce_already_used");
    // And the fresh key still verifies, so the refusal above is the nonce and not
    // the fixture.
    expect((await x402For().verify(body, requirements)).ok).toBe(true);
  });

  it("lets two delegates from one payer verify at once, so one-in-flight is the gateway's job (S6, GW-6)", async () => {
    // S6's actual question, answered by measurement rather than by the rule above
    // being read optimistically. One payer, one chain state, two endpoints at two
    // prices: the RPC stub reports the same access-key nonce for both, so both
    // delegates carry nonce 8 and **both verify**. The scheme therefore cannot be
    // the thing that enforces GW-6 — the collision is resolved on-chain, when the
    // second one is executed against a key that has already moved, which is a
    // settlement failure the seller has already served for. What the pair proves
    // they share is exactly one nonce: read against a key at 8, both refuse.
    const chain = fakeChain();
    const near = createX402Near({
      network: "near:testnet",
      maxSponsoredGas: 30_000_000_000_000n,
      signer: chain.signer,
    });
    const cheapInput = requirementsFor({ priceAmount: "10000" });
    const dearInput = requirementsFor({ priceAmount: "20000" });
    const cheapBody = await mintPayment(cheapInput);
    const dearBody = await mintPayment(dearInput);

    const cheap = await near.verify(cheapBody, near.requirements(cheapInput));
    const dear = await near.verify(dearBody, near.requirements(dearInput));
    expect([cheap.ok, dear.ok]).toEqual([true, true]);
    if (!cheap.ok || !dear.ok) throw new Error("unreachable");
    // Two different payments, and no replay key in common for a route to dedupe on.
    expect(cheap.authorization.replayKey).not.toBe(dear.authorization.replayKey);

    // The other half of that, and the more useful half for C8: two payments minted
    // for the *same* endpoint in the same block are byte-identical — ed25519 is
    // deterministic, and nothing in a NEP-366 delegate is per-request — so they
    // share one replay key and `payments.replay_key`'s unique index collapses them.
    // One in flight per payer per price therefore falls out of the ledger for free;
    // only *different* prices from one payer are the case C8 has to gate by hand.
    const twin = await near.verify(await mintPayment(cheapInput), near.requirements(cheapInput));
    expect(twin.ok).toBe(true);
    if (!twin.ok) throw new Error("unreachable");
    expect(twin.authorization.replayKey).toBe(cheap.authorization.replayKey);

    // Both settle, i.e. both reach the relayer. On a chain only one lands.
    await near.settle(cheapBody, near.requirements(cheapInput));
    await near.settle(dearBody, near.requirements(dearInput));
    expect(chain.submits.length).toBe(2);

    // And the same two, read against a key that has moved to 8, are both refused:
    // one nonce between them, which is why C8's in-flight gate cannot be delegated
    // to the scheme.
    const spentKey = { accessKey: { nonce: 8n, permissionKind: "FullAccess" } as const };
    const afterCheap = await x402For(spentKey).verify(cheapBody, near.requirements(cheapInput));
    const afterDear = await x402For(spentKey).verify(dearBody, near.requirements(dearInput));
    expect([afterCheap.ok, afterDear.ok]).toEqual([false, false]);
    for (const refusal of [afterCheap, afterDear]) {
      if (refusal.ok) throw new Error("a spent nonce must never verify");
      expect(refusal.kind).toBe("invalid");
      expect(refusal.reason).toContain("nonce_already_used");
    }
  });

  it("refuses a delegate that outlives the timeout it advertised (GW-5, GW-6)", async () => {
    // `max_block_height` is bounded from both sides: past it the payment is expired
    // (the test above), and *under* it — a delegate the payer minted against an
    // older block than the chain we are reading — the payment would sit valid long
    // after the `maxTimeoutSeconds` the payer was told, so the scheme refuses the
    // window rather than honouring it. The window is `ceil(60 / 1s)` = 60 blocks
    // (`computeTimeoutBlocks`, dist/cjs/exact/facilitator/index.js:192), and the
    // rest of this file reads the chain at +5, where the same payment verifies.
    const result = await x402For({ blockHeight: BigInt(BLOCK_HEIGHT - 5) }).verify(
      await mintPayment(requirementsFor()),
      requirements,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("timeout_window_exceeds_max_timeout");
  });

  it("refuses a delegate whose gas request exceeds the sponsored cap (PO-2)", async () => {
    // The delegate asks 30 TGas; a cap under that is a relayer that cannot pay.
    const near = x402For({}, 1_000_000_000_000n);
    const result = await near.verify(await mintPayment(requirementsFor()), requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("gas");
  });

  it("refuses a payer whose token balance does not cover the price (GW-5)", async () => {
    // GW-5 asks the gateway to check the balance before serving. Read from the
    // scheme: `verify` calls `ft_balance_of` on `delegate.senderId` — the account
    // the signature binds, not one the payer names in its body — and refuses
    // `balance < amount` (`dist/cjs/exact/facilitator/index.js:418`). So a short
    // balance is already refused here; what C8 still has to add is refusing it
    // *before* the upstream call, so the seller is not paid for a request that was
    // never going to settle.
    const short = await x402For({ ftBalance: 5_000n }).verify(
      await mintPayment(requirementsFor()),
      requirements,
    );
    expect(short.ok).toBe(false);
    if (short.ok) throw new Error("an underfunded payer must never verify");
    expect(short.reason).toContain("insufficient_funds");

    // The boundary is `<`, so exactly enough verifies. Off by one on the scheme's
    // side would either refuse paying customers or accept bounces.
    const exact = await x402For({ ftBalance: 10_000n }).verify(
      await mintPayment(requirementsFor()),
      requirements,
    );
    expect(exact.ok).toBe(true);
  });

  it("refuses a payee that is not registered for the token's storage (S1)", async () => {
    // S1's finding, executed rather than read: `verify` runs `storage_balance_of`
    // on `payTo` and refuses when the token implements NEP-145 and the account is
    // unregistered. It fires on the payer's request, so an unregistered seller
    // looks healthy until someone tries to pay.
    const unregistered = await x402For({ storage: { supported: true, registered: false } }).verify(
      await mintPayment(requirementsFor()),
      requirements,
    );
    expect(unregistered.ok).toBe(false);
    if (unregistered.ok) throw new Error("unreachable");
    expect(unregistered.reason).toContain("storage");

    // And the same payment is accepted when the token implements no storage at all.
    const noStorage = await x402For({ storage: { supported: false } }).verify(
      await mintPayment(requirementsFor()),
      requirements,
    );
    expect(noStorage.ok).toBe(true);
  });

  it("never reports a payment it could not check", async () => {
    // A signer whose chain read throws: the scheme catches it and fails closed, so
    // the outcome must be a refusal either way. Whether it arrives as `invalid`
    // (the scheme's own read-failure code) or `error` (something escaping the
    // library) is the library's choice and recorded here as measured, not assumed.
    const result = await x402For({ failOn: "height" }).verify(
      await mintPayment(requirementsFor()),
      requirements,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a failed chain read must never verify");
    expect(["invalid", "error"]).toContain(result.kind);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("refuses everything when no relayer is configured", async () => {
    const unconfigured = createX402Near({
      network: "near:testnet",
      maxSponsoredGas: 30_000_000_000_000n,
    });
    expect(unconfigured.configured).toBe(false);
    const result = await unconfigured.verify(await mintPayment(requirementsFor()), requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("unconfigured");
    expect(unconfigured.requirements(requirementsFor()).amount).toBe("10000");
    const settled = await unconfigured.settle(await mintPayment(requirementsFor()), requirements);
    expect([settled.ok, settled.ok ? "" : settled.kind]).toEqual([false, "unconfigured"]);
  });
});

describe("settle (GW-3)", () => {
  const requirements = x402For().requirements(requirementsFor());

  it("submits the delegate and reports the transaction hash", async () => {
    const chain = fakeChain();
    const near = createX402Near({
      network: "near:testnet",
      maxSponsoredGas: 30_000_000_000_000n,
      signer: chain.signer,
    });
    const result = await near.settle(await mintPayment(requirementsFor()), requirements);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.nearTxHash).toBe("test-tx-hash");
    expect(chain.submits.length).toBe(1);
  });

  it("refuses to call a reverted transfer settled", async () => {
    // The outer relayer transaction can land while the inner `ft_transfer` fails.
    // Recording that as `settled` would write a ledger entry for money that did
    // not move, so it comes back as a failure that still carries the hash.
    const near = x402For({
      submit: {
        transaction: "tx-reverted",
        innerReceipt: { kind: "failure", error: "Failed to call ft_transfer" },
      },
    });
    const result = await near.settle(await mintPayment(requirementsFor()), requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("invalid");
    expect(result.reason).toContain("settlement_failed");
    expect(result.nearTxHash).toBe("tx-reverted");
  });

  it("refuses a settlement that reports success with no transaction to point at", async () => {
    // A settled payment with a null hash cannot ever be matched against a swap
    // (reconcile joins on the hash, never on a timestamp), and it would leave the
    // dashboard with a revenue row no one can verify on a block explorer. So the
    // hash is part of what "settled" means, not a nicety.
    const near = x402For({
      submit: { transaction: "", innerReceipt: { kind: "success", value: "" } },
    });
    const result = await near.settle(await mintPayment(requirementsFor()), requirements);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("error");
    expect(result.reason).toContain("settle_succeeded_without_transaction_hash");
  });

  it("does not stop a sequential replay by itself, which is what the ledger is for", async () => {
    // The library's settlement cache only covers requests in flight together: its
    // settle path releases the key in a `finally`. Two settles of one delegate,
    // one after the other, therefore both submit. Nothing in this layer prevents
    // it, and the guarantee comes from the two guards that do: the payer's on-chain
    // access-key nonce, and `payments.replay_key` being unique with the
    // compare-and-set on state (`apps/api/test/payments.test.ts`). Pinned here as
    // measured behaviour, not as an aspiration.
    const chain = fakeChain();
    const near = createX402Near({
      network: "near:testnet",
      maxSponsoredGas: 30_000_000_000_000n,
      signer: chain.signer,
    });
    const body = await mintPayment(requirementsFor());
    const first = await near.settle(body, requirements);
    const second = await near.settle(body, requirements);
    expect([first.ok, second.ok, chain.submits.length]).toEqual([true, true, 2]);
  });

  it("refuses two settles of one delegate while the first is still in flight", async () => {
    // The window the in-process cache does close: without it, both callers would
    // see a successful outer transaction and both would hand a hash to the ledger.
    const chain = fakeChain();
    const near = createX402Near({
      network: "near:testnet",
      maxSponsoredGas: 30_000_000_000_000n,
      signer: chain.signer,
    });
    const body = await mintPayment(requirementsFor());
    const [first, second] = await Promise.all([
      near.settle(body, requirements),
      near.settle(body, requirements),
    ]);
    const successes = [first, second].filter((result) => result.ok).length;
    expect(successes).toBeLessThanOrEqual(1);
    expect(chain.submits.length).toBeLessThanOrEqual(1);
  });
});

describe("settlementStatus reads the chain for the boot sweep (C10)", () => {
  type TxCall = { readonly method: string; readonly params: readonly unknown[] };

  /** A JSON-RPC stub that answers `tx` with whatever this case calls an answer. */
  async function withTxStub(
    answer: (call: TxCall) => { result?: unknown; error?: unknown },
    run: (rpcUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const call = JSON.parse(body) as TxCall & { id: number };
        const reply = answer(call);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...reply }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await run(url);
    } finally {
      server.close();
    }
  }

  function nearWith(rpcUrl: string | undefined) {
    return createX402Near({
      network: "near:testnet",
      maxSponsoredGas: 30_000_000_000_000n,
      signer: fakeChain().signer,
      ...(rpcUrl === undefined ? {} : { rpcUrl }),
    });
  }

  it("asks `tx` for the exact hash under the relayer's account and calls a success settled", async () => {
    const seen: TxCall[] = [];
    await withTxStub(
      (call) => {
        seen.push({ method: call.method, params: call.params });
        return {
          result: {
            status: { SuccessValue: "" },
            receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
          },
        };
      },
      async (url) => {
        expect(await nearWith(url).settlementStatus("hash-ok")).toBe("settled");
      },
    );
    expect(seen).toEqual([{ method: "tx", params: ["hash-ok", RELAYER, "FINAL"] }]);
  });

  it("calls a failed final status failed", async () => {
    await withTxStub(
      () => ({ result: { status: { Failure: { ActionError: { index: 0 } } } } }),
      async (url) => {
        expect(await nearWith(url).settlementStatus("hash-failed")).toBe("failed");
      },
    );
  });

  it("reads a failed inner receipt as failed even when the outer transaction succeeded", async () => {
    // The delegate is wrapped: the relayer's transaction can land while the
    // `ft_transfer` it carried reverted. That is not money for the ledger.
    await withTxStub(
      () => ({
        result: {
          status: { SuccessValue: "" },
          receipts_outcome: [
            { outcome: { status: { SuccessReceiptId: "receipt-1" } } },
            { outcome: { status: { Failure: { ActionError: { index: 0 } } } } },
          ],
        },
      }),
      async (url) => {
        expect(await nearWith(url).settlementStatus("hash-inner-failed")).toBe("failed");
      },
    );
  });

  it("answers unknown for a node error, so nothing is booked or abandoned on a guess", async () => {
    await withTxStub(
      () => ({ error: { code: -32000, message: "transaction not found" } }),
      async (url) => {
        expect(await nearWith(url).settlementStatus("hash-missing")).toBe("unknown");
      },
    );
  });

  it("answers unknown with no URL or no account to ask as, rather than reaching the network", async () => {
    expect(await nearWith(undefined).settlementStatus("hash")).toBe("unknown");
    const anonymous = createX402Near({
      network: "near:testnet",
      maxSponsoredGas: 30_000_000_000_000n,
    });
    expect(await anonymous.settlementStatus("hash")).toBe("unknown");
  });
});
