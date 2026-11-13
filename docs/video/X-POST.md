# The X post — copy for H2

The submission's `demoUrl` field wants a **public demo post** (`HACKATHON.md` §3), so
the first post in the thread is what a judge lands on and has to carry the story on
its own. That is why the video goes on post 1 and the remaining three posts answer
the two questions these tracks are judged on: *does money really move*, and *can you
prove it*.

Post 1 states the project was built at the NEAR hackathon and names both tracks,
which is what H2's Done-when asks for. Nothing below claims a mainnet payment, a
wallet signature or a real payout: the film badges every simulated step on screen,
and post 4 says the same thing in words.

Character counts are measured, not estimated: each fenced block's own text with the
trailing newlines stripped, which is how a composer counts it — internal
newlines kept, blank lines included, because a blank line is a character a reader
sees on screen. All
five blocks are under 280. They are **not** X's own counter, which was not
reachable from here.

## Thread (recommended)

### 1/ — attach `docs/video/walkthrough.mp4` to this post

```
Agents can't get a credit card, so they can't pay for your API.

Till is an x402 gateway on NEAR: the agent gets 402, pays in NEAR, and the seller's response is bought — only if the upstream returns 2xx.

Built at NEAR Hackathon 2026 — Real-World Money + Agent Economy.
```

269 characters.

### 2/ — the order the paid call runs in

```
The paid call has one order, and it's enforced: verify → guards → upstream → settle.

Settle only on a 2xx. A settle that fails is a strike. Two served-but-unsettled calls in 24h and the payer gets 403 before we burn any relayer gas.
```

233 characters.

### 3/ — the payout leg and the reconciliation

```
Money out goes through NEAR Intents (1Click) to a 6-decimal stablecoin on another chain, and every payment is matched to its payout swap by transaction hash only — never by amount, never by time.

Unmatched, short, or refunded opens a discrepancy with a suggested action.
```

271 characters.

### 4/ — what is real, what is mocked, and where the code is

```
Real vs mocked, stated on screen: the 402, the ledger and the rules are shipped code. The payout provider in this cut is the mock and the chain leg is a stub. No mainnet payment has been made.

Repo: github.com/accensa/accensa-till

#NEAR #x402 #buildonnear
```

257 characters.

## Single post (fallback, if a thread is not wanted)

Drops the honesty paragraph, which is the reason this is the fallback and not the
recommendation.

```
Agents can't get a credit card.

Till paywalls a seller's GET API with x402 on NEAR: 402, the agent pays, and the seller is served only on a 2xx upstream. Payouts route through NEAR Intents, reconciled by tx hash in an append-only ledger.

2-min demo below #NEAR #x402
```

268 characters.

Every number above is a claim about the block it sits under, so re-measure after
editing one: the count is `len` of each fenced block's text with its
trailing newlines stripped.

## What to upload

Measured from the committed bytes on 2026-11-13 (`stat` size; duration and track
types read out of the MP4 atoms — `mvhd` timescale/duration and each `hdlr` handler,
because `ffprobe` is not installed on that host):

| File | Bytes | Duration | Tracks |
|---|---|---|---|
| `walkthrough.mp4` | 11,942,103 (~11.9 MB) | 117.0 s | video + audio |
| `first-cut.mp4` | 9,291,224 (~9.3 MB) | 117.0 s | video only |

Upload **`walkthrough.mp4`** — it is the one with the narration. `first-cut.mp4` is
silent. 117 s is inside X's 2:20 video ceiling and ~11.9 MB is far below its size
limit, so no re-encode is needed.

The byte counts in `README.md`, `FIRST-CUT.md` and ROADMAP H1 quote **earlier
renders** of these two files (35.3 MB / 32.8 MB / 5.21 MB) and no longer match the
committed artefacts; the table above is what is in the tree today. Codec names,
frame rate and frame count in those documents were not re-measured here — only the
duration, the presence of an audio track, and the sizes.

## Posting notes

- Alt text on the video, so the post is readable without playing it: *"Terminal
  answering HTTP 402 Payment Required with a base64 x402 challenge, then a Postgres
  ledger showing a payment in on NEAR and a payout out on another chain."*
- The link lives in 4/ so post 1 carries no outbound link.
- The URL of post 1 is the `demoUrl` value in the application form
  (`HACKATHON.md` §3: "a public demo post").
- Publishing is H2 and its owner is a human with the account; nothing here posts
  anything by itself.
