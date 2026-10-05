-- Preserve immutable generation intent and per-clip provenance.
ALTER TABLE "GeneratedClip" ADD COLUMN "generationJobId" TEXT;
ALTER TABLE "GeneratedClip" ADD COLUMN "templateId" TEXT;
ALTER TABLE "GeneratedClip" ADD COLUMN "styleVariant" TEXT;
ALTER TABLE "GeneratedClip" ADD COLUMN "requestedClipIndex" INTEGER;

CREATE INDEX "GeneratedClip_generationJobId_idx" ON "GeneratedClip"("generationJobId");
