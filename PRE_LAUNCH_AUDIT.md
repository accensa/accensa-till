# Pre-Launch Technical & Security Audit: Till Gateway

This document provides a ranked pre-launch engineering assessment of the **Till** repository on branch `checkpoint/f6-e10-handoff`. 

In accordance with strict production requirements, items touching **Auth, Payments, and User Data / Accounting** are ranked first, followed by infrastructure vulnerabilities, test harness blockers, and remaining pre-launch roadmap items.

---

## Part 1: High-Risk Items Already Implemented (Most Likely to Break in Production or Get Us Hacked)

### 1. [AUTH / DATA ACCESS] Session Cookie Scoped to `/api` Breaks Web Dashboard Navigation
- **File & Line:** [`apps/api/src/lib/session.ts:204`](file:///home/dell/accensa-till/apps/api/src/lib/session.ts#L204) (and [`apps/api/src/routes/auth.ts:249`](file:///home/dell/accensa-till/apps/api/src/routes/auth.ts#L249))
- **Why It Matters:** The session cookie is issued with `path: "/api"`. In standard web browsers, cookies with `Path=/api` are only attached to requests targeting `/api/*`. When an authenticated seller navigates to HTML dashboard routes (`/`, `/endpoints`, `/payments`, `/reconciliation`), the browser does **not** send the `till_session` cookie. Next.js server components calling `await cookies()` receive `undefined`, perpetually rendering `<SessionNotice kind="no-session" />` and locking the seller out of the UI.
- **Efficient One-Line Fix:** In `apps/api/src/lib/session.ts:204`, change `path: "/api"` to `path: "/"` (and in `apps/api/src/routes/auth.ts:249`, change `{ path: "/api", secure }` to `{ path: "/", secure }`).

---

### 2. [AUTH / SECURITY] Gateway Reverse Proxy Forwards Client Credentials to External Upstream URLs
- **File & Line:** [`apps/api/src/gateway/proxy.ts:60-62`](file:///home/dell/accensa-till/apps/api/src/gateway/proxy.ts#L60-L62)
- **Why It Matters:** `isForwardableHeader()` only strips hop-by-hop headers, `proxy-*`, and `x-payment`/`payment-signature`. It does **not** strip `cookie` or `authorization`. If a seller points an endpoint's `upstreamUrl` to a malicious or third-party server and an authenticated user visits `/r/:slug` in the same browser, their `till_session` cookie and any client `Authorization` headers are forwarded directly to the upstream server, enabling session hijacking and credential theft.
- **Efficient One-Line Fix:** In `apps/api/src/gateway/proxy.ts:61`, add `&& name !== "cookie" && name !== "authorization"` to the return predicate.

---

### 3. [PAYMENTS / INTEGRITY] Non-Atomic Settlement and Ledger Booking
- **File & Line:** [`apps/api/src/gateway/route.ts:754-781`](file:///home/dell/accensa-till/apps/api/src/gateway/route.ts#L754-L781)
- **Why It Matters:** The gateway transitions a payment to `settled` via `advancePayment(db, ...)` in one transaction, and then records the entry via `recordSettlement(db, ...)` in a separate transaction. If the Node process terminates, crashes (OOM, SIGTERM), or drops its database connection between lines 758 and 771, the payment remains committed as `settled` in `payments`, but no `payment_in` line is written to `ledger_entries`. This creates an unbooked payment discrepancy that violates ledger completeness and requires manual human adjustment.
- **Efficient One-Line Fix:** Wrap `advancePayment` and `recordSettlement` in a single `db.transaction(async (tx) => ...)` block so payment settlement and ledger booking commit atomically.

---

### 4. [USER DATA / REPORTING] Overview Snapshot Uses Default `READ COMMITTED` Isolation
- **File & Line:** [`apps/api/src/services/overview.ts:84`](file:///home/dell/accensa-till/apps/api/src/services/overview.ts#L84)
- **Why It Matters:** `readSellerOverview` executes four independent SELECT queries (`ledgerRows`, `transitRows`, `openRows`, `servedRows`) inside a single `db.transaction()`. Under PostgreSQL's default `READ COMMITTED` isolation level, each query takes a new MVCC snapshot at the start of each statement. Any payment settlement or swap state change committing between `ledgerRows` and `transitRows` causes money to be double-counted or omitted from both, displaying phantom or corrupted totals to the seller.
- **Efficient One-Line Fix:** Execute `await tx.execute(sql\`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY\`);` at line 85 of `apps/api/src/services/overview.ts`.

---

### 5. [USER DATA / MULTI-TENANCY] Unscoped Swap Subquery in Overview In-Transit Query
- **File & Line:** [`apps/api/src/services/overview.ts:112-117`](file:///home/dell/accensa-till/apps/api/src/services/overview.ts#L112-L117)
- **Why It Matters:** The `transitRows` query filters `payments` by the seller's endpoints, but the `notExists` subquery on `swaps` filters strictly on `swaps.originTxHash = payments.nearTxHash` without scoping `swaps` through `payout_routes` to the seller. In development, test environments, or in the presence of reused/colliding transaction hashes, another seller's swap row can suppress the current seller's in-transit calculation.
- **Efficient One-Line Fix:** Join `payoutRoutes` in `apps/api/src/services/overview.ts:115` and add `and(eq(payoutRoutes.sellerId, sellerId), eq(swaps.originTxHash, payments.nearTxHash), isNotNull(swaps.terminalAt))`.

---

### 6. [FINANCIAL / COMPLIANCE] Misleading Non-Custodial "Net Held" Accounting Calculation
- **File & Line:** [`apps/web/lib/overview.ts:88-98`](file:///home/dell/accensa-till/apps/web/lib/overview.ts#L88-L98) and [`apps/web/components/domain/OverviewTotals.tsx:30`](file:///home/dell/accensa-till/apps/web/components/domain/OverviewTotals.tsx#L30)
- **Why It Matters:** `netHeldBase` calculates `settled + adjusted - paidOut - refunded` per asset and displays it in a table column labeled `"Net held"`. Till is strictly non-custodial. For cross-chain Intents payouts, the settlement asset (e.g. NEAR USDC) and the payout asset (e.g. Arbitrum USDC) exist on separate rows in `ledger_entries`. This formula results in large positive balances on the input asset and negative balances on the destination asset, directly violating hard rule 9 (no cross-asset netting) and confusing sellers into thinking Till holds custodial funds.
- **Efficient One-Line Fix:** Delete the `netHeld` column from `apps/web/lib/overview.ts:98` and `OverviewTotals.tsx:30`, and present separate inflow and payout totals per asset without cross-asset subtraction.

---

### 7. [TEST / HARNESS] 14 Forbidden Non-Null Assertions in Overview Test Suite
- **File & Line:** [`apps/api/test/overview.test.ts:149, 158, 164, 175, 177, 178, 179, 329, 550`](file:///home/dell/accensa-till/apps/api/test/overview.test.ts#L149)
- **Why It Matters:** `pnpm lint` fails with 14 errors under Biome rule `lint/style/noNonNullAssertion`. CI runs `pnpm lint` as its first gate; until these are fixed, all PRs and pushes to `main` fail immediately.
- **Efficient One-Line Fix:** Replace `!` operators in `apps/api/test/overview.test.ts` with explicit destructuring guards (e.g., `if (!seller) throw new Error("missing seller");`).

---

### 8. [TEST / HARNESS] Stale 500 Error Detail Assertion in Web Client Test
- **File & Line:** [`apps/web/test/api-client.test.ts:782-784`](file:///home/dell/accensa-till/apps/web/test/api-client.test.ts#L782-L784)
- **Why It Matters:** The test asserts `refused.detail` contains `"/api/overview returned 500"`. Because `overview_unreadable` was recently added to `dashboardErrorSchema`, `api.overview` now parses the JSON error payload and returns `"An overview on record is not one Till can read, so none is shown."`, failing `pnpm test` across the workspace.
- **Efficient One-Line Fix:** In `apps/web/test/api-client.test.ts:783`, replace `"/api/overview returned 500"` with `"An overview on record is not one Till can read, so none is shown."`.

---

### 9. [TEST / HARNESS] Missing Offline Skip & DB Pool Closure in `overview.test.ts`
- **File & Line:** [`apps/api/test/overview.test.ts:31-70`](file:///home/dell/accensa-till/apps/api/test/overview.test.ts#L31-L70)
- **Why It Matters:** Unlike other database test files, `overview.test.ts` lacks `describe.skipIf(!handle)` and does not call `await client?.end()` in `afterAll`. Running `pnpm test` without an active PostgreSQL instance crashes the test runner, and running it against Postgres leaves unclosed pool connections.
- **Efficient One-Line Fix:** Wrap the test suite in `describe.skipIf(!hasDb)` and add `afterAll(async () => { await client?.end(); })`.

---

## Part 2: Ranked List of All Things Left to Do Before Launch

Ranked strictly: **Auth / Wallet Access first**, **Payments / Live Provider second**, **User Data / Reporting third**, followed by **Hackathon Submission**.

### 1. [AUTH] Browser Wallet Selector & NEP-413 Signature Prompt UI (Task F8 / UI-1)
- **File & Line:** [`apps/web/app/(auth)/sign-in/page.tsx:11-22`](file:///home/dell/accensa-till/apps/web/app/(auth)/sign-in/page.tsx#L11-L22) & [`ROADMAP.md:397`](file:///home/dell/accensa-till/ROADMAP.md#L397)
- **Why It Matters:** The sign-in page currently displays static copy stating that wallet integration is not implemented. Real browser sellers cannot authenticate or obtain a session cookie using browser extensions (Meteor, Here, MyNearWallet).
- **Efficient One-Line Fix:** Implement `@near-wallet-selector/core` and `@near-wallet-selector/modal-ui-js` on `/sign-in` to sign the nonce challenge from `/api/auth/nonce` and submit it to `/api/auth/verify`.

---

### 2. [AUTH / INFRASTRUCTURE] Provision Testnet Accounts & Funded Relayer Key (Task A10 / GW-2)
- **File & Line:** [`ROADMAP.md:132`](file:///home/dell/accensa-till/ROADMAP.md#L132) & [`.env.example:22-26`](file:///home/dell/accensa-till/.env.example#L22-L26)
- **Why It Matters:** The gateway cannot sponsor gas or submit NEP-366 delegate actions on `near:testnet` in a deployed environment without `RELAYER_ACCOUNT_ID` and `RELAYER_SECRET_KEY` holding real testnet gas.
- **Efficient One-Line Fix:** Create and fund the NEAR testnet relayer account and set `RELAYER_ACCOUNT_ID` and `RELAYER_SECRET_KEY` in environment secrets.

---

### 3. [PAYMENTS] Live 1Click Quote Endpoint Verification vs Mock Provider (Tasks S3, S4, D3, D7)
- **File & Line:** [`apps/api/src/payouts/oneclick/client.ts:1-120`](file:///home/dell/accensa-till/apps/api/src/payouts/oneclick/client.ts#L1-L120) & [`ROADMAP.md:321, 333`](file:///home/dell/accensa-till/ROADMAP.md#L321)
- **Why It Matters:** The payout leg is running entirely on `PAYOUT_PROVIDER=mock`. To demonstrate real cross-chain settlement, 1Click's live quote API (`dry: true`) and the 0.2% fee structure must be validated on mainnet without exceeding the authorized spend cap.
- **Efficient One-Line Fix:** Test live 1Click quote endpoint with `dry: true` against `https://1click.chaindefuser.com` and document verified parameters in `docs/spikes/S4.md`.

---

### 4. [USER DATA / RECONCILIATION] Complete Evidence & Test Validation for `PAYOUT_SHORTFALL` (Task E10 / LR-6)
- **File & Line:** [`packages/core/src/reconcile/payout-shortfall.ts:1-36`](file:///home/dell/accensa-till/packages/core/src/reconcile/payout-shortfall.ts#L1-L36) & [`ROADMAP.md:378`](file:///home/dell/accensa-till/ROADMAP.md#L378)
- **Why It Matters:** Cross-chain swaps can suffer severe slippage. While the rule code is drafted, Task E10 remains marked in-progress (`[~]`) without recorded evidence, leaving slippage detection unverified in the release build.
- **Efficient One-Line Fix:** Run integration fixtures against `payoutShortfall`, record execution output in `ROADMAP.md:380`, and update task status to `[x]`.

---

### 5. [USER DATA / EXPORT] Implement Streaming Ledger CSV Export (Task F7 / LR-7)
- **File & Line:** [`apps/api/src/routes/export.ts:1`](file:///home/dell/accensa-till/apps/api/src/routes/export.ts#L1) & [`ROADMAP.md:457`](file:///home/dell/accensa-till/ROADMAP.md#L457)
- **Why It Matters:** PRD requirement LR-7 mandates a downloadable CSV export of all `ledger_entries` in human-readable decimal units for seller tax and accounting compliance; the route currently contains only a stub comment.
- **Efficient One-Line Fix:** Mount `GET /api/export/ledger.csv` in `apps/api/src/routes/export.ts` streaming `ledger_entries` formatted via `displayAmount`.

---

### 6. [SUBMISSION / DELIVERY] Demo Film Narration, Final Check & Payload Validation (Tasks H1, H4, H6)
- **File & Line:** [`ROADMAP.md:512, 521, 527`](file:///home/dell/accensa-till/ROADMAP.md#L512) & [`docs/PRD.md:280-320`](file:///home/dell/accensa-till/docs/PRD.md#L280-L320)
- **Why It Matters:** Hackathon judging requires an approved public video link, verified repository checks, and an automated submission payload matching exact Hackathon schemas (`tracks`, `requestId`, `nearAddress`).
- **Efficient One-Line Fix:** Run `pnpm demo`, record final demo narration, validate JSON payload with `scripts/submit-payload.ts`, and submit before 13 Nov evening deadline.
