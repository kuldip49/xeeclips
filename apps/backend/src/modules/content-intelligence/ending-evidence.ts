import type { BoundaryWord } from './clip-boundary.service';
import { bare, CLAUSE_WORD, continuation, dangling, newTopic, terminal } from './boundary-semantics';

/**
 * Ending evidence under ASR uncertainty.
 *
 * Boundary QA used to read a clip's final token as truth: a trailing "..." or a missing full stop on a
 * misrecognised last word ("a Manuel." heard as "a metal...") failed END_COMPLETE even though the speaker had
 * plainly finished. This module asks the question the viewer cares about - did the speaker finish the thought? -
 * and uses the final token's spelling only as one piece of evidence.
 *
 * WHICH SIGNALS ARE REAL AND WHICH ARE INFERRED (nothing below is invented):
 *   REAL      per-word `confidence` = faster-whisper's word probability, forwarded by the AI service and stored in
 *             TranscriptSegment.words. Absent for transcripts stored before it was forwarded; then it is null and
 *             no number is made up. A fresh tail pass (`TailPass`) is real ASR plus measured audio.
 *   INFERRED  trailing ellipsis (Whisper's own trail-off / uncertainty marker), missing terminal punctuation,
 *             a malformed or hyphen-truncated final token, closure by pause / speaker turn / end of source, clause
 *             completeness of the final sentence, cross-pass disagreement on the last lexical item.
 * Audio energy at the cut is NOT used as an end-of-utterance cue unless there is trailing silence or continuing voice;
 * measured level/slope does not separate a natural offset from a mid-word cut (see tail_analysis.py).
 */
export type AsrState = 'ASR_RELIABLE' | 'ASR_UNCERTAIN' | 'ASR_CONFLICTING';
export type EndingVerdict = 'NOT_APPLICABLE' | 'COMPLETE' | 'INCOMPLETE' | 'INCONCLUSIVE';
export type EndingClosure = 'PAUSE' | 'TURN' | 'SOURCE_END' | 'NONE';

export type TailWord = { text: string; start: number; end: number; confidence: number | null };
export type TailAcousticsResult = { stopped: boolean; speechContinues: boolean | null; audioEndsMs: number; postSilenceMs: number };
/** One bounded re-transcription of the last seconds before a clip end, with the audio measured at the cut. */
export type TailPass = { version: 1; windowStart: number; windowEnd: number; finalWordEnd: number;
  words: TailWord[]; acoustics: TailAcousticsResult };

export type EndingEvidence = {
  version: 1; verdict: EndingVerdict; state: AsrState;
  finalToken: string; wordStart: number; wordEnd: number;
  finalConfidence: number | null; confidenceSource: 'WORD' | 'NONE';
  realSignals: string[]; inferredSignals: string[]; closure: EndingClosure; reasons: string[];
  tail?: { agreement: number; finalOnlyDiffers: boolean; freshFinalToken: string | null; freshFinalConfidence: number | null;
    acoustics: TailAcousticsResult };
};

/**
 * Thresholds, with their basis. Word probabilities over the three real acceptance clips (231 words): median 0.98,
 * about 10% below 0.6, so low confidence alone is common and never decides a verdict. On the Delivery ending the final
 * token scored 0.40-0.59 in every one of five passes while the preceding words scored 0.92-1.00.
 */
export const ASR_ENDING_POLICY = {
  lowConfidence: 0.6,        // absolute: below this the final word is a weak reading
  relativeDrop: 0.3,         // or this far under the median of the six words before it (needs >= 3 of them)
  pauseSec: 0.8,             // same natural-break gap the boundary service already uses
  minSentenceWords: 4,
  tailAgreement: 0.8,        // share of the words before the last one that two passes must agree on
  tailAlignSec: 0.3,         // a tail pass belongs to this word only if it was taken at the same word end
  tailFreshMoreSec: 0.12     // fresh speech starting this long after the word end means the speech runs on
} as const;

// Words that cannot end a thought. Only consulted on the path that RELAXES punctuation strictness, so a longer
// list can only make acceptance stricter.
const OPEN_TAIL = new Set(['is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does',
  'did', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must', 'of', 'in', 'on', 'at', 'for',
  'with', 'from', 'by', 'about', 'into', 'onto', 'over', 'under', 'through', 'than', 'as', 'like', 'between', 'toward',
  'towards', 'against', 'without', 'within', 'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'his',
  'her', 'its', 'our', 'their', 'every', 'each', 'several', 'and', 'or', 'but', 'so', 'because', 'if', 'when', 'while',
  'although', 'though', 'which', 'who', 'whom', 'whose', 'where', 'whether', 'to', 'also', 'just', 'even', 'only',
  'very', 'quite', 'not', 'probably', 'actually', 'basically', 'then', 'now']);

const INTERROGATIVE = /^(?:(?:so|and|but|well|okay|now)\s+)?(?:who|what|why|how|when|where|which|do|does|did|is|are|was|were|can|could|would|should|will|have|has)\b/iu;
const ELLIPSIS = /(?:\.{2,}|…)["'’”\])]*$/u;
const TRUNCATED = /[-–—]["'’”\])]*$/u;
/** A token cut off mid-word ("Manu-"): explicit evidence the speech was interrupted, whatever follows. */
export const isTruncatedToken = (text: string) => TRUNCATED.test(text.trim());
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}
const sameToken = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && distance(a, b) <= 1);
const hasPredicate = (tokens: string[]) => tokens.slice(0, -1).some((t, i) => CLAUSE_WORD.test(t)
  || /(?:ed|ing)$/iu.test(t) || (i > 0 && /(?<!s)s$/iu.test(t)));

/** Close the final token's sentence for QA: `metal...`, `metal` and `metal,` read as `metal.`. The returned clip text keeps the ASR spelling. */
export const closeSentence = (text: string) => {
  const trimmed = text.trimEnd();
  const stripped = trimmed.replace(/(?:\.{2,}|…|[,;:])+(["'’”\])]*)$/u, '$1');
  return /[.!?।॥]["'’”\])]*$/u.test(stripped) ? stripped : stripped.replace(/(["'’”\])]*)$/u, '.$1');
};

/** The tail pass taken at this word, if there is one. A pass taken at another word says nothing about this ending. */
export function alignedTail(word: BoundaryWord): TailPass | undefined {
  const pass = word.tailPass;
  // The pass comes from stored JSON: anything malformed is ignored, never allowed to throw inside the gate.
  const wellFormed = !!pass && pass.version === 1 && Array.isArray(pass.words) && !!pass.acoustics && typeof pass.acoustics === 'object'
    && pass.words.every(w => !!w && typeof w.text === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end));
  return wellFormed && Math.abs(pass.finalWordEnd - word.end) <= ASR_ENDING_POLICY.tailAlignSec && pass.windowStart < word.start ? pass : undefined;
}

function tailComparison(words: BoundaryWord[], index: number, pass: TailPass) {
  const final = words[index];
  const original = words.slice(Math.max(0, index - 6), index).map(w => bare(w.text)).filter(Boolean).slice(-5);
  // Words that began before the original word ended are the same utterance; later ones are handled as "more speech".
  const fresh = pass.words.filter(w => w.start < final.end && bare(w.text)).sort((a, b) => a.start - b.start);
  const freshFinal = fresh.at(-1) ?? null;
  const freshPrefix = fresh.slice(0, -1).map(w => bare(w.text)).slice(-5);
  const compared = Math.min(original.length, freshPrefix.length);
  let matches = 0;
  for (let k = 1; k <= compared; k++) if (sameToken(original[original.length - k], freshPrefix[freshPrefix.length - k])) matches++;
  const agreement = compared >= 3 ? matches / compared : 0;
  const finalSame = !!freshFinal && sameToken(bare(final.text), bare(freshFinal.text));
  // Words the first pass did not have, starting after this word ended: the speaker did not stop here.
  const more = pass.words.some(w => w.start >= final.end + ASR_ENDING_POLICY.tailFreshMoreSec && bare(w.text));
  let sentenceStart = 0;
  for (let i = fresh.length - 2; i >= 0; i--) if (terminal(fresh[i].text)) { sentenceStart = i + 1; break; }
  const freshSentence = fresh.slice(sentenceStart).map(w => bare(w.text));
  const freshText = fresh.map(w => w.text).join(' ');
  const freshComplete = !!freshFinal && !OPEN_TAIL.has(bare(freshFinal.text)) && !dangling(closeSentence(freshText).replace(/[.!?।]+$/u, ''))
    // The window can start mid-sentence; only a sentence whose start the fresh pass actually saw must show a predicate.
    && (sentenceStart === 0 || (hasPredicate(freshSentence) && freshSentence.length >= ASR_ENDING_POLICY.minSentenceWords));
  return { agreement, finalSame, freshFinal, more, freshComplete, freshEllipsis: !!freshFinal && ELLIPSIS.test(freshFinal.text.trim()) };
}

/**
 * Does the speaker's thought end at `words[index]`, given that the final token's punctuation is not a plain full stop?
 * Cheap to call: a word that is already terminally punctuated is NOT_APPLICABLE and never reaches the evidence logic.
 */
export function assessEnding(input: { words: BoundaryWord[]; index: number; startIndex: number; sourceEnd: number }): EndingEvidence {
  const { words, index, startIndex, sourceEnd } = input;
  const final = words[index], text = final.text.trim(), core = bare(text);
  const conf = typeof final.confidence === 'number' && Number.isFinite(final.confidence) ? final.confidence : null;
  const out: EndingEvidence = { version: 1, verdict: 'INCOMPLETE', state: 'ASR_UNCERTAIN', finalToken: final.text,
    wordStart: final.start, wordEnd: final.end, finalConfidence: conf, confidenceSource: conf === null ? 'NONE' : 'WORD',
    realSignals: [], inferredSignals: [], closure: 'NONE', reasons: [] };
  if (terminal(text)) return { ...out, verdict: 'NOT_APPLICABLE', state: 'ASR_RELIABLE' };

  const next = words[index + 1];
  const gap = next ? next.start - final.end : Infinity;
  const turn = !!next && !!final.speaker && !!next.speaker && final.speaker !== next.speaker && next.start >= final.end;
  out.closure = turn ? 'TURN' : next ? (gap >= ASR_ENDING_POLICY.pauseSec ? 'PAUSE' : 'NONE')
    // Nothing follows. No margin test against the end of the audio: ASR word ends are only good to ~100 ms (the same Delivery
    // audio put its final word's end at 27.54 s in one run and 27.62 s in another, with voice energy running to ~27.60 s), so
    // "the audio ends N ms after the word" cannot tell a finished word from a cut one. Doubt, tail pass and review decide.
    : 'SOURCE_END';

  const ellipsis = ELLIPSIS.test(text), truncated = TRUNCATED.test(text);
  const previous = words.slice(Math.max(0, index - 6), index).map(w => w.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  const lowAbs = conf !== null && conf < ASR_ENDING_POLICY.lowConfidence;
  const lowRel = conf !== null && previous.length >= 3 && conf <= median(previous) - ASR_ENDING_POLICY.relativeDrop;
  if (lowAbs) out.realSignals.push('FINAL_WORD_CONFIDENCE_LOW');
  if (lowRel) out.realSignals.push('FINAL_WORD_CONFIDENCE_DROP');
  if (ellipsis) out.inferredSignals.push('TRAILING_ELLIPSIS');
  else if (!truncated) out.inferredSignals.push('NO_TERMINAL_PUNCTUATION');
  if (truncated) out.inferredSignals.push('TRUNCATED_FINAL_TOKEN');
  const malformed = !core || (core.length === 1 && !/^[ai]$/iu.test(core)) || (/\d/u.test(core) && /\p{L}/u.test(core)) || /(.)\1{3,}/u.test(core);
  if (malformed) out.inferredSignals.push('MALFORMED_FINAL_TOKEN');

  // A token Whisper marked as trailing off even though it read the word confidently is a genuine trail-off.
  out.state = ellipsis && conf !== null && !lowAbs && !lowRel ? 'ASR_RELIABLE' : 'ASR_UNCERTAIN';
  // An ellipsis is a marker Whisper also emits when unsure; alone it can neither prove nor excuse a trail-off. It is
  // excused by a real weak reading of the word (or a malformed token), or by another pass disagreeing with it.
  const ellipsisOnly = ellipsis && !lowAbs && !lowRel && !malformed;
  const pass = alignedTail(final);
  const cmp = pass ? tailComparison(words, index, pass) : undefined;
  let stableAcrossPasses = false;
  if (pass && cmp) {
    stableAcrossPasses = cmp.agreement >= ASR_ENDING_POLICY.tailAgreement && cmp.finalSame && cmp.freshEllipsis === ellipsis;
    if (cmp.agreement < ASR_ENDING_POLICY.tailAgreement || !cmp.finalSame || cmp.freshEllipsis !== ellipsis) out.state = 'ASR_CONFLICTING';
    out.tail = { agreement: cmp.agreement, finalOnlyDiffers: cmp.agreement >= ASR_ENDING_POLICY.tailAgreement && !cmp.finalSame,
      freshFinalToken: cmp.freshFinal?.text ?? null, freshFinalConfidence: cmp.freshFinal?.confidence ?? null, acoustics: pass.acoustics };
  }
  const fail = (...reasons: string[]): EndingEvidence => ({ ...out, verdict: 'INCOMPLETE', reasons: [...out.reasons, ...reasons] });

  if (truncated) return fail('TRUNCATED_FINAL_WORD');
  if (out.closure === 'NONE') return fail(gap < 0.35 ? 'SPEECH_CONTINUES_IMMEDIATELY' : 'NO_PAUSE_OR_TURN_AFTER_FINAL_WORD');
  if (out.state === 'ASR_RELIABLE') return fail('TRAILING_OFF_CONFIRMED');
  // A pause alone does not make a clause a finished utterance. Whisper ends a segment only where it hears the utterance
  // end, so an unreliable last word is excused only when the decoder itself closed its segment there (or the speaker changed).
  if (out.closure === 'PAUSE' && final.segmentEnd !== true) return fail('NOT_AT_ASR_UTTERANCE_BOUNDARY');
  // The same word with the same trailing dots in two independent passes is a genuine trail-off, whatever its confidence.
  if (ellipsis && stableAcrossPasses) return fail('TRAILING_OFF_STABLE_ACROSS_PASSES');

  // Clause completion of the final sentence, judged without trusting the last token's spelling.
  let from = index;
  while (from > startIndex && !terminal(words[from - 1].text)) from--;
  const sentence = words.slice(from, index + 1).map(w => bare(w.text)).filter(Boolean);
  const sentenceText = closeSentence(words.slice(from, index + 1).map(w => w.text.trim()).join(' ')).replace(/[.!?।]+$/u, '');
  if (OPEN_TAIL.has(core) || dangling(sentenceText)) return fail('DANGLING_CLAUSE');
  // A question whose mark was lost with the final token is still a question: silence after it is not an answer.
  if (INTERROGATIVE.test(sentence.join(' '))) return fail('UNPUNCTUATED_QUESTION_END');
  if (sentence.length < ASR_ENDING_POLICY.minSentenceWords || !hasPredicate(sentence)) return fail('FRAGMENTARY_FINAL_SENTENCE');
  const nextText = words.slice(index + 1, index + 9).map(w => w.text).join(' ');
  if (next && gap < 1.2 && continuation(nextText) && !newTopic(nextText)) return fail('CONTINUATION_AFTER_BOUNDARY');

  if (pass && cmp) {
    if (pass.acoustics.speechContinues === true) return fail('ACOUSTIC_SPEECH_CONTINUES');
    if (!next && cmp.more) return fail('FRESH_PASS_HEARS_MORE_SPEECH');
    if (cmp.agreement < ASR_ENDING_POLICY.tailAgreement) return fail('TAIL_UNSTABLE');
    if (!cmp.freshComplete) return fail('FRESH_PASS_INCOMPLETE');
  }
  // At the very end of the audio a CONFIDENTLY read last word with no full stop is not noise: Whisper punctuates a sentence
  // it heard finish, so the missing stop is itself evidence of a cut. Only doubt about the token itself can excuse it.
  if (out.closure === 'SOURCE_END' && !(lowAbs || lowRel || malformed || out.state === 'ASR_CONFLICTING')) return fail('SOURCE_END_WITHOUT_TOKEN_DOUBT');
  if ((out.closure === 'SOURCE_END' || ellipsisOnly) && !pass) {
    // Nothing follows and the audio gives no stop to rely on (or the ellipsis is the only doubt): one bounded tail pass
    // decides, never the token alone.
    return { ...out, verdict: 'INCONCLUSIVE', reasons: ['NEEDS_TAIL_VERIFICATION'] };
  }
  return { ...out, verdict: 'COMPLETE', reasons: [pass ? 'TAIL_PASS_CONFIRMS_COMPLETION' : out.closure === 'TURN' ? 'SPEAKER_TURN_CLOSURE' : 'PAUSE_CLOSURE'] };
}

/** Validate and convert the AI service's /tail-transcriptions response. Returns null for anything malformed. */
export function tailPassFromResponse(value: unknown, finalWordEnd: number): TailPass | null {
  const r = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const a = r?.acoustics && typeof r.acoustics === 'object' ? r.acoustics as Record<string, unknown> : null;
  if (!r || !a || !Array.isArray(r.words) || !Number.isFinite(r.window_start) || !Number.isFinite(r.window_end)) return null;
  const words: TailWord[] = [];
  for (const item of r.words) {
    const w = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    if (!w || typeof w.text !== 'string' || !Number.isFinite(w.start) || !Number.isFinite(w.end)) return null;
    words.push({ text: w.text, start: w.start as number, end: w.end as number,
      confidence: typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : null });
  }
  return { version: 1, windowStart: r.window_start as number, windowEnd: r.window_end as number, finalWordEnd, words,
    acoustics: { stopped: a.stopped === true, speechContinues: typeof a.speech_continues === 'boolean' ? a.speech_continues : null,
      audioEndsMs: Math.round((Number(a.audio_ends_ms) || 0) * 10) / 10, postSilenceMs: Math.round((Number(a.post_silence_ms) || 0) * 10) / 10 } };
}
