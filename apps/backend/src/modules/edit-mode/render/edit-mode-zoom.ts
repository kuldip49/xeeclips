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
import { zoomMomentKey } from '../edit-mode-zoom-events';
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

/** Spacing and budget of the shared phrase-timed emphasis policy (StyleOne and StyleTwo). One definition, used by
 *  the renderer and by the style compiler's renderability check. */
export const phraseZoomLimits = (durationSec: number) => ({ minGapSec: 5,
  maxEvents: durationSec <= 15 ? 1 : durationSec <= 45 ? 3 : 4 });

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
  /**
   * Workstream G: zoom EFFECT elements, already on the exported timeline. They
   * render whatever the zoom POLICY says - the user placed them - but they go
   * through exactly the same shot, information and subject-safety checks as a
   * planned moment. One that claims a planned moment replaces it.
   */
  manual?: ManualZoomInput[];
  minGapSec?: number;
  maxEvents?: number;
  /** Speaker/camera changes that must settle before a punch-in starts. */
  switchTimes?: number[];
};

export type ManualZoomInput = {
  elementId: string; startSec: number; endSec: number; scale: number; enabled: boolean;
  claimsMoment: string | null; triggerText: string; semanticReason?: string;
  focusX?: number | null; focusY?: number | null; focusTrackId?: string | null;
};

export type ZoomPlanResult = { events: RenderZoomEvent[]; rejections: RenderZoomRejection[] };

/** Stable id for a planned moment, so a QA repair can name one exactly. */
export const zoomEventId = (startSec: number, triggerText: string) =>
  `z${startSec.toFixed(3)}-${triggerText.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 24).toLowerCase()}`;

/** The nearest named intensity for a free scale, for reporting only. */
const intensityFor = (scale: number): Exclude<ZoomPolicy, 'OFF'> =>
  (Object.entries(EDIT_MODE_ZOOM_SCALES) as Array<[Exclude<ZoomPolicy, 'OFF'>, number]>)
    .reduce((best, entry) => Math.abs(entry[1] - scale) < Math.abs(best[1] - scale)
      ? entry : best)[0];

type ZoomCandidate = {
  id: string; startSec: number; holdSec: number; requested: number;
  intensity: Exclude<ZoomPolicy, 'OFF'>; triggerText: string; reason: string;
  /** Planned moments respect the classifier's "no zoom on this kind of shot";
   *  a zoom the user placed by hand overrides that editorial default. */
  editorialGate: boolean;
  focusX?: number | null; focusY?: number | null; focusTrackId?: string | null;
};

export function planEditModeZoom(input: ZoomPlanInput): ZoomPlanResult {
  const events: RenderZoomEvent[] = [];
  const rejections: RenderZoomRejection[] = [];
  const manual = input.manual ?? [];
  if ((input.policy === 'OFF' || !input.moments.length) && !manual.length) {
    return { events, rejections };
  }
  const suppressed = new Set(input.suppressed ?? []);
  const ceilings = input.scaleCeilings ?? {};
  const claimed = new Set(manual.map((zoom) => zoom.claimsMoment).filter(Boolean));

  // Phase 4 recorded the moments in SOURCE seconds. A moment whose words were
  // trimmed away simply has no exported instant and disappears with the cut.
  const planned = input.policy === 'OFF' ? [] : input.moments
    .filter((moment) => !claimed.has(zoomMomentKey(moment)));
  const candidates: ZoomCandidate[] = planned.flatMap((moment) => {
    const starts = input.map.toTimeline(moment.startSec);
    if (!starts.length) {
      rejections.push({ triggerText: moment.triggerText, startSec: moment.startSec,
        reason: 'TRIGGER_REMOVED_FROM_TIMELINE' });
      return [];
    }
    return starts.map((startSec) => ({
      id: zoomEventId(startSec, moment.triggerText), startSec,
      holdSec: Math.max(0.6, moment.endSec - moment.startSec),
      requested: EDIT_MODE_ZOOM_SCALES[moment.intensity], intensity: moment.intensity,
      triggerText: moment.triggerText, reason: moment.reason, editorialGate: true }));
  });
  // A hand-placed zoom's element length is the WHOLE move, so its hold is what
  // remains after the ramps.
  for (const zoom of manual) {
    if (!zoom.enabled) continue;
    candidates.push({ id: `ze-${zoom.elementId}`, startSec: zoom.startSec,
      holdSec: Math.max(EDIT_MODE_ZOOM.minHoldSec, zoom.endSec - zoom.startSec -
        EDIT_MODE_ZOOM.rampInSec - EDIT_MODE_ZOOM.rampOutSec),
      requested: zoom.scale, intensity: intensityFor(zoom.scale),
      triggerText: zoom.triggerText, reason: zoom.semanticReason || 'EDITED_ZOOM',
      editorialGate: false, focusX: zoom.focusX, focusY: zoom.focusY,
      focusTrackId: zoom.focusTrackId });
  }
  candidates.sort((left, right) => left.startSec - right.startSec);

  for (const candidate of candidates) {
    const id = candidate.id;
    const reject = (reason: string) => rejections.push({ triggerText: candidate.triggerText,
      startSec: round(candidate.startSec), reason });
    if (suppressed.has(id)) { reject('QA_REPAIR_SUPPRESSED'); continue; }
    if (events.length >= (input.maxEvents ?? EDIT_MODE_ZOOM.maxEvents)) {
      reject('ZOOM_BUDGET_REACHED'); continue;
    }
    const previous = events[events.length - 1];
    if (previous && candidate.startSec - previous.endSec <
      (input.minGapSec ?? EDIT_MODE_ZOOM.minGapSec)) {
      reject('TOO_CLOSE_TO_PREVIOUS_ZOOM'); continue;
    }

    const shotIndex = input.shots.findIndex((shot) =>
      candidate.startSec >= shot.start - 1e-6 && candidate.startSec < shot.end);
    const shot = input.shots[shotIndex];
    const segment = input.frameSegments[shotIndex];
    if (!shot || !segment) { reject('NO_SHOT_AT_TRIGGER'); continue; }
    if (segment.layout !== 'FILL') { reject('SHOT_IS_FITTED_NOT_CROPPED'); continue; }
    if (candidate.editorialGate && !shot.zoomAllowed) {
      reject(`SHOT_DOES_NOT_ALLOW_ZOOM_${shot.shotClass}`); continue;
    }
    if (shot.informationMode) { reject('INFORMATION_SHOT'); continue; }

    // The whole move - rise, hold and return - has to live inside this shot,
    // with clearance at both ends, so it never interpolates across a hard cut.
    const startSec = Math.max(shot.start + EDIT_MODE_ZOOM.shotMarginSec, candidate.startSec);
    const rampIn = EDIT_MODE_ZOOM.rampInSec;
    const rampOut = EDIT_MODE_ZOOM.rampOutSec;
    const hold = Math.max(EDIT_MODE_ZOOM.minHoldSec, candidate.holdSec);
    const endSec = startSec + rampIn + hold + rampOut;
    const limit = Math.min(shot.end - EDIT_MODE_ZOOM.shotMarginSec, input.durationSec);
    if (endSec > limit) { reject('SHOT_TOO_SHORT_FOR_A_SETTLED_ZOOM'); continue; }
    if ((input.switchTimes ?? []).some((time) =>
      time >= startSec - .5 && time <= endSec + .5)) {
      reject('SPEAKER_SWITCH_NEEDS_CLEAR_FRAME'); continue;
    }

    const focal = input.focalAt(startSec + rampIn + hold / 2);
    const focusX = clamp(candidate.focusX ?? focal.x, 0.25, 0.75);
    const focusY = clamp(candidate.focusY ?? focal.y, 0.25, 0.75);
    const ceiling = ceilings[id] ?? candidate.requested;
    let scale = Math.min(candidate.requested, ceiling);
    let failure = '';
    while (scale >= EDIT_MODE_ZOOM.minScale) {
      failure = safetyFailure({ ...input, startSec, peakStartSec: startSec + rampIn,
        peakEndSec: startSec + rampIn + hold, endSec, peakScale: scale, focusX, focusY });
      if (!failure) break;
      scale = Number((scale - EDIT_MODE_ZOOM.scaleStep).toFixed(4));
    }
    if (scale < EDIT_MODE_ZOOM.minScale) { reject(failure || 'UNSAFE_AT_EVERY_SCALE'); continue; }
    const requested = candidate.requested;
    const frame = (t: number) => Math.round(t * input.fps);
    const focusFrame = nearestFrame(input.frames, startSec + rampIn + hold / 2);
    const baselineAtFocus = input.cropAt(startSec + rampIn + hold / 2);
    const focusTrack = focusFrame?.faces.filter((face) => face.trackId)
      .sort((left, right) => {
        const position = (face: typeof left) => ({
          x: (face.x + face.w / 2 - baselineAtFocus.x) / baselineAtFocus.w,
          y: (face.y + face.h / 2 - baselineAtFocus.y) / baselineAtFocus.h });
        const a = position(left); const b = position(right);
        return Math.hypot(a.x - focusX, a.y - focusY) -
          Math.hypot(b.x - focusX, b.y - focusY);
      })[0];
    events.push({
      id, startSec: round(startSec), peakStartSec: round(startSec + rampIn),
      peakEndSec: round(startSec + rampIn + hold), endSec: round(endSec),
      peakScale: scale, focusX: round(focusX), focusY: round(focusY),
      intensity: candidate.intensity, triggerText: candidate.triggerText, reason: candidate.reason,
      focusTrackId: candidate.focusTrackId ?? focusTrack?.trackId ?? null,
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
