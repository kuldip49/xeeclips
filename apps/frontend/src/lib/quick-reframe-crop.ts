import type { ReframeAnalysis, ReframeAspect, ReframeBox, ReframePlan } from '@ai-content-platform/shared';

/** Crop shapes offered in the Crop step. STYLEONE matches StyleOne's fixed 1080x700 media window. */
export const CROP_SHAPES: Array<{ id: ReframeAspect; label: string; ratio: number | null }> = [
  { id: 'SOURCE', label: 'Original', ratio: null },
  { id: 'CUSTOM', label: 'Free', ratio: null },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: 'STYLEONE', label: 'StyleOne window', ratio: 1080 / 700 }
];
export const shapeRatio = (aspect: ReframeAspect) => CROP_SHAPES.find((shape) => shape.id === aspect)?.ratio ?? null;
export const FULL: ReframeBox = { x: 0, y: 0, w: 1, h: 1 };
/** The server keeps at least 20% of the frame; handles stop a little before that. */
const MIN = 0.3;
const clamp = (value: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
const overlap = (a: ReframeBox, b: ReframeBox) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const contains = (a: ReframeBox, b: ReframeBox, pad = 0) => b.x - pad >= a.x - 0.001 && b.y - pad >= a.y - 0.001 &&
  b.x + b.w + pad <= a.x + a.w + 0.001 && b.y + b.h + pad <= a.y + a.h + 0.001;

export type Insets = { top: number; bottom: number; left: number; right: number };
export const insetsOf = (box: ReframeBox): Insets => ({ top: box.y, bottom: 1 - box.y - box.h, left: box.x, right: 1 - box.x - box.w });
export const boxOf = (i: Insets): ReframeBox => ({ x: i.left, y: i.top, w: 1 - i.left - i.right, h: 1 - i.top - i.bottom });
export const isFull = (box: ReframeBox) => box.x < 1e-4 && box.y < 1e-4 && box.w > 0.9999 && box.h > 0.9999;

/** The largest box of `ratio` (pixel aspect) centred on `box`, inside the frame. */
export function fitRatio(box: ReframeBox, ratio: number, width: number, height: number): ReframeBox {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let w = box.w, h = w * width / (ratio * height);
  if (h > box.h) { h = box.h; w = h * ratio * height / width; }
  if (h > 1) { h = 1; w = ratio * height / width; }
  if (w > 1) { w = 1; h = width / (ratio * height); }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** One drag step from the crop as it was when the pointer went down. */
export function dragCrop(start: ReframeBox, handle: Handle, dx: number, dy: number, ratio: number | null,
  width: number, height: number): ReframeBox {
  if (handle === 'move') return { ...start, x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) };
  let { x, y, w, h } = start;
  const right = start.x + start.w, bottom = start.y + start.h;
  if (handle.includes('w')) { x = clamp(start.x + dx, 0, right - MIN); w = right - x; }
  if (handle.includes('e')) w = clamp(start.w + dx, MIN, 1 - start.x);
  if (handle.includes('n')) { y = clamp(start.y + dy, 0, bottom - MIN); h = bottom - y; }
  if (handle.includes('s')) h = clamp(start.h + dy, MIN, 1 - start.y);
  if (ratio) {
    // A locked shape follows the dominant axis of the gesture and anchors the opposite edge.
    const horizontal = handle === 'e' || handle === 'w' || (handle.length === 2 && Math.abs(dx) >= Math.abs(dy));
    if (horizontal) h = w * width / (ratio * height); else w = h * ratio * height / width;
    if (h > 1 || w > 1) return start;
    if (handle.includes('n')) y = bottom - h; else if (!handle.includes('s')) y = start.y + (start.h - h) / 2;
    if (handle.includes('w')) x = right - w; else if (!handle.includes('e')) x = start.x + (start.w - w) / 2;
    if (x < -1e-6 || y < -1e-6 || x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return start;
  }
  return { x: clamp(x), y: clamp(y), w: clamp(w, MIN, 1 - clamp(x)), h: clamp(h, MIN, 1 - clamp(y)) };
}

/** Pinch / wheel zoom around the crop centre. factor < 1 zooms in. */
export function zoomCrop(start: ReframeBox, factor: number, ratio: number | null, width: number, height: number): ReframeBox {
  let w = clamp(start.w * factor, MIN, 1), h = clamp(start.h * factor, MIN, 1);
  if (ratio) { h = w * width / (ratio * height); if (h > 1) { h = 1; w = ratio * height / width; } }
  const cx = start.x + start.w / 2, cy = start.y + start.h / 2;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

const time = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
/** The same protections the server enforces on Done, so the problem is visible before pressing it. */
export function cropProblems(plan: ReframePlan, analysis: ReframeAnalysis | null): string[] {
  if (!analysis) return [];
  const crop = plan.crop; const problems: string[] = [];
  if (crop.w * crop.h < 0.2) problems.push('Keep at least 20% of the original frame.');
  const tracked = !!plan.tracking?.length;
  if (!tracked) {
    const face = analysis.frames.find((frame) => frame.faces.some((box) => !contains(crop, box)) ||
      frame.persons.some((box) => overlap(crop, box) / Math.max(0.001, box.w * box.h) < 0.92));
    if (face) problems.push(`This crop cuts off a detected person at ${time(face.t)}. Widen it to keep the main subject visible.`);
    const info = analysis.frames.find((frame) => frame.information.some((box) => !contains(crop, box)));
    if (info) problems.push(`This crop would hide important on-screen information at ${time(info.t)}.`);
    if (analysis.regions.some((region) => region.kind === 'ATTRIBUTION' && !contains(crop, region)))
      problems.push('Keep the detected creator attribution inside the frame.');
    if (!plan.captions.replaceExisting && analysis.regions.some((region) => region.kind === 'CAPTION' && !contains(crop, region)))
      problems.push('Keep the video\'s own captions inside the frame, or allow replacing them in Clean overlays.');
  }
  return problems;
}

/** Normalized source box -> the same box inside the cropped frame (null when it falls outside). */
export function intoCrop(box: ReframeBox, crop: ReframeBox): ReframeBox | null {
  const x = (box.x - crop.x) / crop.w, y = (box.y - crop.y) / crop.h, w = box.w / crop.w, h = box.h / crop.h;
  if (x + w <= 0 || y + h <= 0 || x >= 1 || y >= 1) return null;
  return { x, y, w, h };
}
