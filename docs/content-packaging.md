# AI content packaging

AI-edited clips are packaged before encode without changing clip discovery, ranking,
boundaries, camera behavior, zoom behavior, grading, worker concurrency, or the
one-full-render path. Normal clips do not enter this flow.

## Pipeline

1. `EntityResolutionService` collects names from title, metadata, description,
   transcript introductions/references, OCR/name cards, whole-video understanding,
   and channel metadata. A name is safe at confidence `>= 0.78`, or at `>= 0.60`
   when at least two evidence-source types agree. Unknown and ambiguous identities
   retain a meaningful role and never become guessed names.
2. `ContentCategoryService` assigns primary/secondary categories and confidence.
   Deterministic archetype, emotional-tone, and source-humor classifiers add the
   clip's editorial context.
3. `ContentPackagingService` creates at least five grounded hook diagnostics,
   validates every candidate, ranks valid candidates with `PackagingHookScorer`,
   and creates separate YouTube Shorts, Instagram Reels, and TikTok copy.
4. The selected package is passed to the existing edit planner. The renderer lays
   out `PODCAST_BOLD` subtitles completely before encode. Hook wording, captions,
   hashtags, and semantic grouping never trigger a second full render.
5. Actual render measurements finalize first-frame and subtitle QA, recompute the
   independent packaging score, emit telemetry, and persist the complete object in
   `GeneratedClip.contentPackaging`.

ONLINE semantic generation is accepted only from the existing GPT-5.6 Luna route;
invalid or failed output uses the deterministic fallback and never falls through to
Ollama. OFFLINE may use the local route before deterministic fallback.
`FALLBACK_ONLY` is deterministic.

## Grounding and ranking

Hooks are checked against the transcript and only the entity names marked safe to
use. Unsupported names, numbers, humor, production meta-language, clickbait,
unresolved pronouns, and duplicates are rejected. Ranking records grounding,
clarity, curiosity, specificity, entity recognition, emotional strength, category
fit, archetype fit, first-frame strength, retention potential, novelty, humor fit,
boldness, and readability. Humor packaging is available only when humor is detected
in the source with sufficient confidence.

The independent packaging score combines identity confidence, hook strength,
curiosity, boldness, humor fit, category fit, caption strength, hashtag relevance,
first-frame strength, and subtitle visual quality. It reports `HIGH`, `MEDIUM`, or
`LOW`; it does not change frozen candidate ranking and never promises virality.

Platform limits are intentionally compact: YouTube Shorts gets 2-4 hashtags,
Instagram Reels 3-8, and TikTok 3-6. Generic trend tags are removed. Captions add
context instead of repeating the on-screen hook.

## PODCAST_BOLD contract

- Requested font: Inter ExtraBold; the production Alpine image installs
  `font-inter` and `font-noto`, and the renderer verifies the family with
  `fc-match`. Missing local fonts are reported as a fallback, never a false pass.
- Size: 72 px at 1080-wide, clamped to 64-84 px.
- Inactive/active colors: `#FFFFFF` / `#FFD400`.
- Outline/shadow: `#111111` at 6 px, with a 2 px black shadow.
- Uppercase at render time only; stored transcript text is unchanged.
- No background box; maximum width 78%; one line preferred, two lines maximum.
- Semantic phrases prefer 2-5 words and permit no more than 6. Punctuation,
  pauses, syntax, semantic boundaries, and exact word timestamps determine groups.
- The complete phrase geometry and balanced line break are calculated once. Active
  words change color only, using exact word timestamps, so the block cannot resize,
  reflow, jump, or move.
- Placement retains the existing editorial frame and selects one `NORMAL` or
  `SAFE_HIGH` baseline per shot against faces, source graphics, OCR, lower thirds,
  hook space, and mobile safe zones.

The template enum also reserves `COMEDY_POP`, `EDUCATION_CLEAN`, `FINANCE_BOLD`,
`GAMING_ENERGY`, and `NEWS_EDITORIAL`; those styles are deliberately not implemented.

## QA and telemetry

Packaging QA records entity safety, hook grounding/specificity/meta-language,
boldness/category/humor/readability/first-frame checks, caption relevance and
non-duplication, hashtag relevance/platform limits, subtitle presence/readability,
safe-area and overflow checks, two-line and six-word limits, layout stability,
active-word visibility, timing, face safety, and source-graphic safety. Values are
nullable until real render evidence exists.

Telemetry includes entity/person/speaker/fallback counts, category confidence,
archetype and tone, hook count/style and score components, platform/tag count, the
full subtitle typography/layout/timing measurements, and packaging score/potential.

## Verification

- `npm run test:content-packaging-phase` covers the 20 required deterministic
  scenarios.
- `npm run verify:content-packaging-visual` renders three real-media samples with
  concurrency two and one full render each.
- The generated comparison report and manifest are under
  `.real-qa-preview/content-packaging-phase/`.

The checked Windows visual host does not have Inter/fontconfig, so its sample runs
honestly report `subtitleFontValid` as degraded and use the resolved fallback. The
production container installs and verifies Inter. Existing conservative grading
diagnostics can also mark a sample degraded; none of these degradations is converted
to a pass.
