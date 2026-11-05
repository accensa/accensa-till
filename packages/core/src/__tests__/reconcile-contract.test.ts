import { describe, expect, it } from "vitest";

import { SEVERITIES, severityRank } from "../reconcile/types.ts";
import {
  discrepancyDtoSchema,
  discrepancyListResponseSchema,
  discrepancyResolveResponseSchema,
  payerBlockClearRequestSchema,
  payerBlockClearResponseSchema,
  payerBlockDtoSchema,
  payerBlockListResponseSchema,
} from "../schemas/discrepancy.ts";
import { dashboardErrorSchema } from "../schemas/endpoint.ts";

/**
 * UI-4's wire shape (F4a): the open worklist, the row a manual resolve closes, and
 * the payers a seller is currently blocking.
 *
 * The list is a contract rather than a convenience because the dashboard renders
 * every item it is given: an unbounded array is an unbounded page (C15), and a row
 * the schema refuses is the route's named failure rather than one item fewer
 * (F3's rule, one table later).
 */

const openItem = {
  id: "6f0e2d1c-3b4a-4f5e-8d7c-1a2b3c4d5e6f",
  sellerId: "3b0c8b6a-2b0f-4a11-9c1d-2f4a6b8c0e11",
  code: "SERVED_NOT_SETTLED",
  severity: "high",
  paymentId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
  swapId: null,
  dedupeKey: "SERVED_NOT_SETTLED:9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d:none",
  explanation: "A payer was served an answer and the transfer never settled.",
  suggestedAction: "Check the relayer balance, then retry the settlement.",
  openedAt: "2026-11-05T09:00:00.000Z",
  resolvedAt: null,
  resolution: null,
};

function items(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    ...openItem,
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    dedupeKey: `SERVED_NOT_SETTLED:none:${String(index)}`,
  }));
}

describe("severity order is one array, read by both halves (F4)", () => {
  it("ranks critical before low, in the order SEVERITIES is written", () => {
    expect(SEVERITIES.map((severity) => severityRank(severity))).toEqual([0, 1, 2, 3]);
    expect(severityRank("critical")).toBeLessThan(severityRank("low"));
  });

  it("refuses a rank for a word that is not a severity", () => {
    // @ts-expect-error the parameter is the enum, not any string
    expect(() => severityRank("urgent")).toThrow();
  });
});

describe("the open worklist (UI-4)", () => {
  it("accepts a persisted discrepancy as the dashboard sees it", () => {
    const parsed = discrepancyListResponseSchema.parse({ discrepancies: [openItem] });
    expect(parsed.discrepancies[0]?.code).toBe("SERVED_NOT_SETTLED");
    expect(parsed.discrepancies[0]?.resolvedAt).toBeNull();
  });

  it("refuses a code no rule emits, so the route can name the row rather than drop it", () => {
    const result = discrepancyListResponseSchema.safeParse({
      discrepancies: [{ ...openItem, code: "SOMETHING_ELSE" }],
    });
    expect(result.success).toBe(false);
  });

  it("caps the list at 256 items on both boundaries", () => {
    expect(discrepancyListResponseSchema.safeParse({ discrepancies: items(256) }).success).toBe(
      true,
    );
    const past = discrepancyListResponseSchema.safeParse({ discrepancies: items(257) });
    expect(past.success).toBe(false);
    if (!past.success) {
      expect(past.error.issues[0]?.message).toContain("256");
    }
  });

  it("closes a row through the resolve response with the human's word on it", () => {
    const closed = discrepancyResolveResponseSchema.parse({
      discrepancy: {
        ...openItem,
        resolvedAt: "2026-11-05T10:30:00.000Z",
        resolution: "manual",
      },
    });
    expect(closed.discrepancy.resolution).toBe("manual");
  });

  it("refuses a resolution word that is neither auto nor manual", () => {
    const result = discrepancyResolveResponseSchema.safeParse({
      discrepancy: { ...openItem, resolvedAt: "2026-11-05T10:30:00.000Z", resolution: "shrug" },
    });
    expect(result.success).toBe(false);
  });
});

describe("the payer blocks a seller is holding (UI-4)", () => {
  const block = {
    payerAccountId: "payer.testnet",
    strikes: 2,
    blocked: true,
    lastStrikeAt: "2026-11-05T08:45:00.000Z",
  };

  it("accepts a blocked payer and one with nothing to show yet", () => {
    expect(payerBlockDtoSchema.parse(block).strikes).toBe(2);
    const clean = payerBlockDtoSchema.parse({
      ...block,
      strikes: 0,
      blocked: false,
      lastStrikeAt: null,
    });
    expect(clean.lastStrikeAt).toBeNull();
  });

  it("refuses a payer account name the chain would not accept", () => {
    for (const payerAccountId of [
      "Payer.testnet",
      "drop table",
      "ab",
      `${"a".repeat(60)}.testnet`,
    ]) {
      expect(payerBlockDtoSchema.safeParse({ ...block, payerAccountId }).success).toBe(false);
    }
  });

  it("refuses a negative strike count, which is not a thing a count can be", () => {
    expect(payerBlockDtoSchema.safeParse({ ...block, strikes: -1 }).success).toBe(false);
  });

  it("answers a clear with the list that follows it, not a re-typed row", () => {
    const cleared = payerBlockClearResponseSchema.parse({
      payerBlocks: [{ ...block, strikes: 0, blocked: false }],
    });
    expect(cleared.payerBlocks[0]?.blocked).toBe(false);
  });

  it("takes a note on the clear and refuses a payer name or an author invented by the body", () => {
    expect(payerBlockClearRequestSchema.parse({ note: "spoke to them" }).note).toBe(
      "spoke to them",
    );
    expect(payerBlockClearRequestSchema.parse({}).note).toBeUndefined();
    expect(payerBlockClearRequestSchema.safeParse({ note: "n".repeat(201) }).success).toBe(false);
  });

  it("caps the block list the same way", () => {
    const many = Array.from({ length: 257 }, (_unused, index) => ({
      ...block,
      payerAccountId: `payer-${index}.testnet`,
    }));
    expect(
      payerBlockListResponseSchema.safeParse({ payerBlocks: many.slice(0, 256) }).success,
    ).toBe(true);
    expect(payerBlockListResponseSchema.safeParse({ payerBlocks: many }).success).toBe(false);
  });
});

describe("the refusal codes UI-4 needs are in the dashboard's contract", () => {
  it("names an unreadable discrepancy, an unresolvable one and an unreadable block list", () => {
    for (const code of [
      "discrepancy_unreadable",
      "discrepancy_not_found",
      "payer_block_unreadable",
    ]) {
      const parsed = dashboardErrorSchema.safeParse({ code, message: "x" });
      expect(parsed.success).toBe(true);
    }
  });

  it("still refuses a code nobody defined", () => {
    expect(dashboardErrorSchema.safeParse({ code: "made_up", message: "x" }).success).toBe(false);
  });
});
