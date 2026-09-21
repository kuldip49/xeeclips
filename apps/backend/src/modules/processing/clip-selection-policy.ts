import { BadRequestException } from '@nestjs/common';
import { semanticSimilarity } from './semantic-similarity.service';

// Product-level contract for the simplified "tell us how many clips" workflow. Everything here is
// pure and deterministic so the same analyzed video always yields the same ordered selection.

export const MAX_SOURCE_VIDEO_DURATION_SECONDS = 7200;
export const FINAL_CLIP_MIN_SECONDS = 15;
export const FINAL_CLIP_MAX_SECONDS = 120;
export const VIDEO_TOO_LONG_MESSAGE =
  'This video is longer than the 2-hour limit. Please upload a video shorter than 2 hours.';

export type TargetPlatform = 'INSTAGRAM_REELS' | 'YOUTUBE_SHORTS' | 'TIKTOK';
export type OutputStyle = 'NORMAL' | 'AI_EDITED';
export type UserAiModeLabel = 'Online' | 'Local' | 'Fallback';

export const TARGET_PLATFORMS: readonly TargetPlatform[] =
  ['INSTAGRAM_REELS', 'YOUTUBE_SHORTS', 'TIKTOK'];

export function parseTargetPlatform(value: unknown): TargetPlatform | null {
  if (value == null || value === '') return null;
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if ((TARGET_PLATFORMS as readonly string[]).includes(normalized)) return normalized as TargetPlatform;
  throw new BadRequestException('targetPlatform must be INSTAGRAM_REELS, YOUTUBE_SHORTS, or TIKTOK');
}

export function parseOutputStyle(value: unknown): OutputStyle {
  // NORMAL_CLIPS / EDITED_CLIPS stay accepted for older clients.
  if (value === 'NORMAL' || value === 'NORMAL_CLIPS') return 'NORMAL';
  if (value === 'AI_EDITED' || value === 'EDITED_CLIPS') return 'AI_EDITED';
  throw new BadRequestException('outputStyle must be NORMAL or AI_EDITED');
}

export const processingTypeForOutputStyle = (style: OutputStyle) =>
  style === 'AI_EDITED' ? 'EDITED_CLIPS' as const : 'NORMAL_CLIPS' as const;

export function isVideoTooLong(durationSeconds: number | null | undefined) {
  return typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) &&
    durationSeconds > MAX_SOURCE_VIDEO_DURATION_SECONDS;
}

/** Returns 0 for a source longer than the 2-hour limit (such a video is rejected). */
export function maxClipCountForDuration(durationSeconds: number | null | undefined) {
  const duration = typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds) : 0;
  if (duration <= 600) return 6;
  if (duration < 900) return 8;
  if (duration <= 3600) return 12;
  if (duration <= MAX_SOURCE_VIDEO_DURATION_SECONDS) return 20;
  return 0;
}

/** Convenience starting value for the counter; never presented as a recommendation. */
export function defaultClipCountForMax(maxClipCount: number) {
  if (maxClipCount <= 0) return 0;
  if (maxClipCount <= 6) return Math.min(3, maxClipCount);
  if (maxClipCount <= 8) return 4;
  if (maxClipCount <= 12) return 6;
  return 8;
}

export function validateRequestedClipCount(value: unknown, maxClipCount: number) {
  const count = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1)
    throw new BadRequestException('requestedClipCount must be a whole number of at least 1');
  if (count > maxClipCount)
    throw new BadRequestException(`This video allows at most ${maxClipCount} clips`);
  return count;
}

/**
 * User-facing label for the processing job's authoritative effectiveAiMode. Component-level
 * deterministic fallback inside an ONLINE or local job stays in telemetry and does not change it.
 */
export function userAiModeLabel(effectiveAiMode: unknown): UserAiModeLabel {
  const mode = String(effectiveAiMode ?? '').toUpperCase();
  if (mode === 'ONLINE') return 'Online';
  if (mode === 'OFFLINE' || mode === 'LOCAL_LLM' || mode === 'LOCAL') return 'Local';
  return 'Fallback';
}

export type ClipProcessingType = ReturnType<typeof processingTypeForOutputStyle>;

/** Distinguishes rendered files of one source range: output style and target platform. */
export const clipVariantKey = (processingType: ClipProcessingType,
  targetPlatform: TargetPlatform | null | undefined) =>
  `${processingType}:${targetPlatform ?? 'DEFAULT'}`;

export const NORMAL_CLIP_WIDTH = 1080;
export const NORMAL_CLIP_HEIGHT = 1920;

/**
 * An already rendered variant is reused instead of rendered again. Normal clips from before the
 * fixed 9:16 canvas (source-aspect renders) are not a valid variant and get replaced.
 */
export function isReusableClipVariant(clip: { processingType: string; aspectRatio: string;
  width: number; height: number }) {
  if (clip.processingType === 'EDITED_CLIPS') return true;
  return clip.aspectRatio === '9:16' && clip.width === NORMAL_CLIP_WIDTH &&
    clip.height === NORMAL_CLIP_HEIGHT;
}

export type SelectableCandidate = {
  id?: string;
  startTime: number;
  endTime: number;
  transcriptText: string;
  contentPotential: number;
  rank: number | null;
  reject: boolean;
};

export type UsabilityVerdict = { usable: true } | { usable: false; reason: string };

const FILLER = new Set(['uh', 'um', 'erm', 'hmm', 'like', 'yeah', 'okay', 'ok', 'so', 'well',
  'right', 'you', 'know', 'basically', 'actually', 'literally']);
const tokens = (text: string) =>
  text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];

/**
 * Hard usability gate. Independent of quality tier: a candidate below the historical
 * PRIMARY/SECONDARY thresholds is still deliverable when it passes here. Scoring-based
 * `reject` (incomplete excerpt, filler-heavy, duplicate range, no standalone value) is honored.
 */
export function evaluateCandidateUsability(candidate: SelectableCandidate,
  videoDurationSeconds?: number | null): UsabilityVerdict {
  const { startTime, endTime } = candidate;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime)
    return { usable: false, reason: 'INVALID_TIMESTAMP_RANGE' };
  if (typeof videoDurationSeconds === 'number' && Number.isFinite(videoDurationSeconds) &&
    endTime > videoDurationSeconds + 0.5)
    return { usable: false, reason: 'OUTSIDE_SOURCE_DURATION' };
  const duration = endTime - startTime;
  if (duration < FINAL_CLIP_MIN_SECONDS - 0.001) return { usable: false, reason: 'TOO_SHORT' };
  if (duration > FINAL_CLIP_MAX_SECONDS + 0.001) return { usable: false, reason: 'TOO_LONG' };
  if (candidate.reject) return { usable: false, reason: 'REJECTED_BY_ANALYSIS' };
  if (candidate.rank == null) return { usable: false, reason: 'NOT_RANKED_OR_DUPLICATE' };
  const words = tokens(candidate.transcriptText ?? '');
  if (words.length < 20) return { usable: false, reason: 'SEVERE_TRANSCRIPT_FRAGMENTATION' };
  // Speech far too sparse for the range means unusable audio or mostly silence.
  if (words.length / duration < 0.6) return { usable: false, reason: 'INSUFFICIENT_SPEECH' };
  const meaningful = words.filter((word) => !FILLER.has(word)).length;
  if (meaningful / words.length < 0.55) return { usable: false, reason: 'MEANINGLESS_FILLER' };
  return { usable: true };
}

const overlapRatio = (a: SelectableCandidate, b: SelectableCandidate) => {
  const intersection = Math.max(0, Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime));
  return intersection / Math.max(0.001, Math.min(a.endTime - a.startTime, b.endTime - b.startTime));
};

export const SELECTION_MAX_OVERLAP = 0.4;
export const SELECTION_MAX_TEXT_SIMILARITY = 0.78;

export function isDuplicateOfAny(candidate: SelectableCandidate, selected: SelectableCandidate[]) {
  return selected.some((other) => overlapRatio(candidate, other) > SELECTION_MAX_OVERLAP ||
    semanticSimilarity.similarity(candidate.transcriptText, other.transcriptText) >
      SELECTION_MAX_TEXT_SIMILARITY);
}

/** Strongest first with deterministic tie-breaks; scores are used exactly as stored. */
export function compareCandidateStrength(a: SelectableCandidate, b: SelectableCandidate) {
  return b.contentPotential - a.contentPotential ||
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
    a.startTime - b.startTime || a.endTime - b.endTime;
}

/**
 * The canonical ordered list of distinct, usable moments. Selecting N clips is always the
 * first N entries, so asking for 10 after 5 keeps the original five in place.
 */
export function rankUsableCandidates<T extends SelectableCandidate>(candidates: T[],
  videoDurationSeconds?: number | null) {
  const ordered: T[] = [];
  const rejected: Array<{ candidate: T; reason: string }> = [];
  for (const candidate of [...candidates].sort(compareCandidateStrength)) {
    const verdict = evaluateCandidateUsability(candidate, videoDurationSeconds);
    if (!verdict.usable) { rejected.push({ candidate, reason: verdict.reason }); continue; }
    if (isDuplicateOfAny(candidate, ordered)) {
      rejected.push({ candidate, reason: 'DUPLICATE_OF_STRONGER_SELECTION' });
      continue;
    }
    ordered.push(candidate);
  }
  return { ordered, rejected };
}

export function selectBestClips<T extends SelectableCandidate>(candidates: T[],
  requestedClipCount: number, videoDurationSeconds?: number | null) {
  return rankUsableCandidates(candidates, videoDurationSeconds).ordered.slice(0,
    Math.max(0, requestedClipCount));
}

export function qualityBand(contentPotential: number) {
  return contentPotential >= 75 ? 'high' as const : contentPotential >= 60 ? 'medium' as const
    : 'fallbackUsable' as const;
}
