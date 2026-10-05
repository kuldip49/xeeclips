ALTER TABLE "Video" ADD COLUMN "sourceType" TEXT NOT NULL DEFAULT 'UPLOAD';
ALTER TABLE "Video" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Video" ADD COLUMN "externalVideoId" TEXT;
CREATE UNIQUE INDEX "Video_projectId_sourceType_externalVideoId_key" ON "Video"("projectId", "sourceType", "externalVideoId");

CREATE TABLE "VideoImport" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "videoId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'YOUTUBE',
  "externalVideoId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "stage" TEXT NOT NULL DEFAULT 'FETCHING_INFO',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "error" TEXT,
  "title" TEXT,
  "durationSec" DOUBLE PRECISION,
  "thumbnailUrl" TEXT,
  "aiMode" "AiProcessingMode" NOT NULL DEFAULT 'ONLINE',
  "processingType" "ProcessingType" NOT NULL DEFAULT 'EDITED_CLIPS',
  "outputAspectRatio" TEXT DEFAULT '9:16',
  "targetPlatform" "TargetPlatform",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VideoImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VideoImport_projectId_provider_externalVideoId_key" ON "VideoImport"("projectId", "provider", "externalVideoId");
CREATE INDEX "VideoImport_projectId_status_idx" ON "VideoImport"("projectId", "status");
ALTER TABLE "VideoImport" ADD CONSTRAINT "VideoImport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoImport" ADD CONSTRAINT "VideoImport_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;
