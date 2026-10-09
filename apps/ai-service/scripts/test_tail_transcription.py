"""Tail-check regression: python scripts/test_tail_transcription.py <delivery.wav>

Part 1 is pure signal processing (no model). Part 2 runs the real Whisper model on the real Delivery audio,
with storage stubbed to copy that local file (same pattern as test_whisper_offline.py).
"""
import re
import shutil
import sys
import wave
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np
from fastapi.testclient import TestClient

from app import main
from app.tail_analysis import MAX_TAIL_WINDOW_SEC, measure_tail

RATE = 16000


def tone(seconds, level=0.3):
    t = np.arange(int(seconds * RATE)) / RATE
    # Amplitude-modulated noise-ish tone: speech-like energy, deterministic.
    return (level * np.sin(2 * np.pi * 180 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))).astype(np.float32)


def silence(seconds):
    return np.zeros(int(seconds * RATE), dtype=np.float32) + 1e-4


# ---- Part 1: acoustic decisions on synthetic audio -------------------------------------------------------------
# 1. Speech then a real pause: the cut is a stop.
audio = np.concatenate([tone(3.0), silence(0.8)])
ac = measure_tail(audio, RATE, 0.0, 3.0, [(0.0, 3.0)])
assert ac.stopped and ac.speech_continues is False and ac.post_silence_ms >= 300, ac

# 2. Speech continues well past the stated word end (ASR missed words): not a stop.
audio = np.concatenate([tone(3.0), tone(1.0)])
ac = measure_tail(audio, RATE, 0.0, 3.0, [(0.0, 3.0)])
assert ac.speech_continues is True and not ac.stopped, ac

# 3. The audio ends with the word (Delivery's situation). Level/slope cannot tell a finished word from a cut one,
#    so the result must be indeterminate - neither a clean stop nor a claimed cut.
for tail in (0.0, 0.11):
    audio = np.concatenate([tone(3.0), silence(tail)]) if tail else tone(3.0)
    ac = measure_tail(audio, RATE, 0.0, 3.0, [(0.0, 3.0)])
    assert not ac.stopped and ac.speech_continues is None, (tail, ac)
print('Acoustic decisions on synthetic audio: PASS')

# ---- Part 2: the real model on the real Delivery audio ---------------------------------------------------------
source = sys.argv[1] if len(sys.argv) > 1 else None
if not source:
    print('No WAV supplied: model checks skipped')
    sys.exit(0)

storage = Mock()
storage.fget_object.side_effect = lambda bucket, key, path: shutil.copyfile(key if key != 'cut' else cut_path, path)
cut_path = str(Path(source).with_name('tail-test-cut.wav'))
with patch.object(main, 'get_storage_client', return_value=storage), TestClient(main.app) as client:
    def ask(key, start, end, final):
        return client.post('/tail-transcriptions', json={'bucket': 'b', 'object_key': key, 'window_start': start,
                                                         'window_end': end, 'final_word_end': final})

    # Exact production-failure window: the last 8 s of the 27.65 s Delivery source.
    response = ask(source, 19.65, 27.65, 27.54)
    assert response.status_code == 200, response.text
    body = response.json()
    spelled = ' '.join(re.sub(r'[^\w\']', '', w['text']).lower() for w in body['words'])
    print('tail words:', ' '.join(f"{w['text']}[{w['confidence']:.2f}]" for w in body['words']))
    # Everything up to the last word is stable; only the final lexical item is allowed to vary.
    assert 'looks more like a' in spelled, spelled
    assert all(w['confidence'] is not None for w in body['words']), 'faster-whisper word probability must be forwarded'
    # The source ends within ~110 ms of the stated word end: acoustics must be reported as indeterminate, not faked.
    assert not body['acoustics']['stopped'] and body['acoustics']['speech_continues'] is None, body['acoustics']
    assert 50 <= body['acoustics']['audio_ends_ms'] <= 200, body['acoustics']
    print('acoustics:', body['acoustics'])

    # Bounded: a window beyond the cap is refused, never silently widened.
    refused = ask(source, 0, MAX_TAIL_WINDOW_SEC + 2, 5)
    assert refused.status_code == 422, refused.status_code
    assert ask(source, 5, 8, 20).status_code == 422, 'final_word_end outside the window'

    # Control: the same audio cut 0.8 s after a mid-sentence word. Speech runs on past the stated end, so the
    # acoustics must say so (a clean stop would be a false claim).
    with wave.open(source, 'rb') as wav:
        params = wav.getparams()
        wav.setpos(0)
        frames = wav.readframes(int(14.8 * wav.getframerate()))
    with wave.open(cut_path, 'wb') as out:
        out.setparams(params)
        out.writeframes(frames)
    cut = ask('cut', 6.0, 14.8, 14.0)
    assert cut.status_code == 200, cut.text
    ac = cut.json()['acoustics']
    print('continuing-speech acoustics:', ac)
    assert not ac['stopped'], 'speech runs on after the stated end; this must not read as a clean stop'
Path(cut_path).unlink(missing_ok=True)
print('Tail transcription endpoint on the real Delivery audio: PASS')
