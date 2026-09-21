import type { AnalysisFrame, EditAnalysis } from './edit-analysis';
import type { EditedTimeline } from './edit-timeline';
import { timelineMapper } from './edit-timeline';

export type ShotClass = 'SINGLE_SPEAKER' | 'TALKING_HEAD' | 'TWO_PERSON' | 'MULTI_SPEAKER' |
  'GROUP_SHOT' | 'WIDE_SHOT' | 'SCREEN_WEB' | 'WEBPAGE' | 'ARTICLE' | 'DOCUMENT' | 'CHART' |
  'GRAPH' | 'INFOGRAPHIC' | 'PRESENTATION' | 'SCREEN_RECORDING' | 'DEMONSTRATION' |
  'REACTION' | 'PRODUCT' | 'B_ROLL' | 'FULL_FRAME_INFORMATION' | 'OTHER';
// FILL crops the source into the viewport; FIT keeps the whole source frame
// visible over a soft blurred fill.
export type ShotLayout = 'FILL' | 'FIT';
export type ShotFrameMode = 'FACE_SINGLE' | 'FACE_PAIR' | 'INFORMATION_REGION' |
  'SCREEN_CONTENT' | 'BROLL_COMPOSITION' | 'SOURCE_COMPOSITION';
export type Shot = {
  sourceStart: number; sourceEnd: number; start: number; end: number;
  shotClass: ShotClass; frameMode: ShotFrameMode; layout: ShotLayout; zoomAllowed: boolean;
  informationMode: boolean; faceCount: number; personCount: number;
  primaryFaceArea: number; textCoverage: number; sampleCount: number; reason: string;
};

export const INFORMATION_CLASSES = new Set<ShotClass>(['SCREEN_WEB', 'WEBPAGE', 'ARTICLE',
  'DOCUMENT', 'CHART', 'GRAPH', 'INFOGRAPHIC', 'PRESENTATION', 'SCREEN_RECORDING',
  'DEMONSTRATION', 'PRODUCT', 'FULL_FRAME_INFORMATION']);
const PEOPLE_FILL = new Set<ShotClass>(['SINGLE_SPEAKER', 'TALKING_HEAD', 'REACTION']);

export function frameModeFor(shotClass: ShotClass, informationMode: boolean): ShotFrameMode {
  if (shotClass === 'SCREEN_RECORDING' || shotClass === 'SCREEN_WEB') return 'SCREEN_CONTENT';
  if (informationMode) return 'INFORMATION_REGION';
  if (shotClass === 'SINGLE_SPEAKER' || shotClass === 'TALKING_HEAD' || shotClass === 'REACTION')
    return 'FACE_SINGLE';
  if (shotClass === 'TWO_PERSON' || shotClass === 'MULTI_SPEAKER') return 'FACE_PAIR';
  if (shotClass === 'B_ROLL' || shotClass === 'WIDE_SHOT' || shotClass === 'DEMONSTRATION' ||
    shotClass === 'PRODUCT') return 'BROLL_COMPOSITION';
  return 'SOURCE_COMPOSITION';
}

export const SHOT_TUNING = { minFaceArea: .0015, minPersonArea: .02,
  // Text boxes centred below this line are treated as burned-in captions/tickers.
  captionBandY: .74, infoCoverage: .1, screenCoverage: .06, preserveCoverage: .04,
  talkingHeadFaceArea: .03, speakerFaceArea: .008, dominantFaceRatio: 2.2,
  pairFitShare: .8, infoOcrWords: 12 } as const;

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

function informationCoverage(frame: AnalysisFrame) {
  if (!frame.textBoxes.length) return frame.textCoverage;
  return Math.min(1, frame.textBoxes.filter((box) => box.y + box.h / 2 < SHOT_TUNING.captionBandY)
    .reduce((sum, box) => sum + box.w * box.h, 0));
}

function informationClass(text: string, coverage: number): ShotClass {
  const value = text.toLowerCase();
  const words = value.match(/[\p{L}]{2,}/gu) ?? [];
  const numbers = value.match(/\d+(?:[.,]\d+)?%?/gu) ?? [];
  if (/https?:|www\.|\.com\b|\.org\b|\.gov\b|search|subscribe|sign in|login/u.test(value)) return 'WEBPAGE';
  if (numbers.length >= 4 && numbers.length >= words.length * .25) return 'CHART';
  if (/(^|\s)(def|function|const|return|import|class)\s/u.test(value)) return 'SCREEN_RECORDING';
  if (words.length >= 35) return coverage >= .25 ? 'DOCUMENT' : 'ARTICLE';
  if (words.length > 0 && words.length <= 12 && coverage >= .1) return 'PRESENTATION';
  return 'FULL_FRAME_INFORMATION';
}

export function classifyFrames(frames: AnalysisFrame[], cropWidth: number, options: {
  preserveInformation?: boolean; ocrText?: string } = {}) {
  const tuning = SHOT_TUNING;
  const faceSets = frames.map((frame) => frame.faces.filter((face) => face.w * face.h >= tuning.minFaceArea)
    .sort((a, b) => b.w * b.h - a.w * a.h));
  const personSets = frames.map((frame) => frame.persons.filter((person) =>
    person.w * person.h >= tuning.minPersonArea));
  const faceCount = median(faceSets.map((faces) => faces.length));
  const personCount = median(personSets.map((people) => people.length));
  const primaryFaceArea = median(faceSets.filter((faces) => faces.length)
    .map((faces) => faces[0].w * faces[0].h));
  const ocrCoverage = Math.max(0, ...frames.map((frame) => frame.ocrCoverage ?? 0));
  const coverage = Math.max(median(frames.map(informationCoverage)), ocrCoverage);
  const frameText = [...new Set(frames.flatMap((frame) => frame.ocrLines))].join(' ');
  const text = `${frameText} ${options.ocrText ?? ''}`;
  // Only frame-local OCR (dense analysis) counts as evidence of an information shot.
  const ocrWords = (frameText.match(/[\p{L}]{2,}/gu) ?? []).length;
  const pairShare = faceSets.filter((faces) => faces.length >= 2).map((faces) => {
    const pair = faces.slice(0, 2);
    return Math.max(...pair.map((face) => face.x + face.w)) - Math.min(...pair.map((face) => face.x));
  });
  const pairFits = pairShare.length > 0 && pairShare.filter((width) => width <= cropWidth * .9).length /
    pairShare.length >= tuning.pairFitShare;
  const dominance = faceSets.filter((faces) => faces.length >= 2).map((faces) =>
    faces[0].w * faces[0].h / Math.max(1e-6, faces[1].w * faces[1].h));
  const dominant = dominance.length > 0 && median(dominance) >= tuning.dominantFaceRatio;

  let shotClass: ShotClass;
  let reason: string;
  if (!frames.length) { shotClass = 'OTHER'; reason = 'NO_ANALYSIS_SAMPLES'; }
  else if ((coverage >= tuning.infoCoverage || ocrWords >= tuning.infoOcrWords) &&
    (faceCount === 0 || primaryFaceArea < .02)) {
    shotClass = informationClass(text, coverage);
    reason = `TEXT_COVERAGE_${coverage.toFixed(3)}_OCR_WORDS_${ocrWords}`;
  } else if (coverage >= tuning.screenCoverage && faceCount <= 1 && primaryFaceArea < .012) {
    shotClass = 'SCREEN_RECORDING'; reason = 'TEXT_WITH_SMALL_OR_NO_FACE';
  } else if (faceCount >= 3) { shotClass = 'GROUP_SHOT'; reason = 'THREE_OR_MORE_FACES'; }
  else if (faceCount === 2) {
    shotClass = dominant ? 'SINGLE_SPEAKER' : 'TWO_PERSON';
    reason = dominant ? 'DOMINANT_FOREGROUND_FACE' : 'TWO_COMPARABLE_FACES';
  } else if (faceCount === 1) {
    shotClass = primaryFaceArea >= tuning.talkingHeadFaceArea ? 'TALKING_HEAD' :
      primaryFaceArea >= tuning.speakerFaceArea ? 'SINGLE_SPEAKER' : 'WIDE_SHOT';
    reason = `ONE_FACE_AREA_${primaryFaceArea.toFixed(3)}`;
  } else if (personCount >= 3) { shotClass = 'GROUP_SHOT'; reason = 'THREE_OR_MORE_PEOPLE'; }
  else if (personCount === 2) { shotClass = 'TWO_PERSON'; reason = 'TWO_PEOPLE_NO_FACES'; }
  else if (personCount === 1) {
    const heights = personSets.filter((people) => people.length).map((people) => people[0].h);
    shotClass = median(heights) >= .45 ? 'SINGLE_SPEAKER' : 'WIDE_SHOT';
    reason = 'ONE_PERSON_NO_FACE';
  } else if (coverage >= tuning.preserveCoverage) {
    shotClass = informationClass(text, coverage); reason = 'TEXT_WITHOUT_PEOPLE';
  } else { shotClass = 'B_ROLL'; reason = 'NO_PEOPLE_OR_TEXT'; }

  const peopleWidth = median(personSets.filter((people) => people.length >= 2).map((people) =>
    Math.max(...people.map((person) => person.x + person.w)) - Math.min(...people.map((person) => person.x))));
  let layout: ShotLayout = 'FILL';
  let informationMode = INFORMATION_CLASSES.has(shotClass);
  if (informationMode) layout = 'FIT';
  else if (shotClass === 'GROUP_SHOT' || shotClass === 'MULTI_SPEAKER') layout = 'FIT';
  else if (shotClass === 'TWO_PERSON')
    layout = (faceCount === 2 ? pairFits : peopleWidth > 0 && peopleWidth <= cropWidth * .9) ? 'FILL' : 'FIT';
  if (options.preserveInformation && coverage >= tuning.preserveCoverage && layout === 'FILL' &&
    primaryFaceArea < tuning.talkingHeadFaceArea) {
    layout = 'FIT'; informationMode = true; reason += '+LUNA_PRESERVE_INFORMATION';
  }
  const zoomAllowed = layout === 'FILL' && !informationMode &&
    (PEOPLE_FILL.has(shotClass) || shotClass === 'TWO_PERSON');
  const frameMode = frameModeFor(shotClass, informationMode);
  return { shotClass, frameMode, layout, zoomAllowed, informationMode, faceCount, personCount,
    primaryFaceArea, textCoverage: coverage, reason };
}

// Splits the edited source range at shot boundaries and classifies each shot.
export function classifyShots(analysis: EditAnalysis, timeline: EditedTimeline, cropWidth: number,
  options: { preserveInformation?: boolean } = {}): Shot[] {
  const mapper = timelineMapper(timeline);
  const bounds = [timeline.editedStart,
    ...analysis.shotBoundaries.filter((value) => value > timeline.editedStart + .2 &&
      value < timeline.editedEnd - .2),
    timeline.editedEnd];
  const shots: Shot[] = [];
  for (let index = 0; index < bounds.length - 1; index++) {
    const sourceStart = bounds[index];
    const sourceEnd = bounds[index + 1];
    const start = Math.max(0, mapper.point(sourceStart));
    const end = Math.min(timeline.editedDuration, mapper.point(sourceEnd));
    if (end - start < .04) continue;
    let frames = analysis.frames.filter((frame) => frame.t >= sourceStart - .01 && frame.t < sourceEnd + .01);
    // Sparse analysis may miss short shots entirely; borrow the nearest samples.
    if (!frames.length && analysis.source !== 'DENSE') {
      const middle = (sourceStart + sourceEnd) / 2;
      frames = [...analysis.frames].sort((a, b) => Math.abs(a.t - middle) - Math.abs(b.t - middle))
        .filter((frame) => Math.abs(frame.t - middle) <= 3).slice(0, 2);
    }
    const result = classifyFrames(frames, cropWidth, { ...options,
      ocrText: analysis.source === 'DENSE' ? '' : analysis.ocrText });
    shots.push({ sourceStart, sourceEnd, start, end, sampleCount: frames.length, ...result });
  }
  return shots;
}

export function shotAt(shots: Shot[], t: number): Shot | undefined {
  return shots.find((shot) => t >= shot.start - 1e-6 && t < shot.end) ?? shots[shots.length - 1];
}

// ffmpeg `enable` expression covering the matching FIT intervals (final
// timeline). Information shots and plain FIT shots are composited by separate
// branches - one is cropped to its information region, the other is not - so
// each needs its own expression.
export function fitEnableExpression(shots: Shot[],
  match: (shot: Shot) => boolean = () => true) {
  const ranges = shots.filter((shot) => shot.layout === 'FIT' && match(shot));
  return ranges.map((shot) => `between(t\\,${shot.start.toFixed(3)}\\,${(shot.end - .001).toFixed(3)})`).join('+');
}
