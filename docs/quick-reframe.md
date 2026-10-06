# Quick Reframe AI (V2: crop first)

Implementation and acceptance report, 2026-10-07.

## The guided sequence

**Import → Analyze → 1. Crop → 2. Choose Style → 3. Edit (StyleOne or Manual) → 4. Export → History.**

`/quick-reframe` is a separate top-navigation page with its own concurrency-one BullMQ queue. It owns
a canonical `EditProject` but never creates Video, ProcessingJob, ClipCandidate or GeneratedClip rows,
never selects highlights, never shortens or splits the video, and keeps the original audio and timeline.
Quick Reframe projects are hidden from the editor's project list and appear only in Quick Reframe History.

A step indicator (`components/quick-reframe/step-indicator.tsx`) shows the active step. Earlier and
already-reachable steps are links back; nothing is lost by going back.

### 1. Crop (`crop-step.tsx`)

After upload the video is analyzed locally (faces/persons, scene boundaries, OCR at 1 fps, Whisper),
and a smart crop suggestion is saved as the first draft. The Crop step shows only crop and source-inspection
tools: a large playable preview, drag handles (corners and edges, mouse and touch), move, pinch zoom (Ctrl +
wheel on desktop), edge sliders (from top/bottom/left/right), shapes (Original, Free, 9:16, 4:5, 1:1, 16:9,
StyleOne window = 1080×700), Smart crop suggestion, Reset, Adjust/Preview-result toggle, and Cancel/Done.
OCR boxes are hidden unless **Show detected text** is turned on.

The crop is normalized (independent of screen size) and applies to the whole duration. The same
protections the server enforces are shown live and block Done: detected faces/persons, important
on-screen information, creator attribution and the video's own captions must stay inside the crop
(captions may be cropped only after explicitly choosing to replace them). Smart suggestions remove black
bars and decorative text, including headlines stacked in the top 40% above the picture, only where those
checks pass; removing empty bars may leave as little as 30% of the frame, otherwise at least 60% is kept.

**Clean overlays** lives inside the Crop step: localized blur or mask (cover) regions, timed, for videos
the user owns or may edit (rights checkbox). Detected attribution cannot be cleaned unless the user
explicitly selects it and declares it is their own branding. Regions overlapping faces or information
are refused. The crop preview approximates blur with CSS; the rendered result uses FFmpeg.

The draft autosaves (debounced) so a refresh keeps it. **Done** bakes the crop and cleanup into the
source (below) and opens step 2. **Cancel** restores the last confirmed crop.

### How the crop is stored (why it is never applied twice)

The canonical editor's own VIDEO crop pads the kept region back to the full source frame (a
letterbox), which would shrink the picture inside StyleOne's window and never produce a real cropped
canvas. So **Done** renders the confirmed crop/tracking/cleanup/denoise once (`quickCleanRender`,
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

"How would you like to edit your video?" offers **Apply StyleOne** and **Open Manual Editor**, plus the
caption situation (detected / missing / uncertain). Neither runs before the crop is confirmed (the API
refuses StyleOne, preview and export until then). Switching from Manual to StyleOne asks first; switching
from StyleOne to Manual offers "Keep StyleOne and edit" or "Start from the cropped video". Each switch is
one canonical revision, so editor Undo restores the previous composition.

### 3a. StyleOne (`styleone-step.tsx`)

Uses the actual StyleOne engine: `resolveCreativeStyle(AUTOMATIC_2)` → `compileCreativeStyle` →
`applyAssistantBundle` (one undoable `APPLY_ASSISTANT_EDIT` revision). `AUTOMATIC_2_STREET3_LAYOUT` stays
the only geometry source: black 1080×1920 canvas, fixed media window x=0 y=610 1080×700, EB Garamond hook
with semantic emphasis above it, white/lime active-word captions in its safe box. The bundle adds the
canonical `SET_VIDEO_FRAMING FIT`, so the whole confirmed crop is fitted inside the window (the editor
preview and the canonical camera both honour it); choosing the "StyleOne window" crop shape fills it
exactly. The hook is the Recommended suggestion (local unless OpenAI was authorized). Captions are
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

The Hooks tool contains:

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
`20261007010000_quick_reframe_v2` (additive). `plan` now holds only the crop-step draft (shape, crop,
tracking, cleanup, denoise); it never rewrites the timeline. `hooks` stores ranked category objects (old
string lists are still read). Sessions from V1 open on the Crop step with their previous crop as the draft.

## Verification (2026-10-07)

- Typechecks: shared, backend, frontend. Unit: `test-quick-reframe.cjs` (crop safety incl. repost
  headline/bars case, attribution, captions, URL validation, mask graph with real FFmpeg) and
  `test-quick-reframe-styleone.cjs` (baked-source identity, Manual canonical composition, actual StyleOne as
  one undoable revision with FIT, fixed canvas/window, preview/export parity, caption styles, six-category
  ranking, no composition after a failed crop).
- Live, `scripts/verify-quick-reframe-v2.cjs` (HTTP like the browser, outputs inspected, self-cleaning),
  on owned synthetic 27.2 s portrait "repost" fixtures (SAPI speech, black bars, headline, creator handle;
  one with burned-in subtitles):
  - Smart suggestion on the repost fixture trims bars and the headline (keeps y 0.307–0.800, handle and
    picture inside); with the test's side tweak the crop bakes 720×1280 → 690×616.
  - A StyleOne: 1080×1920 H.264/AAC 27.20 s; canvas black outside the window at start/middle/end; media window
    vs confirmed crop MAE 1.23–1.24 (0–255); serif hook ink; 15 generated captions; active-word highlight 1,945
    lime pixels at 3.72 s; original/export audio r=0.994 at −5 ms; History + re-edit.
  - Re-crop after styling: same SOURCE id and element ids, previous export marked stale; a crop that cut the
    creator handle was refused.
  - B/C Manual: OpenAI hooks (all six categories, one Recommended) applied with a fitted size, captions
    generated, Warm filter + saturation measured in the 720p export (806×720, the crop's shape; picture strip
    rgb 172,137,63 → 178,142,34), refresh keeps everything.
  - E Switching: StyleOne over manual edits is one revision; editor Undo restored the manual hook and colour;
    the confirmed crop key was unchanged.
  - D Existing captions: detected as readable, kept inside the crop, zero generated captions; StyleOne wrote its
    own local hook although no suggestions had been requested.
  - Identity crop: SOURCE points back to the original, no extra encode.
- `verify-quick-reframe-persistence.cjs` after a backend restart (crop, path, exports, History, hidden from
  the editor list, ranged playback; then deletion → 404 for export, cropped source and original) and
  `verify-quick-reframe-word-highlight.cjs`.
- Browser: `e2e/quick-reframe.spec.ts` (mocked; crop-first at 320–1440 px, OCR toggle, sliders, choose +
  switch confirmation, ownership gate, export resolutions) and `e2e/quick-reframe-flow.spec.ts` (live, real
  clicks: both full journeys including handle drag, refresh, download and History re-edit, and phone widths
  320–768 for crop handles, the editor's Hooks drawer with the keyboard, and export) — 9/9 passed.
- Regression: canonical editor scripts unchanged versus the pre-change baseline (the same two, phase7 and
  ai-objects, already failed on HEAD); generated-clip edit-project scripts pass; Create Clips journeys
  (`e2e/workflows.spec.ts`: XeeFree/StyleZero, XeePro/StyleOne, History → Edit → Ask AI → Undo → Export,
  delete, offline recovery) 5 passed, YouTube skipped (no authorized URL); editor/mobile/crop E2E 16 passed.
  `product-simplification` still expects an "Edit" desktop-nav link that the V1 commit replaced with Quick
  Reframe.

## Limits

- Smart crop and caption detection sample one frame per second and are confidence-based; moving or
  low-contrast text may need manual review. The crop preview shows tracking at its starting position.
- The editor has no text animation, so hook animation is not offered. Zoom is the Inspector's scale and
  AI zoom events, not a separate manual tool. Effects/transitions remain unimplemented in the editor.
- Browser previews of blur masks are approximations; the rendered preview is exact.
- Hook ranking is a quality judgement. Local suggestions can cover fewer than six categories; OpenAI needs
  per-request consent. Silent videos get no hook or caption suggestions.
- Estimated export size is a bitrate estimate (CRF encoding is content-dependent).
- Social import (Instagram/X) is unchanged and still behind its deployment approval flag.
- The laptop backend must stay online; CPU analysis and renders take minutes for long sources (≤180 s).
