# Shared Content Intelligence and Creative Quality

## Final release acceptance — 2026-10-09

English human acceptance is **COMPLETE**. The operator explicitly passed Advice, Repaired Delivery and Cultural-Fusion for meaningful start, complete ending, hook truthfulness, natural/clickable hook and overall quality. Delivery's two name checks, neither matching, and delivery-fraud context were separately human-confirmed. The original Delivery start failed; the recovered authorized full source and waveform alignment established its old 70.00-second offset. The repaired interval is **68.97–96.62 seconds**, restoring “Now, if you may recall yesterday” while keeping the accepted hook and ending. All three canonical style renders pass the 14 boundary checks, timing, fit and audio-alignment checks.

The final regression run after human sign-off passed **25/25 current scripts with no skips**, backend/shared/frontend type checks, **9 template visual cases** and **18 final-hook renders**. This includes boundary checks, StyleZero/StyleOne/StyleTwo, Quick Reframe, editor/History, Ask AI hook rewrite, strong-hook preservation and explicit change-hook behavior. Eight real PostgreSQL persistence checks passed in a newly created disposable database, which was removed after verification.

The shared source-start guard rejects a short verbless fragment even at source timestamp zero; no earlier context is fabricated. Automatic generation preserves a strong existing hook. Explicit changes exclude the old hook, clear the selected-hook override, and share retained-source grounding across editor, Ask AI and Quick Reframe; generated hook overlays cannot ground themselves. Canonical template geometry, fonts and palettes remain unchanged.

Real Hindi/Hinglish spoken-media certification is **PENDING**, a documented post-release limitation. Both local synthetic language tests are **SYNTHETIC-ASR ACCEPTANCE INCONCLUSIVE**, not real-media certification or a V2 failure. The native transcription routing audit found no obvious forced-language/translation bug; poor synthetic ASR has an inconclusive cause, and confidence-based downstream fail-safe behavior remains unverified. Existing unrelated stale candidate/understanding and worker startup fixtures are documented outside the required 25-script suite. Creative scores remain editorial judgments, with provider latency and run-to-run variation.

Commit/push and production deployment are explicitly authorized following this passing gate. Deployment remains a separate acceptance step requiring backup/restore verification, maintenance, two strict idle checks, local/public health, real-media smoke and cleanup; this local sign-off does not assert a live deployment result.



Implemented in `apps/backend/src/modules/content-intelligence`. The current workspace paths share `ClipBoundaryService`, `ContentUnderstandingService`, `CreativePackageService` and `CreativeQualityService`. The v2 release has completed English human acceptance and the final local regression gate. Production deployment results are recorded separately. See [v2 acceptance and remaining checks](content-intelligence-v2-acceptance.md). Existing adapters preserve stored clip/editor contracts. Historical exported parsing helpers remain for backward compatibility.

## Boundary algorithm

1. Read original timestamped words, segment punctuation and diarization. When words are unavailable, retain whole segments with their actual timestamps; never invent equal-width word timing.
2. Find natural starts/ends using sentence punctuation, Hindi danda, pauses of at least 0.8 seconds and speaker changes. Reject dangling conjunctions and clauses.
3. Recover the beginning of the containing sentence, with up to 12 seconds of pre-roll. Restore nearby questions and dependent openings. Tight-gap continuation fragments allow two bounded hops, at most 24 seconds total. If required context exceeds the budget, prefer a later natural start or reject the candidate.
4. Search staged extensions at 0, +5, +10, +20 and +25 seconds, with exceptional answers/stories bounded at +45 seconds and an explicit reason. Stay within the existing 15–120 second product bounds and source duration. If extension cannot fit, use a complete earlier unit or reject; never certify an arbitrary cut as complete. Explicit topic changes stop the search.
5. Preserve a completed answer after a question, including a continuing answer speaker turn; wait for list items, nearby punchlines and explanation/conclusion markers. Small audio pads stop before the next word.
6. Validate again after editing-plan changes, before rendering. Repair within the available source window or reject before FFmpeg. If the delivered spoken text changes, regenerate its package against that final text.
7. ONLINE adds one bounded semantic selection from at most 24 timestamp-backed safe ranges. It asks whether the start is understandable and the ending resolves the answer, argument, joke, list or story. An unavailable review fails closed. FALLBACK_ONLY retains deterministic checking without cloud calls.

QA contains `START_COMPLETE`, `END_COMPLETE`, `THOUGHT_COMPLETE`, `QUESTION_RESOLVED`, `PUNCHLINE_INCLUDED`, `CONTEXT_SUFFICIENT`, `CONCLUSION_INCLUDED`, `CLAIM_RESOLVED`, `LIST_COMPLETE`, `STORY_BEAT_COMPLETE`, `NO_DANGLING_CLAUSE`, `NO_DANGLING_PRONOUN`, `NO_UNRESOLVED_SETUP` and `VIEWER_SATISFIED_END`. Non-applicable checks pass; absent timing evidence fails automatic clip certification. Raw/final ranges, adjustments, reasons and final QA persist internally. Quick Reframe/manual ranges receive QA and review status without silent trim expansion.

Authored timestamp fixtures demonstrate these repairs:

| Case | Proposed range | Repaired range | Result |
| --- | --- | --- | --- |
| Podcast question/answer | 1.30–19.87s | 0–21.37s | Restores question and final answer sentence |
| Cut sentence | 1.30–16.62s | 0–18.12s | Keeps the final sentence's last word |
| Joke setup/payoff | 1.30–15.97s | 0–17.47s | Includes the punchline |
| Hindi | 1.30–22.47s | 0–23.97s | Uses danda and preserves complete speech |

These are synthetic timestamp examples, separate from the real-media acceptance below. Manual timeline trims remain explicit user edits; the system does not silently expand their chosen crops or timeline ranges.

## Evidence and understanding

`ContentEvidence` is a bounded whitelist: source/range and transcript/visual versions, retained transcript (9,000 characters), previous/next context (1,500 each), boundary QA, up to 20 speaker turns, visual summary (1,500), OCR (2,200), source title/caption/hashtags, scene, tone, template and intent. No credentials, source media URLs or whole project JSON are sent. Generating creative copy does not rerun transcription or vision, and it sends text evidence rather than new video frames.

Quick Reframe evidence follows its confirmed crop, cleanup masks and retained source ranges. Manual editor evidence follows retained source video elements; hidden elements and generated hook/support overlays cannot supply new facts. A source social caption alone cannot authorize content generation without video evidence.

`ContentUnderstanding` has this versioned schema:

```ts
{
  version, evidenceKey,
  mainTopic, subtopic, centralClaim, tension, keyInsight, surprisingPoint,
  emotionalAngle, humorSupported, sarcasmSupported, speakerIntent, audience,
  participants: [{ id, name, role, evidence }], speakerCount,
  conversationRelationship, sceneContext, visibleText, keyEntities,
  question, payoff, bestAngle, watchReason, supportedClaims
}
```

Participant roles allow `HOST`, `GUEST`, `INTERVIEWER`, `INTERVIEWEE`, `SPEAKER`, `NARRATOR`. Current deterministic inference uses diarized question/answer turns for interviewer/interviewee and explicit textual introductions for names. Unknown tracks use “person 1”, etc.; position and face appearance never establish identity or host/guest order. Other roles and difficult relationships can remain unknown.

Existing candidate understanding is reused. Otherwise the separate understanding role can interpret the compact evidence with external consent. Its process cache is keyed by source, range, transcript/visual versions, evidence contents and intelligence version. Pending identical requests coalesce. Understanding and creative caches are bounded to 500 entries; final packages also persist in existing JSON fields. Template/direction/category changes regenerate creative output without repeating unchanged understanding.

## Creative package and quality

The shared package contains ranked hooks, selected hook, concise synopsis, caption variants, Focused/Niche/Broad hashtag sets, optional supporting line, tone and context summary. Internal fields retain quality results, routing attempts, escalation count and understanding version. Public package/card/History views omit internal model routes and scores.

Supported hook categories include the existing eleven plus **Hidden Truth, Unexpected Result, Tension, Challenge, Conflict, Mistake, Wait Until, Myth/Reality, Before/After and Reveal**. Humor and sarcasm require supporting evidence. The writer is asked for a pool of 15 candidates in a fixed mechanism mix (3 curiosity gap, 2 contrarian, 2 hidden truth, 2 tension, 2 question, 2 story tease, 1 emotional, 1 bold claim) in the dominant spoken register, each with a short `support` naming the clip moment it rests on. A repair pass asks for 10 (hook rewrite) or 6 (full package) fresh candidates. Native transcription is explicitly requested for new Create Clips and editor analysis; Quick Reframe already requests it.

Hooks allow 4–26 words and 320 characters: short 4–8, normal 8–14, long 14–22 and exceptional up to 26. Similarity checks reject five-word contiguous copies, three copied words comprising at least 70% of the hook, or at least 90% token overlap with a transcript sentence. Near duplicates are removed; at most two per category remain. Model output must pass clickability ≥70, context ≥65, specificity ≥45 and novelty ≥60, plus grounding ≥70 and misleading risk ≤30, before package evaluation. Local fallback remains explicitly limited and can require review.

Ranking exposes separate `CLICKABILITY_SCORE` and `CONTEXT_SCORE`, with relevance, faithfulness, novelty, specificity, clarity, curiosity, emotional pull, tension, mobile readability, tone fit, copy similarity, genericness, misleading-risk and template-fit components. For hooks a model reviewed, clickability, context, grounding, misleading risk, specificity and naturalness are the reviewer's scores of meaning; novelty stays an objective measure of transcript copying. The keyword/word-overlap heuristics now score only locally generated hooks that no model reviewed. None of these are measured audience retention. Delivered transcript/OCR/visual evidence supplies context; metadata alone cannot rescue an unrelated hook. Reusable generic frames receive a novelty penalty. Factual and semantic checks remain mandatory. Basic English plurals are normalized and Hindi combining marks retained.

### Hook selection pipeline

Writer and reviewer share one definition of a strong hook (`HOOK_RUBRIC`: clickability, curiosity gap, specificity, contextual relevance, truthful framing, natural/stand-alone language, audience appeal). **Grounding means the implied claim, tension or question is supported by the clip, not that the hook reuses its words**: inference ("the real reason…", "what nobody tells you…") is allowed only where the clip supports it, and a hook may claim only as much as the moment it rests on shows (no example generalised into a mechanism, no why-question the clip does not answer, no attribution the clip does not make).

1. **Objective screen** (`CreativeQualityService.screen`, reasons recorded per hook): schema, duplicates/exclusions, 4–26 words and 320 characters, unsupported numbers/quotes/attributed names and filler clickbait, invented names (mid-sentence proper nouns, CamelCase brands and acronyms the clip never mentions; Title Case headlines only checked for brands/acronyms), topic-description wording, transcript copying, unsupported humor/sarcasm. Word overlap with the transcript is **not** a gate here.
2. **Shortlist**: up to eight survivors, one per mechanism in a fixed priority order, never ordered by keyword scores.
3. **One reviewer call** scores every shortlisted hook independently (clickability, context, grounding, misleading risk, specificity, naturalness, summary-like, approved, plus a short issue/why). Full packages add the synopsis/captions/hashtags/supporting line to the same call. A hook is approved only if it meets every bar; one flawed alternate can no longer reject a strong hook. A truncated or malformed reply is retried once on double the budget. A reviewer outage is **not** a creative verdict: it never triggers escalation and ends `NEEDS_REVIEW` (`GROUNDING_REVIEW_UNAVAILABLE`).
4. **Order**: comfortably grounded hooks first, then the more clickable and specific one (see the two-tier choice below); among approved hooks one that fits every template unshortened is preferred unless it trails by more than 10 points. A long hook is never rejected for length.
5. **Result**: one approved hook that clears the composite quality bar (`CREATIVE_QUALITY_THRESHOLD`, 75) is a complete `ACCEPTED` result; alternates are a convenience. The old requirement of three surviving hooks (`INSUFFICIENT_DISTINCT_HOOKS`) measured pool size after word-overlap filtering and has been removed.
6. **Repair** (at most one, stronger model, only after a creative rejection): the writer receives the exact reasons per rejected hook (verdict codes, scores, reviewer wording) and plain instructions such as "Previous hook was too generic. Increase specificity and stakes" or "Previous hook was misleading… keep the curiosity but remove the unsupported implication", plus the hooks that did pass.

`CreativePackageService.scoreHooks` runs the identical screen and reviewer over arbitrary hooks for benchmarks and calibration.

**Final calibration additions (2026-10-09, third pass).**

- **Stand-alone hooks.** Model-written hooks that open with a third-person pronoun (they, he, she, their…) are refused by the objective screen (`UNRESOLVED_PRONOUN`; not applied to locally shortened user wording), and the reviewer flags `unclearReference` for any pronoun or reference a viewer who has not heard the clip cannot resolve. A `naturalness` bar of 70 joins the others. Speed or intensity claims the clip never makes ("instantly", "in seconds", "immediately") are refused objectively (`UNSUPPORTED_DETAIL`). The writer is told to use plain punctuation (no em or en dashes): some templates export a dash as a hyphen, and dashes make copy read as machine-written.
- **Position-neutral review.** The reviewer used to see the hooks in a fixed order, which measurably biased it: the same hook was approved 4/6 when listed first or in the middle but 1/6 when listed last. The list is now shown in a seeded, content-derived order (deterministic for a given pool).
- **Two-tier choice.** Among approved hooks, a *comfortably grounded* hook (grounding ≥85, misleading risk ≤15) always outranks a marginal one, and within a tier the more clickable and specific hook wins. This replaced a single safety-heavy blend that kept choosing slogan-like lines ("Sustainable boundaries require accepting disagreement"). Bars and the composite are unchanged.
- **Keep a good existing hook.** `CreativeRequest.existingHook` makes the pipeline judge a hook already on the clip by the same screen and reviewer (in the same single reviewer call) and keep it unless a generated rewrite beats it by at least 8 composite points or the existing hook has a known problem (fails the screen or a bar, composite below 75, or does not fit the templates while a rewrite does). It is an API on the shared service, used by the acceptance harness; it is not wired into the editor's explicit "change my hook" flows, which must still return a different hook.
- **No silent downgrade.** A package that misses only the composite bar, or fails on its copy, keeps its reviewer-approved hooks (still `NEEDS_REVIEW`); local template hooks are used only when no hook was approved. The offline editor assistant likewise refuses to propose a weak local hook and asks for the user's own wording (see the updated `test-generated-clip-edit-project`).
- **Timings.** Each attempt records `generationMs`, `screenMs`, `reviewMs` and `attemptMs` in the internal trace (`internal.trace[].timings`, never in the public package), plus `internal.timings.understandingMs` and `totalMs`.

The full-package gate requires an approved hook, a specific synopsis, grounded non-repeating captions, relevant small hashtag sets and a useful distinct supporting line. Empty support is allowed. A separate model-assisted critic checks semantic claims, entities, missing takeaway, misleading promises, sensitive-context humor and hashtag relevance. Lexical failures are split. Hard failures (missing or filler copy, unsupported numbers/quotes/attributed names, captions or support repeating a hook, spam or malformed hashtag sets, no approved hook, a filler or invented-fact synopsis) can never be cleared. Paraphrase-only failures (`SYNOPSIS_LOW_OVERLAP`, `CAPTION_LOW_OVERLAP`, `HASHTAG_LOW_OVERLAP`, `SUPPORTING_LINE_LOW_OVERLAP`: accurate copy or related-topic tags such as `#PeoplePleasing` that share too few literal words with the transcript) are sent to the semantic critic, and only a supported review clears them. Hard factual checks still apply to every surfaced component after review. A failed semantic review's copy is replaced by grounded local suggestions and marked `NEEDS_REVIEW`, rather than surfaced as an accepted model package.

## Routing and cost

| Variable | Default/behavior |
| --- | --- |
| `CREATIVE_PRIMARY_MODEL` | Empty: use existing configured creative role route |
| `CREATIVE_ESCALATION_MODEL` | Empty: repair retry on the primary model. Production: `gpt-6.1-sol` (ignored `.env`) |
| `CREATIVE_QUALITY_THRESHOLD` | 75, clamped to 0–100 |
| `CREATIVE_MAX_ESCALATION_ATTEMPTS` | 1; clamped to 0–1 |
| `CREATIVE_GROUNDING_REVIEW` | true; semantic review on eligible external drafts |

Configure the escalation model only with an actual available higher-capability model for the production provider/account. No new model name or API key is hardcoded. Model overrides apply only to creative roles, not transcription, vision, understanding or edit planning. Routing keeps the existing credentials, role timeouts, budgets, provider failures and circuits. Different tiers/models have different cache keys. If the escalation variable is empty, the single repair request uses the existing route with stronger instructions; that is a retry, not a verified capability upgrade. Overrides are applied only to the OpenAI route, so an OpenAI model ID is never sent to another provider.

Production routing (configured 2026-10-08): primary creative, understanding and the semantic critic use `OPENAI_MODEL` (`gpt-5.6-luna`, budget tier). `CREATIVE_ESCALATION_MODEL=gpt-6.1-sol` (GPT-6.1 Sol, a newer, higher-capability tier listed for this account at $2/$10 per 1M input/output tokens versus Luna's $0.20/$1.20) is used only for the one repair attempt after `CreativeQualityService` or the semantic critic rejects a draft. A provider failure (timeout, 5xx) on the first call is not a quality verdict: it retries the primary tier and never escalates. Each escalation logs a server-side `shared_creative_escalation` event (failures, score); model names appear only in server logs and internal package metadata, never in public package, card or History responses.

An uncached external package uses at most one understanding call (zero when existing analysis is supplied), two creative calls and two reviewer calls (one per generation attempt; the reviewer judges the hooks and, for full packages, the copy in the same call, and is retried once only after a fault). Hook-only requests use a smaller output budget and reuse understanding. Measured on the three authorized real clips: a first-pass hook rewrite is two calls, about 14 s (writer median 6.5 s, reviewer median 7.5 s); a repair adds a stronger-model call (about 9-12 s for hooks, kept to 6 hooks for full packages because that model writes about 45 tokens/s against a 20 s ceiling) and a second review. Repeated identical requests are cached; local generation makes no provider calls. Provider chain failover can add attempts within the existing router policy. Actual currency cost depends on configured models/provider pricing and usage; no price estimate is assumed.

## Product integration

- Create Clips: repaired candidate → existing understanding → shared creative generation/gate → final boundary validation → render. StyleZero, StyleOne and clean cuts preserve their existing render/credit/variant contracts.
- Render packaging and edit-plan hook selection consume the shared package. If speech changes, its copy is regenerated and its hook reranked against delivered speech.
- StyleOne styling takes hook options and the optional supporting line from the persisted final package. Existing layouts that intentionally omit support remain unchanged.
- Quick Reframe hooks and post copy are adapters to the shared service. Hook regeneration preserves caption/hashtag choices; revision and post-copy comparisons prevent stale writes. Initial local StyleOne suggestions persist understanding metadata too.
- Manual editor Suggested Hooks uses the shared endpoint, with category and rewrite direction controls. “Write post copy” produces a full package. Hook-only changes preserve copy; stored copy provenance prevents showing earlier-revision copy as current.
- Ask AI hook proposals use the same generator while keeping canonical Apply/undo behavior.
- History reads final selected hook, synopsis, caption, hashtags and understanding version from persisted packages. It exposes expandable post copy with a copy button; internal routing metadata remains server-side.

## Examples

Before: **“Stop trying to make everyone like you”** repeats spoken advice.

After, grounded in the authored approval/boundaries fixture:

- **“Whose approval gets to decide your boundaries?”** — actual Create Clips rendered headline.
- **“A boundary is not sustainable without some disapproval”** — actual accepted online Quick Reframe recommendation.
- **“Where approval ends, boundaries begin”** — local shared reframing.

Before synopsis: “This clip talks about success and mindset.”

Actual accepted online synopsis: “Chasing approval makes decisions depend on other people and encourages commitments you cannot sustain. The speaker explains that protecting focused work requires saying no and accepting that some people may disagree, making boundaries more sustainable.”

Actual online concise caption: “Protecting your priorities sometimes means disappointing people.”

Actual accepted Focused tags: `#PersonalBoundaries #ApprovalSeeking #ProtectYourTime`. Other local relevant tags include `#Boundaries #Approval #Decisions #SustainableBoundaries`. No generic trending spam is added.

## Verification and deployment state

The sections below record **historical v1 acceptance**, including its now-rejected setup-only ending. Current local v2 verification and unresolved acceptance are in [the v2 report](content-intelligence-v2-acceptance.md). No v2 deployment has occurred.

Final validation passed: 24 regression commands, including the A–J intelligence dataset, boundary adapter, candidate/shared-package consistency, model routing, creative packaging, Quick Reframe, manual editing, Ask AI chat, History/selection contracts, credits/idempotency paths, the current 60-check frontend suite and real FFmpeg/FFprobe export variants. Backend/shared builds, frontend type checking and the static Cloudflare-compatible frontend build also passed. The historic `test:clips` UI entry point now delegates to the current unified UI suite and checks the shared creative controls; its obsolete checks referenced retired labels and a removed workspace file.

The new `test-content-intelligence.cjs` regression dataset contains ten authored cases: podcast answer, sentence cutoff, joke/payoff, emotional story, serious advice, debate, Hindi, Hinglish, imported caption context and screen tutorial/OCR. Each checks repaired edges, grounded novel bounded hooks, specific synopsis, matching captions, relevant sets and non-duplicate copy. Additional tests cover exact last-word boundaries, pauses, speaker changes, complete answers, unfinished lists, impossible duration, absent timings, retained-context filtering, unsupported names/numbers, serious tone, semantic rejection, cache reuse and one creative escalation with analysis routing unaffected.

The live test uses the actual production service images and compiled workspace code, isolated from production data: port 4100, a disposable database, Redis, MinIO and AI worker. A newly authored 37.9167-second synthetic speech video was uploaded through normal authenticated APIs. Real OpenAI calls used the already configured provider model. Create Clips → StyleOne exported 1080×1920 at 34.96 seconds; Quick Reframe → Manual exported 1280×720 at 37.9167 seconds. The latter full creative package was `ACCEPTED` with no warnings. The run also checked History copy and generic manual full-package generation.

Both rendered videos were downloaded, probed and inspected at their first and final speech frames. Re-transcribing their actual rendered audio in the isolated local worker confirmed the opening “Why does chasing approval weaken boundaries?” and final “That is how your boundaries become sustainable.” The StyleOne final spoken word ended at 34.66 seconds, inside its 34.96-second output. This is real-media verification using production code in isolation, not a public-production deployment test.

Artifacts are intentionally ignored under `.real-qa-preview/content-intelligence/`: `live-report.json`, both MP4 exports, frame PNGs, `media-inspection.json`, `rendered-audio-verification.json` and regression reports. They contain only authored test evidence, not credentials. The reusable guarded runner is `apps/backend/scripts/verify-content-intelligence-live.cjs`; it refuses production API URLs. Model tier escalation was first verified through the real router with a controlled provider.

### Live escalation and conversational acceptance (2026-10-08)

`apps/backend/scripts/verify-creative-escalation-live.cjs` injects an intentionally weak primary draft (transcript-copied hooks, filler synopsis, `#viral` tags) and runs the rest through the real router and OpenAI. Result: rejected with five failures, one escalation to `gpt-6.1-sol` (12.1 s), semantic review on `gpt-5.6-luna`, `ACCEPTED` at 91. Understanding ran once before generation; no transcription, OCR, vision or boundary work is reachable from the creative service. The run also exposed that the strong model's accurate paraphrased captions and related tags failed the old all-lexical gate, which caused the hard/soft split above.

The conversational acceptance used a real, owner-authorized 32-second two-host show excerpt (food-delivery fraud story) on an isolated compose project (`xeeqa`: own Postgres/Redis/MinIO/AI worker, API on 127.0.0.1:4100) running the release image, ONLINE with real OpenAI: `INTEL_QA_ONLINE=true INTEL_QA_MEDIA=<mp4> INTEL_QA_OUT=.real-qa-preview/conversational-acceptance node scripts/verify-content-intelligence-live.cjs`. Both paths passed. In the release run, four first drafts (Luna) were rejected by the gate or critic; all four escalated to `gpt-6.1-sol` and all four escalated packages were `ACCEPTED` (scores 87–91), across the Create Clips candidate/export packages and Quick Reframe hooks/post copy. (An earlier run of the same media had one escalated candidate package rejected by the critic for overclaiming; export-time packaging then produced an accepted package.)

- Create Clips → StyleOne: 1080×1920, 30.0 s, H.264/AAC 48 kHz, decodes cleanly. Re-transcribed rendered audio starts at the source's first words ("Hey, recall yesterday") and ends on the complete sentence "…we ordered lunch that day." 0.32 s before the end. The edited-clip gate passed start/end/continuation checks. Hook "What can one lunch order actually prove?" is the shared package's selected hook and the StyleOne HOOK element. The package is `ACCEPTED`; its synopsis/caption say the test's result is not shown; tags include `#DoorDash #SuspectedFraud`.
- Quick Reframe → Manual: 1280×720, 32.0 s, valid; final word "day." 0.62 s before the end. Its package is `ACCEPTED` with the same `content-intelligence-v1` understanding version, hooks such as "Who's actually delivering your DoorDash order?", an accurate synopsis and Focused/Niche/Broad tags (`#DoorDash #UberEats #DeliveryFraud`, …).
- The excerpt's last sentence sets up a test whose result lies beyond the 32-second source. The clip ends on a complete sentence, but the story payoff is not available to include (the gate reports `clipEndPayoffDelivered: false`). The copy honestly says so instead of inventing an outcome. The in-clip question ("Let's see if this really is Gregory") is answered in the clip ("And it's not").

Existing unrelated authentication changes were preserved. No database migration is needed; this uses existing JSON fields. Configure model overrides before rollout, rebuild/restart the laptop backend, and publish the verified static frontend through the existing deployment procedure when rollout is authorized.

The four disposable QA containers and `content_intelligence_test_20261008` database were removed after verification. Original backend, frontend, AI worker, Postgres, Redis and MinIO containers remained running; existing networks and model volumes were retained. Saved acceptance videos and reports remain in the ignored local artifact directory.

## Limits

- Boundary completion uses deterministic discourse/timing heuristics, not a proof of arbitrary conversational completeness. ASR punctuation, inaccurate timestamps, overlapping speech, very long answers and references requiring more than the bounded context can still require rejection/review.
- Automatic v2 clip exports reject missing timing evidence. Explicit manual timelines remain editable and their copy is marked for review.
- Local fallback produces safe limited suggestions and can be marked `NEEDS_REVIEW` when diversity/quality is insufficient. It cannot match a capable creative model across all genres or languages. Hindi/Hinglish regression coverage is authored text/timing coverage, not live multilingual media acceptance.
- Grounding of model hooks is judged by a reviewer model, not proved. It is deterministic at temperature 0 but not perfectly consistent on borderline over-generalisation (in a 3-run calibration of 41 hand-labelled hooks, flat summaries and invented claims were never approved, but clickbait phrasing and a few overstated-but-plausible hooks flipped between runs). The objective screen cannot judge meaning; the reviewer can be wrong. The system does not promise virality or universal creative quality.
- Reviewer scores are context-dependent: the same hook can move by 10-15 points between batches, and an existing hook the reviewer judges at the clickability bar can be kept or replaced from run to run. Pass/fail decisions for a hook should rest on repeated scoring, not one sample.
- Em dashes in hooks export as hyphen-length marks in StyleZero/StyleOne on the QA machine (font fallback); the writer is told not to use them, and the platform fallback appearance remains a portability limit.
- Avoidable duplicate model calls remain outside `create()`: changing only the template/style with identical speech regenerates the whole creative output (a writer and a reviewer call, about 15 s), because `template` is part of both the request key and the prompt evidence; candidate packages in `judgeCandidates` run one after another; Quick Reframe's post copy and its hook suggestions are separate generations for the same clip.
- Memory caches reset on process restart. Persisted candidate/package reuse remains, but there is no new distributed understanding-cache table.
- Escalation adds a stronger-model call and a second review (roughly 17-25 s) to a rejected package; each call stays inside its own ceiling (writer 20 s, reviewer 12 s). The reviewer stays on the budget model and can still reject the stronger model's copy as overclaiming; the package then falls back to limited local suggestions until export-time packaging regenerates copy for the delivered speech.
- Local fallback copy for unscripted conversation remains generic (for example "What's behind dordash and fraud?"). Spoken filler words are now excluded from topic terms, but fallback is not a substitute for the online path.
