ALTER TABLE "ClipCandidate"
  ADD COLUMN "rangeKey" TEXT,
  ADD COLUMN "heuristicScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "payoffScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "flowScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "retentionScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "shareabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "overallScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "reject" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "topic" TEXT NOT NULL DEFAULT 'Legacy candidate',
  ADD COLUMN "rejectionReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "judgeSource" TEXT NOT NULL DEFAULT 'LEGACY';

UPDATE "ClipCandidate"
SET "rangeKey" = concat(round("startTime"::numeric, 3), ':', round("endTime"::numeric, 3)),
    "heuristicScore" = "viralPotentialScore",
    "overallScore" = "viralPotentialScore";

ALTER TABLE "ClipCandidate"
  ALTER COLUMN "rangeKey" SET NOT NULL,
  ALTER COLUMN "rank" DROP NOT NULL;

CREATE UNIQUE INDEX "ClipCandidate_videoId_rangeKey_key" ON "ClipCandidate"("videoId", "rangeKey");
CREATE INDEX "ClipCandidate_videoId_overallScore_idx" ON "ClipCandidate"("videoId", "overallScore");

CREATE TABLE "GeneratedClip" (
  "id" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "candidateId" TEXT,
  "rangeKey" TEXT NOT NULL,
  "startTime" DOUBLE PRECISION NOT NULL,
  "endTime" DOUBLE PRECISION NOT NULL,
  "duration" DOUBLE PRECISION NOT NULL,
  "bucket" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "codec" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GeneratedClip_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GeneratedClip_candidateId_key" ON "GeneratedClip"("candidateId");
CREATE UNIQUE INDEX "GeneratedClip_objectKey_key" ON "GeneratedClip"("objectKey");
CREATE UNIQUE INDEX "GeneratedClip_videoId_rangeKey_key" ON "GeneratedClip"("videoId", "rangeKey");
CREATE INDEX "GeneratedClip_videoId_createdAt_idx" ON "GeneratedClip"("videoId", "createdAt");

ALTER TABLE "GeneratedClip" ADD CONSTRAINT "GeneratedClip_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeneratedClip" ADD CONSTRAINT "GeneratedClip_candidateId_fkey"
  FOREIGN KEY ("candidateId") REFERENCES "ClipCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
