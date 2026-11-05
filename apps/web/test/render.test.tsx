import type { CreationCheck, EndpointCreateInput, EndpointDto } from "@till/core/schemas";
import { endpointCreateSchema, endpointDtoSchema } from "@till/core/schemas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreateEndpointFormView } from "../components/domain/CreateEndpointForm.tsx";
import { CreationCheckResults } from "../components/domain/CreationCheckResults.tsx";
import { EndpointCard, EndpointList } from "../components/domain/EndpointCard.tsx";
import { SessionNotice } from "../components/domain/SessionNotice.tsx";
import type { EndpointCreateResult } from "../lib/api-client.ts";
import {
  FIELD_EXAMPLES,
  FIELD_LABELS,
  type FieldErrors,
  type FormField,
  emptyForm,
} from "../lib/endpoint-form.ts";

/**
 * The screens a seller reads (UI-2), rendered by `react-dom/server` and asserted as
 * text. There is no browser here and no DOM test framework, so this cannot prove a
 * click works — what it proves is that the markup says the right thing about the
 * data it was handed: live versus not-live, the reason beside the inactive endpoint,
 * a refusal as a sentence rather than a code, and a failure to reach Till as
 * neither an empty list nor a lie.
 */

/**
 * Fixtures are built by parsing them with the same schemas the app parses with, so
 * a money field is a branded string rather than a cast — which is the rule the
 * screen is meant to enforce, tested by obeying it here.
 */
const LIVE: EndpointDto = endpointDtoSchema.parse({
  id: "3b0c8b6a-2b0f-4a11-9c1d-2f4a6b8c0e11",
  slug: "abcdefghij",
  gatewayUrl: "https://gateway.test/r/abcdefghij",
  upstreamUrl: "https://data.seller.test/prices",
  priceAmount: "1250000",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "direct",
  active: true,
  description: "Live grain prices",
  creationWarnings: [],
});

const INACTIVE: EndpointDto = endpointDtoSchema.parse({
  ...LIVE,
  id: "7c2d9e0f-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  slug: "klmnopqrst",
  gatewayUrl: "https://gateway.test/r/klmnopqrst",
  active: false,
  description: null,
  creationWarnings: [
    "seller.testnet is not registered for usdc.testnet storage; register it first or payments would be refused.",
    "The price 0.00001 is below Till's 0.01 minimum.",
  ],
});

const CHECKS: CreationCheck[] = [
  { code: "network", ok: true, message: "Payments settle on near:testnet." },
  {
    code: "price_floor",
    ok: false,
    message: "The price 0.00001 is below Till's 0.01 minimum.",
  },
  { code: "upstream_url", ok: true, message: "The upstream URL is reachable under policy." },
  {
    code: "storage_registration",
    ok: false,
    message: "seller.testnet is not registered for usdc.testnet storage.",
  },
];

/**
 * React escapes what it renders — `Till's` comes out as `Till&#x27;s` — and a
 * seller reads the sentence, not the encoding, so the markup is unescaped before it
 * is compared. Nothing is normalised beyond that: order and presence are the claims.
 */
function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Order matters as much as presence: a fix the seller has to find is a fix missed. */
function appearsBefore(markup: string, first: string, second: string): boolean {
  return markup.indexOf(first) < markup.indexOf(second);
}

const VIEW_HANDLERS = {
  onEdit: () => undefined,
  onReview: () => undefined,
  onConfirm: () => undefined,
  onBack: () => undefined,
  onReset: () => undefined,
} as const;

describe("the endpoint list (UI-2)", () => {
  it("names an active endpoint as live and gives the seller the link to hand a buyer", () => {
    const markup = renderToStaticMarkup(<EndpointCard endpoint={LIVE} />);
    expect(markup).toContain("Live");
    expect(markup).toContain(LIVE.gatewayUrl);
    expect(text(markup)).toContain("1.25 usdc.testnet");
    expect(markup).toContain(LIVE.description ?? "");
    expect(markup).not.toContain("Why this one is not live");
  });

  it("shows why an inactive endpoint is inactive, from the row rather than the request", () => {
    // The list page has no creation response to lean on: these sentences come off
    // the row, which is what makes a reload after a week still explain itself (PO-2).
    const markup = renderToStaticMarkup(<EndpointCard endpoint={INACTIVE} />);
    expect(markup).toContain("Not live");
    expect(markup).toContain("Why this one is not live");
    for (const warning of INACTIVE.creationWarnings) {
      expect(text(markup)).toContain(warning);
    }
    expect(markup).not.toContain(">Live<");
  });

  it("draws a list of two newest-first, and an empty one as empty rather than as a failure", () => {
    const both = renderToStaticMarkup(<EndpointList endpoints={[LIVE, INACTIVE]} />);
    expect(appearsBefore(both, LIVE.slug, INACTIVE.slug)).toBe(true);

    const empty = text(renderToStaticMarkup(<EndpointList endpoints={[]} />));
    expect(empty).toContain("No endpoints yet");
    expect(empty).not.toMatch(/could not|not answering|failed/);
  });

  it("renders every endpoint it is given, so one row cannot vanish", () => {
    const markup = renderToStaticMarkup(<EndpointList endpoints={[LIVE, INACTIVE, LIVE]} />);
    expect(markup.match(/<article/g)?.length).toBe(3);
  });
});

describe("the creation checks a save answers with (PO-2)", () => {
  it("leads with what failed and counts it", () => {
    const markup = text(renderToStaticMarkup(<CreationCheckResults checks={CHECKS} />));
    expect(markup).toContain("2 checks to fix");
    expect(appearsBefore(markup, "price_floor", "network")).toBe(true);
    for (const check of CHECKS) {
      expect(markup).toContain(check.message);
    }
  });

  it("says one check in the singular, and says so when nothing failed", () => {
    const one = CHECKS.filter((check) => check.code !== "storage_registration");
    expect(text(renderToStaticMarkup(<CreationCheckResults checks={one} />))).toContain(
      "1 check to fix",
    );
    const allOk = CHECKS.filter((check) => check.ok);
    expect(text(renderToStaticMarkup(<CreationCheckResults checks={allOk} />))).toContain(
      "Every creation check passed",
    );
  });

  it("keeps the passed checks readable, because a seller may need to prove one ran", () => {
    const markup = text(renderToStaticMarkup(<CreationCheckResults checks={CHECKS} />));
    expect(markup).toContain("2 passed (network, upstream_url)");
  });

  it("survives the same code twice, which is what two accounts to check looks like", () => {
    const twice: CreationCheck[] = [
      ...CHECKS,
      { code: "storage_registration", ok: false, message: "refund.testnet is not registered." },
    ];
    const markup = text(renderToStaticMarkup(<CreationCheckResults checks={twice} />));
    expect(markup).toContain("3 checks to fix");
    expect(markup).toContain("refund.testnet is not registered.");
  });
});

describe("the three screens that are not a list (F1, UI-2)", () => {
  it("asks for a sign-in when there is no cookie to ask with", () => {
    const markup = renderToStaticMarkup(<SessionNotice kind="no-session" />);
    expect(text(markup)).toContain("Sign in with your NEAR wallet");
    expect(markup).toContain('href="/sign-in"');
  });

  it("says the session was refused, and does not claim the seller has nothing", () => {
    const markup = text(renderToStaticMarkup(<SessionNotice kind="session-refused" />));
    expect(markup).toContain("Sign in again");
    expect(markup).not.toContain("No endpoints yet");
  });

  it("says Till is not answering, quotes why, and offers no sign-in link", () => {
    const markup = renderToStaticMarkup(
      <SessionNotice detail="/api/endpoints returned 500" kind="unreachable" />,
    );
    expect(text(markup)).toContain("Till is not answering");
    expect(text(markup)).toContain("/api/endpoints returned 500");
    expect(markup).not.toContain("href=");
  });
});

describe("the create form, step by step (UI-2, PO-2)", () => {
  it("shows one labelled input per field, with an example rather than a guess", () => {
    const markup = renderToStaticMarkup(
      <CreateEndpointFormView
        busy={false}
        errors={{}}
        pending={null}
        result={null}
        values={emptyForm}
        {...VIEW_HANDLERS}
      />,
    );
    const words = text(markup);
    for (const label of Object.values(FIELD_LABELS)) {
      expect(words).toContain(label);
    }
    expect(markup).toContain(`placeholder="${FIELD_EXAMPLES.upstreamUrl}"`);
    expect(words).not.toContain("Confirm before Till saves");
  });

  it("puts each refusal sentence beside the field it names", () => {
    const errors: FieldErrors = {
      upstreamUrl: "Give the full https:// address of the API you are selling.",
      payoutMode: "Choose a payout mode: direct or intents.",
    };
    const words = text(
      renderToStaticMarkup(
        <CreateEndpointFormView
          busy={false}
          errors={errors}
          pending={null}
          result={null}
          values={emptyForm}
          {...VIEW_HANDLERS}
        />,
      ),
    );
    expect(words).toContain(errors.upstreamUrl ?? "");
    expect(words).toContain(errors.payoutMode ?? "");
    expect(appearsBefore(words, "Give the full https", "Description (optional)")).toBe(true);
  });

  const PENDING_INPUT: EndpointCreateInput = endpointCreateSchema.parse({
    upstreamUrl: "https://data.seller.test/prices",
    priceAmount: "1250000",
    assetContract: "usdc.testnet",
    network: "near:testnet",
    payoutMode: "direct",
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: "seller.testnet",
    refundAddress: "seller.testnet",
  });

  function confirmView(busy: boolean) {
    return (
      <CreateEndpointFormView
        busy={busy}
        errors={{}}
        pending={PENDING_INPUT}
        result={null}
        values={emptyForm}
        {...VIEW_HANDLERS}
      />
    );
  }

  it("confirms the destination and the price in both units before anything is saved", () => {
    const words = text(renderToStaticMarkup(confirmView(false)));
    expect(words).toContain("Confirm before Till saves this");
    expect(words).toContain("seller.testnet");
    expect(words).toContain("1.25 of usdc.testnet (1250000 base units)");
    expect(words).toContain("Confirm and create");
    expect(words).not.toContain("Live");
  });

  it("marks the confirm button as busy rather than letting a second click through", () => {
    const markup = renderToStaticMarkup(confirmView(true));
    const words = text(markup);
    expect(words).toContain("Saving");
    expect(words).not.toContain("Confirm and create");
    // The attribute, not the label: a disabled button is the thing that cannot be
    // clicked twice, and twice would be two payout routes for one confirmation.
    expect(markup).toMatch(/<button[^>]+disabled=""/);
  });

  function withResult(result: EndpointCreateResult) {
    return text(
      renderToStaticMarkup(
        <CreateEndpointFormView
          busy={false}
          errors={{}}
          pending={PENDING_INPUT}
          result={result}
          values={emptyForm}
          {...VIEW_HANDLERS}
        />,
      ),
    );
  }

  it("shows a live endpoint and its checks, which is what makes it usable in seconds", () => {
    const words = withResult({
      kind: "created",
      result: { endpoint: LIVE, checks: CHECKS.filter((check) => check.ok) },
    });
    expect(words).toContain("Live — this link now takes payment");
    expect(words).toContain(LIVE.gatewayUrl);
    expect(words).toContain("Every creation check passed");
  });

  it("shows an endpoint that was saved but left inactive, with the reasons", () => {
    const words = withResult({ kind: "created", result: { endpoint: INACTIVE, checks: CHECKS } });
    expect(words).toContain("Saved, but not live yet");
    expect(words).toContain("2 checks to fix");
    expect(words).toContain("register it first or payments would be refused");
  });

  it("names the address a refused confirmation disagreed with", () => {
    const words = withResult({
      kind: "rejected",
      error: {
        code: "destination_not_confirmed",
        message: "Confirm the destination address that was shown to you.",
        destinationAddress: "seller.testnet",
      },
    });
    expect(words).toContain("Till will pay out to");
    expect(words).toContain("seller.testnet");
    expect(words).not.toContain("Live");
  });

  it("sends a seller whose session ended to sign in, and says nothing was created", () => {
    const words = withResult({
      kind: "rejected",
      error: { code: "unauthenticated", message: "Sign in to create an endpoint." },
    });
    expect(words).toContain("Sign in again");
    expect(words).toContain("Till did not create anything");
  });

  it("turns the field refusals back into sentences instead of codes", () => {
    const words = withResult({
      kind: "rejected",
      error: {
        code: "invalid_request",
        message: "The endpoint could not be created from this body.",
        issues: [
          { path: "upstreamUrl", code: "invalid_string" },
          { path: "description", code: "too_big" },
        ],
      },
    });
    expect(words).toContain("Give the full https:// address of the API you are selling.");
    expect(words).toContain(`${FIELD_LABELS.description} is longer than Till accepts.`);
    expect(words).not.toMatch(/invalid_string|too_big/);
  });

  it("says nothing was saved when Till could not be reached", () => {
    const words = withResult({ kind: "unreachable", detail: "fetch failed: ECONNREFUSED" });
    expect(words).toContain("The dashboard could not reach Till");
    expect(words).toContain("Nothing was saved");
    expect(words).toContain("ECONNREFUSED");
    expect(words).not.toContain("No endpoints yet");
  });

  it("offers one way back to the form from every answer", () => {
    for (const result of [
      { kind: "created", result: { endpoint: LIVE, checks: [] } } as EndpointCreateResult,
      {
        kind: "rejected",
        error: { code: "invalid_json", message: "The request body is not JSON." },
      } as EndpointCreateResult,
      { kind: "unreachable", detail: "x" } as EndpointCreateResult,
    ]) {
      expect(withResult(result)).toContain("Create another");
    }
  });

  it("renders the payout mode as a choice of the two modes Till has", () => {
    const markup = renderToStaticMarkup(
      <CreateEndpointFormView
        busy={false}
        errors={{}}
        pending={null}
        result={null}
        values={{ ...emptyForm, payoutMode: "intents" }}
        {...VIEW_HANDLERS}
      />,
    );
    expect(markup).toContain('option value="direct"');
    expect(markup).toContain('option value="intents"');
    expect(markup).toContain('value="intents"');
    expect(FIELD_LABELS.payoutMode).toBeTruthy();
    expect((Object.keys(FIELD_EXAMPLES) as FormField[]).length).toBe(
      Object.keys(FIELD_LABELS).length,
    );
  });
});
