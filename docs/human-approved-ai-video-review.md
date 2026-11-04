# Human-approved AI video review

MCP 1.2.0 adds five tools and the opt-in `xeeclip:media:review` scope. Production rollout evidence is recorded below after deployment. Existing connections are not expanded: reconnect and explicitly select the new permission. AI processing consent for generation remains a separate setting.

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
|9|No second login|Official SDK approved-client playback without human cookie passed locally|
|10|Media output|Minimal duration/MIME/deadline/evidence coverage; no storage paths|
|11|Review tool|Actual JPEG frames + WAV audio; findings completion requires evidence|
|12|Evidence marker|METADATA_ONLY descriptor vs ACTUAL_RENDERED_MEDIA delivery; sampled coverage explicit|
|13|Edit integration|Canonical headline/edit/export and changed-render re-review passed locally|
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
|26|Production test|Pending gated disposable acceptance and exact cleanup|
|27|Commit|Recorded in final deployment evidence|
|28|Deployed version|Pending; candidate MCP 1.2.0|

## Database and rollback

Migration `20261104000000_human_approved_video_review` is additive and transactional. No reset/down migration is used. Release requires a fresh custom-format production backup, successful isolated restore and SQL rehearsal, unchanged canonical fingerprints for existing rows, false review setting for all restored users and four empty new tables. Backend/frontend rollback artifacts are retained. An application rollback keeps the additive schema; old code ignores it. Existing AI, database, Redis, MinIO and local frontend containers must remain untouched.

Private acceptance artifacts, disposable identities and configuration snapshots stay in ignored `.cache` and the private durable storage backup directory. They are never committed. Production status is not claimed until post-release smoke, original-data preservation, cleanup and maintenance-off health checks pass.
