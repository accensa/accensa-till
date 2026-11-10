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

## Quickstart

No keys, no wallet, no funded account, one command. Every line under "see" is
what this tree printed when it was run on 2026-11-09, not what it is expected to
print; the numbered steps are the judge's script (DQ-1, and `HACKATHON.md` Q-012
and Q-017 — this file is written to be followed by a machine as much as by a
person).

Those steps were also run from a fresh `git clone` of `main` rather than from a
developer's checkout (G3): cold image build with zero cached steps, no key, no
secret and no exported variable, `pnpm seed` idempotent on its second call, the
`402` below, `pnpm demo` exiting `0` twice on one volume, and `git status` clean
with no root-owned file in the clone afterwards. What that run cannot claim is a
different machine: it was the same host, daemon and OS as everything else here.

### With Docker

1. `docker compose up`

   See three services come up: `postgres` healthy, then in the api log
   `[✓] migrations applied successfully!` followed by

   ```
   {"level":"warn","message":"no relayer key: the gateway can advertise but not settle (A10)","relayerAccountId":"relayer.testnet"}
   {"level":"info","message":"api listening","port":3000,"provider":"mock"}
   ```

   and in the web log `✓ Ready in 4.9s`. The warning is the honest state, not a
   failure: the relayer key is A10's, and without it the gateway advertises and
   refuses rather than pretending to settle.

2. `docker compose exec api pnpm seed` — one seller, one paywalled endpoint, one
   payout route, all written through the shipped services rather than by hand.

   See:

   ```
   seeded   seller=01a1c04a-a4f8-7000-a7a4-a42f2da53687 endpoint=01a1c04a-a547-7000-b801-ca45ed186f4b
   paywall  http://localhost:3000/r/demo
   price    1000000 base units of usdc.testnet
   deposit  mock-deposit-1 (made up by the mock provider; no swap will run)
   payout   eth/usdc -> 0x742d35cc662dd0c4f8e3f1b0a4b1e6a4d9d01f2c
   ```

   Run it again and the first line reads `already  seeded endpoint=…, nothing
   written`: the script is idempotent, which is why CI can call it before every
   demo pass.

3. `curl -i http://localhost:3000/r/demo` — the paywall, unpaid.

   See `HTTP/1.1 402 Payment Required`, a base64 `PAYMENT-REQUIRED` header, and a
   body that decodes to the same object:

   ```json
   {"x402Version":2,"error":"Payment required","resource":{"url":"http://localhost:3000/r/demo","description":"Demo prices endpoint (seeded by scripts/seed.ts)","mimeType":"application/json"},"accepts":[{"scheme":"exact","network":"near:testnet","amount":"1000000","asset":"usdc.testnet","payTo":"mock-deposit-1","maxTimeoutSeconds":60,"extra":{}}]}
   ```

   Those are the six fields a payer signs against. Read `payTo` with the
   disclosure in "What is real, and what is not" in mind: on this boot it is the
   mock provider's invented deposit address, so the number is right and the
   address is not payable — `mock-deposit-1` is exactly what the seed line named.

4. `docker compose exec api pnpm demo` — PRD section 8, end to end, asserted.

   See the run's own header, then six numbered steps of `ok` lines and `·` lines
   that print what happened, then the verdict:

   ```
   SIMULATED run — the chain, the payout provider and the loopback upstream are scripted (DQ-2).
   The gateway, the payment verification, the guards, the ledger, the poll loop and the
   reconciliation rules are the shipped code, running for real against Postgres.
   …
   PRD section 8 ran and every assertion held.
   ```

   Exit code `0`. Invert any of its 44 assertions and the same command prints a
   `FAILED` line with the last few gateway responses under it and exits `1` —
   that was checked, not assumed. The CI `demo` job runs steps 2, 3 and 4 on
   every push and pull request, and runs the demo twice so a rerun against a
   database that already holds a finished walk is tested on the runner rather
   than on a laptop.

5. `docker compose down -v` — stops the stack and removes the database volume.

   Nothing was written into your checkout to get there: `find . -user root | wc -l`
   was `0` after the run above, which is A16's Done-when and the reason the api and
   web services carry their dependencies in an image instead of bind-mounting the
   repository.

### Without Docker

The same scripts against your own Postgres 16. Nothing in this repository loads a
`.env` file — `apps/api/src/env.ts` reads `process.env` — so export the three
variables the api, the seed and the demo all need (the full set, with safe
defaults, is [`.env.example`](.env.example)):

```sh
export DATABASE_URL=postgres://till:till@localhost:5432/till
export SESSION_SECRET=at-least-32-characters-of-your-own-making   # openssl rand -hex 32
export GATEWAY_PUBLIC_URL=http://localhost:3000                   # the origin you will curl
pnpm install
pnpm db:migrate
pnpm seed && pnpm demo
pnpm dev                       # api on :3000, web on :3001, /api/* rewritten to the api
```

The other way to get there is to source the menu itself, which is plain
`KEY=value` text: `set -a; . ./.env.example; set +a` and then
`export SESSION_SECRET=$(openssl rand -hex 32)`. That pair was run today and
`loadEnv()` accepted it (`provider: mock`, `network: near:testnet`). Sourcing it
without the secret does not boot, and the single line it prints is the design
rather than a trap: `invalid environment, missing or malformed: SESSION_SECRET`.
A session that signs seller logins has to be yours, so the file leaves that one
blank on purpose — and comments out the optional names instead of leaving them
empty, because an unset variable takes its default while an empty one fails its
own schema (`env.ts` explains this per variable).

`GATEWAY_PUBLIC_URL` is what the advertisement puts in the `resource.url` a payer
signs against, so it has to be the origin you are about to call.

`pnpm demo` on this path runs against whatever the suites left behind, which is worth
knowing because it reaches the poller. The loop claims the 25 oldest rows still
waiting for an answer (`DEFAULT_POLL_BATCH_SIZE`,
`apps/api/src/jobs/poll-payouts.ts`), and a row is waiting when `terminal_at` is null.
The suites leave rows like that on purpose — they delete nothing, because the ledger's
trigger forbids it — so this machine's `DATABASE_URL` was carrying 26 rows with a
terminal state and no stamp (`e1-ref-…`, `e2-ref-…`, `a19-swap-…`), and 26 older rows
in a batch of 25 is enough to keep this run's own swap out of the first pass. D10
closed that from both ends: an unanswered ref is now rescheduled on the same
attempt-based gap a provider call that throws gets, so it stops coming back due every
pass and holding the queue, and a claimed row already in a terminal state gets its
`terminal_at` converged by the pass that claims it rather than staying claimable
forever. The demo then drives the loop until the swap it is waiting on has been
answered — `drive()` in `scripts/demo.ts`, capped at 20 passes, printing how many it
took — instead of assuming one pass will reach it. Measured here on 2026-11-10: with
27 due rows in the table, the pre-D10 demo failed five assertions, every one of them
`state pending` for a swap nobody polled; after D10 the same table ran clean
(`PRD section 8 ran and every assertion held.`, exit `0`), step 3 reaching its swap on
the second pass and step 4 on the first. The queue behaviour itself is what
`apps/api/test/poll-payouts.test.ts` pins: 26 refs the provider never answers plus one
it does, the clock advanced by exactly one loop interval between passes, and the
answered swap reached on pass 2 — three of those tests fail when run against the
pre-D10 poller. The Docker path never hit this, because `docker compose down -v`
removes the volume with it, and CI never reuses a database.

### The payout half on its own, with no database at all

```sh
pnpm simulate [succeed|refund|fail|stall]
```

Runs the mock provider, turns what it reports into the rows the reconciliation
rules read, and prints the states, the amounts in base units and the discrepancy
each case produces. See, for `refund`:

```
refund: the swap failed and the deposit came back to the payer
  route    mock-deposit-1 quote=mock-quote-1
  states   refunded (terminal=true)
  amounts  in=1000000 out=none refunded=1000000
  origin   mock-tx-refund  raw.simulated=true
  finding  PAYOUT_REFUNDED (high) The payout swap to the destination chain was refunded, so the money did not arrive where the seller asked for it.
  result   as scripted

all scripted outcomes reached their stated end
```

No network, no keys, no database, and every line labelled simulated (DQ-2).
`pnpm simulate empty-payer` exits `1` and says why: an account too empty to pay
is refused inside the payment verification (C8, GW-7), which needs a gateway and
a chain read rather than a scripted provider status — that is step 5 of
`pnpm demo`.

### The two programs the demo drives, run by hand

```sh
pnpm exec tsx scripts/demo-upstream.ts                            # 127.0.0.1:4100 — /data, /fail, /slow, /moved
pnpm exec tsx scripts/demo-agent.ts http://localhost:3000/r/demo  # reads the 402, prints the requirements
```

The agent is the buyer: a plain fetch, assert `402`, decode the challenge
(header first, body only as the human fallback), print the requirements, then pay
through `createPayerFetch`. Without `DEMO_PAYER_ACCOUNT_ID` and
`DEMO_PAYER_SECRET_KEY` it prints the challenge and exits `2` — the honest state
until A10's funded testnet payer exists; with both it signs through the shipped
`@fastnear/x402` client and asserts the `PAYMENT-RESPONSE` receipt. `pnpm demo`
starts both itself, so you only need these if you want to watch one leg.

### What the quickstart will not show you

- **Money that moved.** No wallet has paid a request in this build, no
  `ft_transfer` has landed and no relayer has submitted a transaction. Send the
  gateway a payment header it can decode and you get the exact shape of that gap:
  `503 {"error":"unconfigured","detail":"no relayer configured, so nothing can be
  verified or settled"}`, which is fail-closed rather than invented. (A header it
  cannot decode is a `402` re-challenge naming `payment_header_undecodable`; both
  were observed on the boot above.)
- **A signed-in dashboard.** `http://localhost:3001/endpoints`, `/payments` and
  `/reconciliation` all answer `Till will not list or save an endpoint without a
  session. Sign in with your NEAR wallet.` and `/sign-in` says what it is waiting
  on: `The server half is built and tested (F1: routes/auth.ts, lib/session.ts,
  and the NEP-413 verifier in packages/core). This page still needs a wallet to
  prompt (F8), so it does not pretend to sign anyone in.` The three pages are
  real and were driven against a booted API with a minted session cookie
  (`ROADMAP.md` F2, F3, F4, F9); what is missing is the browser wallet, F8 and
  A10's account.
- **The overview page.** `http://localhost:3001/` prints `Overview Not
  implemented (UI-6, P1).` because F6 is P1 and P1 does not ship before P0.

## What is real, and what is not

This is a running system with one unproven headline. The paywall, the payment
verification, the guards, the ledger, both loops, the reconciliation rules and
three dashboard pages are code with tests, and the Quickstart above walks the
money path on them. What is not proven is the one thing the design keeps saying:
that a chain accepted a payment. Be exact about which half is which:

| | State |
|---|---|
| Product and architecture design | Real. Seven documents, red-teamed, in `docs/`. |
| Folder structure and module boundaries | Real. Every path in [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md) exists. |
| Data model | Real. `apps/api/src/db/schema.ts` and the drizzle-kit generated `apps/api/migrations/` cover all eight tables, and `0001_ledger_append_only.sql` carries the append-only trigger. Six tests run against a live Postgres 16 and prove `UPDATE` and `DELETE` on `ledger_entries` raise and that the discrepancy dedupe index collapses a repeated open cause to one row — including a check that the tests fail when either guard is removed. `0007_payout_routes_immutable.sql` adds the second such trigger, on `payout_routes`: 15 tests in `apps/api/test/payout-routes.test.ts` prove it raises on a rewrite through drizzle *and* through raw SQL, that `payout_routes_destination_key` lands two racing creations for one destination on one row, and that deleting a route a settled payment points at is refused by `payments_route_id_fkey` rather than by a rule in prose. Ids are UUID v7 from `newId()` in `@till/core`, hung on every table through the column default, so an id sorts with its row's insertion: four more Postgres tests read a written row back and compare id order against `ctid` order, the database's own record of insertion, and one of them states what that suite cannot show (a real insert costs more than a millisecond, so the sub-millisecond counter is proven only in `packages/core`). |
| Reconciliation rules | All five P0 rules are implemented **and tested against fixtures that execute**: `SERVED_NOT_SETTLED` (2), `PAYOUT_REFUNDED` (7), `PAYOUT_FAILED` (6), `PAYOUT_STUCK` (9), `PAYMENT_NOT_SWEPT` (8, whose `direct` silence is D8's mode check). What those fixtures hand the rules is a snapshot. The join that snapshot stands for is now E2's and it is one function: `services/swaps.ts`'s `linkSwapByHash` puts a payment and a swap together on `swaps.origin_tx_hash = payments.near_tx_hash` and on nothing else (14 tests on real Postgres — the same hash links two rows whose amounts and timestamps disagree, and a pair whose amount, asset and both timestamps agree while their hashes differ is *refused*, which is the join a heuristic would make and the error this product exists to find), and it says why it declined: no hash, no candidate, or one hash on two payments, in which case it names both and writes neither. What is still open is who reads it. D6's poller is now the caller and links every swap it polls from inside the transaction that writes the provider's answer, so a running process does make the link; what it joins is still a `swaps` row, and none exists in a deployed process until the S2/B8 decision ships the swap creator. The loop that runs the *rules* over that snapshot is E9's now, and it is wired: `jobs/reconcile.ts` reads the payments and swaps into a snapshot on one database clock, calls `runAllRules`, and writes the findings inside the transaction that holds the seller's `SKIP LOCKED` claim, on `RECONCILE_INTERVAL_SECONDS` and again for every seller the poller moved (the two scheduling calls live in `jobs/ticks.ts`, because `server.ts` binds a port and so cannot be imported by a test — which is what makes "runs after a status change" an asserted fact rather than a read comment). What it reads is still bounded by the same gap: a deployed process has no `swaps` rows until S2/B8 ships the creator, so `PAYOUT_STUCK`, `PAYOUT_SHORTFALL` and the swap-side rules have no rows to judge in production even though the loop asks them correctly. The three P1 rules return nothing on purpose, because they depend on spike S2 (deposit listing shape) and guessing there would hide real money. |
| Money and state helpers | Real. `packages/core/src/__tests__/money.test.ts` runs 13 passing tests over parsing, formatting, integer-only shortfall, a value past `Number.MAX_SAFE_INTEGER`, and a tolerance wide enough that the shortfall rule could never fire. `packages/core/src/__tests__/schemas.test.ts` runs 35, 18 of them over the money boundary: a negative or zero endpoint price, payment amount or advertised requirement is refused, while a negative ledger `adjustment` and an absurd provider amount still validate, because there the sign is information. The other 5 bound every array at that boundary (C15): past its cap a `creationWarnings` or `byAsset` list is refused with one issue that names the cap, and the same field carrying 200 000 wrong-typed elements yields 18 issues and 964 bytes rather than the 200 001 issues and 11.5 MB `error.format()` an uncapped array produced — the shape of the zod advisory C14 declined to upgrade for, which `.max()` alone does not close, because zod 3 parses the elements before it reads the array's own constraint. The remaining 7 are D9's update body: an empty patch is refused, `network`, `assetContract`, `id`, `slug`, `sellerId` and `routeId` are refused by name — so the schema, and not a handler's memory, decides which columns an edit may touch — the money boundary holds on the way in exactly as it does at creation, and the response is the shape create already returns. The last 5 are F9's: the endpoint the dashboard reads carries its own payout route, an endpoint DTO with no `route` key at all is refused — required, not optional, so a forgotten join fails the contract instead of rendering an empty destination for a seller to confirm — `route: null` is allowed, because that is a state a create whose destination failed leaves the row in, a refused destination is named by field rather than as a whole route, and a `direct` route keeps its null deposit address because that is what `direct` means. `packages/core/src/__tests__/states.test.ts` runs 73: every one of the 16 ordered payment state pairs and every one of the 36 swap pairs, the five named payment edges C7 leaves in the machine (which is what makes an `abandoned` row reopenable exactly once, toward `verified` and toward nothing else), plus the sticky-terminal and unknown-status rules from D1. `packages/core/src/__tests__/ids.test.ts` runs 10 over the id generator: the v7 layout and its version and variant bits, the millisecond read back out of the hex, 4 000 ids from two generators with no collision, a frozen millisecond whose 200 ids come out with counters exactly `0..199`, a clock that steps backwards and fails to lower an already-issued id, and 5 000 ids through the counter overflow, where the 4 097th lands on the next millisecond instead of wrapping. |
| Gateway, payouts, dashboard, jobs | Partly real. The upstream proxy and its SSRF/address policy are implemented and tested against a live loopback HTTP server (30 tests: size caps against a chunked body, three timeout shapes, both address families, every resolver record that is not an IP literal — a record the internal-range check cannot parse is refused rather than dialled — a seller origin that tries to `Set-Cookie` into the gateway, prompt the buyer's browser for credentials, or forge the `payment-signature`/`x-402-*` headers a buyer reads as proof of settlement; all ten are dropped, the ordinary five arrive; and since C17 a seller URL whose name resolves to the gateway's own public address is refused, with IPv6 spellings and v4-mapped forms compared by value). The payments service and its state machine are implemented and tested against Postgres (21 tests, including a concurrent settle that must fulfil once, C7's compare-and-set reopen of an abandoned row — which is tested with a *second connection* holding the row `for update` while the service is between its read and its write, because a one-connection test pool makes `Promise.all` a queue and proves the conflict path rather than the interleaving — and C10's `recordSettlementHash`, which stamps the hash while the row is still `verified` and refuses a settled or already-stamped row). The mock payout provider and the offline flow are implemented and tested (23 + 15), and log redaction has its own suite (6). The x402 payment layer (C1) is written and **executed offline against the shipped scheme** — 32 tests in `apps/api/test/x402.test.ts` mint a genuine NEP-366 signed delegate through a loopback JSON-RPC stub and run it through `@x402/near`'s own verifier with the facilitator's seven chain reads answered by a fake, so the refusals are the scheme's codes rather than mocks of them (forged signature, wrong amount, wrong recipient, expired, over-wide window, three access-key cases, gas cap, deleted payer, unregistered payee, spent nonce, insufficient balance), plus five over `settlementStatus`, which reads a transaction through a loopback NEAR node (settled, a failed status, a failed inner receipt, an unreadable node, and no relayer account). What that does *not* prove: a relayer submitting, a `ft_transfer` landing, or the deposit balances existing — all on-chain and owed to A10. The challenge a payer answers is written and tested too (C2, 31 tests): `gateway/requirements.ts` builds the x402 v2 `402` from the endpoint's own rows and caches it per endpoint, keyed by a fingerprint of the fields the advertisement is made of, so a row that changed re-derives on the next request and no write path has to remember to invalidate; five shapes it could not itself verify are refused by name, because S1 showed a bad `payTo` is only discovered inside `verify`, on a stranger's request. One finding there is worth stating plainly: the requirements ride in the base64 `PAYMENT-REQUIRED` **response header**, and the shipped v2 client reads the body only when it claims `x402Version: 1` — so a body-only 402 is a 402 no wallet can pay. The cache is handed no payout provider and no verify/settle, and its call is synchronous, which is how "an unpaid request makes no provider call" is enforced by the shape rather than counted. It is now a `curl`-reachable endpoint, and has been: the gateway route (C4) mounts `GET /r/:slug`, and `curl -i http://127.0.0.1:8899/r/curl-demo` against a booted process returned `HTTP/1.1 402 Payment Required` with a base64 `PAYMENT-REQUIRED` header decoding to `payTo: "curl-demo.testnet"`, `amount: "10000"`, `maxTimeoutSeconds: 60` and a body identical to it — on a boot with no relayer key, which is what proves the free half needs nothing but the row. The route's own 40 tests (`apps/api/test/gateway.test.ts`) run on real Postgres and a real `node:http` seller; two of them (serve, wrong price) go through the **shipped** `createX402Near` over a genuine NEP-366 delegate, so those accept/refuse decisions are the scheme's rather than a stub's, and the rest script the outcomes a stub is the only way to hand back in sequence. What that suite proves: every status the payer can see (402 for no payment and for a refused one, 403 for a payer blocked at that seller after two unsettled serves (C9), 404 for an unknown or paused slug, 409 for a replayed authorization whose row already has an answer (a settled one, a served-unsettled one, or an abandoned one that carries settlement evidence — and since C7 a *plain* abandoned row is not in that list, because the retry takes it back over and serves it), 429 for a payer already being served, 502 for an upstream that failed or answered 5xx, 503 for a facilitator that could not run, and C6 closed the case C4 left open: a seller `3xx` is the seller's own answer, forwarded with its `Location` made absolute against the endpoint's upstream — Till never follows it, and nothing is settled for a response that delivered no resource), that a non-2xx abandons the payment and settles nothing, that the same authorization presented again after that abandonment reopens the *same row* — one payment, one `payment_in` ledger line, one `payment_retried` log line — and that a replay of a row carrying a settlement hash is refused with `409` and no receipt instead (C7, GW-4), that a settle failure after a 2xx still serves, that the receipt rides in `PAYMENT-RESPONSE` and only when the stored row is `settled`, and that a request going through the *default* upstream seam is refused by the shipped SSRF policy — so the test seam cannot be the production path. The pre-serve guards (C8) are a shipped policy rather than a placeholder: `gateway/guards.ts` refuses an advertised window shorter than the gateway's own timeout with `503`, and refuses a second in-flight payment from one payer with `429` and `Retry-After`. Because S6 measured that a *read* cannot be that gate — two delegates from one payer both verify and both submit — the guarantee sits at the insert, in the transaction that takes `pg_advisory_xact_lock(hashtext(payer))`, re-reads that payer's live row and inserts, so the loser of a real race gets `429` and books nothing (17 tests in `apps/api/test/guards.test.ts`, on a pool of 8 so the pool cannot be what serialises them). The balance check is deliberately not duplicated: `verify` already reads `ft_balance_of` on the account the signature binds, and Till's half is that this happens before the seller is dialed, tested with a genuine delegate underfunded by one yocto-unit. The strike block (C9) is the third shipped guard: `services/strikes.ts` counts `served_unsettled` rows in 24 hours per payer *and* seller, and `guards.ts` answers `403 payer_blocked` on the next paid request (8 tests in `apps/api/test/strikes.test.ts`, plus the route's end-to-end case), with the seller's clear appended to `payer_clears` as a watermark rather than a rewrite of payment history. The boot sweep (C10) is the first real job: `jobs/sweep-stale.ts` runs before the server starts listening, takes `verified` rows older than Guard 3's in-flight window and decides each one by evidence rather than by assumption — no settlement hash becomes `abandoned`, a hash is read from the chain and becomes `settled` plus the settlement's ledger lines — `payment_in`, and in `direct` mode the `payout_out` of the transfer that already paid the seller — or `abandoned` keeping the hash when the chain says the transfer failed, and a hash the node cannot answer for leaves the row `verified` and counts `unproven` instead of guessing (10 tests in `apps/api/test/sweep-stale.test.ts`, on real Postgres and a scripted probe, including a restart that finds one row of each kind, a direct recovery that books both lines, an intents recovery that books only the payment, and a race where another writer settles the row first). Its honest limit is in the code and in section 10 of the architecture: a crash between submitting a settle and stamping its hash leaves a row with no evidence, so the sweep abandons it; the delegate's nonce then refuses a re-serve, and the unbooked settle is reconciliation's to find. GW-10's two process-wide bounds (C13) are in memory and per route instance, which for a boot is the process: every `GET /r/:slug` counts against a fixed window (`RATE_LIMIT_REQUESTS` per `RATE_LIMIT_WINDOW_MS`) before the endpoint join, and a settlement reserves one `MAX_SPONSORED_GAS` from a global `SPONSORED_GAS_BUDGET` — read before the payment row is opened and reserved atomically just before `settle` — with either refusal answered `429` and logged (`rate_limited`, `sponsored_gas_exhausted`). The unit tests drive both counters on an injected clock (8 tests in `apps/api/test/limits.test.ts`, no sleeps), the route tests show the request limit answers before an unknown slug can become a `404` and that an exhausted budget neither dials the seller nor opens a row, and a settlement whose reservation is refused after the upstream answered leaves its row `abandoned` with the seller's status and no ledger line. Four mutations — the limiter check, the capacity check, the settle reservation, and the rate-limit log — each killed their case. GW-9's answer cache (C12) keeps a settled 2xx of up to 256 KB for five minutes, keyed by the authorization's `replay_key`, so a buyer whose connection dropped before the body arrived can retry the *same* authorization and get the same bytes back with no second seller request, no second settlement and no second ledger line — the receipt on the replay is rebuilt from the settled row. A miss, an expired entry or a body over the cap falls back to C7's `409` plus receipt rather than being silent, and the cache is bounded at 32 MiB and 1,024 entries so a long-lived process cannot grow it without limit; the unit tests drive expiry on an injected clock (5 tests in `apps/api/test/response-cache.test.ts`), and four mutations (the lookup key, the fill, the entry cap, the TTL) each killed their case. D8 closed the `direct` payout leg: `services/ledger.ts`'s `recordSettlement` writes `payment_in` and, for `direct`, the matching `payout_out` in one transaction, so a direct sale's ledger reconciles without a swap; `intents` books only the payment and waits for D6's swap, and the reconcile rule `PAYMENT_NOT_SWEPT` skips direct payments rather than flagging every sale whose pay-to was the seller. The gateway suite asserts both line sets (direct and intents), and the boot sweep books the same pair per mode. The polling job is no longer one of those empty files: `apps/api/src/jobs/poll-payouts.ts` claims due swaps with `FOR UPDATE OF swaps SKIP LOCKED`, asks the provider once per pass while still holding the rows, keeps a terminal state sticky, judges a non-terminal backwards move by D1's own transition table, refuses an amount that is not an integer of base units at the boundary, reschedules a row whose provider call threw on `POLL_INTERVAL_SECONDS * 2 ** poll_attempts` capped by `POLL_MAX_BACKOFF_SECONDS`, and books `payout_out`/`refund_in` plus the payment link in the same transaction that wrote the state — 28 tests in `apps/api/test/poll-payouts.test.ts` on real Postgres, and 4 in `apps/api/test/loop.test.ts` on fake timers for the helper that drops an overlapping tick, survives a throwing one and stops on a handle. The reconcile loop is now a job rather than a design sentence (E9): `apps/api/src/jobs/reconcile.ts` runs one transaction per seller — claim the seller `FOR UPDATE OF sellers SKIP LOCKED`, read its payments, swaps and the database clock into a `ReconcileSnapshot`, call core's `runAllRules`, and hand the findings to `writeFindings` *while still holding the claim* — and `jobs/ticks.ts` holds the two tick bodies that `server.ts` schedules: the interval pass over every seller on `RECONCILE_INTERVAL_SECONDS`, and the same call made from the poll tick with `sellerIds` set to exactly the sellers D6 reported it moved — a file that reads the environment and binds a port cannot be imported by a test, so the wiring is separate from the scheduling. 18 tests in `apps/api/test/reconcile.test.ts` on real Postgres hold the two Done-when claims: three passes over one snapshot leave one row with its `opened_at` unmoved, and a pass held by another writer is *skipped* rather than queued, which is witnessed by reading `pg_locks` for the `RowShareLock` on `sellers` before asserting the skip (a skip that happened for no reason would pass an outcome-only test). The rest is what the loop is *for*: the three windows arriving from the config, `payoutMode` read off the payment's own route so a D9 edit cannot silence a cause on money already taken, `SwapRow.paymentId` populated so `PAYOUT_SHORTFALL` names both sides, one seller's causes staying out of another's pass, and the rule that a pass which could not see every row — over the read cap, or carrying a row this build cannot interpret — opens findings and closes none, proved by the differential rather than asserted (the same seller, read completely, does close it). Twenty-one deliberate breakages were run against the file and seventeen killed a case: the claim dropped, `skipLocked` flipped to a wait, auto-close left on for a partial pass (in the job and in the writer), both read caps made invisible, the row over the cap kept, each half of the partial predicate, the capped read ordered oldest-first, the payout mode read from the live endpoint field, a routeless payment dropped by an inner join, the swap read scoped to the whole database, the poll tick naming nobody after a move, the poller not reporting the move, and the dedupe key trusted from the rule instead of recomputed. Four survived and are stated rather than smoothed over: dropping the `created_at` id tiebreaker and ageing the pass by the process clock are behaviourally invisible to any fixture on one machine with distinct insert times, the poll tick's empty-list guard is equivalent (an empty list reconciles nobody), and the writer's empty-keys branch is redundant because `notInArray` with an empty list closes the same rows. An earlier failure was found by running the suite before it was green, where a clock read as a bare `now()` arrived from the driver as a *string* (its parser only ever sees a column's own type) and eleven tests failed until it was asked for as milliseconds. And it runs: a boot against a freshly migrated scratch database holding one settled payment aged 700 s printed `{"code":"reconcile_pass","findings":1,"opened":1,"closed":0}` two seconds after listening, and after forty-five seconds of two-second intervals — some twenty passes — the log held exactly one `reconcile_pass` line and `discrepancies` exactly one `PAYMENT_NOT_SWEPT` row, so idempotence is what a running process does rather than only what a test asks for. What is still an empty file that throws `not implemented` with its task id: the 1Click client (D3) and every dashboard route except endpoint create, list and update, which D4 and D9 shipped behind the session seam — the 11.3 checks run at creation, a failed one leaves the endpoint inactive with the seller-facing reasons persisted on the row, and `GET`/`POST /api/endpoints` refuse a create whose `confirmedAddress` does not echo the shown destination (`422`, nothing written); 19 tests cover the checks and the loopback storage read without a database, and 17 against Postgres cover persistence, the direct route, listing scope and the route's 401/400/422/201 answers — plus the payout route D5 added: an `intents` creation is now *active* on the deposit address its provider prepared (it used to fail that check by design), a provider refusal and a broken destination each leave their own warning and no route, and the route a destination gets is reused rather than quoted twice (one ask for `[1 route, 2 endpoints]`). The same address is what the payer's 402 names: a test creates the endpoint through the service, reads it back through the gateway's own join and asserts the prepared address inside the base64 `PAYMENT-REQUIRED` header, with a `direct` endpoint beside it naming the seller's own account. Changing those terms is `PATCH /api/endpoints/:id` (D9, PO-7): section 11.3 runs again over the *merged* terms, and a change lands whole or not at all — a refused patch writes no endpoint row, no warning row and no route, so the `payments.amount`, `route_id` and `asset_contract` a settled payment snapshotted still name the address and price that payment was actually made against, and `payout_routes` has no `UPDATE` in the code and a trigger that refuses one in the database. An edit also never decides whether the paywall is open: `active` stays as the row has it unless the body names it, so repairing a failed check does not silently open a seller's pause. 29 tests in `apps/api/test/endpoint-updates.test.ts` run that on real Postgres — the last 6 are the dashboard's own reads: a create answers with the destination it resolved and the address it advertises, a create that never got a route answers with the null that says so, the list carries each endpoint's own route in the one read the page makes, a landed destination change answers with the route the next payment will use, a refused change answers with the destination the endpoint *still* pays out to, and a price-only change keeps the same route id so the echo still matches the row — and ten deliberate breakages there — a refused change that writes, an invented destination, a provider quote spent on a change that cannot land, liveness inherited from the patch, the echo check dropped, the update contract relaxed — each kill at least one of them. The card has the caller now (F9): `apps/web/lib/endpoint-edit.ts` turns the form into the `PATCH` body as a **diff** against the endpoint it was read with, so a save cannot restate a field nobody touched; the pause button posts `{ active }` and nothing else; a new payout address is refused by the client until the seller confirms the address the card printed off `endpoint.route`; and `EndpointEditor` holds the *address* it is waiting on rather than a request body, so a `confirmedAddress` cannot exist in a request assembled before that step — which is also why `route` is required on the DTO. 18 edit-logic tests, 40 render tests through `renderToStaticMarkup` (the form has no `active` input, and a mutation that adds one fails that test) and a live run against a booted API with `next start`, 14/14 through the web origin: a price change landing while the payment made before it kept its amount and its route, an unechoed move `422 destination_not_confirmed`, a **confirmed** move on a `direct` endpoint refused by `direct_destination` with still one route row, the same move with `payoutMode: intents` writing a second route and advertising its deposit while the first row and the payment stood unchanged, a pause touching nothing else, a below-floor change refused with the row identical *including* `active:false`, a foreign seller's `404` and a forged cookie's `401` writing nothing, and the re-read page showing the new address, `2.5` and `Not live` in the text a browser would paint. Ten mutations, ten caught. What no test does is click the button: `apps/web` has no DOM framework, so the state a click sets is passed to these components as a prop and the click path is a human's (or H1's video). The session those routes sit behind is now real rather than a seam (F1): `POST /api/auth/nonce` mints a 32-byte NEP-413 challenge and keeps a signed copy of it in a five-minute cookie, `POST /api/auth/verify` compares the body against that cookie, verifies the wallet's ed25519 signature over `sha256(borsh(tag ++ message ++ nonce ++ recipient ++ callbackUrl))`, requires the signing key to appear on the claimed account's chain key list as `FullAccess`, and only then issues a twelve-hour `HttpOnly; SameSite=Strict; Path=/api` session cookie whose HMAC key is HKDF-derived per purpose — so a session token is not a sign-in challenge and neither is ever sent to the gateway's `/r/:slug`. Evidence: 30 NEP-413 tests pinned against golden vectors measured from `@near-js/signers`, 14 codec tests, 7 chain-read tests with `fetch` stubbed, and 17 route tests on real Postgres that sign in with a locally generated keypair and then use the issued cookie to list endpoints through `createApp`; 18 of 20 deliberate breakages were caught, and the two that survived are redundant layers (the ed25519 key construction already refuses a secp256k1 key; HKDF already separates the two cookies) whose pair-mutation is caught. What F1 does not have: a wallet to prompt in the browser (F8) and a real testnet account whose key list can be read (A10). The dashboard now has a screen on that session (F2): `/endpoints` reads F1's cookie server-side and forwards it to `GET`/`POST /api/endpoints` through the `/api/*` rewrite, so the browser stays single-origin and the cookie stays `HttpOnly`, and either lists the seller's endpoints or says why it cannot. Creating one is edit, then confirm, then result: the price the seller types is converted by `parseAmount` (`1.25` to `1250000`, never a float), the payout destination is shown for confirmation and sent back as `confirmedAddress`, and D4's checks come back in the API's own words with the failures first. A body the API's own schema refuses is reported as unreachable rather than as an empty list, because an unverified response is not a verified empty one. Proven against a booted API through the web origin: `201` with 8 checks and 3 failing, `422 destination_not_confirmed` for a create that did not echo the address, and the next `GET /endpoints` server-rendered the new row as `Not live` with its reasons. What it does not do is make an endpoint live: every endpoint that run created is `active:false`, because `upstream_url`, `destination_address` and `storage_registration` need a public origin and A10's accounts, and inventing a payout account to paint a green check is not on the table. The seller's reconciliation worklist is the third screen on that session (F4): `GET /api/discrepancies` returns only that seller's open items, ordered by a SQL `CASE` generated from core's `SEVERITIES` rather than a rank typed out twice, `POST /api/discrepancies/:id/resolve` closes one occurrence and answers with the closed row, and `GET`/`POST /api/payer-blocks` show and lift the holds using the same predicate the gateway blocks on. A row the contract cannot read is a named `500`, never a worklist with one item fewer, and a clear's author comes from the session: the route test sends `clearedBy` in the body and asserts the stored row names the signed-in account anyway. |
| x402 on NEAR, Intents payouts | The x402 half is written and measured offline (see the gateway row); the payout half runs on the mock provider, by decision (A17 chose option (c)), and the demo labels it. Spikes: S1 closed on its fallback branch (`payTo` is the seller's own testnet account, because `@x402/near` refuses an unregistered payee before anything moves), S5 closed on paper, S3 and S4 answered by the organizers, S6 half measured offline and its answer is the opposite of what the roadmap assumed — concurrent delegates from one payer **both verify**, so one-in-flight is the gateway's job (`docs/spikes/S6.md`); S2 and S7 are blocked on the money question A17 declined. Nothing here has been run against a chain. |
| CI guard scripts | **Run, and they work.** `sh scripts/check-boundaries.sh` passes on this tree and exits 1 on each injected violation (`@fastnear` outside `x402/near.ts`, a float money literal, a `drizzle-orm` import in `packages/core`, a bare `z.array(` in a schema file). `pnpm roadmap:check` exits 1 both when `ROADMAP.md` is stale and when a change touches code but not the roadmap — the second case verified against a temporary commit, not by reasoning, because a dirty worktree reproduces it falsely. |

All of it executes: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm boundaries` and `pnpm roadmap` all pass on Node 22, the API boots and answers `/healthz` and `/api/healthz`, refuses to start on a missing env var, and the Next dev server reaches the API through the `/api/*` rewrite, which `next build` now compiles with `/endpoints`, `/payments` and `/reconciliation` as dynamic routes (F2, F3, F4). UI-3 is on the tree too: `GET /api/payments` scoped by the endpoint join, and the seller's ledger page rendering each row's state, decimal amount and explorer link — proven against a live process pair at `ROADMAP.md` F3 (15/15 checks, both chains' link shapes, no link invented for a missing hash). UI-4 is on it as well: `/reconciliation` lists the seller's open items severity-first from core's own `SEVERITIES`, prints each finding's explanation and suggested action as the rule wrote them, closes one by hand and shows the payers this seller is holding — listed by `strikesForPayer`'s own predicate, so a hold on screen is a hold the gateway is enforcing — with a clear that records the signed-in account as its author and never a name from the body. Proven the same way (26/26, including the page re-read after both actions). CI runs the same commands on GitHub Actions and is green on `main`. What has *not* happened: a paid request on a chain — the 402 has been served by a live process and has never been paid by a wallet, no `ft_transfer` has landed, no relayer has submitted a transaction, and no payout has moved. The gateway does write a `payment_in` ledger entry on its settled path, but only in tests, against real Postgres and a settlement that was scripted — the money half of that line is still the mock's. The ledger's own rule is now tested as a rule (E1): `apps/api/test/ledger.test.ts` books every event and counts only the rows its run minted — one entry per settlement, the `direct` pair, one `payout_out` per succeeded swap, one `refund_in` per refunded one, two events on one swap staying two rows — and lets the database, not the writer, refuse a negative payout, an invented payment id and a fifth kind. The single-writer boundary was watched firing at a planted second file, and the suite leaves its rows behind rather than deleting them, because the append-only trigger refuses that in a test exactly as it does in production. Matching is now a tested function rather than a design sentence (E2): `apps/api/src/services/swaps.ts` is the only writer of `swaps.payment_id`, `linkSwapByHash` reads the hash off the swap's own row so no caller can hand it an amount or a window, and 14 tests on real Postgres pin both halves of the rule — the same hash links sums of 7 and 999 999 999 and a payment settled in 2020, while a pair whose amount, asset and both timestamps are identical and only the hashes differ is refused. What it cannot decide it reports: a missing or blank hash, a hash nobody carries, and two payments sharing one hash (both ids named, nothing written, because picking one would hide the other). It scopes to the swap's seller and never to its route — PO-7's old payment on an old route is precisely the pair that must still join — and it is blind to payment state, since interpretation is the rules' job. The write is a compare-and-set on `payment_id is null`, and the branch that loses it is observed rather than assumed: a second connection holds the row locked and uncommitted, `pg_stat_activity` confirms the matcher's update is standing on that lock, and the matcher then reports the link that won instead of claiming one it wrote. Its single-writer boundary was watched firing too, and the calling of it is D6's now: `jobs/poll-payouts.ts` runs `linkSwapByHash` on every provider answer from inside the transaction that claimed the row, so the join has a production caller — while E9's loop remains the reader, and a deployed process still has no `swaps` rows to join until the S2/B8 creator exists. The proxy is now routed through by the gateway's own suite: a `node:http` seller on `127.0.0.1` is dialed by the shipped `getUpstream`, and one case asserts that a request going through the *default* upstream seam is refused by the shipped SSRF policy. `pnpm test` counts 210 passing and 6 todo in `packages/core` (the todo are three rules whose tasks, E10 to E12, are still open), and 532 passing in `apps/api` across 34 files when `DATABASE_URL` points at a Postgres — 225 passed and 307 skipped without it, since the eighteen database files skip (281 tests in them: `payments`, `guards`, `gateway`, `endpoints`, `payout-routes`, `auth`, `strikes`, `sweep-stale`, `append-only`, `ledger`, `ids`, `money-constraints`, `discrepancies`, `payments-route`, `discrepancies-route`, `endpoint-updates`, `swap-matching` and `reconcile`), and `poll-payouts.test.ts` running only its two `backoffSeconds` unit tests without one (26 of its 28 skip). `apps/web` adds 151 passing across 8 files — the dashboard's tests, run by the same `pnpm test` in Node through `renderToStaticMarkup`, no browser and no new dependency. The `createApp` suite is not among the skipped ones: `createApp({ env, log })` lives in `apps/api/src/app.ts` and `server.ts` only boots, so a handler is tested by calling `app.request(path)` with an injected env and a recording logger — no port, no database (A21). `docker compose up` runs on Compose v2 and works (Postgres healthy, migrations applied, both servers answering) from a built image, and no longer writes root-owned files into the checkout, which was A16. The security pass G4 scanned every blob in git history and the whole working tree for credentials, hardened and mutation-tested the SSRF record check, and triaged `pnpm audit`; C14 then cut the production advisories from seven to three, each judged on reachability rather than severity (the rest are recorded in `ROADMAP.md` section 8 and owned by C16). The red-team pass G6 ran early over the code that exists rather than waiting for the rest, and four guards came out of it: money that must be positive is validated as positive at the JSON boundary and in the environment (a negative endpoint price used to parse, and `MIN_PRICE_BASE_UNITS=-1` used to boot), and the money columns now also carry CHECK constraints so a write path that skips the schema still cannot store a negative sum (A19), the proxy now filters the seller's *response* headers and not only the buyer's request, log redaction covers credential-shaped names and shapes inside a value, and a shortfall tolerance too wide to ever fire is refused in both the function and the config. Every one of them was broken on purpose afterwards to confirm its tests fail — the counts and the mutations are in `ROADMAP.md` under G6.

### The line between mocked and real, drawn where the code draws it

Payouts default to `PAYOUT_PROVIDER=mock` and the network to `near:testnet`, and
a run never sends a mainnet transaction unless a human asks for that specific
action (see [`AGENTS.md`](AGENTS.md)). `pnpm demo` scripts exactly three surfaces
and prints that it did so in its own header:

- **the chain** — a loopback JSON-RPC stub behind the payment layer's `signer`
  seam, so the NEP-366 delegate is genuinely signed by the shipped signer over an
  advertisement the client really received, and the only invented answer is
  "did the transfer land";
- **the payout provider** — `PAYOUT_PROVIDER=mock`, every status carrying
  `raw.simulated = true`;
- **the seller's origin** — a loopback upstream behind `app.ts`'s
  `gateway.upstream` seam. `resolveUpstreamTarget` refuses a loopback address for
  every seller whatever `ALLOW_INSECURE_UPSTREAM` says (C5: that knob is about
  http versus https, never the address), so the demo bypasses the policy at one
  call site and says so rather than relaxing a rule that exists to stop a seller
  pointing Till at its own network.

Everything else in the walk is the shipped code on real Postgres: the gateway
route, `@x402/near`'s verification, the guards, the ledger writers, the poll loop,
the reconciliation rules and the dashboard's own reads. The six steps, each ending
in checks against a response or the database:

1. a seeded endpoint answers `402` with the six fields a payer signs against, and
   the unpaid request dialled the seller zero times and booked zero ledger lines;
2. `scripts/demo-agent.ts` pays as its own process, exits `0`, and leaves exactly
   one `settled` payment row carrying the receipt's settlement hash;
3. the money books one `payment_in` in the token the payer sent, the polled swap
   reaches `succeeded`, and the payout books one `payout_out` on the *destination's*
   asset — two different tokens, which is the cross-chain half;
4. a refund comes back, books one `refund_in`, and reconciliation opens
   `PAYOUT_REFUNDED` for that swap with an explanation and a suggested action;
5. a payer whose balance is below the price is refused `402` with the reason in the
   re-challenge, the seller is never dialled, and no row is opened;
6. a payer served twice without settling is blocked `403 payer_blocked` on the
   third, neither strike books revenue, and reconciliation opens
   `SERVED_NOT_SETTLED` for each.

## Known limitations

- **The headline feature is unproven on a chain.** The payment layer is executed
  offline against the shipped scheme (C1) and the gateway has served a real `402`
  from a booted process (C4, and again for this README on 2026-11-09), but no
  wallet has ever paid one. A boot with no relayer key answers a request that
  carries a decodable payment header with
  `503 {"error":"unconfigured","detail":"no relayer configured, so nothing can be
  verified or settled"}` — fail-closed, and the exact shape of A10's gap. (A
  header that does not decode is a `402` re-challenge naming
  `payment_header_undecodable`; both were observed on the stack in the Quickstart.)
  A10 — three testnet accounts with the relayer funded, testnet NEAR being free
  (Q-008) — is what turns "scripted to accept" into "the chain accepted". Whether
  an Intents deposit address can act as an x402 `payTo` was closed by S1 choosing
  its documented fallback, `payTo` is the seller's own account, because the
  measurement needs mainnet and A17 kept the payout leg on the mock. `direct` mode
  plus reconciliation is therefore the product being built, and Intents payouts are
  labelled as unmeasured.
- **Nothing in this repository has ever touched mainnet, and the one path that
  could is not written.** `PAYOUT_PROVIDER=mock` is the default in the tests, the
  demo, CI and `docker compose up`. The other value, `oneclick`, is the real Intents
  client, and it is still an empty file that throws `not implemented (D3)` — so
  there is no route from a checkout to a mainnet transaction, which is A17's
  decision rather than an accident. Every money number in this project is base
  units of a testnet token against either the mock provider or the loopback chain
  stub in `scripts/demo.ts`.
- **The guards bound a payer's concurrency and their history, and both bounds are
  narrower than the summary suggests.** A short advertised window is `503`; a second
  payment in flight from one payer is `429 payer_in_flight` with `Retry-After`. Two
  details a reader gets wrong from that sentence: the gate is keyed on the **payer
  account alone**, not on payer-and-endpoint, so one payer cannot hold two payments
  open even across different endpoints of the same seller; and the window is
  **derived rather than configured** — `ceil((UPSTREAM_TIMEOUT_MS +
  AUTHORIZATION_EXPIRY_MARGIN_MS) / 1000)`, which is 45 s on the defaults and moves
  only if one of those two moves. The guarantee sits at the insert, behind a
  per-payer advisory lock, not in a read, because S6 measured that two concurrent
  delegates from one payer both verify and both submit. C9's history is per payer
  **and** seller: two `served_unsettled` rows in 24 hours answer that payer's next
  paid request with `403 payer_blocked`, at that seller only. PRD 8.6 words this as
  "served once, then blocked"; the shipped, tested, mutation-proved threshold is
  two, because one strike would block a payer whose single failure was the
  gateway's own, and `pnpm demo` step 6 prints the disagreement rather than moving
  the number (G5 owns the doc half). The seller's clear ships —
  `POST /api/payer-blocks/:payerAccountId/clear` (F4) — and appends a `payer_clears`
  watermark instead of rewriting history; a block also ages out when both strikes
  leave the window, and the `403` carries no `Retry-After`, because no timer is the
  promised exit.
- **A replayed authorization gets one more serve, and only five minutes of second
  copies.** C7 built the `abandoned` half: an authorization whose row abandoned (the
  upstream failed or timed out, nothing charged, nothing delivered) is accepted
  again, moves that *same row* back to `verified` and serves once, settling on a 2xx
  like a first attempt. A row that already has an answer is `409 payment_replay`, and
  what comes back with it depends on the answer (C12, GW-9):
  - `settled` with a hash **and** the served bytes still in this process's cache —
    under five minutes old, under 256 KB, not evicted from the 1 024-entry / 32 MiB
    bound, and the cache is memory, so a restart empties it: the buyer gets the same
    bytes with a `PAYMENT-RESPONSE` receipt rebuilt from the stored row, and the
    seller is not dialled twice for one authorization;
  - `settled` with a hash and a cache **miss**: `409` *with* the receipt, so a buyer
    who lost the response can still prove it paid, and still has no copy of the body;
  - `served_unsettled`: `409` with no body and no receipt, and never cached on
    purpose — goods delivered on credit will not be delivered twice.
  An `abandoned` row that carries a settlement hash or a `settled_at` is refused too:
  evidence of money moving outranks the state written before it, and since C10 that
  row is a shape the code can actually produce — the boot sweep abandons a stale row
  only after reading the chain and keeps the hash when the transfer failed. The
  sweep's blind spot is stated rather than hidden: a crash between submitting a
  settle and recording its hash leaves a row with no evidence, so the sweep abandons
  it, and if that settle did land the ledger is short one `payment_in` (the
  delegate's nonce still refuses a second serve). That is reconciliation's to find,
  not the payer's to suffer. While the first request is *still* running the answer
  is C8's `429`, which is the honest one: there is no response to replay yet.
- **GET only, and a non-GET says so.** The gateway serves one method and refuses the
  rest by name (C20): `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS` answer
  `405` with `Allow: GET` and the gateway's own JSON
  `{"error":"method_not_allowed"}`, and none of them get a `PAYMENT-REQUIRED` header,
  because a method nobody can pay for is not offered a price. The refusal runs before
  the endpoint read, the request limiter, `verify` and `settle`, so it books no row,
  dials no seller and writes no ledger line. It also precedes existence: `POST
  /r/nope` is a `405`, not a `404`. `HEAD` is what made this a money bug rather than a
  wording one. Hono cannot route a HEAD to a HEAD handler — `hono-base.js` dispatches
  it as a GET and answers `new Response(null, …)` — so before C20 a `HEAD` carrying a
  valid payment verified, served and settled, and the server dropped the body. Since
  `settled` is neither a strike nor a discrepancy, nothing in the product would ever
  have reported a payer who paid for nothing, and the follow-up GET was refused `409`
  on its own replay key. Both halves were seen on the compose stack today: `curl -I
  /r/demo` and `curl -X POST /r/demo` answer `405` with `allow: GET` and no challenge
  header where `GET /r/demo` still answers `402` with one, and the api logs carry the
  `{"code":"method_not_allowed","method":…}` warns. The behaviour is asserted against
  real Postgres in `apps/api/test/gateway.test.ts`, "the method policy (C20, GW-2)".
  The rest of PRD §4's non-goals fall out of what the
  proxy does rather than from a refusal: the buyer's request body is never read (only
  the URL and its query string go upstream), responses are buffered rather than
  streamed and capped at `UPSTREAM_MAX_BYTES` (1 MiB by default, asked for with
  `accept-encoding: identity` so the cap counts real bytes), a seller `3xx` is
  forwarded with its `Location` made absolute and never followed, nothing settles for
  a response that delivered no resource, and a seller's `set-cookie`,
  `www-authenticate` and `content-length` are stripped on the way out (G6) — so a
  seller that sets cookies or prompts for credentials through Till will look broken.
  There is no CORS middleware: a browser page on another origin cannot present a
  payment header at all, because the buyer this design serves is an agent process,
  not a tab.
- **"Stablecoins only" is a scope statement the code does not enforce.** PRD §4 lists
  "payout assets other than 6-decimal stablecoins" as a non-goal and AGENTS.md hard
  rule 9 repeats it, but nothing here gates the token: `endpoints.asset_contract` and
  `payout_routes.destination_asset` are free text, `checkEndpointCreation` validates
  the network, the price floor, the address shape, the refund address and NEP-145
  storage — never the asset's kind or its decimals — and `parseAmount` /
  `formatAmount` default to `STABLECOIN_DECIMALS = 6` in `packages/core/src/money.ts`.
  The consequence is the misleading half: a seller who names an 18-decimal asset is
  **accepted** and then read as if it had six, so the advertised price is wrong by
  twelve orders of magnitude instead of refused. What *is* enforced at the money
  boundary is sign and floor — positive-amount validation in the schemas and A19's
  CHECK constraints in the columns. Whether to enforce an allow-list at creation is
  an open decision, and it is stated here rather than settled quietly.
- **The demo advertises a `payTo` that cannot receive money.** The Quickstart's
  decoded `402` names `payTo: "mock-deposit-1"`, and the seed line says what it is:
  "made up by the mock provider; no swap will run". Under `PAYOUT_PROVIDER=mock` the
  route's deposit address comes from the mock's `prepareRoute`, so the price, the
  asset and the network in that challenge are the real ones and the address is not
  payable. With a real provider the address is one the provider prepared; S1's
  finding — a facilitator refuses an unregistered payee before anything moves — is
  why a `direct` endpoint advertises the seller's own account instead, which the
  gateway suite asserts beside the `intents` case.
- **A deployed process has nothing to poll and, until it does, nothing to join.**
  `jobs/poll-payouts.ts` starts on `POLL_INTERVAL_SECONDS` and `jobs/reconcile.ts`
  runs the rules on `RECONCILE_INTERVAL_SECONDS` and again for every seller the
  poller moved, so a boot does take a swap to its terminal state, link it to the
  payment sharing its hash and book the payout or refund line inside the one
  transaction that claimed the row. What it acts on is a `swaps` row, and no
  production path creates one yet: that writer is the piece that has to decide the
  standing-versus-per-payment deposit design, which is spike S2 and B8's open
  question. So today the queue is filled by the test suite and by `pnpm demo`,
  matching by transaction hash assumes deposits report origin hashes (S2), and
  without that assumption reconciliation is materially weaker.
- Micropayment economics are unmeasured, so `MIN_PRICE_BASE_UNITS` is a
  placeholder (S7).
- **The dashboard is proven as far as a tree with no DOM framework can prove it.**
  `apps/web` renders through `renderToStaticMarkup` and was driven against a booted
  API and a `next start` process with a minted session cookie (F2, F3, F4, F9), but
  no test clicks a button: the state a click sets is passed to those components as a
  prop, and the click path belongs to a human or to the submission video. What the
  Quickstart shows of the dashboard is therefore the honest state — the three real
  pages ask for a session, and `/sign-in` names F8 as the missing wallet rather than
  pretending.
- The project name is a working name; `accensa-till` is the repo, "Till" appears
  throughout the docs, and renaming is open work under A1.
- The migration set is drizzle-kit generated except `0001_ledger_append_only.sql`:
  a generator cannot express a trigger, so that file is hand written and
  registered in `migrations/meta/_journal.json`. If a later `pnpm db:generate`
  takes the 0001 slot, renumber it — the header comment says how.
- Dependencies are installed and `pnpm-lock.yaml` is committed, so the version
  ranges are resolved and `--frozen-lockfile` works (the resolved versions, one
  line per package, are the Built with section at the end). The runtime set is
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
  because the payout leg runs on the mock provider (see the disclosure above).
  Two honest caveats in that set: `@fastnear/wallet` is declared and imported by
  nothing (C18, P1, a human call because removing a dependency is one), and the
  one native transitive dependency is `secp256k1`, which compiles during install.
  `pnpm audit` is 3 production advisories, all recorded in `ROADMAP.md` section 8
  with why each is or is not reachable here.
- **`docker compose up` needs Compose v2, and it no longer writes into your
  checkout.** Re-verified on 2026-11-09 on this tree: `find . -user root | wc -l`
  is `0` after the stack came up, the api and web services carry their dependencies
  in a built image instead of bind-mounting the repository and installing inside the
  mount, and `pnpm demo` passed when run inside the api container. That was A16, and
  the earlier state of this bullet — root-owned `node_modules` per package and a
  root-owned 650 MB `.pnpm-store` you could not delete without `sudo` — describes the
  bind-mount design it replaced. Legacy `docker-compose` v1 (1.29.2) still cannot read
  this file at all, since it rejects Compose Spec keys like `name:`.
- **The payout leg has no testnet.** `HACKATHON.md` Q-007 (2026-11-03) states that no
  NEAR Intents testnet exists or is planned, so real payout behaviour is mainnet only.
  Development uses `dry: true` quotes and the mock provider, and a mainnet transaction
  needs the human's explicit approval with a stated ceiling (A17). A partner API key is
  not required and costs 0.2% without one (Q-006), so nothing on the payout side waits
  on partner onboarding.
- GitHub Actions is green on `main`, and the guards were seen failing there too: a
  float money literal stops the `boundaries` step, a code-only commit and a stale
  progress block each stop the `roadmap` step. Those three were run on throwaway
  branches pushed only to be dispatched and deleted, so the checks are proven on the
  runner and no broken commit survives on any ref. The `demo` job runs on every push
  and pull request and has run twice there since G1 — the second pass against the
  database the first one wrote.

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
[https://nearhackathon.com/HACKATHON.md](https://nearhackathon.com/HACKATHON.md).
The pinned copy was re-fetched and re-pinned on 2026-11-09 and is byte-identical
to the live file at that time (`cmp` clean, sha256 `903794f4…`); the organizers
have updated it since the first pin on 2026-11-03, and the whole delta is the new
"Request changes" process — a mistake in a saved submission is fixed at
[nearhackathon.com/request-changes](https://nearhackathon.com/request-changes),
never by submitting twice — plus two new partner rows. No date, no track rule and
no Q&A item moved, so nothing in the build plan changed. What binds this
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
not yet working. Q-005 allows any library, template or AI-written code and asks
that the README list it, which is what Built with below does, and Q-012 is why
there is a reproducible walkthrough here rather than a wall of screenshots.

## Built with

`HACKATHON.md` Q-005 allows any library, template or AI-written code and asks the
README to list it. The list is read out of `pnpm-lock.yaml` on 2026-11-09, so the
versions are the resolved ones rather than the manifest ranges.

| Package | Resolved | What it does here |
| --- | --- | --- |
| `hono` | 4.13.16 | the HTTP layer: the gateway route, `/api/*`, middleware |
| `@hono/node-server` | 2.1.6 | the one Node process the api runs in |
| `drizzle-orm` | 0.38.4 | every query the app writes |
| `drizzle-kit` | 0.30.6 | generates `apps/api/migrations/` (`pnpm db:generate`) |
| `postgres` | 3.4.9 | the Postgres driver underneath drizzle |
| `zod` | 3.25.76 | every boundary check, including the x402 payment payload |
| `jose` | 5.10.0 | the signed session cookie in `apps/api/src/lib/session.ts` |
| `@fastnear/x402` | 2.5.0 | the NEAR x402 facilitator. Inside `apps/api/src` only `x402/near.ts` may import it (hard rule 1, and `pnpm boundaries` greps for the violation); two api test files import it directly, which is how they mint genuine NEP-366 delegates rather than stubs |
| `@fastnear/wallet` | 2.5.0 | installed and imported by nothing; dropping it is C18, a human call |
| `next` | 15.5.28 | the dashboard, `apps/web` |
| `react`, `react-dom` | 19.3.1 | the dashboard's components |
| `tailwindcss` | 4.3.3 | the dashboard's styling, via `@import "tailwindcss"` in `apps/web/app/globals.css` |
| `typescript` | 5.9.3 | the language, `strict`, no `any` |
| `@biomejs/biome` | 1.9.4 | `pnpm lint` |
| `vitest` | 2.1.9 | every test in `packages/core`, `apps/api` and `apps/web` |
| `tsx` | 4.23.15 | runs `scripts/*.ts` with no build step |

Underneath those, load-bearing and only transitive: `@x402/near` 2.18.0 — the
scheme Till claims to implement, whose shipped code S1 read for the
storage-balance rule — and `secp256k1` 5.0.1, the one native module, compiled
during install. Neither is in a manifest; both are in the lockfile. The wire
format, the NEAR transaction encoding and the payment signature check are that
library's job, not ours (AGENTS.md hard rule 1: no new protocol code).

**Not used, and worth saying because a reviewer has to guess otherwise:** no
template, starter kit, boilerplate generator or UI component library.
`shadcn`, Radix, Tremor and `@mui` appear zero times across the four manifests
and the lockfile; `apps/web/components/ui/` holds a `.gitkeep` and the eleven
dashboard components in `apps/web/components/domain/` are written here. No Redis,
no queue library, no separate worker, no browser test framework (hard rule 10),
and no hosted facilitator: the facilitator is a library running in this process,
so nothing in the payment path needs an API key.

**Our own pre-hackathon code: none.** `git log --reverse` puts the first commit on
2026-11-02, inside the 1–14 November window, and nothing here imports
`accensa-app`, `accensa-contracts` or `x402-facilitator-stellar` — that last one is
the same team's previous answer to this problem, linked as context below rather
than used as a baseline.

**How it was written:** by AI agents working from `AGENTS.md`, one `ROADMAP.md`
task at a time, each `[x]` carrying an `Evidence:` line naming the command that
ran and what it printed. A human made the calls recorded in `ROADMAP.md` section 8
(including A17, which is why the payout leg is mocked) and owns the accounts, the
keys and the submission.

## Contributing

**The rule: every contribution updates `ROADMAP.md` in the same change.** DQ-5,
AGENTS.md hard rule 14, and enforced rather than advised. `pnpm roadmap:check` is
`scripts/roadmap-progress.ts --check` plus `scripts/check-roadmap.sh`, and it
fails a diff that touches anything in the repository while leaving `ROADMAP.md`
unchanged, and fails a progress block that no longer matches the task list. Both
halves were watched failing on the runner — a code-only commit and a stale
progress block, each pushed to a throwaway branch and then deleted — which is the
paragraph near the end of Known limitations.

"Update it" means the whole protocol in `ROADMAP.md` section 1, not the checkbox:

1. the task's status — `[ ]` `[~]` `[x]` `[!]` `[-]`, with `[x]` only after
   running that task's own `Done when` check;
2. its `Evidence:` line — the command you ran, what it printed, and what you did
   not run;
3. the requirement matrix, the spike tracker and the section 8 decision log,
   whenever the change touches them;
4. one changelog line in section 9 — date, task IDs, what changed, evidence;
5. `pnpm roadmap`, which regenerates the progress block. That block is generated;
   never hand-edit it.

Documentation-only, test-only and refactor-only changes are covered, and work
that matches no task gets a task first. The rule is written in three places
because DQ-5's `Done when` asks for three: here, in [`AGENTS.md`](AGENTS.md), and
as the first checklist item of
[`.github/pull_request_template.md`](.github/pull_request_template.md).

Definition of done, run locally before pushing:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm boundaries && pnpm roadmap:check
pnpm demo    # whenever the change touches gateway, payouts, ledger or reconciliation
```

The counts, and the fact that `pnpm test` means two runs (with `DATABASE_URL` and
without — the database-backed files skip rather than fake, so a green run without
a database is a smaller green run), are in the paragraph under "What is real, and
what is not". Every `Evidence:` line says which of the two it was.

Five more rules are decisions rather than suggestions, and they are the ones a
fast agent breaks:

- P0 before P1, one requirement per change, commit per task with a message like
  `C6 GW-3: settle only on upstream 2xx`, with `ROADMAP.md` inside that commit.
- For a guard, a reconciliation rule or ledger code, write the failing test first
  — then break the guard on purpose and confirm that test fails. A guard nobody
  watched fire is not a guard.
- Money is `bigint` base units and `numeric(78,0)` in Postgres; a float literal
  for an amount stops `pnpm boundaries`. Payments match payouts by transaction
  hash only — never by amount, time or heuristic (hard rules 3 and 7).
- No dependency added without asking a human (working method 6), and no mainnet
  transaction, funded key or paid external API call unless a human asked for that
  specific action in that session. The defaults `PAYOUT_PROVIDER=mock` and
  `NEAR_NETWORK=near:testnet` are the safe side and stay the defaults.
- Never print, log, commit or paste a secret — `RELAYER_SECRET_KEY`,
  `ONECLICK_JWT`, `SESSION_SECRET` — and never create or edit a real `.env`;
  change `.env.example` only.

And the reporting rule, which is why this README is written the way it is: **do
not report success from reading code — report what you ran and what it printed.**
"Tests pass" and "works end to end" are different claims, and the pull request
template asks which one you actually verified.

Built for the NEAR Hackathon, development window 1–14 November 2026, Real-World
Money track. Part of the Accensa org, alongside
[accensa-app](https://github.com/accensa/accensa-app),
[accensa-contracts](https://github.com/accensa/accensa-contracts) and
[x402-facilitator-stellar](https://github.com/accensa/x402-facilitator-stellar).
