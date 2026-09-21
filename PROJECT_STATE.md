# Project State

Last updated: 2026-09-21

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
