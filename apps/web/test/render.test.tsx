import type {
  CreationCheck,
  EndpointCreateInput,
  EndpointDto,
  EndpointUpdateResponse,
} from "@till/core/schemas";
import {
  endpointCreateSchema,
  endpointDtoSchema,
  endpointUpdateResponseSchema,
} from "@till/core/schemas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreateEndpointFormView } from "../components/domain/CreateEndpointForm.tsx";
import { CreationCheckResults } from "../components/domain/CreationCheckResults.tsx";
import { EndpointCard, EndpointList } from "../components/domain/EndpointCard.tsx";
import { EndpointEditorView } from "../components/domain/EndpointEditor.tsx";
import { SessionNotice } from "../components/domain/SessionNotice.tsx";
import type { EndpointCreateResult, EndpointUpdateResult } from "../lib/api-client.ts";
import { EDIT_FIELD_ORDER, type EditFormValues, editInitial } from "../lib/endpoint-edit.ts";
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
  route: {
    id: "9e1f2a3b-4c5d-4e6f-8a7b-0c1d2e3f4a5b",
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: "seller.testnet",
    refundAddress: "seller.testnet",
    provider: "mock",
    depositAddress: null,
    modeDetail: "direct",
  },
  creationWarnings: [],
});

const INACTIVE: EndpointDto = endpointDtoSchema.parse({
  ...LIVE,
  id: "7c2d9e0f-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  slug: "klmnopqrst",
  gatewayUrl: "https://gateway.test/r/klmnopqrst",
  active: false,
  description: null,
  route: null,
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

  it("names the payout address the seller would be asked to confirm, and says when there is none", () => {
    // D5 moved the destination onto the route row, and D9 checks a `PATCH` echo
    // against what was shown. A card that rendered an empty address would be handing
    // the seller a blank to confirm, so the route-less case has to say it out loud.
    const live = text(renderToStaticMarkup(<EndpointCard endpoint={LIVE} />));
    expect(live).toContain("Payout destination");
    expect(live).toContain("seller.testnet");
    expect(live).not.toContain("no route set");

    const routeless = text(renderToStaticMarkup(<EndpointCard endpoint={INACTIVE} />));
    expect(routeless).toContain("no route set");
  });

  it("opens the editor for the row it shows, so a change is made on the endpoint it names", () => {
    const markup = renderToStaticMarkup(<EndpointCard endpoint={LIVE} />);
    expect(markup).toContain("Change these terms");
    expect(markup).toContain(`aria-label="Change ${LIVE.slug}"`);
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

/**
 * The edit step (F2's remaining caller for D9's `PATCH`, PO-7's UI half). Same rule
 * as the create form above: what is proven here is what the markup *says* about the
 * data it was handed — that a form prefilled from a row shows the row's own terms,
 * that the confirmation shows a difference rather than a form, and that a refusal
 * prints the terms still in force instead of the ones that were not written.
 */

const EDITOR_HANDLERS = {
  onEdit: () => undefined,
  onReview: () => undefined,
  onConfirm: () => undefined,
  onBack: () => undefined,
  onDismiss: () => undefined,
  onLiveness: () => undefined,
} as const;

/** The same endpoint after a price-and-destination change Till accepted. */
const RAISED: EndpointDto = endpointDtoSchema.parse({
  ...LIVE,
  priceAmount: "2500000",
  payoutMode: "intents",
  route: {
    id: "9e1f2a3b-4c5d-4e6f-8a7b-0c1d2e3f4a5b",
    destinationChain: "near",
    destinationAsset: "usdc",
    destinationAddress: "new-payout.testnet",
    refundAddress: "new-refund.testnet",
    provider: "mock",
    depositAddress: "mock-deposit-9",
    modeDetail: "standing",
  },
});

function editForm(
  endpoint: EndpointDto,
  values: EditFormValues,
  extra: {
    readonly errors?: FieldErrors;
    readonly note?: string | null;
    readonly busy?: boolean;
  } = {},
): string {
  return text(
    renderToStaticMarkup(
      <EndpointEditorView
        busy={extra.busy ?? false}
        endpoint={endpoint}
        errors={extra.errors ?? {}}
        note={extra.note ?? null}
        pendingAddress={null}
        result={null}
        values={values}
        {...EDITOR_HANDLERS}
      />,
    ),
  );
}

function editMarkup(
  endpoint: EndpointDto,
  values: EditFormValues,
  extra: {
    readonly errors?: FieldErrors;
    readonly note?: string | null;
    readonly busy?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <EndpointEditorView
      busy={extra.busy ?? false}
      endpoint={endpoint}
      errors={extra.errors ?? {}}
      note={extra.note ?? null}
      pendingAddress={null}
      result={null}
      values={values}
      {...EDITOR_HANDLERS}
    />,
  );
}

function edited(endpoint: EndpointDto): EditFormValues {
  return {
    ...editInitial(endpoint),
    priceAmount: "2.50",
    destinationAddress: "new-payout.testnet",
    refundAddress: "new-refund.testnet",
    payoutMode: "intents",
  };
}

function withEditResult(result: EndpointUpdateResult): string {
  return text(
    renderToStaticMarkup(
      <EndpointEditorView
        busy={false}
        endpoint={LIVE}
        errors={{}}
        note={null}
        pendingAddress={null}
        result={result}
        values={editInitial(LIVE)}
        {...EDITOR_HANDLERS}
      />,
    ),
  );
}

const ACCEPTED = endpointUpdateResponseSchema.parse({
  endpoint: RAISED,
  checks: CHECKS.filter((check) => check.ok),
});
const STILL_LIVE = endpointUpdateResponseSchema.parse({ endpoint: LIVE, checks: CHECKS });

describe("the edit form, prefilled from the row (F2, PO-7)", () => {
  it("shows the endpoint's own terms, including the destination off its route", () => {
    const markup = editMarkup(LIVE, editInitial(LIVE));
    expect(markup).toContain('value="https://data.seller.test/prices"');
    expect(markup).toContain('value="1.25"');
    expect(markup).toContain('value="Live grain prices"');
    expect(markup).toContain('value="seller.testnet"');
    expect(markup).toContain('value="direct"');
  });

  it("renders one input per editable field and no field the API would refuse", () => {
    const words = editForm(LIVE, editInitial(LIVE));
    for (const field of EDIT_FIELD_ORDER) {
      expect(words).toContain(FIELD_LABELS[field]);
    }
    // A network or token the seller could retype is a token they could move money to
    // on somebody else's endpoint; D9 names them in its refusal and this names nothing.
    expect(words).not.toContain("Network");
    expect(words).not.toContain("Payment token");
  });

  it("keeps liveness out of the form, so a price save cannot reopen a paused paywall", () => {
    const markup = editMarkup(LIVE, edited(LIVE));
    expect(markup).not.toMatch(/name="active"/);
    expect(markup).not.toMatch(/type="checkbox"/);
    // The separate control, which says which way it goes and what is already true.
    expect(text(markup)).toContain("Pause this paywall");
    expect(text(editMarkup(INACTIVE, editInitial(INACTIVE)))).toContain("Open this paywall again");
  });

  it("puts each refusal sentence beside the field it names", () => {
    const errors: FieldErrors = { priceAmount: "Give a price above zero, like 1.25." };
    expect(editForm(LIVE, edited(LIVE), { errors })).toContain(errors.priceAmount ?? "");
  });

  it("says nothing has changed rather than sending an empty patch", () => {
    const words = editForm(LIVE, editInitial(LIVE), {
      note: "Nothing here has changed yet. Till saves only what you changed.",
    });
    expect(words).toContain("Nothing here has changed yet");
  });
});

describe("confirming a new payout address (PO-2's rule, one step later)", () => {
  function confirmView(busy: boolean): string {
    return text(
      renderToStaticMarkup(
        <EndpointEditorView
          busy={busy}
          endpoint={LIVE}
          errors={{}}
          note={null}
          pendingAddress="new-payout.testnet"
          result={null}
          values={edited(LIVE)}
          {...EDITOR_HANDLERS}
        />,
      ),
    );
  }

  it("confirms the difference, in both forms of the price, before Till writes", () => {
    const words = confirmView(false);
    expect(words).toContain("Confirm before Till writes this");
    expect(words).toContain("Nothing has changed yet");
    expect(words).toContain("1.25 of usdc.testnet");
    expect(words).toContain("2.5 of usdc.testnet");
    expect(words).toContain("Till pays out to new-payout.testnet");
    expect(words).toContain("a settled payment keeps the one it was made under");
    expect(words).not.toContain("Review the change");
  });

  it("marks the confirm button as busy rather than letting a second click through", () => {
    const words = confirmView(true);
    expect(words).toContain("Saving");
    expect(words).not.toContain("Confirm and save");
  });
});

describe("the four answers a change gets (D9)", () => {
  it("shows the new terms as live once Till wrote them, in the units the seller reads", () => {
    const words = withEditResult({ kind: "updated", result: ACCEPTED });
    expect(words).toContain("Saved — the next payer is charged this");
    expect(words).toContain("2.5 of usdc.testnet");
    expect(words).toContain("Every creation check passed");
    // Raw base units on a screen is how a seller reads 2.50 as 2,500,000.
    expect(words).not.toContain("2500000");
  });

  it("says so when the terms it wrote are not taking money yet", () => {
    const paused = endpointUpdateResponseSchema.parse({
      endpoint: endpointDtoSchema.parse({ ...RAISED, active: false }),
      checks: CHECKS.filter((check) => check.ok),
    });
    expect(withEditResult({ kind: "updated", result: paused })).toContain(
      "Saved, and this paywall is closed",
    );
  });

  it("renders a refused change as the terms still in force, not the ones it rejected", () => {
    const words = withEditResult({ kind: "refused", result: STILL_LIVE });
    expect(words).toContain("Till refused the change and wrote nothing");
    expect(words).toContain("These are still the live terms");
    expect(words).toContain("2 checks to fix");
    expect(words).toContain("1.25 of usdc.testnet");
    expect(words).toContain("seller.testnet");
    expect(words).not.toContain("2.5");
    expect(words).not.toContain("new-payout.testnet");
  });

  it("names both addresses when the confirmation disagreed with the row", () => {
    const words = withEditResult({
      kind: "rejected",
      error: {
        code: "destination_not_confirmed",
        message: "Confirm the destination address that was shown to you.",
        destinationAddress: "attacker.testnet",
      },
    });
    expect(words).toContain("Till will keep paying out to");
    expect(words).toContain("seller.testnet");
    expect(words).toContain("attacker.testnet");
  });

  it("sends a seller whose session ended to sign in, and says nothing was written", () => {
    const words = withEditResult({
      kind: "rejected",
      error: { code: "unauthenticated", message: "Sign in to change an endpoint." },
    });
    expect(words).toContain("Sign in again");
    expect(words).toContain("Till wrote nothing");
  });

  it("says the endpoint was not there, and turns a body refusal into sentences", () => {
    expect(
      withEditResult({
        kind: "rejected",
        error: { code: "endpoint_not_found", message: "No endpoint of yours has that id." },
      }),
    ).toContain("No endpoint of yours has that id. Nothing was written.");

    const words = withEditResult({
      kind: "rejected",
      error: {
        code: "invalid_request",
        message: "Nothing about this endpoint changed.",
        issues: [{ path: "upstreamUrl", code: "invalid_string" }],
      },
    });
    expect(words).toContain("Give the full https:// address of the API you are selling.");
    expect(words).not.toContain("invalid_string");
  });

  it("refuses to claim a change when it could not read the answer", () => {
    const words = withEditResult({ kind: "unreachable", detail: "/api/endpoints/x returned 502" });
    expect(words).toContain("it is not claiming anything changed");
    expect(words).toContain("/api/endpoints/x returned 502");
    expect(words).not.toContain("Saved");
  });

  it("offers one way back to the form from every answer", () => {
    for (const result of [
      { kind: "updated", result: ACCEPTED } as EndpointUpdateResult,
      { kind: "refused", result: STILL_LIVE } as EndpointUpdateResult,
      {
        kind: "rejected",
        error: { code: "invalid_json", message: "The request body is not JSON." },
      } as EndpointUpdateResult,
      { kind: "unreachable", detail: "x" } as EndpointUpdateResult,
    ]) {
      expect(withEditResult(result)).toContain("Back to the form");
    }
  });
});
