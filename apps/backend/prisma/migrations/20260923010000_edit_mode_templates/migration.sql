-- EditMode Workstream F: templates.
--
-- Additive only. Nothing existing is dropped, renamed or re-typed:
--   * one new enum VALUE on EditHistoryActor, so a template application can be
--     told apart from a preset one in history;
--   * one new table for user-saved templates. Built-in templates live in code
--     and are not stored here.
--
-- A template is a style policy, so it has no relation to EditProject: it is
-- portable across projects and outlives any one of them.

ALTER TYPE "EditHistoryActor" ADD VALUE IF NOT EXISTS 'TEMPLATE';

CREATE TABLE IF NOT EXISTS "EditTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "ownerScope" TEXT NOT NULL DEFAULT 'LOCAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EditTemplate_ownerScope_name_key"
    ON "EditTemplate"("ownerScope", "name");

CREATE INDEX IF NOT EXISTS "EditTemplate_ownerScope_updatedAt_idx"
    ON "EditTemplate"("ownerScope", "updatedAt");
