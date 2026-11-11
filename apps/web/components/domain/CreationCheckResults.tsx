import type { CreationCheck } from "@till/core/schemas";

import { orderChecks } from "../../lib/endpoint-form.ts";

/**
 * Every creation check, in the order a seller needs them (UI-2, PO-2): the ones
 * that failed first, then the ones that passed.
 *
 * There is deliberately no code-to-copy table here, unlike
 * `domain/DiscrepancyCard.tsx`. A creation check already carries the sentence the
 * API's rule wrote — "register the token storage first or payments would be
 * refused" — and a second copy in the UI would be a string that can disagree with
 * the rule that produced it. The code is shown beside it as the thing to quote when
 * the seller asks.
 */
export type CreationCheckResultsProps = { readonly checks: readonly CreationCheck[] };

export function CreationCheckResults({ checks }: CreationCheckResultsProps) {
  // The keys pair a code with its position because a code is not unique: the
  // storage rule runs once per account it has to check.
  const { failed, passed } = orderChecks(checks);
  return (
    <div className="mt-5 border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-coal px-4 py-3">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone">
          {failed.length === 0
            ? "Every creation check passed"
            : `${failed.length} ${failed.length === 1 ? "check" : "checks"} to fix`}
        </h3>
        <span className={`chip ${failed.length === 0 ? "chip-live" : "chip-warn"}`}>
          {failed.length === 0 ? "Clear" : "Blocked"}
        </span>
      </div>

      {failed.length > 0 ? (
        <ul className="divide-y divide-line">
          {failed.map((check, index) => (
            <li
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4"
              key={`${check.code}:${index}`}
            >
              <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-danger">
                Failed
              </span>
              <div className="min-w-0">
                <code className="font-mono text-[11px] text-bone">{check.code}</code>
                <p className="mt-1 text-sm leading-6 text-muted">{check.message}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {passed.length > 0 ? (
        <details className="border-t border-line">
          <summary className="cursor-pointer px-4 py-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted transition-colors hover:text-bone">
            <span aria-hidden className="mr-2 text-acid">
              +
            </span>
            {passed.length} passed ({passed.map((check) => check.code).join(", ")})
          </summary>
          <ul className="divide-y divide-line border-t border-line">
            {passed.map((check, index) => (
              <li
                className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4"
                key={`${check.code}:${index}`}
              >
                <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-mint">
                  Passed
                </span>
                <div className="min-w-0">
                  <code className="font-mono text-[11px] text-bone">{check.code}</code>
                  <p className="mt-1 text-sm leading-6 text-muted">{check.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
