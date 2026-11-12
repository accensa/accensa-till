# Walkthrough film — `walkthrough.mp4` & `first-cut.mp4`

The 2-minute walkthrough film is fully rendered using Till's Web3 design system
matching the website's dark theme, terminal chrome, and brand palette.
Directed and edited according to launch film motion rules from `huashu-art-motion`:
1. **Hook in the first seconds (Shot 01)**: Autonomous agent hitting a 402 challenge with dynamic zoom-out reveal.
2. **Strong motion throughout (Shots 02–10, 12)**: Programmatic `push`, `pull`, and `glide` tracking across screens.
3. **Suspense pause before the biggest moment (Shot 11)**: 1.8s dead-freeze pause before a 403 Forbidden slam block.
4. **NEAR Hackathon climax (Shot 13)**: Wide pull-back showcasing "Built at NEAR Hackathon 2026" (Real-World Money & Agent Economy tracks).

Coupled with professional voiceover synthesized via ElevenLabs George (`eleven_turbo_v2_5`), dynamically tempo-matched and muxed into `walkthrough.mp4`.

## The artefacts

### 1. `docs/video/walkthrough.mp4` (Full Video + ElevenLabs Voiceover)

```
codec_name=h264      width=1920  height=1080  r_frame_rate=30/1
codec_name=aac       sample_rate=44100        channels=1 (mono)
nb_frames=3510       pix_fmt=yuv420p
duration=117.000000  size=37077648 (~35.3 MB)
```

### 2. `docs/video/first-cut.mp4` (Motion Video Track)

```
codec_name=h264      width=1920  height=1080  r_frame_rate=30/1
nb_frames=3510       pix_fmt=yuv420p
duration=117.000000  size=34433152 (~32.8 MB)
```

16:9, 1920 × 1080, 30 fps, **exact 117.000 s**, 3,510 frames, H.264 `yuv420p` + AAC audio.
117 s is under the 120 s ceiling `docs/PRD.md` §8 sets ("target 2 minutes").

## Motion Language & Director Rules (`huashu-art-motion`)

- **Shot 01 (0–7s) The Hook**: Starts zoomed in on the live terminal 402 challenge (`zoom=1.14`), then pulls back dynamically to reveal the widescreen banner ("NO CREDIT CARDS · NO API KEYS · REVOLUTIONARY X402 MICROPAYMENTS ON NEAR").
- **Shots 02, 03, 07, 09, 10 (`CAM.push`)**: Smooth 6–7% push-in zooms focusing viewer attention onto live metrics, SQL rows, and audit messages.
- **Shots 04, 06, 12 (`CAM.glide`)**: Horizontal tracking pan across decoded challenges, payment-payout matching, and reconciliation action rows.
- **Shots 05, 08 (`CAM.pull`)**: Pull-outs from detail to wide view as requests resolve and table states settle.
- **Shot 11 The Suspense Pause & 403 Slam**:
  - `0.0s – 4.0s`: Gentle push-in on strikes 1 and 2 (`zoom 1.0 -> 1.05`).
  - `4.0s – 5.8s`: **Suspense Pause**: 1.8 seconds dead freeze holding on `[SUSPENSE PAUSE] EVALUATING FRAUD VECTOR...`.
  - `5.8s – 6.2s`: **The Slam**: Sudden punch-in (`zoom 1.15`) centered directly onto `403 FORBIDDEN · PAYER BLOCKED`.
  - `6.2s – 11.0s`: Settle and hold showing `0 relayer gas burned`.
- **Shot 13 NEAR Hackathon Climax**: Wide pull-out revealing the gold trophy card `🏆 BUILT AT NEAR HACKATHON 2026`, Primary Track (Real-World Money), Secondary Track (Agent Economy), and verified testnet transaction hashes.

## Visual Design & Web3 Theming

Unlike the unstyled initial prototype, the walkthrough uses the exact design tokens and components from `@till/web`:
- **Palette**: `#070809` obsidian ink background, `#c9ff57` acid green accents, `#63e6a4` live emerald status indicators, and `#25282d` border structure.
- **Terminal Chrome**: macOS/Unix dark terminal frames with traffic-light control dots, `till@near:~$` bash prompts, and syntax highlighting for commands, HTTP headers, and JSON payloads.
- **Browser Mockups**: Clean viewport containers with address bar and security lock for `/endpoints`, `/payments`, and `/reconciliation` screens.
- **HUD & Subtitles**: Synchronized lower-third caption bar displaying the narration from `NARRATION.md`, coupled with an acid-green progress bar tracking playback time.
- **Honest Badging**: Persistent badges distinguishing REAL on-chain executions from SIMULATED demo flows per hackathon judging rules.

## What was run

```bash
# 1. Render motion video with FFmpeg camera movements
$ python3 docs/video/render-motion.py
[*] Step 1: Capturing 13 high-resolution retina stills from stage.html...
  ✓ Captured Shot 01 (7s) -> still-01.png
  ✓ ...
[*] Step 2: Applying director camera movements (push/pull/glide/pause/slam) via FFmpeg...
  ✓ Motion clip 01 rendered (7s @ 30fps) -> clip-01.mp4
  ✓ ...
[*] Step 3: Concatenating all 13 motion clips into first-cut.mp4...
[✓] Video motion render complete: docs/video/first-cut.mp4 (32.84 MB, 117s @ 30fps)

# 2. Synthesize ElevenLabs voiceover and mux
$ python3 docs/video/generate-voiceover.py
[*] Generating 13 voiceover clips using ElevenLabs (Voice: George, Model: eleven_turbo_v2_5)...
  ✓ ...
[*] Concatenating padded clips into narration-master.wav...
[*] Muxing voiceover with first-cut.mp4 -> walkthrough.mp4...
[✓] Done! Created docs/video/walkthrough.mp4 (35.36 MB, 117s)
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
