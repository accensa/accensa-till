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
| Reconciliation rules | Four of the five P0 rules are implemented **and tested against fixtures that execute**: `SERVED_NOT_SETTLED` (2), `PAYOUT_REFUNDED` (7), `PAYOUT_FAILED` (6), `PAYOUT_STUCK` (9). `PAYMENT_NOT_SWEPT` is written but its fixture tests are owed on E7, which waits on E2. The three P1 rules return nothing on purpose, because they depend on spike S2 (deposit listing shape) and guessing there would hide real money. |
| Money and state helpers | Real. `packages/core/src/__tests__/money.test.ts` runs 12 passing tests over parsing, formatting, integer-only shortfall and a value past `Number.MAX_SAFE_INTEGER`. `packages/core/src/__tests__/states.test.ts` runs 70: every one of the 16 ordered payment state pairs and every one of the 36 swap pairs, plus the sticky-terminal and unknown-status rules from D1. |
| Gateway, payouts, dashboard, jobs | Partly real. The upstream proxy and its SSRF/address policy are implemented and tested against a live loopback HTTP server (24 tests: size caps against a chunked body, three timeout shapes, both address families, and every resolver record that is not an IP literal — a record the internal-range check cannot parse is refused rather than dialled). The payments service and its state machine are implemented and tested against Postgres (11 tests, including a concurrent settle that must fulfil once). The mock payout provider and the offline flow are implemented and tested (23 + 15). What is still an empty file that throws `not implemented` with its task id: the gateway route (C4), x402 (C1), the 1Click client (D3), every job (C10, D6, E2) and every dashboard route. |
| x402 on NEAR, Intents payouts | **Not written, not proven.** Spikes S1 to S7 are all open. |
| CI guard scripts | **Run, and they work.** `sh scripts/check-boundaries.sh` passes on this scaffold and exits 1 on each injected violation (`@fastnear` outside `x402/near.ts`, a float money literal, a `drizzle-orm` import in `packages/core`). `pnpm roadmap:check` exits 1 both when `ROADMAP.md` is stale and when a change touches code but not the roadmap — the second case verified against a temporary commit, not by reasoning, because a dirty worktree reproduces it falsely. |

The scaffold executes: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm boundaries` and `pnpm roadmap` all pass on Node 22, the API boots and answers `/healthz` and `/api/healthz`, refuses to start on a missing env var, and the Next dev server reaches the API through the `/api/*` rewrite. CI runs the same commands on GitHub Actions and is green on `main`. What has *not* happened: a paid request — no HTTP 402 challenge has ever been served and paid — a real payout, or a ledger entry written by a request path. The proxy is tested against a loopback server that nothing routes through yet, and the only payout provider that exists is the mock. `pnpm test` counts 106 passing and 8 todo in `packages/core`, and 71 passing with 17 more that need Postgres and skip without `DATABASE_URL`. `docker compose up` runs on Compose v2 and works (Postgres healthy, migrations applied, both servers answering) from a built image, and no longer writes root-owned files into the checkout, which was A16. The security pass G4 scanned every blob in git history and the whole working tree for credentials, hardened and mutation-tested the SSRF record check, and triaged `pnpm audit`: all seven production advisories need a breaking dependency bump, which is open work as C14.

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
- `docker compose up` works, and it should not yet be run inside a working
  checkout: the api and web services bind-mount the repository and install into
  it, which leaves root-owned `node_modules` per package and a root-owned
  `.pnpm-store` of about 650 MB that the owner cannot delete without `sudo`.
  Found by running it on Compose v2, open as A16. Legacy `docker-compose` v1
  still cannot read this file at all, since it rejects Compose Spec keys like
  `name:`.
- **The payout leg has no testnet.** `HACKATHON.md` Q-007 (2026-11-03) states
  that no NEAR Intents testnet exists or is planned, so real payout behaviour is
  mainnet only. Development uses `dry: true` quotes and the mock provider, and a
  mainnet transaction needs the human's explicit approval with a stated ceiling
  (A17). A partner API key is not required and costs 0.2% without one (Q-006), so
  nothing on the payout side waits on partner onboarding.
- GitHub Actions is green on `main`, and the guards were seen failing there too:
  a float money literal stops the `boundaries` step, a code-only commit and a
  stale progress block each stop the `roadmap` step. Those three were run on
  throwaway branches pushed only to be dispatched and deleted, so the checks are
  proven on the runner and no broken commit survives on any ref.

## Quickstart

The database and the two dev servers work; the end-to-end demo does not, and
that is the honest state rather than an oversight. `pnpm seed` and `pnpm demo`
throw `not implemented` until the gateway exists (C11, G1), which is also why the
`demo` CI job is manual-dispatch only for now. The payout half of the flow is
already scriptable end to end — that is `pnpm simulate`, below.

```sh
pnpm install
pnpm db:migrate            # needs Postgres: docker compose up postgres
pnpm test                  # core money tests; the Postgres tests skip without DATABASE_URL
pnpm dev                   # api on :3000, web on :3001, /api/* rewritten to the api
```

```sh
pnpm simulate [succeed|refund|fail|stall]   # one scripted payout outcome
```

It runs the mock provider, turns what the provider reports into the rows the
reconciliation rules read, and prints the swap states, the amounts in base units
and the discrepancy each case produces — `PAYOUT_REFUNDED`, `PAYOUT_FAILED`,
`PAYOUT_STUCK`, or nothing for a clean payout. It exits non-zero when an outcome
does not behave as scripted. No network, no keys, no database, and every line it
prints is simulated, marked as such on screen (DQ-2).

`docker compose up` is verified on Compose v2 (v5.7.0): Postgres comes up healthy,
migrations apply, the api listens on 3000 and the web dev server reaches it on
3001. It has a real defect until A16 lands, and it is worth knowing before you
run it: the api and web services bind-mount the repository and install inside it,
so a run in your own checkout leaves root-owned `node_modules` for every package
and a root-owned `.pnpm-store` of about 650 MB that you cannot delete without
`sudo`. Run it from a copy of the tree, or wait for A16.

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
HACKATHON.md    the organizers' rule set, committed as a pinned copy
```

## Hackathon rules

[`HACKATHON.md`](HACKATHON.md) is the organizers' instruction file, committed so
the repo carries the rules it is built against; the live copy is
[https://nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md)
and it is byte-identical to the pinned one as of 2026-11-03. What binds this
project: development ends 2026-11-14 23:59 UTC and the repository must be public
by then and through judging; tracks are `realworld` primary and `agents`
secondary, with `security` and `business` open as a human decision; submission is
one POST with fields only the human can supply (name, lead, email, team size,
payout account, links, description) and one attempt per repository; a partner
1Click key is optional at a 0.2% fee (Q-006); there is no Intents testnet, so the
payout leg is mainnet and needs explicit approval (Q-007, A17). Because Claude
Code and Codex screen every entry for reproducibility before a human jury scores
it (Q-017), this README is written for a machine reader too: the commands under
Quickstart are the judge's script, and each one is either verified or labelled as
not yet working.

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
