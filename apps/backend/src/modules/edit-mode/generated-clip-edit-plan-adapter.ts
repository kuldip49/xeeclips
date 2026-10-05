// Converts the frozen automatic editor's persisted plan + final telemetry into
// EditMode's canonical element model. This is deliberately pure: materialising
// a project must not call an LLM, re-run analysis, or reinterpret the source.

import { Prisma } from '@prisma/client';
import type { EditPlan, TimedWord } from '../editing/edit-plan';
import { generateCaptions } from './edit-mode-captions';
import { colorProperties, resolveColorFilter, type ColorFilterId } from './edit-mode-color';
import { captionStylePreset, styleProperties, textStylePreset,
  type CaptionStylePresetId, type TextStylePresetId } from './edit-mode-text';
import type { EditElementInput } from './edit-mode.types';
import { zoomProperties, MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from './edit-mode-zoom-events';
import { buildTimelineMap } from './render/edit-mode-timeline-map';

export const AUTOMATIC_EDIT_ADAPTER_VERSION = 1;

type JsonRecord = Record<string, unknown>;
type TranscriptSegment = { start: number; end: number; text: string; words: unknown };
type IdFactory = (kind: string, index: number) => string;

export type AutomaticEditApproximation = {
  capability: string;
  source: string;
  canonical: string;
  reason: string;
};

export type AutomaticEditReport = {
  adapterVersion: number;
  sourcePlanVersion: number | 'LEGACY_V1';
  segmentCount: number;
  captionCount: number;
  hookCount: number;
  textOverlayCount: number;
  zoomCount: number;
  approximations: AutomaticEditApproximation[];
  unsupported: string[];
};

export type AutomaticEditResult =
  | { mode: 'CANONICAL'; elements: EditElementInput[]; settingsPatch: JsonRecord;
      report: AutomaticEditReport }
  | { mode: 'FLATTENED_FALLBACK'; reason: string; details: string[] };

const record = (value: unknown): JsonRecord => value && typeof value === 'object' &&
  !Array.isArray(value) ? value as JsonRecord : {};
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const round = (value: number) => Number(value.toFixed(6));
const json = (value: JsonRecord): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const fallback = (reason: string, ...details: string[]): AutomaticEditResult => ({
  mode: 'FLATTENED_FALLBACK', reason, details
});

function isCurrentPlan(value: unknown): value is EditPlan {
  const plan = record(value);
  const hook = record(plan.onScreenHook);
  const subtitle = record(plan.subtitleStyle);
  const audio = record(plan.audio);
  return finite(plan.clipStartSec) && finite(plan.clipEndSec) &&
    Number(plan.clipEndSec) > Number(plan.clipStartSec) &&
    typeof plan.aspectRatio === 'string' &&
    typeof hook.enabled === 'boolean' && typeof hook.text === 'string' &&
    finite(hook.startSec) && finite(hook.endSec) &&
    Array.isArray(plan.operations) && Array.isArray(plan.retentionMoments) &&
    Array.isArray(plan.onScreenText) && typeof subtitle.enabled === 'boolean' &&
    typeof subtitle.template === 'string' && typeof audio.normalize === 'boolean';
}

function planSchemaErrors(plan: EditPlan): string[] {
  const errors: string[] = [];
  const oneOf = (value: unknown, allowed: readonly string[], path: string) => {
    if (typeof value !== 'string' || !allowed.includes(value)) errors.push(path);
  };
  oneOf(plan.aspectRatio, ['9:16', '16:9', '1:1', '4:5'], 'aspectRatio');
  oneOf(plan.onScreenHook.position, ['TOP', 'CENTER_TOP'], 'onScreenHook.position');
  oneOf(plan.onScreenHook.style, ['BOLD_POP', 'CLEAN', 'IMPACT', 'CLEAN_CENTER',
    'IMPACT_TOP', 'MINIMAL_BOX', 'TOP_HEADLINE'], 'onScreenHook.style');
  if (!(plan.onScreenHook.endSec >= plan.onScreenHook.startSec)) errors.push('onScreenHook.range');
  oneOf(plan.subtitleStyle.template, ['PODCAST_BOLD', 'COMEDY_POP', 'EDUCATION_CLEAN',
    'FINANCE_BOLD', 'GAMING_ENERGY', 'NEWS_EDITORIAL'], 'subtitleStyle.template');
  oneOf(plan.subtitleStyle.position, ['BOTTOM', 'CENTER'], 'subtitleStyle.position');
  if (!Number.isInteger(plan.subtitleStyle.maxWordsPerLine) ||
    plan.subtitleStyle.maxWordsPerLine < 1) errors.push('subtitleStyle.maxWordsPerLine');
  if (typeof plan.subtitleStyle.highlightCurrentWord !== 'boolean') {
    errors.push('subtitleStyle.highlightCurrentWord');
  }
  if (typeof plan.audio.removeLongPauses !== 'boolean') errors.push('audio.removeLongPauses');
  for (const [index, rawText] of plan.onScreenText.entries()) {
    const item = record(rawText);
    if (typeof item.text !== 'string' || !finite(item.startSec) || !finite(item.endSec) ||
      Number(item.endSec) <= Number(item.startSec) ||
      !['TOP', 'CENTER', 'LOWER_THIRD'].includes(String(item.position)) ||
      !['NORMAL', 'STRONG'].includes(String(item.emphasis))) errors.push(`onScreenText[${index}]`);
  }
  for (const [index, rawOperation] of plan.operations.entries()) {
    const item = record(rawOperation);
    if (!['TRIM', 'REMOVE_SILENCE', 'ZOOM', 'ZOOM_OUT', 'REFRAME', 'WORD_HIGHLIGHT']
      .includes(String(item.type)) || !finite(item.startSec) || !finite(item.endSec) ||
      Number(item.endSec) <= Number(item.startSec)) errors.push(`operations[${index}]`);
  }
  if (plan.gradePreset !== undefined) oneOf(plan.gradePreset, ['CLEAN_SOCIAL',
    'WARM_TALKING_HEAD', 'COOL_DOCUMENTARY', 'NEUTRAL_EDUCATIONAL',
    'SOURCE_ALREADY_GRADED'], 'gradePreset');
  if (plan.backgroundMode !== undefined) oneOf(plan.backgroundMode, ['SOURCE_MATCH_SOLID',
    'SOURCE_MATCH_GRADIENT', 'DARK_NEUTRAL', 'SOFT_BLUR_EXTENSION'], 'backgroundMode');
  return errors;
}

function transcriptWords(segments: TranscriptSegment[]): { words: TimedWord[]; exact: boolean } {
  const exact = segments.flatMap((segment) => (Array.isArray(segment.words) ? segment.words : [])
    .flatMap((item) => {
      const word = record(item);
      return finite(word.start) && finite(word.end) && Number(word.end) > Number(word.start) &&
        typeof word.text === 'string' && word.text.trim()
        ? [{ start: Number(word.start), end: Number(word.end), text: word.text }] : [];
    }));
  if (exact.length) return { words: exact.sort((a, b) => a.start - b.start), exact: true };
  return { exact: false, words: segments.flatMap((segment) => {
    if (!(segment.end > segment.start)) return [];
    const tokens = segment.text.trim().split(/\s+/u).filter(Boolean);
    return tokens.map((text, index) => ({
      start: segment.start + (segment.end - segment.start) * index / tokens.length,
      end: segment.start + (segment.end - segment.start) * (index + 1) / tokens.length,
      text
    }));
  }) };
}

function captionPreset(plan: EditPlan): CaptionStylePresetId {
  const template: Record<string, CaptionStylePresetId> = {
    PODCAST_BOLD: 'PODCAST', COMEDY_POP: 'BOLD_HIGHLIGHT', EDUCATION_CLEAN: 'EDUCATIONAL',
    FINANCE_BOLD: 'HIGH_CONTRAST', GAMING_ENERGY: 'SOCIAL', NEWS_EDITORIAL: 'CLEAN'
  };
  const theme: Record<string, CaptionStylePresetId> = {
    CLEAN_WHITE: 'CLEAN', HIGH_CONTRAST: 'HIGH_CONTRAST', WARM_ACCENT: 'EDUCATIONAL',
    COOL_ACCENT: 'PODCAST', BOLD_SOCIAL: 'SOCIAL'
  };
  return template[plan.subtitleStyle.template] ?? theme[plan.subtitleTheme] ?? 'CLEAN';
}

function gradeFilter(value: unknown): ColorFilterId {
  return ({ CLEAN_SOCIAL: 'CLEAN', WARM_TALKING_HEAD: 'WARM',
    COOL_DOCUMENTARY: 'COOL', NEUTRAL_EDUCATIONAL: 'CLEAN',
    SOURCE_ALREADY_GRADED: 'ORIGINAL', NO_CHANGE: 'ORIGINAL' } as Record<string, ColorFilterId>)[
      String(value)] ?? 'ORIGINAL';
}

function textPreset(style: unknown, emphasis?: unknown): TextStylePresetId {
  if (emphasis === 'STRONG' || ['BOLD_POP', 'IMPACT', 'IMPACT_TOP'].includes(String(style))) {
    return 'BOLD_SOCIAL';
  }
  if (style === 'MINIMAL_BOX') return 'MINIMAL';
  return 'HOOK';
}

function measuredBox(telemetry: JsonRecord, fallbackBox: { x: number; y: number;
  width: number; height: number }) {
  const bounds = record(telemetry.hookBounds);
  const canvas = record(telemetry.canvasResolution);
  if (![bounds.x, bounds.y, bounds.width, bounds.height, canvas.width, canvas.height].every(finite) ||
    Number(canvas.width) <= 0 || Number(canvas.height) <= 0) return fallbackBox;
  return {
    x: round(Number(bounds.x) / Number(canvas.width)),
    y: round(Number(bounds.y) / Number(canvas.height)),
    width: round(Number(bounds.width) / Number(canvas.width)),
    height: round(Number(bounds.height) / Number(canvas.height))
  };
}

function sourceSpan(map: ReturnType<typeof buildTimelineMap>, start: number, end: number) {
  const placements: Array<{ startTime: number; duration: number }> = [];
  for (const segment of map.segments) {
    const overlapStart = Math.max(start, segment.sourceStart);
    const overlapEnd = Math.min(end, segment.sourceEnd);
    if (!(overlapEnd > overlapStart)) continue;
    placements.push({ startTime: round(segment.timelineStart + overlapStart - segment.sourceStart),
      duration: round(overlapEnd - overlapStart) });
  }
  return placements;
}

/**
 * Reconstruct a newly materialised AI_EDITED clip. The final telemetry segment
 * list is authoritative for cuts because the automatic renderer can repair the
 * editorial plan after it is produced. Plan operations alone are not sufficient.
 */
export function adaptAutomaticEditPlan(input: {
  editPlan: unknown;
  editTelemetry: unknown;
  sourceAssetId: string;
  sourceDuration: number;
  transcriptSegments: TranscriptSegment[];
  idFactory: IdFactory;
}): AutomaticEditResult {
  const raw = record(input.editPlan);
  if (raw.version !== undefined && raw.version !== 1) {
    return fallback('UNSUPPORTED_EDIT_PLAN_VERSION', `Received version ${String(raw.version)}`);
  }
  if (!isCurrentPlan(raw)) return fallback('MALFORMED_EDIT_PLAN',
    'The persisted editPlan does not satisfy the v1 reconstruction contract');
  const plan = raw as EditPlan;
  const schemaErrors = planSchemaErrors(plan);
  if (schemaErrors.length) return fallback('MALFORMED_EDIT_PLAN',
    `Invalid v1 fields: ${schemaErrors.join(', ')}`);
  const sourcePlanVersion = raw.version === undefined ? 'LEGACY_V1' as const : 1 as const;
  const telemetry = record(input.editTelemetry);
  const rawSegments = telemetry.timelineSegments;
  if (!Array.isArray(rawSegments) || !rawSegments.length) {
    return fallback('MISSING_FINAL_TIMELINE',
      'Final editTelemetry.timelineSegments is required; plan operations are not exact output cuts');
  }

  const segments: Array<{ sourceStart: number; sourceEnd: number; finalStart: number;
    finalEnd: number }> = [];
  let cursor = 0;
  for (const [index, item] of rawSegments.entries()) {
    const value = record(item);
    if (![value.sourceStart, value.sourceEnd, value.finalStart, value.finalEnd].every(finite)) {
      return fallback('MALFORMED_FINAL_TIMELINE', `Segment ${index} has non-numeric bounds`);
    }
    const segment = { sourceStart: Number(value.sourceStart), sourceEnd: Number(value.sourceEnd),
      finalStart: Number(value.finalStart), finalEnd: Number(value.finalEnd) };
    if (segment.sourceStart < 0 || segment.sourceEnd <= segment.sourceStart ||
      segment.sourceEnd > input.sourceDuration + 1e-3 ||
      segment.finalEnd <= segment.finalStart || Math.abs(segment.finalStart - cursor) > 0.05 ||
      Math.abs((segment.sourceEnd - segment.sourceStart) -
        (segment.finalEnd - segment.finalStart)) > 0.05) {
      return fallback('UNSAFE_FINAL_TIMELINE', `Segment ${index} is out of range or inconsistent`);
    }
    cursor = segment.finalEnd;
    segments.push(segment);
  }

  const approximations: AutomaticEditApproximation[] = [];
  const unsupported: string[] = [];
  if (plan.aspectRatio === '4:5') approximations.push({ capability: 'ASPECT_RATIO',
    source: '4:5', canonical: 'SOURCE',
    reason: 'EditMode does not currently expose a 4:5 canvas, so the source canvas is retained.' });
  const selectedGrade = record(telemetry.grading).selectedPreset ?? plan.gradePreset;
  const filterId = gradeFilter(selectedGrade);
  if (filterId !== 'ORIGINAL') approximations.push({ capability: 'COLOR_GRADE',
    source: String(selectedGrade), canonical: filterId,
    reason: 'Automatic tone curves have no one-to-one EditMode filter; the closest editable filter is resolved into canonical sliders.' });
  const color = colorProperties(resolveColorFilter(filterId), filterId, 1);

  const elements: EditElementInput[] = segments.map((segment, index) => ({
    id: input.idFactory('video', index), assetId: input.sourceAssetId, type: 'VIDEO',
    track: 0, position: index, startTime: round(segment.finalStart),
    duration: round(segment.finalEnd - segment.finalStart), trimStart: round(segment.sourceStart),
    trimEnd: round(segment.sourceEnd), properties: json({ ...color, sourceVolume: 1,
      sourceMuted: false, automaticSourceSegment: index,
      automaticReconstructionOrigin: 'FINAL_TELEMETRY' })
  }));
  const map = buildTimelineMap(elements.map((element) => ({ ...element,
    id: element.id!, properties: element.properties })));

  let hookCount = 0;
  if (plan.onScreenHook.enabled && plan.onScreenHook.text.trim()) {
    const placement = sourceSpan(map, plan.onScreenHook.startSec, plan.onScreenHook.endSec)[0];
    if (placement) {
      const preset = textStylePreset(textPreset(plan.onScreenHook.style));
      const box = measuredBox(telemetry, preset.box);
      elements.push({ id: input.idFactory('hook', 0), assetId: null, type: 'TEXT', track: 2,
        position: 0, startTime: placement.startTime, duration: placement.duration,
        trimStart: 0, trimEnd: null, properties: json({ ...box, ...styleProperties(preset.style),
          content: plan.onScreenHook.text, presetRole: 'HOOK', templateRole: 'HOOK',
          textStyleId: preset.id, scale: 1, rotation: 0, opacity: 1, zIndex: 40,
          anchor: 'top-left', locked: false, hidden: false,
          origin: 'AUTOMATIC_RECONSTRUCTION', manualEdited: false }) });
      hookCount = 1;
    } else unsupported.push('HOOK_REMOVED_BY_FINAL_CUTS');
  }

  let textOverlayCount = 0;
  for (const [index, rawText] of plan.onScreenText.entries()) {
    const item = record(rawText);
    if (typeof item.text !== 'string' || !item.text.trim() ||
      !finite(item.startSec) || !finite(item.endSec)) continue;
    for (const [part, placement] of sourceSpan(map, Number(item.startSec), Number(item.endSec)).entries()) {
      const preset = textStylePreset(textPreset(null, item.emphasis));
      const role = item.position === 'LOWER_THIRD' ? 'LOWER_THIRD' : 'KEY_POINT';
      const rolePreset = item.position === 'LOWER_THIRD' ? textStylePreset('LOWER_THIRD') : preset;
      elements.push({ id: input.idFactory('text', index * 100 + part), assetId: null, type: 'TEXT',
        track: 2, position: hookCount + textOverlayCount, startTime: placement.startTime,
        duration: placement.duration, trimStart: 0, trimEnd: null,
        properties: json({ ...rolePreset.box, ...styleProperties(rolePreset.style), content: item.text,
          presetRole: role, templateRole: role, textStyleId: rolePreset.id, scale: 1, rotation: 0,
          opacity: 1, zIndex: 38, anchor: 'top-left', locked: false, hidden: false,
          origin: 'AUTOMATIC_RECONSTRUCTION', manualEdited: false }) });
      textOverlayCount++;
    }
  }

  let captionCount = 0;
  if (plan.subtitleStyle.enabled) {
    const transcript = transcriptWords(input.transcriptSegments);
    if (!transcript.words.length) return fallback('CAPTIONS_REQUIRE_TRANSCRIPT',
      'The automatic plan requires captions but the original Video has no timed transcript');
    try {
      const generated = generateCaptions({ words: transcript.words, wordTimings: transcript.exact,
        map, limit: 400, wordsPerCaption: Math.max(2,
          Math.min(5, plan.subtitleStyle.maxWordsPerLine)) });
      const preset = captionStylePreset(captionPreset(plan));
      const captionBox = plan.subtitleStyle.position === 'CENTER'
        ? { ...preset.box, y: 0.48 } : preset.box;
      for (const [index, caption] of generated.captions.entries()) {
        elements.push({ id: input.idFactory('caption', index), assetId: null, type: 'SUBTITLE',
          track: 1, position: index, startTime: caption.startTime, duration: caption.duration,
          trimStart: 0, trimEnd: null, properties: json({ ...captionBox,
            ...styleProperties(preset.style), content: caption.content, words: caption.words,
            captionStyleId: preset.id, presetRole: 'SUBTITLE', scale: 1, rotation: 0, opacity: 1,
            zIndex: 35, anchor: 'top-left', locked: false, hidden: false, manualEdited: false,
            activeWord: { ...record(preset.style.activeWord),
              enabled: plan.subtitleStyle.highlightCurrentWord },
            transcriptTiming: transcript.exact ? 'WORD' : 'SEGMENT_DERIVED',
            origin: 'AUTOMATIC_RECONSTRUCTION' }) });
      }
      captionCount = generated.captions.length;
      approximations.push({ capability: 'CAPTION_STYLE',
        source: `${plan.subtitleStyle.template}/${plan.subtitleTheme}`,
        canonical: preset.id,
        reason: 'Automatic subtitle templates map to the closest editable EditMode caption preset; wording, grouping, timing, position, and active-word enablement remain canonical.' });
      if (!transcript.exact) approximations.push({ capability: 'CAPTION_WORD_TIMING',
        source: 'TRANSCRIPT_SEGMENTS', canonical: 'EVENLY_DERIVED_WORD_TIMINGS',
        reason: 'The source transcript did not persist per-word timings.' });
    } catch (error) {
      return fallback('CAPTION_RECONSTRUCTION_FAILED', (error as Error).message);
    }
  }

  let zoomCount = 0;
  const zoomEvents = Array.isArray(telemetry.zoomEvents) ? telemetry.zoomEvents : [];
  for (const [index, rawZoom] of zoomEvents.entries()) {
    const event = record(rawZoom);
    if (![event.startSec, event.endSec, event.peakScale].every(finite) ||
      Number(event.endSec) <= Number(event.startSec) || Number(event.startSec) < 0 ||
      Number(event.endSec) > map.durationSec + 1e-3) {
      unsupported.push(`MALFORMED_ZOOM_EVENT_${index}`);
      continue;
    }
    const requested = Number(event.peakScale);
    const scale = round(Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, requested)));
    elements.push({ id: input.idFactory('zoom', index), assetId: null, type: 'EFFECT', track: 3,
      position: index, startTime: round(Number(event.startSec)),
      duration: round(Number(event.endSec) - Number(event.startSec)), trimStart: 0, trimEnd: null,
      properties: json({ ...zoomProperties({ scale, enabled: true, claimsMoment: null,
        triggerText: typeof event.triggerText === 'string' ? event.triggerText : '' }),
        automaticPeakScale: requested, automaticFocusX: event.focusX,
        automaticFocusY: event.focusY, semanticReason: event.semanticReason ?? event.reason ?? '' }) });
    zoomCount++;
    if (Math.abs(scale - requested) > 1e-6) approximations.push({ capability: 'ZOOM_STRENGTH',
      source: `${requested}x`, canonical: `${scale}x`,
      reason: `EditMode's subject-safe editable zoom ceiling is ${MAX_ZOOM_SCALE}x.` });
  }

  const dynamicCrop = Array.isArray(telemetry.stabilizedCropCenters) &&
    telemetry.stabilizedCropCenters.length > 1;
  if (dynamicCrop) approximations.push({ capability: 'DYNAMIC_REFRAME',
    source: 'PER_FRAME_CROP_TRACK', canonical: 'EDITABLE_AUTO_REFRAME_POLICY',
    reason: 'EditMode stores crop per segment and deterministically recalculates safe camera motion from cached analysis.' });
  const backgroundMode = plan.backgroundMode;
  if (backgroundMode && backgroundMode !== 'DARK_NEUTRAL') unsupported.push(
    `BACKGROUND_MODE_${backgroundMode}`);
  if (plan.musicMood && plan.musicMood !== 'NONE') unsupported.push(
    'MUSIC_INTENT_WITHOUT_PERSISTED_ASSET_REFERENCE');
  if (plan.audio.normalize) approximations.push({ capability: 'AUDIO_NORMALIZATION',
    source: 'AUTOMATIC_LOUDNESS_NORMALIZATION', canonical: 'SOURCE_VOLUME_1',
    reason: 'No normalized gain value was persisted, so canonical audio starts at the original source level.' });

  const reframeSource = String(telemetry.reframeSource ?? '');
  const reframePolicy = plan.preserveInformation ? 'INFORMATION_PRESERVING'
    : reframeSource === 'FACE' ? 'FACE_FOCUSED' : reframeSource === 'PERSON' ? 'AUTO' : 'SOURCE';
  const report: AutomaticEditReport = { adapterVersion: AUTOMATIC_EDIT_ADAPTER_VERSION,
    sourcePlanVersion, segmentCount: segments.length, captionCount, hookCount, textOverlayCount,
    zoomCount, approximations, unsupported };
  return { mode: 'CANONICAL', elements, report, settingsPatch: {
    selectedPreset: 'SOURCE_MANUAL', aspectRatio: plan.aspectRatio === '4:5' ? 'SOURCE' : plan.aspectRatio,
    pacing: 'SOURCE', subtitlePolicy: captionCount ? 'AUTO' : 'OFF',
    hookPolicy: hookCount ? 'RECOMMENDED' : 'OFF', zoomPolicy: 'OFF', reframePolicy,
    musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE',
    textPolicy: textOverlayCount ? 'KEY_POINTS' : 'OFF', overlayPolicy: 'NONE',
    informationRegionPolicy: plan.preserveInformation ? 'PRESERVE' : 'RESPECT',
    hookText: hookCount ? plan.onScreenHook.text : null,
    automaticReconstruction: report
  } };
}
