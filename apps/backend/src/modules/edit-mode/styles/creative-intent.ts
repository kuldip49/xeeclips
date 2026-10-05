// Step 11: the creative brief changes WHICH moments are selected.
//
//   final score = quality (the existing candidate score, unchanged)
//               + intent  (how well THIS candidate matches what the user asked for)
//
// With a content brief, intent carries most of the weight, so "funny moments"
// and "educational moments" produce materially different selections from the
// same source. "only X" is strict: non-matching candidates are excluded rather
// than merely demoted (and the shortfall is reported honestly upstream).
// Duplicate prevention and usability rules stay where they were - this only
// re-orders (and, when strict, filters) an already de-duplicated usable pool.

import type { ContentIntent, ContentMode } from './creative-brief';

export type IntentCandidate = {
  id: string; transcriptText: string; topic?: string | null; reason?: string | null;
  title?: string | null; bestHook?: string | null; synopsis?: string | null;
  contentType?: string | null; duration: number;
  contentPotential?: number | null; overallScore?: number | null;
  informationScore?: number | null; emotionScore?: number | null; controversyScore?: number | null;
  standaloneScore?: number | null; endingStrength?: number | null;
};

export type IntentScore = { candidateId: string; qualityScore: number; intentScore: number;
  finalScore: number; matchedTopics: string[]; matchedModes: ContentMode[]; excluded: boolean;
  reason: string };

const MODE_EVIDENCE: Record<ContentMode, RegExp> = {
  FUNNY: /\b(?:haha+|lol|laugh(?:s|ing|ed)?|joke|joking|funny|hilarious|kidding|ridiculous|crazy|\(laughs?\)|\[laughter\])\b/giu,
  EDUCATIONAL: /\b(?:because|the reason|here'?s how|how to|step|means|for example|in other words|basically|explain|the key is|you need to understand|works by)\b/giu,
  CONTROVERSIAL: /\b(?:wrong|nobody|everyone thinks|disagree|actually|myth|the truth is|unpopular|controversial|overrated|scam|lie|lying|problem is)\b/giu,
  EMOTIONAL: /\b(?:felt|feel|cried|tears|hurt|lost|love|scared|afraid|heart|broke)\b/giu,
  INSPIRING: /\b(?:never give up|you can|believe|dream|possible|change your life|keep going|proud)\b/giu,
  STORY: /\b(?:when i was|one day|i remember|back then|years ago|so i|story)\b/giu,
  ADVICE: /\b(?:you should|my advice|tip|make sure|don'?t|always|never|the best way)\b/giu,
  SURPRISING: /\b(?:surprising|shocked|never expected|turns out|believe it or not|crazy thing)\b/giu,
  DRAMATIC: /\b(?:fight|argue|furious|intense|crisis|disaster)\b/giu
};

const stem = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/gu, '')
  .replace(/(?:ing|ed|es|s)$/u, '');
// Two-letter words count (topics like "AI", "UK", "VR"); common two-letter function words do not.
const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/u).filter((word) =>
  word.length >= 2 && !STOP.has(word)).map((word) => (word.length > 3 ? stem(word) : word));
const STOP = new Set(['the', 'and', 'for', 'about', 'with', 'that', 'this', 'from', 'only', 'just',
  'part', 'parts', 'moment', 'moments', 'clip', 'clips', 'discussion', 'talk', 'talking',
  'is', 'it', 'to', 'of', 'in', 'on', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'me', 'my',
  'no', 'so', 'up', 'us', 'we', 'or', 'if', 'am', 'oh', 'ok']);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function topicMatch(topic: string, haystack: string, haystackTokens: Set<string>) {
  // Whole words only: "ai" must not match "said" or "again".
  if (new RegExp(`\\b${escapeRegex(topic)}\\b`, 'u').test(haystack)) return 1;
  const wanted = tokens(topic);
  if (!wanted.length) return 0;
  const hits = wanted.filter((token) => haystackTokens.has(token)).length;
  return hits / wanted.length;
}

function modeEvidence(mode: ContentMode, candidate: IntentCandidate, text: string) {
  const hits = (text.match(MODE_EVIDENCE[mode]) ?? []).length;
  const lexical = Math.min(1, hits / 3);
  // The pipeline already measured some of these; use them when present.
  const measured = mode === 'EDUCATIONAL' ? candidate.informationScore
    : mode === 'CONTROVERSIAL' ? candidate.controversyScore
      : mode === 'EMOTIONAL' || mode === 'INSPIRING' ? candidate.emotionScore : null;
  const typeMatch = candidate.contentType && new RegExp(mode.toLowerCase().slice(0, 5), 'u')
    .test(candidate.contentType.toLowerCase()) ? 0.3 : 0;
  const scored = typeof measured === 'number' && measured > 0 ? Math.min(1, measured / 100) : null;
  return Math.min(1, (scored === null ? lexical : 0.5 * lexical + 0.5 * scored) + typeMatch);
}

export function hasContentIntent(intent: ContentIntent | null | undefined) {
  return !!intent && (intent.modes.length > 0 || intent.topics.length > 0 ||
    intent.exclude.length > 0 || intent.keepFullContext);
}

/** Scores and re-orders an ALREADY de-duplicated, usable, quality-ordered pool. */
export function rankByIntent<T extends IntentCandidate>(ordered: T[], intent: ContentIntent,
  semantic?: Map<string, number>): { ordered: T[]; scores: IntentScore[]; excludedCount: number } {
  if (!hasContentIntent(intent)) {
    return { ordered, excludedCount: 0, scores: ordered.map((candidate) => {
      const quality = candidate.contentPotential ?? candidate.overallScore ?? 50;
      return { candidateId: candidate.id, qualityScore: quality, intentScore: 0, finalScore: quality,
        matchedTopics: [], matchedModes: [], excluded: false, reason: 'no content intent' };
    }) };
  }
  const scores = ordered.map((candidate, rank) => {
    const text = [candidate.transcriptText, candidate.topic, candidate.reason, candidate.title,
      candidate.bestHook, candidate.synopsis].filter(Boolean).join(' ').toLowerCase();
    const tokenSet = new Set(tokens(text));
    const topicScores = intent.topics.map((topic) => ({ topic, score: topicMatch(topic, text, tokenSet) }));
    const matchedTopics = topicScores.filter((item) => item.score >= 0.5).map((item) => item.topic);
    const topicScore = topicScores.length ? Math.max(...topicScores.map((item) => item.score)) : null;
    const modeScores = intent.modes.map((mode) => ({ mode, score: modeEvidence(mode, candidate, text) }));
    const matchedModes = modeScores.filter((item) => item.score >= 0.34).map((item) => item.mode);
    const modeScore = modeScores.length ? Math.max(...modeScores.map((item) => item.score)) : null;
    const excludedHit = intent.exclude.some((term) => topicMatch(term, text, tokenSet) >= 0.75);
    const contextScore = intent.keepFullContext
      ? Math.min(1, ((candidate.standaloneScore ?? 50) / 100) * 0.6 +
        ((candidate.endingStrength ?? 50) / 100) * 0.2 + Math.min(1, candidate.duration / 60) * 0.2)
      : null;
    const parts = [topicScore, modeScore, contextScore].filter((value): value is number => value !== null);
    let intentScore = parts.length ? parts.reduce((total, value) => total + value, 0) / parts.length : 0;
    const ai = semantic?.get(candidate.id);
    if (typeof ai === 'number') intentScore = 0.5 * intentScore + 0.5 * Math.min(1, Math.max(0, ai / 100));
    if (excludedHit) intentScore *= 0.2;
    const quality = candidate.contentPotential ?? candidate.overallScore ?? Math.max(0, 80 - rank);
    // Intent dominates when the user said what they want; quality still breaks ties.
    const finalScore = Number((0.35 * quality + 65 * intentScore).toFixed(3));
    const excluded = excludedHit || (intent.strict && topicScore !== null && topicScore < 0.5 &&
      (typeof ai !== 'number' || ai < 50));
    return { candidate, score: { candidateId: candidate.id, qualityScore: quality,
      intentScore: Number((intentScore * 100).toFixed(1)), finalScore, matchedTopics, matchedModes,
      excluded, reason: excluded ? (excludedHit ? 'matches an excluded subject' : 'off-topic for an "only" brief')
        : [matchedTopics.length ? `topics: ${matchedTopics.join(', ')}` : '',
          matchedModes.length ? `modes: ${matchedModes.join(', ').toLowerCase()}` : '']
          .filter(Boolean).join('; ') || 'weak match' } };
  });
  // "only funny moments": drop moments with no evidence of the requested kind - but mode
  // evidence is fuzzy, so when nothing shows it the restriction degrades to ranking rather
  // than delivering zero clips.
  if (intent.strictModes && !intent.topics.length && intent.modes.length) {
    const offKind = scores.filter((item) => !item.score.excluded && !item.score.matchedModes.length);
    const onKind = scores.filter((item) => !item.score.excluded && item.score.matchedModes.length);
    if (onKind.length) {
      for (const item of offKind) {
        item.score.excluded = true;
        item.score.reason = 'not the kind of moment an "only" brief asked for';
      }
    }
  }
  const kept = scores.filter((item) => !item.score.excluded)
    .sort((a, b) => b.score.finalScore - a.score.finalScore);
  return { ordered: kept.map((item) => item.candidate), scores: scores.map((item) => item.score),
    excludedCount: scores.length - kept.length };
}

/** Whether a raw transcript window is worth adding for a strict/topic brief. */
export function matchesIntent(text: string, intent: ContentIntent) {
  if (!intent.topics.length) return true;
  const lower = text.toLowerCase();
  const tokenSet = new Set(tokens(lower));
  return intent.topics.some((topic) => topicMatch(topic, lower, tokenSet) >= 0.5);
}
