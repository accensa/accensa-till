# Modules

Read this before touching a module. Paths are relative to the repo root. `pnpm boundaries`
(`scripts/check-boundaries.sh`) enforces the "Owner" column in CI, so a rule here is not
advisory.

## `packages/core` — shared, dependency-free contract

| Path | Holds | Rules |
|---|---|---|
| `src/money.ts` | `parseAmount`/`formatAmount`/`isShortfall`, `STABLECOIN_DECIMALS = 6` | `bigint` only; rejects anything a float would round |
| `src/states.ts` | payment and swap state machines, `TERMINAL_SWAP_STATES` | terminal is `succeeded`/`refunded`/`failed`; `incomplete` is deliberately absent (S5) |
| `src/schemas/*.ts` | every Zod DTO both apps share (`endpoint`, `payment`, `overview`, `common`) | bounds on every array; money travels as decimal strings; both apps import, neither extends |
| `src/reconcile/*.ts` | one file per discrepancy code, pure rules + `runAllRules` | no DB, HTTP or `Date.now()` inside a rule (hard rule 6) |
| `src/auth/nep413.ts` | NEP-413 signed-message verification | `node:crypto` ed25519 only; no `@fastnear` |
| `src/ids.ts` | UUID v7 generation | app-side ids, not DB defaults |

Owner: nobody but core. Core may not import `drizzle-orm`, `hono`, `postgres`, `jose`,
`next` or any `apps/*` file — the boundary script and `next build` both check it.

## `apps/api` — one process: gateway, dashboard API, background loops

| Path | Holds | Owner rule |
|---|---|---|
| `src/gateway/route.ts` | `GET /r/:slug` + the 405 guard (`refuseMethod`): challenge, verify, guards, upstream, settle, replay | the paid path; state transitions come from here |
| `src/gateway/guards.ts` | GW-5 balance, GW-6 one-in-flight read, GW-7 strikes | guard tests need an accepting and a rejecting case |
| `src/gateway/{proxy,ssrf,limits,response-cache,requirements}.ts` | upstream dial, loopback/private-address refusal, rate + gas budgets, GW-9 replay cache, advertisement cache | `resolveUpstreamTarget` always re-checks the resolved record |
| `src/x402/near.ts` | the only `@fastnear/*` import in the repo | hard rule 1 — nothing else may import it |
| `src/services/ledger.ts` | the only writer of `ledger_entries` | append-only; a DB trigger blocks UPDATE/DELETE |
| `src/services/swaps.ts` | the only writer of the payment↔swap link | joins by transaction hash and nothing else (hard rule 7) |
| `src/services/payout-routes.ts` | prepare/dedupe/insert of immutable routes | never updates a route; a change mints a new row |
| `src/services/discrepancies.ts` | the only writer of `discrepancies` | dedupe key, auto-resolve, severity-ordered worklist |
| `src/services/{endpoints,payments,sellers,access-keys,status,strikes}.ts` | everything else server-side | `strikes.ts` holds the block predicate **and** the clear watermark the gateway enforces |
| `src/jobs/{loop,ticks,poll-payouts,reconcile,sweep-stale}.ts` | the three loops and the boot sweep | assertable bodies live in `ticks.ts`; `server.ts` only starts them |
| `src/routes/*.ts` | dashboard HTTP, all session-gated except `/auth/*` | thin: validate, call a service, map errors. `swaps.ts` and `export.ts` are one-line unmounted stubs; `/assets` has no file |
| `src/payouts/` | `PayoutProvider` interface, `mock/`, `oneclick/` (client + status map) | `createProvider` returns the real client when `PAYOUT_PROVIDER=oneclick`; only its `prepareRoute` refuses, because `originAsset`, `depositType` and `slippageTolerance` are undecided (D3, S2/B8) — the live-money boundary |
| `src/db/{schema,client}.ts`, `src/db/queries/`, `migrations/` | Drizzle schema, one pool, hand-written reads | every money column `numeric(78,0)` with a CHECK |
| `src/lib/{session,logger}.ts`, `src/env.ts`, `src/app.ts`, `src/server.ts` | HKDF+JWS cookie codec, buffered logger, the whole env schema, route mounting, boot | `env.ts` is the only place env is read; `app.ts` takes `AppDeps` seams for tests |

## `apps/web` — Next 15 App Router dashboard

| Path | Holds | Rules |
|---|---|---|
| `app/layout.tsx` | nav + F5's header status; async, reads the cookie, calls `api.status` | server component |
| `app/(app)/*/page.tsx` | endpoints (UI-2), payments (UI-3), reconciliation (UI-4) | server components; no fetching in components |
| `app/(auth)/sign-in` | the F8 wallet-prompt screen | — |
| `components/domain/*.tsx` | the dashboard's components, hand-written, styled from `app/globals.css`'s tokens and component classes | no component library; `components/ui/` is an empty `.gitkeep`; no border radius or gradient |
| `components/domain/{NavLinks,PageHeader}.tsx` | nav with pathname active state; numbered page header | `NavLinks` is client; `PageHeader` is presentational |
| `components/domain/{ReconcileActions,SignInForm,EndpointEditor,CreateEndpointForm}.tsx` | the interactive surfaces | the only `"use client"` boundaries; everything else is server-rendered |
| `lib/api-client.ts` | every `fetch`, each parsed or answered `unreachable` | the only place that talks to the API |
| `lib/{endpoint-form,endpoint-edit,payments,reconcile,header-status,format}.ts` | every rule the browser enforces before sending, as pure functions | a rule needs a test here, not in a component |

## `scripts/` — operator and CI entry points

`demo.ts` (runs PRD §8 end to end and asserts), `demo-agent.ts` (the payer that really
signs and pays), `demo-upstream.ts`, `seed.ts`, `simulate.ts`, `check-boundaries.sh`,
`roadmap-progress.ts`, `check-roadmap.sh`. Files here may not use a bare specifier:
only `apps/*` and `packages/*` install the dependencies, so a script imports through
`apps/api/src/**` paths. `pnpm typecheck` covers them via `tsconfig.scripts.json`.

## Tests

`packages/core/src/**/__tests__/`, `apps/api/test/` (Postgres-backed; skips itself without
`DATABASE_URL`), `apps/web/test/` (Vitest + testing-library), `test/offline-flow.test.ts`
for the scripts. A database test never asserts on rows another test could have written:
scope by the ids it created.
