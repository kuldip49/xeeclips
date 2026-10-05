// EditMode manual audio.
//
// Source-video audio, uploaded music, trims, fades and speech ducking are all
// canonical EditElement state, and this module is the single place that says
// what a valid value is and what the neutral one looks like. The command layer,
// the render planner and the tests all read the bounds from here.
//
// Everything is pure. Nothing here touches Prisma, FFmpeg or the frozen pipeline.

import type { TimedWord } from '../editing/edit-plan';

// --- Bounds -----------------------------------------------------------------
//
// Volume is a GAIN, not a fraction: 1 is the level the asset was recorded at and
// 2 is twice that. Allowing above unity is what makes "make the music slightly
// louder" possible on a quiet upload; the render's limiter is what stops the sum
// of a boosted track and dialogue from clipping.
export const MIN_VOLUME = 0;
export const MAX_VOLUME = 2;
export const DEFAULT_VOLUME = 1;
/** The level a newly added music clip lands at: present, under the dialogue. */
export const DEFAULT_MUSIC_VOLUME = 0.25;
export const MAX_FADE_SEC = 30;

/** How far the music is pulled down under speech. These are gains, so a smaller
 * number is a deeper duck. */
export const DUCK_STRENGTHS = {
  SUBTLE: 0.6,
  MEDIUM: 0.35,
  STRONG: 0.15
} as const;
export type DuckStrengthId = keyof typeof DUCK_STRENGTHS;
export const DUCK_STRENGTH_IDS = Object.keys(DUCK_STRENGTHS) as DuckStrengthId[];
export const DEFAULT_DUCK_STRENGTH: DuckStrengthId = 'MEDIUM';

export const MIN_DUCK_GAIN = 0;
export const MAX_DUCK_GAIN = 1;
export const MIN_DUCK_MS = 10;
export const MAX_DUCK_MS = 2000;
export const DEFAULT_ATTACK_MS = 150;
export const DEFAULT_RELEASE_MS = 350;

/** Speech separated by less than this is treated as one continuous passage: the
 * music must not bounce back up between two words of a sentence. */
export const SPEECH_GAP_MERGE_SEC = 0.9;
/** Every window becomes a trapezoid in the render expression, so the count is
 * bounded. Adjacent windows are merged until it fits. */
export const MAX_SPEECH_WINDOWS = 48;

export type AudioState = {
  volume: number;
  muted: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  duckEnabled: boolean;
  /** Resolved gain applied under speech. */
  duckGain: number;
  attackMs: number;
  releaseMs: number;
  /** The named strength last chosen, for the UI. `duckGain` is what renders. */
  duckStrength: DuckStrengthId | null;
};

export class AudioRangeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AudioRangeError';
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

const round = (value: number) => Number(value.toFixed(6));

const bounded = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
};

/** Reads the audio state of an AUDIO element, tolerating absent or partial
 * state. A clip saved before ducking existed reads back as un-ducked, never
 * as NaN. */
export function readAudioState(properties: unknown,
  defaultVolume = DEFAULT_MUSIC_VOLUME): AudioState {
  const props = record(properties);
  const strength = props.duckStrength;
  return {
    volume: bounded(props.volume, defaultVolume, MIN_VOLUME, MAX_VOLUME),
    muted: props.muted === true,
    fadeInSec: bounded(props.fadeInSec, 0, 0, MAX_FADE_SEC),
    fadeOutSec: bounded(props.fadeOutSec, 0, 0, MAX_FADE_SEC),
    duckEnabled: props.duckUnderSpeech === true,
    duckGain: bounded(props.duckLevel, DUCK_STRENGTHS[DEFAULT_DUCK_STRENGTH],
      MIN_DUCK_GAIN, MAX_DUCK_GAIN),
    attackMs: bounded(props.attackMs, DEFAULT_ATTACK_MS, MIN_DUCK_MS, MAX_DUCK_MS),
    releaseMs: bounded(props.releaseMs, DEFAULT_RELEASE_MS, MIN_DUCK_MS, MAX_DUCK_MS),
    duckStrength: typeof strength === 'string' && strength in DUCK_STRENGTHS
      ? strength as DuckStrengthId : null
  };
}

/** The source video's own audio, stored on the VIDEO element. Absent state is
 * "as recorded", so a timeline made before these controls existed sounds the
 * same as it always did. */
export function readSourceAudio(properties: unknown): { volume: number; muted: boolean } {
  const props = record(properties);
  return {
    volume: bounded(props.sourceVolume, DEFAULT_VOLUME, MIN_VOLUME, MAX_VOLUME),
    muted: props.sourceMuted === true
  };
}

export function validateVolume(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_VOLUME || parsed > MAX_VOLUME) {
    throw new AudioRangeError('INVALID_VOLUME',
      `volume must be between ${MIN_VOLUME} and ${MAX_VOLUME}`);
  }
  return round(parsed);
}

export function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AudioRangeError('INVALID_AUDIO_FLAG', `${field} must be true or false`);
  }
  return value;
}

/**
 * Validates a fade pair against the length it has to fit inside.
 *
 * Both fades live on the same clip, so the constraint is on the SUM: a 3s fade
 * in and a 3s fade out do not fit a 4s clip even though each of them would.
 */
export function validateFades(fadeInSec: unknown, fadeOutSec: unknown,
  durationSec: number): { fadeInSec: number; fadeOutSec: number } {
  const parse = (value: unknown, field: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_FADE_SEC) {
      throw new AudioRangeError('INVALID_FADE',
        `${field} must be between 0 and ${MAX_FADE_SEC} seconds`);
    }
    return round(parsed);
  };
  const fadeIn = parse(fadeInSec, 'fadeInSec');
  const fadeOut = parse(fadeOutSec, 'fadeOutSec');
  if (fadeIn + fadeOut > durationSec + 1e-6) {
    throw new AudioRangeError('INVALID_FADE',
      'The fade in and fade out together are longer than this clip');
  }
  return { fadeInSec: fadeIn, fadeOutSec: fadeOut };
}

/**
 * Validates a source trim for an AUDIO element.
 *
 * The uploaded file is never modified: a trim is a read window over it, exactly
 * as a VIDEO element's trim is a window over the source video. The window must
 * fit the asset, and its length is what the clip occupies on the timeline.
 */
export function validateAudioTrim(trimStartValue: unknown, trimEndValue: unknown,
  assetDurationSec: number | null): { trimStart: number; trimEnd: number } {
  const trimStart = Number(trimStartValue);
  const trimEnd = Number(trimEndValue);
  if (!Number.isFinite(trimStart) || trimStart < 0) {
    throw new AudioRangeError('INVALID_AUDIO_TRIM', 'trimStart must be zero or more');
  }
  if (!Number.isFinite(trimEnd) || trimEnd <= trimStart) {
    throw new AudioRangeError('INVALID_AUDIO_TRIM', 'trimEnd must be after trimStart');
  }
  if (assetDurationSec != null && assetDurationSec > 0 && trimEnd > assetDurationSec + 1e-3) {
    throw new AudioRangeError('INVALID_AUDIO_TRIM',
      `This audio file is ${assetDurationSec.toFixed(2)}s long, so the trim cannot end at ` +
      `${trimEnd.toFixed(2)}s`);
  }
  return { trimStart: round(trimStart), trimEnd: round(trimEnd) };
}

export function validateDuckStrength(value: unknown): DuckStrengthId {
  if (typeof value !== 'string' || !(value in DUCK_STRENGTHS)) {
    throw new AudioRangeError('INVALID_DUCK_STRENGTH',
      `duckStrength must be one of ${DUCK_STRENGTH_IDS.join(', ')}`);
  }
  return value as DuckStrengthId;
}

export function validateDuckTiming(attackValue: unknown, releaseValue: unknown) {
  const parse = (value: unknown, field: string, fallback: number) => {
    if (value === undefined || value === null) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < MIN_DUCK_MS || parsed > MAX_DUCK_MS) {
      throw new AudioRangeError('INVALID_DUCK_TIMING',
        `${field} must be between ${MIN_DUCK_MS} and ${MAX_DUCK_MS} milliseconds`);
    }
    return Math.round(parsed);
  };
  return { attackMs: parse(attackValue, 'attackMs', DEFAULT_ATTACK_MS),
    releaseMs: parse(releaseValue, 'releaseMs', DEFAULT_RELEASE_MS) };
}

// --- Speech windows ---------------------------------------------------------

export type SpeechWindow = { startSec: number; endSec: number };

/** Merges overlapping and near-adjacent windows, then keeps merging the closest
 * remaining pair until the count fits the render expression's budget. Merging is
 * always conservative: a merged window covers everything both covered, so no
 * moment of speech ever stops being treated as speech. */
export function mergeSpeechWindows(windows: SpeechWindow[],
  gapSec = SPEECH_GAP_MERGE_SEC, limit = MAX_SPEECH_WINDOWS): SpeechWindow[] {
  const sorted = windows.filter((window) => window.endSec > window.startSec)
    .sort((left, right) => left.startSec - right.startSec);
  const merged: SpeechWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startSec - last.endSec <= gapSec) {
      last.endSec = Math.max(last.endSec, window.endSec);
      continue;
    }
    merged.push({ startSec: window.startSec, endSec: window.endSec });
  }
  while (merged.length > limit) {
    let index = 0;
    let smallest = Infinity;
    for (let i = 1; i < merged.length; i += 1) {
      const gap = merged[i].startSec - merged[i - 1].endSec;
      if (gap < smallest) { smallest = gap; index = i; }
    }
    merged[index - 1].endSec = Math.max(merged[index - 1].endSec, merged[index].endSec);
    merged.splice(index, 1);
  }
  return merged.map((window) => ({ startSec: round(window.startSec),
    endSec: round(window.endSec) }));
}

/**
 * Derives speech windows on the EXPORTED timeline from cached transcript words.
 *
 * The transcript is in SOURCE seconds and the timeline is a reordered, retimed,
 * possibly repeated selection of it, so every word is projected through the same
 * timeline map the captions and the camera use. A word in a deleted range
 * contributes nothing; a word in a range used twice contributes twice; a word in
 * a sped-up clip contributes a correspondingly shorter window.
 *
 * Nothing here transcribes, calls a service or invents timing. When the cached
 * transcript carries no word timings this returns an empty list, and ducking is
 * reported unavailable rather than faked.
 */
export function speechWindowsFromTranscript(words: TimedWord[], map: {
  segments: Array<{ sourceStart: number; sourceEnd: number; timelineStart: number;
    timelineEnd: number; speed: number }>;
}): SpeechWindow[] {
  const windows: SpeechWindow[] = [];
  for (const word of words) {
    if (!(word.end > word.start)) continue;
    for (const segment of map.segments) {
      const start = Math.max(word.start, segment.sourceStart);
      const end = Math.min(word.end, segment.sourceEnd);
      if (!(end > start)) continue;
      const speed = segment.speed > 0 ? segment.speed : 1;
      windows.push({
        startSec: segment.timelineStart + (start - segment.sourceStart) / speed,
        endSec: Math.min(segment.timelineEnd,
          segment.timelineStart + (end - segment.sourceStart) / speed)
      });
    }
  }
  return mergeSpeechWindows(windows);
}

/**
 * The FFmpeg volume expression that ducks one track under speech.
 *
 * Each window becomes a TRAPEZOID: zero outside [start - attack, end + release],
 * one across the speech itself, and a linear ramp between - so the music dips
 * before the first syllable and recovers after the last rather than snapping.
 * The coverage of the loudest overlapping window wins (`max`), and the gain is
 * then interpolated between 1 and the duck gain by that coverage.
 *
 * This is real, deterministic automation over known speech timings, not a
 * compressor guessing from a sidechain, which is what makes it reproducible and
 * measurable: `verify-edit-mode-color-audio.cjs` proves the level drops inside a
 * known window and returns outside it.
 */
export function duckVolumeExpression(windows: SpeechWindow[], duckGain: number,
  attackMs: number, releaseMs: number): string {
  if (!windows.length) return '';
  const attack = Math.max(MIN_DUCK_MS, attackMs) / 1000;
  const release = Math.max(MIN_DUCK_MS, releaseMs) / 1000;
  const fixed = (value: number) => Number(value.toFixed(3)).toString();
  const ramps = windows.map((window) =>
    `clip((t-${fixed(window.startSec - attack)})/${fixed(attack)},0,1)*` +
    `clip((${fixed(window.endSec + release)}-t)/${fixed(release)},0,1)`);
  const coverage = ramps.reduce((accumulated, ramp) =>
    accumulated ? `max(${accumulated},${ramp})` : ramp, '');
  return `1-${fixed(1 - Math.max(0, Math.min(1, duckGain)))}*(${coverage})`;
}
