-- Additive release guards for the campaign domain only. No legacy rows/columns are rewritten.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_status_check" CHECK ("status" IN ('DRAFT','ACTIVE','PAUSED','COMPLETED','ARCHIVED'));
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_count_check" CHECK ("defaultClipCount" BETWEEN 1 AND 20);
ALTER TABLE "CampaignBrief" ADD CONSTRAINT "CampaignBrief_version_check" CHECK ("version" > 0);
ALTER TABLE "CampaignBrief" ADD CONSTRAINT "CampaignBrief_mode_check" CHECK ("mode" IN ('XEEFREE','XEEPRO'));
ALTER TABLE "CampaignAsset" ADD CONSTRAINT "CampaignAsset_type_check" CHECK ("type" IN ('LOGO','IMAGE','MUSIC','REFERENCE','DOCUMENT'));
ALTER TABLE "CampaignAsset" ADD CONSTRAINT "CampaignAsset_size_check" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 52428800);
ALTER TABLE "CampaignAsset" ADD CONSTRAINT "CampaignAsset_use_check" CHECK ("intendedUse" IN ('','REFERENCE','LOGO_TOP_RIGHT','BACKGROUND_MUSIC','IMAGE_OVERLAY'));
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_status_check" CHECK ("status" IN ('QUEUED','STARTING','GENERATING','PREPARING','COMPLETED','FAILED'));
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_mode_check" CHECK ("mode" IN ('XEEFREE','XEEPRO'));
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_style_check" CHECK ("style" IN ('STYLEZERO','STYLEONE','STYLETWO'));
ALTER TABLE "CampaignRun" ADD CONSTRAINT "CampaignRun_count_check" CHECK ("requestedClipCount" BETWEEN 1 AND 20 AND "briefVersion" > 0);
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_mode_check" CHECK ("mode" IN ('XEEFREE','XEEPRO'));
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_style_check" CHECK ("style" IN ('STYLEZERO','STYLEONE','STYLETWO'));
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_lifecycle_check" CHECK ("lifecycleStatus" IN ('NEEDS_REVIEW','READY','POSTED'));
ALTER TABLE "CampaignClip" ADD CONSTRAINT "CampaignClip_compliance_check" CHECK ("complianceStatus" IN ('PASS','WARN','FAIL','UNKNOWN') AND "complianceScore" BETWEEN 0 AND 100);
ALTER TABLE "CampaignPost" ADD CONSTRAINT "CampaignPost_metrics_check" CHECK ("views" >= 0 AND "likes" >= 0 AND "comments" >= 0 AND "shares" >= 0 AND "earnings" >= 0);
ALTER TABLE "CampaignPost" ADD CONSTRAINT "CampaignPost_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- FK lookup/cleanup paths not covered by existing campaign-leading indexes.
CREATE INDEX "CampaignSource_videoId_idx" ON "CampaignSource"("videoId");
CREATE INDEX "CampaignRun_sourceId_idx" ON "CampaignRun"("sourceId");
CREATE INDEX "CampaignClip_runId_idx" ON "CampaignClip"("runId");
CREATE INDEX "CampaignClip_editProjectId_idx" ON "CampaignClip"("editProjectId");
CREATE INDEX "CampaignClip_generatedClipId_idx" ON "CampaignClip"("generatedClipId");
