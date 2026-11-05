import { formatAmount, parseAmount } from "@till/core/money";
import { endpointCreateRequestSchema, positiveBaseUnitAmountSchema } from "@till/core/schemas";
import { describe, expect, it } from "vitest";

import {
  type EndpointFormValues,
  FIELD_EXAMPLES,
  FIELD_LABELS,
  type FormField,
  buildCreateInput,
  confirmationRows,
  createBody,
  emptyForm,
  fieldErrorsFromIssues,
  issueCopy,
  orderChecks,
} from "../lib/endpoint-form.ts";

/**
 * The create form's rules (UI-2, PO-1/PO-2), run without a browser: what the seller
 * typed becomes what is sent, what is blamed when a field is wrong, and what the
 * confirmation step vouches for. The rendering of the same screens is in
 * `render.test.tsx`; the HTTP shapes are in `api-client.test.ts`.
 */

const VALID: EndpointFormValues = {
  ...emptyForm,
  upstreamUrl: "https://data.seller.test/prices",
  priceAmount: "1.25",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "direct",
  destinationChain: "near",
  destinationAsset: "usdc",
  destinationAddress: "seller.testnet",
  refundAddress: "seller.testnet",
};

function filled(overrides: Partial<EndpointFormValues> = {}): EndpointFormValues {
  return { ...VALID, ...overrides };
}

function build(overrides: Partial<EndpointFormValues> = {}) {
  return buildCreateInput(filled(overrides));
}

function expectErrors(
  result: ReturnType<typeof buildCreateInput>,
): Partial<Record<FormField, string>> {
  if (result.ok) {
    throw new Error("expected the form to refuse what was typed");
  }
  return result.errors;
}

describe("the price the seller types is the price Till charges (hard rule 3)", () => {
  it("turns a decimal amount into base units as a string, never through a float", () => {
    const result = build();
    if (!result.ok) {
      throw new Error(`the valid form was refused: ${JSON.stringify(result.errors)}`);
    }
    expect(result.input.priceAmount).toBe("1250000");
    expect(positiveBaseUnitAmountSchema.safeParse(result.input.priceAmount).success).toBe(true);
    // The round trip the confirmation screen depends on.
    expect(formatAmount(BigInt(result.input.priceAmount))).toBe("1.25");
    expect(parseAmount("1.25")).toBe(1_250_000n);
  });

  it("refuses a price with more precision than a stablecoin has", () => {
    expect(expectErrors(build({ priceAmount: "0.0000001" })).priceAmount).toMatch(
      /six decimal places/,
    );
  });

  it("refuses a price that is not a number, and one that is signed", () => {
    expect(expectErrors(build({ priceAmount: "one" })).priceAmount).toMatch(/plain number/);
    expect(expectErrors(build({ priceAmount: "" })).priceAmount).toMatch(/plain number/);
    // "-1" converts cleanly and is refused by the schema's positivity rule (G6 F1),
    // which is the second net, and the copy still names the price.
    const negative = expectErrors(build({ priceAmount: "-1" }));
    expect(negative.priceAmount).toMatch(/above zero/);
  });

  it("keeps a whole-unit price exact", () => {
    const result = build({ priceAmount: "1000000" });
    if (!result.ok) {
      throw new Error("a whole million should convert");
    }
    expect(result.input.priceAmount).toBe("1000000000000");
  });
});

describe("what the form sends", () => {
  it("trims every field and drops a blank description", () => {
    const result = build({
      upstreamUrl: "  https://data.seller.test/prices  ",
      description: "   ",
    });
    if (!result.ok) {
      throw new Error(`a trimmed form must still be valid: ${JSON.stringify(result.errors)}`);
    }
    expect(result.input.upstreamUrl).toBe("https://data.seller.test/prices");
    expect("description" in result.input).toBe(false);

    const written = build({ description: "Live grain prices" });
    if (!written.ok) {
      throw new Error("a written description must survive");
    }
    expect(written.input.description).toBe("Live grain prices");
  });

  it("echoes the destination it showed as the confirmation (PO-2)", () => {
    const result = build();
    if (!result.ok) {
      throw new Error("the valid form must be buildable");
    }
    const body = createBody(result.input);
    expect(body.confirmedAddress).toBe(result.input.destinationAddress);
    expect(endpointCreateRequestSchema.safeParse(body).success).toBe(true);

    // The echo is derived from the input, not from a second read of the field:
    // changing what is typed changes both halves together, which is the whole point.
    const other = build({ destinationAddress: "another.testnet" });
    if (!other.ok) {
      throw new Error("a second valid destination must be buildable");
    }
    expect(createBody(other.input).confirmedAddress).toBe("another.testnet");
  });

  it("shows the seller exactly the fields the confirmation vouches for", () => {
    const result = build();
    if (!result.ok) {
      throw new Error("the valid form must be buildable");
    }
    const rows = confirmationRows(result.input);
    const labels = rows.map((row) => row.label);
    expect(labels).toEqual([
      FIELD_LABELS.upstreamUrl,
      FIELD_LABELS.priceAmount,
      FIELD_LABELS.network,
      FIELD_LABELS.payoutMode,
      FIELD_LABELS.destinationChain,
      FIELD_LABELS.destinationAsset,
      FIELD_LABELS.destinationAddress,
      FIELD_LABELS.refundAddress,
    ]);
    // Money shown in both units, so a rounding mistake cannot hide.
    expect(rows[1]?.value).toBe("1.25 of usdc.testnet (1250000 base units)");
    expect(rows[6]?.value).toBe("seller.testnet");
    expect(confirmationRows({ ...result.input, description: "Grain" }).length).toBe(9);
  });
});

describe("an invalid form says which field, in one pass (UI-2)", () => {
  it("blames every required field at once and none of the optional ones", () => {
    const errors = expectErrors(buildCreateInput(emptyForm));
    expect(Object.keys(errors).sort()).toEqual(
      [
        "assetContract",
        "destinationAddress",
        "destinationAsset",
        "destinationChain",
        "network",
        "payoutMode",
        "priceAmount",
        "refundAddress",
        "upstreamUrl",
      ].sort(),
    );
    expect(errors.description).toBeUndefined();
  });

  it("never answers a field with a zod code", () => {
    const errors = expectErrors(buildCreateInput(emptyForm));
    for (const copy of Object.values(errors)) {
      expect(copy).toBeTruthy();
      expect(copy).not.toMatch(/too_small|too_big|invalid_string|invalid_type|expected/);
    }
    // A field's own name is how a seller finds it again in a ten-field form, and an
    // empty URL is refused by the URL rule, which says something better than "empty".
    expect(errors.network).toBe(`${FIELD_LABELS.network} cannot be empty.`);
    expect(errors.upstreamUrl).toMatch(/^Give the full https/);
  });

  it("refuses an http upstream and an oversized description, and leaves an account's shape to Till", () => {
    expect(
      expectErrors(build({ upstreamUrl: "http://data.seller.test/prices" })).upstreamUrl,
    ).toMatch(/https/);
    expect(expectErrors(build({ description: "x".repeat(501) })).description).toMatch(
      /longer than Till accepts/,
    );

    // A wrong-shaped NEAR account is not this form's to judge. `endpointCreateSchema`
    // asks only for a non-empty string; the `refund_address` and `direct_destination`
    // creation checks answer with the account they expected, in a sentence that names
    // it (PO-2). Refusing it here would be a second rule about the same account.
    const odd = build({ refundAddress: "Not An Account" });
    if (!odd.ok) {
      throw new Error("the form must not invent a rule the schema does not have");
    }
    expect(odd.input.refundAddress).toBe("Not An Account");
  });

  it("reports a field the API refused by the same sentence, whoever refused it", () => {
    const fromApi = fieldErrorsFromIssues([
      { path: "upstreamUrl", code: "invalid_string" },
      { path: "priceAmount", code: "too_small" },
      { path: "mysteryField", code: "too_small" },
    ]);
    expect(Object.keys(fromApi)).toEqual(["upstreamUrl", "priceAmount"]);
    expect(fromApi.upstreamUrl).toBe(issueCopy("upstreamUrl", "invalid_string"));
    expect(fromApi.priceAmount).toBe(issueCopy("priceAmount", "too_small"));
  });

  it("takes the first refusal for a field, so one field is one sentence", () => {
    const errors = fieldErrorsFromIssues([
      { path: "network", code: "too_small" },
      { path: "network", code: "invalid_string" },
    ]);
    expect(Object.keys(errors)).toEqual(["network"]);
  });

  it("accepts every example the form prints in its placeholders", () => {
    // A placeholder the API would refuse is the dashboard pointing the seller at a
    // wrong answer, so the examples are held to the same schema as the input.
    const fromExamples: EndpointFormValues = {
      ...emptyForm,
      ...(Object.fromEntries(
        (Object.keys(FIELD_EXAMPLES) as FormField[]).map((field) => [field, FIELD_EXAMPLES[field]]),
      ) as Record<FormField, string>),
    };
    const result = buildCreateInput(fromExamples);
    if (!result.ok) {
      throw new Error(`an example the form shows was refused: ${JSON.stringify(result.errors)}`);
    }
    expect(result.input.payoutMode).toBe("direct");
  });
});

describe("the checks a creation answers with, in the order a seller needs", () => {
  const checks = [
    { code: "network", ok: true, message: "Payments settle on near:testnet." },
    { code: "price_floor", ok: false, message: "The price 0.00001 is below Till's 0.01 minimum." },
    { code: "upstream_url", ok: true, message: "The upstream URL is reachable." },
    { code: "storage_registration", ok: false, message: "seller.testnet is not registered." },
  ] as const;

  it("puts the failures first and keeps the passed ones as a record", () => {
    const { failed, passed } = orderChecks(checks);
    expect(failed.map((check) => check.code)).toEqual(["price_floor", "storage_registration"]);
    expect(passed.map((check) => check.code)).toEqual(["network", "upstream_url"]);
  });

  it("does not lose a check when one fails", () => {
    const { failed, passed } = orderChecks(checks);
    expect(failed.length + passed.length).toBe(checks.length);
  });
});
