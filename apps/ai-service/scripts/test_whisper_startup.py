"""Run: python -m unittest discover -s scripts -p test_whisper_startup.py"""
import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException, Response
from app import main


class WhisperStartupTests(unittest.TestCase):
    def run_startup(self, check):
        async def run():
            async with main.lifespan(main.app):
                check()
        asyncio.run(run())

    def test_local_model_reused_without_loading_during_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'tokenizer.json').write_text('{}')
            model = Mock()
            model.transcribe.side_effect = lambda *a, **k: (
                iter([SimpleNamespace(start=0, end=1, text=' hello ')]),
                SimpleNamespace(language='en', language_probability=1, duration=1),
            )
            storage = Mock()
            storage.fget_object.side_effect = lambda b, k, p: Path(p).write_bytes(b'audio')
            with patch.dict(main.os.environ, {'WHISPER_MODEL_PATH': directory,
                     'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}), \
                 patch.object(main, 'WhisperModel', return_value=model) as loader, \
                 patch.object(main, 'get_storage_client', return_value=storage):
                def check():
                    self.assertEqual(main.health(Response())['status'], 'ok')
                    for _ in range(2):
                        result = main.transcribe(main.TranscriptionRequest(bucket='test', object_key='a.wav'))
                        self.assertEqual(result.text, 'hello')
                        self.assertEqual(set(result.model_dump()), {
                            'text', 'language', 'language_probability', 'duration', 'segments'})
                    for call in model.transcribe.call_args_list:
                        self.assertEqual(call.kwargs['task'], 'translate')
                    loader.assert_called_once_with(directory, device='cpu',
                        compute_type='int8', local_files_only=True)
                self.run_startup(check)

    def test_non_english_audio_is_translated_and_source_language_is_retained(self):
        model = Mock()
        model.transcribe.return_value = (
            iter([SimpleNamespace(start=0, end=2, text=' This is the English translation. ')]),
            SimpleNamespace(language='hi', language_probability=.98, duration=2),
        )
        storage = Mock()
        storage.fget_object.side_effect = lambda b, k, p: Path(p).write_bytes(b'audio')
        main.app.state.whisper_model = model
        try:
            with patch.object(main, 'get_storage_client', return_value=storage):
                result = main.transcribe(
                    main.TranscriptionRequest(bucket='test', object_key='hindi.wav')
                )
            self.assertEqual(result.text, 'This is the English translation.')
            self.assertEqual(result.language, 'hi')
            self.assertEqual(result.segments[0].text, 'This is the English translation.')
            self.assertEqual(model.transcribe.call_args.kwargs['task'], 'translate')
        finally:
            main.app.state.whisper_model = None

    def test_failure_retries_and_endpoint_does_not_retry_or_download(self):
        with patch.dict(main.os.environ, {'WHISPER_MODEL_PATH': '',
                'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}), \
             patch.object(main, 'download_model', side_effect=RuntimeError('not cached')) as resolve, \
             patch.object(main.asyncio, 'sleep', new_callable=AsyncMock) as sleep, \
             patch.object(main, 'get_storage_client') as storage:
            def check():
                response = Response()
                self.assertEqual(main.health(response)['status'], 'degraded')
                self.assertEqual(response.status_code, 503)
                with self.assertRaises(HTTPException) as error:
                    main.transcribe(main.TranscriptionRequest(bucket='test', object_key='a.wav'))
                self.assertEqual(error.exception.status_code, 503)
                self.assertEqual(error.exception.detail,
                    'Whisper model not loaded. Check local model path.')
                self.assertEqual(resolve.call_count, 3)
                resolve.assert_called_with('base', local_files_only=True)
                self.assertEqual(sleep.await_count, 2)
                storage.assert_not_called()
            self.run_startup(check)

    def test_cached_name_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'tokenizer.json').write_text('{}')
            with patch.dict(main.os.environ, {'WHISPER_MODEL_PATH': directory + '/missing',
                    'WHISPER_MODEL': 'base', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}), \
                 patch.object(main, 'download_model', return_value=directory) as resolve, \
                 patch.object(main, 'WhisperModel', return_value=Mock()) as loader:
                self.run_startup(lambda: self.assertIsNotNone(main.get_whisper_model()))
                resolve.assert_called_once_with('base', local_files_only=True)
                self.assertEqual(loader.call_args.args[0], directory)
                self.assertTrue(loader.call_args.kwargs['local_files_only'])

    def test_explicit_online_startup(self):
        with patch.dict(main.os.environ, {'WHISPER_MODEL_PATH': '',
                'WHISPER_MODEL': 'base', 'HF_HUB_OFFLINE': '0', 'TRANSFORMERS_OFFLINE': '0'}), \
             patch.object(main, 'WhisperModel', return_value=Mock()) as loader:
            self.run_startup(lambda: self.assertIsNotNone(main.get_whisper_model()))
            self.assertEqual(loader.call_args.args[0], 'base')
            self.assertFalse(loader.call_args.kwargs['local_files_only'])

    def test_retry_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'tokenizer.json').write_text('{}')
            with patch.dict(main.os.environ, {'WHISPER_MODEL_PATH': directory}), \
                 patch.object(main, 'WhisperModel', side_effect=[RuntimeError('temporary'), Mock()]) as loader, \
                 patch.object(main.asyncio, 'sleep', new_callable=AsyncMock):
                self.run_startup(lambda: self.assertIsNotNone(main.get_whisper_model()))
                self.assertEqual(loader.call_count, 2)

    def test_incomplete_local_model_never_fetches_tokenizer(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(main.os.environ, {'WHISPER_MODEL_PATH': directory}), \
                 patch.object(main, 'WhisperModel') as loader, \
                 patch.object(main.asyncio, 'sleep', new_callable=AsyncMock):
                self.run_startup(lambda: self.assertIsNone(main.app.state.whisper_model))
                loader.assert_not_called()


if __name__ == '__main__':
    unittest.main()
