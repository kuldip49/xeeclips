// EditMode caption generation, splitting and merging.
//
// Pure and deterministic. Given the transcript already cached on the source
// asset and the canonical VIDEO track, this module says exactly which caption
// lines exist, what they say and when. It runs no LLM, re-transcribes nothing,
// and never invents a word: every caption's text is a contiguous run of
// transcript words, and every caption's timing comes from those words' own
// timings projected onto the edited timeline.
//
// The frozen auto pipeline's caption path (src/modules/editing/*) is untouched.
// The one thing borrowed from it is `buildSubtitlePhrases`, the deterministic
// phrase grouper, called as a pure function with EditMode's own parameters.

import { buildSubtitlePhrases } from '../editing/subtitle-phrases';
import { sanitizeSubtitleText } from '../editing/subtitle-text';
import type { TimedWord } from '../editing/edit-plan';
import type { TimelineMap } from './render/edit-mode-timeline-map';
import { MAX_CAPTION_LENGTH, type CaptionWord } from './edit-mode-text';

/** A caption shorter than this would flash on screen, so generation holds it. */
export const MIN_CAPTION_SEC = 0.35;
/** Words per caption line the grouper starts at, and the ceiling it will grow
 *  to when the caption count has to come down under the safety limit. */
export const DEFAULT_WORDS_PER_CAPTION = 5;
export const MAX_WORDS_PER_CAPTION = 14;

const round = (value: number) => Number(value.toFixed(6));

export type CaptionSpec = {
  content: string;
  /** Timeline seconds. */
  startTime: number;
  duration: number;
  /** Word timings RELATIVE to startTime. Empty when the transcript had none. */
  words: CaptionWord[];
};

export type CaptionGenerationResult = {
  captions: CaptionSpec[];
  /** True when the transcript carried real per-word timings. */
  wordTimings: boolean;
  /** The grouping actually used, after any widening to fit under the limit. */
  wordsPerCaption: number;
  /** Set when grouping had to be widened, so the UI can say why. */
  grouped: boolean;
  warnings: string[];
};

export class CaptionGenerationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CaptionGenerationError';
  }
}

/**
 * Projects one phrase onto the edited timeline.
 *
 * A phrase can survive zero times (its words were cut), once, or more than once
 * (its source range was reused). A caption never outlives the segment its words
 * were spoken in: a phrase straddling a cut is held to the end of its own
 * segment rather than carried over footage the viewer no longer hears it in.
 */
function placePhrase(map: TimelineMap, start: number, end: number) {
  const placements: Array<{ startTime: number; duration: number; sourceStart: number;
    speed: number }> = [];
  for (const timelineStart of map.toTimeline(start)) {
    const segment = map.segments.find((item) => timelineStart >= item.timelineStart - 1e-6 &&
      timelineStart < item.timelineEnd);
    const speed = segment?.speed ?? 1;
    const naturalEnd = timelineStart + Math.max(MIN_CAPTION_SEC, (end - start) / speed);
    const limit = segment?.timelineEnd ?? map.durationSec;
    const timelineEnd = Math.min(limit, naturalEnd);
    if (!(timelineEnd > timelineStart)) continue;
    placements.push({ startTime: round(timelineStart),
      duration: round(timelineEnd - timelineStart),
      sourceStart: start, speed });
  }
  return placements;
}

/**
 * Builds caption lines from the cached transcript.
 *
 * `limit` is the timeline's caption ceiling. When the natural 5-word grouping
 * would exceed it, the grouping is widened deterministically (6, 7, ... words
 * per line) until the count fits — the same transcript always produces the same
 * captions. Widening is preferred to truncation because dropping caption lines
 * would silently lose transcript the user can see in the video.
 */
export function generateCaptions(input: {
  words: TimedWord[];
  wordTimings: boolean;
  map: TimelineMap;
  limit: number;
  /** Optional deterministic starting width. Automatic-plan reconstruction uses
   * the persisted maxWordsPerLine; ordinary EditMode generation keeps 5. */
  wordsPerCaption?: number;
}): CaptionGenerationResult {
  const warnings: string[] = [];
  const usable = input.words.filter((word) => Number.isFinite(word.start) &&
    Number.isFinite(word.end) && word.end > word.start && word.text.trim());
  if (!usable.length) {
    throw new CaptionGenerationError('NO_TRANSCRIPT',
      'This source has no cached transcript with usable timings. Run "Analyze source" first.');
  }

  let wordsPerCaption = Number.isInteger(input.wordsPerCaption)
    ? Math.max(1, Math.min(MAX_WORDS_PER_CAPTION, input.wordsPerCaption!))
    : DEFAULT_WORDS_PER_CAPTION;
  let captions = build(usable, input.map, wordsPerCaption);
  while (captions.length > input.limit && wordsPerCaption < MAX_WORDS_PER_CAPTION) {
    wordsPerCaption += 1;
    captions = build(usable, input.map, wordsPerCaption);
  }
  if (captions.length > input.limit) {
    throw new CaptionGenerationError('TOO_MANY_SUBTITLES',
      `This transcript produces ${captions.length} caption lines, more than the ${input.limit} ` +
      'this timeline can hold even at the widest grouping. Use a shorter source.');
  }
  const grouped = wordsPerCaption !== DEFAULT_WORDS_PER_CAPTION;
  if (grouped) {
    warnings.push(`Captions were grouped ${wordsPerCaption} words to a line to stay under the ` +
      `${input.limit}-caption limit. The wording and timings are still transcript-exact.`);
  }
  if (!input.wordTimings) {
    warnings.push('The cached transcript has only phrase-level timings, so captions use those ' +
      'timings exactly and the active-word highlight is unavailable.');
  }
  return { captions, wordTimings: input.wordTimings, wordsPerCaption, grouped, warnings };
}

function build(words: TimedWord[], map: TimelineMap, maxWords: number): CaptionSpec[] {
  const captions: CaptionSpec[] = [];
  for (const phrase of buildSubtitlePhrases(words, maxWords)) {
    const text = sanitizeSubtitleText(phrase.words.map((word) => word.text).join(' '))
      .slice(0, MAX_CAPTION_LENGTH);
    if (!text) continue;
    for (const placement of placePhrase(map, phrase.start, phrase.end)) {
      captions.push({
        content: text,
        startTime: placement.startTime,
        duration: placement.duration,
        // Word timings are rebased onto the caption and divided by the segment's
        // playback rate, so a sped-up clip highlights the word actually heard.
        words: phrase.words.map((word) => ({
          start: round(Math.max(0, (word.start - placement.sourceStart) / placement.speed)),
          end: round(Math.max(0, (word.end - placement.sourceStart) / placement.speed)),
          text: word.text
        })).filter((word) => word.end > word.start)
      });
    }
  }
  return captions.sort((left, right) => left.startTime - right.startTime);
}

// --- Split -------------------------------------------------------------------

export type CaptionSplit = {
  left: { content: string; startTime: number; duration: number; words: CaptionWord[] };
  right: { content: string; startTime: number; duration: number; words: CaptionWord[] };
};

/**
 * Splits one caption at a timeline instant.
 *
 * The text is divided, never duplicated: the two halves concatenate back to the
 * original wording. The cut point is chosen on a WORD boundary — the stored word
 * timings when the caption has them, otherwise the proportional position rounded
 * to the nearest space — because splitting mid-word would produce a caption the
 * transcript never said.
 *
 * The two spans are contiguous and non-overlapping by construction.
 */
export function splitCaption(input: {
  content: string; startTime: number; duration: number; words: CaptionWord[];
  atSec: number;
}): CaptionSplit {
  const offset = round(input.atSec - input.startTime);
  if (!(offset > MIN_CAPTION_SEC / 2) || !(offset < input.duration - MIN_CAPTION_SEC / 2)) {
    throw new CaptionGenerationError('SPLIT_OUT_OF_RANGE',
      'Move the playhead further inside this caption before splitting it.');
  }
  const tokens = input.content.split(/\s+/u).filter(Boolean);
  if (tokens.length < 2) {
    throw new CaptionGenerationError('CAPTION_TOO_SHORT',
      'A caption of one word cannot be split.');
  }

  // Where the words stop belonging to the first half.
  let index: number;
  if (input.words.length >= 2 && input.words.length === tokens.length) {
    index = input.words.filter((word) => word.start < offset - 1e-6).length;
  } else {
    index = Math.round((offset / input.duration) * tokens.length);
  }
  index = Math.max(1, Math.min(tokens.length - 1, index));

  const leftWords = input.words.slice(0, index);
  const rightWords = input.words.slice(index);
  // The split instant is the playhead, unless real word timings put a cleaner
  // boundary in the gap between the two words - then the gap is used, so neither
  // half clips a word that is still being spoken.
  const boundary = leftWords.length && rightWords.length
    ? Math.min(Math.max(offset, leftWords[leftWords.length - 1].end), rightWords[0].start)
    : offset;
  const cut = round(Math.max(MIN_CAPTION_SEC / 2,
    Math.min(input.duration - MIN_CAPTION_SEC / 2, boundary)));

  return {
    left: { content: tokens.slice(0, index).join(' '), startTime: round(input.startTime),
      duration: cut,
      words: leftWords.map((word) => ({ ...word, end: Math.min(word.end, cut) })) },
    right: { content: tokens.slice(index).join(' '),
      startTime: round(input.startTime + cut), duration: round(input.duration - cut),
      words: rightWords.map((word) => ({ ...word,
        start: round(Math.max(0, word.start - cut)), end: round(Math.max(0, word.end - cut)) })) }
  };
}

// --- Merge -------------------------------------------------------------------

/** Two captions may merge when they sit within this gap of each other. */
export const MAX_MERGE_GAP_SEC = 2;

export type CaptionMerge = { content: string; startTime: number; duration: number;
  words: CaptionWord[] };

/**
 * Merges two adjacent captions into one.
 *
 * `selected` supplies the STYLE of the result (documented, and what the editor
 * relies on: merging into the caption you have open keeps the look you are
 * editing). The text is the two contents in TIMELINE order, joined by one space;
 * the span is the union of the two spans.
 */
export function mergeCaptions(selected: { content: string; startTime: number; duration: number;
  words: CaptionWord[] }, other: { content: string; startTime: number; duration: number;
  words: CaptionWord[] }): CaptionMerge {
  const [first, second] = selected.startTime <= other.startTime
    ? [selected, other] : [other, selected];
  const gap = second.startTime - (first.startTime + first.duration);
  if (gap > MAX_MERGE_GAP_SEC + 1e-6) {
    throw new CaptionGenerationError('CAPTIONS_NOT_ADJACENT',
      `These captions are ${gap.toFixed(1)}s apart, further than the ${MAX_MERGE_GAP_SEC}s ` +
      'merge limit.');
  }
  const startTime = round(first.startTime);
  const endTime = round(Math.max(first.startTime + first.duration,
    second.startTime + second.duration));
  const content = `${first.content.trim()} ${second.content.trim()}`.trim()
    .slice(0, MAX_CAPTION_LENGTH);
  // Word timings are rebased onto the merged caption. If either side lacked
  // them the merged caption carries none, rather than a half-populated list
  // that would highlight some words and skip others.
  const words = first.words.length && second.words.length
    ? [...first.words.map((word) => ({ ...word,
      start: round(first.startTime + word.start - startTime),
      end: round(first.startTime + word.end - startTime) })),
    ...second.words.map((word) => ({ ...word,
      start: round(second.startTime + word.start - startTime),
      end: round(second.startTime + word.end - startTime) }))]
      .sort((left, right) => left.start - right.start)
    : [];
  return { content, startTime, duration: round(endTime - startTime), words };
}

/** The caption adjacent to `target` in the given direction, on the same track. */
export function adjacentCaption<T extends { id: string; type: string; track: number;
  startTime: number; duration: number }>(elements: T[], target: T,
  direction: 'PREVIOUS' | 'NEXT'): T | undefined {
  const captions = elements
    .filter((element) => element.type === 'SUBTITLE' && element.track === target.track)
    .sort((left, right) => left.startTime - right.startTime ||
      left.id.localeCompare(right.id));
  const index = captions.findIndex((element) => element.id === target.id);
  if (index < 0) return undefined;
  return direction === 'PREVIOUS' ? captions[index - 1] : captions[index + 1];
}

/** The active word at one instant inside a caption, or -1. Shared by the preview
 * and the ASS builder so both highlight exactly the same word. */
export function activeWordIndex(words: CaptionWord[], offsetSec: number): number {
  for (let index = 0; index < words.length; index++) {
    if (offsetSec >= words[index].start - 1e-6 && offsetSec < words[index].end - 1e-6) {
      return index;
    }
  }
  return -1;
}
