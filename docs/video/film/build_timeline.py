#!/usr/bin/env python3
"""Build the film timeline from the measured voiceover and word timings.

Every scene starts on an eighth-note grid (120 BPM), the voiceover starts a
fixed lead after its scene, and visual cues are anchored to the exact word the
narrator says. Writes build/timeline.json and build/timeline.js.
"""

import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
BUILD = ROOT / "build"

FPS = 60
BPM = 120
GRID = 60.0 / BPM / 2          # eighth note = 0.25 s
FIRST_VO = 0.9
LEAD = 0.5
TAIL = 0.45
OUTRO = 3.15
MIN_SCENE = 3.0

CUES = {
    "hook": {"data": "Data", "prices": "Prices", "compute": "Compute",
             "card": "credit", "invoice": "invoices"},
    "problem": {"free": "free", "charge": "charge", "prove": "prove",
                "arrived": "arrived"},
    "reveal": {"till": "Till", "near": "NEAR"},
    "setup": {"point": "Point", "price": "price", "switch": "Switch"},
    "challenge": {"request": "request", "paying": "paying", "four": "four",
                  "required": "required"},
    "paid": {"signs": "signs", "gasless": "gasless", "verifies": "verifies",
             "serves": "serves", "settles": "settles"},
    "proof": {"real": "real", "mock": "mock-up", "receipt": "receipt"},
    "payout": {"payouts": "Payouts", "intents": "Intents",
               "stablecoin": "stablecoin", "chain": "chain",
               "hash": "hash"},
    "reconcile": {"refunded": "refunded", "english": "English",
                  "next": "next"},
    "guard": {"blocked": "blocked", "gas": "gas"},
    "close": {"till": "Till", "charge": "charge", "prove": "Prove",
              "money": "money", "hackathon": "Hackathon"},
}


def norm(word):
    return re.sub(r"[^a-z0-9]", "", word.lower())


def build_chunks(text, words):
    """Caption chunks: sentences, split again at commas when long."""
    pieces = []
    for sent in re.split(r"(?<=[.!?])\s+", text.strip()):
        if len(sent) <= 86:
            pieces.append(sent)
            continue
        buf = ""
        for part in re.split(r"(?<=,)\s+", sent):
            if buf and len(buf) + len(part) > 86:
                pieces.append(buf.strip())
                buf = part
            else:
                buf = (buf + " " + part).strip()
        if buf:
            pieces.append(buf.strip())

    chunks, idx = [], 0
    for piece in pieces:
        toks = [norm(t) for t in piece.split() if norm(t)]
        if not toks:
            continue
        # find the first word at or after idx that matches
        while idx < len(words) and norm(words[idx]["w"]) != toks[0]:
            idx += 1
        start_i = min(idx, len(words) - 1)
        for _ in toks:
            idx += 1
        end_i = min(idx, len(words)) - 1
        chunks.append({
            "text": piece,
            "start": words[start_i]["s"],
            "end": words[min(end_i + 1, len(words) - 1)]["s"] if end_i + 1 < len(words) else words[-1]["e"],
        })
    return chunks


def main():
    vo = json.loads((BUILD / "vo.json").read_text())
    words = json.loads((BUILD / "words.json").read_text())
    scenes = []

    t = 0.0
    for i, (clip, aligned) in enumerate(zip(vo, words)):
        start = 0.0 if i == 0 else math.ceil((t + 0.02) / GRID) * GRID
        vo_start = FIRST_VO if i == 0 else start + LEAD
        end = vo_start + clip["speech"] + (OUTRO if i == len(vo) - 1 else TAIL)
        end = max(end, start + MIN_SCENE)
        end = math.ceil(end / GRID) * GRID

        by_word = {}
        for w in aligned["words"]:
            by_word.setdefault(norm(w["w"]), []).append(w)
        cues = {}
        for key, word in CUES[clip["id"]].items():
            found = by_word.get(norm(word))
            cues[key] = round(vo_start + (found[0]["s"] if found else 0.0), 3)
        cues["vo"] = round(vo_start, 3)

        scenes.append({
            "id": clip["id"],
            "headline": clip["headline"],
            "start": round(start, 3),
            "end": round(end, 3),
            "vo_start": round(vo_start, 3),
            "vo_dur": clip["speech"],
            "cues": cues,
            "captions": [
                {**c, "start": round(vo_start + c["start"], 3),
                 "end": round(vo_start + c["end"], 3)}
                for c in build_chunks(clip["text"], aligned["words"])
            ],
        })
        t = end

    timeline = {
        "fps": FPS,
        "bpm": BPM,
        "grid": GRID,
        "duration": round(t, 3),
        "scenes": scenes,
    }
    (BUILD / "timeline.json").write_text(json.dumps(timeline, indent=2) + "\n")
    (BUILD / "timeline.js").write_text(
        "window.TIMELINE = " + json.dumps(timeline) + ";\n"
    )
    print(f"total {timeline['duration']:.2f}s")
    for s in scenes:
        print(f"  {s['id']:<10} {s['start']:7.2f} -> {s['end']:7.2f}  "
              f"vo {s['vo_start']:7.2f}  cues "
              + ", ".join(f"{k}={v - s['vo_start']:+.1f}" for k, v in s["cues"].items() if k != "vo"))


if __name__ == "__main__":
    sys.exit(main())
