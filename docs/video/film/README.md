# Till — the film

One continuous camera move through the paid-call order, the ledger and the payout route:
104 seconds, 1920×1080 at 60 fps, narration, original score, burned-in captions.

| Artefact | What it is |
|---|---|
| `till-film.mp4` | The cut: 104.2 s, 6 255 frames, H.264 High + AAC 48 kHz stereo, 30 MB, sha256 `fec618ae…` |
| `storyboard.jpg` | One frame every two seconds, 4×13 grid, straight out of the encode |
| `stills/` | Eight key frames at full resolution |
| `script.json` | The eleven spoken blocks and their on-screen headlines |
| `film.html`, `film.css`, `film.js` | The picture. Every pixel is a pure function of `t` — there is no animation library and no timeline UI |
| `build_voice.py`, `align_words.py` | Narration through the ElevenLabs CLI, then forced alignment for per-word cues |
| `build_timeline.py` | Scene boundaries on a 120 BPM eighth-note grid, cues anchored to the word the narrator says |
| `make_audio.py` | The score and the sound design, synthesized from oscillators and noise (no samples) |
| `mix_audio.py` | Places voiceover and SFX on the timeline and masters the mix |
| `render.mjs`, `render_all.sh`, `inspect.mjs` | Headless Chrome → JPEG frames → ffmpeg, plus the layout checker |

`build/` is generated and ignored (`build/` is in the root `.gitignore`).

## Rebuilding it

The renderer has no npm dependency: it drives an already-running Chrome over the
DevTools Protocol and shells out to a static ffmpeg.

```bash
cd docs/video/film

# 1 · narration (needs an authenticated `elevenlabs` CLI session)
python3 build_voice.py          # script.json → build/vo/*.wav + build/vo.json
python3 align_words.py          # → build/words.json + build/align/
python3 build_timeline.py       # → build/timeline.json, build/timeline.js

# 2 · score and sound design
python3 make_audio.py           # → build/audio/*.wav
python3 mix_audio.py            # → build/audio/mix.wav (48 kHz stereo, −14 LUFS)

# 3 · picture
./render_all.sh                 # Chrome → build/frames → till-film.mp4
```

`render_all.sh` takes `FPS` from the environment (default 60). Fonts are embedded as
base64 in `assets/fonts/embedded.css` so a render on another machine is not a different
typeface.

## What the film claims

Every on-screen claim is one the repository can back:

- The settlement receipt in *Verified. Served. Settled.* and *Real settlement* is the
  measured NEAR testnet transaction from `docs/spikes/S6.md`
  (`42XtdGR1RoDne3JX2RT6XDfhoVqw9M1orZJHLmHBTJne`), and the frame says `LIVE · NEAR TESTNET`
  beside it.
- The payout scene states both halves in the picture, not in a footer: the 1Click client,
  polling and swap matching are shipped, and **in the public demo the payout leg runs on the
  mock provider**.
- `403`, two strikes, the append-only trigger, hash-only reconciliation and the
  `PAYOUT_REFUNDED` copy match `services/strikes.ts`, migration `0003`, and
  `packages/core/src/reconcile/`. The reconciliation card is a rendering of the real
  finding shape, not an invented screen.

What it does not claim: that a wallet has paid this gateway in production (A10), or that
the payout leg has moved real money (A17 (c)).

## How it is checked

- `inspect.mjs` seeks the page and reports elements outside the frame, clipped text,
  caption collisions and payment-packet collisions. Run it against a live page:
  `node inspect.mjs 2 5 9 …`.
- `ffmpeg -i` on the cut prints the stream shape; `-f null -` decodes every frame;
  `volumedetect` prints the master's level.
- Frame-to-frame difference over the whole cut shows no frozen stretch: the camera carries
  a slow parallax breathe on every shot, and the payout route's dashed legs keep moving.
- The renderer is deterministic: the same range rendered twice hashes identically. It waits
  two of the page's own animation frames after each seek, because seeking only mutates styles;
  that is a paint guarantee, not a cure for judder — **230 of the 6 255 frames are byte-identical
  to their predecessor**, i.e. the camera moved less than one raster pixel in 1/60 s. That was
  measured, not assumed: an earlier diagnosis blamed a compositor race, and the fixed renderer
  reproduced the same rate, so the holds are the animation's own.

`docs/video/film` is excluded from `biome check` in `biome.json`: `film.css`, `film.js` and
`film.html` are a deterministic art asset read by a browser, not application code, and the
stylesheet is tuned to the pixel rather than to the formatter. Nothing under `apps/` or
`packages/` changes scope because of it.
