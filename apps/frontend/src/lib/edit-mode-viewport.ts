import type { EditElement } from './edit-mode-types';

/**
 * The timeline viewport: the one shared calculation every track windows itself
 * against. It is pure — no DOM, no React — so the windowing rules can be
 * exercised directly by scripts/test-timeline-virtualization.cjs.
 *
 * The timeline used to lay elements out as a percentage of the container, which
 * meant the whole project was always on screen and every element was always
 * mounted. A real project carries 400+ caption elements, so that mounted 400
 * interactive blocks (each with two trim handles) into a band a few hundred
 * pixels wide. Geometry is now in pixels at a zoom level (pxPerSecond) with a
 * horizontal scroll, which both makes dense caption tracks readable and gives
 * the windowing a visible time range to work from.
 */

export const MIN_PX_PER_SEC = 2;
export const MAX_PX_PER_SEC = 400;
export const DEFAULT_PX_PER_SEC = 24;
/** Seconds mounted either side of the visible range, so scrolling reveals
 *  already-mounted blocks rather than blank space. Also the quantization grid. */
export const DEFAULT_OVERSCAN_SEC = 5;
export const ZOOM_FACTOR = 1.5;

export type TimelineViewport = {
  pxPerSecond: number;
  scrollLeft: number;
  viewportWidth: number;
  duration: number;
  overscanSec: number;
  contentWidthPx: number;
  maxScrollLeft: number;
  visibleStartSec: number;
  visibleEndSec: number;
  windowStartSec: number;
  windowEndSec: number;
};

export function clampPxPerSecond(value: number) {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PX_PER_SEC;
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, value));
}

/** The zoom that puts the whole project in the band — the "Fit" button. */
export function fitPxPerSecond(viewportWidth: number, duration: number) {
  if (viewportWidth <= 0 || duration <= 0) return DEFAULT_PX_PER_SEC;
  return clampPxPerSecond(viewportWidth / duration);
}

/** How much of the timeline the editor opens on. Wide enough to work in,
 *  narrow enough that a dense caption track opens windowed. */
export const INITIAL_VISIBLE_SEC = 30;
/** Projects up to this long (every generated short) open fitted: the whole clip is visible. */
export const FIT_ON_OPEN_MAX_SEC = 120;

/**
 * The zoom the timeline opens at: the whole project when it is short enough to
 * fit, otherwise a fixed working span. Opening on "fit" for a long project is
 * what made the first paint mount every element at once.
 */
export function initialPxPerSecond(viewportWidth: number, duration: number) {
  if (viewportWidth <= 0 || duration <= 0) return DEFAULT_PX_PER_SEC;
  return clampPxPerSecond(viewportWidth /
    (duration <= FIT_ON_OPEN_MAX_SEC ? duration : INITIAL_VISIBLE_SEC));
}

export function createViewport(input: {
  pxPerSecond: number; scrollLeft: number; viewportWidth: number; duration: number;
  overscanSec?: number;
}): TimelineViewport {
  const pxPerSecond = clampPxPerSecond(input.pxPerSecond);
  const duration = Math.max(0, Number.isFinite(input.duration) ? input.duration : 0);
  const viewportWidth = Math.max(0, Number.isFinite(input.viewportWidth) ? input.viewportWidth : 0);
  const overscanSec = Math.max(0, input.overscanSec ?? DEFAULT_OVERSCAN_SEC);
  const contentWidthPx = duration * pxPerSecond;
  const maxScrollLeft = Math.max(0, contentWidthPx - viewportWidth);
  const scrollLeft = Math.max(0, Math.min(maxScrollLeft,
    Number.isFinite(input.scrollLeft) ? input.scrollLeft : 0));
  const visibleStartSec = scrollLeft / pxPerSecond;
  const visibleEndSec = (scrollLeft + viewportWidth) / pxPerSecond;
  // The raw window is quantized onto an overscan-sized grid so that scrolling a
  // few pixels does not invalidate the mounted set: the window only changes
  // once the viewport has travelled a whole grid cell. Quantization always
  // widens, so the grid window still contains the raw overscan window.
  const grid = Math.max(0.5, overscanSec || DEFAULT_OVERSCAN_SEC);
  const windowStartSec = Math.max(0, Math.floor((visibleStartSec - overscanSec) / grid) * grid);
  const windowEndSec = Math.ceil((visibleEndSec + overscanSec) / grid) * grid;
  return { pxPerSecond, scrollLeft, viewportWidth, duration, overscanSec, contentWidthPx,
    maxScrollLeft, visibleStartSec, visibleEndSec, windowStartSec, windowEndSec };
}

/**
 * Half-open intersection, matching how the timeline treats an element's span:
 * it covers [startTime, startTime + duration). A zero-length element has no
 * interior, so it is included when the window contains its single instant.
 */
export function intersectsRange(startTime: number, duration: number,
  rangeStart: number, rangeEnd: number) {
  const start = Number.isFinite(startTime) ? startTime : 0;
  const span = Math.max(0, Number.isFinite(duration) ? duration : 0);
  if (span === 0) return start >= rangeStart && start <= rangeEnd;
  return start < rangeEnd && start + span > rangeStart;
}

/**
 * The elements a track actually mounts. Everything else stays in canonical
 * state untouched — this only decides what gets DOM. `keepIds` forces elements
 * to stay mounted regardless of the window, which is what keeps a selected
 * element (and its trim handles, and an in-flight drag) valid after it scrolls
 * off screen.
 */
export function windowElements(elements: EditElement[], viewport: TimelineViewport,
  keepIds: Array<string | null | undefined> = []) {
  const keep = new Set(keepIds.filter((id): id is string => typeof id === 'string' && !!id));
  return elements.filter((element) => keep.has(element.id) ||
    intersectsRange(element.startTime, element.duration,
      viewport.windowStartSec, viewport.windowEndSec));
}

/**
 * The scroll offset that holds the time under `anchorOffsetPx` (a pixel offset
 * from the viewport's left edge) still while the zoom changes — so zooming
 * keeps what you were looking at under the cursor instead of jumping to 0.
 */
export function scrollForZoom(viewport: TimelineViewport, nextPxPerSecond: number,
  anchorOffsetPx: number) {
  const next = clampPxPerSecond(nextPxPerSecond);
  const anchorSec = (viewport.scrollLeft + anchorOffsetPx) / viewport.pxPerSecond;
  const maxScrollLeft = Math.max(0, viewport.duration * next - viewport.viewportWidth);
  return Math.max(0, Math.min(maxScrollLeft, anchorSec * next - anchorOffsetPx));
}

/**
 * Where to scroll so `seconds` is comfortably on screen, or null when it
 * already is. Returning null is what stops playhead-following from fighting a
 * user who has scrolled somewhere deliberately.
 */
export function scrollToReveal(viewport: TimelineViewport, seconds: number, marginPx = 48) {
  if (viewport.viewportWidth <= 0) return null;
  const px = Math.max(0, seconds) * viewport.pxPerSecond;
  const margin = Math.min(marginPx, viewport.viewportWidth / 3);
  if (px >= viewport.scrollLeft + margin &&
    px <= viewport.scrollLeft + viewport.viewportWidth - margin) return null;
  return Math.max(0, Math.min(viewport.maxScrollLeft, px - viewport.viewportWidth / 2));
}

const TICK_STEPS_SEC = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];

export function tickStepSec(pxPerSecond: number, minSpacingPx = 80) {
  for (const step of TICK_STEPS_SEC) if (step * pxPerSecond >= minSpacingPx) return step;
  return TICK_STEPS_SEC[TICK_STEPS_SEC.length - 1];
}

/** Ruler ticks are windowed too — a 300s project at 1s ticks is 300 DOM nodes. */
export function rulerTicks(viewport: TimelineViewport) {
  const step = tickStepSec(viewport.pxPerSecond);
  const from = Math.max(0, Math.floor(viewport.windowStartSec / step) * step);
  const to = Math.min(viewport.duration, viewport.windowEndSec);
  const ticks: number[] = [];
  for (let at = from; at <= to + 1e-6; at += step) ticks.push(Math.round(at * 1000) / 1000);
  return ticks;
}
