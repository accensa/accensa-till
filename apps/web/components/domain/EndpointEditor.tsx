"use client";

import type { DashboardError, EndpointDto, EndpointUpdateRequest } from "@till/core/schemas";
import type { ChangeEvent, FormEvent } from "react";
import { useState } from "react";

import { type EndpointUpdateResult, api } from "../../lib/api-client.ts";
import {
  EDIT_FIELD_ORDER,
  type EditField,
  type EditFormValues,
  buildEditBody,
  changeRows,
  editInitial,
  livenessBody,
} from "../../lib/endpoint-edit.ts";
import { FIELD_LABELS, type FieldErrors, fieldErrorsFromIssues } from "../../lib/endpoint-form.ts";
import { displayAmount } from "../../lib/format.ts";
import { CreationCheckResults } from "./CreationCheckResults.tsx";

/**
 * Change one endpoint's terms (F2's edit step, D9's `PATCH`, PO-7's UI half).
 *
 * Three things this screen is not allowed to do, and each is a line of code rather
 * than a wish:
 *
 * - it sends only what the seller changed (`buildEditBody` diffs against the endpoint
 *   it was given), so a save cannot restate a field nobody touched;
 * - it has no control over `active` in the form. Pausing is the button below it, and
 *   that button's body is `{ active }` alone — which is how "an edit never opens a
 *   paywall somebody paused" holds when the form is the one doing the submitting;
 * - a new payout address goes through a confirmation step, and the address the
 *   request echoes is the one those rows rendered — the same string the seller read,
 *   rebuilt only when they pressed confirm. The address already on the row comes from
 *   `endpoint.route` (D5), which is what lets the screen show a *from* at all.
 *
 * `EndpointEditorView` is the whole rendering and `EndpointEditor` the state above it,
 * so a test can draw each step without a browser (ARCHITECTURE.md 3).
 */

export type EditorViewProps = {
  readonly endpoint: EndpointDto;
  readonly values: EditFormValues;
  readonly errors: FieldErrors;
  /**
   * The payout address waiting to be confirmed, or `null` while the seller is typing.
   * It is an address and not a request body on purpose: the body is rebuilt from
   * `values` when the seller confirms, so nothing that was assembled before the
   * confirmation — least of all a `confirmedAddress` — can be sent without it.
   */
  readonly pendingAddress: string | null;
  readonly result: EndpointUpdateResult | null;
  readonly note: string | null;
  readonly busy: boolean;
  readonly onEdit: (field: EditField, value: string) => void;
  readonly onReview: () => void;
  readonly onConfirm: () => void;
  readonly onBack: () => void;
  readonly onDismiss: () => void;
  readonly onLiveness: () => void;
};

export function EndpointEditorView({
  endpoint,
  values,
  errors,
  pendingAddress,
  result,
  note,
  busy,
  onEdit,
  onReview,
  onConfirm,
  onBack,
  onDismiss,
  onLiveness,
}: EditorViewProps) {
  if (result !== null) {
    return <ChangeResult endpoint={endpoint} result={result} onDismiss={onDismiss} />;
  }

  if (pendingAddress !== null) {
    const rows = changeRows(endpoint, values);
    return (
      <section aria-label="Confirm the change" className="mt-3">
        <h4 className="text-sm font-semibold">
          Confirm before Till writes this. Nothing has changed yet.
        </h4>
        <table className="mt-2 text-sm">
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th className="pr-3 text-left font-normal opacity-60">{row.label}</th>
                <td className="pr-3">
                  <code>{row.from}</code>
                </td>
                <td>
                  <span className="opacity-60">→</span> <code>{row.to}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-sm">
          Till pays out to <code>{pendingAddress}</code>. It is asking you to say so because a
          payout route is written from this value and a settled payment keeps the one it was made
          under.
        </p>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="border px-3 py-1 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Saving…" : "Confirm and save"}
          </button>
          <button type="button" className="border px-3 py-1 text-sm" onClick={onBack}>
            Back
          </button>
        </div>
      </section>
    );
  }

  return (
    <form
      aria-label={`Change ${endpoint.slug}`}
      className="mt-3"
      onSubmit={reviewOnSubmit(onReview)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {EDIT_FIELD_ORDER.map((field) => (
          <label className="block text-sm" htmlFor={`edit-${endpoint.id}-${field}`} key={field}>
            <span className="font-semibold">{FIELD_LABELS[field]}</span>
            {field === "payoutMode" ? (
              <select
                className="mt-1 block w-full border px-2 py-1"
                id={`edit-${endpoint.id}-${field}`}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  onEdit(field, event.target.value)
                }
                value={values[field]}
              >
                <option value="direct">direct — pay the account you signed in with</option>
                <option value="intents">intents — swap through a provider</option>
              </select>
            ) : (
              <input
                className="mt-1 block w-full border px-2 py-1"
                id={`edit-${endpoint.id}-${field}`}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onEdit(field, event.target.value)
                }
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

      {note === null ? null : <p className="mt-2 text-sm opacity-70">{note}</p>}

      <div className="mt-3 flex gap-2">
        <button type="submit" className="border px-3 py-1 text-sm">
          Review the change
        </button>
        {/* The only control that changes whether money arrives, and the only body with
            `active` in it. It says which way it goes and what is already true. */}
        <button
          type="button"
          className="border px-3 py-1 text-sm disabled:opacity-50"
          disabled={busy}
          onClick={onLiveness}
        >
          {busy ? "Working…" : endpoint.active ? "Pause this paywall" : "Open this paywall again"}
        </button>
      </div>
      <p className="mt-2 text-xs opacity-60">
        Till saves only what you changed, and a change that fails one of its checks is refused whole
        — an endpoint that was earning keeps earning while you fix it.
      </p>
    </form>
  );
}

/** The four answers D9's route can give, each in the API's own words. */
function ChangeResult({
  endpoint,
  result,
  onDismiss,
}: {
  readonly endpoint: EndpointDto;
  readonly result: EndpointUpdateResult;
  readonly onDismiss: () => void;
}) {
  if (result.kind === "updated" || result.kind === "refused") {
    const changed = result.result;
    return (
      <section aria-label="Change result" className="mt-3">
        <h4 className="text-sm font-semibold">
          {result.kind === "updated"
            ? changed.endpoint.active
              ? "Saved — the next payer is charged this"
              : "Saved, and this paywall is closed"
            : "Till refused the change and wrote nothing"}
        </h4>
        {result.kind === "refused" ? (
          <p className="mt-1 text-sm opacity-70">
            These are still the live terms, including the payout address:
          </p>
        ) : null}
        <CreationCheckResults checks={changed.checks} />
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="opacity-60">Price</dt>
          <dd>
            {displayAmount(changed.endpoint.priceAmount)} of {changed.endpoint.assetContract}
          </dd>
          <dt className="opacity-60">Payout destination</dt>
          <dd>
            <code>{changed.endpoint.route?.destinationAddress ?? "none yet"}</code>
          </dd>
        </dl>
        <button type="button" className="mt-3 border px-3 py-1 text-sm" onClick={onDismiss}>
          Back to the form
        </button>
      </section>
    );
  }

  if (result.kind === "rejected") {
    return (
      <section aria-label="Change refused" className="mt-3">
        <h4 className="text-sm font-semibold text-red-700">Till did not save that</h4>
        <Refusal error={result.error} endpoint={endpoint} />
        <button type="button" className="mt-3 border px-3 py-1 text-sm" onClick={onDismiss}>
          Back to the form
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Change refused" className="mt-3">
      <p className="text-sm text-red-700">
        The dashboard could not read Till&apos;s answer, so it is not claiming anything changed. (
        {result.detail})
      </p>
      <button type="button" className="mt-3 border px-3 py-1 text-sm" onClick={onDismiss}>
        Back to the form
      </button>
    </section>
  );
}

function Refusal({
  error,
  endpoint,
}: {
  readonly error: DashboardError;
  readonly endpoint: EndpointDto;
}) {
  if (error.code === "destination_not_confirmed") {
    return (
      <p className="mt-1 text-sm">
        Till will keep paying out to{" "}
        <code>{endpoint.route?.destinationAddress ?? "the address on the row"}</code> until you
        confirm the new one:{" "}
        <code>{error.destinationAddress ?? "the address you were editing"}</code>. {error.message}
      </p>
    );
  }
  if (error.code === "unauthenticated") {
    return (
      <p className="mt-1 text-sm">
        <a className="underline" href="/sign-in">
          Sign in again
        </a>{" "}
        and come back: Till wrote nothing.
      </p>
    );
  }
  if (error.code === "endpoint_not_found") {
    return <p className="mt-1 text-sm">{error.message} Nothing was written.</p>;
  }
  const issues = Object.values(fieldErrorsFromIssues(error.issues ?? []));
  return (
    <>
      <p className="mt-1 text-sm">{error.message}</p>
      {issues.length === 0 ? null : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {issues.map((copy) => (
            <li key={copy}>{copy}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function reviewOnSubmit(onReview: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onReview();
  };
}

export function EndpointEditor({ endpoint }: { readonly endpoint: EndpointDto }) {
  const [values, setValues] = useState<EditFormValues>(() => editInitial(endpoint));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pendingAddress, setPendingAddress] = useState<string | null>(null);
  const [result, setResult] = useState<EndpointUpdateResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(body: EndpointUpdateRequest): Promise<void> {
    setBusy(true);
    try {
      setResult(await api.updateEndpoint(endpoint.id, body));
      setPendingAddress(null);
      setErrors({});
      setNote(null);
    } finally {
      setBusy(false);
    }
  }

  async function toggleLiveness(): Promise<void> {
    setBusy(true);
    try {
      // Its own body, its own press: `{ active }` and nothing beside it (D9).
      setResult(await api.updateEndpoint(endpoint.id, livenessBody(endpoint)));
    } finally {
      setBusy(false);
    }
  }

  function review(): void {
    const built = buildEditBody(endpoint, values);
    if (built.ok) {
      // Only a change that names no new payout address can get here: `buildEditBody`
      // without a confirmation refuses one, so sending this body cannot move money.
      setErrors({});
      setNote(null);
      void send(built.body);
      return;
    }

    setPendingAddress(null);
    if (built.reason === "nothing-changed") {
      setErrors({});
      setNote("Nothing here has changed yet. Till saves only what you changed.");
      return;
    }
    if (built.reason === "needs-confirmation") {
      // The same press that would have sent it: the address is known, so the
      // confirmation screen can render now instead of asking the seller twice.
      setErrors({});
      setNote(null);
      setPendingAddress(built.shownAddress);
      return;
    }
    setNote(null);
    setErrors(built.errors);
  }

  /**
   * The confirmation press. The body is rebuilt *here*, with `confirmed`, so the
   * `confirmedAddress` Till checks can only have been produced by the confirmation the
   * seller just gave; nothing that was assembled before it is stored to be sent later.
   */
  function confirmChange(): void {
    if (pendingAddress === null) {
      return;
    }
    const built = buildEditBody(endpoint, values, { confirmed: true });
    if (built.ok) {
      void send(built.body);
      return;
    }
    setPendingAddress(null);
    if (built.reason === "invalid") {
      setNote(null);
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setNote(
      "Till was not sent anything: what is on the screen no longer differs from the endpoint's own terms.",
    );
  }

  return (
    <EndpointEditorView
      busy={busy}
      endpoint={endpoint}
      errors={errors}
      note={note}
      onBack={() => setPendingAddress(null)}
      onConfirm={confirmChange}
      onDismiss={() => {
        setResult(null);
        setNote(null);
      }}
      onEdit={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
      onLiveness={() => void toggleLiveness()}
      onReview={review}
      pendingAddress={pendingAddress}
      result={result}
      values={values}
    />
  );
}
