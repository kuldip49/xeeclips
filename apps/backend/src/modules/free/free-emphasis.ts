import { isNumberToken, lower } from './free-lexicon';
import { framesOf, type FrameType } from './free-analysis';
import { reconstructSentences, type Sentence, type TimedToken } from './free-sentences';

/**
 * Sentence-aware emphasis for XeeFree zooms and subtitle highlights.
 *
 * The word-level scorer alone finds loud-looking words (numbers, capitals, a list of dramatic terms). A good zoom lands on the beat of a
 * sentence that matters: the payoff, the conclusion, a number, the turn of a contrast, the cause in an explanation, the answer to a
 * question. This picks at most ONE emphasis word per such sentence, then spaces and budgets the picks so a clip never zooms constantly.
 * Face safety, zoom magnitude and final spacing stay with the shared zoom planner; nothing here touches geometry.
 */
export type EmphasisKind = 'PAYOFF' | 'CONCLUSION' | 'NUMBER' | 'CONTRAST' | 'REASON' | 'ANSWER' | 'QUESTION' | 'ADVICE' | 'KEY_TERM';
export type EmphasisWord = { text: string; start: number; end: number; confidence?: number | null };
export type EmphasisPick = { word: EmphasisWord; kind: EmphasisKind; weight: number; sentence: number };

const KIND_WEIGHT: Record<EmphasisKind, number> = { PAYOFF: .9, CONCLUSION: .85, NUMBER: .8, CONTRAST: .75, REASON: .7, ANSWER: .7, ADVICE: .6, QUESTION: .55, KEY_TERM: .4 };
const bare = (text: string) => lower(text);
const weakWord = (w: string) => w.length < 3 || /^(?:that|this|with|from|have|they|them|then|than|were|been|will|would|could|should|about|there|their|what|when|which|your|just|like|really|very)$/u.test(w);

/** The most meaningful word of a sentence: a number, else the longest non-trivial word (a stand-in for "the content word"). */
function focusWord(tokens: TimedToken[], from = 0): TimedToken | undefined {
  const numeric = tokens.slice(from).find(t => isNumberToken(t.text) && t.start !== undefined);
  if (numeric) return numeric;
  return [...tokens.slice(from)].filter(t => t.start !== undefined && !weakWord(bare(t.text).replace(/[^\p{L}\p{N}']/gu, ''))).sort((a, b) =>
    bare(b.text).length - bare(a.text).length || (a.start ?? 0) - (b.start ?? 0))[0];
}

export function freeEmphasisPicks(words: EmphasisWord[], clipStart: number, clipEnd: number, budget: number, minSpacingSec = 4): EmphasisPick[] {
  const inRange = words.filter(w => w.start >= clipStart && w.end <= clipEnd && w.end > w.start);
  const sentences = reconstructSentences(inRange.map(w => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence })));
  const candidates: EmphasisPick[] = [];
  const last = sentences.filter(s => s.complete && s.kind !== 'QUESTION').at(-1);
  const push = (s: Sentence, kind: EmphasisKind, token: TimedToken | undefined) => {
    if (!token || token.start === undefined || token.end === undefined) return;
    candidates.push({ word: { text: token.text, start: token.start, end: token.end, confidence: token.confidence }, kind, weight: KIND_WEIGHT[kind], sentence: s.index });
  };
  for (const s of sentences) {
    if (!s.complete) continue;
    const frames = framesOf(s, sentences);
    const types = new Set<FrameType>(frames.map(f => f.type));
    if (types.has('NUMBER')) push(s, 'NUMBER', s.tokens.find(t => isNumberToken(t.text)));
    if (types.has('CONTRAST')) {
      const turn = s.tokens.findIndex(t => /^(?:but|not|instead|however|though)[,.]?$/iu.test(t.text.trim()));
      push(s, 'CONTRAST', turn >= 0 ? focusWord(s.tokens, turn + 1) : focusWord(s.tokens));
    }
    if (types.has('REASON')) {
      const because = s.tokens.findIndex(t => /^because$/iu.test(t.text.replace(/[^\p{L}]/gu, '')));
      push(s, 'REASON', because >= 0 ? focusWord(s.tokens, because + 1) : focusWord(s.tokens));
    }
    if (types.has('CONCLUSION')) push(s, 'CONCLUSION', focusWord(s.tokens));
    if (types.has('ADVICE') || types.has('WARNING')) push(s, 'ADVICE', s.tokens.find(t => t.start !== undefined && !weakWord(bare(t.text).replace(/[^\p{L}']/gu, ''))));
    if (types.has('LEAD')) push(s, 'CONCLUSION', focusWord(s.tokens, Math.max(0, s.tokens.findIndex(t => /^(?:is|was)$/iu.test(t.text)) + 1)));
    if (types.has('CLAIM') || types.has('OPINION')) push(s, 'KEY_TERM', focusWord(s.tokens));
    if (s === last) push(s, 'PAYOFF', focusWord(s.tokens));
    const previous = sentences[s.index - 1];
    if (previous?.kind === 'QUESTION' && s.speaker !== previous.speaker) push(s, 'ANSWER', focusWord(s.tokens));
    else if (previous?.kind === 'QUESTION') push(s, 'ANSWER', focusWord(s.tokens));
    if (s.kind === 'QUESTION' && s.words.length >= 5) push(s, 'QUESTION', focusWord(s.tokens));
  }
  // Strongest first; one pick per sentence; spaced apart; never in the first 1.5 s or the last 1.2 s of the clip.
  const chosen: EmphasisPick[] = [];
  for (const c of candidates.sort((a, b) => b.weight - a.weight || a.word.start - b.word.start)) {
    if (chosen.length >= budget) break;
    if (c.word.start <= clipStart + 1.5 || c.word.end >= clipEnd - 1.2) continue;
    if (chosen.some(o => o.sentence === c.sentence || Math.abs(o.word.start - c.word.start) < minSpacingSec)) continue;
    chosen.push(c);
  }
  return chosen.sort((a, b) => a.word.start - b.word.start);
}
