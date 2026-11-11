import type { EndpointDto } from "@till/core/schemas";

import { displayAmount } from "../../lib/format.ts";
import { EndpointEditor } from "./EndpointEditor.tsx";

/**
 * One endpoint in the seller's list (UI-2). Two states and nothing else: live, with
 * the link to hand a buyer, or left inactive with the reasons the creation checks
 * stored on the row (PO-2) — which is why a reload still explains itself instead of
 * showing an endpoint that silently does not work.
 *
 * The destination is drawn from `endpoint.route` (D5), and says so when the endpoint
 * has no route at all rather than leaving the field blank: a seller who confirms an
 * empty address has confirmed nothing, and `PATCH` refuses that (F2e-a).
 */
export type EndpointCardProps = { readonly endpoint: EndpointDto };

export function EndpointCard({ endpoint }: EndpointCardProps) {
  return (
    <article className="panel">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={endpoint.active ? "chip chip-live" : "chip chip-warn"}>
              <span
                aria-hidden
                className={`h-1.5 w-1.5 ${endpoint.active ? "bg-mint" : "bg-amber"}`}
              />
              {endpoint.active ? "Live" : "Not live"}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">
              {endpoint.payoutMode} payout
            </span>
          </div>
          <h3 className="mt-3 truncate text-lg font-semibold tracking-[-0.01em] text-bone">
            {endpoint.description ?? endpoint.slug}
          </h3>
        </div>
        <code className="border border-line-bright px-2 py-1 font-mono text-[10px] text-muted">
          {endpoint.slug}
        </code>
      </header>

      <dl className="grid gap-x-6 gap-y-3 px-5 py-5 text-sm sm:grid-cols-[150px_minmax(0,1fr)]">
        <dt className="label pt-0.5">Payment link</dt>
        <dd className="min-w-0">
          <a
            className="link break-all font-mono text-[12px]"
            href={endpoint.gatewayUrl}
            rel="noreferrer"
            target="_blank"
          >
            {endpoint.gatewayUrl}
          </a>
        </dd>

        <dt className="label pt-0.5">Price</dt>
        <dd className="font-mono text-[12px] tabular-nums">
          <span className="text-bone">{displayAmount(endpoint.priceAmount)}</span>{" "}
          <span className="text-faint">{endpoint.assetContract}</span>
        </dd>

        <dt className="label pt-0.5">Network</dt>
        <dd className="font-mono text-[12px] text-muted">{endpoint.network}</dd>

        <dt className="label pt-0.5">Upstream</dt>
        <dd className="min-w-0 break-all font-mono text-[12px] text-muted">
          {endpoint.upstreamUrl}
        </dd>

        <dt className="label pt-0.5">Payout mode</dt>
        <dd className="font-mono text-[12px] text-muted">{endpoint.payoutMode}</dd>

        <dt className="label pt-0.5">Payout destination</dt>
        <dd className="min-w-0 break-all font-mono text-[12px] text-bone">
          {endpoint.route?.destinationAddress ?? "no route set"}
          {/* The address a `direct` endpoint pays is the signed-in account, which the
              browser cannot know; an intents route names the deposit address beside it. */}
          {typeof endpoint.route?.depositAddress === "string" ? (
            <span className="mt-1 block text-faint">
              via <code>{endpoint.route.depositAddress}</code>
            </span>
          ) : null}
        </dd>
      </dl>

      {endpoint.creationWarnings.length > 0 ? (
        <section className="border-t border-line px-5 py-4">
          <h4 className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-amber">
            <span aria-hidden className="h-1.5 w-1.5 bg-amber" />
            Why this one is not live
          </h4>
          <ul className="mt-3 space-y-2">
            {endpoint.creationWarnings.map((warning, index) => (
              <li
                className="border-l border-amber/40 pl-3 text-sm leading-6 text-muted"
                key={`${index}:${warning.slice(0, 24)}`}
              >
                {warning}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="border-t border-line px-5 py-3 font-mono text-[10px] leading-5 tracking-[0.04em] text-faint">
        Slug <code className="text-muted">{endpoint.slug}</code> — the only name a buyer sees, and
        not guessable from another endpoint&apos;s.
      </p>

      {/* D9's `PATCH`, on the row it changes. Folded away because a list of eight
          input boxes per endpoint is not a list; the seller opens it to change terms. */}
      <details className="border-t border-line px-5 py-4">
        <summary className="inline-flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted transition-colors hover:text-acid">
          <span aria-hidden>+</span>
          Change these terms
        </summary>
        <EndpointEditor endpoint={endpoint} />
      </details>
    </article>
  );
}

/**
 * The list the dashboard opens with (UI-2). Empty is stated as empty: a seller who
 * has created nothing must be able to tell that apart from a list that failed to
 * load, and only the second one is a problem.
 */
export function EndpointList({ endpoints }: { readonly endpoints: readonly EndpointDto[] }) {
  return (
    <section aria-label="Endpoints">
      {endpoints.length === 0 ? (
        <div className="panel flex flex-col gap-3 p-8">
          <span className="chip chip-muted w-fit">No endpoints</span>
          <p className="max-w-xl text-sm leading-6 text-muted">
            No endpoints yet. Create one below: Till checks it as it is saved and tells you what is
            missing.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {endpoints.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} />
          ))}
        </div>
      )}
    </section>
  );
}
