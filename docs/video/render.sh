#!/usr/bin/env bash
#
# docs/video/render.sh — deterministic first-cut render of the Till demo film (H1).
#
# What it does, in order:
#   1. reads the shot durations and the caption text out of NARRATION.md (that file
#      is the authoritative narration; nothing is re-typed here),
#   2. builds one 1920x1080 still per shot from the captured evidence in CAPTURES/
#      — a terminal frame rendered from a capture text file, or a dashboard
#      screenshot scaled and letterboxed — burning into each still the shot title,
#      its caption, and for every simulated shot a SIMULATED badge naming exactly
#      what is scripted,
#   3. concatenates the stills into first-cut.mp4 with a hard cut per shot.
#      No Ken Burns, no crossfade, no audio track: the human records the voice last.
#
# Writes only docs/video/build/ (disposable) and docs/video/first-cut.mp4. Re-runs
# to the same output: no clock, no network, no randomness, fixed fps and encoder
# settings, ffmpeg bitexact flags.
#
# Requirements, all present on the machine this was written and run on
# (ffmpeg 6.1.1-3ubuntu5): ffmpeg with drawtext (libfreetype) and libx264, python3,
# and the Ubuntu DejaVu fonts. The script checks for them and refuses rather than
# half-rendering.
#
# Usage:  bash docs/video/render.sh
#
set -euo pipefail

VIDEO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$VIDEO_DIR/build"
FFMPEG="${FFMPEG:-ffmpeg}"

W=1920
H=1080
FPS=30
BG="0x0b1120"
FG="0xe6edf3"
MONO="/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_BOLD="/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
SANS="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

die() { echo "render.sh: $*" >&2; exit 1; }

command -v "$FFMPEG" >/dev/null 2>&1 || die "ffmpeg not found (or set FFMPEG=/path/to/ffmpeg)"
command -v python3 >/dev/null 2>&1 || die "python3 not found; it parses NARRATION.md"
# Captured into a variable rather than piped into grep -q: with pipefail set, grep
# closing the pipe early makes ffmpeg die on SIGPIPE and the check reads as a
# missing filter.
FF_FILTERS="$("$FFMPEG" -hide_banner -filters 2>/dev/null || true)"
case "$FF_FILTERS" in
  *drawtext*) ;;
  *) die "this ffmpeg has no drawtext (needs libfreetype)" ;;
esac
for f in "$MONO" "$MONO_BOLD" "$SANS"; do
  [ -r "$f" ] || die "font missing: $f"
done
[ -r "$VIDEO_DIR/NARRATION.md" ] || die "NARRATION.md is the caption source and is not readable"

# ---------------------------------------------------------------------------
# The shot table. Tab separated: id, kind, source file(s, comma separated),
# on-screen title, SIMULATED badge reason (empty means no badge).
# `text` renders a capture as a terminal frame; `png` is a browser screenshot.
# Durations and captions are keyed on the same two-digit id and live in
# NARRATION.md, so the spoken script and the film cannot drift apart silently.
# ---------------------------------------------------------------------------
mkdir -p "$BUILD/frames" "$BUILD/captions"
SHOTS_TSV="$BUILD/shots.tsv"
cat > "$SHOTS_TSV" <<'TSV'
01	text	CAPTURES/frames/f01-title.txt	Till: what it is	
02	png	CAPTURES/06-dashboard-endpoints.png	PRD 8.1: a seller, one live paywalled endpoint, an empty ledger	the deposit address is the mock provider's
03	text	CAPTURES/frames/f03-curl-402.txt	PRD 8.2: an unpaid request answers 402	
04	text	CAPTURES/frames/f04-decoded.txt	PRD 8.2: the same challenge, base64-decoded	payTo is the mock's invented deposit address
05	text	CAPTURES/frames/f05-demo-step2.txt	PRD 8.2: the buyer pays and is served	the chain leg is a loopback stub
06	text	CAPTURES/frames/f06-demo-step3.txt	PRD 8.3: payment booked, payout polled	PAYOUT_PROVIDER=mock
07	text	CAPTURES/frames/f07b-ledger.txt	PRD 8.3: ledger_entries, read back from Postgres	these rows describe mock-provider money
08	png	CAPTURES/07-dashboard-payments.png	PRD 8.3: the seller's payments screen	data from the simulated run
09	text	CAPTURES/frames/f08-simulate-refund.txt	PRD 8.4: pnpm simulate refund	scripted refund
10	text	CAPTURES/frames/f09-demo-step4.txt	PRD 8.5: reconciliation opens PAYOUT_REFUNDED	scripted refund
11	text	CAPTURES/frames/f10-demo-step6.txt	PRD 8.6: served twice without settling, then blocked	settlement scripted to fail
12	png	CAPTURES/08-dashboard-reconciliation.png	PRD 8.5 and 8.6: the reconciliation screen	data from the simulated run
13	text	CAPTURES/frames/f12-close.txt	What is real, and what is not	
TSV

"$FFMPEG" -version >/dev/null

python3 - "$VIDEO_DIR" "$BUILD" "$SHOTS_TSV" "$W" "$H" "$FPS" "$BG" "$FG" \
  "$MONO" "$MONO_BOLD" "$SANS" <<'PY'
import os, re, subprocess, sys, textwrap

(VIDEO_DIR, BUILD, SHOTS_TSV, W, H, FPS, BG, FG, MONO, MONO_BOLD, SANS) = sys.argv[1:12]
W, H, FPS = int(W), int(H), int(FPS)
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")

# --- NARRATION.md is the authority for duration + caption -------------------
narration = {}
for sid, dur, cap in re.findall(
    r"^### Shot (\d\d)[^\n]*\nDURATION: (\d+)\n\nNARRATION: (.+)",
    open(f"{VIDEO_DIR}/NARRATION.md", encoding="utf-8").read(),
    re.M,
):
    narration[sid] = (int(dur), " ".join(cap.split()))

shots = [line.rstrip("\n").split("\t") for line in open(SHOTS_TSV, encoding="utf-8")]
for sid, *_ in shots:
    if sid not in narration:
        raise SystemExit(f"render.sh: shot {sid} has no block in NARRATION.md")

def wrap(text, width):
    out = []
    for para in text.split("\n"):
        if para.strip() == "":
            out.append("")
        else:
            out.extend(textwrap.wrap(para, width=width, subsequent_indent="    ") or [""])
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out)

def drawtext(font, extra, **kw):
    """drawtext=... with every value escaped for the filtergraph parser."""
    parts = [f"fontfile={font}"]
    for k, v in kw.items():
        v = str(v).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
        parts.append(f"{k}={v}")
    return f"drawtext={':'.join(parts)}"

def run(args):
    print("+ " + " ".join(args[:1]) + " …")
    subprocess.run(args, check=True)

frames = []
for sid, kind, sources, title, badge in shots:
    duration, caption = narration[sid]

    titlefile = f"{BUILD}/captions/{sid}-title.txt"
    capfile = f"{BUILD}/captions/{sid}-caption.txt"
    open(titlefile, "w", encoding="utf-8").write(wrap(title, 70) + "\n")
    open(capfile, "w", encoding="utf-8").write(wrap(caption, 84) + "\n")

    if kind == "text":
        raw_body = []
        for rel in sources.split(","):
            raw_body.append(
                open(os.path.join(VIDEO_DIR, rel), encoding="utf-8").read().rstrip("\n")
            )
        body_text = "\n".join(raw_body)
        # Fit the body into the band between the title and the caption instead of
        # hoping: DejaVu Sans Mono advances 0.605 em and a line costs 1.42 em with
        # its spacing, so pick the width and size that put the last line above the
        # caption box, then wrap once more at the chosen width.
        TOP, BAND = 200, 660
        width = 104
        for _ in range(2):
            bodyfile = f"{BUILD}/frames/{sid}.txt"
            open(bodyfile, "w", encoding="utf-8").write(wrap(body_text, width) + "\n")
            nlines = max(1, len(open(bodyfile, encoding="utf-8").read().rstrip("\n").split("\n")))
            fontsize = max(14, min(26, int(BAND / (1.42 * nlines))))
            width = max(64, min(120, int((W - 160) / (0.605 * fontsize))))
        used = nlines * 1.42 * fontsize
        if used > BAND:
            print(f"render.sh: warning: shot {sid} body is {used:.0f}px in a {BAND}px band")
        inputs = ["-f", "lavfi", "-i", f"color=c={BG}:s={W}x{H}:r={FPS}"]
        chain = (
            f"[0:v]drawtext=fontfile={MONO}:textfile={bodyfile}:fontcolor={FG}"
            f":fontsize={fontsize}:line_spacing={max(4, int(fontsize * 0.25))}"
            f":x=72:y={TOP}"
        )
    else:
        # A browser screenshot is white and whatever shape it was shot in; it gets
        # its own band between the title and the caption rather than being blown up
        # under them, so the overlays never sit on top of the page being shown. The
        # 1920x1080 frames keep their aspect ratio inside the 1500x660 band.
        inputs = ["-i", os.path.join(VIDEO_DIR, sources)]
        chain = (
            f"[0:v]scale=1500:660:force_original_aspect_ratio=decrease,"
            f"pad=1500:660:(ow-iw)/2:(oh-ih)/2:color=0xffffff,"
            f"pad={W}:{H}:210:200:color={BG}"
        )

    chain += "," + drawtext(SANS, "", textfile=titlefile, fontcolor="white",
                            fontsize=38, x=72, y=84)
    chain += "," + drawtext(SANS, "", textfile=capfile, fontcolor="white",
                            fontsize=27, line_spacing=8, x="(w-text_w)/2", y="h-196",
                            box=1, boxcolor="0x000000@0.62", boxborderw=22)
    if badge:
        bfile = f"{BUILD}/captions/{sid}-badge.txt"
        open(bfile, "w", encoding="utf-8").write("SIMULATED\n" + wrap(badge, 40) + "\n")
        chain += "," + drawtext(MONO_BOLD, "", textfile=bfile, fontcolor="white",
                                fontsize=26, line_spacing=6, x="w-text_w-64", y=64,
                                box=1, boxcolor="0xc2313f@0.95", boxborderw=18)
    chain += "[v]"

    frame = f"{BUILD}/frames/{sid}.png"
    run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *inputs,
         "-filter_complex", chain, "-map", "[v]", "-frames:v", "1",
         "-fflags", "+bitexact", frame])
    frames.append((frame, duration))
    print(f"render.sh: shot {sid}  {duration}s  {kind}  badge={'yes' if badge else 'no'}")

# --- concat: one hard cut per shot, no audio -------------------------------
inputs, filters, labels = [], [], []
for i, (frame, duration) in enumerate(frames):
    inputs += ["-loop", "1", "-framerate", str(FPS), "-t", str(duration), "-i", frame]
    filters.append(f"[{i}:v]fps={FPS},format=yuv420p,setsar=1[v{i}]")
    labels.append(f"[v{i}]")

total = sum(d for _, d in frames)
out = f"{VIDEO_DIR}/first-cut.mp4"
run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *inputs,
     "-filter_complex", ";".join(filters) + ";" + "".join(labels) +
     f"concat=n={len(frames)}:v=1:a=0[outv]",
     "-map", "[outv]", "-r", str(FPS), "-c:v", "libx264", "-preset", "medium",
     "-crf", "20", "-pix_fmt", "yuv420p", "-g", str(FPS), "-an",
     "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart", out])
print(f"render.sh: wrote {out}  ({len(frames)} shots, {total}s at {FPS} fps, {W}x{H})")
PY
