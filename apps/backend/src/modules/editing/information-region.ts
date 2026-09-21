import type { AnalysisFrame } from './edit-analysis';
import type { Rect } from './platform-layout';
import type { Shot } from './shot-classifier';

// Information shots - a webpage, an article, a chart, a slide, a report, a
// tweet, a screen recording - are shown FIT so nothing is cropped away. Fitting
// a 16:9 source into a 9:16 viewport, though, leaves a letterboxed band barely a
// third of the canvas tall: the information is technically preserved and
// practically unreadable.
//
// So instead of fitting the whole frame, find the region that actually carries
// the information and fit THAT. The region is the bounding box of the detected
// text and graphic structure, padded so nothing sits against an edge, expanded
// to the viewport's aspect ratio where there is room, and clamped to the frame.
// Nothing inside it is ever cut off; what is dropped is empty margin.

export type InformationRegion = {
  // Normalised source coordinates (0-1).
  x: number; y: number; w: number; h: number;
  // How much larger the information renders than it would with a whole-frame
  // fit. 1 means the region is the whole frame and cropping buys nothing.
  readabilityGain: number;
  // Share of sampled information frames whose boxes fit inside the region.
  coverage: number;
  sampleCount: number;
  boxCount: number;
};
export type ShotInformationRegion = { shot: Shot; region: InformationRegion };

export const INFORMATION_FIT = {
  // Padding around the detected content, as a share of the region's own size.
  padRatio: .06,
  // Minimum padding in normalised frame units, so a tight region still breathes.
  minPad: .015,
  // Below this the crop is not worth the risk of clipping something undetected.
  minGain: 1.15,
  // A region smaller than this is more likely a detection artefact than content.
  minArea: .04,
  // Outlier boxes (a corner watermark, a stray caption) must not drag the region
  // out to the full frame: a box is dropped when it lies outside the dense core
  // and carries less than this share of the total detected area.
  outlierAreaShare: .06,
  minSamples: 2
} as const;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * The region of the source frame that carries the supplied information shots.
 *
 * Returns null when no usable region was found, when the region is effectively
 * the whole frame, or when cropping to it would not make the content
 * meaningfully larger - in those cases the plain whole-frame fit is correct.
 */
export function detectInformationRegion(frames: AnalysisFrame[], shots: Shot[],
  viewport: { width: number; height: number },
  source: { width: number; height: number }): InformationRegion | null {
  const ranges = shots.filter((shot) => shot.layout === 'FIT' && shot.informationMode);
  if (!ranges.length) return null;
  const inRange = (t: number) => ranges.some((shot) =>
    t >= shot.sourceStart - .01 && t < shot.sourceEnd + .01);
  const samples = frames.filter((frame) => inRange(frame.t) &&
    (frame.textBoxes.length || frame.graphicBoxes?.length));
  if (samples.length < INFORMATION_FIT.minSamples) return null;

  type Box = { x: number; y: number; w: number; h: number };
  const boxes: Box[] = samples.flatMap((frame) =>
    [...frame.textBoxes, ...(frame.graphicBoxes ?? [])])
    .filter((box) => box.w > 0 && box.h > 0 && box.w * box.h >= .0006);
  if (!boxes.length) return null;

  // The dense core: the area-weighted centre of the detected boxes. Boxes far
  // from it that carry almost no area are treated as decoration, not content.
  const totalArea = boxes.reduce((sum, box) => sum + box.w * box.h, 0);
  const centre = boxes.reduce((acc, box) => {
    const weight = box.w * box.h / totalArea;
    return { x: acc.x + (box.x + box.w / 2) * weight, y: acc.y + (box.y + box.h / 2) * weight };
  }, { x: 0, y: 0 });
  const core = boxes.filter((box) => {
    const share = box.w * box.h / totalArea;
    if (share >= INFORMATION_FIT.outlierAreaShare) return true;
    const distance = Math.hypot(box.x + box.w / 2 - centre.x, box.y + box.h / 2 - centre.y);
    return distance <= .42;
  });
  const kept = core.length ? core : boxes;
  let left = Math.min(...kept.map((box) => box.x));
  let top = Math.min(...kept.map((box) => box.y));
  let right = Math.max(...kept.map((box) => box.x + box.w));
  let bottom = Math.max(...kept.map((box) => box.y + box.h));

  // Pad so no glyph sits against a crop edge.
  const padX = Math.max(INFORMATION_FIT.minPad, (right - left) * INFORMATION_FIT.padRatio);
  const padY = Math.max(INFORMATION_FIT.minPad, (bottom - top) * INFORMATION_FIT.padRatio);
  left = clamp01(left - padX); top = clamp01(top - padY);
  right = clamp01(right + padX); bottom = clamp01(bottom + padY);
  let w = right - left;
  let h = bottom - top;
  if (w <= 0 || h <= 0 || w * h < INFORMATION_FIT.minArea) return null;

  // Grow the region toward the viewport's aspect ratio wherever there is room:
  // the scale is set by the tighter axis, so widening a short region costs
  // nothing and keeps more context on screen.
  const targetAspect = (viewport.width / viewport.height) * (source.height / source.width);
  const aspect = w / h;
  if (aspect < targetAspect) {
    const want = Math.min(1, h * targetAspect);
    const centreX = Math.min(1 - want / 2, Math.max(want / 2, left + w / 2));
    left = clamp01(centreX - want / 2); w = Math.min(want, 1 - left);
  } else if (aspect > targetAspect) {
    const want = Math.min(1, w / targetAspect);
    const centreY = Math.min(1 - want / 2, Math.max(want / 2, top + h / 2));
    top = clamp01(centreY - want / 2); h = Math.min(want, 1 - top);
  }

  // The region renders at the largest scale that still fits the viewport, so the
  // gain over a whole-frame fit is how much smaller the region is on its
  // binding axis.
  const fitScale = (rw: number, rh: number) =>
    Math.min(viewport.width / (rw * source.width), viewport.height / (rh * source.height));
  const readabilityGain = fitScale(w, h) / fitScale(1, 1);
  if (!Number.isFinite(readabilityGain) || readabilityGain < INFORMATION_FIT.minGain) return null;

  const region = { x: left, y: top, w, h };
  const contains = (box: Box) => box.x >= region.x - 1e-6 && box.y >= region.y - 1e-6 &&
    box.x + box.w <= region.x + region.w + 1e-6 && box.y + box.h <= region.y + region.h + 1e-6;
  const coverage = boxes.filter(contains).length / boxes.length;
  return { ...region, readabilityGain: Number(readabilityGain.toFixed(3)),
    coverage: Number(coverage.toFixed(4)), sampleCount: samples.length, boxCount: boxes.length };
}

/** Detects an independent important region for every information shot. Separate
 * render branches switch at the shot boundary, so an article and a later chart
 * never compromise each other's composition. */
export function detectInformationRegions(frames: AnalysisFrame[], shots: Shot[],
  viewport: { width: number; height: number }, source: { width: number; height: number }) {
  return shots.filter((shot) => shot.layout === 'FIT' && shot.informationMode)
    .flatMap((shot): ShotInformationRegion[] => {
      const region = detectInformationRegion(frames, [shot], viewport, source);
      return region ? [{ shot, region }] : [];
    });
}

/** The region in source pixels, snapped to even dimensions for FFmpeg's crop. */
export function regionCropRect(region: InformationRegion,
  source: { width: number; height: number }): Rect {
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const width = even(region.w * source.width);
  const height = even(region.h * source.height);
  const x = Math.max(0, Math.min(source.width - width, Math.round(region.x * source.width)));
  const y = Math.max(0, Math.min(source.height - height, Math.round(region.y * source.height)));
  return { x, y, width, height };
}
