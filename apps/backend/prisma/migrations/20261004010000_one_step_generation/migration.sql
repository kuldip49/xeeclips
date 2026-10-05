-- One-step entry: carry the pre-selected clip request through import and analysis.
ALTER TABLE "ProcessingJob" ADD COLUMN "autoGeneration" JSONB;
ALTER TABLE "ProcessingJob" ADD COLUMN "autoGenerationStatus" TEXT;
ALTER TABLE "ProcessingJob" ADD COLUMN "autoGenerationError" TEXT;
ALTER TABLE "VideoImport" ADD COLUMN "autoGeneration" JSONB;
CREATE INDEX "ProcessingJob_autoGenerationStatus_idx" ON "ProcessingJob"("autoGenerationStatus");
