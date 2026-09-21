import { MIN_CLIP_DURATION_SECONDS } from './clip-candidates';

export type TranscriptWord = { start: number; end: number; text: string };

export type BoundaryOptimizationResult = {
  startTime: number;
  endTime: number;
  transcriptText: string;
  openingStrength: number;
  endingStrength: number;
  leadingTrimmedMs: number;
  trailingWasteMs: number;
};

// Deliberately narrow: filler openers only. A broader stop-word list would risk trimming
// into the actual first thought of the clip.
const FILLER_OPENERS = new Set(['so', 'well', 'um', 'uh', 'umm', 'uhh', 'okay', 'ok',
  'right', 'and', 'but', 'like', 'anyway', 'basically', 'actually', 'now']);
const MAX_LEADING_TRIM_WORDS = 4;
const MAX_LEADING_TRIM_SECONDS = 3;
const MAX_TRAILING_SILENCE_SECONDS = 1.5;
const NATURAL_TAIL_SECONDS = 0.25;

const clean = (text: string) => text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  .toLocaleLowerCase('en-US');
const endsNaturally = (text: string) => /[.!?]["'’”]?$/u.test(text.trim());
const startsStrong = (text: string) =>
  /^(did you|here is|here's|how|imagine|the (?:biggest|real|secret)|what|why|you (?:can|need|will|won't))/iu
    .test(text.trim());
const startsWithFragment = (text: string) =>
  /^(and|but|because|he|it|she|so|that|then|they|this|which)\b/iu.test(text.trim());

function wordsInRange(words: TranscriptWord[], start: number, end: number) {
  return words.filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) &&
    word.end > word.start && word.start >= start - 0.001 && word.end <= end + 0.001)
    .sort((left, right) => left.start - right.start);
}

/**
 * Trims a candidate window to exact word boundaries: drops a leading filler run and
 * trailing dead air while never moving outside the original window, never cutting a word
 * in half, and never shrinking below MIN_CLIP_DURATION_SECONDS. Pure and deterministic —
 * it never invents or rewrites speech, only selects a tighter subrange of what was said.
 */
export function optimizeClipBoundaries(
  candidate: { startTime: number; endTime: number; transcriptText: string },
  allWords: TranscriptWord[]
): BoundaryOptimizationResult {
  const originalText = candidate.transcriptText;
  const inRange = wordsInRange(allWords, candidate.startTime, candidate.endTime);
  if (!inRange.length) {
    return {
      startTime: candidate.startTime, endTime: candidate.endTime, transcriptText: originalText,
      openingStrength: openingStrengthFromText(originalText),
      endingStrength: endingStrengthFromText(originalText, 0),
      leadingTrimmedMs: 0, trailingWasteMs: 0
    };
  }

  let startIndex = 0;
  let trimmedLeadingSeconds = 0;
  while (startIndex < inRange.length - 1 && startIndex < MAX_LEADING_TRIM_WORDS) {
    const word = inRange[startIndex];
    const wouldTrim = word.end - candidate.startTime;
    const remainingDuration = candidate.endTime - word.end;
    if (!FILLER_OPENERS.has(clean(word.text)) || wouldTrim > MAX_LEADING_TRIM_SECONDS ||
      remainingDuration < MIN_CLIP_DURATION_SECONDS) break;
    trimmedLeadingSeconds = wouldTrim;
    startIndex += 1;
  }

  const lastWord = inRange[inRange.length - 1];
  const silenceTail = Math.max(0, candidate.endTime - lastWord.end);
  const canTrimTail = silenceTail > MAX_TRAILING_SILENCE_SECONDS &&
    lastWord.end + NATURAL_TAIL_SECONDS - inRange[startIndex].start >= MIN_CLIP_DURATION_SECONDS;
  const startTime = startIndex > 0 ? inRange[startIndex].start : candidate.startTime;
  const endTime = canTrimTail
    ? Math.min(candidate.endTime, lastWord.end + NATURAL_TAIL_SECONDS)
    : candidate.endTime;
  const keptWords = inRange.slice(startIndex).filter((word) => word.start < endTime + 0.001);
  const transcriptText = keptWords.length
    ? keptWords.map((word) => word.text.trim()).join(' ').replace(/\s+/gu, ' ').trim()
    : originalText;

  return {
    startTime, endTime,
    transcriptText: transcriptText || originalText,
    openingStrength: openingStrengthFromText(transcriptText || originalText),
    endingStrength: endingStrengthFromText(transcriptText || originalText,
      canTrimTail ? 0 : silenceTail),
    leadingTrimmedMs: Math.round(trimmedLeadingSeconds * 1000),
    trailingWasteMs: canTrimTail ? Math.round((silenceTail - NATURAL_TAIL_SECONDS) * 1000) : 0
  };
}

function openingStrengthFromText(text: string) {
  const first = text.match(/[^.!?]+[.!?]?/u)?.[0] ?? text;
  let score = 55;
  if (startsWithFragment(first)) score -= 30;
  if (startsStrong(first)) score += 30;
  if (/^[a-z]/u.test(first.trim())) score -= 5;
  return Math.max(0, Math.min(100, score));
}

function endingStrengthFromText(text: string, remainingSilenceSeconds: number) {
  let score = endsNaturally(text) ? 75 : 40;
  score -= Math.min(30, remainingSilenceSeconds * 12);
  return Math.max(0, Math.min(100, Math.round(score)));
}
