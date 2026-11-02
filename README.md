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
| Data model | Drafted. `apps/api/src/db/schema.ts` and `apps/api/migrations/0001_initial.sql` cover all eight tables, the append-only ledger trigger and the discrepancy dedupe index — **never run against Postgres**. |
| Reconciliation rules | Drafted. The five P0 rules are implemented as pure functions in `packages/core/src/reconcile/`; the three P1 rules return nothing because they depend on spike S2. **Not executed.** |
| Money and state helpers | Drafted. `money.ts` and `states.ts` are complete; **untested** — one rule test exists, seven are `it.todo`. |
| Gateway, payouts, dashboard, jobs | Empty files with contracts and comments. Every one of them throws `not implemented` with its task ID. |
| x402 on NEAR, Intents payouts | **Not written, not proven.** Spikes S1 to S7 are all open. |
| CI guard scripts | **Run, and they work.** `sh scripts/check-boundaries.sh` passes on this scaffold and exits 1 on each injected violation (`@fastnear` outside `x402/near.ts`, a float money literal, a `drizzle-orm` import in `packages/core`). `sh scripts/check-roadmap.sh` exits 0 when `ROADMAP.md` is part of the change and 1 when it is not. |

Nothing TypeScript in this repo has been executed. There is no working server, no
paid request, no payout and no ledger entry yet. `pnpm install` has never run
here, the tests have never run, `docker compose up` has never started, and the
GitHub Actions workflow has never had a run — this machine has Node v18 and no
pnpm, and the workspace targets Node 22.

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
- The migration in `apps/api/migrations/` is hand-written. Once drizzle-kit is
  installed, `pnpm db:generate` owns that directory and this file must be
  replaced by a generated snapshot.
- No dependency has been installed and no lockfile exists, so nothing in the
  version ranges above has been resolved or verified.
- `docker compose` v2 is not installed on the machine that wrote this, so
  `docker-compose.yml` has only been checked as YAML, not as a Compose file. The
  local `docker-compose` is legacy v1 and rejects Compose Spec keys like `name:`.

## Quickstart

Does not work yet, and that is the honest state rather than an oversight. Once
A2 and A3 close:

```sh
docker compose up          # Postgres + api + web
pnpm install
pnpm db:migrate && pnpm seed
pnpm demo                  # end-to-end with mock payouts, non-zero exit on failure
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
