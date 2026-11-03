-- CreateTable
CREATE TABLE "McpClient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "secretHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAuthorization" (
    "requestHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "redirectUri" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "scopes" TEXT[],
    "state" TEXT,
    "consentHash" TEXT,
    "codeHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpAuthorization_pkey" PRIMARY KEY ("requestHash")
);

-- CreateTable
CREATE TABLE "McpGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpToken" (
    "hash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopes" TEXT[],
    "resource" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "McpAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "failureCode" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "McpAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "entityId" TEXT,
    "actionId" TEXT,
    "result" TEXT NOT NULL,
    "creditEffect" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "McpClient_createdAt_idx" ON "McpClient"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpAuthorization_codeHash_key" ON "McpAuthorization"("codeHash");

-- CreateIndex
CREATE INDEX "McpAuthorization_expiresAt_idx" ON "McpAuthorization"("expiresAt");

-- CreateIndex
CREATE INDEX "McpGrant_userId_createdAt_idx" ON "McpGrant"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "McpToken_grantId_kind_idx" ON "McpToken"("grantId", "kind");

-- CreateIndex
CREATE INDEX "McpToken_expiresAt_idx" ON "McpToken"("expiresAt");

-- CreateIndex
CREATE INDEX "McpAction_status_createdAt_idx" ON "McpAction"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpAction_userId_clientId_tool_key_key" ON "McpAction"("userId", "clientId", "tool", "key");

-- CreateIndex
CREATE INDEX "McpAudit_userId_createdAt_idx" ON "McpAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "McpAudit_createdAt_idx" ON "McpAudit"("createdAt");

-- AddForeignKey
ALTER TABLE "McpAuthorization" ADD CONSTRAINT "McpAuthorization_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAuthorization" ADD CONSTRAINT "McpAuthorization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "McpGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAction" ADD CONSTRAINT "McpAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAudit" ADD CONSTRAINT "McpAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

