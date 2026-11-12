# Pre-Launch Technical & Security Audit: Till Gateway

**Repository:** `accensa-till`  
**Reviewer:** Senior Systems & Security Engineer  
**Status:** Pre-Launch Review (No code changes applied)  
**Rule Compliance:** Items touching **Auth, Payments, and User Data / Accounting** are ranked first, followed by infrastructure risks, test harness blockers, and remaining pre-launch roadmap deliverables.

---

## Part 1: High-Risk Items Already Implemented (Most Likely to Break in Production or Get Us Hacked)

### 1. [AUTH / FRONTEND CRASH] Unhandled Node `Buffer` in Browser Client Component Breaks Wallet Sign-In
- **File & Line:** [`apps/web/components/domain/SignInForm.tsx:559`](file:///home/ademola/orgs/accensa/accensa-till/apps/web/components/domain/SignInForm.tsx#L559)
- **Why It Matters:** Next.js client components marked `"use client"` execute in browser environments where Node's global `Buffer` is undefined. In `handleWalletPrompt()`, line 559 executes `const nonceBytes = Buffer.from(challenge.nonce, "base64");`. When a seller with an injected browser wallet (Meteor, HERE, Sender) clicks "Prompt Wallet", the browser throws `ReferenceError: Buffer is not defined`, crashing the sign-in prompt and preventing sellers from logging into the console.
- **Efficient One-Line Fix:** Replace `Buffer.from(challenge.nonce, "base64")` with `decodeSignInNonce(challenge.nonce) ?? new Uint8Array()` using the cross-platform decoder already exported from `@till/core`.

---

### 2. [AUTH / SESSION LIFECYCLE] Missing Sign-Out Endpoint and UI Session Invalidation
- **File & Line:** [`apps/api/src/routes/auth.ts:83`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/routes/auth.ts#L83) & [`apps/web/components/domain/ConsoleShell.tsx:55`](file:///home/ademola/orgs/accensa/accensa-till/apps/web/components/domain/ConsoleShell.tsx#L55)
- **Why It Matters:** The API provides `POST /auth/nonce` and `POST /auth/verify`, but no `POST /auth/sign-out` route exists to delete the `till_session` HttpOnly cookie, and the frontend shell provides no sign-out trigger. On shared developer machines, workstations, or multi-seller setups, a user cannot revoke their session or switch NEAR accounts without manually opening browser dev tools and deleting cookies.
- **Efficient One-Line Fix:** In `apps/api/src/routes/auth.ts`, mount `app.post("/auth/sign-out", (c) => { deleteCookie(c, SESSION_COOKIE, { path: "/", secure }); return c.json({ ok: true }); });` and render a sign-out button in `ConsoleShell.tsx`.

---

### 3. [AUTH / UI DRIFT] Navigation Header Unconditionally Displays "Connect Wallet" Even When Authenticated
- **File & Line:** [`apps/web/components/domain/ConsoleShell.tsx:55-57`](file:///home/ademola/orgs/accensa/accensa-till/apps/web/components/domain/ConsoleShell.tsx#L55-L57)
- **Why It Matters:** In the main layout shell, the top navigation bar unconditionally renders `<a className="btn btn-primary" href="/sign-in">Connect wallet</a>` even when a valid session token exists and the user is authenticated on `/endpoints` or `/payments`. This confuses sellers regarding whether their wallet is connected, obscures which account is active, and clicking the button navigates away from their active dashboard view.
- **Efficient One-Line Fix:** In `ConsoleShell.tsx:55`, conditionally render the authenticated account ID when `token` is present: `{token ? <span className="font-mono text-xs text-bone">{status.kind === "ok" ? status.status.relayer.accountId : "Connected"}</span> : <a className="btn btn-primary" href="/sign-in">Connect wallet</a>}`.

---

### 4. [PAYMENTS / INTEGRITY] Non-Atomic Payment State Transition and Ledger Settlement Booking
- **File & Line:** [`apps/api/src/gateway/route.ts:754-781`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/gateway/route.ts#L754-L781) & [`apps/api/src/jobs/sweep-stale.ts:116-146`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/jobs/sweep-stale.ts#L116-L146)
- **Why It Matters:** `advancePayment(db, payment.id, "settled", ...)` and `recordSettlement(db, ...)` are executed in separate database transactions. If `recordSettlement` throws (database connection timeout, pool exhaustion, constraint check failure) or the Node process crashes in between, `payments.state` is committed as `settled`, but no `payment_in` entry is created in `ledger_entries`. Even though the reconciliation loop detects this via `PAYMENT_UNBOOKED`, the restart sweep (`sweepStaleOnBoot`) only probes rows in `verified` state, leaving the payment unrecovered without manual intervention.
- **Efficient One-Line Fix:** Wrap both operations in a single atomic transaction: `await db.transaction(async (tx) => { const booked = await advancePayment(tx, payment.id, "settled", ...); await recordSettlement(tx, { sellerId: row.sellerId, amount: BigInt(booked.amount), asset: booked.assetContract, paymentId: booked.id }, row.payoutMode); });`.

---

### 5. [PAYMENTS / ROUTE CRASH] Live 1Click Intents Route Creation Throws Unhandled Provider Error
- **File & Line:** [`apps/api/src/payouts/oneclick/client.ts:289-296`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/payouts/oneclick/client.ts#L289-L296)
- **Why It Matters:** `OneClickClient.prepareRoute` unconditionally throws `OneClickError("Till has never posted a 1Click quote...")`. If an operator configures `PAYOUT_PROVIDER=oneclick` in production without noticing this boundary, any seller attempting to create an endpoint in `intents` mode causes an unhandled 500 error / route rejection rather than a clean creation check failure explaining that standing deposit addresses are pending quote configuration.
- **Efficient One-Line Fix:** In `apps/api/src/services/endpoints.ts:82`, wrap `routePreparer.prepareRoute` in a `try/catch` block that transforms `OneClickError` into a structured creation check failure: `failed("deposit_address", error.message)`.

---

### 6. [USER DATA / FINANCIAL COMPLIANCE] Misleading Non-Custodial "Net Held" Accounting Calculation
- **File & Line:** [`apps/web/lib/overview.ts:88-98`](file:///home/ademola/orgs/accensa/accensa-till/apps/web/lib/overview.ts#L88-L98) & [`apps/web/components/domain/OverviewTotals.tsx:24`](file:///home/ademola/orgs/accensa/accensa-till/apps/web/components/domain/OverviewTotals.tsx#L24)
- **Why It Matters:** `netHeldBase` calculates `settled + adjusted - paidOut - refunded` per asset and displays it in a table column labeled `"Net held"`. Till is strictly non-custodial. For cross-chain Intents payouts, the settlement asset (e.g. NEAR USDC) and the payout asset (e.g. Arbitrum USDC) exist on separate rows in `ledger_entries`. This formula results in large positive balances on the input asset and negative balances on the destination asset, violating hard rule 9 (no cross-asset netting) and confusing sellers into thinking Till holds custodial balances.
- **Efficient One-Line Fix:** Remove `"Net held"` from `COLUMNS` in `OverviewTotals.tsx:24` and delete `netHeld` from `apps/web/lib/overview.ts:110`, reporting inflows and payouts side-by-side without cross-asset subtraction.

---

### 7. [USER DATA / DOS VULNERABILITY] Unbounded In-Memory Loading on Ledger CSV Export
- **File & Line:** [`apps/api/src/services/ledger.ts:127-143`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/services/ledger.ts#L127-L143) & [`apps/api/src/routes/export.ts:84-87`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/routes/export.ts#L84-L87)
- **Why It Matters:** `listLedgerForExport` executes a query selecting all `ledgerEntries` for a seller without any `LIMIT`, pagination, or stream chunking. All entries are loaded into Node memory as an array and concatenated into one CSV string in memory. For a seller with 100,000+ transactions, hitting `GET /api/export/ledger.csv` can exhaust the Node V8 heap and trigger an Out-Of-Memory (OOM) crash of the entire API process.
- **Efficient One-Line Fix:** In `apps/api/src/services/ledger.ts:141`, add `.limit(10_000)` or pipe a PostgreSQL streaming cursor directly to the HTTP response.

---

### 8. [INFRASTRUCTURE / RELIABILITY] In-Memory Sponsored Gas Budget & Rate Limit Resets on Restart
- **File & Line:** [`apps/api/src/gateway/limits.ts:40-62`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/gateway/limits.ts#L40-L62) & [`apps/api/src/gateway/route.ts:286-295`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/gateway/route.ts#L286-L295)
- **Why It Matters:** `limits.requests` and `limits.sponsoredGas` reside in volatile Node process memory. In containerized cloud deployments (auto-scaling, blue-green deploys, restarts on crash), budget counters reset to zero. An attacker can repeatedly drain sponsored gas by timing requests across restart boundaries.
- **Efficient One-Line Fix:** Persist `sponsoredGas.reserved` in a persistent key-value store or PostgreSQL row, or track gas directly against the on-chain relayer balance using `RELAYER_BALANCE_ALERT_BASE_UNITS`.

---

## Part 2: Ranked List of All Things Left to Do Before Launch

Ranked strictly: **Auth / Wallet Access & Keys first**, **Payments / Live Provider second**, **Reconciliation & Accounting third**, followed by **Deployment & Hackathon Submission**.

### 1. [AUTH / INFRASTRUCTURE] Fund Testnet Relayer & Payer Accounts and Provision Keys (Task A10 / GW-2)
- **File & Line:** [`accensa-till/.env.example:42-48`](file:///home/ademola/orgs/accensa/accensa-till/.env.example#L42-L48) & [`accensa-till/ROADMAP.md:132`](file:///home/ademola/orgs/accensa/accensa-till/ROADMAP.md#L132)
- **Why It Matters:** The API currently runs without `RELAYER_SECRET_KEY` and `DEMO_PAYER_SECRET_KEY`. Without funded testnet credentials, the gateway cannot sponsor transactions or submit NEP-366 delegate actions on `near:testnet`, returning 503 on every real payment attempt.
- **Efficient One-Line Fix:** Create and fund the NEAR testnet relayer and payer accounts and configure `RELAYER_ACCOUNT_ID`, `RELAYER_SECRET_KEY`, `DEMO_PAYER_ACCOUNT_ID`, and `DEMO_PAYER_SECRET_KEY` in environment secrets.

---

### 2. [PAYMENTS] Live 1Click Partner Key Request & Mainnet Quote Verification (Tasks A11, S3, S4, D7)
- **File & Line:** [`apps/api/src/payouts/oneclick/client.ts:25-32`](file:///home/ademola/orgs/accensa/accensa-till/apps/api/src/payouts/oneclick/client.ts#L25-L32) & [`ROADMAP.md:135, 172, 175, 333`](file:///home/ademola/orgs/accensa/accensa-till/ROADMAP.md#L135)
- **Why It Matters:** The payout leg is running on `PAYOUT_PROVIDER=mock`. To demonstrate genuine cross-chain settlement via NEAR Intents, a 1Click partner API key must be requested, and a live mainnet quote (`dry: true`) for a small stablecoin swap must be verified to measure real fees and quote structures.
- **Efficient One-Line Fix:** Request partner API key from ChainDefuser, execute a live `dry: true` quote query against `https://1click.chaindefuser.com/v0/quote`, and record verified parameters in `docs/spikes/S4.md`.

---

### 3. [PAYMENTS / ARCHITECTURE] Resolve Standing Deposit Address vs Direct Mode (Tasks S2, S7, B8, D8)
- **File & Line:** [`ROADMAP.md:169, 184, 187, 336`](file:///home/ademola/orgs/accensa/accensa-till/ROADMAP.md#L169) & [`docs/ARCHITECTURE.md:140-165`](file:///home/ademola/orgs/accensa/accensa-till/docs/ARCHITECTURE.md#L140-L165)
- **Why It Matters:** Spikes S2 and S7 remain marked blocked (`[!]`) because NEAR Intents does not support a testnet. The team must formally close B8 by deciding whether `direct` mode is the primary production path or whether standing deposit addresses can be obtained without manual per-payment quoting.
- **Efficient One-Line Fix:** In `ROADMAP.md`, update B8 and D8 to formally designate `direct` mode as P0 for launch with Intents as optional secondary routing.

---

### 4. [RECONCILIATION / RULES] Implement and Test Rules `INCOMPLETE_DEPOSIT` and `ORPHAN_DEPOSIT` (Tasks E11, E12 / LR-6)
- **File & Line:** [`ROADMAP.md:381, 384`](file:///home/ademola/orgs/accensa/accensa-till/ROADMAP.md#L381) & [`packages/core/src/reconcile/index.ts`](file:///home/ademola/orgs/accensa/accensa-till/packages/core/src/reconcile/index.ts)
- **Why It Matters:** PRD requirement LR-6 specifies P1 reconciliation rules for partial deposits (`INCOMPLETE_DEPOSIT`) and untracked deposits arriving at deposit addresses (`ORPHAN_DEPOSIT`). While P0 rules are complete, these two remain open tasks.
- **Efficient One-Line Fix:** Implement `incomplete-deposit.ts` and `orphan-deposit.ts` under `packages/core/src/reconcile/` matching the existing `ReconcileSnapshot` contract.

---

### 5. [DEPLOYMENT / INFRASTRUCTURE] Production Hosted Instance Warmed and Verified (Task G7 / DQ-4)
- **File & Line:** [`ROADMAP.md:514`](file:///home/ademola/orgs/accensa/accensa-till/ROADMAP.md#L514) & [`docker-compose.yml`](file:///home/ademola/orgs/accensa/accensa-till/docker-compose.yml)
- **Why It Matters:** Evaluation criteria (Execution & Completeness, 20%) require an accessible live deployment with PostgreSQL and the API running on public infrastructure (e.g., Fly.io, Render, Railway, or AWS) with SSL/TLS.
- **Efficient One-Line Fix:** Deploy Docker image to public cloud provider, seed initial endpoints, and verify `/healthz` responds 200 over HTTPS.

---

### 6. [SUBMISSION / DEMO] Record Narration, Publish X Post, and Submit Hackathon Payload (Tasks H1–H6)
- **File & Line:** [`ROADMAP.md:524-536`](file:///home/ademola/orgs/accensa/accensa-till/ROADMAP.md#L524) & [`scripts/submit-payload.ts`](file:///home/ademola/orgs/accensa/accensa-till/scripts/submit-payload.ts)
- **Why It Matters:** Final hackathon delivery requires a public video walkthrough with labelled simulated steps, an X announcement post with `#NEARHackathon`, and automated submission payload validation matching the Real-World Money and Agent Economy tracks before the deadline.
- **Efficient One-Line Fix:** Run `pnpm demo`, record final 3-minute video walkthrough, post to X, and run `pnpm tsx scripts/submit-payload.ts` to submit the entry.
