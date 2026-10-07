# Shared Content Intelligence and Creative Quality

Implemented in `apps/backend/src/modules/content-intelligence`. The active production paths share `ClipBoundaryService`, `ContentUnderstandingService`, `CreativePackageService` and `CreativeQualityService`. Existing adapters preserve stored clip/editor contracts. Historical exported parsing helpers remain for backward compatibility; they are not the active creative generator.

## Boundary algorithm

1. Read original timestamped words, segment punctuation and diarization. When words are unavailable, retain whole segments with their actual timestamps; never invent equal-width word timing.
2. Find natural starts/ends using sentence punctuation, Hindi danda, pauses of at least 0.8 seconds and speaker changes. Reject dangling conjunctions and clauses.
3. Recover the beginning of the containing sentence, with up to 6 seconds of pre-roll. Include a preceding sentence for dependent openings when it fits. If the required context exceeds the budget, prefer a later natural start or reject the candidate.
4. Find the earliest complete ending at or beyond the proposed end, with up to 12 seconds of extension. Stay within the existing 15–120 second product bounds and source duration. If extension cannot fit, use a complete earlier thought; never certify an arbitrary cut as complete.
5. Preserve a completed answer after a question, including a continuing answer speaker turn; wait for list items, nearby punchlines and explanation/conclusion markers. Small audio pads stop before the next word.
6. Validate again after editing-plan changes, before rendering. Repair within the available source window or reject before FFmpeg. If the delivered spoken text changes, regenerate its package against that final text.

QA contains `START_COMPLETE`, `END_COMPLETE`, `THOUGHT_COMPLETE`, `QUESTION_RESOLVED`, `PUNCHLINE_INCLUDED` and `CONTEXT_SUFFICIENT`. Non-applicable question/punchline checks pass; absent timing evidence is explicitly unknown/false and is not certified. Candidate repair and final QA are persisted internally.

Authored timestamp fixtures demonstrate these repairs:

| Case | Proposed range | Repaired range | Result |
| --- | --- | --- | --- |
| Podcast question/answer | 1.30–19.87s | 0–21.37s | Restores question and final answer sentence |
| Cut sentence | 1.30–16.62s | 0–18.12s | Keeps the final sentence's last word |
| Joke setup/payoff | 1.30–15.97s | 0–17.47s | Includes the punchline |
| Hindi | 1.30–22.47s | 0–23.97s | Uses danda and preserves complete speech |

These are synthetic timestamp examples, separate from the real-media acceptance below. Manual timeline trims remain explicit user edits; the system does not silently expand their chosen crops or timeline ranges.

## Evidence and understanding

`ContentEvidence` is a bounded whitelist: source/range and transcript/visual versions, retained transcript (9,000 characters), previous/next context (700 each), up to 20 speaker turns, visual summary (1,500), OCR (2,200), source title/caption/hashtags, scene, tone, template and intent. No credentials, source media URLs or whole project JSON are sent. Generating creative copy does not rerun transcription or vision, and it sends text evidence rather than new video frames.

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

Supported hook categories: **Bold, Curiosity, Contrarian, Sarcastic, Humorous, Emotional, Question, Authority/Insight, Story, Warning, Professional**. Humor and sarcasm require supporting evidence and are suppressed for sensitive serious subjects. The model is instructed to produce new angles in the spoken language, rather than subtitles or synonym substitutions.

Hooks are limited to 3–12 words and 64 characters. Similarity checks reject a contiguous copy of five words, three copied words comprising at least 70% of the hook, or at least 90% token overlap with a transcript sentence. Near-duplicate angles are removed; at most two candidates per category and sixteen total remain. One is Recommended.

Ranking measures relevance, faithfulness, novelty, clarity, curiosity, emotional pull, brevity, mobile readability and tone fit. Reusable generic framing receives a novelty penalty. Deterministic grounding rejects unsupported numbers and quotes, certain unsupported named references, generic marketing/virality promises and poor evidence overlap. Basic English plural forms are normalized; Unicode combining marks are retained for Hindi.

The full-package gate requires several distinct hooks, a specific synopsis, grounded non-repeating captions, relevant small hashtag sets and a useful distinct supporting line. Empty support is allowed. A separate model-assisted critic checks semantic claims, entities, missing takeaway, misleading promises, sensitive-context humor and hashtag relevance. Lexical failures are split. Hard failures (missing or filler copy, unsupported numbers/quotes/attributed names, captions or support repeating a hook, spam or malformed hashtag sets, too few novel hooks, non-specific synopsis) can never be cleared. Paraphrase-only failures (`CAPTION_LOW_OVERLAP`, `HASHTAG_LOW_OVERLAP`, `SUPPORTING_LINE_LOW_OVERLAP`: accurate copy or related-topic tags such as `#PeoplePleasing` that share too few literal words with the transcript) are sent to the semantic critic, and only a supported review clears them. Hard factual checks still apply to every surfaced component after review. A failed semantic review's copy is replaced by grounded local suggestions and marked `NEEDS_REVIEW`, rather than surfaced as an accepted model package.

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

An uncached external package uses at most one understanding call (zero when existing analysis is supplied), two creative calls and two semantic reviews. Hook-only requests use a smaller output budget and reuse understanding. Repeated identical requests are cached; local generation makes no provider calls. Provider chain failover can add attempts within the existing router policy. Actual currency cost depends on configured models/provider pricing and usage; no price estimate is assumed.

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
- No timing evidence is explicitly uncertified; existing compatibility behavior can retain such ranges rather than inventing timing.
- Local fallback produces safe limited suggestions and can be marked `NEEDS_REVIEW` when diversity/quality is insufficient. It cannot match a capable creative model across all genres or languages. Hindi/Hinglish regression coverage is authored text/timing coverage, not live multilingual media acceptance.
- Lexical grounding cannot establish all paraphrased facts; external semantic review is enabled by default, but model evaluation itself can be wrong. The system does not promise virality or universal creative quality.
- Memory caches reset on process restart. Persisted candidate/package reuse remains, but there is no new distributed understanding-cache table.
- Escalation adds ~10–12 s to a rejected package (within the 20 s creative ceiling). The semantic critic stays on the budget model and can reject the stronger model's copy as overclaiming; the package then falls back to limited local suggestions until export-time packaging regenerates copy for the delivered speech.
- Local fallback copy for unscripted conversation remains generic (for example "What's behind dordash and fraud?"). Spoken filler words are now excluded from topic terms, but fallback is not a substitute for the online path.
