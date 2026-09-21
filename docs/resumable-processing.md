# Resumable video processing

Each video owns nine unique stage records. Outputs are saved before the next stage starts.
Retries preserve transcripts, segments, chunk IDs, and existing analyses. A completed stage
checkpoint is authoritative and never runs again unless FORCE_REPROCESS=true. Incomplete
stages also reuse valid persisted outputs. Missing chunk analyses and visual results are
processed individually. Retry processing never deletes successful output.

BullMQ runs each video-processing job once. POST /videos/:id/retry
reuses the existing queue job; active/waiting/delayed jobs are not duplicated. There is no
automatic full-job retry. Completed videos return 409 unless force reprocessing is enabled;
unknown videos return 404. Stage history persists across manual attempts,
with the latest failure and execution timestamps on each stage. FAILED is the overall
failure marker; prior successful stage records are preserved.

Each stage row describes the latest attempt, rather than storing an append-only attempt
history. Its startedAt/completedAt/error/progress remain queryable through video/project
responses. Frontend transcript and chunk access uses persisted database artifact flags, so
successful data remains visible even when the overall job has failed.

Visual analysis disabled: SKIPPED, overall COMPLETED, 100%. Enabled: one missing chunk per
request, bounded by AI_SERVICE_TIMEOUT_MS, persisted immediately. A failed visual request
leaves all core outputs readable and marks the visual stage and overall job failed.
The unchanged AI endpoint downloads the source for each request; one-chunk requests trade
additional downloads for bounded work and durable partial progress.

## Database rollout

This repository previously used db push, with no migration history. For an existing database
matching the old schema, baseline it once before deploying:
```sh
npx prisma migrate resolve --applied 20260909000000_baseline
npx prisma migrate deploy
npx prisma generate
```
For an empty database, run migrate deploy without resolve. The additive migration backfills
stages from existing output records, never deletes output, and associates old failed jobs
with the first incomplete stage. Restart/rebuild the backend and frontend after migration.
Do not run an old worker concurrently with the new worker: old code still deletes chunks.

Backend tests: npm run build, then node scripts/test-processing-resume.cjs.
The integration script uses isolated fixture rows in the configured PostgreSQL database
and real Redis; it does not enqueue fixtures into the normal worker queue.

Real-media smoke test (requires a short video with audible speech and running services):
```sh
node scripts/test-processing-media.cjs /path/to/short-speech.mp4
```
This test uses the upload API and removes only its own project and storage objects.

## Verification on 2026-09-09

- Backend and frontend production builds passed.
- Prisma generation, validation, baseline, migration deploy, and schema drift check passed.
- Real PostgreSQL/Redis regression tests passed for visual failure preservation, one-attempt
  jobs, manual HTTP retries (including exhausted jobs and concurrent requests), missing
  analyses, disabled visual analysis, empty speech results, and stalled-worker failures.
- A 14.8-second synthetic speech video completed through real upload, ffprobe, ffmpeg,
  MinIO, and Whisper: three segments, three chunks, three analyses; visual SKIPPED; 100%.
- Existing chunk-building and chunk-analysis regression checks passed.
- Docker image rebuilding was blocked by the local Docker registry TLS trust error.
  Updated sources and generated Prisma client were synced into the existing development
  containers for the live test. Rebuild images after resolving registry certificate trust.
- Browser automation could not initialize because of a Windows sandbox helper failure;
  interactive browser verification was unavailable.

## Changed files

- apps/backend/prisma/schema.prisma
- apps/backend/prisma/migrations/migration_lock.toml
- apps/backend/prisma/migrations/20260909000000_baseline/migration.sql
- apps/backend/prisma/migrations/20260909010000_processing_stages/migration.sql
- apps/backend/src/modules/processing/video-processor.service.ts
- apps/backend/src/modules/processing/processing-queue.service.ts
- apps/backend/src/modules/videos/videos.controller.ts
- apps/backend/src/modules/videos/videos.service.ts
- apps/backend/src/modules/projects/projects.service.ts
- apps/backend/src/main.ts
- apps/backend/package.json
- apps/backend/Dockerfile
- apps/backend/scripts/test-processing-resume.cjs
- apps/backend/scripts/test-processing-media.cjs
- apps/frontend/src/lib/api.ts
- apps/frontend/src/components/processing-pipeline.tsx
- apps/frontend/src/components/project-workspace.tsx
- apps/frontend/src/components/transcript-panel.tsx
- apps/frontend/src/components/chunks-panel.tsx
- docs/resumable-processing.md

Prisma generated client files and backend/frontend build outputs were also regenerated.
