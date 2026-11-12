#!/usr/bin/env python3
"""
Renders the redesigned 1920x1080 Web3 walkthrough deck into first-cut.mp4.
Uses headless Google Chrome to render docs/video/stage.html for each of the 13 shots,
then compiles them into an exact 117.0s 30fps H.264 video using ffmpeg.
"""

import os
import subprocess
import sys
from pathlib import Path

VIDEO_DIR = Path(__file__).parent.resolve()
STAGE_HTML = VIDEO_DIR / "stage.html"
BUILD_DIR = VIDEO_DIR / "build-v2"
OUTPUT_MP4 = VIDEO_DIR / "first-cut.mp4"
BACKUP_MP4 = VIDEO_DIR / "first-cut.old.mp4"

FFMPEG = os.environ.get("FFMPEG")
if not FFMPEG:
    # Try static ffmpeg in sightline or system ffmpeg
    sightline_ffmpeg = Path("/home/ademola/sightline/node_modules/ffmpeg-static/ffmpeg")
    if sightline_ffmpeg.exists():
        FFMPEG = str(sightline_ffmpeg)
    else:
        FFMPEG = "ffmpeg"

CHROME = os.environ.get("CHROME_BIN", "/usr/bin/google-chrome")

SHOTS = [
    (1, 7),
    (2, 8),
    (3, 9),
    (4, 9),
    (5, 8),
    (6, 11),
    (7, 8),
    (8, 9),
    (9, 9),
    (10, 9),
    (11, 11),
    (12, 11),
    (13, 8),
]

TOTAL_DURATION = sum(dur for _, dur in SHOTS)
assert TOTAL_DURATION == 117, f"Expected 117s, got {TOTAL_DURATION}s"

BUILD_DIR.mkdir(parents=True, exist_ok=True)

print(f"[*] Rendering 13 styled Web3 slides from {STAGE_HTML.name}...")
frame_paths = []
for shot_id, dur in SHOTS:
    out_png = BUILD_DIR / f"frame-{shot_id:02d}.png"
    url = f"file://{STAGE_HTML.resolve()}?shot={shot_id}"
    
    cmd = [
        CHROME,
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--force-device-scale-factor=1",
        "--window-size=1920,1080",
        f"--screenshot={out_png}",
        url,
    ]
    
    res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0 or not out_png.exists():
        print(f"Error rendering shot {shot_id}: {res.stderr}")
        sys.exit(1)
        
    print(f"  ✓ Shot {shot_id:02d} ({dur}s) -> {out_png.name}")
    frame_paths.append((out_png, dur))

# Write concat file
concat_txt = BUILD_DIR / "concat.txt"
with open(concat_txt, "w") as f:
    for path, dur in frame_paths:
        f.write(f"file '{path.name}'\n")
        f.write(f"duration {dur}\n")
    # Concat demuxer requirement: repeat last file without duration
    f.write(f"file '{frame_paths[-1][0].name}'\n")

print(f"\n[*] Compiling 117.0s MP4 using {FFMPEG}...")

# Backup old mp4 if present and not backed up
if OUTPUT_MP4.exists() and not BACKUP_MP4.exists():
    OUTPUT_MP4.rename(BACKUP_MP4)

ffmpeg_cmd = [
    FFMPEG,
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", str(concat_txt),
    "-vf", "format=yuv420p",
    "-c:v", "libx264",
    "-r", "30",
    "-preset", "slow",
    "-crf", "18",
    "-t", "117.0",
    "-movflags", "+faststart",
    str(OUTPUT_MP4),
]

res = subprocess.run(ffmpeg_cmd, cwd=BUILD_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
if res.returncode != 0:
    print(f"ffmpeg error:\n{res.stderr}")
    sys.exit(1)

size_mb = OUTPUT_MP4.stat().st_size / (1024 * 1024)
print(f"\n[✓] Render complete: {OUTPUT_MP4} ({size_mb:.2f} MB, {TOTAL_DURATION}s @ 30fps)")
