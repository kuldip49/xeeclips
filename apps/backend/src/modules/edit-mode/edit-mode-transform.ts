// EditMode manual transform state.
//
// Crop, rotation, flip, scale, position and speed are canonical EditElement
// properties, not render-only decoration: this module is the single place that
// says what a valid value is and what the neutral one looks like. The command
// layer, the render planner and the tests all read the bounds from here, so a
// value the editor can store is by construction a value the renderer can honour.
//
// Everything is pure. Nothing here touches Prisma, FFmpeg or the frozen pipeline.

/** Normalized source-region insets. Each is the fraction of the frame removed
 * from that edge, so an uncropped element is four zeroes. */
export type CropInsets = { left: number; right: number; top: number; bottom: number };

export type TransformState = {
  crop: CropInsets;
  /** Degrees, positive clockwise. */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
};

export const NEUTRAL_CROP: CropInsets = { left: 0, right: 0, top: 0, bottom: 0 };

// Bounds. These are deliberately generous for short-form work and deliberately
// finite: an unbounded scale or speed is an export that never finishes.
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;
export const MIN_ROTATION = -180;
export const MAX_ROTATION = 180;
/** At least this fraction of each axis must survive a crop. */
export const MIN_CROP_REMAINDER = 0.05;
/** Speed presets the editor offers; any value inside the bounds is still valid. */
export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

const finite = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round = (value: number) => Number(value.toFixed(6));

/** Reads the crop stored on an element, tolerating absent or partial state. */
export function readCrop(properties: unknown): CropInsets {
  const crop = record(record(properties).crop);
  return {
    left: Math.max(0, finite(crop.left, 0)),
    right: Math.max(0, finite(crop.right, 0)),
    top: Math.max(0, finite(crop.top, 0)),
    bottom: Math.max(0, finite(crop.bottom, 0))
  };
}

export function readTransform(properties: unknown): TransformState {
  const props = record(properties);
  return {
    crop: readCrop(properties),
    rotation: finite(props.rotation, 0),
    flipH: props.flipH === true,
    flipV: props.flipV === true
  };
}

/** The playback rate stored on a VIDEO element; 1 when absent or unusable. */
export function readSpeed(properties: unknown): number {
  const speed = finite(record(properties).speed, 1);
  return speed >= MIN_SPEED && speed <= MAX_SPEED ? speed : 1;
}

export function readScale(properties: unknown): number {
  const scale = finite(record(properties).scale, 1);
  return scale >= MIN_SCALE && scale <= MAX_SCALE ? scale : 1;
}

export const isNeutralCrop = (crop: CropInsets) =>
  crop.left === 0 && crop.right === 0 && crop.top === 0 && crop.bottom === 0;

export class TransformRangeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TransformRangeError';
  }
}

/**
 * Validates a crop.
 *
 * A crop that leaves nothing behind is not a crop, it is a black frame, so both
 * axes must keep MIN_CROP_REMAINDER. Rejecting here rather than clamping is
 * deliberate: silently widening a crop the user asked for would make the preview
 * disagree with the export, which is the exact class of bug this workstream fixes.
 */
export function validateCrop(input: {
  left?: unknown; right?: unknown; top?: unknown; bottom?: unknown;
}): CropInsets {
  const crop: CropInsets = {
    left: round(finite(input.left, 0)), right: round(finite(input.right, 0)),
    top: round(finite(input.top, 0)), bottom: round(finite(input.bottom, 0))
  };
  for (const [edge, value] of Object.entries(crop)) {
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new TransformRangeError('INVALID_CROP',
        `crop ${edge} must be between 0 and 1`);
    }
  }
  if (crop.left + crop.right > 1 - MIN_CROP_REMAINDER) {
    throw new TransformRangeError('INVALID_CROP',
      `crop left and right must leave at least ${MIN_CROP_REMAINDER * 100}% of the width`);
  }
  if (crop.top + crop.bottom > 1 - MIN_CROP_REMAINDER) {
    throw new TransformRangeError('INVALID_CROP',
      `crop top and bottom must leave at least ${MIN_CROP_REMAINDER * 100}% of the height`);
  }
  return crop;
}

export function validateRotation(value: unknown): number {
  const rotation = round(finite(value, NaN));
  if (!Number.isFinite(rotation) || rotation < MIN_ROTATION || rotation > MAX_ROTATION) {
    throw new TransformRangeError('INVALID_ROTATION',
      `rotation must be between ${MIN_ROTATION} and ${MAX_ROTATION} degrees`);
  }
  return rotation;
}

export function validateScale(value: unknown): number {
  const scale = round(finite(value, NaN));
  if (!Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new TransformRangeError('INVALID_SCALE',
      `scale must be between ${MIN_SCALE} and ${MAX_SCALE}`);
  }
  return scale;
}

export function validateSpeed(value: unknown): number {
  const speed = round(finite(value, NaN));
  if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) {
    throw new TransformRangeError('INVALID_SPEED',
      `speed must be between ${MIN_SPEED}x and ${MAX_SPEED}x`);
  }
  return speed;
}

/** A VIDEO transform offset, in canvas widths/heights from centre. */
export function validateOffset(value: unknown, axis: 'x' | 'y'): number {
  const offset = round(finite(value, NaN));
  if (!Number.isFinite(offset) || offset < -1 || offset > 1) {
    throw new TransformRangeError('INVALID_POSITION',
      `${axis} must be between -1 and 1`);
  }
  return offset;
}

/** The timeline length one VIDEO element occupies: its source range, divided by
 * how fast it is played. This is the one definition of the relationship, shared
 * by the command layer, the validator and the render planner. */
export function timelineDurationFor(trimStart: number, trimEnd: number, speed: number) {
  return round((trimEnd - trimStart) / (speed > 0 ? speed : 1));
}

export type LayoutSegment = { id: string; start: number; end: number };

/** Sequences the VIDEO track into start/end spans, in position order. */
export function videoLayout(elements: Array<{
  id: string; type: string; track: number; position: number; startTime: number; duration: number;
}>): LayoutSegment[] {
  const layout: LayoutSegment[] = [];
  let cursor = 0;
  const videos = elements
    .filter((element) => element.type === 'VIDEO' && element.track === 0)
    .sort((left, right) => left.position - right.position || left.startTime - right.startTime);
  for (const element of videos) {
    layout.push({ id: element.id, start: round(cursor), end: round(cursor + element.duration) });
    cursor += element.duration;
  }
  return layout;
}

const layoutEnd = (layout: LayoutSegment[]) => layout.length ? layout[layout.length - 1].end : 0;

/**
 * Projects one timeline instant from an old VIDEO layout onto a new one.
 *
 * Segments are matched by index, so an instant keeps the position *within the
 * clip it was placed against* when that clip's length changes. A caption pinned
 * to the second half of clip 2 is still on the second half of clip 2 after clip
 * 2 is played at double speed, rather than sliding onto whatever now occupies
 * those absolute seconds.
 */
export function projectInstant(instant: number, before: LayoutSegment[],
  after: LayoutSegment[]): number {
  if (!before.length || !after.length) return instant;
  const index = before.findIndex((segment) => instant >= segment.start - 1e-6 &&
    instant < segment.end - 1e-6);
  if (index < 0 || index >= after.length) {
    // Past the end of the old timeline: hold it at the end of the new one.
    return round(Math.min(instant, layoutEnd(after)));
  }
  const source = before[index];
  const target = after[index];
  const span = source.end - source.start;
  const fraction = span > 0 ? (instant - source.start) / span : 0;
  return round(target.start + fraction * (target.end - target.start));
}

/**
 * Re-times every non-VIDEO element after the VIDEO track's layout changed.
 *
 * Overlays, captions and music keep their meaning relative to the footage, and
 * are then held inside the new timeline. Nothing is dropped: an element that
 * would be squeezed out is kept at the minimum length instead, because silently
 * deleting an overlay the user placed is worse than a short one they can see.
 */
export function retimeOverlays<T extends { id: string; type: string; track: number;
  startTime: number; duration: number; trimStart?: number; trimEnd?: number | null; assetId?: string | null }>(
  elements: T[], before: LayoutSegment[], after: LayoutSegment[], minDurationSec: number,
  audioSourceDuration?: (assetId: string) => number | null | undefined): T[] {
  const total = layoutEnd(after);
  if (!(total > 0)) return elements;
  return elements.map((element) => {
    if (element.type === 'VIDEO' && element.track === 0) return element;
    const start = projectInstant(element.startTime, before, after);
    const end = projectInstant(element.startTime + element.duration, before, after);
    const clampedStart = Math.max(0, Math.min(start, Math.max(0, total - minDurationSec)));
    let length = Math.max(minDurationSec, Math.min(end - clampedStart, total - clampedStart));
    if (element.type === 'AUDIO' && element.assetId && audioSourceDuration) {
      const sourceDuration = audioSourceDuration(element.assetId);
      if (sourceDuration != null) length = Math.min(length, sourceDuration - (element.trimStart ?? 0));
    }
    if (Math.abs(clampedStart - element.startTime) < 1e-6 &&
      Math.abs(length - element.duration) < 1e-6) return element;
    const next: T = { ...element, startTime: round(clampedStart), duration: round(length) };
    // AUDIO carries its own source range, which the validator ties to the
    // element's length, so the trim window follows the retimed duration.
    if (element.type === 'AUDIO') {
      const trimStart = Math.max(0, element.trimStart ?? 0);
      next.trimStart = round(trimStart);
      next.trimEnd = round(trimStart + next.duration);
    }
    return next;
  });
}

/** What one VIDEO trim changed: the segment, its source range before and after, and its speed. */
export type VideoTrimChange = {
  segmentId: string;
  before: { trimStart: number; trimEnd: number };
  after: { trimStart: number; trimEnd: number };
  speed: number;
};

export type VideoTrimLimits = {
  minDurationSec: number;
  /** An enabled zoom shorter than this cannot ease in and out, so a trim that leaves less removes it. */
  minZoomSec: number;
  audioSourceDuration?: (assetId: string) => number | null | undefined;
};

/**
 * Re-times every non-VIDEO element after ONE video segment's source range changed.
 *
 * A trim does not stretch footage, it removes (or restores) the head or tail of it,
 * so everything placed on the timeline keeps its place against the CONTENT:
 *
 *  - an element inside the trimmed segment is mapped through SOURCE time, which is
 *    why a caption at source 8.0s is still at source 8.0s after 3s are cut from the
 *    head (it moves 3s earlier on the timeline), never scaled by the new length;
 *  - an element on a different segment only shifts by that segment's length change;
 *  - what falls off either end is clipped, and an element that is entirely cut away
 *    (or left too short to be meaningful) is removed. Undo restores it.
 *
 * AUDIO keeps its place against the footage like every other layer, and when the
 * trim cuts its beginning its own read window advances by exactly the removed
 * prefix, so the music is not restarted from a different place. This is the same
 * policy `adjustSourceRange` applies at the outer boundary of a generated clip.
 *
 * `retimeOverlays` (proportional) remains correct for a SPEED change, where the
 * whole segment is genuinely stretched; it is wrong for a trim.
 */
export function retimeForVideoTrim<T extends { id: string; type: string; track: number;
  startTime: number; duration: number; trimStart?: number; trimEnd?: number | null;
  assetId?: string | null; properties?: unknown }>(elements: T[], before: LayoutSegment[],
  after: LayoutSegment[], change: VideoTrimChange, limits: VideoTrimLimits): T[] {
  const total = layoutEnd(after);
  if (!(total > 0)) return elements;
  const index = before.findIndex((segment) => segment.id === change.segmentId);
  const oldLength = layoutEnd(before);
  const speed = change.speed > 0 ? change.speed : 1;
  const EPS = 1e-6;
  /** `t` on the old timeline -> new timeline; `clamped` stays inside the trimmed segment. */
  const project = (t: number, side: 'start' | 'end') => {
    const found = before.findIndex((segment) => side === 'start'
      ? t >= segment.start - EPS && t < segment.end - EPS
      : t > segment.start + EPS && t <= segment.end + EPS);
    if (found < 0 || found >= after.length) {
      const value = t + (total - oldLength);
      return { value, clamped: Math.min(total, Math.max(0, value)) };
    }
    const segment = before[found], target = after[found];
    if (found !== index) {
      const value = target.start + (t - segment.start);
      return { value, clamped: value };
    }
    const source = change.before.trimStart + (t - segment.start) * speed;
    const value = target.start + (source - change.after.trimStart) / speed;
    return { value, clamped: Math.min(target.end, Math.max(target.start, value)) };
  };
  return elements.flatMap((element) => {
    if (element.type === 'VIDEO' && element.track === 0) return [element];
    const from = project(element.startTime, 'start');
    const to = project(element.startTime + element.duration, 'end');
    const startTime = Math.max(0, Math.min(from.clamped, total));
    let length = Math.min(to.clamped, total) - startTime;
    const zoom = element.type === 'EFFECT' && record(element.properties).enabled !== false;
    const floor = zoom ? limits.minZoomSec : limits.minDurationSec;
    const unchanged = Math.abs(length - element.duration) < EPS;
    if (length < EPS || (!unchanged && length < Math.min(floor, element.duration) - EPS)) return [];
    const prefix = Math.max(0, from.clamped - from.value);
    let trimStart = Math.max(0, element.trimStart ?? 0);
    if (element.type === 'AUDIO') {
      trimStart += prefix;
      const sourceDuration = element.assetId && limits.audioSourceDuration
        ? limits.audioSourceDuration(element.assetId) : null;
      if (sourceDuration != null) length = Math.min(length, sourceDuration - trimStart);
      if (length < EPS) return [];
    }
    if (Math.abs(startTime - element.startTime) < EPS && Math.abs(length - element.duration) < EPS &&
      (element.type !== 'AUDIO' || prefix < EPS)) return [element];
    const next: T = { ...element, startTime: round(startTime), duration: round(length) };
    if (element.type === 'AUDIO') {
      next.trimStart = round(trimStart);
      next.trimEnd = round(trimStart + next.duration);
    }
    return [next];
  });
}
