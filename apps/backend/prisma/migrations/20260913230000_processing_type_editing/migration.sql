CREATE TYPE "ProcessingType" AS ENUM ('NORMAL_CLIPS', 'EDITED_CLIPS');

ALTER TABLE "ProcessingJob"
  ADD COLUMN "processingType" "ProcessingType" NOT NULL DEFAULT 'NORMAL_CLIPS',
  ADD COLUMN "outputAspectRatio" TEXT;

ALTER TABLE "GeneratedClip"
  ADD COLUMN "processingType" "ProcessingType" NOT NULL DEFAULT 'NORMAL_CLIPS',
  ADD COLUMN "aspectRatio" TEXT NOT NULL DEFAULT 'SOURCE',
  ADD COLUMN "editPlan" JSONB,
  ADD COLUMN "editTelemetry" JSONB;

ALTER TABLE "VisualAnalysis"
  ADD COLUMN "faceTracks" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "personTracks" JSONB NOT NULL DEFAULT '[]';
