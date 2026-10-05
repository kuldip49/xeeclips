# Automatic 2 — street3.mp4 template

`street3.mp4` (1080×1920, 60 fps, 34.17 s) is the single authoritative visual reference for Automatic 2.
Only the **visual template** (outer composition + typography) comes from it; editing intelligence
(clip selection, cuts, speaker switching, face-safe reframing, semantic zoom, grade, audio) is unchanged
and operates *inside* the fixed media window.

## Measured geometry (pixels, 1080×1920)

| Region | Measurement |
|---|---|
| Canvas | `#000000`, no blur / gradient / duplicate |
| Media window | x 0–1080, **y 610–1310 (700 px)**, identical in every sampled frame, speaker and evidence shots alike |
| Hook ink | y 485–580, x 37–1031; two centred lines; serif, cap height 33 px, `#D0D0D1`; emphasis amber `#A7761A` + deep red `#801B2E` |
| Supporting line ink | y 1324–1448, x 167–893; two centred lines, cap height ~45 px, `#D0D0D1` |
| Black space | 610 px above the media window, 610 px below it |

The reference has no burned captions; Automatic 2's lime active-word captions are anchored to the bottom of the media
window (`captionSafeBox`) and never leave it.

## Design changes requested 2026-10-03 (geometry unchanged)

- **Hook:** white text (`colors.hookText`) with its semantically highlighted words (at most two: numbers, names,
  substantive words - `semanticHookRuns`) in one red (`colors.hookHighlight`, `#E53935`). Previews use the same
  rule (`hookEmphasisRuns` in the frontend).
- **No supporting line:** the template has no `TEXT` component; the region below the picture stays black.
- **Speaker punch-in** (`render/edit-mode-speaker-punch.ts`): inside the fixed window the tracked crop is tightened
  on the followed speaker so the face fills ~31% (medium-close) or ~40% (close-up) of the card, alternating at
  sentence ends (at most every 6 s). Each interval is validated on the analysis frames (target face whole with
  10% headroom, no second face half-cut); a two-shot the camera holds as a pair is never punched. Folded into
  `cropAt` (editor `cameraPath`, zoom safety, QA) and the camera filter, so preview and export agree.
- **Semantic zoom only:** Automatic 2 replaces zooms inherited from the base edit and zooms only the strongest
  emphasis moments (score >= 0.68), ranked by score, at most 1/2/3 for clips <=20/<=40/>40 s, >= 8 s apart, 1.08x.
- **Results card:** while the Automatic 2 export renders, the card previews the clip in the Automatic 2 frame
  (its source range in the media window under the red hook), never the base render's Automatic 1 layout.

## Single source of truth

`apps/backend/src/modules/edit-mode/styles/automatic-2-street3-layout.ts` → `AUTOMATIC_2_STREET3_LAYOUT`
→ `resolveVisualLayout()` → persisted `resolvedVisualLayout` → browser preview *and* FFmpeg export.
Nothing re-derives these numbers. Outer geometry never depends on source aspect, resolution, face count, speaker or B-roll.

## Typeface

EB Garamond (OFL). Backend image: `apk add font-eb-garamond` (Dockerfile). Browser: `apps/frontend/public/fonts/EBGaramond12-Regular.otf`
via `@font-face` in `globals.css`. EB Garamond is ~18 % narrower than the reference face, so sizes are nudged (hook 30 / support 40
design units) to match block size rather than cap height.

## QA

- `apps/backend/scripts/qa-street3-compare.py <street3.mp4> <generated.mp4…>` — samples 0/10/25/50/75/90/100 %, measures the media
  window, hook and supporting blocks, fails if any outer row differs from the reference window or a full-width picture leaks outside it.
- `npm run verify:automatic-2` — in-memory harness on real media (asserts exact geometry constants, font, camera aspect).
- `apps/backend/scripts/verify-automatic-2-e2e.cjs --file <video> [--browser] [--template AUTOMATIC_1]` — real HTTP flow
  (upload → Automatic 2 → final export). `--browser` opens the real Results page in Chrome (Playwright), asserts the
  temporary base clip plays with its badge and that the card swaps to the final export without a reload. Prints timings,
  the export's camera telemetry (shots/layout, speaker switches, face-safety violations) and final QA.
- `scripts/test-automatic-2-reliability.cjs` — offline regressions for graphic fit, trim clamping and Automatic 1 isolation.

## Reliability rules (completion pass, 2026-10-03)

- **Information-safe fit is deterministic.** `automatic2InformationFit()` (`render/edit-mode-camera.ts`) marks a shot
  FIT/INFORMATION when ≥40 % of its frames show screen/graphic evidence — visual labels, OCR word count/coverage,
  text-box area, graphic boxes, or edge density on a landscape source — and no useful face dominates it. It does not
  depend on the classifier's shot class being populated. Automatic 1 ignores it (`speakerSafe` only).
- **Trims never reach FFmpeg out of range.** `clampEditWindowToSource()` clamps the candidate/edit window to the probed
  video-stream duration before planning (pre-/post-roll included); `normalizeProbedSourceTrims()` re-clamps every
  source trim to the downloaded file's probe before the render plan and recomputes the remapped durations. Only overruns up to 1 s are
  corrected; a larger one is a broken timeline and fails as `INVALID_TIMELINE` instead of a truncated export.
- **One high-quality render.** Automatic 2's base clip is only a temporary preview (Export is disabled and a style
  failure never substitutes it), so it is encoded `ultrafast/crf26` and Automatic 1's pixel QA is skipped
  (`qa: false`); the editable plan is produced exactly as before. The canonical Automatic 2 EditMode export, with its own
  QA and repair pass, is the only full-quality render. Telemetry: `baseRenderRole: AUTOMATIC_2_TEMPORARY_PREVIEW`.
- **Face tracks reach the final camera.** The materializer copies the clip's cached visual analysis into the editable
  source asset, so the final render tracks the active speaker instead of falling back to a centred crop.
