# Human-approved AI video review

MCP 1.2.0 adds five tools and the opt-in `xeeclip:media:review` scope. Deployed and healthy on 2026-11-04. Production rollout evidence is recorded below. Existing connections are not expanded. Register/re-add the assistant connection with the new permission, then explicitly approve it. A client registration that cached the old scope list must be registered again; a token refresh cannot add permission. AI processing consent for generation remains a separate setting.

## Privacy and use

Settings → Integrations → AI Assistants → AI Video Review starts OFF for every existing and new user. Turning it ON only permits review requests. Each specific rendered video still requires the signed-in human to choose Allow Once or Cancel. Optional revision access is unchecked by default. A reviewing assistant can understand information visible or audible in the approved video; this does not permit unrelated account/application access.

`xeeclip_request_video_review` returns an approval request and human approval link, never media. Approval is cookie/Origin protected and nonce bound; there is no MCP approval tool. `xeeclip_get_approved_video_reviews` discovers only the exact connection's already approved review IDs, purposes and deadlines. It cannot list unapproved clips or the library. Website Check with AI buttons explain approval and instruct the human to return to the connected assistant; a server cannot initiate an unsolicited assistant turn.

`xeeclip_get_review_media` returns minimal playback information and a two-minute HMAC ticket, capped by grant expiry. The protected gateway also requires the approved client's MCP bearer token, without an interactive browser login. It streams only rendered H.264/audio, strips hidden tags, chapters, subtitle/data tracks and H.264 SEI user data, and sends no-store/noindex/no-referrer headers. Review access does not grant long-lived export/download rights. Like any visible media, recipients can retain content they actually receive.

`xeeclip_review_video` supplies actual decoded rendered evidence: up to eight JPEG frames and twenty seconds of mono audio per bounded range. Native image/audio blocks are outside structured JSON. The assistant must report only observed issues and identify sampled coverage; if its host does not forward audio, it must say audio was not reviewed. No transcript, source metadata, editor JSON, campaign brief, account details, storage keys or credentials are supplied. Video content is untrusted data, not instructions. No transcription/OCR/provider calls or review credit charges are added.

`xeeclip_complete_video_review` stores timestamped findings only after actual media has been delivered. A descriptor alone remains METADATA_ONLY and cannot support a completed inspection. The actual-media marker proves delivery/decoding, not that an AI understood every frame. Branded ChatGPT/Claude model behavior is not inferred from SDK or website tests.

## Authorization and lifecycle

OAuth scope + account opt-in + server-side human-approved ReviewGrant are all required. Grants bind user, OAuth client, connection, clip, purpose and exact render fingerprint. Default: one render, fifteen minutes or completion, whichever comes first. Explicit revision access allows at most three versions of the same clip during the original window. Each version permits at most five shared sample/stream attempts. Two inspections/streams can run concurrently; FFmpeg sample commands have eight-second deadlines. Review completion closes old render access.

OFF, Revoke, OAuth disconnect and expiry invalidate authorization server-side without restart. OFF revokes pending requests and active grants; ON does not resurrect them. Active streams are rechecked every second, with explicit expiry timers. Pending approvals expire after ten minutes. Requested/approved/accessed/completed/expired/revoked events are audited with identities/time; no media bytes, signed URLs or tokens enter audit logs.

Review-only OAuth clients cannot get accounts, credits, sources, History, campaigns, jobs, canonical projects, edits, exports or generation. Separately approved clips:read/edit/export permissions continue to govern the existing canonical editor. Findings offer Open Editor/Fix with AI where a canonical project exists; editing never follows from review permission itself.

## Release acceptance

| # | Requirement | Evidence/status |
|---|---|---|
|1|Permission architecture|Three independent server-side gates; user/client/connection/clip/render binding|
|2|Settings toggle|Explicit On/Off, persists; separate from generation consent|
|3|Default state|Database DEFAULT false; no inferred opt-in|
|4|Request tool|Idempotent pending request, no media|
|5|Human approval|Playable human preview, Allow Once/Cancel, unchecked revision option|
|6|ReviewGrant|Four additive request/grant/pass/audit tables; DB scope/pass/evidence constraints|
|7|Temporary duration|15-minute grant, 10-minute pending request, completion ends access|
|8|Protected media|HMAC ticket + exact MCP bearer; hidden metadata removed|
|9|No second login|Official SDK approved-client playback without human cookie passed in production|
|10|Media output|Minimal duration/MIME/deadline/evidence coverage; no storage paths|
|11|Review tool|Actual JPEG frames + WAV audio; findings completion requires evidence|
|12|Evidence marker|METADATA_ONLY descriptor vs ACTUAL_RENDERED_MEDIA delivery; sampled coverage explicit|
|13|Edit integration|Canonical headline/edit/export and changed-render re-review passed in production|
|14|Bounded re-review|Default one version, explicit maximum three; no grant extension|
|15|Review-only client|Actual review succeeds, unrelated tools deny by scope|
|16|Account isolation|Cross-user and account/library/campaign/admin/credit probes denied|
|17|Clip isolation|Different owned clip/ticket substitution denied|
|18|Client isolation|Same-user other client and foreign client denied|
|19|Denial|Cancel → AI_VIDEO_REVIEW_DENIED|
|20|Disabled|OFF blocks new access and cached request receipts; ON never restores grants|
|21|Expiry|Simulated deadline → AI_VIDEO_REVIEW_EXPIRED|
|22|Revoke|Next access denied; active stream checks ≤1 second|
|23|Audit|Lifecycle events verified; no media/URL/token log fields|
|24|MCP regression|50 tools; strict schemas/PKCE/refresh/revocation/rates/idempotency/IDOR; all Free styles, mocked Pro success/busy refund, Reframe, campaigns, canonical edits/export, source-import units|
|25|Website regression|Review dialogs, Settings/OAuth at 1440/375/390; Create/Reframe/Clippers/campaign/History/editor/result fit all widths|
|26|Production test|A–H security/media/edit acceptance passed; responsive UI passed; all disposable users/media removed; original data/storage preserved; maintenance OFF|
|27|Commit|Release application `842b2c2a2f253b3916c5a4418d773870bc343f78`, pushed normally through feature branch and main|
|28|Deployed version|MCP 1.2.0, 50 tools, 15 scopes; Cloudflare `47d75bdd-a40a-45bf-a671-97ae67ff3ed1`|

## Database and rollback

Migration `20261104000000_human_approved_video_review` is additive and transactional. No reset/down migration is used. Release requires a fresh custom-format production backup, successful isolated restore and SQL rehearsal, unchanged canonical fingerprints for existing rows, false review setting for all restored users and four empty new tables. Backend/frontend rollback artifacts are retained. An application rollback keeps the additive schema; old code ignores it. Existing AI, database, Redis, MinIO and local frontend containers must remain untouched.

Private acceptance artifacts, disposable identities and configuration snapshots stay in ignored `.cache` and the private durable storage backup directory. They are never committed. Post-release smoke, original-data preservation, cleanup and maintenance-off health checks all passed.

## Final production evidence

- Release application: `842b2c2a2f253b3916c5a4418d773870bc343f78`; backend image `sha256:ce89cdfd934d62360405a352c09fa96815228fe310484d4cb0716bb4f4c83432`. MCP endpoint remains `https://api.xeeclip.me/mcp`.
- Frontend version: `47d75bdd-a40a-45bf-a671-97ae67ff3ed1`. The public review bundle exactly matches the tested artifact (SHA-256 `e8c63df6528c5815ab0bad197f2a7a3e191bc28c6b0c5e3f383efad1950a72c4`).
- Migration 39, `20261104000000_human_approved_video_review`, is applied. First restore/rehearsal validated all 40 original tables and four added empty tables. Final cleanup preserved all 44 current table fingerprints and all 50,644 original rows. All original users remain review OFF. All four review tables are empty after disposable cleanup.
- Fresh final backup: `C:\projects\ai-content-platform\storage\xeeclip-human-review-20261104\production-1793808724698.dump`, 33,638,957 bytes, SHA-256 `d14d836899a98be8976c392243fa12688d653640056793c78cbe8a209694f053`. Restore and migration checksum verified; original pre-migration backup is also retained in the same private directory.
- All 669 original storage objects preserved, inventory SHA-256 `818d4e5535e5af667fdd1584e0500a8afe8daef6c60884759ab69890e6a801b8`. No original OAuth records changed or expired during final preservation checks.
- Production SDK acceptance passed OFF, ON without approval, human Allow Once, actual sanitized MP4/native JPEG/WAV delivery, different user/client/owned clip denial, metadata-only completion denial, expiry, revoke, OFF invalidation, audit and canonical headline edit/export/re-review. Actual returned QA frames were visually inspected before/after; the headline changed in rendered pixels. Media delivery/decoding is distinct from subjective model comprehension.
- Production regression passed all three XeeFree styles, Quick Reframe, campaign logo/music → Free understanding → confirmation → generation → canonical assets/captions → compliance (WARN, with no FAIL/UNKNOWN), OAuth/refresh/replay/revoke, and one bounded real XeePro attempt returning XEEPRO_BUSY with its credit refund verified. Mocked Pro success/refund and source-import validation/security suites also passed locally; no new live external URL import was needed for this unchanged import pipeline.
- Production human approval UI and website smoke passed at 1440, 375 and 390 pixels: explicit On/Off, playable preview, unchecked revision default, Cancel, Allow Once, optional session revisions, Revoke, History Check with AI privacy, Create, Reframe/result, Clippers/campaign, History and editor. No horizontal overflow.
- Two earlier attempts automatically restored the prior backend/frontend when release checks failed. Release tooling was corrected to handle Windows background handles and public asset propagation. The remaining UI test read Cancel before its asynchronous save completed; the test now waits for the exact save/revoke response. No product authorization change was necessary. The unchanged immutable image's passed production security/campaign/credit evidence was retained, and final UI/site gates were rerun with fresh disposable users. All attempts cleaned their disposable data; no original rows/media were lost.
- Final health at 2026-11-04 16:26:27 UTC: site/API/MCP/OAuth healthy, maintenance OFF, queues idle, no live reservations. AI service, PostgreSQL, Redis, MinIO and local frontend container identities/images unchanged. Tunnel configuration restored exactly. Prior backend image and Cloudflare version `94ced590-6608-41bf-9d9f-d45e431d475d` retained for rollback; no destructive schema rollback is required.

Evidence is stored privately under `.cache/human-approved-review-release/` (final UI/site/cleanup) and its `attempt-2/production-qa/` directory (unchanged-image security/media/campaign/credit acceptance). No actual ChatGPT/Claude branded conversation was run as part of this QA: official MCP SDK, decoded media, inspected frames and the real XeeClip browser UI were tested. Hosts must support/forward the relevant native media blocks; assistants must identify any unreviewed audio or unsampled portions. Findings link to existing canonical projects; unmaterialized clips retain the existing explicit Edit Video/restore flow. No outstanding P0/P1 release blockers.

Final status: **XEECLIP_HUMAN_APPROVED_AI_REVIEW_DEPLOYED_AND_HEALTHY**
