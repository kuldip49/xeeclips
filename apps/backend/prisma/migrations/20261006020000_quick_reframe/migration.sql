CREATE TABLE "QuickReframe" (
 "id" TEXT NOT NULL, "editProjectId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'INPUT',
 "progress" INTEGER NOT NULL DEFAULT 0, "message" TEXT NOT NULL DEFAULT 'Upload a video',
 "error" TEXT, "operationId" TEXT, "analysis" JSONB, "plan" JSONB,
 "hooks" JSONB NOT NULL DEFAULT '[]', "undo" JSONB NOT NULL DEFAULT '[]', "redo" JSONB NOT NULL DEFAULT '[]',
 "externalAiAuthorized" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "QuickReframe_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuickReframe_editProjectId_key" ON "QuickReframe"("editProjectId");
CREATE INDEX "QuickReframe_createdAt_idx" ON "QuickReframe"("createdAt");
ALTER TABLE "QuickReframe" ADD CONSTRAINT "QuickReframe_editProjectId_fkey"
 FOREIGN KEY ("editProjectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
