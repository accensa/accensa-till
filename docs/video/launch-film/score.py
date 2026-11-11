"""Original score and SFX for the Till launch film.

No sample libraries and no licence questions: every sound is synthesised here from
sines, noise and envelopes. 120 BPM, 30 s, 48 kHz stereo, written to score.wav.

The picture is choreographed to this grid (beat = 0.5 s), so the cue times below are
the same numbers the HTML's timeline uses: panel hits at 1.0/4.0/9.0/14.0/19.0/24.0,
step ticks at 9.5/10.5/11.5/12.5, clicks at 6.30/17.25.
"""

from __future__ import annotations

import array
import math
import random
import wave

RATE = 48_000
DURATION = 30.0
FRAMES = int(RATE * DURATION)
BEAT = 0.5

left = array.array("f", [0.0]) * FRAMES
right = array.array("f", [0.0]) * FRAMES

rng = random.Random(20261111)


def add(index: int, value: float, pan: float = 0.0) -> None:
    if index < 0 or index >= FRAMES:
        return
    l_gain = math.sqrt((1.0 - pan) / 2.0)
    r_gain = math.sqrt((1.0 + pan) / 2.0)
    left[index] += value * l_gain
    right[index] += value * r_gain


def add_burst(start: float, length: float, shape: str, freq: float, gain: float, pan: float = 0.0) -> None:
    begin = int(start * RATE)
    count = int(length * RATE)
    for i in range(count):
        t = i / RATE
        p = i / count
        if shape == "kick":
            env = math.exp(-9.0 * p)
            v = math.sin(2.0 * math.pi * (freq * (1.0 + 0.9 * math.exp(-30.0 * p))) * t) * env
        elif shape == "hat":
            env = math.exp(-26.0 * p)
            v = (rng.random() * 2.0 - 1.0) * env
        elif shape == "noise":
            env = math.exp(-5.0 * p)
            v = (rng.random() * 2.0 - 1.0) * env
        else:
            env = math.exp(-5.5 * p)
            v = math.sin(2.0 * math.pi * freq * t) * env
        add(begin + i, v * gain, pan)


def add_tone(start: float, length: float, freq: float, gain: float, attack: float, decay: float, pan: float = 0.0) -> None:
    begin = int(start * RATE)
    count = int(length * RATE)
    for i in range(count):
        t = i / RATE
        if t < attack:
            env = t / attack
        else:
            env = math.exp(-decay * (t - attack))
        # A soft second harmonic gives the plucks some body without a filter.
        v = (math.sin(2.0 * math.pi * freq * t) + 0.22 * math.sin(4.0 * math.pi * freq * t)) * env
        add(begin + i, v * gain, pan)


def pad_chord(start: float, length: float, notes: list[float], gain: float) -> None:
    begin = int(start * RATE)
    count = int(length * RATE)
    for i in range(count):
        t = i / RATE
        attack = min(1.0, t / 0.6)
        release = 1.0
        if t > length - 0.8:
            release = max(0.0, (length - t) / 0.8)
        env = attack * release
        v = 0.0
        for n, freq in enumerate(notes):
            detune = 1.0 + (n - 1) * 0.0016
            v += math.sin(2.0 * math.pi * freq * detune * t)
            v += 0.35 * math.sin(2.0 * math.pi * freq * 2.0 * detune * t)
        # Slight delay on the right channel widens the pad without a plugin.
        add(begin + i, v * env * gain / len(notes), -0.25)
        add(begin + i + 240, v * env * gain / len(notes), 0.25)


# --- Kick grid -----------------------------------------------------------------
for beat in range(int(DURATION / BEAT)):
    at = beat * BEAT
    if 4.0 <= at <= 27.5 or beat in (2, 6, 7):
        add_burst(at, 0.24, "kick", 56.0, 0.5)
    if at >= 8.0 and at < 28.0:
        add_burst(at + BEAT / 2.0, 0.08, "hat", 0.0, 0.12, 0.25)

# --- Impacts on the scene cuts -------------------------------------------------
for at in (1.0, 4.0, 9.0, 14.0, 19.0, 24.0):
    add_burst(at, 0.5, "kick", 48.0, 0.55)
    add_burst(at, 0.4, "noise", 0.0, 0.12, -0.15)

# --- Bass ----------------------------------------------------------------------
ROOTS = [55.0, 43.65, 65.41, 49.0]  # A1, F1, C2, G1
for bar in range(int(DURATION / 2.0)):
    root = ROOTS[bar % 4]
    for eighth in range(8):
        at = bar * 2.0 + eighth * 0.25
        if at < 3.5 or at > 28.0:
            continue
        freq = root * (2.0 if eighth % 4 == 3 else 1.0)
        add_tone(at, 0.22, freq, 0.20, 0.005, 16.0, -0.05)

# --- Arp -----------------------------------------------------------------------
SCALE = [220.0, 261.63, 329.63, 392.0, 440.0, 523.25]
for step in range(int(DURATION / 0.25)):
    at = step * 0.25
    if at < 8.0 or at > 27.5:
        continue
    if step % 8 in (0, 3, 6):
        freq = SCALE[(step * 3) % len(SCALE)]
        add_tone(at, 0.20, freq, 0.05, 0.004, 22.0, 0.3 if step % 2 else -0.3)

# --- Pads ----------------------------------------------------------------------
CHORDS = [
    (0.0, 4.0, [110.0, 130.81, 164.81]),
    (4.0, 9.0, [110.0, 130.81, 164.81]),
    (9.0, 14.0, [87.31, 110.0, 130.81]),
    (14.0, 19.0, [130.81, 164.81, 196.0]),
    (19.0, 24.0, [98.0, 123.47, 146.83]),
    (24.0, 29.2, [110.0, 130.81, 164.81]),
]
for start, stop, notes in CHORDS:
    pad_chord(start, stop - start, notes, 0.16)

# --- Risers into the drop and the close ---------------------------------------
for start, stop in ((7.4, 9.0), (22.4, 24.0)):
    begin = int(start * RATE)
    count = int((stop - start) * RATE)
    for i in range(count):
        p = i / count
        v = (rng.random() * 2.0 - 1.0) * (p**2) * 0.16
        add(begin + i, v, -0.4 + 0.8 * p)

# --- UI SFX, on the same grid the picture uses --------------------------------
for at in (9.5, 10.5, 11.5, 12.5):
    add_tone(at, 0.16, 1760.0, 0.10, 0.002, 30.0)
for at in (6.30, 17.25):
    add_tone(at, 0.09, 2400.0, 0.12, 0.001, 40.0)
    add_burst(at, 0.12, "noise", 0.0, 0.06, 0.1)
for at in (15.0, 15.62, 16.24, 16.86, 17.48):
    add_tone(at, 0.05, 3200.0, 0.035, 0.001, 60.0)

# --- Master --------------------------------------------------------------------
peak = 1.0
for i in range(FRAMES):
    peak = max(peak, abs(left[i]), abs(right[i]))

gain = 0.9 / peak if peak > 0 else 1.0
fade_in = int(0.25 * RATE)
fade_out = int(1.2 * RATE)

frames = array.array("h")
for i in range(FRAMES):
    env = 1.0
    if i < fade_in:
        env = i / fade_in
    if i > FRAMES - fade_out:
        env *= max(0.0, (FRAMES - i) / fade_out)
    l = max(-1.0, min(1.0, left[i] * gain * env))
    r = max(-1.0, min(1.0, right[i] * gain * env))
    frames.append(int(l * 32767))
    frames.append(int(r * 32767))

with wave.open("score.wav", "wb") as out:
    out.setnchannels(2)
    out.setsampwidth(2)
    out.setframerate(RATE)
    out.writeframes(frames.tobytes())

print(f"wrote score.wav  {DURATION:.0f}s  peak {peak:.3f}  normalized {0.9 / peak if peak else 1:.3f}")
