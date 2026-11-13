# ARCHITECTURE: Till

Version 2, revised after a red-team pass (section 14). Companion to `PRD.md`. For a short outline of the decisions that matter most, see `ARCHITECTURE_ESSENTIALS.md`.

Items marked **[VERIFY]** are assumptions about third-party behavior that were read from documentation or recalled, not tested. Each maps to a spike in section 12. Do not build on a [VERIFY] item before its spike is closed.

---

## 1. System overview

One backend process, one web app, one database.

- **Gateway**: public HTTP surface that buyer agents call. Issues x402 `402` responses, verifies payments, proxies to the seller's upstream, settles.
- **Facilitator (in process)**: verification and settlement of NEAR `exact` scheme payments, using the existing FastNear implementation. Holds the relayer key.
- **Jobs (in process)**: two timer loops inside the same process, one polling payout status and one running reconciliation. No separate worker and no job queue library.
- **Dashboard API**: authenticated JSON API for the seller UI, served by the same process.
- **Web app**: the seller dashboard. Reaches the API through Next.js rewrites so the browser sees a single origin.

```
 Buyer agent                                          Seller upstream API
     |                                                       ^
     | 1. GET /r/:slug                                       | 4. proxied GET
     v                                                       |
+-----------------------------------------------------------+------+
|  apps/api (Hono, one process)                                    |
|                                                                  |
|  Gateway --- 2. 402 requirements (cached per endpoint)           |
|     |  3. verify + guards (expiry, balance, strikes, in-flight)  |
|     |  5. settle on NEAR (relayer pays gas)                      |
|     v                                                            |
|  services (payments, ledger, discrepancies) --> Postgres         |
|                                                                  |
|  Dashboard API  <----- Next.js rewrites <------ apps/web         |
|                                                                  |
|  Loops: poll-payouts (20s), reconcile (60s)                      |
|     \--> PayoutProvider (1Click or mock)                         |
+------------------------------------------------------------------+
```

## 2. Key architectural decisions

| # | Decision | Alternatives rejected | Why |
|---|---|---|---|
| D1 | Hosted gateway that proxies to the seller's API, GET only in v1 | Middleware SDK; POST and streaming support | Zero seller code; GET only removes body replay, streaming and non-idempotency problems. Since C20 the restriction is enforced rather than planned: a non-`GET` on `/r/:slug` answers `405` with `Allow: GET` and no challenge, before the endpoint read, before the limiter, before `verify` and before any settle (`gateway/route.ts`'s `refuseMethod`, code `method_not_allowed`). Hono dispatches a HEAD onto its GET handler and empties the answer afterwards, so that one method is caught inside the handler by reading `c.req.method`; the rest reach the separate registration |
| D2 | Reuse the NEAR x402 packages in process; build no protocol code | Own facilitator; standalone facilitator service | Protocol layer exists; value is the seller operations layer. Verified 2026-11-03 from the shipped types: `createNearFacilitator` and `createNearResourceServer` run in our process and the server takes an `InProcessFacilitator`, so "in process" is what the packages are built for, not a stretch. It does mean our own relayer account sponsors the gas (see 13) |
| D3 | No custom smart contracts | Escrow or payments contract | NEP-141 transfers with NEP-366 delegates cover the flow |
| D4 | Payouts behind a `PayoutProvider` interface with a mock | Direct 1Click calls everywhere | Offline demo, keyless screening, and a fallback if the API misbehaves |
| D5 | Append-only per-asset event ledger, enforced by a database trigger | Mutable balances; lint-only enforcement | Reconciliation needs an immutable trail. It is an event log, not double-entry accounting |
| D6 | Single Postgres, in-process timer loops, `FOR UPDATE SKIP LOCKED` for claiming work | pg-boss, Redis, separate worker | Two timers do not justify a queue library or a second process |
| D7 | Verify, call upstream, settle only on upstream 2xx, with four guards (4.2) | Settle first; settle always | Seller is never paid for a failed call; guards cover the exploit this ordering creates |
| D8 | TypeScript end to end, pnpm workspaces, one shared package (`core`) | Rust; many small packages | The needed packages are JS; only the web app shares code with the API |
| D9 | Money as integer base units | Floats, decimal strings | Exact accounting |
| D10 | Payout mode per endpoint: `direct` or `intents` | Intents only | `direct` is the fallback if S1 fails and costs almost nothing to keep |
| D11 | Payout assets limited to 6-decimal stablecoins in v1 | Any asset the provider supports | Removes the need for a price oracle in shortfall detection and avoids decimal mismatches |
| D12 | One `intents` sub-design only (standing or per-payment address), chosen by S2 | Supporting both | Two matching strategies doubles the hardest code. Delete the loser from this document once S2 closes |
| D13 | Payments matched to swaps by transaction hash, never by amount and time | Heuristic matching | A heuristic that can mis-match hides the exact errors the product exists to find |
| D14 | One in-flight paid request per payer in v1 | Per-payer nonce-ordered settlement queue | Sidesteps NEP-366 nonce ordering hazards (14.1); revisit after S6 |

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x strict, Node 22 LTS | |
| Monorepo | pnpm workspaces | `apps/api`, `apps/web`, `packages/core` |
| API | Hono with `@hono/node-server` | |
| NEAR x402 | `@fastnear/x402` 2.5.0 (`./server`, `./facilitator`, `./node`) over `@x402/near` 2.18.0 | Verified from npm 2026-11-03: framework-agnostic, no express, ships a self-hostable facilitator and a reference relayer signer. `@x402/near` is not in any manifest — the lockfile resolves it at 2.18.0 as a dependency of `@fastnear/x402` (`pnpm-lock.yaml`). See 13 |
| NEAR RPC reads | JSON-RPC over `fetch`, and `node:crypto` for ed25519 | Sign-in needs a public read (`view_access_key_list`) and a signature check, not a signer; hard rule 1 keeps every `@fastnear/*` import in `x402/near.ts`. The browser wallet prompt is F8, and the package it needs is that task's open question |
| Payouts | NEAR Intents 1Click Swap REST API | Base URL `https://1click.chaindefuser.com`, paths under `/v0` (S5: the OpenAPI `servers.url`). **Measured from this host 2026-11-10**, plain HTTPS, no credentials: `GET /docs/v0/openapi.yaml` → 200, 1,900,990 bytes, sha256 starting `9a2e6766`; `GET /v0/tokens` → 200, 54,920 bytes; `GET /v0/status` with no parameters → 400 `Deposit address should be not empty`. The live spec's `GetExecutionStatusResponse.status` re-diffed against `docs/spikes/S5.md` field for field: the same seven values (`KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, `FAILED`). The limit that remains: those values and the hash arrays are confirmed at spec level only — nothing has been seen on a real swap, and no key exists (D3 open) |
| Database | PostgreSQL 16 | `NULLS NOT DISTINCT` available (15+) |
| ORM | Drizzle with the `postgres` driver | SQL migrations committed |
| Sessions | Signed cookie via `jose` | No sessions table |
| Validation | Zod | Schemas in `packages/core` |
| Web | Next.js App Router, hand-written domain components, Tailwind classes | Rewrites `/api/*` to the API. No component library: `shadcn` and `radix` appear zero times in the manifests and `pnpm-lock.yaml`, `apps/web/components/ui/` holds only a `.gitkeep` that nothing imports, and all twelve components are hand-written in `apps/web/components/domain/` (`CreateEndpointForm.tsx` to `SwapTimeline.tsx`). Tailwind v4 compiles through `apps/web/postcss.config.mjs`, which loads `@tailwindcss/postcss` (dev dependency, approved by the human 2026-11-10 — Next uses its own built-in PostCSS set when that config file is absent, and that set does not include Tailwind v4, so `app/globals.css`'s `@import "tailwindcss"` reached the browser as `node_modules/tailwindcss/index.css` verbatim: 33,847 bytes of preflight and `@theme` variables with `@tailwind utilities` unparsed and zero utility rules). Measured after the fix, same day: `next build` emits one 8,632-byte stylesheet whose 57 utility rules cover every `className` the twelve components carry, `.flex`, `.text-sm`, `.space-y-4` and `.divide-y` included |
| Tests | Vitest; `pnpm demo` doubles as the end-to-end test | No browser test framework |
| Lint and format | Biome | One tool |
| Boundaries | `scripts/check-boundaries.sh`, a grep script in CI | Enforces the rules in `PROJECT_STRUCTURE.md`: one writer per table (`ledger_entries`, `payout_routes`, `discrepancies`), the payment-to-swap link only in `services/swaps.ts`, `@fastnear` only in `x402/near.ts`, 1Click only in `payouts/oneclick/` and `env.ts`, `packages/core` free of database, HTTP and framework imports, and no `@till/core` barrel in `apps/web` — where the string rule is backed by running `next build`, because only the bundler can see a subtree that re-exports `node:crypto` |
| Roadmap upkeep | `scripts/roadmap-progress.ts` and `scripts/check-roadmap.sh` in CI | Fails any change that leaves `ROADMAP.md` untouched or its progress block stale |
| Hosting | One platform for API and Postgres (Fly.io or Railway); web on the same platform or Vercel with rewrites | Choose by accounts you already have |
| CI | GitHub Actions | Lint, typecheck, unit tests, boundaries, `pnpm roadmap:check`, `pnpm demo` against mock |

## 4. Request lifecycle

### 4.1 Unpaid request

`GET /r/:slug` with no payment header returns `402`. The requirements travel in the base64 **`PAYMENT-REQUIRED` response header** — that is x402 v2's own rule, read from the shipped client rather than from the spec prose: `getPaymentRequiredResponse` decodes that header and looks at the body only when `body.x402Version === 1` (`@x402/core` 2.18.0 `dist/esm/chunk-UCXEF6EL.mjs:1088-1096`), and the library's resource server writes the header and no body field (`:645-653`). Till repeats the same object as a JSON body with `x402Version: 2` in it, which is a value that fallback refuses, so a person with `curl` sees the price and no client can read the two positions differently. The header advertises **one** price in `accepts`, never a list: a wallet picks an entry, and two entries is an endpoint that can be paid the cheaper one.

`gateway/requirements.ts` (C2) builds this from the endpoint's own rows and refuses to advertise five shapes it could not itself verify — a network this process has no facilitator for, a pay-to it cannot resolve or that is not a NEAR account id, a price below `MIN_PRICE_BASE_UNITS`, a price or resource a boundary schema rejects. The reason for checking at advertisement time is S1's third consequence: a bad `payTo` is only discovered inside `verify`, on a stranger's request, so a wrong row looks like a working endpoint until someone pays for it and is refused.

Requirements are cached per endpoint, keyed by a fingerprint of the fields the advertisement is made of, and invalidated by their own content rather than by a write-path hook, so an unpaid request costs the one row read that resolved it and no provider call; the cache is handed neither a payout provider nor the verify/settle half of the payment layer, and it is synchronous. Entries are bounded (512 by default, evicting the oldest insertion). The advertised authorization window is derived as `max(30, ceil((UPSTREAM_TIMEOUT_MS + AUTHORIZATION_EXPIRY_MARGIN_MS) / 1000) + 15)` rather than configured beside those timeouts, so Guard 1 cannot be broken by config drift; S6 measured that this number is what the payer's client turns into `maxBlockHeight` at one block per second. In per-payment-address mode the fingerprint changes with every payment and the bound is what keeps memory flat; this is one reason standing addresses are preferred.

### 4.2 Paid request

The steps below are the design; what `gateway/route.ts` runs today is C4's order with C8's guards, and where the two differ the sentence says so and names the task that owns the difference.

1. Resolve the endpoint, then parse the payment header. Resolution comes first because a challenge must never be issued for a row Till could not honour: an unknown or paused slug is `404`, a payout mode this build does not run and an endpoint the advertisement layer refuses are both `503`. The blocked-payer check (4.3) cannot happen here: until `verify` runs, the payer is the request's claim rather than an account the signature binds, so the block is evaluated in the guard seam below (step 5) — and since C9 it is.
2. Facilitator `verify`. On failure: `402` with a reason. The reason is the only field that changes — price, asset, network and pay-to are re-encoded from the same cached advertisement, so a payer whose signature was refused mints a new signature against the requirement it was already shown rather than guessing which field moved. A verifier that could not run at all (`unconfigured`, `error`) is `503`, not `402`: asking a stranger to pay for something we have not established we can verify is the seller's failure, not the payer's.
3. **Guard 1, expiry.** Reject if the authorization's window is shorter than the upstream timeout plus a margin; otherwise settlement can fail after the work is done. Since C1, `expiresAt` is `null` by fact (the expiry lives in the delegate's `max_block_height`, and reading it means decoding Borsh here), so the comparison is against the **advertised** `maxTimeoutSeconds`, which S6 measured to be exactly what the payer's client turns into `maxBlockHeight` at one block per second. The scheme's own refusals (`delegate_action_expired`, and the over-wide-window refusal) are then checked at verify and at settle, so the guard's job is the *before-serving* half.
4. **Guard 2, balance.** Reject if the payer's token balance is below the price. S6 found `verify` already does this (`ft_balance_of` on `delegate.senderId`, refused at `balance < amount`), so the gateway's half is *when*: run it before the upstream call, so a payment that will be refused never buys a proxied response. Verification still does not **hold** funds, which is why Guard 4 exists.
5. **Guard 3, in-flight.** If the payer already has a paid request in flight, return `429` with `Retry-After`. One in flight per payer (D14). S6 measured that the scheme will not do this: two delegates from one payer both verify and both submit, and only the chain refuses the second — after the seller has served. This guard is the whole defence, and it must be keyed per payer (the ledger's `replay_key` only collapses identical payments).

Steps 3 to 5 are one seam in the code (`gateway/guards.ts`), and since C8 the seam is filled: the route's default is `createGuards`, and `guardsPendingC8` survives only as a name a test asks for when it wants the paid path without the guards. What ships is not three checks. Guard 1 is a **belt**, because the authorization's own window cannot be read (step 3) and the advertised number is derived from the same two env values the belt compares, so a running process cannot fail it — it is there for the day the window becomes a per-endpoint column. Guard 2 is **not run in this file at all**: `verify` already reads the balance on the account the signature binds, so re-reading it would be a chain call per paid request asking a question the same request just answered, and what Till owns is the ordering, which is tested by sending an underfunded genuine delegate and showing the seller was never dialed. Guard 3 ships in two halves, deliberately: the read in `guards.ts` is the polite one (a `429` with `Retry-After`, no transaction), and the **guarantee** is at the insert — `openPayment`'s claim takes `pg_advisory_xact_lock(hashtext(payer)::int)`, re-reads the payer's live row and inserts in the same transaction, and the loser gets `{kind: "in_flight"}` rather than a second row. A read-only version of this guard is not a gate, which is exactly what S6 measured. The read is bounded by `UPSTREAM_TIMEOUT_MS` + the settlement margin so a `verified` row left behind by a dead process cannot turn the rate limit into a ban; C10's boot sweep is what makes that row visible and dealt with (section 10), and the bound is what keeps it harmless in the meantime. Guard 4 ships since C9 in `services/strikes.ts` and is evaluated **first** in the seam: it is a fact about the payer that needs no configuration, and a misconfigured window must not turn a blocked payer's `403` into a `503` that reads like an outage. Its count cannot advance concurrently, because Guard 3 already allows one in-flight payment per payer, so the read is the whole enforcement rather than a polite half. A guard can answer `403`, `409`, `429`, `502` or `503`, and never `402`: it runs on a payment that already verified, and re-challenging that payer asks them to sign a second payment because of our decision — the blocked payer is the clearest case, since nothing they sign can lift a seller's block.
6. Insert the `payments` row with `replay_key`. If a row with that key exists in state `abandoned`, reuse it (same authorization, retry allowed). If it exists in any other state, return `409` with the stored receipt and no charge (see 4.4). **C7 shipped the reuse half C4 left at `409` for every existing row**: `openPayment` moves the abandoned row back to `verified` with a compare-and-set on `state`, re-stamps `verified_at` from the database clock so Guard 3's window and C10's sweep measure *this* attempt, clears the previous attempt's `upstream_status`/`upstream_ms`, and returns `retried` so the route logs that one authorization is being served on a row that already failed once. It refuses a row that carries a `near_tx_hash` or a `settled_at` (4.4), and it refuses a row belonging to a different endpoint, because `replay_key` deliberately does not contain the endpoint (8.3) and one seller's two endpoints at one price can present byte-identical delegates. The receipt on a `409` is attached only when the stored row is `settled` and carries a `near_tx_hash`, because a `409` that shows a receipt for a payment that did not settle would be a forged one. **C8 added the case this step never covered: an existing row that is still `verified` is a `429`, not a `409`** — the first request has not finished, so there is no answer to replay yet, and the honest reply is "come back in `Retry-After` seconds". The two rules compose rather than overlap: an abandoned row is not in flight, so the retry passes the guard's read; the retried row *is* in flight from then on, so a third request with the same authorization is a `429`. One authorization gets one more serve, not an unlimited queue of them (`guards.test.ts`).
7. Forward a `GET` to the upstream. No redirects followed, timeout enforced, response size capped, payment headers stripped.
8. Upstream returned 2xx: call facilitator `settle`. Anything else (4xx, 5xx, timeout): mark `abandoned`, do not settle, return the upstream status for 4xx and `502` for 5xx or timeout. The `502` replaces the body rather than forwarding it: a seller's 5xx is their stack trace, their framework's error page, their version headers, and a buyer has no business reading them. **C6 decided the 3xx C4 left open: it is the seller's answer, not their failure.** Till forwards the status and the body it comes with, rewrites a relative `Location` to absolute against the endpoint's own upstream URL (RFC 9110 7.3.2's rule for proxies — forwarded verbatim it would be a path on the gateway's origin, so the buyer's follow-up gets a `404` from Till rather than the seller's redirect), and settles nothing, because nothing was delivered. Following the redirect is still refused (section 8, C5): fetching the target here would mean dialling a second, unvalidated address on the seller's say-so and serving bytes this payment never bought, and it is the buyer's browser that goes there, not our proxy (section 8, and C5's `302` case in `upstream.test.ts`).
9. Settle succeeded: state `settled`, write `payment_in`, return the upstream response with a receipt header carrying the NEAR transaction hash. The header is v2's `PAYMENT-RESPONSE`, base64 of `SettleResponse` (`success`, `transaction`, `network`), read off `createSettlementHeaders` in the shipped client rather than invented here; `transaction` is the same string `payments.near_tx_hash` holds, which is what lets the reconciler join a receipt to a swap (LR-2) from one value. **C10 added the write that makes the hash survive a crash between submitting the settle and booking it**: `recordSettlementHash` sets `near_tx_hash` on the row *while it is still `verified`*, compare-and-set on `state = 'verified'` and `near_tx_hash is null`, before `advancePayment` makes the terminal move. The order matters — the row is the only place a restarted process can learn which chain transaction to look up — and the CAS means the stamp can fail without failing the request: if the row is no longer `verified`, some other writer owns it and the warning `settlement_hash_not_recorded` is the record of that. A settle that loses the terminal move (another writer advanced the row first) still returns the receipt, because the money moved and the payer is owed the hash; only the booking is skipped (`settlement_race`).
10. **Guard 4, strikes.** Settle failed after a 2xx upstream: state `served_unsettled`, open a critical `SERVED_NOT_SETTLED` discrepancy, still return the response. Payers with two such events in 24 hours are blocked from new paid calls until a seller clears them. This turns the exploit "pay with an empty account" into a bounded loss of one or two calls. **C9 shipped the count and the block**: the next paid request from that payer at that seller is `403` before any byte is bought (4.3), and the seller's clear is an appended `payer_clears` row. The state and the response are C4's, and the discrepancy row is still E2's write path — the event is logged at `error` with `code: "SERVED_NOT_SETTLED"` and no `discrepancies` row is inserted, so the log remains the only record of the discrepancy itself while the block reads the payment rows.

### 4.3 Blocked payers

**C9 shipped this, and it is one query plus one append-only table.**

A strike is a payment in state `served_unsettled`: an answer went out and the money did not. The count is computed over `payments` — there is no strike column and no counter to keep honest, because the row is already the fact. A payer with `STRIKE_THRESHOLD = 2` such rows inside `STRIKE_WINDOW_HOURS = 24` at one seller's endpoints answers `403 payer_blocked` on the next paid request, before the upstream is dialed. The count joins `payments.endpoint_id` to `endpoints.seller_id`, so the scope is **per payer and per seller**, not global: the loss belongs to the seller whose answer was served, and a block at one tenant must not be another tenant's to trigger or lift.

A seller's clear is a row in `payer_clears`, not an update: `payments` is append-only evidence (PO-7), so a clear that deleted or re-stated a strike would lose the record that the loss happened. The query compares each strike's `verified_at` against `max(payer_clears.created_at)` for that pair, which makes the latest clear a **watermark**: strikes before it stop counting, strikes after it count again, and every clear stays visible with `cleared_by` and an optional note. The window remains a second exit — a block ages out when both strikes leave 24 hours — but the documented exit is the clear, which is why the refusal carries no `Retry-After`: a date would be a promise Till does not intend to keep.

The refusal is `403`, not `402`: the payer already holds a valid authorization, and signing another one cannot lift a seller's block. The seller-facing HTTP route is F4's and has shipped: `GET /payer-blocks` and `POST /payer-blocks/:payerAccountId/clear` in `routes/discrepancies.ts` (9.2), both behind the session cookie and answering `401` without one, because an unauthenticated clear would be the security hole rather than the feature. Both call `clearPayerBlock` in `services/strikes.ts`, C9's write, which is where the watermark rule actually lives.

What C8 added next door is worth keeping distinct, because the two queries look alike and answer different questions: `inFlightPayment` asks whether this payer has a row in state `verified` newer than the window, which is a rate limit that expires by itself, whereas this section asks whether the payer has twice been served without settling, which is a judgement that ends by a seller's clear or by the window. The first is enforced at the insert as well as at the read (4.2 step 5); this one needs no insert-time twin, because Guard 3 already permits one in-flight payment per payer, so two strikes cannot be minted concurrently.

### 4.4 Paid but not delivered

If settlement succeeded but the response never reached the buyer, a retry with the same authorization hits the replay guard. Since C12 (GW-9) a settled answer up to 256 KB is kept in memory for five minutes keyed by `replay_key` and replayed on that retry with the same `PAYMENT-RESPONSE` receipt. Only the served path fills the cache, so an `abandoned` retry still re-serves through its payment (C7) and a `served_unsettled` row is never replayed. A miss — after five minutes, after a restart, or for a body over the limit — falls back to the `409` and receipt that described this limitation before C12, and the seller still sees a normal settled payment. Entries are bounded at 32 MiB total and 1,024 entries, evicting the oldest insertion; the receipt is rebuilt from the settled row rather than stored with the body, so the hash a replay names is the one the ledger holds.

C7 narrowed this in both directions, and the sentence above now describes one state rather than three. A retry against a `settled` row returns `409` with the header, which is the described behaviour. A retry against a `served_unsettled` row returns `409` and hands out no receipt, and that is deliberate: the money may already have moved, and a second delivery for one authorization is not on offer — the machine has no edge from `served_unsettled` back to `verified`, and the row is left for the reconcile path to settle, not re-served. (C10's sweep deliberately does not touch this state either: it exists only when a settle was submitted from a live process and came back failed, so there is nothing for a restart to reconstruct.) A retry against an `abandoned` row is now served: the row moves back to `verified` and this request gets its answer, because no abandonment path ever called `settle`, so the delegate's nonce is still unspent and the signature still buys what it was signed for. That is the case the previous paragraph called missing from the design; it is in the code now, and `gateway.test.ts` ("retries an abandoned payment with the same authorization, serves it and charges once") is the receipt for it.

Two things make the retry safe rather than merely convenient, and both are predicates rather than arguments. One authorization has one `replay_key` and the key is under a unique index, so reuse moves the row it already made and cannot produce a second one to settle. And the reuse write refuses any row carrying a `near_tx_hash` or a `settled_at`: no route branch can put either on an `abandoned` row today, but C10's sweep abandons stale rows *after* reading the chain, and a row whose money moved while the process was dead is exactly the row a retry must never serve. `services/payments.ts` therefore keeps `advancePayment` out of the move entirely — a generic advance into `verified` would put that guard behind a caller's good manners.

### 4.5 Payout lifecycle

**`direct` mode.** `payTo` is the seller's NEAR account. No swap. The ledger records `payment_in` and, in the same transaction, an immediate `payout_out` whose note says the x402 transfer itself paid the seller — a ledger showing money in without the matching out would read as an unpaid seller. `services/ledger.ts`'s `recordSettlement` is the one writer for both modes: `intents` books only the payment, and its `payout_out` arrives when the swap succeeds. The C10 boot sweep books the same pair when it recovers a direct settlement, and the reconcile rule `PAYMENT_NOT_SWEPT` skips `direct` payments, whose pay-to already was the seller. Shipped (D8). The seller account must be storage-registered for the payment token; this is checked when the endpoint is created (11.3).

**`intents` mode.** `payTo` is an Intents deposit address and the transfer is swapped to the seller's destination. **Spike S1 closed this branch on 2026-11-03 without measuring it, and the branch is weaker than the doc assumed: `@x402/near` 2.18.0's facilitator refuses a payment whose `payTo` is not already storage-registered for that token (`docs/spikes/S1.md`), nothing registers it for us, and whether Intents registers the addresses it hands out is not knowable from our side. Under A17's answer the payout leg runs on the mock provider, so this mode is the designed-but-unproven half of the product, and `direct` is the one the demo can show. Selecting between the two and deleting the loser is B8's job, not a quiet default:** Spike S2 selects exactly one of:

- **Standing address (preferred).** One long-lived `ANY_INPUT` style quote per seller and destination, accumulating many small payments. Matches micropayment economics (14.1) and avoids per-request provider calls.
- **Per-payment address.** A fresh quote per paid request. Easy one-to-one matching, but every swap pays minimums and fees and requires a quote deadline that outlives the buyer's retry window.

**The route half of both modes is shipped (D5), and it is written to be neutral about which of the two S2 picks.** `services/payout-routes.ts` is the only writer of `payout_routes`: a creation reads for a standing route per (seller, provider, chain, asset, address, refund, `mode_detail`), and only when there is none does it call `prepareRoute({ amount: null })` and store what came back. `payout_routes_destination_key` (migration `0006`) is the same rule as a partial unique index, `WHERE mode_detail <> 'per_payment'`, so the `per_payment` design stays un-deduped rather than being silently forbidden — B8's choice survives both answers. `mode_detail` is part of the key, not just of the lookup, because a `direct` route's deposit address is null by definition and a mode-blind read would advertise it as an address. A route is resolved *before* the endpoint insert, so it outlives the creation that wrote it and the next one reuses the quote instead of paying for it twice (red-team B12). Migration `0007` puts a `BEFORE UPDATE` trigger on the table: a destination change inserts a new route and moves `endpoints.route_id`, while `payments.route_id` — snapshotted at verify time — keeps reading the payout the payment actually had (red-team B9, PO-7). `DELETE` is not refused, because a route no payment points at holds no history and a referenced one is already held by `payments_route_id_fkey`. What this does *not* prove: the address behind every test above was minted by the mock (`mock-deposit-<n>`, shaped like a NEAR account id so it survives the same advertisement checks a real one does, and resolving nowhere), because D3, A11/S3 and the spend itself are open (A17, DQ-2).

**The status half is shipped (D6), and it is the only thing that makes an `intents` payout an event rather than a hope.** `jobs/poll-payouts.ts` runs in this process on `POLL_INTERVAL_SECONDS` (default 20, with the retry ceiling in `POLL_MAX_BACKOFF_SECONDS`), and one pass is one transaction: it claims due swaps with `FOR UPDATE OF swaps SKIP LOCKED` where `terminal_at is null` and that row's own `next_poll_at` has passed, asks the provider once for exactly those refs while still holding them, then decides per row. The claims PO-4 makes about this loop are load-bearing in three different places: `SKIP LOCKED` keeps two passes running at the same moment off the same rows, the committed `next_poll_at` keeps a later pass from re-asking about rows an earlier one already answered (which is why the gap is per ref, as spike S5 asked), and one boolean in `jobs/loop.ts` drops a tick that outlived its interval instead of queueing a backlog of them. A terminal state is sticky — a report that contradicts one is logged and dropped, and the only column it touches is the `terminal_at` a pre-migration row is missing, which it converges so the row stops being polled forever rather than being polled with an answer it will never use. A non-terminal backwards move is judged by `canTransitionSwap` rather than by a special case, so there is one definition of "disagree". An answer is checked at the boundary before it can reach a row: `null` means "not reported yet" and is storable, a value that is not an integer of base units is refused with the row's story untouched, and a `null` hash never erases the one a link was built from. The *transition into* terminal is what books the ledger, inside the same transaction as the state write — `payout_out` in the route's `destination_asset`, `refund_in` in the linked payment's `asset_contract`, `failed` nothing — so LR-1's "one entry per event" reads as one line for a payout that reports itself finished five times, which is D6's answer to the question E1 left open; and a refund with no link books nothing rather than guessing an asset, because a wrong asset on that line is what would make `PAYOUT_REFUNDED` unfixable. What it does not prove is in `ROADMAP.md` section 7: **no production path creates a `swaps` row**, so a deployed loop polls an empty queue until S2/B8 ship that creator. PO-4's real-provider half is D3's client and `map-status.ts`, which now exist and are tested offline (section 5): `PAYOUT_PROVIDER=oneclick` polls and reads assets for real and cannot mint a deposit address, because the quote's `originAsset`, `depositType` and `slippageTolerance` are still undecided — so the unproven half is the *queue's contents*, not the reader of them.

**Changing those terms is a new route and a new advertisement, never a new history (D9, PO-7).** `updateEndpoint` in `services/endpoints.ts` reads the seller's own row, merges the body onto the destination its route holds — an endpoint has no destination columns of its own — and runs the merged terms through the *same* `checkEndpointCreation` a create uses, so the two paths cannot drift apart. The write happens only if every check passes on the new terms. A refused edit writes nothing at all — no endpoint update, no warning row, no route rewrite — and answers with the reasons in its response, because unlike a create it has a live paywall behind it and de-activating an endpoint that was earning over a mistyped address would cost the seller money already arriving. Two rules follow from that. `active` keeps the row's value unless the body names it, so repairing a paused endpoint's price does not open the paywall and an endpoint D4 left inactive stays inactive until the seller says so. And a provider is asked about a new destination only when nothing else failed, so a change that was going to be refused for an unrelated reason costs no quote and leaves no orphan row in a table that cannot be cleaned up (B12). Because `payments` copied `amount`, `asset_contract` and `route_id` from the advertisement at verify time, and this path issues no `UPDATE payments`, an earlier payment keeps its price and its payout while the next `PAYMENT-REQUIRED` names the new ones; C2's fingerprint already covers price and `routeDepositAddress`, so the changed advertisement re-derives by itself. What is *not* editable, and refused by name rather than dropped: `network` and `assetContract` (what a payer's signed delegate is denominated in — a live slug may not revise the token its own history was paid in), `id`, `slug`, `sellerId` (ownership) and `routeId` (which would bypass the whole rule). Shipped offline on the mock. **The seller's half shipped too (F9):** `apps/web/lib/endpoint-edit.ts` holds the rules with no React in them — `buildEditBody` diffs the form against the endpoint it was given, so a save cannot restate a field nobody touched, and it refuses a new `destinationAddress` unless the seller confirmed one, in which case the body carries `confirmedAddress` equal to it — and `livenessBody` is the entire body of the pause button, `{ active }` and nothing else. The card prints `endpoint.route.destinationAddress`, which is where PO-2's echo comes from: `endpointDtoSchema.route` is required-and-nullable and `listEndpoints` takes it in the same `leftJoin`, so the address the seller confirms is the address the row holds rather than a value the form remembered. `apps/web` has no DOM framework, so `EndpointEditor` is a `…View` that renders plus a container that holds `pendingAddress: string | null` and rebuilds the body when the seller presses confirm: a request assembled before the confirmation cannot be sent, because there is no request stored to send.

## 5. Payout provider interface

```ts
export interface PayoutProvider {
  prepareRoute(input: PrepareRouteInput): Promise<PreparedRoute>;
  getStatus(input: StatusInput): Promise<NormalizedSwap[]>;
  listAssets(): Promise<SupportedAsset[]>;
}

export type NormalizedSwapState =
  | "pending" | "processing" | "succeeded"
  | "refunded" | "failed" | "incomplete";
```

Rules:

- `NormalizedSwap` carries `originTxHash` when the provider supplies it. Matching depends on it (D13, S2).
- Terminal states are sticky. A later status that appears to move a swap out of a terminal state is logged and ignored.
- Terminal means exactly `succeeded`, `refunded` and `failed` (D1, closing S5's first consequence). `incomplete` is not one: the provider does not declare `INCOMPLETE_DEPOSIT` terminal and it is the one status where money arrives short, so an incomplete swap stays visible to `PAYOUT_STUCK` instead of being filed as finished. There is one list, `TERMINAL_SWAP_STATES` in `@till/core`, and `payouts/provider.ts` re-exports it rather than keeping its own copy.
- Unknown provider statuses map to `processing` and trigger a `PAYOUT_STUCK` check after the stuck window.
- **The 1Click client exists and is deliberately half-live (D3, 2026-11-10).** `payouts/oneclick/client.ts` implements `getStatus` and `listAssets` against a zod subset of the recorded OpenAPI document — every schema `.passthrough()`, so the whole body still reaches `swaps.raw` and a mapping bug stays diagnosable — and `payouts/oneclick/map-status.ts` is the explicit switch over the seven `SCREAMING_SNAKE_CASE` values that S5 asked for, never `normalizeSwapState` on a lowercased guess: `KNOWN_DEPOSIT_TX` is `processing` so a deposit seen on origin cannot move a swap backwards, and `INCOMPLETE_DEPOSIT` is `incomplete`, which D1 keeps out of the terminal list so the short-payout case stays visible. `createProvider` (`payouts/index.ts`) builds it for `PAYOUT_PROVIDER=oneclick` instead of throwing. **What it refuses is the live-money boundary:** `prepareRoute` throws `OneClickError(reason: "config")` because `QuoteRequest` requires `originAsset`, `depositType` and `slippageTolerance` and Till decides none of them (S2/B8), so no deposit address can be minted and no mainnet movement is reachable from a checkout. `getStatus` makes one `GET /v0/status` per reference, spaced by `ONECLICK_MIN_CALL_GAP_MS` (5000, the only spacing the provider publishes and the reason S5 left it unverified) and bounded per pass by `ONECLICK_STATUS_CALLS_PER_PASS` (4), published as `PayoutProvider.statusCallsPerPass` so `poll-payouts.ts` claims `min(batchSize, statusCallsPerPass)` and never locks a row it will not ask about. A non-2xx, an unparseable body or an unreadable reference omits that one swap and logs it, which the poller already treats as an unanswered ref (D10 backs off, nothing is guessed); a call that cannot be made at all throws, which is the outage path. `ONECLICK_JWT` travels as `Authorization: Bearer` and appears in no log field and no error message. The mock is still the only provider any demo, test or CI run uses, and `swaps.raw`'s `simulated: true` marker is unchanged. `MockProvider` supports scripted outcomes (`succeed`, `refund`, `fail`, `stall`).
- The provider's own clock is persisted (S5, consequence 2). `NormalizedSwap.providerUpdatedAt` comes from the status payload's `updatedAt` — "last time the state was updated", which is time-in-state — into `swaps.provider_updated_at`, and `packages/core/src/reconcile/payout-stuck.ts` ages a non-terminal swap on `providerUpdatedAt ?? lastPolledAt`. That preference is what makes `PAYOUT_STUCK` reachable at all: `last_polled_at` moves every pass, so a provider that keeps answering `PENDING_DEPOSIT` about money that has not moved in a day used to look freshly polled and never looked stuck. A report that stops carrying a clock leaves the last known value in place rather than resetting the age, and the mock reports none, so every existing window behaves as before.
- The mock's script is an argument, never an environment default (D2, DQ-2). It refuses a route it has no script for and a status request for a reference it never issued, instead of filling either in with `succeeded`, and every payload it hands back carries `simulated: true` so a mocked row stays marked in `swaps.raw`. `payouts/mock/scenarios.ts` drives one outcome as far as the reconciliation rules, on a clock the caller supplies, which is what makes `pnpm simulate` reproducible offline.
- Selected by `PAYOUT_PROVIDER=oneclick|mock`. Default in `.env.example` is `mock`.

## 6. Data model

Amounts are `numeric(78,0)` base units. Ids are UUID v7, minted in the app by `newId()` from `@till/core` and supplied by each table's column default, so the leading 48 bits are the creation millisecond and an id sorts with its row's insertion. Within one process that ordering is exact — the 12 bits beneath the timestamp are a counter, not noise — and across processes it is only approximate, because they share neither counter nor clock. An id is therefore an index-locality hint and a tiebreaker, never a timestamp: ordering of record is `created_at`, and time comparisons use database time. Every table has `created_at timestamptz default now()`.

Where the sign of an amount is not information it is enforced twice, and the database is the inner layer. The JSON boundary refuses a non-positive endpoint price, payment amount and 402 amount (`positiveBaseUnitAmountSchema`, G6 F1), and A19 makes the same arithmetic true of the columns: `endpoints.price_amount >= 0`, `payments.amount >= 0`, a ledger entry non-negative unless its kind is `adjustment`, and `swaps.refunded_amount` never above `amount_in` when both are present. The JSON boundary stays stricter than the columns on purpose — "positive" is policy (a payable request) while "non-negative" is arithmetic — so a write path that skips the schema still cannot store a negative sum. A ledger `adjustment` and a swap amount read back from the provider stay signed, because there a negative is either the correction itself or the fact the reconciler is supposed to raise a finding about.

```
sellers
  id                uuid pk
  near_account_id   text unique not null
  display_name      text

endpoints
  id                uuid pk
  seller_id         uuid fk sellers
  slug              text unique not null      -- random suffix, not enumerable
  upstream_url      text not null             -- https only outside local dev
  price_amount      numeric(78,0) not null    -- >= MIN_PRICE_BASE_UNITS, and CHECK >= 0
  asset_contract    text not null             -- NEP-141 contract id
  network           text not null
  description       text
  payout_mode       text not null             -- 'direct' | 'intents'
  route_id          uuid fk payout_routes null
  active            boolean not null default true
  creation_warnings jsonb not null default '[]'  -- D4: why creation left the endpoint inactive (11.3)

payout_routes   -- immutable; a change creates a new row
  id                  uuid pk
  seller_id           uuid fk sellers
  destination_chain   text not null           -- lowercased before it is keyed
  destination_asset   text not null           -- stablecoin, 6 decimals (D11)
  destination_address text not null           -- format-validated per chain
  refund_address      text not null
  provider            text not null
  deposit_address     text                    -- null for 'direct': pay-to is the seller
  deposit_memo        text
  quote_ref           text
  deadline_at         timestamptz
  mode_detail         text not null           -- 'standing' | 'per_payment' (one survives S2)
  -- D5: unique (seller, provider, chain, asset, address, refund, mode_detail)
  --   where mode_detail <> 'per_payment' (0006), and a BEFORE UPDATE trigger
  --   that raises (0007). Only services/payout-routes.ts inserts.

payments
  id                  uuid pk
  endpoint_id         uuid fk endpoints
  route_id            uuid fk payout_routes null   -- snapshot at verify time
  payer_account_id    text not null
  amount              numeric(78,0) not null       -- snapshot of price; CHECK >= 0
  asset_contract      text not null
  replay_key          text unique not null
  state               text not null   -- verified | abandoned | settled | served_unsettled
  delegate_expires_at timestamptz
  near_tx_hash        text
  upstream_status     int
  upstream_ms         int
  verified_at         timestamptz
  settled_at          timestamptz

payer_clears   -- a seller's clear of a blocked payer, appended, never updated
  id                  uuid pk
  payer_account_id    text not null
  seller_id           uuid fk sellers not null    -- the block is per payer per seller
  cleared_by          text not null               -- the session account that cleared
  note                text
  -- 4.3: the newest row for this pair is a watermark; strikes before it stop counting

swaps
  id                  uuid pk
  route_id            uuid fk payout_routes
  payment_id          uuid fk payments null    -- set when matched by tx hash
  provider_ref        text not null
  state               text not null            -- NormalizedSwapState
  amount_in           numeric(78,0)
  amount_out          numeric(78,0)
  min_amount_out      numeric(78,0)            -- only present for per-payment quotes
  origin_tx_hash      text                     -- match key against payments.near_tx_hash
  destination_tx_hash text
  refunded_amount     numeric(78,0)            -- CHECK null or <= amount_in
  last_polled_at      timestamptz
  terminal_at         timestamptz
  poll_attempts       int not null default 0  -- D6's retry count, reset by an answer
  next_poll_at        timestamptz             -- D10: when this row may be asked again
  raw                 jsonb not null

ledger_entries   -- append only, enforced by trigger
  id                  uuid pk
  seller_id           uuid fk sellers
  kind                text not null   -- payment_in | payout_out | refund_in | adjustment
  amount              numeric(78,0) not null   -- CHECK: inflows >= 0; adjustment signed
  asset               text not null
  payment_id          uuid fk payments null
  swap_id             uuid fk swaps null
  note                text

discrepancies
  id                  uuid pk
  seller_id           uuid fk sellers
  code                text not null
  severity            text not null
  payment_id          uuid fk payments null
  swap_id             uuid fk swaps null
  dedupe_key          text not null       -- code plus subject ids, see below
  explanation         text not null
  suggested_action    text not null
  details             jsonb
  opened_at           timestamptz
  resolved_at         timestamptz
  resolution          text                -- auto | manual

  -- one OPEN discrepancy per cause PER SELLER; a resolved one may reopen later.
  -- The seller is part of the key because a cause with no payment or swap id has
  -- the same dedupe_key for every seller (E8).
  create unique index discrepancies_open_dedupe
    on discrepancies (seller_id, dedupe_key) where resolved_at is null;

response_cache   -- dead schema. It is created by migration
                 -- `0000_luxuriant_greymalkin.sql`, and outside that migration and the
                 -- generated `migrations/meta/` snapshots the name appears in exactly
                 -- one place: its own `pgTable` declaration in `db/schema.ts`. No code
                 -- reads or writes a row. C12's shipped replay cache is in memory
                 -- (4.4, `gateway/response-cache.ts`)
  replay_key          text pk
  status              int not null
  headers             jsonb not null
  body                bytea not null      -- <= 256 KB
  expires_at          timestamptz not null
```

### 6.1 Ledger rules

- A trigger raises on any `UPDATE` or `DELETE` of `ledger_entries`. Corrections are `adjustment` rows.
- Entries are per asset. There is no cross-asset balance. "In transit" for a seller is settled payments minus swaps in a terminal state, computed by query.
- A settled payment writes one `payment_in`. A swap reaching `succeeded` writes one `payout_out`. Reaching `refunded` writes one `refund_in`.
- Only `services/ledger.ts` inserts into the table, and each of its writers decides its own kind: they take the entry without a `kind` field, so a call cannot ask for a payout and get a refund (E1). Enforcement of the single door is the `pnpm boundaries` grep, which was watched rejecting a planted second writer. The same trigger that makes the ledger auditable also binds the tests: a suite that books rows cannot delete them, so a database-backed ledger test mints its own ids and counts only those.

## 7. Reconciliation engine

Runs every 60 seconds per seller and after any swap status change, inside the API process. Both halves are `apps/api/src/jobs/reconcile.ts` (E9), and the two calls that wire them are in `apps/api/src/jobs/ticks.ts`: `reconcileTick` over every seller on `RECONCILE_INTERVAL_SECONDS`, and the same function with `sellerIds` set to the sellers D6's poll tick reported it moved. No worker, no queue (hard rule 10) — "after a status change" is inside the poll tick, and `startLoop`'s overlap skip is what keeps a slow provider from stacking the two passes on one another. `server.ts` keeps only the two `startLoop` calls, because a file that reads the environment and binds a port cannot be imported by a test.

- **Pure core.** Rules are pure functions in `packages/core`: `(snapshot) => Finding[]`. No I/O. The job is the seam: it reads rows, calls `runAllRules`, and hands the findings to `services/discrepancies.ts`. No rule logic in the job and no I/O in a rule.
- **One claim per seller.** A pass takes its seller's own row with `FOR UPDATE OF sellers SKIP LOCKED` and holds it across the write, which is why `writeFindings` runs inside the same transaction — a claim released before the write is a claim that proved nothing. A seller another pass holds is `skipped`, not queued, and counted in the result so `skipped` can be told apart from `findings: 0`. The partial unique index on `(seller_id, dedupe_key) where resolved_at is null` stays as the second defence: it stops a duplicate row, it does not stop two passes deciding to close each other's work.
- **One clock per pass.** `now()` is read in the same statement as the claim, so inside one transaction it is that transaction's start instant and no two rules age a row against different times. (Read as `extract(epoch …)::float8`: a raw `now()` in a select list arrives from the driver as a *string*, because the timestamp parser only ever sees a column's own type.)
- **A partial pass opens and never closes.** Auto-resolution reads the findings list as exhaustive, so the two ways it can fail to be one — more rows than `DEFAULT_SNAPSHOT_MAX_ROWS` (read newest-first, so a capped pass sees live money rather than history), and rows this build cannot interpret (a payment state outside the state machine, an amount that is not an integer of base units, a payment with no `verified_at`) — set `partial`, which turns auto-close off for that seller and logs `reconcile_snapshot_partial` with the counts. Refusing the seller instead would make one unreadable row an outage for its whole reconciliation; closing on a partial list would silently shut a live finding.
- **Payout mode from the payment's own route.** `PaymentRow.payoutMode` is read off `payout_routes.mode_detail` for the route the payment carries, and `endpoints.payout_mode` — a live, D9-editable field — is used only when `payments.route_id is null`, which logs `reconcile_route_snapshot_missing`. Reading the endpoint for every payment would let one edit silence `PAYMENT_NOT_SWEPT` on money already taken: PO-7's drift, arriving in the reader.
- **Bookedness travels with the payment.** `ReconcileSnapshot.bookedPaymentIds` is the ids of the payments whose settlement line reached `ledger_entries`, and `PAYMENT_UNBOOKED` (G6·2) is the rule that reads it: a `settled` payment with no `payment_in` line older than `SWEEP_WINDOW_SECONDS` is the shape `gateway/route.ts` leaves behind when `recordSettlement` throws after `advancePayment` committed (the `ledger_write_failed` log). The read is an `exists()` column on the payments select rather than a second query — a separate capped read keeps a *different* `maxRows` than the payments read does, and the first test of it printed a false `PAYMENT_UNBOOKED` for the newest payment. `ledger_payment_idx` (`(payment_id, kind)`, migration 0010) is what stops that semi-join from scanning the ledger once per payment. The rule is why `SETTLEMENT_LEDGER_KIND` is exported from `services/ledger.ts`: the reader and the writer must name the same kind, and a string copied into both drifts.
- **One join, by hash.** `services/swaps.ts`'s `linkSwapByHash(db, swapId)` is D13's implementation and the only writer of `swaps.payment_id` (E2). It reads the hash off the swap's own row — the signature takes a swap id and no amount, no hash and no window, so a heuristic is not available to a caller — and searches `payments.near_tx_hash` scoped to the swap's seller, deliberately not to its route and not to any payment state: PO-7 keeps an old payment on the route it was opened under, and whether money is joined cannot depend on which side settled first. What it cannot decide it reports instead of guessing: `no_origin_hash` (null, empty or blank), `no_candidate`, and `ambiguous` with **both** payment ids, because `origin_tx_hash` is not unique and choosing one would hide the other. The write is a compare-and-set on `payment_id is null`, so a second loop that races it reports the link that won rather than writing its own. D6's poll loop is its first production caller: it links every swap it claimed, on every provider answer and not only a terminal one (the deposit hash can arrive on a `processing` report), from inside the same transaction that wrote the state, so a link and the status it was derived from commit together. E9 is the reader: the snapshot hands the rules both `swaps.payment_id` (which is what `PAYOUT_SHORTFALL` names a payment with) and `swaps.origin_tx_hash` (which is what `PAYMENT_NOT_SWEPT` decides against), so the join has a writer *and* a reader and neither is a heuristic.
- **Idempotent.** `dedupe_key` plus the per-seller partial unique index prevents duplicate open discrepancies, including those with a null payment or swap id (a plain unique constraint would treat nulls as distinct and fail to deduplicate; see 14.1). The seller is in the index because the key cannot carry it for every rule: a null-subject cause is otherwise the same row for every seller. An open row a later pass sees again is left alone, so `opened_at` stays the first observation — E9's acceptance test runs the same snapshot three times and asserts the row does not move.
- **Auto-resolution.** When the cause clears, the discrepancy closes with `resolution = auto`.
- **Config windows.** Sweep delay and stuck threshold come from environment: `SWEEP_WINDOW_SECONDS`, `STUCK_WINDOW_SECONDS`, `SHORTFALL_TOLERANCE_BPS`, each passed into the snapshot as `ReconcileConfig` rather than read inside a rule.
- **Shortfall.** With stablecoin payouts only (D11), shortfall is `amount_out < amount_in * (1 - SHORTFALL_TOLERANCE_BPS / 10000)`. No oracle needed.

Rule priority:

| Tier | Codes |
|---|---|
| P0 | `SERVED_NOT_SETTLED`, `PAYOUT_REFUNDED`, `PAYOUT_FAILED`, `PAYOUT_STUCK`, `PAYMENT_NOT_SWEPT`, `PAYMENT_UNBOOKED` |
| P1 | `PAYOUT_SHORTFALL`, `INCOMPLETE_DEPOSIT`, `ORPHAN_DEPOSIT` |

The P1 codes depend on how deposits to a standing address are reported, which is unknown until S2.

## 8. Security design

### 8.1 Relayer key

Full-access key required by the underlying package. Mitigations:

- Dedicated relayer account holding a small balance.
- Key only in server environment; never logged; never in the web app.
- A global sponsored-gas budget and a process-wide request limiter, both in memory and reset on restart (C13, GW-10); the one-in-flight rule (D14) also bounds a payer's burn rate.
- Dashboard header shows relayer balance and warns below a threshold. **Shipped (F5, UI-5):** `GET /api/status` reads the relayer account's own `view_account` and the header compares it with `RELAYER_BALANCE_ALERT_BASE_UNITS` — and a chain that does not answer is reported as `unknown`, never as a balance of zero, which 11.2 explains.

### 8.2 Seller authentication

Shipped as F1, in `apps/api/src/routes/auth.ts` over the NEP-413 engine in `packages/core/src/auth/nep413.ts`:

- `POST /auth/nonce` mints 32 random bytes, answers `{ message, recipient, nonce, callbackUrl }` — `recipient` being the origin of `GATEWAY_PUBLIC_URL`, so a signature is bound to this deployment — and keeps a signed copy of the same four fields in `till_sign_in` for five minutes.
- The wallet signs `sha256(borsh(u32(2**31+413) ++ message ++ nonce ++ recipient ++ callbackUrl))` with an **ed25519 full-access key** and sends the signature base64, which is what the spec's output interface says and the one form Till accepts.
- `POST /auth/verify` then compares the body with that cookie — message, recipient, nonce (constant-time) and callback — verifies the signature, and only after both reads the chain's `view_access_key_list` for the claimed account and requires the signing key to appear there as `FullAccess`. That order is the rate limit: nothing before the chain read costs more than a hash and a signature check.
- Success creates or finds the seller row by account name and sets `till_session` for twelve hours; the challenge cookie is deleted on the way out.

Both cookies are `HttpOnly`, `SameSite=Strict`, `Path=/api`, and `Secure` whenever `NODE_ENV=production`. Strict rather than the Lax this section used to say: `/api` is only ever reached by the dashboard's own same-origin `fetch`, so Lax bought nothing here, and `Path=/api` also keeps the session out of the gateway's `/r/:slug` surface entirely (G6 F2's class of problem, removed rather than filtered). They are signed by two keys HKDF-derived from `SESSION_SECRET` per purpose, so a session token is not a valid sign-in challenge — and a `purpose` claim and the claim shapes are two further independent layers over the same confusion.

Refusals are named, because "who do you claim to be" failing has four different causes a seller can act on: `invalid_json` and `invalid_request` (400), `sign_in_challenge`, `key_type_unsupported`, `signature_invalid`, `account_not_found`, `key_not_found` (401), `access_keys_unavailable` (503 — an RPC that timed out is never reported as an ownership failure). A refusal logs the code and the account only: never the signature, the public key or a cookie.

Two limits are stated rather than engineered away. There is no session table, so a logout is a cookie delete and a captured challenge cookie stays replayable for the rest of its five minutes; and `key_not_found` deliberately does not distinguish "that key is not on the account" from "it is there as a function-call key", which is not information to hand out. The browser half — a wallet prompt that produces the signature — is F8; measuring this against real testnet access keys is A10's.

### 8.3 Replay protection

`replay_key` is sha256 of the signed delegate action, under a unique index: **this exact authorization, once**. It deliberately does not include the endpoint, because a NEP-366 delegate binds payer, relayer, nonce and the `ft_transfer` arguments (recipient, asset, amount) and nothing else — so one payment is one payment no matter which of the seller's endpoints presents it, and a key that varied per endpoint would book one real on-chain transfer as two ledger rows. Two consequences, both measured (S6): two requests for the *same* endpoint in the same block mint byte-identical delegates and therefore share one key, which is what makes "one in flight per payer per price" a property of the ledger rather than of new code; and a delegate replayed against a *different* endpoint of the same price also hits the same key, so a replay of a spent key is answered the way step 6 of 4.2 says — `409` with the stored receipt and no second answer — and never by serving. Abandoned payments may be retried with the same authorization (4.2 step 6, C7): the retry finds the existing row and moves it forward, it does not insert a second payment. Two conditions ride on that move, both written into the `UPDATE` rather than remembered by the caller: the row must belong to the endpoint that opened it (so endpoint B cannot take over A's abandoned row and serve its own upstream under it), and the row must carry neither `near_tx_hash` nor `settled_at` (so a row that shows money moved is never reopened for a second settlement). `settled` has no edge back at all, and `served_unsettled` has none to `verified`, which is 4.4's second delivery argument in the table rather than in prose.

### 8.4 Proxy safety (SSRF)

- Resolve the hostname, reject private, loopback and link-local results, then connect to the resolved address directly so a second DNS lookup cannot change it (DNS rebinding).
- Judge every record the resolver returns, not just the first: one internal or unparsable record condemns the whole name, because filtering them and dialling a "good" one is the rebinding shape. A record that is not an IP literal is refused — the range check cannot parse other text, and an unparsable answer would otherwise be accepted and dialled (G4).
- Do not follow redirects.
- Reject upstream URLs that point at the gateway itself. The origin strings are compared first, and the target's resolved address is then compared with the gateway's own resolved address at the same scheme and port, so a URL naming the gateway's public IP — or an alias of it — is refused too (C17). Addresses are compared by value, so `::1` and `0:0:0:0:0:0:0:1` are the same host. If the gateway's own name cannot be resolved (split-horizon or public-only DNS), the string comparison is still applied rather than refusing every upstream.
- `https` only outside local development.
- Timeout and maximum response size.
- Strip hop-by-hop and payment headers from the request before forwarding, and filter the seller's response on the way back (G6 F2). The buyer's browser sits on the gateway origin, which is also where the dashboard session lives, so `set-cookie` from any paywalled origin is a cookie written into it, `www-authenticate` makes the browser prompt for credentials against the gateway, and a forged `payment-signature` or `x-402-*` header is a false claim of settlement. Framing belongs to one connection, so the upstream `content-length` is dropped and Till's own server frames the bytes it holds. `location` still travels, because no redirect is followed and the buyer needs it.

### 8.5 Config

All secrets from environment, validated by Zod at boot. The process refuses to start on missing or malformed values, and the refusal names the keys and never the values, because the same object holds `RELAYER_SECRET_KEY` and `ONECLICK_JWT` — which means a numeric field has to add a Zod issue rather than throw from a transform, since a thrown error loses the path (G6). Values that are floors are positive: `MIN_PRICE_BASE_UNITS` and `MAX_SPONSORED_GAS` reject a minus and a zero (a negative floor passes everything), and `SHORTFALL_TOLERANCE_BPS` is confined to `[0, 10000)`, because 0 is the strictest tolerance and 10000 tolerates the whole payment, which would leave `payout-shortfall` never firing while looking configured (G6 F1, F4).

## 9. Interfaces

### 9.1 Public gateway

| Method and path | Purpose |
|---|---|
| `GET /r/:slug` | Paywalled resource; 402 or upstream response |
| `GET /healthz` | Liveness |

What `GET /r/:slug` answers, since the status is the payer's whole interface (4.2):

- **200** the seller's body, with the settlement hash in a base64 `PAYMENT-RESPONSE` header.
- **3xx** the seller's own redirect, forwarded with a `Location` made absolute against their upstream URL and no receipt: nothing was delivered, so nothing was settled. Till does not follow it.
- **402** no payment header, a header this process cannot decode, or a payment the scheme refused. All three are challenges; the refused ones carry `error` and are otherwise byte-identical to the advertisement.
- **403** the payer is blocked at this seller: two `served_unsettled` payments inside 24 hours and no clear since (4.3). The payment verified, so a fresh challenge would be dishonest; the body says `payer_blocked` and there is no `Retry-After`, because the exit is the seller's clear rather than a clock.
- **404** unknown slug, or an endpoint whose `active` is false — read from the row rather than from a `where` clause, so the two are not distinguishable to a stranger.
- **405** any method other than `GET` on `/r/:slug`, with `Allow: GET` and no `PAYMENT-REQUIRED` header, answered before the endpoint row is read, before the limiter, before `verify` and before any settle (GW-2, C20). A method this product does not serve is a method nobody can pay for, so it gets no price. `HEAD` needs its own half of the guard inside the GET handler, because Hono dispatches it there and empties the answer afterwards.
- **409** this authorization already produced a payment row **that will not be served again**: `settled`, `served_unsettled`, or an `abandoned` row that carries a settlement hash or a `settled_at` (8.3, 4.4). The stored hash travels in the receipt header only when that row is `settled`. An ordinary `abandoned` row is not here since C7 — it is retried, served if the seller answers, and lands on `200`/`502`/`4xx` like any first attempt.
- **429** not yet, or not on this process's budget. Four producers, and they do not all carry `Retry-After`: the fixed-window request limiter (`gateway/route.ts`, code `rate_limited`, `Retry-After` the window left); Guard 3's in-flight read (`gateway/guards.ts`, code `payer_in_flight`, `Retry-After` the in-flight window `UPSTREAM_TIMEOUT_MS` + the settlement margin); `openPayment`'s claim when two authorizations arrive together (route code `payer_in_flight`, the same `Retry-After`); and the sponsored-gas budget (code `sponsored_gas_exhausted`), checked before the row is inserted and reserved again immediately before `settle`, with **no** `Retry-After` because the budget is a process lifetime, not a window, and only resets on restart. A payer cannot tell the first three apart, which is intended. A replayed authorization whose row is still `verified` lands here rather than on the `409`, because there is nothing to replay yet.
- **502** the upstream failed or answered 5xx; the payment is abandoned and never charged.
- **503** Till could not decide — an endpoint it cannot advertise, a payout mode this build does not run, or a facilitator that could not run. A 503 challenges nobody.

Stripping is by name list, in `gateway/proxy.ts`: hop-by-hop headers (RFC 9110 7.6.1), anything starting `proxy-`, and payment material — `payment-signature`, `x-402*`, `x-payment*` — never travel to the seller. A seller's answer loses those too, plus `set-cookie`, `www-authenticate` and a upstream `content-length`, because the buyer's browser is on the gateway origin and a paywalled seller must not be able to write a cookie into the host that carries the dashboard session (G6 F2). `authorization` is *not* in the list: a buyer sending a bearer token to a paywalled resource is a seller's concern, not a payment path, and if that ever reads wrong the change belongs here rather than in the route.

### 9.2 Dashboard API

| Method and path | Purpose |
|---|---|
| `POST /auth/nonce`, `POST /auth/verify` | Wallet sign-in (F1, 8.2). The only routes under `/api` that answer without a session — they are what issues one. Refusals are named: `invalid_json`, `invalid_request` (400); `sign_in_challenge`, `key_type_unsupported`, `signature_invalid`, `account_not_found`, `key_not_found` (401); `sign_in_throttled` (429, with `Retry-After`); `access_keys_unavailable` (503). A challenge is redeemed once: the nonce the signature covers is recorded for the cookie's own five minutes (`lib/sign-in-guard.ts`), so a captured challenge cookie plus its signature is not a second session |
| `GET /endpoints`, `POST /endpoints`, `PATCH /endpoints/:id` | Manage endpoints (session required); price changes apply to new payments only |
| `GET /payments` | Paginated, joined with swap state |
| `GET /swaps` | The seller's payout leg, newest first (UI-3, `routes/swaps.ts`, `db/queries/swaps.ts`): `swaps.routeId -> payout_routes.sellerId` is the scope, and the body is `SwapDto[]` — state, base-unit amounts, both hashes, poll and terminal times. An inner join, so a swap no route can attribute is shown to nobody. Read-only like `GET /payments` |
| `GET /discrepancies`, `POST /discrepancies/:id/resolve` | List and manual resolution (F4, `routes/discrepancies.ts`) |
| `GET /payer-blocks`, `POST /payer-blocks/:payerAccountId/clear` | The payers this seller is holding, listed by the same predicate the gateway enforces, and the clear that appends a `payer_clears` row with `clearedBy` taken from the session rather than the body (F4, `routes/discrepancies.ts`; the write is C9's `clearPayerBlock`). An account id that does not parse, or a body beyond a 200-character note, is `422` |
| `GET /status` | The dashboard header's two facts (UI-5, F5): the relayer account's chain balance and the newest provider answer among this seller's swaps, each with the threshold it is judged against. Half the contract is that an unread value has no number to carry — see 11.2 |
| `GET /ledger.csv` (also `/api/ledger.csv`, `/api/export/ledger.csv`) | Decimal-unit CSV of the session seller's ledger (LR-7). Amounts go through `formatAmount`, and every field is spreadsheet-injection escaped (`routes/export.ts`) |
| `GET /assets` | Supported payout assets. **Not mounted, and there is no stub file for it**: `routes/` has no assets route, and the provider method it would answer from (`listAssets` in `payouts/provider.ts`) exists with only the mock implementing it |

Three hardening rules sit above every dashboard route in `app.ts` (G7): a 64 KB body ceiling on `/api/*` answered `413 payload_too_large` before a handler parses it, an `Origin` check on every mutating `/api` request answered `403 origin_refused`, and `secureHeaders` (nosniff, `X-Frame-Options: SAMEORIGIN`, no `X-Powered-By`; no CSP, because this process serves JSON and CSV). Production also refuses a non-https `NEAR_RPC_URL`, `ONECLICK_BASE_URL` or `GATEWAY_PUBLIC_URL` at boot (`env.ts`).

`app.ts` answers 9.1's liveness probe on **both** `/healthz` and `/api/healthz` from one handler (`app.on("get", ["/healthz", "/api/healthz"], …)`): the container healthcheck in `docker-compose.yml` and the CI probe use the first, and the browser only ever speaks `/api/*` (A5).

Schemas live once in `packages/core` and are imported by both apps.

## 10. Failure behavior

| Failure | Behavior |
|---|---|
| Upstream non-2xx or timeout | No settlement; payment `abandoned`; the seller's 4xx and 3xx are forwarded (a 3xx's relative `Location` made absolute) and a 5xx or a timeout is `502`. **The retry is built (C7):** the same authorization presented again moves that `abandoned` row back to `verified`, serves once, and settles on a 2xx like any first attempt. What it will not do is reopen a row that carries a hash or a `settled_at`, which is the shape C10's sweep can leave behind (4.4, 8.3) |
| Settlement fails after 2xx | Response returned; `served_unsettled`; the strike is counted, so two in 24 hours block the payer at that seller (C9); the `SERVED_NOT_SETTLED` discrepancy is logged and not yet inserted (E2) |
| Delegate expires too soon | Rejected before the upstream call |
| Payer balance too low | Rejected before the upstream call |
| Second concurrent request from a payer | 429 with `Retry-After` |
| Provider API down | Payments continue; polling backs off (D6, D10); dashboard shows provider degraded — **shipped (F5)** as the header's poll line going `warn` past five intervals without an answer, and `never_polled` saying so when nothing ever has |
| Database down | 503 before verifying anything |
| Relayer out of gas | 503 with a reason; dashboard alert — **shipped (F5)** as the header's balance line, `warn` under `RELAYER_BALANCE_ALERT_BASE_UNITS` and `unknown` when the chain read itself failed, which is deliberately not the same sentence as zero |
| Process restart | **C10 shipped the boot sweep.** Before `serve`, `sweepStaleOnBoot` takes `verified` rows older than Guard 3's in-flight window (`UPSTREAM_TIMEOUT_MS` + `AUTHORIZATION_EXPIRY_MARGIN_MS`), oldest first, and settles each by what the row and the chain say: no `near_tx_hash` → `abandoned` (no settle was submitted); hash present → one NEAR JSON-RPC `tx` read — chain settled → `settled` plus best-effort `payment_in`, chain failed → `abandoned` keeping the hash, unknown (RPC error, timeout, no relayer account) → left `verified` and counted `unproven`, because a guess either books a payment that never landed or abandons one that did. Every move is a compare-and-set, so a row another writer is advancing is skipped rather than overwritten. **The honest limit:** a crash between submitting the settle and stamping the hash leaves an unmovable `abandoned` row even though the money may have moved; the delegate's nonce then refuses the retry (`nonce_already_used`), so nothing is served twice, and the unbooked settle is reconciliation's problem, not the payer's. Loops resume and reconciliation is idempotent; in-process counters (the guards' read, the settlement cache) reset, and the insert-time claim is what makes a brief reset harmless |
| Duplicate submission | Unique `replay_key`; settled duplicates get 409 with receipt |

## 11. Observability and validation

### 11.1 Logging

Structured JSON logs with a request id also stored on `payments`. Provider calls logged with latency and status, never secrets.

### 11.2 Health

Relayer balance and last successful poll time shown in the dashboard header. No separate admin page.

**Shipped (F5, UI-5).** `GET /api/status` answers both facts for the session's seller and `app/layout.tsx` renders them in the header, so the warning is in the first paint rather than behind a page nobody navigates to. Three states, and the third is the reason the DTO has its shape: `ok` states the fact, `warn` states it past a threshold the seller can act on, and `unknown` states that Till could not look. The previous shape carried a required balance, so an RPC that did not answer reached the screen as `0` yoctoNEAR — the one sentence that sends a seller to top up a relayer that may be full. Now `relayerBalanceDtoSchema` binds its amount to its state (`ok` carries one, `account_missing` and `unreadable` carry none) and `payoutPollDtoSchema` binds `no_swaps` / `never_polled` / `polled` to the swap count and answer time they were derived from, so a header cannot print a number it did not read. Each half also travels with the threshold it is judged against — `RELAYER_BALANCE_ALERT_BASE_UNITS` for the balance, `POLL_INTERVAL_SECONDS * 5` for the poll — because the arithmetic is the API's and only the wording is the dashboard's (`apps/web/lib/header-status.ts`, a pure function, which is what makes the sentences assertable without a browser). The poll time is `swaps.last_polled_at`, which D6 stamps only on a pass that *got an answer*, scoped by the `swaps → payout_routes.seller_id` join so one seller's busy provider cannot age or refresh another's header, and aged by `now() - max(last_polled_at)` inside Postgres (hard rule 12).

### 11.3 Input validation at creation

- Upstream URL passes the SSRF checks at creation, not just at request time. **Shipped (D4):** creation calls the same `resolveUpstreamTarget` the proxy dials through, so the two cannot disagree about a host.
- Seller NEAR account is checked for storage registration on the payment token; if missing, the UI says so and the endpoint stays inactive. Refunds also land on the NEAR side, so this matters in `intents` mode too. **Shipped (D4):** a JSON-RPC `storage_balance_of` read against the token contract, shaped exactly as `@x402/near`'s verify interprets it — `supported: false` skips the rule, a null balance fails it, and an unreadable node fails it as *unverifiable* rather than passing.
- Destination address format is validated per chain and shown back to the seller for explicit confirmation. A well-formed address on the wrong chain is not detectable. **Shipped (D4):** NEAR, Solana, Bitcoin and twelve EVM chains; the create request must echo the shown value as `confirmedAddress` or it is refused `422`.
- Price must be at least `MIN_PRICE_BASE_UNITS`. **The check shipped (D4) against the configured value; the number is still S7's.** `10000` base units is the placeholder the check runs with, not a measured minimum.
- **The same list runs on a change, not only on a create (D9).** `updateEndpoint` re-runs `checkEndpointCreation` on the merged terms, so a below-floor price, an unreachable upstream or a malformed destination is refused with the same sentences — and, unlike a create, nothing is written: the live terms stay exactly as they were and the reasons go in the response only, because `creation_warnings` means "why this endpoint is not live" and an active endpoint carrying a refused edit's reasons would tell the gateway's own join something untrue. The destination being validated comes from the endpoint's *route row*, since `endpoints` carries no destination columns; an endpoint whose create never resolved a route therefore has nothing to merge onto, and a price-only repair is refused naming `destination_chain`, `refund_address` and `deposit_address` — which is the honest answer, because the seller has to resend the destination. `confirmedAddress` is required for the same reason it is at creation: a destination nobody was shown is a payout route to a stranger. **What shows it is the dashboard (F9):** the list read answers every row with its own route, the endpoint card prints that address, and the editor's confirmation step echoes the string those rows rendered — so there is one source for the address a seller vouches for, and an edit that changes it is refused before the API sees a body the seller was never shown.

## 12. Spikes (resolve before building the dependent part)

| ID | Question | Pass condition | Fallback |
|---|---|---|---|
| S1 | Can an Intents deposit address be `payTo` for a NEAR x402 payment, including storage registration at that address? | A real small payment lands and the swap completes | `direct` mode only |
| S2 | Is a standing deposit address available, and do deposit listings include the origin transaction hash? | Two payments to one address, both listed with hashes | Per-payment address; if hashes are missing there too, match through the deposit-submit call |
| S3 | Partner API key lead time, and what quotes return without one. `HACKATHON.md` Q-006 (2026-11-03) already documents the no-key path: a key is not required and the fee is 0.2%, registration at partners.near-intents.org | Working key or a documented no-key path — the second half is now documented by the organizers | Mock provider, labelled honestly |
| S4 | Payout leg on mainnet without spending: what does a `dry: true` quote return and what is refused without a partner key? (The original question, "any testnet for payouts?", was answered by the organizers on 2026-11-03 in `HACKATHON.md` Q-007: none exists or is planned) | Dry quote observed and the no-key behaviour recorded | Mainnet with minimal amounts, only after the human authorizes it (A17) |
| S5 | Full swap status enum and which are terminal | **Closed on paper 2026-11-03**, `docs/spikes/S5.md`: seven values, three terminal, `INCOMPLETE_DEPOSIT` not among them | Unknown maps to `processing` |
| S6 | NEP-366 behavior: do concurrent delegates from one payer fail on nonce ordering, and what is the default expiry? | **Half measured 2026-11-03**, `docs/spikes/S6.md`: the nonce rule refuses only a payment whose nonce has already *executed*, so concurrent delegates both verify — the hazard is a settlement failure, not a protection. There is no library default expiry: the payer's client sets `maxBlockHeight = height + ceil(maxTimeoutSeconds / 1)`, so the window is *our* advertised timeout, bounded on both sides | Keep D14 (one in flight), and enforce it in C8 rather than assuming the scheme does |
| S7 | Minimum deposit and fee for a real $0.01 to $1 payment into each sub-design | Measured numbers, `MIN_PRICE_BASE_UNITS` set | Raise the price floor or fall back to `direct` |

Record each result in `docs/spikes/Sx.md` with date, what was tried and the decision. Four files exist: `prior-art.md` (B1), `S1.md`, `S5.md`, `S6.md`. The others have no file for two different reasons. S3 and S4 were answered from organizer statements rather than experiments — Q-006 (a partner JWT is optional, the no-key fee is 0.2%) and Q-007 (no Intents testnet exists or is planned) — so the answer is in the table above and no result file was written. S2 and S7 are `[!]` in `ROADMAP.md` section 6 because they cannot be measured from this build at all: each needs a real quote and a real deposit listing, which is mainnet-only per Q-007, and A17 answered (c) so the payout leg runs on the mock. The open question behind both is S1's last one — whether registering a token at a `payTo` costs the payer or the recipient, and so whether a bad destination costs anything before it is discovered (`docs/spikes/S1.md` "What would verify the measured answer", and S5's open question 6, which records Q-007).

## 13. Assumptions about third parties

| Claim | Confidence | Source |
|---|---|---|
| NEAR Intents can settle x402 payments in the asset and chain a seller chooses | Certain (stated by NEAR) | near.org agentic payments page |
| Sellers route x402 payouts by setting a 1Click deposit address as the payment destination | Certain (stated by NEAR) | same page |
| FastNear x402 supports v2 `exact` on `near:mainnet` and `near:testnet` with NEP-141 tokens | Certain (read from the shipped code) | `@x402/near` 2.18.0: `NEAR_NETWORKS = ["near:mainnet","near:testnet"]`, `DEFAULT_ASSETS` lists one USDC contract per network, all six decimals |
| A payment is one `ft_transfer` authorized by a `SignedDelegate`, with the facilitator paying gas; native NEAR is not a payment asset and recipients need NEP-145 storage registration | Certain (documented; the transfer shape is also in the shipped code) | js.fastnear.com x402 page, and `exact/facilitator/index.mjs`, which rejects a delegate unless the single function call is `ft_transfer` with `deposit === 1n` and `receiver_id === payTo`; `storageBalanceOf` distinguishes "token has no NEP-145" from "account not registered" |
| Till can be its own facilitator, in process, with no third-party x402 service and no `X-API-Key` | Certain (read from the shipped types) | `@fastnear/x402` 2.5.0 `./facilitator` exports `createNearFacilitator({registrations})`; `./server` exports `createNearResourceServer({facilitators})`, and `NearFacilitatorClient` is `FacilitatorClient \| InProcessFacilitator` — an in-process object satisfies it. Read 2026-11-03 from the npm tarball |
| The gateway needs no web framework adapter for x402 | Certain (read from the shipped types) | same `server.d.ts`: it returns a bare `x402ResourceServer`; the package has no express or other framework dependency |
| An x402 v2 `402` challenge is delivered in the base64 `PAYMENT-REQUIRED` response **header**, and a body-only challenge is read only by a v1 client | Certain (read from the shipped client and server, C2) | `@x402/core` 2.18.0 `dist/esm/chunk-UCXEF6EL.mjs:1088-1096` (client: header first, body only when `x402Version === 1`) and `:645-653` (`createHTTPPaymentRequiredResponse` sets that header alone); the encoder's accepted shape is `/^[A-Za-z0-9+/]*={0,2}$/` at `chunk-ABS7D6VX.mjs:86` |
| Settlement of a NEAR `exact` payment needs a relayer account whose **full-access** key Till holds | Certain (read from the shipped types) | `FacilitatorRelayerConfig = {accountId, secretKey: KeyPairString}`, documented as "Full-access secret key for the relayer, e.g. `ed25519:...`"; `createFacilitatorNearSigner` submits the outer `Action::Delegate` transaction. So A10 is required, not optional, and the key is a new secret for `env.ts` (already present as `RELAYER_SECRET_KEY`) |
| `MAX_SPONSORED_GAS` is denominated in gas, and the client asks for 3e13 of it per payment | Certain (read from the shipped code) | `exact/facilitator/index.mjs`: rejects when `fc.gas > this.maxSponsoredGas`; `DEFAULT_FT_TRANSFER_GAS = 30000000000000n`, `DEFAULT_MAX_SPONSORED_GAS = 100000000000000n`. Our default was 1e7 and rejected every payment; fixed in `env.ts` and pinned by `apps/api/test/env.test.ts` 2026-11-03 |
| A payment asset on NEAR is the implicit USDC account, 6 decimals | Certain for the package default, Not verified live | `DEFAULT_ASSETS` in `@x402/near`: mainnet `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, testnet `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`. Read from the npm tarball 2026-11-03; confirm against the live contract in S1 before hardcoding |
| A 1Click partner JWT is not required; without one the fee is higher. Quotes are callable unauthenticated | Certain for "not required" (organizer answer); **the fee number is contested** | `HACKATHON.md` Q-006 (2026-11-03) says 0.2%. The Intents fee docs, read in S5 the same day, price unauthenticated quotes at +25 bps (0.25%). Ask which is current (A11). Endpoint behaviour is still to observe in S4. Replaces the earlier "needs a bearer token" assumption, which came from reading the API docs as if the key were mandatory |
| Swap status is polled by deposit address | Certain (documented) | NEAR Intents docs; S5 confirms there is no webhook on the partner REST API |
| Standing `ANY_INPUT` addresses suit repeated payments | Guessing | Spike S2 |
| Deposit listings include origin transaction hashes | Guessing | Spike S2 |
| The 1Click `/v0/status` response carries the destination-chain and origin-chain hashes Till matches on | Likely (required in the spec). Confirmed against the **live** spec fetched 2026-11-10 (section 3), and still never observed on a real settlement | S5: `SwapDetails` requires `destinationChainTxHashes`, `intentHashes`, `nearTxHashes`, `originChainTxHashes`, each `{hash, explorerUrl}`. Empty arrays are legal, so a hash is only guaranteed once settled. Since 2026-10-27 swaps are confidential-only and `nearTxHashes` has no swap hash |
| Delegates from one access key must execute in nonce order | **Certain for the rule, and the rule is weaker than it sounds** (was Likely; spike S6) | S6 read it out of the shipped verifier and ran it: the check is `delegate.nonce <= accessKey.nonce` (`exact/facilitator/index.js:375`) and an access key's nonce moves only when a transaction executes, so two concurrent delegates from one payer **both verify and both submit** — measured in `apps/api/test/x402.test.ts`. The ordering hazard is real but it lands as a settlement failure after the seller has served, which is why D14/Guard 3 cannot be delegated to the scheme (`docs/spikes/S6.md`) |
| The payout leg has no testnet | Certain (organizer answer, was Guessing) | `HACKATHON.md` Q-007, read 2026-11-03: "None exists or is planned. Mainnet, separate dev accounts, tiny amounts, dry: true quotes". The Intents introduction page says the same to S5 |
| A deposit address on NEAR accepts NEP-141 transfers without prior registration | **No, for any token that implements storage management** (was Guessing, spike S1) | S1 read the rule out of the shipped counterparty code rather than measuring a chain: `@x402/near` 2.18.0 `exact/facilitator/index.mjs:238` calls `storage_balance_of` on `requirements.payTo` and returns `invalid_exact_near_recipient_not_registered_for_storage` when the token supports storage and the account is not registered, and `storage_deposit` appears zero times in that dist. A token without the method reports `supported: false` and the check is skipped, which is why this is "no, for tokens with storage" and not a flat no |
| Cross-chain swaps have minimum amounts and fees that exceed cent-level payments | Likely | Spike S7 |

## 14. Red team review

Three questions, answered against the v1 design. Each item states what changed.

### 14.1 What would break

| # | What breaks | Why | Resolution |
|---|---|---|---|
| B1 | **Micropayment economics.** Cent-level calls into cross-chain swaps can fall under provider minimums or lose most of the value to fees. [Likely] | Swaps are built for larger transfers | S7 measures it. `MIN_PRICE_BASE_UNITS` enforced at endpoint creation. Standing address preferred (D12) so many payments share one swap flow. If the numbers are bad, `direct` mode becomes the headline |
| B2 | **Settle-after-serve is an exploit.** A buyer with an empty account gets responses for free, because verify does not hold funds. [Certain] that verification alone does not lock a balance | v1 returned the response even when settlement failed | Guards 1 to 4 in 4.2: expiry check, balance re-check, one in flight, strike-based blocking. **C8 shipped the first and third** (the balance check is the scheme's inside `verify`, and Till's half is that it runs before the upstream); **C9 shipped the fourth**: two `served_unsettled` payments in 24 hours at one seller block the payer's next paid request with `403` until the seller clears it (4.3), so sequential attempts are bounded to two per window instead of unbounded |
| B3 | **Delegate expiry.** If the signed authorization expires while the upstream call runs, settlement fails after the work is done. [Likely] | Settle happens after upstream | Guard 1 rejects authorizations that are too short-lived |
| B4 | **Concurrent payments from one payer.** Agents parallelize; delegates from one access key can fail on nonce ordering if settled out of order. **[Measured, S6] the scheme does not prevent it:** both verify, both submit, and the loser fails on-chain *after* the seller served | Settlement order follows upstream latency, not payment order | D14 caps one in flight per payer, and Guard 3 has to do it before serving — nothing downstream can. **Shipped by C8, at the insert rather than at the read:** a per-payer `pg_advisory_xact_lock` held across the read-and-insert of `openPayment`, so the second of two simultaneous authorizations gets `429` and no row. The read in `guards.ts` is the same answer without a transaction, and provably not enough — deleting the lock is a test, and the first version of that test was not (see `ROADMAP.md` C8's mutation list) |
| B5 | **Discrepancy deduplication was broken.** A unique constraint over `(code, payment_id, swap_id)` does not deduplicate rows where an id is null, because Postgres treats nulls as distinct unless told otherwise. [Certain] A resolved row would also block reopening | Orphan deposits have no payment id | `dedupe_key` plus a per-seller partial unique index on open rows |
| B6 | **Heuristic matching hides real errors.** Matching a payment to a swap by amount and time can pair the wrong two and make a genuine mismatch look clean | Standing address design in v1 | D13: match on transaction hash only. If S2 shows hashes are unavailable, the standing design is dropped. **Shipped by E2 as refusals, not as a comment:** `linkSwapByHash` cannot be handed an amount or a window, and it writes nothing when the hash is missing, unmatched or shared by two payments — with a test that refuses the pair an amount-and-time matcher would join (identical amount, asset and timestamps, different hashes) and links the pair it would split (same hash, sums 7 vs 999999999) |
| B7 | **Shortfall rule had no baseline.** Standing addresses have no per-payment quote, so there is no `min_amount_out` | Rule assumed a quote | Stablecoin-only payouts and a tolerance in basis points (D11, section 7) |
| B8 | **Ledger claimed more than it was.** v1 called it double-entry and derived cross-asset balances that mean nothing. Lint rules do not stop a stray `UPDATE` | Loose wording and weak enforcement | Honest naming (event ledger), per-asset entries, trigger-based immutability |
| B9 | **Edits rewrite history.** Changing price or destination would alter how past payments read | Payments referenced the endpoint, not a snapshot | `payments` stores amount and `route_id`; routes are immutable |
| B10 | **Legitimate retry blocked.** After an upstream failure the buyer re-sends the same authorization and the replay guard rejects it | Unique key with no state awareness | Closed by C7: abandoned payments are retried on the same row (4.2 step 6), with the two conditions in 8.3 keeping the move off the money path |
| B11 | **SSRF via DNS rebinding and redirects.** Validating a hostname and then connecting by name lets the answer change. [Certain] | Naive check | Connect to the validated address, no redirects, self-loop check |
| B12 | **Quote spam.** Per-payment addresses would create a provider quote for every unpaid request, including bot traffic | Quote at 402 time | Standing address preferred; otherwise bounded cache and rate limit |
| B13 | **Provider state regressions and drift.** Status could appear to move backwards or gain unknown values | External API | Terminal states sticky; unknown maps to `processing` with an alert |
| B14 | **Seller account unregistered for the token.** Direct payments and refunds fail | Storage deposit requirement | Checked at endpoint creation (11.3) |
| B15 | **Demo-day failures.** Provider outage, relayer out of gas, cold start, rate limits during judging | Single points of failure | Mock fallback is documented, relayer balance shown, live instance warmed before submission, README states what is mocked |

### 14.2 Edge cases that were missing

| # | Edge case | Decision |
|---|---|---|
| E1 | Upstream returns 4xx | No settlement; pass the status through. Charging for 4xx invites sellers to return errors; not charging means a buyer can spam bad requests for free, which costs the seller only compute. Accepted |
| E2 | Upstream returns a redirect | Not followed; treated as non-2xx |
| E3 | Large or streaming responses | Size cap; streaming not supported in v1 |
| E4 | Paid, response lost, buyer retries | 409 with receipt now; response cache in P1 (4.4) |
| E5 | Seller changes price or upstream mid-flight | Payments snapshot price and route (B9). Upstream changes apply to the next request |
| E6 | Destination address valid in format but wrong for the chain | Not detectable. Mitigated by showing the address back with a confirmation step |
| E7 | Refund destination unregistered or unreachable | Storage check at creation; if a refund still fails the swap shows `refunded` with a stuck amount and `PAYOUT_STUCK` fires |
| E8 | Deposit after the quote deadline | Applies to per-payment mode. Treated as `ORPHAN_DEPOSIT` or provider refund, whichever the provider reports |
| E9 | Decimal differences across chains | Only 6-decimal stablecoins allowed (D11) |
| E10 | Self-payment (payer equals seller) | Allowed; needed for the demo. Flagged in the payments table so it is not mistaken for revenue |
| E11 | Two reconcile runs overlapping | `SKIP LOCKED` claiming plus idempotent findings |
| E12 | Clock skew | Database time for all comparisons |
| E13 | Process restart with payments mid-flight | Closed by C10's boot sweep: rows left in `verified` beyond the in-flight window are classified, not just abandoned — no hash is `abandoned`, a hash is looked up on-chain and becomes `settled` (plus `payment_in`) or `abandoned` keeping the hash, and an unreadable chain leaves the row `verified` as `unproven` (section 10, `sweep-stale.ts`) |
| E14 | Endpoint disabled while a payment is in flight | In-flight request completes; new requests get 404 |
| E15 | Slug guessing | Random suffix; gateway returns the same 404 for missing and inactive endpoints |

### 14.3 What was overengineered

| # | Cut | Why |
|---|---|---|
| O1 | pg-boss and a separate worker process | Two timers do not need a queue. One fewer dependency and one fewer process in the one-command demo |
| O2 | `packages/db`, `packages/payouts`, `packages/x402` | Only the API uses them. Folders inside `apps/api` give the same boundaries without workspace plumbing. `packages/core` stays because the web app shares it |
| O3 | Playwright | `pnpm demo` with assertions and a non-zero exit code is the end-to-end test |
| O4 | `sessions` table | Stateless signed cookies are enough for one seller role |
| O5 | `splits` table and revenue splits | Unused and unplanned; removed from the PRD |
| O6 | `method_allowlist` and POST support | GET only in v1 |
| O7 | Both intents sub-designs | One is built (D12) |
| O8 | `/admin/health` page | Header indicators cover it |
| O9 | Eight reconciliation rules at P0 | Five at P0, three at P1 (section 7) |
| O10 | Vercel plus Fly with cross-site cookie setup | Single origin through rewrites |
| O11 | Per-payer rate-limit infrastructure | One in-flight rule (D14) plus a global in-memory cap: C13's fixed-window request limiter and sponsored-gas budget |

Kept on purpose despite looking heavy: the `PayoutProvider` interface and mock (they make the demo run without keys and survive a provider outage), the append-only ledger (the product is its audit trail), and the pure reconciliation rules (cheap to test, central to the pitch).

### 14.4 What this review did not settle

- Whether the headline feature works at all. That is S1 and S2.
- Whether real micropayments survive provider fees. That is S7.
- Whether anyone else has built seller-side reconciliation on NEAR. [Guessing] that they have not; search before committing.
