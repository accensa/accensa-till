#!/usr/bin/env python3
"""Synthesise the film's original score and sound design.

No samples and no third-party libraries: wavetable oscillators, one-pole
filters and a small delay network, written straight into 16-bit WAV files.
The score is composed to the edit at 120 BPM.

Outputs
  build/audio/score.wav       104 s stereo bed
  build/audio/sfx/<name>.wav  the sound palette
  build/audio/sfx.json        palette metadata for mix_audio.py
"""

import json
import math
import random
import sys
import time
import wave
from array import array
from pathlib import Path

SR = 44100
ROOT = Path(__file__).parent.resolve()
OUT = ROOT / "build" / "audio"
# The cut's length is whatever the timeline says: a re-recorded line must not
# leave the score a fraction of a second short of the picture.
DUR = float(json.loads((ROOT / "build" / "timeline.json").read_text())["duration"])
N = int(SR * DUR)

TBL = 8192
SIN = [math.sin(2 * math.pi * i / TBL) for i in range(TBL)]
TRI = [2 * abs(2 * i / TBL - 1) - 1 for i in range(TBL)]
rng = random.Random(1102)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def alloc(n=N):
    return array("f", bytes(4 * n)), array("f", bytes(4 * n))


def add_note(L, R, t0, dur, freq, amp=0.08, pan=0.0, shape="sine",
             attack=0.006, decay=0.35, release=0.06, fc=9000, det=0.0):
    """One voice. Attack/decay/release are seconds; decay is an exp constant."""
    n = int(dur * SR)
    i0 = int(round(t0 * SR))
    if n <= 0 or i0 >= len(L):
        return
    if i0 < 0:
        n += i0
        i0 = 0
    n = min(n, len(L) - i0)
    if n <= 0:
        return

    atk_n = max(1, int(attack * SR))
    rel_n = max(1, int(release * SR))
    dec_f = math.exp(-1.0 / max(1e-4, decay * SR))
    alpha = 1 - math.exp(-2 * math.pi * min(fc, SR * 0.45) / SR)
    gl = math.sqrt((1 - pan) * 0.5) * 1.414
    gr = math.sqrt((1 + pan) * 0.5) * 1.414

    table = SIN if shape == "sine" else TRI if shape == "tri" else None
    p1 = 0
    p2 = 0
    dp1 = int(freq / SR * TBL * 65536)
    dp2 = int(freq * (1 + det) / SR * TBL * 65536)
    env = 1.0
    lp = 0.0
    mask = TBL - 1

    for k in range(n):
        if table is not None:
            x = table[(p1 >> 16) & mask]
            if det:
                x = (x + table[(p2 >> 16) & mask]) * 0.5
            p1 += dp1
            p2 += dp2
        else:  # saw
            x = 2 * (((p1 >> 16) & mask) / TBL) - 1
            if det:
                x = (x + (2 * (((p2 >> 16) & mask) / TBL) - 1)) * 0.5
            p1 += dp1
            p2 += dp2
        lp += alpha * (x - lp)
        env *= dec_f
        a = k / atk_n
        if a > 1.0:
            a = 1.0
        r = (n - k) / rel_n
        if r > 1.0:
            r = 1.0
        s = lp * env * a * r * amp
        L[i0 + k] += s * gl
        R[i0 + k] += s * gr


def kick(L, R, t0, amp=0.5, dur=0.42, f0=132.0, f1=44.0):
    i0 = int(t0 * SR)
    n = min(int(dur * SR), len(L) - i0)
    if n <= 0 or i0 < 0:
        return
    phase = 0.0
    env = 1.0
    envf = math.exp(-1.0 / (0.10 * SR))
    for k in range(n):
        t = k / n
        f = f1 + (f0 - f1) * math.exp(-t * 7.0)
        phase += f / SR
        if k < 90:
            click = (rng.random() * 2 - 1) * (1 - k / 90) * 0.35
        else:
            click = 0.0
        s = (math.sin(2 * math.pi * phase) * 0.9 + click) * env * amp
        L[i0 + k] += s
        R[i0 + k] += s
        env *= envf


def hat(L, R, t0, amp=0.05, dur=0.09, pan=0.18):
    i0 = int(t0 * SR)
    n = min(int(dur * SR), len(L) - i0)
    if n <= 0 or i0 < 0:
        return
    env = 1.0
    envf = math.exp(-1.0 / (0.018 * SR))
    prev = 0.0
    gl = math.sqrt((1 - pan) * 0.5) * 1.414
    gr = math.sqrt((1 + pan) * 0.5) * 1.414
    for k in range(n):
        x = rng.random() * 2 - 1
        hp = x - prev * 0.92
        prev = x
        s = hp * env * amp
        L[i0 + k] += s * gl
        R[i0 + k] += s * gr
        env *= envf


def noise_sweep(L, R, t0, dur, amp=0.12, up=True, pan=0.0):
    i0 = int(t0 * SR)
    n = min(int(dur * SR), len(L) - i0)
    if n <= 0 or i0 < 0:
        return
    lo = 0.02
    prev = 0.0
    gl = math.sqrt((1 - pan) * 0.5) * 1.414
    gr = math.sqrt((1 + pan) * 0.5) * 1.414
    for k in range(n):
        x = k / n
        f = (x if up else 1 - x) ** 2
        a = lo + (1 - lo) * f
        nz = rng.random() * 2 - 1
        prev += a * (nz - prev)
        env = math.sin(math.pi * x) ** 1.6
        s = prev * env * amp
        L[i0 + k] += s * gl
        R[i0 + k] += s * gr


def reverb(L, R, wet=0.30):
    """Small stereo delay network: two damped combs and a diffuse tap."""
    d1 = int(0.171 * SR)
    d2 = int(0.263 * SR)
    d3 = int(0.037 * SR)
    b1 = array("f", bytes(4 * d1))
    b2 = array("f", bytes(4 * d2))
    p1 = p2 = 0
    lp1 = lp2 = 0.0
    for i in range(len(L)):
        x = (L[i] + R[i]) * 0.5
        y1 = b1[p1]
        y2 = b2[p2]
        lp1 += 0.30 * (y1 - lp1)
        lp2 += 0.26 * (y2 - lp2)
        b1[p1] = x + lp2 * 0.74
        b2[p2] = lp1 * 0.66 + x * 0.18
        p1 = (p1 + 1) % d1
        p2 = (p2 + 1) % d2
        w = lp1 * wet
        L[i] += w * 0.92
        R[i] += w
        # diffuser: one early reflection pair
        if i >= d3:
            L[i] += L[i - d3] * 0.05
            R[i] += R[i - d3] * 0.04


CHORDS = {
    "Dm":  ([50, 53, 57], 38),
    "Bb":  ([46, 50, 53], 34),
    "F":   ([41, 45, 48], 29),
    "C":   ([48, 52, 55], 36),
    "A":   ([45, 49, 52], 33),
    "Bbmaj7": ([46, 50, 53, 57], 34),
}
GROOVE = ["Dm", "Bb", "F", "C"]


def chord(t0, dur, name, amp=0.055, bright=1500, attack=0.5, release=0.9):
    notes, root = CHORDS[name]
    for n in notes:
        add_note(L, R, t0, dur, midi(n), amp=amp, pan=-0.25,
                 shape="saw", attack=attack, decay=6.0, release=release,
                 fc=bright, det=0.004)
    add_note(L, R, t0, dur, midi(notes[-1] + 24), amp=amp * 0.22, shape="sine",
             attack=attack, decay=6.0, release=release, fc=8000)
    add_note(L, R, t0, dur, midi(root), amp=amp * 0.9, shape="sine",
             attack=attack * 0.8, decay=8.0, release=release, fc=400)


def bass(t0, dur, note, amp=0.11):
    add_note(L, R, t0, dur, midi(note), amp=amp, shape="sine",
             attack=0.006, decay=0.22, release=0.03, fc=300)


def pluck(t0, note, amp=0.05, pan=0.2, bright=2600):
    add_note(L, R, t0, 0.55, midi(note), amp=amp, pan=pan, shape="tri",
             attack=0.002, decay=0.16, release=0.12, fc=bright)


def hit(t0, amp=0.55):
    kick(L, R, t0, amp=amp, dur=0.55, f0=150, f1=38)
    add_note(L, R, t0, 0.9, midi(26), amp=amp * 0.5, shape="sine",
             attack=0.004, decay=0.35, release=0.2, fc=200)
    noise_sweep(L, R, t0, 1.1, amp=0.16, up=False)


def intro():
    prog = [("Dm", 0.0, 6.0), ("Bb", 6.0, 6.0), ("Dm", 12.0, 6.0), ("Bb", 18.0, 3.0)]
    for name, t, d in prog:
        chord(t, d, name, amp=0.036, bright=1500, attack=1.4, release=1.4)
    # heartbeat
    for b in range(1, 10):
        kick(L, R, b * 2.0, amp=0.16, dur=0.5, f0=110, f1=42)
    for t in (4.0, 10.0, 16.0, 19.0):
        pluck(t, [74, 81, 77, 82][int(t) % 4], amp=0.055, pan=0.3, bright=3200)
    noise_sweep(L, R, 17.0, 4.0, amp=0.10, up=True, pan=-0.1)


def groove():
    t = 21.0
    bar = 0
    while t < 62.9:
        name = GROOVE[bar % 4]
        notes, root = CHORDS[name]
        if bar % 2 == 0:
            chord(t, 4.0, name, amp=0.044, bright=2300)
        # bass pulse on eighths
        for e in range(8):
            n = root + (12 if e in (3, 6) else 0)
            bass(t + e * 0.25, 0.22, n, amp=0.058 if e % 2 == 0 else 0.044)
        # kick on 1 and 3, soft extra on the "and" of 3
        kick(L, R, t, amp=0.21)
        kick(L, R, t + 1.0, amp=0.18)
        kick(L, R, t + 1.75, amp=0.11)
        # hats on eighths
        for e in range(8):
            hat(L, R, t + e * 0.25, amp=0.062 if e % 2 == 0 else 0.042)
        # arp on sixteenths
        seq = [notes[0], notes[1], notes[2], notes[1] + 12]
        for s in range(16):
            note = seq[s % 4] + (12 if s >= 12 else 0)
            pluck(t + s * 0.125, note, amp=0.046 if s % 4 else 0.060,
                  pan=0.25 if s % 2 else -0.15)
        t += 2.0
        bar += 1


def lift():
    t = 63.0
    names = ["F", "C", "Dm", "Bb"]
    for i, name in enumerate(names):
        t0 = t + i * 2.9
        chord(t0, 3.0, name, amp=0.055, bright=1800)
        notes, root = CHORDS[name]
        for e in range(6):
            bass(t0 + e * 0.25, 0.2, root, amp=0.050)
            hat(L, R, t0 + e * 0.25, amp=0.050)
        kick(L, R, t0, amp=0.14)
        kick(L, R, t0 + 1.0, amp=0.12)
        for s in range(8):
            pluck(t0 + s * 0.25, notes[s % 3] + 12, amp=0.048, pan=0.35)


def tense():
    chord(74.5, 8.25, "Bbmaj7", amp=0.06, bright=1100, attack=0.8, release=0.6)

    def add_note_cluster():
        # E natural over Bb: the unresolved part
        add_note(L, R, 75.0, 7.0, midi(76), amp=0.018, shape="sine",
                 attack=1.2, decay=4.0, release=1.0, fc=2400)
        add_note(L, R, 76.5, 5.5, midi(88), amp=0.010, shape="sine",
                 attack=1.5, decay=3.0, release=1.0, fc=5000)
    add_note_cluster()
    t = 74.5
    while t < 82.6:
        bass(t, 0.18, 34, amp=0.060)
        t += 0.5
    for i in range(8):
        hat(L, R, 74.5 + i * 1.0, amp=0.020, dur=0.16)


def drive():
    t = 82.75
    names = ["Dm", "A", "Dm", "A"]
    for i, name in enumerate(names):
        t0 = t + i * 1.8
        chord(t0, 2.0, name, amp=0.05, bright=1700, attack=0.25)
        notes, root = CHORDS[name]
        for e in range(8):
            bass(t0 + e * 0.225, 0.18, root + (12 if e % 4 == 3 else 0), amp=0.055)
        for b in range(4):
            kick(L, R, t0 + b * 0.45, amp=0.15 if b % 2 == 0 else 0.11)
        for s in range(8):
            hat(L, R, t0 + s * 0.225, amp=0.062)
        for s in range(6):
            pluck(t0 + s * 0.3, notes[s % 3], amp=0.050, pan=-0.2)


def close():
    hit(90.0, amp=0.5)
    chord(90.0, 10.0, "Dm", amp=0.065, bright=1400, attack=0.35, release=2.5)
    add_note(L, R, 90.0, 12.0, midi(38), amp=0.11, shape="sine",
             attack=0.3, decay=9.0, release=2.0, fc=300)
    # Dm add9 colour
    for n in (50, 53, 57, 64):
        add_note(L, R, 92.0, 8.0, midi(n), amp=0.035, pan=0.1,
                 shape="saw", attack=1.4, decay=5.0, release=2.0,
                 fc=1600, det=0.003)
    for t, n in ((91.0, 74), (92.5, 77), (94.0, 81), (95.5, 76)):
        pluck(t, n, amp=0.032, pan=0.25, bright=2000)
    noise_sweep(L, R, 96.0, 6.0, amp=0.05, up=True, pan=0.0)


# ---------------------------------------------------------------- sound design

def sfx_write(name, L, R):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.wav"
    norm = 1.0
    peak = max(max((abs(v) for v in L), default=0), max((abs(v) for v in R), default=0))
    if peak > 0:
        norm = 0.85 / peak
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        deck = bytearray()
        for i in range(len(L)):
            for v in (L[i] * norm, R[i] * norm):
                q = int(max(-1.0, min(1.0, v)) * 32767)
                deck += (q & 0xFFFF).to_bytes(2, "little")
        w.writeframes(bytes(deck))
    return path.name


def sfx_bank():
    bank = {}
    spec = {
        "blip": 0.35, "blip_hi": 0.35, "whoosh": 0.9, "whoosh_long": 1.4,
        "click": 0.18, "toggle": 0.35, "gate": 0.7, "impact": 1.2,
        "chime": 1.6, "chime_up": 1.8, "alert": 1.4, "stamp": 0.6,
        "coin": 0.7, "type": 2.2, "hiss": 1.2, "swell": 2.6,
        "lock": 0.5, "sparkle": 1.1, "ui": 0.4, "pen": 1.2,
    }
    for name, dur in spec.items():
        L, R = alloc(int(dur * SR))
        if name == "blip":
            add_note(L, R, 0.01, 0.20, 760, amp=0.5, shape="sine", decay=0.05, fc=5000)
            add_note(L, R, 0.02, 0.16, 1520, amp=0.12, shape="sine", decay=0.03)
        elif name == "blip_hi":
            add_note(L, R, 0.01, 0.22, 1180, amp=0.45, shape="sine", decay=0.05)
            add_note(L, R, 0.02, 0.15, 2360, amp=0.12, shape="sine", decay=0.03)
        elif name == "whoosh":
            noise_sweep(L, R, 0.0, dur, amp=0.5, up=True)
        elif name == "whoosh_long":
            noise_sweep(L, R, 0.0, dur, amp=0.45, up=True, pan=-0.15)
            noise_sweep(L, R, 0.3, dur - 0.4, amp=0.22, up=False, pan=0.2)
        elif name == "click":
            add_note(L, R, 0.0, 0.05, 2100, amp=0.5, shape="sine", decay=0.008, fc=9000)
            add_note(L, R, 0.0, 0.03, 520, amp=0.25, shape="sine", decay=0.006)
        elif name == "toggle":
            add_note(L, R, 0.0, 0.05, 1700, amp=0.4, shape="sine", decay=0.008)
            add_note(L, R, 0.10, 0.06, 1150, amp=0.45, shape="sine", decay=0.010)
        elif name == "gate":
            kick(L, R, 0.0, amp=0.55, dur=0.5, f0=120, f1=48)
            add_note(L, R, 0.02, 0.35, 220, amp=0.18, shape="sine", decay=0.06)
        elif name == "impact":
            kick(L, R, 0.0, amp=0.85, dur=0.9, f0=170, f1=34)
            add_note(L, R, 0.0, 1.0, 41, amp=0.4, shape="sine", decay=0.5, fc=200)
            noise_sweep(L, R, 0.0, 0.8, amp=0.35, up=False)
        elif name in ("chime", "chime_up"):
            notes = [74, 81, 86] if name == "chime_up" else [69, 76, 81]
            for i, n in enumerate(notes):
                add_note(L, R, 0.04 + i * 0.11, 0.9, midi(n), amp=0.20 - i * 0.03,
                         shape="sine", attack=0.004, decay=0.35, release=0.3)
                add_note(L, R, 0.04 + i * 0.11, 0.9, midi(n + 12), amp=0.05,
                         shape="sine", decay=0.2)
        elif name == "alert":
            add_note(L, R, 0.0, 0.5, midi(62), amp=0.28, shape="tri", decay=0.14)
            add_note(L, R, 0.16, 0.7, midi(58), amp=0.28, shape="tri", decay=0.2)
            add_note(L, R, 0.0, 0.4, midi(46), amp=0.16, shape="sine", decay=0.15)
        elif name == "stamp":
            kick(L, R, 0.0, amp=0.5, dur=0.28, f0=180, f1=70)
            noise_sweep(L, R, 0.0, 0.12, amp=0.4, up=False)
        elif name == "coin":
            add_note(L, R, 0.0, 0.35, midi(88), amp=0.25, shape="tri", decay=0.08)
            add_note(L, R, 0.05, 0.5, midi(95), amp=0.18, shape="tri", decay=0.12)
        elif name == "type":
            t = 0.02
            for i in range(14):
                add_note(L, R, t, 0.026, 2400 + (i % 3) * 240, amp=0.24,
                         shape="sine", decay=0.005, fc=9000)
                t += 0.11 + (0.03 if i % 4 == 0 else 0)
        elif name == "hiss":
            noise_sweep(L, R, 0.0, dur, amp=0.28, up=False)
            add_note(L, R, 0.0, 0.5, 5200, amp=0.03, shape="sine", decay=0.2)
        elif name == "swell":
            noise_sweep(L, R, 0.0, dur, amp=0.22, up=True)
            for n in (50, 57, 62, 65):
                add_note(L, R, 0.3, dur - 0.4, midi(n), amp=0.04, shape="saw",
                         attack=1.2, decay=4.0, release=0.8, fc=1800, det=0.004)
        elif name == "lock":
            add_note(L, R, 0.0, 0.09, 320, amp=0.3, shape="sine", decay=0.02)
            add_note(L, R, 0.06, 0.25, 1800, amp=0.2, shape="sine", decay=0.03)
        elif name == "sparkle":
            for i, n in enumerate((86, 93, 98, 90)):
                add_note(L, R, i * 0.07, 0.5, midi(n), amp=0.12, shape="sine",
                         decay=0.12, pan=(-0.3 + i * 0.2))
        elif name == "ui":
            add_note(L, R, 0.0, 0.16, 620, amp=0.25, shape="sine", decay=0.04)
            add_note(L, R, 0.03, 0.12, 1240, amp=0.10, shape="sine", decay=0.03)
        elif name == "pen":
            t = 0.0
            for i in range(11):
                add_note(L, R, t, 0.05, 3200 + rng.random() * 1400, amp=0.14,
                         shape="sine", decay=0.012, pan=0.15)
                t += 0.085 + rng.random() * 0.03
        reverb(L, R, wet=0.22)
        bank[name] = sfx_write(name, L, R)
    (OUT / "sfx.json").write_text(json.dumps(bank, indent=2) + "\n")
    return bank


def main():
    global L, R
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    L, R = alloc()
    print("[audio] score: intro", flush=True)
    intro()
    print("[audio] score: groove", flush=True)
    groove()
    print("[audio] score: lift", flush=True)
    lift()
    print("[audio] score: tense", flush=True)
    tense()
    print("[audio] score: drive", flush=True)
    drive()
    print("[audio] score: close", flush=True)
    close()
    print("[audio] score: reverb + master", flush=True)
    reverb(L, R, wet=0.30)

    # gentle bus glue then peak normalise
    prev_l = prev_r = 0.0
    peak = 0.0
    for i in range(N):
        prev_l += 0.75 * (L[i] - prev_l)
        prev_r += 0.75 * (R[i] - prev_r)
        L[i] = prev_l
        R[i] = prev_r
        peak = max(peak, abs(prev_l), abs(prev_r))
    gain = 0.90 / peak if peak else 1.0
    path = OUT / "score.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        deck = bytearray()
        for i in range(N):
            a = int(max(-1.0, min(1.0, L[i] * gain)) * 32767)
            b = int(max(-1.0, min(1.0, R[i] * gain)) * 32767)
            deck += (a & 0xFFFF).to_bytes(2, "little")
            deck += (b & 0xFFFF).to_bytes(2, "little")
        w.writeframes(bytes(deck))
    print(f"[audio] score.wav {path.stat().st_size/1e6:.1f} MB  peak {peak:.2f}")
    print("[audio] sound design", flush=True)
    sfx_bank()
    print(f"[audio] done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
