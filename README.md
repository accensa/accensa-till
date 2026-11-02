# Till (working name)

Seller-side back-office for [x402](https://www.x402.org/) payments on NEAR.

An API seller can already take money from AI agents and still not know whether
every payment became a payout. Till points at an existing GET endpoint, paywalls
it with x402, routes the payout through [NEAR Intents](https://near-intents.org/)
to whichever chain and stablecoin the seller picks, and keeps an append-only
ledger that matches every payment to every payout by transaction hash — then
raises an alert in plain language when the two disagree.

Read [`docs/PRD.md`](docs/PRD.md) for scope and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
for the design. Status and open work live in [`ROADMAP.md`](ROADMAP.md).

## What is real, and what is not

This repository is currently **documentation and a scaffold**. Be exact about it:

| | State |
|---|---|
| Product and architecture design | Real. Seven documents, red-teamed, in `docs/`. |
| Folder structure and module boundaries | Real. Every path in [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md) exists. |
| Data model | Real. `apps/api/src/db/schema.ts` and the drizzle-kit generated `apps/api/migrations/` cover all eight tables, and `0001_ledger_append_only.sql` carries the append-only trigger. Six tests run against a live Postgres 16 and prove `UPDATE` and `DELETE` on `ledger_entries` raise and that the discrepancy dedupe index collapses a repeated open cause to one row — including a check that the tests fail when either guard is removed. |
| Reconciliation rules | Drafted. The five P0 rules are implemented as pure functions in `packages/core/src/reconcile/`; only `served-not-settled` has tests that execute (2 pass), the other rule files skip as `it.todo`, and the three P1 rules return nothing because they depend on spike S2. |
| Money and state helpers | Money is real: `packages/core/src/__tests__/money.test.ts` runs 12 passing tests over parsing, formatting, integer-only shortfall and a value past `Number.MAX_SAFE_INTEGER`. `states.ts` is written and still has no test (that is C3). |
| Gateway, payouts, dashboard, jobs | Empty files with contracts and comments. Every one of them throws `not implemented` with its task ID. |
| x402 on NEAR, Intents payouts | **Not written, not proven.** Spikes S1 to S7 are all open. |
| CI guard scripts | **Run, and they work.** `sh scripts/check-boundaries.sh` passes on this scaffold and exits 1 on each injected violation (`@fastnear` outside `x402/near.ts`, a float money literal, a `drizzle-orm` import in `packages/core`). `pnpm roadmap:check` exits 1 both when `ROADMAP.md` is stale and when a change touches code but not the roadmap — the second case verified against a temporary commit, not by reasoning, because a dirty worktree reproduces it falsely. |

The scaffold executes: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm boundaries` and `pnpm roadmap` all pass on Node 22, the API boots and answers `/healthz` and `/api/healthz`, refuses to start on a missing env var, and the Next dev server reaches the API through the `/api/*` rewrite. What has *not* happened: a paid request, a proxy to an upstream, a payout, a ledger entry written by the gateway, `docker compose up` (no Compose v2 on this machine), and a green GitHub Actions run — the workflow has never completed, so the CI scripts are proven locally only.

## Known limitations

- **The headline feature is unproven.** Whether an Intents deposit address can
  act as an x402 `payTo` is spike S1. If it fails, `direct` mode plus
  reconciliation becomes the product and Intents payouts become the stretch goal.
- Micropayment economics are unmeasured, so `MIN_PRICE_BASE_UNITS` is a
  placeholder (S7).
- Matching payments to swaps by transaction hash assumes deposits report origin
  hashes (S2). Without it, reconciliation is materially weaker.
- The project name is a working name; `accensa-till` is the repo, "Till" appears
  throughout the docs, and renaming is open work under A1.
- The migration set is drizzle-kit generated except `0001_ledger_append_only.sql`:
  a generator cannot express a trigger, so that file is hand written and
  registered in `migrations/meta/_journal.json`. If a later `pnpm db:generate`
  takes the 0001 slot, renumber it — the header comment says how.
- Dependencies are installed and `pnpm-lock.yaml` is committed, so the version
  ranges are resolved and `--frozen-lockfile` works. Nothing above `postgres`,
  `drizzle-orm`, `hono`, `next`, `zod`, `jose`, `vitest` and `biome` is in the
  manifest yet, and `@fastnear` packages plus `@near-intents` clients are not
  installed because no spike has asked for them (AGENTS.md: ask first).
- `docker compose` v2 is not installed on the machine that wrote this, so
  `docker-compose.yml` has only been checked as YAML, not as a Compose file. The
  local `docker-compose` is legacy v1 and rejects Compose Spec keys like `name:`.
- GitHub Actions has never produced a green run for this repository, so CI is
  verified step by step locally rather than observed on the runner.

## Quickstart

The database and the two dev servers work; the end-to-end demo does not, and
that is the honest state rather than an oversight. `pnpm seed` and `pnpm demo`
throw `not implemented` until the gateway and the mock provider exist (C11, D2,
G1), which is also why the `demo` CI job is manual-dispatch only for now.

```sh
pnpm install
pnpm db:migrate            # needs Postgres: docker compose up db
pnpm test                  # core money tests; the Postgres tests skip without DATABASE_URL
pnpm dev                   # api on :3000, web on :3001, /api/* rewritten to the api
```

Once the demo path closes:

```sh
pnpm seed && pnpm demo     # end-to-end with mock payouts, non-zero exit on failure
```

Payouts default to `PAYOUT_PROVIDER=mock` and the network to `near:testnet`. A
run never sends a mainnet transaction unless a human asks for it (see
[`AGENTS.md`](AGENTS.md)).

## Layout

```
apps/api        Hono gateway, facilitator wrapper, payouts, db, services, jobs
apps/web        Next.js dashboard
packages/core   pure TS: money, state machines, shared schemas, reconcile rules
scripts         demo, seed, simulate, boundary and roadmap checks
docs            PRD, ARCHITECTURE, ARCHITECTURE_ESSENTIALS, PROJECT_STRUCTURE, spikes/
ROADMAP.md      live task list — updated in every contribution, CI enforces it
```

## Hacking

Start with [`AGENTS.md`](AGENTS.md) and the progress block in
[`ROADMAP.md`](ROADMAP.md). Do P0 before P1, write the failing test first for
guards and rules, never match payments to payouts by amount or time, and update
`ROADMAP.md` in the same change as everything else — CI fails otherwise.

Built for the NEAR Hackathon, development window 1–14 November 2026, Real-World
Money track. Part of the Accensa org, alongside
[accensa-app](https://github.com/accensa/accensa-app),
[accensa-contracts](https://github.com/accensa/accensa-contracts) and
[x402-facilitator-stellar](https://github.com/accensa/x402-facilitator-stellar).
