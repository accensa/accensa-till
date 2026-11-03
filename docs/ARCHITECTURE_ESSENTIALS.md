# ARCHITECTURE_ESSENTIALS: Till (working name)

Version 2.1. Outline of decisions that must not be violated. Detail: `ARCHITECTURE.md`. Scope: `PRD.md`. Layout: `PROJECT_STRUCTURE.md`. Status and task list: `ROADMAP.md` (repo root).

## What it is

- Hosted gateway that paywalls a seller's GET API with x402 on NEAR
- Payouts through NEAR Intents to a seller-chosen stablecoin and chain
- Append-only ledger plus reconciliation that flags payment and payout mismatches

## Hard rules

1. No custom smart contracts and no new protocol code. Reuse the FastNear x402 packages in process.
2. Paid call order: verify, guards, upstream, settle. Settle only on upstream 2xx.
3. Money is integer base units (`bigint` in code, `numeric(78,0)` in Postgres). Never floats.
4. `ledger_entries` is append only, enforced by a database trigger. Only `services/ledger.ts` inserts.
5. All payout calls go through `PayoutProvider`. Only `payouts/oneclick/client.ts` talks to 1Click.
6. Reconciliation rules are pure functions in `packages/core`. No I/O inside a rule.
7. Match payments to swaps by transaction hash only. Never by amount or time.
8. Terminal swap states are sticky. Unknown provider statuses map to `processing`.
9. Payout assets are 6-decimal stablecoins only.
10. One process, one Postgres. No Redis, no queue library, no separate worker.
11. Every env var validated by Zod at boot. Default `PAYOUT_PROVIDER=mock`.
12. Never hardcode a USDC contract id or provider asset id. Read from config.
13. Anything marked VERIFY in `ARCHITECTURE.md` is unproven. Close its spike first.
14. `ROADMAP.md` is updated in every contribution (status, evidence, changelog, `pnpm roadmap`). CI enforces it with `pnpm roadmap:check`.

## Stack

- TypeScript 5 strict, Node 22, pnpm workspaces
- Hono (API and gateway), Next.js App Router with Tailwind and shadcn/ui
- Postgres 16, Drizzle, Zod, `jose` for signed cookies
- `@fastnear/x402`, `@fastnear/api`, `@fastnear/wallet`
- Vitest, Biome, GitHub Actions, a grep script for import boundaries

## Layout

- `apps/api`: gateway, facilitator wrapper, payouts, db, services, jobs, dashboard routes
- `apps/web`: dashboard, rewrites `/api/*` to the API
- `packages/core`: schemas, money, state machines, reconciliation rules

## Paid call guards (in this order)

1. Payer not blocked (two `served_unsettled` in 24h means blocked)
2. Authorization expiry outlasts upstream timeout plus margin
3. Payer balance covers the price
4. One in flight per payer, else 429
5. Replay key: abandoned may retry, settled returns 409 with receipt

## Core flow

1. No payment: 402 with cached requirements
2. Verify, guards, insert payment
3. Proxy GET: no redirects, timeout, size cap, SSRF-safe connect
4. Non-2xx or timeout: abandon, no settle
5. 2xx: settle, write `payment_in`, return with receipt header
6. Settle fails after 2xx: return response, open `SERVED_NOT_SETTLED`, count a strike

## Payout modes

- `direct`: payTo is the seller's account, no swap
- `intents`: payTo is an Intents deposit address; one sub-design (standing or per-payment), chosen by S2, the other deleted
- If S1 fails: `direct` plus reconciliation becomes the product

## Tables

`sellers`, `endpoints`, `payout_routes` (immutable), `payments` (snapshot route and amount), `swaps`, `ledger_entries`, `discrepancies` (dedupe key, partial unique index on open rows), `response_cache` (P1)

## Reconciliation codes

- P0: `SERVED_NOT_SETTLED`, `PAYOUT_REFUNDED`, `PAYOUT_FAILED`, `PAYOUT_STUCK`, `PAYMENT_NOT_SWEPT`
- P1: `PAYOUT_SHORTFALL`, `INCOMPLETE_DEPOSIT`, `ORPHAN_DEPOSIT`

Each needs a pure rule, a fixture test, a plain-language explanation and a suggested action.

## Security musts

- Relayer key server-side only, low balance, global gas cap
- SSRF: connect to the validated IP, no redirects, no self-loop
- Wallet-signature sign-in, signed HTTP-only cookie, single origin
- Endpoint creation checks token registration, price floor and address format

## Spikes (day one)

- S1: Intents deposit address as `payTo`, storage registration — **closed 2026-11-03 on the fallback branch, not measured.** The x402 facilitator refuses an unregistered `payTo` (`docs/spikes/S1.md`), so `payTo` is the seller's own testnet account and the payout leg runs on the mock (`direct` is the proven half, `intents` the designed-but-unproven one)
- S2: Standing address, and do deposits list origin tx hashes
- S3: Partner API key lead time — Q-006 (2026-11-03): a key is optional, the no-key fee is 0.2%
- S4: Payout testnet — Q-007: none exists or is planned, so the payout leg is mainnet, `dry: true` first, gated on the human's approval
- S5: Full swap status enum
- S6: NEP-366 concurrency and expiry behavior
- S7: Minimum deposit and fees for small payments

## What was cut (do not rebuild)

pg-boss, separate worker, `packages/db`, `packages/payouts`, `packages/x402`, Playwright, `sessions` table, `splits`, POST support, admin health page, second intents sub-design

## Delivery constraints

- Dev ends 14 Nov 2026 23:59 UTC; target submit 13 Nov
- Only code written after the announcement counts
- Fresh clone must run with `docker compose up` then `pnpm demo`, no keys, mock payouts
- README states what is real, what is mocked, and known limitations
- All P0 before any P1
- `ROADMAP.md` is the live status; keep it current in every change
