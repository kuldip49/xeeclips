# Three-hour source upload deployment — 2 November 2026

Status: **DEPLOYED_AND_HEALTHY**

Release commit: `113eaae052d6d3feea188d88e119184233167781`, pushed normally to main.
Backend: `xeeclip-backend:three-hour-113eaae` (`sha256:3d73092e1cfd270b8dceb1bbcb8ab47fa80bd23b1494979f881ad8a06418ccae`).
Cloudflare frontend version: `1aeec32c-fe78-442e-a2ba-070b37c6e289`. Live Create page scripts match the production build exactly.

Create Clips and Clipper source uploads accept up to and including 10,800 seconds.
The production YouTube import setting is now `YOUTUBE_IMPORT_MAX_DURATION=10800`.
The 4 GiB chunked upload cap, 30-clip cap, Quick Reframe's separate 180-second limit,
and direct editor capacity remain unchanged.

| Production check | Result |
|---|---|
| Source duration | Actual 10,800-second upload accepted; 10,801-second upload rejected with VIDEO_TOO_LONG; rejected upload creates no video. Worker passes the 3-hour duration check. |
| Browser limit | Real metadata and friendly over-limit prevention pass at 1440px, 375px and 390px; no unwanted project/upload request or horizontal overflow. |
| Create Clips | XeeFree generation, MP4 download and saved History pass for StyleZero, StyleOne and StyleTwo. |
| Quick Reframe | All three styles pass crop, saved Result, direct export, refresh and explicit canonical editor, including mobile controls. |
| Clippers | New Campaign, rules, logo/music, confirmed understanding, source, Free StyleOne generation, compliance, canonical edit/save, export, Ready, Posted and exact metrics pass. |
| Auth and security | Disposable signup, real browser login/logout, secure cookie, reciprocal resource ownership, ordinary-user admin/credit mutation denial and invalid uploads pass. |
| Credits | Seven successful charges; exactly one reserve and settlement per job; zero outstanding reservations. |
| XeeFree | 6 production audit records have zero cloud/OpenAI calls, escalations and blocked attempts. |
| XeePro | One bounded attempt returns XEEPRO_BUSY, with no charge and no automatic Free fallback. |
| Errors | Insufficient credits, corrupt media, over-limit media and busy behavior show friendly messages. Public DTOs omit private storage/provider fields. |
| Services | Site, API, AI service, PostgreSQL, Redis, MinIO and tunnel healthy. AI and dependency containers retain their original IDs/images. |
| Migrations | 37 applied; 0 incomplete; no new migration. |
| Preservation | All 48,859 original rows across 34 app tables and all 637 original storage objects retain their fingerprints after cleanup. |
| Final state | Disposable users, media and credentials removed; workers idle; original tunnel restored; maintenance off; four post-reopen health samples passed. |

The exact-duration production fixture intentionally contains no audio, so it reaches the
worker's ordinary NO_AUDIO_STREAM check after passing the duration gate. Real short speech
media covers successful end-to-end generation/export. Full three-hour transcription quality
and processing time were not benchmarked.

Fresh database backup: `C:\projects\ai-content-platform\storage\three-hour-release-20261102-113eaae\production-1793625399683.dump` (31,491,523 bytes).
SHA-256: `ccd60633055c52e168773b00818ed97809f173d7f110a4d448385c2da8003838`. Restored successfully in network-isolated PostgreSQL and matched all 34 tables.
Configuration snapshots, pinned cutover/rollback files and sanitized acceptance summaries are retained in
`C:/projects/ai-content-platform/storage/three-hour-release-20261102-113eaae`; private configuration and credentials are excluded from Git.

Rollback is prepared and unused: backend `xeeclip-backend-rollback:before-three-hour-113eaae`, original environment snapshot,
and frontend version `c4a92393-dbc7-4dd8-af9d-9a6862c64759`. No live database reset or restore was performed.

Local verification before deployment: shared/backend/frontend builds, 17 backend suites,
8 frontend suites, 9 browser cases, real-media upload tests, import/count/performance/error
regressions, and real-media/safe-error tests inside the deployment image passed.

Final health verification: 2026-11-02T13:36:20.256Z.
