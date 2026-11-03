# XeeClip MCP external-source import release report

Released 2026-11-03: **XEECLIP_MCP_MULTI_PLATFORM_IMPORT_DEPLOYED_AND_HEALTHY**. Local and production gates passed. Maintenance is off; open P0=0 / P1=0.

| # | Item | Result |
|---|---|---|
| 1 | actual supported platform list | YouTube, Instagram and X/Twitter, enabled by existing production approval flags. TikTok, Facebook, Vimeo, Twitch, direct media and other providers are not implemented. |
| 2 | generic import architecture | Generic MCP adapter → shared provider resolver → existing VideoImport queue/retriever/normalizer → normal owned Project/Video/processing job. No MCP-only downloader, source model or renderer. |
| 3 | provider detection | Parsed HTTPS URLs, exact hosts/path syntax and canonical IDs. Shared with the existing website/social resolver; tracking fields removed. Explicit X video selection retained. |
| 4 | import MCP tool | xeeclip_import_source(url, idempotencyKey, optional title) returns a durable import reference immediately; queue delivery runs after transaction admission. New analysis uses XeeFree and costs no generation credit. |
| 5 | import status tool | xeeclip_get_source_import returns QUEUED, PROCESSING, COMPLETE or FAILED. COMPLETE/sourceStatus READY includes sourceId only after canonical analysis completes. Poll at least every 5000ms. |
| 6 | supported-sources tool | xeeclip_get_supported_sources derives enabled providers/limits from the shared registry and deployment flags, and exposes existing Create defaults (XeePro/StyleZero/3, Free when Pro is administratively disabled). Explicit user settings take precedence. |
| 7 | YouTube | Supplied authorized URL imported to a normal READY source, visible in the website; real Free StyleOne generation, edit and export passed locally and in production. Source duration approximately 22m27s. |
| 8 | Instagram | Supplied authorized Reel imported and analyzed. Missing metadata duration was handled by actual file probing; 23.88s source reached READY and real StyleTwo Quick Reframe Result in production. |
| 9 | TikTok | Not implemented by the existing importer. Clean UNSUPPORTED_SOURCE tested; no new support claim. |
| 10 | Facebook | Not implemented. Clean UNSUPPORTED_SOURCE tested. |
| 11 | X/Twitter | Supplied authorized video imported to READY locally and in production. Targeted fixes validate post display_id separately from media id, preserve selected-video URLs and defer unknown codec names to the actual strict local probe. |
| 12 | Vimeo | Not implemented. Clean UNSUPPORTED_SOURCE tested. |
| 13 | direct URLs | Not implemented; no generic fetch endpoint. Direct-media input returns UNSUPPORTED_SOURCE. Normal website file uploads remain unchanged. |
| 14 | any other supported sources | None beyond the three registry entries. Twitch/unknown URLs are rejected; the retriever's wider extractor catalog is not exposed as a support claim. |
| 15 | unsupported behavior | Strict input schemas and provider policy reject unsupported host/path/scheme, credential URLs, fragments and arbitrary inputs without fetching them. Safe normalized MCP errors only. |
| 16 | private/login-protected behavior | Existing access gates retained, credentials/cookies are not imported from browsers, and no login/private/paywall bypass is attempted. Unit checks cover reliably detected private/login/age gates; no unauthorized private live sample was used. |
| 17 | DRM behavior | Known protected formats/messages map to SOURCE_DRM_PROTECTED and stop. Protected-stream rejection is tested with controlled metadata; DRM bypass is not implemented. |
| 18 | redirects/SSRF | Authenticated per-process loopback HTTPS proxy checks/pins every destination to public IPv4, rejects mixed/private DNS, internal/XeeClip destinations and nonstandard ports. Native downloads stay behind the proxy. Real proxy/rebinding tests passed; local probes/FFmpeg inputs cannot open embedded network resources. |
| 19 | 3-hour limit | 10800-second cap is retained for every supported provider, with actual downloaded-file probing and normalized source validation. All-provider 10800/10800.001 boundary tests passed; existing upload regressions passed. Quick Reframe separately retains its 180-second cap. |
| 20 | idempotency | Scoped MCP receipts commit with import admission; per-user/provider/video transaction lock coalesces different concurrent keys. Same-key retries never repeat import work. Explicit new keys can retry eligible failures; a new action cannot join a deleted/failed source forever. Queue-loss/deleted-source fault tests used rolled-back PostgreSQL fixtures. |
| 21 | Create Clips flow | Real authorized YouTube URL → normal analyzed source → Free StyleOne clip → job/result passed locally and in production. Existing generation mode/style/count inputs remain authoritative; optional create_clips(sourceUrl) orchestration is omitted in favor of the explicit async chain. |
| 22 | Quick Reframe flow | Real authorized Instagram URL → source READY → XeeFree StyleTwo → saved Result passed locally and in production; existing canonical flow and transcript reuse retained. |
| 23 | Campaign flow | Imported YouTube source → stored campaign → Free understanding → explicit brief confirmation → attach source → generation → compliance WARN passed locally and in production. No posting or external publication was performed. |
| 24 | canonical editor after import | Imported clip used the same EditProject; headline edit, canonical MP4 export and authenticated ranged download passed. Website editor/Result/History showed saved state at 1440, 375 and 390px, with no horizontal overflow and visible export control. |
| 25 | ChatGPT-compatible test | Official SDK authenticated over production HTTPS, discovered 45 tools and completed all three provider imports plus generation/edit/export. Offline refresh resumed existing long-running jobs with identical references and no new charge. Branded ChatGPT UI was not exercised. Refresh discovered tools and reconnect to approve xeeclip:sources:import. |
| 26 | Claude-compatible test | The same compatible official remote SDK flow passed in production, with Inspector 2.13.0 strict catalog acceptance locally. Branded Claude UI was not exercised; use automatic OAuth client registration, not CIMD. |
| 27 | credits | Production imports/analysis made no credit reservation or charge. Only the two requested Create/campaign generations consumed credits; ordinary editing/export had no extra charge. No duplicate or outstanding reservations; import audit is NO_CREDIT_CHARGE. Resuming QA after token expiry did not regenerate media. |
| 28 | XeeFree zero-cloud | Controlled policy/network-trap regression and real source-job telemetry show zero cloud calls/OpenAI calls/Pro escalations. Pro selection remains explicit; existing busy/refund regression passed without silent Free fallback. |
| 29 | regression tests | 11 affected local suites, backend build, frontend typecheck, immutable image contracts, real three-provider production SDK flows, OAuth refresh/replay/revocation, explicit import-scope denial, IDOR, safe audit/token storage, desktop/375/390 Settings/consent/editor/Result/History passed. Production rate limits were preserved and QA respected retry delays. Open P0=0, P1=0. |
| 30 | production health | Site/API/MCP 1.1.0/database/Redis/MinIO/AI/tunnel healthy after reopening; OAuth advertises 14 scopes including explicit source import. All original 40 table fingerprints / 48,865 rows and 637 storage objects preserved after removing both disposable users and their media/metadata. Existing MCP connections preserved. No database migration; all 38 migration records finished. |
| 31 | commit/deployment | Runtime commit 51dcd2bf9de0d84395e4e46230af333e978aa787, normally pushed to main; backend image sha256:184b4b4ee4cda12666061a72ba46e78eed1aad173062b24e840cf14940c162d8. Backend-only cutover under maintenance with idle checks and a fresh restored backup. Frontend c8ec9555-08e5-450a-b1d5-cf441021f951, AI, Postgres, Redis and MinIO unchanged. Original configuration/tunnel restored. Rollback prepared and retained; not performed. |

## Production backup and preservation

- Restore-tested pre-deployment backup: `C:\projects\ai-content-platform\storage\xeeclip-source-import-20261103\production-1793676489943.dump` (31,506,381 bytes).
- SHA-256: `d71e23e0985fc092b91ba3fd9ddccfbd5aa91e7d34d732268c7fd996a69cf54e`. Isolated PostgreSQL restore matched all 40 original table fingerprints. No migration or destructive reset was applied.
- Retained rollback image: `xeeclip-backend-rollback:before-xeeclip-source-import` (`sha256:85de633faa73075ddfe38b00700aa6c0682d59aa2ed87468f5487fd3d9672d8e`). The private guarded rollback helper restores the previous backend/configuration and leaves the database schema intact. Public frontend rollback is unnecessary because it was unchanged.
- All three production URL imports reached READY: YouTube (1347.34s), Instagram (23.88s) and X (8.27s). Successful admission requests returned in 72–112ms; download/analysis ran asynchronously.
- Production Create → canonical edit → MP4/range download, Instagram → StyleTwo Reframe Result, and imported source → confirmed campaign → generation/compliance passed. Both disposable accounts/imports/media/credits/OAuth metadata were then removed; original database, existing connections and all 637 storage objects retained exact fingerprints.
- Final public health/discovery and unchanged frontend bundle hashes verified at 2026-11-03T06:12:09.872Z. Maintenance is OFF; unchanged service container identities and production environment were verified.
- Temporary verification connections experienced transient fetch failures; bounded retries retained TLS verification. A long-running QA client's access token expired while approval review was unavailable; refresh resumed the existing job rather than admitting another generation. Final acceptance and exact credit accounting passed.


## Evidence and limits

Local private evidence: ignored `.cache/source-import/qa`; release/backup operations: ignored `.cache/xeeclip-source-import-release`. Authorized media URLs, credentials and storage inventories are excluded from Git. [The implementation guide](xeeclip-complete-mcp.md#external-url-workflow) documents the exact tools, scope upgrade, retry and error behavior.

Existing P2 dependency-maintenance and static SPA unknown-route HTTP 200 issues remain documented in the previous release report. Unimplemented platforms and branded-client UI testing are stated limitations, not claimed passes. No new P3 polish work was added. IPv6-only destinations are conservatively rejected; access to a particular public post still depends on platform restrictions.

XEECLIP_MCP_MULTI_PLATFORM_IMPORT_DEPLOYED_AND_HEALTHY
