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
    <div className="mt-4">
      <h3 className="font-semibold">
        {failed.length === 0
          ? "Every creation check passed"
          : `${failed.length} ${failed.length === 1 ? "check" : "checks"} to fix`}
      </h3>
      {failed.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {failed.map((check, index) => (
            <li className="text-sm" key={`${check.code}:${index}`}>
              <span className="text-red-700">Failed</span> <code>{check.code}</code>
              <p className="opacity-80">{check.message}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {passed.length > 0 ? (
        <details className="mt-3">
          <summary className="text-sm cursor-pointer">
            {passed.length} passed ({passed.map((check) => check.code).join(", ")})
          </summary>
          <ul className="mt-2 space-y-2">
            {passed.map((check, index) => (
              <li className="text-sm" key={`${check.code}:${index}`}>
                <span className="text-green-700">Passed</span> <code>{check.code}</code>
                <p className="opacity-80">{check.message}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
