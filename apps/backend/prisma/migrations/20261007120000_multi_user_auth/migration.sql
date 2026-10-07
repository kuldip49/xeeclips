-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CreditType" AS ENUM ('INITIAL_GRANT', 'ADMIN_GRANT', 'ADMIN_DEDUCTION', 'MANUAL_ADJUSTMENT', 'GENERATION_RESERVE', 'GENERATION_CONSUME', 'GENERATION_REFUND');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('RESERVED', 'CONSUMED', 'REFUNDED');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "userId" TEXT;
ALTER TABLE "VideoImport" ADD COLUMN "creditReservationKey" TEXT;

-- AlterTable
ALTER TABLE "ProcessingJob" ADD COLUMN     "creditReservationKey" TEXT;

-- AlterTable
ALTER TABLE "EditProject" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "ReferenceAsset" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "SavedStyle" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "EditTemplate" ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "creditsConsumed" INTEGER NOT NULL DEFAULT 0,
    "aiProcessingConsentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditReservation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 1,
    "status" "ReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "CreditType" NOT NULL,
    "reason" TEXT NOT NULL,
    "jobId" TEXT,
    "adminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditReservation_jobKey_key" ON "CreditReservation"("jobKey");

-- CreateIndex
CREATE INDEX "CreditReservation_userId_createdAt_idx" ON "CreditReservation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditReservation_status_idx" ON "CreditReservation"("status");

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetUserId_createdAt_idx" ON "AuditLog"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Project_userId_createdAt_idx" ON "Project"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EditProject_userId_createdAt_idx" ON "EditProject"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferenceAsset_userId_idx" ON "ReferenceAsset"("userId");

-- CreateIndex
CREATE INDEX "SavedStyle_userId_idx" ON "SavedStyle"("userId");

-- CreateIndex
CREATE INDEX "EditTemplate_userId_idx" ON "EditTemplate"("userId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferenceAsset" ADD CONSTRAINT "ReferenceAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedStyle" ADD CONSTRAINT "SavedStyle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditTemplate" ADD CONSTRAINT "EditTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_credit_nonnegative" CHECK ("creditBalance" >= 0 AND "creditsConsumed" >= 0);
ALTER TABLE "User" ADD CONSTRAINT "User_email_normalized" CHECK (email = lower(trim(email)));
CREATE UNIQUE INDEX "User_single_owner" ON "User" (role) WHERE role = 'ADMIN';
ALTER TABLE "CreditReservation" ADD CONSTRAINT "CreditReservation_amount_nonnegative" CHECK (amount >= 0);
