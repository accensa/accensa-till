# Narration — Till demo film (H1)

One numbered block per shot, in [`SHOTLIST.md`](SHOTLIST.md) order. Sized at
2.5 words per second against each shot's duration; the whole read is **295 words
over 117 s** — counted, not estimated: the thirteen `NARRATION:` lines below, split
on whitespace, 295 tokens against 117 s of `DURATION:` (2.52 words per second),
which leaves headroom under the 120 s ceiling for the pauses a human recorder puts
in.

Rules the text keeps:

- Where a step is mocked or simulated, the narration **says it out loud**, not only
  on screen. Shots 2, 4, 5, 6, 7, 8, 9, 10, 11 and 12 carry a burned-in SIMULATED
  badge as well.
- No claim that a chain accepted a payment, that a wallet signed, or that money
  arrived anywhere. The closing shot is the disclosure.
- Step six is narrated against the **shipped** rule (two `served_unsettled`
  payments in 24 hours, `STRIKE_THRESHOLD = 2` in
  `apps/api/src/services/strikes.ts`), not against the old PRD §8.6 sentence.
- Every number spoken is a number printed in `CAPTURES/`.

`render.sh` parses these blocks: the `### Shot NN` line, the `DURATION:` line and
the `NARRATION:` line are the caption track, so edit here and re-render.

---

### Shot 01 — Title card
DURATION: 7

NARRATION: Till is a seller-side back-office for x402 payments on NEAR. That sentence is the README's own definition.

### Shot 02 — PRD 8.1, the seller and the empty ledger
DURATION: 8

NARRATION: Step one. A seller with one paywalled endpoint and an empty ledger. This is the dashboard the seeded row produces.

### Shot 03 — PRD 8.2, the unpaid request
DURATION: 9

NARRATION: An unpaid request gets a 402. This is a live curl against the running gateway, and the answer carries a payment challenge.

### Shot 04 — PRD 8.2, the challenge decoded
DURATION: 9

NARRATION: Decoded, it names the six fields a payer signs against. The deposit address is the mock's invention, and the caption says so.

### Shot 05 — PRD 8.2, paid and served
DURATION: 8

NARRATION: Now the buyer pays. This leg is simulated: the chain is a loopback stub, so no wallet signed a real transaction.

### Shot 06 — PRD 8.3, payment in, payout out
DURATION: 11

NARRATION: Step three, the money. One payment in, nothing out yet. The payout provider is the mock, and its row says simulated. The match is by transaction hash.

### Shot 07 — PRD 8.3, the ledger rows
DURATION: 8

NARRATION: The ledger as Postgres returns it. Payment in on NEAR, payout out on Ethereum, then a payment and a refund.

### Shot 08 — PRD 8.3, the seller's payments screen
DURATION: 9

NARRATION: The seller's payments screen. Four rows: two settled, two served without settling. The data is simulated; the page is the shipped dashboard.

### Shot 09 — PRD 8.4, the simulated refund
DURATION: 9

NARRATION: Step four is a simulated refund, and the script says so in its own header. No network, no keys. The swap reports refunded.

### Shot 10 — PRD 8.5, PAYOUT_REFUNDED with its explanation
DURATION: 9

NARRATION: Reconciliation opens it with a sentence, not a code. The payout was refunded, so the money did not arrive where the seller asked.

### Shot 11 — PRD 8.6, served without settling, then blocked
DURATION: 11

NARRATION: Step six is the distinctive moment. Two serves while settlement fails, both stored as served without settling, and neither books revenue. The third request is refused 403, payer blocked.

### Shot 12 — Close on the reconciliation screen
DURATION: 11

NARRATION: The reconciliation screen is where a seller acts. Three open items, each with an explanation, a suggested action and a resolve button. Below, the held payer and its clear action.

### Shot 13 — Disclosure card
DURATION: 8

NARRATION: No wallet has paid this gateway, and no mainnet transaction has been sent. The payout provider is the mock.

---

## On-screen captions (what `render.sh` burns in)

The caption under each frame is the same sentence as the narration, wrapped to the
frame; the badge in the top-right corner is the SIMULATED label, and it names the
specific thing that is scripted rather than saying "demo":

| Shot | Badge | Badge wording on screen |
|---|---|---|
| 01 | no | — |
| 02 | yes | `SIMULATED: the deposit address is the mock provider's` |
| 03 | no | — (the challenge itself is shipped gateway code answering for real) |
| 04 | yes | `SIMULATED: payTo is the mock's invented deposit address` |
| 05 | yes | `SIMULATED: the chain leg is a loopback stub` |
| 06 | yes | `SIMULATED: PAYOUT_PROVIDER=mock` |
| 07 | yes | `SIMULATED: these rows describe mock-provider money` |
| 08 | yes | `SIMULATED: data from the simulated run` |
| 09 | yes | `SIMULATED: scripted refund` |
| 10 | yes | `SIMULATED: scripted refund` |
| 11 | yes | `SIMULATED: settlement scripted to fail` |
| 12 | yes | `SIMULATED: data from the simulated run` |
| 13 | no | — (this card is the disclosure) |

## Reading notes for the human recorder

- Shots 6, 11 and 12 are the ones worth slowing down for; the rest are steady.
- Say "four-oh-two" and "forty-three" rather than reading the digits, and say
  `PAYOUT_REFUNDED` as "payout refunded" and `SERVED_NOT_SETTLED` as "served not
  settled" — they are spelled on screen.
- 117 s of read at 2.5 words/second leaves about 3 s of slack inside the 120 s
  ceiling. Do not add sentences; cut one if the pacing runs long.
- No voice exists in `first-cut.mp4`. The captions are the only text track.
