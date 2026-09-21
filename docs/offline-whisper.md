# Offline Whisper setup

Run this once from the repository root on a connected Windows host:

```powershell
.\scripts\download-whisper-model.ps1
docker compose up -d --build ai-service
```

The downloader fetches the converted [Systran base model](https://huggingface.co/Systran/faster-whisper-base/tree/main), resolves a single revision, and saves config.json, model.bin, tokenizer.json, and vocabulary.txt directly into models/whisper-base. It keeps TLS verification enabled. If your host also reports certificate errors, install your organization's trusted CA or download on a trusted connected machine and copy the entire folder. Do not disable certificate verification. A specific revision can be selected with -Revision.

The model folder is ignored by Git and mounted read-only at /models/whisper-base. Do not start the service until the download finishes. Restart ai-service after replacing model files.

Defaults in .env and .env.example:

```dotenv
WHISPER_MODEL=base
WHISPER_MODEL_PATH=/models/whisper-base
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
ENABLE_VISUAL_ANALYSIS=false
```

For a non-Docker launch, set WHISPER_MODEL_PATH to the absolute host model directory and export the other variables into the service process. The Python service does not read the root .env automatically.

Whisper loads once per service worker during startup, with three attempts and two seconds between failures. An existing local path takes priority. A missing path falls back to WHISPER_MODEL; with either offline flag enabled (the default), that fallback can only use an already cached snapshot. Incomplete local models fail startup loading instead of fetching a missing tokenizer. The HTTP server remains available after exhausted retries: /health returns HTTP 503 with status degraded, and /transcriptions returns HTTP 503 with detail "Whisper model not loaded. Check local model path." Successful transcription request and response schemas are unchanged.

Both offline flags must explicitly be disabled to permit a model-name download at startup. Requests always reuse the loaded model and never initialize or retry it. Visual Intelligence remains disabled by default.

## Confirm offline operation

```powershell
docker compose logs ai-service
curl.exe -f http://localhost:8000/health
docker compose exec ai-service printenv HF_HUB_OFFLINE TRANSFORMERS_OFFLINE WHISPER_MODEL_PATH
```

Logs should show source=local path, model_path=/models/whisper-base, device=cpu, compute_type=int8, offline=enabled, and "Whisper model loaded successfully". Health should return status ok. Docker's health check also reports unhealthy if loading failed.

Run startup regression tests:

```powershell
docker compose run --rm --no-deps -v "${PWD}/apps/ai-service/scripts:/app/scripts:ro" ai-service python -m unittest discover -s scripts -p test_whisper_startup.py
```

For a network-isolated real-model HTTP test, put a short video containing speech at storage/whisper-verification/short.mp4, then run:

```powershell
docker run --rm --network none -e WHISPER_MODEL_PATH=/models/whisper-base -e HF_HUB_OFFLINE=1 -e TRANSFORMERS_OFFLINE=1 -e PYTHONPATH=/app -v "${PWD}/models/whisper-base:/models/whisper-base:ro" -v "${PWD}/apps/ai-service/scripts:/app/scripts:ro" -v "${PWD}/storage/whisper-verification:/samples:ro" ai-content-platform-ai-service python scripts/test_whisper_offline.py /samples/short.mp4
```

This test runs real startup, /health, and /transcriptions over loopback HTTP. Only MinIO retrieval is replaced by a local file copy so the container needs no network. It asserts a nonempty transcript, unchanged response keys, no model initialization during the request, and zero external Python socket connection attempts. Docker additionally disables external networking.

## Verification on 2026-09-09

- Six startup regression tests passed: local reuse, retry exhaustion and 503, retry recovery, missing tokenizer, cached-name fallback, and explicit online startup.
- Backend build passed; Compose configuration validation passed.
- Running AI service loaded /models/whisper-base on CPU with int8 and offline enabled; /health returned HTTP 200 and status ok.
- A ten-second video retrieved through real MinIO storage transcribed successfully through /transcriptions (HTTP 200, three segments).
- The same video passed the network-isolated HTTP test using the real model: zero external Python socket attempts and no request-time model initialization.
- Frontend source and behavior were unchanged; frontend build was not required.
- Normal Docker rebuild was blocked by Docker Hub's untrusted certificate chain. For runtime verification, the updated app was packaged on top of the existing local AI-service image with its installed dependencies, then the Compose service was recreated with --no-build. A clean Docker build still requires fixing Docker's registry CA trust. Model provisioning itself succeeded with TLS verification on the Windows host.

