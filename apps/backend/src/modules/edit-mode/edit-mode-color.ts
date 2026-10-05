// EditMode manual colour.
//
// Colour is canonical EditElement state, exactly like crop and speed: this
// module is the single place that says what a valid adjustment is, what the
// neutral one looks like, and what each built-in filter resolves to. The command
// layer, the render planner, the preview parity test and the editor's own mirror
// all read the bounds from here, so a value the editor can store is by
// construction a value the renderer can honour.
//
// Everything is pure. Nothing here touches Prisma, FFmpeg or the frozen pipeline.
//
// --- Ranges ------------------------------------------------------------------
//
// Every control is NORMALIZED and NEUTRAL AT ZERO. Eight of the eleven are
// bipolar (-1..1, zero meaning "leave it alone"); `sharpness`, `fade` and
// `vignette` are unipolar (0..1) because there is no meaningful negative of
// them. One convention for all of them is what makes "reset" a single value, a
// legacy element with no colour block indistinguishable from an untouched one,
// and a filter definition a plain interpolation from zero.

export type ColorAdjustments = {
  /** Midtone exposure, applied as a gamma change. */
  exposure: number;
  /** Additive lift of the whole signal. */
  brightness: number;
  contrast: number;
  /** Tone-curve control over the top and the bottom of the range. */
  highlights: number;
  shadows: number;
  saturation: number;
  /** Blue <-> orange. Positive is warmer. */
  temperature: number;
  /** Green <-> magenta. Positive is magenta. */
  tint: number;
  /** Unsharp-mask amount. 0 is off. */
  sharpness: number;
  /** Lifted-black film fade. 0 is off. */
  fade: number;
  /** Corner darkening. 0 is off. */
  vignette: number;
};

export const COLOR_KEYS = ['exposure', 'brightness', 'contrast', 'highlights', 'shadows',
  'saturation', 'temperature', 'tint', 'sharpness', 'fade', 'vignette'] as const;
export type ColorKey = typeof COLOR_KEYS[number];

/** The bounds each control accepts. The editor mirrors this table in
 * `lib/edit-mode-color.ts`, and `test-edit-mode-color.cjs` compares the two
 * field by field so they cannot drift. */
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

/** Built-in filters. Each is a deterministic set of adjustment values - never a
 * LUT, a download or an external asset - so a filter is nothing more than a
 * named starting point the user can then edit by hand. */
export const COLOR_FILTER_IDS = ['ORIGINAL', 'CLEAN', 'WARM', 'COOL', 'CINEMATIC', 'VIBRANT',
  'SOFT', 'HIGH_CONTRAST', 'VINTAGE', 'BLACK_AND_WHITE'] as const;
export type ColorFilterId = typeof COLOR_FILTER_IDS[number];

export type ColorFilterDefinition = {
  id: ColorFilterId;
  label: string;
  description: string;
  /** The values this filter resolves to at full strength. Absent keys are neutral. */
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

export const colorFilter = (id: string): ColorFilterDefinition | undefined =>
  COLOR_FILTERS.find((filter) => filter.id === id);

export class ColorRangeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ColorRangeError';
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

const round = (value: number) => Number(value.toFixed(6));

/**
 * Reads the colour stored on an element, tolerating absent or partial state.
 *
 * A legacy element - one saved before colour existed - has no `colorAdjustments`
 * at all, and every key of it resolves to the neutral value here rather than to
 * NaN or to a silently different default. This is the only reader: the render
 * planner and the command layer both go through it.
 */
export function readColor(properties: unknown): ColorAdjustments {
  const stored = record(record(properties).colorAdjustments);
  const resolved = { ...NEUTRAL_COLOR };
  for (const key of COLOR_KEYS) {
    const parsed = Number(stored[key]);
    if (!Number.isFinite(parsed)) continue;
    const { min, max } = COLOR_BOUNDS[key];
    resolved[key] = round(Math.max(min, Math.min(max, parsed)));
  }
  return resolved;
}

/** The filter id last applied, for the UI and for templates. It is a LABEL: the
 * resolved adjustments above are what actually renders. */
export function readColorFilterId(properties: unknown): ColorFilterId | null {
  const id = record(properties).colorFilterId;
  return typeof id === 'string' && colorFilter(id) ? id as ColorFilterId : null;
}

export function readColorFilterStrength(properties: unknown): number {
  const parsed = Number(record(properties).colorFilterStrength);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, round(parsed))) : 1;
}

export const isNeutralColor = (color: ColorAdjustments) =>
  COLOR_KEYS.every((key) => Math.abs(color[key]) < 1e-9);

/** Validates one control. Rejecting rather than clamping is deliberate: silently
 * accepting a value the renderer would not honour is how a preview and an export
 * drift apart. */
export function validateColorValue(key: ColorKey, value: unknown): number {
  const parsed = Number(value);
  const { min, max } = COLOR_BOUNDS[key];
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ColorRangeError('INVALID_COLOR_VALUE',
      `${key} must be between ${min} and ${max}`);
  }
  return round(parsed);
}

export function validateColorFilterId(value: unknown): ColorFilterId {
  if (typeof value !== 'string' || !colorFilter(value)) {
    throw new ColorRangeError('INVALID_COLOR_FILTER',
      `filterId must be one of ${COLOR_FILTER_IDS.join(', ')}`);
  }
  return value as ColorFilterId;
}

export function validateColorFilterStrength(value: unknown): number {
  if (value === undefined || value === null) return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new ColorRangeError('INVALID_COLOR_FILTER_STRENGTH',
      'strength must be between 0 and 1');
  }
  return round(parsed);
}

/**
 * Resolves a filter at a strength into concrete adjustment values.
 *
 * Strength is an interpolation from NEUTRAL to the filter's target, resolved
 * ONCE, at the moment the filter is applied. It is deliberately not a
 * render-time multiplier: if it were, the stored numbers would not be the
 * numbers that render, the sliders would show something other than the truth,
 * and moving one would fight a hidden second state. What the user gets instead
 * is a named starting point they then own outright.
 */
export function resolveColorFilter(id: ColorFilterId, strength = 1): ColorAdjustments {
  const definition = colorFilter(id);
  const resolved = { ...NEUTRAL_COLOR };
  if (!definition) return resolved;
  const amount = Math.max(0, Math.min(1, strength));
  for (const key of COLOR_KEYS) {
    const target = definition.adjustments[key];
    if (target === undefined) continue;
    const { min, max } = COLOR_BOUNDS[key];
    resolved[key] = round(Math.max(min, Math.min(max, target * amount)));
  }
  return resolved;
}

/** Stored form of a colour state, ready to merge into element properties. */
export const colorProperties = (color: ColorAdjustments, filterId: ColorFilterId | null,
  strength: number): Record<string, unknown> => ({
  colorAdjustments: { ...color },
  colorFilterId: filterId,
  colorFilterStrength: strength
});
