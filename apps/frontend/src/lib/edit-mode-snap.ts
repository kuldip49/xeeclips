/**
 * Preview canvas geometry: how big the canvas is, and how a dragged box snaps
 * inside it.
 *
 * Pure — no DOM, no React — so the snapping rules can be exercised by
 * scripts/test-timeline-virtualization.cjs alongside the viewport maths.
 *
 * Everything is in NORMALIZED canvas coordinates (0..1 from the top-left), the
 * same space EditElement boxes are stored in, so a snapped value is a value the
 * canonical command can carry unchanged.
 */

/** How close, in canvas fractions, a value has to be to snap. ~1% of the canvas
 *  is close enough to feel magnetic and far enough not to fight deliberate
 *  placement. */
export const SNAP_THRESHOLD = 0.012;

/** The lines an element snaps to: both edges and the centre of the canvas. */
export const SNAP_TARGETS = [0, 0.5, 1] as const;

export type SnapGuide = { axis: 'x' | 'y'; at: number };

export type SnapResult = { x: number; y: number; guides: SnapGuide[] };

const nearest = (candidates: Array<{ value: number; target: number }>) => {
  let best: { value: number; target: number; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.value - candidate.target);
    if (distance <= SNAP_THRESHOLD && (!best || distance < best.distance)) {
      best = { ...candidate, distance };
    }
  }
  return best;
};

/**
 * Snaps a box's position.
 *
 * Each axis is considered independently and three anchors are offered on each:
 * the leading edge, the centre and the trailing edge. The returned offset is the
 * shift that would put the winning anchor exactly on its target, so the box
 * keeps its size and only moves.
 */
export function snapBox(box: { x: number; y: number; width: number; height: number }): SnapResult {
  const guides: SnapGuide[] = [];
  const axis = (start: number, size: number, which: 'x' | 'y') => {
    const anchors = [start, start + size / 2, start + size];
    const candidates = anchors.flatMap((value) =>
      SNAP_TARGETS.map((target) => ({ value, target })));
    const hit = nearest(candidates);
    if (!hit) return start;
    guides.push({ axis: which, at: hit.target });
    return Number((start + (hit.target - hit.value)).toFixed(6));
  };
  return { x: axis(box.x, box.width, 'x'), y: axis(box.y, box.height, 'y'), guides };
}

/** Rotation snapping: the cardinal angles plus the 45s, within 4 degrees. */
export const ROTATION_SNAPS = [-180, -135, -90, -45, 0, 45, 90, 135, 180];
export const ROTATION_SNAP_DEGREES = 4;

export function snapRotation(degrees: number): number {
  const wrapped = Math.max(-180, Math.min(180, degrees));
  for (const target of ROTATION_SNAPS) {
    if (Math.abs(wrapped - target) <= ROTATION_SNAP_DEGREES) return target;
  }
  return Number(wrapped.toFixed(1));
}

/** Keeps a box inside the canvas without resizing it. */
export function clampBox(box: { x: number; y: number; width: number; height: number }) {
  const width = Math.max(0.02, Math.min(1, box.width));
  const height = Math.max(0.02, Math.min(1, box.height));
  return {
    x: Number(Math.max(0, Math.min(1 - width, box.x)).toFixed(6)),
    y: Number(Math.max(0, Math.min(1 - height, box.y)).toFixed(6)),
    width: Number(width.toFixed(6)), height: Number(height.toFixed(6))
  };
}

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * The box a corner drag produces.
 *
 * The opposite corner is the anchor and stays put, which is what makes dragging
 * the top-left grow the box upwards rather than sliding it. The result is
 * clamped into the canvas, so a resize can never store an out-of-bounds box the
 * backend would reject.
 */
export function resizeBox(box: { x: number; y: number; width: number; height: number },
  corner: ResizeCorner, dx: number, dy: number) {
  const left = corner === 'nw' || corner === 'sw' ? box.x + dx : box.x;
  const top = corner === 'nw' || corner === 'ne' ? box.y + dy : box.y;
  const right = corner === 'ne' || corner === 'se' ? box.x + box.width + dx : box.x + box.width;
  const bottom = corner === 'sw' || corner === 'se' ? box.y + box.height + dy : box.y + box.height;
  return clampBox({ x: Math.min(left, right - 0.02), y: Math.min(top, bottom - 0.02),
    width: Math.max(0.02, right - left), height: Math.max(0.02, bottom - top) });
}


/**
 * The largest box of `aspect` that fits inside the space the editor row gives
 * the preview, in whole pixels.
 *
 * The canvas used to be sized by CSS `aspect-ratio` alone, with `max-h-full
 * max-w-full` and no definite dimension to derive from, which collapses the box
 * to 0x0: the preview had no size at all, so neither the video nor any overlay
 * was ever drawn. Measuring the frame and writing explicit pixels fixes that,
 * and the resulting width is also the number the renderer calls `canvas.width` -
 * which is what lets the text layer size type with the renderer's own formula
 * instead of an approximation of it.
 */
export function fitCanvas(frame: { width: number; height: number }, aspect: number) {
  if (!(frame.width > 0) || !(frame.height > 0) || !(aspect > 0)) return { width: 0, height: 0 };
  const width = Math.min(frame.width, frame.height * aspect);
  return { width: Math.floor(width), height: Math.floor(width / aspect) };
}
