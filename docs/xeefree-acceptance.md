# XeeFree acceptance — 2026-10-13

The existing XeeFree upgrade is complete as a local feature, with the limits below. English functional acceptance is evaluated; this is not production certification or a claim of parity with XeePro. Production deployment is excluded from this task. Architecture: [xeefree-pipeline.md](xeefree-pipeline.md).

## Final 28-point report

1. **Old architecture.** FALLBACK_ONLY shared Whisper/chunk heuristics and deterministic creative templates. Frequent-word templates produced headlines such as “What's behind tell and reason?” and “money and black through the lens of stolen and slavery.” They lacked sentence structure and meaningful relationships.

2. **Weaknesses found.** Low-confidence stage services still attempted provider calls; chunk-based windows combined topics; padded endings could drift into the next sentence; disputed claims could become presupposing headlines. Rambling speech yielded no usable cultural hook, ASR hyphen fragments became “start -ups,” generated editor provenance could be replaced, and History could label an old clip with a newer job's tier. Concurrent editor saves could also return HTTP 500 on Prisma P2034.

3. **New architecture.** Eleven local modules reconstruct sentences, extract typed semantic frames, score moments on fifteen dimensions, diversify candidates, validate boundaries, generate grounded hooks/copy, clean captions, stabilize speakers and choose sentence-aware emphasis. Local ASR/vision and the existing renderer/editor remain shared. No new cloud dependency or database migration.

4. **Hard Free-only policy.** ONLINE is Pro; FALLBACK_ONLY and legacy OFFLINE are Free. Missing execution scope fails closed as Free. Router and structured-provider entry points enforce XEEFREE_PROVIDER_VIOLATION before building a request. Normal Free paths bypass providers rather than relying on guard failures. Project-owned origin/telemetry controls editor policy; unknown generated provenance is Free. Standalone and Pro editor consent rules remain. Explicit admin connectivity tests get ONLINE only when no job scope exists; an inherited Free scope is never upgraded.

5. **OpenAI proof.** Independent live audits report openAiCalls=0 for every audited Free job. The real configured keys were present, provider hosts blackholed, and six router/provider/transport entry points replaced by fail-fast traps. Offline policy checks also kill transport/network access. See the proof table below.

6. **Cloud LLM proof.** cloudLlmCalls=0 in every audited Free analysis, no llm_request/llm_route or trap-entry events in combined stdout/stderr. This covers local ASR with actual processing, rendering, History, editor and Quick Reframe requests, not metadata alone.

7. **Pro escalation proof.** proEscalations=0 and providerEntryAttempts=0 throughout the audited Free runs. Separate ONLINE uploads reached configured models and recorded calls/escalation, establishing a positive control. A Free job was never converted to ONLINE for comparison.

8. **Blocked-attempt proof.** blockedProviderAttempts=0 in accepted audits. Earlier nonzero stage attempts were diagnostic failures and triggered the deterministic early-return fix; they are excluded from successful proof. The independent trap throws on an attempted call even if application counters fail to record it.

9. **Content understanding.** Sentence/typed-frame analysis identifies questions, answers, claims, reasons, contrasts, lists, story outcomes and supported entities/numbers. Advice, story, list, monologue and debate fixtures complete locally. This is rule-based understanding; inferred intent, ambiguous attribution and weak ASR remain less capable than a model reviewer.

10. **Boundaries.** Free repair keeps an already-complete final word when it only has post-word padding. Word-cut and unfinished-thought gates remain. Explicit immediately following disagreement requires its first substantive completed response within the existing extension budget; otherwise the candidate is held. The episode's disputed segment changed from 62.70–95.23 s to 62.70–103.22 s, retaining the reply. Pro boundary defaults are unchanged. Local base tail-ASR ran live; the optional stronger Whisper/consensus branch is tested, not certified on a real ambiguous-media acceptance set.

11. **Moment selection.** Sentence windows use fifteen normalized signals and deterministic maximal-marginal-relevance diversity. Long I/Z requested three and delivered three per style. Short B/D/G/H each have one usable distinct moment and return an explicit count shortfall when two are requested. C/E yield zero under the unchanged shared minimum; no fabricated or duplicate clips pad the count.

12. **Hook engine.** Typed spans support question, story, contrast, warning, advice and other supported families. A simpler literal clause/pull quote is permitted when a stronger hook fails. Fallbacks still pass the same gates. The engine rejects unsupported facts, names, numbers and misleading premise uplift; it does not construct headlines from unrelated frequent tokens.

13. **Grammar/clarity gates.** Twelve deterministic gates cover grammar, meaning, context, grounding, word salad, dangling pronouns, transcript stuffing, unsupported names/numbers, misleading claims, natural wording and clickability. Gerund subjects and idiomatic “It's not X, it's Y” survive generation and reopen. A disputed reason becomes “Does remote work kill creativity?” rather than “Why does remote work kill creativity?” Gates are heuristics, not an independent human language verdict.

14. **Weak-hook cases.** Cultural-fusion now has a grounded usable fallback: “To me being Somali isn't just eating bananas with rice.” Offline clause calibration also accepts “Being Somali isn't just eating bananas with rice.” This fixes the prior no-hook report. Rambling speech can yield a clean literal clause when present; bare stitched clauses remain rejected. Funny pronoun-led or incomplete clips without sufficient standalone context still return NEEDS_REVIEW/no hook. No context is invented to force a result.

15. **Captions/copy.** Free caption cleanup repairs repeated fragments, punctuation, casing and split hyphen tokens while retaining timings and source wording. Generated EditMode captions avoid weak-end splits; manual captions are preserved. Synopsis, caption options and hashtags use supported evidence. Options can be fewer than five when evidence is short. Some tutorial wording, topic prefixes and tags such as #Bug remain clumsy. The frozen renderer and manual “Generate captions” command are not universally recleaned by this pass.

16. **Speaker switching.** A→B→A diarization blips are stabilized before the shared camera planner. Logic and shared camera regressions pass. Accepted live exports recorded no useful speaker switch; E produced no clip. Real multi-speaker/face-switch accuracy remains uncertified, and no face identity is inferred.

17. **Zoom.** Important sentence beats are spaced and bounded; shared face safety and manual zoom precedence remain. Deterministic zoom and editor tests pass. Accepted live evidence recorded no actual useful automatic zoom, so it does not certify visual effectiveness on real speakers.

18. **StyleZero.** A/B/D/G/H and three I/Z clips export; real advice exports and cultural-fusion base export are usable. Actual styled MP4s are retained. Earlier scarcity/validation failures are preserved in artifacts rather than counted as successful exports.

19. **StyleOne.** Same eligible fixture matrix and I/Z counts pass. Real advice exports pass. Cultural-fusion fails subject-framing validation (about half the samples), even after repair; it is not certified. A base clip downloaded by an earlier harness is not accepted as a StyleOne export.

20. **StyleTwo.** Same eligible fixture matrix and I/Z counts pass. Real advice exports pass; cultural-fusion has the same framing limitation as StyleOne. Typography/geometry and recent crop/preview/export parity code are preserved.

21. **Quick Reframe.** Manual upload/analysis, grounded local hooks/post copy and export pass on the QA fixtures. Dedicated C StyleOne/StyleTwo preview/export paths pass under traps. Public copy remains separate from video subtitles. Real cultural-fusion style framing remains a limitation, not waived by Quick Reframe.

22. **Editor/Ask AI Free.** History reopen shows XeeFree and hides provider/model lineage. Generic settings PATCH cannot replace the server-owned generation origin; History/materialization prefer clip telemetry over a newer video job. Owned Free requests work with global cloud consent off, even when externalAiAuthorized is supplied. Direct hook rewrites execute locally on B/G/H/I/Z; missing music yields NEEDS_INPUT, ambiguous requests UNSUPPORTED. D's retained-range hook rewrite declines with a setup/ending warning instead of escalating. The final B run verifies all three exports, History, immutable provenance, local hook rewrite, direct/open-ended command handling and Quick Reframe. Concurrent PATCH saves are now retried only after a rolled-back P2034 transaction, rereading the revision: one save commits, the other returns 409, one History row. Repeated contention stops after three attempts with 409 and no extra mutation. This does not promise instantaneous rendering or every possible editor operation.

23. **English live acceptance.** Functional QA used authored English SAPI speech transcribed by real local Whisper and rendered by FFmpeg, plus real human advice/cultural/delivery material. The fixture matrix below is complete as an evaluation, including zero-count and failed cases. Synthetic speakers do not certify human diarization or all English content. Real advice passes; cultural-fusion is partly accepted; intact delivery has one StyleZero export, while other styles/counts are not certified. Unsafe original truncated delivery was not relabelled as passing.

24. **Hindi/Hinglish.** Hindi: **PENDING REAL MEDIA**. Hinglish: **PENDING REAL MEDIA**. Synthetic transcription is insufficient for certification. Unsupported-language paths avoid English templates and retain a review warning. English completion is not blocked by this missing real-media set.

25. **Free versus Pro.** Separate same-source ONLINE jobs preserve the configured Pro pipeline, language bars and threshold behavior. Successful short-source comparisons share start/end ranges but Pro paraphrases and varies headline mechanisms more naturally. Pro B/D/G delivered one per style; H delivered only StyleZero; I delivered zero. An earlier D control also delivered zero at its language gate, while a later separate D run passed. Free delivered three per style on I. These variable, mostly synthetic results do not establish parity or superiority. Some Pro report rows have empty copy fields; no universal caption/synopsis advantage is claimed.

26. **Runtime/performance.** This is render-dominated QA, not latency certification. The short-source Free/Pro totals and long-run totals appear below. Final rebuilt B takes 126 s for analysis plus three exports/editor/Quick Reframe, with 6.3 s analysis; final D takes 111 s with 12.7 s analysis. UI mutations remain separate from rendering. Existing editor timing tests include 300-caption single-row persistence and phone trim/duplicate/speed/undo/redo; nine desktop/phone browser cases pass. No promise of zero delay for any video.

27. **Regressions.** Final Free suite: 59 engine and 14 policy checks pass; backend compilation/type check, shared and frontend type checks, and static frontend build pass. Isolated real-database auth/ownership/credit suite: 27 checks pass, including concurrent save, bounded contention, tier retention and Free consent exceptions. Editor object awareness: 66 checks; browser editing: nine. Broad 69-script evaluation resolves to 61 passes and eight existing/environment/fixture failures, described below; one frontend source assertion also fails identically at HEAD. No newly unexplained regression is classified as passing.

28. **Remaining limits.** Free has a narrower, plainer and sometimes awkward hook/copy vocabulary; incomplete context can still decline. C/E are too short for the shared clip minimum. Cultural StyleOne/Two framing is unresolved. Real speaker switching, useful automatic zoom, ambiguous strong-tail ASR and Hindi/Hinglish are not certified. Delivery all-style acceptance, processing-resume integration and the listed historical suites remain incomplete. Free/Pro comparisons are small and stochastic. Production has not received this feature.

## Live matrix and artifacts

Artifacts are under the git-ignored .real-qa-preview/xeefree/ directory. Count is per style, not the sum of variants.

| Source | Requested / delivered | Boundary, hook and export result | Evidence |
|---|---|---|---|
| A question/answer | 1 / 1 each | Earlier complete run preserved; all styles/History pass; A was not blindly rerun | free/report.json |
| B story | 2 / 1 each; final 1 / 1 each | 0.91–22.08 s; “Three years ago I lost my biggest client overnight”; outcome retained; local editor/QR pass | free-short and final-save-recovery |
| C advice | 2 / 0 each | Reconstructed useful speech about 13.25 s, below the unchanged 15 s minimum. HEAD has the same zero count. Quick Reframe manual + StyleOne/Two export pass | final-short-limits |
| D disagreement | 2 / 1 each; final 1 / 1 each | 0.81–18.61 s; neutral question, claim and rebuttal retained; all style exports/History/QR pass; hook rewrite can decline | final-disagreement and final-recovery |
| E two speakers | 2 / 0 each | Useful speech about 13.52 s; shared minimum refuses it. Manual Quick Reframe passes; no switch certification | final-short-limits |
| G list | 2 / 1 each | 0.84–16.29 s; “Three reasons start-ups fail”; rebuilt live run confirms hyphen repair | free-hyphen |
| H tutorial | 2 / 1 each | 0.81–16.91 s; grounded but clumsy UI-label headline; three exports/History/QR pass | free-short |
| I monologue | 3 / 3 each | Three distinct overlapping sentence windows, contrast/conditional/patience angles; complete endings after padding fix; nine usable exports | final-long original style files; free-long/final-long-resumed checks |
| Z episode | 3 / 3 each | Different exercise/story/list-debate ranges. Disputed segment extends to 103.22 s to include the response; nine usable exports | final-Z-response style files; free-long completed flows |
| Real advice | 3 / 2 each | Two usable ranges, boundaries and all styles/History/editor/QR pass; count shortfall retained | continuation-long-real |
| Real cultural-fusion | 3 / 1 base | Plain grounded hook recovered; StyleZero usable; StyleOne/Two STYLE_FAILED subject framing. Earlier base-download masquerading as styles is excluded | continuation-long-real + offline ASR checks |
| Intact real delivery | 3 / 1 StyleZero | One usable export; prior harness stopped on scarcity before other styles. Original truncated media not certified | continuation-long-real |

The final-Z-response run saved all nine exports and History before an editor PATCH 500. Its original logs were unavailable after interruption/QA removal. A forced real PostgreSQL concurrent-save test reproduced P2034/500, then passed after the bounded retry fix. Fresh final D and rebuilt B complete the editor/export flows. The failed episode report is preserved; it is not silently rewritten as an all-flow pass.

## Independent zero-cloud evidence

| Audit prefix | Completed distinct analyses | OpenAI / cloud / Pro escalation / blocked attempts | Trap entries |
|---|---:|---|---:|
| continuation-short | 4 | 0 / 0 / 0 / 0 | 0 |
| continuation-long | 5 | 0 / 0 / 0 / 0 | 0 |
| final-long | 4 | 0 / 0 / 0 / 0 | 0 |
| final-consent | 1 | 0 / 0 / 0 / 0 | 0 |
| final | 2 | 0 / 0 / 0 / 0 | 0 |
| final-recovery | 1 | 0 / 0 / 0 / 0 | 0 |
| final-save | 1 | 0 / 0 / 0 / 0 | 0 |

These are eighteen distinct audited analysis jobs across saved periods. Each audit checks all job summaries, six preload entry points and both Docker output streams. Audit JSON/raw logs are saved locally before teardown. The final-save image digest is sha256:2c14fed3bda5cae8cf894e1907874054c7accf873558bcf4f947c33fe0f4c931. Auth integration independently asserts no trap events. This is application-entry instrumentation plus host blackholes, not a packet capture of every process on the machine.

The separate Pro D control records seven OpenAI/cloud analysis calls, one escalation and eighteen provider request records across analysis/generation. Later Pro short/long comparisons also record online calls. It proves instrumentation observes cloud use without mixing Free and Pro jobs.

## Same-source comparison and timings

| Source | Free example | Pro example | Free / Pro whole-run seconds |
|---|---|---|---:|
| B | Three years ago I lost my biggest client overnight | The client loss that unexpectedly built an entire business | 270 / 291 |
| D | Does remote work kill creativity? | Can remote teams create without constant face-to-face contact? Hear the written-proposal argument. | 148 / 317 |
| G | Three reasons start-ups fail | Three forces can bring a startup down: no demand, no cash, no trust | 122 / 227 |
| H | How to choose Shortcuts and Search for the action you use most often | Want a shortcut for your most-used action? Start here | 166 / 257 |
| I | It's not talent, it's a habit of shrinking the problem | No delivered Pro clip: hook/structural gates | 669 / 929 |
| Z | Exercise, hiring and disputed remote-work angles | No separate Pro Z acceptance | 557 / not run |

Short Free analysis was about 6–11 s; I 14.7 s and Z 22.9 s. Short Pro analysis was about 49–97 s, I 90.2 s. Totals include three requested style operations, editor and Quick Reframe; short runs requested two clips while I/Z Free requested three. They are not per-clip benchmarks. Shared visual telemetry does not prove real useful switching/zoom in either tier on these fixtures. Pro H StyleOne/Two and I gates failed; the earlier D failure is retained in pro-comparison/report.json.

## Regression evaluation

The broad runner is scripts/verify-xeefree-regressions.cjs. Raw outputs, retests, archived HEAD comparisons and classified-report.json are local artifacts. Recovered fixture/environment cases include explicit ONLINE scope for mocked Pro services, modern shared creative schemas, safe Windows upload execution, adequate benchmark timeout and isolated authenticated integration.

| Remaining suite | Evaluation |
|---|---|
| test-processing-resume.cjs | Database/Redis integration and stale short/visual fixture; baseline also fails. Resume recovery is not certified |
| test-clip-candidates.cjs | Existing HEAD shared-creative/status fixture failure |
| test-video-understanding.cjs | Existing HEAD undefined candidate/copy expectation |
| test-pipeline-performance.cjs | Existing HEAD shortlist-count fixture |
| test-editing.cjs | Existing HEAD creative-call budget fixture |
| test-edit-quality.cjs | Existing HEAD 55/56 overlong-hook fit expectation |
| test-online-resilience.cjs | Existing HEAD fallback hashtag expectation when review is unavailable |
| test-ai-providers-http.cjs | Existing HEAD unauthenticated/bootstrap harness; authorization was not weakened |

Frontend source suites: six of seven pass; test-chat-ui expects the old consent-before-panel behavior and fails identically on archived HEAD. Nine desktop/phone browser cases cover music and trim/zoom/media. Following the save fix, eight affected editor/music/trim/timing/materialization/AI-object suites were rerun and pass. The 27-case auth harness uses a brand-new named database, unique Redis container and MinIO bucket, then removes only its own state.

## Files and tests

New implementation: apps/backend/src/modules/free/{free-analysis,free-boundary,free-captions,free-copy,free-creative,free-emphasis,free-hooks,free-lexicon,free-moments,free-sentences,free-speakers}.ts and processing/execution-policy.ts.

Integration changes: processing router/provider/telemetry/stage services; content-intelligence creative/understanding/boundaries; deterministic editing/plans/subtitles; generated clip selection/export/History/materialization; edit-mode planner/chat/agent/captions/presets/project-save; auth consent guard; explicit admin provider connectivity scope. Template geometry, music/trim/zoom/media stabilization and Pro creative bars remain.

Added tests/tools: test-xeefree-engine.cjs, test-xeefree-policy.cjs, test-xeefree-qa-safety.cjs, fixtures/xeefree-corpus.cjs, verify-xeefree-{asr,auth,live,provider-audit}.cjs, xeefree-provider-trap.cjs, xeefree-qa-safety.cjs, scripts/verify-xeefree-regressions.cjs. The top-up validates names, labels, network, loopback port, database host/mount and exact disposable UUID/email/role before one credit update. Seven negative stack identities are refused.

Modified tests: AI modes, auth/security, clip/content intelligence, content packages, editor AI objects, ending ASR, generated-project materialization, local fallback, processing-resume dependencies, provider connectors, Quick Reframe copy, video understanding and Pro hook grammar. Changes identify explicit online mocks, the modern creative contract, finite grounded option pools and persisted Free ownership/tier behavior. They do not lower Pro thresholds.

Documentation: CLAUDE.md, PROJECT_STATE.md, xeefree-pipeline.md and this 28-point report.

## Operational and Git status

- QA: final proof saved. All five verified xeeqa containers, xeeqa_default and four QA-owned volumes removed; no QA containers remain. Shared ai-content-platform_visual_models preserved. Task-private provider/session manifests removed; proof, media and baseline archives retained. See local qa-cleanup-result.json.
- Production: six original container IDs, image digests, start times, environment hashes and sorted mount sets matched the before snapshot. Final post-cleanup verification PASS (production-after-cleanup.json). No production restart, migration, user/credit/env change or deployment is authorized here.
- Git: main; starting HEAD 5e7bd32, with one existing style-preview commit ahead of origin/main. This report belongs to the coherent “feat: strengthen XeeFree local intelligence” feature commit after proof/docs/cleanup. Normal push to main includes the previously unpublished style-preview commit. The verified commit/push result is supplied in the completion message.
- Unrelated work: preserve the three untracked root editor-release scripts (prepare-editor-timing-release.cjs, release-editor-timing.cjs, verify-editor-timing-live.cjs); exclude them from the feature commit. Ignored QA artifacts/baseline archives are retained. No Git worktree was created.
- Deployment: **NOT DEPLOYED. Production remains on its existing running images.**
