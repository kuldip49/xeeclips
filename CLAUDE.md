# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Personal AI-powered short-form content assistant. It ingests a long video and runs it through a pipeline
(transcription → semantic chunking → deterministic chunk analysis → visual analysis → provider-neutral LLM
understanding → clip candidate discovery → creative generation → export) to surface short-form clip
candidates with hooks, captions, and hashtags.

Monorepo with three apps:

- `apps/frontend` — Next.js 15 / React 19 app (landing, dashboard, project detail pages), shadcn/ui + Tailwind.
- `apps/backend` — NestJS API gateway. Owns Prisma/PostgreSQL, MinIO object storage, BullMQ/Redis job queue,
  and all LLM provider routing.
- `apps/ai-service` — FastAPI service doing the CPU/GPU-heavy work: faster-whisper transcription and OpenCV/
  YOLO/PaddleOCR-based visual analysis. Stateless — it does not talk to PostgreSQL.

Infra: PostgreSQL, Redis, MinIO, all orchestrated via `docker-compose.yml`.

## Commands

Run from repo root (npm workspaces: `apps/frontend`, `apps/backend`, `packages/shared`).

```bash
# Start everything (Docker)
docker compose up --build
# or on Windows:
.\scripts\start-local.ps1

# Individual dev servers (outside Docker)
npm run dev:backend     # nest start --watch
npm run dev:frontend    # next dev on :3000

# Build / lint (both are workspace-wide)
npm run build
npm run lint             # actually `tsc --noEmit` in both frontend and backend — there is no eslint config

# Health checks
curl http://localhost:4000/health
curl http://localhost:8000/health
```

Backend-specific (run inside `apps/backend`, most `build` first via the `npm run <name>` scripts in
`package.json`):

```bash
npm run prisma:generate
npm run db:push                    # prisma db push (dev schema sync)
npm run db:migrate                 # prisma migrate deploy

# Feature test/verification scripts (each builds first, then runs a .cjs script against a live/dockerized stack)
npm run test:clips
npm run test:understanding
npm run test:multi-model
npm run test:visual-intelligence
npm run test:editing
npm run test:editing-media
npm run test:motion-sfx
```

There is no single unit-test command — correctness is verified by targeted `.cjs` scripts in
`apps/backend/scripts/` (e.g. `test-chunks.cjs`, `test-chunk-analysis.cjs`) run against a real/dockerized
Postgres+Redis+MinIO stack, plus `verify-milestoneN.cjs` scripts that exercise the full worker pipeline
end-to-end and clean up their own disposable data afterward. Run a single script directly with
`node scripts/<name>.cjs` after `npm run build`.

AI service (Python, FastAPI, inside `apps/ai-service`):

```bash
python scripts/setup_visual_models.py      # pre-fetch OpenCV/YOLO/OCR models (also runs in docker-compose command)
python scripts/test_visual_intelligence.py
python scripts/verify_visual_runtime.py
```

Whisper model must be pre-downloaded before starting the AI service — see `docs/offline-whisper.md` and
`.\scripts\download-whisper-model.ps1`.

## Architecture

### Processing pipeline (the core of the system)

Video processing is driven by BullMQ jobs (`apps/backend/src/modules/processing/processing-queue.service.ts`,
`video-processor.service.ts`) tracked as a `ProcessingJob` row with a `progress` (0–100) and `status`. Each
stage persists its own Prisma models and the whole job commits its final stage transactionally, so a failed
stage leaves the job `FAILED` rather than partially `COMPLETED`. Retries **replace** prior stage data
(cascading deletes) rather than appending duplicates — this idempotency is load-bearing and is checked by the
`verify-milestoneN.cjs` scripts.

Stage order (see `PROJECT_STATE.md` for the authoritative, detailed history of each milestone):

1. FFmpeg metadata extraction + 16kHz mono WAV extraction, uploaded to MinIO.
2. AI service transcribes the WAV with faster-whisper → `Transcript` + `TranscriptSegment` rows.
3. Segments are merged into semantic `TranscriptChunk`s by a punctuation/pause heuristic (no ML).
4. Each chunk gets a deterministic, non-LLM `ChunkAnalysis` (readability, speech rate, density, etc.).
5. Each chunk gets a deterministic `VisualAnalysis` (OpenCV frame sampling: shot boundaries, motion, faces,
   OCR, brightness/contrast/colorfulness) — gated by `VISUAL_INTELLIGENCE_ENABLED`/`ENABLE_VISUAL_ANALYSIS`.
6. Provider-neutral LLM `VideoUnderstanding` (summary, topics, claims, chapters) using hierarchical
   summarization for long transcripts.
7. `ClipCandidate` discovery: evidence fusion + `ClipUnderstanding`, then generator/critic/finalizer creative
   generation producing exactly three hooks, a three-paragraph synopsis, and five hashtags per candidate, with
   separate Content Potential / Generation Quality / Confidence scores.
8. Optional `GeneratedClip` export (vertical clip render).

### Multi-model LLM routing (`apps/backend/src/modules/processing/`)

LLM calls are provider-neutral and routed per-task by `llm-router.service.ts` / `llm-provider.service.ts` /
`provider-registry.ts`, with per-task cross-provider failover, bounded retries, per-model concurrency limits,
and circuit-breaker cooldowns. Normal role assignment: an Omni/multimodal model for visual+transcript
evidence, a reasoning model for clip/critic judgments, and a creative model for one structured candidate-pool
generation request. When no configured provider succeeds, generation falls back to a deterministic
(non-LLM) path rather than failing the job — this fallback is intentional, not a bug, and is exercised by
`test-local-fallback-quality.cjs`. All provider keys/models are environment-driven (see `docker-compose.yml`
for the full list of `LLM_*` / `NVIDIA_*` / `GOOGLE_*` / `OPENAI_*` / `LOCAL_LLM_*` vars) — never hardcode a
model identifier or API key.

### Data model

Prisma schema: `apps/backend/prisma/schema.prisma`. One row per pipeline stage per chunk/video
(`TranscriptChunk` → `ChunkAnalysis` 1:1, `TranscriptChunk` → `VisualAnalysis` 1:1, `Video` →
`VideoUnderstanding` → `VideoUnderstandingChapter[]`, `Video` → `ClipCandidate[]` → `GeneratedClip[]`), with
cascading deletes throughout so re-processing a video never leaves orphaned rows.

### Frontend

`apps/frontend/src/app/projects/[id]` is the project workspace: it polls processing progress, then
progressively loads transcript chunks, chunk analysis, visual analysis, understanding, and clip candidates as
they become available, each panel with its own loading/empty/pending/failure/retry state.

### AI service boundary

`apps/ai-service` exposes `/health`, a transcription endpoint, and `/visual-analysis` (accepts a MinIO
object + chunk time ranges, returns one position-keyed visual result per chunk). It has no database access
and no knowledge of Projects/Videos — the backend owns all persistence and calls the AI service as a stateless
compute boundary.

## Working conventions

- `PROJECT_STATE.md` is the authoritative, continuously-updated record of what's implemented per milestone,
  including exact field semantics (e.g. how `shotBoundaries` intervals are half-open) and what's explicitly
  deferred. Check it before assuming a feature exists or before re-deriving behavior that's already specified
  there.
- Backend and frontend "lint" is a TypeScript type-check only (`tsc --noEmit`), not eslint — don't expect
  eslint config or `.eslintrc` files.
- Verification scripts that touch the live Docker stack create disposable projects/videos/DB rows/MinIO
  objects and remove them at the end of the run — follow that pattern for any new verification script rather
  than leaving test data behind.
