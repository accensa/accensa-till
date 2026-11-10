# First cut — `first-cut.mp4`

The film exists and it was rendered in this session, against the re-captured
evidence and the two fixes the earlier cut was waiting on (`9f137f4` F10, `d9477f1`
F11). What follows is what was run, what it printed, and what a human still has to
do before it is the submission file.

## The artefact

`docs/video/first-cut.mp4`, measured with `ffprobe` rather than described:

```
$ ffprobe -v error -show_entries format=duration,size \
    -show_entries stream=width,height,r_frame_rate,nb_frames,codec_name,pix_fmt \
    docs/video/first-cut.mp4
codec_name=h264      width=1920  height=1080  r_frame_rate=30/1
nb_frames=3510       pix_fmt=yuv420p
duration=117.000000  size=11523980
```

16:9, 1920 × 1080, 30 fps, **117.000 s**, 3 510 frames, H.264 `yuv420p`,
one video stream and no audio track (the human records the voice last), one hard
cut per shot, no transitions. 117 s is under the 120 s ceiling `docs/PRD.md` §8
sets ("target 2 minutes"), and the remaining 3 s is the slack a real read with
pauses needs.

## What was run

```
$ which ffmpeg && ffmpeg -version | head -1
/usr/bin/ffmpeg
ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers

$ bash docs/video/render.sh
render.sh: shot 01  7s  text  badge=no
render.sh: shot 02  8s  png   badge=yes
render.sh: shot 03  9s  text  badge=no
render.sh: shot 04  9s  text  badge=yes
render.sh: shot 05  8s  text  badge=yes
render.sh: shot 06  11s  text  badge=yes
render.sh: shot 07  8s  text  badge=yes
render.sh: shot 08  9s  png   badge=yes
render.sh: shot 09  9s  text  badge=yes
render.sh: shot 10  9s  text  badge=yes
render.sh: shot 11  11s  text  badge=yes
render.sh: shot 12  11s  png   badge=yes
render.sh: shot 13  8s  text  badge=no
render.sh: wrote /home/gamp/Orgs/ACCENSA/accensa-till/docs/video/first-cut.mp4  \
  (13 shots, 117s at 30 fps, 1920x1080)

$ time bash docs/video/render.sh > /dev/null
real    1m17.995s
```

Shot 02 is `png` now: the endpoints frame replaced the seed terminal frame, so three
of the thirteen shots are screenshots and ten are terminal frames.

The render was then run a second time and the output is byte-identical:

```
$ sha256sum docs/video/first-cut.mp4      # run 1
769986ace63e212cafc341b2e25a18bb6af4b496167ada399a3dbf19bbd99819
$ bash docs/video/render.sh && sha256sum docs/video/first-cut.mp4   # run 2
769986ace63e212cafc341b2e25a18bb6af4b496167ada399a3dbf19bbd99819
```

The determinism claim is about the pipeline, and it holds on this content: two runs
of the current sources, same bytes. (The previous cut — old captures, seed terminal
frame in shot 02, portrait screenshots — was itself rendered three times to the same
hash `bef2ab8f…`; that hash belongs to a file that no longer exists, so it is not a
check on this one.)

`render.sh` needs ffmpeg with `drawtext` (libfreetype) and libx264, `python3`
(3.12.3 here) and the Ubuntu DejaVu fonts. It checks for all of them and exits with
a named reason instead of half-rendering; nothing in it is untested, because both
runs above completed on the machine it runs on.

## How it is put together

Three files, no hand-copying:

- [`NARRATION.md`](NARRATION.md) is the authority. Each `### Shot NN` block carries
  `DURATION:` and `NARRATION:`; `render.sh` parses them, so the burned-in subtitle
  **is** the spoken sentence and the two cannot drift. Edit narration there and
  re-render.
- The shot table inside `render.sh` (`docs/video/build/shots.tsv`, regenerated on
  every run) maps each shot id to its source file in `CAPTURES/`, its on-screen
  title, and the SIMULATED badge's wording.
- `CAPTURES/` holds the evidence. Every frame is either a verbatim excerpt of a
  capture (`CAPTURES/frames/fNN-*.txt`, each with the one `$ command` line that
  produced it) or one of the three browser screenshots. `build/` is disposable
  output; delete it, the render rebuilds it.

Because the sources are captures, no number or timestamp on screen was typed by
hand. Shot 07's ledger rows carry `2026-11-10 09:57:04.292812+00` because `psql`
printed that; shot 12's `opened Nov 10, 2026, 10:57 AM` is what the shipped page
rendered; the strike payer is `strike-8ae02f1c.testnet` because that is the run
label `scripts/demo.ts` printed on this database.

## Real and simulated, shot by shot

| Shot | On screen | Badge | Why |
|---|---|---|---|
| 01 | Title: the README's own definition sentence | no | a card, not a claim |
| 02 | screenshot `/endpoints`: the seeded endpoint card, `Live`, over the create form | yes | the card's payout destination is `… via mock-deposit-1`, the deposit address the mock provider made up |
| 03 | live `curl -i` → `402 Payment Required` + base64 header | no | shipped gateway code answering for real; nothing upstream was dialled |
| 04 | the same header decoded | yes | `payTo mock-deposit-1` is not payable |
| 05 | `pnpm demo` header + step 2 | yes | the chain leg is a loopback JSON-RPC stub; no wallet signed anything |
| 06 | `pnpm demo` step 3 | yes | `PAYOUT_PROVIDER=mock`; `raw.simulated=true` is the mock's own marker |
| 07 | `ledger_entries` read back from Postgres | yes | real rows, written by shipped writers, describing mock-provider money |
| 08 | screenshot `/payments` | yes | data from the simulated run; the page is shipped |
| 09 | `pnpm simulate refund` | yes | the script's header says `SIMULATED run` |
| 10 | `pnpm demo` step 4 | yes | the refund is scripted; the rule that opened it is shipped |
| 11 | `pnpm demo` step 6 | yes | settlement scripted to fail; guards, ledger and rule shipped |
| 12 | screenshot `/reconciliation` | yes | discrepancies from the simulated run |
| 13 | Disclosure card, quoted from README | no | this card *is* the disclosure |

Ten of thirteen shots carry the badge, and the narration says the same thing out
loud in those shots rather than leaving it to the corner of the frame. Nothing in
the film claims a paid request, a chain acceptance or a real payout — the demo
transcript it shows ends `PRD section 8 ran and every assertion held.` with exit 0
and 44 `ok` lines, which is what it actually is.

## What is missing from this cut

1. **No voice.** By design: the MP4 is silent so the read can be recorded against
   the captions, and the durations in `NARRATION.md` are the contract the reader
   works to (295 words over 117 s, 2.52 words/second, counted by splitting the
   thirteen `NARRATION:` lines on whitespace).

That is the only thing missing that a human still has to supply. The four gaps this
section carried are closed, and what closed them is in the tree:

2. **Closed — the `/endpoints` shot exists.** PRD 8.1 asks for "a seller with a live
   paywalled endpoint", and the screen that shows it used to answer `500`:
   `endpointDtoSchema.upstreamUrl` required `https://`
   (`packages/core/src/schemas/endpoint.ts`) while `scripts/seed.ts` stores
   `http://127.0.0.1:4100/data` for `pnpm demo` to dial, so the read threw on a row
   the shipped seed had written. Repo commit `9f137f4` (F10) split the read DTO from
   the submit rule — POST and PATCH still refuse `http://`, and the dial-time
   loopback refusal is what keeps Till from calling it — and the new
   `apps/api/test/endpoints.test.ts` case failed with the 500 before the change.
   Shot 02 is now `CAPTURES/06-dashboard-endpoints.png`, the seeded card as the
   shipped page renders it. Hand-editing the row for a pretty screenshot would have
   made the frame a fake; fixing the read did not.
3. **Closed — the dashboard is styled.** The served CSS used to be 33,847 bytes with
   an empty `@layer utilities { @tailwind utilities; }`: Tailwind v4's utility
   generation never ran. Repo commit `d9477f1` (F11) added the approved
   `@tailwindcss/postcss` dev dependency and `apps/web/postcss.config.mjs`; the
   stylesheet is now 8,632 bytes carrying 57 utility rules, and every `className`
   extracted from `apps/web` is in it. What that buys is honest: these are
   hand-written components with a deliberately small class set, so the pages are
   styled, not designed.
4. **Closed — no dev badge in the pixels.** The compose `web` service still runs
   `pnpm --filter @till/web dev` (`docker-compose.yml:51`), which is what painted the
   round Next logo and the red "1 Issue" pill into the old frames. The three frames
   in the cut come from a production build served by `next start` on host port 3002
   instead, so no dev indicator exists to paint. Verified by looking at
   `build/frames/02.png`, `08.png` and `12.png`.
5. **Closed — the screenshots are 1920 × 1080**, shot through the DevTools protocol
   with the viewport overridden, so they sit in the film's 16:9 band at their own
   aspect ratio instead of being upscaled from 806 × 801.

## What a human does next

1. Record the voice from `NARRATION.md` (117 s of read; the reading notes at the
   bottom of that file say which shots to slow down for) and mux it:
   `ffmpeg -i docs/video/first-cut.mp4 -i voice.m4a -c:v copy -shortest final.mp4`.
   Optional: burn the SIMULATED badges out only if the wording changed — they come
   from the shot table, not the film.
2. **Watch the whole thing once, then approve.** Nothing is submitted until that
   happens; `docs/video/` itself was committed on 2026-11-10, with the captures,
   `render.sh` and this file.
3. If the dashboard is re-shot, follow the recipe in `README.md` (production build
   with `API_ORIGIN` set, `next start` on 3002, DevTools capture at 1920 × 1080) and
   keep the filenames — the shot table refers to them by name, and `render.sh` reads
   the durations and captions from `NARRATION.md`.
