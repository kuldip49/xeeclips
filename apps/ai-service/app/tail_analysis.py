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

# End-of-file (EOF) classification, for windows that reach the end of the source audio. The word end that ASR reports is only good
# to ~100 ms, so the file's own ending is judged from the waveform: the level of its last 30 ms against (a) the speech level of
# the window and (b) the body of the word that is ending. A voice that stops naturally has already decayed by the last frames;
# a cut through speech has not. Calibrated on the three real acceptance clips (natural ends cut at the voicing offset, n=29;
# mid-speech cuts, n=360): natural ends sit at body drop <= -10.4 dB (p90), cuts at >= -7.0 dB (p10). The silero VAD gap was
# measured too and is useless here (0 ms for every file), so it is not used.
EOF_REACH_SEC = 0.05            # the window counts as reaching EOF when it ends within this of the end of the audio
EOF_CONTINUES_BODY_DB = -7.0    # end level within 7 dB of the word's own body: voice is still going
EOF_CLOSED_BODY_DB = -10.0      # decayed by 10 dB or more below the word body: the voice has finished
EOF_CLOSED_LEVEL_DB = -16.0     # or simply quiet against the speech level
EOF_MIN_SILENCE_FRAMES = 10     # <= 90 ms after an abrupt drop can be codec padding, not an audible pause
EOF_ABRUPT_DROP_DB = 15.0
EOF_CLASSES = ('TRAILING_SILENCE', 'VOICE_CONTINUING', 'INDETERMINATE')


def classify_eof(audio, rate: int):
    """(class, level_db, body_drop_db) for the END of `audio`. Level is relative to the window's speech level (90th percentile)."""
    import numpy as np
    db = frame_db(audio, rate)
    live = db[db > -60.0]
    if db.size < 40 or live.size < 10:
        return 'INDETERMINATE', None, None
    speech = float(np.percentile(live, 90))
    quiet = db <= speech + EOF_CLOSED_LEVEL_DB
    trailing = 0
    for is_quiet in quiet[::-1]:
        if not is_quiet:
            break
        trailing += 1
    if 0 < trailing < EOF_MIN_SILENCE_FRAMES and db.size - trailing >= 40:
        edge = db.size - trailing
        # AAC decoding may append a few silent frames to a file cut through voiced speech. Those frames must not
        # turn the cut into closure. Judge the voice immediately BEFORE a short, abrupt drop; no ASR timestamp is used.
        if float(db[edge - 1] - db[edge]) >= EOF_ABRUPT_DROP_DB:
            db = db[:edge]
    level = float(np.median(db[-3:]) - speech)
    body = float(np.median(db[-30:-5]) - speech)
    drop = level - body
    if level <= EOF_CLOSED_LEVEL_DB or drop <= EOF_CLOSED_BODY_DB:
        return 'TRAILING_SILENCE', level, drop
    if drop > EOF_CONTINUES_BODY_DB:
        return 'VOICE_CONTINUING', level, drop
    return 'INDETERMINATE', level, drop


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
    # Only when the window reaches the end of the source audio; None otherwise.
    eof: str | None = None
    eof_level_db: float | None = None
    eof_body_drop_db: float | None = None


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
                 word_spans: list[tuple[float, float]], reaches_eof: bool = False) -> TailAcoustics:
    """What the audio does after `final_word_end` (absolute seconds in the source). `reaches_eof`: the window ends at the end of the source."""
    import numpy as np
    eof = classify_eof(audio, rate) if reaches_eof else (None, None, None)
    db = frame_db(audio, rate)
    window_sec = audio.size / rate
    rel_end = final_word_end - window_start
    audio_ends_ms = max(0.0, (window_sec - rel_end) * 1000.0)
    if db.size == 0 or rel_end <= 0:
        return TailAcoustics(final_word_end, None, None, 0.0, audio_ends_ms, False, None, *eof)

    spans = [db[int(max(0, a - window_start) / FRAME_SEC):int(max(0, b - window_start) / FRAME_SEC) + 1]
             for a, b in word_spans]
    voiced = np.concatenate(spans) if any(v.size for v in spans) else db
    speech_db = float(np.percentile(voiced, 90))
    if window_sec - rel_end < INDETERMINATE_AUDIO_SEC:
        return TailAcoustics(final_word_end, speech_db, None, 0.0, audio_ends_ms, False, None, *eof)

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
                         audio_ends_ms, bool(quiet.mean() >= 0.8) and not continues, continues, *eof)


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
