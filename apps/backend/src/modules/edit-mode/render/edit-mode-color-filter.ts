// EditMode manual colour -> FFmpeg.
//
// Pure: a ColorAdjustments in, a filter chain string out. Keeping this separate
// from the graph builder is what lets the tests assert the exact chain a given
// grade produces without encoding anything, and what lets the real-media verify
// script measure the pixels those filters actually produce.
//
// --- Where colour sits in the segment chain ---------------------------------
//
// The full per-segment order is:
//
//   colour -> crop -> flip -> rotate -> normalize -> scale/position
//
// Colour comes FIRST, on the source pixels, for two reasons. It matches the
// preview, where a CSS `filter` is resolved on the element's own content before
// its `transform` places it - so what is graded is the picture, not the frame it
// ends up in. And it keeps the black that crop, rotation and fit-padding
// introduce genuinely black: a `brightness` lift applied afterwards would raise
// the letterbox bars along with the image, which is a visible artefact and one
// no editor expects.
//
// --- Within colour ----------------------------------------------------------
//
//   eq (exposure/brightness/contrast/saturation)
//     -> curves (shadows/highlights/fade)
//     -> colorchannelmixer (temperature/tint)
//     -> unsharp (sharpness)
//     -> vignette
//
// Tone before colour before detail: contrast is set on the untinted signal, the
// cast is laid over the tone that resulted, and sharpening reads the graded
// image. Each stage is emitted ONLY when its controls are non-neutral, so a
// neutral grade produces the empty string and therefore byte-identical FFmpeg
// arguments to the ones the export produced before colour existed.

import { isNeutralColor, type ColorAdjustments } from '../edit-mode-color';

/**
 * Gains. Each maps a normalized -1..1 (or 0..1) control onto the range of the
 * FFmpeg parameter behind it. They are deliberately conservative: the ends of
 * every slider are a strong-but-usable grade rather than a destroyed frame, so
 * there is no region of the control that is not worth having.
 */
export const COLOR_GAINS = {
  /** eq brightness is additive over -1..1; a third of it is already a lot. */
  brightness: 0.3,
  /** eq contrast is a multiplier around 1. */
  contrast: 0.6,
  /** eq saturation is a multiplier around 1; -1 must reach exactly 0 (mono). */
  saturation: 1,
  /** Exposure is a gamma change, in stops. In eq, gamma > 1 brightens. */
  exposureStops: 0.8,
  /** Tone-curve displacement of the 0.25 and 0.75 control points. */
  curve: 0.2,
  /** Black lift for `fade`. */
  fadeLift: 0.18,
  /** Per-channel gain for the temperature/tint cast. */
  balance: 0.3,
  /** unsharp luma amount. */
  sharpen: 1.5,
  /** vignette angle, in radians, at full strength. */
  vignetteAngle: 0.9
} as const;

const fixed = (value: number) => Number(value.toFixed(4)).toString();

/** A tone curve point, clamped to the legal 0..1 output range. */
const point = (input: number, output: number) =>
  `${fixed(input)}/${fixed(Math.max(0, Math.min(1, output)))}`;

/**
 * The `eq` stage: exposure, brightness, contrast and saturation.
 *
 * Saturation is the one control with a hard endpoint rather than a taste
 * setting: -1 means monochrome, and it must land on exactly 0 so that the
 * Black & white filter is actually black and white.
 */
function eqStage(color: ColorAdjustments): string {
  const parts: string[] = [];
  if (color.brightness !== 0) {
    parts.push(`brightness=${fixed(color.brightness * COLOR_GAINS.brightness)}`);
  }
  if (color.contrast !== 0) {
    parts.push(`contrast=${fixed(1 + color.contrast * COLOR_GAINS.contrast)}`);
  }
  if (color.saturation !== 0) {
    parts.push(`saturation=${fixed(Math.max(0,
      1 + color.saturation * COLOR_GAINS.saturation))}`);
  }
  if (color.exposure !== 0) {
    // eq applies pow(value, 1/gamma), so a gamma ABOVE 1 brightens. (The first
    // version of this had the sign the other way round and dimmed the picture
    // on a positive exposure; the real-media pixel measurement is what caught
    // it, which is why that measurement exists.)
    parts.push(`gamma=${fixed(2 ** (color.exposure * COLOR_GAINS.exposureStops))}`);
  }
  return parts.length ? `eq=${parts.join(':')}` : '';
}

/**
 * The `curves` stage: shadows, highlights and fade, as one four-point curve.
 *
 * Three controls share one filter because they are three edits to the same
 * transfer function - separate `curves` instances would compose in a way none of
 * the three sliders describes. `fade` lifts the black point; `shadows` and
 * `highlights` move the quarter and three-quarter points, and are carried along
 * by the lift so that raising the black point does not silently undo them.
 */
function curvesStage(color: ColorAdjustments): string {
  if (color.shadows === 0 && color.highlights === 0 && color.fade === 0) return '';
  const lift = color.fade * COLOR_GAINS.fadeLift;
  const span = 1 - lift;
  const shadow = lift + span * (0.25 + color.shadows * COLOR_GAINS.curve);
  const highlight = lift + span * (0.75 + color.highlights * COLOR_GAINS.curve);
  const points = [point(0, lift), point(0.25, shadow), point(0.75, highlight), point(1, 1)];
  return `curves=all='${points.join(' ')}'`;
}

/**
 * The `colorchannelmixer` stage: temperature and tint.
 *
 * Both are casts over the same three channels, so they are ONE filter rather
 * than two: warm pushes red up and blue down, magenta pushes green down and red
 * and blue up, and an editor who sets both gets the sum once instead of two
 * stacked casts whose interaction neither slider describes.
 *
 * `colorbalance` would be the obvious filter and is deliberately NOT used: on
 * the yuv420p sources this editor works with it is a silent no-op in practice -
 * the real-media verification measured a temperature change of exactly zero
 * through it. `colorchannelmixer` is a plain per-channel gain, it is measurably
 * effective on the same input, and it is exactly as deterministic.
 */
function balanceStage(color: ColorAdjustments): string {
  if (color.temperature === 0 && color.tint === 0) return '';
  const g = COLOR_GAINS.balance;
  const red = 1 + color.temperature * g + color.tint * g * 0.5;
  const green = 1 - color.tint * g;
  const blue = 1 - color.temperature * g + color.tint * g * 0.5;
  const gain = (value: number) => fixed(Math.max(0, value));
  return `colorchannelmixer=rr=${gain(red)}:gg=${gain(green)}:bb=${gain(blue)}`;
}

/**
 * The FFmpeg chain for one element's colour.
 *
 * Returns '' when the grade is neutral, so an untouched timeline produces
 * exactly the arguments it produced before this module existed.
 */
export function colorAdjustmentFilter(color: ColorAdjustments): string {
  if (isNeutralColor(color)) return '';
  const parts = [eqStage(color), curvesStage(color), balanceStage(color)];
  if (color.sharpness > 0) {
    // Luma-only: sharpening chroma on compressed source pixels produces edge
    // colour fringing rather than detail.
    parts.push(`unsharp=5:5:${fixed(color.sharpness * COLOR_GAINS.sharpen)}:5:5:0`);
  }
  if (color.vignette > 0) {
    parts.push(`vignette=angle=${fixed(color.vignette * COLOR_GAINS.vignetteAngle)}`);
  }
  return parts.filter(Boolean).join(',');
}
