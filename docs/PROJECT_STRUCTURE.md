# PROJECT_STRUCTURE: Till (working name)

Version 2.1. Where everything lives and where new code goes. Companion to `ARCHITECTURE.md`.

Change in 2.1: added `ROADMAP.md` at the root with its tooling and the rule that it is updated in every contribution.

Change from v1: `packages/db`, `packages/payouts` and `packages/x402` became folders inside `apps/api`, the worker entry point and Playwright were removed, and the grep boundary check was added. Only `packages/core` remains shared, because the web app is the only other consumer.

## Repository layout

```
till/
├── README.md                     # what is real vs mocked, known limitations, quickstart
├── AGENTS.md                     # rules for coding agents (shared)
├── CLAUDE.md                     # Claude Code additions; imports AGENTS.md
├── ROADMAP.md                    # live task list and status; updated in EVERY contribution
├── package.json                  # root scripts only
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.scripts.json         # the root `typecheck` runs it over `scripts/`, which no workspace package covers
├── biome.json
├── docker-compose.yml            # postgres, api, web
├── .env.example                  # every variable; defaults to mock payouts
├── .github/
│   ├── workflows/ci.yml          # lint, typecheck, test, boundaries, roadmap check, demo
│   └── pull_request_template.md  # includes the ROADMAP.md checkbox
│
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── ARCHITECTURE_ESSENTIALS.md
│   ├── PROJECT_STRUCTURE.md
│   └── spikes/                   # S1.md to S7.md, one result file each
│
├── apps/
│   ├── api/
│   │   ├── migrations/           # generated SQL, committed; 0001 and 0007 are hand-written triggers (ledger append-only, payout_routes immutable)
│   │   ├── drizzle.config.ts
│   │   ├── src/
│   │   │   ├── server.ts         # Boot only: env, logger, app, listen; the timer loops start here
│   │   │   ├── app.ts            # createApp(env, log) — every route lives where a test can reach it without a port
│   │   │   ├── env.ts            # Zod env validation, fails fast
│   │   │   ├── gateway/
│   │   │   │   ├── route.ts      # /r/:slug handler
│   │   │   │   ├── requirements.ts   # cached x402 payment requirements
│   │   │   │   ├── guards.ts     # strike block (C9) + advertised window + in-flight read (C8); balance is inside verify
│   │   │   │   ├── limits.ts     # GW-10: fixed-window request limiter and global sponsored-gas budget (C13)
│   │   │   │   ├── response-cache.ts # GW-9: five-minute replay of a settled answer (C12)
│   │   │   │   ├── proxy.ts      # upstream GET, limits, no redirects
│   │   │   │   └── ssrf.ts       # validated-address connect, self-loop check
│   │   │   ├── x402/
│   │   │   │   ├── near.ts       # the only importer of @fastnear x402 packages; verify, settle, settlementStatus
│   │   │   │   └── types.ts      # our own types so library types do not leak
│   │   │   ├── payouts/
│   │   │   │   ├── provider.ts   # PayoutProvider interface, normalized types
│   │   │   │   ├── index.ts      # createProvider(env)
│   │   │   │   ├── oneclick/
│   │   │   │   │   ├── client.ts     # the only code that calls the 1Click API
│   │   │   │   │   └── map-status.ts # provider status to normalized state
│   │   │   │   └── mock/
│   │   │   │       ├── provider.ts   # scripted: succeed, refund, fail, stall
│   │   │   │       └── scenarios.ts  # one outcome driven to the rows the rules read (D2)
│   │   │   ├── db/
│   │   │   │   ├── schema.ts     # Drizzle tables
│   │   │   │   ├── client.ts
│   │   │   │   └── queries/      # read helpers grouped by table
│   │   │   ├── services/
│   │   │   │   ├── payments.ts   # state transitions; listPaymentsForSeller is UI-3's scoped read
│   │   │   │   ├── strikes.ts    # strike count + appended seller clear (C9), and the grouped list of who is held on that same predicate (UI-4)
│   │   │   │   ├── ledger.ts     # the only writer of ledger_entries
│   │   │   │   ├── endpoints.ts  # creation checks: registration, floor, address (D4); resolves the payout route before the insert (D5); changes a live endpoint's terms whole or not at all (D9)
│   │   │   │   ├── payout-routes.ts # the only writer of payout_routes: one standing quote per destination and mode, never an update (D5)
│   │   │   │   ├── access-keys.ts # the chain read sign-in needs: is this key full access on that account (F1)
│   │   │   │   ├── sellers.ts    # the only place a seller row is created, keyed by account name (F1)
│   │   │   │   ├── discrepancies.ts  # the only writer of discrepancies; dedupe, auto-resolve, manual close (E8), the severity-ordered open worklist (UI-4)
│   │   │   │   └── swaps.ts      # the only writer of the payment↔swap link; joins by transaction hash and nothing else, and reports what it cannot join (E2)
│   │   │   ├── routes/           # dashboard API
│   │   │   │   ├── auth.ts       # nonce + verify, the only routes that answer without a session (F1)
│   │   │   │   ├── endpoints.ts  # GET list / POST create with confirmation (D4); PATCH one endpoint's terms on the same checks and the same echo (D9)
│   │   │   │   ├── payments.ts  # GET /payments, scoped by the endpoint join, 500 on an unreadable row (UI-3)
│   │   │   │   ├── swaps.ts
│   │   │   │   ├── discrepancies.ts # GET the worklist and the holds, POST a resolve and a clear, every one scoped by the session (UI-4)
│   │   │   │   └── export.ts     # ledger CSV (P1)
│   │   │   ├── jobs/
│   │   │   │   ├── loop.ts       # timer helper with SKIP LOCKED claiming
│   │   │   │   ├── poll-payouts.ts # claims due swaps, asks the provider, books the answer, and names the sellers it moved (D6)
│   │   │   │   ├── reconcile.ts  # one transaction per seller: claim it, read its snapshot on the database clock, call core's rules, write the findings (E9)
│   │   │   │   ├── ticks.ts      # the two loop bodies: poll and then reconcile the sellers it moved, and reconcile everyone on the other interval (E9)
│   │   │   │   └── sweep-stale.ts    # boot sweep (C10): stale `verified` rows by row evidence + chain read
│   │   │   └── lib/
│   │   │       ├── logger.ts
│   │   │       └── session.ts    # two HKDF-derived signed cookies via jose: session and spent challenge (F1)
│   │   └── test/                 # integration tests against docker Postgres
│   │
│   └── web/                       # Next 15 App Router, single origin (A5)
│       ├── next.config.ts        # rewrites /api/* to the API, baked at build time from API_ORIGIN
│       ├── vitest.config.ts      # JSX through esbuild; the suite runs in Node, no browser
│       ├── test/                 # the form and edit rules, the client against a fetch stub, rendered markup
│       ├── app/
│       │   ├── (auth)/sign-in/   # stub until F8: needs a browser wallet prompt, and that package is F8's open question
│       │   ├── (app)/
│       │   │   ├── page.tsx              # overview (P1 totals)
│       │   │   ├── endpoints/            # page.tsx is UI-2: lists and creates, server component
│       │   │   ├── payments/             # page.tsx is UI-3: the seller's ledger, server component
│       │   │   └── reconciliation/       # page.tsx is UI-4: the open items and the holds, server component
│       │   └── layout.tsx                # nav; F5's header status (balance, last poll) is still to come
│       ├── components/
│       │   ├── ui/                       # shadcn components
│       │   └── domain/                   # EndpointCard, CreateEndpointForm, CreationCheckResults,
│       │                                 #   SessionNotice, PaymentTable, PaymentRow, SwapTimeline,
│       │                                 #   DiscrepancyCard + PayerBlockTable (UI-4, presentational),
│       │                                 #   ReconcileActions (UI-4: the screen's one "use client" boundary),
│       │                                 #   EndpointEditor (F9: D9's PATCH, view + container)
│       └── lib/
│           ├── api-client.ts             # every fetch, each response parsed or answered `unreachable`
│           ├── endpoint-form.ts          # the form's rules as plain functions, no React
│           ├── endpoint-edit.ts          # the edit's rules: the diff, the echo, the pause body
│           ├── payments.ts                 # explorer link per row, the four state words, the copy
│           ├── reconcile.ts              # severity words, an age against a passed-in clock, the empty and held copy
│           └── format.ts                 # base units to display amounts
│
├── packages/
│   └── core/                     # pure TypeScript, no I/O, no framework imports
│       └── src/
│           ├── ids.ts            # uuid v7 row ids, monotonic within a process
│           ├── money.ts          # bigint helpers, decimals, formatting
│           ├── auth/             # NEP-413: borsh payload, sha256, ed25519 verify, nonce (F1)
│           │   ├── index.ts
│           │   └── nep413.ts     # no framework, no @near-js import — node:crypto only, vectors measured against the library
│           ├── schemas/          # Zod schemas shared by api and web
│           ├── states.ts         # payment and swap state machines
│           └── reconcile/
│               ├── index.ts      # runAllRules(snapshot)
│               ├── types.ts
│               ├── served-not-settled.ts      # P0
│               ├── payout-refunded.ts         # P0
│               ├── payout-failed.ts           # P0
│               ├── payout-stuck.ts            # P0
│               ├── payment-not-swept.ts       # P0; skips direct payments (D8)
│               ├── payout-shortfall.ts        # P1
│               ├── incomplete-deposit.ts      # P1
│               ├── orphan-deposit.ts          # P1
│               └── __tests__/                 # one fixture-driven test per rule
│
├── scripts/
│   ├── demo-agent.ts             # buyer agent that pays a seller endpoint
│   ├── demo-upstream.ts          # tiny upstream API for the demo
│   ├── demo.ts                   # orchestrates the demo and asserts outcomes
│   ├── seed.ts                   # seller, endpoint, route
│   ├── simulate.ts               # pnpm simulate: the scripted payout outcomes, offline
│   ├── check-boundaries.sh       # grep-based import rules, run in CI
│   ├── roadmap-progress.ts       # regenerates the ROADMAP.md progress block; --check mode for CI
│   ├── check-roadmap.sh          # fails if a change leaves ROADMAP.md untouched
│   └── spikes/                   # throwaway scripts for S1 to S7, kept as evidence
```

## apps/web

Runs beside `apps/api` as its own process and talks to it over HTTP on one origin.

```
app/(app)/endpoints/page.tsx     # lists and creates on the session (UI-2)
app/(app)/payments/page.tsx        # the same read shape for the ledger (UI-3)
app/(app)/reconciliation/page.tsx  # the open items and the holds, read on the session (UI-4)
components/domain/               # what a seller sees; each renders a named type
  EndpointCard.tsx               # one endpoint: live, or not live with D4's reasons, its destination from its route
  EndpointEditor.tsx             # change these terms: view + container, the confirmation step (F9, "use client")
  CreateEndpointForm.tsx         # edit → confirm → result ("use client")
  CreationCheckResults.tsx       # failed checks first, then the passed ones
  SessionNotice.tsx              # the three screens that are not a list
PaymentTable.tsx                 # one row per payment, linked to its transaction (UI-3)
DiscrepancyCard.tsx              # one open item, quoting the finding's own two sentences (UI-4)
PayerBlockTable.tsx              # who is held, with the count that put them there (UI-4)
ReconcileActions.tsx             # the screen's one "use client": both lists, both actions ("use client")
lib/api-client.ts                # every fetch in the app, and the only place that parses
lib/endpoint-form.ts             # the rules, as plain functions (buildCreateInput, orderChecks)
lib/endpoint-edit.ts             # the edit's rules as plain functions (buildEditBody, livenessBody, changeRows)
lib/payments.ts                    # paymentTxLink, paymentStateWords, the seller-facing copy
lib/reconcile.ts                 # severityWords, discrepancyAge(openedAt, nowMs), the empty and held copy
lib/format.ts                    # base units → decimal, for display only
test/                            # the rules, the client against a fetch stub, the rendered markup
next.config.ts                   # /api/* → API_ORIGIN, which makes the cookie first-party
```

- **A body that will not parse is `unreachable`, never an empty list** (F2). `api.endpoints()` and `api.createEndpoint()` return a small named union — `ok`/`created`, `signed_out`/`rejected`, `unreachable` — and each arm is checked against the schemas in `packages/core/src/schemas/endpoint.ts` before it is returned. An unverified response is not a verified empty one: on the client this replaced, contract drift rendered "No endpoints yet" and invited the seller to create a second endpoint that already exists. `test/api-client.test.ts` pins the negative case. `api.updateEndpoint()` (F9) has four arms and two of them are `422`: `refused` is the check list *with* the live terms beside it, `rejected` is the request itself being refused, and folding the first into the second would throw away the price the endpoint is actually charging.
- **A payment list is scoped by a join, and a link is only drawn where one exists** (UI-3). `listPaymentsForSeller` filters on `endpoints.seller_id` because a payment row has no seller of its own; adding a column would put the same fact in two places that can disagree. `paymentTxLink` returns `null` for a hash that is not on chain yet and for a network Till has no explorer for, and `PaymentTable` then says so in words instead of wrapping the hash in an anchor — a wrong explorer URL is read as evidence. `selfPayment` is decided against the session's own account, so a seller testing with their wallet sees *a test, not revenue*.
- **"The page contains this string" is not a test of a Next page.** `next start` ships both the rendered markup and the RSC payload with the same text inside `<script>` tags, so a count over raw HTML reads 2 where a browser paints 1. Its server render also separates adjacent text with `<!-- -->` and escapes `'` as `&#x27;`, so `2 unpaid serves` and a sentence with an apostrophe do not appear as written — and `renderToStaticMarkup` does neither, which is why the same assertion can pass in a unit test and fail against the running app. Live checks strip the scripts, drop the comments and decode the entities first (`ROADMAP.md` section 8, 2026-11-05).
- **One client boundary per screen, and it re-reads rather than hoping** (UI-4). The page is a server component because the session cookie is `HttpOnly`; it hands both lists to `ReconcileActions`, which owns the busy state and, after an action the API accepted, calls the read again instead of marking the row closed itself. The order of the cards is the API's — `listOpenDiscrepanciesForSeller` builds its `CASE` from core's `SEVERITIES` and the page sorts nothing, because a second sort is a second opinion about what is most urgent. The screen's own copy carries no digits: the strike window and threshold are C9's and live in `apps/api`, which web must not import, so each row states its own count instead.
- **The form's rules are functions, not JSX.** `lib/endpoint-form.ts` decides what is valid, what the confirmation table shows and what a refusal's sentence is; `CreateEndpointForm.tsx` only calls it. That is what makes UI-2's acceptance testable in Node, which is where it runs today.
- **An edit sends a diff, and pausing is its own body** (F9, PO-7). `lib/endpoint-edit.ts` compares the form against the endpoint it was given and puts only the differences in the `PATCH` body, because D9 merges whatever it receives onto the stored terms — so a form that resubmitted everything would name fields nobody touched, and two of those are not innocent: `active` (an edit that reopened a paywall somebody paused) and `destinationAddress` (a payout route nobody confirmed). Hence `livenessBody`, which is the pause button's whole request, and `buildEditBody`, which refuses an address change it has not been shown a confirmation for. `EndpointEditor` keeps only the *address* it is waiting on and rebuilds the body when the seller confirms, so a `confirmedAddress` cannot exist in a request that was assembled before that step; the mutation that deletes the guard fails two tests, and the one that adds an `active` checkbox fails the render test that looks for it.
- **`apps/web` imports `@till/core/schemas` and `@till/core/money`, never `@till/core`.** The barrel re-exports `ids.ts` and `auth/nep413.ts`, both of which import `node:crypto`, and webpack refuses a `node:` specifier in a client bundle. The dependency rule below says what enforces it.
- **`API_ORIGIN` is read twice with different lifetimes**: `next build` bakes the `/api/*` rewrite into `.next/routes-manifest.json`, while `lib/api-client.ts` reads the variable per request for the server component's fetch. Set it before the build when the API is not on `PORT`'s default, or the rewrite answers 500 while the page itself loads.
- **Tests render with `react-dom/server`, not a browser.** `vitest.config.ts` turns JSX through esbuild (the tsconfig keeps `jsx: "preserve"` for Next) and the suite asserts the text a seller would read; `test/react-dom-server.d.ts` declares the one entry point they call, because `@types/react-dom` would be a new dependency (C19). No click simulation: a click only sets state, and the state a click would set is passed to these components as a prop.

## Dependency rules

Violating these is a bug, not a style issue. `scripts/check-boundaries.sh` enforces them in CI.

```
apps/web  ──►  packages/core
apps/api  ──►  packages/core
packages/core  ──►  nothing in the workspace
```

Inside `apps/api/src`:

```
gateway, routes, jobs  ──►  services, payouts, x402, db, lib
services               ──►  db, lib
payouts, x402          ──►  lib (and packages/core)
db                     ──►  lib
```

- `packages/core` imports no database, HTTP or framework code.
- Only `payouts/oneclick/client.ts` calls the 1Click API.
- Only `x402/near.ts` imports `@fastnear/*` x402 packages.
- Only `services/ledger.ts` inserts into `ledger_entries`. `scripts/check-boundaries.sh` greps for the write outside that file, and the grep was watched doing its job: a planted second writer made the gate print the rule with the offending file and line and exit 1 (E1). The service's four writers take `Omit<LedgerWrite, "kind">`, so the kind is the function's and not the caller's — a `recordPayoutOut(db, { kind: "refund_in" })` does not compile, which is the mistake an append-only ledger exists to make impossible.
- A test suite that writes ledger rows cannot delete them, in `test/` or anywhere else: A7's trigger refuses `DELETE` on `ledger_entries`, then the foreign key refuses the payment a ledger row points at, then the endpoint behind that. So a DB-backed suite mints its own ids per run and asserts counts filtered by them, and leaves its rows in the database (`append-only.test.ts` and `ledger.test.ts` both end with `sql.end()` and nothing else). That is not a leak to fix but the table's rule applied to the test, and it is the reason no test here counts a whole table.
- Only `services/payout-routes.ts` inserts into `payout_routes`, and nothing in `apps/api/src` updates, deletes or raw-writes it (D5). Two guards, deliberately redundant: `scripts/check-boundaries.sh` greps the source so a rewrite fails the commit, and migration `0007_payout_routes_immutable.sql` raises at the database so a row cannot be edited after the fact. The grep cannot see a rewrite that already happened and the trigger cannot stop the code from being written, so neither alone is the rule.
- Only `services/swaps.ts` links a payment to a swap (E2, LR-2). The column is `swaps.payment_id`, and the rule is about who may write it, not about who may write `swaps`: D6's poller owns a swap's state, amounts and timestamps, and may not decide which payment the money belongs to. `scripts/check-boundaries.sh` greps for a `set({ paymentId })` (or a raw `payment_id` assignment) outside that file, and the rule was watched firing — a planted second writer printed the rule with the offending file and line and exited 1, then was deleted and the gate re-run green. The other half of hard rule 5, "never match by amount or time", is *not* expressible as a grep: text cannot prove the absence of a heuristic. It is held instead by `test/swap-matching.test.ts`, which links two rows whose amount and timestamps disagree and refuses two rows whose amount, asset and both timestamps agree, so a matcher that drifted toward a heuristic fails a test rather than passing a build.
- Only `services/discrepancies.ts` writes the `discrepancies` table (E9, LR-4). Rules are pure and never touch it; `jobs/reconcile.ts` hands its findings to `writeFindings` *inside the transaction that holds the seller's claim*, and the dashboard closes a row through `resolveManually` in this same file rather than with an UPDATE of its own. One owner matters because that file owns two answers nothing else can recompute: which cause a row *is* (`dedupeKeyFor`) and when it was first seen (`opened_at`, which a re-run must not move). The grep was watched firing at a planted second writer — an UPDATE and an INSERT in a new file, both printed with file and line, gate exit 1 — then deleted and re-run green.
- `payouts` and `x402` never import from `db` or `services`.
- `apps/web` never imports from `apps/api`.
- `apps/web` never imports `@till/core` itself, only its browser-safe subtrees `@till/core/schemas`, `@till/core/money`, `@till/core/states`. The barrel reaches `node:crypto` and a client bundle cannot contain it, so `scripts/check-boundaries.sh` runs `next build` and lets the bundler judge the whole tree instead of grepping for one specifier: a core subtree that re-exported `ids.ts` passed every string rule and failed the build (observed 2026-11-05). Cost is about 16 seconds on `pnpm boundaries`.
- Every array in `packages/core/src/schemas/` is built with `boundedArray` (`common.ts`), never a bare `z.array(` (C15): zod v3 parses all elements before it checks the array, so an uncapped array turns a large payload into one issue object per element.

## Where does new code go

| You are adding | Put it in |
|---|---|
| Any change at all | Update `ROADMAP.md` in the same change: task status, evidence, changelog line, then `pnpm roadmap` |
| A reconciliation rule | New file in `packages/core/src/reconcile/`, register in `index.ts`, fixture test in `__tests__/` |
| A change to who may sign in | The message encoding and verification in `packages/core/src/auth/` (pure, `node:crypto` only), the cookie codec in `apps/api/src/lib/session.ts`, the chain read in `apps/api/src/services/access-keys.ts`, the refusal codes in `apps/api/src/routes/auth.ts` |
| A discrepancy code | Enum in `packages/core/src/schemas/`, the rule, and its two sentences in that rule — `DiscrepancyCard.tsx` prints what the finding says and invents none of it (LR-4, UI-4) |
| A payout provider | New folder in `apps/api/src/payouts/`, implement `PayoutProvider`, register in `createProvider` |
| A dashboard endpoint | Zod schema in `packages/core/src/schemas/`, route in `apps/api/src/routes/`, mounted in `app.ts`, call in `apps/web/lib/api-client.ts` |
| A table or column | `apps/api/src/db/schema.ts`, run `pnpm db:generate`, commit the migration |
| A background loop | File in `apps/api/src/jobs/`, its body in `ticks.ts`, and start it from `server.ts` — a test cannot import `server.ts` without binding a port, so nothing that must be asserted on belongs in the `startLoop` call |
| A guard on paid requests | `apps/api/src/gateway/guards.ts` with a test in `apps/api/test/` |
| An env var | `env.ts` schema and `.env.example` in the same change — except a variable only `apps/web` reads (`API_ORIGIN`), which has no `env.ts` and is documented in `.env.example` and the apps/web section above |
| A UI primitive | `apps/web/components/ui/` |
| A domain UI component | `apps/web/components/domain/` |
| A rule the dashboard enforces before sending | A pure function in `apps/web/lib/`, beside `endpoint-form.ts`, with its own test — a component cannot be asserted on without a browser |
| A screen a seller reaches with no session, or with one the API refuses | `apps/web/components/domain/SessionNotice.tsx`; the route's server component chooses which of the three kinds to show |
| A field of the dashboard contract | `packages/core/src/schemas/`, and then make the API's own suite parse it (`endpoints.test.ts`, `payments-route.test.ts`) — a schema the API never reads is documentation, not a guard |

## Naming and conventions

- Files `kebab-case.ts`; React components `PascalCase.tsx`.
- Database columns `snake_case`; TypeScript fields `camelCase`.
- Money fields end in `Amount` in code and hold `bigint` base units.
- Reconciliation codes are `SCREAMING_SNAKE_CASE`, identical in code, database and UI copy keys.
- Tests sit beside the code or in a package-level `test/` folder; rule tests live in `__tests__/`.
- No default exports except Next.js pages and layouts.

## Root scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Run API and web with local Postgres |
| `pnpm db:generate` | Generate a migration from the schema |
| `pnpm db:migrate` | Apply migrations |
| `pnpm seed` | Create a demo seller, endpoint and route |
| `pnpm demo` | Run the PRD section 8 walk (its own upstream, agent, simulated chain and payouts) against Postgres; assert outcomes; non-zero exit on failure |
| `pnpm test` | Unit and integration tests |
| `pnpm lint` | Biome check |
| `pnpm typecheck` | `tsc --noEmit` across the workspace, plus `tsconfig.scripts.json` over `scripts/` |
| `pnpm boundaries` | Run the import-boundary check |
| `pnpm roadmap` | Regenerate the `ROADMAP.md` progress block |
| `pnpm roadmap:check` | Fail if `ROADMAP.md` is untouched by a change or its progress block is stale |

## Environment variables (names only; see `.env.example`)

- `DATABASE_URL`
- `NEAR_NETWORK`, `NEAR_RPC_URL`
- `RELAYER_ACCOUNT_ID`, `RELAYER_SECRET_KEY`
- `PAYOUT_PROVIDER` (`mock` or `oneclick`)
- `ONECLICK_BASE_URL`, `ONECLICK_JWT`
- `SESSION_SECRET`
- `GATEWAY_PUBLIC_URL`
- `UPSTREAM_TIMEOUT_MS`, `UPSTREAM_MAX_BYTES`, `AUTHORIZATION_EXPIRY_MARGIN_MS`
- `MAX_SPONSORED_GAS`, `MIN_PRICE_BASE_UNITS`
- `POLL_INTERVAL_SECONDS`, `POLL_MAX_BACKOFF_SECONDS`, `RECONCILE_INTERVAL_SECONDS`
- `STUCK_WINDOW_SECONDS`, `SWEEP_WINDOW_SECONDS`, `SHORTFALL_TOLERANCE_BPS`

`C10`'s boot sweep has no window variable of its own: it uses Guard 3's derived
in-flight window (`UPSTREAM_TIMEOUT_MS + AUTHORIZATION_EXPIRY_MARGIN_MS`), because
that is the rule that decides when a `verified` row stopped meaning "being served
right now". A second knob could drift from it.

## AGENTS.md (suggested content, under 30 lines)

1. Read the progress block and your phase in `ROADMAP.md`, then `docs/ARCHITECTURE_ESSENTIALS.md`, before changing anything.
2. Follow the dependency rules in `docs/PROJECT_STRUCTURE.md` and run `pnpm boundaries`.
3. Never write to `ledger_entries` outside `services/ledger.ts`.
4. Never match payments to swaps by amount or time.
5. Update `ROADMAP.md` in every contribution, then run `pnpm lint && pnpm typecheck && pnpm test && pnpm boundaries && pnpm roadmap:check` before declaring work done.
6. Ask before adding a dependency. Do not add Redis, a queue library or a browser test framework.
7. Anything marked VERIFY in `docs/ARCHITECTURE.md` needs its spike closed first.
