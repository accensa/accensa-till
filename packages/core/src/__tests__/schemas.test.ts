import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  baseUnitAmountSchema,
  boundedArray,
  fromBaseUnits,
  positiveBaseUnitAmountSchema,
} from "../schemas/common.ts";
import {
  endpointCreateSchema,
  endpointDtoSchema,
  endpointUpdateRequestSchema,
  endpointUpdateResponseSchema,
  endpointUpdateSchema,
} from "../schemas/endpoint.ts";
import { ledgerEntryDtoSchema } from "../schemas/ledger.ts";
import { overviewDtoSchema } from "../schemas/overview.ts";
import {
  paymentDtoSchema,
  paymentPayloadSchema,
  paymentRequirementsSchema,
} from "../schemas/payment.ts";
import { swapDtoSchema } from "../schemas/swap.ts";

/**
 * G6 F1: a negative amount was valid at every JSON boundary, so `-1000000` could
 * arrive as an endpoint price or a payment amount and be written to a
 * `numeric(78,0)` column that has no CHECK on it. The schema is the only boundary
 * these fields cross before the database, so the sign rule belongs here.
 *
 * The rejecting tests are the point. The accepting ones pin the scope: the guard
 * covers amounts that must be positive and leaves the two places where a negative
 * is real information (a ledger correction, a provider-reported swap amount).
 */

const validEndpointCreate = {
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

const validEndpointDto = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "prices-7f3a",
  gatewayUrl: "https://till.example/r/prices-7f3a",
  upstreamUrl: "https://data.seller.test/prices",
  priceAmount: "10000",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "direct",
  active: true,
  description: null,
  creationWarnings: [],
} as const;

const validPaymentDto = {
  id: "00000000-0000-4000-8000-000000000000",
  endpointId: "00000000-0000-4000-8000-000000000001",
  routeId: null,
  payerAccountId: "payer.testnet",
  amount: "10000",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  state: "verified",
  nearTxHash: null,
  upstreamStatus: null,
  upstreamMs: null,
  verifiedAt: "2026-11-03T00:00:00Z",
  settledAt: null,
  selfPayment: false,
} as const;

const validSwapDto = {
  id: "00000000-0000-4000-8000-000000000002",
  routeId: "00000000-0000-4000-8000-000000000003",
  paymentId: null,
  providerRef: "mock:1",
  state: "processing",
  amountIn: "10000",
  amountOut: null,
  refundedAmount: null,
  originTxHash: null,
  destinationTxHash: null,
  lastPolledAt: null,
  terminalAt: null,
} as const;

const validLedgerDto = {
  id: "00000000-0000-4000-8000-000000000004",
  sellerId: "00000000-0000-4000-8000-000000000005",
  kind: "adjustment",
  amount: "-10000",
  asset: "usdc",
  paymentId: null,
  swapId: null,
  note: "corrected a double count",
  createdAt: "2026-11-03T00:00:00Z",
} as const;

const validRequirements = {
  scheme: "exact",
  network: "near:testnet",
  amount: "10000",
  asset: "usdc.testnet",
  payTo: "seller.testnet",
  maxTimeoutSeconds: 60,
  extra: {},
} as const;

const validPayload = {
  x402Version: 2,
  resource: { url: "https://till.example/r/prices-7f3a", mimeType: "application/json" },
  accepted: validRequirements,
  payload: { signedDelegateAction: "DQAAAHBheWVyLnRlc3RuZXQ".padEnd(120, "A") },
} as const;

describe("positive base unit amounts (G6 F1)", () => {
  it("accepts every positive integer string, including ones a float cannot hold", () => {
    for (const amount of ["1", "10000", "9007199254740993250000", "00007"]) {
      expect([amount, positiveBaseUnitAmountSchema.safeParse(amount).success]).toEqual([
        amount,
        true,
      ]);
    }
  });

  it("refuses zero, negatives, and everything that is not an integer string", () => {
    // An exception here is a failure too: safeParse must report these as invalid,
    // not throw, because a route that parses a request body has no catch for it.
    for (const amount of ["0", "-1", "-1000000", "-0", "", "1.5", "1e9", "+1", " 1", "abc"]) {
      expect([amount, positiveBaseUnitAmountSchema.safeParse(amount).success]).toEqual([
        amount,
        false,
      ]);
    }
  });

  it("keeps the brand, so a validated amount is still usable where money is expected", () => {
    const parsed = positiveBaseUnitAmountSchema.parse("10000");
    const asSigned: z.infer<typeof baseUnitAmountSchema> = parsed;
    expect(asSigned).toBe("10000");
  });
});

describe("endpoint price is positive (G6 F1)", () => {
  it("accepts a real price", () => {
    expect(endpointCreateSchema.safeParse(validEndpointCreate).success).toBe(true);
  });

  it("refuses a negative and a zero price at creation", () => {
    for (const priceAmount of ["-1000000", "0", "-0"]) {
      const parsed = endpointCreateSchema.safeParse({ ...validEndpointCreate, priceAmount });
      expect([priceAmount, parsed.success]).toEqual([priceAmount, false]);
    }
  });

  it("refuses a negative price on the way out too, so a bad row is not served", () => {
    expect(endpointDtoSchema.safeParse(validEndpointDto).success).toBe(true);
    expect(
      endpointDtoSchema.safeParse({ ...validEndpointDto, priceAmount: "-1000000" }).success,
    ).toBe(false);
  });
});

describe("payment amount is positive (G6 F1)", () => {
  it("accepts a real payment and refuses a negative or zero one", () => {
    expect(paymentDtoSchema.safeParse(validPaymentDto).success).toBe(true);
    for (const amount of ["-1000000", "0"]) {
      expect([amount, paymentDtoSchema.safeParse({ ...validPaymentDto, amount }).success]).toEqual([
        amount,
        false,
      ]);
    }
  });

  it("refuses to advertise a negative price to a payer (GW-1 requirements body)", () => {
    expect(paymentRequirementsSchema.safeParse(validRequirements).success).toBe(true);
    expect(
      paymentRequirementsSchema.safeParse({ ...validRequirements, amount: "-10000" }).success,
    ).toBe(false);
  });

  it("refuses a scheme name that is not the one the payer's wallet matches on (C1)", () => {
    // The counterparty picks a requirement by comparing `scheme` and `network`, so
    // a name of our own invention is an endpoint that can never be paid.
    for (const scheme of ["near-address", "near", "exact ", ""]) {
      expect([
        scheme,
        paymentRequirementsSchema.safeParse({ ...validRequirements, scheme }).success,
      ]).toEqual([scheme, false]);
    }
  });
});

/**
 * C1: the body a buyer posts is untrusted input that goes straight into the
 * verifier, so its shape is bounded here rather than by whatever the library
 * happens to tolerate.
 */
describe("the buyer's payment payload is bounded (C1)", () => {
  it("accepts a well-formed v2 payload", () => {
    expect(paymentPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it("refuses the other x402 version, whose field names mean different things", () => {
    for (const x402Version of [1, 3, 0]) {
      expect([
        x402Version,
        paymentPayloadSchema.safeParse({ ...validPayload, x402Version }).success,
      ]).toEqual([x402Version, false]);
    }
  });

  it("refuses an absent, empty or absurdly large signed delegate action", () => {
    for (const signedDelegateAction of ["", "short", "A".repeat(4097)]) {
      const parsed = paymentPayloadSchema.safeParse({
        ...validPayload,
        payload: { signedDelegateAction },
      });
      expect([signedDelegateAction.length, parsed.success]).toEqual([
        signedDelegateAction.length,
        false,
      ]);
    }
    expect(paymentPayloadSchema.safeParse({ ...validPayload, payload: {} }).success).toBe(false);
  });

  it("refuses a payload that carries a negative price in its accepted requirements", () => {
    // The verifier is handed our cached requirements, not this field, but the
    // shape still has to refuse the sign rather than pass it through (G6 F1).
    expect(
      paymentPayloadSchema.safeParse({
        ...validPayload,
        accepted: { ...validRequirements, amount: "-1" },
      }).success,
    ).toBe(false);
  });

  it("takes v2's resource as an object, not the v1 URL string", () => {
    // v1 put a bare `resource: string` in PaymentRequirements; v2's payload
    // carries a ResourceInfo with a required `url`. Accepting the string here
    // would mean the shape we validate is not the shape we forward.
    expect(paymentPayloadSchema.safeParse({ ...validPayload, resource: undefined }).success).toBe(
      true,
    );
    for (const resource of [
      "https://till.example/r/prices-7f3a",
      {},
      { url: "" },
      { url: "not a url" },
      { url: "https://till.example", tags: Array.from({ length: 33 }, (_, i) => `t${i}`) },
    ]) {
      expect(paymentPayloadSchema.safeParse({ ...validPayload, resource }).success).toBe(false);
    }
    expect(
      paymentPayloadSchema.safeParse({
        ...validPayload,
        resource: { url: "https://till.example", tags: ["prices"], description: "x".repeat(2000) },
      }).success,
    ).toBe(true);
  });

  it("refuses a network with no chain namespace", () => {
    // The library types `network` as `${string}:${string}`, so `testnet` is not a
    // network at all and would fail at settlement, after the payer was served.
    for (const network of ["testnet", "", "near:", ":testnet", "near:testnet:extra"]) {
      const parsed = paymentPayloadSchema.safeParse({
        ...validPayload,
        accepted: { ...validRequirements, network },
      });
      expect([network, parsed.success]).toEqual([network, false]);
    }
    for (const network of ["near:testnet", "near:mainnet", "eip155:84532"]) {
      expect(
        paymentPayloadSchema.safeParse({
          ...validPayload,
          accepted: { ...validRequirements, network },
        }).success,
      ).toBe(true);
    }
  });
});

describe("money that is allowed to be negative stays signed (G6 F1 scope)", () => {
  it("accepts a negative ledger adjustment, because a correction is a signed row", () => {
    expect(ledgerEntryDtoSchema.safeParse(validLedgerDto).success).toBe(true);
    expect(
      ledgerEntryDtoSchema.safeParse({ ...validLedgerDto, kind: "payment_in", amount: "10000" })
        .success,
    ).toBe(true);
  });

  it("records a provider amount exactly as it arrived, even an absurd one", () => {
    // The swap DTO mirrors what the provider reported. Rejecting "-5" here would
    // drop the payload; payout-shortfall turns a negative amountOut into a
    // discrepancy instead, which is the response a seller can act on.
    expect(swapDtoSchema.safeParse({ ...validSwapDto, amountOut: "-5" }).success).toBe(true);
  });

  it("leaves the signed schema unchanged, so sums of ledger rows still validate", () => {
    expect(baseUnitAmountSchema.safeParse("-1").success).toBe(true);
    expect(fromBaseUnits(-1n)).toBe("-1");
  });
});

/**
 * D9 (PO-7): what a seller may change on an endpoint that already exists.
 *
 * The shape of this body is the whole boundary. A payment snapshots its price and
 * its route at verify time, so a change cannot reach an earlier row — but a body
 * that could name an `id`, a `sellerId` or the token an endpoint charges in would
 * let a request do the things the snapshot cannot protect against. So those are
 * refused here, by name, rather than ignored: zod drops unknown keys by default,
 * and an ignored `sellerId` is a bug waiting for a caller that assumes it was
 * honoured.
 */
describe("endpointUpdateSchema (D9, PO-7)", () => {
  it("accepts a price-only change and leaves the rest unset", () => {
    const parsed = endpointUpdateSchema.safeParse({ priceAmount: "25000" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.priceAmount).toBe("25000");
      expect(parsed.data.payoutMode).toBeUndefined();
      expect(parsed.data.destinationAddress).toBeUndefined();
    }
  });

  it("accepts a destination change with its confirmation echo beside it", () => {
    const parsed = endpointUpdateRequestSchema.safeParse({
      payoutMode: "intents",
      destinationAddress: "0x742d35cc6634c0532923a5f8",
      confirmedAddress: "0x742d35cc6634c0532923a5f8",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a body that changes nothing", () => {
    // Not pedantry: an empty change is a write of the same values, a fresh set of
    // check messages and a log line for an edit that did not happen.
    expect(endpointUpdateSchema.safeParse({}).success).toBe(false);
    expect(endpointUpdateRequestSchema.safeParse({ confirmedAddress: "a.testnet" }).success).toBe(
      false,
    );
  });

  it("refuses the fields a change is not allowed to reach, naming each one", () => {
    const cases = [
      ["network", "near:mainnet"],
      ["assetContract", "usdc"],
      ["id", "00000000-0000-4000-8000-000000000001"],
      ["slug", "someone-elses-name"],
      ["sellerId", "00000000-0000-4000-8000-000000000002"],
      ["routeId", "00000000-0000-4000-8000-000000000003"],
    ] as const;
    for (const [field, value] of cases) {
      const parsed = endpointUpdateSchema.safeParse({ priceAmount: "25000", [field]: value });
      expect([field, parsed.success]).toEqual([field, false]);
      if (!parsed.success) {
        expect([field, parsed.error.issues[0]?.code]).toEqual([field, "unrecognized_keys"]);
        expect(parsed.error.issues[0]?.message).toContain(field);
      }
    }
  });

  it("holds the money boundary on the way in, the same way creation does", () => {
    for (const price of ["-1", "0", "1.5", "1e3", "abc", ""]) {
      expect(endpointUpdateSchema.safeParse({ priceAmount: price }).success).toBe(false);
    }
    expect(endpointUpdateSchema.safeParse({ priceAmount: "10000" }).success).toBe(true);
  });

  it("refuses a non-boolean active and a description past its cap", () => {
    expect(endpointUpdateSchema.safeParse({ active: "true" }).success).toBe(false);
    expect(endpointUpdateSchema.safeParse({ description: "x".repeat(501) }).success).toBe(false);
    expect(endpointUpdateSchema.safeParse({ description: "new price" }).success).toBe(true);
  });

  it("answers with the endpoint and every check, in the shape create already uses", () => {
    const parsed = endpointUpdateResponseSchema.safeParse({
      endpoint: validEndpointDto,
      checks: [
        {
          code: "price_floor",
          ok: true,
          message: "The price is at or above the configured floor.",
        },
      ],
    });
    expect(parsed.success).toBe(true);

    // An undeclared check code is a parse error here rather than an unmapped code
    // in the dashboard, which is the same reason the create response declares them.
    const drifted = endpointUpdateResponseSchema.safeParse({
      endpoint: validEndpointDto,
      checks: [{ code: "some_new_check", ok: false, message: "nope" }],
    });
    expect(drifted.success).toBe(false);
  });
});

/**
 * C15: every array at the JSON boundary is bounded.
 *
 * The zod advisory C14 declined to upgrade for is reachable in exactly one shape
 * here: an array schema with no length cap, fed a large array. zod v3 accumulates
 * one issue object per failing element and `error.format()` turns them into a
 * string, so a hostile payload costs memory and CPU on the way to a 400. The
 * measured cost, before this task: 200 000 wrong-typed elements against an
 * uncapped `z.array(z.string())` produced 200 000 issues and an 11 488 904-byte
 * formatted error in 569 ms. `.max()` on its own does not fix that — it runs
 * after the elements are parsed, so the same payload produced 200 001 issues.
 * The bound has to come before the elements are looked at, which is what
 * `boundedArray` does and what the hostile-payload test below pins.
 */
describe("arrays are bounded (C15)", () => {
  const warnings = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `warning ${index}`);
  const assetRow = {
    asset: "usdc.testnet",
    settledAmount: "10000",
    inTransitAmount: "0",
    paidOutAmount: "0",
    refundedAmount: "0",
  };
  const overviewWith = (byAsset: unknown) =>
    overviewDtoSchema.safeParse({
      byAsset,
      openDiscrepancies: 0,
      servedUnsettledCount: 0,
    });

  it("accepts an endpoint's creation warnings up to the cap, all of them", () => {
    const parsed = endpointDtoSchema.safeParse({
      ...validEndpointDto,
      creationWarnings: warnings(16),
    });
    expect(parsed.success).toBe(true);
    // The gate must not trim a payload it accepts: a truncated list would tell the
    // seller their endpoint has fewer problems than it does.
    if (parsed.success) expect(parsed.data.creationWarnings).toEqual(warnings(16));
  });

  it("refuses one warning past the cap, and names the cap", () => {
    const parsed = endpointDtoSchema.safeParse({
      ...validEndpointDto,
      creationWarnings: warnings(17),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.length).toBe(1);
      expect(parsed.error.issues[0]?.message).toContain("at most 16");
    }
  });

  it("accepts an asset row up to its cap and refuses one past it", () => {
    expect(overviewWith(new Array(32).fill(assetRow)).success).toBe(true);
    const over = overviewWith(new Array(33).fill(assetRow));
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.issues[0]?.message).toContain("at most 32");
  });

  it("keeps a hostile array small on the way out, for both boundaries", () => {
    // One issue per element is the cost this closes. The cap is the bound, so the
    // assertion is stated against it rather than against a tuned constant.
    const hostile = new Array(200_000).fill(123);
    const cases = [
      [
        "creationWarnings",
        endpointDtoSchema.safeParse({ ...validEndpointDto, creationWarnings: hostile }),
        16,
      ],
      ["byAsset", overviewWith(hostile), 32],
    ] as const;
    for (const [field, parsed, cap] of cases) {
      expect([field, parsed.success]).toEqual([field, false]);
      if (!parsed.success) {
        const bytes = JSON.stringify(parsed.error.format()).length;
        expect([field, parsed.error.issues.length]).toEqual([field, cap + 2]);
        expect([field, bytes < 5_000]).toEqual([field, true]);
      }
    }
  });

  it("bounds the work a bare element schema would still do", () => {
    // `boundedArray` on its own, so the guard is pinned at the helper and not only
    // through the two DTOs that happen to use it today.
    const schema = boundedArray(z.string(), 4);
    expect(schema.safeParse(["a", "b", "c", "d"]).success).toBe(true);
    const hostile = new Array(200_000).fill(123);
    const parsed = schema.safeParse(hostile);
    expect(parsed.success).toBe(false);
    // max + 1 element issues, because that is how many entries the gate lets
    // through, plus the one the cap itself raises.
    if (!parsed.success) expect(parsed.error.issues.length).toBe(6);

    // The rejected alternative replaced an over-cap array with `null` before
    // parsing, which bounded the work but reported "Expected array, received
    // null" for an array that was simply too long. A refusal a seller can read is
    // part of the contract, so the messages for the other shapes stay truthful.
    const short = schema.safeParse(["a", 1, "c"]);
    if (!short.success)
      expect(short.error.issues[0]?.message).toBe("Expected string, received number");
    const notAnArray = schema.safeParse("abc");
    if (!notAnArray.success) {
      expect(notAnArray.error.issues[0]?.message).toContain("Expected array, received string");
    }
  });
});
