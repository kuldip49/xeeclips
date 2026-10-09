"""Raw Whisper arrays must be 16 kHz; other WAV rates require the model's decoder/resampler."""
import tempfile
import unittest
import wave
from pathlib import Path
from app.main import _chunk_bounds


class TranscriptionSampleRateTests(unittest.TestCase):
    def test_other_pcm_rates_use_resampling_decoder(self):
        with tempfile.TemporaryDirectory() as directory:
            for rate in [8000, 22050, 44100, 48000]:
                file = Path(directory) / f'{rate}.wav'
                with wave.open(str(file), 'wb') as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(rate)
                    output.writeframes(bytes(rate * 2))
                self.assertIsNone(_chunk_bounds(str(file)), rate)

    def test_canonical_audio_keeps_timestamp_backed_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'canonical.wav'
            with wave.open(str(file), 'wb') as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(16000)
                output.writeframes(bytes(16000 * 2))
            self.assertEqual(_chunk_bounds(str(file)), (16000, [(0, 16000)]))


if __name__ == '__main__':
    unittest.main()
