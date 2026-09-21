# EditMode Phase 5 — render, export and EditMode QA

Phase 5 turns the canonical EditMode project state into an actual MP4. It adds no AI chat, no
conversational edit commands and no natural-language planner, and it does not touch the frozen
automatic clipping/rendering workflow.

A user can now edit by hand or apply a preset, see the canonical timeline, press **Export**, and get
a rendered, QA-checked video stored as `EditAsset(role: EXPORT)` that they can preview and download.

## Architecture

```
EditProject.revision + EditElement[] + EditAsset[] + settings   ← the canonical state, authoritative
        ↓
buildRenderPlan            deterministic, pure, no I/O and no LLM
        ↓
validateRenderPlan         every predictable failure, before a frame is encoded
        ↓
buildFfmpegArgs            one filter graph, derived only from the plan
        ↓
FFmpeg                     H.264 / AAC / MP4
        ↓
runEditModeQa              ffprobe + bounded event-driven frame sampling
        ↓
local repair → re-render   at most 2 full renders for a normal export
        ↓
MinIO  edit-mode/<projectId>/exports/<assetId>/final.mp4
        ↓
EditAsset(role: EXPORT)    with sourceRevision, QA result and render telemetry
```

Everything lives in `apps/backend/src/modules/edit-mode/render/`:

| file | responsibility |
| --- | --- |
| `edit-mode-render.types.ts` | the typed render plan, QA report, progress and error codes |
| `edit-mode-timeline-map.ts` | ordered source→timeline mapping (trim, split, delete, reorder) |
| `edit-mode-camera.ts` | shots, reframe policy, crop, fitted/information branches |
| `edit-mode-zoom.ts` | planned zoom intent → validated, bounded geometry |
| `edit-mode-ass.ts` | text, caption and hook rendering as one ASS file |
| `edit-mode-render-plan.ts` | builds the plan from canonical state + cached evidence |
| `edit-mode-render-validate.ts` | pre-render validation |
| `edit-mode-filtergraph.ts` | plan → the exact FFmpeg argument vector |
| `edit-mode-qa.ts` | post-render QA and repair selection |
| `edit-mode-render.service.ts` | orchestration, storage, EditAsset, progress |

## Isolation from the frozen pipeline

The render path never calls the processing queue, video processor, clip selector, clip render queue
or clip exporter; never creates a `ProcessingJob`, `ClipCandidate` or `GeneratedClip`; never enqueues
BullMQ work; and never calls an LLM. `apps/backend/src/modules/processing/**`,
`apps/backend/src/modules/videos/**` and `apps/backend/src/modules/projects/**` are unmodified, and
the automatic `AI_EDITED` renderer's defaults are untouched.

What *is* reused is the frozen editing intelligence as **pure callable logic**, never its
orchestration: `classifyFrames`, `ReframeService.plan`, `detectInformationRegion` /
`regionCropRect`, `zoomWindow`, `gradingFilter` / `sampleImageStats`, `buildSubtitlePhrases`,
`assTime` / `escapeAssText` / `sanitizeSubtitleText`, `estimateTextWidth`, `probeMedia`, and the
bounded frame/audio measurement helpers in `render-qa.ts`. EditMode instantiates `ReframeService`
locally rather than importing the editing module's injector graph.

Two automated checks hold this: `test-edit-mode-render.cjs` scans every file in `render/` (comments
stripped) for forbidden identifiers, and `test-edit-mode-export.cjs` asserts the frozen row counts
are unchanged across real exports.

## The render plan

```ts
{
  editProjectId, sourceRevision, sourceAssetId, presetId,
  canvas: { width, height, fps, aspectRatio, sourceWidth, sourceHeight },
  durationSec,
  videoSegments:   [{ elementId, sourceStart, sourceEnd, timelineStart, timelineEnd }],
  visualOverlays:  [{ elementId, assetId, role, x, y, width, height, startSec, endSec,
                      opacity, zIndex, preserveAspectRatio }],
  textOverlays:    [RenderTextOverlay],   // canvas pixels, exact stored wording
  subtitles:       [RenderTextOverlay],
  audioTracks:     [{ elementId, assetId, kind, startSec, endSec, trimStart, trimEnd,
                      volume, muted, fadeInSec, fadeOutSec, duck* }],
  frameSegments:   [{ shotIndex, startSec, endSec, layout, shotClass, frameMode, faceCount, reason }],
  zoomEvents:      [RenderZoomEvent],
  zoomRejections:  [{ triggerText, startSec, reason }],
  grading:         { policy, preset, strengthScale, filter },
  output:          { container, videoCodec, audioCodec, crf, preset, audioBitrate },
  policies, hasSourceAudio, subtitlesFromTranscript, warnings
}
```

There is no separate render-only timeline model. Every segment, overlay, caption and audio track is
derived from an `EditElement`; `settings` supplies only the policies.

## Timeline mapping

The canonical VIDEO track is an **ordered** list of source ranges. A trim changes a range, a split
produces two, a delete drops one and a move reorders them — so unlike the frozen pipeline (one clip
window plus a set of cuts) the EditMode timeline is not expressible as `clipStart + cuts`, and the
shared `createTimelineMapper` cannot describe it.

`buildTimelineMap` is the EditMode-local equivalent. It produces the ordered segment list plus
`toSource(t)` and `toTimeline(sourceSec)` — the latter returning *every* exported instant a source
instant survives at, so a range used twice maps twice and a deleted range maps nowhere. Cached
analysis frames and source shot boundaries are projected through it, and every segment join is
treated as a shot boundary even when the analysis saw no shot change.

Audio is trimmed from the same segment ranges as its video, so it stays in sync; multi-segment
exports get a 12 ms fade at each join so a hard cut does not click.

## Aspect ratio and canvas

| setting | canvas |
| --- | --- |
| `9:16` | 1080×1920 |
| `16:9` | 1920×1080 |
| `1:1` | 1080×1080 |
| `SOURCE` | the source shape, even dimensions, longest side capped at 1920 |

Square pixels throughout (`setsar=1`). The three fixed canvases are deliberately the same shapes the
frozen camera solver already solves for, so a tracked export uses its filter unchanged instead of a
rewritten approximation.

## Reframe

`reframePolicy` modulates — never replaces — what the evidence says:

| policy | behaviour |
| --- | --- |
| `SOURCE` | every shot keeps the whole source frame; a differently-shaped canvas letterboxes it over a blurred fill rather than cropping. A source already the canvas shape is a plain scale. |
| `AUTO` | the shot classifier's own FILL/FIT decision stands. |
| `FACE_FOCUSED` | shots with a real detected face are filled and tracked. A shot with no reliable face keeps the classifier's decision — no speaker is ever invented. |
| `INFORMATION_PRESERVING` | information shots are fitted to their detected readable region; face shots still get face-safe framing. |

A pair of faces too wide for the crop is fitted rather than cut in half. An information shot with no
*distinct* readable region (the content already fills the frame) falls back to the plain fitted
branch, never to a crop. A timeline with no cached analysis gets a centred camera and says so in
`warnings`.

## Semantic zoom

Phase 4 persisted **intent** (`settings.presetRun.plannedZoomMoments`, in source seconds). Phase 5
converts that intent into actual geometry and refuses the parts the footage does not support. It
never invents a zoom the plan did not ask for.

Bounded scales: `SUBTLE` 1.06, `MODERATE` 1.10, `STRONG` 1.15. The envelope is an eased rise into a
hold and a smoothstep return that sets the camera back down on 1.0.

A moment is rendered only when all of this holds: its trigger survived the cut; the whole move —
rise, hold and return — fits inside one shot with 120 ms clearance at both ends; the shot is a
cropped (`FILL`) people shot that allows zoom and is not an information shot; there is at least
1.2 s since the previous move and the 8-event budget is not spent; and at every sampled instant the
resulting window keeps each subject ≥ 95% visible with non-negative headroom and every
above-the-caption-band text box ≥ 95% visible.

When a move is unsafe the scale is reduced in 0.02 steps first, and only that one event is dropped
if it cannot be saved below 1.03. The zoom policy is never globally disabled, and every refusal is
recorded in `zoomRejections` with a reason.

## Grading

EditMode maps its own `gradingPolicy` onto the frozen grade-filter builder and decides for itself how
hard to push. The frozen `AI_EDITED` grading defaults are not modified.

| policy | preset | strength |
| --- | --- | --- |
| `NONE` | — | a true no-op (`null` filter; nothing is inserted into the graph) |
| `SUBTLE` | `CLEAN_SOCIAL` | 0.5 |
| `CLEAN` | `CLEAN_SOCIAL` | 1 |
| `WARM` | `WARM_TALKING_HEAD` | 1 |
| `CONTRAST` | `CLEAN_SOCIAL` | 1.35 |

Source statistics are sampled from the real file before the encode, so an already-graded or
near-clipping source is damped by the shared builder's own logic. Nothing LUT-like is applied: the
strongest EditMode grade lands around 1.05 contrast.

## Text, images and logos

Normalized element boxes resolve to canvas pixels, top-left anchored — the same convention the
editor preview draws. Text is sized at `fontSize × canvasWidth / 600`, which is exactly what the
preview's `cqw` sizing produces, so an overlay is the size on the exported frame that the editor
showed. The preview canvas now also honours `settings.aspectRatio`, so the two agree in shape.

Image and logo overlays honour `startTime`, `duration`, `x`, `y`, `width`, `height`, `opacity` and
`zIndex`; a `preserveAspectRatio` image is fitted and centred inside its box, matching the preview's
`object-contain`.

## Text and subtitle rendering

Every `TEXT`, `SUBTITLE` and preset `HOOK` element becomes one ASS event carrying its own stored
properties: content, timing, position, width, font family, size, weight, alignment, colour,
background (as an opaque ASS box) and opacity. **zIndex is the ASS layer**, so the canonical stacking
is what libass composites. Preset hook wording is rendered exactly as saved — nothing is regenerated
at export time.

Only fonts already in the backend image are used (`DejaVu Sans` / `Serif` / `Sans Mono`, resolved
through fontconfig); nothing is downloaded. Line breaks stored in the content are honoured, and each
resulting line is wrapped to the element's own width using the shared width estimate — breaks are
added, never words.

### Subtitles

Caption elements on the timeline are rendered verbatim. Where Phase 4 stored only the subtitle
*policy* (because the transcript yielded more caption lines than an editable track should hold, or
because it had no word timings to place them with), captions are generated at render time from the
same cached transcript using the same deterministic phrase logic: transcript-exact text, transcript
timings remapped onto the exported timeline, and each caption held at the end of its own segment so
one never plays over footage its words were cut from. A transcript with no word timings produces no
captions and a warning — never invented text.

## Audio and music

Source dialogue plus every `AUDIO` element, honouring `startTime`, `duration`, `trimStart`,
`trimEnd`, `volume`, `muted`, `fadeInSec` and `fadeOutSec`. Music is user-uploaded or licensed only;
no external music API is involved and no default track is selected.

Mixing is `amix … normalize=0` — element levels are exactly what the timeline set — followed by
`alimiter=limit=0.95`, so dialogue plus music cannot clip, and a short tail fade so the export does
not end on a click. A muted or zero-volume element is not even decoded. A source with no audio
stream exports a video-only file rather than fabricated silence.

**Ducking is deferred.** `duckUnderSpeech`, `duckLevel`, `attackMs` and `releaseMs` are parsed,
validated and carried on the render plan, but no ducking filter is applied in Phase 5 — a robust
speech-aware sidechain needs a speech-activity pass that would meaningfully expand this phase.

## Pre-render validation

Deterministically invalid state is caught before FFmpeg is invoked, as a typed error: missing source
or overlay/audio asset, unsupported media type, a source with no video stream, an invalid or
reversed trim, a trim past the end of the source, a gap or overlap in the timeline, an element
outside the project duration, negative timing, an element positioned outside the frame, empty text,
invalid typography or zIndex, a fade longer than its clip, an out-of-range volume, an impossible
zoom envelope, and a canvas that is not a valid video size.

## QA

EditMode-local, bounded, and classified as `PASS` / `DEGRADED_ACCEPTABLE` / `REPAIR_REQUIRED` /
`REJECT`. A visible correctness defect is never filed as acceptable degradation.

Checks: the output exists and ffprobes; expected resolution; duration within tolerance; a video
stream; an audio stream where one is expected; no negative timestamps; the final frame decodes; no
unexpectedly black/empty output; overlay bounds; caption bounds; subject safety; information-region
readability; and audio peak sanity.

Frame sampling is event-driven and bounded to 20 frames, round-robined across mandatory frames,
segment joins, zoom peaks, overlay start/end, caption transitions and shot changes, and decoded in
batches by the shared helper — no giant `select` expression is ever built.

### Repair

Pre-render validation is preferred; post-render repair is local and capped at **2 total renders**
(`EDIT_MODE_MAX_RENDER_ATTEMPTS`, hard-limited to 3). Every re-render logs why.

- a subject-safety failure **during an active zoom** → suppress that one zoom event
- a subject-safety failure with no active zoom → widen that one shot to a whole-frame fit
- an information-region failure → fit that one shot to its readable region

Nothing is disabled globally, and a failure with no applicable repair is a typed `QA_FAILED` rather
than a silently accepted export.

## Export lifecycle

`POST /edit-mode/projects/:id/export` validates the revision, refuses a duplicate concurrent export,
and returns immediately with the initial progress — the request never waits on an encode. Execution
is direct async work in the backend process: **no BullMQ queue and no EditMode-local queue was
added.**

Progress (`PREPARING → RENDERING → QA → UPLOADING → COMPLETED | FAILED`) is held in memory and
mirrored onto `settings.export` so a reloaded workspace can resume watching. That write does **not**
bump the revision and does **not** create an `EditHistory` row: rendering is not an edit, so undo and
redo are untouched by it.

Project status follows `READY`/`DRAFT` → `EXPORTING` → `COMPLETED`, or `FAILED`. Existing
`Project`/`Video` status semantics are unchanged.

### Endpoints

```
POST /edit-mode/projects/:id/export             start a render
GET  /edit-mode/projects/:id/export/progress    live or last-persisted progress
GET  /edit-mode/projects/:id/exports            every export, newest first
GET  /edit-mode/projects/:id/exports/:assetId   one export
GET  /edit-mode/assets/:assetId/file            the MP4, with range support (pre-existing)
```

### Typed errors

`SOURCE_MISSING`, `ASSET_MISSING`, `INVALID_TIMELINE`, `UNSUPPORTED_MEDIA`, `RENDER_FAILED`,
`QA_FAILED`, `UPLOAD_FAILED`, `STALE_EXPORT`, `EXPORT_ALREADY_RUNNING`.

## EditAsset(EXPORT), revisions and staleness

Each export is a **new** `EditAsset(role: EXPORT)` at
`edit-mode/<editProjectId>/exports/<assetId>/final.mp4`. Exports accumulate as v1, v2, v3 — a new one
never overwrites the asset a previous revision produced.

Its metadata records `sourceRevision`, `stale`, preset, aspect ratio, resolution, duration, codecs,
bitrate, file size, render duration, attempt count, applied repairs, the full QA report, the
policies, zoom counts (rendered / rejected / reduced), grading, element counts and warnings.

The export captures the revision at start. If the timeline moves while it renders, the asset is
still retained but is flagged `stale`, and the project is returned to `READY` rather than declared
`COMPLETED` — a stale render is never silently presented as the project's current result. Listings
compute `current` by comparing `sourceRevision` to the live revision, and the UI labels each export
accordingly.

## Frontend

`EditExportPanel` (`apps/frontend/src/components/edit-mode/edit-export-panel.tsx`): one **Export
video** button, a progress bar with the phase (`Rendering…` / `Checking quality…` / `Finalizing…`),
and a versioned list of finished exports with resolution, duration, size, codecs, a Current / From rN
badge, inline **Preview** and **Download**. The workspace is not redesigned.

Two pre-existing frontend defects were fixed because they broke this panel (and had been breaking the
Phase 2–4 source preview the same way):

- `editAssetPlaybackUrl` returned `SERVER_API_URL` during SSR — inside Docker `http://backend:4000`,
  a host the browser cannot resolve — so the `<video>` src hydrated to an unreachable address. URLs
  destined for the DOM now always use the public base.
- `EditHistoryPanel` rendered `toLocaleString()`, which differs between the server's timezone and the
  viewer's. The resulting hydration mismatch aborted hydration for the **whole page**, silently
  stopping every client effect in the workspace. Timestamps are now a stable UTC rendering.

The backend also now exposes `Accept-Ranges` / `Content-Range` / `Content-Length` via CORS, without
which a cross-origin `<video>` cannot seek a ranged response.

Preset PREVIEW remains a plan preview — changing a preset never triggers a render. There is no
separate always-on rendered-preview system; the editor preview stays lightweight and client-side,
and the real rendered output is previewed after an export.

## Determinism

An export is deterministic from `EditProject.revision` + `EditElement[]` + `EditAsset[]` +
`settings`. No LLM is called during export; all semantic planning happened in Phase 4. Source
analysis and transcription are never re-run — the export reads only what Analyze already cached, and
each asset is downloaded once per export and reused across attempts.

## Tests

| script | what it covers |
| --- | --- |
| `npm run test:edit-mode` | the whole EditMode suite, Phases 1–5 |
| `scripts/test-edit-mode-render.cjs` | offline: timeline mapping, video timeline, aspect ratios, reframe, zoom, grading, overlays, text/ASS, subtitles, audio, pre-render validation, bounded QA sampling, framing QA and repair selection, determinism and isolation |
| `scripts/test-edit-mode-export.cjs` | real FFmpeg renders through `EditModeRenderService`: full export, repeated exports, staleness, silent source, typed failures, "export is not an edit", isolation |
| `scripts/verify-edit-mode-export.cjs` | disposable real-media verification against the dockerized stack (Postgres + MinIO), with `--file`, `--aspect`, `--preset`, `--analyze`, `--keep`; cleans up every row and object it creates |

## Known limitations

- **Ducking is deferred** (properties preserved, no filter applied).
- The editor preview shows the source letterboxed in the correct canvas shape; it does not simulate
  the reframe crop, the zoom envelope, grading or burned-in captions. Those are seen in the exported
  file.
- Render-time captions use one built-in caption style rather than a per-preset caption design.
- Progress lives in one backend process; a restart mid-render leaves the last persisted phase and
  the export must be started again.
- A `SOURCE` export is capped at a 1920 longest side.
- `EditAssetRole.LOGO` was missing from the local dev database (a Phase 3 drift, not a Phase 5
  change). `npm run db:push` syncs it; no schema change was needed for Phase 5.
