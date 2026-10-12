# Editor: trim, zoom/pan, music and media (2026-10-12, committed to main, undeployed)

Focused pass over three Edit Mode controls. Nothing here changes StyleZero/StyleOne/StyleTwo visuals,
Content Intelligence, hook generation, crop logic, credits or auth. Acceptance evidence is at the end.

## Time origin (one convention)

* **Source time** – seconds in the uploaded video. Stored on VIDEO elements as `trimStart` / `trimEnd`.
* **Editor (clip-local) time** – seconds on the exported timeline, 0 = first frame of the first VIDEO
  segment. Every other element (`startTime`, `duration` of captions, text, images, music, zoom events) and the
  preview playhead are in this time. `duration = (trimEnd - trimStart) / speed`.

Example: source 105.0 s, trim start 100.0 s -> editor time 5.0 s. Nothing else is ever stored in source time
except `presetRun.plannedZoomMoments` (planner input, projected through the timeline map at render).

## One canonical trim

The canonical trim IS the VIDEO element's source range (`trimStart`, `trimEnd`, in seconds, no separate
`trimStartMs`). The timeline handles, the Inspector "Original source boundaries", split/delete, the preview
(`resolvePreviewPosition`), the render plan (`buildTimelineMap`) and the exported length all read it. Nothing
recomputes it: `origin.currentSourceStart/End` is a *copy* kept in step by the command layer
(`originBoundaryPatch`) after every VIDEO-track mutation; `origin.generatedStart/End` is never touched and is
the audit record of what the generator chose. The Inspector shows "Your trim. Originally generated: …".

A manual trim is a user edit: no analysis, Content Intelligence or hook generation is re-run. Trim errors are
refused in plain words (`INVALID_TRIM`: start before end, not shorter than 0.05 s, not past the source).

### Trim keeps everything attached to the footage

`retimeForVideoTrim` (edit-mode-transform.ts) maps every non-VIDEO element through SOURCE time. Cutting 3 s
from the head moves a caption at source 6 s from timeline 6 s to 3 s (it used to be *scaled* by the new length,
so it drifted); what falls outside the trim is clipped, wholly cut items are removed (Undo restores them),
zooms left shorter than they can settle (1.1 s) are removed, music keeps playing the same moment of the song
under the same footage (its read window advances by the cut prefix, as `adjustSourceRange` already did).
`retimeOverlays` (proportional) stays for SPEED changes only, where the footage really is stretched.

Styled projects persist time-keyed geometry beside the elements (`resolvedVisualLayout.cameraPath`,
`frameSegments`). The export re-plans the camera on the current timeline, so after any edit that moves footage
the persisted path is recomputed with the same planner (`refreshStyledLayout`), falling back to re-keying
through source time (Quick Reframe's fixed camera, or no cached analysis). One history revision restores both.

## One canonical manual zoom

`packages/shared/manual-zoom.cjs` is the only manual zoom math. A VIDEO segment stores `scale` (1 = none) and
`offsetX/offsetY`: the picture is scaled about the centre of its **window** (the whole canvas, or a card
layout's video window) and shifted by a fraction of that window. The pan is limited to `|scale-1|/2` so the
picture always covers the window; `SET_VIDEO_SCALE` re-clamps the stored pan in the same revision, and
`SET_VIDEO_POSITION` clamps to the current zoom. The preview (`manualZoomCss`) and FFmpeg
(`manualZoomFilter`) read the same stored values and the same clamp.

* Export applies it once, to the framed picture, time-gated to its segment (`edit-mode-filtergraph.ts`,
  "Manual zoom / pan"). It used to run on the raw source frame *before* the camera, which made the offsets
  mean "fractions of the source file" (3.2x the distance on screen for a 16:9 source in a 9:16 canvas) and let
  the camera slide it. A StyleTwo manual crop carries its own scale inside its crop geometry and is skipped, so
  nothing is applied twice.
* **Precedence:** a manually zoomed/panned segment owns its region. Automatic/template zoom events overlapping
  it are rejected (`MANUAL_ZOOM_OVERRIDES`, preview and export alike); elsewhere they are untouched. Automatic
  and manual zoom never multiply.
* UI: Inspector -> "Zoom and pan" (slider, − / + buttons, Pan X/Y limited to the stored range, Reset zoom),
  and dragging the picture in the preview when the segment is selected and zoomed. Phone Inspector drawer is
  the same component.
* Timed zoom events (`ADD_ZOOM`): a hand-placed zoom that overlaps another is refused (`ZOOM_OVERLAP`), one
  shorter than 1.1 s is refused (`ZOOM_TOO_SHORT`), trims keep or remove them as above.

## Music

Upload -> asset, "Add to timeline" / automatic add at the playhead, volume (0-200 %), mute, fades, source
window, ducking (real, from transcript word timings; disabled with the reason when unavailable), delete,
Undo/Redo, reload. Rules: music plays **once** (no loop): it stops at the end of its file or of the video and is
cut to the clip length when longer; it follows the footage through trims (above). Mix: source + music with
`amix normalize=0`, then `alimiter limit=0.95 level=disabled`.

Two export defects fixed: (1) `alimiter` auto-level re-scaled the signal to full scale after limiting, so a hot
mix clipped at 1.0 and every export was louder than its volume setting; (2) mono source/music was upmixed
−3 dB (`aformat=stereo`), so it exported quieter than the preview. 100 % now means "as recorded".

## Media (image / logo overlays)

Canonical normalized box (`x,y,width,height` of the canvas), opacity, z-index, rotation/flip/crop, start/end on
the editor timeline, delete. The export resolves the same box to pixels (an image keeps its shape and is
centred in its box, as `object-contain` in the preview). Overlays are an edit layer: template geometry is
untouched. Unsupported/unreadable uploads say which types work.

## Editing hygiene

A command that changes nothing (a slider released where it started, a field tabbed through) creates no revision
and no Undo step. Range sliders commit on pointer release, key release or blur, only when they moved.
Missing media at export fails with a plain message and never leaves the project in `EXPORTING`.

## Verification (all local, disposable data)

| Check | Command |
|---|---|
| Trim, retime, lineage, camera path | `node apps/backend/scripts/test-editor-trim.cjs` |
| Zoom/pan commands, precedence, graph, music/media plan | `node apps/backend/scripts/test-editor-zoom-media.cjs` |
| Real FFmpeg: trim, zoom, pan, music, overlay, undo/redo/reload, plain + StyleOne + StyleTwo, audio mix, failures | `node apps/backend/scripts/verify-editor-trim-zoom-media.cjs` |
| Real talking-head clip with the real StyleOne/StyleTwo compilers | `node apps/backend/scripts/verify-editor-real-clip.cjs` |
| Preview vs export pixels in Chrome (desktop + 390 px) | `node apps/backend/scripts/verify-editor-parity-browser.cjs [--dir …] [--viewport 390x844]` |
| UI flow through the real editor (desktop + phone) | `E2E_FRONTEND_URL=… npx playwright test e2e/editor-trim-zoom-media.spec.ts` |

Known limits: the Chrome tab cannot play audio headlessly, so music/source sync is measured in the export, not
in the preview; browser preview shows a *blurred* fit backdrop as a neutral colour (export blurs); gain above
100 % previews at 100 %; a StyleTwo manual crop keeps its own scale control (unchanged).
