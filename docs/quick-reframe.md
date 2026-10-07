# Quick Reframe (V3: fully manual crop first)

Implementation and acceptance report. V2 (2026-10-07) introduced crop-first; V3 (2026-10-07) makes the crop
stage 100% manual and moves every AI step after the editing-mode choice.

## The guided sequence

**Import → 1. Crop (manual) → Done Cropping → 2. Choose Style → 3. Edit (StyleOne or Manual) → 4. Export → History.**

`/quick-reframe` is a separate top-navigation page with its own concurrency-one BullMQ queue. It owns
a canonical `EditProject` but never creates Video, ProcessingJob, ClipCandidate or GeneratedClip rows,
never selects highlights, never shortens or splits the video, and keeps the original audio and timeline.
Quick Reframe projects are hidden from the editor's project list and appear only in Quick Reframe History.

A step indicator (`components/quick-reframe/step-indicator.tsx`) shows the active step. Earlier and
already-reachable steps are links back; nothing is lost by going back.

### When AI runs

| Stage | What runs |
| --- | --- |
| Upload / import | `PLAYBACK` job: ffprobe, an H.264/AAC browser copy only when the codec needs one, and the whole-frame draft. Deterministic. |
| 1. Crop | Nothing. No detection, OCR, face/subject tracking, suggestion or correction. The API refuses `/analyze`, `/styleone` and `/hooks` until the crop is confirmed; `/suggest` no longer exists. |
| Done Cropping | `PREPARE` job: the exact rectangle is baked into SOURCE with FFmpeg (deterministic). |
| Choose StyleOne / Manual | `ANALYZE` job (local only: faces/OCR on the uploaded frame, Whisper). Cached on the ORIGINAL asset, so a re-crop never repeats it. |
| Hooks | Local generator; OpenAI only with the per-request consent box. |

The caption situation (`subtitleState`) is reported **for the confirmed crop**: burned-in captions the user
cropped away count as missing (StyleOne then generates captions); a caption line the crop cuts through is
"uncertain". Faces are only used afterwards for the Manual hook-position warning.

### 1. Crop (`crop-step.tsx`, geometry in `lib/quick-reframe-crop.ts`)

Opens immediately after upload: large playable preview, full-frame stage with the dimmed outside area, a
draggable crop rectangle with four corner and four edge handles (48 px touch targets), a live cropped preview
(canvas drawn from the playing video), "Preview result" (the cropped composition playing), Start/Middle/End
jump buttons and a seek bar. Nothing else: no StyleOne, hooks or editing tools.

- **Aspect ratios:** Original (locked to the source ratio), Free, 9:16, 16:9, 1:1, 4:5, 5:4, 3:4, 4:3, 2:3,
  3:2, 21:9, and a custom `W:H` field (`7:5`, `2.35:1`, `4x5`; 1:20…20:1). Choosing a fixed ratio keeps the
  current crop's area and centre in the new shape (shrinking only as far as the frame requires); Free keeps
  the crop exactly. A fixed ratio stays locked while resizing (corners follow the larger axis and anchor the
  opposite corner; edges anchor the opposite edge); Free moves each edge independently.
- **Grid:** Rule of thirds (with power points), 3 × 3, 4 × 4, Center crosshair, Golden ratio, None, plus a
  Show/Hide toggle. Drawn over the crop area only, saved with the draft, never changes the crop.
- **Precise controls (all synchronized with the rectangle):** Crop top/bottom/left/right sliders and pixel
  fields (behave exactly like dragging that edge), Width/Height in source pixels, Zoom (1× = largest crop of
  this shape), Pan left/right and up/down, Position X/Y, Reset (whole frame, Original), Cancel (back to the
  confirmed crop, or to the crop the step opened with), Done Cropping. Arrow keys nudge the focused box by
  1 px (Shift: 10 px). Rotation is not offered (the bake pipeline has no reliable rotation).
- **Gestures:** pointer events for mouse, pen and touch. One finger drags a handle or the box; two fingers
  pinch (spread = zoom in) and pan together; lifting one finger continues as a move. The stage is
  `touch-action: none`, so drags never scroll the page, while the rest of the page scrolls normally; the
  workspace is not a scroll anchor, so text reflowing beside it never shifts the picture under a finger.
  Ctrl + wheel (and trackpad pinch) zooms on desktop.
- **Full screen:** a viewport overlay rendered on `<body>` (so no transformed ancestor breaks `fixed`), with
  safe-area insets, page scroll locked, Escape to leave, and Reset/Cancel/Done Cropping docked at the bottom.
- **Only technical limits:** finite numbers, inside the frame, at least 16 × 16 source pixels. Faces, captions,
  hooks, attribution, subject coverage and minimum area never block Done. Non-blocking notes: crops whose
  short side is under 360 px will look soft at 720p/1080p; very narrow shapes are scaled so the export's long
  side stays within 3840 px.
- Coordinates are normalized to the uploaded frame (independent of screen size). The crop is fixed for the
  whole duration; V1/V2 subject tracking is removed when a crop is saved. The draft autosaves (debounced),
  so a refresh, a backend restart or returning to Crop restores the exact rectangle, ratio and grid.
- The V2 "Clean overlays" tool (OCR-based blur/mask) is no longer part of the crop step. Sessions saved with
  cleanup regions keep them (still under their rights and attribution checks) and can remove them.
- The page notes that cropping is the user's choice and that reposted videos should keep the credit their
  creator requires; nothing in the product hides third-party provenance automatically.

### How the crop is stored (why it is never applied twice)

The canonical editor's own VIDEO crop pads the kept region back to the full source frame (a
letterbox), which would shrink the picture inside StyleOne's window and never produce a real cropped
canvas. So **Done Cropping** renders the confirmed crop (plus any legacy cleanup) once (`quickCleanRender`,
validated by ffprobe and a full decode) and updates the project's `SOURCE` EditAsset **in place**: the
same row id now points at the cropped file, with the original duration and transcript. The uploaded file
becomes a REFERENCE asset `quickReframeKind: ORIGINAL` (distinct identity key, `storageObjectKey` = the real
object), so the crop can be re-edited any time. Element asset ids never change, so every edit, history
snapshot and undo step survives a re-crop. The swap is logged as `QUICK_REFRAME_SOURCE_PREPARED`, which
canonical undo does not replay. A full-frame crop with no cleanup and a browser-compatible codec bakes
nothing: SOURCE points back at the original. The baked file is identified by a key-order-independent
fingerprint of the preparation; previous baked files are deleted, the ORIGINAL never is.

Both editing paths and every preview/export compose from that SOURCE. In the editor the Crop tool leads
back to this step instead of stacking a second crop.

### 2. Choose Style (`choose-step.tsx`)

"How would you like to edit your video?" offers **Apply StyleOne** and **Open Manual Editor**. Neither
runs before the crop is confirmed (the API refuses StyleOne, analysis, hooks, preview and export until then),
and no AI result is shown here: the screen only says that the speech and captions are checked after the
choice. Choosing either starts the `ANALYZE` job when the upload has not been analyzed yet; for StyleOne the
job keeps the operation claimed and continues straight into StyleOne and its preview, so the browser never
sees an idle gap. Switching from Manual to StyleOne asks first; switching
from StyleOne to Manual offers "Keep StyleOne and edit" or "Start from the cropped video". Each switch is
one canonical revision, so editor Undo restores the previous composition.

### 3a. StyleOne (`styleone-step.tsx`)

Uses the actual StyleOne engine: `resolveCreativeStyle(AUTOMATIC_2)` → `compileCreativeStyle` →
`applyAssistantBundle` (one undoable `APPLY_ASSISTANT_EDIT` revision). `AUTOMATIC_2_STREET3_LAYOUT` stays
the only geometry source: black 1080×1920 canvas, fixed media window x=0 y=610 1080×700, EB Garamond hook
with semantic emphasis above it, white/lime active-word captions in its safe box. The bundle adds the
canonical `SET_VIDEO_FRAMING FIT`, so the whole confirmed crop is fitted inside the window (the editor
preview and the canonical camera both honour it), with the black canvas around a crop whose shape
differs from the window; the crop is never recalculated, re-cropped or stretched. A custom 54:35 crop
fills the window exactly. The hook is the Recommended suggestion (local unless OpenAI was authorized). Captions are
generated (`GENERATE_CAPTIONS`, real word timings) only when the video has none; readable existing
captions are kept with no duplicate layer. StyleOne is rendered only after it is chosen.

The result screen shows the rendered 540×960 preview and **Re-edit Crop**, **Change Hook** (suggestions or
own text, one canonical text command), **Adjust Captions** (show/hide, or generate when missing),
**Edit More** (the canonical editor with the StyleOne composition intact), **Export Video** and **Undo
StyleOne**.

### 3b. Manual editing (the canonical editor)

**Open Manual Editor** opens `/edit-mode/<editProjectId>` — the same complete editor as everywhere else —
with a Quick Reframe step bar, back link and a Quick Reframe-only **Hooks** tool (desktop rail and phone
tool bar). StyleOne is not applied. The preview starts as the cropped video with its original timeline and
audio. Every other tool is the existing one: Text, Captions, Filters (10 presets), Adjust (exposure,
brightness, contrast, highlights, shadows, saturation, temperature, tint, sharpness, fade, vignette, each
with reset), Audio (volume, mute, fades, music, ducking), Overlay (images/logos), Templates, Media, timeline
editing, Inspector (scale/position, rotation, speed), Undo/Redo and Ask AI. Export in the editor header
goes to the shared Quick Reframe export step.

The Hooks tool follows the post-choice analysis ("Checking your video's speech and captions…", with a
**Check video** retry if it was canceled or failed). It contains:

- **Suggested Hooks** (`quick-reframe-hooks.ts`): six categories — Bold, Curiosity, Question, Contrarian,
  Emotional, Professional. With the per-request consent box ticked, OpenAI (backend key, `OPENAI_MODEL`,
  router role `hookGeneration`) writes two per category from up to 8,000 transcript characters; the
  existing grounded local generator always contributes and is the fallback. All candidates go through
  `scoreHook` (rejects ungrounded lines, fabricated quotes, clickbait, false urgency; scores grounding,
  brevity/readability, mechanism and specificity) plus a phone-readability term; at most two per category,
  duplicates removed, the top line marked **Recommended** ("a quality judgement, not a promise of views").
  Cards offer Apply and Edit; Regenerate and "Write your own hook" are always available. A hook is a
  canonical TEXT element (`textStyleId: HOOK`, `presetRole: HOOK`).
- **Position**: Above video (when the canvas has room; "Make room above the video" switches to a 9:16 FIT
  frame), Top inside video, Center, Custom (drag in the preview). A warning appears when the hook covers a
  detected face (mapped through the crop) or the captions. **Show hook for**: first 3 s / 5 s / whole video.
  Font, color and background open the existing Text tools.
- **Captions decision**: "Captions detected." (kept; generating anyway is behind an explicit warning) or
  "No captions detected. Add captions?" → **Generate Captions** (local Whisper transcript, canonical
  grouping and word timings). Customization uses the existing Captions tools.

### 4. Export (`export-step.tsx`)

One export process for both paths (`QuickReframeService.compose`): the canonical render plan, ASS text and
FFmpeg graph over the confirmed SOURCE, including the project's images and music. The screen shows the
final rendered preview (or a Render preview button), duration, the exact resolution for the chosen quality
(720p or 1080p short side; StyleOne is 720×1280 or 1080×1920), aspect ratio, format (H.264/AAC) and an
estimated size. Output is validated by ffprobe (codec, exact canvas, duration ±0.25 s, audio present
when audible) and a full decode before it is saved; only then does **Download Video** appear. Previews
are 540 short side with the same layout and are replaced; exports persist and become "edited since export"
when the project changes.

### History

Quick Reframe History cards show the **Quick Reframe** label, the editing path (StyleOne/Manual),
preview, **Re-edit** (StyleOne result screen, or the editor for Manual), **Export**, **Download** and
**Delete** (removes exports, previews, the cropped source and the original). Reopening restores the crop,
hook, captions and adjustments because they are all canonical state.

## Data

`QuickReframe` gained `editPath` (STYLEONE | MANUAL) and `confirmed` (the baked preparation), migration
`20261007010000_quick_reframe_v2` (additive). `plan` holds only the crop-step draft (aspect — `SOURCE`,
`CUSTOM` = Free, or `W:H` — crop, grid, legacy cleanup, denoise); it never rewrites the timeline. V3 needs no
migration: `grid` lives in the plan JSON and the new statuses (`PLAYBACK`, `CROPPING`) are strings. `hooks` stores ranked category objects (old
string lists are still read). Sessions from V1 open on the Crop step with their previous crop as the draft.

## Verification (V3, 2026-10-07)

- Typechecks: shared, backend, frontend. Unit: `test-quick-reframe.cjs` (V3 contract: whole-frame draft,
  crops that cut faces/captions/attribution stored exactly, only technical limits incl. the 16 px minimum,
  every preset + custom ratio, display-only grid, crop-aware caption state, legacy cleanup rights, exact
  export canvases incl. the 3840 px cap, bake graph; real FFmpeg 16×16 crop) and `test-quick-reframe-styleone.cjs`.
  The frontend geometry (`quick-reframe-crop.ts`) was checked standalone: every ratio switch, locked/free drags
  on all handles, zoom/pan, edge/size fields, parsing.
- Live, `scripts/verify-quick-reframe-v3.cjs --openai --restart` (HTTP like the browser, files inspected with
  ffprobe and extracted frames, self-cleaning) on owned synthetic 27.2 s 720×1280 "repost" fixtures (SAPI
  speech, black bars, headline, creator handle; one with burned-in subtitles):
  - Before Done Cropping: no analysis, no transcript; `/analyze`, `/styleone`, `/hooks` refused; `/suggest` gone.
  - Every crop baked to exactly the chosen rectangle (frames at start/middle/end vs the same crop of the
    original, MAE 0–255; a 24 px shifted crop for comparison): Free 438×496 (0.14 vs 13.05), 9:16 360×640
    (0.06), 16:9 720×404 (0.17), 1:1 432×432 (0.04), 4:5 360×450 (0.05), custom 7:5 502×358 (0.07), from
    top/bottom/left/right (≤0.04), 16×16 minimum. A 10 px crop was refused; a grid change kept the confirmed crop.
  - StyleOne on the Free crop that cuts the headline, handle and captions: analysis started only on choosing;
    crop kept exactly; 1080×1920 H.264/AAC 27.20 s; black canvas; whole crop FIT in the window (MAE 1.86, no
    second crop, black pillarbox); preview/export parity MAE 2.69; audio r=0.994 at −5 ms; 15 captions; History.
  - Manual on a 4:5 crop: analysis started only on choosing; no automatic elements; OpenAI hooks (consent) +
    15 captions + Warm; export 1080×1350 H.264/AAC 27.20 s, audio r=0.994. Re-crop to 16:9 kept the SOURCE id
    and all 17 elements, marked the export stale and re-exported 1284×720 (the 405 px crop height floors to 404).
  - After `docker restart ai-content-backend`: crops, ratios, paths and exports intact.
  - Captions follow the crop: crop keeping the subtitles → EXISTING_READABLE, none added; crop removing them →
    MISSING, StyleOne generated 15.
- Browser (local stack): `e2e/quick-reframe.spec.ts` (mocked, 9/9: no AI tools/requests while cropping at
  320–1440 px, every ratio chip, corner/edge/move drags, ratio locks, custom ratio, grid never changes the crop,
  numeric sync, exact saved crop, zoom/pan/reset, CDP touch drag + two-finger pinch/pan without page scroll,
  full screen, exact restore, low-resolution warning, choose/export) and `e2e/quick-reframe-flow.spec.ts` (live,
  3/3: Free crop by sliders and handle drags, refresh, confirmed crop equals the drawn one, no analysis before
  the choice, StyleOne and Manual journeys to downloaded exports, History re-edit, phones 320–768).
- Regression: canonical editor scripts as before (only the pre-existing phase7 and ai-objects failures);
  generated-clip edit-project, unified generation, Quick Reframe StyleOne scripts pass.

## Editor ↔ export parity (2026-10-07, follow-up)

Reported: the Export step showed only the middle band of a 1080×1920 export, and changing the colour of the
on-screen hook did nothing. Fixed together with every other manual text control, verified by
`e2e/quick-reframe-parity.spec.ts` (live: editor screenshot vs a frame of the real MP4, bounding boxes of the
plate, coloured text, highlighted word, captions and video window must agree within 2.5% and glyph heights
within 10%):

- **Export preview:** the video fills its box absolutely (a percentage height inside a centred grid did not
  resolve, so the frame overflowed and was clipped).
- **Hook colour:** a StyleOne hook stores per-word `textRuns`, which overrode the Text colour. `SET_TEXT_COLOR`
  now recolours the words drawn in the old text colour (emphasis keeps its own); the preview mirrors it.
  New **Word colours** section: select words, colour them, recolour highlights, reset, one colour for all
  (`SET_TEXT_RUNS`; an empty list removes per-word colours).
- **Colour pickers** commit the picked value (debounced, and on blur): the native picker blurs when it opens,
  so the old commit-on-blur sent the previous colour.
- **Editor commands are queued** (each runs on the revision the previous produced) and a click on an element is
  no longer committed as a move; a colour picked while a move was saving used to be dropped as a conflict.
- **StyleOne layout no longer overrides manual edits in the export:** text keeps its own position and box; the
  template auto-fit applies only while the font size is still the template size, and the editor preview applies
  the same fit (`layoutFittedFontSize`).
- **No stretching in the editor:** a FIT video inside StyleOne's window is fitted with black bars, as exported
  (it was stretched to 1080×700). The card canvas no longer claims a blurred backdrop.
- **Focus view** includes every visible text/caption/image box, so a moved hook never leaves the view.
- **Same line breaks:** the preview draws the renderer's own breaks (port of `wrapTokens`, incl. two-line
  balancing for the serif); per-word colours and the active word follow them.
- **Same glyph size and face:** libass sizes fonts by line height, CSS by the em; the preview scales each font to
  the measured export size (Inter ×1/1.217, EB Garamond ×1/1.08, Noto Sans ×1/1.53, Noto Serif ×1/1.46), and the
  export now uses the EB Garamond **12** cut the editor loads (fontconfig had picked the wider 08 cut).

Measured (1080×1920, StyleOne, edited hook): plate x 174–904 vs 174–906, text 196–884 vs 194–884, video window
192–890 vs 190–888. Manual 4:5: captions 184–896 vs 182–898; the hook plate exports ~18 px wider per side
(libass box padding).

## Deployment

Parity follow-up: backend hot-deployed to the laptop stack; frontend Worker version `adb9be67-5516-4387-8dd0-12dde3d32988`. Against production: Quick Reframe journeys, both parity tests and the crop suite 14/14, Create Clips `e2e/workflows.spec.ts` 5 passed (YouTube skipped).

V3 (commit `b97874b` on `main`): backend hot-deployed to the laptop Docker stack (`https://api.xeeclip.me`; no
migration, existing sessions kept, V2 sessions open on the Crop step with their crop as the draft). Static
frontend deployed to Cloudflare (Worker version `157bd95c-33a8-4f36-aee3-946a09ba975b`). Against production:
`e2e/quick-reframe-flow.spec.ts` 3/3 (both full journeys with real downloads, phone widths),
`e2e/quick-reframe.spec.ts` 9/9, and the Create Clips journeys `e2e/workflows.spec.ts` 5 passed (YouTube
skipped: no authorized URL). Disposable sessions were deleted.

V2 (commit `7a39bc2`): additive migration `20261007010000_quick_reframe_v2` applied on restart; Worker version
`ed1a1bb0-5aa3-4327-8f19-b15158d2a3cb`; production flow spec 3/3.

## Limits

- Caption detection (after the mode choice) samples one frame per second and is confidence-based; moving or
  low-contrast text may need manual review.
- No rotation in the crop step. Even-pixel encoding can floor a crop by 1 px, so a preset ratio may export a
  few pixels off the textbook size (e.g. 1284×720 for a 405 px-tall 16:9 crop).
- Very narrow Free crops are exported with the long side capped at 3840 px; the browser editor's preview canvas
  keeps its 128 px minimum side and may letterbox such extremes.
- The editor has no text animation, so hook animation is not offered. Zoom is the Inspector's scale and
  AI zoom events, not a separate manual tool. Effects/transitions remain unimplemented in the editor.
- Hook ranking is a quality judgement. Local suggestions can cover fewer than six categories; OpenAI needs
  per-request consent. Silent videos get no hook or caption suggestions.
- Estimated export size is a bitrate estimate (CRF encoding is content-dependent).
- Social import (Instagram/X) is unchanged and still behind its deployment approval flag.
- The laptop backend must stay online; CPU analysis and renders take minutes for long sources (≤180 s).
