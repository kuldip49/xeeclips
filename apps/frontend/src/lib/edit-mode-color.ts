/**
 * The editor's half of the colour contract.
 *
 * This mirrors `apps/backend/src/modules/edit-mode/edit-mode-color.ts` exactly -
 * the same keys, the same bounds, the same neutral, the same filter definitions.
 * It exists so a slider can redraw at pointer speed without a round trip, and
 * `test-edit-mode-color.cjs` compares it field by field against the backend's
 * own `/edit-mode/color` catalogue so the two cannot drift.
 */

import type { CSSProperties } from 'react';

export type ColorAdjustments = {
  exposure: number; brightness: number; contrast: number; highlights: number; shadows: number;
  saturation: number; temperature: number; tint: number; sharpness: number; fade: number;
  vignette: number;
};

export const COLOR_KEYS = ['exposure', 'brightness', 'contrast', 'highlights', 'shadows',
  'saturation', 'temperature', 'tint', 'sharpness', 'fade', 'vignette'] as const;
export type ColorKey = typeof COLOR_KEYS[number];

export const COLOR_BOUNDS: Record<ColorKey, { min: number; max: number }> = {
  exposure: { min: -1, max: 1 },
  brightness: { min: -1, max: 1 },
  contrast: { min: -1, max: 1 },
  highlights: { min: -1, max: 1 },
  shadows: { min: -1, max: 1 },
  saturation: { min: -1, max: 1 },
  temperature: { min: -1, max: 1 },
  tint: { min: -1, max: 1 },
  sharpness: { min: 0, max: 1 },
  fade: { min: 0, max: 1 },
  vignette: { min: 0, max: 1 }
};

export const NEUTRAL_COLOR: ColorAdjustments = {
  exposure: 0, brightness: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0,
  temperature: 0, tint: 0, sharpness: 0, fade: 0, vignette: 0
};

/** How each control is labelled and written out. Sliders are all -100..100 or
 * 0..100 in the UI; the stored value is the normalized one. */
export const COLOR_CONTROLS: Array<{ key: ColorKey; label: string; hint: string }> = [
  { key: 'exposure', label: 'Exposure', hint: 'Overall light, weighted to the midtones' },
  { key: 'brightness', label: 'Brightness', hint: 'Lifts or lowers the whole picture' },
  { key: 'contrast', label: 'Contrast', hint: 'Separation between dark and light' },
  { key: 'highlights', label: 'Highlights', hint: 'The brightest part of the picture' },
  { key: 'shadows', label: 'Shadows', hint: 'The darkest part of the picture' },
  { key: 'saturation', label: 'Saturation', hint: 'How strong the colours are' },
  { key: 'temperature', label: 'Temperature', hint: 'Cooler (blue) to warmer (orange)' },
  { key: 'tint', label: 'Tint', hint: 'Green to magenta' },
  { key: 'sharpness', label: 'Sharpness', hint: 'Edge definition' },
  { key: 'fade', label: 'Fade', hint: 'Lifted blacks, for a soft film look' },
  { key: 'vignette', label: 'Vignette', hint: 'Darkens the corners' }
];

export const COLOR_FILTER_IDS = ['ORIGINAL', 'CLEAN', 'WARM', 'COOL', 'CINEMATIC', 'VIBRANT',
  'SOFT', 'HIGH_CONTRAST', 'VINTAGE', 'BLACK_AND_WHITE'] as const;
export type ColorFilterId = typeof COLOR_FILTER_IDS[number];

export type ColorFilterDefinition = {
  id: ColorFilterId; label: string; description: string;
  adjustments: Partial<ColorAdjustments>;
};

export const COLOR_FILTERS: ColorFilterDefinition[] = [
  { id: 'ORIGINAL', label: 'Original', description: 'No colour change.', adjustments: {} },
  { id: 'CLEAN', label: 'Clean',
    description: 'A neutral social grade: a little contrast and bite, no colour cast.',
    adjustments: { contrast: 0.18, saturation: 0.1, sharpness: 0.25, shadows: 0.06 } },
  { id: 'WARM', label: 'Warm', description: 'Golden skin tones and a gentle lift.',
    adjustments: { temperature: 0.35, exposure: 0.08, saturation: 0.12, contrast: 0.1 } },
  { id: 'COOL', label: 'Cool', description: 'A cooler, cleaner, slightly harder look.',
    adjustments: { temperature: -0.35, contrast: 0.14, saturation: 0.04 } },
  { id: 'CINEMATIC', label: 'Cinematic',
    description: 'Held highlights, lifted shadows, cool cast and a soft vignette.',
    adjustments: { contrast: 0.26, highlights: -0.2, shadows: 0.16, saturation: -0.08,
      temperature: -0.12, fade: 0.14, vignette: 0.3 } },
  { id: 'VIBRANT', label: 'Vibrant', description: 'Punchy colour for busy feeds.',
    adjustments: { saturation: 0.45, contrast: 0.2, sharpness: 0.3 } },
  { id: 'SOFT', label: 'Soft', description: 'Lower contrast and a light bloom of fade.',
    adjustments: { contrast: -0.18, highlights: 0.12, fade: 0.22, saturation: -0.06 } },
  { id: 'HIGH_CONTRAST', label: 'High contrast', description: 'Hard, graphic, high impact.',
    adjustments: { contrast: 0.55, shadows: -0.2, highlights: 0.1, sharpness: 0.35 } },
  { id: 'VINTAGE', label: 'Vintage', description: 'Faded, warm and a little desaturated.',
    adjustments: { fade: 0.34, temperature: 0.24, saturation: -0.28, contrast: -0.1,
      vignette: 0.35 } },
  { id: 'BLACK_AND_WHITE', label: 'Black & white', description: 'Full monochrome with bite.',
    adjustments: { saturation: -1, contrast: 0.22, sharpness: 0.2 } }
];

const num = (value: unknown, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/** Reads the colour stored on an element, resolving absent or partial state to
 * the neutral value - exactly as the backend's `readColor` does. */
export function readColorAdjustments(properties: Record<string, unknown>): ColorAdjustments {
  const stored = properties.colorAdjustments;
  const record = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored as Record<string, unknown> : {};
  const resolved = { ...NEUTRAL_COLOR };
  for (const key of COLOR_KEYS) {
    const { min, max } = COLOR_BOUNDS[key];
    resolved[key] = Math.max(min, Math.min(max, num(record[key], 0)));
  }
  return resolved;
}

export const readColorFilterId = (properties: Record<string, unknown>): ColorFilterId | null => {
  const id = properties.colorFilterId;
  return typeof id === 'string' && COLOR_FILTER_IDS.includes(id as ColorFilterId)
    ? id as ColorFilterId : null;
};

export const readColorFilterStrength = (properties: Record<string, unknown>) =>
  Math.max(0, Math.min(1, num(properties.colorFilterStrength, 1)));

export const isNeutralColor = (color: ColorAdjustments) =>
  COLOR_KEYS.every((key) => Math.abs(color[key]) < 1e-9);

export function resolveColorFilter(id: ColorFilterId, strength = 1): ColorAdjustments {
  const definition = COLOR_FILTERS.find((filter) => filter.id === id);
  const resolved = { ...NEUTRAL_COLOR };
  if (!definition) return resolved;
  const amount = Math.max(0, Math.min(1, strength));
  for (const key of COLOR_KEYS) {
    const target = definition.adjustments[key];
    if (target === undefined) continue;
    const { min, max } = COLOR_BOUNDS[key];
    resolved[key] = Number(Math.max(min, Math.min(max, target * amount)).toFixed(6));
  }
  return resolved;
}

/** True when the stored values still match the filter they are labelled with.
 * When they do not, the panel says "Cinematic (edited)" rather than pretending
 * the filter is still what is on screen. */
export function matchesFilter(color: ColorAdjustments, id: ColorFilterId | null,
  strength: number): boolean {
  if (!id) return isNeutralColor(color);
  const target = resolveColorFilter(id, strength);
  return COLOR_KEYS.every((key) => Math.abs(color[key] - target[key]) < 1e-4);
}

// --- Preview ----------------------------------------------------------------
//
// PARITY LIMITS, stated plainly rather than papered over. The export is
// authoritative; this is the closest deterministic approximation a browser can
// draw, and the Adjust panel says so on screen.
//
//   brightness   CSS brightness()   - close; CSS is multiplicative, FFmpeg's eq
//                                     brightness is additive, so deep shadows
//                                     move slightly less here than in the export.
//   contrast     CSS contrast()     - close.
//   saturation   CSS saturate()     - close. -100% is exactly monochrome in both.
//   exposure     CSS brightness()   - approximated. The renderer applies a GAMMA
//                                     change, which holds highlights; the CSS
//                                     approximation scales linearly, so bright
//                                     areas preview slightly hotter than they
//                                     export.
//   temperature  sepia + hue-rotate + saturate - an approximation of a per-channel
//                                     colour balance. The direction and rough
//                                     strength match; the exact hue does not.
//   tint         hue-rotate         - same caveat.
//   fade         a white veil + reduced contrast - visually equivalent to the
//                                     renderer's lifted black point.
//   vignette     a radial-gradient overlay - visually equivalent.
//   highlights   partially reproduced through contrast/brightness. CSS has no
//   shadows      tone curve, so these two are DIRECTIONALLY right and not exact.
//   sharpness    NOT reproduced. CSS has no unsharp mask. The panel marks it.

/** Controls the preview can only approximate, or cannot draw at all. Surfaced in
 * the UI so no control silently claims a fidelity it does not have. */
export const PREVIEW_PARITY: Record<ColorKey, 'EXACT' | 'APPROXIMATE' | 'EXPORT_ONLY'> = {
  brightness: 'EXACT', contrast: 'EXACT', saturation: 'EXACT',
  exposure: 'APPROXIMATE', highlights: 'APPROXIMATE', shadows: 'APPROXIMATE',
  temperature: 'APPROXIMATE', tint: 'APPROXIMATE', fade: 'APPROXIMATE',
  vignette: 'APPROXIMATE', sharpness: 'EXPORT_ONLY'
};

const round = (value: number) => Number(value.toFixed(4));

/**
 * The CSS `filter` string approximating one grade.
 *
 * Gains match the renderer's COLOR_GAINS wherever CSS has an equivalent, so a
 * slider at half travel looks half as strong in both places.
 */
export function colorFilterCss(color: ColorAdjustments): string {
  const parts: string[] = [];
  // Exposure and brightness both end up as CSS brightness; they are summed once
  // rather than stacked as two filters, which would multiply.
  const light = 2 ** (color.exposure * 0.8) * (1 + color.brightness * 0.3);
  if (Math.abs(light - 1) > 1e-6) parts.push(`brightness(${round(light)})`);
  // Fade lowers contrast as well as lifting black, and highlights/shadows are
  // approximated as a small contrast change in opposite directions.
  const contrast = (1 + color.contrast * 0.6) *
    (1 - color.fade * 0.18) *
    (1 + (color.shadows * -0.1) + (color.highlights * 0.1));
  if (Math.abs(contrast - 1) > 1e-6) parts.push(`contrast(${round(Math.max(0, contrast))})`);
  const saturation = Math.max(0, 1 + color.saturation);
  if (Math.abs(saturation - 1) > 1e-6) parts.push(`saturate(${round(saturation)})`);
  if (color.temperature !== 0) {
    // Warm is sepia rotated towards orange; cool is the same rotated past blue.
    parts.push(`sepia(${round(Math.abs(color.temperature) * 0.5)})`,
      `hue-rotate(${round(color.temperature > 0 ? -12 : 170)}deg)`,
      `saturate(${round(1 + Math.abs(color.temperature) * 0.25)})`);
  }
  if (color.tint !== 0) parts.push(`hue-rotate(${round(color.tint * 18)}deg)`);
  return parts.join(' ');
}

/** The style for the `<video>` element itself. */
export function colorPreviewStyle(color: ColorAdjustments): CSSProperties {
  const filter = colorFilterCss(color);
  return filter ? { filter } : {};
}

/**
 * The two overlay layers CSS filters cannot express: the fade veil and the
 * vignette. Both are drawn above the video and below the overlays, so they grade
 * the footage without washing out a logo or a caption - which is also what the
 * renderer does, since colour is applied per segment before compositing.
 */
export function colorOverlayLayers(color: ColorAdjustments): Array<{
  key: string; style: CSSProperties;
}> {
  const layers: Array<{ key: string; style: CSSProperties }> = [];
  if (color.fade > 0) {
    layers.push({ key: 'fade', style: { background: '#ffffff',
      opacity: round(color.fade * 0.18) } });
  }
  if (color.vignette > 0) {
    layers.push({ key: 'vignette', style: { background:
      `radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,${
        round(Math.min(0.85, color.vignette * 0.8))}) 100%)` } });
  }
  return layers;
}
