import { Injectable } from '@nestjs/common';
import type { OutputAspectRatio } from '../processing/processing-type';
import { createTimelineMapper, Cut } from './timeline-remap';
import type { Rect } from './platform-layout';
import { sourceToCanvas } from './composition-coordinates';
import type { AnalysisFrame } from './edit-analysis';
import type { Shot } from './shot-classifier';

export type VisualTrack = { timestamp: number; x: number; y: number; w: number; h: number;
  confidence?: number; mouthActivity?: number; trackId?: string };
export type CropCenter = { t: number; x: number; y: number };
type CameraKey = CropCenter & { duration: number };

export const OUTPUT_DIMENSIONS: Record<OutputAspectRatio, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 }
};
export const CAMERA_TUNING = {
  subjectSafeWidth: .76, deadZoneWidth: .56, minHeadroom: .06,
  sameSpeakerMoveSec: .65, speakerSwitchHoldSec: 0,
  speakerSwitchMoveSec: .16, speakerSwitchConfirmations: 2,
  minFaceArea: .003, minPersonArea: .025, minSwitchHoldSec: 1.5, shotCutSec: .001,
  // A move longer than half the crop width would drag the frame visibly across
  // the other faces, so it is cut rather than panned.
  snapPanThreshold: .3, snapMoveSec: .08,
  // Right after a switch the camera targets the new subject directly and settles
  // fast, instead of creeping toward them with the slow same-speaker easing -
  // that creep is what reads as the frame "rolling" after a character change.
  postSwitchSettleSec: .9, postSwitchMoveSec: .18,
  // Above this, a single camera move is long enough to be read as a pan.
  smoothMoveSec: .35
} as const;
export type CropWindow = { x: number; y: number; w: number; h: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round4 = (value: number) => Number(value.toFixed(4));
const center = (track: VisualTrack) => ({ x: track.x + track.w / 2,
  y: track.y + track.h / 2 });
const area = (track: VisualTrack) => track.w * track.h;
const valid = (track: VisualTrack, minArea: number) =>
  Number.isFinite(track.timestamp) && Number.isFinite(track.x) &&
  Number.isFinite(track.y) && Number.isFinite(track.w) && Number.isFinite(track.h) &&
  track.x >= 0 && track.y >= 0 && track.w > 0 && track.h > 0 &&
  track.x + track.w <= 1.01 && track.y + track.h <= 1.01 &&
  area(track) >= minArea && (track.confidence == null || track.confidence >= .5);
const smoothStep = (progress: number) => {
  const value = clamp(progress, 0, 1);
  return value * value * (3 - 2 * value);
};
function coordinateAt(keys: CameraKey[], t: number, axis: 'x' | 'y') {
  let previous = keys[0][axis];
  for (const key of keys.slice(1)) {
    if (t < key.t) return previous;
    if (t <= key.t + key.duration)
      return previous + (key[axis] - previous) * smoothStep((t - key.t) / key.duration);
    previous = key[axis];
  }
  return previous;
}
function coordinateExpression(keys: CameraKey[], axis: 'x' | 'y') {
  let expression = keys[keys.length - 1][axis].toFixed(5);
  for (let index = keys.length - 1; index > 0; index--) {
    const key = keys[index];
    const previous = keys[index - 1][axis];
    const duration = key.duration.toFixed(3);
    const progress = `(t-${key.t.toFixed(3)})/${duration}`;
    const eased = `(3*pow(${progress}\\,2)-2*pow(${progress}\\,3))`;
    expression = `if(lt(t\\,${key.t.toFixed(3)})\\,${previous.toFixed(5)}\\,` +
      `if(lt(t\\,${(key.t + key.duration).toFixed(3)})\\,` +
      `${previous.toFixed(5)}+${(key[axis] - previous).toFixed(5)}*${eased}\\,${expression}))`;
  }
  return expression;
}

@Injectable()
export class ReframeService {
  plan(aspectRatio: OutputAspectRatio, faceTracks: VisualTrack[] = [],
    personTracks: VisualTrack[] = [], clipStart = 0, cuts: Cut[] = [],
    sourceWidth = OUTPUT_DIMENSIONS[aspectRatio].width,
    sourceHeight = OUTPUT_DIMENSIONS[aspectRatio].height,
    speakerChangeTimes: number[] = [], fps = 30, viewport?: Rect,
    editorialOverride?: boolean, options: { shots?: Shot[]; responsive?: boolean;
      structuralRepair?: boolean } = {}) {
    const shots = options.shots ?? [];
    // Repair mode: follow a new subject after one sample instead of two.
    const confirmations = options.responsive ? 1 : CAMERA_TUNING.speakerSwitchConfirmations;
    const minSwitchHold = options.responsive ? .6 : CAMERA_TUNING.minSwitchHoldSec;
    const shotIndexAt = (t: number) => {
      if (!shots.length) return 0;
      const index = shots.findIndex((shot) => t >= shot.start - 1e-6 && t < shot.end);
      return index >= 0 ? index : shots.length - 1;
    };
    const output = OUTPUT_DIMENSIONS[aspectRatio];
    const editorialCanvas = editorialOverride ?? (output.height > output.width &&
      (viewport != null || sourceWidth > sourceHeight));
    const renderHeight = viewport ? Math.round(viewport.height / 2) * 2 :
      editorialCanvas ? Math.round(output.height * .65 / 2) * 2 : output.height;
    const padTop = viewport ? Math.round(viewport.y / 2) * 2 :
      editorialCanvas ? Math.round(output.height * .25 / 2) * 2 : 0;
    const scale = Math.max(output.width / sourceWidth, renderHeight / sourceHeight);
    const cropWidth = clamp(output.width / (sourceWidth * scale), .01, 1);
    const cropHeight = clamp(renderHeight / (sourceHeight * scale), .01, 1);
    const mapper = createTimelineMapper(clipStart, cuts);
    const speakerSignals = speakerChangeTimes.filter((time) => Number.isFinite(time) &&
      !mapper.removed(time, time + .001)).map((time) => mapper.point(time)).sort((a, b) => a - b);
    const surviving = (tracks: VisualTrack[], minimum: number) => tracks
      .filter((track) => valid(track, minimum) &&
        !mapper.removed(track.timestamp, track.timestamp + .001))
      .sort((a, b) => a.timestamp - b.timestamp);
    const faces = surviving(faceTracks, CAMERA_TUNING.minFaceArea);
    const people = surviving(personTracks, CAMERA_TUNING.minPersonArea);
    const samples: Array<{ t: number; faces: VisualTrack[]; people: VisualTrack[] }> = [];
    for (const track of [...faces, ...people].sort((a, b) => a.timestamp - b.timestamp)) {
      const t = Math.max(0, mapper.point(track.timestamp));
      const last = samples[samples.length - 1];
      const sample = last && Math.abs(last.t - t) < .08 ? last :
        { t, faces: [], people: [] };
      if (sample !== last) samples.push(sample);
      (faces.includes(track) ? sample.faces : sample.people).push(track);
    }
    for (const time of speakerSignals) {
      if (samples.some((sample) => Math.abs(sample.t - time) < .08)) continue;
      const nearest = [...samples].sort((a, b) =>
        Math.abs(a.t - time) - Math.abs(b.t - time) || b.t - a.t)[0];
      if (nearest && Math.abs(nearest.t - time) <= 2)
        samples.push({ t: time, faces: nearest.faces, people: nearest.people });
    }
    samples.sort((a, b) => a.t - b.t);
    const rawCropCenters: CropCenter[] = [];
    const keys: CameraKey[] = [{ t: 0, x: .5, y: .5, duration: 0 }];
    const acceptedSubjects: CropCenter[] = [];
    let active: VisualTrack | null = null;
    let pending: { x: number; count: number; trackId?: string } | null = null;
    let speakerSwitchCount = 0;
    const speakerSegments: Array<{ startSec: number; endSec: number;
      targetFace: { x: number; y: number; w: number; h: number };
      confidence: number; trackId: string | null }> = [];
    let handledSpeakerSignal = -Infinity;
    let reframeAdjustmentCount = 0;
    let cameraReframeCount = 0;
    let cropMovementDistance = 0;
    let shotChangeReframeCount = 0;
    let lastSwitchAt = -Infinity;
    let currentShot = -1;
    // Every camera move that follows a shot cut or a speaker change, for QA.
    const cameraMoves: Array<{ t: number; durationSec: number; distance: number;
      snapped: boolean }> = [];
    for (const sample of samples) {
      let candidates = sample.faces.length ? sample.faces : sample.people;
      if (!candidates.length) continue;
      const shotIndex = shotIndexAt(sample.t);
      const shot = shots[shotIndex];
      // FIT shots show the whole frame; the crop underneath is not visible.
      if (shot?.layout === 'FIT') continue;
      const shotChanged = shots.length > 0 && shotIndex !== currentShot && currentShot >= 0;
      if (shotIndex !== currentShot) {
        currentShot = shotIndex;
        if (shotChanged) { active = null; pending = null; }
      }
      const pairShot = shot?.shotClass === 'TWO_PERSON';
      if (pairShot && candidates.length >= 2) {
        const pair = [...candidates].sort((a, b) => area(b) - area(a)).slice(0, 2);
        const left = Math.min(...pair.map((face) => face.x));
        const right = Math.max(...pair.map((face) => face.x + face.w));
        const top = Math.min(...pair.map((face) => face.y));
        const bottom = Math.max(...pair.map((face) => face.y + face.h));
        candidates = [{ timestamp: pair[0].timestamp, x: left, y: top,
          w: right - left, h: bottom - top, trackId: 'pair' }];
      } else if (!shots.length && sample.faces.length >= 2 &&
        !sample.faces.some((face) => (face.mouthActivity ?? 0) > .15)) {
        const pair = [...sample.faces].sort((a, b) => area(b) - area(a)).slice(0, 2);
        const left = Math.min(...pair.map((face) => face.x));
        const right = Math.max(...pair.map((face) => face.x + face.w));
        if (right - left <= cropWidth * CAMERA_TUNING.subjectSafeWidth) {
          const top = Math.min(...pair.map((face) => face.y));
          const bottom = Math.max(...pair.map((face) => face.y + face.h));
          candidates = [{ timestamp: pair[0].timestamp, x: left, y: top,
            w: right - left, h: bottom - top }];
        }
      }
      const currentActive = active;
      const speakerSignal = currentActive ?
        [...speakerSignals].reverse().find((time) => time > handledSpeakerSignal &&
          time <= sample.t && sample.t - time <= 6) : undefined;
      const sameTrack = currentActive?.trackId ?
        candidates.find((item) => item.trackId === currentActive.trackId) : undefined;
      const maxArea = Math.max(...candidates.map(area), 1e-6);
      const candidateScore = (item: VisualTrack) => {
        const continuity = currentActive && ((item.trackId && item.trackId === currentActive.trackId) ||
          Math.abs(center(item).x - center(currentActive).x) < .08) ? 1 : 0;
        return (item.mouthActivity ?? 0) * .48 + continuity * (speakerSignal == null ? .28 : .04) +
          (item.confidence ?? .5) * .14 + area(item) / maxArea * .1;
      };
      const ranked = [...candidates].sort((a, b) => candidateScore(b) - candidateScore(a));
      const alternative = speakerSignal != null && currentActive ? ranked.find((item) =>
        item.trackId && item.trackId !== currentActive.trackId) : undefined;
      const candidate: VisualTrack = alternative ?? ranked[0] ?? sameTrack!;
      const subject = center(candidate);
      rawCropCenters.push({ t: sample.t, x: subject.x, y: subject.y });
      if (!active && !shotChanged && area(candidate) < .015) {
        if (pending && (candidate.trackId ? pending.trackId === candidate.trackId :
          Math.abs(pending.x - subject.x) < Math.max(.1, cropWidth * .35)))
          pending.count++;
        else pending = { x: subject.x, count: 1, trackId: candidate.trackId };
        if (pending.count < confirmations) continue;
      }
      const distinct = active && (candidate.trackId && active.trackId
        ? candidate.trackId !== active.trackId :
        Math.abs(subject.x - center(active).x) > Math.max(.26, cropWidth * .7));
      if (distinct) {
        if (pending && (candidate.trackId ? pending.trackId === candidate.trackId :
          Math.abs(pending.x - subject.x) < Math.max(.1, cropWidth * .35)))
          pending.count++;
        else pending = { x: subject.x, count: 1, trackId: candidate.trackId };
        if (pending.count < confirmations && speakerSignal == null) continue;
        if (shots.length && speakerSignal == null &&
          sample.t - lastSwitchAt < minSwitchHold) continue;
        lastSwitchAt = sample.t;
        speakerSwitchCount++;
        if (speakerSignal != null) handledSpeakerSignal = speakerSignal;
      } else if (active) pending = null;
      if (speakerSignal != null && !distinct) {
        speakerSwitchCount++;
        lastSwitchAt = sample.t;
        handledSpeakerSignal = speakerSignal;
      }
      active = candidate;
      acceptedSubjects.push({ t: sample.t, ...subject });
      if (!speakerSegments.length || distinct || speakerSignal != null || shotChanged) {
        if (speakerSegments.length) speakerSegments[speakerSegments.length - 1].endSec = sample.t;
        speakerSegments.push({ startSec: sample.t, endSec: sample.t,
          targetFace: { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h },
          trackId: candidate.trackId ?? null,
          confidence: candidate.mouthActivity != null ?
            Math.min(1, .55 + candidate.mouthActivity * .4) :
            candidates.length === 1 ? .75 : .4 });
      } else speakerSegments[speakerSegments.length - 1].endSec = sample.t;
      const last = keys[keys.length - 1];
      const currentX = coordinateAt(keys, sample.t, 'x');
      const currentY = coordinateAt(keys, sample.t, 'y');
      let nextX = currentX;
      let nextY = currentY;
      const safeHalf = cropWidth * CAMERA_TUNING.subjectSafeWidth / 2;
      const excess = Math.abs(subject.x - currentX) + candidate.w / 2 - safeHalf;
      if (keys.length === 1 && rawCropCenters.length === 1 && area(candidate) >= .015)
        nextX = subject.x;
      else if (distinct || speakerSignal != null || shotChanged) nextX = subject.x;
      else if (excess > 0 && Math.abs(subject.x - currentX) >
        cropWidth * CAMERA_TUNING.deadZoneWidth / 2)
        nextX = currentX + Math.sign(subject.x - currentX) *
          (excess + cropWidth * .04);
      nextX = clamp(nextX, cropWidth / 2, 1 - cropWidth / 2);
      if (cropHeight < .99) {
        const eyeY = candidate.y + candidate.h * (sample.faces.length ? .35 : .28);
        const top = currentY - cropHeight / 2;
        if (keys.length === 1 || shotChanged || candidate.y < top + cropHeight *
          CAMERA_TUNING.minHeadroom || candidate.y + candidate.h > top + cropHeight * .93)
          nextY = clamp(eyeY + cropHeight * .16, cropHeight / 2, 1 - cropHeight / 2);
      }
      if (keys.length === 1 && sample.t <= .75 && area(candidate) >= .015) {
        keys[0].x = nextX;
        keys[0].y = nextY;
        pending = null;
        continue;
      }
      if (Math.abs(nextX - currentX) < .003 && Math.abs(nextY - currentY) < .003)
        continue;
      if (shotChanged) {
        // A source cut hides the reframe: jump exactly at the cut, no pan.
        // Do not inherit an interpolation that began in the previous shot: end
        // it at the boundary and initialise the new composition independently.
        if (last.t < shot.start && last.t + last.duration > shot.start)
          last.duration = Math.max(CAMERA_TUNING.shotCutSec, shot.start - last.t);
        keys.push({ t: shot.start, x: nextX, y: nextY, duration: CAMERA_TUNING.shotCutSec });
        cropMovementDistance += Math.hypot(nextX - currentX, nextY - currentY);
        shotChangeReframeCount++;
        lastSwitchAt = sample.t;
        // Telemetry and validation use the source discontinuity itself, not the
        // first (possibly sparse) detection in the new shot. This is an actual
        // one-frame reset at the boundary, never an interpolation inherited
        // from the incompatible previous shot.
        cameraMoves.push({ t: round4(shot.start), durationSec: CAMERA_TUNING.shotCutSec,
          distance: round4(Math.hypot(nextX - currentX, nextY - currentY)), snapped: true });
        pending = null;
        continue;
      }
      const switching = Boolean(distinct || speakerSignal != null);
      // Still settling onto a subject the camera has only just switched to.
      const settling = !switching && sample.t - lastSwitchAt <= CAMERA_TUNING.postSwitchSettleSec;
      if (settling) nextX = clamp(subject.x, cropWidth / 2, 1 - cropWidth / 2);
      const distance = Math.hypot(nextX - currentX, nextY - currentY);
      const longMove = distance > cropWidth * CAMERA_TUNING.snapPanThreshold;
      const duration = switching ?
        (longMove ? CAMERA_TUNING.snapMoveSec : CAMERA_TUNING.speakerSwitchMoveSec) :
        settling ? CAMERA_TUNING.postSwitchMoveSec : CAMERA_TUNING.sameSpeakerMoveSec;
      const hold = switching || settling ? CAMERA_TUNING.speakerSwitchHoldSec : .08;
      if (switching || settling) cameraMoves.push({ t: round4(sample.t),
        durationSec: duration, distance: round4(distance), snapped: switching && longMove });
      // Rendering is offline, so the responsive camera may arrive by the sample time.
      const startAt = options.responsive ? sample.t - duration : sample.t + hold;
      keys.push({ t: Math.max(last.t + last.duration, startAt), x: nextX, y: nextY, duration });
      cropMovementDistance += Math.hypot(nextX - currentX, nextY - currentY);
      reframeAdjustmentCount++;
      if (!switching && !settling) cameraReframeCount++;
      pending = null;
    }
    // Put the camera down before the final frame. Late detections may still
    // create a key near a shot end; those keys snap to their destination by the
    // last 400 ms instead of leaving a zoom/reframe visibly unfinished.
    const finalEnd = shots.length ? shots[shots.length - 1].end : null;
    if (finalEnd != null) {
      const stableAt = Math.max(0, finalEnd - .4);
      // Drop late targets rather than stacking several instantaneous keys at
      // the same timestamp (which can leave coordinateAt walking through stale
      // states during the freeze). A move already in progress is truncated so
      // it reaches its own safe destination by stableAt, then the crop remains
      // constant through the last displayable frame.
      for (let index = keys.length - 1; index >= 1; index--)
        if (keys[index].t >= stableAt) keys.splice(index, 1);
      const last = keys[keys.length - 1];
      if (last && last.t + last.duration > stableAt)
        last.duration = Math.max(CAMERA_TUNING.shotCutSec, stableAt - last.t);
    }
    const centerX = coordinateExpression(keys, 'x');
    const centerY = coordinateExpression(keys, 'y');
    const faceSafetyViolations = speakerSegments.filter((segment) => {
      const cropX = coordinateAt(keys, segment.startSec, 'x');
      const face = segment.targetFace;
      return face.x < cropX - cropWidth / 2 - .01 ||
        face.x + face.w > cropX + cropWidth / 2 + .01;
    }).length;
    const x = `max(0\\,min(iw-${output.width}\\,iw*(${centerX})-${output.width}/2))`;
    const y = `max(0\\,min(ih-${renderHeight}\\,ih*(${centerY})-${renderHeight}/2))`;
    const filter = `fps=${fps},scale=${output.width}:${renderHeight}:` +
      `force_original_aspect_ratio=increase,crop=${output.width}:${renderHeight}:` +
      `x='${x}':y='${y}',setsar=1`;
    const focalAt = (t: number) => {
      const nearest = [...acceptedSubjects].sort((a, b) => Math.abs(a.t - t) -
        Math.abs(b.t - t))[0];
      if (!nearest) return { x: .5, y: .5 };
      return { x: clamp(.5 + (nearest.x - coordinateAt(keys, t, 'x')) / cropWidth, .2, .8),
        y: clamp(.5 + (nearest.y - coordinateAt(keys, t, 'y')) / cropHeight, .2, .8) };
    };
    const canvasViewport = viewport ?? { x: 0, y: 0, width: output.width, height: output.height };
    const trackToCanvas = (track: VisualTrack): VisualTrack => {
      const t = Math.max(0, mapper.point(track.timestamp));
      const cropCenter = { x: coordinateAt(keys, t, 'x'), y: coordinateAt(keys, t, 'y') };
      const transformed = sourceToCanvas({ x: track.x, y: track.y,
        width: track.w, height: track.h }, {
        x: cropCenter.x - cropWidth / 2, y: cropCenter.y - cropHeight / 2,
        width: cropWidth, height: cropHeight
      }, canvasViewport);
      const left = clamp(transformed.x, canvasViewport.x,
        canvasViewport.x + canvasViewport.width);
      const top = clamp(transformed.y, canvasViewport.y,
        canvasViewport.y + canvasViewport.height);
      const right = clamp(transformed.x + transformed.width, canvasViewport.x,
        canvasViewport.x + canvasViewport.width);
      const bottom = clamp(transformed.y + transformed.height, canvasViewport.y,
        canvasViewport.y + canvasViewport.height);
      return { ...track, x: left / output.width, y: top / output.height,
        w: Math.max(0, right - left) / output.width,
        h: Math.max(0, bottom - top) / output.height };
    };
    const cropAt = (t: number): CropWindow => ({
      x: coordinateAt(keys, t, 'x') - cropWidth / 2, y: coordinateAt(keys, t, 'y') - cropHeight / 2,
      w: cropWidth, h: cropHeight });
    // A subject change should read as a cut or a quick settle, never as a long
    // drift across the frame.
    const longestSwitchMoveSec = cameraMoves.length ?
      Math.max(...cameraMoves.map((move) => move.durationSec)) : null;
    const longPanCount = cameraMoves.filter((move) =>
      move.durationSec > CAMERA_TUNING.smoothMoveSec &&
      move.distance > cropWidth * CAMERA_TUNING.snapPanThreshold).length;
    const shotSwitchMotionSmooth = cameraMoves.length ? longPanCount === 0 &&
      cameraMoves.every((move) => move.durationSec <= CAMERA_TUNING.smoothMoveSec) : null;
    const shotCutResetsCamera = cameraMoves.filter((move) => move.snapped &&
      shots.some((shot) => Math.abs(shot.start - move.t) <= .12))
      .every((move) => move.durationSec <= CAMERA_TUNING.shotCutSec + .001);
    const cameraTargetStable = longPanCount === 0 && keys.every((key, index) => index === 0 ||
      key.duration <= CAMERA_TUNING.sameSpeakerMoveSec);
    return { filter, focalAt, rawCropCenters, cropAt, shotChangeReframeCount, keyCount: keys.length,
      cameraMoves, longestSwitchMoveSec, longPanCount, shotSwitchMotionSmooth,
      speakerSwitchSmooth: shotSwitchMotionSmooth, cameraNoLongPan: longPanCount === 0,
      cameraTargetStable, shotCutResetsCamera,
      stabilizedCropCenters: keys.map((key) => ({ t: key.t + key.duration,
        x: key.x, y: key.y })),
      cropMovementDistance: Number(cropMovementDistance.toFixed(4)),
      reframeAdjustmentCount, cameraReframeCount, speakerTrackCount: speakerSegments.length,
      speakerSegments, speakerSwitchCount, faceSafetyViolations,
      detectedPeople: Math.max(0, ...samples.map((sample) => sample.people.length ||
        sample.faces.length)),
      sourceToCanvas: trackToCanvas,
      sourceResolution: { width: sourceWidth, height: sourceHeight },
      outputResolution: output, renderResolution: { width: output.width,
        height: renderHeight }, padTop, cropWidth, cropHeight };
  }

  filter(aspectRatio: OutputAspectRatio, tracks: VisualTrack[] = [],
    clipStart = 0, cuts: Cut[] = [], sourceWidth?: number, sourceHeight?: number) {
    return this.plan(aspectRatio, tracks, [], clipStart, cuts, sourceWidth,
      sourceHeight).filter;
  }
}
