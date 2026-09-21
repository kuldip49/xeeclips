-- CreateEnum
CREATE TYPE "ProcessingJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ChunkAnalysis" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "exclamationCount" INTEGER NOT NULL,
    "keywordDensity" DOUBLE PRECISION NOT NULL,
    "averageSentenceLength" DOUBLE PRECISION NOT NULL,
    "speechRate" DOUBLE PRECISION NOT NULL,
    "informationDensity" DOUBLE PRECISION NOT NULL,
    "readabilityScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChunkAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "status" "ProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT,
    "languageProbability" DOUBLE PRECISION,
    "duration" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transcript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptChunk" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "startTime" DOUBLE PRECISION NOT NULL,
    "endTime" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "wordCount" INTEGER NOT NULL,

    CONSTRAINT "TranscriptChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "transcriptId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "start" DOUBLE PRECISION NOT NULL,
    "end" DOUBLE PRECISION NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "audioBucket" TEXT,
    "audioObjectKey" TEXT,
    "bitrate" BIGINT,
    "codec" TEXT,
    "duration" DOUBLE PRECISION,
    "fps" DOUBLE PRECISION,
    "height" INTEGER,
    "width" INTEGER,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualAnalysis" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "shotBoundaries" JSONB NOT NULL,
    "sceneChangeCount" INTEGER NOT NULL,
    "averageMotion" DOUBLE PRECISION NOT NULL,
    "faceCount" INTEGER NOT NULL,
    "largestFaceRatio" DOUBLE PRECISION NOT NULL,
    "brightness" DOUBLE PRECISION NOT NULL,
    "contrast" DOUBLE PRECISION NOT NULL,
    "colorfulness" DOUBLE PRECISION NOT NULL,
    "ocrText" TEXT NOT NULL,
    "subtitleDetected" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisualAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChunkAnalysis_chunkId_key" ON "ChunkAnalysis"("chunkId" ASC);

-- CreateIndex
CREATE INDEX "ProcessingJob_status_idx" ON "ProcessingJob"("status" ASC);

-- CreateIndex
CREATE INDEX "ProcessingJob_videoId_idx" ON "ProcessingJob"("videoId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_videoId_key" ON "Transcript"("videoId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptChunk_videoId_position_key" ON "TranscriptChunk"("videoId" ASC, "position" ASC);

-- CreateIndex
CREATE INDEX "TranscriptSegment_transcriptId_idx" ON "TranscriptSegment"("transcriptId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_transcriptId_position_key" ON "TranscriptSegment"("transcriptId" ASC, "position" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Video_objectKey_key" ON "Video"("objectKey" ASC);

-- CreateIndex
CREATE INDEX "Video_projectId_idx" ON "Video"("projectId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "VisualAnalysis_chunkId_key" ON "VisualAnalysis"("chunkId" ASC);

-- AddForeignKey
ALTER TABLE "ChunkAnalysis" ADD CONSTRAINT "ChunkAnalysis_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "TranscriptChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptChunk" ADD CONSTRAINT "TranscriptChunk_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisualAnalysis" ADD CONSTRAINT "VisualAnalysis_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "TranscriptChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
