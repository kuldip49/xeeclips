-- Legacy EditProjects remain valid. A generated clip may own at most one
-- canonical materialized EditProject.
ALTER TABLE "EditProject" ADD COLUMN "generatedClipId" TEXT;

CREATE UNIQUE INDEX "EditProject_generatedClipId_key"
ON "EditProject"("generatedClipId");

ALTER TABLE "EditProject"
ADD CONSTRAINT "EditProject_generatedClipId_fkey"
FOREIGN KEY ("generatedClipId") REFERENCES "GeneratedClip"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
