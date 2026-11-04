# Full canonical MCP editor control — release report

MCP **1.3.0**, **60 tools**, **76 typed editor actions**. Endpoint remains `https://api.xeeclip.me/mcp`. This upgrade uses the website's existing EditProject, commands, history, style compiler and renderer. No database migration or new OAuth scope is needed. No account setting or review approval is enabled for an existing user.

Production status: **XEECLIP_MCP_FULL_EDITOR_CONTROL_DEPLOYED_AND_HEALTHY**. Completed 2026-11-04T20:32:44.660Z. Release commit **21d4c14483e7543d90f373d96b1063029ed73fb6**, pushed normally to main. Disposable production QA and cleanup passed; maintenance is off.

| # | Requirement | Implementation / evidence |
|---|---|---|
| 1 | Human editor map | [86 audited rows](mcp-full-editor-capability-map.md), including all 71 inspector actions and timeline/template/history/export/review services. |
| 2 | MCP map | Complete strict command union plus the named reads/template/group/preset/source tools; existing 50 tools retained. |
| 3 | Missing controls found | Added text/caption creation, all typography, caption timing/groups, layers, fades/ducking, full visual adjustments, zoom events, template switching and layout inspection. |
| 4 | Tools | Ten new tools: get_editor_capabilities, list_edit_elements, get_edit_layout, preview_element_placement, apply_edit_commands, remove_caption_group, change_template, apply_editor_preset, adjust_source_range, check_edit_requirements. All names have the xeeclip_ prefix. |
| 5 | Element model | Safe typed roles, text, geometry, timing, layer, opacity, visibility/lock, audio/transforms, asset ID and template relationship; paginated, with explicit caption-group IDs. No storage keys. |
| 6 | Hook | Content replacement preserves exact geometry/timing/layer/style; canonical fit refuses overflow. Named placement returns the template hook region. |
| 7 | Text | Add, content/runs, fonts, size/weight/colors, stroke/shadow/background, alignment/spacing/case, geometry, timing, opacity, layer, duplicate/remove. |
| 8 | Captions | Correct wording, cue timing, split/merge, add missing cue, visibility, selective group removal, primary preservation. Burned-in source pixels are not editor layers. |
| 9 | Caption templates | Existing caption presets and active-word styling; highlights require actual cached word timings. |
| 10 | Style switching | StyleZero/One/Two through the existing style resolver/compiler; owned/builtin saved templates through the existing service. Existing wording/timing/cuts/crop/pan/zoom/music/logo survive. Default text size may decrease to fit. |
| 11 | Framing | Existing reframe policies and FIT/FILL/FREE/ASPECT commands, with canonical scope validation. |
| 12 | Crop | Per-segment/whole-video canonical validated crop; also supported image transforms. |
| 13 | Zoom/pan | Manual transform plus canonical timed zoom events, strength and source-speed controls. |
| 14 | Logo/overlays | Authorized editor assets; existing campaign-asset tools retain campaign ownership checks. Move/resize/crop/rotation/flip/opacity/layer/timing/remove. |
| 15 | Audio | Music replacement/removal, gain, mute, trim/fades, ducking; source gain. One equals recorded 100%, with no hidden gain. |
| 16 | Visual controls | All 11 canonical adjustments and the ten existing filters; renderer planning regressions pass. |
| 17 | Add | Canonical text roles, captions, logo/image/audio/zoom; template defaults and shared text measurement. |
| 18 | Remove | Explicit IDs/group; canonical same-history undo. No project/account deletion tool is added. |
| 19 | Placement | Deterministic named resolver regions, safe margins, exact geometry reuse and timed conflicts; no random coordinates. Face envelope is advisory, not measured face detection. |
| 20 | Defaults | Existing preset/component styles. Actual frame review caught and fixed a black-on-black StyleTwo CTA; its regression assertion now passes. |
| 21 | Revision | Every public write requires expectedRevision and idempotencyKey; atomic receipts, stale conflicts and protected-batch rollback are tested. |
| 22 | Undo/Redo | Same canonical history as the website; website Undo/MCP Redo and MCP Undo/Redo pass. |
| 23 | Campaign | Same project/assets, independent scopes; owned campaign generation and branded editor exercised. |
| 24 | Compliance | Immediate revision-aware recomputation after MCP edits/undo; required-logo removal records FAIL and undo restores PASS/WARN. No regeneration/extra charge. |
| 25 | Actual review | Explicit disposable human consent; native sampled rendered JPEG frames and WAV audio before/after, not transcript-only review. |
| 26 | Bounded loop | Existing specific-client grant, fifteen-minute expiry, max three render versions only with approved revision access; review-only cannot edit/export/read account. |
| 27 | Parity | One canonical renderer/export; native frame inspection verified headline and late CTA placement. Existing renderer approximation notes still apply. |
| 28 | No browser auth | New full-control SDK acceptance records zero Cookie headers on MCP requests; only fixture setup and explicit human-consent endpoints use disposable website sessions. |
| 29 | Security | Cross-user project/asset/saved-template denial; review/edit/export/account scopes independent; no raw settings/DB/CSS/URLs; malformed schemas, conflicts and denial-preservation tested. |
| 30 | OpenAI/ChatGPT | Independent OpenAI-compatible MCP SDK scenario passes review→edits→three styles→CTA→export→review. Branded ChatGPT browser UI is not available in this environment; no claim that it was exercised. |
| 31 | Claude | Independent Claude-compatible MCP SDK session passes complex editing, template hook placement, audio/filter/zoom, undo/redo and rendered re-review. Branded Claude UI was not available. |
| 32 | Discovery | Official MCP Inspector 2.13.0 discovers all 60 tools and the complete typed batch schema; production discovery passed with all 60 tools. |
| 33 | Regression | 30 broad suites, 17 Clipper suites, review/sanitization, campaign suites, real Free all-three-style generation, Quick Reframe result, mocked Pro success/busy refund. Desktop/375/390 seven-route browser smoke and website/MCP history parity pass locally and in production. Production also passed all three Free styles, Quick Reframe export/charging, campaign generation and edit compliance, ownership/admin/credit checks, plus one bounded real Pro attempt. |
| 34 | Commit/deployed version | MCP 1.3.0; release commit 21d4c14483e7543d90f373d96b1063029ed73fb6; immutable image sha256:2f1b9690568f03d71927a2d2f16431026ee85cdb4ef44d184b6d61bba3da7467. Backend only; frontend unchanged. |

## Acceptance artifacts

Tracked repeatable checks: `apps/backend/scripts/test-mcp-full-editor.cjs`, `verify-mcp-full-editor.cjs`, `verify-mcp-full-editor-security.cjs`, `verify-mcp-full-editor-campaign.cjs`, plus the existing MCP/editor/campaign suites. Private runtime artifacts stay in ignored `.cache/mcp-full-editor-release`; credentials, cookies, review media and storage inventories are not committed.

## Limits and v1.1 notes

There are no new transitions, arbitrary keyframe animation, CSS, renderer internals or unowned media imports. Structural caption groups do not certify duplicates. Metadata requirement checks return WARN for visual/audio judgments and never claim the whole video was watched. Review evidence covers only sampled time ranges. Existing renderer notes include rounded ASS plate and font-weight approximations; the upgrade preserves those existing semantics.

A client that caches an older tool catalog needs a new connection/chat catalog refresh to discover the new tools; the URL and plugin/App identity remain unchanged. No unrelated services or frontend need deployment for these backend/domain changes.

## Release and rollback

Release is gated on a fresh database/config backup, isolated restore with all-table fingerprints, production idle/maintenance, immutable backend-only deployment, disposable production acceptance, exact cleanup, original database/MinIO preservation and maintenance off. Existing AI/database/Redis/MinIO/frontend containers must remain unchanged. The previous backend image is retained for immediate rollback; no destructive schema action is permitted.

## Final production record

- Release commit: `21d4c14483e7543d90f373d96b1063029ed73fb6`. Backend image: `sha256:2f1b9690568f03d71927a2d2f16431026ee85cdb4ef44d184b6d61bba3da7467` (`xeeclip-backend:full-editor-21d4c14`).
- Database: no new migration; all 39 existing migrations complete. No reset or destructive schema operation.
- Backup: `C:/projects/ai-content-platform/storage/xeeclip-mcp-full-editor-20261105/production-1793822621879.dump`, 33,842,978 bytes, SHA-256 `acb637b5d9a2a97a784df3c91b0ba146d987def1cd9b26fef83852df39ccf53e`. Independent PostgreSQL restore matched all 44 business-table fingerprints before release. Configuration and tunnel snapshots retained with the backup.
- Production: full editor scenarios through independent OpenAI/Claude-compatible MCP sessions passed; actual rendered JPEG/WAV evidence before and after; official Inspector 2.13.0 discovered 60 tools. New full-editor MCP traffic sent zero browser cookies (98 Bearer requests).
- Real Pro: one attempt, XEEPRO_BUSY, credit delta 0; no silent Free fallback or provider configuration change. Mocked success/busy/refund and zero-cloud Free checks also passed locally.
- Preservation: all original business data/review settings and MinIO objects verified after exact disposable cleanup. Any ordinary expired OAuth retention is reconciled against the restored backup in the private preservation record. All unrelated containers and the deployed frontend remained unchanged. Site/API/database/Redis/MinIO/tunnel are healthy and idle; original tunnel bytes restored; maintenance OFF.
- Rollback: not invoked. Prior backend image `sha256:406e7c36d8b42bc68b4fd041c0fc97133f05403a4fa7c2be2eaf4b83f1873713` retained as `xeeclip-backend-rollback:before-xeeclip-full-editor`; database/config backup and verified restore available.
- Remaining issues: no P0/P1 found in acceptance. Existing ASS plate/font approximations are P2 renderer limitations; cached client catalog refresh guidance is P3. Branded ChatGPT/Claude UIs were unavailable; the report claims the actual compatible MCP protocol tests only.
