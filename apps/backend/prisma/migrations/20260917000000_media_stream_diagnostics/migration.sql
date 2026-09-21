ALTER TABLE "Video"
  ADD COLUMN "hasVideo" BOOLEAN,
  ADD COLUMN "hasAudio" BOOLEAN,
  ADD COLUMN "audioCodec" TEXT,
  ADD COLUMN "videoStreamIndex" INTEGER,
  ADD COLUMN "audioStreamIndex" INTEGER,
  ADD COLUMN "formatName" TEXT;

ALTER TABLE "ProcessingJob"
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "retryable" BOOLEAN NOT NULL DEFAULT true;
