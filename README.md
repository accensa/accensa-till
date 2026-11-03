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
| Data model | Real. `apps/api/src/db/schema.ts` and the drizzle-kit generated `apps/api/migrations/` cover all eight tables, and `0001_ledger_append_only.sql` carries the append-only trigger. Six tests run against a live Postgres 16 and prove `UPDATE` and `DELETE` on `ledger_entries` raise and that the discrepancy dedupe index collapses a repeated open cause to one row — including a check that the tests fail when either guard is removed. Ids are UUID v7 from `newId()` in `@till/core`, hung on every table through the column default, so an id sorts with its row's insertion: four more Postgres tests read a written row back and compare id order against `ctid` order, the database's own record of insertion, and one of them states what that suite cannot show (a real insert costs more than a millisecond, so the sub-millisecond counter is proven only in `packages/core`). |
| Reconciliation rules | Four of the five P0 rules are implemented **and tested against fixtures that execute**: `SERVED_NOT_SETTLED` (2), `PAYOUT_REFUNDED` (7), `PAYOUT_FAILED` (6), `PAYOUT_STUCK` (9). `PAYMENT_NOT_SWEPT` is written but its fixture tests are owed on E7, which waits on E2. The three P1 rules return nothing on purpose, because they depend on spike S2 (deposit listing shape) and guessing there would hide real money. |
| Money and state helpers | Real. `packages/core/src/__tests__/money.test.ts` runs 13 passing tests over parsing, formatting, integer-only shortfall, a value past `Number.MAX_SAFE_INTEGER`, and a tolerance wide enough that the shortfall rule could never fire. `packages/core/src/__tests__/schemas.test.ts` runs 23, 18 of them over the money boundary: a negative or zero endpoint price, payment amount or advertised requirement is refused, while a negative ledger `adjustment` and an absurd provider amount still validate, because there the sign is information. The other 5 bound every array at that boundary (C15): past its cap a `creationWarnings` or `byAsset` list is refused with one issue that names the cap, and the same field carrying 200 000 wrong-typed elements yields 18 issues and 964 bytes rather than the 200 001 issues and 11.5 MB `error.format()` an uncapped array produced — the shape of the zod advisory C14 declined to upgrade for, which `.max()` alone does not close, because zod 3 parses the elements before it reads the array's own constraint. `packages/core/src/__tests__/states.test.ts` runs 70: every one of the 16 ordered payment state pairs and every one of the 36 swap pairs, plus the sticky-terminal and unknown-status rules from D1. `packages/core/src/__tests__/ids.test.ts` runs 10 over the id generator: the v7 layout and its version and variant bits, the millisecond read back out of the hex, 4 000 ids from two generators with no collision, a frozen millisecond whose 200 ids come out with counters exactly `0..199`, a clock that steps backwards and fails to lower an already-issued id, and 5 000 ids through the counter overflow, where the 4 097th lands on the next millisecond instead of wrapping. |
| Gateway, payouts, dashboard, jobs | Partly real. The upstream proxy and its SSRF/address policy are implemented and tested against a live loopback HTTP server (26 tests: size caps against a chunked body, three timeout shapes, both address families, every resolver record that is not an IP literal — a record the internal-range check cannot parse is refused rather than dialled — and a seller origin that tries to `Set-Cookie` into the gateway, prompt the buyer's browser for credentials, or forge the `payment-signature`/`x-402-*` headers a buyer reads as proof of settlement; all ten are dropped, the ordinary five arrive). The payments service and its state machine are implemented and tested against Postgres (11 tests, including a concurrent settle that must fulfil once). The mock payout provider and the offline flow are implemented and tested (23 + 15), and log redaction has its own suite (6). The x402 payment layer (C1) is written and **executed offline against the shipped scheme** — 27 tests in `apps/api/test/x402.test.ts` mint a genuine NEP-366 signed delegate through a loopback JSON-RPC stub and run it through `@x402/near`'s own verifier with the facilitator's seven chain reads answered by a fake, so the refusals are the scheme's codes rather than mocks of them (forged signature, wrong amount, wrong recipient, expired, over-wide window, three access-key cases, gas cap, deleted payer, unregistered payee, spent nonce, insufficient balance). What that does *not* prove: a relayer submitting, a `ft_transfer` landing, or the deposit balances existing — all on-chain and owed to A10. What is still an empty file that throws `not implemented` with its task id: the gateway route (C4), the 1Click client (D3), every job (C10, D6, E2) and every dashboard route. |
| x402 on NEAR, Intents payouts | The x402 half is written and measured offline (see the gateway row); the payout half runs on the mock provider, by decision (A17 chose option (c)), and the demo labels it. Spikes: S1 closed on its fallback branch (`payTo` is the seller's own testnet account, because `@x402/near` refuses an unregistered payee before anything moves), S5 closed on paper, S3 and S4 answered by the organizers, S6 half measured offline and its answer is the opposite of what the roadmap assumed — concurrent delegates from one payer **both verify**, so one-in-flight is the gateway's job (`docs/spikes/S6.md`); S2 and S7 are blocked on the money question A17 declined. Nothing here has been run against a chain. |
| CI guard scripts | **Run, and they work.** `sh scripts/check-boundaries.sh` passes on this scaffold and exits 1 on each injected violation (`@fastnear` outside `x402/near.ts`, a float money literal, a `drizzle-orm` import in `packages/core`, a bare `z.array(` in a schema file). `pnpm roadmap:check` exits 1 both when `ROADMAP.md` is stale and when a change touches code but not the roadmap — the second case verified against a temporary commit, not by reasoning, because a dirty worktree reproduces it falsely. |

The scaffold executes: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm boundaries` and `pnpm roadmap` all pass on Node 22, the API boots and answers `/healthz` and `/api/healthz`, refuses to start on a missing env var, and the Next dev server reaches the API through the `/api/*` rewrite. CI runs the same commands on GitHub Actions and is green on `main`. What has *not* happened: a paid request — no HTTP 402 challenge has ever been served and paid — a real payout, or a ledger entry written by a request path. The proxy is tested against a loopback server that nothing routes through yet, and the only payout provider that exists is the mock. `pnpm test` counts 140 passing and 8 todo in `packages/core` (the todo are four rules whose tasks, E7 and E10 to E12, are still open), and 140 passing in `apps/api` across 11 files when `DATABASE_URL` points at a Postgres — 119 without it, since the three database files skip. The route suite is not among the skipped ones: `createApp({ env, log })` lives in `apps/api/src/app.ts` and `server.ts` only boots, so a handler is tested by calling `app.request(path)` with an injected env and a recording logger — no port, no database (A21). `docker compose up` runs on Compose v2 and works (Postgres healthy, migrations applied, both servers answering) from a built image, and no longer writes root-owned files into the checkout, which was A16. The security pass G4 scanned every blob in git history and the whole working tree for credentials, hardened and mutation-tested the SSRF record check, and triaged `pnpm audit`; C14 then cut the production advisories from seven to three, each judged on reachability rather than severity (the rest are recorded in `ROADMAP.md` section 8 and owned by C16). The red-team pass G6 ran early over the code that exists rather than waiting for the rest, and four guards came out of it: money that must be positive is validated as positive at the JSON boundary and in the environment (a negative endpoint price used to parse, and `MIN_PRICE_BASE_UNITS=-1` used to boot), the proxy now filters the seller's *response* headers and not only the buyer's request, log redaction covers credential-shaped names and shapes inside a value, and a shortfall tolerance too wide to ever fire is refused in both the function and the config. Every one of them was broken on purpose afterwards to confirm its tests fail — the counts and the mutations are in `ROADMAP.md` under G6.

## Known limitations

- **The headline feature is unproven on a chain.** The payment layer is executed
  offline against the shipped scheme (C1) and has never served or taken a real
  402. Whether an Intents deposit address can act as an x402 `payTo` was closed
  by S1 choosing its documented fallback — `payTo` is the seller's own account —
  because the measurement needs mainnet and A17 kept the payout leg on the mock.
  `direct` mode plus reconciliation is therefore the product being built, and
  Intents payouts are labelled as unmeasured.
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
  ranges are resolved and `--frozen-lockfile` works. The runtime set is
  `hono` and `@hono/node-server` 2 (one process, one HTTP server), `postgres`
  and `drizzle-orm` (the only place SQL is written), `zod` (every boundary
  check), `jose` (session signing), `next` and `react` (the dashboard), and
  `vitest` plus `@biomejs/biome` for tests and lint. Added on 2026-11-03 under
  C14: **`@fastnear/x402` 2.5.0** and **`@fastnear/wallet` 2.5.0**, which bring
  `@x402/core`, `@x402/near`, `@x402/fetch` and `@near-js/*` with them. We do
  not implement the x402 wire format, NEAR transaction encoding or ed25519
  payment verification ourselves — that is money-critical cryptography and the
  library is the thing that has to be right about it. Nothing else is in the
  tree: the resource server is framework-agnostic so no express or adapter
  enters, the facilitator is self-hosted so no third-party service and no API
  key sits in the gateway path, and no `@near-intents` client is installed
  because the payout leg runs on the mock provider (see the disclosure below).
  The one native transitive dependency is `secp256k1`, which compiles during
  install; `pnpm audit` is 3 production advisories, all recorded in
  `ROADMAP.md` section 8 with why each is or is not reachable here.
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
