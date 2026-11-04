# MCP server-side editor correction

MCP 1.2.1 preserves 50 tools and 15 scopes. No new permission, database migration, frontend deployment or AI-service change is required.

## Root cause, established before the fix

The MCP editor dispatcher already authenticates the OAuth bearer, resolves the account into server-side request context, checks scopes/ownership and calls canonical domain services. It does not call a React route, inspect a DOM, use local storage, require a cookie or redirect editing to login. In the connected OpenAI-host plugin, `get_edit_project` and `save_edit` succeeded on an existing owned project without a browser; save did not create a revision or change its content.

The reproducible integration gaps were in capability coverage and guidance: the project summary exposed only one text layer and omitted text/caption geometry; overlay update/removal accepted IMAGE only, so an assistant could not select/remove the extra TEXT title or duplicate SUBTITLE layers or position the headline. Export results also mixed bearer-download instructions with a signed-in-browser suggestion. The reported login sentence is assistant fallback behavior, not a backend editor authentication requirement; its exact preceding model reasoning was not available. The fix removes that ambiguity and supplies the missing bounded canonical layer operations.

## Change

- Project summaries identify server-side OAuth editing, optional-human-UI links, normalized canvas coordinates, all bounded text layers, caption IDs/tracks/boxes/visibility and resolved text styles. Review-only permission still cannot read this data.
- `update_headline` keeps its existing required arguments and accepts an optional normalized box, color, size, alignment, stroke, shadow and background. All changes translate to existing canonical commands; fit validation remains authoritative.
- `update_overlay` now moves/resizes/sets opacity on explicitly selected TEXT, SUBTITLE and IMAGE layers. `remove_overlay` accepts either one ID or up to 200 explicit unique IDs and removes only those layer types. The complete batch validates before mutation and commits as one reversible canonical bundle; VIDEO/audio/source pixels are excluded.
- The canonical ASS renderer now honors explicitly disabled stroke with zero outline. Legacy unstyled text keeps its previous fallback outline. This closes the observed black-outline mismatch when putting black text inside a white bar; renderer/text regression tests cover both paths.
- Every edit/export tool and server instructions explicitly direct assistants to execute OAuth tools, not open website links as a prerequisite. Missing scopes, stale revisions and unsupported edits remain structured errors. HTTP OAuth failures retain standard challenges plus stable AUTH_EXPIRED/TOKEN_REVOKED/AUTH_REQUIRED codes. Commands already autosave; `save_edit` verifies the current revision without inventing another save/revision.
- Reuse `EditModeService` get/trim/applyAssistantBundle/undo/redo and `EditModeRenderService` export/progress/download. No parallel editor implementation or database write path is introduced for MCP mutations.

## Acceptance and final report

| # | Item | Evidence |
|---|---|---|
|1|Root cause|Capability omissions and browser-oriented guidance; connected OAuth read/save already succeeded before changes|
|2|Browser dependency found|No server edit dependency found; optional website URLs and ambiguous export guidance were present|
|3|Server-side edit auth|MCP OAuth bearer only; scopes and per-user canonical ownership context preserved; no cookie fallback|
|4|Canonical editor service|Existing EditModeService commands/bundles, optimistic revision and history; existing render/export service|
|5|Headline edit|Exact `Before You Trade, Mark This` placed inside fixture white bar with readable black text|
|6|Caption edit|Selected bottom duplicate cue IDs removed; original speaker cue and embedded source caption remain|
|7|Overlay/title removal|Only the identified extra TEXT title and duplicate SUBTITLE layers removed; source video state unchanged|
|8|Revision handling|One batch → one revision/undo step; exact retry stable; undo/redo/save and stale EDIT_CONFLICT verified|
|9|Export|Canonical async export and range download using Bearer only; actual rendered re-review after export|
|10|Ownership|Foreign project/export denied; review-only token denied edit; expired/revoked tokens return correct codes|
|11|OpenAI/ChatGPT result|Connected OpenAI-host XeeClip plugin read/save succeeded without browser. Official MCP SDK performs the full correction with bearer-only requests. Separate ChatGPT branded UI is not available in this desktop session; no unrun UI/model result is claimed|
|12|Claude result|Claude-compatible Streamable HTTP SDK client exercised ownership rejection; the same standard protocol supports direct editor mutations. Separate Claude branded UI is not available|
|13|Commit/deploy|Deployed `b053d227811f090327b91e2861bdc794bca5359d`, MCP 1.2.1; production A–G and exact rendered correction passed; maintenance OFF|

Local acceptance uses a disposable synthetic 8-second video, a white bar, two editable title layers, one original speaker caption, two duplicate bottom caption cues and a baked original caption. Fixture setup uses authenticated canonical website setup APIs; all actual MCP review/edit/save/undo/redo/export requests use Authorization Bearer only, without Cookie headers or frontend access. A–G cover owned edit, insufficient scope, foreign project, expired token, revoked token, stale revision and valid export. Review → explicit disposable human approval → actual frames/audio → edit → export → approved re-review also passes. The source VIDEO state and credits are unchanged. Existing customer clip content was not changed to demonstrate a fix.

Focused validation: backend build; MCP contract/idempotency/strict schema suite; targeted server-editor tests; canonical text/caption suite (117 checks); canonical render planning suite; real isolated OAuth/DB/renderer acceptance. The same matrix and exact rendered correction passed in production, followed by complete disposable cleanup and maintenance off.

Hosts caching old tool schemas should refresh their MCP tool catalog or open a fresh connection/chat. Existing edit/export OAuth scopes remain sufficient; review consent remains separate and never implies edit access. If an operation is unsupported, report its structured error rather than requesting website editor sign-in. Embedded source text cannot be erased by removing editable layers.

## Final production evidence

- Application commit `b053d227811f090327b91e2861bdc794bca5359d` pushed normally via feature branch and main; backend image `sha256:406e7c36d8b42bc68b4fd041c0fc97133f05403a4fa7c2be2eaf4b83f1873713`, version 1.2.1. Endpoint remains `https://api.xeeclip.me/mcp`; existing edit/export scopes remain sufficient.
- Production used 38 MCP requests with bearer-only authentication, no Cookie header or frontend request. Exact white-bar headline correction, selected extra title/bottom caption removal, preserved original speaker/baked caption, canonical website-visible state, undo/redo, stable save/retry, export/range download and actual rendered re-review all passed. Returned production before/after frames were visually inspected; the headline is legible inside the bar.
- Every A–G case passed: valid owned edit; review-only/no-edit scope denied; foreign project denied; expired token → AUTH_EXPIRED; revoked token → TOKEN_REVOKED; stale revision → EDIT_CONFLICT; successful export/download without browser login. Credits unchanged.
- Post-deployment the existing connected OpenAI-host XeeClip plugin independently read the customer's canonical project and verified its saved revision successfully. It returned MCP_OAUTH_BEARER / SERVER_SIDE_CANONICAL_EDITOR and optional-human-UI link metadata. No browser was opened, and the existing revision/content were unchanged. This is connected-plugin verification in Codex, not a claim of a separately run ChatGPT or Claude branded UI session.
- No new migration: all 39 existing migrations remain finished. Fresh database backup fully restored in network-isolated PostgreSQL. All 44 original table fingerprints, account settings and 669 original storage objects were preserved at cleanup. Two disposable users, their clients, projects, review grants and media were removed; no active jobs/reservations remain.
- Backup: `C:\projects\ai-content-platform\storage\xeeclip-mcp-server-edit-20261105\production-1793817542363.dump`, 33,842,589 bytes, SHA-256 `a3fa93533dc16b8c615a250de04027ccad56c963e77fc35b2dbc4e9f6fae08a6`. Verified original storage inventory SHA-256 `818d4e5535e5af667fdd1584e0500a8afe8daef6c60884759ab69890e6a801b8`. Private acceptance/config evidence remains under ignored `.cache/mcp-server-edit-release/`.
- Final health at 2026-11-04 18:45:49 UTC (2026-11-05 local): site/API/MCP/database/Redis/MinIO healthy, maintenance OFF, queues idle, exact tunnel configuration restored. Frontend version `47d75bdd-a40a-45bf-a671-97ae67ff3ed1` and the AI/PostgreSQL/Redis/MinIO/local-frontend container identities/images were unchanged. Prior backend image retained as `xeeclip-backend-rollback:before-xeeclip-server-edit`; no rollback was needed.

Final status: **XEECLIP_MCP_SERVER_SIDE_EDIT_DEPLOYED_AND_HEALTHY**
