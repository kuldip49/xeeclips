# XeeClip complete MCP release report

Released 2026-11-03. **XEECLIP_COMPLETE_MCP_DEPLOYED_AND_HEALTHY**. Local gate **XEECLIP_COMPLETE_MCP_RELEASE_READY**, all production acceptance gates passed, maintenance removed. Open release blockers: **P0 0 / P1 0**.

| # | Item | Result |
|---|---|---|
| 1 | final architecture | Thin MCP adapter over existing Videos, Quick Reframe, Campaigns, canonical EditMode, credits and render queues; no second editor, renderer or business database layer. |
| 2 | MCP server location | apps/backend/src/modules/mcp in the existing Nest backend; 42 strictly validated tools. |
| 3 | SDK/version | Official @modelcontextprotocol/sdk 1.32.2, Zod 4.6.7; official Inspector 2.13.0; server version 1.0.0. |
| 4 | transport | Stateless Streamable HTTP / JSON over verified HTTPS. Per-request SDK server/transport; no cross-user session state. |
| 5 | production MCP URL | [https://api.xeeclip.me/mcp](https://api.xeeclip.me/mcp). Public discovery and unauthenticated Bearer challenge passed after maintenance was removed. |
| 6 | OAuth implementation | Authorization code + S256 PKCE + automatic Dynamic Client Registration, exact MCP audience, public none/confidential client_secret_post. Invalid verifier, redirect, replay and audience checks passed. |
| 7 | scopes | 12 business scopes plus explicitly consented offline_access; required scopes advertised on tools and checked on every call. Read-only and wrong-scope denial passed. |
| 8 | consent UI | Production login return path, Allow/Cancel, client name, human permission labels and account-bound single-use nonce passed at 1440, 375 and 390px. Credits implications are displayed. |
| 9 | token security | Random opaque access tokens (15 minutes); explicit offline access enables rotating refresh tokens (30-day inactivity). Hash-only credentials verified in production, including client secrets. Refresh replay revokes the family. |
| 10 | revocation | Production Settings revocation and token revocation passed. Future tool calls, export downloads and refresh fail immediately; the existing website login remains usable. |
| 11 | rate limits | Redis per-user and per-user/client budgets: 180 reads, 40 writes, 6 generations and 10 exports per minute; bounded local load accepted 600 reads across permitted identities then returned RATE_LIMITED. OAuth edge-IP budgets also apply. |
| 12 | idempotency | Unique user/client/tool/key plus input hash, minimal canonical transaction receipts and durable results. Exact retries, conflicting input, parallel admission and crash receipt tests passed; no duplicate production reservation. |
| 13 | audit system | Safe MCP metadata only, with bounded cleanup and 30-day audit retention. Production audit inspection checked 286 events without credentials, transcripts, raw storage keys or diagnostic traces. |
| 14 | account tool | Official SDK and Inspector account/credits calls passed against real HTTPS production with user-bound data. |
| 15 | credits | Canonical ledger and ownership guards retained. Production successful charges and one Pro refund matched the balance exactly; no outstanding disposable reservation. |
| 16 | sources | Owned source list/get, bounded pagination and source-backed operations passed. Ordinary upload retains the three-hour / 4 GiB cap; duration boundary regression tests passed. This release did not perform a complete three-hour media render. |
| 17 | Create Clips | Production SDK generated real clips for all three styles, read asynchronous progress and retrieved saved canonical results. Existing website Create passed desktop/mobile smoke. |
| 18 | XeeFree | Zero-cloud policy traps passed locally, including reuse of a Pro-analyzed source. Production Free job telemetry recorded zero cloud calls, zero OpenAI calls and zero Pro escalations across its generation requests. |
| 19 | XeePro | Mocked success and busy/refund passed locally. Exactly one bounded real production attempt met upstream quota failure, returned XEEPRO_BUSY, produced no output and refunded one credit; zero net charge and no silent Free fallback. No second production attempt was made. |
| 20 | StyleZero | Real production MCP generation, result retrieval and explicit canonical editor restoration passed. |
| 21 | StyleOne | Real production generation, canonical text/frame/audio edits, MP4 export and website-visible changes passed. |
| 22 | StyleTwo | Real production MCP generation passed; affected StyleTwo/Reframe regression suites remained green. |
| 23 | Quick Reframe | Real production source-backed StyleOne Result, saved canonical project and export passed. Local cached StyleZero reuse and source transcript/region-analysis reuse passed. Existing Quick Reframe retains its 180-second limit and explicit Edit flow. |
| 24 | campaigns | Production create → understand rules → explicit confirmation → source attachment → Free StyleOne generation → compliance → canonical edits/export → Ready to Post → manual Posted → metrics/earnings passed. |
| 25 | campaign assets | Production owned stored logo/music imported through canonical asset handling; image/logo add/update/remove and music replacement passed. Cross-user asset use denied without partial imports. |
| 26 | compliance | Production rule evaluation returned PASS/WARN as appropriate; current export reached Ready to Post. Reads do not mutate campaign lifecycle. Unverifiable requirements remain subject to human review. |
| 27 | canonical EditProject integration | MCP edits appeared in the same production website project. Existing editor commands, persistence, asset ownership, revisions and renderer are reused. |
| 28 | trim | Canonical source trim passed with existing validation and persisted timing. |
| 29 | crop | Validated normalized crop edge insets passed; no separate MCP crop implementation. |
| 30 | zoom/pan | Canonical zoom and pan commands passed with normal bounds/clamping. |
| 31 | headline | Fit-validated text update passed and appeared in production website preview. |
| 32 | captions | Canonical subtitle text/timing and actual preset selection passed; manual provenance retained. |
| 33 | music | Owned stored campaign music import, replacement and canonical export passed. |
| 34 | volume | Source/music volume commands passed; recorded 1 means 100%, preserving existing control semantics. |
| 35 | overlays/logos | Owned logo/image add, update and remove passed, including exact idempotent retry. |
| 36 | filters/adjustments | Existing filter presets and normalized visual adjustments passed. |
| 37 | undo/redo | MCP Undo/Redo passed. Live website Undo followed by MCP Redo incremented the same revision history and restored shared state. |
| 38 | edit concurrency | Stale expectedRevision was rejected without overwriting the current website/MCP edits. Export admission uses the canonical atomic revision/status guard. |
| 39 | export | Real canonical production MP4 with audio/video was downloaded and probed. Authenticated range streaming, exact export retry, QR one-time charge and cross-user export denial passed. |
| 40 | History | Shared website History passed at all three widths; MCP lists and stable historical job references passed, without read-triggered rematerialization. |
| 41 | signed download/result URLs | Secure result/editor URLs plus ownership-protected API downloads. Downloads require an Authorization Bearer token; website result pages require login. No public transferable signed URL or raw storage key is exposed. |
| 42 | credit behavior | Five disposable production reservations consumed, one refunded, none outstanding; balances A=0 and B=5 before cleanup. No second MCP billing path or edit/export surcharge was introduced. |
| 43 | IDOR/security | Production source/clip/job/editor/campaign/asset/compliance/Reframe/export ownership probes passed; admin endpoints and credit mutation denied. Cached export progress now checks ownership before returning shared progress. |
| 44 | SSRF | No tool accepts arbitrary fetch URLs, shell/SQL, local paths or raw storage references. Owned IDs and validated OAuth callback policy are enforced. |
| 45 | migrations | Reviewed additive 20261102000000_xeeclip_mcp applied: six new metadata tables, no existing business-column changes. All 38 migration records finished with no rollback. Backup restore and additive rehearsal preserved every original row fingerprint. |
| 46 | ChatGPT compatibility result | Official SDK/Inspector verified discovery, OAuth, offline refresh, strict tools, generation, editing and export. Branded ChatGPT UI was not tested. Use the current custom MCP plugin workflow and OAuth automatic registration; workspace write permissions apply. |
| 47 | Claude compatibility result | Compatible official remote SDK/Inspector workflow passed end to end. Branded Claude UI was not tested. Select Register automatically, because published-identity/CIMD is not implemented. |
| 48 | desktop Settings integration | Live production Integrations list, consent/callback/token exchange and revocation passed at 1440px; mobile counterparts passed at 375/390px. |
| 49 | existing website regression | 28 affected local suites plus five final targeted suites passed, followed by the polling hotfix tests. Production Create, Reframe, Clippers, campaign, editor, History and Settings passed at 1440/375/390px without horizontal overflow; critical editor export control remained accessible. |
| 50 | production test | All disposable production gates passed. A P1 mixed-snapshot polling race found during the one Pro attempt was fixed in 396103d, regression-tested, redeployed backend-only and verified using the existing job. Site/API/MCP/database/Redis/MinIO/AI/tunnel were healthy after reopening. |
| 51 | data preservation | All 34 original tables / 48,859 original rows and 637 original storage objects matched the pre-release fingerprints after disposable cleanup. Production environment and persistent mounts retained; AI/Postgres/Redis/MinIO/loopback frontend container identities unchanged. |
| 52 | cleanup | Both disposable users, media, campaigns, assets, exports, sessions, ledgers and OAuth metadata removed through guarded owned cleanup. All six new MCP tables were empty afterward; no original data was deleted. |
| 53 | maintenance | Processing maintenance is OFF. Original API tunnel configuration restored byte for byte; release gate stopped. Final public health verified at 2026-11-03T01:36:12.916Z. |
| 54 | rollback status | Rollback not performed. Original backend image/config, database backup and previous Cloudflare version retained. Prepared guarded rollback starts the pinned prior application directly and retains unused additive tables; no destructive database reset. |
| 55 | known limitations | Open P0=0, P1=0. P2 dependency maintenance and existing static SPA unknown-path HTTP 200 remain documented below. Branded assistant UI acceptance remains unperformed; uploads stay on the website and secure downloads need credentials. No new P3 polish work included. |
| 56 | commit hash | Runtime release 396103d7da5622be59f46a5000a9ad1e86d11a05; integration a96d22c; migration whitespace correction f0e8b66. Normal fast-forward/main pushes only; original dirty Clipper checkout preserved. This report is committed separately after deployment. |
| 57 | deployed version | MCP 1.0.0; backend xeeclip-backend:complete-mcp-396103d, image sha256:85de633faa73075ddfe38b00700aa6c0682d59aa2ed87468f5487fd3d9672d8e; public Cloudflare frontend c8ec9555-08e5-450a-b1d5-cf441021f951 built from f0e8b66. The hotfix changed no frontend runtime and required no further frontend deployment. |

## Backup and rollback

- Verified pre-migration dump: `C:\projects\ai-content-platform\storage\xeeclip-complete-mcp-20261103\production-1793667161539.dump` (31,491,523 bytes), created 2026-11-03T00:53:07.261Z.
- SHA-256: `198efe28a3abd07061635aefaf468d9d5146c9bf2c273fec15966bcd49ad0ce7`. Restored into isolated PostgreSQL; additive migration rehearsed and all 34 original fingerprints retained. Config/container/tunnel snapshots are private in the same durable backup directory.
- Retained rollback backend: `xeeclip-backend-rollback:before-xeeclip-complete-mcp` (image `sha256:3d73092e1cfd270b8dceb1bbcb8ab47fa80bd23b1494979f881ad8a06418ccae`). Previous frontend: `1aeec32c-fe78-442e-a2ba-070b37c6e289`.
- Operational helpers/evidence: ignored `.cache/xeeclip-complete-mcp-release`. Re-enable the guarded maintenance gate, wait for idle, then use the prepared `rollback.cjs --apply` only if rollback is needed. It leaves the additive tables in place and bypasses the older migration CLI. Verify original configuration, public health, data fingerprints and then remove maintenance. No rollback has been executed.

## Evidence and release fixes

Local evidence is under ignored `.cache/mcp`; production evidence is under ignored `.cache/xeeclip-complete-mcp-release/production-qa`. Private cookies, tokens, passwords, storage inventories and backups are excluded from Git. Safe operational summaries are retained beside the durable backup.

The production-compatible official SDK authenticated two disposable users, discovered all 42 tools, generated real media, retrieved results, edited the same canonical projects shown by the website, exported real MP4s and downloaded securely. Official Inspector tool listing/account/credits checks passed. Actual branded ChatGPT and Claude account UIs were not exercised; this is explicitly a compatible-client acceptance result.

The Pro polling race combined a newly terminal result with an older error-code read. The fix classifies status/error using the same canonical result snapshot. Regression coverage checks transitions to busy and away from an older busy code. Backend build, MCP contract, Pro busy/refund, clip selection and the Linux image contract passed; the existing production Pro job was re-read after deployment. The successful refund was never reissued, and no new provider attempt was made.

Other release-blocking fixes included canonical export-cache ownership checks, route-specific body parsers that preserve normal Nest JSON parsing, token/client-secret handling, durable mutation receipts and explicit stored-asset ownership. Error probes covered invalid upload, malformed OAuth input, insufficient credits, export validation, stale revisions and busy generation without exposing raw diagnostics.

Performance acceptance found no duplicate admissions/reservations, outstanding QA credits or stuck work at cleanup. Existing bounded queries/queues remain in use, cached transcript/region-analysis reuse passed locally, and retries are bounded. These are sanity and targeted acceptance checks, not an unbounded load benchmark or a guarantee that all possible inputs are failure-free.

## Connect an assistant

Use **https://api.xeeclip.me/mcp**, OAuth and automatic registration. [The connection guide](xeeclip-complete-mcp.md#connect-chatgpt) contains the current ChatGPT plugin steps; [Claude steps](xeeclip-complete-mcp.md#connect-claude) specify Register automatically. The authentication method, permissions and endpoints were tested with the official SDK/Inspector; branded UI steps follow the linked official vendor documentation checked 2026-11-03.

XeeClip consent identifies the requesting client and shows requested account/credits/sources/clips, generation/edit/export, Reframe, campaign and History permissions. Continuing access appears only if offline_access was requested. Approve only the permissions you intend. Revoke at **XeeClip Settings → Integrations → AI Assistants → Revoke**; website login remains active. A first read-only command is: **“Show my XeeClip credits and available source videos.”** Then select a source and explicitly request, for example, **“Create one StyleOne clip using XeeFree.”** Campaign generation requires reviewing and confirming the brief.

## P2/P3 and compatibility limits for the next release

- P2: existing static SPA fallback returns HTTP 200 for an unknown path while showing a not-found view. Preserve working deep links when addressing hosting status behavior.
- P2: finish the documented dependency maintenance for trusted storage parsing/build-time or unused parsing paths. Next.js/body-parser patches are included; npm audit is not empty. The assessed exposure and upgrade scope are in the implementation guide.
- Compatibility: branded ChatGPT/Claude UI verification remains outside this acceptance evidence. Client/workspace permissions can restrict write tools. No CIMD, machine-to-machine grant or MCP upload endpoint is supplied.
- Existing V1 behavior: campaign posting is manually recorded; metrics/earnings are user-entered. Unverifiable requirements need human review. Downloads require Bearer authentication or a signed-in website result page.
- P3: no additional polish changes made. Previously documented native video/screenshot rasterization residuals are not claimed to be pixel-identical.

XEECLIP_COMPLETE_MCP_DEPLOYED_AND_HEALTHY
