import type { TimedWord } from './edit-plan';

export type SubtitlePhrase = { words: TimedWord[]; start: number; end: number;
  lines: string[]; lineBreakIndex: number | null };
const units = new Set(['%', 'percent', 'seconds', 'minutes', 'hours', 'days', 'years',
  'dollars', 'rupees', 'million', 'billion', 'kg', 'km', 'mph']);
const modifiers = new Set(['most', 'more', 'very', 'really', 'strong', 'major', 'important',
  'big', 'small', 'new', 'key', 'main', 'best', 'first', 'last']);
const clean = (text: string) => text.replace(/[^\p{L}\p{N}%]/gu, '').toLowerCase();
const protectedPair = (left: string, right: string) => {
  const a = clean(left); const b = clean(right);
  return (/\d/u.test(a) && units.has(b)) || modifiers.has(a) ||
    (/^[A-Z]/u.test(left) && /^[A-Z]/u.test(right) && a.length > 1 && b.length > 1);
};

export function buildSubtitlePhrases(input: TimedWord[], maxWords = 5): SubtitlePhrase[] {
  const words = input.filter((word) => Number.isFinite(word.start) &&
    Number.isFinite(word.end) && word.end > word.start && word.text.trim())
    .sort((a, b) => a.start - b.start);
  const phrases: TimedWord[][] = [];
  let current: TimedWord[] = [];
  const flush = () => { if (current.length) phrases.push(current); current = []; };
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const previous = current[current.length - 1];
    const gap = previous ? word.start - previous.end : 0;
    const punctuation = previous && /[.!?;:]$/u.test(previous.text);
    if (current.length && (gap > .48 || (punctuation && current.length >= 2) ||
      (current.length >= maxWords && !protectedPair(previous.text, word.text)) ||
      current.length >= maxWords + 1)) flush();
    current.push(word);
  }
  flush();
  // Avoid one-word flashes when the neighboring phrase has room and no long pause.
  for (let index = 0; index < phrases.length - 1; index++) {
    if (phrases[index].length === 1 && phrases[index + 1].length < maxWords &&
      phrases[index + 1][0].start - phrases[index][0].end < .32) {
      phrases[index + 1].unshift(...phrases[index]); phrases.splice(index, 1); index--;
    }
  }
  return phrases.map((group) => {
    const texts = group.map((word) => word.text);
    let lines = [texts.join(' ')];
    let lineBreakIndex: number | null = null;
    if (lines[0].length > 20 && texts.length >= 3) {
      let split = Math.ceil(texts.length / 2);
      if (protectedPair(texts[split - 1], texts[split])) split = Math.min(texts.length - 1, split + 1);
      lines = [texts.slice(0, split).join(' '), texts.slice(split).join(' ')];
      lineBreakIndex = split;
    }
    return { words: group, start: group[0].start, end: group[group.length - 1].end,
      lines, lineBreakIndex };
  });
}
