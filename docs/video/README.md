# `docs/video/` — the H1 demo film

Everything needed to produce, verify and re-make the two-minute demo video for
`docs/PRD.md` section 8. The directory is committed, so the evidence and the film
travel with the repository; the human still watches the cut and decides whether it
is the submission file.

| File | What it is |
|---|---|
| [`SHOTLIST.md`](SHOTLIST.md) | 13 shots, 117 s, each naming the capture file it comes from, plus the PRD §8 coverage map and the known gaps |
| [`NARRATION.md`](NARRATION.md) | The spoken script, one block per shot, sized 2.5 words/second. `render.sh` reads durations and subtitles out of this file |
| [`X-POST.md`](X-POST.md) | The copy for the submission post (H2): a four-post thread with the film on post 1, a single-post fallback, and the measured facts about which MP4 to upload |
| [`x-cards/`](x-cards/) | The three 16:9 cards the thread attaches (posts 2–4): `cards.html` + `cards.css` in the film's own tokens, `render-cards.mjs` (headless Chrome over CDP, no npm dependency) which refuses to write a card that overflows, falls back to a system font, sets type below 10 px or uses a colour outside the palette, and the committed `x-post-2/3/4.png` at 2400 × 1350 |
| [`CAPTURES/`](CAPTURES/) | The raw evidence: five text captures, one `psql` read, three browser screenshots, and `frames/` — the verbatim excerpts the film renders |
| [`render-v2.py`](render-v2.py) | Renders the Web3 styled presentation deck (`stage.html`) into `first-cut.mp4` via headless Chrome CDP |
| [`generate-voiceover.py`](generate-voiceover.py) | Synthesizes ElevenLabs voiceover narration per shot and muxes it into `walkthrough.mp4` |
| `walkthrough.mp4` | The complete 2-minute demo with ElevenLabs voiceover: 117.000 s, 1920 × 1080, 30 fps, H.264 + AAC stereo |
| `first-cut.mp4` | The silent visual cut: 117.000 s, 1920 × 1080, 30 fps |
| `build/` | Generated per run (the shot table, the wrapped text files, the 13 stills). Disposable |

## Re-running the render

It needs no stack and no network — only the files in `CAPTURES/`:

```sh
bash docs/video/render.sh          # 1 m 18 s wall clock here; rewrites build/ and first-cut.mp4
```

Requirements (all present on the machine this was made on): ffmpeg 6.1.1 built with
libfreetype and libx264, python3, `/usr/share/fonts/truetype/dejavu/`. The script
checks each and refuses with a named reason rather than half-rendering. Two runs on
the current sources produced the same sha256 (see FIRST-CUT.md), so re-rendering
after a narration edit is safe.

## Re-running the capture

The evidence comes from the docker compose stack, not from the shared test database
(`postgres://…:55432`, container `till-pg-verify`) that other agents use.

This time the stack was **recreated from nothing** before the run, so that `pnpm
seed` printed its first-run output instead of "already seeded" and every capture
carries the same fresh database:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"   # node 22 + pnpm

docker compose down -v                 # drops the volume: this is what deleted the
                                       # old UUIDs, timestamps and ledger rows
docker compose up -d --build           # image rebuilt from this tree
until curl -sf http://localhost:3000/healthz >/dev/null; do sleep 1; done   # before anything else
```

`down -v` is the deliberate choice it looks like: it deletes the database the
previous screenshots and the ledger read depend on, and another agent may still
want it. If the stack is already up and you only need to re-run the demo, use it as
it stands and accept `pnpm seed`'s "already seeded" line.

Then, in order, each command's output going to the named file. The header lines in
the existing captures (command, container, finish time, exit code) are part of the
contract — keep them.

```sh
docker compose exec -T api pnpm seed            > CAPTURES/01-seed.txt
curl -sS -i http://localhost:3000/r/demo        > CAPTURES/02-curl-402-raw.txt
# decode the header, and prove it equals the body before writing 03:
#   grep -i '^payment-required:' 02-… | cut -d' ' -f2 | tr -d '\r\n' | base64 -d
                                          > CAPTURES/03-payment-required-decoded.txt
docker compose exec -T api pnpm demo    > CAPTURES/04-demo-transcript.txt   # exit 0, 44 ok lines
docker compose exec -T api pnpm simulate refund > CAPTURES/05-simulate-refund.txt
docker compose exec -T postgres psql -U till -d till \
  -c "select kind, amount, asset, created_at from ledger_entries order by created_at;" \
                                          > CAPTURES/09-ledger-entries.txt
```

`pnpm demo` and `pnpm seed` are idempotent-safe to re-run on the same volume. Every
capture above and the three screenshots below it were written in one pass against
one database, so they agree: re-run one and re-run them all.

### The dashboard screenshots

Port 3001 is the compose `web` service running `next dev`, which paints the Next.js
dev indicator into every frame and serves the dev pipeline. The three frames in
`CAPTURES/` are from a **production build** of the same code instead:

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"

API_ORIGIN=http://localhost:3000 pnpm --filter @till/web build   # baked in at build time
pnpm --filter @till/web exec next start -p 3002                  # next start: no dev badge
```

`/endpoints`, `/payments` and `/reconciliation` are server components: they read
`cookies()` and forward it to the api themselves, so the session cookie has to be on
the **document** request. There is no browser sign-in yet (F8 needs a wallet
extension, which this machine's browser tooling does not have), so each shot was
taken with a session cookie minted in the shape the shipped code accepts
(`apps/api/src/lib/session.ts`: HKDF-SHA256 with the public salt
`till-signed-cookies` and info `till-session-cookie`, then an HS256 JWS):

```sh
# /tmp/mint-session.mjs — throwaway. Derives the key the shipped way, signs a
# {sub: sellerId, acct: "demo-seller.testnet", iat, exp, jti} payload, prints the JWS.
# It reads SESSION_SECRET from the api container's own environment and never prints it.
docker compose exec -T -w /app/apps/api api node - <sellerId> demo-seller.testnet \
  < /tmp/mint-session.mjs > /tmp/till_session.txt    # 0600, /tmp only, never committed
```

`-w /app/apps/api` is required, not decoration: `jose` resolves from the api
package's own `node_modules`, so the identical stdin script fails to import from the
image's default workdir. The seller id is the first UUID on the `seeded` line of
`CAPTURES/01-seed.txt`.

The screenshots came from a throwaway script, also in `/tmp`, that starts the
installed headless Chrome and drives it over the DevTools HTTP + WebSocket endpoint
— `/json/new`, `Emulation.setDeviceMetricsOverride` at 1920 × 1080,
`Network.setCookie`, `Page.navigate`, `Page.captureScreenshot` — writing each PNG
straight into `CAPTURES/` under the filenames the shot table names. It set
`till_session` with `path=/` (the shipped cookie is `path=/api`, which is right for
the app but never sent for a document request). No npm package, no browser
automation library, nothing added to any `package.json`.

The mint script and the shoot script live in `/tmp` and must never be committed. The
minted token belongs in no file under `docs/video/`, and neither script prints
`SESSION_SECRET`.

## What a human still has to do

The two code questions that used to head this list are **answered and shipped**:
`9f137f4` (F10) made `GET /api/endpoints` read the row the seed writes instead of
throwing `500` on it, and `d9477f1` (F11) added the approved `@tailwindcss/postcss`
dev dependency plus `apps/web/postcss.config.mjs` so the dashboard's utility classes
compile. The frames were re-shot against those two commits, so the `/endpoints` shot
is in the film (shot 02). What is left:

1. **Record the voice** against `NARRATION.md` (117 s of read, 3 s of slack) and mux
   it onto the cut.
2. **Watch the whole film once**, then approve or send it back. Judging happens
   against this file, so nothing may be presented as real that is not: every
   simulated moment is badged on screen and said out loud, and there has never been
   a mainnet payment.
3. **Watch it end to end** and approve or send it back. `docs/video/` is committed
   as of 2026-11-10 — the captures, the scripts, the film and the measurements — and
   remember the video is only half of the submission: the X post is the artefact
   (`HACKATHON.md` §2).

## Rules for whoever re-runs this

- Captures are verbatim. If a command fails, capture the failure — that is what the
  old `06-dashboard-endpoints-500-error.png` was, before F10 fixed the 500 and the
  file was replaced by the page rendering. Never hand-write a frame, never edit a
  number, never re-time a caption to something that was not printed.
- No new dependency in any `package.json`, and no browser automation library in the
  repo; the screenshots came from a throwaway DevTools-protocol script in `/tmp`, the
  film from ffmpeg.
- Never print, log or commit `SESSION_SECRET`, `RELAYER_SECRET_KEY` or
  `ONECLICK_JWT`, and never create or edit a real `.env`.
- `export PATH="$HOME/.nvm/versions/node/v22.23.4/bin:$PATH"` before any pnpm or
  node command.
