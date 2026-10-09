# Content Intelligence v2 — local implementation and acceptance

Date: 2026-10-09. Workspace: `C:\projects\ai-content-platform`.

## Final release acceptance — 2026-10-09

English human acceptance is **COMPLETE**. The operator explicitly passed Advice, Repaired Delivery and Cultural-Fusion for meaningful start, complete ending, hook truthfulness, natural/clickable hook and overall quality. Delivery's two name checks, neither matching, and delivery-fraud context were separately human-confirmed. The original Delivery start failed; the recovered authorized full source and waveform alignment established its old 70.00-second offset. The repaired interval is **68.97–96.62 seconds**, restoring “Now, if you may recall yesterday” while keeping the accepted hook and ending. All three canonical style renders pass the 14 boundary checks, timing, fit and audio-alignment checks.

The final regression run after human sign-off passed **25/25 current scripts with no skips**, backend/shared/frontend type checks, **9 template visual cases** and **18 final-hook renders**. This includes boundary checks, StyleZero/StyleOne/StyleTwo, Quick Reframe, editor/History, Ask AI hook rewrite, strong-hook preservation and explicit change-hook behavior. Eight real PostgreSQL persistence checks passed in a newly created disposable database, which was removed after verification.

The shared source-start guard rejects a short verbless fragment even at source timestamp zero; no earlier context is fabricated. Automatic generation preserves a strong existing hook. Explicit changes exclude the old hook, clear the selected-hook override, and share retained-source grounding across editor, Ask AI and Quick Reframe; generated hook overlays cannot ground themselves. Canonical template geometry, fonts and palettes remain unchanged.

Real Hindi/Hinglish spoken-media certification is **PENDING**, a documented post-release limitation. Both local synthetic language tests are **SYNTHETIC-ASR ACCEPTANCE INCONCLUSIVE**, not real-media certification or a V2 failure. The native transcription routing audit found no obvious forced-language/translation bug; poor synthetic ASR has an inconclusive cause, and confidence-based downstream fail-safe behavior remains unverified. Existing unrelated stale candidate/understanding and worker startup fixtures are documented outside the required 25-script suite. Creative scores remain editorial judgments, with provider latency and run-to-run variation.

Commit/push and production deployment are explicitly authorized following this passing gate. Deployment remains a separate acceptance step requiring backup/restore verification, maintenance, two strict idle checks, local/public health, real-media smoke and cleanup; this local sign-off does not assert a live deployment result.



Implementation and local regressions are complete. Sections 1-17 record the first pass, in which all three authorized real-media hook rewrites ended `NEEDS_REVIEW`. **Section 18 (second pass, 2026-10-09) diagnoses why, fixes the hook pipeline and records the new real-media results**: on the final build all three clips end ACCEPTED in 30/30 hook-rewrite runs and 15/15 full-package runs. **Section 19 (third pass) finishes the creative calibration**: the stale regression expectation noted in 18.9 is corrected without changing application behaviour, all 25 runner scripts pass, the delivery hook is replaced by a stable, constraint-compliant one, and the human review page is ready. These are historical intermediate results. The final release acceptance above supersedes their pending listening status.

## 1. Boundary algorithm changes

The shared service works from original word/segment timestamps, punctuation, pauses and speaker turns. It repairs starts, searches complete endings in stages, checks the delivered range again after editing, and rejects missing timing evidence. ONLINE selects the shortest satisfactory range from at most 24 deterministic timestamp-backed alternatives using the existing understanding route. Failed/unavailable semantic review cannot certify an automatic clip. Explicit topic changes stop extension; unrelated-topic punctuation cannot count as payoff.

Candidate discovery, normal export and edited export share this service. Discovery preserves boundary QA when visual evidence is fused. Candidate evidence stores requested/raw/final ranges, reasons and adjustments. Changed delivered speech regenerates copy against the actual retained transcript.

## 2. Maximum extension policy

Search stages: 0, +5, +10, +20, +25 seconds; exceptional stories/answers may reach +45 seconds with a recorded reason. Source duration and the existing 120-second maximum remain hard limits. The ordinary budget is 25 seconds. ONLINE can consider the exceptional budget while requiring semantic justification. Incomplete ranges outside the budget are rejected or replaced by an independently complete earlier unit.

The authored regression includes a 28-second target repaired to 44 seconds and a question/answer extended by 36.4 seconds. These are timing fixtures, not real-audio acceptance examples.

## 3. Start repair policy

Containing-sentence and dependent/question context can add up to 12 seconds. Tight-gap appositive/continuation fragments allow two bounded hops, at most 24 seconds total. Audio padding is bounded and cannot include the preceding word. Unreachable necessary setup leads to a later independent start or rejection. Manual editor/Quick Reframe ranges receive QA without silently changing user trims.

## 4. Ending QA signals

All fourteen must pass for automatic certification:

`START_COMPLETE`, `END_COMPLETE`, `THOUGHT_COMPLETE`, `QUESTION_RESOLVED`, `PUNCHLINE_INCLUDED`, `CONTEXT_SUFFICIENT`, `CONCLUSION_INCLUDED`, `CLAIM_RESOLVED`, `LIST_COMPLETE`, `STORY_BEAT_COMPLETE`, `NO_DANGLING_CLAUSE`, `NO_DANGLING_PRONOUN`, `NO_UNRESOLVED_SETUP`, `VIEWER_SATISFIED_END`.

Non-applicable checks pass. New regressions cover missing test results, unrelated-topic false payoffs, explanatory conclusions after short responses, unavailable semantic review and QA against actual delivered endpoints.

## 5. Hook generation architecture

The shared understanding → creative generation → ranking → factual/semantic quality gate remains the single active model architecture. As of section 18 it requests a 15-candidate pool in a fixed mechanism mix (3 curiosity gap, 2 contrarian, 2 hidden truth, 2 tension, 2 question, 2 story tease, 1 emotional, 1 bold claim), each with a short `support` line, and one reviewer scores them per hook. It preserves concrete clip concepts and rejects summaries, close transcript copies and unsupported claims. Dominant spoken register is supplied to generation.

Create Clips, packaging, template presets, Quick Reframe, editor Suggested Hooks and Ask AI use these shared rules. Ask AI now supplies retained-source evidence, speaker turns and boundary QA rather than grounding hook rewrites in removed speech. Existing JSON persistence and revision checks remain; no migration is required.

## 6. Clickability and context scoring

Separate `CLICKABILITY_SCORE` and `CONTEXT_SCORE` accompany existing components. Model hook eligibility requires clickability ≥70, context ≥65, specificity ≥45 and novelty ≥60 (unchanged) plus, from section 18, grounding ≥70 and misleading risk ≤30; for model hooks the first five are the reviewer's scores of meaning rather than keyword heuristics. Delivered transcript/OCR/visual facts supply context; source metadata cannot rescue unrelated copy. Ranking also considers curiosity, emotional pull, tension, readability, copying and genericness. Factual checks and the semantic critic remain separate from these scores.

Scores are reviewer-model editorial judgements (keyword heuristics now score only unreviewed local fallback hooks), not measured retention or proof of truth, and they vary run to run (section 18.8). Some component values are binary proxies. A generic fallback can score well for overlap/question wording while failing novelty/diversity. A failed shared package stays `NEEDS_REVIEW`, and packaging/render success cannot raise it to HIGH quality. Ask AI excludes fallback hooks that miss eligibility thresholds.

## 7. Hook length policy

4–26 words, at most 320 characters. Short 4–8, normal 8–14, long 14–22, exceptional up to 26. No headline words are removed to fit. Old package versions remain readable; new packages and understanding are v2.

## 8. Long-hook fitting

Typography adapts inside existing boxes: up to four lines for StyleZero/StyleTwo and three for long StyleOne hooks. StyleOne has a bounded 20-design-unit floor for its shallow three-line header; other generic hooks use 24, and StyleTwo retains its shared vector fitter's 28-design-unit floor. Existing editor hook replacement stores a fitted size, including old projects with large initial fonts. Explicit font commands still take precedence.

Wording, fonts, palettes, media geometry, crop, zoom, speaker switching and caption styling are preserved. Impossible hook overflow rejects export instead of using an ellipsis. Hindi fallback is shaped as whole lines, preserving conjuncts and vowel marks. Latin StyleTwo outlines remain unchanged. Platform fallback font appearance remains a portability limitation.

## 9. Creative escalation

At most one creative repair per request, using the existing configured stronger tier after quality failure. The repair receives, per rejected hook, the verdict codes, scores and reviewer wording plus plain instructions (for example "Previous hook was too generic. Increase specificity and stakes" or "Previous hook was misleading… keep the curiosity but remove the unsupported implication"), and the hooks that did pass (section 18.4). Provider failure alone does not trigger a stronger model. Creative repair does not repeat transcription, vision, boundary work or unchanged understanding. Hook-only rewrites preserve other copy. Routing/model metadata remains internal.

Saved real runs used the configured primary/critic and stronger creative tier. They demonstrate actual bounded escalation and actual semantic rejection; no success is inferred from having used the stronger model.

## 10. Language results

English, Hindi, Hinglish and mixed language authored boundary/scoring fixtures pass. The original ten-case dataset and new fifteen-case dataset pass. A loopback caller test confirms Create Clips and generic editor analysis explicitly request `task: transcribe`, preserving native text rather than using the worker's translation default. Quick Reframe already requests native transcription. Previously stored translated transcripts are reused and are not automatically re-transcribed.

Hindi normal/long template lettering was rendered and visually inspected. Live multilingual source-video/creative acceptance has not been certified.

## 11. Real-video before/after results

> **Superseded by section 18 for creative status.** The creative-package and hook-only tables below are the pre-fix results (every case `NEEDS_REVIEW`); the boundary results in this section are unchanged.

These are the owner's existing authorized QA media plus an authored speech video. The compiled shared modules ran directly; fresh FFmpeg cuts were exported and their **actual exported audio** was transcribed through the existing local worker. Only temporary QA audio storage objects were created, then deleted. Application records and service deployments were not changed.

The latest full creative packages all remain `NEEDS_REVIEW` after one escalation. The “new hook” column therefore records limited fallback copy, **not an accepted improved headline**. Earlier exploratory runs accepted stronger hooks, but this final result does not claim stable real-world creative acceptance.

| Media | Target | Raw range | Proposed repaired range | Final duration | Status |
| --- | ---: | --- | --- | ---: | --- |
| Authored approval/boundaries advice | 19.00 s | 9.00–28.00 | 7.56–31.65 | 24.09 s | Boundary passed; exported; creative needs review |
| Authorized delivery-fraud conversation | 30.75 s | 1.15–31.90 | 0.00–26.62 | 26.62 s | Boundary passed; exported; creative needs review |
| Authorized cultural-fusion conversation | 30.00 s | 0.00–30.00 | 0.00–34.31 | 34.31 s | Boundary passed; exported; creative needs review |
| Authorized truncated bond excerpt | 20.00 s | 0.00–20.00 | 0.00–20.04 diagnostic only | No export | Rejected: incomplete opening/ending |

| Media | Old hook | Latest fallback hook | Category | Clickability / context | Escalations |
| --- | --- | --- | --- | --- | ---: |
| Advice | Whose approval gets to decide your boundaries? | What's behind request and accepting? | Curiosity | 76 / 100 | 1 |
| Delivery | Delivery app fraud explained | doordash and fraud: what actually matters? | Question | 75 / 100 | 1 |
| Cultural fusion | Being Somali-American is like bananas and rice | somali and bananas: what actually matters? | Question | 75 / 100 | 1 |
| Truncated bonds | How bond prices work | Not generated | N/A | N/A | 0 |

Advice starts earlier to restore “You keep saying yes…” and ends after the complete point about accepting disagreement. Fresh audio corrects a saved ASR error (“this agreement”) to “disagreement.” Delivery restores the topic introduction and ends at the resolved identification example; it excludes “just as a test, we ordered lunch that day,” whose result is absent. Cultural fusion extends through “That's what it's like to be Somali and American,” instead of ending on the short “I do” response. The bond excerpt lacks recoverable setup and an ending within the available source, so it is rejected.

The critic rejected broader/inferred claims and copy such as declining requests, interface/account identity, diaspora experience and “on a plate.” Its prompt now explicitly permits faithful paraphrase, supported metaphor and grounded interpretation while rejecting invented factual claims and promises whose explanation is absent. Some criticism remains overly literal; it was not bypassed. Fresh audio ASR also has errors (“Manuel” becomes “a man”), so human listening remains required. Audio transcription/inspection is not represented as manual auditory review.

The owner explicitly authorized sending the same three saved clips' retained transcript text and understanding to the configured OpenAI service for the additional hook-only acceptance. The run preserved saved post copy and did not repeat transcription, vision or boundary analysis. Final results (2026-10-09 02:47 local):

| Media | Final hook-only verdict | Selected fallback | Category | Clickability / context | Quality score | Escalations |
| --- | --- | --- | --- | --- | ---: | ---: |
| Advice | NEEDS_REVIEW | What's behind request and accepting? | Curiosity | 76 / 100 | 50 | 1 |
| Delivery | NEEDS_REVIEW | doordash and fraud: what actually matters? | Question | 75 / 100 | 50 | 1 |
| Cultural fusion | NEEDS_REVIEW | somali and bananas: what actually matters? | Question | 75 / 100 | 50 | 1 |

Advice failed on “avoiding” a particular person's disagreement and an “uncomfortable reaction”; delivery failed on attributing the Lisa example directly to DoorDash; cultural fusion failed on “a familiar feeling.” An earlier approved cultural-fusion rewrite passed with score 91 (“Can bananas and rice explain cultural fusion without defining the whole person?”), but the final rerun did not pass. This demonstrates model variability and conservative batch rejection, not stable creative acceptance. The critic evaluates all eligible suggestions, so a rejected alternate can reject the package even when another headline is reasonable. Each request respected its single escalation limit; no rejected model claims were promoted.

Artifacts: [machine report](../.real-qa-preview/content-intelligence-v2/media/report.json), [advice audio](../.real-qa-preview/content-intelligence-v2/media/advice.wav), [delivery audio](../.real-qa-preview/content-intelligence-v2/media/delivery.wav), [cultural-fusion audio](../.real-qa-preview/content-intelligence-v2/media/cultural-fusion.wav). The directory is intentionally ignored by Git.

## 12–14. StyleZero, StyleOne and StyleTwo regressions

All three pass normal, full 26-word and Hindi cases: nine actual React preview/ASS export frame pairs. Tests assert unchanged canonical video segments, frame segments, zoom events, grading, captions, box positions, fonts and palette properties; zero hook overflow; retained wording; and native SVG glyph bounds inside the box. Frames were inspected, including all three long hooks and the corrected Hindi preview/export.

These are canonical text/layout regressions on fixed gray media windows, not newly deployed end-to-end template exports. Existing camera/crop/zoom and generated-project reconstruction tests pass separately. StyleOne generic browser/ASS leading remains approximate; StyleTwo Latin uses shared outlines. [Frame report](../.real-qa-preview/content-intelligence-v2/visuals/report.json).

## 15. Quick Reframe, editor and History regression

All 24 local regression scripts pass with no skips. Coverage includes Quick Reframe manual/StyleOne/StyleTwo/post copy, Ask AI, presets, generated clip editor/reconstruction, style readiness, selection flow, shared packaging, undo/redo/revision persistence, actual FFmpeg clip export and native transcription callers. Existing History/selection contracts consume persisted final copy; no schema changed.

Shared/backend builds and frontend type checks pass. The local static frontend build passes with its required HTTPS public API origin. `git diff --check` passes. No new authenticated deployed UI/History end-to-end run is claimed for v2. [Regression report](../.real-qa-preview/content-intelligence-v2/regressions.json).

## 16. Commit and deployment status

Uncommitted working-tree changes on `main`, based on `ed1f1ae` (“Record passing StyleTwo crop parity production acceptance”). No commit, push, deployment, migration or service restart. Existing running services remain unchanged. No destructive Git command was used.

## 17. Remaining limitations and required actions

- Creative acceptance for the three authorized clips now passes the automated criteria on the final build (section 18) but is **not human-reviewed**. The pre-fix limitation (one alternate rejecting a whole batch) is removed; reviewer judgments remain variable run to run. Limited local fallback is transparent and can remain generic.
- Manual listening of the saved exported audio is pending. Actual worker transcription alone does not satisfy that requirement.
- The initial automatic approval block for the external hook-only command was resolved by explicit user permission for that payload and destination. The authorized test completed; no approval remains pending for this test.
- Live Hindi/Hinglish media and deployed editor/History end-to-end acceptance remain uncertified. Windows Hindi font compensation should be verified on the deployment platform before release.
- ASR timing/punctuation, indirect topic changes, very long answers, cultural context and model judgment can still produce rejection or require review. Scores need empirical calibration. Existing translated transcript caches need deliberate re-analysis to recover native language.

The implementation is reviewable locally. Production rollout should remain on hold while these acceptance items are unresolved.

## 18. Creative acceptance: diagnosis, fix and real-media results (second pass, 2026-10-09)

Scope: why the three authorized real-media hook rewrites (advice, delivery-fraud conversation, cultural-fusion conversation) all ended `NEEDS_REVIEW`, and the fix. The owner's earlier authorization for sending each clip's retained transcript and saved understanding to the configured OpenAI service for these three hook rewrites was relied on; no other media, audio or video left the machine, and no application record, deployment or commit was made. Evidence is under `.real-qa-preview/creative-acceptance/` (git-ignored): `failure-analysis.md`, `review-package/`, `baseline-x5/`, `replay/`, `calibration/`, `final2-hooks/`, `final2-full/`, `forced-escalation/`, `pairwise-*.json`, `final-hook-frames/` and the tools that produced them.

### 18.1 Why every case failed (measured, not guessed)

The pre-fix pipeline was frozen as a loadable build and run 5 times per clip against the real model (15 runs, 308 real hooks). Result: 7/15 ACCEPTED (advice 4/5, delivery 0/5, cultural-fusion 3/5) with 13 escalations. A single earlier run of the same code had ended all three `NEEDS_REVIEW`, so the model is not deterministic and single samples mislead. The same 308 hooks were then re-judged by the fixed objective screen and per-hook reviewer (`replay/`).

| Finding | Evidence |
| --- | --- |
| The deterministic gates discarded good copy on **word overlap alone** | All 117 pre-scoring discards were lexical (72 "<20% shared concepts", 45 "lexical context <65"); none were for copying, invented facts or summary wording. 63 of the 117 (54%) are approved on meaning. |
| Clickability was a **keyword proxy** | 101 of the 191 survivors failed only `clickability <70`. The score rewarded "?" and about 25 English cue words, plus an "emotional" regex containing this advice clip's own vocabulary (*boundaries*, *approval*). No survivor ever failed context, specificity or novelty. |
| The gates also **admitted** unsupported claims | 35 of the 90 hooks that passed the old gates are rejected by the fixed reviewer, for example "The mistake isn't having priorities. It's expecting everyone to agree." and "Why does Johnny Boy's DoorDash order become a guessing game about Gregory?". `factualGrounding` and `misleadingRisk` were hard-coded constants (1 and 0): grounding was never measured. |
| **One alternate sank the package** | The critic received the whole kept pool and returned one holistic `supported: false`; in every failing run its complaints were about non-selected alternates. |
| **Escalation was mostly triggered by the deterministic gates** | 11 of 13 escalations. A pool-size rule (`INSUFFICIENT_DISTINCT_HOOKS`, fewer than 3 survivors) fired because the lexical gate had already removed most hooks. |
| **Format/schema fault** | The critic call was capped at 500 output tokens. The provider's reasoning consumed them, the reply had no output text, and the package ended `GROUNDING_REVIEW_UNAVAILABLE` -> `NEEDS_REVIEW` with no creative verdict (observed on delivery in 2 of 18 baseline runs, 15 of which reached a critic call). |
| The delivery clip is genuinely hard | Garbled speech recognition ("a recall yesterday", "Johnny Boy", "Manuel") and one name-check example as the only evidence. 51 of its 108 hooks over-reached (a mechanism, an unanswered why-question, an attribution to DoorDash). The fixed reviewer rejects that run's own top hook as well as the escalated one. Every first pass still contained approvable hooks (5/5). |

Classification (full table and per-run detail in `failure-analysis.md`): **B** (good copy rejected) and **D** (generator/critic expectation mismatch) dominate. **A** (genuinely weak or over-reaching copy) is real, mainly on delivery, and the old gates were blind to it. **C** is small. **E** applies to delivery. **F** (long hook / template fit) did not occur: every hook was at most 15 words.

**Generator or critic?** Both, in different ways. The generator over-reached on 115 of 308 hooks. The old deterministic gates discarded 63 good hooks and admitted 35 bad ones. The critic was right to reject over-reaching copy but wrong to let one alternate decide the package, and it had no way to say which hook was fine.

### 18.2 Generator/critic alignment and the grounding rule

One definition of a strong hook (`HOOK_RUBRIC` in `creative-quality.service.ts`) is embedded verbatim in both the writer's and the reviewer's prompts (asserted by a test): clickability, curiosity gap, specificity, contextual relevance, truthful framing, natural/stand-alone language, audience appeal. **Grounding is defined as "the implied claim, tension or question is supported by the clip", not "the hook reuses transcript words"**, and the rubric carries the "always being the nice one" example. Inference ("the real reason…", "what nobody tells you…") is allowed only where the clip supports it. Invention is not: a hook may claim only as much as the moment it rests on shows (an example is not a general mechanism, a mismatch is not an explanation, a why/how question needs the clip's own answer, no attribution the clip does not make). Word overlap is no longer a pass/fail test for a reviewed hook. It still gates unreviewed local fallback hooks and the case where review is disabled.

### 18.3 New pipeline

1. **Pool**: 15 candidates in a fixed mix (3 curiosity gap, 2 contrarian, 2 hidden truth, 2 tension, 2 question, 2 story tease, 1 emotional, 1 bold), each with a short `support` naming the clip moment it rests on.
2. **Objective screen** with a recorded reason per hook: schema, duplicates, 4-26 words/320 characters, unsupported numbers/quotes/names and filler clickbait, invented names (CamelCase brands, acronyms and mid-sentence proper nouns the clip never mentions; tolerant of "Uber Eats"/"UberEats", "America"/"American" and Title Case headlines), topic-description wording, transcript copying, unsupported humor.
3. **Shortlist** of up to 8 (one per mechanism, never ordered by keyword scores). This deliberately replaces "shortlist the top 3": a keyword score cannot pick the best three, and picking them that way was the failure.
4. **One reviewer call** scores each shortlisted hook independently (clickability, context, grounding, misleading risk, specificity, naturalness, summary-like, approved, short issue/why). Full packages add the copy to the same call. A truncated or malformed reply is retried once on double the budget. A reviewer outage is not a creative verdict: it never escalates and ends `NEEDS_REVIEW` (`GROUNDING_REVIEW_UNAVAILABLE`).
5. **Choice**: approved hooks are ordered by appeal with safety weighed as heavily (clickability .35, grounding .20, context .15, specificity .15, novelty .05, readability .05, minus misleading risk x .30), with a bounded preference (10 points) for a hook that fits every template unshortened.
6. **Result**: one approved hook that clears the composite bar (75) is a complete `ACCEPTED` result.
7. **Full packages**: the synopsis check is split into a hard part (filler, invented facts) and a reviewable part (`SYNOPSIS_LOW_OVERLAP`, a faithful paraphrase that shares few words with a noisy transcript). Before the split, two of nine delivery full packages ended `NEEDS_REVIEW` because the lexical synopsis rule skipped the reviewer entirely.

### 18.4 Failure-reason-driven escalation

The single repair (stronger model) receives, per rejected hook, its verdict codes, scores and the reviewer's own words, plus plain instructions. Real example from an organic escalation (delivery, run 3): "Previous hook was not supported by the clip (grounding 62<70 - "Fails instantly" exaggerates the demonstrated mismatch). Keep the curiosity but remove the unsupported implication.", "Previous hook was flat. Sharpen the curiosity gap…", "The best approved hook scored 74, below the 75 bar: make the strongest hook sharper…". It recovered with 7 approved hooks (best clickability 88).

A forced escalation with a deliberately weak first pool (flat summaries, invented claims, clickbait) on all three clips: first pool 0 approved, one escalation to `gpt-6.1-sol` (8.6-10.7 s), 5/3/8 approved, all three ACCEPTED. The repair pool is 10 hooks for a hook rewrite and 6 for a full package: the stronger model writes about 45 tokens/s against a 20 s per-call ceiling, and an 890-token full-package repair had already taken 18-19 s.

### 18.5 Thresholds

No existing threshold was lowered: clickability 70, context 65, specificity 45, novelty 60 and the composite 75 are unchanged. Two bars were **added** (grounding >=70, misleading risk <=30). One rule was **removed**: the three-surviving-hooks requirement, which measured pool size after word-overlap filtering rather than quality; one approved hook is now a complete result. The evidence that the bars still separate good from bad is in 18.8.

### 18.6 Template fit (StyleZero, StyleOne, StyleTwo)

Wrapping, bounded font floors and extra lines already exist in all three. A words x word-length sweep through the real render plan and ASS export found StyleTwo the tightest: no headline failed StyleOne without also failing StyleTwo, and StyleZero fit everything. 26-word hooks of ordinary English (average 5 letters), 26-word Hindi/Hinglish and 14-word hooks of 8-letter words fit everywhere. Overflow starts around 26 words of 6-letter words (180 characters) in StyleTwo and 232 characters in StyleOne, well below the 320-character policy cap.

A tighter-line-height rung was prototyped for StyleTwo and **removed**: it rescued no case, because the binding constraint is the four-line cap at the font floor, not leading. Instead, selection is fit-aware (18.3 item 5), so an unfittable hook is chosen only when it is clearly stronger, and export still rejects true overflow instead of truncating. The nine existing template cases pass again, and the six actual final hooks (official and recommended) pass in all three templates, preview and export, with the wording preserved.

### 18.7 Real-media results on the final build

| | Baseline (pre-fix) | Final build |
| --- | --- | --- |
| Hook rewrites, ACCEPTED | 7/15 (advice 4/5, delivery 0/5, cultural 3/5) | **30/30** (10/10 per clip) |
| Escalations | 13 (11 caused by deterministic gates) | 1 (organic, delivery) |
| Full creative packages | all NEEDS_REVIEW in the first pass | **15/15** ACCEPTED (3 escalations); a build before the synopsis split had 7/9 |
| Typical time | about 8-10 s | 14.4 s hooks, 20.0 s full (an escalated run is 29-40 s) |

Official run (run 1 of the 10-run batch per clip, declared before the batch ran):

| Clip | Final hook (pipeline) | Category | Clickability | Context | Grounding | Misleading risk | Specificity | Original hook |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| advice | What does saying yes to everyone actually cost? | Question | 85 | 95 | 96 | 4 | 91 | Whose approval gets to decide your boundaries? |
| delivery | They turned suspicious delivery names into a game | Story | 73 | 88 | 91 | 9 | 87 | Delivery app fraud explained |
| cultural-fusion | What do bananas and rice reveal about Somali-American identity? | Curiosity | 82 | 94 | 92 | 8 | 90 | Being Somali-American is like bananas and rice |

Across the batch, selected hooks averaged clickability 83/81/80, context 93/94/90 and grounding 94/93/90 (advice/cultural/delivery), with minimum clickability 78/74/73 and maximum misleading risk 8/9/14. Different hooks are chosen run to run (9, 8 and 9 distinct hooks in 10 runs for advice, cultural-fusion and delivery), as expected from a creative model.

### 18.8 How much to trust the scores

- **Calibration** (41 hand-written hooks, 3 runs each = 123 judgments, final build): flat summaries 0/27 approved, clickbait 0/12, invented or over-reaching claims 1/30 (the attribution case "DoorDash says Lisa, but the speakers see Manuel" flipped once), strong grounded hooks 34/45 approved. The strong hooks that were rejected were overclaims such as "more than any definition of identity", not lack of appeal. The old deterministic gates accepted 6/15 strong hooks and 4/23 bad ones.
- **Reviewer variance is real.** The same hook's clickability moved by up to about 11 points between scoring runs (the independent model scored one delivery hook 79 then 68), and borderline overclaims can flip. Single scores should not be read as measurements; pass/fail rests on repeated runs and pairwise tests.
- **"More clickable than the original"** was tested pairwise (original vs new, both orders, three viewer framings, two models, 6 trials each). Advice and delivery: the new hooks win 6/6 with "clear" margins from both models. Cultural-fusion: the original is a strong, punchy hook. The pipeline's official hook wins 6/6 under the production reviewer (3 clear) but only 3/6 under the independent model, and my own first recommendation lost to the original 1/6 ("turns it into advice"), so I replaced it. The replacement wins 6/6 with slight margins, but because I iterated against the evaluator that result is optimistic. So the criterion "at least 2/3 clearly more clickable" holds for advice and delivery, not cultural-fusion. Advice's win partly reflects that its original asks about "approval", which the retained clip never mentions.
- **Manual review set** (original / best first-pass / best escalated / my recommended, scored by the production reviewer and by an independent stronger model with the identical rubric) is in each clip's `review.md`. My recommended hooks: advice "What does saying yes to everyone cost your focused work?", delivery "Is that really Gregory? The check says no.", cultural-fusion "What do bananas and rice have to do with being Somali and American?". My transcript audit found the delivery pipeline hook the weakest ("They" has no on-screen antecedent; "suspicious delivery names" is an interpretation) and noted that the delivery transcript does not say whose name Gregory is.

### 18.9 Regressions and one pre-existing failure

Type checks pass in shared, backend and frontend, and `git diff --check` passes. The regression runner now has 25 scripts (the original 24 plus the new offline `test-creative-hook-pipeline.cjs`, 11 checks): **24 pass, 1 fails**. The nine existing template visual cases and the 18 final-hook renders pass. The boundary scripts pass and no boundary logic was changed. The existing live escalation verifier passes with the new protocol (3 cloud calls, `gpt-6.1-sol`, ACCEPTED).

The failure is `test-generated-clip-edit-project` ("existing deterministic AI should understand: change the on screen hook"). It **already failed on the build present at the start of this work** (verified on a frozen copy), and the test file is unchanged from HEAD. Cause: the previous pass added `.filter(hookMeetsThreshold)` to the offline Ask AI hook path ("Ask AI excludes fallback hooks that miss eligibility thresholds"). For that test's six-word transcript every local candidate is a reusable frame such as "What's behind clear and idea?", so the assistant now asks for exact wording instead of proposing one. This is a product decision (keep excluding weak offline hooks and update the test, or allow a clearly labelled limited fallback) and it was not changed here. `test-clip-candidates` and `test-video-understanding` (not among the 24) also fail identically on the start-of-work build.

### 18.10 Human review package and remaining limitations

`.real-qa-preview/creative-acceptance/review-package/index.md`, with `advice/`, `delivery/` and `cultural-fusion/` each holding `review.md` and `review.json`: video and audio paths, transcript, final hook and category, why it is grounded and clickable, scores, the reviewer's explanation, approved and rejected alternates, the original hook, pairwise results, the A/B/C/D table and a human checklist. **It is evidence for a human listener, not a human review. Creative acceptance is not signed off until a person has listened to the clips.**

- Reviewer judgments are model judgments with run-to-run variance; no human panel was used.
- Delivery is the weakest clip (garbled transcript, thin evidence). Its pipeline hook is serviceable rather than strong, and attribution-type overclaims remain the reviewer's least stable area.
- A first-pass hook rewrite now takes about 14 s (two calls) rather than about 9 s, and an escalated one 29-40 s. Each call stays inside its own ceiling, but the stronger-model writer is close to its 20 s ceiling for full packages.
- Only three English-language clips were exercised live; Hindi/Hinglish creative quality is not newly certified.
- The invented-name screen is heuristic (it does not check Title Case headlines for ordinary capitalized words), so the reviewer is the second line of defence for invented identities.
- Not run: authenticated deployed UI/History end-to-end, any deployment, migration, commit or push.

## 19. Final creative calibration (third pass, 2026-10-09)

Scope: final creative calibration only. No boundary, crop, zoom, speaker-switching or template geometry code was touched: the compiled backend differs from the frozen pre-work build in exactly three files (`creative-package.service.js`, `creative-quality.service.js` and the new `hook-fit.js`). Nothing was committed, pushed or deployed. The owner's earlier authorization covered the same three clips' retained transcripts and short hook strings; nothing else was sent to the model provider.

### 19.1 The stale regression test (strong-hook policy kept)

`test-generated-clip-edit-project` was the one failing script of the 25. **Old assertion:** with no model available, `sayAndApply('change the on screen hook')` must be understood (`needsClarification === false`) and the hook text must *change* from "A clearer opening". **Why it is obsolete:** that fixture's transcript is six words ("One clear idea survives this edit"); the only offline candidates are reusable templates built from its most frequent words ("What's behind clear and idea?", "clear and idea: what actually matters?", "clear and idea through the lens of survives and edit"), ungrammatical filler with novelty 37-38 (bar 60). The offline path keeps only hooks that meet every eligibility threshold, so it correctly offers nothing. **Production behaviour was verified, not assumed:** the same offline path does return a good grounded hook when one exists ("Where approval ends, boundaries begin", clickability 99, for a rich advice transcript), and refuses for the delivery transcript, which yields only templates. **Change:** only the expectation was replaced. The test now pins that the refusal is explicit, proposes no change and leaves the hook alone; that the weak candidates miss on novelty; that a good offline hook is still returned when it exists; and that the route the refusal offers (the user's own exact wording) still applies. No application code changed and no threshold was weakened.

### 19.2 Delivery clip wording

The pipeline's previous delivery pick ("They turned suspicious delivery names into a game") has no antecedent for "They", and the other hooks leaned on the name "Gregory" or on details the clip never states ("exposes unreliable account information", "fails instantly", "the displayed name", "the order looks normal until…"). Changes and evidence:

- Objective screen: model hooks that open with a pronoun are refused; speed or intensity claims the clip never makes are refused; the reviewer additionally judges unresolved references and a naturalness bar (70). The previous pick is now refused 8/8.
- Targeted generation (framing: identity mismatch, the name-check moment, no pronoun opening, no personal names, no ownership, no fraud conclusion): 18 pipeline runs produced 89 distinct approved hooks, 61 of which satisfy those constraints mechanically.
- Candidates were scored in random batch contexts (8-20 trials each). My first editorial favourite, "Two names, two checks—and neither matches the person.", **oscillated** (approved 6/8, grounding 52-91). "Not Gregory, not Lisa. So who is it?" was unstable (4/8, grounding 48-86), which confirms keeping names out. The pipeline's own "Two name checks. Two mismatches in this delivery fraud discussion." was stable except one context where the reviewer doubted "two mismatches" (grounding 45).
- **Final delivery hook: "Two name checks in a delivery fraud talk, and neither one matches"** (an editorial rewording of that hook family, replacing the em dash by a comma). Pooled over 20 trials: approved 19/20, clickability 72/82/88, context 83/90/94, grounding 76/88/93, misleading risk 6/13/30, specificity 83/88/94, naturalness 75/84/91, composite 70/79/84 (min/median/max); novelty 93, transcript similarity 0.17, 12 words, fits every template. Two of 20 trials dipped under the 75 composite bar (70 and 74), none was clearly bad.
- Unclear attribution and pronoun issue: **gone** from the final hook (no pronoun, no person's name, no claim about whose name it is, what was displayed, how fast anything happened, or that fraud occurred). The pipeline's own delivery picks are still the weakest of the three clips (6 of 10 final6 runs needed the stronger-model repair; one ended `NEEDS_REVIEW`), and some still carry mild unsupported implications that the reviewer approves.

### 19.3 Other calibration changes found along the way

| Finding (measured) | Change |
| --- | --- |
| The reviewer judged the same hook differently by position: approved 4/6 first, 4/6 middle, **1/6 last**; the existing hook was always appended last, so the cultural-fusion original was kept in 1 of 10 runs. | The reviewer's list is shown in a seeded, content-derived order (deterministic per pool). The original is now kept in 5-6 of 10 runs. |
| A safety-heavy blend kept choosing slogan-like hooks for advice ("Sustainable boundaries require accepting disagreement" in 5 of 10 runs); a clickability-first blend raised risk on delivery (risk 20-25). | Two-tier choice: comfortably grounded (grounding ≥85, risk ≤15) outranks marginal; within a tier the more clickable and specific hook wins. Simulated on recorded runs first: advice and cultural picks became real hooks, delivery risk stayed at max 18. Bars and composite unchanged. |
| A package that missed only the composite bar discarded 8 approved hooks and surfaced the template "doordash and fraud: what actually matters?". | Reviewer-approved hooks are kept (still `NEEDS_REVIEW`); templates only when nothing was approved. |
| "Fails instantly" style claims were repeatedly selected. | Objective screen for speed/intensity words the clip never says. |
| Em dashes export as hyphen-length marks in StyleZero/StyleOne on this machine (preview draws them correctly). | Writer instruction: plain punctuation. 0 of 30 selected hooks in the last batch contain a dash. |

### 19.4 Keeping a strong original

Principle (implemented in the shared service as `existingHook`): a generated rewrite must beat the existing hook by at least 8 composite points or solve a known problem (fails the screen or a bar, composite below 75, does not fit the templates while the rewrite does); otherwise the existing hook stays. It is judged by the same screen and the same single reviewer call, so it costs no extra model call, and an acceptable existing hook also avoids the stronger-model repair when every generated hook is rejected.

Observed over the last batches (30 runs each, original supplied as the existing hook):

| Clip | Original kept | Why replaced when replaced |
| --- | --- | --- |
| advice | 1 of 10 in the last batch (0 of 30 in the three before) | The retained clip never mentions approval, so the reviewer rates the claim's grounding 35-58 in almost every batch (one batch rated it 84: the same hook swings). A real problem, not noise. |
| delivery | 0 | Flat topic label ("Delivery app fraud explained"). |
| cultural-fusion | 5 of 10 (6 of 10 before the last prompt change; 1 of 10 before the position fix) | The reviewer sometimes calls it summary-like or scores clickability 65-68. |

The cultural original is strong but objectively borderline against the bars: novelty 61 (bar 60) and transcript similarity 0.88 (copy line 0.90). It is a close restatement of the speaker's own words, which is why the reviewer sometimes calls it summary-like. Over 20 reviewer trials it was approved 18/20, composite 76/82/84, never clearly bad, and the best generated alternative ("What do bananas and rice have to do with being Somali and American?", 10/10 approved, composite 82/84/86) beats it by about 2 points, below the 8-point margin, so **the original is the final cultural hook**.

### 19.5 Final hooks and repeatability

Each final hook was scored by the production reviewer 20 times (two independent samples of 10), each time inside a different random batch of sibling hooks at a random position. Median (min-max):

| Clip | Final selected hook | Approved | Clickability | Context | Grounding | Misleading risk | Specificity | Composite |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| advice | What does saying yes to everyone quietly cost you? | 20/20 | 84 (81-88) | 94 (89-96) | 94 (89-96) | 8 (4-13) | 86 (82-89) | 82 (78-85) |
| delivery | Two name checks in a delivery fraud talk, and neither one matches | 19/20 | 82 (72-88) | 90 (83-94) | 88 (76-93) | 13 (6-30) | 88 (83-94) | 79 (70-84) |
| cultural-fusion | Being Somali-American is like bananas and rice (original kept) | 18/20 | 78 (67-86) | 95 (88-96) | 96 (92-98) | 5 (3-8) | 94 (90-100) | 82 (76-84) |

Objective bars: novelty 80/93/61 (bar 60), transcript similarity 0.44/0.17/0.88, all pass the strict screen. No trial of any final hook was clearly bad (clickability under 60, grounding under 60, risk over 45 or composite under 65), so none oscillates between clearly good and clearly bad. Per-trial numeric bars plus composite: advice 20/20, cultural-fusion 19/20, delivery 18/20.

The pipeline's own single-run picks (final6, run 1) are listed beside them in the review page: advice "The hidden cost of constant agreement", delivery "A delivery order can carry the wrong identity" (weaker; hence the editorial final), cultural-fusion the original, preserved.

Pipeline batches on the current build (original supplied as existing hook, delivery under the targeted framing): final6 29/30 ACCEPTED, 6 escalations (all delivery), 0 selected hooks with a dash, 0 opening with a pronoun. Earlier batches in the same series: 29/30, 30/30 and 30/30.

### 19.6 Latency by stage

From 90 normal requests and 16 escalated attempts (three clips running concurrently, so slightly pessimistic; understanding costs 0 here because analysis is supplied):

| Stage | Normal request | Escalation attempt |
| --- | --- | --- |
| Writer (generation) | 6.7 s median (5.7-11.9) | 12.5 s (9.5-16.1) on the stronger model |
| Objective screen | under 1 ms | under 1 ms |
| Reviewer | 8.5 s (6.6-20.3, the maximum includes one bounded retry) | 8.1 s (7.1-9.3) |
| Whole attempt | 15.4 s (12.7-28.2) | 20.7 s (17.4-24.2) |
| Whole request | 15.4 s | 36.0 s (32.5-40.3), i.e. first attempt plus escalation |

Avoidable duplicate calls: none inside `create()` (the existing hook rides in the single reviewer call, understanding is skipped when analysis is supplied, the reviewer retries only after a fault). Outside it: (1) changing only the template/style with identical speech costs a full writer and reviewer pair (about 15 s) because `template` is part of the request key and the prompt evidence; verified with a fake router: identical request 0 calls, same speech with a new template 2 calls; (2) `judgeCandidates` builds candidate packages one after another; (3) Quick Reframe's post copy and hook suggestions are separate generations for one clip. No redesign was done in this pass.

### 19.7 Regressions and what is still open

All 25 runner scripts pass (including the updated `test-generated-clip-edit-project` and the 17-check `test-creative-hook-pipeline`), as do the backend, shared and frontend type checks, `git diff --check`, the nine template cases and the 18 final-hook renders (the three finals and the three originals in StyleZero, StyleOne and StyleTwo). The boundary checks (`test-clip-boundary-optimizer`, `test-clip-boundary-continuation` and the boundary datasets in `test-content-intelligence` and `test-content-intelligence-v2`) pass unchanged.

Two scripts outside the 25 fail identically on the frozen pre-work build and on the current one, and were left untouched: `test-video-understanding` (looks for the schema name `shared_creative_package_v1`, renamed to `_v2` earlier) and `test-clip-candidates` (its fake model returns the local template hooks, none of which meet the bars, then asserts at least three hooks). Both are stale fixtures of the same kind as 19.1.

The human review page is `.real-qa-preview/creative-acceptance/human-review/index.html` (and `index.md`): playable video and audio, transcript, original and final hook, category, scores with ranges, reviewer explanation, why grounded and clickable, concerns to check by ear, template frames and the A-I checklist. Every box and the sign-off table are blank on purpose. **Creative acceptance is not complete until a person has listened to the three clips and signed off.** Still open: that human review; the delivery transcript is garbled and "name checks" and "two" must be confirmed by ear; the delivery pipeline output is the weakest and expensive (6 of 10 runs escalate under the targeted framing); the cultural original sits close to the novelty and copy lines; reviewer scores vary run to run; `existingHook` is not wired into any product flow yet; a deployed-platform check of dash and font rendering is still needed.
