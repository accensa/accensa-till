#!/usr/bin/env python3
"""
Generates per-shot ElevenLabs voiceover audio for docs/video/first-cut.mp4.
Reads NARRATION.md for durations and narration text, queries ElevenLabs TTS API,
pads each clip to the shot duration with silence, concatenates them, and muxes
the result into a final video with audio track.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
import urllib.request
import urllib.error

VIDEO_DIR = Path(__file__).parent.resolve()
NARRATION_MD = VIDEO_DIR / "NARRATION.md"
INPUT_MP4 = VIDEO_DIR / "first-cut.mp4"
OUTPUT_MP4 = VIDEO_DIR / "walkthrough.mp4"
AUDIO_DIR = VIDEO_DIR / "voiceover"

FFMPEG = os.environ.get("FFMPEG")
if not FFMPEG:
    sightline_ffmpeg = Path("/home/ademola/sightline/node_modules/ffmpeg-static/ffmpeg")
    if sightline_ffmpeg.exists():
        FFMPEG = str(sightline_ffmpeg)
    else:
        FFMPEG = "ffmpeg"

# Get API key from env or .env.local
API_KEY = os.environ.get("ELEVENLABS_API_KEY")
if not API_KEY:
    for p in [
        Path("/home/ademola/orgs/accensa/.env.local"),
        Path("/home/ademola/orgs/accensa/accensa-till/.env.local"),
        Path(".env.local"),
        Path("../.env.local"),
        Path("../../.env.local")
    ]:
        if p.exists():
            for line in p.read_text().splitlines():
                if line.startswith("ELEVENLABS_API_KEY="):
                    API_KEY = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        if API_KEY:
            break

if not API_KEY:
    print("Error: ELEVENLABS_API_KEY not found in environment or .env.local", file=sys.stderr)
    sys.exit(1)

# Voice ID: George (JBFqnCBsd6RMkjVDRZzb) or Daniel (onwK4e9ZLuTAKqWW03F9)
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")
MODEL_ID = os.environ.get("ELEVENLABS_MODEL_ID", "eleven_turbo_v2_5")

# Parse NARRATION.md
shots = []
pattern = r"^### Shot (\d\d)[^\n]*\nDURATION: (\d+)\n\nNARRATION: (.+)"
matches = re.findall(pattern, NARRATION_MD.read_text(encoding="utf-8"), re.M)

for sid_str, dur_str, text in matches:
    shots.append((int(sid_str), int(dur_str), text.strip()))

assert len(shots) == 13, f"Expected 13 shots, got {len(shots)}"
total_duration = sum(dur for _, dur, _ in shots)
assert total_duration == 117, f"Expected 117s total, got {total_duration}s"

AUDIO_DIR.mkdir(parents=True, exist_ok=True)

print(f"[*] Generating {len(shots)} voiceover clips using ElevenLabs (Voice: {VOICE_ID}, Model: {MODEL_ID})...")

def get_duration(path):
    res = subprocess.run(
        [FFMPEG, "-i", str(path), "-f", "null", "-"],
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        text=True
    )
    # Search for Duration: 00:00:05.12
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", res.stderr)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return 0.0

clip_files = []
for sid, dur, text in shots:
    raw_mp3 = AUDIO_DIR / f"shot-{sid:02d}-raw.mp3"
    padded_wav = AUDIO_DIR / f"shot-{sid:02d}-padded.wav"
    
    if not raw_mp3.exists():
        print(f"  -> Synthesizing Shot {sid:02d} ({dur}s): \"{text[:45]}...\"")
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
        payload = {
            "text": text,
            "model_id": MODEL_ID,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.8
            }
        }
        
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "xi-api-key": API_KEY,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg"
            },
            method="POST"
        )
        
        success = False
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw_mp3.write_bytes(resp.read())
                    success = True
                    break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, Exception) as e:
                print(f"    [!] Attempt {attempt + 1} failed: {e}. Retrying in 2s...")
                import time
                time.sleep(2)
        if not success:
            print(f"Failed to synthesize shot {sid:02d} after 3 attempts.", file=sys.stderr)
            sys.exit(1)
    else:
        print(f"  ✓ Shot {sid:02d} cached: {raw_mp3.name}")

    clip_dur = get_duration(raw_mp3)
    target_dur = dur - 0.35  # leave breathing pause before next shot cut
    
    if clip_dur > target_dur and target_dur > 0:
        ratio = clip_dur / target_dur
        # Clamp tempo ratio between 0.8 and 1.5
        ratio = max(0.8, min(1.5, ratio))
        filter_str = f"atempo={ratio:.4f},apad=whole_dur={dur},atrim=0:{dur}"
        print(f"     Adjusting tempo: {clip_dur:.2f}s -> {target_dur:.2f}s (speed {ratio:.2f}x)")
    else:
        filter_str = f"apad=whole_dur={dur},atrim=0:{dur}"
        print(f"     Padding: {clip_dur:.2f}s with silence to {dur}s")

    cmd = [
        FFMPEG,
        "-y",
        "-i", str(raw_mp3),
        "-filter_complex", filter_str,
        "-c:a", "pcm_s16le",
        "-ar", "44100",
        str(padded_wav)
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    clip_files.append(padded_wav)

# Concatenate all 13 padded clips
concat_txt = AUDIO_DIR / "concat.txt"
with open(concat_txt, "w") as f:
    for clip in clip_files:
        f.write(f"file '{clip.name}'\n")

master_wav = AUDIO_DIR / "narration-master.wav"
print(f"[*] Concatenating padded clips into {master_wav.name}...")
subprocess.run([
    FFMPEG,
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", str(concat_txt),
    "-c", "copy",
    str(master_wav)
], cwd=AUDIO_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

# Mux master audio with first-cut.mp4
print(f"[*] Muxing voiceover with {INPUT_MP4.name} -> {OUTPUT_MP4.name}...")
subprocess.run([
    FFMPEG,
    "-y",
    "-i", str(INPUT_MP4),
    "-i", str(master_wav),
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    str(OUTPUT_MP4)
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

size_mb = OUTPUT_MP4.stat().st_size / (1024 * 1024)
print(f"\n[✓] Done! Created {OUTPUT_MP4} ({size_mb:.2f} MB, {total_duration}s)")
