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
│   │   ├── migrations/           # generated SQL, committed, includes ledger trigger
│   │   ├── drizzle.config.ts
│   │   ├── src/
│   │   │   ├── server.ts         # Boot only: env, logger, app, listen; the timer loops start here
│   │   │   ├── app.ts            # createApp(env, log) — every route lives where a test can reach it without a port
│   │   │   ├── env.ts            # Zod env validation, fails fast
│   │   │   ├── gateway/
│   │   │   │   ├── route.ts      # /r/:slug handler
│   │   │   │   ├── requirements.ts   # cached x402 payment requirements
│   │   │   │   ├── guards.ts     # strike block (C9) + advertised window + in-flight read (C8); balance is inside verify
│   │   │   │   ├── proxy.ts      # upstream GET, limits, no redirects
│   │   │   │   └── ssrf.ts       # validated-address connect, self-loop check
│   │   │   ├── x402/
│   │   │   │   ├── near.ts       # the only importer of @fastnear x402 packages
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
│   │   │   │   ├── payments.ts   # state transitions
│   │   │   │   ├── strikes.ts    # strike count + appended seller clear (C9)
│   │   │   │   ├── ledger.ts     # the only writer of ledger_entries
│   │   │   │   ├── endpoints.ts  # creation checks: registration, floor, address
│   │   │   │   └── discrepancies.ts
│   │   │   ├── routes/           # dashboard API
│   │   │   │   ├── auth.ts
│   │   │   │   ├── endpoints.ts
│   │   │   │   ├── payments.ts
│   │   │   │   ├── swaps.ts
│   │   │   │   ├── discrepancies.ts
│   │   │   │   └── export.ts     # ledger CSV (P1)
│   │   │   ├── jobs/
│   │   │   │   ├── loop.ts       # timer helper with SKIP LOCKED claiming
│   │   │   │   ├── poll-payouts.ts
│   │   │   │   ├── reconcile.ts  # load snapshot, call core rules, persist findings
│   │   │   │   └── sweep-stale.ts    # abandons stale `verified` payments after restart
│   │   │   └── lib/
│   │   │       ├── logger.ts
│   │   │       └── session.ts    # signed cookies via jose
│   │   └── test/                 # integration tests against docker Postgres
│   │
│   └── web/
│       ├── next.config.ts        # rewrites /api/* to the API
│       ├── app/
│       │   ├── (auth)/sign-in/
│       │   ├── (app)/
│       │   │   ├── page.tsx              # overview (P1 totals)
│       │   │   ├── endpoints/
│       │   │   ├── payments/
│       │   │   └── reconciliation/
│       │   └── layout.tsx                # header: relayer balance, last poll
│       ├── components/
│       │   ├── ui/                       # shadcn components
│       │   └── domain/                   # PaymentRow, DiscrepancyCard, SwapTimeline
│       └── lib/
│           ├── api-client.ts             # typed fetch using core schemas
│           └── format.ts                 # base units to display amounts
│
├── packages/
│   └── core/                     # pure TypeScript, no I/O, no framework imports
│       └── src/
│           ├── ids.ts            # uuid v7 row ids, monotonic within a process
│           ├── money.ts          # bigint helpers, decimals, formatting
│           ├── schemas/          # Zod schemas shared by api and web
│           ├── states.ts         # payment and swap state machines
│           └── reconcile/
│               ├── index.ts      # runAllRules(snapshot)
│               ├── types.ts
│               ├── served-not-settled.ts      # P0
│               ├── payout-refunded.ts         # P0
│               ├── payout-failed.ts           # P0
│               ├── payout-stuck.ts            # P0
│               ├── payment-not-swept.ts       # P0
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
- Only `services/ledger.ts` inserts into `ledger_entries`.
- `payouts` and `x402` never import from `db` or `services`.
- `apps/web` never imports from `apps/api`.
- Every array in `packages/core/src/schemas/` is built with `boundedArray` (`common.ts`), never a bare `z.array(` (C15): zod v3 parses all elements before it checks the array, so an uncapped array turns a large payload into one issue object per element.

## Where does new code go

| You are adding | Put it in |
|---|---|
| Any change at all | Update `ROADMAP.md` in the same change: task status, evidence, changelog line, then `pnpm roadmap` |
| A reconciliation rule | New file in `packages/core/src/reconcile/`, register in `index.ts`, fixture test in `__tests__/` |
| A discrepancy code | Enum in `packages/core/src/schemas/`, the rule, and UI copy in `apps/web/components/domain/DiscrepancyCard.tsx` |
| A payout provider | New folder in `apps/api/src/payouts/`, implement `PayoutProvider`, register in `createProvider` |
| A dashboard endpoint | Zod schema in `packages/core/src/schemas/`, route in `apps/api/src/routes/`, mounted in `app.ts`, call in `apps/web/lib/api-client.ts` |
| A table or column | `apps/api/src/db/schema.ts`, run `pnpm db:generate`, commit the migration |
| A background loop | File in `apps/api/src/jobs/`, start it from `server.ts` |
| A guard on paid requests | `apps/api/src/gateway/guards.ts` with a test in `apps/api/test/` |
| An env var | `env.ts` schema and `.env.example` in the same change |
| A UI primitive | `apps/web/components/ui/` |
| A domain UI component | `apps/web/components/domain/` |

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
| `pnpm demo` | Run upstream, agent and simulated failures; assert outcomes; non-zero exit on failure |
| `pnpm test` | Unit and integration tests |
| `pnpm lint` | Biome check |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
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
- `POLL_INTERVAL_SECONDS`, `RECONCILE_INTERVAL_SECONDS`
- `SWEEP_WINDOW_SECONDS`, `STUCK_WINDOW_SECONDS`, `SHORTFALL_TOLERANCE_BPS`

## AGENTS.md (suggested content, under 30 lines)

1. Read the progress block and your phase in `ROADMAP.md`, then `docs/ARCHITECTURE_ESSENTIALS.md`, before changing anything.
2. Follow the dependency rules in `docs/PROJECT_STRUCTURE.md` and run `pnpm boundaries`.
3. Never write to `ledger_entries` outside `services/ledger.ts`.
4. Never match payments to swaps by amount or time.
5. Update `ROADMAP.md` in every contribution, then run `pnpm lint && pnpm typecheck && pnpm test && pnpm boundaries && pnpm roadmap:check` before declaring work done.
6. Ask before adding a dependency. Do not add Redis, a queue library or a browser test framework.
7. Anything marked VERIFY in `docs/ARCHITECTURE.md` needs its spike closed first.
