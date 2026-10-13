import { lower } from './free-lexicon';
import { looksEnglish } from './free-sentences';

/**
 * Deterministic caption-word cleanup for XeeFree.
 *
 * Captions must stay the transcript: nothing here adds, rewrites or reorders a word. Only a few mechanically safe defects are repaired,
 * and every repair is reported so it can be audited:
 *   DUPLICATE_WORD       an identical word repeated back-to-back by the recogniser ("the the"), unless it is a real emphatic repeat;
 *   DUPLICATE_FRAGMENT   a two-to-four word run repeated immediately ("the market the market");
 *   PUNCTUATION_TOKEN    a token that is only punctuation, attached to the word before it;
 *   SENTENCE_CASE        a lower-case word after a full stop, or a bare "i";
 * Non-English text is left exactly as recognised. A caption the user has corrected by hand is never passed through here: this runs only
 * when captions are generated, so manual corrections are inherently preserved.
 */
export type CaptionWord = { text: string; start: number; end: number; confidence?: number | null };
export type CaptionFixKind = 'DUPLICATE_WORD' | 'DUPLICATE_FRAGMENT' | 'PUNCTUATION_TOKEN' | 'SENTENCE_CASE';
export type CaptionFix = { kind: CaptionFixKind; index: number; from: string; to: string };

/** Repeats that are speech, not recognition errors: emphasis and set phrases. */
const EMPHATIC = new Set(['very', 'really', 'so', 'no', 'yes', 'ha', 'hey', 'bye', 'many', 'much', 'never', 'more', 'long', 'far', 'again', 'oh', 'wow', 'go', 'come', 'bad', 'good', 'big', 'little', 'few', 'hot', 'one', 'tick', 'knock', 'blah', 'bla', 'yeah', 'okay', 'ok', 'please', 'sorry', 'thank', 'thanks', 'ba', 'la', 'na', 'da', 'ho', 'had', 'that']);
const key = (text: string) => lower(text).replace(/[^\p{L}\p{N}']/gu, '');
const endsSentence = (text: string) => /[.!?]["'’”)\]]*$/u.test(text.trim());
const MAX_DUP_GAP = .3;

export function cleanCaptionWords<T extends CaptionWord>(input: T[]): { words: T[]; fixes: CaptionFix[] } {
  const fixes: CaptionFix[] = [];
  const sample = input.map(w => lower(w.text).replace(/[^\p{L}\p{N}']/gu, '')).filter(Boolean);
  if (!sample.length || !looksEnglish(sample)) return { words: input, fixes };
  let words = input.map(w => ({ ...w }));

  // Punctuation-only tokens belong to the previous word.
  const attached: T[] = [];
  words.forEach((w, i) => {
    if ((/^[.,!?;:…]+$/u.test(w.text.trim()) || /^-\p{L}/u.test(w.text.trim())) && attached.length) {
      const prev = attached[attached.length - 1];
      fixes.push({ kind: 'PUNCTUATION_TOKEN', index: i, from: `${prev.text} ${w.text}`, to: prev.text.trim() + w.text.trim() });
      attached[attached.length - 1] = { ...prev, text: prev.text.trim() + w.text.trim(), end: Math.max(prev.end, w.end) };
    } else attached.push(w);
  });
  words = attached;

  // Immediately repeated 2-4 word runs ("the market the market"), then single repeated words.
  for (let n = 4; n >= 2; n--) {
    for (let i = 0; i + 2 * n <= words.length; i++) {
      let same = true;
      for (let k = 0; k < n; k++) if (!key(words[i + k].text) || key(words[i + k].text) !== key(words[i + n + k].text)) { same = false; break; }
      const gap = words[i + n].start - words[i + n - 1].end;
      if (!same || gap > MAX_DUP_GAP || words.slice(i, i + n).every(w => EMPHATIC.has(key(w.text)))) continue;
      fixes.push({ kind: 'DUPLICATE_FRAGMENT', index: i, from: words.slice(i, i + 2 * n).map(w => w.text).join(' '), to: words.slice(i + n, i + 2 * n).map(w => w.text).join(' ') });
      // Keep the SECOND copy (it carries the final punctuation) but start it where the first began, so the captions' timing is continuous.
      const start = words[i].start;
      words.splice(i, n);
      words[i] = { ...words[i], start };
      i--;
    }
  }
  const deduped: T[] = [];
  for (const w of words) {
    const prev = deduped[deduped.length - 1];
    const sameWord = prev && key(prev.text) && key(prev.text) === key(w.text);
    const confident = (c?: number | null) => c === undefined || c === null || c >= .85;
    if (sameWord && w.start - prev.end <= MAX_DUP_GAP && !EMPHATIC.has(key(w.text)) && !endsSentence(prev.text) && (confident(prev.confidence) || confident(w.confidence))) {
      // Keep the sentence-initial capital of the first copy and the closing punctuation of the last, so "The the market" becomes "The market".
      const punctuation = (value: string) => value.trim().match(/[,.;:!?…]+["'’”)\]]*$/u)?.[0] ?? '';
      const stem = (value: string) => value.trim().replace(/[,.;:!?…]+["'’”)\]]*$/u, '');
      const text = (/^\p{Lu}/u.test(prev.text.trim()) ? stem(prev.text) : stem(w.text)) + (punctuation(w.text) || punctuation(prev.text));
      fixes.push({ kind: 'DUPLICATE_WORD', index: deduped.length, from: `${prev.text} ${w.text}`, to: text });
      deduped[deduped.length - 1] = { ...w, text, start: prev.start };
    } else deduped.push(w);
  }
  words = deduped;

  // Sentence casing: after a full stop, and the pronoun "I".
  words = words.map((w, i) => {
    let text = w.text;
    const before = words[i - 1]?.text ?? '';
    if (i > 0 && endsSentence(before) && /^[\p{Ll}]/u.test(text) && !/^[a-z]+\.[a-z]/iu.test(text)) text = text.charAt(0).toUpperCase() + text.slice(1);
    text = text.replace(/^i(?=$|['’][a-z]+|[,.!?;:])/u, 'I');
    if (text !== w.text) fixes.push({ kind: 'SENTENCE_CASE', index: i, from: w.text, to: text });
    return text === w.text ? w : { ...w, text };
  });
  return { words, fixes };
}
