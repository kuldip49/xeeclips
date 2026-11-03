# XeeClip complete remote MCP

MCP version **1.0.0**. Endpoint: **https://api.xeeclip.me/mcp**. Implementation: `apps/backend/src/modules/mcp`. Deployment evidence belongs in [the release report](xeeclip-complete-mcp-release-report.md).

## Architecture

The official **@modelcontextprotocol/sdk 1.32.2** and **Zod 4.6.7** serve stateless Streamable HTTP with JSON responses. Each request receives a fresh SDK server and transport.

Assistant → HTTPS MCP → OAuth/scopes → account ownership context → existing Videos, Quick Reframe, Campaigns, EditMode and Render services → existing queues/storage/rendering.

The adapter imports no Prisma, storage client, filesystem, subprocess, FFmpeg or provider API. MCP database access is limited to OAuth, receipts, audit and health. Business services enforce ownership, credits, campaign rules, generation, canonical edits and exports. Even admin MCP users run with their own ownership context. There is no admin tool or second renderer/job/editor system.

Generation uses existing analyzed sources. A trusted internal mode override permits reusing source analysis; public clip-selection parsing cannot accept that override. Rendered clips persist their selected mode so History/editor retain the correct tier. Free prohibits cloud calls. Busy Pro never silently switches to Free.

Quick Reframe uses its existing ingest/prepare/analyze/style/result queue and reuses owned source transcripts and compatible prior region analysis. Its existing **180-second** limit remains. Ordinary source upload remains **3 hours / 4 GiB**. Large uploads stay in XeeClip; assistants select an existing source ID.

## OAuth and account integration

Discovery: `/.well-known/oauth-protected-resource/mcp` (with a root compatibility alias) and `/.well-known/oauth-authorization-server`. SDK endpoints: `/authorize`, `/token`, `/register`, `/revoke`.

Authorization-code flow requires S256 PKCE. Dynamic Client Registration supports public `none` and confidential `client_secret_post` clients. CIMD and machine-to-machine grants are not implemented; select automatic registration. Tokens have the exact MCP resource audience. Random 256-bit opaque access tokens expire after 15 minutes. Explicitly requested/approved **offline_access** issues rotating refresh tokens with a 30-day inactivity expiry. Consumed-refresh replay revokes the whole connection. Every request checks expiry, grant revocation and account status. Website cookies cannot authenticate MCP.

Only SHA-256 representations of access/refresh tokens, codes, pending handles and client secrets persist. The account-bound one-time consent nonce is derived from the high-entropy pending request; repeated loads do not invalidate another tab. Pending requests expire in five minutes; issued codes in two minutes. Tokens never appear in URLs, audit rows or logs.

The authenticated consent page is `/mcp/authorize`. Login/signup preserve only that validated return path. It shows the unverified client name, human permission labels, credit implications, Allow and Cancel. A nonce and the existing Origin guard protect decisions. Settings → Integrations → AI Assistants lists active connections, permissions, dates and immediate revocation. Revoking leaves the website login active.

## Scopes

| Scope | Permission |
|---|---|
| xeeclip:account:read | Account summary |
| xeeclip:credits:read | Canonical balance |
| xeeclip:sources:read | Owned sources |
| xeeclip:clips:read | Clips, jobs and project summaries |
| xeeclip:clips:create | Create Clips |
| xeeclip:clips:edit | Canonical edits, restore, Undo/Redo and save |
| xeeclip:clips:export | Start/read exports and download |
| xeeclip:reframe:create | Quick Reframe |
| xeeclip:campaigns:read | Campaigns, stored assets and compliance |
| xeeclip:campaigns:create | Create/understand/confirm/attach source |
| xeeclip:campaigns:generate | Generate campaign clips |
| xeeclip:history:read | Canonical History |
| offline_access | Refresh tokens; no additional business access |

Tools advertise OAuth scopes in top-level and `_meta.securitySchemes`. Insufficient permissions produce an MCP authentication challenge. Campaign job reads also require campaign read; importing campaign assets requires campaign read plus edit.

## Tool surface

All names have prefix **xeeclip_**. `tools/list` provides authoritative strict JSON schemas; extra properties are rejected.

| Area | Tools | Effects |
|---|---|---|
| Account | get_account, get_credits | Read |
| Sources | list_sources, get_source | Read, bounded pagination |
| Clips | create_clips, get_job, list_clips, get_clip | Create async; other tools read |
| Reframe | quick_reframe, get_reframe_result | Create async; result reads |
| Campaign reads | list_campaigns, get_campaign, get_campaign_clip_compliance | Read; no stored compliance/lifecycle refresh |
| Campaign setup | create_campaign, understand_campaign, confirm_campaign, attach_campaign_source | Existing workspace writes; confirmation requires explicit user approval |
| Campaign generation | generate_campaign_clips | Async, confirmed rules and canonical credits |
| Editor access | get_edit_project, restore_edit_project | Get read-only; explicit restore uses the canonical materializer |
| Frame | trim_video, set_crop, set_zoom, set_pan | Canonical commands |
| Text | update_headline, update_caption, set_caption_style | Canonical fit/timing/style validation |
| Audio | set_music, set_music_volume, set_source_volume | Canonical audio; 1 means 100% recorded volume |
| Images | add_image_overlay, add_logo, update_overlay, remove_overlay | Owned stored assets; reversible edits |
| Color | set_filter, set_visual_adjustments | Existing normalized controls/presets |
| Edit/history | undo, redo, save_edit, list_history | Shared website history; save adds no redundant revision |
| Export | export_clip, get_export | Canonical asynchronous renderer |

Every business write requires idempotencyKey. Existing-project edits/export require expectedRevision. Select an explicit video element on multi-cut projects. Crop uses normalized edge insets, scale is 0.1–4, and pan is bounded -1–1 then canonically clamped. Caption presets come from the actual canonical list. Text changes preserve manual provenance.

No destructive source/campaign/project deletion, arbitrary URL fetch, storage key, shell, SQL or file path is exposed. Music/images must already belong to the selected project or an owned campaign. Uploads stay in the website.

## Retry, jobs and credits

Keys are scoped to user + OAuth client + tool. Identical retries return the original receipt. Different inputs fail IDEMPOTENCY_CONFLICT. A unique receipt row prevents parallel admission. Meaningful generation/campaign/editor/Undo/Redo/export admissions commit minimal IDs/revisions inside the business transaction. Intermediate asset imports cannot complete the placement receipt prematurely; stored asset reuse avoids another import.

Pending duplicates return requestInProgress and a polling recommendation. Interrupted actions never automatically repeat a potentially charged operation; read current state before submitting a new intention/key. Receipts retain no duplicate editor/transcript state and persist so an old key cannot repeat a charge.

Generation/export return canonical references immediately. Poll get_job/get_reframe_result/get_export no faster than recommendedPollAfterMs (normally 5000). Historical source-job references return only canonically ready outputs and identify supersession. Existing reconciliation/recovery handles failures and refunds.

The existing ledger is authoritative. Create/campaign generation consume the normal generation charge; busy Pro without usable output refunds its reservation. Quick Reframe retains its existing export charge. MCP introduces no editing or ordinary editor-export charge.

## Secure results

Results include a website result/editor URL and an authenticated API download URL. Open resultUrl in a signed-in browser for normal download controls. Programmatic export downloads use `GET /mcp/exports/:projectId/:exportId/file`, an Authorization Bearer header and export scope. Project ownership and canonical EXPORT assets are checked before streaming. Range requests work. Query-string tokens are rejected; revocation blocks future downloads.

These are authenticated links, not transferable public signed links. No bucket, raw MinIO key or storage URL is returned. Never paste credentials into a URL.

## Limits, audit and errors

Redis limits apply per user and per user/client per minute: 180 reads, 40 writes, 6 generation admissions and 10 exports. Reconnecting cannot bypass the user limit. OAuth has separate edge-IP limits using the existing trusted Cloudflare header setting. MCP JSON is capped at 256 KiB, OAuth form at 8 KiB and registration JSON at 16 KiB. Compressed MCP/OAuth bodies are rejected.

McpAudit records user/client/connection, tool, safe entity/action IDs, timestamp, result and canonical credit-policy effect. Its source is the MCP audit table. No inputs, credentials or transcripts are stored. Audit retention is 30 days; expired auth/token metadata is cleaned in bounded batches. Receipts remain durable.

Structured events: mcp_connections, mcp_auth_success/failure, mcp_tool_calls/errors, mcp_rate_limits, mcp_create_jobs, mcp_editor_mutations, mcp_exports, mcp_xeepro_busy. `/mcp/health` reports version, transport and database/Redis readiness without secrets.

Stable errors include AUTH_REQUIRED, AUTH_EXPIRED, TOKEN_REVOKED, INSUFFICIENT_SCOPE, INSUFFICIENT_CREDITS, XEEPRO_BUSY, EDIT_CONFLICT, NOT_FOUND, FORBIDDEN, INVALID_INPUT, EDIT_VALIDATION_FAILED, EXPORT_FAILED, GENERATION_FAILED, JOB_FAILED, HEADLINE_DOES_NOT_FIT, AI_CONSENT_REQUIRED, UNSUPPORTED_SOURCE, UNSUPPORTED_OPERATION, IDEMPOTENCY_CONFLICT, OPERATION_INTERRUPTED and RATE_LIMITED. Async failures add friendly errors alongside status/reference data. OAuth uses standard HTTP challenges. MCP responses omit Prisma/FFmpeg/provider diagnostics and stack traces.

## Connect ChatGPT

The following UI steps follow [OpenAI's current connection guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt), checked 2026-11-03. Actual branded UI acceptance is not claimed; the OAuth automatic-registration method was tested with the official SDK/Inspector. Full write support currently requires an eligible Business/Enterprise/Edu workspace and creation/action permissions.

1. On ChatGPT web, open Plugins → + → Add custom MCP server.
2. Name it XeeClip; enter **https://api.xeeclip.me/mcp** under Connection.
3. Choose OAuth with automatic registration. Include **offline_access** when configuring requested scopes for continuing access.
4. Complete XeeClip login, review permissions and select Allow. Acknowledge ChatGPT's server notice, create the plugin and review discovered tools.
5. Install/select it in a chat, enable the intended actions, and try **“Show my XeeClip credits and source videos.”** Approve writes when prompted. Legacy workspaces may expose Apps → Create → Scan Tools instead.

No new OpenAI API key is required. XeeClip Settings → Integrations → AI Assistants → Revoke immediately removes access.

## Connect Claude

These UI steps follow [Claude's current remote connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), checked 2026-11-03. Branded Claude UI was not tested; automatic DCR/OAuth was verified with the compatible official SDK/Inspector.

1. Open Customize → Connectors → + Add → Add custom connector. Team/Enterprise owners configure the connector in Organization settings first.
2. Name it XeeClip and enter **https://api.xeeclip.me/mcp**. Continue through detected authentication.
3. Choose **Sign in now** and OAuth client **Register automatically**. XeeClip does not implement Claude's published-identity/CIMD option. Leave fixed credential headers empty.
4. Add/connect, sign in to XeeClip, review requested permissions and Allow.
5. Enable it from the chat's + → Connectors menu. Try **“Show my XeeClip credits and source videos.”**

Revoke in XeeClip Settings → Integrations → AI Assistants, or remove the client connection. Consent displays the requested permissions from the scope table above; offline access is optional.

## Example requests

- Show my credits/sources; create one XeeFree StyleOne clip; wait and show its saved result.
- Read this canonical project, keep my captions, crop/zoom, use the stored campaign logo/music, then export.
- Create a campaign from these rules, explain the brief and wait for my explicit confirmation before generating StyleTwo; show compliance.
- Change the headline, undo, redo, then export the latest revision.

After EDIT_CONFLICT, re-read the project. Busy Pro requires a new explicit user choice before switching to Free.

## Configuration and database release

MCP_PUBLIC_URL defaults to the production endpoint. FRONTEND_ORIGIN selects consent origin. MCP_ACCESS_TOKEN_TTL defaults to 900 seconds, MCP_REFRESH_TOKEN_TTL to 2592000. Optional MCP_ALLOWED_ORIGINS is an exact browser allowlist; defaults include ChatGPT, Claude and the frontend. Four MCP_RATE_LIMIT_* overrides are bounded integers. No new signing/provider key is required. Production requires HTTPS; development allows loopback HTTP.

Migration `20261102000000_xeeclip_mcp` creates six metadata tables with indexes/FKs: McpClient, McpAuthorization, McpGrant, McpToken, McpAction and McpAudit. It has no destructive statements or changes to existing business columns. User relation additions are Prisma-only. Review exact SQL before applying. A restored production-like rehearsal preserved all 34 original table fingerprints / 48,859 rows and added six empty tables.

Deploy with a fresh restored/verified backup, maintenance, idle checks, the additive migration, backend/static frontend, disposable acceptance, cleanup and fingerprint verification. Keep AI/dependency containers unchanged. Rollback restores the previous backend image and Cloudflare frontend version; leave additive tables unused. Do not reset or destructively restore production as routine rollback.

## Reproduce acceptance

`npm --workspace apps/backend run test:mcp` builds and runs schema, scope, idempotency, crash-receipt and cached-export ownership tests. Existing regression suites cover generation/styles, Free policy, Pro busy, upload duration, Reframe, editor/render/export and rematerialization.

`apps/backend/scripts/mcp-acceptance-client.cjs` defaults to localhost:4400 and saves private state under ignored .cache/mcp. verify-mcp-media, campaign, ownership, editor-assets, browser, site-regression and pro exercise actual HTTP/SDK/media/browser flows. Owned source/logo/music fixtures stay outside Git; configure MCP_QA_SOURCE_PATH and MCP_QA_FIXTURES. Browser origin uses MCP_QA_ORIGIN. Production requires the explicit canonical HTTPS target, MCP_PRODUCTION_QA=1 and a separate ignored MCP_QA_DIR. Mocked Pro verification is local-only.

Inspector **2.13.0** passed strict tools/list and authenticated account/credits calls. Supply credentials with a private read-only config, never CLI token arguments. References: [Inspector](https://github.com/modelcontextprotocol/inspector), [SDK server](https://ts.sdk.modelcontextprotocol.io/server), [SDK client](https://ts.sdk.modelcontextprotocol.io/client). Never commit cookies/tokens, uploads, provider state, private configs or backups.

## Non-blocking dependency follow-ups

Next.js is patched to 15.5.28 and body-parser to 2.4.0. Public frontend is a static Cloudflare deployment without Next image optimization or Server Actions. The old loopback-only frontend mirror is not the public site. The Multer advisory requires a pending asynchronous fileFilter; this app supplies none. Remaining MinIO query-decoder/stream-parser advisories concern trusted storage responses; MCP accepts no URLs or raw storage references. Build-only selector parsing and unused URI normalization paths need separate dependency maintenance. These are documented P2 follow-ups; npm audit is not empty. No framework/storage major migration is included.
