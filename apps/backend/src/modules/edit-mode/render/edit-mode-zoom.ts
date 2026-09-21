// EditMode Phase 5 semantic zoom.
//
// Phase 4 persisted INTENT only: `settings.presetRun.plannedZoomMoments` says
// which spoken beats would justify emphasis. This module converts that intent
// into actual, bounded geometry and refuses the parts of it the footage does not
// support. Nothing here invents a zoom the plan did not ask for.
//
// A zoom is rendered only when, for every sampled instant it covers, the camera
// window it produces keeps the subject safe and any information region readable.
// When it does not, the scale is reduced first and only that one event is
// suppressed if reduction cannot save it - the rest of the plan still renders.

import { zoomWindow } from '../../editing/zoom-planner';
import type { AnalysisFrame } from '../../editing/edit-analysis';
import type { CropWindow } from '../../editing/reframe.service';
import type { Shot } from '../../editing/shot-classifier';
import type { PlannedZoomMoment, ZoomPolicy } from '../presets/edit-preset-policy';
import type { RenderFrameSegment, RenderZoomEvent,
  RenderZoomRejection } from './edit-mode-render.types';
import type { TimelineMap } from './edit-mode-timeline-map';

/** Bounded professional punch-ins. Nothing above STRONG is reachable. */
export const EDIT_MODE_ZOOM_SCALES: Record<Exclude<ZoomPolicy, 'OFF'>, number> = {
  SUBTLE: 1.06, MODERATE: 1.1, STRONG: 1.15
};
export const EDIT_MODE_ZOOM = {
  rampInSec: 0.35,
  rampOutSec: 0.45,
  minHoldSec: 0.3,
  /** Below this a punch-in is invisible; an event reduced this far is dropped. */
  minScale: 1.03,
  scaleStep: 0.02,
  /** Clearance from the shot edges, so a move never straddles a visual cut. */
  shotMarginSec: 0.12,
  minGapSec: 1.2,
  maxEvents: 8,
  /** Share of a subject that must stay inside the zoomed window. */
  subjectVisibleTarget: 0.95,
  informationVisibleTarget: 0.95,
  /** Text centred below this line is a burned-in caption, not information. */
  captionBandY: 0.74,
  minFaceArea: 0.0015,
  safetySampleHz: 6
} as const;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number) => Number(value.toFixed(4));

const overlapRatio = (box: { x: number; y: number; w: number; h: number }, window: CropWindow) => {
  const width = Math.max(0, Math.min(box.x + box.w, window.x + window.w) - Math.max(box.x, window.x));
  const height = Math.max(0, Math.min(box.y + box.h, window.y + window.h) - Math.max(box.y, window.y));
  return box.w * box.h > 0 ? width * height / (box.w * box.h) : 1;
};

/**
 * The rendered scale envelope at an exported-timeline instant.
 *
 * Shape matches what `zoomEnvelopeExpression` emits: an eased rise into the
 * hold and a smoothstep return that sets the camera back down on 1.0. Used by
 * the safety validator and by render QA, so both measure the same geometry the
 * filter graph produces.
 */
export function editModeZoomScaleAt(events: RenderZoomEvent[], t: number) {
  return 1 + events.reduce((sum, event) => {
    if (t <= event.startSec || t >= event.endSec) return sum;
    const rise = t >= event.peakStartSec ? 1
      : (() => { const u = (t - event.startSec) / (event.peakStartSec - event.startSec);
        return u * (2 - u); })();
    const fall = t <= event.peakEndSec ? 1
      : (() => { const d = (event.endSec - t) / (event.endSec - event.peakEndSec);
        return d * d * (3 - 2 * d); })();
    return sum + (event.peakScale - 1) * Math.min(rise, fall);
  }, 0);
}

/** zoompan `z` expression. Frame-based, exactly like the frozen renderer. */
export function zoomEnvelopeExpression(events: RenderZoomEvent[]) {
  const terms = events.map((event) => {
    const amplitude = (event.peakScale - 1).toFixed(4);
    const rampIn = Math.max(1, event.peakStartFrame - event.startFrame);
    const rampOut = Math.max(1, event.endFrame - event.peakEndFrame);
    const up = `max(0\\,min(1\\,(on-${event.startFrame})/${rampIn}))`;
    const down = `max(0\\,min(1\\,(${event.endFrame}-on)/${rampOut}))`;
    return `${amplitude}*min((${up})*(2-(${up}))\\,(${down})*(${down})*(3-2*(${down})))`;
  });
  return terms.length ? `1+${terms.join('+')}` : '1';
}

/** zoompan anchor expression for one axis. */
export function zoomAnchorExpression(events: RenderZoomEvent[], axis: 'focusX' | 'focusY') {
  return events.reduceRight((next, event) =>
    `if(between(on\\,${event.startFrame}\\,${event.endFrame})\\,` +
    `${event[axis].toFixed(4)}\\,${next})`, '0.5');
}

export type ZoomPlanInput = {
  policy: ZoomPolicy;
  moments: PlannedZoomMoment[];
  map: TimelineMap;
  shots: Shot[];
  frameSegments: RenderFrameSegment[];
  /** Analysis frames on the exported timeline. */
  frames: AnalysisFrame[];
  cropAt: (t: number) => CropWindow;
  focalAt: (t: number) => { x: number; y: number };
  fps: number;
  durationSec: number;
  /** Event ids a QA repair suppressed, and reduced scale ceilings, on re-render. */
  suppressed?: string[];
  scaleCeilings?: Record<string, number>;
};

export type ZoomPlanResult = { events: RenderZoomEvent[]; rejections: RenderZoomRejection[] };

/** Stable id for a planned moment, so a QA repair can name one exactly. */
export const zoomEventId = (startSec: number, triggerText: string) =>
  `z${startSec.toFixed(3)}-${triggerText.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 24).toLowerCase()}`;

export function planEditModeZoom(input: ZoomPlanInput): ZoomPlanResult {
  const events: RenderZoomEvent[] = [];
  const rejections: RenderZoomRejection[] = [];
  if (input.policy === 'OFF' || !input.moments.length) return { events, rejections };
  const suppressed = new Set(input.suppressed ?? []);
  const ceilings = input.scaleCeilings ?? {};

  // Phase 4 recorded the moments in SOURCE seconds. A moment whose words were
  // trimmed away simply has no exported instant and disappears with the cut.
  const mapped = input.moments.flatMap((moment) => {
    const starts = input.map.toTimeline(moment.startSec);
    if (!starts.length) {
      rejections.push({ triggerText: moment.triggerText, startSec: moment.startSec,
        reason: 'TRIGGER_REMOVED_FROM_TIMELINE' });
      return [];
    }
    return starts.map((startSec) => ({ moment, startSec,
      endSec: startSec + Math.max(0.6, moment.endSec - moment.startSec) }));
  }).sort((left, right) => left.startSec - right.startSec);

  for (const candidate of mapped) {
    const { moment } = candidate;
    const id = zoomEventId(candidate.startSec, moment.triggerText);
    const reject = (reason: string) => rejections.push({ triggerText: moment.triggerText,
      startSec: round(candidate.startSec), reason });
    if (suppressed.has(id)) { reject('QA_REPAIR_SUPPRESSED'); continue; }
    if (events.length >= EDIT_MODE_ZOOM.maxEvents) { reject('ZOOM_BUDGET_REACHED'); continue; }
    const previous = events[events.length - 1];
    if (previous && candidate.startSec - previous.endSec < EDIT_MODE_ZOOM.minGapSec) {
      reject('TOO_CLOSE_TO_PREVIOUS_ZOOM'); continue;
    }

    const shotIndex = input.shots.findIndex((shot) =>
      candidate.startSec >= shot.start - 1e-6 && candidate.startSec < shot.end);
    const shot = input.shots[shotIndex];
    const segment = input.frameSegments[shotIndex];
    if (!shot || !segment) { reject('NO_SHOT_AT_TRIGGER'); continue; }
    if (segment.layout !== 'FILL') { reject('SHOT_IS_FITTED_NOT_CROPPED'); continue; }
    if (!shot.zoomAllowed) { reject(`SHOT_DOES_NOT_ALLOW_ZOOM_${shot.shotClass}`); continue; }
    if (shot.informationMode) { reject('INFORMATION_SHOT'); continue; }

    // The whole move - rise, hold and return - has to live inside this shot,
    // with clearance at both ends, so it never interpolates across a hard cut.
    const startSec = Math.max(shot.start + EDIT_MODE_ZOOM.shotMarginSec, candidate.startSec);
    const rampIn = EDIT_MODE_ZOOM.rampInSec;
    const rampOut = EDIT_MODE_ZOOM.rampOutSec;
    const hold = Math.max(EDIT_MODE_ZOOM.minHoldSec, candidate.endSec - candidate.startSec);
    const endSec = startSec + rampIn + hold + rampOut;
    const limit = Math.min(shot.end - EDIT_MODE_ZOOM.shotMarginSec, input.durationSec);
    if (endSec > limit) { reject('SHOT_TOO_SHORT_FOR_A_SETTLED_ZOOM'); continue; }

    const focal = input.focalAt(startSec + rampIn + hold / 2);
    const focusX = clamp(focal.x, 0.25, 0.75);
    const focusY = clamp(focal.y, 0.25, 0.75);
    const ceiling = ceilings[id] ?? EDIT_MODE_ZOOM_SCALES[moment.intensity];
    let scale = Math.min(EDIT_MODE_ZOOM_SCALES[moment.intensity], ceiling);
    let failure = '';
    while (scale >= EDIT_MODE_ZOOM.minScale) {
      failure = safetyFailure({ ...input, startSec, peakStartSec: startSec + rampIn,
        peakEndSec: startSec + rampIn + hold, endSec, peakScale: scale, focusX, focusY });
      if (!failure) break;
      scale = Number((scale - EDIT_MODE_ZOOM.scaleStep).toFixed(4));
    }
    if (scale < EDIT_MODE_ZOOM.minScale) { reject(failure || 'UNSAFE_AT_EVERY_SCALE'); continue; }
    const requested = EDIT_MODE_ZOOM_SCALES[moment.intensity];
    const frame = (t: number) => Math.round(t * input.fps);
    events.push({
      id, startSec: round(startSec), peakStartSec: round(startSec + rampIn),
      peakEndSec: round(startSec + rampIn + hold), endSec: round(endSec),
      peakScale: scale, focusX: round(focusX), focusY: round(focusY),
      intensity: moment.intensity, triggerText: moment.triggerText, reason: moment.reason,
      startFrame: frame(startSec), peakStartFrame: frame(startSec + rampIn),
      peakEndFrame: frame(startSec + rampIn + hold), endFrame: frame(endSec),
      reducedFromScale: scale < requested - 1e-6 ? requested : null
    });
  }
  return { events, rejections };
}

/** Empty string when every sampled instant of this move is safe. */
function safetyFailure(input: ZoomPlanInput & { startSec: number; peakStartSec: number;
  peakEndSec: number; endSec: number; peakScale: number; focusX: number; focusY: number }) {
  const probe: RenderZoomEvent = { id: 'probe', startSec: input.startSec,
    peakStartSec: input.peakStartSec, peakEndSec: input.peakEndSec, endSec: input.endSec,
    peakScale: input.peakScale, focusX: input.focusX, focusY: input.focusY,
    intensity: 'SUBTLE', triggerText: '', reason: '', startFrame: 0, peakStartFrame: 0,
    peakEndFrame: 0, endFrame: 0, reducedFromScale: null };
  const step = 1 / EDIT_MODE_ZOOM.safetySampleHz;
  for (let t = input.startSec; t <= input.endSec + 1e-6; t += step) {
    const scale = editModeZoomScaleAt([probe], t);
    if (scale <= 1.001) continue;
    const window = zoomWindow(input.cropAt(t), scale, input.focusX, input.focusY);
    const frame = nearestFrame(input.frames, t);
    if (!frame) continue;
    const faces = frame.faces.filter((face) => face.w * face.h >= EDIT_MODE_ZOOM.minFaceArea)
      .sort((left, right) => right.w * right.h - left.w * left.h);
    const baseline = input.cropAt(t);
    const subjects = faces.filter((face) => overlapRatio(face, baseline) > 0.5).slice(0, 2);
    for (const face of subjects) {
      if (overlapRatio(face, window) < EDIT_MODE_ZOOM.subjectVisibleTarget) return 'SUBJECT_CROPPED';
      if ((face.y - window.y) / window.h < 0) return 'SUBJECT_HEADROOM_LOST';
    }
    const boxes = (frame.textBoxes ?? []).filter((box) =>
      box.y + box.h / 2 < EDIT_MODE_ZOOM.captionBandY && overlapRatio(box, baseline) > 0.5);
    for (const box of boxes) {
      if (overlapRatio(box, window) < EDIT_MODE_ZOOM.informationVisibleTarget) {
        return 'INFORMATION_REGION_CROPPED';
      }
    }
  }
  return '';
}

function nearestFrame(frames: AnalysisFrame[], t: number): AnalysisFrame | null {
  let best: AnalysisFrame | null = null;
  let distance = Infinity;
  for (const frame of frames) {
    const delta = Math.abs(frame.t - t);
    if (delta < distance) { distance = delta; best = frame; }
  }
  return distance <= 0.75 ? best : null;
}
