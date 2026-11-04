BEGIN;
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aiVideoReviewEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiVideoReviewRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_USER_APPROVAL',
    "mediaKind" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "renderFingerprint" TEXT NOT NULL,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AiVideoReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVideoReviewGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reviewRequestId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'REVIEW_MEDIA_ONLY',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "allowRevisions" BOOLEAN NOT NULL DEFAULT false,
    "maxPasses" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AiVideoReviewGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVideoReviewPass" (
    "id" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "renderFingerprint" TEXT NOT NULL,
    "mediaKind" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPROVED',
    "verdict" TEXT,
    "evidenceType" TEXT NOT NULL DEFAULT 'METADATA_ONLY',
    "coverage" JSONB NOT NULL DEFAULT '[]',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "evidenceCalls" INTEGER NOT NULL DEFAULT 0,
    "lockUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AiVideoReviewPass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiVideoReviewAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clipId" TEXT NOT NULL,
    "reviewRequestId" TEXT,
    "event" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiVideoReviewAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiVideoReviewRequest_userId_status_createdAt_idx" ON "AiVideoReviewRequest"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AiVideoReviewRequest_expiresAt_idx" ON "AiVideoReviewRequest"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiVideoReviewGrant_reviewRequestId_key" ON "AiVideoReviewGrant"("reviewRequestId");

-- CreateIndex
CREATE INDEX "AiVideoReviewGrant_userId_status_expiresAt_idx" ON "AiVideoReviewGrant"("userId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiVideoReviewPass_grantId_renderFingerprint_key" ON "AiVideoReviewPass"("grantId", "renderFingerprint");

-- CreateIndex
CREATE INDEX "AiVideoReviewAudit_userId_createdAt_idx" ON "AiVideoReviewAudit"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiVideoReviewRequest" ADD CONSTRAINT "AiVideoReviewRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVideoReviewGrant" ADD CONSTRAINT "AiVideoReviewGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVideoReviewGrant" ADD CONSTRAINT "AiVideoReviewGrant_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "AiVideoReviewRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVideoReviewPass" ADD CONSTRAINT "AiVideoReviewPass_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AiVideoReviewGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVideoReviewAudit" ADD CONSTRAINT "AiVideoReviewAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiVideoReviewAudit" ADD CONSTRAINT "AiVideoReviewAudit_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "AiVideoReviewRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Privacy invariants are enforced independently of client/UI input.
ALTER TABLE "AiVideoReviewGrant" ADD CONSTRAINT "AiVideoReviewGrant_scope_check" CHECK ("scope" = 'REVIEW_MEDIA_ONLY');
ALTER TABLE "AiVideoReviewGrant" ADD CONSTRAINT "AiVideoReviewGrant_pass_limit_check" CHECK ((NOT "allowRevisions" AND "maxPasses" = 1) OR ("allowRevisions" AND "maxPasses" = 3));
ALTER TABLE "AiVideoReviewPass" ADD CONSTRAINT "AiVideoReviewPass_call_limit_check" CHECK ("evidenceCalls" >= 0 AND "evidenceCalls" <= 5);
ALTER TABLE "AiVideoReviewPass" ADD CONSTRAINT "AiVideoReviewPass_evidence_check" CHECK ("evidenceType" IN ('METADATA_ONLY','ACTUAL_RENDERED_MEDIA'));

COMMIT;
