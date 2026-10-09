import type { Rect } from './platform-layout';

// Conservative advance widths for bold Noto Sans, in em. libass sizes fonts by
// line height (~1.36 em for Noto Sans), hence the 0.8 factor. The estimate only
// has to be safe; the renderer re-measures the real glyph bounds with libass.
const NARROW = new Set([...'iljtfrI!.,:;\'"|()[]']);
const WIDE = new Set([...'mwMW@%']);
export function estimateTextWidth(text: string, fontSize: number) {
  let em = 0;
  for (const char of text) {
    if (char === ' ') em += .27;
    else if (NARROW.has(char)) em += .34;
    else if (WIDE.has(char)) em += .92;
    else if (/[A-Z0-9]/u.test(char)) em += .68;
    else em += .6;
  }
  return em * fontSize * .8;
}

const LINE_END_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for',
  'and', 'or', 'but', 'with', 'by', 'from', 'as', 'is', 'his', 'her', 'their', 'its', 'my', 'your']);

// Balanced line breaking: minimize the widest line, prefer semantic breaks, and
// refuse the shapes that make a headline look accidental - a line ending on a
// function word, a one-word last line, or wildly uneven lines.
export function breakLines(words: string[], lineCount: number, fontSize: number): string[] {
  if (lineCount <= 1 || words.length <= 1) return [words.join(' ')];
  const count = Math.min(lineCount, words.length);
  let best: { lines: string[]; score: number } | null = null;
  const recurse = (from: number, remaining: number, acc: string[]) => {
    if (remaining === 1) {
      const lines = [...acc, words.slice(from).join(' ')];
      const widths = lines.map((line) => estimateTextWidth(line, fontSize));
      let penalty = lines.slice(0, -1).filter((line) =>
        LINE_END_STOPWORDS.has(line.split(' ').pop()!.toLowerCase())).length * fontSize * .6;
      // An orphan last word reads as a mistake rather than a line break.
      if (words.length > 3 && lines[lines.length - 1].split(' ').length === 1)
        penalty += fontSize * 1.4;
      // A break that lands on the headline's own punctuation is a real clause
      // boundary, which is always a better place to wrap than the middle of one.
      penalty -= lines.slice(0, -1).filter((line) =>
        /[,;:—–-]$/u.test(line)).length * fontSize * .5;
      const score = Math.max(...widths) + penalty +
        (Math.max(...widths) - Math.min(...widths)) * .18;
      if (!best || score < best.score) best = { lines, score };
      return;
    }
    for (let end = from + 1; end <= words.length - remaining + 1; end++)
      recurse(end, remaining - 1, [...acc, words.slice(from, end).join(' ')]);
  };
  recurse(0, count, []);
  return best!.lines;
}

// lineHeight 1.12: editorial headlines need a little more air between lines
// than captions do, without letting two lines read as two separate thoughts.
export const HOOK_TYPE = { maxFont: 112, minFont: 60, fontStep: 4, lineHeight: 1.12,
  // A headline is now a complete thought of 8-16 words, so it is allowed to use
  // the upper header area it already owns: up to four lines rather than three.
  strokePad: 10, maxLines: 4, lineCost: 10,
  // A long headline is fitted before it is cut: it may use another line and a
  // smaller size (down to `longMinFont`) rather than lose the wording that made
  // it worth choosing. Below this word count nothing changes. A very long line
  // gets one more step down, because at that length the alternative is not a
  // larger headline - it is a shortened one, and the wording is worth more.
  longWords: 11, longMinFont: 46, veryLongWords: 17, veryLongMinFont: 40 } as const;
/** The smallest size a headline of this length may be set at. */
export function hookMinFont(wordCount: number, base: number = HOOK_TYPE.minFont) {
  if (wordCount >= HOOK_TYPE.veryLongWords) return Math.min(base, HOOK_TYPE.veryLongMinFont);
  if (wordCount >= HOOK_TYPE.longWords) return Math.min(base, HOOK_TYPE.longMinFont);
  return base;
}
// Editorial headlines read best as two or three balanced lines: a single line
// costs a little for 4+ words, and each line past the second costs more - unless
// the headline is long, where the extra line is the natural shape of the text,
// not a concession.
const lineCost = (lines: number, words: number) =>
  lines === 1 ? (words >= 4 ? HOOK_TYPE.lineCost : 0) :
    lines === 2 ? 0 :
      words >= HOOK_TYPE.longWords ? HOOK_TYPE.lineCost * .3 * (lines - 2) :
        HOOK_TYPE.lineCost * 1.6 * (lines - 2);

export type HookFit = { text: string; lines: string[]; fontSize: number;
  width: number; height: number; shortenLevel: number; attempts: number };

const STOP = new Set([...LINE_END_STOPWORDS, 'that', 'this', 'why', 'how', 'what', 'who']);
// Deterministic shortening ladder. Each level keeps the original word order and
// never ends on a function word.
export function shortenHook(text: string, level: number): string {
  let value = text.replace(/\s+/gu, ' ').trim();
  if (level <= 0) return value;
  value = value.replace(/\s*\([^)]*\)\s*/gu, ' ').replace(/\s+/gu, ' ').trim();
  const clause = value.split(/\s*[:—–|]\s*/u)[0];
  if (clause.split(' ').length >= 3) value = clause;
  if (level === 1) return value;
  // Gentler than it used to be: the first cutting level still leaves a full
  // headline, so a strong 12-word line is not compressed to five words the
  // moment the largest font does not fit.
  const limit = Math.max(4, 13 - level * 2);
  let words = value.split(' ');
  if (words.length > limit) {
    words = words.slice(0, limit);
    while (words.length > 3 && STOP.has(words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '')))
      words.pop();
    words[words.length - 1] = words[words.length - 1].replace(/[,;:]+$/u, '');
  }
  return words.join(' ');
}

// Finds the largest font / fewest lines that preserve all words inside the zone.
export function fitHookText(text: string, zone: Rect, options: {
  maxFont?: number; minFont?: number; maxLines?: number; startShortenLevel?: number;
  widthScale?: number; heightScale?: number } = {}): HookFit | null {
  const maxFont = options.maxFont ?? HOOK_TYPE.maxFont;
  const baseMinFont = options.minFont ?? HOOK_TYPE.minFont;
  const maxLines = options.maxLines ?? HOOK_TYPE.maxLines;
  const widthScale = options.widthScale ?? 1;
  const heightScale = options.heightScale ?? 1;
  const pad = HOOK_TYPE.strokePad;
  let attempts = 0;
  {
    const candidate = text.replace(/\s+/gu, ' ').trim();
    const words = candidate.split(' ').filter(Boolean);
    if (!words.length) return null;
    // Use more lines and a bounded smaller size while preserving the wording.
    const minFont = hookMinFont(words.length, baseMinFont);
    // For each line count keep the largest fitting size, then prefer fewer lines
    // unless an extra line buys a clearly larger headline.
    let best: (HookFit & { score: number }) | null = null;
    for (let lines = 1; lines <= Math.min(maxLines, words.length); lines++) {
      if (lines === 1 && words.length >= 6) continue;
      for (let font = maxFont; font >= minFont; font -= HOOK_TYPE.fontStep) {
        attempts++;
        const broken = breakLines(words, lines, font);
        const width = Math.max(...broken.map((line) => estimateTextWidth(line, font))) * widthScale + pad * 2;
        const height = broken.length * font * HOOK_TYPE.lineHeight * heightScale + pad * 2;
        if (width > zone.width || height > zone.height) continue;
        const score = font - lineCost(lines, words.length);
        if (!best || score > best.score)
          best = { text: candidate, lines: broken, fontSize: font, width, height,
            shortenLevel: 0, attempts, score };
        break;
      }
    }
    if (best) {
      const { score: _score, ...fit } = best;
      return { ...fit, attempts };
    }
  }
  // Last resort for a single over-long word: shrink below the normal minimum.
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const floor = hookMinFont(words.length, baseMinFont);
  const lines = breakLines(words, Math.min(maxLines, words.length), floor);
  const widest = Math.max(...lines.map((line) => estimateTextWidth(line, 1))) * widthScale;
  const font = Math.floor(Math.min((zone.width - pad * 2) / widest,
    (zone.height - pad * 2) / (lines.length * HOOK_TYPE.lineHeight * heightScale), floor));
  if (!words.length || font < 36) return null;
  return { text: words.join(' '), lines: breakLines(words, lines.length, font), fontSize: font,
    width: widest * font + pad * 2, height: lines.length * font * HOOK_TYPE.lineHeight * heightScale + pad * 2,
    shortenLevel: 0, attempts: attempts + 1 };
}

// Subtitle line layout: at most two lines inside `maxWidth`, shrinking the font
// for unusually long words instead of letting text leave the frame.
export function layoutSubtitleLines(words: string[], fontSize: number, maxWidth: number,
  preferredBreak: number | null) {
  const widthOf = (lines: string[], size: number) =>
    Math.max(...lines.map((line) => estimateTextWidth(line, size)));
  let lines = [words.join(' ')];
  let breakIndex: number | null = null;
  if (widthOf(lines, fontSize) > maxWidth && words.length >= 2) {
    const split = preferredBreak ?? Math.ceil(words.length / 2);
    const candidates = [split, ...Array.from({ length: words.length - 1 }, (_, i) => i + 1)];
    let best = { lines, index: split, width: Infinity };
    for (const index of candidates) {
      if (index <= 0 || index >= words.length) continue;
      const option = [words.slice(0, index).join(' '), words.slice(index).join(' ')];
      const width = widthOf(option, fontSize);
      if (width < best.width - 1) best = { lines: option, index, width };
      if (index === split && width <= maxWidth) { best = { lines: option, index, width }; break; }
    }
    lines = best.lines;
    breakIndex = best.index;
  }
  let size = fontSize;
  while (size > 64 && widthOf(lines, size) > maxWidth) size -= 3;
  return { lines, breakIndex, fontSize: size, width: widthOf(lines, size) };
}
