import { Injectable, Logger } from '@nestjs/common';
import { calculateContentPotential, clampScore, roundScore, ScoredClipCandidate } from './clip-candidates';
import { LlmProviderError, StrictJsonSchema, validateSchema, normalizeSchema } from './llm-provider.service';
import { countPerformance, currentAiProcessingMode, performanceContext } from './performance-telemetry';
import { AiProcessingMode } from './ai-processing-mode';
import { LlmRouteMetadata, LlmRouterService } from './llm-router.service';

export type VisualSignal = { position: number; startTime: number; endTime: number;
  yoloFrameCount?: number | null; faceFrameCount?: number | null;
  ocrFrameCount?: number | null;
  sceneChangeCount: number; sceneCutRate: number; averageShotDuration: number;
  visualTransitionScore: number; averageMotion: number; visualNovelty: number;
  faceCount: number; largestFaceRatio: number; facePresenceRatio: number;
  averageFaceCount: number; primaryFaceAreaRatio: number; primaryFaceCenteredness: number;
  faceStability: number; talkingHeadLikelihood: number; personPresenceRatio: number;
  averagePersonCount: number; objectActivity: number; objectDiversity: number;
  detectedObjectClasses: string[]; largestPersonProminence: number;
  centralPersonScore: number; detectionConfidenceMean: number; brightness: number;
  contrast: number; colorfulness: number; sharpnessScore: number; blackFrameRatio: number;
  ocrText: string; ocrConfidence: number; textAreaRatio: number; subtitleDetected: boolean;
  titleCardPresence?: boolean };
export type MultimodalObservation = { position: number; visualEvent: string;
  visuallyInteresting: boolean; interestScore: number; evidenceRefs: string[] };
export type DeterministicContentType = 'talking head' | 'podcast/interview' |
  'tutorial/demo' | 'slides/presentation' | 'gameplay' | 'sports/action' |
  'screen recording' | 'mixed';
export type CandidateVisualEvidence = {
  facePresenceRatio: number | null; faceProminence: number | null;
  personPresenceRatio: number | null; motionScore: number; sceneCutRate: number;
  ocrPresenceScore: number | null; transcriptOcrAlignment: number | null;
  sharpnessScore: number; visualNovelty: number; blackFrameRatio: number;
  subjectCenteredness: number | null; faceStability: number | null;
  talkingHeadLikelihood: number | null; speechDensity: number; silenceRatio: number;
};
export type ClipEvidence = { startTime: number; endTime: number; transcript: string;
  previousContext: string; nextContext: string; chapter: string; overallVideoTopic: string;
  speechSignals: Record<string, number>; visualSignals: VisualSignal[];
  multimodalSignals: MultimodalObservation[]; supportedFacts: string[];
  importantMoments: string[]; contentType: DeterministicContentType;
  candidateVisualEvidence: CandidateVisualEvidence };

export type ClipUnderstandingDecisionSource = 'LUNA' | 'OLLAMA' |
  'DETERMINISTIC_HIGH_CONFIDENCE' | 'DETERMINISTIC_FALLBACK';

// Stage 5 confidence gate thresholds. Shared by isHighConfidenceClipCandidate and
// highConfidenceGateBlockers so telemetry can never drift from the actual gate.
export const HIGH_CONFIDENCE_GATE_THRESHOLDS = {
  heuristicScore: 80, standaloneScore: 78, payoffScore: 75,
  hookScore: 72, flowScore: 70, informationScore: 65
} as const;
export type HighConfidenceGateDimension = keyof typeof HIGH_CONFIDENCE_GATE_THRESHOLDS;
const HIGH_CONFIDENCE_GATE_DIMENSIONS =
  Object.keys(HIGH_CONFIDENCE_GATE_THRESHOLDS) as HighConfidenceGateDimension[];

/**
 * Deterministic scores alone are trusted to skip a clipUnderstanding model call only when
 * every independent signal already agrees the clip is strong and unambiguous: this is the
 * Stage 5 confidence gate, not a substitute for judgment on anything borderline.
 */
export function isHighConfidenceClipCandidate(candidate: Pick<ScoredClipCandidate,
  'reject' | 'heuristicScore' | 'standaloneScore' | 'payoffScore' | 'hookScore' |
  'flowScore' | 'informationScore'>): boolean {
  if (candidate.reject) return false;
  return HIGH_CONFIDENCE_GATE_DIMENSIONS.every((dimension) =>
    candidate[dimension] >= HIGH_CONFIDENCE_GATE_THRESHOLDS[dimension]);
}

// Diagnostic companion to isHighConfidenceClipCandidate: which of the six gate dimensions
// (independent of the reject flag) fell short of its threshold for this candidate.
export function highConfidenceGateBlockers(candidate: Pick<ScoredClipCandidate,
  'heuristicScore' | 'standaloneScore' | 'payoffScore' | 'hookScore' |
  'flowScore' | 'informationScore'>): HighConfidenceGateDimension[] {
  return HIGH_CONFIDENCE_GATE_DIMENSIONS.filter((dimension) =>
    candidate[dimension] < HIGH_CONFIDENCE_GATE_THRESHOLDS[dimension]);
}

export type ClipUnderstanding = {
  mainTopic: string; subTopics: string[]; speakerIntent: string; mainClaim: string;
  strongestFact: string; keyQuote: string; problem: string; conflict: string;
  surprisingPoint: string; emotionalTone: string; targetAudience: string;
  viewerPainPoint: string; viewerBenefit: string; payoff: string; conclusion: string;
  contentType: string; standaloneMeaning: string; contextNeeded: string;
  engagementDrivers: string[]; supportedClaims: string[]; confidence: number;
};

const stringArray = { type: 'array', items: { type: 'string' } } as const;
export const MAX_MULTIMODAL_OBSERVATIONS = 24;
const understandingProperties = {
  mainTopic: { type: 'string' }, subTopics: stringArray, speakerIntent: { type: 'string' },
  mainClaim: { type: 'string' }, strongestFact: { type: 'string' }, keyQuote: { type: 'string' },
  problem: { type: 'string' }, conflict: { type: 'string' }, surprisingPoint: { type: 'string' },
  emotionalTone: { type: 'string' }, targetAudience: { type: 'string' },
  viewerPainPoint: { type: 'string' }, viewerBenefit: { type: 'string' }, payoff: { type: 'string' },
  conclusion: { type: 'string' }, contentType: { type: 'string' },
  standaloneMeaning: { type: 'string' }, contextNeeded: { type: 'string' },
  engagementDrivers: stringArray, supportedClaims: stringArray,
  confidence: { type: 'number', minimum: 0, maximum: 100 }
} as const;
const UNDERSTANDING_KEYS = Object.keys(understandingProperties);
export const CLIP_UNDERSTANDING_SCHEMA: StrictJsonSchema = { type: 'object',
  additionalProperties: false, properties: { candidates: { type: 'array', items: {
    type: 'object', additionalProperties: false, properties: understandingProperties,
    required: UNDERSTANDING_KEYS } } }, required: ['candidates'] };

const MULTIMODAL_SCHEMA: StrictJsonSchema = { type: 'object', additionalProperties: false,
  properties: { observations: { type: 'array', minItems: 1,
    maxItems: MAX_MULTIMODAL_OBSERVATIONS, items: { type: 'object',
    additionalProperties: false, properties: { position: { type: 'integer', minimum: 0 },
      visualEvent: { type: 'string' }, visuallyInteresting: { type: 'boolean' },
      interestScore: { type: 'number', minimum: 0, maximum: 100 },
      evidenceRefs: { type: 'array', maxItems: 3, items: { type: 'string' } } },
    required: ['position', 'visualEvent', 'visuallyInteresting', 'interestScore', 'evidenceRefs'] } } },
  required: ['observations'] };
const MULTIMODAL_SCHEMA_ITEM = ((MULTIMODAL_SCHEMA.properties as Record<string,
  Record<string, unknown>>).observations.items) as Record<string, unknown>;

const normalize = (value: string) => value.trim().replace(/\s+/gu, ' ');
const sentences = (value: string) => normalize(value).match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [];
const words = (value: string) => normalize(value).split(/\s+/u).filter(Boolean);
const limited = (value: string, count = 30) => words(value).slice(0, count).join(' ');
const average = (values: number[]) => values.length
  ? values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) / values.length : 0;
const tokens = (value: string) => new Set((value.toLocaleLowerCase('en-US')
  .match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 4));

export function inferContentType(signals: VisualSignal[]): DeterministicContentType {
  if (!signals.length) return 'mixed';
  const faceSignals = signals.filter(item => item.faceFrameCount !== null &&
    (item.faceFrameCount === undefined || item.faceFrameCount > 0));
  const personSignals = signals.filter(item => item.yoloFrameCount !== null &&
    (item.yoloFrameCount === undefined || item.yoloFrameCount > 0));
  const textSignals = signals.filter(item => item.ocrFrameCount !== null &&
    (item.ocrFrameCount === undefined || item.ocrFrameCount > 0));
  const face = average(faceSignals.map(item => item.facePresenceRatio));
  const faces = average(faceSignals.map(item => item.averageFaceCount));
  const text = average(textSignals.map(item => item.textAreaRatio));
  const motion = average(signals.map(item => item.averageMotion));
  const person = average(personSignals.map(item => item.personPresenceRatio));
  const classes = new Set(personSignals.flatMap(item => item.detectedObjectClasses ?? []));
  if (faceSignals.length && face >= 65 && faces >= 1.45) return 'podcast/interview';
  if (faceSignals.length && face >= 65 && average(faceSignals.map(item => item.talkingHeadLikelihood)) >= 55) return 'talking head';
  if (textSignals.length && text >= 4 && motion <= 8 && (!personSignals.length || person < 35)) return 'slides/presentation';
  if (motion >= 14 && (classes.has('sports ball') || classes.has('skateboard') ||
    classes.has('surfboard') || person >= 55)) return 'sports/action';
  if (classes.has('tv') || classes.has('laptop') || classes.has('cell phone')) {
    return text >= 2 ? 'screen recording' : 'tutorial/demo';
  }
  if (faceSignals.length && personSignals.length && face < 20 && motion >= 10 && person < 30) return 'gameplay';
  if (signals.some(item => item.objectDiversity >= 3)) return 'tutorial/demo';
  return 'mixed';
}

export function candidateVisualEvidence(candidate: ScoredClipCandidate,
  signals: VisualSignal[], speech?: { speechDensity: number; silenceRatio: number }): CandidateVisualEvidence {
  const ocr = signals.map(item => item.ocrText).filter(Boolean).join(' ');
  const spoken = tokens(candidate.transcriptText);
  const visible = tokens(ocr);
  const overlap = spoken.size ? [...spoken].filter(word => visible.has(word)).length / spoken.size * 100 : 0;
  const speechWords = words(candidate.transcriptText).length;
  const wordsPerSecond = speechWords / Math.max(1, candidate.duration);
  const speechDensity = clampScore(wordsPerSecond / 2.7 * 100);
  const faces = signals.filter(item => item.faceFrameCount !== null &&
    (item.faceFrameCount === undefined || item.faceFrameCount > 0));
  const persons = signals.filter(item => item.yoloFrameCount !== null &&
    (item.yoloFrameCount === undefined || item.yoloFrameCount > 0));
  const textSignals = signals.filter(item => item.ocrFrameCount !== null &&
    (item.ocrFrameCount === undefined || item.ocrFrameCount > 0));
  return {
    facePresenceRatio: faces.length ? roundScore(average(faces.map(item => item.facePresenceRatio))) : null,
    faceProminence: faces.length ? roundScore(average(faces.map(item => item.primaryFaceAreaRatio))) : null,
    personPresenceRatio: persons.length ? roundScore(average(persons.map(item => item.personPresenceRatio))) : null,
    motionScore: roundScore(average(signals.map(item => item.averageMotion))),
    sceneCutRate: Math.round(average(signals.map(item => item.sceneCutRate)) * 1000) / 1000,
    ocrPresenceScore: textSignals.length ? roundScore(average(textSignals.map(item =>
      item.ocrText ? clampScore(35 + item.ocrConfidence * .35 + item.textAreaRatio * 3) : 0))) : null,
    transcriptOcrAlignment: textSignals.length ? roundScore(overlap) : null,
    sharpnessScore: roundScore(average(signals.map(item => item.sharpnessScore))),
    visualNovelty: roundScore(average(signals.map(item => item.visualNovelty))),
    blackFrameRatio: roundScore(average(signals.map(item => item.blackFrameRatio))),
    subjectCenteredness: faces.length || persons.length ? roundScore(Math.max(
      average(faces.map(item => item.primaryFaceCenteredness)),
      average(persons.map(item => item.centralPersonScore)))) : null,
    faceStability: faces.length ? roundScore(average(faces.map(item => item.faceStability))) : null,
    talkingHeadLikelihood: faces.length ? roundScore(average(faces.map(item => item.talkingHeadLikelihood))) : null,
    speechDensity: roundScore(speech?.speechDensity ?? speechDensity),
    silenceRatio: roundScore(speech?.silenceRatio ?? Math.max(0, 100 - speechDensity))
  };
}

export function applyDeterministicEvidence(candidate: ScoredClipCandidate,
  evidence: ClipEvidence): ScoredClipCandidate {
  const visual = evidence.candidateVisualEvidence;
  if (!visual || !evidence.visualSignals.length) return candidate;
  // A successful OpenCV scan is not evidence that a semantic model ran.
  // Infrastructure failure or a spent time budget must not lower clip scores.
  if (visual.facePresenceRatio === null && visual.personPresenceRatio === null &&
      visual.ocrPresenceScore === null) return candidate;
  const contentType = evidence.contentType;
  const brightness = average(evidence.visualSignals.map(item => item.brightness));
  const contrast = average(evidence.visualSignals.map(item => item.contrast));
  const exposure = clampScore(100 - Math.abs(brightness - 52) * 1.7);
  const visualQuality = clampScore(visual.sharpnessScore * .45 + exposure * .25 +
    contrast * .15 + (100 - visual.blackFrameRatio) * .15);
  const activity = clampScore(100 - Math.abs(visual.motionScore - 8) * 5);
  const transitions = clampScore(100 - Math.abs(visual.sceneCutRate - .08) * 650);
  const faceSubject = visual.facePresenceRatio === null ? null : clampScore(
    visual.facePresenceRatio * .35 + Math.min(100, (visual.faceProminence ?? 0) * 4) * .25 +
    (visual.subjectCenteredness ?? 0) * .2 + (visual.faceStability ?? 0) * .2);
  const personSubject = visual.personPresenceRatio === null ? null : clampScore(
    visual.personPresenceRatio * .55 + (visual.subjectCenteredness ?? 0) * .45);
  const ocrContext = visual.ocrPresenceScore === null ? null : clampScore(
    visual.ocrPresenceScore * .55 + (visual.transcriptOcrAlignment ?? 0) * .45);
  const subject = contentType === 'talking head' || contentType === 'podcast/interview'
    ? faceSubject ?? candidate.standaloneScore
    : contentType === 'slides/presentation' || contentType === 'screen recording'
      ? ocrContext ?? candidate.informationScore
      : contentType === 'sports/action' || contentType === 'gameplay'
        ? activity : Math.max(personSubject ?? candidate.standaloneScore,
          (ocrContext ?? candidate.informationScore) * .8);
  const textSupport = ocrContext ?? candidate.informationScore;
  const chaoticPenalty = visual.sceneCutRate > .45 ? (visual.sceneCutRate - .45) * 22 : 0;
  const deadPenalty = visual.blackFrameRatio * .35;
  const adjust = (score: number, support: number, weight: number, penalty = 0) =>
    roundScore(score * (1 - weight) + support * weight - deadPenalty - penalty);
  const hookScore = adjust(candidate.hookScore,
    clampScore(subject * .5 + activity * .25 + textSupport * .25), .12, chaoticPenalty);
  const standaloneScore = adjust(candidate.standaloneScore,
    clampScore(subject * .55 + visualQuality * .3 + textSupport * .15), .12);
  const payoffScore = adjust(candidate.payoffScore,
    clampScore(visualQuality * .45 + textSupport * .35 + activity * .2), .08);
  const flowScore = adjust(candidate.flowScore,
    clampScore(visualQuality * .45 + transitions * .35 + (visual.faceStability ?? candidate.flowScore) * .2), .12,
    chaoticPenalty);
  const informationScore = adjust(candidate.informationScore,
    clampScore(textSupport * .45 + subject * .25 + candidate.informationScore * .3), .09);
  const retentionScore = adjust(candidate.retentionScore,
    clampScore(activity * .25 + transitions * .2 + subject * .25 + visualQuality * .2 +
      visual.speechDensity * .1), .14, chaoticPenalty);
  const shareabilityScore = adjust(candidate.shareabilityScore,
    clampScore(subject * .35 + visualQuality * .25 + textSupport * .2 + activity * .2), .09);
  const contentPotential = calculateContentPotential({ hookScore, standaloneScore, payoffScore,
    flowScore, informationScore, retentionScore, shareabilityScore });
  const reasons = [];
  if (visual.facePresenceRatio !== null && visual.facePresenceRatio >= 70) reasons.push(`Speaker visible through ${Math.round(visual.facePresenceRatio)}% of clip`);
  if (visual.subjectCenteredness !== null && visual.subjectCenteredness >= 70) reasons.push('Clear central subject');
  if (visual.silenceRatio <= 20) reasons.push('Low estimated silence ratio');
  if (visual.transcriptOcrAlignment !== null && visual.transcriptOcrAlignment >= 20) reasons.push('On-screen text supports the spoken topic');
  if (activity >= 55 && activity <= 90) reasons.push('Moderate visual activity');
  if (visual.sharpnessScore >= 70 && exposure >= 65) reasons.push('Sharp, well-lit frames');
  const whySelected = reasons.length ? reasons.join('; ') : candidate.reason;
  return { ...candidate, hookScore, standaloneScore, payoffScore, flowScore,
    informationScore, retentionScore, shareabilityScore, contentPotential,
    overallScore: contentPotential, contentType, whySelected, reason: whySelected };
}

function deterministicObservation(signal: VisualSignal): MultimodalObservation {
  const interestScore = roundScore(clampScore(signal.sceneChangeCount * 12 + signal.averageMotion * .45 +
    signal.largestFaceRatio * .25 + Number(!!signal.ocrText) * 10));
  const events = [signal.sceneChangeCount ? signal.sceneChangeCount + ' scene changes' : 'stable scene',
    signal.faceCount ? signal.faceCount + ' visible face(s)' : 'no detected face',
    signal.ocrText ? 'on-screen text detected' : 'no reliable on-screen text'];
  return { position: signal.position, visualEvent: events.join(', '),
    visuallyInteresting: interestScore >= 55, interestScore,
    evidenceRefs: ['visualAnalysis:chunk:' + signal.position] };
}

export function compactVisualSignals(signals: VisualSignal[]) {
  if (signals.length <= MAX_MULTIMODAL_OBSERVATIONS) return signals.map(compactVisualSignal);
  const temporal = Array.from({ length: Math.ceil(MAX_MULTIMODAL_OBSERVATIONS / 2) }, (_, index) =>
    signals[Math.min(signals.length - 1, Math.floor(index * signals.length /
      Math.ceil(MAX_MULTIMODAL_OBSERVATIONS / 2)))]);
  const interesting = [...signals].sort((left, right) =>
    visualPriority(right) - visualPriority(left)).slice(0, Math.floor(MAX_MULTIMODAL_OBSERVATIONS / 2));
  return [...new Map([...temporal, ...interesting].map(item => [item.position, item])).values()]
    .sort((left, right) => left.position - right.position)
    .slice(0, MAX_MULTIMODAL_OBSERVATIONS).map(compactVisualSignal);
}

function visualPriority(signal: VisualSignal) {
  return signal.sceneChangeCount * 10 + signal.averageMotion + signal.largestFaceRatio * .5 +
    Number(!!signal.ocrText) * 25 + Number(signal.subtitleDetected) * 10;
}

function compactVisualSignal(signal: VisualSignal): VisualSignal {
  return { ...signal, ocrText: normalize(signal.ocrText).slice(0, 160) };
}

function localVisualEvidence(signals: VisualSignal[]) {
  return compactVisualSignals(signals).map(signal => ({ position: signal.position,
    sceneChanges: signal.sceneChangeCount, motion: roundScore(signal.averageMotion),
    sceneCutRate: signal.sceneCutRate, novelty: roundScore(signal.visualNovelty),
    faces: signal.faceCount, facePresence: roundScore(signal.facePresenceRatio),
    largestFace: roundScore(signal.largestFaceRatio), personPresence: roundScore(signal.personPresenceRatio),
    objects: (signal.detectedObjectClasses ?? []).slice(0, 8),
    brightness: roundScore(signal.brightness), contrast: roundScore(signal.contrast),
    sharpness: roundScore(signal.sharpnessScore), blackFrames: roundScore(signal.blackFrameRatio),
    colorfulness: roundScore(signal.colorfulness), subtitle: signal.subtitleDetected,
    titleCard: signal.titleCardPresence === true,
    ocr: normalize(signal.ocrText).slice(0, 80) }));
}

export function localClipUnderstandingInput(evidence: ClipEvidence, candidateId: string) {
  const visual = evidence.visualSignals;
  return { candidateId, exactClipTranscript: evidence.transcript,
    timing: [evidence.startTime, evidence.endTime],
    previousContext: limited(evidence.previousContext, 24),
    nextContext: limited(evidence.nextContext, 24),
    chapterSummary: limited(evidence.chapter, 28),
    topicSummary: limited(evidence.overallVideoTopic, 14),
    metrics: { speech: evidence.speechSignals,
      visual: visual.length ? evidence.candidateVisualEvidence : null,
      visualChunkCount: visual.length,
      sceneChanges: visual.reduce((sum, item) => sum + item.sceneChangeCount, 0),
      maximumMotion: roundScore(Math.max(0, ...visual.map(item => item.averageMotion))),
      maximumFaceRatio: roundScore(Math.max(0, ...visual.map(item => item.largestFaceRatio))),
      interestingVisualMoments: evidence.multimodalSignals.filter(item => item.visuallyInteresting)
        .slice(0, 3).map(item => limited(item.visualEvent, 12)) } };
}

function onlineClipUnderstandingInput(evidence: ClipEvidence, candidateId: string,
  candidate: ScoredClipCandidate) {
  const visual = evidence.candidateVisualEvidence;
  return { candidateId, timing: [evidence.startTime, evidence.endTime],
    transcript: evidence.transcript,
    nearbyContext: [limited(evidence.previousContext, 32), limited(evidence.nextContext, 32)]
      .filter(Boolean), chapter: limited(evidence.chapter, 36),
    topic: limited(evidence.overallVideoTopic, 18),
    scores: { hook: candidate.hookScore, standalone: candidate.standaloneScore,
      payoff: candidate.payoffScore, flow: candidate.flowScore,
      information: candidate.informationScore, retention: candidate.retentionScore,
      shareability: candidate.shareabilityScore },
    visual: visual ? { facePresenceRatio: visual.facePresenceRatio,
      faceProminence: visual.faceProminence, personPresenceRatio: visual.personPresenceRatio,
      motionScore: visual.motionScore, sceneCutRate: visual.sceneCutRate,
      ocrPresenceScore: visual.ocrPresenceScore, sharpnessScore: visual.sharpnessScore,
      visualNovelty: visual.visualNovelty, speechDensity: visual.speechDensity,
      silenceRatio: visual.silenceRatio } : null,
    visualMoments: evidence.multimodalSignals.filter(item => item.visuallyInteresting)
      .slice(0, 2).map(item => limited(item.visualEvent, 12)) };
}

function deterministicUnderstanding(candidate: ScoredClipCandidate, evidence: ClipEvidence): ClipUnderstanding {
  const source = sentences(candidate.transcriptText);
  const first = normalize(source[0] || candidate.topic || 'This clip explains its main point.');
  const last = normalize(source[source.length - 1] || first);
  const strongest = source.find((item) => /\b\d/iu.test(item)) ||
    [...source].sort((a, b) => words(b).length - words(a).length)[0] || first;
  return { mainTopic: candidate.topic || limited(first, 12), subTopics: candidate.relevantTopics || [],
    speakerIntent: 'Explain the clip-specific point', mainClaim: limited(first),
    strongestFact: limited(strongest), keyQuote: limited(first, 22),
    problem: limited(source.find((item) => /\b(?:problem|risk|challenge|fail|wrong)\b/iu.test(item)) || ''),
    conflict: limited(source.find((item) => /\b(?:but|however|yet|instead)\b/iu.test(item)) || ''),
    surprisingPoint: limited(source.find((item) => /\b(?:surpris|unexpected|actually|only)\w*\b/iu.test(item)) || strongest),
    emotionalTone: /\b(?:risk|danger|fail|warning)\b/iu.test(candidate.transcriptText)
      ? 'cautionary' : 'informative', targetAudience: 'Viewers interested in ' +
      limited(candidate.overallVideoTopic || candidate.topic, 10), viewerPainPoint: '',
    viewerBenefit: 'Understand ' + limited(candidate.topic, 12), payoff: limited(last),
    conclusion: limited(last), contentType: 'educational/value',
    standaloneMeaning: candidate.standaloneScore >= 60 ? 'Mostly self-contained' : 'Relies on context',
    contextNeeded: [evidence.previousContext, evidence.nextContext].filter(Boolean).join(' ').slice(0, 300),
    engagementDrivers: [candidate.hookScore >= 60 ? 'strong opening' : '',
      candidate.payoffScore >= 60 ? 'clear payoff' : '',
      evidence.multimodalSignals.some((item) => item.visuallyInteresting) ? 'visual activity' : '']
      .filter(Boolean), supportedClaims: source.slice(0, 5).map((item) => limited(item)),
    confidence: roundScore(evidence.transcript ? 58 + Number(!!evidence.chapter) * 7 +
      Number(evidence.visualSignals.length > 0) * 5 : 20) };
}

@Injectable()
export class ClipIntelligenceService {
  private readonly logger = new Logger(ClipIntelligenceService.name);
  constructor(private readonly router: LlmRouterService = new LlmRouterService()) {}

  isMultimodalConfigured() { return currentAiProcessingMode() !== AiProcessingMode.OFFLINE &&
    this.router.isAnyConfigured('multimodalUnderstanding'); }

  async analyzeMultimodal(videoId: string, signals: VisualSignal[],
    media: Array<{ mimeType: string; data: string }> = []) {
    const fallback = signals.map(deterministicObservation);
    if (currentAiProcessingMode() === AiProcessingMode.OFFLINE) {
      this.logger.log(JSON.stringify({ event: 'offline_deterministic_role',
        role: 'multimodalUnderstanding' }));
      return { observations: fallback, route: null as LlmRouteMetadata | null,
        failureCategory: '' };
    }
    if (!signals.length) return { observations: fallback, route: null as LlmRouteMetadata | null,
      failureCategory: '' };
    try {
      const reasoningSignals = compactVisualSignals(signals);
      const result = await this.router.generate<{ observations: MultimodalObservation[] }>({
        role: 'multimodalUnderstanding', request: { schemaName: 'multimodal_video_evidence',
          schema: MULTIMODAL_SCHEMA, partialBatchField: 'observations',
          cacheKey: videoId + ':' + JSON.stringify(reasoningSignals),
          systemPrompt: 'Interpret deterministic video observations as multimodal evidence. ' +
            'Do not invent objects, dialogue, people, or events absent from the supplied metrics/OCR. ' +
            'evidenceRefs must cite supplied chunk positions. Return every supplied position exactly once. ' +
            'Keep visualEvent under 18 words and evidenceRefs to at most three short entries. ' +
            'Return compact JSON with no explanations or repeated OCR.',
          userPrompt: JSON.stringify(reasoningSignals), maxOutputTokens: 4096, media,
          local: { schemaName: 'local_multimodal_video_evidence', schema: MULTIMODAL_SCHEMA,
            partialBatchField: 'observations', maxOutputTokens: 2400,
            systemPrompt: 'Convert compact deterministic visual metrics into one short observation ' +
              'per supplied position. Use only the metrics and short OCR. Return concise JSON only.',
            userPrompt: JSON.stringify(localVisualEvidence(signals)) } }
      });
      const byPosition = new Map<number, MultimodalObservation>();
      for (const raw of result.data.observations) {
        try {
          const item = normalizeSchema(raw, MULTIMODAL_SCHEMA_ITEM) as MultimodalObservation;
          validateSchema(item, MULTIMODAL_SCHEMA_ITEM);
          if (signals.some(signal => signal.position === item.position)) byPosition.set(item.position, item);
        } catch { /* Preserve other positions; use measured visual evidence for this item. */ }
      }
      return { observations: signals.map((item, index) => {
        if (!byPosition.has(item.position)) countPerformance('schemaRepairCount');
        return byPosition.get(item.position) ?? fallback[index];
      }),
        route: result.metadata, failureCategory: '' };
    } catch (error) {
      const failureCategory = error instanceof LlmProviderError ? error.kind : 'SCHEMA_FAILURE';
      this.logger.warn('Multimodal model path unavailable; deterministic visual evidence retained: ' +
        failureCategory);
      return { observations: fallback, route: null, failureCategory };
    }
  }

  fuse(candidate: ScoredClipCandidate, visualSignals: VisualSignal[],
    observations: MultimodalObservation[],
    speech?: { speechDensity: number; silenceRatio: number }): ClipEvidence {
    const overlap = <T extends { startTime?: number; endTime?: number; position: number }>(item: T) => {
      const visual = visualSignals.find((signal) => signal.position === item.position);
      const start = item.startTime ?? visual?.startTime ?? 0;
      const end = item.endTime ?? visual?.endTime ?? 0;
      return Math.max(0, Math.min(candidate.endTime, end) - Math.max(candidate.startTime, start)) > 0;
    };
    const relevantVisual = visualSignals.filter(overlap);
    const relevantPositions = new Set(relevantVisual.map((item) => item.position));
    const relevantMultimodal = observations.filter((item) => relevantPositions.has(item.position));
    const contentType = inferContentType(relevantVisual);
    const visualEvidence = candidateVisualEvidence(candidate, relevantVisual, speech);
    return { startTime: candidate.startTime, endTime: candidate.endTime,
      transcript: candidate.transcriptText,
      previousContext: candidate.previousTranscriptContext || '',
      nextContext: candidate.nextTranscriptContext || '', chapter: candidate.chapterSummary || '',
      overallVideoTopic: candidate.overallVideoTopic || '', speechSignals: {
        hook: candidate.hookScore, standalone: candidate.standaloneScore,
        payoff: candidate.payoffScore, flow: candidate.flowScore,
        information: candidate.informationScore, retention: candidate.retentionScore,
        shareability: candidate.shareabilityScore }, visualSignals: relevantVisual,
      multimodalSignals: relevantMultimodal,
      supportedFacts: sentences(candidate.transcriptText).slice(0, 8).map(normalize),
      importantMoments: relevantMultimodal.filter((item) => item.visuallyInteresting)
        .map((item) => item.visualEvent), contentType,
      candidateVisualEvidence: visualEvidence };
  }

  async understand(candidates: ScoredClipCandidate[], evidences: ClipEvidence[],
    onProgress?: (completed: number, total: number) => Promise<void>) {
    const fallback = candidates.map((candidate, index) =>
      deterministicUnderstanding(candidate, evidences[index]));
    const decisionSources: ClipUnderstandingDecisionSource[] = candidates.map(candidate =>
      isHighConfidenceClipCandidate(candidate) ? 'DETERMINISTIC_HIGH_CONFIDENCE' :
        'DETERMINISTIC_FALLBACK');
    // Diagnostic tally: for every candidate that did NOT skip the model call, which of the
    // six gate dimensions was below its threshold (a candidate can block on more than one).
    const highConfidenceRejectedBy = Object.fromEntries(HIGH_CONFIDENCE_GATE_DIMENSIONS
      .map((dimension) => [dimension, 0])) as Record<HighConfidenceGateDimension, number>;
    candidates.forEach((candidate, index) => {
      if (decisionSources[index] === 'DETERMINISTIC_HIGH_CONFIDENCE') return;
      for (const dimension of highConfidenceGateBlockers(candidate)) highConfidenceRejectedBy[dimension]++;
    });
    if (!candidates.length) return { understandings: fallback,
      route: null as LlmRouteMetadata | null, failureCategory: '',
      routesByCandidate: [] as Array<LlmRouteMetadata | null>, failureCategories: [] as string[],
      decisionSources, highConfidenceSkippedCount: 0, highConfidenceRejectedBy };
    // Stage 5 confidence gate: a clip that every deterministic signal already agrees is
    // strong and unambiguous skips the semantic model call entirely and keeps its
    // deterministic understanding, which is measurably grounded in the exact transcript.
    const pursueIndexes = candidates
      .map((candidate, index) => (decisionSources[index] === 'DETERMINISTIC_HIGH_CONFIDENCE' ? -1 : index))
      .filter((index): index is number => index >= 0);
    const highConfidenceSkippedCount = candidates.length - pursueIndexes.length;
    if (!pursueIndexes.length) return { understandings: fallback,
      route: null as LlmRouteMetadata | null, failureCategory: '',
      routesByCandidate: candidates.map(() => null), failureCategories: candidates.map(() => ''),
      decisionSources, highConfidenceSkippedCount, highConfidenceRejectedBy };
    const configuredSize = Number(process.env.CLIP_UNDERSTANDING_BATCH_SIZE ?? 2);
    const batchSize = currentAiProcessingMode() === AiProcessingMode.OFFLINE ? 1 :
      Number.isFinite(configuredSize) ? Math.max(1, Math.min(2,
        Math.floor(configuredSize))) : 2;
    const batches = Array.from({ length: Math.ceil(pursueIndexes.length / batchSize) }, (_, index) => {
      const group = pursueIndexes.slice(index * batchSize, (index + 1) * batchSize);
      return { indexes: group, candidates: group.map(item => candidates[item]),
        evidences: group.map(item => evidences[item]) };
    });
    const understandings = [...fallback];
    const routesByCandidate: Array<LlmRouteMetadata | null> = candidates.map(() => null);
    const failureCategories = candidates.map(() => '');
    const routes: LlmRouteMetadata[] = [];
    const failures: string[] = [];
    let nextBatch = 0;
    let completed = highConfidenceSkippedCount;
    const worker = async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++];
        try {
          const batchSchema: StrictJsonSchema = { ...CLIP_UNDERSTANDING_SCHEMA,
            properties: { candidates: { type: 'array', items: {
              type: 'object', additionalProperties: false,
              properties: { ...understandingProperties, candidateId: { type: 'string' } },
              required: [...UNDERSTANDING_KEYS, 'candidateId'] } } } };
          const result = await this.router.generate<{ candidates: ClipUnderstanding[] }>({
            role: 'clipUnderstanding', request: { schemaName: 'clip_understanding',
              schema: batchSchema, partialBatchField: 'candidates',
              cacheKey: batch.candidates.map((item) =>
                item.contentFingerprint || item.rangeKey).join(':'),
              systemPrompt: 'Create one grounded ClipUnderstanding per input, echo its candidateId exactly. ' +
                'The exact clip transcript is the source of truth. Context can clarify but cannot add ' +
                'unsupported claims. Use visual observations only when their evidenceRefs support them.',
              userPrompt: JSON.stringify(batch.evidences.map((evidence, index) =>
                onlineClipUnderstandingInput(evidence, batch.candidates[index].rangeKey,
                  batch.candidates[index]))),
              maxOutputTokens: 3500,
              local: { schemaName: 'local_clip_understanding', schema: batchSchema,
                partialBatchField: 'candidates', maxOutputTokens: 3600,
                systemPrompt: 'Create one grounded clip understanding per item. Exact clip transcript ' +
                  'is the only source for claims; nearby context only clarifies. Echo candidateId. ' +
                  'Keep every field concise and return JSON only with no explanation.',
                userPrompt: JSON.stringify(batch.evidences.map((evidence, index) =>
                  localClipUnderstandingInput(evidence, batch.candidates[index].rangeKey))) } }
          });
          batch.candidates.forEach((candidate, index) => {
            // Legacy test/providers without IDs are safe only when the full positional array is present.
            const item = result.data.candidates.find(value => value &&
              (value as ClipUnderstanding & { candidateId?: string }).candidateId === candidate.rangeKey) ??
              (result.data.candidates.length === batch.candidates.length &&
                result.data.candidates.every(value => !value || !('candidateId' in value))
                ? result.data.candidates[index] : null);
            const originalIndex = batch.indexes[index];
            try {
              const normalized = normalizeSchema(item, { type: 'object', additionalProperties: false,
                properties: understandingProperties, required: UNDERSTANDING_KEYS });
              validateSchema(normalized, { type: 'object', properties: understandingProperties,
                required: UNDERSTANDING_KEYS });
              understandings[originalIndex] = normalized as ClipUnderstanding;
              routesByCandidate[originalIndex] = result.metadata;
              decisionSources[originalIndex] = result.metadata.provider === 'ollama' ? 'OLLAMA' : 'LUNA';
            } catch (error) {
              failureCategories[originalIndex] = 'SCHEMA_FAILURE';
              countPerformance('schemaRepairCount'); failures.push('SCHEMA_FAILURE');
              this.logger.warn('ClipUnderstanding item ' + candidate.rangeKey + ': ' +
                (error instanceof Error ? error.message : 'invalid item'));
            }
          });
          routes.push(result.metadata);
          const context = performanceContext.getStore();
          if (context) {
            const inputChars = batch.evidences.reduce((total, evidence, index) => total +
              JSON.stringify(onlineClipUnderstandingInput(evidence,
                batch.candidates[index].rangeKey, batch.candidates[index])).length, 0);
            const attempt = result.metadata.attempts[result.metadata.attempts.length - 1];
            context.clipUnderstanding = { ...context.clipUnderstanding,
              provider: result.metadata.provider, model: result.metadata.model,
              success: true, inputChars: (context.clipUnderstanding.inputChars || 0) + inputChars,
              latencyMs: (context.clipUnderstanding.latencyMs || 0) + (attempt?.latencyMs || 0),
              outputTokens: (context.clipUnderstanding.outputTokens || 0) +
                (result.normalized?.outputTokens || 0), fallbackUsed: false };
          }
        } catch (error) {
          const failure = error instanceof LlmProviderError ? error.kind : 'SCHEMA_FAILURE';
          failures.push(failure);
          batch.indexes.forEach((originalIndex) => { failureCategories[originalIndex] = failure; });
          const context = performanceContext.getStore();
          if (context) {
            context.clipUnderstanding = { ...context.clipUnderstanding,
              provider: 'openai', model: 'gpt-5.6-luna', success: false,
              fallbackUsed: true, inputChars: (context.clipUnderstanding.inputChars || 0) +
                batch.evidences.reduce((total, evidence, index) => total +
                  JSON.stringify(onlineClipUnderstandingInput(evidence,
                    batch.candidates[index].rangeKey, batch.candidates[index])).length, 0),
              fallbackReason: failure };
          }
          this.logger.warn('Clip understanding batch used deterministic fallback: ' + failure);
        }
        completed += batch.candidates.length;
        if (onProgress) await onProgress(completed, candidates.length);
      }
    };
    const configuredConcurrency = Number(process.env.CLIP_UNDERSTANDING_CONCURRENCY ?? 1);
    const concurrency = Number.isFinite(configuredConcurrency)
      ? Math.max(1, Math.min(4, Math.floor(configuredConcurrency))) : 1;
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    return { understandings, route: routes[0] ?? null, failureCategory: failures[0] ?? '',
      routesByCandidate, failureCategories, decisionSources, highConfidenceSkippedCount,
      highConfidenceRejectedBy };
  }
}

export function calculateConfidence(evidence: ClipEvidence, understanding: ClipUnderstanding,
  generatedByModel: boolean, criticAccepted: boolean) {
  return roundScore(35 + Number(!!evidence.transcript) * 25 + Number(!!evidence.chapter) * 5 +
    Math.min(10, evidence.visualSignals.length * 2) + clampScore(understanding.confidence) * .15 +
    Number(generatedByModel) * 5 + Number(criticAccepted) * 5);
}

export function calculateGenerationQuality(candidate: Pick<ScoredClipCandidate,
  'generatedHookScore' | 'flowScore' | 'informationScore' | 'payoffScore'>,
  criticAccepted: boolean) {
  return roundScore(clampScore(candidate.generatedHookScore || 0) * .4 +
    clampScore(candidate.flowScore) * .2 + clampScore(candidate.informationScore) * .2 +
    clampScore(candidate.payoffScore) * .15 + Number(criticAccepted) * 5);
}
