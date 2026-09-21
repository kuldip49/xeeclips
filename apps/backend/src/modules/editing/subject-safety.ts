import type { AnalysisFrame } from './edit-analysis';
import type { CropWindow } from './reframe.service';
import { INFORMATION_CLASSES, Shot, shotAt } from './shot-classifier';
import { createTimelineMapper } from './timeline-remap';
import { ZoomEvent, zoomScaleAt, zoomWindow } from './zoom-planner';

const overlapRatio = (box: { x: number; y: number; w: number; h: number }, window: CropWindow) => {
  const width = Math.max(0, Math.min(box.x + box.w, window.x + window.w) - Math.max(box.x, window.x));
  const height = Math.max(0, Math.min(box.y + box.h, window.y + window.h) - Math.max(box.y, window.y));
  return box.w * box.h > 0 ? width * height / (box.w * box.h) : 1;
};

export const SUBJECT_SAFETY_TARGET = .95;

// Geometry check of the rendered camera (crop + zoom) against the detections.
export function measureSubjectSafety(input: { frames: AnalysisFrame[]; shots: Shot[];
  cropAt: (t: number) => CropWindow; clipStart: number; cuts: Array<{ start: number; end: number }>;
  zoomEvents: ZoomEvent[]; fps: number; finalDuration: number }) {
  const mapper = createTimelineMapper(input.clipStart, input.cuts);
  const windowAt = (t: number) => {
    const scale = zoomScaleAt(input.zoomEvents, t, input.fps);
    const event = input.zoomEvents.find((item) => t >= item.startSec && t <= item.endSec);
    return zoomWindow(input.cropAt(t), scale, event?.focusX ?? .5, event?.focusY ?? .5);
  };
  let subjectSamples = 0, safe = 0, headroomSafe = 0, visibleSum = 0, offsetSum = 0;
  let minVisible = 1;
  let pairSamples = 0, pairPreserved = 0;
  let infoSamples = 0, infoPreserved = 0;
  let zoomSamples = 0, zoomSafe = 0;
  const perShot = new Map<number, { samples: number; safe: number }>();
  for (const frame of input.frames) {
    if (mapper.removed(frame.t, frame.t + .001)) continue;
    const t = mapper.point(frame.t);
    if (t < 0 || t > input.finalDuration) continue;
    const shot = shotAt(input.shots, t);
    if (!shot) continue;
    const fit = shot.layout === 'FIT';
    const faces = frame.faces.filter((face) => face.w * face.h >= .0015)
      .sort((a, b) => b.w * b.h - a.w * a.h);
    if (shot.shotClass === 'TWO_PERSON' || shot.shotClass === 'GROUP_SHOT' ||
      shot.shotClass === 'MULTI_SPEAKER') {
      if (faces.length >= 2) {
        pairSamples++;
        const window = windowAt(t);
        if (fit || faces.slice(0, 2).every((face) => overlapRatio(face, window) >= .9)) pairPreserved++;
      }
    }
    if (INFORMATION_CLASSES.has(shot.shotClass) || shot.informationMode) {
      infoSamples++;
      const boxes = frame.textBoxes.filter((box) => box.y + box.h / 2 < .74);
      if (fit || boxes.every((box) => overlapRatio(box, windowAt(t)) >= .95)) infoPreserved++;
    }
    if (fit || !faces.length) continue;
    const window = windowAt(t);
    const subjects = shot.shotClass === 'TWO_PERSON' ? faces.slice(0, 2) :
      [faces.find((face) => overlapRatio(face, input.cropAt(t)) > .5) ?? faces[0]];
    for (const face of subjects) {
      const visible = overlapRatio(face, window);
      const headroom = (face.y - window.y) / window.h;
      subjectSamples++;
      visibleSum += visible;
      minVisible = Math.min(minVisible, visible);
      offsetSum += Math.abs(face.x + face.w / 2 - (window.x + window.w / 2)) / window.w;
      if (headroom >= 0) headroomSafe++;
      const ok = visible >= SUBJECT_SAFETY_TARGET && headroom >= 0;
      if (ok) safe++;
      const index = input.shots.indexOf(shot);
      const entry = perShot.get(index) ?? { samples: 0, safe: 0 };
      entry.samples++; if (ok) entry.safe++;
      perShot.set(index, entry);
      if (zoomScaleAt(input.zoomEvents, t, input.fps) > 1.005) { zoomSamples++; if (ok) zoomSafe++; }
    }
  }
  const ratio = (a: number, b: number) => b ? Number((a / b).toFixed(4)) : null;
  return {
    mainSubjectRequired: subjectSamples > 0,
    mainSubjectVisibleRatio: ratio(visibleSum, subjectSamples),
    subjectSafetyRatio: ratio(safe, subjectSamples),
    headroomSafeRatio: ratio(headroomSafe, subjectSamples),
    centerOffset: ratio(offsetSum, subjectSamples),
    faceSafetyMinVisible: subjectSamples ? Number(minVisible.toFixed(4)) : null,
    subjectSamples,
    twoPersonApplicable: pairSamples > 0, twoPersonPreservedRatio: ratio(pairPreserved, pairSamples),
    informationModeApplicable: infoSamples > 0, informationPreservedRatio: ratio(infoPreserved, infoSamples),
    subjectSafeDuringZoomRatio: ratio(zoomSafe, zoomSamples),
    unsafeShotIndexes: [...perShot.entries()].filter(([, entry]) =>
      entry.safe / entry.samples < SUBJECT_SAFETY_TARGET).map(([index]) => index)
  };
}
