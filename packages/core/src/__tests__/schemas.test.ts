import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  baseUnitAmountSchema,
  fromBaseUnits,
  positiveBaseUnitAmountSchema,
} from "../schemas/common.ts";
import { endpointCreateSchema, endpointDtoSchema } from "../schemas/endpoint.ts";
import { ledgerEntryDtoSchema } from "../schemas/ledger.ts";
import { paymentDtoSchema, paymentRequirementsSchema } from "../schemas/payment.ts";
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
  scheme: "near-address",
  network: "near:testnet",
  amount: "10000",
  asset: "usdc.testnet",
  payTo: "seller.testnet",
  maxTimeoutSeconds: 60,
  output: { contentType: "application/json", description: "Prices" },
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
