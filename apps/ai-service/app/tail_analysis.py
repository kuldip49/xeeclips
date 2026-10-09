"""Bounded tail check for acceptance-critical clip endings.

The backend asks for this only when the last word of a clip decides pass/fail and the first ASR pass looks
unstable. It re-transcribes ONE short window (never the whole source) and measures what the audio itself does
at the cut, so the ending verdict does not rest on the spelling of a single token.

Everything here is measured from the audio or reported by faster-whisper; nothing is invented. The word
`confidence` is faster-whisper's per-word probability, exactly as the main transcription reports it.
"""
from __future__ import annotations

import math
import wave
from dataclasses import dataclass

MAX_TAIL_WINDOW_SEC = 12.0
FRAME_SEC = 0.01
# Trailing silence this far below speech level, from 150 ms after the stated word end onward, is a real stop.
STOP_DROP_DB = 18.0
# Voice this close to speech level well after the stated word end means the speech runs on.
CONTINUES_DROP_DB = 12.0
# ASR word ends are estimates (and least reliable for the uncertain word). Audio that ends within this span of the
# stated word end cannot tell a finished word from a cut one: measured energy level and slope do NOT separate natural
# offsets from mid-word cuts (the two distributions overlap almost completely), so the result is left indeterminate.
INDETERMINATE_AUDIO_SEC = 0.25
POST_LOOKAHEAD_SEC = 0.6


@dataclass(frozen=True)
class TailAcoustics:
    """`stopped`: trailing silence follows the last word. `speech_continues`: voice runs on past it. When the audio
    ends with the word neither can be established, so `stopped` is False and `speech_continues` is None."""
    final_word_end: float
    speech_db: float | None
    boundary_db: float | None
    post_silence_ms: float
    audio_ends_ms: float
    stopped: bool
    speech_continues: bool | None


def frame_db(audio, rate: int):
    """10 ms RMS in dBFS. `audio` is a float32 mono numpy array."""
    import numpy as np
    step = max(1, int(rate * FRAME_SEC))
    usable = audio.size - audio.size % step
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    frames = audio[:usable].reshape(-1, step)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    return 20.0 * np.log10(np.maximum(rms, 1e-7))


def measure_tail(audio, rate: int, window_start: float, final_word_end: float,
                 word_spans: list[tuple[float, float]]) -> TailAcoustics:
    """What the audio does after `final_word_end` (absolute seconds in the source)."""
    import numpy as np
    db = frame_db(audio, rate)
    window_sec = audio.size / rate
    rel_end = final_word_end - window_start
    audio_ends_ms = max(0.0, (window_sec - rel_end) * 1000.0)
    if db.size == 0 or rel_end <= 0:
        return TailAcoustics(final_word_end, None, None, 0.0, audio_ends_ms, False, None)

    spans = [db[int(max(0, a - window_start) / FRAME_SEC):int(max(0, b - window_start) / FRAME_SEC) + 1]
             for a, b in word_spans]
    voiced = np.concatenate(spans) if any(v.size for v in spans) else db
    speech_db = float(np.percentile(voiced, 90))
    if window_sec - rel_end < INDETERMINATE_AUDIO_SEC:
        return TailAcoustics(final_word_end, speech_db, None, 0.0, audio_ends_ms, False, None)

    first = int(math.ceil((rel_end + 0.15) / FRAME_SEC))
    last = min(db.size, int((rel_end + POST_LOOKAHEAD_SEC) / FRAME_SEC))
    post = db[first:last]
    boundary_db = float(np.median(post))
    quiet = post <= speech_db - STOP_DROP_DB
    run = 0
    for flag in quiet:
        if not flag:
            break
        run += 1
    continues = float(np.percentile(post, 75)) > speech_db - CONTINUES_DROP_DB
    return TailAcoustics(final_word_end, speech_db, boundary_db, (run + 15) * FRAME_SEC * 1000.0 if run else 0.0,
                         audio_ends_ms, bool(quiet.mean() >= 0.8) and not continues, continues)


def read_window(path: str, start: float, end: float):
    """16 kHz mono float32 audio for [start, end] seconds. Returns (audio, rate, actual_start, audio_duration)."""
    import numpy as np
    try:
        with wave.open(path, 'rb') as wav:
            if wav.getnchannels() == 1 and wav.getsampwidth() == 2 and wav.getframerate() == 16000:
                rate, total = wav.getframerate(), wav.getnframes()
                lo = max(0, int(start * rate))
                hi = min(total, int(end * rate))
                wav.setpos(min(lo, total))
                frames = wav.readframes(max(0, hi - lo))
                return np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0, rate, lo / rate, total / rate
    except (wave.Error, EOFError):
        pass
    from faster_whisper.audio import decode_audio
    audio = decode_audio(path, sampling_rate=16000)
    lo, hi = max(0, int(start * 16000)), min(audio.size, int(end * 16000))
    return audio[lo:hi].astype(np.float32), 16000, lo / 16000, audio.size / 16000
