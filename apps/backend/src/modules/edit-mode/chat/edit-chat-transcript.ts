// Deterministic transcript grounding for chat requests.
//
// "Cut the part where I talk about pricing" is resolved HERE, not by the model.
// The cached transcript is searched with ordinary lexical scoring, the best few
// spans are handed to the planner as candidates, and the planner may only pick
// one of them. That keeps three promises at once: the model never invents a
// timestamp, the search is reproducible run to run, and a request whose subject
// simply is not in the transcript comes back as "not found" rather than as a
// confident cut in the wrong place.
//
// Nothing here calls the AI service or re-transcribes: it reads only the words
// the Phase 1 "Analyze source" step already cached on the EditAsset.

import type { TimedWord } from '../../editing/edit-plan';

export type TranscriptSpan = {
  startSec: number;
  endSec: number;
  text: string;
  /** 0..1 lexical match strength against the user's phrase. */
  confidence: number;
  /** The query terms that actually matched, for the proposal's evidence line. */
  matchedTerms: string[];
};

/** Words that carry no topical meaning, plus the editing verbs a request is
 * phrased with. Removing both leaves the subject the user is pointing at. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'its', 'they', 'them', 'their',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
  'might', 'must', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'about', 'as',
  'into', 'over', 'after', 'before', 'between', 'out', 'up', 'down', 'off', 'again', 'here',
  'there', 'when', 'where', 'while', 'who', 'whom', 'which', 'what', 'how', 'why', 'all',
  'any', 'both', 'each', 'few', 'more', 'most', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'too', 'very', 'just', 'also', 'get', 'got', 'make', 'makes', 'made'
]);

/** Editing vocabulary: present in almost every request, topical in none. */
const COMMAND_WORDS = new Set([
  'cut', 'trim', 'remove', 'delete', 'drop', 'split', 'keep', 'clip', 'edit', 'section',
  'segment', 'portion', 'piece', 'bit', 'talk', 'talks', 'talking', 'talked', 'say', 'says',
  'said', 'saying', 'mention', 'mentions', 'mentioned', 'mentioning', 'discuss', 'discusses',
  'discussed', 'discussing', 'explain', 'explains', 'explained', 'explaining', 'part', 'parts',
  'video', 'clip', 'show', 'shows', 'showing', 'add', 'put', 'place', 'move', 'lower', 'raise',
  'zoom', 'logo', 'text', 'music', 'audio', 'subtitle', 'subtitles', 'caption', 'captions',
  'seconds', 'second', 'sec', 'secs', 'minute', 'minutes', 'start', 'end', 'beginning'
]);

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');

/**
 * A light stem so "pricing", "price" and "priced" all match each other.
 *
 * The trailing-e rule is what unifies them: dropping the inflection alone would
 * leave "pric" against "price" and the query would miss the very sentence it
 * was describing.
 */
const stem = (term: string) => {
  const stripped = term
    .replace(/(ization|isation)$/u, 'ize')
    .replace(/(ings|ing)$/u, '')
    .replace(/(edly|ed)$/u, '')
    .replace(/(ies)$/u, 'y')
    .replace(/(es)$/u, '')
    .replace(/s$/u, '');
  return stripped.length > 3 ? stripped.replace(/e$/u, '') : stripped;
};

/**
 * The topical terms of a request.
 *
 * Both stop words and editing verbs are stripped, so "remove the part where I
 * talk about pricing" reduces to "pricing" - which is the only part of the
 * sentence the transcript can possibly confirm.
 */
export function topicTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of normalize(query).split(/\s+/u)) {
    if (raw.length < 3) continue;
    if (STOP_WORDS.has(raw) || COMMAND_WORDS.has(raw)) continue;
    const key = stem(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(key);
  }
  return terms;
}

/** Groups words into sentence-ish units so a match lands on a whole thought. */
function segments(words: TimedWord[], maxSpanSec: number) {
  const result: { words: TimedWord[]; start: number; end: number }[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (!current.length) return;
    result.push({ words: current, start: current[0].start, end: current[current.length - 1].end });
    current = [];
  };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    current.push(word);
    const next = words[index + 1];
    const sentenceEnd = /[.!?]["')\]]?$/u.test(word.text.trim());
    const pause = next ? next.start - word.end : 0;
    const span = word.end - current[0].start;
    if (sentenceEnd || pause >= 0.55 || span >= maxSpanSec) flush();
  }
  flush();
  return result;
}

export type TranscriptSearchOptions = {
  /** Longest single candidate span. Windows grow up to this before stopping. */
  maxSpanSec?: number;
  /** How many candidates to return. */
  limit?: number;
};

/**
 * Finds the transcript spans a phrase most plausibly refers to.
 *
 * Scoring is inverse-document-frequency weighted term overlap over contiguous
 * sentence windows: a rare term matching is strong evidence, a common one is
 * weak, and a window matching several distinct query terms beats one matching
 * the same term repeatedly. Confidence is the share of the query's total term
 * weight the window actually accounts for, so a request naming two topics only
 * scores high on a window that covers both.
 */
export function searchTranscript(words: TimedWord[], query: string,
  options: TranscriptSearchOptions = {}): TranscriptSpan[] {
  const maxSpanSec = options.maxSpanSec ?? 25;
  const limit = options.limit ?? 4;
  const terms = topicTerms(query);
  if (!terms.length || !words.length) return [];

  const units = segments(words, 12);
  if (!units.length) return [];
  const unitTerms = units.map((unit) => new Set(unit.words
    .flatMap((word) => normalize(word.text).split(/\s+/u))
    .filter((term) => term.length >= 3)
    .map(stem)));

  // Inverse document frequency over the transcript's own sentences, so a term
  // the speaker uses constantly cannot dominate the match.
  const weights = new Map<string, number>();
  for (const term of terms) {
    const hits = unitTerms.reduce((total, set) => total + (set.has(term) ? 1 : 0), 0);
    weights.set(term, Math.log(1 + units.length / (1 + hits)));
  }
  const totalWeight = terms.reduce((total, term) => total + (weights.get(term) ?? 0), 0);
  if (totalWeight <= 0) return [];

  const spans: TranscriptSpan[] = [];
  for (let start = 0; start < units.length; start += 1) {
    const matched = new Set<string>();
    for (let end = start; end < units.length; end += 1) {
      if (units[end].end - units[start].start > maxSpanSec) break;
      for (const term of terms) if (unitTerms[end].has(term)) matched.add(term);
      if (!matched.size) continue;
      const weight = [...matched].reduce((total, term) => total + (weights.get(term) ?? 0), 0);
      // Longer windows must earn their length: a span twice as long as needed
      // is penalised so the tightest window covering the topic wins.
      const spanSec = units[end].end - units[start].start;
      const density = Math.min(1, 8 / Math.max(4, spanSec));
      spans.push({
        startSec: Number(units[start].start.toFixed(3)),
        endSec: Number(units[end].end.toFixed(3)),
        text: units.slice(start, end + 1).flatMap((unit) => unit.words.map((word) => word.text))
          .join(' ').replace(/\s+/gu, ' ').trim().slice(0, 400),
        confidence: Number(Math.min(1, (weight / totalWeight) * (0.7 + 0.3 * density)).toFixed(4)),
        matchedTerms: [...matched]
      });
    }
  }
  if (!spans.length) return [];

  // Keep the best non-overlapping candidates, strongest first.
  spans.sort((left, right) => right.confidence - left.confidence ||
    (left.endSec - left.startSec) - (right.endSec - right.startSec));
  const chosen: TranscriptSpan[] = [];
  for (const span of spans) {
    if (chosen.length >= limit) break;
    const overlaps = chosen.some((other) =>
      span.startSec < other.endSec - 1e-6 && other.startSec < span.endSec - 1e-6);
    if (!overlaps) chosen.push(span);
  }
  return chosen;
}

/**
 * The single span a request resolves to, or null.
 *
 * A span is only returned when it is both strong enough on its own and clearly
 * better than the runner-up. Two equally plausible matches mean the request was
 * ambiguous, and an ambiguous cut is exactly the thing that must become a
 * question instead of an edit.
 */
export function resolveTranscriptSpan(words: TimedWord[], query: string,
  options: TranscriptSearchOptions & { minConfidence?: number } = {}) {
  const minConfidence = options.minConfidence ?? 0.45;
  const candidates = searchTranscript(words, query, options);
  const best = candidates[0];
  if (!best) return { span: null, candidates, reason: 'NO_MATCH' as const };
  if (best.confidence < minConfidence) {
    return { span: null, candidates, reason: 'LOW_CONFIDENCE' as const };
  }
  const runnerUp = candidates[1];
  if (runnerUp && runnerUp.confidence > best.confidence * 0.85) {
    return { span: null, candidates, reason: 'AMBIGUOUS' as const };
  }
  return { span: best, candidates, reason: 'RESOLVED' as const };
}
