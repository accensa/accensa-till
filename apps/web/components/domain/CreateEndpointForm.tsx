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
      <section aria-label="Creation result" className="space-y-4">
        {result.kind === "created" ? (
          <>
            <h3 className="text-xl font-semibold tracking-tight">
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
          <p className="notice-danger">
            The dashboard could not reach Till. Nothing was saved.{" "}
            <span className="mt-1 block font-mono text-[11px] text-muted">{result.detail}</span>
          </p>
        )}
        <button className="btn" onClick={onReset} type="button">
          Create another
        </button>
      </section>
    );
  }

  if (pending !== null) {
    return (
      <section aria-label="Confirm the endpoint" className="panel">
        <div className="border-b border-line bg-coal px-5 py-4">
          <span className="eyebrow">Step 2 / Confirm</span>
          <h3 className="mt-2 text-xl font-semibold tracking-tight">
            Confirm before Till saves this
          </h3>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{DIRECT_DESTINATION_NOTE}</p>
        </div>
        <dl className="grid gap-x-6 gap-y-3 px-5 py-5 text-sm sm:grid-cols-[160px_minmax(0,1fr)]">
          {confirmationRows(pending).map((row) => (
            <div className="contents" key={row.label}>
              <dt className="label pt-0.5">{row.label}</dt>
              <dd className="break-all font-mono text-[12px] text-bone">{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-2 border-t border-line px-5 py-4">
          <button className="btn btn-primary" disabled={busy} onClick={onConfirm} type="button">
            {busy ? "Saving…" : "Confirm and create"}
          </button>
          <button className="btn" onClick={onBack} type="button">
            Back
          </button>
        </div>
      </section>
    );
  }

  return (
    <form aria-label="Create an endpoint" className="panel" onSubmit={reviewOnSubmit(onReview)}>
      <div className="border-b border-line bg-coal px-5 py-3">
        <span className="eyebrow">Step 1 / Terms</span>
      </div>

      <div className="grid gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <label className="block text-sm" htmlFor={`endpoint-${field}`} key={field}>
            <span className="label">{FIELD_LABELS[field]}</span>
            {field === "payoutMode" ? (
              <select
                className="field appearance-none"
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
                className="field"
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
              <span className="mt-1.5 block font-mono text-[10px] leading-4 text-danger">
                {errors[field]}
              </span>
            )}
          </label>
        ))}
      </div>

      <div className="space-y-1 border-t border-line px-5 py-4">
        <p className="text-[11px] leading-5 text-muted">{PRICE_FLOOR_HINT}</p>
        <p className="text-[11px] leading-5 text-muted">{DIRECT_DESTINATION_NOTE}</p>
      </div>

      <div className="border-t border-line px-5 py-4">
        <button className="btn btn-primary" type="submit">
          Review and confirm
        </button>
      </div>
    </form>
  );
}

/** A refusal, in the seller's terms: what Till named, and what to do about it. */
function Refusal({ error }: { readonly error: DashboardError }) {
  if (error.code === "destination_not_confirmed") {
    return (
      <div className="notice-danger">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger">
          Till did not save that
        </h3>
        <p className="mt-2 text-sm leading-6">{error.message}</p>
        <p className="mt-2 text-sm leading-6 text-muted">
          Till will pay out to{" "}
          <code className="text-bone">
            {error.destinationAddress ?? "the address on the request"}
          </code>
          , which is not what you confirmed. Check the destination and try again.
        </p>
      </div>
    );
  }
  if (error.code === "unauthenticated") {
    return (
      <div className="notice-warn">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-amber">
          Your session ended
        </h3>
        <p className="mt-2 text-sm leading-6">
          <a className="link" href="/sign-in">
            Sign in again
          </a>{" "}
          and come back: Till did not create anything.
        </p>
      </div>
    );
  }
  const issues = Object.values(fieldErrorsFromIssues(error.issues ?? []));
  return (
    <div className="notice-danger">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-danger">
        Till did not save that
      </h3>
      <p className="mt-2 text-sm leading-6">{error.message}</p>
      {issues.length === 0 ? null : (
        <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
          {issues.map((copy) => (
            <li className="text-sm leading-6 text-muted" key={copy}>
              {copy}
            </li>
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
