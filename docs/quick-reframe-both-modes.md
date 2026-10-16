# Quick Reframe: Free and Pro local acceptance

Date: 16 October 2026 (Asia/Calcutta). Local implementation; production was not deployed.

Status: `QUICK_REFRAME_BOTH_MODES_READY`. Local acceptance passed; push and deployment remain on hold.

## Architecture and scope

The previous crop-first workflow owned a canonical EditProject, used a separate BullMQ queue, baked the
manual crop once, and supported StyleOne, StyleTwo and Manual. Its intelligence choice was an optional
request consent flag, rather than durable project provenance. Styled results opened an intermediate
Quick Reframe editing surface. StyleZero was missing.

New projects start with `settings.origin = {originKind: 'QUICK_REFRAME', aiMode: 'FALLBACK_ONLY'}`.
The revision-checked `PUT /quick-reframe/:id/mode` explicitly selects XeeFree or XeePro. Mode changes
preserve timeline edits and invalidate suggestions. Hooks and social copy use the stored mode, and
canonical Ask AI reads the same origin. Legacy projects without recorded provenance fail closed to
XeeFree; opening them does not restyle or regenerate their work.

Upload/probe → manual crop → deterministic crop bake → mode/style choice → cached local analysis →
shared creative services → canonical EditProject → canonical editor → History/export.

Every style opens the same editor. The existing source-time VIDEO trims and clip-local overlay,
caption, zoom and music timing remain authoritative. Canonical settings determine the rendered style
after Undo/Redo; an older wizard path cannot override the restored composition. Mode provenance is
kept outside the media Undo/Redo stack.

XeeFree uses the current shared local understanding, hook quality and copy engines. Its ASR now also
reuses the shared ending-evidence and consensus rules for at most one bounded base/strong tail check
when warranted; saved evidence is reused. Original words and correction provenance are retained.
Manual cropping never starts ASR, OCR, face analysis or a cloud request.

XeePro uses the existing router and model configuration. Busy scopes stop the request before any
local result can be delivered as Pro. Failed understanding/creative attempts are not cached, including
concurrent consumers of the same pending request. A subsequent request can recover without a restart.
The UI preserves XeePro selection and offers an explicit **Use XeeFree** action.

The credit policy is unchanged: Quick Reframe reserves one credit at export, rather than at style
generation. A Pro failure during styling therefore has nothing to refund. Export failure releases its
reservation through the existing atomic, idempotent settlement service. Successful exports consume one.

No database schema, pricing, provider model configuration, Create Clips routing or global style geometry
changed. The narrow security-guard adjustment lets an owned Free Quick Reframe request use local tools
without cloud consent. Pro requests still require the existing account consent.

## Results against the requested acceptance points

| # | Area | Local result |
|---|---|---|
| 1 | Old architecture | Crop-first, canonical editor, consent-based intelligence; StyleOne/Two/Manual. |
| 2 | Weaknesses found | Missing durable mode and StyleZero; intermediate editor; unguarded style reasoning; failed Pro caches; uppercase approval mismatch; manual Pro headlines blocked; StyleZero blur placeholder differed from export; baked StyleTwo preview skipped manual zoom/pan. |
| 3 | New mode architecture | Durable server-owned origin; explicit revision-checked selection; no mode change from request consent flags. |
| 4 | XeeFree flow | Crop → all three styles → canonical edits → real FFmpeg export passed with provider entry points trapped. |
| 5 | XeePro flow | Same six-way workflow exercised using isolated mock semantic success; current production router configuration retained. |
| 6 | Zero-cloud proof | Complete Free workflows: router attempts 0, transport attempts 0; consequently OpenAI/cloud/escalation/blocked-provider attempts 0. |
| 7 | Pro busy | Safe XEEPRO_BUSY message, selected mode retained, terminal failed job, no completed output, no Free fallback. |
| 8 | Pro recovery | Same project/router/process succeeds after mocked capacity returns; no restart or flag change. |
| 9 | Credits | One per successful export. Busy styling charges zero. Real PostgreSQL export failure refunded; two concurrent duplicate settlements did not refund again; no RESERVED row remained. |
| 10 | Crop | Exact normalized crop persisted; full duration retained before user trim. Existing ratio, handle, touch, pan, zoom, grid and nudge browser regressions pass. |
| 11 | StyleZero | Shared clean hook/caption components, canonical subtle zooms, whole cropped source fitted once. Shared black matte replaces preview-only blur placeholder. Both modes rendered. |
| 12 | StyleOne | Existing black canvas, serif hook, caption styling and fixed video window retained. Both modes rendered. |
| 13 | StyleTwo | Existing white canvas, fixed window, condensed hook and caption styling retained. Both modes rendered. |
| 14 | Free hooks | Shared deterministic engine produced grounded lines, including “The explanation changes the debate”. Quality/policy regression suites pass. |
| 15 | Pro hooks | Mock semantic hooks passed the shared grammar/clarity reviewer, including “Credentials cannot win this argument”. Typography case changes preserve approval; unapproved generated wording remains blocked. |
| 16 | Video captions | Real local Whisper produced editable timed captions; manual correction survived save/reload and export. Uncertain OCR does not silently create duplicate captions. |
| 17 | Social copy | Separate metadata tool; Free remains local, Pro follows the saved mode. Caption variants, hashtags, rewrite, copy, History and mobile tests pass. |
| 18 | Trim | Both ends trimmed in all six combinations. Export duration agrees with the canonical range; shared content-anchored retiming suite passes. |
| 19 | Zoom/pan | Canonical manual scale and offsets persisted and rendered in all six combinations. The manual crop remains the baseline; card styles do not introduce another automatic crop. |
| 20 | Music | Actual WAV upload, music insertion, volume change, persistence and real StyleTwo export passed. |
| 21 | Media | Actual PNG upload, positioning, sizing, Undo/Redo and real StyleTwo export passed. |
| 22 | Ask AI/editor | Free explicit source-audio edit succeeded locally; open-ended Free request made no provider attempt. Pro semantic request reported XEEPRO_BUSY. Manual controls remained usable. |
| 23 | Undo/Redo | Full canonical element state restored, including music and image overlay; a pre-mode-change Undo did not switch the selected tier. |
| 24 | Reload | Canonical API reload preserved manual text, captions, trim, transform and overlays. Browser reopened every mode/style project. |
| 25 | History | All six exported sessions retained mode and style; Re-edit opens the same canonical project, with Export and Download actions. |
| 26 | Rematerialization | Existing styled-project reconstruction regression suite passes; Quick Reframe continues to own its EditProject directly and creates no GeneratedClip reconstruction fork. |
| 27 | Preview/export | All six real export frames passed the browser comparison in Fit view. Mean absolute RGB error: 9.76–16.62/255, below the 20/255 gate. Baked StyleTwo now uses the existing shared window transform when manually zoomed. |
| 28 | Desktop | All six combinations reopened in the canonical editor; no page errors or horizontal overflow in tested layouts. |
| 29 | 375px | Crop handles, Done Cropping, mode/style choice, editor drawer, social copy, busy action and export tested. |
| 30 | 390px | Same controls/layout coverage; no horizontal overflow. |
| 31 | Performance | No intelligence before confirmed crop/style choice; original analysis/transcript and bounded tail evidence cached. Normal manual edits only mutate canonical state. |
| 32 | Tests | Focused backend suite; policy, busy, availability, trim, zoom/media, timing, rematerialization and headline suites; crop, social-copy and both-mode Playwright suites. See commands below. |
| 33 | Regressions | Focused checks found no remaining regression in the exercised paths. Existing flow/hook/social-copy tests updated for canonical editor navigation and saved mode selection. |
| 34 | Limits | No live provider request was made. Success, quota/busy and recovery used safe mocks. Synthetic speech/test-pattern media exercises actual local ASR and rendering but does not establish multi-person face-tracking quality. Existing OCR-unavailable uncertainty behavior remains. |
| 35 | Files | Quick Reframe service/controller/mode/transcript/compiler; shared session types; mode/choice/hooks/copy/history/workspace UI; narrow canonical editor provenance/headline fixes; shared busy cache guards; tests and isolated QA configuration. |
| 36 | Commit | Local commit `feat: unify Quick Reframe Free and Pro workflows` on `codex/quick-reframe-both-modes`. No push or deployment performed. |

## Verification and artifacts

`npm --workspace apps/backend run test:quick-reframe` builds and runs the focused backend suite.
Frontend type checking: `npm --workspace apps/frontend run lint`.
Final both-mode Playwright run: **4 passed** (desktop/phones, crop/choices/busy/export,
six preview/export frame comparisons, and manual styled-hook typography). Backend focused suite and
frontend type checking also passed again after the final source changes.

The disposable stack is defined in `infra/docker/quick-reframe-qa.yml`. It uses the separate Compose
project `qr-final-qa`, database `quick_reframe_qa`, its own Redis/MinIO, and port 4100. Production
containers and projects are not touched. Initialize `.cache/quick-reframe-qa/provider-state.json` with
`{"busy":false,"freeAttempts":0,"proCalls":0,"transportAttempts":0}` before starting it. The QA preload
is explicitly gated and is never loaded by production startup. Existing local images and models are
required; backend `dist` and shared package files are mounted from this checkout.

Generate authorized disposable speech/video fixtures in `.real-qa-preview/quick-reframe-both-modes`,
then run `node apps/backend/scripts/verify-quick-reframe-both-modes.cjs` and its `--editor-only` pass.
The script validates the isolated container identities before creating accounts or changing test credits.
Run the frontend separately on port 3100 with its public/server API URL set to `http://localhost:4100`.

Playwright: set `E2E_FRONTEND_URL=http://localhost:3100`, `E2E_API_URL=http://localhost:4100` and
`E2E_QUICK_REFRAME_QA=1`; run `quick-reframe.spec.ts`, `quick-reframe-post-copy.spec.ts` and
`quick-reframe-both-modes.spec.ts`. The last suite requires the verifier's disposable session manifest.

Local evidence: `.real-qa-preview/quick-reframe-both-modes/acceptance.json`, six MP4 exports,
desktop/phone screenshots, paired preview/export frames, and `pixel-parity.json`.
Unit/regression logs are in `.cache/quick-reframe-qa/`. Session cookies stay in the ignored QA directory.

## Deployment hold

After local acceptance, create the requested clean commit. Push requires the user's approval.
Production deployment remains a separate action: backend and frontend only, no new migrations,
pricing changes, provider settings or AI-service replacement. Recheck Free export, Pro busy/recovery,
History reopening and one disposable canonical editor export after any approved deployment.
