# Architecture

Short, load-bearing version. `docs/ARCHITECTURE.md` is the full design; `docs/PRD.md` is the
requirements; this file is what you need to not break something.

## Shape

One Node process (`apps/api`) serving the paid gateway, the seller dashboard API and three
background loops, plus one Postgres 16 database, plus a Next 15 dashboard (`apps/web`) that
rewrites `/api/*` to the API. No Redis, no queue, no separate worker, no browser test
framework (hard rule 10). In-memory state is allowed only where losing it on restart is
safe: the GW-9 response cache, the rate and gas counters, the requirements cache.

## The paid call (`GET /r/:slug`)

Order is fixed and it is the whole design (hard rule 2): **verify → guards → upstream →
settle**, and settle only on a 2xx.

1. Non-`GET` → `405` with `Allow: GET`, before the endpoint read, the limiter, `verify` and
   any settle. `HEAD` needs its own check inside the GET handler because Hono dispatches it
   there and empties the body afterwards.
2. No/undecodable payment header → `402` with a `PAYMENT-REQUIRED` advertisement built from
   the endpoint's own route (`payTo` is the deposit address, never the seller's account).
3. `verify` through `@fastnear/x402` in-process (`x402/near.ts`); the scheme itself refuses
   an insufficient balance, so Till does not re-check it.
4. Guards: one in-flight payment per payer (read **and** claimed at insert behind a per-payer
   advisory lock — two concurrent delegates both verify and both submit, measured in S6),
   payer strikes (`403 payer_blocked` after two `served_unsettled` in 24 h at that seller,
   exit by the seller's clear or by the window), sponsored-gas budget, request limiter.
5. Upstream dial with the hop-by-hop and payment headers stripped; body capped.
6. 2xx → `settle` (relayer sponsors the gas) → `payment_in` ledger line; non-2xx/timeout →
   `abandoned`, nothing charged, and the same authorization may be retried.

Replay: an authorization that already produced a `settled` row is `409` with the receipt
hash; a paid-but-undelivered body is served from the five-minute cache; a still-`verified`
row is `429`.

## States

- Payment: `verified → settled | abandoned | served_unsettled`, plus `abandoned → verified`
  (the retry edge). `settled` is the only terminal payment state.
- Swap: `pending → processing → succeeded | refunded | failed | incomplete`. Terminal means
  exactly `succeeded`/`refunded`/`failed`; `incomplete` is **not** terminal on purpose, so a
  short deposit stays visible to `PAYOUT_STUCK`. Unknown provider statuses map to
  `processing`. Terminal stamps are sticky and a compare-and-set, never a blind update.
- Money moves are booked as ledger entries by event, one row per event, and
  `ledger_entries` is append-only behind a trigger.

## Data

`sellers` → `endpoints` → `payout_routes` (immutable; a terms change mints a new row and old
payments keep theirs) → `payments` (snapshot of route and amount) → `swaps` (matched to a
payment **only** by transaction hash) → `ledger_entries`. Around it: `discrepancies`
(dedupe key + partial unique index on open rows, so a rule can fire once), `payer_clears`
(append-only watermark; a clear never rewrites a strike), `response_cache` (**dead schema** —
nothing reads or writes it; the live cache is `gateway/response-cache.ts`).

## Reconciliation

Pure rules in `packages/core/src/reconcile/`, one file per code, driven by
`apps/api/src/jobs/reconcile.ts` per seller. A rule reads rows shaped by the caller and
returns findings; it cannot see the database, the network or the clock. P0 codes:
`SERVED_NOT_SETTLED`, `PAYOUT_REFUNDED`, `PAYOUT_FAILED`, `PAYOUT_STUCK`,
`PAYMENT_NOT_SWEPT`.

## Polling

`jobs/poll-payouts.ts` claims the oldest due rows with `SKIP LOCKED`, asks the provider, and
on silence backs off on the attempt gap (`swaps.poll_attempts`, `next_poll_at`) instead of
returning due every pass — otherwise 25 unanswered rows permanently starve a new payout
(D10). `jobs/sweep-stale.ts` runs at boot and settles `verified` rows older than the in-flight
window by reading the chain once, leaving a row alone when the chain is unproven.

## Provider

Everything payout-side goes through `PayoutProvider`. Only `mock` exists: `oneclick/` is two
eight-line placeholders and `createProvider` throws `not implemented (D3)` on the first poll
tick, not at boot. The mock refuses a route it has no script for, refuses a reference it
never issued, and marks every payload `simulated: true`. Defaults stay
`PAYOUT_PROVIDER=mock`, `NEAR_NETWORK=near:testnet`; NEAR Intents has no testnet, so the
payout leg has never moved real money.

## Sessions and secrets

`POST /auth/nonce` + `/auth/verify` are the only unauthenticated `/api` routes: NEP-413
signature over a one-shot challenge, checked against `view_access_key_list` for a full-access
key, then a `till_session` cookie — HS256 JWS on a key derived by HKDF-SHA256 from
`SESSION_SECRET`, payload carrying `purpose: "session"`, `sub`, `acct`, `iat`, `exp`, `jti`.
Every other `/api` route answers `401` without it. `/healthz` and `/api/healthz` share one
handler. `env.ts` is the only reader of `process.env`; nothing loads a `.env` file and creating
one is forbidden.

## How the dashboard gets its CSS

Tailwind v4 compiles through `apps/web/postcss.config.mjs`, which loads the
`@tailwindcss/postcss` dev dependency the human approved on 2026-11-10. Next falls back to its
own built-in PostCSS set when that file is absent, and that set has no Tailwind, so deleting the
config does not fail the build — it silently ships `node_modules/tailwindcss/index.css` verbatim
(preflight and `@theme` only, zero utility rules) and every `className` in the twelve domain
components goes inert. Check `apps/web/.next/static/css/*.css` for a `.flex` rule if the
dashboard ever looks unstyled.
