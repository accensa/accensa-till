import { parseAmount } from "@till/core/money";
import {
  type CreationCheck,
  type EndpointCreateInput,
  type EndpointCreateRequest,
  endpointCreateSchema,
} from "@till/core/schemas";
import { displayAmount } from "./format.ts";

/**
 * The create-endpoint form's logic (UI-2, PO-1/PO-2), kept out of the components
 * so it can be executed by a test. `apps/web` has no browser test framework
 * (ARCHITECTURE.md 3), and this is the part with the rules in it: what the seller
 * typed becomes what the API is sent, which fields are blamed when it refuses, and
 * what the seller is asked to confirm before Till writes a payout route.
 *
 * Money leaves here as base units and never as a float (hard rule 3): the seller
 * types `1.25`, `parseAmount` turns it into `1250000`, and the API's own schema
 * validates the result. A price that cannot survive that conversion is a field
 * error, not a rounded number.
 */

export type EndpointFormValues = {
  readonly upstreamUrl: string;
  readonly description: string;
  readonly priceAmount: string;
  readonly assetContract: string;
  readonly network: string;
  readonly payoutMode: string;
  readonly destinationChain: string;
  readonly destinationAsset: string;
  readonly destinationAddress: string;
  readonly refundAddress: string;
};

export type FormField = keyof EndpointFormValues;

export type FieldErrors = Partial<Record<FormField, string>>;

/** The order the inputs are rendered in, and the label each one gets. */
export const FIELD_LABELS: Record<FormField, string> = {
  upstreamUrl: "Upstream URL",
  description: "Description (optional)",
  priceAmount: "Price per call",
  assetContract: "Payment token",
  network: "Network",
  payoutMode: "Payout mode",
  destinationChain: "Destination chain",
  destinationAsset: "Destination asset",
  destinationAddress: "Payout destination",
  refundAddress: "Refund account",
};

/** Examples, not defaults: nothing here is a claim about how Till is configured. */
export const FIELD_EXAMPLES: Record<FormField, string> = {
  upstreamUrl: "https://data.seller.test/prices",
  description: "Live grain prices, per request",
  priceAmount: "1.25",
  assetContract: "usdc.testnet",
  network: "near:testnet",
  payoutMode: "direct",
  destinationChain: "near",
  destinationAsset: "usdc",
  destinationAddress: "seller.testnet",
  refundAddress: "seller.testnet",
};

export const emptyForm: EndpointFormValues = {
  upstreamUrl: "",
  description: "",
  priceAmount: "",
  assetContract: "",
  network: "",
  payoutMode: "",
  destinationChain: "",
  destinationAsset: "",
  destinationAddress: "",
  refundAddress: "",
};

/** The price floor is a configured number (D4) the dashboard cannot read; this is the copy that says so. */
export const PRICE_FLOOR_HINT =
  "Till refuses a price below its configured minimum and tells you the floor when it does.";

export type BuildResult =
  | { readonly ok: true; readonly input: EndpointCreateInput }
  | { readonly ok: false; readonly errors: FieldErrors };

/**
 * What the seller typed, through the schema the API will use. A field that is not
 * a valid base-unit string is reported on the price field rather than sent, so the
 * seller is never asked to confirm a number Till would reject.
 */
export function buildCreateInput(values: EndpointFormValues): BuildResult {
  const trimmed: EndpointFormValues = {
    upstreamUrl: values.upstreamUrl.trim(),
    description: values.description.trim(),
    priceAmount: values.priceAmount.trim(),
    assetContract: values.assetContract.trim(),
    network: values.network.trim(),
    payoutMode: values.payoutMode.trim(),
    destinationChain: values.destinationChain.trim(),
    destinationAsset: values.destinationAsset.trim(),
    destinationAddress: values.destinationAddress.trim(),
    refundAddress: values.refundAddress.trim(),
  };

  const errors: FieldErrors = {};

  let priceAmount: string;
  try {
    priceAmount = parseAmount(trimmed.priceAmount).toString();
  } catch (error) {
    errors.priceAmount =
      error instanceof RangeError
        ? "A stablecoin has six decimal places; give a price with no more than that."
        : "Give the price as a plain number, like 1.25.";
    priceAmount = trimmed.priceAmount;
  }

  if (trimmed.payoutMode !== "direct" && trimmed.payoutMode !== "intents") {
    errors.payoutMode = "Choose a payout mode: direct or intents.";
  }

  const candidate = {
    upstreamUrl: trimmed.upstreamUrl,
    priceAmount,
    assetContract: trimmed.assetContract,
    network: trimmed.network,
    ...(trimmed.description === "" ? {} : { description: trimmed.description }),
    payoutMode: trimmed.payoutMode === "intents" ? "intents" : "direct",
    destinationChain: trimmed.destinationChain,
    destinationAsset: trimmed.destinationAsset,
    destinationAddress: trimmed.destinationAddress,
    refundAddress: trimmed.refundAddress,
  };

  const parsed = endpointCreateSchema.safeParse(candidate);
  // Both lists at once, so one pass over the form tells the seller everything that
  // is wrong. A price the converter refused keeps its own sentence rather than the
  // schema's, because the converter got there first and knows more.
  const schemaErrors = parsed.success
    ? {}
    : fieldErrorsFromIssues(
        parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
      );
  const everyError: FieldErrors = { ...schemaErrors, ...errors };

  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, input: parsed.data };
  }
  return { ok: false, errors: everyError };
}

/**
 * One sentence per refusal the create schema can actually produce, keyed by what it
 * checks rather than by the field's name — because a URL and a token contract both
 * fail as `invalid_string`, and "invalid string" is not something a seller can act
 * on.
 *
 * Used for the local parse above and for the `issues` the API returns from
 * `POST /api/endpoints`, so both readers say the same thing about the same failure.
 * Deliberately short: an account id's *shape* is not in this schema
 * (`destinationAddress` and `refundAddress` are validated by Till's creation checks,
 * which answer with a sentence naming the account), and a form that re-implemented a
 * server rule to say it earlier is a second rule that can disagree with the first.
 */
export function issueCopy(path: string, code: string): string {
  const label = path in FIELD_LABELS ? FIELD_LABELS[path as FormField] : path;
  if (code === "too_big") {
    return `${label} is longer than Till accepts.`;
  }
  if (code === "too_small") {
    return `${label} cannot be empty.`;
  }
  if (code === "invalid_type") {
    return `${label} is missing.`;
  }
  if (path === "upstreamUrl") {
    return "Give the full https:// address of the API you are selling.";
  }
  if (path === "priceAmount") {
    return "Give a price above zero, like 1.25.";
  }
  return `${label} is not something Till can use (${code}).`;
}

/** Group a list of `{path, code}` refusals under the field each one names. */
export function fieldErrorsFromIssues(
  issues: readonly { readonly path: string; readonly code: string }[],
): FieldErrors {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    if (issue.path in FIELD_LABELS) {
      errors[issue.path] ??= issueCopy(issue.path, issue.code);
    }
  }
  return errors as FieldErrors;
}

/**
 * The body `POST /api/endpoints` wants: the input plus the destination the seller
 * was shown (PO-2). The echo is taken from the confirmed request itself, never from
 * a fresh read of the input, so the value Till writes the route to is the value that
 * was on screen.
 */
export function createBody(input: EndpointCreateInput): EndpointCreateRequest {
  return { ...input, confirmedAddress: input.destinationAddress };
}

export type ConfirmationRow = {
  readonly label: string;
  readonly value: string;
};

/**
 * What the seller sees before anything is written (UI-2's confirmation step). This
 * is also the whole set of fields `confirmedAddress` vouches for, so the row the
 * dashboard shows and the row the route checks are one list.
 */
export function confirmationRows(input: EndpointCreateInput): readonly ConfirmationRow[] {
  return [
    { label: FIELD_LABELS.upstreamUrl, value: input.upstreamUrl },
    {
      // Both forms of the price, because this is the number the seller is about to
      // charge: what they typed and what Till will put in the challenge.
      label: FIELD_LABELS.priceAmount,
      value: `${displayAmount(input.priceAmount)} of ${input.assetContract} (${input.priceAmount} base units)`,
    },
    { label: FIELD_LABELS.network, value: input.network },
    { label: FIELD_LABELS.payoutMode, value: input.payoutMode },
    { label: FIELD_LABELS.destinationChain, value: input.destinationChain },
    { label: FIELD_LABELS.destinationAsset, value: input.destinationAsset },
    { label: FIELD_LABELS.destinationAddress, value: input.destinationAddress },
    { label: FIELD_LABELS.refundAddress, value: input.refundAddress },
    ...(input.description === undefined
      ? []
      : [{ label: FIELD_LABELS.description, value: input.description }]),
  ];
}

/** A direct endpoint pays the signed-in account, which is not something the browser can know. */
export const DIRECT_DESTINATION_NOTE =
  "A direct endpoint pays the account you signed in with; Till names it if what you typed is not that account.";

export type OrderedChecks = {
  readonly failed: readonly CreationCheck[];
  readonly passed: readonly CreationCheck[];
};

/**
 * Failures first (UI-2): a seller who has three things to fix should not have to
 * read the six things that were already right to find them.
 */
export function orderChecks(checks: readonly CreationCheck[]): OrderedChecks {
  return {
    failed: checks.filter((check) => !check.ok),
    passed: checks.filter((check) => check.ok),
  };
}
