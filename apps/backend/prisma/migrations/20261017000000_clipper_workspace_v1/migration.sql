-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payoutDescription" TEXT NOT NULL DEFAULT '',
    "deadline" TIMESTAMP(3),
    "defaultClipCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBrief" (
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceText" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'XEEFREE',
    "confirmedByUser" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignBrief_pkey" PRIMARY KEY ("campaignId")
);

-- CreateTable
CREATE TABLE "CampaignAsset" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "intendedUse" TEXT NOT NULL DEFAULT '',
    "extractedText" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSource" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "ownershipNote" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRun" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "requestedClipCount" INTEGER NOT NULL,
    "briefVersion" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignClip" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "generatedClipId" TEXT,
    "editProjectId" TEXT,
    "mode" TEXT NOT NULL,
    "style" TEXT NOT NULL,
    "compliance" JSONB NOT NULL,
    "complianceScore" INTEGER NOT NULL DEFAULT 0,
    "complianceStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "checkedRevision" INTEGER NOT NULL DEFAULT -1,
    "checkedBriefVersion" INTEGER NOT NULL DEFAULT 0,
    "lifecycleStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "brandingApplied" BOOLEAN NOT NULL DEFAULT false,
    "socialPackage" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignClip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignPost" (
    "campaignClipId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "postUrl" TEXT NOT NULL DEFAULT '',
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "earnings" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "notes" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignPost_pkey" PRIMARY KEY ("campaignClipId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_projectId_key" ON "Campaign"("projectId");

-- CreateIndex
CREATE INDEX "Campaign_userId_status_createdAt_idx" ON "Campaign"("userId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignAsset_storageKey_key" ON "CampaignAsset"("storageKey");

-- CreateIndex
CREATE INDEX "CampaignAsset_campaignId_type_idx" ON "CampaignAsset"("campaignId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignSource_campaignId_videoId_key" ON "CampaignSource"("campaignId", "videoId");

-- CreateIndex
CREATE INDEX "CampaignRun_status_createdAt_idx" ON "CampaignRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRun_campaignId_requestKey_sourceId_key" ON "CampaignRun"("campaignId", "requestKey", "sourceId");

-- CreateIndex
CREATE INDEX "CampaignClip_campaignId_lifecycleStatus_createdAt_idx" ON "CampaignClip"("campaignId", "lifecycleStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignClip_campaignId_generatedClipId_key" ON "CampaignClip"("campaignId", "generatedClipId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBrief" ADD CONSTRAINT "CampaignBrief_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAsset" ADD CONSTRAINT "CampaignAsset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSource" ADD CONSTRAINT "CampaignSource_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSource" ADD CONSTRAINT "CampaignSource_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "CampaignSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CampaignRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_generatedClipId_fkey" FOREIGN KEY ("generatedClipId") REFERENCES "GeneratedClip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_editProjectId_fkey" FOREIGN KEY ("editProjectId") REFERENCES "EditProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignPost" ADD CONSTRAINT "CampaignPost_campaignClipId_fkey" FOREIGN KEY ("campaignClipId") REFERENCES "CampaignClip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

