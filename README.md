# AI Content Platform

Production target: [xeeclip.me](https://xeeclip.me). Deployment status and
Windows/Cloudflare deployment procedure: [docs/production-deployment.md](docs/production-deployment.md).

Personal AI-powered short-form content assistant with a provider-neutral multi-model clip pipeline.

- Next.js frontend with landing, dashboard, and project detail pages
- NestJS backend API with health, project, and video modules
- FastAPI AI service with a health check
- PostgreSQL, Redis, and MinIO via Docker Compose
- Project creation
- Video upload to MinIO
- Video metadata persistence in PostgreSQL
- Processing job persistence and BullMQ orchestration through Redis
- FFmpeg video metadata extraction
- 16 kHz mono WAV extraction stored in MinIO
- Faster Whisper English transcription/translation from WAV files downloaded from MinIO
- PostgreSQL transcript, word/segment timestamps, confidence, and optional speaker persistence
- Provider-neutral whole-video LLM understanding with hierarchical long-transcript summaries
- Persisted video summaries, topics, claims, questions, stories, important moments, and chapters
- OpenAI as the only production semantic model, with a deterministic built-in fallback
- Bounded retries, concurrency, model-scoped cooldowns, and safe telemetry
- Structured evidence fusion and ClipUnderstanding before creative generation
- Generator/critic/finalizer content packages with exactly three hooks, a three-paragraph synopsis, and five hashtags
- Separate Content Potential, Generation Quality, and Confidence scores
- AI-first clip discovery with PRIMARY/SECONDARY recommendations, duration-based limits,
  cross-clip diversity, content fingerprints, cached packages, and deterministic fallback
- Optional visual analysis and generated vertical clip exports
- Durable processing progress from 0 through 100 percent
- Uploaded video listing in the dashboard

Authentication, trend research, prompt editing, publishing, and analytics are not implemented.

## Model configuration

Production semantic AI is the **OpenAI API only**, configured server-side in `.env`:

```dotenv
LLM_PROVIDER=openai
OPENAI_ENABLED=true
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-luna
OPENAI_TIMEOUT_MS=90000
```

There is no local LLM (Ollama/Qwen) route. When OpenAI cannot be used - no key, invalid key (401),
rate limit (429), timeout, network failure or 5xx - the product keeps working on deterministic
built-in rules: upload, analysis, automatic generation, templates/styles, the manual editor, render
and export never depend on OpenAI. The AI editor says so honestly ("AI editor is temporarily
unavailable. Manual editing and automatic generation are still available.") and never pretends a
semantic request was understood. Old `OFFLINE` jobs are treated as rules-only. The AI editor and
brief reading use OpenAI by default (`EDIT_MODE_CHAT_AI_MODE` unset = `ONLINE`); set it to
`FALLBACK_ONLY` to keep them rules-only. A rejected key keeps reporting "the OpenAI API key was
rejected" (never "try again soon") and OpenAI is not re-called until the key changes. Faster-Whisper,
OpenCV, YOLO and PaddleOCR in the AI service are ordinary local ML and are unaffected.
NVIDIA/Google adapters remain registered but disabled. Keys are never returned to the browser or
stored in PostgreSQL.

## Unified editor

Upload a long video, see it immediately, optionally pick a look (Automatic edit, Clean cuts or one
of 20 templates), mix component styles, add a reference video and a plain-language brief, choose a
clip count and generate. The brief changes which moments are selected. Every clip is Preview / Edit /
Ask AI / Export; Edit and Ask AI open the same canonical, undoable project. Details:
`PROJECT_STATE.md` ("Unified AI Video Editor").

Verification (live stack, disposable data):

```bash
# real media, API level
cd apps/backend && node scripts/verify-unified-generation.cjs --file C:/path/talk.mp4 [--reference C:/path/ref.mp4]
# browser E2E (installed Google Chrome, no browser download)
cd apps/frontend && E2E_SOURCE=C:/path/talk.mp4 npm run test:e2e
# long-source performance
cd apps/backend && node scripts/perf-long-source.cjs --file C:/path/source.mp4 --count 3 --out perf.json
```

## Services

| Service | URL |
| --- | --- |
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:4000 |
| AI Service | http://localhost:8000 |
| MinIO Console | http://localhost:9001 |

## Quick Start

Copy the environment template:

```bash
cp .env.example .env
```

Pre-download the Whisper model before starting the AI service (see [offline Whisper setup](docs/offline-whisper.md)):

```powershell
.\scripts\download-whisper-model.ps1
```

Start everything:

```bash
docker compose up --build
```

On Windows PowerShell, you can also run:

```powershell
.\scripts\start-local.ps1
```

To check local dependencies:

```powershell
.\scripts\check-local.ps1
```

Health checks:

```bash
curl http://localhost:4000/health
curl http://localhost:8000/health
```

Core API routes:

```bash
GET  http://localhost:4000/health
GET  http://localhost:4000/projects
POST http://localhost:4000/projects
GET  http://localhost:4000/projects/:id
GET  http://localhost:4000/videos
POST http://localhost:4000/projects/:projectId/videos
GET  http://localhost:4000/videos/:id/transcript
GET  http://localhost:4000/videos/:id/understanding
GET  http://localhost:4000/videos/:id/clip-candidates
POST http://localhost:4000/videos/:id/clip-selection
GET  http://localhost:4000/videos/:id/generated-clips
```

## Monorepo Layout

```text
apps/
  frontend/      Next.js app with shadcn/ui primitives
  backend/       NestJS API gateway with Prisma and MinIO storage
  ai-service/    FastAPI service boundary for future AI work
infra/
  docker/        Docker-related notes and future infra files
packages/
  shared/        Shared TypeScript types and contracts
storage/
  uploads/       Future local upload mount
  clips/         Future local clip output mount
```

## Data Model

```text
Project
  id
  name
  description
  videos[]
  createdAt
  updatedAt

Video
  id
  projectId
  originalName
  objectKey
  bucket
  mimeType
  sizeBytes
  duration, fps, width, height, codec, bitrate
  audioObjectKey, audioBucket
  transcript
  understanding with chapters[]
  processingJobs[]
  createdAt
  updatedAt

ProcessingJob
  id
  videoId
  status
  progress
  error
  startedAt, completedAt
  createdAt, updatedAt

Transcript
  id
  videoId
  text
  language, languageProbability, duration
  segments[] with position, start, end, text, words, confidence, optional speaker
  createdAt, updatedAt

ClipCandidate
  transcript-grounded evidence and ClipUnderstanding
  Content Potential, Generation Quality, Confidence
  hooks, caption, title, synopsis, hashtags and internal candidate pools
  critic result, provider metadata, generation mode and fallback classification
```
# YouTube source imports

The project page accepts a file upload or a YouTube video URL. URL imports require
confirmation that the user is authorized to process the video and deployment-level
authorization (`YOUTUBE_IMPORT_APPROVED=true`). Keep this false unless the deployment
has permission from YouTube for automated retrieval. Only HTTPS watch,
shorts, and youtu.be links are accepted. The backend requires an approved `yt-dlp`
executable (`YOUTUBE_IMPORT_BINARY`) and `ffprobe` in its runtime. It does not read
browser credentials or cookies, and restricted videos fail with an import error.
Install and use retrieval tooling only where you have permission to retrieve the
source. If retrieval is unavailable, upload an authorized source file instead.
In the Docker Compose setup, setting `YOUTUBE_IMPORT_APPROVED=true` also installs
the optional retriever when the backend image is rebuilt.

Run the `20261003010000_youtube_import` Prisma migration before starting the
backend. A BullMQ import worker records progress in `VideoImport`; the project page
polls that record, including after reload. Successful imports call the same upload
service and processing queue as file uploads. Clip style and count are selected in
the existing post-analysis UI. `MAX_IMPORT_DURATION_SECONDS`,
`MAX_IMPORT_FILE_BYTES`, and `IMPORT_TIMEOUT_MS` control resource limits.
