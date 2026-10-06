// EditMode Phase 5 render planning.
//
// Pure: it reads canonical EditProject state and the analysis/transcript already
// cached on the source asset, and returns a fully typed RenderPlan plus the
// evidence the QA pass reuses. It performs no I/O, calls no LLM, enqueues
// nothing and never touches the frozen pipeline's models or services.
//
// The canonical state is authoritative. There is no second render-only timeline
// model: every segment, overlay, caption and audio track in the plan is derived
// from an EditElement, and `settings` supplies only the policies.

import { gradingFilter, type GradePreset, type ImageStats } from '../../editing/color-grade';
import { buildSubtitlePhrases } from '../../editing/subtitle-phrases';
import { readAudioState, speechWindowsFromTranscript } from '../edit-mode-audio';
import { readTransform } from '../edit-mode-transform';
import { readZoomEffect } from '../edit-mode-zoom-events';
import { analysisFramesFromCache, wordsFromCache } from '../presets/edit-preset-evidence';
import { readEditPresetRun, readEditProjectStyle,
  type GradingPolicy } from '../presets/edit-preset-policy';
import { applyUppercase, readCaptionWords, readTextRuns, readTextStyle,
  DEFAULT_CAPTION_BOX } from '../edit-mode-text';
import { fontSizePx } from './edit-mode-ass';
import { autoFitText, type ResolvedVisualLayout } from '../styles/resolved-visual-layout';
import { planCamera, resolveCanvas } from './edit-mode-camera';
import { planEditModeZoom } from './edit-mode-zoom';
import { buildTimelineMap, remapAnalysisFrames,
  timelineShotBoundaries } from './edit-mode-timeline-map';
import type { EditExportErrorCode, RenderAudioTrack, RenderEvidence, RenderPlan,
  RenderTextOverlay, RenderVisualOverlay } from './edit-mode-render.types';

export const DEFAULT_RENDER_FPS = Number(process.env.EDIT_MODE_RENDER_FPS) || 30;
/** A caption line shorter than this would flash; render-time captions are held. */
const MIN_SUBTITLE_SEC = 0.35;
const NEUTRAL_STATS: ImageStats = { brightness: 0.45, contrast: 0.2, saturation: 0.3,
  highlightClipping: 0, shadowClipping: 0, meanR: 0.5, meanG: 0.5, meanB: 0.5 };

/** EditMode's own grading map. The frozen AI_EDITED grade defaults are untouched:
 * this borrows the pure filter builder and decides for itself how hard to push. */
export const EDIT_MODE_GRADES: Record<GradingPolicy,
  { preset: GradePreset; strengthScale: number }> = {
  NONE: { preset: 'NO_CHANGE', strengthScale: 0 },
  SUBTLE: { preset: 'CLEAN_SOCIAL', strengthScale: 0.5 },
  CLEAN: { preset: 'CLEAN_SOCIAL', strengthScale: 1 },
  WARM: { preset: 'WARM_TALKING_HEAD', strengthScale: 1 },
  CONTRAST: { preset: 'CLEAN_SOCIAL', strengthScale: 1.35 }
};

export class EditExportError extends Error {
  constructor(readonly code: EditExportErrorCode, message: string,
    readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = 'EditExportError';
  }
}

export type PlanAsset = {
  id: string; role: string; mimeType: string; duration: number | null;
  width: number | null; height: number | null; fps: number | null;
  metadata: unknown; transcript: unknown; analysis: unknown;
};
export type PlanElement = {
  id: string; assetId: string | null; type: string; track: number; position: number;
  startTime: number; duration: number; trimStart: number; trimEnd: number | null;
  properties: unknown;
};
export type PlanInput = {
  /** A bounded target for a source-preserving tool's preview/export. Default editor sizing is unchanged. */
  canvasOverride?: { width: number; height: number };
  project: { id: string; revision: number; settings: unknown };
  assets: PlanAsset[];
  elements: PlanElement[];
  /** Sampled from the real source file by the service; neutral when unavailable. */
  imageStats?: ImageStats | null;
  /** Whether the downloaded source actually decodes an audio stream. */
  hasSourceAudio?: boolean;
  fps?: number;
  /** Repair state carried into a re-render. */
  suppressedZoomIds?: string[];
  zoomScaleCeilings?: Record<string, number>;
  widenShots?: number[];
  informationFitShots?: number[];
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const number = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number) => Number(value.toFixed(6));

export type BuiltPlan = { plan: RenderPlan; evidence: RenderEvidence };

export function buildRenderPlan(input: PlanInput): BuiltPlan {
  const warnings: string[] = [];
  const style = readEditProjectStyle(input.project.settings);
  const storedLayout = record(input.project.settings).resolvedVisualLayout;
  const visualLayout = storedLayout && typeof storedLayout === 'object' && !Array.isArray(storedLayout) &&
    number(record(storedLayout).version, 0) === 1 ? storedLayout as ResolvedVisualLayout : null;
  const presetRun = readEditPresetRun(input.project.settings);
  const source = input.assets.find((asset) => asset.role === 'SOURCE');
  if (!source) {
    throw new EditExportError('SOURCE_MISSING', 'This EditProject has no source video attached.');
  }
  const sourceWidth = source.width && source.width > 0 ? source.width : 1920;
  const sourceHeight = source.height && source.height > 0 ? source.height : 1080;
  const fps = Math.max(1, Math.round(input.fps ?? source.fps ?? DEFAULT_RENDER_FPS));

  const map = buildTimelineMap(input.elements.map((element) => ({
    id: element.id, type: element.type, track: element.track, position: element.position,
    startTime: element.startTime, duration: element.duration,
    trimStart: element.trimStart, trimEnd: element.trimEnd,
    properties: element.properties })));
  if (!map.segments.length || !(map.durationSec > 0)) {
    throw new EditExportError('INVALID_TIMELINE',
      'The timeline has no playable video segment to export.');
  }

  const canvas = input.canvasOverride ?? resolveCanvas(style.aspectRatio, sourceWidth, sourceHeight);
  const cached = analysisFramesFromCache(source.analysis);
  const transcript = wordsFromCache(source.transcript);
  if (!cached.frames.length) {
    warnings.push('The source has no cached visual analysis, so framing falls back to a ' +
      'centred camera and no semantic zoom is rendered.');
  }
  const frames = remapAnalysisFrames(cached.frames, map);
  const boundaries = timelineShotBoundaries(cached.shotBoundaries, map);
  const automatic2 = visualLayout?.editingProfile === 'AUTOMATIC_2';
  const card = automatic2 && visualLayout?.videoFrame.mode === 'CARD'
    ? { x: 0, y: 0, width: canvas.width,
      height: Math.max(2, Math.round(visualLayout.videoFrame.height * canvas.height / 2) * 2) }
    : undefined;
  const camera = planCamera({
    policy: style.reframePolicy,
    preserveInformation: style.informationRegionPolicy !== 'IGNORE',
    aspectRatio: style.aspectRatio,
    canvas: { ...canvas, fps }, source: { width: sourceWidth, height: sourceHeight },
    frames, boundaries, map,
    widenShots: input.widenShots, informationFitShots: input.informationFitShots,
    viewport: card, speakerSafe: automatic2, words: transcript.words
  });

  const zoom = planEditModeZoom({
    policy: style.zoomPolicy, moments: presetRun?.plannedZoomMoments ?? [], map,
    shots: camera.shots, frameSegments: camera.frameSegments, frames,
    cropAt: camera.cropAt, focalAt: camera.focalAt, fps, durationSec: map.durationSec,
    suppressed: input.suppressedZoomIds, scaleCeilings: input.zoomScaleCeilings,
    minGapSec: automatic2 ? 5 : undefined,
    maxEvents: automatic2 ? (map.durationSec <= 15 ? 1 : map.durationSec <= 45 ? 3 : 4) : undefined,
    switchTimes: automatic2 ? camera.speakerSegments.slice(1).map((segment) => segment.startSec) : undefined,
    manual: input.elements.flatMap((element) => {
      const zoom = element.type === 'EFFECT' ? readZoomEffect(element.properties) : null;
      return zoom ? [{ elementId: element.id, startSec: element.startTime,
        endSec: element.startTime + element.duration, scale: zoom.scale, enabled: zoom.enabled,
        claimsMoment: zoom.claimsMoment, triggerText: zoom.triggerText,
        semanticReason: zoom.semanticReason, focusX: zoom.focusX, focusY: zoom.focusY,
        focusTrackId: zoom.focusTrackId }] : [];
    })
  });

  const grade = EDIT_MODE_GRADES[style.gradingPolicy];
  const stats = input.imageStats ?? NEUTRAL_STATS;
  const grading = {
    policy: style.gradingPolicy, preset: grade.preset, strengthScale: grade.strengthScale,
    filter: grade.strengthScale > 0
      ? gradingFilter(grade.preset, stats, grade.strengthScale).filter : 'null'
  };

  // --- Overlays -------------------------------------------------------------
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const visualOverlays: RenderVisualOverlay[] = [];
  const textOverlays: RenderTextOverlay[] = [];
  const subtitles: RenderTextOverlay[] = [];
  const audioTracks: RenderAudioTrack[] = [];

  for (const element of input.elements) {
    if (element.type === 'VIDEO' && element.track === 0) continue;
    const properties = record(element.properties);
    const startSec = round(Math.max(0, element.startTime));
    const endSec = round(Math.min(map.durationSec, element.startTime + element.duration));
    if (element.type === 'IMAGE') {
      // Hiding an overlay is canonical element state, exactly as it is for a
      // caption: a hidden logo is absent from the export as well as the preview.
      if (properties.hidden === true) continue;
      const asset = element.assetId ? assetsById.get(element.assetId) : undefined;
      if (!asset) {
        throw new EditExportError('ASSET_MISSING',
          'An overlay on the timeline references an asset that is no longer in this project.',
          { elementId: element.id, assetId: element.assetId });
      }
      visualOverlays.push({
        elementId: element.id, assetId: asset.id,
        role: properties.role === 'LOGO' || asset.role === 'LOGO' ? 'LOGO' : 'IMAGE',
        x: Math.round(clamp01(number(properties.x, 0)) * canvas.width),
        y: Math.round(clamp01(number(properties.y, 0)) * canvas.height),
        width: Math.max(2, Math.round(clamp01(number(properties.width, 0.2)) * canvas.width)),
        height: Math.max(2, Math.round(clamp01(number(properties.height, 0.2)) * canvas.height)),
        startSec, endSec,
        opacity: clamp01(number(properties.opacity, 1)),
        zIndex: Math.round(number(properties.zIndex, 10)),
        preserveAspectRatio: properties.preserveAspectRatio !== false,
        ...readTransform(properties)
      });
      continue;
    }
    if (element.type === 'TEXT' || element.type === 'SUBTITLE') {
      // "Hide captions" is canonical element state, so a hidden caption is
      // absent from the export exactly as it is absent from the preview.
      if (properties.hidden === true) continue;
      let overlay = textOverlay(element, properties, canvas, startSec, endSec);
      const role = String(properties.templateRole ?? properties.presetRole ?? '');
      const region = element.type === 'SUBTITLE' ? visualLayout?.captions
        : role === 'HOOK' ? visualLayout?.hook
          : role === 'KEY_POINT' ? visualLayout?.supportingText : null;
      if (region) {
        const preferred = element.type === 'SUBTITLE' ? region.fontSize
          : autoFitText(overlay.content, { width: region.width, height: region.height,
            maxLines: region.maxLines, preferred: region.fontSize,
            minimum: Math.min(30, region.fontSize), lineHeight: region.lineHeight,
            ...('glyphWidthEm' in region && region.glyphWidthEm
              ? { glyphWidthEm: region.glyphWidthEm } : {}) });
        overlay = { ...overlay,
          x: Math.round(region.x * canvas.width), y: Math.round(region.y * canvas.height),
          width: Math.round(region.width * canvas.width), height: Math.round(region.height * canvas.height),
          fontSizePx: fontSizePx(preferred, canvas.width), lineSpacing: region.lineHeight };
      }
      (element.type === 'SUBTITLE' ? subtitles : textOverlays).push(overlay);
      continue;
    }
    if (element.type === 'AUDIO') {
      const asset = element.assetId ? assetsById.get(element.assetId) : undefined;
      if (!asset) {
        throw new EditExportError('ASSET_MISSING',
          'An audio element on the timeline references an asset that is no longer in this project.',
          { elementId: element.id, assetId: element.assetId });
      }
      const trimStart = Math.max(0, number(element.trimStart, 0));
      // Every audio value is read through the canonical reader, so the editor,
      // an assistant bundle and the renderer resolve a missing or out-of-range
      // stored value in exactly one place - and a legacy clip saved before
      // ducking existed reads back un-ducked rather than as NaN.
      const audio = readAudioState(properties);
      // Fades are carried through EXACTLY as stored. They are bounds-checked by
      // the command layer on the way in and by `validateRenderPlan` on the way
      // out: a pair that does not fit its clip fails the export with a clear
      // message rather than being silently shortened into something the user
      // never asked for.
      const length = Math.max(0, endSec - startSec);
      audioTracks.push({
        elementId: element.id, assetId: asset.id, kind: 'MUSIC', startSec, endSec,
        trimStart: round(trimStart),
        trimEnd: round(element.trimEnd == null ? trimStart + length : element.trimEnd),
        volume: audio.volume, muted: audio.muted,
        fadeInSec: round(audio.fadeInSec), fadeOutSec: round(audio.fadeOutSec),
        duckUnderSpeech: audio.duckEnabled,
        duckLevel: audio.duckGain,
        attackMs: audio.attackMs, releaseMs: audio.releaseMs
      });
    }
  }

  // --- Render-time captions --------------------------------------------------
  // Phase 4 saves the subtitle POLICY rather than caption elements when the
  // transcript yields more lines than an editable track should hold. The
  // captions are then built here, from the same cached transcript and the same
  // deterministic phrase logic, word for word and on their own timings.
  let subtitlesFromTranscript = false;
  const hasSourceAudio = input.hasSourceAudio ?? record(source.metadata).hasAudio !== false;

  // --- Speech windows for ducking -------------------------------------------
  //
  // Derived from the SAME cached transcript the captions use, projected onto the
  // exported timeline by the same map. Nothing re-transcribes and nothing
  // guesses: when the cached transcript carries no word timings there are no
  // windows, `duckingAvailable` is false, and the command layer refuses to turn
  // ducking on rather than shipping an export that silently does nothing.
  const duckingAvailable = transcript.wordTimings && transcript.words.length > 0;
  const speechWindows = duckingAvailable
    ? speechWindowsFromTranscript(transcript.words, map) : [];
  if (!duckingAvailable && audioTracks.some((track) => track.duckUnderSpeech)) {
    warnings.push('A music track asks to duck under speech, but the cached transcript has no ' +
      'word timings, so no ducking is applied.');
  }
  // Step 5 shadow-state rule: canonical SUBTITLE elements always win. A track
  // whose captions are all HIDDEN still exists - the user hid it - so it must
  // not be silently replaced by a render-only track built from the transcript.
  const hasCanonicalCaptions = input.elements.some((element) => element.type === 'SUBTITLE');
  if (style.subtitlePolicy !== 'OFF' && !hasCanonicalCaptions) {
    if (!transcript.wordTimings) {
      warnings.push('Subtitles are enabled but the cached transcript has no word timings, so no ' +
        'captions are rendered.');
    } else {
      const template = defaultSubtitleOverlay(canvas);
      for (const phrase of buildSubtitlePhrases(transcript.words)) {
        for (const start of map.toTimeline(phrase.start)) {
          // A caption never outlives the clip its words were spoken in: a phrase
          // that straddles a cut is held to the end of its own segment rather
          // than carried over footage the viewer no longer hears it in.
          const segment = map.segments.find((item) => start >= item.timelineStart - 1e-6 &&
            start < item.timelineEnd);
          const end = Math.min(segment?.timelineEnd ?? map.durationSec,
            start + Math.max(MIN_SUBTITLE_SEC, phrase.end - phrase.start));
          if (!(end > start)) continue;
          subtitles.push({ ...template, elementId: `transcript-${subtitles.length}`,
            content: phrase.lines.join('\n'), lines: phrase.lines,
            startSec: round(start), endSec: round(end) });
        }
      }
      subtitlesFromTranscript = subtitles.length > 0;
      if (subtitlesFromTranscript) {
        warnings.push(`${subtitles.length} caption line${subtitles.length === 1 ? '' : 's'} ` +
          'generated at render time from the cached transcript, because the timeline stores ' +
          'the subtitle policy rather than caption elements.');
      }
    }
  }

  const plan: RenderPlan = {
    editProjectId: input.project.id,
    sourceRevision: input.project.revision,
    sourceAssetId: source.id,
    presetId: style.selectedPreset,
    canvas: { ...canvas, fps, aspectRatio: style.aspectRatio, sourceWidth, sourceHeight,
      visualLayout,
      fitBackground: ['BLACK', 'WHITE'].includes(String(record(input.project.settings).fitBackground))
        ? record(input.project.settings).fitBackground as 'BLACK' | 'WHITE' : 'BLUR' },
    durationSec: map.durationSec,
    videoSegments: map.segments,
    visualOverlays, textOverlays, subtitles, audioTracks,
    frameSegments: camera.frameSegments,
    zoomEvents: zoom.events, zoomRejections: zoom.rejections,
    grading, output: {
      container: 'mp4', videoCodec: 'h264', audioCodec: 'aac',
      crf: Number(process.env.EDIT_MODE_RENDER_CRF) || 20,
      preset: process.env.EDIT_MODE_RENDER_PRESET || 'veryfast',
      audioBitrate: '160k'
    },
    policies: { aspectRatio: style.aspectRatio, reframePolicy: style.reframePolicy,
      zoomPolicy: style.zoomPolicy, gradingPolicy: style.gradingPolicy,
      subtitlePolicy: style.subtitlePolicy },
    hasSourceAudio,
    speechWindows,
    duckingAvailable,
    subtitlesFromTranscript,
    warnings
  };

  return { plan, evidence: { shots: camera.shots, informationRegion: camera.informationRegion,
    informationCrop: camera.informationCrop,
    frames, cropAt: camera.cropAt, fitExpression: camera.fitExpression,
    informationFitExpression: camera.informationFitExpression, cameraFilter: camera.filter,
    renderHeight: automatic2 && card ? card.height : canvas.height,
    speakerSegments: camera.speakerSegments, speakerSwitchCount: camera.speakerSwitchCount,
    faceSafetyViolations: camera.faceSafetyViolations, cameraMoves: camera.cameraMoves,
    punches: camera.punches } };
}

function textOverlay(element: PlanElement, properties: Record<string, unknown>,
  canvas: { width: number; height: number }, startSec: number,
  endSec: number): RenderTextOverlay {
  // Style is read through the canonical reader, so the renderer and the editor
  // resolve defaults, legacy `backgroundColor` plates and out-of-range stored
  // values in exactly one place.
  const style = readTextStyle(properties);
  const raw = typeof properties.content === 'string' ? properties.content : '';
  const content = applyUppercase(raw, style.uppercase);
  // Word timings are stored relative to the element; the ASS builder works in
  // timeline seconds, so they are rebased here once.
  const words = readCaptionWords(properties)
    .map((word) => ({ start: round(startSec + word.start), end: round(startSec + word.end),
      text: applyUppercase(word.text, style.uppercase) }))
    .filter((word) => word.end > word.start);
  return {
    elementId: element.id,
    kind: element.type === 'SUBTITLE' ? 'SUBTITLE' : 'TEXT',
    content,
    lines: content.split(/\r?\n/u),
    startSec, endSec,
    x: Math.round(clamp01(number(properties.x, DEFAULT_CAPTION_BOX.x)) * canvas.width),
    y: Math.round(clamp01(number(properties.y, 0.4)) * canvas.height),
    width: Math.max(2, Math.round(clamp01(number(properties.width, 0.8)) * canvas.width)),
    height: Math.max(2, Math.round(clamp01(number(properties.height, 0.15)) * canvas.height)),
    fontSizePx: fontSizePx(style.fontSize, canvas.width),
    fontWeight: style.fontWeight,
    fontFamily: style.fontFamily,
    textAlign: style.textAlign,
    color: style.color,
    backgroundColor: typeof properties.backgroundColor === 'string'
      ? properties.backgroundColor : 'transparent',
    opacity: style.opacity,
    zIndex: Math.round(number(properties.zIndex, 30)),
    presetRole: typeof properties.presetRole === 'string' ? properties.presetRole : null,
    stroke: style.stroke,
    shadow: style.shadow,
    background: style.background,
    // Letter spacing travels in DESIGN units; the ASS builder converts it with
    // the same helper every other dimension uses.
    letterSpacing: style.letterSpacing,
    lineSpacing: style.lineSpacing,
    rotation: number(properties.rotation, 0),
    uppercase: style.uppercase,
    activeWord: style.activeWord,
    textRuns: readTextRuns(properties).map((run) => ({ ...run,
      text: applyUppercase(run.text, style.uppercase) })),
    words
  };
}

/** The caption style render-time captions use. It mirrors the layout Phase 4
 * gives a caption element, so a policy-only project and an element-backed one
 * render the same shape. */
function defaultSubtitleOverlay(canvas: { width: number; height: number }): RenderTextOverlay {
  const style = readTextStyle({});
  return {
    elementId: 'transcript', kind: 'SUBTITLE', content: '', lines: [],
    startSec: 0, endSec: 0,
    x: Math.round(DEFAULT_CAPTION_BOX.x * canvas.width),
    y: Math.round(DEFAULT_CAPTION_BOX.y * canvas.height),
    width: Math.round(DEFAULT_CAPTION_BOX.width * canvas.width),
    height: Math.round(DEFAULT_CAPTION_BOX.height * canvas.height),
    fontSizePx: fontSizePx(40, canvas.width), fontWeight: 700,
    fontFamily: 'Inter, sans-serif', textAlign: 'center',
    color: '#ffffff', backgroundColor: '#00000099', opacity: 1, zIndex: 35,
    presetRole: 'SUBTITLE',
    stroke: { ...style.stroke },
    shadow: { ...style.shadow },
    background: { enabled: true, color: '#000000', opacity: 0.6, padding: 12, radius: 8 },
    letterSpacing: 0, lineSpacing: 1.2, rotation: 0, uppercase: false,
    activeWord: { ...style.activeWord },
    textRuns: [],
    words: []
  };
}
