// Turns the EditProject's own cached analysis into the evidence the preset
// planner reasons over.
//
// Everything here is read from EditAsset.transcript / EditAsset.analysis, which
// the Phase 1 "Analyze source" step already persisted. Nothing in this file
// transcribes, samples frames, or calls the AI service: a preset never re-runs
// expensive analysis that is already cached on the exact source.
//
// The frozen editing intelligence is reused as pure callable logic - the shot
// classifier, the information-region detector and the semantic zoom detector are
// imported and called with their own defaults, never modified.

import { buildEditedTimeline } from '../../editing/edit-timeline';
import { detectInformationRegion, type InformationRegion } from '../../editing/information-region';
import { buildSubtitlePhrases, type SubtitlePhrase } from '../../editing/subtitle-phrases';
import { classifyShots, INFORMATION_CLASSES, type Shot } from '../../editing/shot-classifier';
import { detectSemanticZoomCandidates, type SemanticZoomCandidate } from '../../editing/zoom-planner';
import type { AnalysisFrame, EditAnalysis, TextBox } from '../../editing/edit-analysis';
import type { TimedWord } from '../../editing/edit-plan';
import type { VisualTrack } from '../../editing/reframe.service';
import type { EditAspectRatio } from './edit-preset-policy';

export type PresetEvidence = {
  sourceDurationSec: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceAspect: number;
  hasAudioStream: boolean;
  transcriptAvailable: boolean;
  /** True only when the cached transcript carries real word timings. */
  wordTimingsAvailable: boolean;
  analysisAvailable: boolean;
  analysisSource: string;
  transcriptText: string;
  words: TimedWord[];
  phrases: SubtitlePhrase[];
  frames: AnalysisFrame[];
  shots: Shot[];
  informationRegion: InformationRegion | null;
  semanticPeaks: SemanticZoomCandidate[];
  /** Shares of the edited duration, not of the sample count. */
  informationShotRatio: number;
  faceShotRatio: number;
  pairShotRatio: number;
  /** Leading/trailing silence measured from the first and last spoken word. */
  leadInSilenceSec: number;
  tailSilenceSec: number;
  /** OCR text the source burns in, used only to keep callouts honest. */
  ocrText: string;
};

const finite = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const box = (value: unknown): TextBox | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const result = { x: finite(item.x), y: finite(item.y), w: finite(item.w), h: finite(item.h) };
  return result.w > 0 && result.h > 0 ? result : null;
};

const track = (value: unknown, timestamp: number): VisualTrack | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const shape = { x: finite(item.x), y: finite(item.y), w: finite(item.w), h: finite(item.h) };
  if (!(shape.w > 0) || !(shape.h > 0)) return null;
  return { timestamp, ...shape,
    confidence: item.score == null && item.confidence == null ? undefined
      : finite(item.score ?? item.confidence),
    mouthActivity: item.mouth_activity == null && item.mouthActivity == null ? undefined
      : finite(item.mouth_activity ?? item.mouthActivity),
    trackId: item.track_id == null && item.trackId == null ? undefined
      : String(item.track_id ?? item.trackId) };
};

/** The cached EditMode analysis stores the AI service response verbatim, so the
 * snake_case frames are normalised here into the shared AnalysisFrame shape. */
export function analysisFramesFromCache(value: unknown): { frames: AnalysisFrame[];
  shotBoundaries: number[]; ocrText: string; source: string } {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const rawFrames = Array.isArray(record.frames) ? record.frames : [];
  const frames = rawFrames.flatMap((item): AnalysisFrame[] => {
    if (!item || typeof item !== 'object') return [];
    const frame = item as Record<string, unknown>;
    const t = finite(frame.t, -1);
    if (t < 0) return [];
    const list = (key: string) => Array.isArray(frame[key]) ? frame[key] as unknown[] : [];
    return [{
      t,
      faces: list('faces').map((face) => track(face, t)).filter((face): face is VisualTrack => !!face),
      persons: list('persons').map((person) => track(person, t))
        .filter((person): person is VisualTrack => !!person),
      textCoverage: finite(frame.text_coverage ?? frame.textCoverage),
      textBoxes: list('text_boxes').concat(list('textBoxes'))
        .map(box).filter((item): item is TextBox => !!item),
      graphicBoxes: list('graphic_boxes').concat(list('graphicBoxes'))
        .map(box).filter((item): item is TextBox => !!item),
      ocrLines: list('ocr_lines').concat(list('ocrLines')).map(String).filter(Boolean),
      ocrCoverage: frame.ocr_coverage == null && frame.ocrCoverage == null ? undefined
        : finite(frame.ocr_coverage ?? frame.ocrCoverage),
      edgeDensity: frame.edge_density == null && frame.edgeDensity == null ? undefined
        : finite(frame.edge_density ?? frame.edgeDensity),
      visualLabels: list('visual_labels').concat(list('visualLabels')).map(String).filter(Boolean)
    }];
  }).sort((left, right) => left.t - right.t);
  const shotBoundaries = (Array.isArray(record.shotBoundaries) ? record.shotBoundaries
    : Array.isArray(record.shot_boundaries) ? record.shot_boundaries : [])
    .map((item) => finite(item, -1)).filter((item) => item > 0).sort((a, b) => a - b);
  return { frames, shotBoundaries,
    ocrText: typeof record.ocrText === 'string' ? record.ocrText : '',
    source: typeof record.source === 'string' ? record.source : 'NONE' };
}

/** Exact transcript words with their exact timings. Nothing is invented: a
 * transcript without word timings yields segment-level words only. */
export function wordsFromCache(value: unknown): { words: TimedWord[]; text: string;
  wordTimings: boolean } {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const segments = Array.isArray(record.segments) ? record.segments : [];
  const words: TimedWord[] = [];
  let wordTimings = false;
  for (const item of segments) {
    if (!item || typeof item !== 'object') continue;
    const segment = item as Record<string, unknown>;
    const segmentWords = Array.isArray(segment.words) ? segment.words : [];
    const timed = segmentWords.flatMap((entry): TimedWord[] => {
      if (!entry || typeof entry !== 'object') return [];
      const word = entry as Record<string, unknown>;
      const start = finite(word.start, -1);
      const end = finite(word.end, -1);
      const text = String(word.text ?? '').trim();
      return start >= 0 && end > start && text ? [{ start, end, text }] : [];
    });
    if (timed.length) { wordTimings = true; words.push(...timed); continue; }
    const start = finite(segment.start, -1);
    const end = finite(segment.end, -1);
    const text = String(segment.text ?? '').trim();
    if (start >= 0 && end > start && text) words.push({ start, end, text });
  }
  words.sort((left, right) => left.start - right.start);
  const text = typeof record.text === 'string' && record.text.trim()
    ? record.text.trim() : words.map((word) => word.text).join(' ');
  return { words, text, wordTimings };
}

/** Crop width, as a share of the source frame, for the requested output shape. */
export function cropWidthFor(aspectRatio: EditAspectRatio, sourceAspect: number) {
  const target = aspectRatio === '9:16' ? 9 / 16 : aspectRatio === '1:1' ? 1
    : aspectRatio === '16:9' ? 16 / 9 : sourceAspect;
  if (!(sourceAspect > 0) || !(target > 0)) return 1;
  return Math.max(0.05, Math.min(1, target / sourceAspect));
}

export type EvidenceInput = {
  durationSec: number;
  width: number | null;
  height: number | null;
  metadata: unknown;
  transcript: unknown;
  analysis: unknown;
  aspectRatio: EditAspectRatio;
  preserveInformation: boolean;
};

export function buildPresetEvidence(input: EvidenceInput): PresetEvidence {
  const cached = analysisFramesFromCache(input.analysis);
  const transcript = wordsFromCache(input.transcript);
  const sourceWidth = input.width && input.width > 0 ? input.width : 1920;
  const sourceHeight = input.height && input.height > 0 ? input.height : 1080;
  const sourceAspect = sourceWidth / sourceHeight;
  const duration = Math.max(0, input.durationSec);
  const metadata = input.metadata && typeof input.metadata === 'object'
    ? input.metadata as Record<string, unknown> : {};

  let shots: Shot[] = [];
  let informationRegion: InformationRegion | null = null;
  const cropWidth = cropWidthFor(input.aspectRatio, sourceAspect);
  if (duration > 0.2) {
    const timeline = buildEditedTimeline({ candidateStart: 0, candidateEnd: duration,
      editedStart: 0, editedEnd: duration, cuts: [] });
    const analysis: EditAnalysis = { source: cached.source === 'DENSE' ? 'DENSE'
      : cached.frames.length ? 'STORED_SPARSE' : 'NONE', frames: cached.frames,
      shotBoundaries: cached.shotBoundaries.filter((value) => value > 0 && value < duration),
      ocrText: cached.ocrText, fallbackReason: '', runtimeMs: 0 };
    shots = classifyShots(analysis, timeline, cropWidth,
      { preserveInformation: input.preserveInformation });
    const viewportHeight = input.aspectRatio === 'SOURCE' ? sourceHeight : 1920;
    const viewportWidth = Math.round(viewportHeight * cropWidth * sourceAspect);
    informationRegion = detectInformationRegion(cached.frames, shots,
      { width: Math.max(1, viewportWidth), height: viewportHeight },
      { width: sourceWidth, height: sourceHeight });
  }

  const shotSpan = shots.reduce((total, shot) => total + Math.max(0, shot.end - shot.start), 0);
  const share = (match: (shot: Shot) => boolean) => shotSpan > 0
    ? Number((shots.filter(match).reduce((total, shot) => total + shot.end - shot.start, 0) /
      shotSpan).toFixed(4)) : 0;

  const firstWord = transcript.words[0];
  const lastWord = transcript.words[transcript.words.length - 1];
  return {
    sourceDurationSec: duration, sourceWidth, sourceHeight, sourceAspect,
    hasAudioStream: metadata.hasAudio !== false,
    transcriptAvailable: transcript.words.length > 0,
    wordTimingsAvailable: transcript.wordTimings,
    analysisAvailable: cached.frames.length > 0,
    analysisSource: cached.source,
    transcriptText: transcript.text,
    words: transcript.words,
    phrases: transcript.wordTimings ? buildSubtitlePhrases(transcript.words)
      : transcript.words.map((word) => ({ words: [word], start: word.start, end: word.end,
        lines: [word.text], lineBreakIndex: null })),
    frames: cached.frames,
    shots,
    informationRegion,
    semanticPeaks: transcript.words.length
      ? detectSemanticZoomCandidates(transcript.words, [], 0, duration) : [],
    informationShotRatio: share((shot) =>
      shot.informationMode || INFORMATION_CLASSES.has(shot.shotClass)),
    faceShotRatio: share((shot) => shot.faceCount >= 1),
    pairShotRatio: share((shot) => shot.frameMode === 'FACE_PAIR'),
    leadInSilenceSec: firstWord ? Number(Math.max(0, firstWord.start).toFixed(3)) : 0,
    tailSilenceSec: lastWord ? Number(Math.max(0, duration - lastWord.end).toFixed(3)) : 0,
    ocrText: cached.ocrText
  };
}
