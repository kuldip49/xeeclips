// EditMode manual transform -> FFmpeg.
//
// Pure: a RenderVideoSegment (or an overlay's transform) in, a filter chain
// string out. Keeping this separate from the graph builder is what lets the
// tests assert the exact chain a given crop/rotation/flip/speed produces without
// encoding anything, which is the only way "the export matches the preview" can
// be a checked claim rather than a hopeful one.
//
// Order is fixed and deliberate:
//
//   crop -> flip -> rotate -> normalize
//
// Manual zoom/pan (`scale`, `offsetX`, `offsetY`) is deliberately NOT part of this chain. It is
// one canonical transform of the FRAMED picture, applied by the filtergraph after the camera and
// fitted layers have produced the picture the viewer sees (see `manualZoomFilter` in
// packages/shared/manual-zoom.cjs). Doing it here, on the raw source frame, made the offsets mean
// "fractions of the source file" - a different distance on screen for every source/canvas
// aspect pair - and let the camera crop slide the zoom around. Keep it out of this function.
//
// Crop selects the source region first, so rotation spins what the user framed
// rather than framing what rotation produced. The normalize step puts every
// segment back to the source frame size, which is what allows segments with
// DIFFERENT crops to be concatenated at all - concat requires identical
// dimensions, and a per-segment crop would otherwise break a split timeline.

import type { CropInsets } from '../edit-mode-transform';

/** atempo is only well-conditioned over this range, so a larger change is
 * applied as a chain of in-range steps rather than one out-of-range filter. */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2;

export type SegmentTransform = {
  crop: CropInsets;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /** Manual zoom/pan - carried with the segment, applied by `manualZoomFilter`, not here. */
  scale: number;
  offsetX: number;
  offsetY: number;
};

const even = (value: number) => {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
};

const isNeutral = (transform: SegmentTransform) =>
  transform.crop.left === 0 && transform.crop.right === 0 &&
  transform.crop.top === 0 && transform.crop.bottom === 0 &&
  transform.rotation === 0 && !transform.flipH && !transform.flipV;

/**
 * The filter chain for one segment's manual transform.
 *
 * Returns '' when the transform is neutral, so an untouched timeline produces
 * byte-identical FFmpeg arguments to the ones it produced before this existed.
 */
export function segmentTransformFilter(transform: SegmentTransform,
  sourceWidth: number, sourceHeight: number): string {
  if (isNeutral(transform)) return '';
  const width = Math.max(2, even(sourceWidth));
  const height = Math.max(2, even(sourceHeight));
  const parts: string[] = [];

  // 1. Crop: the kept source region, in pixels.
  const { crop } = transform;
  if (crop.left || crop.right || crop.top || crop.bottom) {
    const keptWidth = Math.max(2, even(width * (1 - crop.left - crop.right)));
    const keptHeight = Math.max(2, even(height * (1 - crop.top - crop.bottom)));
    const x = Math.max(0, Math.min(width - keptWidth, Math.round(width * crop.left)));
    const y = Math.max(0, Math.min(height - keptHeight, Math.round(height * crop.top)));
    parts.push(`crop=${keptWidth}:${keptHeight}:${x}:${y}`);
  }

  // 2. Flip. Mirroring before rotation keeps a flipped-and-rotated frame the
  //    same as the preview's `scaleX(-1) rotate(a)`, which composes in this order.
  if (transform.flipH) parts.push('hflip');
  if (transform.flipV) parts.push('vflip');

  // 3. Rotate in place, filling the corners it opens up with black.
  if (transform.rotation !== 0) {
    const radians = (transform.rotation * Math.PI / 180).toFixed(6);
    parts.push(`rotate=${radians}:ow=iw:oh=ih:c=black`);
  }

  // 4. Normalize back to the source frame size (see the header note on concat).
  //
  //    The kept region is FITTED and padded, never stretched. Stretching it to
  //    the frame would distort the picture whenever a crop changes the aspect
  //    ratio - a 16:9 crop of a 9:16 source would come out 3x too tall. Fitting
  //    letterboxes instead, which is what an editor expects from a crop; Scale
  //    is the separate control for punching back in.
  //
  //    setsar is not decoration. A crop followed by a scale leaves FFmpeg with a
  //    non-unit sample aspect ratio (a 974x720 region scaled to 1280x720 comes
  //    out as SAR 487:640), and concat compares SAR as well as pixel size, so
  //    without this a transformed segment cannot be joined to an untransformed
  //    one: "Input link parameters do not match the corresponding output link".
  parts.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1');

  return parts.join(',');
}

/** The transform chain for an overlay image. Overlays are scaled and placed by
 * the graph builder, so this covers only crop, flip and rotation. */
export function overlayTransformFilter(transform: {
  crop: CropInsets; rotation: number; flipH: boolean; flipV: boolean;
}): string {
  const parts: string[] = [];
  const { crop } = transform;
  if (crop.left || crop.right || crop.top || crop.bottom) {
    const keptWidth = (1 - crop.left - crop.right).toFixed(6);
    const keptHeight = (1 - crop.top - crop.bottom).toFixed(6);
    // Overlay source dimensions are not known until decode, so the crop is
    // expressed against iw/ih rather than resolved to pixels here.
    parts.push(`crop=iw*${keptWidth}:ih*${keptHeight}:` +
      `iw*${crop.left.toFixed(6)}:ih*${crop.top.toFixed(6)}`);
  }
  if (transform.flipH) parts.push('hflip');
  if (transform.flipV) parts.push('vflip');
  if (transform.rotation !== 0) {
    const radians = (transform.rotation * Math.PI / 180).toFixed(6);
    // An overlay rotates inside its own alpha, so the corners it opens stay
    // transparent rather than becoming black boxes over the video. The frame GROWS to the rotated
    // extent (rotw/roth): keeping it at iw x ih clipped the corners of every rotated image, while the
    // preview (a CSS rotation about the box centre) shows the whole picture. The graph then centres
    // the grown frame on the overlay's box centre.
    parts.push(`rotate=${radians}:ow=rotw(${radians}):oh=roth(${radians}):c=black@0`);
  }
  return parts.join(',');
}

/**
 * The atempo chain for one playback rate.
 *
 * A single atempo outside [0.5, 2] is either rejected or badly conditioned, so
 * a 4x change becomes two 2x steps. Returns '' at 1x.
 */
export function atempoChain(speed: number): string {
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-6) return '';
  const steps: number[] = [];
  let remaining = speed;
  while (remaining > ATEMPO_MAX + 1e-9) { steps.push(ATEMPO_MAX); remaining /= ATEMPO_MAX; }
  while (remaining < ATEMPO_MIN - 1e-9) { steps.push(ATEMPO_MIN); remaining /= ATEMPO_MIN; }
  steps.push(Number(remaining.toFixed(6)));
  return steps.map((step) => `atempo=${step}`).join(',');
}
