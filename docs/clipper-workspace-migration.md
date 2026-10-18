# Clipper Workspace V1 migration preview

The exact additive SQL is [20261017000000_clipper_workspace_v1/migration.sql](../apps/backend/prisma/migrations/20261017000000_clipper_workspace_v1/migration.sql).
This preview was created before applying any migration. Production is outside this task's development scope.

Seven new tables are added: Campaign, CampaignBrief, CampaignAsset, CampaignSource, CampaignRun,
CampaignClip and CampaignPost. Existing User, Project, Video, GeneratedClip and EditProject tables
are referenced without changing their columns or existing rows.

There are nine non-primary indexes: five unique indexes (campaign project, asset storage key,
campaign/source video, campaign/request/source idempotency, campaign/generated clip) and four
lookup indexes (owner/status/date, campaign/asset type, run/status/date and campaign/clip lifecycle/date).
The SQL includes all seven primary keys and thirteen foreign keys.

Campaign ownership references User with RESTRICT. The campaign source project also uses RESTRICT.
CampaignSource references existing Video with RESTRICT. CampaignClip references GeneratedClip and
EditProject with SET NULL; removing campaign organization never deletes those canonical records.
New campaign-owned children use CASCADE only within the new domain. Run/source deletion uses RESTRICT.

Defaults are explicit in the SQL: DRAFT campaign, XEEFREE unconfirmed brief, version 1, optional
assets, QUEUED runs, UNKNOWN compliance, NEEDS_REVIEW lifecycle, no initial branding, zero metrics
and earnings, USD currency, empty descriptions/notes/arrays, and creation/upload/post timestamps.
Prisma generates UUID identifiers and writes updatedAt; those have no database SQL default.
Brief/compliance/social/run snapshots use JSONB with application validation. Earnings are DECIMAL(14,2).
Currencies are aggregated separately; no exchange-rate or estimated-payout calculation is introduced.

No existing table/column is dropped, renamed or rewritten. The migration contains no data deletion,
schema reset or destructive statement. Local acceptance applies it only to the dedicated
`clipper-v1-qa` Compose project/database. It is not deployed to production.
