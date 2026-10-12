import type { CSSProperties } from 'react';
import { manualZoomCss, readManualZoom } from '@ai-content-platform/shared/manual-zoom.cjs';
import { NEUTRAL_CROP, type CropInsets } from './edit-mode-types';

/**
 * The preview's half of the transform contract.
 *
 * This must compose in the SAME order as edit-mode-segment-filter.ts on the
 * backend - crop, then flip, then rotate, then scale/position - or the preview
 * and the export disagree, which is the exact defect this replaced: `rotation`
 * used to be drawn here and ignored by the renderer entirely.
 *
 * Crop needs two CSS properties, not one. `clip-path` removes the cropped-away
 * region (a transform alone would merely move it, leaving it on screen), and the
 * transform then fits what survives. Together they reproduce the renderer's
 * crop -> scale(fit) -> pad chain, letterboxing rather than stretching.
 *
 * CSS applies a transform list right-to-left, so the string is built in reverse:
 * the rightmost entries are the crop fit, and the leftmost is the position offset.
 */

const num = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

const percent = (value: number) => `${(value * 100).toFixed(4)}%`;

export function readCropInsets(properties: Record<string, unknown>): CropInsets {
  const crop = properties.crop;
  if (!crop || typeof crop !== 'object') return { ...NEUTRAL_CROP };
  const value = crop as Record<string, unknown>;
  return { left: num(value.left), right: num(value.right),
    top: num(value.top), bottom: num(value.bottom) };
}

export type TransformStyleOptions = {
  /** VIDEO carries its own manual zoom/pan; an overlay is placed by its
   * box instead, so those two steps are skipped for one. */
  includeScaleAndOffset?: boolean;
  /** The framed picture's window in CSS pixels (the canvas, or a card layout's video window).
   * The pan is a fraction of this window - the same unit the export uses - so pass it whenever
   * the element being transformed is not itself exactly that window. */
  zoomWindow?: { width: number; height: number };
};

export function transformStyle(properties: Record<string, unknown>,
  options: TransformStyleOptions = {}): CSSProperties {
  const crop = readCropInsets(properties);
  const rotation = num(properties.rotation, 0);
  const flipH = properties.flipH === true;
  const flipV = properties.flipV === true;
  const parts: string[] = [];

  if (options.includeScaleAndOffset) {
    // The ONE manual zoom (packages/shared/manual-zoom.cjs): the export reads the same function,
    // including the pan limit that keeps the picture covering its window.
    const zoom = readManualZoom(properties);
    if (options.zoomWindow) {
      const css = manualZoomCss(zoom, options.zoomWindow.width, options.zoomWindow.height);
      if (css) parts.push(css);
    } else {
      if (zoom.x !== 0 || zoom.y !== 0) parts.push(`translate(${percent(zoom.x)}, ${percent(zoom.y)})`);
      if (zoom.scale !== 1) parts.push(`scale(${zoom.scale})`);
    }
  }
  if (rotation !== 0) parts.push(`rotate(${rotation}deg)`);
  if (flipH) parts.push('scaleX(-1)');
  if (flipV) parts.push('scaleY(-1)');

  const keptWidth = 1 - crop.left - crop.right;
  const keptHeight = 1 - crop.top - crop.bottom;
  const cropped = keptWidth < 1 || keptHeight < 1;
  if (cropped && keptWidth > 0 && keptHeight > 0) {
    // One uniform scale, matching the renderer's fit-and-pad: the kept region is
    // never stretched, so a crop that changes aspect letterboxes rather than
    // distorting. `clip-path` below is what actually removes the rest.
    const fit = Math.min(1 / keptWidth, 1 / keptHeight);
    if (fit !== 1) parts.push(`scale(${fit.toFixed(6)})`);
    parts.push(`translate(${percent((crop.right - crop.left) / 2)}, ` +
      `${percent((crop.bottom - crop.top) / 2)})`);
  }

  const style: CSSProperties = { transformOrigin: 'center' };
  if (parts.length) style.transform = parts.join(' ');
  if (cropped) {
    style.clipPath = `inset(${percent(crop.top)} ${percent(crop.right)} ` +
      `${percent(crop.bottom)} ${percent(crop.left)})`;
  }
  return style;
}

/** True when nothing would be drawn differently. */
export const hasTransform = (properties: Record<string, unknown>) => {
  const style = transformStyle(properties, { includeScaleAndOffset: true });
  return Boolean(style.transform || style.clipPath);
};
