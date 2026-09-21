ALTER TABLE "ClipCandidate"
  ADD COLUMN "contentPotential" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "ClipCandidate"
SET "contentPotential" = "overallScore";

CREATE INDEX "ClipCandidate_videoId_contentPotential_idx"
  ON "ClipCandidate"("videoId", "contentPotential");
