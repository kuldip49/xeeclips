// EditMode Phase 5 camera: shots, reframe policy and the crop the renderer uses.
//
// The frozen editing intelligence is reused as PURE LOGIC only - `classifyFrames`
// decides what a shot is, `ReframeService.plan` solves the camera path, and
// `detectInformationRegion` finds the readable region. None of the auto
// pipeline's orchestration (its clip exporter, its edit plan, its quality gate)
// is involved, and none of its defaults are changed: EditMode instantiates
// ReframeService locally and asks for a plain full-canvas camera, never the
// auto pipeline's editorial letterbox composition.

import { detectInformationRegion, regionCropRect,
  type InformationRegion } from '../../editing/information-region';
import { OUTPUT_DIMENSIONS, ReframeService,
  type CropWindow } from '../../editing/reframe.service';
import { classifyFrames, type Shot } from '../../editing/shot-classifier';
import type { AnalysisFrame } from '../../editing/edit-analysis';
import type { OutputAspectRatio } from '../../processing/processing-type';
import type { EditAspectRatio, ReframePolicy } from '../presets/edit-preset-policy';
import type { RenderFrameSegment } from './edit-mode-render.types';
import type { TimelineMap } from './edit-mode-timeline-map';

/**
 * Production canvases. Square pixels throughout.
 *
 * These are deliberately the same three shapes `OUTPUT_DIMENSIONS` already
 * solves a camera for, so a tracked EditMode export uses the frozen camera
 * solver's own filter unchanged rather than a rewritten approximation of it.
 */
export const EDIT_MODE_CANVASES: Record<Exclude<EditAspectRatio, 'SOURCE'>,
  { width: number; height: number; reframe: OutputAspectRatio }> = {
  '9:16': { ...OUTPUT_DIMENSIONS['9:16'], reframe: '9:16' },
  '16:9': { ...OUTPUT_DIMENSIONS['16:9'], reframe: '16:9' },
  '1:1': { ...OUTPUT_DIMENSIONS['1:1'], reframe: '1:1' }
};
/** Upper bound on a SOURCE export, so a 4K source does not become a 4K render. */
export const SOURCE_CANVAS_MAX_DIMENSION = 1920;
export const SOURCE_CANVAS_MIN_DIMENSION = 128;

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function resolveCanvas(aspectRatio: EditAspectRatio, sourceWidth: number,
  sourceHeight: number): { width: number; height: number } {
  if (aspectRatio !== 'SOURCE') {
    const canvas = EDIT_MODE_CANVASES[aspectRatio];
    return { width: canvas.width, height: canvas.height };
  }
  const width = sourceWidth > 0 ? sourceWidth : 1920;
  const height = sourceHeight > 0 ? sourceHeight : 1080;
  const longest = Math.max(width, height);
  const scale = longest > SOURCE_CANVAS_MAX_DIMENSION
    ? SOURCE_CANVAS_MAX_DIMENSION / longest : 1;
  return {
    width: Math.max(SOURCE_CANVAS_MIN_DIMENSION, even(width * scale)),
    height: Math.max(SOURCE_CANVAS_MIN_DIMENSION, even(height * scale))
  };
}

/** The share of the source frame width a FILL crop keeps for this canvas. */
export function cropWidthFor(canvasWidth: number, canvasHeight: number, sourceWidth: number,
  sourceHeight: number) {
  const sourceAspect = sourceWidth / sourceHeight;
  const target = canvasWidth / canvasHeight;
  if (!(sourceAspect > 0) || !(target > 0)) return 1;
  return Math.max(0.05, Math.min(1, target / sourceAspect));
}

export type CameraInput = {
  policy: ReframePolicy;
  preserveInformation: boolean;
  aspectRatio: EditAspectRatio;
  canvas: { width: number; height: number; fps: number };
  source: { width: number; height: number };
  /** Analysis frames already projected onto the exported timeline. */
  frames: AnalysisFrame[];
  /** Shot boundaries on the exported timeline (segment joins included). */
  boundaries: number[];
  map: TimelineMap;
  /** Shot indexes a QA repair asked to widen or fit, applied on a re-render. */
  widenShots?: number[];
  informationFitShots?: number[];
};

export type CameraPlan = {
  shots: Shot[];
  frameSegments: RenderFrameSegment[];
  informationRegion: InformationRegion | null;
  informationCrop: { x: number; y: number; width: number; height: number } | null;
  /** The exported-timeline crop window in source-normalized coordinates. */
  cropAt: (t: number) => CropWindow;
  focalAt: (t: number) => { x: number; y: number };
  /** FFmpeg filter chain producing the FILL branch at canvas resolution. */
  filter: string;
  /** `enable` expressions for the fitted branches; empty when unused. */
  fitExpression: string;
  informationFitExpression: string;
  cropWidth: number;
  tracked: boolean;
};

const enableExpression = (segments: RenderFrameSegment[],
  match: (segment: RenderFrameSegment) => boolean) => segments.filter(match)
  .map((segment) => `between(t\\,${segment.startSec.toFixed(3)}\\,` +
    `${Math.max(segment.startSec, segment.endSec - 0.001).toFixed(3)})`).join('+');

/**
 * Builds the exported-timeline shots and the camera that frames them.
 *
 * The reframe policy modulates - never replaces - what the evidence says:
 *
 *   SOURCE                  every shot keeps the whole source frame; a canvas of
 *                           a different shape letterboxes it rather than cropping.
 *   AUTO                    the shot classifier's own FILL/FIT decision stands.
 *   FACE_FOCUSED            shots with a real detected face are filled and
 *                           tracked; shots without one keep the classifier's
 *                           decision, so no speaker is ever invented.
 *   INFORMATION_PRESERVING  information shots are fitted to their detected
 *                           region; face shots still get face-safe framing.
 */
export function planCamera(input: CameraInput): CameraPlan {
  const { canvas, source, map } = input;
  const cropWidth = cropWidthFor(canvas.width, canvas.height, source.width, source.height);
  const bounds = [0, ...input.boundaries.filter((value) => value > 0.2 &&
    value < map.durationSec - 0.2), map.durationSec];
  const shots: Shot[] = [];
  for (let index = 0; index < bounds.length - 1; index++) {
    const start = bounds[index];
    const end = bounds[index + 1];
    if (end - start < 0.04) continue;
    const frames = input.frames.filter((frame) => frame.t >= start - 0.01 && frame.t < end + 0.01);
    const classified = classifyFrames(frames, cropWidth,
      { preserveInformation: input.preserveInformation });
    shots.push({ sourceStart: map.toSource(start) ?? start,
      sourceEnd: map.toSource(Math.max(start, end - 1e-4)) ?? end,
      start, end, sampleCount: frames.length, ...classified });
  }
  if (!shots.length) {
    shots.push({ sourceStart: 0, sourceEnd: map.durationSec, start: 0, end: map.durationSec,
      sampleCount: 0, shotClass: 'OTHER', frameMode: 'SOURCE_COMPOSITION', layout: 'FILL',
      zoomAllowed: false, informationMode: false, faceCount: 0, personCount: 0,
      primaryFaceArea: 0, textCoverage: 0, reason: 'NO_ANALYSIS_SAMPLES' });
  }

  const sameShape = Math.abs(canvas.width / canvas.height - source.width / source.height) < 0.01;
  const widen = new Set(input.widenShots ?? []);
  const informationFit = new Set(input.informationFitShots ?? []);
  const frameSegments: RenderFrameSegment[] = shots.map((shot, shotIndex) => {
    let layout: RenderFrameSegment['layout'] = shot.layout;
    let reason = shot.reason;
    if (input.policy === 'SOURCE') {
      layout = sameShape ? 'FILL' : 'FIT';
      reason = `${reason}+REFRAME_SOURCE`;
    } else if (input.policy === 'FACE_FOCUSED' && shot.faceCount >= 1 && shot.layout === 'FILL') {
      reason = `${reason}+FACE_FOCUSED`;
    } else if (input.policy === 'INFORMATION_PRESERVING' && shot.informationMode) {
      layout = 'INFORMATION_FIT';
      reason = `${reason}+INFORMATION_PRESERVING`;
    }
    // QA repairs are local to the shot they name and never disable a feature
    // globally: a subject-safety failure widens that one shot to a whole-frame
    // fit, an information failure crops that one shot to its readable region.
    if (informationFit.has(shotIndex) && layout !== 'INFORMATION_FIT') {
      layout = 'INFORMATION_FIT';
      reason = `${reason}+QA_INFORMATION_REPAIR`;
    } else if (widen.has(shotIndex) && layout === 'FILL') {
      layout = 'FIT';
      reason = `${reason}+QA_SUBJECT_SAFETY_REPAIR`;
    }
    return { shotIndex, startSec: shot.start, endSec: shot.end, layout,
      shotClass: shot.shotClass, frameMode: shot.frameMode, faceCount: shot.faceCount, reason };
  });
  // The shot list carries the resolved layout too, so subject-safety measurement
  // (which treats FIT as always safe) agrees with what is actually rendered.
  frameSegments.forEach((segment, index) => {
    shots[index].layout = segment.layout === 'FILL' ? 'FILL' : 'FIT';
    shots[index].informationMode = shots[index].informationMode ||
      segment.layout === 'INFORMATION_FIT';
  });

  const informationRegion = frameSegments.some((segment) => segment.layout === 'INFORMATION_FIT')
    ? detectInformationRegion(input.frames,
      shots.filter((_, index) => frameSegments[index].layout === 'INFORMATION_FIT'),
      { width: canvas.width, height: canvas.height }, source)
    : null;

  const faces = input.frames.flatMap((frame) => frame.faces);
  const persons = input.frames.flatMap((frame) => frame.persons);
  // Face tracking is only ever driven by real detections. A policy of SOURCE, or
  // a timeline whose analysis found nobody, gets a static centred camera.
  const tracked = input.policy !== 'SOURCE' && input.aspectRatio !== 'SOURCE' &&
    faces.length + persons.length > 0;
  let filter: string;
  let cropAt: (t: number) => CropWindow;
  let focalAt: (t: number) => { x: number; y: number };
  if (tracked) {
    const camera = new ReframeService().plan(
      EDIT_MODE_CANVASES[input.aspectRatio as Exclude<EditAspectRatio, 'SOURCE'>].reframe,
      faces, persons, 0, [], source.width, source.height, [], canvas.fps, undefined,
      // `false` keeps the auto pipeline's editorial letterbox composition out of
      // EditMode: the camera fills the whole canvas and EditMode composes its own.
      false, { shots });
    filter = camera.filter;
    cropAt = camera.cropAt;
    focalAt = camera.focalAt;
  } else {
    const cropHeight = clamp(cropWidthFor(canvas.height, canvas.width, source.height,
      source.width), 0.01, 1);
    const window: CropWindow = { x: (1 - cropWidth) / 2, y: (1 - cropHeight) / 2,
      w: cropWidth, h: cropHeight };
    filter = sameShape
      ? `fps=${canvas.fps},scale=${canvas.width}:${canvas.height},setsar=1`
      : `fps=${canvas.fps},scale=${canvas.width}:${canvas.height}:` +
        `force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},setsar=1`;
    cropAt = () => window;
    focalAt = () => ({ x: 0.5, y: 0.5 });
  }

  // An information shot with no distinct readable region (the content already
  // fills the frame, so cropping to it buys nothing) still has to keep the whole
  // frame: it falls back to the plain fitted branch, never to a crop.
  const hasRegion = informationRegion != null;
  return {
    shots, frameSegments, informationRegion,
    informationCrop: informationRegion ? regionCropRect(informationRegion, source) : null,
    cropAt, focalAt, filter,
    fitExpression: enableExpression(frameSegments, (segment) => segment.layout === 'FIT' ||
      (segment.layout === 'INFORMATION_FIT' && !hasRegion)),
    informationFitExpression: hasRegion ? enableExpression(frameSegments,
      (segment) => segment.layout === 'INFORMATION_FIT') : '',
    cropWidth, tracked
  };
}
