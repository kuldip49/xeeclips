# Quick Reframe result flow

**QUICK_REFRAME_RESULT_FLOW_READY**

This report records local acceptance on 2026-10-16, before release, on
`codex/quick-reframe-result-flow`, based on `0bdedc2d84f597871b62948034615e8fffd6b143`.
Release commit, deployed versions and production smoke results are recorded separately.

## Root cause

`QuickReframeWorkspace` in `apps/frontend/src/components/quick-reframe/workspace.tsx` treated the
wizard's `edit` step as an instruction to navigate to `/edit-mode/<editProjectId>`:

- Baseline line 66: initial session loading redirected when the requested/default step was `edit`.
- Baseline line 75: an effect redirected whenever that step had a confirmed crop and an editing path after processing.
- Baseline line 86: the polling callback redirected when `afterJob.current === 'edit'`.
- Baseline line 146: the immediate style response redirected when no queued work remained.

Style application assigned `afterJob.current = 'edit'`. The backend already persisted the canonical
composition and a verified styled preview, then returned `READY`; the frontend sent users to the
editor instead of showing that result. `defaultStep()` also returned `edit` for unexported results,
so refresh and legacy links repeated the behavior. These locations were checked against the actual
baseline source with `git show HEAD:apps/frontend/src/components/quick-reframe/workspace.tsx`.
`editorUrl(session)` resolves to `/edit-mode/${encodeURIComponent(session.editProjectId)}`.
The backend preview transaction sets `READY` after saving its verified `REFERENCE` asset with
`quickReframeKind: 'PREVIEW'`; successful processing did not require an editor page visit.

## New behavior

Crop → choose mode/style → process → **Result**. The Result screen shows the actual rendered MP4,
XeeFree/XeePro, the selected style and a completion/History status. Users can export and download
there, or explicitly click **Edit Video** to open the existing canonical project.

The Result screen reuses `ExportStep` and `POST /quick-reframe/:id/export`. Export remains an explicit
action with the existing credit charge; merely viewing a preview does not create a paid export.
Downloading an existing export reuses its stored file. No renderer, style geometry, provider routing,
credit policy, project materialization or database schema changed.

Successful preview jobs now qualify for Quick Reframe History before any editor visit or export.
History uses the verified preview until an export exists, and offers View result, Edit Video, Export
and the existing export's Download action. Existing exported items remain supported. A new failed/busy
job without a completed output is excluded.

Loading, refreshing, returning from the editor or following a legacy `step=edit` URL only reads saved
state. Legacy links resolve to `step=result`. An in-progress job resumes polling and finishes on its
Result screen. No view operation implicitly transcribes, restyles, renders or exports. A stale preview
after a manual edit keeps the existing explicit Render preview action. The explicit Manual Editing
choice continues to open the canonical editor, as that button already requests editing.

`XEEPRO_BUSY` remains on style choices with the existing friendly message and explicit Use XeeFree
action; it neither shows a completed Result screen nor opens the editor.

## Requested acceptance report

All required local checks passed. Provider success, busy and recovery use safe mocks; media processing,
database persistence, local speech recognition, FFmpeg rendering and downloads use real local services.

| # | Area | Result |
|---|---|---|
| 1 | Root cause | Four editor-navigation paths consumed the wizard's `edit` completion/default step. |
| 2 | Responsible component | `QuickReframeWorkspace`; the default-step helper also selected `edit`. |
| 3 | Post-processing flow | All styles/modes finish on Result; no automatic editor navigation. |
| 4 | Result page | Rendered styled preview, mode, style, completion/History status, export/download and Edit Video. |
| 5 | Download | Stored canonical export downloaded without visiting the editor or rerunning processing. |
| 6 | Export | Same canonical Quick Reframe export endpoint, revision and pricing; available directly on Result. |
| 7 | Edit Video | Explicit click opens `/edit-mode/<editProjectId>`; no editor fetch or prefetch before that click. |
| 8 | History | Verified previews are listed before editor/export; failed new busy jobs excluded; old exports retained. |
| 9 | Refresh/back | Result survives refresh and browser Back from editor; default/legacy links resolve to Result; no duplicate POSTs. |
| 10 | XeeFree | All three style journeys covered; real ASR/render/export workflows retain zero provider/transport attempts. |
| 11 | XeePro | All three style journeys and real exports covered using safe mocked semantic success. |
| 12 | Busy | Friendly XEEPRO_BUSY message, Pro selection retained, no result/editor redirect or automatic fallback. |
| 13 | Desktop | Navigation, direct export/download, History, editor choice and real result playback covered. |
| 14 | 375px | Same journeys and controls, no horizontal document overflow. |
| 15 | 390px | Same journeys and controls, no horizontal document overflow. |
| 16 | Tests | 43 combined Playwright tests passed; seven focused backend scripts passed; isolated API/media acceptance passed 80 assertions over all six combinations; 81 rematerialization checks passed; frontend type check and static production build passed. |
| 17 | Regressions | Crop/touch/ratios/restore, all three styles, Free zero-cloud, mocked Pro routing/busy/recovery, export credits, canonical editor/Undo/Redo, History and rematerialization passed. All six preview/export frame comparisons stayed below the existing 20/255 mean RGB error limit (maximum 16.6204). |
| 18 | Files | 15 task files: six frontend implementation files, one backend implementation file, five browser specs, one backend acceptance verifier and README/report documentation; exact list below. |
| 19 | Commit | At local acceptance: uncommitted on `codex/quick-reframe-result-flow`, without push or deployment. See the separate release record for subsequent release status. |

## Validation and evidence

- `npm --workspace apps/backend run test:quick-reframe`: passed the backend build and seven focused scripts,
  including the 42-case Pro hook grammar suite.
- `node apps/backend/scripts/test-rematerialize-styled-clip.cjs`: 81 checks passed.
- `node apps/backend/scripts/verify-quick-reframe-both-modes.cjs`: `API_ACCEPTANCE_PASSED`, six combinations,
  80 assertions. Every verified preview appeared in History before the first editor API read or export.
  Successful exports charged exactly one credit; busy charged zero and recovered on the same project/process.
- Playwright `quick-reframe-result`, `quick-reframe`, `quick-reframe-post-copy` and
  `quick-reframe-both-modes`: **43 passed**. This includes 18 mode/style/width result journeys,
  three busy widths, refresh during processing, legacy links, real MP4 playback, canonical editor,
  six frame comparisons and the existing crop/social-copy checks.
- `npm --workspace apps/frontend run lint`: passed.
- `npm --workspace apps/frontend run build:cloudflare`: compiled successfully, checked types and generated
  all 19 static pages. This was a local build only.
- Final saved-result screenshot check: **1 passed**, covering all six actual MP4s at all three widths,
  with zero processing mutations and zero editor API requests. Entry animations were disabled for screenshots.
  The editor typography/Undo test intentionally invalidated two fixture exports; those disposable outputs
  were explicitly regenerated before this screenshot rerun. Stale results correctly showed Render preview
  instead of claiming completion.

Evidence is retained locally:

- `.real-qa-preview/quick-reframe-both-modes/acceptance.json`: API assertions and six real exports.
- `.real-qa-preview/quick-reframe-both-modes/pixel-parity.json`: all six measured frame errors.
- `.real-qa-preview/quick-reframe-both-modes/result-<MODE>-<STYLE>-<WIDTH>.png`: desktop/375px/390px Result screenshots.
- `.cache/quick-reframe-result-flow/`: prior fixture evidence and the disposable output refresh helper.

The isolated `qr-final-qa` Docker services and local frontend dev server were stopped after verification.
No live provider quota or production projects were used.

## Files changed

Implementation:

- `apps/frontend/src/components/quick-reframe/workspace.tsx`
- `apps/frontend/src/components/quick-reframe/export-step.tsx`
- `apps/frontend/src/components/quick-reframe/history.tsx`
- `apps/frontend/src/components/quick-reframe/step-indicator.tsx`
- `apps/frontend/src/components/edit-mode/edit-mode-workspace.tsx`
- `apps/frontend/src/lib/quick-reframe-api.ts`
- `apps/backend/src/modules/quick-reframe/quick-reframe.service.ts`

Tests and documentation:

- `apps/frontend/e2e/quick-reframe-result.spec.ts` (new)
- `apps/frontend/e2e/quick-reframe-both-modes.spec.ts`
- `apps/frontend/e2e/quick-reframe-flow.spec.ts`
- `apps/frontend/e2e/quick-reframe-hooks.spec.ts`
- `apps/frontend/e2e/quick-reframe-live.spec.ts`
- `apps/backend/scripts/verify-quick-reframe-both-modes.cjs`
- `README.md`
- `docs/quick-reframe-result-flow.md` (new)

The three pre-existing untracked editor timing release scripts were preserved. Local acceptance did
not create a commit or use destructive Git operations.
