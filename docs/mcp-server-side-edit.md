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
|13|Commit/deploy|Pending final gated production acceptance; release version 1.2.1|

Local acceptance uses a disposable synthetic 8-second video, a white bar, two editable title layers, one original speaker caption, two duplicate bottom caption cues and a baked original caption. Fixture setup uses authenticated canonical website setup APIs; all actual MCP review/edit/save/undo/redo/export requests use Authorization Bearer only, without Cookie headers or frontend access. A–G cover owned edit, insufficient scope, foreign project, expired token, revoked token, stale revision and valid export. Review → explicit disposable human approval → actual frames/audio → edit → export → approved re-review also passes. The source VIDEO state and credits are unchanged. Existing customer clip content was not changed to demonstrate a fix.

Focused validation: backend build; MCP contract/idempotency/strict schema suite; targeted server-editor tests; canonical text/caption suite (117 checks); canonical render planning suite; real isolated OAuth/DB/renderer acceptance. Production evidence is appended after restored backup, minimal backend cutover, the same disposable matrix, cleanup and maintenance off.

Hosts caching old tool schemas should refresh their MCP tool catalog or open a fresh connection/chat. Existing edit/export OAuth scopes remain sufficient; review consent remains separate and never implies edit access. If an operation is unsupported, report its structured error rather than requesting website editor sign-in. Embedded source text cannot be erased by removing editable layers.
