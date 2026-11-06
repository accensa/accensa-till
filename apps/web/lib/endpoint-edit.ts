import { parseAmount } from "@till/core/money";
import {
  type EndpointDto,
  type EndpointUpdateRequest,
  endpointUpdateRequestSchema,
} from "@till/core/schemas";

import { FIELD_LABELS, type FieldErrors, fieldErrorsFromIssues } from "./endpoint-form.ts";
import { displayAmount } from "./format.ts";

/**
 * The edit form's logic (F2's remaining step, PO-7's UI half): what the seller
 * changed becomes the body `PATCH /api/endpoints/:id` wants (D9).
 *
 * The API takes a *partial* change and merges it onto the stored terms, which is why
 * this file exists at all: a dashboard that resubmitted the whole form would be
 * naming fields the seller did not touch, and two of those are not innocent.
 *
 * - `active` in a body is the paywall opening. D9 keeps a row's liveness unless the
 *   body says otherwise, so a price save that carried the endpoint's current `active`
 *   through would be fine and a price save that carried the form's checkbox would not.
 *   Rather than trust either, the edit form has no `active` field at all — pausing is
 *   its own control and its own body (`livenessBody`).
 * - `destinationAddress` in a body moves where the seller's money comes to rest. It
 *   goes only with `confirmedAddress` set to the address that was on the screen, which
 *   is the same rule create has (PO-2) and the reason `route` is on the DTO (F2e-a):
 *   the address shown and the address vouched for have to come from one read.
 *
 * `network`, `assetContract`, `id` and `slug` are not fields here because the schema
 * refuses them by name; a form that could send one would be a form that could edit
 * somebody else's token.
 */

/** The fields the edit form holds. Every one of them is a string because a form input is. */
export type EditFormValues = {
  readonly upstreamUrl: string;
  readonly description: string;
  readonly priceAmount: string;
  readonly payoutMode: string;
  readonly destinationChain: string;
  readonly destinationAsset: string;
  readonly destinationAddress: string;
  readonly refundAddress: string;
};

export type EditField = keyof EditFormValues;

/**
 * The inputs the editor renders, in order. There is no `active` in this list and
 * there is no network or token in it either: the first because pausing is its own
 * control (`livenessBody`), the second two because D9 refuses them in a body and an
 * input the API would reject is an input that lies about what can be changed.
 */
export const EDIT_FIELD_ORDER: readonly EditField[] = [
  "upstreamUrl",
  "priceAmount",
  "description",
  "payoutMode",
  "destinationChain",
  "destinationAsset",
  "destinationAddress",
  "refundAddress",
];

/**
 * The endpoint's current terms as form values. `null` becomes `""` because an input
 * cannot hold a null, and the diff below compares against this object — so an
 * endpoint with no description and an empty box are the same state, and clearing a
 * description is the one edit that has to be noticed as a change to `null` rather
 * than to absent.
 */
export function editInitial(endpoint: EndpointDto): EditFormValues {
  const route = endpoint.route;
  return {
    upstreamUrl: endpoint.upstreamUrl,
    description: endpoint.description ?? "",
    priceAmount: displayAmount(endpoint.priceAmount),
    payoutMode: endpoint.payoutMode,
    destinationChain: route?.destinationChain ?? "",
    destinationAsset: route?.destinationAsset ?? "",
    destinationAddress: route?.destinationAddress ?? "",
    refundAddress: route?.refundAddress ?? "",
  };
}

export type EditBodyResult =
  | {
      readonly ok: true;
      readonly body: EndpointUpdateRequest;
      readonly changedFields: readonly EditField[];
    }
  | { readonly ok: false; readonly reason: "nothing-changed" }
  | {
      readonly ok: false;
      readonly reason: "needs-confirmation";
      /** The address the seller has to be shown before this can be sent. */
      readonly shownAddress: string;
      readonly body: null;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid";
      readonly errors: FieldErrors;
      readonly body: null;
    };

export type EditOptions = {
  /** True only when the seller ticked the confirmation on the address they can see. */
  readonly confirmed?: boolean;
};

/**
 * The changed fields, as the body will carry them. `null` for a cleared description,
 * base units for a price, and nothing at all for a field that reads the same as the
 * row after trimming.
 */
function diff(
  endpoint: EndpointDto,
  values: EditFormValues,
): {
  readonly fields: EditField[];
  readonly body: Record<string, unknown>;
  readonly errors: FieldErrors;
} {
  const current = editInitial(endpoint);
  const route = endpoint.route;
  const fields: EditField[] = [];
  const body: Record<string, unknown> = {};
  const errors: FieldErrors = {};

  const typed = {
    upstreamUrl: values.upstreamUrl.trim(),
    description: values.description.trim(),
    priceAmount: values.priceAmount.trim(),
    payoutMode: values.payoutMode.trim(),
    destinationChain: values.destinationChain.trim(),
    destinationAsset: values.destinationAsset.trim(),
    destinationAddress: values.destinationAddress.trim(),
    refundAddress: values.refundAddress.trim(),
  };

  if (typed.upstreamUrl !== current.upstreamUrl) {
    fields.push("upstreamUrl");
    body.upstreamUrl = typed.upstreamUrl;
  }

  if (typed.description !== current.description) {
    fields.push("description");
    body.description = typed.description === "" ? null : typed.description;
  }

  // The displayed string is compared first so an untouched price is never put through
  // the converter — and a retyped equivalent ("0.0100" over "0.01") is then compared
  // in base units, which is what stops a save re-stating a price nobody changed.
  if (typed.priceAmount !== current.priceAmount) {
    let baseUnits: string;
    try {
      baseUnits = parseAmount(typed.priceAmount).toString();
    } catch (error) {
      errors.priceAmount =
        error instanceof RangeError
          ? "A stablecoin has six decimal places; give a price with no more than that."
          : "Give the price as a plain number, like 1.25.";
      baseUnits = "";
    }
    if (baseUnits !== "" && baseUnits !== endpoint.priceAmount) {
      fields.push("priceAmount");
      body.priceAmount = baseUnits;
    }
  }

  if (typed.payoutMode !== current.payoutMode) {
    if (typed.payoutMode !== "direct" && typed.payoutMode !== "intents") {
      errors.payoutMode = "Choose a payout mode: direct or intents.";
    } else {
      fields.push("payoutMode");
      body.payoutMode = typed.payoutMode;
    }
  }

  // The four destination columns live on the route (D5), so a route-less endpoint
  // compares against "" — which is how an endpoint whose create never got a route can
  // be repaired by typing the destination it never had (D9's routeless case).
  const destination: readonly [EditField, string][] = [
    ["destinationChain", route?.destinationChain ?? ""],
    ["destinationAsset", route?.destinationAsset ?? ""],
    ["destinationAddress", route?.destinationAddress ?? ""],
    ["refundAddress", route?.refundAddress ?? ""],
  ];
  for (const [field, stored] of destination) {
    if (typed[field] !== stored) {
      fields.push(field);
      body[field] = typed[field];
    }
  }

  return { fields, body, errors };
}

/**
 * What `PATCH /api/endpoints/:id` is sent for this form. The four answers are the
 * four things that can stop it: nothing changed, a price or URL the schema refuses,
 * an address that has not been confirmed, or — the success case — a body carrying
 * exactly the changed fields.
 */
export function buildEditBody(
  endpoint: EndpointDto,
  values: EditFormValues,
  options: EditOptions = {},
): EditBodyResult {
  const { fields, body, errors } = diff(endpoint, values);

  if (Object.keys(errors).length > 0) {
    return { ok: false, reason: "invalid", errors, body: null };
  }

  // Nothing to send. The API would answer `422` ("at least one field has to change"),
  // and an endpoint that was not edited would gain a log line saying it was.
  if (fields.length === 0) {
    return { ok: false, reason: "nothing-changed" };
  }

  if (fields.includes("destinationAddress")) {
    const shown = body.destinationAddress;
    if (options.confirmed !== true || typeof shown !== "string") {
      return { ok: false, reason: "needs-confirmation", shownAddress: String(shown), body: null };
    }
    // The echo is the typed address the screen is showing, taken from the same object
    // the rest of the body came from — never re-read from the row, which by then would
    // be the address being replaced.
    body.confirmedAddress = shown;
  }

  const parsed = endpointUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    // Both the local refusals and the API's share this copy table (F2), so a field
    // the schema names says the same thing here as it would in the check list.
    const mapped = fieldErrorsFromIssues(
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    );
    if (Object.keys(mapped).length > 0) {
      return { ok: false, reason: "invalid", errors: mapped, body: null };
    }
    // A refusal with no field to blame — the whole body is the problem, so say so
    // against the form rather than inventing a field.
    return {
      ok: false,
      reason: "invalid",
      errors: { priceAmount: parsed.error.issues[0]?.message ?? "Till refuses this change." },
      body: null,
    };
  }

  return { ok: true, body: parsed.data, changedFields: fields };
}

/**
 * The pause/resume body: `active` and nothing else (D9). Kept apart from
 * `buildEditBody` on purpose — the form has no `active` field to leak into a save, so
 * the only way liveness changes is by pressing the control that means it.
 */
export function livenessBody(endpoint: EndpointDto): { readonly active: boolean } {
  return { active: !endpoint.active };
}

export type EditChangeRow = {
  readonly label: string;
  readonly from: string;
  readonly to: string;
};

const NO_DESCRIPTION = "(no description)";

/**
 * What the confirmation step shows (UI-2's rule, one field later): the change as
 * from-and-to, so the seller confirms a *difference* rather than a form they typed.
 * The destination address is the row that matters — it is the value `confirmedAddress`
 * vouches for, and the only one Till writes a payout route over.
 */
export function changeRows(
  endpoint: EndpointDto,
  values: EditFormValues,
): readonly EditChangeRow[] {
  const current = editInitial(endpoint);
  const { fields } = diff(endpoint, values);
  const typed = {
    ...values,
    upstreamUrl: values.upstreamUrl.trim(),
    description: values.description.trim(),
    priceAmount: values.priceAmount.trim(),
    payoutMode: values.payoutMode.trim(),
    destinationChain: values.destinationChain.trim(),
    destinationAsset: values.destinationAsset.trim(),
    destinationAddress: values.destinationAddress.trim(),
    refundAddress: values.refundAddress.trim(),
  };

  return fields.map((field) => {
    const label = FIELD_LABELS[field];
    if (field === "priceAmount") {
      // Both numbers, because the seller is about to charge this much: what they typed
      // and what the 402 will name.
      const stored = `${displayAmount(endpoint.priceAmount)} of ${endpoint.assetContract}`;
      const proposed = `${displayAmount(String(parseAmountOr(typed.priceAmount)))} of ${endpoint.assetContract}`;
      return { label, from: stored, to: proposed };
    }
    const from = current[field] === "" ? NO_DESCRIPTION : current[field];
    const to = typed[field] === "" ? NO_DESCRIPTION : typed[field];
    return { label, from, to };
  });
}

/** The converter again, for a form the diff already accepted; `""` means "not a price". */
function parseAmountOr(value: string): string {
  try {
    return parseAmount(value).toString();
  } catch {
    return "";
  }
}
