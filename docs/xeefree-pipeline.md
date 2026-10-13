# XeeFree pipeline

XeeFree is the free tier: it reasons about a video with **no cloud model of any kind**. It uses local ASR (faster-whisper, optionally the
local medium model for a hard ending), local vision/OCR already in the product, transcript evidence, speaker timing and deterministic
scoring, then the same renderer, editor and templates as XeePro (StyleZero / StyleOne / StyleTwo). The difference between the tiers is the
reasoning layer, not product completeness.

XeePro is unchanged. Nothing here weakens, replaces or reroutes it.

## 1. Hard execution policy

`apps/backend/src/modules/processing/execution-policy.ts` is the single definition.

| | `cloudLLMAllowed` | `openAiAllowed` | `proEscalationAllowed` |
|---|---|---|---|
| XEEFREE | false | false | false |
| XEEPRO | true | true | true |

* The tier comes from the job's AI mode (`ONLINE` is XeePro; `FALLBACK_ONLY` and the legacy `OFFLINE` are XeeFree). A stored or untrusted
  value can never opt a job in. **No execution context at all is XeeFree: the policy fails closed.**
* Enforced in code, not in the UI: `LlmRouterService.generate` and `LlmProviderService.generateStructuredWithConfig` both call
  `assertCloudCallAllowed` before any request is built. A XeeFree attempt throws `XeeFreeProviderViolation`
  (`code = XEEFREE_PROVIDER_VIOLATION`, message prefix `XEEFREE_PROVIDER_VIOLATION`, `kind` still `AI_MODE_FALLBACK_ONLY` so existing "model
  unavailable" handlers keep working). It is never retried and never falls back to a Pro route.
* XeeFree stage services (`VideoUnderstandingService`, `ClipIntelligenceService`) take their deterministic path **without attempting** a
  model call, so a normal XeeFree job records `blockedProviderAttempts = 0`. The guard is the backstop, not the normal path.
* Editor surfaces are tied to the **project**, not the deployment: `projectExecutionPolicy(settings)` reads `settings.origin.aiMode`
  or the recorded generation telemetry. Unknown generated provenance fails closed; standalone projects retain their consent rules.
  Generic settings updates preserve server-owned origin, and materialization/History prefer the clip's recorded tier over newer video jobs.
  A XeeFree project is never planned, worded or reviewed by a model, even if the deployment's chat mode is `ONLINE` or a request sets
  `externalAiAuthorized` (hooks endpoint, Ask AI planner, chat hook writer, presets).
* Internal audit (never sent to clients), on every job's performance telemetry:
  `executionMode`, `openAiCalls`, `cloudLlmCalls`, `proEscalations`, `blockedProviderAttempts`. A XeeFree job must end with
  `executionMode = XEEFREE` and the three call counters at **0**.

## 2. Old architecture and what was weak

Old XeeFree = the `FALLBACK_ONLY` mode of the shared pipeline: Whisper chunks -> regex heuristic scores (opening words, payoff words)
-> boundary repair -> `deterministicCreative`, which built hooks as `What's behind {two most frequent words}?` /
`{a} and {b}: what actually matters?` / `{a} and {b} through the lens of {c} and {d}`. On real transcripts this produced
"What's behind tell and reason?", "money and black through the lens of stolen and slavery", "doordash and fraud: what actually matters?".

Weak areas found in the audit: hooks from raw frequent words; no sentence structure (Whisper chunks treated as sentences); a single
keyword-led score for clip ranking; chunk windows that straddle topics; the ending-ASR path unreachable without an LLM reviewer (a clip with
an uncertain last word was held, never checked with the local stronger model); Ask AI and the hooks endpoint gated by deployment/request
flags rather than by the project's tier; word-level-only zoom emphasis; no caption cleanup; telemetry without a tier audit.

## 3. New architecture (`apps/backend/src/modules/free/`)

| File | Responsibility |
|---|---|
| `free-lexicon.ts` | Small English lexicon: function words, verb forms, generic words, noun/verb ambiguity. No tagger, no network. |
| `free-sentences.ts` | Sentence reconstruction from punctuation, pauses, speaker turns, continuation words; fragments flagged, not offered as thoughts. |
| `free-analysis.ts` | Structured understanding: noun phrases, typed frames (reason, contrast, lead, QA, advice, number, story, opinion, ...), entities, key phrases, numbers, participants. Shared `cachedAnalysis`. |
| `free-moments.ts` | Fifteen-dimension moment score, sentence-granular candidate windows, deterministic diversity order. |
| `free-boundary.ts` | Sentence-level start/end QA with one bounded step out; list and question completeness. |
| `free-hooks.ts` | Typed-slot hook engine, 12-point gate, scoring, selection, existing/manual hook handling. |
| `free-copy.ts` | Grounded synopsis, distinct captions and three hashtag sets; short evidence may support fewer options. |
| `free-creative.ts` | Facade used by `CreativePackageService` for every XeeFree package. |
| `free-captions.ts` | Mechanically safe caption-word repairs. |
| `free-speakers.ts` | Speaker-change stabilisation. |
| `free-emphasis.ts` | Sentence-aware zoom / highlight beats. |

## 4. Understanding

`analyzeEvidence` reconstructs sentences, extracts noun phrases (verbs, gerunds, adverbs and generic heads are excluded structurally),
finds typed frames, and fills the shared `ContentUnderstanding` shape (`freeUnderstanding`) plus richer fields (topic, subtopic, main
claim, question, answer, tension, contrast, payoff, conclusion, facts, key phrases, numbers, entities, supported claims, participants,
key moments). Names and numbers come only from the transcript, OCR text or metadata; nothing is inferred from appearance.

## 5. Boundaries and the local ending-ASR flow

`ClipBoundaryService.repair` preserves a complete already-retained final word when explicitly requested by Free export/semantic repair.
This makes post-word padding idempotent: 150–280 ms of padding no longer jumps into the following sentence. Default Pro repair is unchanged;
word-cut, thought-resolution and EOF gates remain required. `repairSemantic` for XeeFree (a) takes the bounded local base tail pass whenever the ending
is uncertain, (b) for an ending accepted only through an unreliable last word takes **one** pass of the optional local stronger Whisper
model over the same <= 9 s window and compares it with the base reading by consensus (`decideTailCorrection`: confirm, adopt with
provenance, or hold for review), and (c) re-reads the repaired range with the sentence layer and takes at most two bounded steps toward a
finished thought (earlier by <= the pre-roll, later by <= the extension). No model call, no loop, no full-source re-transcription.
An immediately following explicit disagreement also requires the first substantive response: a grammatically complete claim followed
by "I disagree" cannot end the debate alone. The same bounded extension budget applies; an unresolvable response is held.

## 6. Moments, candidates and diversity

Windows are enumerated over reconstructed **sentences** (not Whisper chunks) and re-scored on fifteen 0-100 dimensions with fixed weights
(`FREE_MOMENT_WEIGHTS`, rationale in the source): completeness .14, payoff .12, context .10, specificity .07, QA .07, end .07, tension .06,
density .06, start .06, story .05, speech clarity .05, duration .05, novelty .04, speaker clarity .03, visual stability .03. No dimension
exceeds .14. Count-based signals are normalised per 30 s so a window cannot win by merely containing several unrelated beats, a window that
opens several topics (several answered questions, announced lists, story openers, fresh imperatives) is penalised, a list that announces N
items must deliver them, and a story needs its outcome.

Selection order is made diverse deterministically (maximal marginal relevance over transcript overlap, shared key phrases, same angle,
same speakers, temporal nearness). Each pick depends only on earlier picks, so the first N clips never change when more are requested.

## 7. Hooks

Hooks are bound to typed frames found in the clip and built from templates with typed slots; a slot only accepts a span of the right
grammatical type taken whole from the transcript (CLAUSE needs its own subject, VP starts with a base verb, NP needs a non-generic head).
"What's behind tell and reason?" is unconstructible. Families: Curiosity Gap, Contrarian, Bold Claim, Hidden Truth, Unexpected Result,
Tension, Question, Story Tease, Mistake, Warning, Reveal, Conflict, Emotional, Advice, Problem/Solution, Myth, Challenge, Before/After
(a family is only used when the clip supports it).

Every candidate must pass twelve deterministic checks: `GRAMMAR_OK`, `MEANING_CLEAR`, `CONTEXT_COMPLETE`, `GROUNDED`, `NO_WORD_SALAD`,
`NO_DANGLING_PRONOUN`, `NO_TRANSCRIPT_COPY`, `NO_UNSUPPORTED_NAME`, `NO_UNSUPPORTED_NUMBER`, `NO_MISLEADING_CLAIM`, `NATURAL_HEADLINE`,
`CLICKABLE_ENOUGH`. Notable rules: no first person in a multi-speaker clip; a negation before a quoted span must be carried; a hedge never
becomes a bold claim; a pronoun needs a number-matching noun before it; a headline never ends on a function word or pronoun; profanity and
spoken filler are rejected; a list item is never the headline of its list.

`NO_TRANSCRIPT_COPY` means: no stitched fragments and no verbatim run of more than sixteen words. Ordinary sentence copying is limited to ten words;
the plain fallback permits up to fourteen clean words with a finite predicate, including a literal clause isolated from rambling speech.
A short quoted line (the clip's own
answered question, a compact claim) is allowed and marked `directQuote`; a template-wrapped span of up to eleven words ("The lesson: ...")
is a headline, not a subtitle. When no rich candidate passes, the clearest grounded statement that does is used; if even that fails, the package has no hook and says so
(`NEEDS_REVIEW`). It never pads.

An explicit following disagreement changes a causal headline to a neutral question ("Does remote work kill creativity?").
"Why does..." or an unqualified assertion of the disputed premise fails the misleading-claim gate, even without reliable speaker labels.
Saved "It's not X, it's Y" contrasts use the same idiomatic dummy-pronoun rule as generation; ordinary unexplained pronouns still fail.

Scoring is a deterministic proxy (clarity, specificity, clickability, novelty, context, grounding, misleading risk). Because it is not a
reviewer model it has its own acceptance bars (`FREE_HOOK_POLICY`: clickability >= 60, novelty >= 50, specificity >= 40); XeePro hooks keep the original bars.

Existing hooks: a **manual** hook always wins unless the user explicitly asks for a rewrite; a previously generated hook that still passes
the gate is kept unless the best new hook is better by `existingHookMargin` points; one that fails is replaced. Direction text ("shorter",
"bolder", "a question", "clearer", ...) changes the ranking, never the gate.

## 8. Captions, speakers, zoom, styles

* **Captions** (`cleanCaptionWords`): collapse a repeated word or 2-4 word fragment unless it is a real emphatic repeat, attach punctuation-only tokens,
  restore sentence casing and "I", and rejoin ASR-split hyphen fragments such as "start -ups". No new semantic words are added; non-English is left as recognised; manual caption edits are never regenerated through it.
  Weak-end caption splits are avoided for generated-clip EditMode captions.
* **Speakers**: diarization blips (A->B->A within 1.6 s) are cancelled before the camera planner, which adds its own confirmation count and
  minimum hold. No face identity is used.
* **Zoom/highlight**: one beat per important sentence (payoff, conclusion, number, contrast turn, cause, answer), spaced >= 4 s, never in the first
  1.5 s or last 1.2 s, bounded by the shared budget; the shared planner still owns face safety and magnitude.
* **Styles**: StyleZero / StyleOne / StyleTwo geometry, fonts, crop and export are unchanged; hooks are checked against all three fitters.

## 9. Ask AI / editor commands

For a XeeFree project the planner never calls a model. Direct commands (trim, zoom, crop, volume, mute, captions, move text, change/shorten/clearer
hook, template and preset changes) run through the deterministic parser. An open-ended request is declined with an explicit XeeFree message and
nothing is changed. The AI state for such a project is `XEEFREE`, and no consent prompt is required because nothing is sent anywhere.
The global consent guard verifies ownership and persisted Free provenance before allowing these local requests without cloud opt-in.
Pro and standalone requests retain their existing cloud consent requirement.

Project metadata saves retry only rolled-back PostgreSQL P2034 conflicts, at most three attempts. Each attempt re-reads the expected
revision; a competing user save returns a stale-revision conflict rather than overwriting it. Repeated contention returns HTTP 409,
with no duplicate History row. This retry is separate from rendering or provider requests.

## 10. Languages

English is the supported language. Hindi, Hinglish and other languages **are not production-certified**: no English template is applied to
them; one verbatim line of the clip is offered, held below the acceptance bar, with a warning and `languageUnverified` in the trace.
Real spoken Hindi/Hinglish certification is still pending (see PROJECT_STATE.md), so this path stays honest rather than clever.

## 11. Verification

```
npm --workspace apps/backend run test:xeefree          # engine + policy (offline)
node apps/backend/scripts/verify-xeefree-asr.cjs <asr.json> ...   # real ASR output -> candidates -> boundaries -> hooks (old vs new via XEEFREE_DIST)
node apps/backend/scripts/verify-xeefree-live.cjs                 # isolated QA stack on :4100 only; full Create Clips / History / editor / Quick Reframe
```

The policy test patches `fetch` and every provider transport to throw, runs every XeeFree surface, asserts zero calls, and includes a
control proving the same harness does see calls under XeePro.

The live QA preload additionally traps the router, structured provider and four transports. `verify-xeefree-provider-audit.cjs`
independently checks stdout/stderr for any entry attempt and all four job counters. The top-up and auth harnesses positively identify
`xeeqa` before touching its database; auth tests create a separate database, Redis service and MinIO bucket.
Results and remaining limitations are in [xeefree-acceptance.md](xeefree-acceptance.md).
