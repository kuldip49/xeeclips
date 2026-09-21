-- AddEnumValue
ALTER TYPE "ProcessingStage" ADD VALUE 'GENERATE_CLIP_CANDIDATES' BEFORE 'VISUAL_ANALYSIS';

-- CreateTable
CREATE TABLE "ClipCandidate" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "startTime" DOUBLE PRECISION NOT NULL,
    "endTime" DOUBLE PRECISION NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "transcriptText" TEXT NOT NULL,
    "titleCandidate" TEXT NOT NULL,
    "hookCandidate" TEXT NOT NULL,
    "captionCandidate" TEXT NOT NULL,
    "synopsis" TEXT NOT NULL,
    "hashtags" TEXT[] NOT NULL,
    "reason" TEXT NOT NULL,
    "hookScore" DOUBLE PRECISION NOT NULL,
    "informationScore" DOUBLE PRECISION NOT NULL,
    "emotionScore" DOUBLE PRECISION NOT NULL,
    "controversyScore" DOUBLE PRECISION NOT NULL,
    "standaloneScore" DOUBLE PRECISION NOT NULL,
    "viralPotentialScore" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClipCandidate_videoId_rank_key" ON "ClipCandidate"("videoId", "rank");

-- CreateIndex
CREATE INDEX "ClipCandidate_videoId_viralPotentialScore_idx" ON "ClipCandidate"("videoId", "viralPotentialScore");

-- AddForeignKey
ALTER TABLE "ClipCandidate" ADD CONSTRAINT "ClipCandidate_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
