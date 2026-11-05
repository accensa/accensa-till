import type { EndpointDto } from "@till/core/schemas";

import { displayAmount } from "../../lib/format.ts";

/**
 * One endpoint in the seller's list (UI-2). Two states and nothing else: live, with
 * the link to hand a buyer, or left inactive with the reasons the creation checks
 * stored on the row (PO-2) — which is why a reload still explains itself instead of
 * showing an endpoint that silently does not work.
 */
export type EndpointCardProps = { readonly endpoint: EndpointDto };

export function EndpointCard({ endpoint }: EndpointCardProps) {
  return (
    <article className="border-b p-4">
      <header className="flex items-baseline justify-between gap-4">
        <h3 className="font-semibold">{endpoint.description ?? endpoint.slug}</h3>
        <span className={endpoint.active ? "text-sm text-green-700" : "text-sm text-amber-700"}>
          {endpoint.active ? "Live" : "Not live"}
        </span>
      </header>

      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <dt className="opacity-60">Payment link</dt>
        <dd>
          <a className="underline" href={endpoint.gatewayUrl} rel="noreferrer" target="_blank">
            {endpoint.gatewayUrl}
          </a>
        </dd>
        <dt className="opacity-60">Price</dt>
        <dd>
          {displayAmount(endpoint.priceAmount)} {endpoint.assetContract}
        </dd>
        <dt className="opacity-60">Network</dt>
        <dd>{endpoint.network}</dd>
        <dt className="opacity-60">Upstream</dt>
        <dd>
          <code>{endpoint.upstreamUrl}</code>
        </dd>
        <dt className="opacity-60">Payout mode</dt>
        <dd>{endpoint.payoutMode}</dd>
      </dl>

      {endpoint.creationWarnings.length > 0 ? (
        <section className="mt-3">
          <h4 className="text-sm font-semibold">Why this one is not live</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {endpoint.creationWarnings.map((warning, index) => (
              <li key={`${index}:${warning.slice(0, 24)}`}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-2 text-xs opacity-60">
        Slug <code>{endpoint.slug}</code> — the only name a buyer sees, and not guessable from
        another endpoint's.
      </p>
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
        <p className="text-sm">
          No endpoints yet. Create one below: Till checks it as it is saved and tells you what is
          missing.
        </p>
      ) : (
        <div className="divide-y">
          {endpoints.map((endpoint) => (
            <EndpointCard key={endpoint.id} endpoint={endpoint} />
          ))}
        </div>
      )}
    </section>
  );
}
