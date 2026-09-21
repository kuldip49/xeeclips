CREATE TYPE "TargetPlatform" AS ENUM ('INSTAGRAM_REELS', 'YOUTUBE_SHORTS', 'TIKTOK');
CREATE TYPE "OutputStyle" AS ENUM ('NORMAL', 'AI_EDITED');
CREATE TYPE "ClipRenderStatus" AS ENUM ('RENDERING', 'COMPLETED', 'FAILED');

ALTER TABLE "Video"
  ADD COLUMN "targetPlatform" "TargetPlatform";

ALTER TABLE "ProcessingJob"
  ADD COLUMN "outputStyle" "OutputStyle",
  ADD COLUMN "requestedClipCount" INTEGER,
  ADD COLUMN "maxClipCount" INTEGER,
  ADD COLUMN "selectedCandidateIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "clipRenderStatus" "ClipRenderStatus",
  ADD COLUMN "clipRenderError" TEXT,
  ADD COLUMN "clipRequestedAt" TIMESTAMP(3);
