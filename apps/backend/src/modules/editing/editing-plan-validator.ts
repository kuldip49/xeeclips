import { Injectable } from '@nestjs/common';
import type { OutputAspectRatio } from '../processing/processing-type';
import { EditPlan, EditOperation, SubtitleEmphasis, TimedWord, fallbackEditPlan } from './edit-plan';
import { GRADE_PRESET_NAMES } from './color-grade';
import { MUSIC_MOODS } from './music-library';
import { HOOK_LENGTH } from './hook-generator';
import { ZOOM_INTENSITY_BANDS, ZOOM_TUNING } from './zoom-planner';

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const overlap = (a: { startSec: number; endSec: number },
  b: { startSec: number; endSec: number }) => a.startSec < b.endSec && b.startSec < a.endSec;
const validTime = (item: { startSec: number; endSec: number }, start: number, end: number) =>
  finite(item.startSec) && finite(item.endSec) && item.startSec >= start &&
  item.endSec <= end && item.endSec > item.startSec;
const stopWords = new Set(['the', 'and', 'for', 'you', 'your', 'this', 'that',
  'with', 'why', 'how', 'what', 'here', 'there', 'are', 'was', 'were', 'from',
  'have', 'has', 'had', 'but', 'not', 'its', 'they', 'them', 'some', 'just',
  'really', 'very', 'like', 'okay', 'yeah', 'um', 'uh', 'so', 'a', 'an', 'to',
  'of', 'in', 'on', 'at', 'is', 'it', 'we', 'i']);
const normalizeWord = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const validTheme = new Set(['CLEAN_WHITE', 'HIGH_CONTRAST', 'WARM_ACCENT',
  'COOL_ACCENT', 'BOLD_SOCIAL']);
const VALID_INTENSITIES = new Set(['SUBTLE', 'NORMAL', 'STRONG', 'VERY_STRONG']);
// The planner's own bands, restated as a plain range so a model plan is only
// rejected for asking something outside every intensity level (§3).
const ZOOM_SCALE_RANGE = { min: ZOOM_INTENSITY_BANDS.SUBTLE.min,
  max: ZOOM_INTENSITY_BANDS.VERY_STRONG.max };
const ZOOM_STRONG_FROM = ZOOM_INTENSITY_BANDS.NORMAL.max;
const MAX_PLANNED_ZOOMS = ZOOM_TUNING.maxZooms;
const validPlatform = new Set(['UNIVERSAL', 'UNIVERSAL_SOCIAL', 'INSTAGRAM_REELS', 'YOUTUBE_SHORTS', 'TIKTOK']);
const validTemplate = new Set(['FULL_SCREEN_SOCIAL', 'EDITORIAL_FRAME',
  'PODCAST_FRAME', 'DUAL_SPEAKER', 'CLEAN_DOCUMENTARY']);
const validBackground = new Set(['SOURCE_MATCH_SOLID', 'SOURCE_MATCH_GRADIENT',
  'DARK_NEUTRAL', 'SOFT_BLUR_EXTENSION']);
const genericHooks = [/this changes everything/iu, /you need to see this/iu,
  /watch until the end/iu, /wait for it/iu, /you won.t believe/iu];
const metaHookLanguage = [
  /^(?:this\s+)?(?:clip|video|segment)\s+(?:states?|stating|talks?|explains?|explaining|shows?|says?)\b/iu,
  /^(?:the\s+)?(?:speaker|host|guest|person)\s+(?:says?|states?|stating|explains?|explaining|claims?|thinks?|believes?|talks?)\b/iu,
  /^(?:this\s+)?(?:clip|video|segment)\s+(?:about|on)\b/iu,
  /\b(?:the|this)\s+(?:speaker|video|clip|segment)\b/iu,
  /\b(?:speaker|host|guest|person)\s+(?:says?|argues?|claims?|explains?|states?|asks?|believes?|thinks?)\b/iu,
  /\b(?:the|this)\s+person\s+says\b/iu
];
export function hookMetaLanguageFree(text: string) {
  return !metaHookLanguage.some((pattern) => pattern.test(text.trim()));
}
function grounded(text: string, transcript: string) {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const source = new Set(transcript.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return tokens.some((token) => token.length > 3 && !stopWords.has(token) &&
    (source.has(token) || source.has(token.replace(/s$/u, ''))));
}

export type ValidatedEditPlan = { plan: EditPlan; warnings: string[]; fallback: boolean;
  hookOriginalText: string; hookValidationFailureReason: string };

export function validateHook(hook: EditPlan['onScreenHook'], start: number, end: number,
  transcript: string, title: string, allowTitleReuse = false): string {
  if (!hook.enabled) return 'NOT_REQUESTED';
  if (typeof hook.text !== 'string' || !hook.text.trim()) return 'EMPTY_TEXT';
  if (!validTime(hook, start, end) || hook.startSec > start + .5 ||
    hook.endSec - hook.startSec < Math.min(1.8, end - start))
    return 'INVALID_TIMING';
  const tokens = hook.text.trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (genericHooks.some((pattern) => pattern.test(hook.text))) return 'GENERIC_HOOK';
  if (!hookMetaLanguageFree(hook.text)) return 'META_LANGUAGE';
  // Matches the headline policy in hook-generator: 4-8 words is the preferred
  // band, but a longer line is allowed when shortening it would cost meaning -
  // the renderer fits it into the header space instead of cutting it.
  if (tokens.length < HOOK_LENGTH.min || tokens.length > HOOK_LENGTH.max ||
    hook.text.length > HOOK_LENGTH.maxChars) return 'INVALID_LENGTH';
  if (!grounded(hook.text, `${transcript} ${title}`)) return 'NOT_CONTEXTUAL';
  const contextTokens = new Set(`${transcript} ${title}`.toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []);
  const titleTokens = new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const meaningful = tokens.map(normalizeWord).filter((token) => token.length > 3 &&
    !stopWords.has(token));
  if (meaningful.length < 2 || meaningful.filter((token) =>
    contextTokens.has(token) || contextTokens.has(token.replace(/s$/u, ''))).length <
    Math.min(2, meaningful.length)) return 'INSUFFICIENT_CONTEXT';
  if (!allowTitleReuse && meaningful.length >= 2 &&
    meaningful.every((token) => titleTokens.has(token))) return 'DUPLICATES_TITLE';
  if (!['TOP', 'CENTER_TOP'].includes(hook.position) ||
    !['BOLD_POP', 'CLEAN', 'IMPACT', 'CLEAN_CENTER', 'IMPACT_TOP',
      'MINIMAL_BOX', 'TOP_HEADLINE'].includes(hook.style)) return 'INVALID_STYLE';
  return '';
}

@Injectable()
export class EditingPlanValidator {
  validate(input: unknown, start: number, end: number, aspectRatio: OutputAspectRatio,
    words: TimedWord[], transcript = words.map((word) => word.text).join(' '),
    title = '', window?: { start: number; end: number }): ValidatedEditPlan {
    // Operations may sit anywhere in the editorial window around the candidate.
    const windowStart = Math.min(start, window?.start ?? start);
    const windowEnd = Math.max(end, window?.end ?? end);
    const fallback = fallbackEditPlan(start, end, aspectRatio);
    const warnings: string[] = [];
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return { plan: fallback, warnings: ['INVALID_PLAN'], fallback: true,
        hookOriginalText: '', hookValidationFailureReason: 'INVALID_PLAN' };
    const value = input as Partial<EditPlan>;
    if (value.version !== 1 || !finite(value.clipStartSec) || !finite(value.clipEndSec) ||
      Math.abs(value.clipStartSec - start) > 0.05 || Math.abs(value.clipEndSec - end) > 0.05 ||
      !Array.isArray(value.operations) || !value.onScreenHook || !value.subtitleStyle || !value.audio)
      return { plan: fallback, warnings: ['INVALID_PLAN_BOUNDARIES_OR_SCHEMA'], fallback: true,
        hookOriginalText: typeof value.onScreenHook?.text === 'string' ? value.onScreenHook.text : '',
        hookValidationFailureReason: 'INVALID_PLAN_BOUNDARIES_OR_SCHEMA' };

    const sorted = [...value.operations].sort((a, b) => a.startSec - b.startSec);
    const rawEmphasis = Array.isArray(value.subtitleEmphasis) ? value.subtitleEmphasis : [];
    const emphasis: SubtitleEmphasis[] = [];
    for (const item of rawEmphasis.slice(0, 18)) {
      if (!item || typeof item.word !== 'string' || !validTime(item, windowStart, windowEnd) ||
        !['MEDIUM', 'STRONG'].includes(item.strength)) { warnings.push('INVALID_EMPHASIS_REMOVED'); continue; }
      const token = normalizeWord(item.word);
      const match = words.find((word) => normalizeWord(word.text) === token &&
        Math.abs(word.start - item.startSec) <= .18 && Math.abs(word.end - item.endSec) <= .25);
      if (!match || token.length < 3 || stopWords.has(token) ||
        emphasis.some((prior) => Math.abs(prior.startSec - match.start) < .05)) {
        warnings.push('LOW_VALUE_EMPHASIS_REMOVED'); continue;
      }
      emphasis.push({ word: match.text, startSec: match.start, endSec: match.end,
        strength: item.strength });
    }
    const kept: EditOperation[] = [];
    const cuts: EditOperation[] = [];
    let removed = 0;
    let zoomCount = 0;
    for (const operation of sorted) {
      if (!validTime(operation, windowStart, windowEnd)) { warnings.push('INVALID_OPERATION_TIME'); continue; }
      if (operation.type === 'TRIM' || operation.type === 'REMOVE_SILENCE') {
        const duration = operation.endSec - operation.startSec;
        if (!words.length || duration > 2.5 || duration < 0.18 ||
          removed + duration > Math.min(4, (end - start) * 0.15) ||
          cuts.some((cut) => overlap(cut, operation)) ||
          words.some((word) => word.start < operation.endSec - 0.04 &&
            word.end > operation.startSec + 0.04)) {
          warnings.push('UNSAFE_CUT_REMOVED'); continue;
        }
        cuts.push(operation); removed += duration; kept.push(operation);
      } else if (operation.type === 'ZOOM' || operation.type === 'ZOOM_OUT') {
        const triggerTokens = (operation.triggerText ?? '').toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) ?? [];
        const triggerIndex = words.findIndex((word, index) => triggerTokens.length > 0 &&
          triggerTokens.every((token, offset) =>
            normalizeWord(words[index + offset]?.text ?? '') === token));
        const trigger = triggerIndex < 0 ? null : words.slice(triggerIndex,
          triggerIndex + triggerTokens.length);
        const triggerStart = trigger?.[0]?.start ?? -1;
        const triggerEnd = trigger?.[trigger.length - 1]?.end ?? -1;
        // The band the requested scale falls into, and whether a STRONG spoken
        // emphasis actually backs a strong crop. The zoom planner repeats this
        // decision against real face geometry; this only rejects the impossible.
        const intensity = VALID_INTENSITIES.has(operation.intensity ?? '') ?
          operation.intensity : undefined;
        const strongBacked = emphasis.some((item) => item.strength === 'STRONG' &&
          item.startSec >= triggerStart && item.startSec <= triggerEnd);
        if (!trigger || triggerStart < operation.startSec ||
          triggerEnd > operation.endSec || triggerTokens.every((token) =>
            stopWords.has(token)) ||
          // Motion with no stated editorial beat is decoration (§20).
          !String(operation.reason ?? '').trim() ||
          !finite(operation.scale) || operation.scale < ZOOM_SCALE_RANGE.min ||
          operation.scale > ZOOM_SCALE_RANGE.max ||
          operation.endSec - operation.startSec < 0.8 ||
          // Only a STRONG emphasized word earns the strong band.
          ((operation.scale > ZOOM_STRONG_FROM || intensity === 'STRONG' ||
            intensity === 'VERY_STRONG') && !strongBacked) ||
          zoomCount >= MAX_PLANNED_ZOOMS || cuts.some((cut) => overlap(cut, operation)) ||
          kept.some((prior) => (prior.type === 'ZOOM' || prior.type === 'ZOOM_OUT') &&
            operation.startSec - prior.endSec < ZOOM_TUNING.minSpacingSec) ||
          (operation.focusX != null && (!finite(operation.focusX) || operation.focusX < 0 || operation.focusX > 1)) ||
          (operation.focusY != null && (!finite(operation.focusY) || operation.focusY < 0 || operation.focusY > 1))) {
          warnings.push('UNSAFE_ZOOM_REMOVED'); continue;
        }
        zoomCount++; kept.push({ ...operation, ...(intensity ? { intensity } : {}) });
      } else if (operation.type === 'REFRAME') {
        if (!['FACE', 'PERSON', 'CENTER'].includes(operation.target ?? '') ||
          operation.endSec - operation.startSec < 0.5) {
          warnings.push('INVALID_REFRAME_REMOVED'); continue;
        }
        kept.push(operation);
      } else if (operation.type === 'WORD_HIGHLIGHT') {
        if (!Array.isArray(operation.words) || !operation.words.length) {
          warnings.push('INVALID_HIGHLIGHT_REMOVED'); continue;
        }
        kept.push(operation);
      }
    }
    const cutSafeOperations = kept.filter((operation) => {
      if ((operation.type !== 'ZOOM' && operation.type !== 'ZOOM_OUT') ||
        !cuts.some((cut) => overlap(cut, operation)))
        return true;
      warnings.push('UNSAFE_ZOOM_REMOVED');
      return false;
    });
    const hook = value.onScreenHook;
    const hookValidationFailureReason = validateHook(hook, start, end, transcript, title);
    const hookValid = !hookValidationFailureReason;
    if (hook.enabled && !hookValid) warnings.push('INVALID_HOOK_REMOVED');
    const safeHook = hookValid ? { ...hook, startSec: start, endSec: end } :
      fallback.onScreenHook;
    const safeText = (Array.isArray(value.onScreenText) ? value.onScreenText : [])
      .filter((item) => typeof item.text === 'string' && item.text.length <= 60 &&
        grounded(item.text, transcript) &&
        item.text.trim().split(/\s+/u).length <= 7 && validTime(item, windowStart, windowEnd) &&
        item.endSec - item.startSec <= 3 &&
        ['TOP', 'CENTER', 'LOWER_THIRD'].includes(item.position) &&
        ['NORMAL', 'STRONG'].includes(item.emphasis) &&
        (item.position !== 'TOP' || !hookValid || !overlap(item, safeHook)))
      .slice(0, 2);
    const subtitle = value.subtitleStyle;
    const subtitleStyle = {
      enabled: subtitle.enabled !== false,
      // The enum is future-ready, but PODCAST_BOLD is the only production
      // implementation in this phase. Unsupported proposals resolve to it.
      template: 'PODCAST_BOLD' as const,
      position: subtitle.position === 'CENTER' ? 'CENTER' as const : 'BOTTOM' as const,
      maxWordsPerLine: Number.isInteger(subtitle.maxWordsPerLine) ?
        Math.max(2, Math.min(5, subtitle.maxWordsPerLine)) : 4,
      highlightCurrentWord: subtitle.highlightCurrentWord !== false,
      animationStyle: ['WORD_HIGHLIGHT', 'POP', 'PUNCH', 'FADE', 'SLIDE', 'SUBTLE_SCALE']
        .includes(subtitle.animationStyle) ? subtitle.animationStyle : 'WORD_HIGHLIGHT' as const
    };
    const plan: EditPlan = { ...fallback, ...value, clipStartSec: start, clipEndSec: end,
      aspectRatio, operations: cutSafeOperations, onScreenHook: safeHook, onScreenText: safeText,
      subtitleStyle, subtitleEmphasis: emphasis,
      subtitleTheme: validTheme.has(value.subtitleTheme ?? '') ? value.subtitleTheme! : 'BOLD_SOCIAL',
      platformPreset: validPlatform.has(value.platformPreset ?? '') ? value.platformPreset! : 'UNIVERSAL',
      videoTemplate: validTemplate.has(value.videoTemplate ?? '') ? value.videoTemplate : undefined,
      recommendedTemplate: validTemplate.has(value.recommendedTemplate ?? '') ?
        value.recommendedTemplate : undefined,
      backgroundMode: validBackground.has(value.backgroundMode ?? '') ?
        value.backgroundMode : undefined,
      gradePreset: GRADE_PRESET_NAMES.includes(value.gradePreset as never) ?
        value.gradePreset : 'CLEAN_SOCIAL',
      endingStrategy: value.endingStrategy && finite(value.endingStrategy.payoffEndSec) &&
        value.endingStrategy.payoffEndSec > start && value.endingStrategy.payoffEndSec <= windowEnd ?
        { payoffEndSec: value.endingStrategy.payoffEndSec,
          reason: String(value.endingStrategy.reason ?? '').slice(0, 200),
          // A new topic can only begin after the payoff and inside the window;
          // anything else is dropped rather than allowed to trim the ending.
          newTopicBeginsAfterSec: finite(value.endingStrategy.newTopicBeginsAfterSec) &&
            (value.endingStrategy.newTopicBeginsAfterSec as number) > start &&
            (value.endingStrategy.newTopicBeginsAfterSec as number) <= windowEnd ?
            value.endingStrategy.newTopicBeginsAfterSec as number : null,
          endingComplete: value.endingStrategy.endingComplete === true } : fallback.endingStrategy,
      openingStrategy: value.openingStrategy && finite(value.openingStrategy.hookStartSec) &&
        value.openingStrategy.hookStartSec >= windowStart && value.openingStrategy.hookStartSec < end ?
        { hookStartSec: value.openingStrategy.hookStartSec,
          removeWeakLeadIn: value.openingStrategy.removeWeakLeadIn === true,
          reason: String(value.openingStrategy.reason ?? '').slice(0, 200),
          // Required context must sit inside the window and cannot be claimed to
          // start after the candidate ends.
          contextRequiredFromSec: finite(value.openingStrategy.contextRequiredFromSec) &&
            (value.openingStrategy.contextRequiredFromSec as number) >= windowStart &&
            (value.openingStrategy.contextRequiredFromSec as number) < end ?
            value.openingStrategy.contextRequiredFromSec as number :
            undefined } : fallback.openingStrategy,
      editorialIntent: typeof value.editorialIntent === 'string' ? value.editorialIntent.slice(0, 300) : '',
      musicMood: MUSIC_MOODS.includes(value.musicMood as never) ? value.musicMood : fallback.musicMood,
      musicEnergy: ['LOW', 'MEDIUM', 'HIGH'].includes(value.musicEnergy as never) ?
        value.musicEnergy : undefined,
      musicTexture: ['PAD', 'DRONE', 'PULSE'].includes(value.musicTexture as never) ?
        value.musicTexture : undefined,
      loopSuitable: value.loopSuitable === true,
      preserveInformation: value.preserveInformation === true,
      audio: { normalize: value.audio.normalize !== false,
        removeLongPauses: value.audio.removeLongPauses === true },
      retentionMoments: (Array.isArray(value.retentionMoments) ? value.retentionMoments : [])
        .filter((moment) => validTime(moment, windowStart, windowEnd)).slice(0, 6),
      pacingNotes: (Array.isArray(value.pacingNotes) ? value.pacingNotes : [])
        .filter((note): note is string => typeof note === 'string').slice(0, 6) };
    return { plan, warnings, fallback: false, hookOriginalText: hook.text ?? '',
      hookValidationFailureReason };
  }
}
