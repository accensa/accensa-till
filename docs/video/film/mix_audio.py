#!/usr/bin/env python3
"""Place the voiceover and sound design on the timeline and mix the master.

Writes build/audio/mix.wav (48 kHz stereo, -14 LUFS) for the encoder.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
BUILD = ROOT / "build"
AUDIO = BUILD / "audio"
FFMPEG = "/home/ademola/sightline/node_modules/ffmpeg-static/ffmpeg"
DUR = float(json.loads((BUILD / "timeline.json").read_text())["duration"])

# (scene, cue, offset, sound, gain)
PLAN = [
    ("hook", "data", -0.05, "blip", 0.22),
    ("hook", "prices", -0.05, "blip_hi", 0.22),
    ("hook", "compute", -0.05, "blip", 0.20),
    ("hook", "card", -0.10, "whoosh", 0.16),
    ("hook", "invoice", -0.05, "stamp", 0.16),
    ("problem", "vo", 0.20, "type", 0.07),
    ("problem", "free", -0.05, "ui", 0.26),
    ("problem", "charge", -0.05, "click", 0.30),
    ("problem", "prove", -0.05, "alert", 0.16),
    ("problem", "arrived", -0.05, "blip_hi", 0.16),
    ("reveal", "till", -0.02, "impact", 0.55),
    ("reveal", "near", -0.05, "chime_up", 0.16),
    ("setup", "point", 0.25, "type", 0.16),
    ("setup", "price", -0.02, "blip", 0.22),
    ("setup", "switch", -0.02, "toggle", 0.42),
    ("setup", "switch", 0.25, "chime", 0.16),
    ("challenge", "request", 0.20, "whoosh", 0.20),
    ("challenge", "paying", -0.02, "gate", 0.40),
    ("challenge", "four", -0.02, "impact", 0.50),
    ("challenge", "required", -0.05, "lock", 0.34),
    ("paid", "signs", -0.02, "pen", 0.26),
    ("paid", "gasless", -0.05, "sparkle", 0.14),
    ("paid", "verifies", 0.05, "chime", 0.30),
    ("paid", "serves", -0.02, "blip_hi", 0.22),
    ("paid", "settles", -0.02, "coin", 0.26),
    ("proof", "real", -0.02, "swell", 0.16),
    ("proof", "mock", -0.02, "stamp", 0.34),
    ("proof", "receipt", -0.02, "lock", 0.28),
    ("payout", "payouts", -0.02, "whoosh_long", 0.22),
    ("payout", "intents", -0.02, "whoosh", 0.16),
    ("payout", "stablecoin", -0.02, "coin", 0.30),
    ("payout", "chain", -0.02, "click", 0.30),
    ("payout", "hash", -0.02, "lock", 0.40),
    ("reconcile", "refunded", -0.02, "alert", 0.34),
    ("reconcile", "english", -0.02, "ui", 0.22),
    ("reconcile", "next", -0.02, "click", 0.32),
    ("guard", "blocked", -0.02, "impact", 0.60),
    ("guard", "gas", -0.02, "hiss", 0.20),
    ("close", "till", -0.02, "impact", 0.48),
    ("close", "charge", -0.02, "blip", 0.20),
    ("close", "prove", -0.02, "chime_up", 0.24),
    ("close", "money", -0.02, "swell", 0.20),
    ("close", "hackathon", -0.02, "sparkle", 0.20),
]


def main():
    T = json.loads((BUILD / "timeline.json").read_text())
    S = {s["id"]: s for s in T["scenes"]}
    vo = json.loads((BUILD / "vo.json").read_text())
    if abs(T["duration"] - DUR) > 0.01:
        raise SystemExit(f"timeline is {T['duration']}s, score is {DUR}s")

    vo_inputs, vo_filters, vo_labels = [], [], []
    for i, clip in enumerate(vo):
        vo_inputs += ["-i", str(ROOT / clip["file"])]
        ms = int(round(S[clip["id"]]["vo_start"] * 1000))
        vo_filters.append(f"[{i+1}:a]aformat=channel_layouts=stereo,adelay={ms}|{ms}[vo{i}]")
        vo_labels.append(f"[vo{i}]")
    vo_chain = ";".join(vo_filters) + ";" + "".join(vo_labels) + \
        (f"amix=inputs={len(vo_labels)}:normalize=0,apad=whole_dur={DUR},"
         "loudnorm=I=-15:TP=-1.5:LRA=7,asplit=2[voA][voB]")

    plan = []
    for scene, key, off, sound, gain in PLAN:
        s = S[scene]
        base = s["vo_start"] if key == "vo" else s["cues"][key]
        t = base + off
        if 0 <= t < DUR:
            plan.append((t, sound, gain))

    sfx_inputs, sfx_filters, sfx_labels = [], [], []
    offset = 1 + len(vo)
    for i, (t, name, gain) in enumerate(plan):
        sfx_inputs += ["-i", str(AUDIO / f"{name}.wav")]
        ms = int(round(t * 1000))
        sfx_filters.append(
            f"[{offset + i}:a]aformat=channel_layouts=stereo,volume={gain},adelay={ms}|{ms}[sf{i}]"
        )
        sfx_labels.append(f"[sf{i}]")
    sfx_chain = ";".join(sfx_filters) + ";" + "".join(sfx_labels) + \
        f"amix=inputs={len(sfx_labels)}:normalize=0,apad=whole_dur={DUR}[sfx]"

    inputs = ["-i", str(AUDIO / "score.wav")] + vo_inputs + sfx_inputs
    fc = (
        "[0:a]aformat=channel_layouts=stereo,volume=0.30[music];"
        + vo_chain + ";" + sfx_chain + ";"
        + "[music][voA]sidechaincompress=threshold=0.035:ratio=6:attack=18:release=420:makeup=1[duck];"
        + "[duck][voB][sfx]amix=inputs=3:normalize=0,alimiter=limit=0.95,"
        + "loudnorm=I=-14:TP=-1.5:LRA=9[a]"
    )
    out = AUDIO / "mix.wav"
    r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *inputs,
                        "-filter_complex", fc, "-map", "[a]", "-ar", "48000", "-ac", "2",
                        "-t", str(DUR), str(out)], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-2500:], file=sys.stderr)
        raise SystemExit(r.returncode)
    print(f"[mix] {out} {out.stat().st_size/1e6:.1f} MB, {len(plan)} sound cues")


if __name__ == "__main__":
    sys.exit(main())
