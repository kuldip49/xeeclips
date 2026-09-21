"""Offline HTTP smoke test; run in Docker with --network none.
Storage alone is stubbed to copy a supplied local video; Whisper is real.
"""
import json
import shutil
import socket
import sys
import threading
import time
import urllib.request
from unittest.mock import Mock, patch

import uvicorn
from app import main

attempts = []
def audit(event, args):
    if event == 'socket.connect':
        address = args[1]
        if isinstance(address, tuple) and address[0] not in ('127.0.0.1', '::1'):
            attempts.append(str(address))
            raise RuntimeError('Unexpected network connection: ' + str(address))
sys.addaudithook(audit)

storage = Mock()
storage.fget_object.side_effect = lambda b, k, p: shutil.copyfile(sys.argv[1], p)
server = uvicorn.Server(uvicorn.Config(main.app, host='127.0.0.1', port=8765))
with patch.object(main, 'get_storage_client', return_value=storage):
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(300):
            if server.started:
                break
            time.sleep(0.1)
        assert server.started, 'Server failed to start'
        with urllib.request.urlopen('http://127.0.0.1:8765/health') as response:
            assert response.status == 200
            assert json.load(response)['status'] == 'ok'
        with patch.object(main, 'WhisperModel', side_effect=AssertionError('Request reloaded model')), \
             patch.object(main, 'download_model', side_effect=AssertionError('Request tried model download')):
            request = urllib.request.Request(
                'http://127.0.0.1:8765/transcriptions',
                data=json.dumps({'bucket': 'offline-test', 'object_key': 'short.mp4'}).encode(),
                headers={'Content-Type': 'application/json'},
            )
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.load(response)
                assert response.status == 200
                assert result['text'].strip(), result
                assert set(result) == {'text', 'language', 'language_probability', 'duration', 'segments'}
                print(json.dumps(result))
        assert not attempts, attempts
        print('PASS: local startup, HTTP health, real video transcription, zero external socket attempts')
    finally:
        server.should_exit = True
        thread.join(timeout=15)
