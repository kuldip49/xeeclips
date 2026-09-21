-- Additive, isolated persistence for the EditMode workspace.
CREATE TYPE "EditProjectStatus" AS ENUM ('DRAFT', 'READY', 'EXPORTING', 'COMPLETED', 'FAILED');
CREATE TYPE "EditAssetRole" AS ENUM ('SOURCE', 'OVERLAY', 'AUDIO', 'IMAGE', 'EXPORT');
CREATE TYPE "EditElementType" AS ENUM ('VIDEO', 'AUDIO', 'TEXT', 'SUBTITLE', 'IMAGE', 'EFFECT');
CREATE TYPE "EditHistoryActor" AS ENUM ('USER', 'PRESET', 'ASSISTANT', 'SYSTEM');

CREATE TABLE "EditProject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceProjectId" TEXT,
    "status" "EditProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EditAsset" (
    "id" TEXT NOT NULL,
    "editProjectId" TEXT NOT NULL,
    "sourceVideoId" TEXT,
    "role" "EditAssetRole" NOT NULL,
    "originalName" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "duration" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "transcript" JSONB,
    "analysis" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EditElement" (
    "id" TEXT NOT NULL,
    "editProjectId" TEXT NOT NULL,
    "assetId" TEXT,
    "type" "EditElementType" NOT NULL,
    "track" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "startTime" DOUBLE PRECISION NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "trimStart" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "trimEnd" DOUBLE PRECISION,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditElement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EditHistory" (
    "id" TEXT NOT NULL,
    "editProjectId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "actor" "EditHistoryActor" NOT NULL,
    "action" TEXT NOT NULL,
    "command" JSONB,
    "beforeState" JSONB,
    "afterState" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EditAsset_objectKey_key" ON "EditAsset"("objectKey");
CREATE INDEX "EditProject_sourceProjectId_idx" ON "EditProject"("sourceProjectId");
CREATE INDEX "EditProject_updatedAt_idx" ON "EditProject"("updatedAt");
CREATE INDEX "EditAsset_editProjectId_role_idx" ON "EditAsset"("editProjectId", "role");
CREATE INDEX "EditAsset_sourceVideoId_idx" ON "EditAsset"("sourceVideoId");
CREATE INDEX "EditElement_editProjectId_track_position_idx" ON "EditElement"("editProjectId", "track", "position");
CREATE INDEX "EditElement_assetId_idx" ON "EditElement"("assetId");
CREATE UNIQUE INDEX "EditHistory_editProjectId_revision_key" ON "EditHistory"("editProjectId", "revision");
CREATE INDEX "EditHistory_editProjectId_createdAt_idx" ON "EditHistory"("editProjectId", "createdAt");

ALTER TABLE "EditAsset" ADD CONSTRAINT "EditAsset_editProjectId_fkey"
    FOREIGN KEY ("editProjectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EditElement" ADD CONSTRAINT "EditElement_editProjectId_fkey"
    FOREIGN KEY ("editProjectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EditElement" ADD CONSTRAINT "EditElement_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "EditAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_editProjectId_fkey"
    FOREIGN KEY ("editProjectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
