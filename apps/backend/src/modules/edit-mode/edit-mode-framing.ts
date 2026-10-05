// Step 5: canonical framing (crop / fit / fill / aspect) and reframe policy.
//
// Framing is two layers of canonical state:
//
//   project   settings.aspectRatio (the output canvas) and settings.reframePolicy
//             (how the camera is solved over the whole timeline);
//   segment   a VIDEO element's `crop` insets and `frameLayout` override
//             (FIT = whole kept region visible, letterboxed; FILL = cover the canvas).
//
// Nothing here rebuilds a timeline: framing writes only framing properties, so
// trims, order, speed, captions, hook, overlays, audio and zoom are untouched.
// Pure module - no Prisma, no FFmpeg.

import { MIN_CROP_REMAINDER, type CropInsets, NEUTRAL_CROP } from './edit-mode-transform';
import type { EditAspectRatio, ReframePolicy } from './presets/edit-preset-policy';

export const FRAMING_MODES = ['FIT', 'FILL', 'ASPECT', 'FREE'] as const;
export type FramingMode = typeof FRAMING_MODES[number];

export const FRAME_LAYOUTS = ['FIT', 'FILL'] as const;
export type FrameLayout = typeof FRAME_LAYOUTS[number];

export const FRAMING_ASPECTS = ['9:16', '16:9', '1:1'] as const;
export type FramingAspect = typeof FRAMING_ASPECTS[number];

export class FramingError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const RATIO: Record<FramingAspect, number> = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1 };

export function readFrameLayout(properties: unknown): FrameLayout | null {
  const value = properties && typeof properties === 'object'
    ? (properties as Record<string, unknown>).frameLayout : undefined;
  return value === 'FIT' || value === 'FILL' ? value : null;
}

export function validateFramingMode(value: unknown): FramingMode {
  const mode = String(value ?? '').trim().toUpperCase();
  if (!(FRAMING_MODES as readonly string[]).includes(mode)) {
    throw new FramingError('INVALID_FRAMING_MODE',
      `mode must be one of ${FRAMING_MODES.join(', ')}`);
  }
  return mode as FramingMode;
}

export function validateFramingAspect(value: unknown): FramingAspect {
  const raw = String(value ?? '').trim().toLowerCase();
  const aspect = raw === 'vertical' || raw === 'portrait' || raw === '9x16' ? '9:16'
    : raw === 'horizontal' || raw === 'landscape' || raw === '16x9' ? '16:9'
      : raw === 'square' || raw === '1x1' ? '1:1' : raw;
  if (!(FRAMING_ASPECTS as readonly string[]).includes(aspect)) {
    throw new FramingError('INVALID_ASPECT_RATIO',
      `aspectRatio must be one of ${FRAMING_ASPECTS.join(', ')}`);
  }
  return aspect as FramingAspect;
}

/**
 * Centred source insets that carve `aspect` out of a `width` x `height` frame.
 * A frame that is already that shape yields the neutral crop.
 */
export function aspectCropInsets(width: number, height: number, aspect: FramingAspect): CropInsets {
  if (!(width > 0) || !(height > 0)) {
    throw new FramingError('SOURCE_DIMENSIONS_UNKNOWN',
      'The source frame size is unknown, so an aspect crop cannot be computed');
  }
  const sourceRatio = width / height;
  const target = RATIO[aspect];
  if (Math.abs(sourceRatio - target) < 0.01) return { ...NEUTRAL_CROP };
  const round = (value: number) => Number(value.toFixed(6));
  if (sourceRatio > target) {
    const keep = target / sourceRatio;
    if (keep < MIN_CROP_REMAINDER) throw new FramingError('INVALID_CROP',
      'That aspect would leave too little of the frame');
    const inset = round((1 - keep) / 2);
    return { left: inset, right: inset, top: 0, bottom: 0 };
  }
  const keep = sourceRatio / target;
  if (keep < MIN_CROP_REMAINDER) throw new FramingError('INVALID_CROP',
    'That aspect would leave too little of the frame');
  const inset = round((1 - keep) / 2);
  return { left: 0, right: 0, top: inset, bottom: inset };
}

/**
 * User-facing reframe vocabulary -> the renderer policy that genuinely does it.
 * Anything the renderer cannot honestly do is UNSUPPORTED, never faked.
 */
export const REFRAME_POLICY_ALIASES: Record<string, ReframePolicy> = {
  SOURCE: 'SOURCE', ORIGINAL: 'SOURCE', NONE: 'SOURCE',
  AUTO: 'AUTO',
  FACE_FOCUSED: 'FACE_FOCUSED', FACE_PRIORITY: 'FACE_FOCUSED', TALKING_HEAD: 'FACE_FOCUSED',
  SPEAKER: 'FACE_FOCUSED',
  CENTERED: 'CENTERED', CENTER: 'CENTERED', CENTRED: 'CENTERED',
  INFORMATION_PRESERVING: 'INFORMATION_PRESERVING', INFORMATION_PRIORITY: 'INFORMATION_PRESERVING',
  SCREEN_TUTORIAL: 'INFORMATION_PRESERVING'
};

/** Named policies the renderer has no real implementation for. */
export const UNSUPPORTED_REFRAME_POLICIES: Record<string, string> = {
  TWO_PERSON_SAFE: 'Two-person framing needs pair-aware camera solving, which the export ' +
    'renderer does not have. Use AUTO (keeps the classifier\'s fit/fill per shot) or FIT.',
  PRODUCT_CENTER: 'There is no product detector in the analysis, so product-centred framing ' +
    'cannot be computed. Use CENTERED for a static centre crop.'
};

export function resolveReframePolicy(value: unknown): ReframePolicy {
  const key = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/gu, '_');
  if (UNSUPPORTED_REFRAME_POLICIES[key]) {
    throw new FramingError('UNSUPPORTED_REFRAME_POLICY', UNSUPPORTED_REFRAME_POLICIES[key]);
  }
  const policy = REFRAME_POLICY_ALIASES[key];
  if (!policy) throw new FramingError('INVALID_REFRAME_POLICY',
    `reframe policy must be one of ${Object.keys(REFRAME_POLICY_ALIASES).join(', ')}`);
  return policy;
}

/** The project canvas after a whole-project aspect crop. */
export function canvasForAspect(aspect: FramingAspect): EditAspectRatio {
  return aspect;
}
