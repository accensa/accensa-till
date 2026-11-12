#!/usr/bin/env python3
"""Force-align each voiceover clip with ElevenLabs and cache word timings.

Writes build/align/NN-<id>.json (raw response) and build/words.json.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
BUILD = ROOT / "build"
ALIGN = BUILD / "align"
CLI = ["npx", "-y", "@elevenlabs/cli@1.11.0"]


def main():
    ALIGN.mkdir(parents=True, exist_ok=True)
    vo = json.loads((BUILD / "vo.json").read_text())
    out = []
    for i, clip in enumerate(vo):
        dest = ALIGN / f"{i:02d}-{clip['id']}.json"
        if not dest.exists():
            print(f"[align] {i:02d} {clip['id']}", flush=True)
            res = subprocess.run(
                CLI + [
                    "forced-alignment", "create",
                    "--file", str(ROOT / clip["file"]),
                    "--text", clip["text"],
                    "--format", "json",
                ],
                check=True, capture_output=True, text=True,
            )
            dest.write_text(res.stdout)
        data = json.loads(dest.read_text())
        words = [
            {"w": w["text"], "s": w["start"], "e": w["end"]}
            for w in data["words"] if w["text"].strip()
        ]
        out.append({"id": clip["id"], "words": words})
        print(f"        {len(words)} words, last end {words[-1]['e']:.2f}s")
    (BUILD / "words.json").write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
