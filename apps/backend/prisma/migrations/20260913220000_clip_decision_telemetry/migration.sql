ALTER TABLE "ProcessingJob"
  ADD COLUMN "telemetry" JSONB NOT NULL DEFAULT '{}';
