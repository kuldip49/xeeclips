# XeeClip MCP external-source import release report

Local acceptance: **XEECLIP_MCP_MULTI_PLATFORM_IMPORT_RELEASE_READY**. Production deployment pending; no new deployment success is claimed here.

| # | Item | Result |
|---|---|---|
| 1 | actual supported platform list | YouTube, Instagram and X/Twitter, enabled by existing production approval flags. TikTok, Facebook, Vimeo, Twitch, direct media and other providers are not implemented. |
| 2 | generic import architecture | Generic MCP adapter → shared provider resolver → existing VideoImport queue/retriever/normalizer → normal owned Project/Video/processing job. No MCP-only downloader, source model or renderer. |
| 3 | provider detection | Parsed HTTPS URLs, exact hosts/path syntax and canonical IDs. Shared with the existing website/social resolver; tracking fields removed. Explicit X video selection retained. |
| 4 | import MCP tool | xeeclip_import_source(url, idempotencyKey, optional title) returns a durable import reference immediately; queue delivery runs after transaction admission. New analysis uses XeeFree and costs no generation credit. |
| 5 | import status tool | xeeclip_get_source_import returns QUEUED, PROCESSING, COMPLETE or FAILED. COMPLETE/sourceStatus READY includes sourceId only after canonical analysis completes. Poll at least every 5000ms. |
| 6 | supported-sources tool | xeeclip_get_supported_sources derives enabled providers/limits from the shared registry and deployment flags, and exposes existing Create defaults (XeePro/StyleZero/3, Free when Pro is administratively disabled). Explicit user settings take precedence. |
| 7 | YouTube | Supplied authorized URL imported to a normal READY source, visible in the website; real Free StyleOne generation, edit and export passed locally. Source duration approximately 22m27s. |
| 8 | Instagram | Supplied authorized Reel imported and analyzed. Missing metadata duration was handled by actual file probing; 23.88s source reached READY and real StyleTwo Quick Reframe Result locally. |
| 9 | TikTok | Not implemented by the existing importer. Clean UNSUPPORTED_SOURCE tested; no new support claim. |
| 10 | Facebook | Not implemented. Clean UNSUPPORTED_SOURCE tested. |
| 11 | X/Twitter | Supplied authorized video imported to READY locally. Targeted fixes validate post display_id separately from media id, preserve selected-video URLs and defer unknown codec names to the actual strict local probe. |
| 12 | Vimeo | Not implemented. Clean UNSUPPORTED_SOURCE tested. |
| 13 | direct URLs | Not implemented; no generic fetch endpoint. Direct-media input returns UNSUPPORTED_SOURCE. Normal website file uploads remain unchanged. |
| 14 | any other supported sources | None beyond the three registry entries. Twitch/unknown URLs are rejected; the retriever's wider extractor catalog is not exposed as a support claim. |
| 15 | unsupported behavior | Strict input schemas and provider policy reject unsupported host/path/scheme, credential URLs, fragments and arbitrary inputs without fetching them. Safe normalized MCP errors only. |
| 16 | private/login-protected behavior | Existing access gates retained, credentials/cookies are not imported from browsers, and no login/private/paywall bypass is attempted. Unit checks cover reliably detected private/login/age gates; no unauthorized private live sample was used. |
| 17 | DRM behavior | Known protected formats/messages map to SOURCE_DRM_PROTECTED and stop. Protected-stream rejection is tested with controlled metadata; DRM bypass is not implemented. |
| 18 | redirects/SSRF | Authenticated per-process loopback HTTPS proxy checks/pins every destination to public IPv4, rejects mixed/private DNS, internal/XeeClip destinations and nonstandard ports. Native downloads stay behind the proxy. Real proxy/rebinding tests passed; local probes/FFmpeg inputs cannot open embedded network resources. |
| 19 | 3-hour limit | 10800-second cap is retained for every supported provider, with actual downloaded-file probing and normalized source validation. All-provider 10800/10800.001 boundary tests passed; existing upload regressions passed. Quick Reframe separately retains its 180-second cap. |
| 20 | idempotency | Scoped MCP receipts commit with import admission; per-user/provider/video transaction lock coalesces different concurrent keys. Same-key retries never repeat import work. Explicit new keys can retry eligible failures; a new action cannot join a deleted/failed source forever. Queue-loss/deleted-source fault tests used rolled-back PostgreSQL fixtures. |
| 21 | Create Clips flow | Real authorized YouTube URL → normal analyzed source → Free StyleOne clip → job/result passed locally. Existing generation mode/style/count inputs remain authoritative; optional create_clips(sourceUrl) orchestration is omitted in favor of the explicit async chain. |
| 22 | Quick Reframe flow | Real authorized Instagram URL → source READY → XeeFree StyleTwo → saved Result passed locally; existing canonical flow and transcript reuse retained. |
| 23 | Campaign flow | Imported YouTube source → stored campaign → Free understanding → explicit brief confirmation → attach source → generation → compliance WARN passed locally. No posting or external publication was performed. |
| 24 | canonical editor after import | Imported clip used the same EditProject; headline edit, canonical MP4 export and authenticated ranged download passed. Website editor/Result/History showed saved state at 1440, 375 and 390px, with no horizontal overflow and visible export control. |
| 25 | ChatGPT-compatible test | Official SDK authenticated, discovered 45 strict tools and completed URL import/generation/edit/export. Branded ChatGPT UI was not exercised. Refresh discovered tools and reconnect to consent to xeeclip:sources:import. |
| 26 | Claude-compatible test | Official compatible SDK and Inspector 2.13.0 passed. Branded Claude UI was not exercised; use automatic OAuth client registration, not CIMD. |
| 27 | credits | Import/analysis made no credit reservation/charge. Only the two requested Create/campaign generations consumed credits locally; editing/ordinary export had no extra charge. No duplicate or outstanding reservations; explicit import audit is NO_CREDIT_CHARGE. |
| 28 | XeeFree zero-cloud | Controlled policy/network-trap regression and real source-job telemetry show zero cloud calls/OpenAI calls/Pro escalations. Pro selection remains explicit; existing busy/refund regression passed without silent Free fallback. |
| 29 | regression tests | 11 affected suites, backend build, frontend typecheck, real three-provider SDK flows, OAuth refresh/replay/revocation, import-scope denial, IDOR, audit/token storage, Inspector and desktop/375/390 browser checks passed locally. Open P0=0, P1=0. |
| 30 | production health | Existing production remains healthy; rollout is pending. A fresh production backup/config snapshot was restored in isolated PostgreSQL: 40 tables / 48,865 rows / 637 storage objects. No new database migration is required; existing 38 migrations remain. |
| 31 | commit/deployment | Local gate XEECLIP_MCP_MULTI_PLATFORM_IMPORT_RELEASE_READY. Commit/cutover pending. Backend-only deployment planned; public frontend bundle, AI service and database/Redis/MinIO services need no restart. |

## Evidence and limits

Local private evidence: ignored `.cache/source-import/qa`; release/backup operations: ignored `.cache/xeeclip-source-import-release`. Authorized media URLs, credentials and storage inventories are excluded from Git. [The implementation guide](xeeclip-complete-mcp.md#external-url-workflow) documents the exact tools, scope upgrade, retry and error behavior.

Existing P2 dependency-maintenance and static SPA unknown-route HTTP 200 issues remain documented in the previous release report. Unimplemented platforms and branded-client UI testing are stated limitations, not claimed passes. No new P3 polish work was added. IPv6-only destinations are conservatively rejected; access to a particular public post still depends on platform restrictions.

XEECLIP_MCP_MULTI_PLATFORM_IMPORT_NOT_DEPLOYED
