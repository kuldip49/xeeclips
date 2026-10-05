// Step 16: semantic clip boundaries from the transcript.
//
//   "start when he says 'this is the real problem'"  -> START at that phrase
//   "include the previous sentence"                    -> START one sentence earlier
//   "ending feels cut off"                             -> END at the end of the sentence
//   "end after the next sentence"                      -> END one sentence later
//
// Pure: it reads the word-timed transcript of the ORIGINAL source (source
// seconds) around the clip's current range and returns a source second. The
// tool decides how to apply it safely (outer range for a simple clip, first/
// last segment trim for a multi-cut edit - never restoring removed intervals).

import type { TimedWord } from '../../editing/edit-plan';

export const BOUNDARY_ANCHORS = ['PHRASE', 'PREVIOUS_SENTENCE', 'NEXT_SENTENCE', 'COMPLETE_SENTENCE',
  'DROP_FIRST_SENTENCE', 'DROP_LAST_SENTENCE'] as const;
export type BoundaryAnchor = typeof BOUNDARY_ANCHORS[number];

type Sentence = { start: number; end: number; first: number; last: number };
const PAD_START = 0.08;
const PAD_END = 0.15;
const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '').trim();

/** Sentences from punctuation, with long pauses as boundaries when unpunctuated. */
export function sentences(words: TimedWord[]): Sentence[] {
  const out: Sentence[] = [];
  let first = 0;
  words.forEach((word, index) => {
    const next = words[index + 1];
    const punct = /[.?!]["')\]]?$/u.test(word.text.trim());
    const pause = next ? next.start - word.end > 0.9 : true;
    if (punct || pause || !next) {
      out.push({ start: words[first].start, end: word.end, first, last: index });
      first = index + 1;
    }
  });
  return out;
}

export function resolveSemanticBoundary(input: { words: TimedWord[]; clipStart: number;
  clipEnd: number; sourceDuration: number; edge: 'START' | 'END'; anchor: BoundaryAnchor;
  phrase?: string; windowSec?: number }): { sec: number; evidence: string } | { question: string } {
  const words = input.words.filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end))
    .sort((a, b) => a.start - b.start);
  if (!words.length) return { question: 'This source has no word-timed transcript, so I cannot find that moment. Give me a time instead.' };
  const window = input.windowSec ?? 90;
  const all = sentences(words);
  const clamp = (value: number) => Math.max(0, Math.min(input.sourceDuration, value));

  if (input.anchor === 'PHRASE') {
    const phrase = norm(input.phrase ?? '');
    const target = phrase.split(/\s+/u).filter(Boolean);
    if (!target.length) return { question: 'Which words should it start or end on?' };
    const hits: Array<{ start: number; end: number }> = [];
    for (let index = 0; index + target.length <= words.length; index += 1) {
      const slice = words.slice(index, index + target.length).map((word) => norm(word.text));
      if (slice.every((word, offset) => word === target[offset] ||
        (offset === target.length - 1 && word.startsWith(target[offset])))) {
        hits.push({ start: words[index].start, end: words[index + target.length - 1].end });
      }
    }
    const nearby = hits.filter((hit) => hit.start >= input.clipStart - window && hit.start <= input.clipEnd + window);
    if (!nearby.length) return { question: `I couldn't find "${input.phrase}" near this clip in the transcript.` };
    const anchor = input.edge === 'START' ? input.clipStart : input.clipEnd;
    const best = nearby.sort((a, b) => Math.abs(a.start - anchor) - Math.abs(b.start - anchor))[0];
    return input.edge === 'START'
      ? { sec: clamp(best.start - PAD_START), evidence: `"${input.phrase}" is said at ${best.start.toFixed(2)}s` }
      : { sec: clamp(best.end + PAD_END), evidence: `"${input.phrase}" ends at ${best.end.toFixed(2)}s` };
  }

  // The sentence the clip currently starts/ends in (or touches).
  const startIndex = all.findIndex((sentence) => sentence.end > input.clipStart + 0.05);
  const endIndexRaw = all.findIndex((sentence) => sentence.end >= input.clipEnd - 0.05);
  const endIndex = endIndexRaw === -1 ? all.length - 1 : endIndexRaw;
  if (input.anchor === 'PREVIOUS_SENTENCE') {
    const current = startIndex === -1 ? all.length - 1 : startIndex;
    // Mid-sentence start: the missing start of THAT sentence is what is wanted.
    // Clean sentence start: the whole sentence before it.
    const midSentence = all[current].start < input.clipStart - 0.15;
    const target = all[midSentence ? current : current - 1];
    if (!target) return { question: 'The clip already starts at the first sentence of the source.' };
    return { sec: clamp(target.start - PAD_START), evidence: `previous sentence starts at ${target.start.toFixed(2)}s` };
  }
  if (input.anchor === 'DROP_FIRST_SENTENCE') {
    const next = all[(startIndex === -1 ? 0 : startIndex) + 1];
    if (!next || next.start >= input.clipEnd - 1) return { question: 'The clip is too short to drop its first sentence.' };
    return { sec: clamp(next.start - PAD_START), evidence: `second sentence starts at ${next.start.toFixed(2)}s` };
  }
  if (input.anchor === 'COMPLETE_SENTENCE') {
    const sentence = all[endIndex];
    if (sentence.end <= input.clipEnd + 0.05) {
      return { question: 'The clip already ends at the end of a sentence. Should it include the next one?' };
    }
    return { sec: clamp(sentence.end + PAD_END), evidence: `the sentence finishes at ${sentence.end.toFixed(2)}s` };
  }
  if (input.anchor === 'NEXT_SENTENCE') {
    // Whether the clip ends on or inside sentence `endIndex`, "the next sentence"
    // is the one after it (so a mid-sentence end also completes its sentence).
    const target = all[endIndex + 1] ?? null;
    if (!target) return { question: 'There is no next sentence in the source.' };
    return { sec: clamp(target.end + PAD_END), evidence: `next sentence ends at ${target.end.toFixed(2)}s` };
  }
  // DROP_LAST_SENTENCE
  const previous = all[endIndex - 1];
  if (!previous || previous.end <= input.clipStart + 1) return { question: 'The clip is too short to drop its last sentence.' };
  return { sec: clamp(previous.end + PAD_END), evidence: `the previous sentence ends at ${previous.end.toFixed(2)}s` };
}

/** Natural phrasing -> a boundary request, or null. English + common variants. */
export function boundaryRequest(clause: string): { edge: 'START' | 'END'; anchor: BoundaryAnchor;
  phrase?: string } | null {
  const text = clause.toLowerCase().trim();
  const quoted = /["“'‘]([^"”'’]{2,120})["”'’]/u.exec(clause)?.[1];
  if (quoted && /\b(?:start|begin|open)\b/u.test(text) && /\b(?:says?|said|with|at|from|on)\b/u.test(text)) {
    return { edge: 'START', anchor: 'PHRASE', phrase: quoted };
  }
  if (quoted && /\b(?:end|stop|finish|cut)\b/u.test(text) && /\b(?:says?|said|after|at|on)\b/u.test(text)) {
    return { edge: 'END', anchor: 'PHRASE', phrase: quoted };
  }
  if (/\b(?:include|add|keep)\b.*\b(?:previous|prior|earlier) sentence\b|\bsentence before\b|\bstart (?:a|one) sentence earlier\b/u.test(text)) {
    return { edge: 'START', anchor: 'PREVIOUS_SENTENCE' };
  }
  if (/\b(?:ending|end)\b.*\b(?:cut off|feels cut|abrupt|chopped)\b|\bfinish the (?:last )?sentence\b|\bdon'?t cut (?:it )?off\b/u.test(text)) {
    return { edge: 'END', anchor: 'COMPLETE_SENTENCE' };
  }
  if (/\b(?:end|finish|stop)\b.*\bafter the next sentence\b|\binclude the next sentence\b|\bone (?:more|extra) sentence at the end\b/u.test(text)) {
    return { edge: 'END', anchor: 'NEXT_SENTENCE' };
  }
  if (/\b(?:drop|skip|remove|cut)\b.*\bfirst sentence\b|\bstart (?:a|one) sentence later\b/u.test(text)) {
    return { edge: 'START', anchor: 'DROP_FIRST_SENTENCE' };
  }
  if (/\b(?:drop|skip|remove|cut)\b.*\blast sentence\b|\bend (?:a|one) sentence earlier\b/u.test(text)) {
    return { edge: 'END', anchor: 'DROP_LAST_SENTENCE' };
  }
  return null;
}
