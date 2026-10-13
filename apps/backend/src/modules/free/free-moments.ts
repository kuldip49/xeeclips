import { createHash } from 'crypto';
import { contentStems, isGenericWord, isNounish, splitTokens, FILLERS } from './free-lexicon';
import { crossSentenceFrames, framesOf, type Frame, type FrameType } from './free-analysis';
import { reconstructSentences, type Sentence, type TimedToken } from './free-sentences';
import { semanticSimilarity } from '../processing/semantic-similarity.service';

/**
 * XeeFree moment scoring and diversity.
 *
 * A candidate moment is judged on fifteen dimensions, each normalised to 0-100 on an absolute scale (so a score means the same thing in
 * every video) and combined with the documented weights below. No single dimension can carry a moment: the largest weight is 0.14.
 * Nothing here is a keyword list standing alone; each dimension reads structure (reconstructed sentences, typed frames, speaker turns,
 * ASR word confidence) of the moment's own transcript.
 */
export const FREE_MOMENT_DIMENSIONS = ['semanticCompleteness', 'contextIndependence', 'payoffStrength', 'specificity', 'novelty', 'tension', 'questionAnswerStrength',
  'storyStrength', 'informationDensity', 'speechClarity', 'visualStability', 'speakerClarity', 'startQuality', 'endQuality', 'durationFitness'] as const;
export type FreeMomentDimension = typeof FREE_MOMENT_DIMENSIONS[number];

/**
 * Weights, with the reason each carries its share. They sum to 1.
 *  completeness .14 / payoff .12 / end .07 / start .06: a clip that is cut mid-thought or has no payoff fails the viewer outright, so the
 *    "finished thought" family is the largest block (.39).
 *  contextIndependence .10: the clip must make sense to someone who never saw the rest of the video.
 *  specificity .08, QA .07, tension .06, density .06, story .05, novelty .05: why a viewer would stay (concrete, answered, tense, dense, new).
 *  speechClarity .05, speakerClarity .03, visualStability .03: signal quality, deliberately small; the other dimensions decide the pick.
 *  duration .05: a preference for one focused beat (20-45 s) over a sprawling window that merely contains several beats. Completeness still
 *    outranks length; this only stops a window from winning by accumulating unrelated topics.
 */
export const FREE_MOMENT_WEIGHTS: Record<FreeMomentDimension, number> = { semanticCompleteness: .14, contextIndependence: .10, payoffStrength: .12, specificity: .07,
  novelty: .04, tension: .06, questionAnswerStrength: .07, storyStrength: .05, informationDensity: .06, speechClarity: .05, visualStability: .03, speakerClarity: .03,
  startQuality: .06, endQuality: .07, durationFitness: .05 };

export type MomentAngle = FrameType | 'GENERAL';
export type FreeMoment = { dims: Record<FreeMomentDimension, number>; composite: number; hookability: number; angle: MomentAngle; frames: FrameType[];
  keyPhrases: string[]; speakers: string[]; sentenceCount: number; snappedStart: number; snappedEnd: number; reasons: string[] };

const clamp = (value: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, value));
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const TENSION_WORDS = new Set(['but', 'however', 'wrong', 'problem', 'risk', 'mistake', 'fail', 'failed', 'never', 'hate', 'fear', 'afraid', 'worst', 'lost', 'danger', 'instead', 'except', 'despite', 'struggle', 'difficult', 'hard']);
const NARRATIVE_CUES = /\b(?:then|so we|so i|finally|turns out|ended up|that day|one day|years ago|last (?:year|week|month)|when i|when we|i remember|and then|next thing)\b/giu;
/** A list item opener ("Second,", "Finally,", "Number three:"). A clip that ends on one with another item to come ends mid-list. */
export const LIST_OPENER = /^(?:and\s+)?(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|sixth|finally|lastly|next|also|number\s+(?:one|two|three|four|five|\d+)|one|two|three|four|five)\b[,:]/iu;
const LIST_ANNOUNCE = /\b(?<n>two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:reasons|ways|steps|things|mistakes|tips|rules|lessons|questions|habits|signs|types|ideas|options|tricks|principles|points|myths|facts|secrets|problems)\b/iu;
const NUMBER_VALUE: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
/** What a story must deliver to count as finished: an outcome, not only a setup. */
const STORY_OUTCOME = /\b(?:turn(?:s|ed) (?:out|into)|ended up|became|led to|that(?:'s| is) (?:when|why|how)|finally|in the end|ever since|and then|the next (?:morning|day)|offered|realized|learned)\b/iu;
const SETUP_END = /\b(?:here(?:'s| is) (?:why|how|what)|let me (?:explain|tell|show)|the reason is|i(?:'ll| will) tell you|the answer is|wait until|and then)\s*[.!?]?$/iu;

export type FreeIndexInput = { words: TimedToken[]; durationSec?: number };
export class FreeTranscriptIndex {
  readonly sentences: Sentence[];
  readonly frames: Frame[];
  private readonly idf = new Map<string, number>();
  private idfMean = 0; private idfStd = 1;
  readonly fingerprint: string;
  constructor(input: FreeIndexInput) {
    this.sentences = reconstructSentences(input.words);
    const per = this.sentences.flatMap(s => framesOf(s, this.sentences));
    this.frames = [...per, ...crossSentenceFrames(this.sentences)];
    const df = new Map<string, number>();
    for (const s of this.sentences) for (const stem of new Set(contentStems(s.text))) df.set(stem, (df.get(stem) ?? 0) + 1);
    const n = this.sentences.length;
    for (const [stem, count] of df) this.idf.set(stem, Math.log((n + 1) / (count + 1)) + 1);
    const means = this.sentences.map(s => mean([...new Set(contentStems(s.text))].map(w => this.idf.get(w) ?? 1)));
    this.idfMean = mean(means); this.idfStd = Math.sqrt(mean(means.map(m => (m - this.idfMean) ** 2))) || 1;
    this.fingerprint = createHash('sha1').update(this.sentences.map(s => s.text).join('|')).digest('hex').slice(0, 12);
  }
  /** Sentences overlapping [start, end], snapped outward to whole sentences. */
  window(start: number, end: number) {
    const inside = this.sentences.filter(s => s.start !== undefined && s.end !== undefined && s.end > start + .05 && s.start < end - .05);
    return inside;
  }
  meanIdf(stems: string[]) { return mean(stems.map(w => this.idf.get(w) ?? 1)); }
  normalizedNovelty(stems: string[]) { return clamp(50 + 22 * (this.meanIdf(stems) - this.idfMean) / this.idfStd); }
}

const durationFitness = (seconds: number) => seconds < 15 ? 0 : seconds < 20 ? 80 : seconds <= 45 ? 100 : seconds <= 60 ? 82 : seconds <= 75 ? 62 : seconds <= 100 ? 45 : seconds <= 120 ? 35 : 0;

export function scoreMoment(index: FreeTranscriptIndex, startTime: number, endTime: number, options: { wordConfidence?: number; visualStability?: number } = {}): FreeMoment {
  const S = index.window(startTime, endTime);
  const reasons: string[] = [];
  const zero = Object.fromEntries(FREE_MOMENT_DIMENSIONS.map(d => [d, 0])) as Record<FreeMomentDimension, number>;
  if (!S.length) return { dims: zero, composite: 0, hookability: 0, angle: 'GENERAL', frames: [], keyPhrases: [], speakers: [], sentenceCount: 0, snappedStart: startTime, snappedEnd: endTime, reasons: ['NO_SENTENCES'] };
  const first = S[0], last = S[S.length - 1];
  const snappedStart = first.start ?? startTime, snappedEnd = last.end ?? endTime;
  const ids = new Set(S.map(s => s.index));
  const inFrames = index.frames.filter(f => ids.has(f.sentence));
  const words = S.flatMap(s => s.words);
  const text = S.map(s => s.text).join(' ');
  const stems = [...new Set(contentStems(text))];
  const seconds = Math.max(.1, snappedEnd - snappedStart);
  const fragments = S.filter(s => !s.complete);
  const fillerRatio = words.length ? words.filter(w => FILLERS.has(w)).length / words.length : 1;

  // semanticCompleteness
  let completeness = 100;
  if (!first.complete) { completeness -= 35; reasons.push('OPENS_ON_FRAGMENT'); }
  if (!last.complete) { completeness -= 25; reasons.push('ENDS_ON_FRAGMENT'); }
  completeness -= Math.min(30, fragments.filter(s => s !== first && s !== last).length * 10);
  const questionOutside = S.some((s, i) => s.kind === 'QUESTION' && s.words.length >= 4 && !S.slice(i + 1, i + 4).some(n => n.complete && n.kind !== 'QUESTION' && n.words.length >= 4));
  if (questionOutside) { completeness -= 20; reasons.push('QUESTION_WITHOUT_ANSWER'); }
  if (last.kind === 'QUESTION') { completeness -= 15; reasons.push('ENDS_ON_QUESTION'); }
  if (SETUP_END.test(last.text)) { completeness -= 20; reasons.push('ENDS_ON_SETUP'); }
  // A list that announces N items must deliver them; a clip that stops on an item with another one coming ends mid-list.
  const announced = S.map(s => LIST_ANNOUNCE.exec(s.text)).find(Boolean);
  const announcedCount = announced?.groups ? (NUMBER_VALUE[announced.groups.n.toLowerCase()] ?? Number(announced.groups.n)) : 0;
  const itemsPresent = S.filter(s => LIST_OPENER.test(s.text)).length;
  const nextAfter = index.sentences[last.index + 1];
  const midList = (announcedCount > 1 && itemsPresent > 0 && itemsPresent < announcedCount) || (LIST_OPENER.test(last.text) && !!nextAfter && LIST_OPENER.test(nextAfter.text));
  if (midList) { completeness -= 30; reasons.push('LIST_INCOMPLETE'); }
  // Several separate beginnings in one window are several topics, not one moment: each question that gets its own answer, each list that is
  // announced, each story that starts ("Three years ago ...") and each fresh imperative ("Never ...", "Always ...") opens a topic of its own.
  const openers = inFrames.filter(f => f.type === 'QA').length
    + S.filter(s => LIST_ANNOUNCE.test(s.text)).length
    + S.filter(s => /^(?:three|two|four|five|\d+)\s+(?:years|months|weeks|days)\s+ago\b|^(?:one day|last (?:year|week|month)|years ago|a few (?:years|months|weeks) ago)\b/iu.test(s.text)).length
    + S.filter((s, i) => i > 0 && /^(?:never|always|don't|stop|avoid)\s+\p{L}+/iu.test(s.text) && S[i - 1].complete && S[i - 1].kind !== 'QUESTION').length;
  if (openers > 1) { completeness -= Math.min(45, (openers - 1) * 15); reasons.push('MULTIPLE_TOPICS'); }

  // contextIndependence
  let context = 100;
  if (!first.standalone) { context -= 30; reasons.push('OPENING_NOT_STANDALONE'); }
  if (S[1] && S[1].reasons.includes('UNRESOLVED_PRONOUN_OPENING') && first.words.length < 6) context -= 15;
  const earlyText = S.slice(0, 2).map(s => s.words);
  const demonstratives = earlyText.flat().filter((w, i, a) => /^(?:this|that|these|those)$/u.test(w) && isNounish(a[i + 1] ?? '')).length;
  context -= Math.min(24, demonstratives * 8);
  if (first.kind === 'QUESTION' || index.frames.some(f => f.sentence === first.index && ['CLAIM', 'LEAD', 'REASON', 'NUMBER', 'OPINION'].includes(f.type))) context += 5;

  // payoffStrength
  let payoff = 40;
  const lateIds = new Set(S.slice(Math.floor(S.length * .6)).map(s => s.index));
  if (inFrames.some(f => f.type === 'CONCLUSION' && lateIds.has(f.sentence))) payoff += 25;
  if (inFrames.some(f => ['QA', 'REASON', 'LEAD', 'CONDITION', 'CONTRAST'].includes(f.type) && lateIds.has(f.sentence))) payoff += 20;
  if (last.complete && last.kind !== 'QUESTION' && last.words.length >= 6) payoff += 10;
  if (last.kind === 'QUESTION') payoff -= 20;
  if (SETUP_END.test(last.text)) payoff -= 15;
  if (midList) payoff -= 20;
  if (openers > 1) payoff -= Math.min(24, (openers - 1) * 8);
  // A story is finished by its outcome. Setup alone is penalised; setup plus outcome is rewarded.
  const hasStory = index.frames.some(f => f.type === 'STORY' && ids.has(f.sentence)) || /\b(?:remember|years ago|one day|last (?:year|week|month)|when i)\b/iu.test(text);
  if (hasStory) { if (STORY_OUTCOME.test(S.slice(-2).map(s => s.text).join(' '))) payoff += 12; else { payoff -= 15; reasons.push('STORY_WITHOUT_PAYOFF'); } }

  // specificity
  const numbers = words.filter(w => /\d/u.test(w)).length, proper = splitTokens(text).filter((t, i) => i > 0 && /^\p{Lu}[\p{L}'’-]+/u.test(t) && !/^[.!?]/u.test(splitTokens(text)[i - 1]?.slice(-1) ?? '')).length;
  const specificWords = stems.filter(w => !isGenericWord(w)).length;
  const specificity = clamp(25 + Math.min(24, proper * 6) + Math.min(16, numbers * 8) + 35 * (specificWords / Math.max(1, stems.length)));

  // novelty (relative to the rest of this video)
  const novelty = index.normalizedNovelty(stems);

  // Count-based signals are measured per 30 seconds, so a window that merely contains several unrelated beats does not outscore one focused beat.
  const perHalfMinute = Math.max(1, seconds / 30);
  // tension
  const tensionFrames = inFrames.filter(f => ['CONTRAST', 'DISAGREEMENT', 'WARNING', 'MYTH'].includes(f.type)).length / perHalfMinute;
  const tension = clamp(30 + Math.min(45, tensionFrames * 15) + Math.min(25, words.filter(w => TENSION_WORDS.has(w)).length / perHalfMinute * 5));

  // questionAnswerStrength
  const qa = inFrames.filter(f => f.type === 'QA').sort((a, b) => b.strength - a.strength)[0];
  const reasonFrames = inFrames.filter(f => f.type === 'REASON' || f.type === 'LEAD');
  const qaScore = clamp(qa ? 60 + qa.strength * 40 : reasonFrames.length ? 55 + Math.max(...reasonFrames.map(f => f.strength)) * 30 : 25);

  // storyStrength
  const story = inFrames.filter(f => f.type === 'STORY').length / perHalfMinute;
  const cues = (text.match(NARRATIVE_CUES) ?? []).length / perHalfMinute;
  const storyScore = clamp(20 + story * 25 + Math.min(40, cues * 10));

  // informationDensity
  const ratio = specificWords / Math.max(1, words.length);
  const density = clamp(100 * Math.min(1, ratio / .35) - fillerRatio * 80);

  // speechClarity
  const clarity = options.wordConfidence !== undefined ? clamp(options.wordConfidence * 100) : clamp(100 - 150 * fillerRatio - 20 * (fragments.length / Math.max(1, S.length)));

  // speakerClarity
  const speakers = [...new Set(S.map(s => s.speaker).filter((s): s is string => !!s && !/^(?:unknown|none|null)$/iu.test(s)))];
  let flips = 0; for (let i = 1; i < S.length; i++) if (S[i].speaker !== S[i - 1].speaker) flips++;
  const speakerClarity = speakers.length ? clamp(100 - (flips / (seconds / 60)) * 4 - (speakers.length > 3 ? 20 : 0)) : 60;

  // startQuality / endQuality
  let start = 0;
  if (first.standalone) start += 40;
  if (inFrames.some(f => f.sentence === first.index && ['QA', 'REASON', 'LEAD', 'CLAIM', 'OPINION', 'NUMBER', 'REVEAL', 'CONTRAST', 'MYTH'].includes(f.type)) || first.kind === 'QUESTION') start += 30;
  if (!FILLERS.has(first.words[0] ?? '')) start += 15;
  if (first.complete) start += 15;
  let end = 0;
  if (last.complete) end += 35;
  if (/[.!?]$/u.test(last.text)) end += 15;
  if (last.pauseAfter === undefined || last.pauseAfter >= .5) end += 15;
  if (!SETUP_END.test(last.text) && last.kind !== 'QUESTION') end += 10;
  if (midList) end -= 25;
  if (inFrames.some(f => f.type === 'CONCLUSION' && f.sentence >= last.index - 1) || (qa && last.index >= qa.sentence + 1)) end += 25;

  const dims: Record<FreeMomentDimension, number> = { semanticCompleteness: clamp(completeness), contextIndependence: clamp(context), payoffStrength: clamp(payoff), specificity,
    novelty, tension, questionAnswerStrength: qaScore, storyStrength: storyScore, informationDensity: density, speechClarity: clarity, visualStability: clamp(options.visualStability ?? 60),
    speakerClarity, startQuality: clamp(start), endQuality: clamp(end), durationFitness: durationFitness(seconds) };
  const composite = Math.round(FREE_MOMENT_DIMENSIONS.reduce((sum, d) => sum + dims[d] * FREE_MOMENT_WEIGHTS[d], 0) * 100) / 100;
  const hookable = inFrames.filter(f => ['QA', 'REASON', 'LEAD', 'CONTRAST', 'CONDITION', 'ADVICE', 'NUMBER', 'MYTH', 'OPINION', 'REVEAL', 'STORY', 'WARNING'].includes(f.type)).sort((a, b) => b.strength - a.strength);
  const hookability = clamp(hookable.length ? 25 + hookable.slice(0, Math.max(1, Math.min(3, Math.round(3 / perHalfMinute)))).reduce((s, f) => s + f.strength * 30, 0) : 15);
  const angleOrder: FrameType[] = ['QA', 'LEAD', 'REASON', 'CONTRAST', 'OPINION', 'MYTH', 'ADVICE', 'WARNING', 'NUMBER', 'REVEAL', 'STORY', 'CONDITION'];
  const angle: MomentAngle = angleOrder.find(a => hookable.some(f => f.type === a)) ?? 'GENERAL';
  const keyPhrases = [...new Set(inFrames.flatMap(f => Object.values(f.slots).filter(s => s.kind === 'NP' || s.kind === 'CLAUSE').map(s => s.text.toLowerCase())).slice(0, 4))];
  return { dims, composite, hookability, angle, frames: [...new Set(inFrames.map(f => f.type))], keyPhrases, speakers, sentenceCount: S.length, snappedStart, snappedEnd, reasons };
}

// --- candidate integration ------------------------------------------------------------------------------------------------------
type Rescorable = { startTime: number; endTime: number; transcriptText: string; hookScore: number; standaloneScore: number; payoffScore: number; flowScore: number;
  informationScore: number; retentionScore: number; shareabilityScore: number; reject: boolean; rejectionReason: string; reason: string; evidence?: Record<string, unknown> };

const blend = (original: number, free: number, weight = .8) => Math.round(clamp(original * (1 - weight) + free * weight) * 100) / 100;

/**
 * Re-scores a candidate with the free moment model. The seven sub-scores the rest of the pipeline already consumes are blended
 * (80% free / 20% original) rather than replaced, and `contentPotential` is recomputed from them by the caller's own formula, so every
 * downstream invariant (bands, ranking, selection) holds. A moment with no complete sentence at all is rejected outright.
 */
export function applyFreeMoment<T extends Rescorable>(candidate: T, moment: FreeMoment, potential: (scores: { hookScore: number; standaloneScore: number; payoffScore: number; flowScore: number; informationScore: number; retentionScore: number; shareabilityScore: number }) => number): T {
  const d = moment.dims;
  const scores = {
    hookScore: blend(candidate.hookScore, (moment.hookability * .6 + d.startQuality * .4)),
    standaloneScore: blend(candidate.standaloneScore, (d.semanticCompleteness * .5 + d.contextIndependence * .5)),
    payoffScore: blend(candidate.payoffScore, (d.payoffStrength * .6 + d.endQuality * .4)),
    flowScore: blend(candidate.flowScore, (d.semanticCompleteness * .4 + d.speechClarity * .3 + d.speakerClarity * .15 + d.visualStability * .15)),
    informationScore: blend(candidate.informationScore, (d.informationDensity * .5 + d.specificity * .5)),
    retentionScore: blend(candidate.retentionScore, (d.tension * .3 + d.storyStrength * .2 + d.questionAnswerStrength * .3 + d.durationFitness * .2)),
    shareabilityScore: blend(candidate.shareabilityScore, (d.novelty * .3 + d.specificity * .3 + d.payoffStrength * .4)) };
  // The free moment model leads (70%); the original keyword/length heuristics keep a 30% say so a clip they flag as thin cannot be lifted by structure alone.
  const contentPotential = Math.round(clamp(potential(scores) * .3 + moment.composite * .7) * 100) / 100;
  const hardFail = moment.sentenceCount === 0 || (d.semanticCompleteness < 35 && d.contextIndependence < 45);
  return { ...candidate, ...scores, contentPotential, overallScore: contentPotential, heuristicScore: contentPotential,
    reject: candidate.reject || hardFail,
    rejectionReason: hardFail && !candidate.reject ? 'Incomplete or context-dependent moment (free semantic model).' : candidate.rejectionReason,
    reason: `Free moment model: completeness ${Math.round(d.semanticCompleteness)}, payoff ${Math.round(d.payoffStrength)}, context ${Math.round(d.contextIndependence)}, hookability ${Math.round(moment.hookability)}.`,
    evidence: { ...(candidate.evidence ?? {}), freeMoment: { version: 1, composite: moment.composite, hookability: moment.hookability, angle: moment.angle, frames: moment.frames,
      keyPhrases: moment.keyPhrases, speakers: moment.speakers, dims: d, reasons: moment.reasons } } };
}

/**
 * Deterministic diversity order (maximal marginal relevance). Each pick maximises its own strength minus its similarity to what is
 * already chosen, where similarity combines transcript overlap, shared key phrases, the same angle, the same speaker set and temporal
 * nearness. Because each pick depends only on the earlier picks, the first N entries are stable when more clips are requested later.
 */
export type Diversifiable = { startTime: number; endTime: number; transcriptText: string; contentPotential: number; evidence?: unknown };
const freeOf = (c: Diversifiable) => (c.evidence && typeof c.evidence === 'object' ? (c.evidence as Record<string, unknown>).freeMoment : undefined) as
  { angle?: string; keyPhrases?: string[]; speakers?: string[] } | undefined;
export function momentSimilarity(a: Diversifiable, b: Diversifiable): number {
  const fa = freeOf(a), fb = freeOf(b);
  const lexical = semanticSimilarity.similarity(a.transcriptText, b.transcriptText);
  const pa = new Set(fa?.keyPhrases ?? []), pb = new Set(fb?.keyPhrases ?? []);
  const phrases = pa.size && pb.size ? [...pa].filter(p => pb.has(p)).length / Math.min(pa.size, pb.size) : 0;
  const angle = fa?.angle && fa.angle === fb?.angle && fa.angle !== 'GENERAL' ? 1 : 0;
  const sa = new Set(fa?.speakers ?? []), sb = new Set(fb?.speakers ?? []);
  const speakers = sa.size && sb.size ? [...sa].filter(s => sb.has(s)).length / Math.max(sa.size, sb.size) : 0;
  const gap = Math.max(0, Math.max(a.startTime, b.startTime) - Math.min(a.endTime, b.endTime));
  // Only neighbouring moments count as "the same stretch of the video"; distant ones are separated by time already.
  const near = gap < 20 ? 1 : gap < 60 ? .3 : 0;
  return Math.min(1, lexical * .45 + phrases * .2 + angle * .15 + speakers * .05 + near * .15);
}
export function diversifyOrder<T extends Diversifiable>(ordered: T[], lambda = 38): T[] {
  const remaining = [...ordered];
  const out: T[] = [];
  while (remaining.length) {
    let best = 0, bestValue = -Infinity;
    remaining.forEach((c, i) => {
      const similarity = out.length ? Math.max(...out.map(o => momentSimilarity(c, o))) : 0;
      const value = c.contentPotential - lambda * similarity;
      if (value > bestValue + 1e-9) { bestValue = value; best = i; }
    });
    out.push(remaining.splice(best, 1)[0]);
  }
  return out;
}

/** How many chunk-window candidates XeeFree scores before keeping the best (XeePro keeps its original, smaller pool). */
export const FREE_CANDIDATE_POOL = 600;
type PoolCandidate = Rescorable & { heuristicScore: number; contentPotential: number; overallScore: number };
/** Re-scores every window with the free moment model, strongest first, with a deterministic tie-break on position. */
export function rescoreFreePool<T extends PoolCandidate>(candidates: T[], index: FreeTranscriptIndex,
  potential: Parameters<typeof applyFreeMoment>[2]): T[] {
  return candidates.map(c => applyFreeMoment(c, scoreMoment(index, c.startTime, c.endTime), potential))
    .sort((a, b) => b.heuristicScore - a.heuristicScore || a.startTime - b.startTime || a.endTime - b.endTime);
}

/**
 * Sentence-granular windows. Whisper chunks are acoustic groupings that routinely straddle a change of topic, so windows built from them
 * cannot isolate one beat. XeeFree builds its candidate windows from reconstructed sentences instead: every window starts and ends on a
 * sentence boundary and a window never bridges a long silence. The shared candidate generator then enumerates and scores them exactly as it
 * does for chunks.
 */
export type SentenceChunk = { position: number; startTime: number; endTime: number; duration: number; text: string; wordCount: number };
export function sentenceChunks(index: FreeTranscriptIndex): SentenceChunk[] {
  const out: SentenceChunk[] = [];
  for (const s of index.sentences) {
    if (s.start === undefined || s.end === undefined || s.end <= s.start || !s.words.length) continue;
    out.push({ position: out.length, startTime: s.start, endTime: s.end, duration: s.end - s.start, text: s.text, wordCount: s.words.length });
  }
  return out;
}
