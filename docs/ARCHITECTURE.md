# Architecture

This repository starts as a local personal tool, with service boundaries that can
grow into a SaaS later.

## Current Scope

Implemented now:

- Next.js landing page, dashboard, and project detail page
- NestJS API service with `/health`, project, and video modules
- FastAPI AI service with `/health`
- PostgreSQL
- Redis
- MinIO
- Prisma data access for `Project` and `Video`
- MinIO upload storage for source videos
- BullMQ processing queue backed by Redis
- PostgreSQL processing-job status tracking
- FFmpeg metadata and 16 kHz mono WAV extraction
- Faster Whisper transcription in the AI service
- Timestamped transcript segment persistence in PostgreSQL
- Transcript retrieval through the backend API
- Provider-neutral structured-output LLM client (NVIDIA Nemotron is the current configuration)
- Hierarchical whole-video transcript understanding persisted in PostgreSQL
- Chapter/topic-aware clip discovery and judging with transcript-only fallback
- Optional visual intelligence
- Docker Compose orchestration

Deferred:

- Authentication
- Trend research
- Prompt editing
- Publishing
- Analytics
- Billing

## Service Boundaries

### Frontend

The frontend owns user-facing workflows:

- Project dashboard
- Upload entry point
- Project detail view
- Uploaded video list
- Processing status
- Transcript and whole-video summary review
- Post-analysis clip-count recommendations and ranked, per-clip content packages
- Clip editor later

### Backend

The backend is the API gateway and orchestration layer:

- HTTP API
- Database access
- Object storage access
- Project creation
- Video upload metadata
- Job creation and progress tracking
- Calls into the AI service for transcription
- Calls the configured LLM provider for strict structured transcript understanding and clip judging
- Future auth and authorization

### AI Service

The AI service owns Python-native AI and media intelligence work:

- Faster Whisper transcription
- Segment timestamp generation
- Research synthesis later

### Infrastructure

PostgreSQL stores durable application records, Redis supports queues and short
lived coordination, and MinIO stores source videos and generated assets.

## Current Processing Spine

```text
Frontend upload
  -> Backend creates video record
  -> Backend stores source video in MinIO
  -> Backend creates a processing job and enqueues it in Redis
  -> Worker downloads the source video from MinIO
  -> Worker extracts technical metadata and 16 kHz mono WAV audio with FFmpeg
  -> Worker stores the WAV in MinIO and requests transcription
  -> AI service downloads the WAV from MinIO and runs Faster Whisper
  -> Worker stores the transcript and timestamped segments in PostgreSQL
  -> Worker builds timestamped transcript chunks
  -> Worker requests and persists whole-video understanding (hierarchically for long transcripts)
  -> Worker generates heuristic candidates with chapter/topic context
  -> Configured LLM judges candidate-local transcript and context in batches
  -> Backend classifies acceptable candidates as PRIMARY or SECONDARY and recommends a count
  -> Worker falls back to transcript heuristics if either LLM phase is unavailable
  -> Optional visual analysis runs only when enabled
  -> Worker marks the processing job complete
  -> User chooses a duration-limited clip count without rerunning analysis
  -> Backend exports the best PRIMARY clips, then acceptable SECONDARY clips if requested
```

## Data Ownership

Original uploaded media should remain immutable. Derived audio files, transcripts,
candidate clips, and rendered exports should be stored as separate records/assets
with clear lineage.
