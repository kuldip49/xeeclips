import type { ReframeAspect, ReframeBox, ReframeCropGrid } from '@ai-content-platform/shared';

/**
 * Manual crop geometry. Everything here is deterministic: the crop is exactly what the user drags or
 * types, kept inside the frame and above the smallest encodable size. Nothing is detected or suggested.
 * Boxes are normalized to the uploaded frame (x, y, w, h in 0..1), so they do not depend on the screen.
 */
export const CROP_SHAPES: Array<{ id: ReframeAspect; label: string }> = [
  { id: 'SOURCE', label: 'Original' }, { id: 'CUSTOM', label: 'Free' },
  { id: '9:16', label: '9:16' }, { id: '16:9', label: '16:9' }, { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5' }, { id: '5:4', label: '5:4' }, { id: '3:4', label: '3:4' }, { id: '4:3', label: '4:3' },
  { id: '2:3', label: '2:3' }, { id: '3:2', label: '3:2' }, { id: '21:9', label: '21:9' }
];
export const CROP_GRIDS: Array<{ id: ReframeCropGrid; label: string }> = [
  { id: 'THIRDS', label: 'Rule of thirds' }, { id: 'GRID3', label: '3 × 3' }, { id: 'GRID4', label: '4 × 4' },
  { id: 'CROSSHAIR', label: 'Center' }, { id: 'GOLDEN', label: 'Golden ratio' }, { id: 'NONE', label: 'No grid' }
];
export const FULL: ReframeBox = { x: 0, y: 0, w: 1, h: 1 };
/** Smallest crop side in source pixels (the server enforces the same). */
export const MIN_CROP_PIXELS = 16;
/** Below this short side the crop is allowed but will look soft once scaled to 720p/1080p. */
export const LOW_RESOLUTION_PIXELS = 360;
const STYLEONE_WINDOW = 1080 / 700;
const clamp = (value: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));

/** "W:H" from what the user typed ("4:5", "4/5", "4x5", "2.35:1"), or null when it is not a usable ratio. */
export function parseRatio(text: string): ReframeAspect | null {
  const m = /^\s*(\d{1,4}(?:\.\d{1,3})?)\s*[:/x×]\s*(\d{1,4}(?:\.\d{1,3})?)\s*$/iu.exec(text);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (!(a > 0) || !(b > 0) || a / b < 1 / 20 || a / b > 20) return null;
  return `${Number(m[1])}:${Number(m[2])}` as ReframeAspect;
}
/** Pixel width/height a shape locks to, or null for Free Crop. */
export function ratioOf(aspect: ReframeAspect, width: number, height: number): number | null {
  if (aspect === 'CUSTOM') return null;
  if (aspect === 'SOURCE') return width / height;
  if (aspect === 'STYLEONE') return STYLEONE_WINDOW;
  const [a, b] = aspect.split(':').map(Number);
  return a > 0 && b > 0 ? a / b : null;
}
export const isPreset = (aspect: ReframeAspect) => CROP_SHAPES.some((shape) => shape.id === aspect);
export const isFull = (box: ReframeBox) => box.x < 1e-4 && box.y < 1e-4 && box.w > 0.9999 && box.h > 0.9999;
export const sameBox = (a: ReframeBox, b: ReframeBox) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6;
const mins = (width: number, height: number) => ({ w: Math.min(1, MIN_CROP_PIXELS / width), h: Math.min(1, MIN_CROP_PIXELS / height) });

/** A technical problem that would stop the crop from becoming a video, or null. Content never matters. */
export function cropIssue(box: ReframeBox, width: number, height: number): string | null {
  if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return 'The crop needs a width and a height.';
  if (box.x < -1e-6 || box.y < -1e-6 || box.x + box.w > 1 + 1e-5 || box.y + box.h > 1 + 1e-5) return 'The crop must stay inside the video.';
  if (box.w * width < MIN_CROP_PIXELS - 1e-6 || box.h * height < MIN_CROP_PIXELS - 1e-6) return `The crop must be at least ${MIN_CROP_PIXELS} × ${MIN_CROP_PIXELS} pixels.`;
  return null;
}
/** Non-blocking notes about quality. They never change the crop. */
export function cropWarnings(box: ReframeBox, width: number, height: number): string[] {
  const w = Math.round(box.w * width), h = Math.round(box.h * height);
  const warnings: string[] = [];
  if (Math.min(w, h) < LOW_RESOLUTION_PIXELS) warnings.push(`This crop is ${w} × ${h} pixels, so it will look soft when exported at 720p or 1080p.`);
  if (Math.max(w / h, h / w) > 8) warnings.push('This is a very narrow shape. Exports are scaled so the long side stays within 3840 pixels.');
  return warnings;
}

/** The same box placed so its centre is as close to (cx, cy) as the frame allows. */
function centred(w: number, h: number, cx: number, cy: number): ReframeBox {
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}
/** Scale (w, h) to fit inside the frame and above the minimum size, keeping its shape when possible. */
function fitSize(w: number, h: number, width: number, height: number) {
  const min = mins(width, height);
  const down = Math.min(1, 1 / w, 1 / h); w *= down; h *= down;
  const up = Math.max(1, min.w / w, min.h / h); w = Math.min(1, w * up); h = Math.min(1, h * up);
  return { w, h };
}

/**
 * Switching to a fixed shape: the same area as the current crop, around the same centre, in the new shape
 * (scaled down only as far as the frame requires). Free Crop keeps the crop exactly as it is.
 */
export function withRatio(box: ReframeBox, ratio: number | null, width: number, height: number): ReframeBox {
  if (!ratio) return box;
  const area = box.w * box.h;
  // ratio is in pixels: w*width / (h*height) = ratio  ->  w = h * ratio * height / width.
  const h0 = Math.sqrt(area * width / (ratio * height));
  const size = fitSize(h0 * ratio * height / width, h0, width, height);
  return centred(size.w, size.h, box.x + box.w / 2, box.y + box.h / 2);
}

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/**
 * One drag step from the crop as it was when the pointer went down (dx, dy normalized). Free Crop moves
 * each edge independently; a fixed shape keeps its ratio and anchors the opposite edge or corner.
 */
export function dragCrop(start: ReframeBox, handle: Handle, dx: number, dy: number, ratio: number | null,
  width: number, height: number): ReframeBox {
  if (handle === 'move') return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  const min = mins(width, height);
  const right = start.x + start.w, bottom = start.y + start.h;
  const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s');
  if (!ratio) {
    let { x, y, w, h } = start;
    if (west) { x = clamp(start.x + dx, 0, right - min.w); w = right - x; }
    if (east) w = clamp(start.w + dx, min.w, 1 - start.x);
    if (north) { y = clamp(start.y + dy, 0, bottom - min.h); h = bottom - y; }
    if (south) h = clamp(start.h + dy, min.h, 1 - start.y);
    return { x, y, w, h };
  }
  const k = ratio * height / width; // w = h * k (normalized units)
  // The width each axis of the gesture asks for; a corner follows whichever moved further.
  const fromX = west ? start.w - dx : east ? start.w + dx : null;
  const fromY = north ? (start.h - dy) * k : south ? (start.h + dy) * k : null;
  let w = fromX !== null && fromY !== null ? (Math.abs(fromX - start.w) >= Math.abs(fromY - start.w) ? fromX : fromY) : (fromX ?? fromY ?? start.w);
  // Room from the anchored side. A side handle centres the other axis, shifting it at the frame edge.
  const roomW = west ? right : east ? 1 - start.x : 1;
  const roomH = north ? bottom : south ? 1 - start.y : 1;
  w = Math.max(Math.min(w, roomW, roomH * k), min.w, min.h * k);
  const h = w / k;
  if (w > roomW + 1e-9 || h > roomH + 1e-9) return start;
  const cx = start.x + start.w / 2, cy = start.y + start.h / 2;
  const x = west ? right - w : east ? start.x : cx - w / 2;
  const y = north ? bottom - h : south ? start.y : cy - h / 2;
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h };
}

/** Uniform zoom around the crop centre; the shape is unchanged. factor < 1 zooms in (smaller crop). */
export function zoomCrop(start: ReframeBox, factor: number, width: number, height: number): ReframeBox {
  const min = mins(width, height);
  const f = clamp(factor, Math.max(min.w / start.w, min.h / start.h), Math.min(1 / start.w, 1 / start.h));
  return centred(start.w * f, start.h * f, start.x + start.w / 2, start.y + start.h / 2);
}
/** Zoom level: 1 = the largest crop of this shape, 2 = half that size, and so on. */
export const zoomOf = (box: ReframeBox) => Math.min(1 / box.w, 1 / box.h);
export const maxZoomOf = (box: ReframeBox, width: number, height: number) => {
  const min = mins(width, height);
  return Math.max(1, zoomOf(box) * Math.min(box.w / min.w, box.h / min.h));
};
export const setZoom = (box: ReframeBox, zoom: number, width: number, height: number) => zoomCrop(box, zoomOf(box) / zoom, width, height);

export type Edge = 'top' | 'bottom' | 'left' | 'right';
export const edgesOf = (box: ReframeBox): Record<Edge, number> => ({ top: box.y, bottom: 1 - box.y - box.h, left: box.x, right: 1 - box.x - box.w });
/** Set how much is cut from one side. Behaves exactly like dragging that edge's handle. */
export function setEdge(box: ReframeBox, edge: Edge, value: number, ratio: number | null, width: number, height: number): ReframeBox {
  const delta = value - edgesOf(box)[edge];
  if (edge === 'top') return dragCrop(box, 'n', 0, delta, ratio, width, height);
  if (edge === 'bottom') return dragCrop(box, 's', 0, -delta, ratio, width, height);
  if (edge === 'left') return dragCrop(box, 'w', delta, 0, ratio, width, height);
  return dragCrop(box, 'e', -delta, 0, ratio, width, height);
}
/** Exact size in source pixels. Free Crop keeps the top-left corner; a fixed shape keeps its centre. */
export function setSize(box: ReframeBox, size: { w?: number; h?: number }, ratio: number | null, width: number, height: number): ReframeBox {
  const min = mins(width, height);
  if (!ratio) {
    const w = clamp(size.w ?? box.w, min.w, 1), h = clamp(size.h ?? box.h, min.h, 1);
    return { x: clamp(box.x, 0, 1 - w), y: clamp(box.y, 0, 1 - h), w, h };
  }
  const k = ratio * height / width;
  const fitted = fitSize(size.w !== undefined ? size.w : (size.h ?? box.h) * k, size.w !== undefined ? size.w / k : (size.h ?? box.h), width, height);
  return centred(fitted.w, fitted.h, box.x + box.w / 2, box.y + box.h / 2);
}
/** Pan: place the crop's centre (normalized), clamped so the crop stays inside the frame. */
export const panTo = (box: ReframeBox, cx: number, cy: number): ReframeBox => centred(box.w, box.h, cx, cy);

/** Normalized source box -> the same box inside the cropped frame (null when it falls outside). */
export function intoCrop(box: ReframeBox, crop: ReframeBox): ReframeBox | null {
  const x = (box.x - crop.x) / crop.w, y = (box.y - crop.y) / crop.h, w = box.w / crop.w, h = box.h / crop.h;
  if (x + w <= 0 || y + h <= 0 || x >= 1 || y >= 1) return null;
  return { x, y, w, h };
}
