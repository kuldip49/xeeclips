-- CreateEnum
CREATE TYPE "ProcessingStage" AS ENUM ('UPLOADED', 'INSPECT_MEDIA', 'EXTRACT_AUDIO', 'TRANSCRIBE', 'BUILD_CHUNKS', 'ANALYZE_CHUNKS', 'VISUAL_ANALYSIS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProcessingStageStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "VideoProcessingStage" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "stage" "ProcessingStage" NOT NULL,
    "status" "ProcessingStageStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoProcessingStage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoProcessingStage_videoId_stage_key" ON "VideoProcessingStage"("videoId", "stage");

-- AddForeignKey
ALTER TABLE "VideoProcessingStage" ADD CONSTRAINT "VideoProcessingStage_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Initialize old videos from durable outputs, never from percentage thresholds.
WITH state AS (
  SELECT v.*, j."status" AS job_status, j."error" AS job_error,
    EXISTS (SELECT 1 FROM "Transcript" t WHERE t."videoId" = v.id) AS has_transcript,
    EXISTS (SELECT 1 FROM "TranscriptChunk" c WHERE c."videoId" = v.id) AS has_chunks,
    NOT EXISTS (SELECT 1 FROM "TranscriptChunk" c LEFT JOIN "ChunkAnalysis" a ON a."chunkId" = c.id
      WHERE c."videoId" = v.id AND a.id IS NULL) AS all_analyzed,
    NOT EXISTS (SELECT 1 FROM "TranscriptChunk" c LEFT JOIN "VisualAnalysis" a ON a."chunkId" = c.id
      WHERE c."videoId" = v.id AND a.id IS NULL) AS all_visual
  FROM "Video" v
  LEFT JOIN LATERAL (SELECT * FROM "ProcessingJob" WHERE "videoId" = v.id
    ORDER BY "createdAt" DESC LIMIT 1) j ON true
), stages AS (
  SELECT s.*, name,
    CASE
      WHEN name = 'UPLOADED' THEN 'COMPLETED'
      WHEN name = 'INSPECT_MEDIA' AND duration IS NOT NULL AND width IS NOT NULL
        AND height IS NOT NULL AND fps IS NOT NULL AND codec IS NOT NULL THEN 'COMPLETED'
      WHEN name = 'EXTRACT_AUDIO' AND "audioBucket" IS NOT NULL AND "audioObjectKey" IS NOT NULL THEN 'COMPLETED'
      WHEN name = 'TRANSCRIBE' AND has_transcript THEN 'COMPLETED'
      WHEN name = 'BUILD_CHUNKS' AND (has_chunks OR job_status = 'COMPLETED') THEN 'COMPLETED'
      WHEN name = 'ANALYZE_CHUNKS' AND all_analyzed AND (has_chunks OR job_status = 'COMPLETED') THEN 'COMPLETED'
      WHEN name = 'VISUAL_ANALYSIS' AND has_chunks AND all_visual THEN 'COMPLETED'
      WHEN name = 'VISUAL_ANALYSIS' AND job_status = 'COMPLETED' THEN 'SKIPPED'
      WHEN name = 'COMPLETED' AND job_status = 'COMPLETED' THEN 'COMPLETED'
      WHEN name = 'FAILED' AND job_status = 'FAILED' THEN 'FAILED'
      ELSE 'PENDING'
    END AS stage_status
  FROM state s CROSS JOIN unnest(enum_range(NULL::"ProcessingStage")) name
)
INSERT INTO "VideoProcessingStage" ("id", "videoId", "stage", "status", "progress", "completedAt", "error", "updatedAt")
SELECT md5(id || ':' || name::text), id, name, stage_status::"ProcessingStageStatus",
  CASE WHEN stage_status IN ('COMPLETED', 'SKIPPED') THEN 100 ELSE 0 END,
  CASE WHEN stage_status IN ('COMPLETED', 'SKIPPED', 'FAILED') THEN CURRENT_TIMESTAMP ELSE NULL END,
  CASE WHEN stage_status = 'FAILED' THEN job_error ELSE NULL END, CURRENT_TIMESTAMP
FROM stages;

-- Associate legacy failure with its first stage missing durable output.
WITH first_missing AS (
  SELECT DISTINCT ON (s."videoId") s.id, f.error
  FROM "VideoProcessingStage" s
  JOIN "VideoProcessingStage" f ON f."videoId" = s."videoId" AND f.stage = 'FAILED' AND f.status = 'FAILED'
  WHERE s.status = 'PENDING' AND s.stage NOT IN ('FAILED', 'COMPLETED', 'UPLOADED')
  ORDER BY s."videoId", s.stage
)
UPDATE "VideoProcessingStage" s SET status = 'FAILED', error = m.error, "completedAt" = CURRENT_TIMESTAMP
FROM first_missing m WHERE s.id = m.id;
