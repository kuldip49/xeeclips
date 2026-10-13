import { reconstructSentences, type Sentence, type TimedToken } from './free-sentences';
import { LIST_OPENER } from './free-moments';

/**
 * Sentence-level boundary QA for XeeFree. The shared boundary service repairs a range from punctuation, pauses and speaker changes; this
 * layer re-reads the repaired range with the full sentence reconstruction (fragments, dangling words, continuation openers, unresolved
 * pronoun openings) and proposes one bounded step out when the clip still starts or ends inside a thought.
 *
 * Semantic completeness comes before the target duration: a clip is extended to finish its sentence rather than trimmed to a length.
 */
export type TimedWordLike = { start: number; end: number; text: string; speaker?: string | null; confidence?: number | null };
export type SentenceBoundaryQa = {
  startStandalone: boolean; endComplete: boolean; startsMidSentence: boolean; endsMidSentence: boolean;
  first?: string; last?: string; reasons: string[];
  /** The start of the previous sentence / the end of the next one, when a step out is possible. */
  earlierStart?: number; laterEnd?: number };

const EDGE = .35;

export function sentenceBoundaryQa(words: TimedWordLike[], start: number, end: number): SentenceBoundaryQa {
  const context: TimedToken[] = words.filter(w => w.end > start - 45 && w.start < end + 45).map(w => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker, confidence: w.confidence }));
  const sentences = reconstructSentences(context);
  const inside = sentences.filter(s => s.start !== undefined && s.end !== undefined && s.end > start + EDGE && s.start < end - EDGE);
  const reasons: string[] = [];
  if (!inside.length) return { startStandalone: false, endComplete: false, startsMidSentence: false, endsMidSentence: false, reasons: ['NO_SENTENCES_IN_RANGE'] };
  const first = inside[0], last = inside[inside.length - 1];
  const startsMidSentence = (first.start ?? start) < start - EDGE;
  const endsMidSentence = (last.end ?? end) > end + EDGE;
  if (startsMidSentence) reasons.push('FREE_START_MID_SENTENCE');
  if (!first.standalone) reasons.push(...first.reasons.filter(r => r === 'CONTINUATION_START' || r === 'DEPENDENT_OPENING' || r === 'UNRESOLVED_PRONOUN_OPENING' || r === 'NO_FINITE_VERB' || r === 'DANGLING_END').map(r => 'FREE_START_' + r));
  if (endsMidSentence) reasons.push('FREE_END_MID_SENTENCE');
  if (!last.complete) reasons.push(...last.reasons.filter(r => r === 'DANGLING_END' || r === 'NO_FINITE_VERB' || r === 'TOO_SHORT').map(r => 'FREE_END_' + r));
  if (last.kind === 'QUESTION' && inside.length > 0 && !sentences.slice(sentences.indexOf(last) + 1, sentences.indexOf(last) + 2).some(s => (s.start ?? 0) < end + .3)) reasons.push('FREE_END_UNANSWERED_QUESTION');
  const firstIndex = sentences.indexOf(first), lastIndex = sentences.indexOf(last);
  const earlier: Sentence | undefined = sentences[firstIndex - 1], later: Sentence | undefined = sentences[lastIndex + 1];
  // Ending on "Second, ..." while "Third, ..." follows cuts a list in half.
  const midList = LIST_OPENER.test(last.text) && !!later && LIST_OPENER.test(later.text);
  if (midList) reasons.push('FREE_END_MID_LIST');
  // A complete grammatical claim is not a complete debate when the immediate
  // next utterance explicitly disputes it. Include the first substantive reply;
  // a two-word "I disagree" marker alone must not become the repaired ending.
  const disputed = !!later && (later.start ?? Infinity) - (last.end ?? 0) <= 3 &&
    /^(?:i disagree\b|i (?:do not|don't) agree\b|that(?:'s| is) (?:wrong|false|not true)\b)/iu.test(later.text);
  const response = disputed ? sentences.slice(lastIndex + 1, lastIndex + 4).find(s => s.complete && s.kind !== 'QUESTION' && s.words.length >= 4) : undefined;
  if (disputed) reasons.push('FREE_END_BEFORE_DISAGREEMENT_RESPONSE');
  return { startStandalone: first.standalone && !startsMidSentence, endComplete: last.complete && !endsMidSentence && last.kind !== 'QUESTION' && !midList && !disputed,
    startsMidSentence, endsMidSentence, first: first.text, last: last.text, reasons,
    earlierStart: earlier?.start, laterEnd: response?.end ?? later?.end };
}

/** One bounded step out toward a finished thought; null when nothing can be improved within the budget. */
export function nextBoundaryStep(qa: SentenceBoundaryQa, start: number, end: number, budget: { originalStart: number; originalEnd: number; preRoll: number; extension: number; sourceEnd: number; maxDuration: number }):
  { start: number; end: number; moved: 'START' | 'END' } | null {
  if (!qa.startStandalone && qa.earlierStart !== undefined && qa.earlierStart >= budget.originalStart - budget.preRoll && qa.earlierStart < start && end - qa.earlierStart <= budget.maxDuration)
    return { start: Math.max(0, qa.earlierStart - .08), end, moved: 'START' };
  if (qa.startsMidSentence && qa.earlierStart !== undefined && qa.earlierStart < start) { /* handled by the repair's own sentence start */ }
  if (!qa.endComplete && qa.laterEnd !== undefined && qa.laterEnd <= budget.originalEnd + budget.extension && qa.laterEnd > end && qa.laterEnd <= budget.sourceEnd && qa.laterEnd - start <= budget.maxDuration)
    return { start, end: qa.laterEnd, moved: 'END' };
  return null;
}
