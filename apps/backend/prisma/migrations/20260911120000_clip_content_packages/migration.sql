ALTER TABLE "ClipCandidate"
  ADD COLUMN "sourceHookScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "bestHook" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "alternateHooks" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "generatedHookScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "caption" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "cta" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contentType" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "whySelected" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "model" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "promptVersion" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "generationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "fallbackReason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "contentFingerprint" TEXT NOT NULL DEFAULT '';

UPDATE "ClipCandidate"
SET "sourceHookScore" = "hookScore",
    "bestHook" = "hookCandidate",
    "title" = "titleCandidate",
    "caption" = "captionCandidate",
    "generationStatus" = CASE
      WHEN "hookCandidate" <> '' THEN 'LEGACY'
      ELSE 'PENDING'
    END;

CREATE INDEX "ClipCandidate_videoId_contentFingerprint_idx"
  ON "ClipCandidate"("videoId", "contentFingerprint");
