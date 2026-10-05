-- Unified generation (Steps 9-12, 17). Additive only: no existing column,
-- row or constraint is changed.
ALTER TABLE "ProcessingJob" ADD COLUMN "generationSettings" JSONB;

CREATE TABLE "ReferenceAsset" (
    "id" TEXT NOT NULL,
    "videoId" TEXT,
    "originalName" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sourceUrl" TEXT,
    "analysis" JSONB NOT NULL DEFAULT '{}',
    "derivedStyle" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ANALYZING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReferenceAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferenceAsset_objectKey_key" ON "ReferenceAsset"("objectKey");
CREATE INDEX "ReferenceAsset_videoId_idx" ON "ReferenceAsset"("videoId");
ALTER TABLE "ReferenceAsset" ADD CONSTRAINT "ReferenceAsset_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SavedStyle" (
    "id" TEXT NOT NULL,
    "ownerScope" TEXT NOT NULL DEFAULT 'LOCAL',
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SavedStyle_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SavedStyle_ownerScope_category_name_key" ON "SavedStyle"("ownerScope", "category", "name");
CREATE INDEX "SavedStyle_ownerScope_category_idx" ON "SavedStyle"("ownerScope", "category");
