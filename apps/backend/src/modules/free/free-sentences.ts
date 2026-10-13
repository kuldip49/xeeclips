import { AUXILIARIES, CONTINUATION_OPENERS, CONJUNCTIONS, DETERMINERS, FILLERS, POSSESSIVES, PREPOSITIONS, QUESTION_WORDS, SUBJECT_PRONOUNS,
  isAuxiliary, isFunctionWord, isVerbForm, lower, splitTokens } from './free-lexicon';

/**
 * Sentence reconstruction. Whisper segments are acoustic chunks, not sentences: they begin and end mid-clause and carry
 * punctuation of uneven quality. This layer rebuilds semantic units from punctuation, pause length, speaker change, conjunctions
 * and discourse markers, and states honestly which units are NOT complete ("because the reason", "and then what?",
 * "he was saying that"). Fragments are kept, flagged, and never offered as complete thoughts.
 */
export type TimedToken = { text: string; start?: number; end?: number; speaker?: string | null; confidence?: number | null };
export type SentenceKind = 'QUESTION' | 'EXCLAMATION' | 'STATEMENT' | 'FRAGMENT';
export type SentenceReason = 'DANGLING_END' | 'CONTINUATION_START' | 'NO_FINITE_VERB' | 'TOO_SHORT' | 'DEPENDENT_OPENING' | 'UNRESOLVED_PRONOUN_OPENING';
export type Sentence = {
  index: number; text: string; tokens: TimedToken[]; words: string[]; speaker: string | null;
  start?: number; end?: number; kind: SentenceKind; complete: boolean; /** Complete AND understandable as an opening: no continuation word or unresolved pronoun at the start. */ standalone: boolean; reasons: SentenceReason[];
  /** Seconds of silence before / after (timed input only). */
  pauseBefore?: number; pauseAfter?: number; terminal: string };

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'etc', 'inc', 'ltd', 'st', 'fig', 'approx', 'e.g', 'i.e', 'u.s', 'u.k', 'a.m', 'p.m', 'co', 'corp']);
const SHORT_ANSWERS = new Set(['yes', 'no', 'yeah', 'yep', 'nope', 'exactly', 'right', 'sure', 'absolutely', 'definitely', 'correct', 'true', 'false', 'maybe', 'never', 'always', 'okay', 'ok', 'thanks', 'please', 'wow', 'agreed', 'obviously', 'indeed']);
const PARTICLES = new Set(['no', 'up', 'out', 'off', 'down', 'over', 'back', 'away', 'together', 'around', 'through', 'in', 'on', 'there', 'here', 'now', 'today', 'tomorrow', 'yesterday', 'again', 'too', 'also', 'anymore', 'either', 'ever', 'first', 'last', 'later', 'home', 'it', 'them', 'him', 'her', 'me', 'us', 'you', 'that', 'this', 'one', 'enough', 'well', 'else', 'better', 'worse', 'before', 'after', 'ago', 'right', 'anyway', 'though', 'however']);
const INVERSION_START = /^(?:do|does|did|is|are|was|were|am|can|could|should|would|will|shall|may|might|must|have|has|had|isn't|aren't|don't|doesn't|didn't|won't|can't)\b/iu;
const TERMINAL = /[.!?…।॥]["'’”)\]]*$/u;
const SOFT_TERMINAL = /(?:\.{3}|…)["'’”)\]]*$/u;

const bareWord = (token: string) => lower(token);
const endsTerminal = (token: string) => TERMINAL.test(token.trim()) && !isAbbreviation(token);
function isAbbreviation(token: string) {
  const w = token.trim().replace(/["'’”()[\]]/gu, '');
  if (!/\.$/u.test(w)) return false;
  const stripped = w.slice(0, -1).toLowerCase();
  return ABBREVIATIONS.has(stripped) || /^[A-Za-z]$/u.test(stripped) || /^(?:[A-Za-z]\.)+[A-Za-z]$/u.test(stripped);
}

type Work = { tokens: TimedToken[]; speaker: string | null };

function endsWithDanglingWord(words: string[]): boolean {
  const last = words.at(-1);
  if (!last) return false;
  if (CONJUNCTIONS.has(last) && !PARTICLES.has(last)) return true;
  if (DETERMINERS.has(last) && !PARTICLES.has(last)) return true;
  if (POSSESSIVES.has(last)) return true;
  if (PREPOSITIONS.has(last) && !PARTICLES.has(last)) return true;
  if (last === 'to' || last === 'a' || last === 'an' || last === 'the' || last === 'of') return true;
  if (SUBJECT_PRONOUNS.has(last) && last !== 'it' && last !== 'you' && last !== 'me' && words.length <= 3) return true;
  // "I think the", "he was saying that": an auxiliary or a complement-taking verb at the very end of a short unit.
  if (AUXILIARIES.has(last) && words.length <= 5) return true;
  if (/^(?:saying|wondering|trying|going|gonna|wanna|about|wanted)$/u.test(last) && words.length <= 6) return true;
  return false;
}

const ENGLISH_MARKERS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'and', 'that', 'it', 'you', 'i', 'we', 'they', 'for', 'on', 'with', 'as', 'at', 'be', 'this', 'not', 'have', 'has', 'but', 'what', 'do', 'can', 'will', 'my', 'your', 'so', 'if', 'how', 'why', 'there', 'he', 'she', 'from', 'by', 'about', 'when', 'just', 'like', 'or']);
/** Whether a sentence is English enough for the English-only structural checks. Non-Latin scripts and romanised Hindi are not: they are never judged "fragments" by English rules. */
export function looksEnglish(words: string[]): boolean {
  if (words.some(w => /[^\u0000-ɏ]/u.test(w))) return false;
  if (words.length < 5) return true;
  return words.filter(w => ENGLISH_MARKERS.has(w)).length / words.length >= .12;
}

const ANAPHORIC_OPENING = /^(?:the (?:opposite|reverse|same|other|latter|former|rest)\b|that(?:'s| is) (?:why|how|what|because|exactly|true|the)\b|this is (?:why|how|what)\b|which (?:is|means)\b|in other words\b|as a result\b|for that reason\b|because of (?:that|this)\b|those are\b|these are\b)/u;
/** Reasons a candidate sentence is not a complete, free-standing thought. */
export function assessSentenceWords(words: string[], terminalPunct: string): SentenceReason[] {
  const reasons: SentenceReason[] = [];
  if (!words.length) return ['TOO_SHORT'];
  if (!looksEnglish(words)) return words.length < 3 ? ['TOO_SHORT'] : [];
  const first = words[0], isQuestionMark = /\?/u.test(terminalPunct);
  if (endsWithDanglingWord(words) && !(isQuestionMark && words.length >= 4)) reasons.push('DANGLING_END');
  if (CONTINUATION_OPENERS.has(first) && first !== 'that' && first !== 'so') reasons.push('CONTINUATION_START');
  // "That mistake meant ..." / "This approach works" are complete sentences that point back at the previous one: dependent, never merged.
  const hasVerb = words.some(w => isAuxiliary(w) || isVerbForm(w) || /(?:'s|'re|'m|'ve|'ll|'d)$/u.test(w) || /^(?:don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|can't|couldn't|wouldn't|shouldn't|haven't|hasn't|hadn't|gonna|wanna|gotta)$/u.test(w));
  if (!hasVerb && !(words.length <= 2 && SHORT_ANSWERS.has(words[0])) && !(words.length <= 3 && words.every(w => SHORT_ANSWERS.has(w) || w === 'it' || w === 'is'))) reasons.push('NO_FINITE_VERB');
  if (words.length === 1 && !SHORT_ANSWERS.has(words[0])) reasons.push('TOO_SHORT');
  if (/^(?:he|she|they|him|her|them|his|their|it|this|these|those|that)$/u.test(first) && words.length >= 1) reasons.push('UNRESOLVED_PRONOUN_OPENING');
  if (/^(?:and|but|so|because|then)$/u.test(first) && !reasons.includes('CONTINUATION_START') && first !== 'so') reasons.push('DEPENDENT_OPENING');
  // An opening that only makes sense after the previous sentence: "The opposite is true", "That's why ...", "In other words ...".
  if (ANAPHORIC_OPENING.test(words.slice(0, 4).join(' ')) && !reasons.includes('DEPENDENT_OPENING')) reasons.push('DEPENDENT_OPENING');
  return reasons;
}

/** Reasons that make the unit itself unfinished (as opposed to merely depending on context). */
const INCOMPLETE_REASONS = new Set<SentenceReason>(['DANGLING_END', 'NO_FINITE_VERB', 'TOO_SHORT']);
const DEPENDENT_REASONS = new Set<SentenceReason>(['CONTINUATION_START', 'DEPENDENT_OPENING', 'UNRESOLVED_PRONOUN_OPENING']);

function joinText(tokens: TimedToken[]) {
  return tokens.map(t => t.text.trim()).filter(Boolean).join(' ')
    .replace(/\s+([,.;:!?…।])/gu, '$1').replace(/([(\[])\s+/gu, '$1').replace(/\s{2,}/gu, ' ').trim();
}
const wordList = (tokens: TimedToken[]) => tokens.flatMap(t => (lower(t.text).match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []));

function finalize(work: Work[], timed: boolean): Sentence[] {
  const out: Sentence[] = [];
  work.forEach((unit, index) => {
    const tokens = unit.tokens;
    const text = joinText(tokens);
    const words = wordList(tokens);
    const terminal = (text.match(/[.!?…।॥]+["'’”)\]]*$/u)?.[0] ?? '').replace(/["'’”)\]]/gu, '');
    const reasons = assessSentenceWords(words, terminal);
    // "…, right?" / "…, okay?" tag a statement; they do not ask anything.
    const tagQuestion = /,\s*(?:right|okay|ok|yeah|huh|correct|no|you know|see|isn't it|don't you|doesn't it|aren't you|wasn't it)\s*\?["'’”)\]]*$/iu.test(text);
    const questionish = (/\?/u.test(terminal) && !tagQuestion) || (!terminal && (QUESTION_WORDS.has(words[0] ?? '') || INVERSION_START.test(text)) && words.length <= 14)
      || (!/[.!]/u.test(terminal) && INVERSION_START.test(text) && /\byou|we|they|he|she|it|i\b/iu.test(words.slice(1, 3).join(' ')) && words.length <= 14);
    const incomplete = reasons.some(r => INCOMPLETE_REASONS.has(r));
    const first = tokens.find(t => t.start !== undefined), last = [...tokens].reverse().find(t => t.end !== undefined);
    out.push({ index, text, tokens, words, speaker: unit.speaker, ...(timed && first?.start !== undefined ? { start: first.start } : {}),
      ...(timed && last?.end !== undefined ? { end: last.end } : {}),
      kind: incomplete ? 'FRAGMENT' : questionish ? 'QUESTION' : /!/u.test(terminal) ? 'EXCLAMATION' : 'STATEMENT',
      complete: !incomplete, standalone: !incomplete && !reasons.some(r => DEPENDENT_REASONS.has(r)), reasons, terminal });
  });
  if (timed) out.forEach((s, i) => {
    const prev = out[i - 1], next = out[i + 1];
    if (prev?.end !== undefined && s.start !== undefined) s.pauseBefore = Math.max(0, s.start - prev.end);
    if (next?.start !== undefined && s.end !== undefined) s.pauseAfter = Math.max(0, next.start - s.end);
  });
  return out.map((s, i) => ({ ...s, index: i }));
}

const MAX_MERGE_GAP_SEC = 2.0, PAUSE_SPLIT_SEC = 0.85;

/** Core reconstruction over a flat token list. Punctuation, pauses and speaker turns propose boundaries; merging repairs fragments. */
export function reconstructSentences(input: TimedToken[]): Sentence[] {
  // ASR sometimes emits the tail of a hyphenated word ("start" + "-ups") as its own token; it belongs to the word before it.
  const tokens: TimedToken[] = [];
  for (const t of input) {
    if (typeof t.text !== 'string' || !t.text.trim()) continue;
    const prev = tokens[tokens.length - 1];
    if (prev && /^-\p{L}/u.test(t.text.trim()) && !/-$/u.test(prev.text.trim()) && prev.speaker === t.speaker)
      tokens[tokens.length - 1] = { ...prev, text: prev.text.trim() + t.text.trim(), ...(t.end !== undefined ? { end: t.end } : {}) };
    else tokens.push(t);
  }
  if (!tokens.length) return [];
  const timed = tokens.some(t => t.start !== undefined);
  let units: Work[] = [];
  let current: TimedToken[] = [];
  const flush = (speaker: string | null) => { if (current.length) units.push({ tokens: current, speaker }); current = []; };
  tokens.forEach((token, i) => {
    const next = tokens[i + 1];
    current.push(token);
    const speaker = token.speaker ?? null;
    const speakerChange = !!next && (next.speaker ?? null) !== speaker && (next.speaker !== undefined || token.speaker !== undefined);
    const gap = next && token.end !== undefined && next.start !== undefined ? next.start - token.end : 0;
    const textWords = wordList(current);
    const softEnd = SOFT_TERMINAL.test(token.text.trim());
    const hardEnd = endsTerminal(token.text) && !softEnd;
    const nextLower = next ? /^[\p{Ll}]/u.test(next.text.trim().replace(/^["'“‘(]+/u, '')) : false;
    const pauseBreak = gap >= PAUSE_SPLIT_SEC && !endsWithDanglingWord(textWords) && !!next && !CONTINUATION_OPENERS.has(bareWord(next.text));
    if (!next || speakerChange || (hardEnd && !(nextLower && /^[a-z]+\.$/u.test(token.text.trim()) && isAbbreviation(token.text))) || (softEnd && !nextLower) || pauseBreak) flush(speaker);
  });
  flush(null);
  // Repair pass: a unit that stops mid-clause borrows its continuation; a unit that opens as a continuation lends itself to its predecessor.
  for (let guard = 0; guard < 64; guard++) {
    let merged = false;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i], words = wordList(unit.tokens);
      const reasons = assessSentenceWords(words, joinText(unit.tokens).match(/[.!?…।]+["'’”)\]]*$/u)?.[0] ?? '');
      const prev = units[i - 1], next = units[i + 1];
      const gapBefore = prev && unit.tokens[0]?.start !== undefined && prev.tokens.at(-1)?.end !== undefined ? unit.tokens[0].start! - prev.tokens.at(-1)!.end! : 0;
      const gapAfter = next && next.tokens[0]?.start !== undefined && unit.tokens.at(-1)?.end !== undefined ? next.tokens[0].start! - unit.tokens.at(-1)!.end! : 0;
      const sameBefore = !!prev && prev.speaker === unit.speaker, sameAfter = !!next && next.speaker === unit.speaker;
      const unfinished = reasons.includes('DANGLING_END') || reasons.includes('NO_FINITE_VERB') || reasons.includes('TOO_SHORT');
      const startsDependent = reasons.includes('CONTINUATION_START');
      // A continuation joins its predecessor when that one ended: "He left. Because he was angry."
      const selfContained = !unfinished && reasons.every(r => r === 'CONTINUATION_START' || r === 'DEPENDENT_OPENING' || r === 'UNRESOLVED_PRONOUN_OPENING');
      if (startsDependent && selfContained && prev && sameBefore && gapBefore <= MAX_MERGE_GAP_SEC && !/\?["'’”)\]]*$/u.test(prev.tokens.at(-1)!.text.trim())) {
        const lastToken = prev.tokens.at(-1)!;
        const softened = { ...lastToken, text: lastToken.text.trim().replace(/[.!?…।]+(["'’”)\]]*)$/u, '$1,') };
        // The continuation now sits mid-sentence: its opener loses the sentence-initial capital ("..., because he was angry").
        const head = unit.tokens[0], lowered = /^\p{Lu}[\p{Ll}']*$/u.test(head.text.trim().replace(/[^\p{L}']/gu, '')) && !/^I(?:['’]|$)/u.test(head.text.trim())
          ? { ...head, text: head.text.trim().charAt(0).toLowerCase() + head.text.trim().slice(1) } : head;
        units.splice(i - 1, 2, { speaker: prev.speaker, tokens: [...prev.tokens.slice(0, -1), softened, lowered, ...unit.tokens.slice(1)] });
        merged = true; break;
      }
      if (unfinished && next && sameAfter && gapAfter <= MAX_MERGE_GAP_SEC && !/\?/u.test(unit.tokens.at(-1)!.text)) {
        const lastToken = unit.tokens.at(-1)!;
        const softened = { ...lastToken, text: lastToken.text.trim().replace(/[.!?…।]+(["'’”)\]]*)$/u, '$1') };
        units.splice(i, 2, { speaker: unit.speaker, tokens: [...unit.tokens.slice(0, -1), softened, ...next.tokens] });
        merged = true; break;
      }
    }
    if (!merged) break;
  }
  return finalize(units, timed);
}

/** Sentences from a plain transcript. Optional speaker turns give turn boundaries; otherwise one speaker is assumed. */
export function sentencesFromText(text: string, turns?: Array<{ speaker: string; text: string }>): Sentence[] {
  const tokens: TimedToken[] = [];
  const turnList = turns?.length ? turns : [{ speaker: '', text }];
  for (const turn of turnList) {
    const label = turns?.length ? turn.speaker || 'unknown' : null;
    for (const part of splitTokens(turn.text ?? '')) tokens.push({ text: part, speaker: label });
  }
  // Without timing every boundary is punctuation or a speaker turn; a flat token list keeps `reconstructSentences` single-purpose.
  return reconstructSentences(tokens);
}

export const completeSentences = (sentences: Sentence[]) => sentences.filter(s => s.complete);

/** First/last-word helpers shared by the boundary and hook layers. */
export const startsWithFiller = (s: Sentence) => FILLERS.has(s.words[0] ?? '');
export const isFunctionOpening = (s: Sentence) => !!s.words[0] && isFunctionWord(s.words[0]) && !QUESTION_WORDS.has(s.words[0]) && !SUBJECT_PRONOUNS.has(s.words[0]) && !DETERMINERS.has(s.words[0]);
