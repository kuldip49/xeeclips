ALTER TABLE "GeneratedClip" ADD COLUMN "requestedTemplate" TEXT;
ALTER TABLE "GeneratedClip" ADD COLUMN "effectiveTemplate" TEXT;

UPDATE "GeneratedClip" SET "requestedTemplate" = "templateId",
  "effectiveTemplate" = "templateId" WHERE "templateId" IS NOT NULL;
