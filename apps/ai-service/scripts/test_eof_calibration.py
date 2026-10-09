"""End-of-file classification regression on the three real acceptance clips: python scripts/test_eof_calibration.py <human-review dir>

Natural ends (the file is cut at the last voiced frame before a >= 300 ms silence) must almost never read as VOICE_CONTINUING;
cuts through continuous speech must usually do so and rarely read as TRAILING_SILENCE. The window is the last 8 s,
exactly what the tail endpoint sees.
"""
import random
import sys
import wave

import numpy as np

from app.tail_analysis import classify_eof, frame_db

base = sys.argv[1].replace(chr(92), '/').rstrip('/') + '/'


def load(path):
    with wave.open(path, 'rb') as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float32) / 32768.0


nat, mid = [], []
random.seed(11)
for name in ('delivery', 'advice', 'cultural-fusion'):
    a = load(f'{base}{name}/{name}.wav')
    db = frame_db(a, 16000)
    speech = float(np.percentile(db[db > -60], 90))
    voiced = db > speech - 20
    for i in range(10, len(db) - 40):
        if voiced[i] and not voiced[i + 1:i + 31].any() and voiced[i - 8:i + 1].sum() >= 6:
            for off in (0, 2, 4):
                cut = int((i + 1 + off) * 160)
                if cut > 16000 * 6:
                    nat.append(classify_eof(a[:cut][-16000 * 8:], 16000)[0])
    pool = [i for i in range(300, len(db) - 40) if voiced[i - 5:i + 31].all()]
    for i in random.sample(pool, min(len(pool), 120)):
        mid.append(classify_eof(a[:i * 160][-16000 * 8:], 16000)[0])
frac = lambda xs, c: sum(x == c for x in xs) / len(xs)
print(f'natural n={len(nat)}: continuing {frac(nat, "VOICE_CONTINUING"):.2f} trailing {frac(nat, "TRAILING_SILENCE"):.2f} indeterminate {frac(nat, "INDETERMINATE"):.2f}')
print(f'mid-speech n={len(mid)}: continuing {frac(mid, "VOICE_CONTINUING"):.2f} trailing {frac(mid, "TRAILING_SILENCE"):.2f} indeterminate {frac(mid, "INDETERMINATE"):.2f}')
assert len(nat) >= 20 and len(mid) >= 300
# Measured on this sample: natural 0.03 / 0.90 / 0.07, mid-speech 0.87 / 0.09 / 0.04 (continuing / trailing / indeterminate). A false
# VOICE_CONTINUING on a naturally finished source costs a rejected clip (the safe direction); the sample is small (n = 29).
assert frac(nat, 'VOICE_CONTINUING') <= 0.10, 'a naturally finished voice should almost never read as continuing'
assert frac(nat, 'TRAILING_SILENCE') >= 0.75
assert frac(mid, 'VOICE_CONTINUING') >= 0.80
assert frac(mid, 'TRAILING_SILENCE') <= 0.12
print('EOF calibration on the real clips: PASS')
