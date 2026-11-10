# Shot list — Till demo film (H1)

Contract: `docs/PRD.md` section 8 ("Demo script (target 2 minutes)", six steps).
Every number, address and timestamp below was printed by a command run in this
session on 2026-11-10 against the docker compose stack (`till-postgres-1`,
`till-api-1`; api host port 3000, Postgres 5432) on a volume recreated fresh with
`docker compose down -v`, so `pnpm seed` printed its first-run output. The three
dashboard frames come from the same stack's api on 3000 served through a production
`next start` on host port 3002, not from the compose `web` dev server on 3001. The
raw evidence is in [`CAPTURES/`](CAPTURES/); how to re-capture it is in
[`README.md`](README.md).

Target length: **117 s** (hard ceiling 120 s, `docs/PRD.md` §8 "target 2 minutes").
Order is the PRD order. No shot is invented: each one names the file it comes from.

| # | PRD §8 step | On screen | Footage source | SIMULATED badge | Duration |
|---|---|---|---|---|---|
| 01 | — (open) | "Seller-side back-office for x402 payments on NEAR." — README line 3, quoted verbatim — plus "Built at NEAR HACKATHON" | Generated frame from `CAPTURES/frames/f01-title.txt` | no | 7 s |
| 02 | 8.1 seller with a live paywalled endpoint and an empty ledger | Dashboard `/endpoints`: the seeded endpoint card — "Demo prices endpoint (seeded by scripts/seed.ts)", `Live`, payment link `http://localhost:3000/r/demo`, price `1 usdc.testnet`, network `near:testnet`, upstream `http://127.0.0.1:4100/data`, payout mode `intents`, payout destination `0x742d35cc662dd0c4f8e3f1b0a4b1e6a4d9d01f2c via mock-deposit-1` — above the create-an-endpoint form | Browser screenshot `CAPTURES/06-dashboard-endpoints.png` (1920 × 1080, seeded row, minted session). The card is the row `docker compose exec -T api pnpm seed` wrote: seller `01a1c4e3-6fe2-7000-9b80-7ddb3985cb08`, endpoint `01a1c4e3-7020-7000-9cf7-f442af462b6b` (`CAPTURES/01-seed.txt`); its terminal frame `CAPTURES/frames/f02-seed.txt` is still the verbatim excerpt of that capture, but it is no longer in the cut | **yes** — the destination line's `mock-deposit-1` is the deposit address the mock provider made up, and the caption says so | 8 s |
| 03 | 8.2 the agent hits the endpoint and receives a 402 | `curl -i http://localhost:3000/r/demo` → `HTTP/1.1 402 Payment Required` + the base64 `PAYMENT-REQUIRED` header (464 characters, wrapped for legibility) and the JSON body it matches | Live terminal capture → `CAPTURES/frames/f03-curl-402.txt` (from `CAPTURES/02-curl-402-raw.txt`, captured 2026-11-10T09:56:47Z) | no — the advertisement is shipped gateway code answering for real | 9 s |
| 04 | 8.2 (same step, the terms) | The same header base64-decoded: `scheme exact`, `network near:testnet`, `amount 1000000`, `asset usdc.testnet`, `payTo mock-deposit-1`, `maxTimeoutSeconds 60` | Terminal capture → `CAPTURES/frames/f04-decoded.txt` (from `CAPTURES/03-payment-required-decoded.txt`) | **yes** — `payTo mock-deposit-1` is the mock provider's invented address, and the caption says so | 9 s |
| 05 | 8.2 …pays and gets the data | `pnpm demo` run header (what is scripted: the loopback chain stub, the scripted upstream, the run label `run 8ae02f1c`) + step 2 block: `payer demo-agent-payer.testnet on near:testnet`, `response 200`, `ok it is settled` | Terminal capture → `CAPTURES/frames/f05-demo-step2.txt` (from `CAPTURES/04-demo-transcript.txt`, finished 2026-11-10T09:57:04Z, exit 0) | **yes** — the chain leg is a loopback JSON-RPC stub; no wallet signed a real transaction | 8 s |
| 06 | 8.3 the payment shows, then the payout arrives on another chain | `pnpm demo` step 3 block: one `payment_in`, no `payout_out` yet, the polled swap matched by transaction hash, `raw.simulated=true`, one `payout_out` on `eth/usdc` | Terminal capture → `CAPTURES/frames/f06-demo-step3.txt` (from `CAPTURES/04-demo-transcript.txt`) | **yes** — `PAYOUT_PROVIDER=mock`; the swap status is scripted, `raw.simulated` is the mock's own marker | 11 s |
| 07 | 8.3 (the ledger behind it) | `ledger_entries` as Postgres returns it: `payment_in 1000000 usdc.testnet` / `payout_out 1000000 usdc` / `payment_in` / `refund_in`, all four booked 2026-11-10 09:57:04 UTC (`.292812`, `.333157`, `.452377`, `.462876`) | Terminal capture → `CAPTURES/frames/f07b-ledger.txt` (from `CAPTURES/09-ledger-entries.txt`, read 2026-11-10T09:57:27Z) | **yes** — the rows are real rows written by the shipped ledger writers; the money they describe is mock-provider money | 8 s |
| 08 | 8.3 (the seller's screen) | Dashboard `/payments`: four rows all dated Nov 10, 2026, 10:57 AM — `demo-agent-payer.testnet` and `demo-refund-payer.testnet` `Settled — the payer's transfer is on chain`, two `strike-8ae02f1c.testnet` `Served without settling — the seller kept the answer, Till never got the money` — with `NearBlocks` links on the settled pair | Browser screenshot `CAPTURES/07-dashboard-payments.png` (1920 × 1080, the demo run's rows, minted session) | **yes** — data from the simulated run; the screen itself is the shipped page | 9 s |
| 09 | 8.4 a simulated refund | `docker compose exec -T api pnpm simulate refund`: `states refunded (terminal=true)`, `amounts in=1000000 out=none refunded=1000000`, `origin mock-tx-refund raw.simulated=true`, `finding PAYOUT_REFUNDED (high)` | Terminal capture → `CAPTURES/frames/f08-simulate-refund.txt` (from `CAPTURES/05-simulate-refund.txt`) | **yes** — the script's own header says `SIMULATED run`, and the caption says it out loud | 9 s |
| 10 | 8.5 reconciliation raises `PAYOUT_REFUNDED` with its explanation and suggested action | `pnpm demo` step 4 block: `ok reconciliation opens PAYOUT_REFUNDED for this swap`, then the shipped explanation ("The payout swap to the destination chain was refunded, so the money did not arrive where the seller asked for it.") and action ("Confirm the destination address and asset are supported, then re-route the payout or keep it on NEAR.") | Terminal capture → `CAPTURES/frames/f09-demo-step4.txt` | **yes** — the refund is scripted | 9 s |
| 11 | 8.6 the strike case (the distinctive moment) | `pnpm demo` step 6 block: `strike-8ae02f1c.testnet`, `ok both attempts are served with 200 even though settlement failed`, `ok the third is refused 403 payer_blocked, not another 402`, the script's own note `Two strikes in 24 hours block the third request (GW-7), and that is the number PRD 8.6 states: one strike would block a payer whose single failure was the gateway's own.`, `ok both strikes are stored as served_unsettled`, `ok and neither of them books revenue`, `ok reconciliation opens SERVED_NOT_SETTLED for each of them`, and the shipped explanation/action | Terminal capture → `CAPTURES/frames/f10-demo-step6.txt` | **yes** — settlement was scripted to fail; the guards, the ledger and the rule are shipped code | 11 s |
| 12 | 8.5 + 8.6 (close on the reconciliation screen) | Dashboard `/reconciliation`: three open items — two `SERVED_NOT_SETTLED` and one `PAYOUT_REFUNDED`, each with its explanation, `Suggested:` line and `Resolve` action — plus "Payers you are holding" showing `strike-8ae02f1c.testnet`, 2 unpaid serves, opened Nov 10, 2026, 10:57 AM, with `Clear` | Browser screenshot `CAPTURES/08-dashboard-reconciliation.png` (1920 × 1080) | **yes** — the discrepancies come from the simulated run; the rule that raised them is shipped | 11 s |
| 13 | — (close) | "What is real, and what is not", quoted from README: one unproven headline — that a chain accepted a payment. `PAYOUT_PROVIDER=mock`, no wallet has paid, no mainnet transaction | Generated frame from `CAPTURES/frames/f12-close.txt` | no — this card is the disclosure | 8 s |

Total: 7 + 8 + 9 + 9 + 8 + 11 + 8 + 9 + 9 + 9 + 11 + 11 + 8 = **117 s** (295 words of
narration at 2.5 words per second; see `NARRATION.md`, which is the source these
durations were sized from).

PRD §8 coverage: 8.1 → shot 02. 8.2 → 03, 04, 05. 8.3 → 06, 07, 08. 8.4 → 09.
8.5 → 10, and the closing screen 12. 8.6 → 11, and the closing screen 12.
Nothing in the six steps is left unfilmed, and nothing is filmed that is not in them.

## Wording note: PRD §8.6 and the shipped threshold

`docs/PRD.md` §8.6 now states the shipped rule — "a buyer with an empty account is
served twice without settling, and those two strikes are what blocks the third
attempt, with `SERVED_NOT_SETTLED` shown" — which is what
`apps/api/src/services/strikes.ts` implements (`STRIKE_THRESHOLD = 2`,
`STRIKE_WINDOW_HOURS = 24`). The correction landed in repo commit `8720b67` (task
G5), and the film follows the same line. Two things the step still bundles, which
the footage keeps separate:

- An **empty** account is never served. `pnpm demo` step 5 shows it answered `402`
  with `insufficient_funds`, the seller's upstream never dialled, no payment row
  written. That is the first half of PRD 8.6's sentence, and it is a refusal, not a
  serve.
- A payer is **blocked after two** `served_unsettled` payments in 24 hours, which is
  what shot 11 films, and the demo prints the reason itself: `Two strikes in 24
  hours block the third request (GW-7), and that is the number PRD 8.6 states: one
  strike would block a payer whose single failure was the gateway's own.`

Shots 11 and 12 are written against that shipped two-strike rule, so the film needs
no re-recording when the PRD is read aloud next to it.

## What `HACKATHON.md` requires that this shot list alone does not cover

Read from the pinned `HACKATHON.md` in this tree (re-pinned 2026-11-09):

- **No length limit is stated for the video.** The only guidance is "Show one
  complete moment… Skip long intros, architecture slides, and setup" (§2). 110 s of
  six PRD steps fits that; there is no first slide of architecture and no setup
  footage beyond the one seed line, which is the evidence for PRD 8.1.
- **"built at NEAR HACKATHON" is a requirement on the X post, not on the film**
  (§2, and the submission rules). Shot 01 carries the phrase anyway, because the
  post embeds the film and it costs one line.
- **The post, not the video, is the submission artefact**: the human publishes it,
  it must tag `@NEARProtocol` and `#NEARHackathon` (`@NearLegion`, `@NearBuilders`
  optional), lead with the user problem, explain NEAR's role concretely rather than
  "powered by NEAR", and link the repo plus a next step (H2, human).
- **Q-012**: a local-only demo is acceptable *because* the README is reproducible
  and the post carries a video; screenshots alone are not enough if judges cannot
  open the demo. That is why this deliverable ships the raw transcripts next to the
  frames, and why `docs/video/README.md` gives the exact commands.
- **Q-017**: Claude Code and Codex screen every submission before the human jury,
  so anything the film claims must be reproducible from the README. Nothing in the
  narration may claim a paid request, a chain acceptance or a real payout.
- **A hosted demo** is "a plus", to be kept up to 2026-11-18 (ideally 11-25).
  Nothing in this plan hosts anything — that is a human decision with a cost, and
  it is not in H1.
- **Deadline**: development ends 2026-11-14T23:59Z; the repository must be public
  by then (H3) and the submission goes in with the post link (H4).

## Known gaps in the footage (not gaps in the plan)

The three gaps this section carried are closed, each by a change that was measured
rather than assumed. They stay here as the record of what the first frames were
missing and what fixed it.

1. **Closed — the `/endpoints` screen rendered, so shot 02 is the endpoint card.**
   `GET /api/endpoints` answered `500` on the seeded row because the read DTO shared
   the write DTO's `httpsUrlSchema`: `endpointDtoSchema.upstreamUrl` refused the
   `http://127.0.0.1:4100/data` that `scripts/seed.ts` writes on purpose for
   `pnpm demo` to dial, so `toDto` threw on a row the shipped seed had just written.
   Repo commit `9f137f4` (task **F10**) split the two: the read accepts a loopback
   upstream, POST and PATCH still refuse `http://`, and the money path is untouched
   because `resolveUpstreamTarget`'s loopback and private-address refusal at dial
   time is what stops Till dialling it. The test that pins it failed with the 500
   before the change and passes after (`apps/api/test/endpoints.test.ts`). The old
   failure screenshot `06-dashboard-endpoints-500-error.png` is gone; what is in the
   film now is `CAPTURES/06-dashboard-endpoints.png` showing the seeded card.
2. **Closed — the dashboard is styled.** Tailwind v4's utility generation had never
   actually run: Next used its own built-in PostCSS set, which has no Tailwind, so
   `@import "tailwindcss"` shipped as preflight plus `@theme` variables and every
   utility class in the components reached the browser as nothing. Repo commit
   `d9477f1` (task **F11**) added the one approved dev dependency
   `@tailwindcss/postcss` and `apps/web/postcss.config.mjs`. Measured: the served
   stylesheet went from 33,847 bytes with zero utility rules to 8,632 bytes with 57
   utility rules, and every `className` extracted from `apps/web` is present in it.
   Honest about what that buys: the pages are hand-written components carrying a
   deliberately small set of classes, so they are styled, not designed.
3. **Closed — 1920 × 1080 and no dev badge.** The frames are now shot against a
   production build served by `next start` on host port 3002, with the api origin
   baked in at build time (`API_ORIGIN` set to the compose api on port 3000),
   captured at 1920 × 1080 through the DevTools protocol, so they fill the 16:9 band
   instead of being upscaled from 806 × 801, and none of the three carries the
   Next.js dev indicator or the red "1 Issue" pill. The compose `web` service still
   runs `next dev` (`docker-compose.yml:51`), so anyone who re-shoots against port
   3001 gets the badge back — shoot against `next start`, as README.md now says.

What is still not in the film, as notes rather than gaps:

- **The overview screen `/` is not in the film.** It is the page a seller signs into
  and it carries the relayer balance and the "mock last answered …" warning that all
  three frames show in their header; no PRD §8 step asks for it, so no shot does.
- **The seed's own terminal lines are no longer on screen.** Shot 02 used to be
  `pnpm seed`'s output; it is now the page that output produces, which is the
  stronger evidence for PRD 8.1. The verbatim excerpt
  (`CAPTURES/frames/f02-seed.txt`, seller
  `01a1c4e3-6fe2-7000-9b80-7ddb3985cb08`, endpoint
  `01a1c4e3-7020-7000-9cf7-f442af462b6b`) stays in `CAPTURES/frames/` as the
  evidence behind the card, and it is one row in the shot table away from being back
  in the cut.
- **No mainnet anything.** That is not a footage gap and no re-shoot closes it; it is
  what shot 13 says out loud.
