# PRD: Till (working name)

Seller-side back-office for x402 payments on NEAR.

- Status: draft v2.1 (red-team revision; see section 14 and `ARCHITECTURE.md` section 14)
- Live progress, task IDs and changelog: `ROADMAP.md` at the repo root. It must be updated in every contribution.
- Hackathon: NEAR Hackathon, development window 1 to 14 Nov 2026, submission deadline 14 Nov 2026 23:59 UTC
- Tracks: Real-World Money (primary), Agent Economy (secondary)

---

## 1. Summary

AI agents can pay for HTTP resources with x402, and NEAR Intents can settle those payments into the asset and chain a seller wants. The buyer side is well served by existing tooling. The seller side is not: someone who sells API calls to agents cannot see what they were paid, confirm that every payment became a payout, or learn when one silently failed.

Till is that missing layer. A seller points Till at an existing API, sets a price and a payout destination, and gets a paywall, payouts routed through NEAR Intents, and a ledger that reconciles every payment against every payout and raises an alert when they disagree.

## 2. Problem

A seller taking x402 payments with an Intents-routed payout has a chain of events that can break at several points:

1. The buyer's payment verifies but settlement fails after the API already served the response.
2. The payment settles but the cross-chain swap is refunded, stuck or short.
3. Funds land at a payout address that no known payment explains.
4. Small payments fall below swap minimums or lose most of their value to fees.

Today the seller finds out by checking a block explorer, the Intents explorer and their own logs by hand. Money that moves without an audit trail is not usable by a normal company, which is what the Real-World Money track asks builders to fix.

## 3. Users

**Primary: the API seller.** A solo developer or small team selling API access, data or compute to agents. Comfortable with HTTP and JSON, not a crypto operations specialist. Wants to be paid in a stablecoin on a chain they already use and wants to know the books are right without reading transactions.

**Secondary: the finance-minded operator.** Someone at a small company who needs a ledger they can export and explain to an accountant.

**Present in the demo, not a product user: the buyer agent.** Any agent that can pay x402 on NEAR. Till ships no buyer SDK.

## 4. Goals and non-goals

### Goals

- G1. A seller goes from sign-in to a live paywalled endpoint in under five minutes.
- G2. Every payment is traceable from the buyer's NEAR transaction to the seller's payout on the destination chain.
- G3. Any mismatch in that trail is detected and explained in plain language.
- G4. The whole system runs from a fresh clone with one command and no external keys.

### Non-goals (v1)

- A buyer or payer SDK.
- A new facilitator protocol or any custom smart contract.
- Non-GET methods, request bodies and streaming responses. A non-`GET` on a paid path
  answers `405` with `Allow: GET` and no `PAYMENT-REQUIRED` header, before the
  endpoint row is read and before any payment is verified (GW-2, C20): a method this
  product does not serve is a method nobody can pay for. `HEAD` counts as a non-`GET`
  exactly because the proxy would otherwise dial the seller with `method: "GET"`,
  settle real money and drop the body.
- Payout assets other than 6-decimal stablecoins. That is the scope, not a gate: `STABLECOIN_DECIMALS = 6` in `packages/core/src/money.ts` is only the default `parseAmount` and `formatAmount` use when the caller passes no decimals, and nobody ever passes a different number (`displayAmount` in `apps/web/lib/format.ts` defaults to 6 and no call site overrides it). No schema and no creation check (`checkEndpointCreation`) refuses an asset with a different count, so an 18-decimal asset is accepted and priced 10^12 off rather than refused.
- Native NEAR as a payment asset (not supported by the underlying scheme).
- Revenue splits, invoicing, tax reporting, fiat ramps and multi-user teams.
- More than one in-flight paid request per payer (see GW-6).

## 5. Core user flow

**Seller setup**

1. Seller signs in by signing a message with their NEAR wallet.
2. Seller creates an endpoint: upstream URL, price in USDC, description.
3. Seller chooses a payout destination: chain, stablecoin and address, or "keep as USDC on NEAR".
4. Till checks the seller's account can receive the token, shows the destination address back for confirmation, and returns a public gateway URL.

**Buyer payment (what the demo agent does)**

1. Agent calls the gateway URL and receives `402 Payment Required`.
2. Agent signs a payment authorization and retries.
3. Till verifies, calls the seller's upstream, settles only if the upstream returned 2xx, and returns the response with a receipt header.

**Seller operations**

1. Dashboard shows the payment with its NEAR transaction hash.
2. The payout appears with its Intents status and destination-chain transaction.
3. Reconciliation shows the pair as matched, or an open discrepancy with a reason and a suggested next step.

## 6. Requirements

P0 must ship. P1 ships if P0 is solid. Nothing below P1 is planned.

### 6.1 Gateway and payments

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| GW-1 | P0 | Unpaid requests get an x402 v2 `402` with requirements | `curl` returns 402 with price, asset, network and pay-to **in the base64 `PAYMENT-REQUIRED` response header**; C2 read this off the shipped client, whose body path fires only for `x402Version: 1`, so a body-only 402 is a 402 no v2 wallet can pay. Till sends the header and the same JSON in the body |
| GW-2 | P0 | Verify, proxy to upstream, then settle | Paid call returns the upstream body; settlement hash stored; only `GET` is served — `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS` answer `405` with `Allow: GET` before the endpoint read, the limiter, `verify` and `settle`, so nothing dials the seller and no ledger line is written (C20) |
| GW-3 | P0 | Settle only when upstream returns 2xx; 4xx passes through, 5xx and timeouts return 502, none are charged | Tests for 2xx, 4xx, 5xx and timeout show the expected ledger result |
| GW-4 | P0 | Replay protection; an `abandoned` payment may be retried with the same authorization, a settled one gets 409 with its receipt | Tests cover both cases |
| GW-5 | P0 | Pre-serve guards: authorization expiry must outlast the upstream timeout, payer balance must cover the price | Tests reject short-lived and underfunded authorizations before any upstream call |
| GW-6 | P0 | One in-flight paid request per payer; others get 429 with `Retry-After` | Concurrent test shows exactly one proceeds |
| GW-7 | P0 | Payers with two `served_unsettled` payments in 24 hours are blocked until cleared | Test shows the third attempt rejected and a seller clearing the block |
| GW-8 | P0 | SSRF protection: validated-address connect, no redirects, no self-loop, https only outside dev, size and time limits | Unit tests for private ranges, redirect and rebinding cases |
| GW-9 | P1 | Short-lived response cache so a paid-but-undelivered request can be retried (5 minutes, up to 256 KB) | Retry with the same authorization returns the cached response |
| GW-10 | P1 | Global sponsored-gas cap and an in-memory request limiter | Exceeding either returns 429 and logs |

### 6.2 Endpoints and payouts

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| PO-1 | P0 | Create an endpoint with a payout route (chain, stablecoin, address) | Stored; address format validated per chain and confirmed by the seller |
| PO-2 | P0 | Endpoint creation checks seller account token registration and price floor | Inactive with a clear message if either check fails |
| PO-3 | P0 | Payments route through Intents to the chosen destination | A real mainnet payment arrives on the destination chain in the chosen stablecoin |
| PO-4 | P0 | Each swap tracked to a terminal state; terminal states are sticky | Status shown in the dashboard; a simulated regression is ignored |
| PO-5 | P0 | Mock provider with the same interface | Full flow runs offline with `PAYOUT_PROVIDER=mock` |
| PO-6 | P1 | `direct` mode: payTo is the seller's own account, no swap | Seller receives USDC directly; ledger still reconciles |
| PO-7 | P1 | Price or route changes apply to new payments only | Earlier payments keep their original amount and route |

`direct` mode is P1 if spike S1 succeeds. If S1 fails, `direct` becomes P0 and Intents payouts become the stretch goal (see risks).

### 6.3 Ledger and reconciliation

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| LR-1 | P0 | Append-only per-asset event ledger | A database trigger rejects `UPDATE` and `DELETE` |
| LR-2 | P0 | Reconciliation matches payments to swaps by transaction hash | No amount-and-time matching anywhere in the code |
| LR-3 | P0 | The five P0 rules in section 7 | Each has a fixture test that produces the discrepancy |
| LR-4 | P0 | Every discrepancy has a plain-language explanation and suggested action | Visible in the UI |
| LR-5 | P0 | At most one open discrepancy per cause, including those without a payment or swap id | Test inserts the same cause twice with a null id and gets one row |
| LR-6 | P1 | The three P1 rules in section 7 | Fixture tests |
| LR-7 | P1 | CSV export in decimal units | Opens cleanly in a spreadsheet |

### 6.4 Dashboard

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| UI-1 | P0 | Wallet sign-in with a signed session cookie | No secrets in the browser |
| UI-2 | P0 | Endpoint create and list | Live within seconds |
| UI-3 | P0 | Payments table with status, explorer links, and a flag on self-payments | Every row links to its NEAR transaction |
| UI-4 | P0 | Reconciliation view, open items by severity then age | Open items first |
| UI-5 | P0 | Header shows relayer balance and last successful provider poll | Warns below configured thresholds |
| UI-6 | P1 | Seller overview with totals by asset and state | Totals equal the ledger |

### 6.5 Delivery quality

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| DQ-1 | P0 | `docker compose up` then `pnpm demo` completes with seeded data and mock payouts | Fresh clone, no keys, non-zero exit on any failed assertion |
| DQ-2 | P0 | README states exactly what is real and what is mocked, and lists known limitations | A reviewer cannot be misled |
| DQ-3 | P0 | Public repository and demo post on X with video | Both links ready before the deadline |
| DQ-4 | P1 | Live hosted instance, warmed before submission | URL reachable during judging |
| DQ-5 | P0 | `ROADMAP.md` is updated in every contribution by every contributor, human or agent | CI runs `pnpm roadmap:check` and fails when a change leaves `ROADMAP.md` untouched or its progress block stale; the pull request template and the README repeat the rule |

## 7. Reconciliation rules

| Code | Tier | Condition | Severity |
|---|---|---|---|
| SERVED_NOT_SETTLED | P0 | Upstream returned 2xx but settlement did not complete | Critical |
| PAYOUT_REFUNDED | P0 | Swap ended in a refund | High |
| PAYOUT_FAILED | P0 | Swap ended in a failed state | High |
| PAYOUT_STUCK | P0 | Swap in a processing state, or unknown state, beyond the window | Medium |
| PAYMENT_NOT_SWEPT | P0 | Payment settled and no swap activity within the window | High |
| PAYOUT_SHORTFALL | P1 | Output below input by more than the configured tolerance (basis points) | High |
| INCOMPLETE_DEPOSIT | P1 | Deposit smaller than required | Medium |
| ORPHAN_DEPOSIT | P1 | Funds arrived with no matching payment | Medium |

Severities are starting guesses. Windows and tolerance are environment config.

## 8. Demo script (target 2 minutes)

1. A seller with a live paywalled endpoint and an empty ledger.
2. The demo agent hits the endpoint, receives a 402, pays and gets the data.
3. The dashboard shows the payment, then the payout arriving on another chain as a stablecoin.
4. A simulated refund, labelled as simulated on screen and in the README.
5. Reconciliation raises `PAYOUT_REFUNDED` with its explanation and suggested action.
6. A second simulated case: a buyer with an empty account is served twice without settling, and those two strikes are what blocks the third attempt, with `SERVED_NOT_SETTLED` shown.

Step 6 is the most distinctive moment in the demo because it shows a failure mode other tooling does not surface.

## 9. Success criteria

- The automated screen passes: the project runs from the README and does what it says.
- A reviewer can follow one payment end to end in under a minute.
- At least one real mainnet payment is routed through Intents and shown in the video, with its fee and net amount visible.
- Every P0 requirement has a passing test or a documented manual check.

## 10. Constraints

- Only code written after the hackathon announcement counts. Reuse design knowledge from earlier work, not earlier code.
- The repository must be public by submission.
- Native NEAR cannot be a payment asset, and recipients need token storage registration.
- Plan to submit on the evening of 13 Nov.

## 11. Delivery plan

This table is the plan at a glance. The live version, with task IDs, gates and status, is `ROADMAP.md`; if the two disagree, `ROADMAP.md` wins and this table should be corrected.

| Dates (Nov 2026) | Focus | Exit condition |
|---|---|---|
| 2 to 3 | Spikes S1 to S7 and repo skeleton | Payout design decided from evidence, price floor measured |
| 4 to 6 | Gateway, guards, facilitator, payments | Paid call works end to end on testnet; guards tested |
| 7 to 9 | Payout provider, polling, ledger | Real mainnet payment lands on another chain |
| 10 to 11 | Reconciliation (P0 rules) and dashboard | Five P0 rules covered by tests |
| 12 | Hardening, mock mode, one-command demo, P1 only if time | Fresh clone runs without keys |
| 13 | README, video, X post, submission | Form submitted |
| 14 | Buffer only | Nothing new is built |

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Intents deposit address cannot receive the NEP-141 payment | **Partly answered, and the stated consequence has been adopted** | Blocks the headline | Spike S1 closed on its fallback branch (2026-11-03): the x402 facilitator refuses an unregistered `payTo` for any token with storage management, and nothing registers it for us, so the risk is real and not measurable on testnet. A17 then chose the mock payout leg, which means **"`direct` mode plus reconciliation becomes the product" is now the design**, labelled as simulated on screen (DQ-2) rather than a fallback we hope to avoid |
| Micropayments fall below swap minimums or fees dominate | Likely | Payout feature looks impractical | Spike S7; enforce a price floor; prefer a standing address |
| Matching by transaction hash is impossible because deposits lack hashes | Unknown | Reconciliation weakens | Spike S2; drop the standing design if hashes are missing |
| 1Click API key delay | Ruled out 2026-11-03: `HACKATHON.md` Q-006 says a partner JWT is optional, so no payout path waits on approval | No mainnet payouts | Ask for the key only for the fee; the fee number itself is contested (0.2% versus +25 bps, A11) |
| Relayer drained by abusive payers | Medium, and now concrete: settlement is sponsored by our own relayer account holding a **full-access** key (`FacilitatorRelayerConfig` in `@x402/near`) | Loss of gas funds, or loss of the account | Balance re-check, one in flight, strikes, low relayer balance, `MAX_SPONSORED_GAS` bounded at 3e13 (A18) |
| Concurrent agent payments fail on nonce ordering | **Measured, and it is worse than Likely: the scheme does not stop it.** S6 ran it — two delegates from one payer both verify and both submit, and the loser fails on-chain *after* the seller served | Lost calls for parallel agents, paid for | One in flight per payer, enforced by the gateway before serving (GW-6, `docs/spikes/S6.md`) |
| Another entrant builds the same idea | Unknown | Weakens originality | Search before building; differentiate on the guard and reconciliation depth |
| Scope exceeds the team | High if solo | Half-finished features | P0 only until all P0 pass |

## 13. Open questions

1. Standing deposit address or per-payment address, and do deposits report origin hashes?
2. What is the smallest payment that survives provider minimums and fees?
3. How long does partner API key approval take? **Answered in part 2026-11-03:** `HACKATHON.md` Q-006 says a partner JWT is not required and the no-key fee is 0.2%, so this is now a cost question rather than a blocker.
4. Is any testnet available for the payout leg? **Answered 2026-11-03:** no. `HACKATHON.md` Q-007 states none exists or is planned, so the payout leg is mainnet only, with tiny amounts and `dry: true` quotes, and it waits on the human's explicit approval (roadmap A17).
5. Which USDC contract id applies on NEAR mainnet?
6. How many people are building? If one, stop at P0 and the P1 items marked first in each table.

## 14. Red team review (summary)

Full tables are in `ARCHITECTURE.md` section 14. What changed in this version:

**Would break, now handled**
- Verification does not hold funds, so serving before settlement is exploitable. Added expiry and balance guards, one in flight per payer, and strike-based blocking (GW-5 to GW-7).
- Discrepancy deduplication failed for rows with a null id. Fixed with a dedupe key and partial unique index (LR-5).
- Matching by amount and time could hide real mismatches. Matching is now by transaction hash only (LR-2).
- Micropayment economics were unexamined. Added spike S7 and a price floor (PO-2).
- Edits could rewrite history. Payments snapshot price and route (PO-7).

**Edge cases added**
- 4xx and redirect behavior (GW-3), paid-but-undelivered retries (GW-4, GW-9), unregistered seller accounts (PO-2), wrong-chain addresses (PO-1), self-payments (UI-3), restart recovery.

**Cut as overengineered**
- Job queue library and separate worker, three workspace packages, browser test framework, sessions table, revenue splits, POST support, a second payout sub-design, an admin health page, and three of the eight P0 rules.
