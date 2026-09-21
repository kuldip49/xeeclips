-- Persisted clip render lifecycle (QUEUED before dispatch, render start time for stale recovery).
ALTER TYPE "ClipRenderStatus" ADD VALUE IF NOT EXISTS 'IDLE' BEFORE 'RENDERING';
ALTER TYPE "ClipRenderStatus" ADD VALUE IF NOT EXISTS 'QUEUED' BEFORE 'RENDERING';

ALTER TABLE "ProcessingJob"
  ADD COLUMN "clipRenderStartedAt" TIMESTAMP(3);

-- Normal and AI Edited renders of the same range coexist, keyed by output variant.
ALTER TABLE "GeneratedClip"
  ADD COLUMN "targetPlatform" "TargetPlatform",
  ADD COLUMN "variantKey" TEXT;

UPDATE "GeneratedClip" AS g SET "targetPlatform" = v."targetPlatform"
  FROM "Video" AS v WHERE v."id" = g."videoId";
UPDATE "GeneratedClip"
  SET "variantKey" = "processingType"::TEXT || ':' || COALESCE("targetPlatform"::TEXT, 'DEFAULT');
ALTER TABLE "GeneratedClip" ALTER COLUMN "variantKey" SET NOT NULL;

DROP INDEX "GeneratedClip_candidateId_key";
DROP INDEX "GeneratedClip_videoId_rangeKey_key";
CREATE UNIQUE INDEX "GeneratedClip_videoId_rangeKey_variantKey_key"
  ON "GeneratedClip"("videoId", "rangeKey", "variantKey");
CREATE INDEX "GeneratedClip_candidateId_idx" ON "GeneratedClip"("candidateId");
