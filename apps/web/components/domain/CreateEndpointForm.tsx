"use client";

import type { DashboardError, EndpointCreateInput } from "@till/core/schemas";
import type { ChangeEvent, FormEvent } from "react";
import { useState } from "react";

import { type EndpointCreateResult, api } from "../../lib/api-client.ts";
import {
  DIRECT_DESTINATION_NOTE,
  type EndpointFormValues,
  FIELD_EXAMPLES,
  FIELD_LABELS,
  type FieldErrors,
  type FormField,
  PRICE_FLOOR_HINT,
  buildCreateInput,
  confirmationRows,
  createBody,
  emptyForm,
  fieldErrorsFromIssues,
} from "../../lib/endpoint-form.ts";
import { CreationCheckResults } from "./CreationCheckResults.tsx";
import { EndpointCard } from "./EndpointCard.tsx";

/**
 * Create an endpoint (UI-2, PO-1/PO-2), in two steps because Till writes a payout
 * route as it saves: the seller fills the form, then sees the destination and the
 * price back and confirms *that*, and the confirmation is what the request carries
 * (`confirmedAddress`, refused with `422` if it does not match).
 *
 * The step is not stored as state: `pending` holds the validated input, so the
 * screen shows the confirmation exactly when there is a confirmed body to send, and
 * a result replaces it once there is an answer. There is no in-between to render.
 *
 * `CreateEndpointFormView` is the whole rendering and `CreateEndpointForm` is the
 * state above it, which is what lets a test draw each step — the confirmation, a
 * refusal, a live endpoint — without a browser. `apps/web` has no DOM test framework
 * (ARCHITECTURE.md 3), so the parts with rules in them are rendered to markup and
 * read back as text.
 */

const FIELDS = Object.keys(FIELD_LABELS) as FormField[];

export type FormViewProps = {
  readonly values: EndpointFormValues;
  readonly errors: FieldErrors;
  readonly pending: EndpointCreateInput | null;
  readonly result: EndpointCreateResult | null;
  readonly busy: boolean;
  readonly onEdit: (field: FormField, value: string) => void;
  readonly onReview: () => void;
  readonly onConfirm: () => void;
  readonly onBack: () => void;
  readonly onReset: () => void;
};

export function CreateEndpointFormView({
  values,
  errors,
  pending,
  result,
  busy,
  onEdit,
  onReview,
  onConfirm,
  onBack,
  onReset,
}: FormViewProps) {
  if (result !== null) {
    return (
      <section aria-label="Creation result">
        {result.kind === "created" ? (
          <>
            <h3 className="font-semibold">
              {result.result.endpoint.active
                ? "Live — this link now takes payment"
                : "Saved, but not live yet"}
            </h3>
            <CreationCheckResults checks={result.result.checks} />
            <EndpointCard endpoint={result.result.endpoint} />
          </>
        ) : result.kind === "rejected" ? (
          <Refusal error={result.error} />
        ) : (
          <p className="text-sm text-red-700">
            The dashboard could not reach Till. Nothing was saved. ({result.detail})
          </p>
        )}
        <button type="button" className="mt-3 border px-3 py-1 text-sm" onClick={onReset}>
          Create another
        </button>
      </section>
    );
  }

  if (pending !== null) {
    return (
      <section aria-label="Confirm the endpoint">
        <h3 className="font-semibold">Confirm before Till saves this</h3>
        <p className="text-sm opacity-70">{DIRECT_DESTINATION_NOTE}</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {confirmationRows(pending).map((row) => (
            <div className="contents" key={row.label}>
              <dt className="opacity-60">{row.label}</dt>
              <dd>
                <code>{row.value}</code>
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="border px-3 py-1 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Saving…" : "Confirm and create"}
          </button>
          <button type="button" className="border px-3 py-1 text-sm" onClick={onBack}>
            Back
          </button>
        </div>
      </section>
    );
  }

  return (
    <form aria-label="Create an endpoint" onSubmit={reviewOnSubmit(onReview)}>
      <div className="grid gap-3">
        {FIELDS.map((field) => (
          <label className="block text-sm" htmlFor={`endpoint-${field}`} key={field}>
            <span className="font-semibold">{FIELD_LABELS[field]}</span>
            {field === "payoutMode" ? (
              <select
                className="mt-1 block w-full border px-2 py-1"
                id={`endpoint-${field}`}
                name={field}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  onEdit(field, event.target.value)
                }
                value={values[field]}
              >
                <option value="">Choose a payout mode</option>
                <option value="direct">direct — pay the account you signed in with</option>
                <option value="intents">intents — swap through a provider</option>
              </select>
            ) : (
              <input
                className="mt-1 block w-full border px-2 py-1"
                id={`endpoint-${field}`}
                name={field}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onEdit(field, event.target.value)
                }
                placeholder={FIELD_EXAMPLES[field]}
                type="text"
                value={values[field]}
              />
            )}
            {errors[field] === undefined ? null : (
              <span className="mt-1 block text-red-700">{errors[field]}</span>
            )}
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs opacity-60">{PRICE_FLOOR_HINT}</p>
      <p className="text-xs opacity-60">{DIRECT_DESTINATION_NOTE}</p>
      <button type="submit" className="mt-3 border px-3 py-1 text-sm">
        Review and confirm
      </button>
    </form>
  );
}

/** A refusal, in the seller's terms: what Till named, and what to do about it. */
function Refusal({ error }: { readonly error: DashboardError }) {
  if (error.code === "destination_not_confirmed") {
    return (
      <div>
        <h3 className="font-semibold text-red-700">Till did not save that</h3>
        <p className="text-sm">{error.message}</p>
        <p className="mt-1 text-sm">
          Till will pay out to{" "}
          <code>{error.destinationAddress ?? "the address on the request"}</code>, which is not what
          you confirmed. Check the destination and try again.
        </p>
      </div>
    );
  }
  if (error.code === "unauthenticated") {
    return (
      <div>
        <h3 className="font-semibold text-red-700">Your session ended</h3>
        <p className="text-sm">
          <a className="underline" href="/sign-in">
            Sign in again
          </a>{" "}
          and come back: Till did not create anything.
        </p>
      </div>
    );
  }
  const issues = Object.values(fieldErrorsFromIssues(error.issues ?? []));
  return (
    <div>
      <h3 className="font-semibold text-red-700">Till did not save that</h3>
      <p className="text-sm">{error.message}</p>
      {issues.length === 0 ? null : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {issues.map((copy) => (
            <li key={copy}>{copy}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function reviewOnSubmit(onReview: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onReview();
  };
}

export function CreateEndpointForm() {
  const [values, setValues] = useState<EndpointFormValues>(emptyForm);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState<EndpointCreateInput | null>(null);
  const [result, setResult] = useState<EndpointCreateResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(input: EndpointCreateInput): Promise<void> {
    setBusy(true);
    try {
      setResult(await api.createEndpoint(createBody(input)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CreateEndpointFormView
      busy={busy}
      errors={errors}
      onBack={() => setPending(null)}
      onConfirm={() => {
        if (pending !== null) {
          void save(pending);
        }
      }}
      onEdit={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
      onReset={() => {
        setResult(null);
        setPending(null);
        setValues(emptyForm);
        setErrors({});
      }}
      onReview={() => {
        const built = buildCreateInput(values);
        if (built.ok) {
          setErrors({});
          setPending(built.input);
        } else {
          setErrors(built.errors);
        }
      }}
      pending={pending}
      result={result}
      values={values}
    />
  );
}
