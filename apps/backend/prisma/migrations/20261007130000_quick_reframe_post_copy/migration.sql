ALTER TABLE "QuickReframe" ADD COLUMN "sourceContext" JSONB;
ALTER TABLE "QuickReframe" ADD COLUMN "postCopy" JSONB NOT NULL DEFAULT '{}';
