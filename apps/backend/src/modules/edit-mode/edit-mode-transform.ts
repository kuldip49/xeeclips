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
  startTime: number; duration: number; trimStart?: number; trimEnd?: number | null }>(
  elements: T[], before: LayoutSegment[], after: LayoutSegment[], minDurationSec: number): T[] {
  const total = layoutEnd(after);
  if (!(total > 0)) return elements;
  return elements.map((element) => {
    if (element.type === 'VIDEO' && element.track === 0) return element;
    const start = projectInstant(element.startTime, before, after);
    const end = projectInstant(element.startTime + element.duration, before, after);
    const clampedStart = Math.max(0, Math.min(start, Math.max(0, total - minDurationSec)));
    const length = Math.max(minDurationSec, Math.min(end - clampedStart, total - clampedStart));
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
