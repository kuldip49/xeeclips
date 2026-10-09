# Ending QA under ASR uncertainty

**2026-10-09 continuation:** the original Delivery excerpt was proved to cut through the final word, and terminal punctuation
now requires source-EOF acoustics on audio-backed paths. The stronger-tail policy, cache/provenance handling, AAC padding fix,
model measurements and final isolated results are in [ending-v3-continuation.md](ending-v3-continuation.md).
The historical terminal-punctuation and source-end assumptions below are superseded by that report. Production is untouched;
the original truncated fixture is rejected, while an intact-source run passes the handoff's commit/push gate. Production is untouched.

Fixes the Content Intelligence v2 production-acceptance blocker (2026-10-09): the fresh Delivery transcript ended
"... more like a metal..." (the speaker said "Manuel") and the shared boundary gate refused the clip.
Scope is **ending-QA robustness only**. Hook thresholds, clickability scoring, the writer/reviewer rubric, hook
preservation, StyleZero/StyleOne/StyleTwo visuals, crop, zoom, speaker switching and Quick Reframe geometry are untouched.

## 1. Root cause (reproduced)

The exact audio (`delivery.wav`, 27.65 s) was transcribed with the production code path (`whisper-base`, int8, CPU,
`_transcribe`) and the words were fed to the unchanged gate.

| Finding | Evidence |
| --- | --- |
| The final token really is unstable | Same audio, five passes: `metal.` (p 0.42), `metal.` (0.49), `mental` (0.40, 6 s tail), `man` (0.47, 8 s tail), `man` (0.59, 10 s tail). Every pass agrees on "it looks more like **a**" (p 0.92-0.97). Only the last word changes, and it is always the weakest in the tail. |
| A wrong word is **not** what fails the gate | `metal.` and `Manuel.` both pass `repair`. The gate fails only for the **trailing ellipsis**: `terminal()` rejects `...` and `endingSignals` treats `...` as a dangling clause. The failed set (`END_COMPLETE`, `THOUGHT_COMPLETE`, `CLAIM_RESOLVED`, `NO_DANGLING_CLAUSE`, `VIEWER_SATISFIED_END`) is reproduced exactly with a `metal...` token and nothing else changed. |
| The audio gives no stop to hear | The source ends 110 ms after the stated word end and voice energy decays to the last frame. ASR's word end (27.54 s) is itself an underestimate (voice continues to ~27.60 s), which is a symptom of the unstable word. |
| Transcript confidence existed but never reached the gate | faster-whisper exposes `Word.probability` and the AI service already forwarded it as `confidence`; the backend stored it in `TranscriptSegment.words`; `transcriptBoundaryWords` dropped it. |
| Not a V2 boundary regression | The ellipsis comes from ASR. The gate logic that rejects it is older than V2; V2 simply met a fresh ASR run that produced it. |

Honest limit: my run emitted `metal.` (period); production emitted `metal...`. The ellipsis shape is taken from the retained
production candidate text and reproduced by changing only that token. Whisper punctuation differs between runs and CPUs.
The production database rows were deleted with the disposable QA accounts, so the production word timestamps and
confidences were not available; the numbers above come from re-running the same code and model on the same audio.

## 2. What the ASR backend actually exposes

| Signal | Status |
| --- | --- |
| Per-word probability (`Word.probability`) | **REAL.** Forwarded as `words[].confidence`, now carried into `BoundaryWord.confidence`. Absent in transcripts stored before it was forwarded; then it stays absent (never invented). |
| Per-segment confidence | REAL but only an average of word probabilities (or `exp(avg_logprob)`); not used for the decision. |
| Alternatives / n-best | **Not exposed** by faster-whisper's transcribe API. Nothing is claimed. |
| Segment boundaries | REAL structure: a Whisper segment ends where the decoder ended its utterance. Used as `segmentEnd`. |
| Fresh tail pass (new) | REAL: one bounded `/tail-transcriptions` call (<= 12 s window, in practice 9 s) with word probabilities and measured audio. |
| Trailing ellipsis, missing full stop, malformed or hyphen-cut final token, cross-pass disagreement | **INFERRED**, recorded separately in the evidence (`inferredSignals`). |
| Audio energy at the cut | **Not used as an end-of-utterance cue.** Measured on the three real clips (cuts at true word ends vs through the middle of words), level and slope overlap almost completely. Only two audio facts are reliable: trailing **silence** after the last word, and **voice continuing** well past it. When the audio ends with the word, both are reported as indeterminate (`speechContinues: null`). |

## 3. Uncertainty model

`ASR_RELIABLE`, `ASR_UNCERTAIN`, `ASR_CONFLICTING` describe the **final token**, never the sentence.

* `ASR_RELIABLE`: a confidently read word that Whisper still marked as trailing off (`...`). That is a real trail-off, so it fails.
* `ASR_UNCERTAIN`: any doubt about the token: probability < 0.6, or 0.3 below the median of the six words before it, malformed token,
  or an ellipsis / missing stop with no confidence data.
* `ASR_CONFLICTING`: a fresh tail pass agrees on the words before the last one (>= 80%) but disagrees on the last word or its
  ellipsis, or the passes disagree more broadly.

Thresholds come from data: over 231 real words, median probability 0.98 and about 10% below 0.6, so low confidence alone is
common and **never decides** a verdict. On Delivery the final token scored 0.40-0.59 in all five passes.

## 4. Decision policy

`ClipBoundaryService.repair` reads the final token through `assessEnding` (new `ending-evidence.ts`) only when its punctuation is
not already a plain full stop. A terminally punctuated ending behaves exactly as before.

An ending fails when the combined evidence says the thought is incomplete (any of):

* hyphen-truncated last word (`Manu-`) (this also closes a pre-existing hole: a pause used to accept it);
* a dangling clause or a function word last (articles, auxiliaries, prepositions, conjunctions, `then`, ...);
* an unpunctuated question (a lost `?` is still a question; silence is not an answer);
* a fragmentary final sentence (< 4 words or no predicate);
* speech continuing straight after (< 0.35 s), no pause or turn at all, or a dependent continuation;
* a **confident** word with Whisper's trail-off marker, or the same word and the same ellipsis in two passes;
* an unfinished announcement, list, question, story or punchline (the existing semantic checks, still applied to the normalized text);
* at the very end of the audio, a **confidently read** last word with no stop (Whisper punctuates a sentence it heard finish).

An ending with an uncertain final token is accepted only with positive closure:

| Closure | Needs |
| --- | --- |
| Speaker turn | the evidence checks above |
| Pause >= 0.8 s | the checks above **and** the word ends an ASR segment (a pause alone is not an utterance boundary) |
| End of the source | doubt about the **token itself** (not mere missing punctuation) **and** one bounded tail pass that agrees on everything but possibly the last word, hears no further speech, and has a complete final sentence **and** the semantic boundary reviewer (ONLINE mode) must then confirm; deterministic-only mode never takes this path |
| Ellipsis as the only doubt | corroboration by a real weak reading or by a disagreeing pass |

The clip text keeps the ASR spelling (`metal...`). Only the QA view of the final token is normalized. The result carries
`endingEvidence` (verdict, state, real vs inferred signals, closure, tail comparison) and the reason
`ENDING_ASR_UNCERTAIN_ACCEPTED` or `ENDING_NEEDS_TAIL_VERIFICATION`. The boundary reviewer prompt is told the last word may be a misreading.

## 5. The bounded tail pass

* AI service `POST /tail-transcriptions`: one window <= 12 s (422 beyond), one request per distinct ending (cached per word),
  under the same lock as transcription, same model and options; returns words with probabilities and the acoustic facts above.
* Backend `VideoProcessorService.requestTailPass`: a failure returns `null` (strict verdict stands) and never throws into the pipeline.
  `ENDING_TAIL_VERIFICATION_ENABLED=false` disables it.
* The pass is stored on that transcript word (`TranscriptSegment.words[].tailPass`) so export (`repair`/`validate`) and the editor
  (`retainedBoundaryQa`) reach the same verdict from stored data with no further AI call. The candidate also records `endingEvidence`
  in `evidence.boundaryRepair`.
* **Deployment prerequisite:** the AI service must be the new image with `/tail-transcriptions`. Without it the call fails
  safe (the Delivery-type ending is rejected exactly as before), so a backend-only deploy does not fix production.

## 6. Results

Regression suite `apps/backend/scripts/test-ending-asr-uncertainty.cjs` (21 checks; registered as the 26th runner script, `npm run test:ending-asr`):
correct word, wrong proper noun (plain stop / ellipsis in-source / ellipsis at source end with and without a tail pass),
homophone, truncated last word, four genuinely cut-off sentences, immediate continuation, punchline with noisy ASR, unfinished answers
despite silence, confident trail-off, unstable tail passes (four ways), bounded request count, the reviewer seeing the note,
the legacy no-confidence transcript, the editor path, and the **real Delivery fixture** (`scripts/fixtures/delivery-ending-asr.json`).

Differential on real transcripts (old HEAD gate vs new gate, final token distorted, deterministic stage only). Genuine finished
sentence ends vs genuine mid-sentence cuts (n = 20-23 and 190 per row):

| Case | Old accepts | New accepts |
| --- | --- | --- |
| Finished sentence, `...`, weak token, pause | 0 / 20 | 7 / 20 |
| Finished sentence, `...`, real confidence, pause | 0 / 20 | 1 / 20 |
| Mid-sentence cut, `...`, real confidence, pause | 0 / 190 | 0 / 190 |
| Mid-sentence cut, `...`, weak token (p = .3 forced on every word), pause | 0 / 190 | 3 / 190 |
| Mid-sentence cut, no punctuation, pause (pre-existing rule, unchanged) | 136 / 190 | 136 / 190 |
| Source end, real confidences (only the naturally weak last words qualify) | 0 | 2 / 23 finished, 10 / 190 cuts reach the reviewer |
| Source end, weak last word + agreeing tail pass | 0 | 12 / 23 finished, 81 / 190 cuts **reach the semantic reviewer** |

Reading it honestly: before the utterance-boundary rule the first row of cuts was 79 / 190, so that rule matters. The last row
is the residual risk: for a truncated source with a weak last word, the deterministic evidence alone cannot separate a finished
thought from a cut one (the weakness was forced on every word here; real weak words are about 10%). The semantic boundary
reviewer is the gate for that path, which is why the tail pass only runs when it will follow. The pre-existing "pause after an
unpunctuated word" acceptance (136 / 190) was not changed by this work.

Not done and why: the live OpenAI semantic reviewer was not run on this fixture (no network or spend in this task), and no
creative or hook code ran against the fresh-ASR transcript.

## 7. Finding from the isolated full-pipeline run (follow-up fix)

Running the real pipeline from scratch on the Delivery source (fresh ASR, isolated stack) reproduced the production shape
(`metal...`, word probability 0.32) but placed the final word's end 30 ms before the end of the audio. The first version of the gate
treated "less than 40 ms of audio after the last word" as a cut and failed the ending before any tail pass. That margin was an
unjustified line: ASR word ends are only good to about 100 ms (the same audio gave 27.54 s in one run and 27.62 s in another, with
voice energy continuing to about 27.60 s), so the distance to the end of the audio cannot separate a finished word from a cut one.
The margin test is removed. With nothing after the word the closure is `SOURCE_END` whatever the margin, and acceptance still needs
doubt about the token itself, one bounded tail pass, and the semantic reviewer.

## 8. Isolated pre-production acceptance (xeeqa, :4100) - result: NOT READY

Images built from clean exports of the commits (file-by-file identical to git, line endings normalised): AI service
`xeeclip-ai-service:aba8bb6` (`sha256:2aaee9e2...`, contains `/tail-transcriptions`; AI-service code is identical in `feb1506`) and backend
`xeeclip-backend:feb1506` (`sha256:6fb769be...`). The stack used its own PostgreSQL, Redis, MinIO and a copy of the models volume; production was
not touched (user/video counts unchanged).

Real pipeline, Delivery source, fresh ASR, ONLINE, EDITED_CLIPS, StyleTwo, one clip:

| Stage | Result |
| --- | --- |
| Fresh ASR | ended `It turns out it looks more like a metal...`, final word p = 0.32 (production shape reproduced) |
| Uncertainty | `FINAL_WORD_CONFIDENCE_LOW`, `_DROP`, `TRAILING_ELLIPSIS` detected |
| Tail pass | exactly one `/tail-transcriptions` call, 8 s window, second reading `man` (p 0.46), earlier words 100% matched -> `ASR_CONFLICTING`, closure `SOURCE_END`, deterministic gate accepted |
| First run | gate stopped before any tail call: the word ended 30 ms before the end of the audio and a 40 ms margin rule treated that as a cut. Margin rule removed (`feb1506`) |
| Live semantic reviewer | **rejected** at analysis and at export: the clip "ends with the unresolved phrase 'it looks more like a metal...'". No clip delivered. Not forced. |

Reviewer diagnostics (real `gpt-5.6-luna`, exact fresh-ASR words, 3-5 runs per target):

* correct word `Manuel.` -> accepted 12/12 across all four candidate targets;
* `metal...` -> rejected 12/12 across the pipeline's targets; accepted 5/5 only for a 27.65 target that the pipeline does not use;
* the verdict flips with a 30 ms change of `target.end`, and an evidence-rich `endingNote` (confidence, second-pass reading, match rate) flipped different targets
  (saved as `.real-qa-preview/ending-qa/enriched-reviewer-note.patch`, not applied). The reviewer judges meaning: with `metal` the payoff is unintelligible, which
  is also what StyleTwo captions would show. This is a payoff-intelligibility problem, not a boundary-logic problem.

Existing hook `Two name checks in a delivery fraud talk, and neither one matches` against the fresh-ASR transcript (real creative service, `existingHook`): ACCEPTED and
preserved, 2/2; grounding 88, misleading risk 12, naturalness 75, context 86, clickability 86 (human-reviewed control: 86 / 16 / 78 / 91 / 84).

Negative controls (same audio cut at four points, full isolated stack):

| Control | ASR heard | Result |
| --- | --- | --- |
| cut at 18.95 s, "...really is" | `is...` | rejected (`DANGLING_CLAUSE`) |
| cut at 19.10 s, mid-word "Greg" | `is...` (fragment dropped by ASR) | rejected (`DANGLING_CLAUSE`) |
| cut at 15.76 s, "...you order" | `order.` | passed the strict gate (terminal full stop), rejected by the semantic reviewer |
| cut at 17.00 s, mid "oh," | `something, you know.` (final word p = 0.067) | **delivered**: strict path trusts a full stop on a hallucinated token. Old and new gates behave identically. |

The last row is a pre-existing gap, not caused by this work: a terminally punctuated but near-zero-confidence final word at the end of the audio is trusted.
