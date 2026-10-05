-- Step 3: original-source-backed generated clip projects.
-- Existing Step 2 assets remain editor-owned and keep resolving through objectKey.
ALTER TYPE "EditAssetRole" ADD VALUE IF NOT EXISTS 'REFERENCE';

CREATE TYPE "EditAssetStorageOwnership" AS ENUM ('OWNED', 'SHARED');

ALTER TABLE "EditProject"
  ADD COLUMN "originalVideoId" TEXT;

ALTER TABLE "EditAsset"
  ADD COLUMN "storageObjectKey" TEXT,
  ADD COLUMN "storageOwnership" "EditAssetStorageOwnership" NOT NULL DEFAULT 'OWNED';

CREATE INDEX "EditProject_originalVideoId_idx" ON "EditProject"("originalVideoId");

ALTER TABLE "EditProject"
  ADD CONSTRAINT "EditProject_originalVideoId_fkey"
  FOREIGN KEY ("originalVideoId") REFERENCES "Video"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EditAsset"
  ADD CONSTRAINT "EditAsset_sourceVideoId_fkey"
  FOREIGN KEY ("sourceVideoId") REFERENCES "Video"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
