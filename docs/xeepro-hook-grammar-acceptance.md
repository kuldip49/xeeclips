# XeePro hook grammar and clarity acceptance

The user subsequently requested question-led social-video hooks. The current style, regenerated packages and new template samples are documented in [xeepro-question-hook-style.md](C:/projects/ai-content-platform/docs/xeepro-question-hook-style.md). The editorial replacements below record the initial grammar regression baseline.

Verified locally on 2026-10-11. The two exact downloaded bad-hook clips were located, transcribed, regenerated with the configured OpenAI service, and checked with the shared XeePro reviewer. All 15 targeted test suites pass, including 39 new grammar/integration cases. Backend build, frontend TypeScript checking, and `git diff --check` pass. Changes are uncommitted; nothing was deployed.

## 1. Root cause

`deterministicCreative` ranked transcript tokens and inserted the first two directly into `What's behind X and Y?`. Tokens such as `tell` and `agree` were treated like nouns. Lexical overlap and synthesized clarity scores could pass without grammatical or semantic review. When the XeePro reviewer failed, the shared generator could expose this local fallback; Ask AI had another local fallback. A legacy holistic `supported: true` response also bypassed per-hook language assessment. The renderer had no final check requiring a complete reviewed verdict.

The local generator remains available to XeeFree, as requested. XeePro cannot select its unreviewed hooks.

## 2. Old hooks and actual source clips

| Exact local clip | Reproduced hook | New gate result |
| --- | --- | --- |
| `C:\Users\kuldi\Downloads\file (24).mp4` | “What’s behind tell and reason?” | Rejected: `NO_STITCHED_TRANSCRIPT_FRAGMENT` |
| `C:\Users\kuldi\Downloads\file (23).mp4` | “What’s behind puffing and agree?” | Rejected: `NO_STITCHED_TRANSCRIPT_FRAGMENT` |

The original video frames were inspected to match the burned-in hooks, and audio was transcribed locally with Faster-Whisper. Context was taken from those clips, rather than inferred from their filenames or bad hooks. The first clip contrasts impressive academic credentials with the speaker's requested “college dropout” introduction and argues that ideas must stand independently of their delivery. The second describes a technician's reaction to debate and argues that surprise at robust university dialogue indicates an echo chamber.

SHA-256 identities:

- file (24).mp4: `E13DDDE89D8DC054C123D77DE3141C260010968FFC761F3730BE9B6BBB9FA066`
- file (23).mp4: `0CEA1A28E0759D6C828F565A78CE1EEBE7E2090781BA9DAE2628C446DE8418F4`

## 3. Replacement hooks and real reviewer results

| Clip | New hook | Grammar | Clarity | Grounding | Clickability | Context | Naturalness | Template fit |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 24 | A powerful argument against judging ideas by résumés | PASS | PASS | 94 | 77 | 94 | 94 | All three PASS |
| 23 | The real warning sign was surprise at open debate. | PASS | PASS | 94 | 85 | 95 | 95 | All three PASS |

Scores are model reviewer judgments on a 0–100 scale. Both packages were `ACCEPTED`; their selected hooks passed all eight mandatory checks. Both replacements were also manually assessed against the extracted context. Full machine-readable evidence is in [real-results.json](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/real-results.json).

A separate misleading control, “Why introduce Professor Randall Kennedy as a college dropout?”, was rejected with grounding 15, context 35 and misleading risk 95. The speaker asks for that introduction for himself; Kennedy is described as highly credentialed. This control exposed a weakness in the cheaper reviewer, so the hook-review schemas now use `XEEPRO_HOOK_REVIEW_MODEL`, falling back to the configured `CREATIVE_ESCALATION_MODEL` when available. No model identifier is hardcoded. Their timeout is bounded to 40 seconds; other critic schemas retain the existing timeout/routing policy.

## 4. Grammar gate implementation

[hook-language.ts](C:/projects/ai-content-platform/apps/backend/src/modules/content-intelligence/hook-language.ts) defines the mandatory verdicts:

`GRAMMAR_OK`, `MEANING_CLEAR`, `NATURAL_LANGUAGE`, `CONTEXT_COMPLETE`, `NO_BROKEN_PHRASE`, `NO_WORD_SALAD`, `NO_DANGLING_PRONOUN`, `NO_STITCHED_TRANSCRIPT_FRAGMENT`.

The reviewer schema requires every field as a boolean. A missing, malformed or false verdict fails acceptance even when clickability, context and grounding scores are high. A cheap rejection screen catches the reported malformed constructions, broken auxiliary questions, dangling endings and unresolved references before semantic review. It cannot grant approval: arbitrary noun/verb relations and word salad still require the semantic reviewer.

Both the automatic clip executor and canonical editor export planner enforce the shared verdict again immediately before rendering. XeePro hooks require matching reviewed text and the existing grounding/clickability/context thresholds. A missing reviewer or disabled review produces no approved XeePro hook. Renderer failure cannot be bypassed by accepting a degraded render.

## 5. Clarity gate implementation

The reviewer explicitly checks instant comprehension, human phrasing, meaningful noun/verb relations, a complete standalone sentence or headline, grounded meaning, and clickability. Language checks precede numeric selection. Generic summary wording, unsupported implied claims, misattributed people/actions, and unresolved references remain separate rejection reasons.

Clip understanding now includes subject, action, consequence and conclusion alongside topic, claim, conflict, payoff, question and emotional tension. Generation receives these concepts and instructions to write complete hooks; it does not select raw ASR words as template slots. Attribution is checked against the actual transcript independently of generated understanding.

## 6. Grammar rewrite behavior

Language failures trigger at most one targeted grammar/clarity rewrite on the primary generation attempt, followed by a fresh full review. It preserves only supported meaning and may return no hook when the original has no recoverable supported idea. Original scores and verdicts are never inherited. Remaining failures can use the existing bounded regeneration/escalation pass. Failed corrections stay blocked. Normal length guidance is 6–16 words, up to about 22 when needed; the existing exceptional 26-word ceiling remains. Necessary grammar words are preserved.

## 7. Shared XeePro integration points

| Path | Enforcement |
| --- | --- |
| Create Clips / automatic export | Shared creative package, eligible hook selection, final executor check |
| StyleZero, StyleOne, StyleTwo | Same reviewed hook package; shared fit checks and canonical export guard |
| Quick Reframe | Shared `suggestHooks`; persisted review; selected wording must match an approved candidate |
| Manual Editor hook suggestions | Shared creative package and persisted `XEEPRO_V1` marker |
| Ask AI and edit agent | Shared writer; review proof persisted with suggestions; no XeePro local fallback |
| History regeneration / rewrite / re-export | Shared regeneration and canonical guard; materialized generated clips preserve ONLINE lineage |

An existing Pro marker survives later suggestion saves. Legacy Pro hooks without complete verdicts must be regenerated before export. The XeeFree no-model route and its local selection behavior remain unchanged and are covered by tests.

## 8. StyleZero result

Both hooks fit with their complete wording, two-line wrapping and bounded font fitting. The diagnostic export and actual React preview show no text overflow or clipping. Template geometry, colors and font family are preserved. StyleZero retains its existing preview/libass line-leading parity note.

- [Clip 24 diagnostic export](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/visuals/file24-StyleZero.mp4)
- [Clip 23 diagnostic export](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/visuals/file23-StyleZero.mp4)

## 9. StyleOne result

Both hooks fit the actual StyleOne headline box with its serif visual identity and full wording. Font size remains within the template's bounds; no overflow appears in preview or ASS export. StyleOne now has an explicit fit assessment rather than borrowing StyleZero's result.

- [Clip 24 diagnostic export](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/visuals/file24-StyleOne.mp4)
- [Clip 23 diagnostic export](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/visuals/file23-StyleOne.mp4)

## 10. StyleTwo result

Both hooks wrap safely in the existing StyleTwo typography without truncation. Preview and ASS export fit checks pass; template geometry and visual identity remain unchanged.

- [Clip 24 diagnostic export](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/visuals/file24-StyleTwo.mp4)
- [Clip 23 diagnostic export](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/visuals/file23-StyleTwo.mp4)

Visual verification used six three-second local diagnostic exports from the exact downloaded footage. Their already-burned old header was cropped out so the replacement text could be inspected. These are typography diagnostics, not complete production re-exports from the original pre-render source. Assertions preserve the canonical baseline's video/frame segments, zoom, grading and subtitles while changing the hook. All six export PNGs were visually inspected; actual React previews and canonical ASS overflow checks also passed. [Visual results](C:/projects/ai-content-platform/.real-qa-preview/xeepro-hook-grammar/visuals/report.json).

## 11. Quick Reframe result

StyleOne and StyleTwo integration suites pass. The new Pro integration case rejects explicit unreviewed wording before applying the style. Hook generation uses the clip's actual cropped/trimmed context and authorized mode; accepted candidates retain their mandatory review in the editor. Post-copy and crop/trim filtering tests also pass.

## 12. Ask AI result

The new integration cases verify that Ask AI installs the reviewed replacement with its proof and returns `CREATIVE_UNAVAILABLE` when generation/review is unavailable, instead of offering local token-template wording. Existing chat (89 checks) and agent (55 checks) suites pass. The agent passes project identity through initial, resumed and retry planning so accepted hooks persist their review.

## 13. Regression results

All 15 targeted suites pass:

- `test-xeepro-hook-grammar`: 39 cases, including both real bad hooks, grammar, word salad, ASR stuffing, malformed questions, noun/verb mismatch, dangling pronouns, incomplete sentences, long and short valid hooks, generic/misleading rejection, correction with fresh review, unavailable/malformed review, automatic/canonical renderer guards, History lineage, marker persistence, Ask AI, Quick Reframe and scoped reviewer routing.
- `test-creative-hook-pipeline`, `test-content-intelligence`, `test-content-intelligence-v2`.
- `test-edit-mode-chat`, `test-edit-agent`, `test-edit-mode-presets`, `test-edit-mode-render`.
- `test-generated-clip-edit-plan-reconstruction`, `test-generated-clip-edit-project`.
- `test-quick-reframe-styleone`, `test-quick-reframe-styletwo`, `test-quick-reframe-post-copy`.
- `test-ai-processing-modes`, `test-hook-plate-lengths`.

Backend build, frontend TypeScript checking and whitespace checking pass. Real OpenAI acceptance passes for both extracted clip transcripts; the misleading attribution control fails as expected. All six template diagnostics pass. Tests used service-level fixtures and local media rendering; no full browser journey through the deployed website was run.

Reproducible commands after backend build: `node apps/backend/scripts/test-xeepro-hook-grammar.cjs`, `node apps/backend/scripts/verify-xeepro-hook-grammar.cjs`, and `node apps/backend/scripts/verify-xeepro-hook-visuals.cjs`. The live script needs the local extracted `file24-words.json` / `file23-words.json` and configured service. The visual script also needs the existing local canonical template snapshots and fonts referenced in it. Tracked regression transcripts/hashes are in `apps/backend/scripts/fixtures/xeepro-hook-grammar.json`; local media and result files stay in the ignored QA folder.

The user explicitly authorized sending these two extracted transcripts to the project's configured OpenAI service. Only their clip evidence and hook candidates/direction were used; source paths, account information and unrelated data were not sent in prompt content. No database records or original downloaded media were modified.

## 14. Commit status

At the original acceptance stage changes were uncommitted on `main`, with baseline HEAD `6d5a9c5`. No commit, push or deployment had occurred. The user subsequently authorized committing and pushing the accumulated work on 2026-10-11, including the editor music fixes and the [mixed hook variety policy](xeepro-hook-variety.md). Publication status is reported in the task's final response.
