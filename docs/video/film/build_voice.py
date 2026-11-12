#!/usr/bin/env python3
"""Generate the film's voiceover with the authenticated ElevenLabs CLI.

Reads script.json, synthesises one clip per scene, trims leading/trailing
silence, normalises to -16 LUFS and writes build/vo.json with the measured
speech durations used to build the timeline.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
BUILD = ROOT / "build"
VO_DIR = BUILD / "vo"
SCRIPT = json.loads((ROOT / "script.json").read_text())
CLI = ["npx", "-y", "@elevenlabs/cli@1.11.0"]
FFMPEG = os.environ.get(
    "FFMPEG", "/home/ademola/sightline/node_modules/ffmpeg-static/ffmpeg"
)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def duration(path):
    out = run([FFMPEG, "-hide_banner", "-i", str(path), "-f", "null", "-"]).stderr
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.\d+)", out)
    if not m:
        raise RuntimeError(f"no duration for {path}: {out[-400:]}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def speech_bounds(path, noise="-45dB", min_silence=0.12):
    """First and last moment of speech in the clip, in seconds."""
    total = duration(path)
    out = run(
        [
            FFMPEG, "-hide_banner", "-i", str(path),
            "-af", f"silencedetect=noise={noise}:d={min_silence}",
            "-f", "null", "-",
        ]
    ).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", out)]

    start = 0.0
    if starts and starts[0] < 0.05 and ends:
        start = ends[0]
    end = total
    if len(ends) < len(starts):
        end = starts[-1]
    return max(0.0, start - 0.06), min(total, end + 0.12), total


def main():
    VO_DIR.mkdir(parents=True, exist_ok=True)
    voice = SCRIPT["voice"]
    scenes = SCRIPT["scenes"]
    results = []

    for i, scene in enumerate(scenes):
        sid = scene["id"]
        raw = VO_DIR / f"{i:02d}-{sid}.mp3"
        wav = VO_DIR / f"{i:02d}-{sid}.wav"
        if not raw.exists():
            prev = scenes[i - 1]["vo"] if i else ""
            nxt = scenes[i + 1]["vo"] if i + 1 < len(scenes) else ""
            cmd = CLI + [
                "text-to-speech", "convert",
                "--text", scene["vo"],
                "--voice-id", voice["id"],
                "--model-id", voice["model"],
                "--output-format", "mp3_44100_128",
                "--voice-settings.stability", str(voice["stability"]),
                "--voice-settings.similarity-boost", str(voice["similarity"]),
                "--voice-settings.speed", str(voice["speed"]),
                "--output", str(raw),
            ]
            if prev:
                cmd += ["--previous-text", prev]
            if nxt:
                cmd += ["--next-text", nxt]
            print(f"[vo] {i:02d} {sid}: generating", flush=True)
            run(cmd)
        else:
            print(f"[vo] {i:02d} {sid}: cached", flush=True)

        a, b, total = speech_bounds(raw)
        run([
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(raw),
            "-af",
            f"atrim=start={a:.3f}:end={b:.3f},asetpts=N/SR/TB,"
            "loudnorm=I=-16:TP=-1.5:LRA=7,"
            "adelay=0.06,apad=pad_dur=0.12",
            "-ar", "48000", "-ac", "1", str(wav),
        ])
        spoken = duration(wav)
        results.append({
            "id": sid,
            "file": str(wav.relative_to(ROOT)),
            "raw_duration": round(total, 3),
            "speech": round(spoken, 3),
            "headline": scene["headline"],
            "text": scene["vo"],
        })
        print(f"     speech {spoken:.2f}s (raw {total:.2f}s)")

    (BUILD / "vo.json").write_text(json.dumps(results, indent=2) + "\n")
    print(f"[vo] {len(results)} clips, total speech {sum(r['speech'] for r in results):.2f}s")


if __name__ == "__main__":
    sys.exit(main())
