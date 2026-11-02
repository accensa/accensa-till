# ARCHITECTURE: Till (working name)

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
|  Loops: poll-payouts (15s), reconcile (60s)                      |
|     \--> PayoutProvider (1Click or mock)                         |
+------------------------------------------------------------------+
```

## 2. Key architectural decisions

| # | Decision | Alternatives rejected | Why |
|---|---|---|---|
| D1 | Hosted gateway that proxies to the seller's API, GET only in v1 | Middleware SDK; POST and streaming support | Zero seller code; GET only removes body replay, streaming and non-idempotency problems |
| D2 | Reuse the NEAR x402 packages in process; build no protocol code | Own facilitator; standalone facilitator service | Protocol layer exists; value is the seller operations layer |
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
| NEAR x402 | `@fastnear/x402` (server, facilitator, node signer entry points) | Package-only; separate from the main FastNear packages |
| NEAR RPC and signing | `@fastnear/api`, `@fastnear/wallet` | Wallet sign-in via signed message |
| Payouts | NEAR Intents 1Click Swap REST API | Base URL `https://1click.chaindefuser.com` **[VERIFY]** |
| Database | PostgreSQL 16 | `NULLS NOT DISTINCT` available (15+) |
| ORM | Drizzle with the `postgres` driver | SQL migrations committed |
| Sessions | Signed cookie via `jose` | No sessions table |
| Validation | Zod | Schemas in `packages/core` |
| Web | Next.js App Router, Tailwind, shadcn/ui | Rewrites `/api/*` to the API |
| Tests | Vitest; `pnpm demo` doubles as the end-to-end test | No browser test framework |
| Lint and format | Biome | One tool |
| Boundaries | A 15-line grep script in CI | Enforces the rules in `PROJECT_STRUCTURE.md` |
| Roadmap upkeep | `scripts/roadmap-progress.ts` and `scripts/check-roadmap.sh` in CI | Fails any change that leaves `ROADMAP.md` untouched or its progress block stale |
| Hosting | One platform for API and Postgres (Fly.io or Railway); web on the same platform or Vercel with rewrites | Choose by accounts you already have |
| CI | GitHub Actions | Lint, typecheck, unit tests, boundaries, `pnpm roadmap:check`, `pnpm demo` against mock |

## 4. Request lifecycle

### 4.1 Unpaid request

`GET /r/:slug` with no payment header returns `402` with x402 v2 requirements (network, asset, amount, pay-to). Requirements are cached per endpoint and rebuilt only when the endpoint changes, so scanners and bots cannot trigger provider calls. In per-payment-address mode this cache must instead be bounded and rate limited; this is one reason standing addresses are preferred.

### 4.2 Paid request

1. Parse payment header. Reject if the payer is blocked (4.3).
2. Facilitator `verify`. On failure: `402` with a reason.
3. **Guard 1, expiry.** Reject if the delegate's expiry is sooner than now plus the upstream timeout plus a margin. Otherwise settlement can fail after the work is done.
4. **Guard 2, balance.** Re-read the payer's token balance and reject if it is below the price. Verification alone does not prove funds are still there.
5. **Guard 3, in-flight.** If the payer already has a paid request in flight, return `429` with `Retry-After`. One in flight per payer (D14).
6. Insert the `payments` row with `replay_key`. If a row with that key exists in state `abandoned`, reuse it (same authorization, retry allowed). If it exists in any other state, return `409` with the stored receipt and no charge (see 4.4).
7. Forward a `GET` to the upstream. No redirects followed, timeout enforced, response size capped, payment headers stripped.
8. Upstream returned 2xx: call facilitator `settle`. Anything else (4xx, 5xx, timeout): mark `abandoned`, do not settle, return the upstream status for 4xx and `502` for 5xx or timeout.
9. Settle succeeded: state `settled`, write `payment_in`, return the upstream response with a receipt header carrying the NEAR transaction hash.
10. **Guard 4, strikes.** Settle failed after a 2xx upstream: state `served_unsettled`, open a critical `SERVED_NOT_SETTLED` discrepancy, still return the response. Payers with two such events in 24 hours are blocked from new paid calls until a seller clears them. This turns the exploit "pay with an empty account" into a bounded loss of one or two calls.

### 4.3 Blocked payers

Computed by query over `payments` (count of `served_unsettled` in the last 24 hours per payer). No separate table.

### 4.4 Paid but not delivered

If settlement succeeded but the response never reached the buyer, a retry with the same authorization hits the replay guard. Until the P1 response cache exists the buyer gets `409` and the receipt, and the seller sees a normal settled payment. This is a known limitation, documented in the README. The P1 fix stores small responses (up to 256 KB) for five minutes keyed by `replay_key` and replays them on retry.

### 4.5 Payout lifecycle

**`direct` mode.** `payTo` is the seller's NEAR account. No swap. The ledger records `payment_in` and an immediate `payout_out` of kind `direct`. The seller account must be storage-registered for the payment token; this is checked when the endpoint is created (11.3).

**`intents` mode.** `payTo` is an Intents deposit address and the transfer is swapped to the seller's destination. Spike S2 selects exactly one of:

- **Standing address (preferred).** One long-lived `ANY_INPUT` style quote per seller and destination, accumulating many small payments. Matches micropayment economics (14.1) and avoids per-request provider calls.
- **Per-payment address.** A fresh quote per paid request. Easy one-to-one matching, but every swap pays minimums and fees and requires a quote deadline that outlives the buyer's retry window.

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
- Unknown provider statuses map to `processing` and trigger a `PAYOUT_STUCK` check after the stuck window.
- `OneClickProvider` stores the raw payload in `swaps.raw`. `MockProvider` supports scripted outcomes (`succeed`, `refund`, `fail`, `stall`).
- Selected by `PAYOUT_PROVIDER=oneclick|mock`. Default in `.env.example` is `mock`.

## 6. Data model

Amounts are `numeric(78,0)` base units. Ids are UUID v7. Every table has `created_at timestamptz default now()`. Time comparisons use database time.

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
  price_amount      numeric(78,0) not null    -- >= MIN_PRICE_BASE_UNITS
  asset_contract    text not null             -- NEP-141 contract id
  network           text not null
  description       text
  payout_mode       text not null             -- 'direct' | 'intents'
  route_id          uuid fk payout_routes null
  active            boolean not null default true

payout_routes   -- immutable; a change creates a new row
  id                  uuid pk
  seller_id           uuid fk sellers
  destination_chain   text not null
  destination_asset   text not null           -- stablecoin, 6 decimals (D11)
  destination_address text not null           -- format-validated per chain
  refund_address      text not null
  provider            text not null
  deposit_address     text
  deposit_memo        text
  quote_ref           text
  deadline_at         timestamptz
  mode_detail         text not null           -- 'standing' | 'per_payment' (one survives S2)

payments
  id                  uuid pk
  endpoint_id         uuid fk endpoints
  route_id            uuid fk payout_routes null   -- snapshot at verify time
  payer_account_id    text not null
  amount              numeric(78,0) not null       -- snapshot of price
  asset_contract      text not null
  replay_key          text unique not null
  state               text not null   -- verified | abandoned | settled | served_unsettled
  delegate_expires_at timestamptz
  near_tx_hash        text
  upstream_status     int
  upstream_ms         int
  verified_at         timestamptz
  settled_at          timestamptz

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
  refunded_amount     numeric(78,0)
  last_polled_at      timestamptz
  terminal_at         timestamptz
  raw                 jsonb not null

ledger_entries   -- append only, enforced by trigger
  id                  uuid pk
  seller_id           uuid fk sellers
  kind                text not null   -- payment_in | payout_out | refund_in | adjustment
  amount              numeric(78,0) not null
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

  -- one OPEN discrepancy per cause; a resolved one may reopen later
  create unique index discrepancies_open_dedupe
    on discrepancies (dedupe_key) where resolved_at is null;

response_cache   -- P1, see 4.4
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
- Only `services/ledger.ts` inserts into the table.

## 7. Reconciliation engine

Runs every 60 seconds per seller and after any swap status change, inside the API process.

- **Pure core.** Rules are pure functions in `packages/core`: `(snapshot) => Finding[]`. No I/O.
- **Idempotent.** `dedupe_key` plus the partial unique index prevents duplicate open discrepancies, including those with a null payment or swap id (a plain unique constraint would treat nulls as distinct and fail to deduplicate; see 14.1).
- **Auto-resolution.** When the cause clears, the discrepancy closes with `resolution = auto`.
- **Config windows.** Sweep delay and stuck threshold come from environment.
- **Shortfall.** With stablecoin payouts only (D11), shortfall is `amount_out < amount_in * (1 - SHORTFALL_TOLERANCE_BPS / 10000)`. No oracle needed.

Rule priority:

| Tier | Codes |
|---|---|
| P0 | `SERVED_NOT_SETTLED`, `PAYOUT_REFUNDED`, `PAYOUT_FAILED`, `PAYOUT_STUCK`, `PAYMENT_NOT_SWEPT` |
| P1 | `PAYOUT_SHORTFALL`, `INCOMPLETE_DEPOSIT`, `ORPHAN_DEPOSIT` |

The P1 codes depend on how deposits to a standing address are reported, which is unknown until S2.

## 8. Security design

### 8.1 Relayer key

Full-access key required by the underlying package. Mitigations:

- Dedicated relayer account holding a small balance.
- Key only in server environment; never logged; never in the web app.
- Global and per-payer sponsored-gas caps; one-in-flight rule (D14) also bounds burn rate.
- Dashboard header shows relayer balance and warns below a threshold.

### 8.2 Seller authentication

- Server issues a nonce in a short-lived signed cookie. Seller signs a message containing it with their NEAR wallet.
- Server verifies the signature against the account's access keys and sets a signed session cookie (HTTP-only, SameSite Lax).
- Single origin via Next.js rewrites; no cross-site cookie configuration.

### 8.3 Replay protection

`replay_key` is a hash of payer, delegate nonce and endpoint, under a unique index. Abandoned payments may be retried with the same authorization (4.2 step 6).

### 8.4 Proxy safety (SSRF)

- Resolve the hostname, reject private, loopback and link-local results, then connect to the resolved address directly so a second DNS lookup cannot change it (DNS rebinding).
- Do not follow redirects.
- Reject upstream URLs that point at the gateway itself.
- `https` only outside local development.
- Timeout and maximum response size.
- Strip hop-by-hop and payment headers before forwarding.

### 8.5 Config

All secrets from environment, validated by Zod at boot. The process refuses to start on missing or malformed values.

## 9. Interfaces

### 9.1 Public gateway

| Method and path | Purpose |
|---|---|
| `GET /r/:slug` | Paywalled resource; 402 or upstream response |
| `GET /healthz` | Liveness |

### 9.2 Dashboard API (session required)

| Method and path | Purpose |
|---|---|
| `POST /auth/nonce`, `POST /auth/verify` | Wallet sign-in |
| `GET /endpoints`, `POST /endpoints`, `PATCH /endpoints/:id` | Manage endpoints; price changes apply to new payments only |
| `GET /payments` | Paginated, joined with swap state |
| `GET /swaps/:id` | Detail including raw provider payload |
| `GET /discrepancies`, `POST /discrepancies/:id/resolve` | List and manual resolution |
| `GET /ledger.csv` | Export (P1) |
| `GET /assets` | Supported payout assets |

Schemas live once in `packages/core` and are imported by both apps.

## 10. Failure behavior

| Failure | Behavior |
|---|---|
| Upstream non-2xx or timeout | No settlement; payment `abandoned`; retry with the same authorization allowed |
| Settlement fails after 2xx | Response returned; `served_unsettled`; critical discrepancy; strike counted |
| Delegate expires too soon | Rejected before the upstream call |
| Payer balance too low | Rejected before the upstream call |
| Second concurrent request from a payer | 429 with `Retry-After` |
| Provider API down | Payments continue; polling backs off; dashboard shows provider degraded |
| Database down | 503 before verifying anything |
| Relayer out of gas | 503 with a reason; dashboard alert |
| Process restart | Loops resume; reconciliation is idempotent; in-flight request counters reset, which can briefly allow a second concurrent request and is accepted |
| Duplicate submission | Unique `replay_key`; settled duplicates get 409 with receipt |

## 11. Observability and validation

### 11.1 Logging

Structured JSON logs with a request id also stored on `payments`. Provider calls logged with latency and status, never secrets.

### 11.2 Health

Relayer balance and last successful poll time shown in the dashboard header. No separate admin page.

### 11.3 Input validation at creation

- Upstream URL passes the SSRF checks at creation, not just at request time.
- Seller NEAR account is checked for storage registration on the payment token; if missing, the UI says so and the endpoint stays inactive. Refunds also land on the NEAR side, so this matters in `intents` mode too.
- Destination address format is validated per chain and shown back to the seller for explicit confirmation. A well-formed address on the wrong chain is not detectable.
- Price must be at least `MIN_PRICE_BASE_UNITS`, set from spike S7.

## 12. Spikes (resolve before building the dependent part)

| ID | Question | Pass condition | Fallback |
|---|---|---|---|
| S1 | Can an Intents deposit address be `payTo` for a NEAR x402 payment, including storage registration at that address? | A real small payment lands and the swap completes | `direct` mode only |
| S2 | Is a standing deposit address available, and do deposit listings include the origin transaction hash? | Two payments to one address, both listed with hashes | Per-payment address; if hashes are missing there too, match through the deposit-submit call |
| S3 | Partner API key lead time, and what quotes return without one | Working key or a documented no-key path | Mock provider, labelled honestly |
| S4 | Any testnet for payouts? | Testnet quote succeeds | Mainnet with minimal amounts |
| S5 | Full swap status enum and which are terminal | List from the OpenAPI spec | Unknown maps to `processing` |
| S6 | NEP-366 behavior: do concurrent delegates from one payer fail on nonce ordering, and what is the default expiry? | Documented result with a test | Keep D14 (one in flight) |
| S7 | Minimum deposit and fee for a real $0.01 to $1 payment into each sub-design | Measured numbers, `MIN_PRICE_BASE_UNITS` set | Raise the price floor or fall back to `direct` |

Record each result in `docs/spikes/Sx.md` with date, what was tried and the decision.

## 13. Assumptions about third parties

| Claim | Confidence | Source |
|---|---|---|
| NEAR Intents can settle x402 payments in the asset and chain a seller chooses | Certain (stated by NEAR) | near.org agentic payments page |
| Sellers route x402 payouts by setting a 1Click deposit address as the payment destination | Certain (stated by NEAR) | same page |
| FastNear x402 supports v2 `exact` on `near:mainnet` and `near:testnet` with NEP-141 tokens | Certain (documented) | js.fastnear.com x402 page |
| A payment is one `ft_transfer` authorized by a `SignedDelegate`, with the facilitator paying gas | Certain (documented) | same page |
| Native NEAR is not a payment asset and recipients need storage registration | Certain (documented) | same page |
| 1Click quote requests need a bearer token; unauthenticated use incurs a higher fee | Certain (documented) | NEAR Intents docs |
| Swap status is polled by deposit address | Certain (documented) | NEAR Intents docs |
| Standing `ANY_INPUT` addresses suit repeated payments | Guessing | Spike S2 |
| Deposit listings include origin transaction hashes | Guessing | Spike S2 |
| Delegates from one access key must execute in nonce order | Likely | Recalled from NEP-366 semantics; spike S6 |
| The payout leg has no testnet | Guessing | Spike S4 |
| A deposit address on NEAR accepts NEP-141 transfers without prior registration | Guessing | Spike S1 |
| Cross-chain swaps have minimum amounts and fees that exceed cent-level payments | Likely | Spike S7 |
| NEAR native USDC contract id | Not recorded | Look up in S1; do not hardcode from memory |

## 14. Red team review

Three questions, answered against the v1 design. Each item states what changed.

### 14.1 What would break

| # | What breaks | Why | Resolution |
|---|---|---|---|
| B1 | **Micropayment economics.** Cent-level calls into cross-chain swaps can fall under provider minimums or lose most of the value to fees. [Likely] | Swaps are built for larger transfers | S7 measures it. `MIN_PRICE_BASE_UNITS` enforced at endpoint creation. Standing address preferred (D12) so many payments share one swap flow. If the numbers are bad, `direct` mode becomes the headline |
| B2 | **Settle-after-serve is an exploit.** A buyer with an empty account gets responses for free, because verify does not hold funds. [Certain] that verification alone does not lock a balance | v1 returned the response even when settlement failed | Guards 1 to 4 in 4.2: expiry check, balance re-check, one in flight, strike-based blocking |
| B3 | **Delegate expiry.** If the signed authorization expires while the upstream call runs, settlement fails after the work is done. [Likely] | Settle happens after upstream | Guard 1 rejects authorizations that are too short-lived |
| B4 | **Concurrent payments from one payer.** Agents parallelize; delegates from one access key can fail on nonce ordering if settled out of order. [Likely] | Settlement order follows upstream latency, not payment order | D14 caps one in flight per payer. S6 confirms the hazard |
| B5 | **Discrepancy deduplication was broken.** A unique constraint over `(code, payment_id, swap_id)` does not deduplicate rows where an id is null, because Postgres treats nulls as distinct unless told otherwise. [Certain] A resolved row would also block reopening | Orphan deposits have no payment id | `dedupe_key` plus a partial unique index on open rows |
| B6 | **Heuristic matching hides real errors.** Matching a payment to a swap by amount and time can pair the wrong two and make a genuine mismatch look clean | Standing address design in v1 | D13: match on transaction hash only. If S2 shows hashes are unavailable, the standing design is dropped |
| B7 | **Shortfall rule had no baseline.** Standing addresses have no per-payment quote, so there is no `min_amount_out` | Rule assumed a quote | Stablecoin-only payouts and a tolerance in basis points (D11, section 7) |
| B8 | **Ledger claimed more than it was.** v1 called it double-entry and derived cross-asset balances that mean nothing. Lint rules do not stop a stray `UPDATE` | Loose wording and weak enforcement | Honest naming (event ledger), per-asset entries, trigger-based immutability |
| B9 | **Edits rewrite history.** Changing price or destination would alter how past payments read | Payments referenced the endpoint, not a snapshot | `payments` stores amount and `route_id`; routes are immutable |
| B10 | **Legitimate retry blocked.** After an upstream failure the buyer re-sends the same authorization and the replay guard rejects it | Unique key with no state awareness | Abandoned payments may be retried (4.2 step 6) |
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
| E13 | Process restart with payments mid-flight | Rows left in `verified` beyond the upstream timeout are marked `abandoned` by a sweep; if a settle may have happened, the on-chain hash is looked up before marking |
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
| O11 | Per-payer rate-limit infrastructure | One in-flight rule (D14) plus a global in-memory cap |

Kept on purpose despite looking heavy: the `PayoutProvider` interface and mock (they make the demo run without keys and survive a provider outage), the append-only ledger (the product is its audit trail), and the pure reconciliation rules (cheap to test, central to the pitch).

### 14.4 What this review did not settle

- Whether the headline feature works at all. That is S1 and S2.
- Whether real micropayments survive provider fees. That is S7.
- Whether anyone else has built seller-side reconciliation on NEAR. [Guessing] that they have not; search before committing.
