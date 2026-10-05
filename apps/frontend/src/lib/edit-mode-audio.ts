/**
 * The editor's half of the audio contract.
 *
 * Mirrors `apps/backend/src/modules/edit-mode/edit-mode-audio.ts`: the same
 * bounds, the same defaults, the same ducking strengths. The panel clamps to
 * these so a control can never ask for a value the server would reject, and
 * `test-edit-mode-color.cjs` compares the two tables so they cannot drift.
 */

export const MIN_VOLUME = 0;
/** Volume is a GAIN, not a fraction: 1 is the level the file was recorded at. */
export const MAX_VOLUME = 2;
export const DEFAULT_VOLUME = 1;
export const DEFAULT_MUSIC_VOLUME = 0.25;
export const MAX_FADE_SEC = 30;

export const DUCK_STRENGTHS = { SUBTLE: 0.6, MEDIUM: 0.35, STRONG: 0.15 } as const;
export type DuckStrengthId = keyof typeof DUCK_STRENGTHS;
export const DUCK_STRENGTH_IDS = ['SUBTLE', 'MEDIUM', 'STRONG'] as const;
export const DEFAULT_DUCK_STRENGTH: DuckStrengthId = 'MEDIUM';

export const DUCK_STRENGTH_LABELS: Record<DuckStrengthId, string> = {
  SUBTLE: 'Subtle', MEDIUM: 'Medium', STRONG: 'Strong'
};

const num = (value: unknown, fallback: number) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export type AudioState = {
  volume: number; muted: boolean; fadeInSec: number; fadeOutSec: number;
  duckEnabled: boolean; duckStrength: DuckStrengthId;
};

/** Reads an AUDIO element's state, resolving absent or partial state the same
 * way the backend does - a clip saved before ducking existed reads un-ducked. */
export function readAudioState(properties: Record<string, unknown>,
  defaultVolume = DEFAULT_MUSIC_VOLUME): AudioState {
  const strength = properties.duckStrength;
  return {
    volume: clamp(num(properties.volume, defaultVolume), MIN_VOLUME, MAX_VOLUME),
    muted: properties.muted === true,
    fadeInSec: clamp(num(properties.fadeInSec, 0), 0, MAX_FADE_SEC),
    fadeOutSec: clamp(num(properties.fadeOutSec, 0), 0, MAX_FADE_SEC),
    duckEnabled: properties.duckUnderSpeech === true,
    duckStrength: typeof strength === 'string' && strength in DUCK_STRENGTHS
      ? strength as DuckStrengthId : DEFAULT_DUCK_STRENGTH
  };
}

/** The source video's own audio, stored on each VIDEO element. */
export function readSourceAudio(properties: Record<string, unknown>) {
  return {
    volume: clamp(num(properties.sourceVolume, DEFAULT_VOLUME), MIN_VOLUME, MAX_VOLUME),
    muted: properties.sourceMuted === true
  };
}

/**
 * The gain the preview can actually apply.
 *
 * PARITY LIMIT: an HTMLMediaElement's `volume` is capped at 1, so the preview
 * cannot play a track boosted above 100%. Anything above unity previews at 100%
 * and exports at the level that was set; the Audio panel says so next to the
 * slider rather than letting the difference be a surprise.
 */
export const previewGain = (volume: number) => clamp(volume, 0, 1);
export const exceedsPreviewGain = (volume: number) => volume > 1.0001;
