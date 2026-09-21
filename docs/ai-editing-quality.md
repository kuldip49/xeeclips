# AI editing quality (EDITED_CLIPS)

EDITED_CLIPS turns a selected clip candidate into a publish-ready vertical short.
Clip discovery, scoring, Luna judging, boundary optimization, thresholds,
dedup/diversity and provider isolation are unchanged. NORMAL_CLIPS still exports
the selected range as a clean source clip.

Principle: **Luna decides what is editorially important; deterministic code
guarantees that it happens, then measures the rendered file.**

## Pipeline

```
selected candidate
 → padded source window (candidate ± 4 s)            clip-export.service.ts
 → dense clip analysis (AI service /edit-analysis)    edit-analysis.ts / edit_analysis.py
 → edit plan (Luna in ONLINE, deterministic otherwise) edit-plan.service.ts
 → boundaries + independent timeline                  edit-boundaries.ts, edit-timeline.ts
 → loop check                                         evaluateLoop()
 → shot classification + camera                        shot-classifier.ts, reframe.service.ts
 → word onset refinement, subtitles, hook             subtitle-renderer.service.ts, text-layout.ts
 → zoom plan + safety                                 zoom-planner.ts, subject-safety.ts
 → single-pass FFmpeg render (+ QA taps)              video-edit-executor.service.ts
 → render QA → quality gate → bounded repair          render-qa.ts, edit-quality-gate.ts
```

Luna (ONLINE only, role `editingPlan`, schema `clip_edit_plan_v2`) chooses the
hook, strong words, zoom trigger words, opening/payoff hints, grade mood, music
mood, loop suitability and whether information must be preserved. It never
produces geometry or exact timing. OFFLINE and FALLBACK_ONLY make no LLM call; a
deterministic editor picks statistics/names/long content words for emphasis and
at most one zoom.

## Timeline

`EditedTimeline` keeps `candidateStart/End`, `rawStart/End/Duration`,
`editedStart/End/Duration`, the removed ranges, and `segments`
(`sourceStart/End → finalStart/End`). The edited duration can be shorter or up
to 6 s longer than the raw clip (to finish a thought). Everything rendered is
mapped through this timeline: word events, zooms, shots, hook, music, QA frame
numbers. Telemetry stores the full map (`timelineSegments`).

Boundary rules: extend a mid-thought start to its sentence start (≤ 3 s); accept
Luna's later opening only at a sentence start (≤ 4 s); remove up to four weak
lead-in tokens (`so`, `well`, `um`, `you know,` …) but keep meaning-bearing ones
(`So many`, `Now that`); drop trailing fillers; keep an 80 ms pre-roll and a
280 ms tail (100 ms for loops). Internal pauses longer than 0.75 s keep 0.35 s
of silence; standalone disfluencies are cut with 30 ms margins; the total
internal removal is capped at 15 % / 4 s. Segment joins get 12 ms audio fades.

**Ending is a semantic decision, not a punctuation check.** A "clean" ending
needs terminal punctuation *and* not a trailing continuation phrase (`because`,
`but`, `and so`, `i told`, `the reason`, `guys like`, `what happens is`, …) —
those signal the clip cuts into another thought even if Whisper happened to
punctuate the last word. If the candidate end isn't clean, boundary repair
searches both directions for the nearest clean closure, escalating the window
in tiers (±3 s, then ±8 s, then ±15 s) only as far as needed, and only ever
extending up to the 120 s product max duration; if nothing is found it falls
back to the best available (still word-accurate) cut and reports
`endRepairAttempted` / `endRepairSucceeded` so a truly unresolvable case is
visible in telemetry rather than silently accepted. `clipEndComplete` /
`clipEndNatural` (and the underlying `endSemanticComplete` /
`endNotContinuation` / `endThoughtResolved`) reflect this; the final render
also gets a short (≤150 ms) speech fade at the very end so the cut reads as
deliberate rather than abrupt — safe because the tail always sits past the
last spoken word.

## Visual intelligence

`/edit-analysis` decodes the window, detects shot cuts frame-accurately (colour
and luminance histograms plus pixel change), and at 4 fps runs BlazeFace on the
full frame and three upper crops (small faces), a face-landmark mouth-openness
signal per face (→ `mouth_activity`), YOLO persons (2 fps, plus face-less frames),
text-line regions, and OCR on the middle frame of up to four face-less or
text-heavy shots. Faces get IoU/centre track ids; tracks end at shot cuts.

Shot classes: `SINGLE_SPEAKER`, `TALKING_HEAD`, `TWO_PERSON`, `GROUP_SHOT`,
`WIDE_SHOT`, `B_ROLL`, `WEBPAGE`, `ARTICLE`, `DOCUMENT`, `CHART`,
`PRESENTATION`, `SCREEN_RECORDING`, `FULL_FRAME_INFORMATION`, `OTHER`.
Information shots (text coverage ≥ 10 % or ≥ 12 OCR words without a dominant
face), groups, and two people who do not fit the crop use **FIT** (whole source
frame over a darkened blur) and never zoom. Captions move below a fitted frame.

The camera (FILL) holds a stable crop inside a dead zone, needs two samples (or a
speaker-turn signal) and a 1.5 s minimum hold before switching subjects, frames
both faces in two-person FILL shots, and jumps (no pan) exactly at a shot cut.

## Layout and look

`INSTAGRAM_REELS` / `EDITORIAL_FRAME` at 1080×1920: header 0–340, video viewport
360–1540, footer 1540–1920. The source video stays sharp and centred in the
viewport; header and footer extend the atmosphere of the running shot.

- **Scene palettes.** One small decode of the edited span (2 fps, 32×32) gives a
  palette per shot (dominant/secondary colour, brightness, saturation,
  warm/cool). Consecutive shots whose rendered header/footer colours differ by
  less than 12 RGB units, and shots shorter than 1.2 s, share one palette, so the
  frame changes colour only on meaningful scene changes. Colours are desaturated
  and darkened until white text reaches 7:1 contrast.
- **Tint track.** Each palette is a top/bottom colour card on the final timeline;
  cards cross-fade over 400 ms centred on the scene change (header = top colour,
  footer = bottom colour).
- **Ambient extension (`SOFT_BLUR_EXTENSION`, default).** The running footage is
  scaled to 216×384, Gaussian-blurred (σ 9), temporally smoothed over 11 frames
  (cuts become ~⅓ s dissolves, motion calms down), luma/chroma scaled to 55 %,
  mixed 50/50 with the tint track and scaled up to 1080×1920. `SOURCE_MATCH_GRADIENT`
  and `DARK_NEUTRAL` plans render this way too; `SOURCE_MATCH_SOLID` shows the
  solid tint only. Repair falls back ambient → plain gradient → neutral palette.

Grading is unchanged by the background choice.

Grading measures brightness, contrast, saturation, clipping and colour cast.
Presets: `CLEAN_SOCIAL`, `WARM_TALKING_HEAD`, `COOL_DOCUMENTARY`,
`NEUTRAL_EDUCATIONAL`, `SOURCE_ALREADY_GRADED` (forced for high-contrast or
saturated sources; minimal change), and `NO_CHANGE` (forced when the source is
already well-exposed, controlled highlights/shadows, natural saturation and no
white-balance cast — a true identity filter, not a light touch). Exposure is
applied through gamma so blacks are not lifted. QA adds conservative-grading
signals (`exposureNatural`, `highlightSafe`, `shadowSafe`, `saturationNatural`,
`whiteBalanceNatural`, `gradingNotOverprocessed`) alongside `gradingApplied`,
all enhancement-severity: they confirm the render stayed within the "correct,
don't stylize" brief regardless of which preset was picked.

## Hook and subtitles

The hook is fitted to the header zone (x 100–980, y 34–306, vertically centred
in the header; deterministic shortening), then re-measured with a libass render of
the same ASS file and refitted up to four times. In the editorial frame it is an
uppercase headline (Noto Sans Bold, ≤ 96 px, +1 letter spacing, 3 px outline,
soft 3 px shadow), preferably two balanced lines (one line costs a little for 4+
words, a third line costs more). It fades in and rises 12 px over 220 ms, then
stays locked in one position until the last frame; QA samples it after that
settle time. If a hook is required but cannot be verified in the rendered file,
the gate fails.

Subtitles use the transcript words verbatim, 2–5 word phrases, Noto Sans bold
99 px with a dark outline, lower-middle of the viewport, at most two lines inside
830 px. Each word event runs until the next word starts (no flicker) and is placed
on the output frame grid. The active word pops to 110 % in the accent colour;
Luna/deterministic keywords stay in the keyword colour and pop to 112 % (at most
two keywords per phrase, STRONG first; emphasis repair uses 112/114 %).
Before rendering, word starts are snapped to clean audio onsets measured in the
source window (only offsets within −120/+250 ms; consistent median applied to
the rest).

Caption placement is shot-aware. Under FIT shots captions sit below the fitted
frame. Otherwise the stored OCR text regions of that moment (lower thirds,
banners, logos, chart labels, burned-in captions), mapped to canvas pixels, are
intersected with the caption box: above 6 % coverage the caption moves just above
or below the text, or 12 %/20 % of the viewport higher, never onto a face and
never above 40 % of the viewport; otherwise it stays in its normal lower-middle
position. Telemetry: `subtitleCollisionDetected`, `subtitlePositionAdjusted`,
`subtitleCollisionAreaRatio`.

## Zoom

A zoom starts 60 ms after the trigger word onset, ramps for 0.3 s (peak near the
stressed word), holds 0.35–0.9 s, and returns to 1.0 over 0.45 s. Scale
1.16 (1.18 for STRONG words, up to 1.22), minimum visible 1.12, at most three, at
least 2.3 s apart. The hold is shortened to finish before a cut or shot change.
The anchor centres the subject; the scale is reduced until the padded face(s)
and any readable burned-in text stay ≥ 98 %/90 % visible, otherwise the zoom is
rejected (`SUBJECT_UNSAFE`, `TEXT_UNSAFE`, `INFORMATION_SHOT`, …).

## Audio

Speech: 70 Hz high-pass, 2.5:1 compression, loudnorm −16 LUFS / −1.5 dBTP.
Music comes only from the manifest in `EDIT_MUSIC_DIR` (default
`apps/backend/assets/music`, generated at image build by
`scripts/generate-music-library.cjs`); tracks must declare an allowed license
(`GENERATED_IN_HOUSE`, `LICENSED`, `ROYALTY_FREE_APPROVED`, `CC0`,
`ROYALTY_FREE_LICENSED`). The bed is levelled (~−30 to −32 LUFS), faded in over
0.5 s and out over 1.8 s, and sidechain-ducked under speech (measured
27–32 dB below speech while words are spoken). Speech stays dominant (≥ 10 dB is
a hard gate).

Moods: `SUBTLE_DOCUMENTARY` (podcast/interview/news), `DOCUMENTARY_TENSION`
(debate/politics), `CLEAN_NEUTRAL` (education), `MODERN_MINIMAL` (technology),
`ENERGETIC_LIGHT`, `CALM_WARM`, `ATMOSPHERIC`, and `NONE`. Luna picks the mood
as an editorial call — `NONE` is a legitimate, final answer for serious,
solemn or dense content where any bed would compete with the voice, not
something the render layer overrides back to a default; the deterministic
editor's keyword fallback also returns `NONE` for grave subject matter
(death, tragedy, abuse, …). `musicDecision` (`USE_MUSIC` / `NO_MUSIC`) records
that call in telemetry. Selection tries the mood, then related moods, then any
track; within a mood the highest `priority` tier wins (generated beds default
to 0, other licenses to 10), the clip's range key spreads clips across that
tier, and a track used recently on the same source video is skipped in favor
of an alternative when one exists (`musicReusePenalty` / `musicVarietyValid`
report whether a repeat was unavoidable). To add approved music, drop files
into `EDIT_MUSIC_DIR` and list them in `library.json` with `id`, `file`,
`title`, `moods`, `license`, `loudnessLufs`, and optionally `priority` and
`attribution`.

`EDIT_MUSIC_REQUIRED` defaults to **true**, but only ever forces a bed when
the editorial mood actually asked for one (i.e. it never overrides an explicit
`NONE`); a missing library then uses a generated in-graph pad. NORMAL_CLIPS
never run this path and stay music-free. When music is required, the repair
ladder is: another track (−5 dB) → the generated pad → no music, which marks
the edit **DEGRADED** (`musicPresentWhenRequired`), never a silent "fully
edited" clip.

## Render QA, gate and repair

The render graph writes the final MP4 plus QA taps (ungraded viewport, speech
stem, ducked music stem). Measurements on the output:

- hook/subtitle: libass probe masks compared with output pixels (rendered,
  inside safe zone, contrast, active/keyword colours visible);
- sync: speech onsets vs. rendered subtitle starts (median residual, spread,
  average, p95) plus frame-grid error;
- zoom: scale estimated from before/peak/after frames of the same shot;
- background: header/footer colour vs. the tint (or tint + darkened footage for
  the ambient mode) at four frames, not flat black, and the step across every
  palette crossfade midpoint vs. the total change (≤ 60 %);
- hook: glyph bounds identical at settle/middle/last frame, inside the header,
  line height from the mask's row profile;
- captions vs. burned-in source text: rendered caption bounds vs. OCR regions;
- grading: ungraded tap vs. final viewport deltas and direction;
- audio: loudness, clipping, A/V offset, music presence, speech-to-music dB,
  fade-in/out depth on the un-ducked bed (≥ 6 dB);
- geometry: subject visibility/headroom, two-person and information preservation.

Checks declare applicability first. Baseline failures (video/audio/duration,
hook, subtitle render/coverage, consistent sync offset, subject visibility
< 80 %, two-person/information preservation, background, speech dominance,
required music) make the edit **FAILED**. Enhancement failures (keyword/animation
visibility, zoom visibility/timing, grading, loop, opening/ending quality) make it
**DEGRADED**. Polish checks: `backgroundSourceMatched`, `backgroundNotGenericBlack`,
`backgroundTransitionSmooth`, `hookTypographyReadable`,
`subtitleSourceGraphicCollisionSafe`, `musicRendered`, `musicPresentWhenRequired`,
`musicMoodSelected`, `musicFadeInValid`, `musicFadeOutValid` and the composite
`finalVisualCohesionPass` are enhancements; `hookPositionStable` and `hookSafe`
are baseline. One full render is the normal path. The optional second render is
reserved for a repairable baseline failure or a deterministic severe grading-safety
correction; ordinary enhancement misses remain honestly **DEGRADED**. Subtitle timing
is preflighted before encode. A post-render quality failure is not sent through a
second deterministic plan, because that would discard the first encode without
changing its source evidence. The UI marks DEGRADED clips as "Partial polish".

Pre-render validation classifies each candidate as `READY`,
`REPAIRABLE_PRE_RENDER`, or `SKIP_BEFORE_RENDER`. It covers timeline/start-context,
camera hard-cut/reset/final-settle structure, face/crop validity, information-crop
bounds, and safe zoom coverage. Job telemetry records render/repair/rejection counts,
`wastedRenderMs`, time to first/second/all clips, and per-candidate plan, validation,
render, QA, repair, and total time. A grading retry additionally records before/after
checks and metrics, predicted/actual improvement, reason, and render time.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDIT_DENSE_ANALYSIS_ENABLED` | `true` | call `/edit-analysis` |
| `EDIT_ANALYSIS_FPS` | `4` | dense sampling rate |
| `EDIT_ANALYSIS_TIMEOUT_MS` | `300000` | request timeout |
| `EDIT_MUSIC_ENABLED` / `EDIT_MUSIC_REQUIRED` | `true` / `true` | music policy (EDITED_CLIPS only) |
| `EDIT_MUSIC_DIR` | `assets/music` | licensed library |
| `AI_EDITED_RENDER_CONCURRENCY` | `2` (1..4) | bounded candidate render workers |
| `FFMPEG_THREADS_PER_RENDER` | CPU-aware | threads assigned to each concurrent render |
| `MAX_FULL_VIDEO_RENDER_ATTEMPTS` | `2` | expensive full-video repair ceiling |
| `EDIT_MAX_RENDER_ATTEMPTS` | `2` | legacy alias for the repair ceiling |
| `EDIT_RENDER_PRESET` | `veryfast` | x264 preset |

## Tests

```bash
cd apps/backend
  npm run test:edit-quality        # timeline, boundaries, hook, shots, zoom, QA math, preflight and gate
npm run test:editing             # legacy editing unit tests
npm run test:editing-media       # executor + FFmpeg + QA on synthetic media
npm run test:editing-benchmark   # 9 golden scenarios vs scripts/fixtures/editing-benchmark-baseline.json
docker exec -w /app/apps/backend ai-content-backend \
  node scripts/verify-edited-clips.cjs --limit 4 --mode FALLBACK_ONLY   # real videos, disposable
```

`verify-edited-clips.cjs --mode ONLINE` uses the configured Luna provider.

## Known limits

- Speech-onset measurement on real audio is noisy (breaths, soft consonants);
  sync QA fails only on a consistent offset and reports averages/p95 separately.
- Mouth activity is a landmark-openness heuristic, not audio-visual speaker
  diarization; two comparable faces that do not fit the crop are shown with FIT
  rather than cutting between speakers.
- Source videos with their own large captions/graphics are protected from zoom
  and caption overlap, but not removed.
- Music beds are procedurally generated ambience (11 beds, 7 moods); add
  licensed tracks through `library.json` (with `priority`) for richer scoring.
- Caption/source-text avoidance relies on the dense analysis OCR regions (4 fps);
  text that OCR misses is not avoided.
