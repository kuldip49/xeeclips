ALTER TYPE "ProcessingStage" ADD VALUE IF NOT EXISTS 'WHOLE_VIDEO_UNDERSTANDING' BEFORE 'ANALYZE_CHUNKS';

CREATE TABLE "VideoUnderstanding" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "mainTopic" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "topics" TEXT[],
    "keyClaims" TEXT[],
    "questions" TEXT[],
    "stories" TEXT[],
    "importantMoments" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoUnderstanding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VideoUnderstandingChapter" (
    "id" TEXT NOT NULL,
    "understandingId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "startTime" DOUBLE PRECISION NOT NULL,
    "endTime" DOUBLE PRECISION NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "topics" TEXT[],
    "importanceScore" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "VideoUnderstandingChapter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VideoUnderstanding_videoId_key" ON "VideoUnderstanding"("videoId");
CREATE UNIQUE INDEX "VideoUnderstandingChapter_understandingId_position_key"
    ON "VideoUnderstandingChapter"("understandingId", "position");
CREATE INDEX "VideoUnderstandingChapter_understandingId_startTime_idx"
    ON "VideoUnderstandingChapter"("understandingId", "startTime");

ALTER TABLE "VideoUnderstanding" ADD CONSTRAINT "VideoUnderstanding_videoId_fkey"
    FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoUnderstandingChapter" ADD CONSTRAINT "VideoUnderstandingChapter_understandingId_fkey"
    FOREIGN KEY ("understandingId") REFERENCES "VideoUnderstanding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
