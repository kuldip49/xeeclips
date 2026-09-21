# AI Content Platform

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
- Nemotron Omni multimodal evidence, Nemotron Super reasoning/critic, and Gemini Flash creative roles
- Per-task cross-provider failover with bounded retries, concurrency, model-scoped cooldowns, and safe telemetry
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

Set server-side keys and the exact model identifiers available to your provider accounts in `.env`.
The template deliberately does not guess an Omni or Gemini Flash identifier:

```dotenv
NVIDIA_API_KEY=
NVIDIA_MULTIMODAL_MODEL=
NVIDIA_REASONING_MODEL=nvidia/nemotron-3-super-120b-a12b
GOOGLE_API_KEY=
GOOGLE_CREATIVE_MODEL=
```

Normal routing is Omni for multimodal understanding, Super for transcript/clip reasoning and
criticism, and Gemini Flash for one structured creative candidate-pool request. Failover is
per task; deterministic generation is used only after no configured capable route succeeds.
Keys are never returned to the browser or stored in PostgreSQL.

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
