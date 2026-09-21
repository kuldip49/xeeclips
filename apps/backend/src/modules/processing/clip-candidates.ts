import { semanticSimilarity } from './semantic-similarity.service';
import { FINAL_CLIP_MAX_SECONDS, FINAL_CLIP_MIN_SECONDS, maxClipCountForDuration }
  from './clip-selection-policy';

export const MIN_CLIP_DURATION_SECONDS = FINAL_CLIP_MIN_SECONDS;
export const MAX_CLIP_DURATION_SECONDS = FINAL_CLIP_MAX_SECONDS;
export const MAX_CANDIDATES = 100;
export const MIN_CANDIDATE_TARGET = 40;
export const PRIMARY_CLIP_SCORE = 75;
export const SECONDARY_CLIP_SCORE = 60;

export type RecommendationTier = 'PRIMARY' | 'SECONDARY';

export type ClipContentHook = {
  text: string;
  style: string;
  score: number;
};

type AnalysisMetrics = {
  questionCount: number;
  exclamationCount: number;
  keywordDensity: number;
  averageSentenceLength: number;
  speechRate: number;
  informationDensity: number;
  readabilityScore: number;
};

export type ChunkForClipCandidate = {
  position: number;
  startTime: number;
  endTime: number;
  duration: number;
  text: string;
  wordCount: number;
  analysis: AnalysisMetrics | null;
};

export type CandidateUnderstandingContext = {
  mainTopic: string;
  topics: string[];
  summary?: string;
  keyClaims?: string[];
  questions?: string[];
  chapters: Array<{
    startTime: number;
    endTime: number;
    title: string;
    summary: string;
    topics: string[];
    importanceScore: number;
  }>;
};

export type ClipScores = {
  hookScore: number;
  sourceHookScore: number;
  standaloneScore: number;
  payoffScore: number;
  flowScore: number;
  informationScore: number;
  retentionScore: number;
  shareabilityScore: number;
  contentPotential: number;
  overallScore: number;
  reject: boolean;
  topic: string;
  reason: string;
  rejectionReason: string;
};

export type ScoredClipCandidate = ClipScores & {
  videoId: string;
  rangeKey: string;
  startTime: number;
  endTime: number;
  duration: number;
  transcriptText: string;
  heuristicScore: number;
  judgeSource: 'GPT_5_4_MINI' | 'LLM' | 'HEURISTIC_FALLBACK';
  rank: number | null;
  chapterSummary?: string;
  neighboringTranscriptContext?: string;
  overallVideoTopic?: string;
  wholeVideoContext?: string;
  relevantTopics?: string[];
  previousTranscriptContext?: string;
  nextTranscriptContext?: string;
  bestHook?: string;
  alternateHooks?: string[];
  generatedHookScore?: number;
  selectedHookStrategy?: string;
  title?: string;
  synopsis?: string;
  caption?: string;
  hashtags?: string[];
  cta?: string;
  contentType?: string;
  whySelected?: string;
  provider?: string;
  model?: string;
  promptVersion?: string;
  generationStatus?: 'GENERATED' | 'FALLBACK';
  fallbackReason?: string;
  contentFingerprint?: string;
  hooks?: ClipContentHook[];
  hookOptions?: Array<{
    hook: string;
    strategy: string;
    components: {
      relevance: number;
      clarity: number;
      curiosity: number;
      payoffAlignment: number;
      specificity: number;
    };
    score: number;
  }>;
  evidence?: Record<string, unknown>;
  clipUnderstanding?: Record<string, unknown>;
  criticResult?: Record<string, unknown>;
  providerMetadata?: Array<Record<string, unknown>>;
  creativeCandidates?: Record<string, unknown>;
  generationQuality?: number;
  confidence?: number;
  generationMode?: ProcessingMode;
  fallbackUsed?: boolean;
  failureCategory?: string;
  localValidationIssues?: Array<'hooks' | 'caption' | 'title' | 'hashtags' | 'synopsis'>;
  decisionSource?: 'LUNA' | 'OLLAMA' | 'DETERMINISTIC_HIGH_CONFIDENCE' | 'DETERMINISTIC_FALLBACK';
  openingStrength?: number;
  endingStrength?: number;
  leadingTrimmedMs?: number;
  trailingWasteMs?: number;
};

export type ProcessingMode = 'CLOUD_AI' | 'PARTIAL_CLOUD_AI' | 'LOCAL_AI' |
  'DETERMINISTIC_FALLBACK';

export function processingModeFor(
  metadata: Array<Record<string, unknown>>,
  generated: boolean
): ProcessingMode {
  if (!generated) return 'DETERMINISTIC_FALLBACK';
  let cloud = false, local = false;
  for (const item of metadata) {
    const provider = String(item.provider || '').toLowerCase();
    if (provider === 'ollama' || provider === 'local') local = true;
    else if (provider && provider !== 'deterministic') cloud = true;
  }
  return local && cloud ? 'PARTIAL_CLOUD_AI' : local ? 'LOCAL_AI' : 'CLOUD_AI';
}

export function maximumClipCountForDuration(durationSeconds: number | null | undefined) {
  return maxClipCountForDuration(durationSeconds);
}

export function recommendationTierForScore(
  contentPotential: number
): RecommendationTier | null {
  if (contentPotential >= PRIMARY_CLIP_SCORE) return 'PRIMARY';
  if (contentPotential >= SECONDARY_CLIP_SCORE) return 'SECONDARY';
  return null;
}

// contentPotential is fixed by deterministic/heuristic scoring (and, in FALLBACK_ONLY mode,
// applyDeterministicEvidence) before creative generation and the critic ever run — neither
// stage changes hookScore/standaloneScore/etc. — so this check made before CONTENT_GENERATION
// matches exactly what calculateClipRecommendation will see afterward. A candidate that is
// already outside the PRIMARY/SECONDARY range here cannot become recommended later, so paying
// for a creativeGeneration call for it is never worthwhile.
export function isEligibleForCreativeGeneration(candidate: Pick<ClipScores,
  'reject' | 'contentPotential'>): boolean {
  return !candidate.reject && recommendationTierForScore(candidate.contentPotential) !== null;
}

export function calculateClipRecommendation<T extends {
  contentPotential: number;
  reject: boolean;
}>(candidates: T[], durationSeconds: number | null | undefined) {
  const maximumClipCount = maximumClipCountForDuration(durationSeconds);
  const acceptable = candidates.filter((candidate) =>
    !candidate.reject && recommendationTierForScore(candidate.contentPotential) !== null);
  const primaryCount = acceptable.filter((candidate) =>
    recommendationTierForScore(candidate.contentPotential) === 'PRIMARY').length;
  return {
    recommendedClipCount: Math.min(primaryCount, maximumClipCount),
    maximumClipCount,
    primaryCount,
    secondaryCount: acceptable.length - primaryCount,
    candidatesDiscovered: acceptable.length
  };
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'because', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'him', 'his', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me',
  'my', 'of', 'on', 'or', 'our', 'she', 'so', 'than', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'us',
  'was', 'we', 'were', 'which', 'who', 'will', 'with', 'would', 'you', 'your'
]);
const FILLER_WORDS = new Set([
  'actually', 'basically', 'erm', 'hmm', 'like', 'literally', 'okay', 'right',
  'so', 'uh', 'um', 'well', 'yeah', 'yep', 'youknow'
]);
const PAYOFF_WORDS = new Set([
  'answer', 'because', 'conclusion', 'finally', 'lesson', 'result', 'revealed',
  'therefore', 'thisiswhy', 'ultimately', 'worked'
]);
const TRANSITION_WORDS = new Set([
  'because', 'but', 'first', 'however', 'instead', 'next', 'second', 'so',
  'then', 'therefore', 'ultimately', 'yet'
]);

export const clampScore = (value: number) => Math.min(100, Math.max(0,
  Number.isFinite(value) ? value : 0));
export const roundScore = (value: number) => Math.round(clampScore(value) * 100) / 100;
export function calculateContentPotential(scores: Pick<ClipScores,
  'hookScore' | 'standaloneScore' | 'payoffScore' | 'flowScore' |
  'informationScore' | 'retentionScore' | 'shareabilityScore'>) {
  return roundScore(
    clampScore(scores.hookScore) * 0.18 +
    clampScore(scores.standaloneScore) * 0.16 +
    clampScore(scores.payoffScore) * 0.16 +
    clampScore(scores.flowScore) * 0.12 +
    clampScore(scores.informationScore) * 0.12 +
    clampScore(scores.retentionScore) * 0.16 +
    clampScore(scores.shareabilityScore) * 0.10
  );
}
const clamp = clampScore;
const round = roundScore;
const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ');
const words = (text: string) =>
  text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+(?:['\u2019][\p{L}\p{N}]+)*/gu) ?? [];
const sentences = (text: string) =>
  normalize(text).match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.map(normalize) ?? [];

function weightedMetric(chunks: ChunkForClipCandidate[], field: keyof AnalysisMetrics) {
  let weight = 0;
  let total = 0;
  for (const chunk of chunks) {
    if (!chunk.analysis) continue;
    const chunkWeight = Math.max(chunk.duration, 0.1);
    weight += chunkWeight;
    total += chunk.analysis[field] * chunkWeight;
  }
  return weight ? total / weight : 0;
}

function rangeKey(startTime: number, endTime: number) {
  return `${startTime.toFixed(3)}:${endTime.toFixed(3)}`;
}

function topicFrom(text: string) {
  const options = sentences(text);
  const best = options.reduce((current, sentence) => {
    const value = words(sentence).filter((word) => !STOP_WORDS.has(word)).length +
      Number(/[?!]/u.test(sentence)) * 3;
    return value > current.value ? { sentence, value } : current;
  }, { sentence: options[0] ?? text, value: -1 }).sentence.replace(/[.!?]+$/u, '');
  const clean = normalize(best);
  return clean.length <= 80 ? clean : `${clean.slice(0, 77).trim()}...`;
}

function durationFitness(duration: number) {
  if (duration < MIN_CLIP_DURATION_SECONDS || duration > MAX_CLIP_DURATION_SECONDS) return 0;
  return clamp(100 - Math.abs(duration - 35) * 1.7);
}

function evaluateHeuristically(chunks: ChunkForClipCandidate[], text: string, duration: number): ClipScores {
  const tokens = words(text);
  const sentenceList = sentences(text);
  const firstSentence = sentenceList[0] ?? text;
  const questionCount = chunks.reduce((sum, chunk) => sum + (chunk.analysis?.questionCount ?? 0), 0);
  const exclamationCount = chunks.reduce((sum, chunk) => sum + (chunk.analysis?.exclamationCount ?? 0), 0);
  const informationDensity = weightedMetric(chunks, 'informationDensity');
  const readability = weightedMetric(chunks, 'readabilityScore');
  const speechRate = weightedMetric(chunks, 'speechRate');
  const keywordDensity = weightedMetric(chunks, 'keywordDensity');
  const fillerRatio = tokens.length
    ? tokens.filter((word) => FILLER_WORDS.has(word.replace(/\s/gu, ''))).length / tokens.length
    : 1;
  const startsWithFragment = /^(and|but|because|he|it|she|so|that|then|they|this|which)\b/iu.test(text);
  const strongOpening = /^(did you|here is|here's|how|imagine|the (?:biggest|real|secret)|what|why|you (?:can|need|will|won't))/iu.test(firstSentence);
  const endsNaturally = /[.!?]["']?$/u.test(text);
  const payoffSignals = tokens.filter((word) => PAYOFF_WORDS.has(word.replace(/\s/gu, ''))).length;
  const transitionSignals = tokens.filter((word) => TRANSITION_WORDS.has(word)).length;
  const speechRateFitness = clamp(100 - Math.abs(speechRate - 145) * 0.85);

  const hookScore = clamp(18 + Number(strongOpening) * 28 + Math.min(questionCount, 2) * 14 +
    Math.min(exclamationCount, 2) * 7 + Math.min(keywordDensity, 30) * 0.45);
  const standaloneScore = clamp(durationFitness(duration) * 0.45 + Number(!startsWithFragment) * 18 +
    Number(endsNaturally) * 17 + Math.min(tokens.length / 55, 1) * 20 - fillerRatio * 35);
  const payoffScore = clamp(18 + Math.min(payoffSignals, 4) * 14 + Number(endsNaturally) * 20 +
    Number(sentenceList.length >= 2) * 10 + Number(/\b(?:but|because|therefore|so)\b/iu.test(text)) * 10);
  const flowScore = clamp(25 + Math.min(sentenceList.length, 6) * 7 + Math.min(transitionSignals, 5) * 7 +
    speechRateFitness * 0.15 - Number(startsWithFragment) * 18);
  const informationScore = clamp(informationDensity * 0.65 + readability * 0.18 + speechRateFitness * 0.17);
  const retentionScore = clamp(hookScore * 0.35 + flowScore * 0.25 + payoffScore * 0.2 +
    durationFitness(duration) * 0.2 - fillerRatio * 20);
  const shareabilityScore = clamp(hookScore * 0.25 + informationScore * 0.35 + payoffScore * 0.25 +
    standaloneScore * 0.15);
  const overallScore = calculateContentPotential({ hookScore, standaloneScore, payoffScore,
    flowScore, informationScore, retentionScore, shareabilityScore });
  const incomplete = tokens.length < 20 || (startsWithFragment && !endsNaturally);
  const fillerHeavy = fillerRatio > 0.22;
  const reject = incomplete || fillerHeavy || overallScore < 42;
  const rejectionReason = incomplete
    ? 'Incomplete or context-dependent excerpt.'
    : fillerHeavy ? 'Filler-heavy excerpt.'
      : overallScore < 42 ? 'Insufficient engagement and standalone value.' : '';

  return {
    hookScore: round(hookScore), sourceHookScore: round(hookScore),
    standaloneScore: round(standaloneScore),
    payoffScore: round(payoffScore), flowScore: round(flowScore),
    informationScore: round(informationScore), retentionScore: round(retentionScore),
    shareabilityScore: round(shareabilityScore), contentPotential: round(overallScore),
    overallScore: round(overallScore),
    reject, topic: topicFrom(text),
    reason: `Heuristics found ${round(informationScore)} information, ${round(hookScore)} hook, and ${round(payoffScore)} payoff potential.`,
    rejectionReason
  };
}

function buildCandidate(videoId: string, chunks: ChunkForClipCandidate[]): ScoredClipCandidate {
  const transcriptText = normalize(chunks.map((chunk) => chunk.text).join(' '));
  const startTime = chunks[0].startTime;
  const endTime = chunks[chunks.length - 1].endTime;
  const duration = round(endTime - startTime);
  const scores = evaluateHeuristically(chunks, transcriptText, duration);
  return {
    videoId, rangeKey: rangeKey(startTime, endTime), startTime, endTime, duration,
    transcriptText, heuristicScore: scores.overallScore, ...scores,
    judgeSource: 'HEURISTIC_FALLBACK', rank: null
  };
}

function addUnderstandingContext(
  candidate: ScoredClipCandidate,
  context: CandidateUnderstandingContext | null,
  chunks: ChunkForClipCandidate[],
  startIndex: number,
  endIndex: number
) {
  const previousTranscriptContext = normalize(chunks[startIndex - 1]?.text ?? '').slice(0, 1000);
  const nextTranscriptContext = normalize(chunks[endIndex + 1]?.text ?? '').slice(0, 1000);
  const neighboringTranscriptContext = normalize([
    previousTranscriptContext,
    nextTranscriptContext
  ].filter(Boolean).join(' ')).slice(0, 2000);
  if (!context) {
    return { ...candidate, neighboringTranscriptContext, previousTranscriptContext,
      nextTranscriptContext };
  }
  const chapter = context.chapters.map((item) => ({
    item,
    overlap: Math.max(0, Math.min(candidate.endTime, item.endTime) -
      Math.max(candidate.startTime, item.startTime))
  })).sort((left, right) => right.overlap - left.overlap)[0]?.item;
  return {
    ...candidate,
    chapterSummary: chapter?.summary ?? '',
    neighboringTranscriptContext,
    previousTranscriptContext,
    nextTranscriptContext,
    overallVideoTopic: context.mainTopic,
    wholeVideoContext: normalize([
      context.summary ?? '',
      ...(context.keyClaims ?? []),
      ...(context.questions ?? [])
    ].filter(Boolean).join(' ')).slice(0, 2000),
    relevantTopics: [...new Set([...(chapter?.topics ?? []), ...context.topics])].slice(0, 20)
  };
}

export function generateCandidateRanges(
  videoId: string,
  input: ChunkForClipCandidate[],
  contextOrMaxCandidates: CandidateUnderstandingContext | number | null = null,
  configuredMaxCandidates = MAX_CANDIDATES
): ScoredClipCandidate[] {
  const context = typeof contextOrMaxCandidates === 'number' ? null : contextOrMaxCandidates;
  const maxCandidates = typeof contextOrMaxCandidates === 'number'
    ? contextOrMaxCandidates
    : configuredMaxCandidates;
  const chunks = [...input].filter((chunk) => chunk.analysis && normalize(chunk.text) &&
    Number.isFinite(chunk.startTime) && Number.isFinite(chunk.endTime) &&
    chunk.endTime >= chunk.startTime)
    .sort((a, b) => a.position - b.position || a.startTime - b.startTime);
  const byRange = new Map<string, ScoredClipCandidate>();

  for (let start = 0; start < chunks.length; start += 1) {
    const window: ChunkForClipCandidate[] = [];
    for (let end = start; end < chunks.length; end += 1) {
      const chunk = chunks[end];
      if (window.length && chunk.startTime - window[window.length - 1].endTime > 3) break;
      const duration = chunk.endTime - chunks[start].startTime;
      if (duration > MAX_CLIP_DURATION_SECONDS) break;
      window.push(chunk);
      if (duration >= MIN_CLIP_DURATION_SECONDS) {
        const candidate = addUnderstandingContext(
          buildCandidate(videoId, window),
          context,
          chunks,
          start,
          end
        );
        byRange.set(candidate.rangeKey, candidate);
      }
    }
  }

  const scored = [...byRange.values()].sort((a, b) =>
    b.heuristicScore - a.heuristicScore || a.startTime - b.startTime || a.endTime - b.endTime);
  const passing = scored.filter((candidate) => !candidate.reject);
  const shortlist = passing.slice(0, maxCandidates);
  if (shortlist.length < Math.min(MIN_CANDIDATE_TARGET, scored.length, maxCandidates)) {
    const selected = new Set(shortlist.map((candidate) => candidate.rangeKey));
    for (const candidate of scored) {
      if (!selected.has(candidate.rangeKey)) shortlist.push(candidate);
      if (shortlist.length >= Math.min(MIN_CANDIDATE_TARGET, scored.length, maxCandidates)) break;
    }
  }
  return shortlist.sort((a, b) => b.heuristicScore - a.heuristicScore || a.startTime - b.startTime);
}

function overlapRatio(a: { startTime: number; endTime: number }, b: { startTime: number; endTime: number }) {
  const intersection = Math.max(0, Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime));
  return intersection / Math.max(0.001, Math.min(a.endTime - a.startTime, b.endTime - b.startTime));
}

function textSimilarity(a: string, b: string) {
  return semanticSimilarity.similarity(a, b);
}

export function suppressOverlapAndRank(candidates: ScoredClipCandidate[]) {
  const ordered = [...candidates].sort((a, b) => b.overallScore - a.overallScore ||
    b.heuristicScore - a.heuristicScore || a.startTime - b.startTime);
  const accepted: ScoredClipCandidate[] = [];
  const rejected: ScoredClipCandidate[] = [];
  for (const candidate of ordered) {
    if (candidate.reject) {
      rejected.push({ ...candidate, rank: null });
      continue;
    }
    const duplicate = accepted.find((other) => overlapRatio(candidate, other) > 0.58 ||
      textSimilarity(candidate.transcriptText, other.transcriptText) > 0.82);
    if (duplicate) {
      rejected.push({ ...candidate, reject: true, rank: null,
        rejectionReason: `Duplicate or overlapping range of ${duplicate.rangeKey}.` });
    } else {
      accepted.push(candidate);
    }
  }
  return [
    ...accepted.map((candidate, index) => ({ ...candidate, rank: index + 1 })),
    ...rejected
  ];
}

export function selectDiversifiedCandidates<T extends {
  startTime: number; endTime: number; transcriptText: string; topic: string;
  overallScore: number; reject: boolean;
}>(candidates: T[], count: number, minimumScore = 60): T[] {
  const eligible = [...candidates].filter((candidate) => !candidate.reject &&
    candidate.overallScore >= minimumScore)
    .sort((a, b) => b.overallScore - a.overallScore || a.startTime - b.startTime);
  const selected: T[] = [];
  const topics = new Set<string>();
  const canUse = (candidate: T) => !selected.some((other) => overlapRatio(candidate, other) > 0.4 ||
    textSimilarity(candidate.transcriptText, other.transcriptText) > 0.78);
  for (const candidate of eligible) {
    const topic = candidate.topic.trim().toLocaleLowerCase('en-US');
    if (topics.has(topic) || !canUse(candidate)) continue;
    selected.push(candidate);
    topics.add(topic);
    if (selected.length === count) return selected;
  }
  for (const candidate of eligible) {
    if (selected.includes(candidate) || !canUse(candidate)) continue;
    selected.push(candidate);
    if (selected.length === count) break;
  }
  return selected;
}

// Compatibility export for existing verification scripts.
export const generateClipCandidates = generateCandidateRanges;

export function aiShortlistLimit(durationSeconds: number) {
  const minutes = durationSeconds / 60;
  const base = minutes <= 10 ? 12 : minutes <= 20 ? 15 : minutes <= 30 ? 20 :
    minutes <= 60 ? 25 : 30;
  // Keep the analyzed pool comfortably larger than the largest clip count a user may request.
  return Math.max(base, Math.ceil(maxClipCountForDuration(durationSeconds) * 1.75));
}

export function shortlistForUnderstanding(candidates: ScoredClipCandidate[], durationSeconds: number) {
  return selectDiversifiedCandidates(suppressOverlapAndRank(candidates),
    aiShortlistLimit(durationSeconds), 0);
}

export function shortlistForCreative(candidates: ScoredClipCandidate[], durationSeconds: number) {
  const baseLimit = durationSeconds <= 600 ? 6 : durationSeconds <= 1200 ? 10 :
    durationSeconds <= 1800 ? 12 : durationSeconds <= 3600 ? 15 : 18;
  const limit = Math.max(baseLimit, maxClipCountForDuration(durationSeconds));
  // AI confidence changes priority modestly; deterministic content quality remains the main signal.
  const ranked = candidates.map(candidate => ({ ...candidate,
    overallScore: candidate.overallScore * .9 + (candidate.confidence ?? 50) * .1 }));
  const selected = selectDiversifiedCandidates(ranked, limit, 0);
  const keys = new Set(selected.map(candidate => candidate.rangeKey));
  return candidates.filter(candidate => keys.has(candidate.rangeKey));
}
