# Project State

Last updated: 2026-09-28

## Milestones

- Milestone 1: complete
- Milestone 2: complete
- Milestone 3: complete
- Milestone 4: complete
- Milestone 5: complete
- Milestone 6: complete
- AI Editing Quality (EDITED_CLIPS): complete — see `docs/ai-editing-quality.md`
- EditMode Phase 1–3 (foundation, manual timeline, assets/overlays): complete — see
  `docs/edit-mode-phase3.md`
- EditMode Phase 4 (presets + no-prompt auto edit): complete — see `docs/edit-mode-phase4.md`
- EditMode Phase 5 (render, export, EditMode QA): complete — see `docs/edit-mode-phase5.md`
- EditMode Phase 6 (AI chat editor): complete — see `docs/edit-mode-phase6.md`
- Unified AI video editor (Steps 5–25): see "Unified AI Video Editor" below

## Product Flow — Analysis-First, Platform-Aware Clip Creation

- User flow: choose target platform (`INSTAGRAM_REELS` / `YOUTUBE_SHORTS` / `TIKTOK`, stored on
  `Video.targetPlatform`) → upload → the pipeline analyzes only (no rendering) → choose output style
  (`NORMAL` / `AI_EDITED`) and a clip count → the backend picks, cuts and renders the best N clips.
  No processing-type, aspect-ratio, duration, or recommendation controls in the main UI.
- Source limit: 7200 s. Rejected at upload (best-effort ffprobe, HTTP 400 `VIDEO_TOO_LONG`) and in
  the worker right after `INSPECT_MEDIA` (non-retryable `VIDEO_TOO_LONG`), before transcription.
- `maxClipCountForDuration` (`clip-selection-policy.ts`): ≤10 min → 6, <15 min → 8, 15–60 min → 12,
  >60–120 min → 20, >120 min → 0 (rejected). UI counter defaults 3/4/6/8 are conveniences only.
- Final clip duration is 15–120 s (`MAX_CLIP_DURATION_SECONDS` raised from 60); each clip's range
  comes from candidate generation + `optimizeClipBoundaries` (and edit boundaries for AI_EDITED).
- Hard usability gate (`evaluateCandidateUsability`) is separate from quality ranking: valid range,
  inside the source, 15–120 s, not `reject`, ranked (not a duplicate), ≥20 words, ≥0.6 words/s,
  ≥55% non-filler words. PRIMARY ≥75 / SECONDARY ≥60 remain telemetry only; scores are never changed.
- Best-N (`rankUsableCandidates`): contentPotential desc → rank → start; greedy dedup (overlap
  >0.4 or text similarity >0.78). Selecting N is always the first N of this list, so the order is
  stable across requests. Render failures skip to the next usable moment.
- Pool sizing: `aiShortlistLimit` ≥ 1.75 × max clips; creative shortlist ≥ max clips; the top
  max-clips usable candidates get creative generation regardless of tier.
- Candidate expansion (only when usable < requested): deterministic `generateCandidateRanges` over
  persisted chunks + boundary optimizer + `fallbackContent`, zero LLM calls, persisted with
  `evidence.candidateExpansion = true` and always ordered after the analysis pool.
- API: `POST /videos/:id/clip-selection { requestedClipCount, outputStyle }` (legacy `count`
  accepted) validates 1..max, requires a COMPLETED analysis job, records `outputStyle`,
  `requestedClipCount`, `maxClipCount`, `clipRenderStatus` on `ProcessingJob`, and renders on the
  `clip-rendering` BullMQ queue (`ClipRenderQueueService`, `CLIP_RENDER_CONCURRENCY`, default 1). `GET /videos/:id/clip-analysis` (status, max/default count, availability, request
  state) and `GET /videos/:id/clip-results` (ordered clean cards: hook, synopsis, caption,
  hashtags, `aiModeUsed`). Telemetry lives in `ProcessingJob.telemetry.clipSelection`.
- AI mode label: only the job's `effectiveAiMode` decides it: ONLINE → Online, OFFLINE/LOCAL_LLM →
  Local, FALLBACK_ONLY (or unknown) → Fallback. Deterministic fallback/repair of one candidate inside
  an ONLINE job still shows Online; component-level fallback stays in backend telemetry.
- Render state is persisted, never in memory: `clipRenderStatus` IDLE/QUEUED/RENDERING/COMPLETED/
  FAILED, `clipRenderError` (safe user message), `clipRequestedAt` (request identity), and
  `clipRenderStartedAt`. QUEUED is claimed with a conditional update before dispatch; the worker
  sets RENDERING, then COMPLETED/FAILED. Worker writes are guarded by `clipRequestedAt`, so a
  superseded request never overwrites a newer one. Queue job id is
  `clips-<processingJobId>-<requestedAt ms>`, so resending a request never enqueues a duplicate.
- Idempotent `POST /clip-selection`: an identical active request returns its state (and re-adds the
  same queue id); an identical COMPLETED request with every clip delivered returns without
  dispatching; a different request while active → 409.
- Restart recovery: BullMQ redelivers a stalled job, and the worker resumes a RENDERING request.
  A QUEUED/RENDERING request older than `CLIP_RENDER_STALE_MS` (default 120000, measured from
  render start or request) with no live queue job becomes FAILED "Clip creation was interrupted.
  Please try again." It is checked at startup and on every analysis/results read. Live or unknown
  queue state (Redis unreachable) is never recovered.
- Normal clips are always 1080x1920: the full source frame fits (FIT) over a blurred copy of the
  source, with no black bars and no source-aspect option. No hook, subtitles, music, grading,
  zooms, or edit plan. AI_EDITED passes `targetPlatform` to the edit plan (`platformPreset` + soft
  platform guidance).
- Output variants: `GeneratedClip` is unique on `(videoId, rangeKey, variantKey)` with
  `variantKey = <processingType>:<targetPlatform|DEFAULT>`, so Normal and AI Edited renders of the
  same moment coexist (`candidateId` is no longer unique). A valid existing variant is reused
  without downloading or rendering. A pre-9:16 source-aspect Normal render is replaced.
  `clip-results` lists only the currently requested variant.
- Normal workspace shows the upload, clip panel, and result cards only. Stage, media, transcript,
  understanding, and chunk panels render only with `SHOW_DEVELOPER_DIAGNOSTICS=true` (server-side
  env on the frontend, default off) via `developer-diagnostics.tsx`.
- Migrations `20260918000000_analysis_first_clip_flow` (additive) and
  `20260919000000_clip_output_variants` (enum values, `clipRenderStartedAt`, GeneratedClip
  `targetPlatform`/`variantKey` backfilled from the video, unique index swap). Tests:
  `scripts/test-clip-selection-flow.cjs` (lifecycle, idempotency, stale recovery, AI mode label,
  variant results), `scripts/test-clip-export.cjs` (variant coexistence/reuse, blurred 9:16 canvas
  with real FFmpeg), `scripts/test-clip-ui.cjs` (no diagnostics in the workspace).

## AI Editing Quality — EDITED_CLIPS

Clip discovery/selection is unchanged (frozen). Only the EDITED_CLIPS export path changed;
NORMAL_CLIPS still renders the selected range with no edit plan.

- The candidate is source material. The exporter cuts a padded source window
  (candidate ± 4 s) and the edit gets an independent `EditedTimeline`
  (`candidateStart/End`, `rawStart/End/Duration`, `editedStart/End/Duration`,
  `segments` = source → final map). Every timed layer (words, zooms, shots, hook,
  music, QA) goes through that map. `GeneratedClip.startTime/endTime` store the
  edited source bounds for edited clips.
- Deterministic boundaries (`edit-boundaries.ts`) are **scored, not sequential**.
  The module builds several openings and several endings inside the padded window
  and picks the pair that reads as one narrative unit (strong open → enough
  context → payoff → clean close), rather than applying a fixed chain of edits to
  the selected range.
  - Openings: the selected start, the sentence start behind it, Luna's
    `hookStartSec`, and — only when the selected opening is itself weak (a
    disfluency/discourse marker, an unresolved pronoun, or housekeeping such as
    "let me explain") — the sentence starts ahead of it. Weak lead-in removal is
    applied to every candidate before scoring, so the comparison is between
    finished openings (still never cutting words, still guarded against
    meaning-bearing "So many"/"Now that").
  - `scoreOpening` weighs attention strength, context completeness, speech
    naturalness, first-sentence strength, curiosity, emotional pull and payoff
    setup against filler/silence/continuation/unresolved-pronoun penalties. The
    shift penalty is **asymmetric**: moving the opening later costs ~3× moving it
    earlier, because going back adds context the viewer needs while going forward
    throws away the setup the payoff rests on.
  - Endings: the selected end, Luna's `payoffEndSec`, every clean closure in both
    directions inside the tiers (±3 s → ±8 s → ±15 s, backward trims still capped
    at `maxEndTrimSec`), and the last clean closure before a new topic begins.
    `scoreEnding` weighs semantic completeness, natural cadence, payoff strength,
    topic closure and context resolution against abruptness, continuation, dead
    air, unresolved-question and **new-topic** penalties (§16: end after "This
    changed the entire market.", not into "Anyway, the next thing…"). Backward
    trims cost ~2.5× forward extensions, since trimming drops delivered content
    while extending only finishes a thought already started.
  - The selected boundary always stays in the pool and only loses to an
    alternative that beats it by a margin (0.75), so scoring noise never moves a
    clip that was already well cut. `SELECTED_END_UNRESOLVED` is a real reported
    outcome, not a silent inheritance.
  - Endings are judged semantically, not just by punctuation: a trailing
    continuation phrase ("because", "and so", "i told", "guys like", …) is never
    treated as complete. **Whisper does not always punctuate** — a real transcript
    can run 30 s with no full stop — so when the search window contains no
    punctuated closure at all, a pause ≥ `sentenceGapSec` becomes a usable
    closure with partial credit. That distinction drives severity below.
  - First-word safety: `clampStart` targets ~100 ms of pre-roll but never passes
    the word's own onset. When Whisper's previous word ends into this one the
    pre-roll is simply shorter — that is a source limitation, reported as
    `firstWordPreRollAvailableMs`, not an edit defect.
- Luna's editorial role (`EDIT_PLAN_SCHEMA`) now also carries
  `openingStrategy.contextRequiredFromSec` (the earliest second a cold viewer
  needs) and `endingStrategy.newTopicBeginsAfterSec` / `endingComplete`. As with
  every other hint, deterministic code validates them against the window and
  snaps them to word boundaries; a hint that lands nowhere near a word is ignored
  rather than snapped.
- Ending severity (`endingDefectSeverity`) decides whether a bad ending blocks
  delivery. `SERIOUS` (→ BASELINE gate failure) means the defect is **provable**:
  the clip ends on a continuation marker, or on neither punctuation nor a pause.
  An unpunctuated transcript is a measurement gap, not proof, so it degrades
  (`MINOR`) instead of failing a clip that may well be fine. An unfinished
  sentence no longer quietly receives PASSED.
- Start/end quality gate checks: `clipStartStrong`, `clipStartNatural`,
  `clipStartContextComplete`, `clipFirstWordNotClipped` (BASELINE),
  `firstWordPreRollNatural`, `weakLeadInRemovedOrJustified`, `hookStartAligned`,
  `clipEndComplete`, `clipEndNatural`, `clipEndNotContinuation`,
  `clipEndNoNewTopicLeak`, `deadAirAtEndAcceptable`, `audioTailNatural`,
  `lastSubtitleComplete`, `cameraSettledAtEnd`, `zoomSettledAtEnd`.
  `clipEndPayoffDelivered` is reported but **not required** — "did this land a
  payoff" is a lexical guess, and a clip that finishes its thought well must not
  be degraded for it. `cameraSettledAtEnd` allows up to 2.5 % crop-width movement
  over the final 0.4 s: it catches a reframe still in progress, not the
  sub-percent drift the stabilizer always carries.
- Boundary repairs run in the optimizer **before** a frame is rendered, so they
  never enter the render repair loop (which could not change a word boundary
  anyway and would only re-render the same clip). `BoundaryRepairAction` names
  them for reporting; `openingRepairAttempted/Succeeded` and
  `endRepairAttempted/Succeeded` record what the cascade had to do.
- Content package ↔ final boundaries (§35/§36): boundary optimisation can add or
  drop the very lines a headline was grounded in, so after the boundaries settle
  the already-generated hook candidate pool is re-scored against the delivered
  transcript (`EditPlanService.realignHook`). No extra model call — when the
  boundaries did not move, the deterministic scorer returns the same headline.
  `hookRealignedToFinalBoundaries` records when it changed.
- Boundary telemetry for the later analytics loop: `originalStartSec`,
  `optimizedStartSec`, `startAdjustmentSec`, `openingStrategy`, `openingScore`,
  `openingScoreComponents`, `openingCandidates`, the same six for the ending,
  plus `contextExpandedSec`, `weakLeadRemovedSec`, `payoffPreserved`,
  `newTopicTrimmed` and `endingDefectSeverity`. Strategies are named
  (`QUESTION_OPEN`, `COLD_OPEN_PAYOFF`, `SURPRISE_OPEN`, `CONFLICT_OPEN`,
  `STORY_OPEN`, `INSIGHT_OPEN`, `CONTEXT_OPEN`; `PAYOFF_CLOSE`,
  `CONCLUSION_CLOSE`, `SENTENCE_CLOSE`, `NEW_TOPIC_TRIMMED`, `UNRESOLVED_CLOSE`)
  so real publishing performance can later be correlated against them. No
  invented "virality" score is recorded anywhere in the decision.
- Not implemented: the §23 micro-cold-open (a short payoff excerpt spliced ahead
  of the chronological clip). The spec marks it optional and warns against
  forcing it; it would need duplicate-speech detection in the subtitle and
  timeline layers to be safe, so it stays deferred rather than half-built.
- Dense clip-local analysis: `POST /edit-analysis` (AI service) returns 4 fps
  multi-scale face boxes with track ids and mouth activity, YOLO persons, text
  regions, per-shot OCR and frame-accurate shot boundaries. Falls back to stored
  chunk analysis (`STORED_SPARSE`) when unavailable.
- Shot classification (`shot-classifier.ts`) → FILL (crop) or FIT (whole frame
  over blurred fill) per shot; two people who do not fit and all information
  shots (webpage/article/document/chart/presentation/screen) use FIT and allow no
  zoom. Information shots are **fitted to their information region, not to the
  whole frame** (`information-region.ts`): fitting a 16:9 source into the 9:16
  viewport leaves a ~608 px letterboxed band in which the content is technically
  preserved and practically unreadable. `detectInformationRegion` takes the
  bounding box of the detected text and graphic structure over the information
  shots, drops outlier boxes that lie outside the dense area-weighted core and
  carry < 6 % of the detected area, pads it, and grows it toward the viewport's
  aspect ratio wherever there is room. The region is then cropped and fitted, so
  the content renders at the largest scale the viewport allows. Nothing detected
  is ever cut off (`informationRegionCoverage` must be 1); the crop is skipped
  when the content already fills the frame or the gain would be < 1.12, and the
  `INFORMATION_FIT` repair drops back to the whole-frame fit. Information shots
  and plain FIT shots composite through separate branches with their own `enable`
  expressions, since a single FFmpeg crop cannot change size over time. Caption
  placement and burned-in-text mapping follow the region's geometry.
  `informationReadable` (ENHANCEMENT) reports the outcome; measured on a real
  screen-heavy render: region gain **2.35×**, rendered height **1246 px vs. 608 px**
  for a whole-frame fit, coverage 1, `informationPreserved` true. The camera re-evaluates instantly at every shot boundary, frames pairs in
  two-person FILL shots, and uses hysteresis/min-hold for speaker switches.
  Subject changes cut or settle, they never drift: a shot cut jumps exactly at the
  cut, a speaker switch eases over 0.16 s (0.07 s when the move exceeds half the
  crop width, which would otherwise drag the frame across the other faces), and
  for 0.9 s afterwards the camera targets the new subject directly over 0.18 s
  instead of creeping toward them with the 0.65 s same-speaker easing — that creep
  was what read as the frame "rolling" after a character change.
  `shotSwitchMotionSmooth` (plus `cameraMoves`, `longestSwitchMoveSec`,
  `longPanCount`) measures it.
- Camera motion (`zoom-planner.ts`): every move is an editorial event, never
  decoration. An operation with no `reason` is rejected (`NO_SEMANTIC_REASON`) and
  never rendered; the reason is classified into a `semanticCategory` (STATISTIC,
  REVEAL, PUNCHLINE, CONTRADICTION, EMOTION, SPEAKER_SHIFT, CONTEXT, EMPHASIS)
  that drives the effect choice below. Two kinds:
  - **`ZOOM` (push in)** starts 60 ms after the trigger word's onset, ramps for
    0.3 s on an ease-out so the move is felt immediately, holds 0.6–1.5 s while
    the beat continues, and returns over 0.4 s on a smoothstep whose flat tail
    sets the camera down on the baseline instead of stopping on it.
  - **`ZOOM_OUT` (pull back)** is tight on its very first frame and eases back to
    1.0. It is only ever accepted when it can be anchored to a hard visual
    discontinuity within 1.2 s before the beat — the clip's opening frame, a
    removed-silence cut, or a shot change (`anchorKind`: CLIP_START / CUT /
    SHOT_START) — because that is the only place an already-tight frame reads as
    framing rather than a pop. Anything else is `ZOOM_OUT_NO_ANCHOR`.
  Intensity bands (`ZOOM_INTENSITY_BANDS`): SUBTLE 1.08–1.14, NORMAL 1.15–1.20,
  STRONG 1.21–1.28. A requested scale is clamped into its band and **never pushed
  up**; STRONG is only granted when a STRONG `subtitleEmphasis` word backs the
  trigger, otherwise the move is walked back to NORMAL. The existing subject/text
  safety search then steps the scale down (in 0.02 increments, floor 1.10) until
  the padded face — both faces in a TWO_PERSON shot — stays ≥ 98 % visible and any
  readable burned-in text stays ≥ 90 % visible; a move that cannot be made safe is
  rejected (`SUBJECT_UNSAFE` / `TEXT_UNSAFE`) rather than shipped, and information
  shots allow no zoom at all. Budget: at most `min(4, round(duration/12))` moves,
  ≥ 2.3 s apart, so a 30 s clip gets up to 3 and a 45 s clip up to 4 — and a clip
  with no justified beat gets none. Every envelope finishes before the final
  frame (`zoomSettledBeforeEnd`); the hold is shortened, or the move dropped, when
  a cut or the clip end leaves no room.
- Sound design (`sfx-library.ts`): one short effect per accepted camera-motion
  event, chosen from the event itself — `ZOOM_IN` / `ZOOM_OUT` for pushes and
  pulls, `TRANSITION` for a pull back across a cut or shot change, `STAT_HIT` on a
  statistic, `REVEAL` on a reveal, `IMPACT_LIGHT` on a STRONG punchline or
  contradiction. Assets are local only: a file dropped into
  `apps/backend/assets/sfx/<category>/` is that category (`zoom-in`, `zoom-out`,
  `reveal`, `stat`, `transition`, `impact`; .wav/.mp3/.m4a/.ogg/.flac), an
  optional `sfx.json` refines individual files, and **nothing is ever downloaded**.
  With no assets present the renderer synthesizes its own plain effects in-graph
  (filtered pink-noise swells and soft low sines) so motion always has matching
  sound; a local file always outranks them. Selection is deterministic per seed
  and rotates within a clip so two pushes in a row are not the identical whoosh.
  Mixing (`SFX_MIX`): each effect is trimmed to ≤ 1.2 s, gain-matched to its
  category target (ZOOM ‑26, TRANSITION ‑28, REVEAL/STAT ‑24, IMPACT ‑27 LUFS,
  makeup capped at +12 dB), delayed to the motion's start (a pull back scores at
  `zoomOutStartSec`), summed, ducked by a speech sidechain and peak-limited to
  ‑12 dBFS, then mixed alongside the music bed — speech priority is absolute.
  Measured on a real render: effect onset **20 ms** from the motion, speech
  **14.7 dB** above the effects bus under continuous speech.
- Motion/sound quality gate (all ENHANCEMENT): `zoomSemanticallyJustified`,
  `zoomIntensityValid`, `zoomSubjectSafe`, `zoomInformationSafe`,
  `zoomSettledBeforeEnd`, `sfxTimingValid` (measured onset within 100 ms of the
  planned time, on a separate effects-only QA bus), `sfxSpeechSafe` (speech ≥ 10 dB
  above the effects during the speech they play under), `sfxNotOverused` (inherits
  the motion budget) and `sfxMatchesEvent`. Repairs: `SFX_QUIET` pulls the bus
  down 5 dB at a time and `SFX_DISABLE` drops sound design entirely rather than
  ever letting it compete with the voice. Env: `EDIT_SFX_ENABLED`, `EDIT_SFX_DIR`,
  `EDIT_SFX_ALLOW_GENERATED`. Verified by `npm run test:motion-sfx`
  (`scripts/test-motion-sfx.cjs`), which covers single speaker, emotional moment,
  statistic, punchline, reveal, two-person, information-heavy and strong-ending
  cases, and renders every generated effect through real FFmpeg to check its
  level, length and declared loudness.
- Subtitles: exact word timing on the final timeline, frame-grid ASS times,
  continuous word events, per-word onset snapping to the source audio (±120/250 ms
  guard), active-word pop (accent colour) and persistent keyword colour, width-aware
  2-line layout, placement below FIT frames and above burned-in source text.
- Hook: **mandatory for every AI_EDITED clip** (`EditPlan.hookRequired`, set only
  on the edited path; NORMAL clips never carry one). The hook checks are therefore
  always applicable — `hookRendered=false` / empty text / "N/A" can no longer reach
  PASSED, and a missing headline is a BASELINE failure that blocks delivery.
  Generation (`hook-generator.ts`, `edit-plan.service.ts`): Luna returns six
  candidates with deliberately different mechanisms (`hookCuriosity`,
  `hookTension`, `hookDirect`, `hookEmotion`, `hookInsight`, plus `hookHumor` —
  automatically replaced by `hookConsequence` on death/tragedy/abuse subjects, so
  humour is never forced onto solemn material), which are scored together with
  the plan's own hook and the whole deterministic pool. `scoreHook` hard-rejects
  clickbait, fabricated quotes, false urgency, mid-sentence transcript fragments,
  incomplete sentences, ungrounded lines, title duplicates and headlines already
  used by another clip of the same video, then ranks the survivors on brevity,
  editorial mechanism, question form, numerals, named entities, grounding,
  content density, platform fit and mechanism diversity (per-component scores are
  returned for the analytics loop). Length policy: 4–8 words preferred, 3–10
  good, **up to 14 allowed** when shortening would cost meaning, curiosity or
  specificity — a strong long headline is never traded for a weak short one
  (`HOOK_LENGTH`, mirrored by `validateHook`). Mechanisms are drawn from the full
  editorial set (curiosity gap, contradiction, surprise, stakes, hidden
  consequence, strong question, unusual fact, emotional tension, humour, irony,
  conflict, transformation, reveal, social proof, counterintuitive claim).
  When Luna is unavailable the deterministic generator still
  produces a real headline: it ranks the clip's sentences by charge, compresses
  the strongest one (discourse markers, hedges, existentials and trailing clauses
  removed), focuses it on its strongest word at a clause boundary at two widths,
  builds a contrast frame from a sentence that contains its own turn, and
  re-casts a passive clause — in the main clause or in the causal clause the
  speaker gives — into a question: *"There was a huge market for it and that was
  banned"* → *"Why Was This Huge Market Banned?"*; *"…because the alarm had been
  disconnected"* → *"Why Was This Alarm Disconnected?"*. Only grounded rewrites
  plus the question scaffolding are used; a verbatim line is kept in the pool only
  when it starts where the speaker started, and is penalised so any real rewrite
  outranks it. The ladder ends at the clip's compressed title, so the hook is
  never empty; a survivor that scores below the weak-hook floor (2.5) is replaced
  by a headline built from the clip's own title, since a vague three-word
  fragment tells a viewer less than the subject does. Unpunctuated ASR
  transcripts are split on spoken discourse boundaries first, so the compressor
  works on clauses instead of one 200-word run-on. A headline must also carry a
  predicate: a noun pile the window slicer stopped on ("Reason Why Donald Trump",
  "Period Between Trump's First") is rejected as INCOMPLETE_SENTENCE - possessives
  do not count as verbs and an ordinal is not an ending.
  Diversity across clips of one source is advisory, not a ban:
  `ClipExportService` remembers the last eight delivered headlines/mechanisms per
  video and feeds them back as a scoring penalty (an exact re-use is rejected).
  Fitted (1–3 lines, two preferred for a normal headline, size, deterministic
  shortening) and
  calibrated against real libass glyph bounds; editorial hooks are uppercase
  (≤ 104 px, 3.4 px outline, 2 px tracking, soft shadow), fade/rise in over 220 ms
  and then stay locked.
  The headline is **anchored from the top of the video viewport**, not from the
  top of the canvas (`HOOK_PLACEMENT` in `platform-layout.ts`):
  `hookTopY = videoViewport.y − targetGapAboveVideo − renderedHookHeight`, with
  `targetGapAboveVideo = 58 px` and the measured gap gated to 45–70 px. The hook
  zone's bottom edge *is* that baseline, so one-, two- and three-line headlines
  all end at the same y and grow upward — identical placement across every clip
  using the same layout, with the ambient background keeping the unused space
  above. Measured on real renders: planned block gap 58 px, rendered ink gap
  69–70 px (a text line reserves descender space below the glyphs), identical in
  the first and final frames of every scenario.
  **Long-hook fit priority** (`text-layout.ts`): wording first, then the free
  header space above the headline, then better line breaks, then 2–3 lines, then
  a smaller size (`longWords = 11` words switches the size floor from 60 px to
  `longMinFont = 46 px`), and only then the shortening ladder — which is itself
  gentler (first cut level keeps ~9 words instead of 7). A third line costs
  almost nothing for a long headline and stays expensive for a short one. Line
  breaking minimises the widest line, penalises a break on a function word and a
  one-word last line, and rewards breaking on the headline's own punctuation.
  Measured: 5/8/10/12/15-word headlines all fit every preset's hook zone at
  ≥ 46 px on ≤ 3 lines, and the 12- and 15-word lines keep every word
  (`shortenLevel = 0`).
  **Accents**: 1–4 strong words carry a colour, budgeted by headline length
  (`hookAccentBudget`: ≤ 4 words → 1, ≤ 8 → 2, ≤ 11 → 3, longer → 4). Red is
  primary, green secondary, warm gold tertiary (`hook-accent.ts`). Deterministic
  scoring over numerals, `subtitleEmphasis` matches, charged words (now including
  contradiction, consequence, reveal and transformation vocabulary), mid-sentence
  named entities and headline position; function words are never accented,
  accents are never adjacent (so emphasis is spread across the line rather than
  clustered), the bar rises for each additional accent, and the accented share of
  the headline is capped at 45 % of its letters. Everything else stays
  white. `hookTextPresent` / `hookRendered` / `hookInsideSafeZone` /
  `hookPositionValid` / `hookNotTooHigh` / `hookGapAboveVideoValid` /
  `hookAccentWordsValid` / `hookAccentDistributionValid` / `hookLineCountValid` /
  `hookFontReadable` / `hookLongTextFitValid` gate all of this.
  The hook QA mask uses `HOOK_MASK_MIN_LUMINANCE = .3` rather than `probeMask`'s
  default `.5`: the primary accent (red, relative luminance ≈ .4) sat below the
  default, so a line holding the accent alone was invisible to QA — the headline
  measured as a single line, the glyph-bound calibration under-corrected, and the
  cover comparison ran against a partial mask.
- Captions avoid burned-in source text (OCR regions of that moment) when it would
  cover > 6 % of the caption box, never moving onto a face.
- Zoom: timed from the trigger word onset (+60 ms, peak ~0.36 s later, hold, return
  to 1.0), 1.16–1.22, shortened before cuts/shot ends, reduced or rejected when a
  subject or large burned-in text would be clipped.
- Look: per-scene palettes (shots merged unless their colours clearly differ,
  ≥ 1.2 s) cross-faded over 400 ms at scene changes; default header/footer is an
  ambient extension of the running footage (low-res blur, temporal smoothing,
  darkened, mixed with the scene tint), `SOURCE_MATCH_SOLID` shows the tint only;
  white-text contrast ≥ 7:1; source-aware grade presets (exposure via gamma, cast
  correction, `SOURCE_ALREADY_GRADED` keeps graded sources subtle, `NO_CHANGE` is
  a true identity filter for already-balanced footage — conservative grading
  never touches footage that doesn't need it). Grading is `eq` → tone curve →
  vibrance → colour balance → unsharp: the tone curve is a restrained S with an
  explicit highlight rolloff and a shadow floor computed from the source's own
  clipping (`toneCurvePoints`), and most of the colour lift comes from `vibrance`
  rather than flat saturation, which leaves skin tones alone. Sharpening was
  reduced across presets. `gradingLooksNatural` composites the exposure,
  highlight, shadow, saturation, white-balance and over-processing guards.
- Audio — **curated local music library**: your own tracks live in mood folders
  under `apps/backend/assets/music/` (`documentary`, `podcast`, `tension`,
  `technology`, `motivational`, `emotional`, `neutral`, `energetic`,
  `atmospheric`; see the README there). `scripts/scan-music-library.cjs` indexes
  them into `curated.json` — folder name supplies the default mood, ffprobe
  supplies duration/format, `ebur128` measures integrated loudness, and a sidecar
  `<track>.json` or folder `meta.json` overrides any field (`moods`, `license`,
  `attribution`, `energy`, `texture`, `weight`, `priority`, `enabled`). Supported
  formats: `.mp3 .m4a .wav .aac .ogg .flac`. Nothing is ever downloaded.
  License is enforced: only `OWNED` / `LICENSED` / `ROYALTY_FREE_APPROVED` /
  `GENERATED_IN_HOUSE` / `CC0` / `ROYALTY_FREE_LICENSED` are used, anything else
  needs `EDIT_MUSIC_ALLOW_UNLICENSED=true` (local auditioning only).
  The generated beds now live in a **separate** directory
  (`assets/music-generated/library.json`, `EDIT_MUSIC_GENERATED_DIR`) so
  regenerating them can never drop a curated track and a read-only bind mount of
  the curated folders cannot hide the fallback. Curated tracks outrank generated
  beds by default (priority 10 vs 0). Luna chooses editorial intent only —
  `musicMood`, `musicEnergy`, `musicTexture` — and never names a file; the
  deterministic library picks the track, ranking the top priority tier by
  energy/texture fit then `weight`, with a reuse penalty against tracks already
  used for other clips from the same source video (variety never costs mood
  quality: the penalty only chooses between equally good matches).
  Fallback in-house beds (`scripts/generate-music-library.cjs`,
  `GENERATED_IN_HOUSE`, 13 beds / 7 moods), 0.9 s fade-in,
  sidechain ducking, loudnorm −16 LUFS, short (≤150 ms) speech tail fade at the
  cut. The beds are *composed*, not stacked sines: a felt pad, a plucked arpeggio
  with per-note decay envelopes and harmonics, and a sub bass move through a
  four-chord progression (8 s per chord, 32 s cycle, 96 s files so a clip never
  hears a bar twice); rhythmic moods add noise hats above 4 kHz and a filtered
  low thump; every bed carries a quiet pink-noise floor and is de-harshened,
  compressed and normalised to −20 LUFS. Manifest entries declare `energy` and
  `texture`; a `PULSE` bed is placed 1.5 dB lower than a pad at the same loudness.
  The bed is EQ-carved where speech lives (−4 dB at 2.4 kHz, −2 dB at 400 Hz)
  before ducking (threshold 0.03, ratio 8, attack 12 ms, release 520 ms), so it
  can sit at a useful level without competing with the voice. Rendered files carry
  `LIBRARY_VERSION` in their name so an existing library directory picks up new
  beds instead of reusing old ones; `NONE` is a valid editorial mood (`musicDecision: NO_MUSIC`) and is never
  overridden back to a default bed; `EDIT_MUSIC_REQUIRED=true` only forces music
  when the editorial mood actually asked for one; track selection avoids
  repeating the same bed on the same source video when an alternative exists.
- Render QA measures the actual output (libass probe masks vs. output pixels,
  zoom scale estimation, header/footer colour, ungraded-tap vs. final grading
  deltas, speech/music stems, audio onsets). A deterministic gate
  (`edit-quality-gate.ts`) marks the clip PASSED / DEGRADED / FAILED; bounded
  auto-repair (≤ 3 renders) refits hooks, darkens headers, makes the camera
  responsive or switches unsafe shots to FIT, retimes consistent subtitle offsets,
  rebuilds emphasis, regenerates backgrounds, retries/removes music, strengthens
  zooms/grades. FAILED edits are never exported (Luna plan → deterministic retry →
  error). DEGRADED is stored in `editTelemetry.editQualityStatus`.

- Thumbnail: every edited clip renders a designed cover in the same FFmpeg run
  (`thumbnail-frame.ts` picks the frame deterministically — largest/most centred
  subject, away from shot cuts, away from the clip's edges; information-heavy
  clips prefer the most readable frame instead). The cover is the same canvas
  (background, grade, framing) carrying only the clip's own headline — identical
  wording, position and accent colours, drawn static with no entrance animation —
  and no captions or callouts. It is uploaded next to the clip and stored on
  `GeneratedClip.thumbnailObjectKey/MimeType/Width/Height`. `thumbnailGenerated`
  and `thumbnailMatchesHookText` are BASELINE for edited clips (a missing cover,
  or one without the headline, blocks delivery and triggers `HOOK_REFIT`);
  `thumbnailContainsHook` and `thumbnailReadable` stay ENHANCEMENT because they
  are pixel-correlation measurements against the same libass probe mask used for
  the clip's hook.
- The cover is what the viewer sees **before pressing play**: `GET
  /generated-clips/:clipId/poster` streams it, `toClipCard` exposes `posterUrl`
  (null when no cover was stored), and the frontend clip card sets it as the
  `<video poster>` with `preload="none"`, so the designed cover with the hook
  replaces the browser's own first frame.

### Visual polish pass — dialogue-only audio, strong semantic zoom, plated headline

A targeted pass over the finished editor. Clip discovery, best-N selection,
transcription, information-region logic, thumbnail architecture, shot smoothing,
the queue, NORMAL clips, boundary logic and the content package are unchanged.

- **No music, no sound design.** `musicPolicy()` and `sfxPolicy()` now default to
  disabled (`EDIT_MUSIC_ENABLED`/`EDIT_MUSIC_REQUIRED`/`EDIT_SFX_ENABLED` default
  `false` in `docker-compose.yml` and `.env.example`), so an AI_EDITED clip ships
  with dialogue/source audio only: no bed is selected, mixed, ducked or faded and
  no zoom whoosh, transition, impact or stat hit is generated. The whole library,
  selection and mixing architecture is intact and deliberately untouched —
  flipping the flags back on restores beds and effects. `musicDecision` is
  `NO_MUSIC` and `musicSkippedReason` is `DISABLED_BY_POLICY` under the policy, so
  every music/SFX check reports **N/A** instead of failing an edit for an absence
  that was the intent.
- **Zoom is the only motion device**, and the bands are visibly stronger: SUBTLE
  1.10–1.15, NORMAL 1.16–1.22, STRONG 1.23–1.32. A push only reaches past
  `ZOOM_TIGHT_SCALE` (1.28) on a single dominant face in a close shot, and the
  existing subject/text safety search still walks any scale back until the whole
  head and any readable burned-in text survive the crop.
- **Word-level zoom timing.** A push now *leads* its trigger word: it starts
  `preOnsetSec` (130 ms, clamped to 80–180 ms and to the room inside its own shot)
  **before** the word onset and peaks ~150 ms after it, so the camera is already
  moving when the word lands. Envelope: 0.28 s ease-in ramp, 0.5–1.2 s hold,
  0.38 s smoothstep settle. `zoomStartsBeforeWord` and `peakOffsetFromWordMs` are
  reported per event. Budget is ~1 event per 10 s, at least 2 on a clip of 22 s or
  more, capped at 5, spaced ≥ 2.3 s.
- **Reframing is not zoom.** Every planned event carries
  `motionKind: 'SEMANTIC_ZOOM'`; camera reframes and shot changes are produced by
  the reframe planner and never enter the zoom list. `zoomNotJustReframe` reports
  the three counts separately, and `semanticZoomCountValid` only applies to a clip
  where at least one shot actually allows a push (an information-heavy clip that
  stays stable is correct, not degraded).
- **Rendered zoom QA.** `zoomVisibleScaleDeltaValid` measures the *rendered* scale
  change on the finished frame against a floor per intensity
  (`ZOOM_VISIBLE_DELTA`: SUBTLE .07, NORMAL .10, STRONG .16), so a move that plans
  1.26 and renders 1.04 is a failed move however correct its plan was.
- **The headline is a complete thought.** `HOOK_LENGTH` is now min 7, preferred
  8–16, max 22 words / 130 characters, enforced identically by the scorer, the
  plan validator, both Luna prompts and the new BASELINE `hookWordCountValid`
  check. The deterministic generator was widened to match (wider focus windows, a
  clause-bounded extension of the passive question frame, and the widest grounded
  form of a short spoken line), and `lastResortHook` extends a short title with
  the clip's own words and trims any unfinished tail.
- **Fitting beats cutting.** A long headline may use up to four lines and a
  length-aware size floor (`hookMinFont`: 46 px from 11 words, 40 px from 17)
  before the shortening ladder is ever reached. Measured: 7 w → 76 px/2 lines,
  10 w → 64 px/2, 12 w → 56 px/3, 20 w → 44 px/3, all with the wording intact.
- **White plate, dark text, one accent colour.** The headline is drawn on a
  near-white (`#F7F7F7`) rounded plate sized to the fitted block — an ASS `\p1`
  drawing on its own `HookPlate` style, not a full-width band — in dark charcoal
  `#111111`. `hookAccentFamily` picks **one** family per headline (RED for
  conflict/stakes, GREEN for growth/money, BLUE for everything analytical, the
  default), and every accent word in that headline uses that one colour; the
  budget is 1/2/3/4 accents by length. The plate carries the contrast, so the
  headline needs no outline or shadow.
- **The plate is the hook** for layout and QA. It is bottom-anchored in
  `hookZone`, so a one-, two-, three- or four-line headline presents the same
  bottom edge to the footage, `HOOK_PLACEMENT.targetGapAboveVideo` is 48 px
  (valid 35–60), and a long headline grows *upward*. Render QA masks the **dark**
  pixels inside the plate (`probeMask({ maxLuminance })`) and measures contrast
  against the plate itself; the background sampler excludes the whole plate
  rectangle before reading the header's colour.
- **New caption face.** Captions are set in `Inter ExtraBold` (`font-inter`, added
  to the backend image). Nothing is assumed: `resolveFontFamily` asks fontconfig
  what the name actually resolves to, falls back to Noto Sans when it is missing,
  and `subtitleFontValid` reports the fallback rather than letting the look change
  silently. `EDIT_SUBTITLE_FONT`/`EDIT_HOOK_FONT` override it.
- **Captions do not move.** One baseline per **shot**, never per phrase: the
  renderer takes `shotRanges` and picks NORMAL, the single SAFE_HIGH alternate, or
  the fitted-frame edge once for each shot. One font size is used for the whole
  clip (the smallest any phrase needs). The active word changes **colour only** —
  every `\fscx`/`\fscy` is gone, because scaling a word inside a centred line
  re-flows it and shifts the block sideways — and the entrance animation no longer
  scales, rises or slides. `subtitlePositionStable`, `subtitlePhraseSizeValid` and
  `activeWordDoesNotMoveBlock` check this.
- **Sync stays tight.** Word-level timestamps and frame-grid snapping are
  unchanged; `subtitleSyncAverageValid` now requires ≤ 50 ms average residual
  (was 120) and drives `SUBTITLE_RETIME`, which shifts the whole track by the
  measured offset. Real-footage renders measure 7–62 ms.
- Verified on real footage with `scripts/verify-edited-clips.cjs` and on the
  synthetic stack with `scripts/test-editing-media.cjs`; the headline length band,
  plate, placement and accent family have their own libass render test,
  `scripts/test-hook-plate-lengths.cjs`.

## Content Package — Platform-Aware Packaging

The clip's meaning is understood once (transcript, evidence, `ClipUnderstanding`)
and never varies by platform. What varies is **packaging**: register, caption
length and how many hashtags are worth carrying. Nothing here invents a fact,
claims a trend or promises performance — these are ranking and formatting
preferences, not guarantees, and the component scores (curiosity, grounding,
clarity, platform fit, brevity, diversity) are ranking aids, never a "viral
score".

- `platform-packaging.ts` owns the contract per `Video.targetPlatform`:
  Instagram Reels → `CONVERSATIONAL_EMOTIONAL` caption, `BROAD_PLUS_NICHE` tags,
  3–8 (target 6); TikTok → `PUNCHY_CURIOSITY`, `TIGHT_TOPICAL`, 3–6 (target 5);
  YouTube Shorts → `CLEAR_SEARCHABLE`, `MINIMAL_SEARCH`, 2–4 (target 3, because
  title/thumbnail/content outrank tags there). No platform selected → a neutral
  5-tag default.
- Generation (`openai-clip-judge.service.ts`): the platform's packaging brief is
  appended to the creative system prompt and to each candidate's input, and the
  caption is explicitly asked to extend the hook, add context, keep curiosity and
  carry searchable terms — never to repeat the hook verbatim. Grounding,
  three-paragraph synopsis and multi-candidate pools (10–12 hooks, 3–5 titles,
  3–4 captions, 15–20 hashtags, 2–4 synopses, then local ranking + the Luna
  critic) are unchanged.
- `applyPlatformPackaging` runs **after** the critic, so generation and
  validation keep one contract: it resizes the (already grounded, already ranked)
  hashtag set to the platform's band using only tags from that clip's own pool,
  drops `#viral`/`#fyp`/`#trending`-style spam, and trims an over-long caption at
  a sentence boundary. It never rewrites a claim.
- `buildContentFingerprint` includes the platform, so a package generated for one
  surface is never silently reused for another; `CLIP_CONTENT_PROMPT_VERSION` is
  `clip-content-v8-platform-aware-packaging`.
- The deterministic fallback package stays specific to the clip and changes
  register with the platform (question-led for TikTok, subject-led and searchable
  for Shorts, contextual for Reels). It never emits "This clip is interesting" /
  "Watch what happens" filler.
- Analytics loop: `GeneratedClip.editTelemetry` records `hookMechanism`,
  `hookCandidateCount`, `hookMechanismsOffered`, `hookScore` +
  `hookScoreComponents`, `hookAccentWordCount`, `hookDiversityContext` and
  `contentPackaging` (platform, caption style, hashtag strategy, hashtag count),
  so future view/retention/share data can be correlated against the packaging
  decisions instead of hardcoded assumptions.
- Subtitle emphasis keeps the exact spoken wording; only *which* word is
  emphasised improved. The deterministic selector now scores surprise,
  contradiction, consequence and reveal vocabulary and mid-sentence named
  entities alongside numbers and long words, and a phrase carries **one**
  emphasised word unless it is ≥ 4 words long and the second one is STRONG.
- Thumbnail consistency is by construction: the cover renders the identical
  headline dialogue (same fit, position and accent colours) as the clip.

Verification: `test:edit-quality` (26 unit tests), `test:hook-music`
(22 unit tests: hook generation/scoring, long/short length policy, diversity,
platform nudges, placement across every preset, accents, information-region
detection, curated music loading/selection), `test:content-package` (20 unit
tests: hook mechanisms per clip type, dishonesty rejections, 5/8/10/12/15-word
hook layout across every preset, accent budgets/distribution, platform hashtag
and caption contracts, deterministic fallback packages, subtitle emphasis),
`test:editing`,
`test:editing-media`, `test:editing-benchmark` (9 synthetic golden scenarios with a
stored baseline), `verify:hook-music` (real renders: single speaker, two people,
information-heavy screen, Luna available, Luna deliberately unavailable, and
music variety across clips from one source — measures the hook's glyph pixels in
the first and final frames and on the cover), `verify:edited-clips` (real videos
in the Docker stack, disposable).

## EditMode Phase 4 — Presets and No-Prompt Auto Edit

EditMode is additive and isolated from the frozen auto pipeline. Phase 4 adds reusable presets and
automatic editing that requires no prompt. Full contract: `docs/edit-mode-phase4.md`.

- Eight presets: `INSTAGRAM_REEL_PROFESSIONAL`, `PODCAST_CLIP`, `EDUCATIONAL`, `PRODUCT_PROMO`,
  `MOTIVATIONAL`, `CLEAN_BUSINESS`, `MINIMAL`, `SOURCE_MANUAL`. Each is a typed policy of closed
  enums, not a fixed sequence; `SOURCE_MANUAL` records the selection and transforms nothing.
- Pipeline: source + cached analysis → preset policy → content-aware planner → validated EditMode
  commands → canonical `EditProject`/`EditElement`/`EditHistory` → existing manual editor. Manual
  and preset edits share one mutation path (`EditModeService.applyElementCommand`), so both are
  normalised and validated identically. No preset code writes element rows or patches settings.
- Content-aware, evidence-driven: no semantic emphasis in the transcript means no zoom; slides or
  screen content force `INFORMATION_PRESERVING` framing and refuse zoom; a requested face-focused
  framing degrades to `AUTO` without a reliable face; pair composition is preserved when two faces
  both survive the crop; an already-vertical source is not reframed; no product overlay, CTA, hook,
  music or speaker label is invented when the source does not support it.
- Cached reuse only: the planner reads `EditAsset.transcript` and `EditAsset.analysis` from the
  Phase 1 analyze step and never re-transcribes or re-analyses. Frozen editing intelligence is
  reused as pure logic with unchanged defaults (`classifyShots`, `detectInformationRegion`,
  `buildSubtitlePhrases`, `detectSemanticZoomCandidates`, `buildEditedTimeline`,
  `deterministicHook`/`chooseBestHook`).
- `GET /edit-mode/presets`; `POST /edit-mode/projects/:id/preset/preview` returns a structured
  proposal and writes nothing; `POST /edit-mode/projects/:id/preset/apply` commits atomically. Both
  reject a stale `revision` before doing any work.
- One apply is one `EditHistory` row (`actor: PRESET`, `action: APPLY_PRESET`) whose before/after
  state carries both elements and settings, so a single undo restores the complete pre-preset
  project and a single redo restores the applied one.
- Ownership metadata in `EditElement.properties` (`origin` USER/PRESET/ASSISTANT, `presetId`,
  `presetRunId`, `presetRole`, `createdAtRevision`) makes a reapply replace only preset-owned
  elements. Manual logos, text, images, music, trims and arrangement always survive; preset elements
  are replaced rather than duplicated; a hand-made trim is never overwritten and a preset trim is
  idempotent across reapplies. No schema change was required.
- `EditProject.settings` persists `selectedPreset`, `aspectRatio`, `pacing`, `subtitlePolicy`,
  `hookPolicy`, `zoomPolicy`, `reframePolicy`, `musicPolicy`, `gradingPolicy`, `textPolicy`,
  `overlayPolicy`, `informationRegionPolicy`, `hookText`, and a `presetRun` record. No new table.
- Subtitles are transcript-exact: one `SUBTITLE` element per phrase with the transcript's own words
  and timings, capped by `EDIT_MODE_MAX_SUBTITLE_ELEMENTS` (default 400), above which the policy is
  persisted for the render phase instead. Hooks are grounded by the existing hook scorer and omitted
  when nothing clears the bar.
- Phase 4 renders nothing. Reframe, zoom and grading are persisted intent for a later render phase.
- LLM use is limited to headline wording via the existing `LlmRouterService` `hookGeneration` role
  under a strict schema, so existing ONLINE/OFFLINE/`FALLBACK_ONLY` routing applies and no API key
  was added. A provider failure or a rejected proposal degrades to the deterministic hook.
  `EDIT_MODE_PRESET_LLM_ENABLED=false` forces the deterministic path.
- Isolation: no `ProcessingJob`, `ClipCandidate` or `GeneratedClip` is created, nothing is enqueued,
  and no `Project` or `Video` row is read or written. `EditModeModule` provides `LlmRouterService`
  directly rather than importing `ProcessingModule`, keeping the frozen queue and video processor out
  of EditMode's injector graph.

### Phase 4 verification

- Backend and frontend TypeScript checks and all workspace production builds passed.
- `npm --workspace apps/backend run test:edit-mode` — Phase 1, 2, 3 and 4 suites all green.
  Phase 4 (`test-edit-mode-presets.cjs`, also `test:edit-mode-presets`) covers the catalogue and its
  typed enums, invalid presets, `SOURCE_MANUAL` applying nothing, a plan per preset over
  talking-head / two-person / slide / silent fixtures, cached-analysis reuse, auto-pipeline
  isolation, PREVIEW purity, APPLY, single-revision `PRESET` history, undo/redo, manual-edit
  preservation across reapply, generated-command validation, stale revisions, the no-prompt flow,
  and the deterministic fallback.
- Frozen auto-pipeline regressions all passed: `test:edit-quality` (56/56), `test:editing`,
  `test:editing-media`, `test:editing-benchmark` (9 scenarios), `test:clip-selection`.


## EditMode Phase 5 — Render, Export and EditMode QA

Phase 5 turns the canonical EditMode state into an actual MP4. Full contract:
`docs/edit-mode-phase5.md`.

- EditMode has its OWN rendering orchestration in
  `apps/backend/src/modules/edit-mode/render/`. It never calls the frozen processing queue, video
  processor, clip selector, clip render queue or clip exporter, never creates a `ProcessingJob`,
  `ClipCandidate` or `GeneratedClip`, never enqueues BullMQ work, and never calls an LLM. The frozen
  editing intelligence is reused only as pure callable logic (shot classifier, camera solver,
  information region, grade filter builder, ASS primitives, bounded QA measurement).
- An export is deterministic from `EditProject.revision` + `EditElement[]` + `EditAsset[]` +
  `settings`. A typed `RenderPlan` is built and fully validated before FFmpeg runs, and the FFmpeg
  argument vector is a pure function of that plan. No second render-only timeline model exists.
- The VIDEO track is an ORDERED list of source ranges, so trims, splits, deletes and REORDERS all
  render correctly. Because a reordered timeline is not expressible as `clipStart + cuts`, EditMode
  has its own `buildTimelineMap`; the shared `createTimelineMapper` is not usable here. Audio is
  trimmed from the same ranges, and every segment join counts as a shot boundary.
- Canvases: `9:16` 1080×1920, `16:9` 1920×1080, `1:1` 1080×1080, `SOURCE` the source shape with the
  longest side capped at 1920. Square pixels, H.264/AAC/MP4, faststart.
- `reframePolicy` modulates the evidence rather than replacing it: `SOURCE` fits the whole frame,
  `AUTO` keeps the classifier's call, `FACE_FOCUSED` tracks only real detections (no invented
  speaker), `INFORMATION_PRESERVING` fits information shots to their detected readable region. An
  information shot with no distinct region falls back to a whole-frame fit, never a crop.
- Phase 4's `plannedZoomMoments` are INTENT. Phase 5 converts them into bounded geometry (SUBTLE
  1.06 / MODERATE 1.10 / STRONG 1.15) and validates each against shot boundaries, subject safety and
  information readability. An unsafe move is reduced first and then suppressed individually; the
  zoom policy is never globally disabled, and every refusal is recorded with a reason.
- Grading is EditMode-local: `NONE` is a true no-op, and `SUBTLE`/`CLEAN`/`WARM`/`CONTRAST` borrow
  the pure grade-filter builder at EditMode's own strengths. The frozen `AI_EDITED` grading defaults
  are unchanged.
- Text, captions and preset hooks are one ASS file; canonical `zIndex` is the ASS layer. Wording is
  never regenerated at export. Where Phase 4 stored only the subtitle POLICY, captions are built at
  render time from the cached transcript with the same deterministic phrase logic — transcript-exact
  text and timings, each caption held at the end of its own segment.
- Audio mixes source dialogue with user-supplied music at the timeline's own levels
  (`normalize=0`), limited so the sum cannot clip. DUCKING IS DEFERRED: the Phase 3 properties are
  preserved and carried on the plan, but no ducking filter is applied.
- EditMode QA is local and bounded (≤20 event-driven frames): probe, resolution, duration, streams,
  timestamps, final-frame decode, blank output, overlay/caption bounds, subject safety,
  information readability, audio peak. Results are `PASS` / `DEGRADED_ACCEPTABLE` /
  `REPAIR_REQUIRED` / `REJECT`; a visible defect is never acceptable degradation. Repairs are local
  (suppress one zoom, widen one shot, fit one shot to its region) and capped at 2 total renders.
- Export is direct async work — NO BullMQ queue and no EditMode-local queue was added. Progress
  (`PREPARING → RENDERING → QA → UPLOADING → COMPLETED|FAILED`) is mirrored onto `settings.export`
  WITHOUT bumping the revision or writing an `EditHistory` row: rendering is not an edit.
- Each export is a new `EditAsset(role: EXPORT)` at
  `edit-mode/<editProjectId>/exports/<assetId>/final.mp4`, carrying `sourceRevision` and full render
  /QA telemetry. Exports accumulate (v1, v2, v3) and are never overwritten. An export whose revision
  moved while it rendered is retained but flagged `stale`, and the project returns to `READY`
  instead of being declared `COMPLETED`.
- Routes, all under `/edit-mode`: `POST projects/:id/export`, `GET projects/:id/export/progress`,
  `GET projects/:id/exports`, `GET projects/:id/exports/:assetId`; download reuses the existing
  range-capable `GET assets/:assetId/file`.
- No schema change was required — `EditAssetRole.EXPORT` already existed. (`EditAssetRole.LOGO` was
  missing from the local dev database, a Phase 3 drift; `npm run db:push` syncs it.)
- Tests: `test-edit-mode-render.cjs` (offline plan/graph/QA units) and `test-edit-mode-export.cjs`
  (real FFmpeg renders through the service) run inside `npm run test:edit-mode`;
  `scripts/verify-edit-mode-export.cjs` is the disposable real-media check against the Docker stack.

## Milestone 6 — Visual Intelligence

Every semantic transcript chunk now receives deterministic frame-based visual analysis during video processing. PostgreSQL stores exactly one VisualAnalysis row per TranscriptChunk, linked by a unique chunkId; deleting or replacing a chunk cascades to both its text and visual analysis records.

The AI service downloads the immutable source video from MinIO once per batch and samples frames at 0.5-second intervals. For each chunk it computes and stores:

- shotBoundaries: absolute video timestamps where adjacent sampled-frame color histograms cross the scene-change threshold.
- sceneChangeCount: the number of detected shot boundaries.
- averageMotion: mean normalized grayscale frame difference, on a 0–100 scale.
- faceCount: the maximum simultaneous frontal-face count in a sampled frame.
- largestFaceRatio: the largest detected face area as a percentage of frame area.
- brightness: mean grayscale intensity on a 0–100 scale.
- contrast: mean normalized grayscale standard deviation on a 0–100 scale.
- colorfulness: the clamped Hasler–Süsstrunk colorfulness approximation on a 0–100 scale.
- ocrText: unique accepted Tesseract OCR lines sampled once per second.
- subtitleDetected: whether an accepted OCR line occurs in the lower 35 percent of a sampled frame.

OpenCV supplies frame decoding, histogram comparison, image statistics, motion differences, and Haar-cascade face detection. OCR rejects low-confidence and isolated-character noise. Adjacent chunks use half-open time intervals so a boundary frame belongs to the chunk that starts at that timestamp. Chunks without a decodable sample still receive a finite zero/default record, preserving one record per chunk.

### API, frontend, and processing

- POST /visual-analysis on the AI service accepts the source object and all chunk time ranges and returns one position-keyed result per chunk.
- GET /videos/:id/visual-analysis returns records in semantic chunk position order.
- Missing videos return 404 with Video not found; existing videos without chunks return an empty array.
- The Transcript chunks panel loads text analysis and visual analysis together. It displays cut count/timestamps, scene changes, motion, faces, largest-face ratio, brightness, contrast, colorfulness, OCR text, and subtitle detection with the existing loading, pending, failure, empty, and retry states.
- Processing progress is now 5, 20, 35, 50, 60, 90, 95, 97, 98 after text chunk analysis, 99 after visual analysis, and 100 after the chunk/analysis/job transaction commits.
- The worker rejects missing, duplicate, non-finite, or malformed visual results before persistence. Chunk rows, both one-to-one analysis rows, and completed job state commit atomically; retries replace prior chunks and cascade-delete both analysis types.

### Existing data and verification

apps/backend/scripts/backfill-visual-analysis.cjs analyzes completed videos with missing visual records and is safe to rerun while processing is idle. Passing --refresh recomputes retained records after heuristic changes. The finalized backfill populated/refreshed all 52 existing chunks; database verification found 52 visual records and zero chunks missing one.

- Prisma formatting/client generation, backend/frontend TypeScript checks, backend/frontend production builds, Python syntax checks, script syntax checks, and Docker Compose validation passed.
- Backend, frontend, and AI-service Docker images built successfully with OpenCV and Tesseract installed in the AI image. Recreated services started successfully, PostgreSQL synchronized the additive schema, both health endpoints passed, and the frontend returned HTTP 200.
- Synthetic-video checks passed for shot changes, motion, face defaults, OCR, subtitle placement, empty-sample defaults, output ordering, and finite metrics: apps/ai-service/scripts/test_visual_analysis.py.
- Live API verification returned every visual field, equal chunk/analysis counts, chunk-position ordering, and the expected missing-video 404.
- A disposable existing-media copy was processed through the real worker, FFmpeg, transcription service, visual-analysis service, PostgreSQL, Redis, and MinIO. It produced 18 chunks and 18 linked visual records with finite metrics; progress was [5,20,35,50,60,90,95,97,98,99,100] and final status was COMPLETED. apps/backend/scripts/verify-milestone6.cjs removed all disposable database and object-storage data afterward.

No clip selection, LLM, hook, caption, hashtag, or trend-research functionality was added.

## Milestone 5 — Chunk Analysis Engine

Every semantic transcript chunk now receives a deterministic, non-model analysis during video processing. PostgreSQL stores exactly one `ChunkAnalysis` row per `TranscriptChunk`, linked by a unique `chunkId`; deleting or replacing a chunk cascades to its analysis.

The engine computes and stores:

- `questionCount`: occurrences of ASCII or full-width question marks.
- `exclamationCount`: occurrences of ASCII or full-width exclamation marks.
- `keywordDensity`: occurrences of the most frequent non-stop-word term as a percentage of all words.
- `averageSentenceLength`: words divided by detected sentences, treating a non-empty unpunctuated chunk as one sentence.
- `speechRate`: words per minute from the chunk duration; a zero-duration chunk produces zero.
- `informationDensity`: non-stop-word terms as a percentage of all words.
- `readabilityScore`: an English Flesch reading-ease approximation, clamped to 0–100. Non-English words use a conservative one-syllable fallback.

Metrics are rounded to two decimal places. Empty inputs and zero durations are handled without non-finite values. This is heuristic analysis only and introduces no LLM, scene, vision, clip-selection, hook, caption, or hashtag functionality.

### API, frontend, and processing

- `GET /videos/:id/chunk-analysis` returns analysis records in semantic chunk position order.
- Missing videos return 404 with `Video not found`; existing videos without chunks return an empty array.
- The Transcript chunks panel loads the chunk and analysis endpoints together and displays all seven scores beneath each chunk, with loading, pending, failure, empty, and retry states preserved.
- Processing now advances from transcript persistence at 95 to chunks built at 97, chunks analyzed at 99, and the analysis/chunk/job transaction committed at 100.
- Chunk rows, their nested analysis rows, and the completed job state are committed in one transaction. A retry replaces prior chunks and their cascade-deleted analyses instead of appending duplicates.

### Existing data and verification

The additive schema was synchronized by backend startup. `apps/backend/scripts/backfill-chunk-analysis.cjs` analyzes existing chunks that do not yet have an analysis and is safe to rerun when processing is idle. It populated 52 existing chunks; the live endpoint returned equal chunk and analysis counts for a completed video.

- Prisma formatting/client generation, backend and frontend TypeScript checks, and backend/frontend production builds passed.
- Deterministic metric checks passed for empty input, punctuation counts, Unicode punctuation, density calculations, sentence length, speech rate, zero duration, and readability bounds: `node apps/backend/scripts/test-chunk-analysis.cjs`.
- The prior semantic chunk algorithm test still passes.
- Docker Compose validation and backend/frontend image builds passed. Recreated services started successfully, PostgreSQL synchronized the schema, and the project frontend returned HTTP 200.
- Live analysis API checks confirmed all seven fields, one analysis per chunk, ordered results, and missing-video 404 behavior.
- A disposable existing-media copy was processed through the real worker, FFmpeg, transcription service, PostgreSQL, and Chunk Analysis Engine. It produced 14 chunks and 14 linked analyses, all metrics were finite, and progress was `[5,20,35,50,60,90,95,97,99,100]` with final status `COMPLETED`. `apps/backend/scripts/verify-milestone5.cjs` removed all disposable database and object-storage data afterward.

## Milestone 4 — Transcript Intelligence

The worker now reads persisted TranscriptSegment rows in position order after saving the transcript and merges adjacent segments into deterministic semantic chunks.

- Sentence-ending punctuation (including closing quotes and brackets) ends a chunk.
- A pause of at least 1 second starts a new chunk.
- Commas, semicolons, and colons provide boundaries after 15 seconds of accumulated speech.
- Unpunctuated passages flush at the next segment boundary after 30 seconds. Whole segments are preserved; this is not a strict maximum duration, and timestamps are never invented within a segment.
- Blank segments are skipped, whitespace is normalized, and the final partial chunk is saved. Empty transcripts produce no chunks.
- This is a punctuation-and-pause heuristic, with no model-based topic analysis.

PostgreSQL stores TranscriptChunk rows with videoId, startTime, endTime, text, duration (endTime minus startTime in seconds), and wordCount (whitespace-delimited words). Rows also have an id and per-video position, with a unique videoId/position constraint and cascading video deletion.

Retries replace chunks instead of appending duplicates. Saving a replacement transcript invalidates old chunks. Chunk persistence and COMPLETED/progress 100 are committed in the same database transaction; a chunking failure leaves the job failed rather than complete.

### API and frontend

- GET /videos/:id/chunks returns an array ordered by position.
- Missing videos return 404 with Video not found; existing videos without chunks return an empty array.
- ProjectWorkspace displays Transcript chunks beneath TranscriptPanel, including time ranges, duration, word count, and text.
- Chunks automatically fetch when processing completes. Loading, empty, pending, failure, and manual fetch-retry states are provided.
- ProcessingPipeline now includes Build chunks. Progress is 5, 20, 35, 50, 60, 90 (transcription response), 95 (transcript saved/chunking), then 100 (chunks committed).
- The prior frontend/backend integration remains in place: ProjectWorkspace loads full video objects from GET /videos?projectId=..., and feeds the pipeline and transcript panel.

### Deployment and existing transcripts

The existing Docker backend startup runs prisma db push, creating the additive TranscriptChunk model. Backend and frontend images were rebuilt and containers recreated.

After schema sync and backend readiness, existing completed transcripts can be backfilled with:

```sh
docker compose exec -T backend node scripts/backfill-chunks.cjs
```

The script requires a current backend build in dist, skips videos whose latest job is not completed, and atomically replaces each video's chunks. It was run successfully: 46 chunks across 3 completed transcripts. Run it while processing is idle.

### Milestone 4 verification

- Prisma client generation, all workspace production builds, and all workspace TypeScript checks passed.
- Chunk algorithm checks passed for adjacency, ordering, pauses, sentence/soft boundaries, long passages, overlap, whitespace, empty input, and invalid timestamps: node apps/backend/scripts/test-chunks.cjs (after backend build).
- Docker Compose configuration validation and backend/frontend image builds passed. Recreated services are running; PostgreSQL, Redis, and MinIO are healthy; backend and AI health endpoints return ok.
- Live GET /videos/:id/chunks returned 16 persisted chunks for the existing English video. Missing-video 404 and existing-video empty-array responses passed.
- A disposable copy of existing media was processed through the real worker, FFmpeg, AI transcription service, and PostgreSQL twice. Both runs returned 17 segments and 14 chunks, with identical chunk content, no duplicates, and progress [5,20,35,50,60,90,95,100]. The test invokes the worker directly with a progress recorder; it does not test BullMQ delivery.
- Persisted fields, text preservation, API responses, job completion, and retry replacement were checked by apps/backend/scripts/verify-milestone4.cjs. Floating-point duration comparisons use a 1e-9 tolerance.
- Disposable verification database records and copied source/extracted audio objects were removed; original media and transcripts were preserved.
- The served project page returned HTTP 200 and includes the Transcript chunks panel and Build chunks stage. Interactive browser verification was unavailable because the browser tool process failed to start.

## Milestone 3

The video processing pipeline now continues from WAV extraction into transcription:

1. The backend worker uploads the extracted 16 kHz mono WAV to MinIO.
2. The backend calls the AI service with the WAV bucket and object key.
3. The AI service downloads the WAV from MinIO and transcribes it with faster-whisper.
4. The backend stores one transcript per video and a timestamped row for every segment in PostgreSQL.
5. ProcessingJob progress advances through the media and transcription stages and finishes at 100.

Transcript writes are idempotent. A retried processing job replaces the prior segment set instead of creating duplicates.

### API

- GET /videos/:id/transcript returns transcript metadata and segments ordered by position.
- A missing video returns 404 with Video not found.
- A video whose processing has not produced a transcript returns 404 with Transcript not found.

### Runtime configuration

- WHISPER_MODEL defaults to small.
- WHISPER_DEVICE defaults to cpu.
- WHISPER_COMPUTE_TYPE defaults to int8.
- The first transcription downloads the configured converted Whisper model if it is not cached.

## EditMode Phase 6 — AI Chat Editor

A natural-language front end to the EditMode editor. It is a front end, not a second editor: a
sentence becomes a structured command bundle that the canonical layer executes through the same
`applyElementCommand` / `normalizeVideoTrack` / `validateTimeline` path the manual editor and the
preset planner use. Full detail in `docs/edit-mode-phase6.md`.

- Pipeline: message + selection + playhead → bounded handle-addressed context (with deterministic
  transcript search) → deterministic planner, or the LLM under `CHAT_INTENT_SCHEMA` → validation →
  grounding/resolution → server-held PROPOSAL → user Apply → `applyAssistantBundle` → exactly ONE
  `EditHistory` row (actor `ASSISTANT`, action `APPLY_ASSISTANT_EDIT`), so one chat request is one
  undo step.
- Proposal-first without exception. Even a cosmetic change shows a plain-sentence preview; raw
  command JSON is never surfaced. `plan` writes no edit: same revision, elements, style settings and
  history count before and after.
- The model addresses nothing directly. Elements and assets are exposed only behind `el3` /
  `asset1` handles or the target kinds `SELECTED` / `LAST` / `ROLE` / `AT_TIME` / `REF`; parameters
  are filtered to a fixed allow-list, so FFmpeg, shell strings and raw ids cannot survive
  validation.
- Timestamps are never invented: every time value is bounds-checked against the live timeline, and a
  `TRANSCRIPT`-grounded range must match a window the backend's own `searchTranscript` produced. A
  topic mentioned twice resolves to `AMBIGUOUS` and becomes a question.
- Destructive commands (`TRIM`/`SPLIT`/`DELETE`/`REMOVE`) require confidence ≥ 0.75; reversible
  cosmetic commands require ≥ 0.6.
- `AT_TIME` targets bind during execution, not at plan time, so a mid-clip cut (split → split →
  delete) stays correct as each split changes which segment covers a second.
- A cut that shortens the timeline emits explicit `SET_ELEMENT_TIMING` refits for overflowing
  overlays, ordered BEFORE the cut — load-bearing, because the canonical layer validates after every
  command.
- Chat thread lives in `EditProject.settings.chat`, bounded (40 messages / 2000 chars / 8 remembered
  element ids). It is conversation state, not project state: it does not move the revision, it is
  excluded from history snapshots, and `historyMutation` deliberately preserves it across undo.
- Proposals are held in process for 15 min (`EDIT_MODE_CHAT_PROPOSAL_TTL_MS`), 8 per project. The
  client sends only a `proposalId`. RESTART LIMITATION: pending proposals are lost on restart and
  Apply then returns `PROPOSAL_NOT_FOUND`; nothing can be half-applied.
- Stale handling: a proposal records `baseRevision` and `plannedDurationSec`. It is safely rebased
  when every resolved element still exists and (for time-carrying plans) the timeline length is
  unchanged; otherwise it is marked `STALE`.
- Routing reuses the existing `editingPlan` role — no new provider, key or role, and no frozen file
  touched. `editingPlan` is absent from the router's frozen OFFLINE allowlist, so OFFLINE chat
  planning is deterministic-only. `EDIT_MODE_CHAT_LLM_ENABLED=false` disables the model path.
- **No schema change.** `EditHistoryActor.ASSISTANT`, the `ASSISTANT` element origin and the
  free-form `settings` JSON already existed.
- Isolation verified: no `ProcessingJob` / `ClipCandidate` / `GeneratedClip`, no frozen service
  reference, no FFmpeg or shell reach, and applying a chat edit never triggers an export. Export
  stays deterministic and LLM-free.
- API (all under `/edit-mode`): `GET :id/chat`, `POST :id/chat/plan`, `POST :id/chat/apply`,
  `POST :id/chat/cancel`.
- Tests: `test:edit-mode-chat` (89 offline checks, also run by `test:edit-mode`) and
  `verify:edit-mode-chat` (27 checks against the live stack, ending in a real Phase 5 export and
  FFprobe, cleaning up after itself).

## Unified AI Video Editor — Steps 5–25 (2026-09-27 … 09-28)

One product: upload → source preview → optional look / component styles / reference / brief →
count → generate → every clip is Preview / Edit / Ask AI / Export, all on ONE canonical EditProject.

- Step 5 scope + constraints: `edit-mode/edit-command-scope.ts` (SELECTED_ELEMENT(S) / TRACK /
  CURRENT_SEGMENT / ALL_VIDEO_SEGMENTS / PROJECT; actors MANUAL_USER_ACTION / AI_ACTION /
  TEMPLATE_ACTION / SYSTEM_ACTION; constraints PROTECT_* + TARGET_RANGE_ONLY), enforced inside
  `applyElementCommand`, not in prompts. Task constraints bind AI only; project locks
  (`GET/PUT /edit-mode/projects/:id/constraints`) bind everyone. Bundles with `onInvalid: CONTINUE`
  return per-command DONE / BLOCKED_BY_CONSTRAINT / UNSUPPORTED / INVALID / FAILED / SKIPPED. Every
  block logs `edit_constraint_blocked`. `edit-mode-framing.ts`: FIT/FILL/9:16/16:9/1:1/FREE for one
  segment or all, as one history row. Caption style never regenerates wording; only
  REGENERATE_CAPTIONS rewrites. Test: `test-edit-mode-scope-constraints.cjs` (109).
- Step 6 production model policy: OpenAI only (`OPENAI_MODEL`), deterministic fallback, no
  Ollama/Qwen route; `OFFLINE` rows normalise to `FALLBACK_ONLY`. User-facing AI states
  (401/429/timeout/network/5xx/…) in `src/modules/ai/ai-availability.ts`; `NOT_REQUESTED` marks a
  deliberate rule-based step (e.g. the live style preview) so it is never reported as an outage.
- Steps 7/8/16/18 agent: `edit-mode/agent/` — observe → plan (deterministic fast path, OpenAI planner)
  → typed tool registry → canonical commands → reload → verify → ledger per clause (DONE /
  NEEDS_CONFIRMATION / NEEDS_INPUT / UNSUPPORTED / FAILED / SKIPPED / BLOCKED_BY_CONSTRAINT) →
  self-review. Destructive work waits for "yes" unless autonomy is AI_AUTONOMOUS; a tool's own
  `destructive` predicate is authoritative for its commands. Semantic boundaries
  (`edit-agent-boundary.ts`) use word timestamps; multi-cut projects only trim the outer segment.
  Test: `test-edit-agent.cjs` (53).
- Steps 9–12, 14, 15, 17 generation: `edit-mode/styles/` — 20 full templates + 9 component
  libraries, ONE precedence resolver (instruction > component > reference > template > default),
  brief → content intent (re-ranks the de-duplicated pool; "only X" filters) + style hints,
  reference video → measured editing principles mapped onto our styles, saved styles by stable id.
  A styled request renders clean cuts and applies the style canonically in each clip's own
  EditProject (`GenerationStylingService`, one TEMPLATE revision, then a canonical export), so the
  delivered clip IS the editable project. Migration `20260927030000_unified_generation`
  (`ProcessingJob.generationSettings`, `ReferenceAsset`, `SavedStyle`) — applied.
  Frontend: `components/generation/*`, `lib/creative-generation.ts`, `clip-creation-panel.tsx`;
  the upload form no longer asks Normal vs Edited. Editor: `?panel=ai` opens the AI editor; the
  Templates tool has "My styles". Tests: `test-unified-generation.cjs` (54),
  `apps/frontend/scripts/test-clip-creation-ui.cjs` (51).
- Step 13 delivery: `clipSelection.deliveryStopReason` (REQUESTED_COUNT_DELIVERED /
  NO_ADDITIONAL_DISTINCT_USABLE_MOMENTS / EXPANSION_ONLY_PRODUCED_DUPLICATES_OR_OFF_INTENT) and a
  `clip_delivery_stopped` log whenever fewer than N are delivered.
- Real-media verification: `scripts/verify-unified-generation.cjs --file <talk.mp4>` (24 checks,
  disposable): poster + ranged source, precedence, N delivered, canonical styling, 1080x1920 exports
  with audio, Ask AI verified without rewording, briefs choose different moments.
- Brief semantics (09-28): "only"/"just" express RESTRICTION (`strict` for topics, `strictModes` for
  a kind of moment) and are never topic tokens; editing instructions ("just make it cleaner") are
  never content filters; "the part about hiring" -> topic "hiring". A kind restriction that nothing
  shows degrades to ranking instead of delivering zero clips (mode evidence is lexical/fuzzy); a
  strict topic shortfall stays an honest shortfall. Topics match whole words ("ai" no longer
  matches "said").
- Selected configuration vs resolved plan: the user's top-level look (`generation.look`:
  AI_EDITED / NORMAL / template id) is persisted and restored, because a styled request renders a
  clean cut (`outputStyle: NORMAL`) - previously "Automatic edit" + style words reloaded as
  "Clean cuts".
- Video deletion now also removes reference uploads and the cached source poster from MinIO.
- Found by the browser E2E / outage run and fixed (09-28): the source `<video>` was server-rendered
  with the internal `SERVER_API_URL` (black, unplayable) - DOM media URLs now use
  `getPublicApiBaseUrl()`; boundary moves through the lineage-aware outer range were always
  "not verified" (the tool now verifies the reloaded edge and that inner cuts are kept); the editor
  preview drew every fitted frame on black while the export uses `settings.fitBackground` (white/black
  exact now, blur labelled); the AI editor defaulted to rules-only when `EDIT_MODE_CHAT_AI_MODE` was
  unset (now ONLINE); a rejected key was mislabelled "not configured" / "try again soon" (the router
  now keeps the permanent cause, the agent keeps the planner's real availability state).
- Found by the 60-minute performance run and fixed (09-28): every source whose transcription took
  more than 5 minutes (roughly > 50 min of media) FAILED with `fetch failed: HeadersTimeoutError` -
  Node's global fetch has a hidden 300 s headers timeout that `AI_SERVICE_TIMEOUT_MS` (30 min) never
  reached. Transcription, visual analysis, editor source analysis and reference analysis now use
  `processing/ai-service-http.ts` (node:http, only the configured timeout). Test:
  `scripts/test-ai-service-http.cjs`. Known limitation: a client-side timeout does not cancel the
  AI service's work, which keeps running until it finishes.
- Browser E2E: `apps/frontend/e2e/unified-flow.spec.ts` (32 steps, installed Chrome,
  `E2E_SOURCE=<talk.mp4> npm run test:e2e`, `E2E_TRACE=1` for traces). Outage run:
  `scripts/verify-openai-unavailable.cjs` against a backend whose key is invalid (never the real one).
- Bugs only real media exposed (fixed, with regression tests): the materializer gave NORMAL clips
  the probed MP4 length instead of the source interval, so the 1e-4 duration validator refused every
  later command; styling orphaned by a backend restart never resumed (now resumed on boot); "only
  the serious explanations" became a strict literal topic that excluded every candidate.

## Automatic 2 = street3.mp4 visual template (2026-09-30)

- `street3.mp4` is the single visual reference. Measured (1080x1920): black canvas; media window x0-1080 **y610-1310 (700 px)**, fixed for every shot; hook ink y485-580 (two centred serif lines); supporting-line ink y1324-1448.
- One constant, `AUTOMATIC_2_STREET3_LAYOUT` (`apps/backend/src/modules/edit-mode/styles/automatic-2-street3-layout.ts`), feeds `resolveVisualLayout` -> persisted layout -> browser preview and FFmpeg export. Outer geometry never varies with source, face count or B-roll. Details: `docs/automatic-2-street3.md`.
- Typeface EB Garamond (`font-eb-garamond` in the backend image; `public/fonts/EBGaramond12-Regular.otf` in the frontend). Hook `#D0D0D1` with amber/deep-red semantic emphasis, present for the whole reel; supporting line omitted unless it is a real sub-hook (filler such as "The clip examines..." is rejected).
- ASS wrapping is font-aware (serif width scale + balanced two-line breaks) for EB Garamond only; Automatic 1 fonts are unchanged.
- Result card shows the playable base media with a "temporary preview" badge while the Automatic 2 export renders, then swaps automatically.
- QA: `scripts/qa-street3-compare.py`, `npm run verify:automatic-2`, `scripts/verify-automatic-2-e2e.cjs`.

### Automatic 2 completion / reliability pass (2026-10-03)

Template geometry unchanged. Rules in `docs/automatic-2-street3.md` ("Reliability rules"); regressions in
`scripts/test-automatic-2-reliability.cjs`.
- Information-safe FIT no longer needs the classifier: OCR/text/graphic/edge/label evidence, and any landscape
  shot that is mostly faceless, is fitted whole. Shots are additionally split where useful-face presence flips
  for >=1.5 s each side (wipes/dissolves that hard-cut detection misses). Automatic 1 framing unchanged.
- INVALID_TRIM root cause: trims were validated against stored container duration (+250 ms slack) while FFmpeg
  reads the actual stream (e.g. 704.9 s video in a 705.0 s container). Edit window and render trims are now
  clamped to the probe before planning/FFmpeg
  (overruns up to 1 s are corrected; a larger one is a broken timeline and still fails as INVALID_TIMELINE).
- Automatic 2 base clip = temporary preview only: `ultrafast/crf26`, Automatic 1 pixel QA skipped (it was also
  rejecting valid Automatic 2 candidates, e.g. `hardCutTransitionClean`). One full-quality render: the canonical
  EditMode export (own QA + repair). Editable plan unchanged.
- Export fixes found on real media: long EB Garamond hooks were emitted as one overflowing ASS line (wrapper now
  uses the fitter's 0.40 em/char floor); the fallback "What makes ... useful in practice" line and supporting lines
  that repeat the on-screen hook are rejected; final export metadata now records `camera` telemetry.
- Fixed 10-03: pressing Create again with unchanged settings did nothing (an identical finished request was
  answered as "already satisfied"). The button now reads "Regenerate N Clips" in that case and sends
  `regenerate: true`, which starts a new request (fresh renders under a new request key); retries and
  double-submits of an in-progress request are still de-duplicated. Test: `test-clip-selection-flow.cjs`.
- Design changes 10-03 (user request; street3 geometry unchanged): white hook with red highlighted words, no supporting line, speaker
  punch-in (medium/close alternating at sentence ends, face-safe), semantic-only sparse zoom (inherited
  Automatic 1 zooms replaced), and the pending Results card previews in the Automatic 2 frame instead of the
  Automatic 1-format base. Details: `docs/automatic-2-street3.md`. Existing clips need Regenerate to pick it up.

## One-step entry: upload or YouTube link → Generate (2026-10-04)

The project page's "Generate clips" form is the only entry: a file **or** a YouTube link (tab shown only when
`/videos/import-capabilities` says `youtubeEnabled`), Automatic 1 / Automatic 2, 1–8 clips, one Generate button.
Platform (default YouTube Shorts), clip shape, AI mode and an optional brief sit under "More options". No
deployment/retriever wording reaches users; the only YouTube question is "I have the right to process this video."
- No second pipeline. The form builds the exact clip-selection body the "Create clips" button posts
  (`entryGenerationRequest`, same `generationPayload`/`requestOutputStyle` helpers) and sends it as
  `generationRequest` (multipart JSON string on `POST /projects/:id/videos`, object on `POST /videos/import-url`).
  `parseAutoGeneration` (`videos/auto-generation.ts`) validates it up front: `parseClipCreationRequest`, count
  1..8 (`maxClipCountForDuration` floor), template AUTOMATIC_1/AUTOMATIC_2 only, no referenceId.
- Persistence: `VideoImport.autoGeneration` → `ProcessingJob.autoGeneration` + `autoGenerationStatus`
  (`PENDING → STARTING → STARTED | FAILED`, error in `autoGenerationError`) — migration
  `20261004010000_one_step_generation`. A re-submitted link overwrites the import's request (latest choice wins);
  if that video already exists, `VideosService.requestAutoGeneration` attaches it (starting now if analysed).
- Handoff: `VideosService` listens to BullMQ `QueueEvents('completed')` on the video-processing queue (job id =
  ProcessingJob id) plus a 15 s sweep (and a 2 min release of stale STARTING claims), claims PENDING→STARTING, then
  calls the ordinary `ClipSelectionService.create()`. Analysis is untouched; create() remains idempotent.
- Backend eligibility unchanged (`YOUTUBE_IMPORT_APPROVED`, URL parser, public/non-age-restricted/non-live
  metadata, duration/size limits, ffprobe audio+video). Messages were reworded only; codes are unchanged.
- Progress (one flow): import card "Importing YouTube video… N%" / "Preparing source…" → video card
  `analysisProgressLabel` (Preparing source / Transcribing / Analyzing / Finding clips) with "Then N clips with
  <template> will be created automatically" → "Finding clips…" → "Rendering i / N…" → "Applying Automatic 2…" →
  "Ready". On auto-started videos the old setup panel is folded under "Change template or regenerate".
- Failure: a refused/failed import shows "This YouTube video can't be imported automatically. You can upload the
  video file instead." with "Upload file instead" (reopens the form in upload mode prefilled from the import's
  stored request/settings) and "Try again". A synchronous refusal keeps the form state and offers the same switch.
- Fixed while testing: the browser duration pre-check (`readDuration`) waited forever when the `<video>` never
  loaded metadata (background tabs); it now gives up after 4 s — the backend still enforces the 2 h limit.
- Verified 10-04 in Chrome (disposable project): upload 32 s podcast → Automatic 2 × 3 → auto-started on analysis
  completion (`auto_generation_started` log) → honest PARTIAL 1/3 (INSUFFICIENT_DISTINCT_SOURCE_MOMENTS, short
  source) with the Automatic 2 export ready; unavailable link `watch?v=AAAAAAAAAAA` → VIDEO_UNAVAILABLE fallback,
  settings (Automatic 2, 5, brief) preserved into upload mode. E2E: `youtube-import-enabled/disabled.spec.ts`.
- Stale before this change (not updated): `apps/backend/scripts/test-clip-ui.cjs` asserts pre-redesign strings.

### YouTube import reliability pass (2026-10-04)

- Root cause of "can't be imported automatically" for ordinary public videos: the metadata step ran
  `yt-dlp --dump-single-json`, whose output carries every auto-caption table (2.8 MB for `idJOddK22kg`, a public
  12-min 1080p video). The adapter killed the process at a 2 MB stdout cap and mapped the kill to
  VIDEO_UNAVAILABLE. yt-dlp itself had exited 0 in 3 s. Metadata now prints only compact fields
  (`-O '%(.{id,title,...})j'` + a slim formats list, ~8 KB); the runaway cap is 16 MB and reports its own reason.
- Failure categories (`IMPORT_FAILURE_CODES`, persisted in `VideoImport.errorCode`, real reason in the
  `external_video_import` log): VIDEO_NOT_FOUND, PRIVATE_VIDEO, LOGIN_REQUIRED, AGE_RESTRICTED,
  REGION_RESTRICTED, LIVE_STREAM_UNSUPPORTED, NO_VIDEO_FORMAT, NO_AUDIO_FORMAT, RATE_LIMITED, BOT_CHALLENGE,
  NETWORK_TIMEOUT, DOWNLOAD_FAILED, MEDIA_INVALID, STORAGE_FAILED, UNKNOWN_PROVIDER_ERROR (+ existing
  DURATION_LIMIT, SIZE_LIMIT, IMPORT_UNAVAILABLE for a missing binary/disabled deployment, IMPORT_CANCELLED).
  `classifyYtDlpError` reads yt-dlp's ERROR lines (private → bot → rate-limit → age → region → login order,
  because those messages all contain "sign in"). Each code has a friendly message (`IMPORT_FAILURE_MESSAGES`).
- Early refusal from metadata: live/upcoming/post_live, private, age_limit>0, availability other than
  public/unlisted, no non-DRM video or audio format, duration over the limit. Archived streams (was_live) proceed.
  Unlisted videos are allowed (reachable without sign-in). No cookies or credentials are ever used.
- Format chain (`FORMAT_CHAIN`, no fixed format ids): 1) H.264≤1080p + AAC → MP4; 2) best video≤1080p + best
  audio → MKV; 3) best single file; 4) anything, preferring HLS. Each step is a yt-dlp selector with its own `/`
  fallbacks; a step that cannot be downloaded or yields a file without video/audio moves to the next. Then
  `normalizeImportedMedia` makes the canonical H.264/AAC MP4 (+faststart): copy matching streams, transcode only
  mismatches (libx264 veryfast crf20 / AAC 192k), re-probe, reject anything shorter than retrieved.
- Validation: ffprobe has video+audio, duration>0, 16–8192 px, known codecs/container, size>0; the stored source
  must cover ≥97% of the metadata duration (never truncated), then MinIO size is verified.
- Retries: NETWORK_TIMEOUT and RATE_LIMITED only, `YOUTUBE_IMPORT_MAX_ATTEMPTS` (3) per step, backoff 2/4/8 s
  (rate limit 15/30/60 s), capped 60 s; yt-dlp also gets `--retries 3 --fragment-retries 10`. Private, removed,
  sign-in, age, region and bot-check failures are never retried.
- Timeouts (env, seconds): YOUTUBE_IMPORT_CONNECT_TIMEOUT 30 (socket), YOUTUBE_IMPORT_TOTAL_TIMEOUT 10800 (whole
  import; was 30 min per yt-dlp call), YOUTUBE_IMPORT_STALL_TIMEOUT 300 (no download progress → NETWORK_TIMEOUT,
  retried), YOUTUBE_IMPORT_METADATA_TIMEOUT 180, YOUTUBE_IMPORT_MAX_DURATION 7200 (capped at the platform's 2 h),
  YOUTUBE_IMPORT_MAX_BYTES 4 GiB. Old names are fallbacks. Orphaned IMPORTING rows are requeued at startup after
  max(10 min, stall+5 min) of silence.
- Startup log `event=youtube_import_config` records the resolved binary path and `yt-dlp --version`
  (2026.08.19 from Alpine's repo at build time). Update = rebuild the image (see Dockerfile comment), never
  `apk upgrade` in a running container.
- Frontend: the failure card shows the specific message; "Try again" is the primary action for temporary
  categories, "Upload file instead" otherwise. Input copy: "Paste a public YouTube link".
- Tests: `scripts/test-youtube-import.cjs` (offline: URL parser, classifier against real yt-dlp wording, retry
  policy, chain, messages, config); `scripts/test-youtube-import-fallbacks.cjs` (stub retriever + real FFmpeg:
  chain fallback, WebM VP9/Opus → H.264/AAC MP4, audio-only step skipped, 503 retried, private not retried).
- Restart safety (found 10-04 when a user's import sat at 0% forever): a shutdown used to abort in-flight imports
  as IMPORT_CANCELLED, which left the row IMPORTING with no worker, and boot only reclaimed rows idle >10 min.
  Shutdown now aborts with IMPORT_INTERRUPTED and requeues the row to PENDING; boot reclaims IMPORTING rows idle
  >2 min (this process is the only import worker). Verified live: interrupted at 21:01:44, resumed and READY 21:02:49.
- Imports run `YOUTUBE_IMPORT_CONCURRENCY` (default 2) at a time, so one import never waits behind another; the
  progress estimate falls back to bitrate × duration when YouTube omits DASH sizes; FETCHING_INFO shows
  "Checking video…".
- Verified 10-04 (real import job, disposable project, all first-attempt via step 1, no transcode needed):
  user URL `idJOddK22kg` 12 min 1080p (223 MB, 56 s) then Automatic 2 × 3 delivered; CC-BY 7.7 min 1080p60,
  44 min 720p lecture, 38 min 4K podcast, 21 min tutorial (youtu.be), 8 min 4K drone landscape, 7 s Shorts URL.
  Expected failures: invalid id → INVALID_URL, `AAAAAAAAAAA` → VIDEO_NOT_FOUND, private → PRIVATE_VIDEO,
  age-gated → AGE_RESTRICTED. Members-only/sign-in-only not verified live (no example); covered by unit tests.

### Results cards, styling reliability and editor view (2026-10-04)

- Results: a pending Automatic 2 card no longer plays a "temporary preview" (it played the raw source, e.g.
  4:48 / 12:06). It shows only progress in the Automatic 2 frame (hook + "Queued / Applying style / Rendering
  the final video") and swaps to the finished export when ready (`data-testid=automatic-2-pending`;
  `verify-automatic-2-e2e.cjs` updated). Status line: "Applying Automatic 2… i / N ready". (User request
  10-04; supersedes the 10-03 "preview in the A2 frame" choice.)
- Styling: `GenerationStylingService.ensureStyled` styles clips in a pool (`GENERATION_STYLE_CONCURRENCY`,
  default 2) instead of one by one (3 clips: ~5 min -> ~2.6 min after render). A 60 s sweep
  (`resumeUnstyled`, last 12 h) restarts styling for delivered clips that no live run owns and that are not
  ready/failed - previously a restart between delivery and the first style write left cards pending forever.
- Editor view: the export canvas sits on a pasteboard with a visible frame; card layouts (Automatic 2) default
  to a "Focus" view zoom (hook + video window fill the stage, ~2x; view only, export unchanged) with a Fit/Focus
  toggle; editor opens on the first caption frame instead of 0; projects <=120 s open with the whole timeline in
  view (`FIT_ON_OPEN_MAX_SEC`); the timeline band is drag-resizable (remembered per browser, double-click resets;
  default band unchanged). Fixed a preview/export mismatch: the Automatic 2 camera path made the video element
  wider than the canvas and Tailwind's `video { max-width: 100% }` squeezed it (black strip, wrong framing);
  `maxWidth: 'none'` now matches the export frame.

### Raw look, clip limits and exact clip count (2026-10-04)

- Third automatic look `AUTOMATIC_RAW` ("Raw"): the Automatic 1 edit (selection, start/end boundaries, trims,
  speaker-following vertical framing, zoom in/out) with every presentation layer removed - `rawEditPlan`
  (`editing/raw-edit-plan.ts`) disables hook, captions, word highlights, on-screen text and music; the executor
  gets `sfxDisabled` + `gradeDisabled` (source colour kept; `resolveGradePreset` maps NO_CHANGE to CLEAN_SOCIAL,
  so the opt-out is explicit). Applied in `prepare`, so the persisted plan (Edit / Ask AI) is raw too. Never
  styled in EditMode (style words/components/reference are ignored; the brief still steers selection).
  Offered in the entry form and the Create clips panel. Test: `scripts/test-raw-template.cjs`. Verified: 3/3 Raw
  clips 1080x1920, hookRendered=false, subtitles off, zooms kept.
- Limits: `maxClipCountForDuration` = 8 under 15 min, 20 up to 60 min, 30 up to 120 min (was 8/12/20) for every
  look. Entry form allows up to 30 and caps by the chosen file's length; a YouTube request above its video's
  limit fails to auto-start with "This video allows at most N clips" and keeps the choices.
- Exact count: once every distinct, usable moment is used, selection escalates through fill tiers instead of
  delivering PARTIAL: (1) weaker / <=60% overlapping analysed moments, (2) <=80% overlap, (3) sentence-aligned
  windows slid over the transcript (<=92% overlap, never the same range). Fills keep the hard limits (15-120 s,
  real speech), are only compared against delivered clips and other fills, are appended after every distinct
  moment (`evidence.candidateFill`), and their renders accept a failed final pixel QA as DEGRADED
  (`acceptDegradedQuality`, logged `edited_clip_quality_accepted_as_last_resort`) - first-choice clips stay fully
  gated. PARTIAL now only happens when even fill windows are impossible (e.g. no speech). Telemetry:
  `fillTierReached`, `fillCandidateCount`. Test: `scripts/test-exact-clip-count.cjs`. Verified on the 32 s
  podcast (previously 1/3 PARTIAL): 3/3 COMPLETE via tiers 1-3, one clip accepted as DEGRADED.

### Reliability + Raw layout follow-ups (2026-10-04, afternoon)

- Transcription no longer OOM-kills the AI service on long sources: 16 kHz mono WAV is read in ~10-min windows
  (`WHISPER_CHUNK_SEC`, cut at the quietest 100 ms within +/-8 s), language fixed by the first window, previous
  tail as `initial_prompt`, timestamps offset back; one transcription at a time (`transcription_lock`).
  2 h source: 19 min, AI-service peak 855 MB (was killed). The AI service now runs without `--reload` and every
  app container has `restart: unless-stopped` (a dead worker used to leave a zombie reloader).
  Backend retries transcription on dropped connections / 5xx after waiting for `/health`
  (`AI_TRANSCRIPTION_ATTEMPTS`, default 3).
- One-step requests above the video's limit (YouTube length unknown at submit) are clamped to the limit with a
  visible notice (`autoGeneration.adjustedFrom`) instead of failing to start.
- Raw layout (user decision): Automatic 1's centred card (video in the middle, on-screen information kept by the
  normal FIT logic, speaker framing + switching + zoom) on a plain `DARK_NEUTRAL` (#15171C) surround - the
  executor takes `backgroundMode` from the render context, and fitted shots fill with the same flat colour instead
  of a blurred copy. Raw renders accept a still-failing final pixel QA as DEGRADED (like Automatic 2 skipping it).
  An interim full-frame crop variant was tried and removed at the user's request.
- Endings (all looks, `edit-boundaries.ts`): a usable (finished-sentence, non-continuation) ending always beats an
  unfinished selected one regardless of the score margin; with none in the search windows, the end extends forward
  to the next finished sentence (<= 120 s, never across a 2.5 s silence).
- Clip render queue: `maxStalledCount` 5 (`CLIP_RENDER_MAX_STALLS`) so a restart mid-request resumes instead of
  failing; leftover `/tmp/ai-content-clip-batch-*` source copies are removed when the worker starts.
- Ops note: Docker Desktop's VM (~7.4 GB) can run out of memory with two 1080p renders of a 2 h source plus the
  AI service's loaded models; raising its memory limit is recommended.

## Mobile-first responsive frontend (2026-10-05)

Frontend-only pass; no backend, API contract, pipeline, template or export change.

- **Shell.** Below `lg` the sidebar is replaced by a compact sticky header (logo or Back, page
  title, one contextual action) and a bottom tab bar: Home `/dashboard`, Projects `/projects`
  (new list page), a prominent Create `/create`, Edits `/edit-mode`, More (sheet). Safe-area
  insets via `--safe-*` CSS vars; `--nav-offset` keeps sticky CTAs above the tab bar, and the bar
  steps aside while a text field is focused (`useTypingFlag`, `<html data-keyboard>`).
- **Create.** `/create` is the one-step flow without naming a project first: `UploadVideoForm`
  without `projectId` creates a project named after the file / YouTube id on submit (reused on
  retry), then routes to it. Uploads can be cancelled (`uploadVideo(..., signal)`); offline
  pauses Generate (`useBackendStatus` polls `/health` every 15 s while down).
- **Results.** One card per row on phones; `LazyVideo` mounts the `<video>` only near the
  viewport (poster/placeholder before), pauses off-screen, same src so byte ranges are unchanged.
  Edit / Ask AI / Export are ≥44px; full-screen player in a `BottomSheet`. Long copy (synopsis,
  caption, hashtags) folds behind one tap on phones only. `StageSteps` shows Analyzing → Finding
  moments → Creating clips → Applying Automatic 2 → Ready.
- **Editor on phones** (`md` and below, `useIsMobile` decides which tree mounts): top bar,
  preview, then either the compact timeline (60px header column, one-row toolbar) or ONE docked
  drawer (`EditMobileDrawer`, swipe-down/close), and a horizontally scrolling tool bar (Ask AI,
  Inspect, Captions, Text, Crop, Audio, Style, Adjust, Filters, Overlay, Media). Drawers reuse the
  desktop panel bodies (`EditToolPanelBody`, `EditInspectorContent`, `EditAiContent layout='sheet'`,
  `EditExportPanel`) — no duplicated editing logic. `?panel=ai` opens the AI drawer. Crop picks
  the segment under the playhead, docks compact controls, supports one-finger pan and two-finger
  pinch (same `setCropZoom`, so export parity is untouched). Timeline touch: swipe scrolls, tap
  selects/seeks, a selected block (touch-action none) and trim handles (wider on coarse pointers)
  drag. iOS keyboard: the editor pins itself to `visualViewport`; Android uses
  `interactive-widget=resizes-content`.
- **Desktop** is unchanged (≥768 for the editor shell, ≥1024 for the app sidebar), except tablets
  (<1024) open the editor with the floating Media panel closed.
- **Verification.** `npx playwright test e2e/mobile-responsive.spec.ts` (read-only; A shell +
  overflow at 320/360/375/390/412/430, B create, C result cards, D editor/AI/crop/export, E backend
  offline). Overflow audit 63/63 page×width combinations clean (320–1440). Real phone-viewport
  create upload and CDP touch crop (pinch → Done → Undo restores) verified on the local stack.
- **Limits.** Real iOS Safari/Android keyboards were not available here (emulation only); the
  dashboard is still server-rendered, so an offline backend shows the notice only after SSR fails;
  timeline pinch-zoom is not implemented (zoom buttons remain).

## Unified dark design system (2026-10-06)

Frontend-only; no backend, API contract, generation, editor command, template, subtitle or export
change. Generated media and the Automatic 1/2 previews keep their own colours and fonts.

- **Tokens.** Every chrome colour is a CSS variable in `globals.css` (RGB channels, so Tailwind
  opacity works) exposed as semantic Tailwind colours in `tailwind.config.ts`: surfaces
  `background` #080B14 / `sunken` #0B0F1A / `surface` #121827 / `elevated` #1C2436, `border`
  #2A3042 (+`border-strong`), text `foreground` #F8FAFC / `soft` / `muted-foreground` #94A3B8 /
  `faint`, brand `primary` #8B5CF6 (`-hover` #7C3AED, `-soft` for text on dark), `secondary`
  #22D3EE (progress, live/active indicators, spinners), `accent` #F472B6 (decoration only),
  status `success` #34D399 / `warning` #FBBF24 / `danger` #FB7185, neutral washes `tint-*`,
  `inset`, `scrim`, editor lane identities `track-*`, and `stage` #05070D behind video. No raw
  palette (`slate-*`, `violet-*`…) or hex surface classes remain; the only black/white left are
  video stages and media handles. The editor preview canvas stays `rgb(0,0,0)`.
- **Shared pieces.** `.panel`, `.field`, `.btn-primary`, `.eyebrow`, `.empty-state`; `Button`
  gains `destructive`/`lg`; one `ConfirmDialog` (a `BottomSheet` on phones, `role=alertdialog`)
  replaces the native `window.confirm` on result cards and the bespoke History dialog.
- **Type.** `next/font` self-hosts Inter (body, forms; `--font-sans`) and Manrope (headings,
  nav, CTAs, option titles; `--font-display`), both variable with metric-matched fallbacks. The
  editor's caption fonts are untouched: next/font registers hashed family names, so the literal
  `Inter` in caption stacks still resolves exactly as before.
- **Layout fixes found on the way.** Implicit `auto` grid columns let min-content push Create
  (320px), result cards and the editor Inspector rows past their container (already true in
  production, worse with the wider fonts); those grids are now `grid-cols-[minmax(0,1fr)]`. The
  video lane relied on CSS order for `track.color` vs `bg-transparent`; it now uses the tint only.
- **Verification.** Typecheck + production build; all 173 semantic classes present in the built
  CSS; 49 page×width screenshots (320/375/390/430/768/1024/1440) with Inter/Manrope computed and no
  page or element overflow; read-only phone check of Create, History, results, Edit, Ask AI
  consent→chat, Export and delete-confirm/cancel (38/38). The Playwright suites have 8 failures
  that fail identically on the previous commit (stale expectations: Ask AI consent, empty History,
  removed test ids); none are new.

## Explicitly deferred

- LLM features
- Clip selection and generation
- Emotion detection
- Hooks
- Captions
- Hashtags
- Viral scoring
- Authentication, publishing, analytics, and other later milestones

## Milestone 3 verification (prior baseline)

- Prisma schema formatting and client generation pass.
- Backend TypeScript checking passes.
- Python transcription service syntax checking passes.
- Docker Compose configuration validation passes.
- Backend and AI service container builds pass with the pinned dependencies.
- Both service health endpoints pass after container recreation and database schema sync.
- A disposable spoken-video upload completed end to end at progress 100.
- The transcript endpoint returned the expected text and a persisted segment with start 0 and end 5 seconds.
- All disposable database records, MinIO objects, and local test media were removed after verification.
