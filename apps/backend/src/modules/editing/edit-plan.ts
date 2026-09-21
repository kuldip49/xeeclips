import type { StrictJsonSchema } from '../processing/llm-provider.service';
import type { OutputAspectRatio } from '../processing/processing-type';
import type { VideoTemplate, BackgroundMode } from './platform-layout';
import type { MusicEnergy, MusicMood, MusicTexture } from './music-library';
import type { GradePreset } from './color-grade';
import type { ZoomIntensity } from './zoom-planner';

export type TimedWord = { start: number; end: number; text: string;
  // Normalised local RMS prominence, populated when the renderer has access to
  // source audio. Transcript-only callers can omit it.
  audioEnergyScore?: number };
export type SubtitleThemeName = 'CLEAN_WHITE' | 'HIGH_CONTRAST' | 'WARM_ACCENT' |
  'COOL_ACCENT' | 'BOLD_SOCIAL';
export type PlatformPreset = 'UNIVERSAL' | 'UNIVERSAL_SOCIAL' | 'INSTAGRAM_REELS' | 'YOUTUBE_SHORTS' | 'TIKTOK';
export type SubtitleEmphasis = { word: string; startSec: number; endSec: number;
  strength: 'MEDIUM' | 'STRONG' };
export type SubtitleTemplateName = 'PODCAST_BOLD' | 'COMEDY_POP' | 'EDUCATION_CLEAN' |
  'FINANCE_BOLD' | 'GAMING_ENERGY' | 'NEWS_EDITORIAL';
export type EditOperation = {
  // ZOOM pushes in on a beat; ZOOM_OUT starts tight and pulls back to reveal
  // context, so it is only ever accepted on a hard visual discontinuity.
  type: 'TRIM' | 'REMOVE_SILENCE' | 'ZOOM' | 'ZOOM_OUT' | 'REFRAME' | 'WORD_HIGHLIGHT';
  // `reason` doubles as the motion's semanticReason: an operation that names no
  // editorial beat is decoration and the zoom planner rejects it.
  startSec: number; endSec: number; reason: string;
  scale: number | null; focusX: number | null; focusY: number | null;
  target: 'FACE' | 'PERSON' | 'CENTER' | null; words: string[];
  triggerText?: string;
  // Editorial strength of the move; deterministic code maps it to an exact
  // scale band and may walk it back for subject/text safety.
  intensity?: ZoomIntensity;
};
export type EditPlan = {
  version: 1; clipStartSec: number; clipEndSec: number; aspectRatio: OutputAspectRatio;
  // Editorial intent only; deterministic code snaps every second below to a
  // word boundary and may reject it outright.
  openingStrategy: { hookStartSec: number; removeWeakLeadIn: boolean; reason: string;
    // The earliest second a cold viewer needs for the moment to make sense.
    contextRequiredFromSec?: number };
  endingStrategy?: { payoffEndSec: number; reason: string;
    // Where the speaker moves on to a different subject, so the edit can stop
    // before it instead of leaking the next topic into the ending.
    newTopicBeginsAfterSec?: number | null;
    // Luna's own read of whether the payoff actually completes by payoffEndSec.
    endingComplete?: boolean };
  editorialIntent?: string;
  musicMood?: MusicMood;
  // Editorial music intent. Luna picks mood/energy/texture; the deterministic
  // library picks the actual file, so no model ever names a filesystem path.
  musicEnergy?: MusicEnergy;
  musicTexture?: MusicTexture;
  loopSuitable?: boolean;
  preserveInformation?: boolean;
  // AI_EDITED clips must always carry a visible headline: the quality gate
  // treats a missing hook as a baseline failure rather than "not applicable".
  // NORMAL clips never set it.
  hookRequired?: boolean;
  onScreenHook: { enabled: boolean; text: string; startSec: number; endSec: number;
    position: 'TOP' | 'CENTER_TOP'; style: 'BOLD_POP' | 'CLEAN' | 'IMPACT' |
      'CLEAN_CENTER' | 'IMPACT_TOP' | 'MINIMAL_BOX' | 'TOP_HEADLINE' };
  operations: EditOperation[];
  retentionMoments: Array<{ startSec: number; endSec: number;
    action: 'ZOOM' | 'CUT_PAUSE' | 'REFRAME' | 'HIGHLIGHT' | 'NONE' |
      'KEEP' | 'TRIM' | 'TEXT_EMPHASIS' | 'SUBTITLE_EMPHASIS'; reason: string }>;
  onScreenText: Array<{ text: string; startSec: number; endSec: number;
    position: 'TOP' | 'CENTER' | 'LOWER_THIRD'; emphasis: 'NORMAL' | 'STRONG' }>;
  subtitleStyle: { enabled: boolean; template: SubtitleTemplateName;
    position: 'BOTTOM' | 'CENTER'; maxWordsPerLine: number;
    highlightCurrentWord: boolean;
    animationStyle: 'WORD_HIGHLIGHT' | 'POP' | 'PUNCH' | 'FADE' | 'SLIDE' | 'SUBTLE_SCALE' };
  subtitleTheme: SubtitleThemeName;
  subtitleEmphasis: SubtitleEmphasis[];
  platformPreset: PlatformPreset;
  videoTemplate?: VideoTemplate;
  recommendedTemplate?: VideoTemplate;
  backgroundMode?: BackgroundMode;
  gradePreset?: GradePreset;
  audio: { normalize: boolean; removeLongPauses: boolean };
  pacingNotes: string[];
};

const obj = (properties: Record<string, unknown>): StrictJsonSchema => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties)
});
const num = { type: 'number' };
const str = { type: 'string' };
const bool = { type: 'boolean' };
const nullableNum = { type: ['number', 'null'] };
const enumStr = (values: string[]) => ({ type: 'string', enum: values });
const timed = { startSec: num, endSec: num };

export const EDIT_PLAN_SCHEMA: StrictJsonSchema = obj({
  version: { type: 'integer', enum: [1] }, clipStartSec: num, clipEndSec: num,
  aspectRatio: enumStr(['9:16', '16:9', '1:1', '4:5']),
  openingStrategy: obj({ hookStartSec: num, removeWeakLeadIn: bool, reason: str,
    contextRequiredFromSec: num }),
  endingStrategy: obj({ payoffEndSec: num, reason: str,
    newTopicBeginsAfterSec: nullableNum, endingComplete: bool }),
  editorialIntent: str,
  musicMood: enumStr(['DOCUMENTARY_TENSION', 'CLEAN_NEUTRAL', 'ENERGETIC_LIGHT',
    'CALM_WARM', 'ATMOSPHERIC', 'SUBTLE_DOCUMENTARY', 'MODERN_MINIMAL', 'NONE']),
  musicEnergy: enumStr(['LOW', 'MEDIUM', 'HIGH']),
  musicTexture: enumStr(['PAD', 'DRONE', 'PULSE']),
  loopSuitable: bool,
  preserveInformation: bool,
  onScreenHook: obj({ enabled: bool, text: str, ...timed,
    position: enumStr(['TOP', 'CENTER_TOP']),
    style: enumStr(['BOLD_POP', 'CLEAN', 'IMPACT', 'CLEAN_CENTER', 'IMPACT_TOP', 'MINIMAL_BOX', 'TOP_HEADLINE']) }),
  operations: { type: 'array', items: obj({
    type: enumStr(['TRIM', 'REMOVE_SILENCE', 'ZOOM', 'ZOOM_OUT', 'REFRAME', 'WORD_HIGHLIGHT']),
    ...timed, reason: str, scale: nullableNum, focusX: nullableNum, focusY: nullableNum,
    target: { type: ['string', 'null'], enum: ['FACE', 'PERSON', 'CENTER', null] },
    words: { type: 'array', items: str }, triggerText: str,
    intensity: enumStr(['SUBTLE', 'NORMAL', 'STRONG', 'VERY_STRONG'])
  }) },
  retentionMoments: { type: 'array', items: obj({ ...timed,
    action: enumStr(['ZOOM', 'CUT_PAUSE', 'REFRAME', 'HIGHLIGHT', 'NONE',
      'KEEP', 'TRIM', 'TEXT_EMPHASIS', 'SUBTITLE_EMPHASIS']), reason: str }) },
  onScreenText: { type: 'array', items: obj({ text: str, ...timed,
    position: enumStr(['TOP', 'CENTER', 'LOWER_THIRD']),
    emphasis: enumStr(['NORMAL', 'STRONG']) }) },
  subtitleStyle: obj({ enabled: bool, template: enumStr(['PODCAST_BOLD', 'COMEDY_POP',
    'EDUCATION_CLEAN', 'FINANCE_BOLD', 'GAMING_ENERGY', 'NEWS_EDITORIAL']),
    position: enumStr(['BOTTOM', 'CENTER']), maxWordsPerLine: { type: 'integer' },
    highlightCurrentWord: bool,
    animationStyle: enumStr(['WORD_HIGHLIGHT', 'POP', 'PUNCH', 'FADE', 'SLIDE', 'SUBTLE_SCALE']) }),
  subtitleTheme: enumStr(['CLEAN_WHITE', 'HIGH_CONTRAST', 'WARM_ACCENT',
    'COOL_ACCENT', 'BOLD_SOCIAL']),
  subtitleEmphasis: { type: 'array', items: obj({ word: str, ...timed,
    strength: enumStr(['MEDIUM', 'STRONG']) }) },
  platformPreset: enumStr(['UNIVERSAL', 'UNIVERSAL_SOCIAL', 'INSTAGRAM_REELS', 'YOUTUBE_SHORTS', 'TIKTOK']),
  videoTemplate: enumStr(['FULL_SCREEN_SOCIAL', 'EDITORIAL_FRAME',
    'PODCAST_FRAME', 'DUAL_SPEAKER', 'CLEAN_DOCUMENTARY']),
  recommendedTemplate: enumStr(['FULL_SCREEN_SOCIAL', 'EDITORIAL_FRAME',
    'PODCAST_FRAME', 'DUAL_SPEAKER', 'CLEAN_DOCUMENTARY']),
  backgroundMode: enumStr(['SOURCE_MATCH_SOLID', 'SOURCE_MATCH_GRADIENT',
    'DARK_NEUTRAL', 'SOFT_BLUR_EXTENSION']),
  gradePreset: enumStr(['CLEAN_SOCIAL', 'WARM_TALKING_HEAD', 'COOL_DOCUMENTARY',
    'NEUTRAL_EDUCATIONAL', 'SOURCE_ALREADY_GRADED']),
  audio: obj({ normalize: bool, removeLongPauses: bool }),
  pacingNotes: { type: 'array', items: str }
});

export function fallbackEditPlan(start: number, end: number,
  aspectRatio: OutputAspectRatio): EditPlan {
  return { version: 1, clipStartSec: start, clipEndSec: end, aspectRatio,
    openingStrategy: { hookStartSec: start, removeWeakLeadIn: false,
      reason: 'Preserve selected clip without speculative cuts',
      contextRequiredFromSec: start },
    endingStrategy: { payoffEndSec: end, reason: 'Selected clip end',
      newTopicBeginsAfterSec: null, endingComplete: false },
    editorialIntent: '', musicMood: 'CLEAN_NEUTRAL', musicEnergy: 'LOW', musicTexture: 'PAD',
    loopSuitable: false,
    preserveInformation: false,
    onScreenHook: { enabled: false, text: '', startSec: start, endSec: start,
      position: 'TOP', style: 'CLEAN' },
    operations: [], retentionMoments: [], onScreenText: [],
    subtitleStyle: { enabled: true, template: 'PODCAST_BOLD', position: 'BOTTOM',
      maxWordsPerLine: 5, highlightCurrentWord: true, animationStyle: 'WORD_HIGHLIGHT' },
    subtitleTheme: 'BOLD_SOCIAL', subtitleEmphasis: [], platformPreset: 'UNIVERSAL',
    videoTemplate: 'EDITORIAL_FRAME',
    recommendedTemplate: 'EDITORIAL_FRAME', backgroundMode: 'SOURCE_MATCH_GRADIENT',
    gradePreset: 'CLEAN_SOCIAL',
    audio: { normalize: true, removeLongPauses: false }, pacingNotes: [] };
}
