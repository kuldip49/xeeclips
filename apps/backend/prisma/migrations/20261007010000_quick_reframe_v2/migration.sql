-- Quick Reframe V2: crop-first wizard. Additive only; existing sessions keep working.
ALTER TABLE "QuickReframe" ADD COLUMN "editPath" TEXT;
ALTER TABLE "QuickReframe" ADD COLUMN "confirmed" JSONB;
