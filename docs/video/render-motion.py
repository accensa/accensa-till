#!/usr/bin/env python3
"""
Renders the redesigned 1920x1080 Web3 walkthrough deck with cinematic camera
movements based on huashu-art-motion and launch film director rules:
1. Hook in the first 7s: Inbound agent 402 challenge with dynamic zoom-out reveal.
2. Strong middle movement: push, pull, and glide tracking across live screens.
3. Suspense pause & slam in Shot 11: 1.8s dead-freeze pause before a 403 Forbidden slam.
4. NEAR Hackathon climax in Shot 13: wide pull-back revealing hackathon tracks & verification.

Outputs: docs/video/first-cut.mp4 (exact 117.0s, 30 fps, H.264)
"""

import os
import subprocess
import sys
from pathlib import Path

VIDEO_DIR = Path(__file__).parent.resolve()
STAGE_HTML = VIDEO_DIR / "stage.html"
BUILD_DIR = VIDEO_DIR / "build-motion"
OUTPUT_MP4 = VIDEO_DIR / "first-cut.mp4"
BACKUP_MP4 = VIDEO_DIR / "first-cut.old.mp4"

FFMPEG = os.environ.get("FFMPEG")
if not FFMPEG:
    sightline_ffmpeg = Path("/home/ademola/sightline/node_modules/ffmpeg-static/ffmpeg")
    if sightline_ffmpeg.exists():
        FFMPEG = str(sightline_ffmpeg)
    else:
        FFMPEG = "ffmpeg"

CHROME = os.environ.get("CHROME_BIN", "/usr/bin/google-chrome")

# (shot_id, duration_sec, zoompan_filter_str)
# Each shot operates at 30 fps, so frames = dur * 30.
# Input is high-res 3840x2160, output is 1920x1080.
SHOT_CONFIGS = [
    # Shot 01: Hook (7s = 210 frames)
    # Starts focused on the terminal prompt / 402 challenge, pulls back to reveal hook banner
    (
        1, 7,
        "zoompan=z='max(1.02, 1.14 - 0.12*(on/210.0))':d=210:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2) - (1.0 - on/210.0)*80':"
        "s=1920x1080:fps=30"
    ),
    # Shot 02: PRD 8.1 Seller & Empty Ledger (8s = 240 frames) - Push-in
    (
        2, 8,
        "zoompan=z='min(1.06, 1.0 + 0.06*(on/240.0))':d=240:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 03: PRD 8.2 Unpaid Request (9s = 270 frames) - Push-in
    (
        3, 9,
        "zoompan=z='min(1.07, 1.0 + 0.07*(on/270.0))':d=270:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 04: PRD 8.2 Decoded Challenge (9s = 270 frames) - Glide / Pan
    (
        4, 9,
        "zoompan=z=1.05:d=270:"
        "x='iw/2-(iw/zoom/2) - 90 + 180*(on/270.0)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 05: PRD 8.2 Paid & Served (8s = 240 frames) - Pull-out
    (
        5, 8,
        "zoompan=z='max(1.0, 1.06 - 0.06*(on/240.0))':d=240:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 06: PRD 8.3 Payment In, Payout Out (11s = 330 frames) - Glide
    (
        6, 11,
        "zoompan=z=1.04:d=330:"
        "x='iw/2-(iw/zoom/2) + 70*sin(on/330.0*3.14159)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 07: PRD 8.3 PostgreSQL Ledger (8s = 240 frames) - Push-in
    (
        7, 8,
        "zoompan=z='min(1.06, 1.0 + 0.06*(on/240.0))':d=240:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 08: PRD 8.3 Payments Screen (9s = 270 frames) - Pull-out
    (
        8, 9,
        "zoompan=z='max(1.0, 1.06 - 0.06*(on/270.0))':d=270:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 09: PRD 8.4 Simulated Refund (9s = 270 frames) - Push-in
    (
        9, 9,
        "zoompan=z='min(1.06, 1.0 + 0.06*(on/270.0))':d=270:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 10: PRD 8.5 Reconciliation Audit (9s = 270 frames) - Push-in
    (
        10, 9,
        "zoompan=z='min(1.06, 1.0 + 0.06*(on/270.0))':d=270:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 11: PRD 8.6 Fraud Defense, Suspense Pause & 403 Slam (11s = 330 frames)
    # Frames 0-120: gentle push on strikes (1.0 -> 1.05)
    # Frames 120-174 (1.8s): SUSPENSE PAUSE (dead hold at 1.05)
    # Frames 174-186: SLAM (punch to 1.15)
    # Frames 186-330: Hold at 1.10 centered on 403 Forbidden Payer Blocked
    (
        11, 11,
        "zoompan=z='if(lt(on,120), 1.0 + 0.05*(on/120.0), if(lt(on,174), 1.05, if(lt(on,186), 1.15, 1.10)))':d=330:"
        "x='iw/2-(iw/zoom/2)':"
        "y='if(lt(on,174), ih/2-(ih/zoom/2)-30, ih/2-(ih/zoom/2)+50)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 12: PRD 8.6 Reconciliation Resolution (11s = 330 frames) - Glide
    (
        12, 11,
        "zoompan=z=1.04:d=330:"
        "x='iw/2-(iw/zoom/2) + 60*sin(on/330.0*3.14159)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
    # Shot 13: NEAR Hackathon Climax (8s = 240 frames) - Wide Pull-out
    (
        13, 8,
        "zoompan=z='max(1.0, 1.08 - 0.08*(on/240.0))':d=240:"
        "x='iw/2-(iw/zoom/2)':"
        "y='ih/2-(ih/zoom/2)':"
        "s=1920x1080:fps=30"
    ),
]

TOTAL_DURATION = sum(dur for _, dur, _ in SHOT_CONFIGS)
assert TOTAL_DURATION == 117, f"Expected 117s, got {TOTAL_DURATION}s"

BUILD_DIR.mkdir(parents=True, exist_ok=True)

print(f"[*] Step 1: Capturing 13 high-resolution retina stills from {STAGE_HTML.name}...")
still_paths = []
for shot_id, dur, _ in SHOT_CONFIGS:
    out_png = BUILD_DIR / f"still-{shot_id:02d}.png"
    url = f"file://{STAGE_HTML.resolve()}?shot={shot_id}"
    
    cmd = [
        CHROME,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--window-size=1920,1080",
        f"--screenshot={out_png}",
        url,
    ]
    
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0 or not out_png.exists():
        print(f"Error capturing shot {shot_id}: {res.stderr}", file=sys.stderr)
        sys.exit(1)
        
    print(f"  ✓ Captured Shot {shot_id:02d} ({dur}s) -> {out_png.name}")
    still_paths.append((shot_id, dur, out_png))

print(f"\n[*] Step 2: Applying director camera movements (push/pull/glide/pause/slam) via FFmpeg...")
clip_paths = []
for shot_id, dur, filter_expr in SHOT_CONFIGS:
    still_png = BUILD_DIR / f"still-{shot_id:02d}.png"
    clip_mp4 = BUILD_DIR / f"clip-{shot_id:02d}.mp4"
    
    cmd = [
        FFMPEG,
        "-y",
        "-loop", "1",
        "-i", str(still_png),
        "-vf", filter_expr,
        "-t", f"{dur}.0",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "26",
        "-pix_fmt", "yuv420p",
        "-r", "30",
        str(clip_mp4),
    ]
    
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0 or not clip_mp4.exists():
        print(f"Error rendering clip for shot {shot_id}: {res.stderr}", file=sys.stderr)
        sys.exit(1)
        
    print(f"  ✓ Motion clip {shot_id:02d} rendered ({dur}s @ 30fps) -> {clip_mp4.name}")
    clip_paths.append(clip_mp4)

# Create concat manifest
concat_txt = BUILD_DIR / "concat.txt"
with open(concat_txt, "w") as f:
    for clip in clip_paths:
        f.write(f"file '{clip.name}'\n")

print(f"\n[*] Step 3: Concatenating all 13 motion clips into {OUTPUT_MP4.name}...")
if OUTPUT_MP4.exists() and not BACKUP_MP4.exists():
    OUTPUT_MP4.rename(BACKUP_MP4)

cmd = [
    FFMPEG,
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", str(concat_txt),
    "-c", "copy",
    "-movflags", "+faststart",
    str(OUTPUT_MP4),
]

res = subprocess.run(cmd, cwd=BUILD_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
if res.returncode != 0:
    print(f"Error concatenating clips: {res.stderr}", file=sys.stderr)
    sys.exit(1)

size_mb = OUTPUT_MP4.stat().st_size / (1024 * 1024)
print(f"\n[✓] Video motion render complete: {OUTPUT_MP4} ({size_mb:.2f} MB, {TOTAL_DURATION}s @ 30fps)")
