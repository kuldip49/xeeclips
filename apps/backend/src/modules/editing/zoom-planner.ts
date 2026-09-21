import type { EditPlan, SubtitleEmphasis, TimedWord } from './edit-plan';
import type { AnalysisFrame } from './edit-analysis';
import type { CropWindow, VisualTrack } from './reframe.service';
import type { Shot } from './shot-classifier';
import type { SfxType } from './sfx-library';
import { createTimelineMapper, Cut } from './timeline-remap';

/**
 * Motion has to be felt to be worth anything, so the bands below are wide enough
 * for a push-in to read on a phone - but every level is still gated by the
 * subject/text safety search further down, which walks the scale back until the
 * face and any burned-in text survive the crop.
 */
export type ZoomIntensity = 'SUBTLE' | 'NORMAL' | 'STRONG' | 'VERY_STRONG';
export const ZOOM_INTENSITY_BANDS: Record<ZoomIntensity, { min: number; max: number }> = {
  // SUBTLE remains accepted for old persisted plans. New semantic events use
  // the three visible bands from the AI_EDITED camera policy.
  SUBTLE: { min: 1.1, max: 1.17 }, NORMAL: { min: 1.18, max: 1.24 },
  STRONG: { min: 1.26, max: 1.36 }, VERY_STRONG: { min: 1.32, max: 1.4 } };
// A push only reads as deliberate once the frame actually changes size on a
// phone. These are the *rendered* deltas render QA measures, not the planned
// ones: a move that plans 1.24 but renders 1.05 is a failed move (§13).
export const ZOOM_VISIBLE_DELTA: Record<ZoomIntensity, number> = {
  SUBTLE: .07, NORMAL: .12, STRONG: .18, VERY_STRONG: .24 };
// Above this the crop is tight enough that only a single dominant face in a
// close shot can survive it; everything else is capped one step lower.
export const ZOOM_TIGHT_SCALE = 1.32;
const TIGHT_ZOOM_SHOT_CLASSES = new Set(['SINGLE_SPEAKER', 'TALKING_HEAD']);
export const ZOOM_INTENSITIES: ZoomIntensity[] = ['SUBTLE', 'NORMAL', 'STRONG', 'VERY_STRONG'];
export function intensityFor(scale: number): ZoomIntensity {
  return scale >= ZOOM_INTENSITY_BANDS.VERY_STRONG.min - 1e-6 ? 'VERY_STRONG' :
    scale >= ZOOM_INTENSITY_BANDS.STRONG.min - 1e-6 ? 'STRONG' :
    scale >= ZOOM_INTENSITY_BANDS.NORMAL.min - 1e-6 ? 'NORMAL' : 'SUBTLE';
}

// IN pushes from the baseline frame toward the subject; OUT starts already tight
// and pulls back to reveal context. An OUT only ever begins on a hard visual
// discontinuity (the clip's first frame, a removed-silence cut, or a shot change)
// because that is the only place a frame can already be tight without popping.
export type ZoomKind = 'IN' | 'OUT';
export type ZoomAnchorKind = 'CLIP_START' | 'CUT' | 'SHOT_START';

// Luna picks the semantic beat (triggerText); these constants turn it into an
// exact envelope: start just after the word onset, peak near the stressed
// part of the word, hold while the beat continues, and return to 1.0.
export const ZOOM_TUNING = {
  // The move must already be under way when the word lands, so it begins
  // 130 ms BEFORE the word onset and peaks just after it: that lead plus a
  // 280 ms ramp puts the peak ~150 ms after the speaker says the word. The lead
  // is only ever shortened when the word sits that close to its own shot's
  // start - a push is never delayed past the word it belongs to.
  preOnsetSec: .13, maxPreOnsetSec: .18,
  rampInSec: .28, minHoldSec: .45, maxHoldSec: 1, rampOutSec: .34,
  // OUT events establish their tight frame instantly across the cut, hold it
  // while the tight read lands, then settle back.
  outHoldSec: .5, outRampSec: .42, outAnchorWindowSec: 1.2,
  // The safety search never walks a move below the bottom of the SUBTLE band:
  // a crop the viewer cannot perceive is not worth rendering at all.
  defaultScale: 1.2, strongScale: 1.3, veryStrongScale: 1.36,
  maxScale: 1.4, minScale: 1.1, minVisibleScale: 1.1,
  // Gap between complete envelopes. Local-peak suppression separately keeps
  // trigger words at least 2.2 seconds apart.
  // Five events leave room inside the strict 24-frame final-QA budget for a
  // baseline, peak and settled sample per zoom plus timeline anchors.
  minSpacingSec: .45, localPeakSpacingSec: 2.2, maxZooms: 5, peakSyncToleranceSec: .2,
  eventsPerSec: 1 / 7,
  // Below this length a clip carries at most one move; above it, at least two,
  // so a 30-45 s clip is never left with a single token push.
  twoEventMinDurationSec: 15,
  subjectMarginX: .15, subjectMarginTop: .25, minVisibleRatio: .98, minTextArea: .01
} as const;

/**
 * Why the camera moved. Motion without one of these is decoration, so an
 * operation that cannot be attributed to a beat is rejected outright (§20).
 */
export type ZoomSemanticCategory = 'STATISTIC' | 'REVEAL' | 'PUNCHLINE' | 'CONTRADICTION' |
  'EMOTION' | 'SPEAKER_SHIFT' | 'CONTEXT' | 'EMPHASIS';

const CATEGORY_PATTERNS: Array<[ZoomSemanticCategory, RegExp]> = [
  ['STATISTIC', /\b(statistic|stat|number|percent|figure|数|数字|metric|data|count|amount|dollars?|million|billion)\b/iu],
  ['REVEAL', /\b(reveal|reveals?|revealing|disclos|unveil|shows? that|turns out|payoff|answer|conclusion)\b/iu],
  ['PUNCHLINE', /\b(punchline|punch line|joke|humou?r|ironic|irony|deadpan|kicker|zinger)\b/iu],
  ['CONTRADICTION', /\b(contradict|contrary|however|but actually|opposite|disagree|pushback|rebuttal|denial|denies)\b/iu],
  ['EMOTION', /\b(emotion|emotional|anger|angry|fear|grief|joy|shock|surprise|surprising|reaction|reacts?|moved)\b/iu],
  ['SPEAKER_SHIFT', /\b(speaker (shift|change|switch)|second speaker|other speaker|interject|interrupt|hands? over)\b/iu],
  ['CONTEXT', /\b(context|environment|wider|broader|scene|room|surroundings|establish|two[- ]person|both speakers|screen|document)\b/iu]
];
const NUMBERISH = /(\d|\b(million|billion|trillion|percent|hundred|thousand|half|double|triple)\b)/iu;

/** Classifies the editorial reason Luna (or the deterministic path) gave. */
export function classifySemanticReason(reason: string, triggerText = '',
  kind: ZoomKind = 'IN'): ZoomSemanticCategory {
  for (const [category, pattern] of CATEGORY_PATTERNS)
    if (pattern.test(reason)) return category;
  if (NUMBERISH.test(triggerText)) return 'STATISTIC';
  return kind === 'OUT' ? 'CONTEXT' : 'EMPHASIS';
}

/**
 * Sound design follows the edit event, never the other way round (§14). A pull
 * back across a hard cut is a transition; a pull back inside the same scene is an
 * air pull; a push onto a number is a light stat hit, and only a STRONG push onto
 * a punchline or contradiction earns an accent.
 */
export function sfxTypeFor(kind: ZoomKind, category: ZoomSemanticCategory,
  intensity: ZoomIntensity, anchor: ZoomAnchorKind | null): SfxType {
  if (kind === 'OUT') return anchor === 'CUT' || anchor === 'SHOT_START' ? 'TRANSITION' : 'ZOOM_OUT';
  if (category === 'STATISTIC') return 'STAT_HIT';
  if (category === 'REVEAL') return 'REVEAL';
  if (intensity === 'STRONG' && (category === 'PUNCHLINE' || category === 'CONTRADICTION'))
    return 'IMPACT_LIGHT';
  return 'ZOOM_IN';
}

export type ZoomEvent = {
  // Always SEMANTIC_ZOOM: a camera move that is only a reframe or a shot change
  // is produced elsewhere and never enters this list, so zoom QA can count real
  // semantic motion without mistaking repositioning for emphasis (§12).
  motionKind: 'SEMANTIC_ZOOM';
  kind: ZoomKind; intensity: ZoomIntensity; semanticReason: string;
  semanticCategory: ZoomSemanticCategory; anchorKind: ZoomAnchorKind | null;
  sfxType: SfxType; sfxEnabled: boolean; sfxAtSec: number;
  triggerText: string; triggerTimestamp: number; triggerWordMid: number;
  phrase: string; wordStartSec: number; semanticScore: number; audioEnergyScore: number;
  combinedScore: number; reason: string; trackId: string | null; faceConfidence: number | null;
  faceLockValid: boolean;
  verificationFrameTimes: number[];
  startSec: number; zoomInEndSec: number; zoomOutStartSec: number; endSec: number;
  peakScale: number; scalePeak: number; targetScale: number; requestedScale: number;
  focusX: number; focusY: number;
  startFrame: number; endFrame: number; rampFrames: number; rampInFrames: number; rampOutFrames: number;
  zoomTriggeredOnStrongWord: boolean; zoomPeakSynced: boolean; zoomReturned: boolean;
  // The move is under way before the word is spoken, and the rendered scale
  // change QA must be able to measure for this intensity.
  zoomStartsBeforeWord: boolean; peakOffsetFromWordMs: number; minVisibleScaleDelta: number;
  subjectSafeDuringZoom: boolean; informationSafeDuringZoom: boolean; scaleReducedForSafety: boolean;
};
export type ZoomRejection = { triggerText: string; reason: string };

export type SemanticZoomCandidate = {
  word: string; phrase: string; timestamp: number; endSec: number;
  semanticScore: number; audioEnergyScore: number; combinedScore: number; reason: string;
};

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const center = (box: { x: number; y: number; w: number; h: number }) =>
  ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const STOP = new Set(['the', 'and', 'for', 'you', 'this', 'that', 'with', 'are', 'was', 'but',
  'not', 'its', 'they', 'just', 'like', 'so', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'it']);
const STRONG_WORDS = new Set(['never', 'always', 'only', 'first', 'last', 'best', 'worst',
  'biggest', 'secret', 'hidden', 'wrong', 'truth', 'proof', 'failed', 'failure', 'danger',
  'risk', 'warning', 'impossible', 'changed', 'forced', 'collapse', 'crisis', 'revealed']);
const CONTRADICTIONS = new Set(['however', 'instead', 'despite', 'although', 'opposite', 'actually']);
const EMOTIONAL = new Set(['love', 'hate', 'fear', 'angry', 'shocked', 'surprised', 'amazing',
  'terrible', 'devastating', 'exciting', 'unbelievable']);

/** Maximum meaningful camera beats a clip length can carry. It is a ceiling,
 * never a quota: candidates still have to clear semantic/energy thresholds. */
export function semanticZoomTarget(durationSec: number) {
  if (durationSec < 15) return 2;
  if (durationSec < 20) return 3;
  if (durationSec < 30) return 5;
  if (durationSec < 45) return 7;
  return 8;
}

/** Minimum useful coverage for people-led clips. This is deliberately separate
 * from semanticZoomTarget (the upper budget) and is always capped by real local
 * peaks, so it can never manufacture decorative motion. */
export function requiredSemanticZoomCount(durationSec: number, eligiblePeaks: number) {
  if (durationSec < 15 || eligiblePeaks < 2) return 0;
  const durationTarget = durationSec < 20 ? 2 : durationSec < 30 ? 3 :
    durationSec < 40 ? 4 : durationSec < 50 ? 5 : durationSec < 55 ? 5 : 6;
  return Math.min(durationTarget, eligiblePeaks, ZOOM_TUNING.maxZooms);
}

function semanticReasonFor(word: TimedWord, index: number, words: TimedWord[],
  emphasis: SubtitleEmphasis[]) {
  const token = normalize(word.text);
  const strong = emphasis.some((item) => item.strength === 'STRONG' &&
    Math.abs(item.startSec - word.start) <= .06);
  if (NUMBERISH.test(token)) return { score: 1, reason: 'statistic or number' };
  if (CONTRADICTIONS.has(token)) return { score: .94, reason: 'contradiction or turn' };
  if (EMOTIONAL.has(token)) return { score: .92, reason: 'emotional phrase' };
  if (STRONG_WORDS.has(token)) return { score: .9, reason: 'strong semantic word' };
  if (strong) return { score: .88, reason: 'strong transcript emphasis' };
  if (emphasis.some((item) => Math.abs(item.startSec - word.start) <= .06))
    return { score: .72, reason: 'semantic transcript emphasis' };
  const letters = token.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 4 && /^\p{Lu}/u.test(word.text) && index > 0)
    return { score: .7, reason: 'named entity' };
  if (/[!?]$/u.test(word.text)) return { score: .7, reason: 'sentence payoff' };
  if (/[.]$/u.test(word.text) && index > 2) return { score: .58, reason: 'sentence payoff' };
  if (letters.length >= 9 && !STOP.has(token)) return { score: .54, reason: 'key content word' };
  return { score: 0, reason: '' };
}

/** Finds local semantic/audio peaks rather than choosing one clip-global winner. */
export function detectSemanticZoomCandidates(words: TimedWord[], emphasis: SubtitleEmphasis[],
  from = -Infinity, to = Infinity): SemanticZoomCandidate[] {
  const inRange = words.filter((word) => word.start >= from && word.end <= to);
  const candidates = inRange.flatMap((word, index) => {
    const semantic = semanticReasonFor(word, index, inRange, emphasis);
    const audioEnergyScore = clamp(word.audioEnergyScore ?? 0, 0, 1);
    const combinedScore = semantic.score * .78 + audioEnergyScore * .22;
    if (semantic.score < .54 && combinedScore < .62) return [];
    const phraseWords = inRange.slice(Math.max(0, index - 2), Math.min(inRange.length, index + 3))
      .filter((item) => item.start >= word.start - 1.2 && item.end <= word.end + 1.2);
    return [{ word: word.text, phrase: phraseWords.map((item) => item.text).join(' '),
      timestamp: word.start, endSec: word.end, semanticScore: semantic.score,
      audioEnergyScore, combinedScore, reason: semantic.reason }];
  });
  // Non-max suppression collapses adjacent strong words into one intentional beat.
  const kept: SemanticZoomCandidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.combinedScore - a.combinedScore ||
    a.timestamp - b.timestamp)) {
    if (kept.some((item) => Math.abs(item.timestamp - candidate.timestamp) <
      ZOOM_TUNING.localPeakSpacingSec)) continue;
    kept.push(candidate);
  }
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    const target = semanticZoomTarget(to - from);
    if (kept.length > target) {
      const regionWidth = (to - from) / target;
      const regional = Array.from({ length: target }, (_, index) => kept
        .filter((item) => item.timestamp >= from + index * regionWidth &&
          item.timestamp < from + (index + 1) * regionWidth)
        .sort((a, b) => b.combinedScore - a.combinedScore)[0])
        .filter((item): item is SemanticZoomCandidate => Boolean(item));
      const selected = [...regional];
      for (const candidate of [...kept].sort((a, b) => b.combinedScore - a.combinedScore)) {
        if (selected.length >= target) break;
        if (!selected.includes(candidate)) selected.push(candidate);
      }
      return selected.sort((a, b) => a.timestamp - b.timestamp);
    }
  }
  return kept.sort((a, b) => a.timestamp - b.timestamp);
}

export function findTrigger(words: TimedWord[], triggerText: string, from: number, to: number) {
  const tokens = triggerText.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) return null;
  for (let index = 0; index < words.length; index++) {
    // Word starts may have been snapped to the audio onset (up to 250 ms).
    if (words[index].start < from - .3 || words[index].start > to + .3) continue;
    if (tokens.every((token, offset) => normalize(words[index + offset]?.text ?? '') === token))
      return words.slice(index, index + tokens.length);
  }
  return null;
}

// Chooses the stressed word inside a trigger phrase: emphasized first, then the longest content word.
function stressedWord(trigger: TimedWord[], emphasis: SubtitleEmphasis[]) {
  const emphasized = trigger.find((word) => emphasis.some((item) =>
    Math.abs(item.startSec - word.start) < .05));
  if (emphasized) return emphasized;
  return [...trigger].filter((word) => !STOP.has(normalize(word.text)))
    .sort((a, b) => normalize(b.text).length - normalize(a.text).length)[0] ?? trigger[0];
}

function visibleRatio(box: { x: number; y: number; w: number; h: number }, window: CropWindow) {
  const width = Math.max(0, Math.min(box.x + box.w, window.x + window.w) - Math.max(box.x, window.x));
  const height = Math.max(0, Math.min(box.y + box.h, window.y + window.h) - Math.max(box.y, window.y));
  return box.w * box.h > 0 ? width * height / (box.w * box.h) : 1;
}

// Source-normalized window visible at zoom `scale` with zoompan anchors.
export function zoomWindow(crop: CropWindow, scale: number, anchorX: number, anchorY: number): CropWindow {
  const u0 = (1 - 1 / scale) * anchorX;
  const v0 = (1 - 1 / scale) * anchorY;
  return { x: crop.x + u0 * crop.w, y: crop.y + v0 * crop.h, w: crop.w / scale, h: crop.h / scale };
}

function subjectsFor(frame: AnalysisFrame, shot: Shot | undefined, crop: CropWindow): VisualTrack[] {
  const faces = frame.faces.filter((face) => face.w * face.h >= .0015)
    .filter((face) => visibleRatio(face, crop) > .5)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  if (!faces.length) return frame.persons.filter((person) => visibleRatio(person, crop) > .5).slice(0, 1)
    .map((person) => ({ ...person, h: Math.min(person.h, person.w * 1.2) }));
  return shot?.shotClass === 'TWO_PERSON' ? faces.slice(0, 2) : faces.slice(0, 1);
}

const padded = (box: VisualTrack) => ({ x: box.x - box.w * ZOOM_TUNING.subjectMarginX,
  y: box.y - box.h * ZOOM_TUNING.subjectMarginTop,
  w: box.w * (1 + 2 * ZOOM_TUNING.subjectMarginX), h: box.h * (1 + ZOOM_TUNING.subjectMarginTop) });

export type ZoomPlanInput = {
  plan: EditPlan; cuts: Cut[]; words: TimedWord[]; fps: number;
  shots?: Shot[]; cropAt?: (t: number) => CropWindow; frames?: AnalysisFrame[];
  focalAt?: (t: number) => { x: number; y: number };
  scaleCap?: number; scaleFloor?: number; disabled?: boolean; finalDuration?: number;
  sfxDisabled?: boolean; sourceWidth?: number; sourceHeight?: number;
  zoomSuppressions?: Array<{ triggerTimestamp: number; reason: string }>;
};

export function planZoomEvents(input: ZoomPlanInput): { events: ZoomEvent[]; rejected: ZoomRejection[];
  candidates: SemanticZoomCandidate[]; eligibleEmphasisCount: number; eligibleSafeZoomCount: number;
  nominalRequiredZoomCount: number; effectiveRequiredZoomCount: number; requiredZoomCount: number;
  actualZoomCount: number; zeroZoomReason: 'HAS_SAFE_ZOOMS' | 'ZERO_ZOOM_JUSTIFIED' |
    'ZERO_ZOOM_CAUSED_BY_REPAIR_BUG'; zoomSuppressionReasons: string[];
  zoomCoverageValid: boolean } {
  const tuning = ZOOM_TUNING;
  const { plan, fps, words } = input;
  const mapper = createTimelineMapper(plan.clipStartSec, input.cuts);
  const finalDuration = input.finalDuration ?? mapper.point(plan.clipEndSec);
  const events: ZoomEvent[] = [];
  const rejected: ZoomRejection[] = [];
  const shots = input.shots ?? [];
  // Hard visual discontinuities on the final timeline: the only places a frame
  // may already be tight, because the change of image hides the jump.
  const anchors: Array<{ at: number; kind: ZoomAnchorKind }> = [
    { at: 0, kind: 'CLIP_START' as const },
    ...input.cuts.map((cut) => ({ at: mapper.point(cut.start), kind: 'CUT' as const })),
    ...shots.slice(1).map((shot) => ({ at: shot.start, kind: 'SHOT_START' as const }))
  ].filter((anchor) => anchor.at >= -1e-6 && anchor.at < finalDuration)
    .sort((a, b) => a.at - b.at);
  const candidates = detectSemanticZoomCandidates(words, plan.subtitleEmphasis,
    plan.clipStartSec, plan.clipEndSec);
  // Duration controls the ceiling, while local-peak scoring decides whether the
  // clip actually earns that many moves.
  const budget = Math.min(tuning.maxZooms, semanticZoomTarget(finalDuration));
  const planned = plan.operations
    .filter((operation) => operation.type === 'ZOOM' || operation.type === 'ZOOM_OUT')
    .sort((a, b) => a.startSec - b.startSec);
  const informationShare = shots.filter((shot) => shot.informationMode)
    .reduce((sum, shot) => sum + shot.end - shot.start, 0) / Math.max(.01, finalDuration);
  const brollShare = shots.filter((shot) => shot.shotClass === 'B_ROLL')
    .reduce((sum, shot) => sum + shot.end - shot.start, 0) / Math.max(.01, finalDuration);
  const peopleShare = shots.filter((shot) => ['SINGLE_SPEAKER', 'TALKING_HEAD', 'TWO_PERSON']
    .includes(shot.shotClass)).reduce((sum, shot) => sum + shot.end - shot.start, 0) /
    Math.max(.01, finalDuration);
  const coverageApplicable = peopleShare >= .5 && informationShare < .5 && brollShare < .5;
  // The duration table is a nominal editorial target, not a quota. Candidate
  // detection runs before crop/shot safety is known, so capping here by the raw
  // semantic peaks caused safe clips to be rejected later as e.g. 4/6. Keep a
  // provisional target for generation, then calculate the effective required
  // count from the peaks that actually survive every structural safety check.
  const nominalRequiredZoomCount = coverageApplicable ?
    requiredSemanticZoomCount(finalDuration, Number.POSITIVE_INFINITY) : 0;
  const provisionalRequiredZoomCount = coverageApplicable ?
    Math.min(nominalRequiredZoomCount, candidates.length) : 0;
  // Callers without shot analysis retain the legacy deterministic two-peak
  // fallback; classified information/B-roll clips do not receive quota motion.
  const generationTarget = coverageApplicable ? provisionalRequiredZoomCount :
    shots.length || candidates.length < 4 ? 0 : Math.min(2, candidates.length);
  const plannedPushes = planned.filter((operation) => operation.type === 'ZOOM').length;
  const shouldGenerate = coverageApplicable ? (planned.length === 0 ||
    plannedPushes > 0 && plannedPushes < generationTarget) : planned.length === 0 && generationTarget > 0;
  const generated = (shouldGenerate ? candidates : []).filter((candidate) =>
    !planned.some((operation) => {
    const match = findTrigger(words, operation.triggerText ?? '', operation.startSec, operation.endSec);
    return match?.some((word) => Math.abs(word.start - candidate.timestamp) < .08) ||
      Math.abs(operation.startSec - candidate.timestamp) < tuning.localPeakSpacingSec;
  })).map((candidate) => {
    const strong = candidate.semanticScore >= .88 || candidate.combinedScore >= .86;
    return { type: 'ZOOM' as const, startSec: Math.max(plan.clipStartSec, candidate.timestamp - .25),
      endSec: Math.min(plan.clipEndSec, candidate.endSec + 1.05), reason: candidate.reason,
      scale: strong ? tuning.strongScale : tuning.defaultScale, focusX: null, focusY: null,
      target: 'FACE' as const, words: [], intensity: strong ? 'STRONG' as const : 'NORMAL' as const,
      triggerText: candidate.word };
  });
  const operations = [...planned, ...generated].sort((a, b) => a.startSec - b.startSec);
  for (const operation of operations) {
    const label = operation.triggerText ?? '';
    const kind: ZoomKind = operation.type === 'ZOOM_OUT' ? 'OUT' : 'IN';
    if (input.disabled) { rejected.push({ triggerText: label, reason: 'ZOOM_DISABLED_BY_REPAIR' }); continue; }
    if (events.length >= budget) { rejected.push({ triggerText: label, reason: 'MAX_ZOOMS' }); continue; }
    // Motion must support meaning: an operation that names no editorial beat is
    // decoration, and decoration is never rendered.
    const semanticReason = (operation.reason ?? '').trim().slice(0, 160);
    if (!semanticReason) { rejected.push({ triggerText: label, reason: 'NO_SEMANTIC_REASON' }); continue; }
    const trigger = findTrigger(words, label, operation.startSec, operation.endSec);
    // Legacy plans without trigger text keep their own timing.
    const stressed = trigger ? stressedWord(trigger, plan.subtitleEmphasis) : null;
    if (!trigger && label.trim()) { rejected.push({ triggerText: label, reason: 'TRIGGER_NOT_FOUND' }); continue; }
    // Phrase operations are anchored to the stressed word itself, not the first
    // word of the phrase. This is the timestamp the viewer hears as the beat.
    const sourceOnset = stressed?.start ?? (trigger ? trigger[0].start : operation.startSec);
    if (mapper.removed(sourceOnset, sourceOnset + .01) || sourceOnset < plan.clipStartSec ||
      sourceOnset > plan.clipEndSec) { rejected.push({ triggerText: label, reason: 'TRIGGER_REMOVED' }); continue; }
    const onset = mapper.point(sourceOnset);
    const localSuppression = input.zoomSuppressions?.find((item) =>
      Math.abs(item.triggerTimestamp - onset) <= .08);
    if (localSuppression) {
      rejected.push({ triggerText: label, reason: `LOCAL_REPAIR_${localSuppression.reason}` });
      continue;
    }
    const wordMid = stressed ? (mapper.point(stressed.start) + mapper.point(stressed.end)) / 2 : onset;
    const triggerEnd = stressed ? mapper.point(stressed.end) :
      trigger ? mapper.point(trigger[trigger.length - 1].end) : mapper.point(operation.endSec);
    const strong = Boolean(trigger && plan.subtitleEmphasis.some((item) => item.strength === 'STRONG' &&
      trigger.some((word) => Math.abs(word.start - item.startSec) < .05)));
    const category = classifySemanticReason(semanticReason, label, kind);
    // Luna's requested scale decides the band; a STRONG emphasized word may push
    // into the strong band, everything else is capped at the normal one.
    const requested = operation.scale ?? tuning.defaultScale;
    const requestedIntensity: ZoomIntensity = operation.intensity &&
      ZOOM_INTENSITIES.includes(operation.intensity) ? operation.intensity : intensityFor(requested);
    // Strong framing is only safe when a strong emphasis actually justifies it.
    const allowed: ZoomIntensity = ['STRONG', 'VERY_STRONG'].includes(requestedIntensity) && !strong ?
      'NORMAL' : requestedIntensity;
    const band = ZOOM_INTENSITY_BANDS[allowed];
    let scale = clamp(operation.scale ?? (allowed === 'VERY_STRONG' ? tuning.veryStrongScale :
      allowed === 'STRONG' ? tuning.strongScale :
      allowed === 'SUBTLE' ? band.min + .03 : tuning.defaultScale), band.min, band.max);
    if (input.scaleFloor) scale = Math.max(scale, Math.min(band.max, input.scaleFloor));
    if (input.scaleCap) scale = Math.min(scale, input.scaleCap);
    scale = clamp(scale, tuning.minScale, tuning.maxScale);
    // The tightest band is held back until the shot is known: only a single
    // dominant speaker in a close shot can carry a crop past ZOOM_TIGHT_SCALE
    // with forehead and chin intact (§7).
    const requestedTight = scale;
    scale = Math.min(scale, ZOOM_TIGHT_SCALE);
    let targetScale = scale;

    let anchorKind: ZoomAnchorKind | null = null;
    let start: number;
    let rampInSec: number;
    let hold: number;
    let rampOutSec: number;
    if (kind === 'OUT') {
      // The tight frame has to be established by a change of image, so snap back
      // to the nearest discontinuity shortly before the beat.
      const anchor = [...anchors].reverse().find((item) =>
        item.at <= onset + .05 && onset - item.at <= tuning.outAnchorWindowSec);
      if (!anchor) { rejected.push({ triggerText: label, reason: 'ZOOM_OUT_NO_ANCHOR' }); continue; }
      anchorKind = anchor.kind;
      start = anchor.at;
      // One frame of ramp: instant across the discontinuity, never a visible pop.
      rampInSec = 1 / fps;
      rampOutSec = tuning.outRampSec;
      // Hold the tight frame at least until the beat itself lands.
      hold = Math.max(tuning.outHoldSec, onset - start);
    } else {
      // Lead the word: the push has to be moving by the time it is spoken, so it
      // starts 80-180 ms early and is only pulled in when the clip (or the shot
      // it sits in) has no room before the onset - never delayed past it.
      const shotStart = shots.find((item) => onset >= item.start && onset < item.end)?.start ?? 0;
      const room = Math.max(0, onset - Math.max(0, shotStart));
      if (trigger && room < .12) {
        rejected.push({ triggerText: label, reason: 'NO_WORD_LEAD_IN' });
        continue;
      }
      const lead = trigger ? clamp(Math.min(tuning.preOnsetSec, room), 0, tuning.maxPreOnsetSec) : 0;
      start = Math.max(0, onset - lead);
      rampInSec = tuning.rampInSec;
      rampOutSec = tuning.rampOutSec;
      hold = clamp(triggerEnd - (start + rampInSec) + .25, tuning.minHoldSec, tuning.maxHoldSec);
    }
    const peak = start + rampInSec;
    // The envelope must finish before the next cut or shot change; shorten the hold if needed.
    const shotEnd = shots.find((shot) => start >= shot.start && start < shot.end)?.end ?? Infinity;
    const limit = Math.min(finalDuration - .4, shotEnd - .05, ...input.cuts
      .map((cut) => mapper.point(cut.start)).filter((at) => at > start + .05).map((at) => at - .05));
    if (peak + hold + rampOutSec > limit) hold = limit - peak - rampOutSec;
    if (hold < .15) {
      rejected.push({ triggerText: label, reason: limit >= finalDuration - .4 ? 'TOO_CLOSE_TO_END' : 'NO_ROOM_BEFORE_CUT' });
      continue;
    }
    const end = peak + hold + rampOutSec;
    const previous = events[events.length - 1];
    if (previous && start - previous.endSec < tuning.minSpacingSec) {
      rejected.push({ triggerText: label, reason: 'TOO_CLOSE_TO_PREVIOUS_ZOOM' }); continue;
    }
    const covering = shots.filter((shot) => shot.start < end && shot.end > start);
    if (covering.length > 1) { rejected.push({ triggerText: label, reason: 'CROSSES_SHOT_BOUNDARY' }); continue; }
    const shot = covering[0];
    if (shot && !shot.zoomAllowed) {
      rejected.push({ triggerText: label, reason: shot.informationMode ? 'INFORMATION_SHOT' : `SHOT_${shot.shotClass}` });
      continue;
    }
    // Anchor on the subject and verify it stays inside the zoomed window.
    let focusX = .5, focusY = .5;
    let subjectSafe = true;
    let reduced = false;
    let trackId: string | null = null;
    let faceConfidence: number | null = null;
    let faceLockValid = true;
    const near = (margin: number) => (input.frames ?? []).filter((frame) => {
      if (mapper.removed(frame.t, frame.t + .001)) return false;
      const t = mapper.point(frame.t);
      return t >= start - margin && t <= end + margin && (!shot || (t >= shot.start && t < shot.end));
    });
    // Sparse detections may have no sample inside the envelope; use the closest ones.
    let frames = near(.15);
    if (!frames.length) frames = near(1.5);
    if (input.cropAt && frames.length) {
      const crop = input.cropAt(peak);
      const targetFrame = [...frames].sort((a, b) => Math.abs(a.t - sourceOnset) -
        Math.abs(b.t - sourceOnset))[0];
      const targetCrop = input.cropAt(mapper.point(targetFrame.t));
      const targetFaces = targetFrame.faces.filter((face) => visibleRatio(face, targetCrop) > .5);
      const cropCenter = targetCrop.x + targetCrop.w / 2;
      // Mouth activity leads; continuity with the already-composed crop and face
      // confidence break ties. Area is deliberately a weak signal so the largest
      // listener does not steal the punch-in.
      const chosen = [...targetFaces].sort((a, b) => {
        const score = (face: VisualTrack) => (face.mouthActivity ?? 0) * .5 +
          (face.confidence ?? .5) * .15 + Math.min(1, face.w * face.h / .08) * .1 +
          Math.max(0, 1 - Math.abs(center(face).x - cropCenter) / Math.max(.01, targetCrop.w)) * .25;
        return score(b) - score(a);
      })[0] ?? subjectsFor(targetFrame, shot, targetCrop)[0];
      trackId = chosen?.trackId ?? null;
      faceConfidence = chosen ? Number((chosen.mouthActivity != null ?
        Math.min(1, .55 + chosen.mouthActivity * .4) : chosen.confidence ??
          (targetFaces.length <= 1 ? .75 : .55)).toFixed(3)) : null;
      const chosenCenter = chosen ? center(chosen) : null;
      const lockedSubjectsFor = (frame: AnalysisFrame, atCrop: CropWindow) => {
        const visible = frame.faces.filter((face) => visibleRatio(face, atCrop) > .5);
        if (trackId) return visible.filter((face) => face.trackId === trackId);
        if (chosenCenter && visible.length) {
          const nearest = [...visible].sort((a, b) =>
            Math.hypot(center(a).x - chosenCenter.x, center(a).y - chosenCenter.y) -
            Math.hypot(center(b).x - chosenCenter.x, center(b).y - chosenCenter.y))[0];
          return Math.hypot(center(nearest).x - chosenCenter.x, center(nearest).y - chosenCenter.y) <= .2 ?
            [nearest] : [];
        }
        return subjectsFor(frame, shot, atCrop).slice(0, 1);
      };
      const lockedSamples = frames.filter((frame) =>
        lockedSubjectsFor(frame, input.cropAt!(mapper.point(frame.t))).length > 0).length;
      const trackStability = chosen ? lockedSamples / frames.length : 0;
      faceLockValid = !chosen || trackStability >= .6;
      if (!faceLockValid) {
        scale = Math.min(scale, ZOOM_INTENSITY_BANDS.NORMAL.max);
        targetScale = scale; reduced = true;
      }
      // VERY_STRONG is reserved for a stable, single dominant face and a source
      // with enough pixels to survive the crop. A two-person semantic beat stays
      // a moderate temporary punch-in and returns to the pair composition.
      const enoughResolution = (input.sourceWidth ?? 0) >= 720 && (input.sourceHeight ?? 0) >= 720;
      const veryStrongSafe = shot && !shot.informationMode && shot.faceCount <= 1 &&
        TIGHT_ZOOM_SHOT_CLASSES.has(shot.shotClass) && trackStability >= .75 && enoughResolution;
      if (kind === 'IN' && requestedTight > scale && veryStrongSafe) {
        scale = requestedTight; targetScale = requestedTight;
      }
      if (shot?.shotClass === 'TWO_PERSON') {
        scale = Math.min(scale, ZOOM_INTENSITY_BANDS.NORMAL.max);
        targetScale = Math.min(targetScale, ZOOM_INTENSITY_BANDS.NORMAL.max);
      }
      if (requestedIntensity === 'VERY_STRONG' && !veryStrongSafe) {
        scale = Math.min(scale, ZOOM_INTENSITY_BANDS.STRONG.min);
        targetScale = scale; reduced = true;
      }
      const subjects = frames.flatMap((frame) =>
        lockedSubjectsFor(frame, input.cropAt!(mapper.point(frame.t))));
      if (subjects.length || frames.some((frame) => frame.textBoxes.length)) {
        const left = Math.min(...subjects.map((box) => box.x));
        const right = Math.max(...subjects.map((box) => box.x + box.w));
        const top = Math.min(...subjects.map((box) => box.y));
        const bottom = Math.max(...subjects.map((box) => box.y + box.h));
        // Without a detected subject the zoom stays centred.
        const fu = subjects.length ? ((left + right) / 2 - crop.x) / crop.w : .5;
        const eye = subjects.length ? (top + (bottom - top) * .4 - crop.y) / crop.h : .45;
        const safeAt = (candidate: number, ax: number, ay: number) => frames.every((frame) => {
          const t = mapper.point(frame.t);
          const crop = input.cropAt!(t);
          const window = zoomWindow(crop, candidate, ax, ay);
          // Large burned-in text that is readable before the zoom must stay readable.
          const texts = frame.textBoxes.filter((box) => box.w * box.h >= tuning.minTextArea &&
            visibleRatio(box, crop) >= .9);
          return lockedSubjectsFor(frame, crop).every((box) =>
            visibleRatio(padded(box), window) >= tuning.minVisibleRatio) &&
            texts.every((box) => visibleRatio(box, window) >= .9);
        });
        const anchorsFor = (candidate: number) => ({
          x: clamp((fu - 1 / (2 * candidate)) / (1 - 1 / candidate), 0, 1),
          y: clamp((eye - .38 / candidate) / (1 - 1 / candidate), 0, 1) });
        const safeAtSubjectsOnly = (candidate: number) => {
          const anchor = anchorsFor(candidate);
          return frames.every((frame) => {
            const t = mapper.point(frame.t);
            const window = zoomWindow(input.cropAt!(t), candidate, anchor.x, anchor.y);
            return lockedSubjectsFor(frame, input.cropAt!(t)).every((box) =>
              visibleRatio(padded(box), window) >= tuning.minVisibleRatio);
          });
        };
        subjectSafe = false;
        for (let candidate = scale; candidate >= tuning.minVisibleScale - 1e-6; candidate -= .02) {
          const anchor = anchorsFor(candidate);
          if (safeAt(candidate, anchor.x, anchor.y)) {
            reduced = candidate < scale - 1e-6;
            scale = Number(candidate.toFixed(3)); focusX = anchor.x; focusY = anchor.y;
            subjectSafe = true;
            break;
          }
        }
        if (!subjectSafe) {
          rejected.push({ triggerText: label, reason: safeAtSubjectsOnly(scale) ? 'TEXT_UNSAFE' : 'SUBJECT_UNSAFE' });
          continue;
        }
      }
    } else if (input.focalAt) {
      const focus = input.focalAt((start + end) / 2);
      focusX = focus.x; focusY = focus.y;
    }
    const startFrame = Math.round(start * fps);
    const rampInFrames = Math.max(1, Math.round(rampInSec * fps));
    const rampOutFrames = Math.max(1, Math.round(rampOutSec * fps));
    const endFrame = Math.round(end * fps);
    const intensity = intensityFor(scale);
    const scored = candidates.find((candidate) => Math.abs(candidate.timestamp - sourceOnset) < .08);
    // A pull back is scored where the motion begins; a push is scored on the
    // word that triggered it (§15).
    const sfxAtSec = kind === 'OUT' ? (endFrame - rampOutFrames) / fps : startFrame / fps;
    events.push({ motionKind: 'SEMANTIC_ZOOM',
      kind, intensity, semanticReason, semanticCategory: category, anchorKind,
      sfxType: sfxTypeFor(kind, category, intensity, anchorKind),
      sfxEnabled: input.sfxDisabled !== true, sfxAtSec,
      triggerText: label, triggerTimestamp: onset, triggerWordMid: wordMid,
      phrase: scored?.phrase ?? trigger?.map((word) => word.text).join(' ') ?? label,
      wordStartSec: onset, semanticScore: scored?.semanticScore ?? (strong ? .88 : .65),
      audioEnergyScore: scored?.audioEnergyScore ?? stressed?.audioEnergyScore ?? 0,
      combinedScore: scored?.combinedScore ?? (strong ? .8 : .6), reason: semanticReason,
      trackId, faceConfidence, faceLockValid,
      verificationFrameTimes: [-.3, -.1, 0, .2, .6].map((offset) =>
        Number(clamp(onset + offset, 0, finalDuration - 1 / fps).toFixed(3))),
      startSec: startFrame / fps, zoomInEndSec: (startFrame + rampInFrames) / fps,
      zoomOutStartSec: (endFrame - rampOutFrames) / fps, endSec: endFrame / fps,
      peakScale: Number(scale.toFixed(3)), scalePeak: Number(scale.toFixed(3)),
      targetScale: Number(targetScale.toFixed(3)),
      requestedScale: requested, focusX, focusY,
      startFrame, endFrame, rampFrames: rampInFrames, rampInFrames, rampOutFrames,
      zoomTriggeredOnStrongWord: Boolean(stressed && (strong || plan.subtitleEmphasis.some((item) =>
        Math.abs(item.startSec - stressed.start) < .05) || normalize(stressed.text).length >= 4)),
      // A pull back peaks at its own start, so peak sync only constrains a push.
      zoomPeakSynced: kind === 'OUT' ? true :
        Math.abs((startFrame + rampInFrames) / fps - wordMid) <= tuning.peakSyncToleranceSec,
      zoomReturned: endFrame - rampOutFrames > startFrame + rampInFrames,
      // A push that begins after its word has already been spoken is late, not
      // emphatic; a pull back is established on its anchor instead (§6).
      zoomStartsBeforeWord: kind === 'OUT' || !trigger || startFrame / fps <= onset + 1e-6,
      peakOffsetFromWordMs: Math.round(((startFrame + rampInFrames) / fps - onset) * 1000),
      minVisibleScaleDelta: ZOOM_VISIBLE_DELTA[intensity],
      subjectSafeDuringZoom: subjectSafe, informationSafeDuringZoom: !shot?.informationMode,
      scaleReducedForSafety: reduced });
  }
  const eligibleEmphasisCount = candidates.length;
  const eligibleSafeZoomCount = events.length;
  const effectiveRequiredZoomCount = coverageApplicable ?
    Math.min(nominalRequiredZoomCount, eligibleSafeZoomCount) : 0;
  const requiredZoomCount = effectiveRequiredZoomCount;
  const actualZoomCount = events.length;
  const locallySuppressed = Boolean(input.zoomSuppressions?.length);
  const zeroZoomReason = events.length ? 'HAS_SAFE_ZOOMS' : locallySuppressed && candidates.length ?
    'ZERO_ZOOM_CAUSED_BY_REPAIR_BUG' : 'ZERO_ZOOM_JUSTIFIED';
  const zoomSuppressionReasons = [...new Set(rejected.map((item) => item.reason))];
  const zoomCoverageValid = (!coverageApplicable || actualZoomCount >= effectiveRequiredZoomCount) &&
    zeroZoomReason !== 'ZERO_ZOOM_CAUSED_BY_REPAIR_BUG';
  return { events, rejected, candidates, eligibleEmphasisCount, eligibleSafeZoomCount,
    nominalRequiredZoomCount, effectiveRequiredZoomCount, requiredZoomCount, actualZoomCount,
    zeroZoomReason, zoomSuppressionReasons, zoomCoverageValid };
}

/**
 * Eased envelope per event (§6): the push in uses an ease-out so the motion is
 * felt immediately and settles into the hold, and the return uses a smoothstep
 * whose flat tail sets the camera down on the baseline rather than stopping on it.
 * A pull back is the same shape with a one-frame ramp in, established across the
 * cut it is anchored to.
 */
const easeIn = (u: string) => `(${u})*(2-(${u}))`;
const easeOut = (d: string) => `(${d})*(${d})*(3-2*(${d}))`;

export function zoomExpression(events: ZoomEvent[]) {
  const terms = events.map((event) => {
    const amplitude = (event.peakScale - 1).toFixed(3);
    const down = `max(0\\,min(1\\,(${event.endFrame}-on)/${event.rampOutFrames}))`;
    // A pull back is already tight on its very first frame - the discontinuity it
    // is anchored to is what hides the change - so it has no ramp in at all.
    const rise = event.kind === 'OUT' ? `gte(on\\,${event.startFrame})` :
      easeIn(`max(0\\,min(1\\,(on-${event.startFrame})/${event.rampInFrames}))`);
    return `${amplitude}*min(${rise}\\,${easeOut(down)})`;
  });
  return terms.length ? `1+${terms.join('+')}` : '1';
}

export function zoomAnchorExpression(events: ZoomEvent[], axis: 'focusX' | 'focusY') {
  return events.reduceRight((next, event) =>
    `if(between(on\\,${event.startFrame}\\,${event.endFrame})\\,` +
    `${event[axis].toFixed(4)}\\,${next})`, '0.5');
}

// Evaluates the rendered zoom envelope at a final-timeline instant.
export function zoomScaleAt(events: ZoomEvent[], t: number, fps: number) {
  const frame = Math.round(t * fps);
  return 1 + events.reduce((sum, event) => {
    const up = clamp((frame - event.startFrame) / event.rampInFrames, 0, 1);
    const rise = event.kind === 'OUT' ? (frame >= event.startFrame ? 1 : 0) : up * (2 - up);
    const down = clamp((event.endFrame - frame) / event.rampOutFrames, 0, 1);
    return sum + (event.peakScale - 1) * Math.min(rise, down * down * (3 - 2 * down));
  }, 0);
}
