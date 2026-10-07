-- Older installs acquired these nullable media columns through db push.
-- Add them for reproducible fresh installs, preserving existing deployments.
ALTER TABLE "GeneratedClip" ADD COLUMN IF NOT EXISTS "thumbnailHeight" INTEGER;
ALTER TABLE "GeneratedClip" ADD COLUMN IF NOT EXISTS "thumbnailMimeType" TEXT;
ALTER TABLE "GeneratedClip" ADD COLUMN IF NOT EXISTS "thumbnailObjectKey" TEXT;
ALTER TABLE "GeneratedClip" ADD COLUMN IF NOT EXISTS "thumbnailWidth" INTEGER;
