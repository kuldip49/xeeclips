'use strict';

/**
 * The ONE manual zoom/pan transform of a VIDEO segment.
 *
 * Stored on the segment as `scale` (1 = no zoom) and `offsetX` / `offsetY`. The offsets are
 * fractions of the framed picture's own width/height: the picture the viewer sees inside its
 * window (the whole canvas, or a card layout's video window). That window is the coordinate
 * system - never the source file's pixels - so the same numbers mean the same thing at any
 * source aspect ratio, in the React preview and in the FFmpeg export.
 *
 * The picture is scaled about the window centre and then shifted by `offset`. The shift is
 * limited so the picture always covers the window when zoomed in (no black gaps), and stays
 * inside the window when zoomed out. Both consumers use `clampPan`, so a value can never be
 * stored, previewed or exported at a position the other would refuse.
 */

const MIN_MANUAL_ZOOM = 0.1;
const MAX_MANUAL_ZOOM = 4;
const EPSILON = 1e-6;

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value) => Number(value.toFixed(6));
const even = (value) => { const rounded = Math.round(value); return rounded % 2 === 0 ? rounded : rounded + 1; };

/** Largest |offset| (in window widths/heights) that keeps the picture covering / inside the window. */
function maxPan(scale) {
  return round(Math.abs(finite(scale, 1) - 1) / 2);
}

function clampScale(scale) {
  return round(clamp(finite(scale, 1), MIN_MANUAL_ZOOM, MAX_MANUAL_ZOOM));
}

function clampPan(scale, x, y) {
  const limit = maxPan(scale);
  return { x: round(clamp(finite(x, 0), -limit, limit)), y: round(clamp(finite(y, 0), -limit, limit)) };
}

/** The effective manual zoom of a segment's stored properties. */
function readManualZoom(properties) {
  const props = properties && typeof properties === 'object' ? properties : {};
  const stored = finite(props.scale, 1);
  const scale = stored >= MIN_MANUAL_ZOOM && stored <= MAX_MANUAL_ZOOM ? stored : 1;
  const pan = clampPan(scale, props.offsetX, props.offsetY);
  return { scale, x: pan.x, y: pan.y };
}

/** True when the segment is manually zoomed or panned (so automatic zoom must stand aside). */
function isManualZoom(properties) {
  const zoom = readManualZoom(properties);
  return Math.abs(zoom.scale - 1) > EPSILON || Math.abs(zoom.x) > EPSILON || Math.abs(zoom.y) > EPSILON;
}

/**
 * The export geometry for a window of `width` x `height` pixels: the picture is scaled to
 * even pixel dimensions and then either cropped back to the window (zoom in) or padded into it
 * (zoom out). `x`/`y` are the crop origin or pad origin. Rounding is at most 1 px against the
 * exact CSS transform the preview draws from the same stored values.
 */
function manualZoomGeometry(zoom, width, height) {
  const w = Math.max(2, Math.round(width)), h = Math.max(2, Math.round(height));
  const { scale, x, y } = zoom;
  const scaledWidth = Math.max(2, even(w * scale)), scaledHeight = Math.max(2, even(h * scale));
  if (scale >= 1) {
    const slackX = scaledWidth - w, slackY = scaledHeight - h;
    return { mode: 'CROP', width: w, height: h, scaledWidth, scaledHeight,
      x: clamp(Math.round(slackX / 2 - x * w), 0, slackX),
      y: clamp(Math.round(slackY / 2 - y * h), 0, slackY) };
  }
  const slackX = w - scaledWidth, slackY = h - scaledHeight;
  return { mode: 'PAD', width: w, height: h, scaledWidth, scaledHeight,
    x: clamp(Math.round(slackX / 2 + x * w), 0, slackX),
    y: clamp(Math.round(slackY / 2 + y * h), 0, slackY) };
}

/** The FFmpeg filter chain for one manually zoomed picture; '' when it is not zoomed. */
function manualZoomFilter(zoom, width, height) {
  if (!(Math.abs(zoom.scale - 1) > EPSILON || Math.abs(zoom.x) > EPSILON || Math.abs(zoom.y) > EPSILON)) return '';
  const g = manualZoomGeometry(zoom, width, height);
  return g.mode === 'CROP'
    ? `scale=${g.scaledWidth}:${g.scaledHeight},crop=${g.width}:${g.height}:${g.x}:${g.y},setsar=1`
    : `scale=${g.scaledWidth}:${g.scaledHeight},pad=${g.width}:${g.height}:${g.x}:${g.y}:black,setsar=1`;
}

/** The CSS transform of the same zoom for a window of `width` x `height` CSS pixels, about its centre. */
function manualZoomCss(zoom, width, height) {
  const parts = [];
  if (Math.abs(zoom.x) > EPSILON || Math.abs(zoom.y) > EPSILON) {
    parts.push(`translate(${(zoom.x * width).toFixed(3)}px, ${(zoom.y * height).toFixed(3)}px)`);
  }
  if (Math.abs(zoom.scale - 1) > EPSILON) parts.push(`scale(${zoom.scale})`);
  return parts.join(' ');
}

module.exports = { MIN_MANUAL_ZOOM, MAX_MANUAL_ZOOM, maxPan, clampScale, clampPan, readManualZoom,
  isManualZoom, manualZoomGeometry, manualZoomFilter, manualZoomCss };
