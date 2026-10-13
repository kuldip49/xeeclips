import { createHash } from 'crypto';
import { ABSOLUTES, AUXILIARIES, CONTINUATION_OPENERS, DETERMINERS, EMOTION_WORDS, PREPOSITIONS, FILLERS, FIRST_PERSON, HEDGES, LIST_NOUNS, NEGATIONS, POSSESSIVES, QUESTION_WORDS,
  REVEAL_MARKERS, SUBJECT_PRONOUNS, WARNING_WORDS, baseVerb, contentStems, isAuxiliary, isFunctionWord, isGenericWord, isGerund, isNounish, isNumberToken,
  isVerbForm, lower, splitTokens, wordsOf } from './free-lexicon';
import { sentencesFromText, type Sentence } from './free-sentences';

/**
 * The XeeFree understanding layer: structure extracted from transcript sentences, speaker turns and on-screen text with no model.
 * Everything here is a literal span of the evidence (or a count over it). Nothing is inferred about who a person is, and a
 * name or number only appears when it is written in the transcript, OCR or metadata.
 */
export type NounPhrase = { text: string; head: string; words: string[]; sentence: number; proper: boolean; definite: boolean };
export type SlotKind = 'CLAUSE' | 'NP' | 'VP' | 'QUESTION' | 'NUM' | 'PHRASE';
export type Slot = { kind: SlotKind; text: string; sentence: number };
export type FrameType = 'OPINION' | 'REASON' | 'CONTRAST' | 'CONDITION' | 'ADVICE' | 'LEAD' | 'NUMBER' | 'QA' | 'REVEAL' | 'MYTH' | 'STORY' | 'EMOTION' | 'WARNING' | 'CLAIM'
  | 'CONCLUSION' | 'LIST' | 'DISAGREEMENT' | 'BEFORE_AFTER';
export type Frame = { type: FrameType; sentence: number; slots: Record<string, Slot>; strength: number; hedged: boolean; firstPerson: boolean; speaker: string | null };
export type KeyMoment = { kind: FrameType; sentence: number; text: string; strength: number; start?: number; end?: number };
export type FreeEvidence = { transcript: string; speakerTurns?: Array<{ speaker: string; text: string }>; visibleText?: string; visualSummary?: string;
  sceneType?: string; sourceTitle?: string; sourceCaption?: string };
export type FreeAnalysis = {
  version: string; sentences: Sentence[]; speakers: string[]; monologue: boolean;
  topic: string; subtopic: string; mainClaim: string; question: string; answer: string; tension: string; contrast: string; payoff: string; conclusion: string;
  importantFacts: string[]; importantPhrases: string[]; keywords: string[]; numbers: Array<{ text: string; context: string }>; entities: string[];
  /** How many times each key phrase is spoken (lower-cased phrase -> count). A phrase heard once is a weak topic and a weak hashtag. */
  topicCounts: Record<string, number>;
  supportedClaims: string[]; participants: Array<{ id: string; role: string; evidence: string }>; sceneContext: string[];
  phrases: NounPhrase[]; frames: Frame[]; keyMoments: KeyMoment[]; evidenceText: string };
export const FREE_ANALYSIS_VERSION = 'xeefree-analysis-v1';

const LEAD_NOUNS = new Set(['punchline', 'twist', 'moral', 'takeaway', 'mistake', 'problem', 'secret', 'reason', 'key', 'trick', 'rule', 'truth', 'lesson', 'difference', 'answer', 'risk', 'danger', 'myth', 'goal', 'issue', 'trap',
  'challenge', 'catch', 'upside', 'downside', 'advantage', 'benefit', 'cost', 'point', 'mindset', 'habit', 'sign', 'fear', 'question', 'priority', 'strategy', 'principle', 'shift', 'change']);
const PUNCT_BREAK = /[,;:.!?—–()"“”]$/u;

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const compact = (value: string) => value.replace(/\s+/gu, ' ').trim();
const stripEdgePunct = (value: string) => value.replace(/^[\s"'“‘(\[—–-]+|[\s"'”’)\].,;:!?—–-]+$/gu, '').trim();

const LEADING_NOISE = /^(?:(?:oh|ah|wow|hey|hmm|huh|so|and|but|well|okay|ok|yeah|yep|right|now|then|anyway|basically|honestly|look|listen|alright|like|um|uh|you know|i mean|you see|see|actually|first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|finally|next|lastly|also|plus|number (?:one|two|three|four|five))\b[,\s]*)+/iu;
/** Spoken lead-ins that announce a statement without being part of it: "I'll tell you this,", "the thing is", "let me explain". */
const LEAD_INS = /^(?:(?:now[, ]+)?i(?:'ll| will| am going to|'m going to| want to| would like to) (?:tell|say|show|explain|ask) you (?:this|something|what|that)?|let me (?:tell|explain|say|ask|show) (?:you )?(?:this|something|what)?|here(?:'s| is) the thing|the thing is|what i(?:'m| am) saying is|what i mean is|i(?:'m| am) telling you|let's be honest|to be honest|to be clear|the fact (?:is|of the matter is)|you know what)(?:\s+that)?[,:;]?\s+(?=\S)/iu;
const INLINE_FILLERS = /(?:,\s*)?\b(?:you know|i mean|you see)\b(?:\s*,)?/giu;
const TRAILING_NOISE = /(?:[,\s]+(?:you know|right|okay|ok|like|y'know|i mean|or something|and stuff|and all that|and so on|you see))+[\s.!?]*$/iu;
/** Removes spoken scaffolding without touching a single content word. */
/** "I don't, I don't believe" -> "I don't believe": an immediately repeated run of up to four words is a disfluency, not content. */
export function dedupeRepeats(value: string): string {
  const tokens = value.split(' ');
  const key = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  for (let n = 4; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= tokens.length; i++) {
      let same = true;
      for (let k = 0; k < n; k++) if (!key(tokens[i + k]) || key(tokens[i + k]) !== key(tokens[i + n + k])) { same = false; break; }
      if (same) { tokens.splice(i, n); i--; }
    }
  }
  return tokens.join(' ').replace(/\s+([,;])/gu, '$1');
}
/** A statement that talks about the talk ("let me explain", "I'll tell you") announces content rather than carrying it. */
export const META_TALK = /^(?:let me|let us|let's|i(?:'ll| will| want to| wanna| would like to| am going to| 'm going to)|i'm going to|here(?:'s| is| are)|so what i|what i)\b.{0,40}\b(?:explain|show|tell|say|ask|start|begin|talk|share|go|look|ask|clarify|put it)\b/iu;
export function cleanClause(raw: string): string {
  let value = compact(raw).replace(/\b(?:um+|uh+|er+|erm|hmm+)\b[,\s]*/giu, '');
  value = dedupeRepeats(value.replace(LEADING_NOISE, '').replace(LEAD_INS, '').replace(LEADING_NOISE, '').replace(INLINE_FILLERS, ' ').replace(/\s{2,}/gu, ' ')).replace(TRAILING_NOISE, '').replace(/\s+,/gu, ',').replace(/,\s*,/gu, ',');
  return stripEdgePunct(compact(value));
}

const wordsLower = (value: string) => wordsOf(value);
const hasFiniteVerb = (words: string[]) => words.some((w, i) => (isAuxiliary(w) && words[i - 1] !== 'to') || (isVerbForm(w) && words[i - 1] !== 'to') || /(?:'s|'re|'m|'ve|'ll|'d)$/u.test(w) || /^(?:don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|can't|couldn't|wouldn't|shouldn't|haven't|hasn't|hadn't|gonna|wanna|gotta)$/u.test(w));
const DANGLING_TAIL = new Set(['and', 'but', 'or', 'because', 'so', 'if', 'when', 'while', 'that', 'which', 'who', 'to', 'of', 'for', 'with', 'from', 'by', 'at', 'in', 'on', 'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'is', 'are', 'was', 'were', 'than', 'as', 'about', 'into', 'then', 'also', 'not', 'no']);

/** A finite clause with its own subject: safe to place after "Why" / "What happens when" / "Is it true that". */
export function isClause(text: string): boolean {
  const words = wordsLower(text);
  if (words.length < 3 || words.length > 22) return false;
  if (CONTINUATION_OPENERS.has(words[0]) || FILLERS.has(words[0])) return false;
  // "what happens is...", "how it works": a wh-clause is not a statement that can follow "Why".
  if (QUESTION_WORDS.has(words[0]) && words[0] !== 'who') return false;
  if (DANGLING_TAIL.has(words.at(-1)!)) return false;
  if (!hasFiniteVerb(words)) return false;
  // "staring at an invoice that would never be paid" is a participial phrase, not a clause: a gerund followed by a preposition modifies something else.
  if (isGerund(words[0]) && PREPOSITIONS.has(words[1] ?? '')) return false;
  // The finite verb: not a gerund subject ("Learning to code is..."), and not an infinitive after "to" ("to code").
  const verbAt = words.findIndex((w, i) => (isAuxiliary(w) && w !== 'being' && w !== 'been' && words[i - 1] !== 'to') || (isVerbForm(w) && !isGerund(w) && words[i - 1] !== 'to') || /(?:'s|'re|'m|'ve|'ll|'d)$/u.test(w) || /n't$/u.test(w));
  // Needs something before the verb that can be a subject: a pronoun, determiner phrase or noun.
  const before = words.slice(0, verbAt);
  // "an invoice that would never be paid": the only verb sits inside a relative clause, so this is a noun phrase. A later main verb rescues it.
  if (/^(?:that|which|who|whom|whose)$/u.test(words[verbAt - 1] ?? '') && !words.slice(verbAt + 1).some((w, i) => (isAuxiliary(w) || (isVerbForm(w) && !isGerund(w))) && i > 0)) return false;
  // "there's no market for bonds": an existential carries its subject inside the contraction.
  if (verbAt === 0 && /^(?:there's|there're|here's)$/u.test(words[0]) && words.length >= 4) return true;
  if (verbAt === 0) return false;
  return before.some(w => SUBJECT_PRONOUNS.has(w) || DETERMINERS.has(w) || POSSESSIVES.has(w) || isNounish(w) || /^(?:there|here|it|that|this|everyone|everybody|nobody|someone|people)$/u.test(w));
}
/** An imperative or "to"-less verb phrase beginning with a base verb: "say no without guilt". */
export function isBaseVerbPhrase(text: string): boolean {
  const words = wordsLower(text);
  if (words.length < 2 || words.length > 16) return false;
  const first = words[0];
  if (AUXILIARIES.has(first) || SUBJECT_PRONOUNS.has(first) || NEGATIONS.has(first) || !isVerbForm(first) || baseVerb(first) !== first) return false;
  if (DANGLING_TAIL.has(words.at(-1)!)) return false;
  return true;
}

const properToken = (token: string) => /^\p{Lu}[\p{L}'’-]*$/u.test(token.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '')) && !/^(?:I|I'm|I've|I'll|I'd)$/u.test(token.replace(/[^\p{L}'’]/gu, ''));

/** Noun phrases of one sentence, as literal spans. Verbs, gerunds, adverbs and generic heads are excluded structurally. */
export function nounPhrases(sentence: Sentence): NounPhrase[] {
  const tokens = splitTokens(sentence.text);
  const out: NounPhrase[] = [];
  let run: string[] = [], proper = false, definite = false;
  const flush = () => {
    // Drop leading determiners from the phrase text but remember them.
    while (run.length && (DETERMINERS.has(lower(run[0])) || POSSESSIVES.has(lower(run[0])))) { definite = true; run = run.slice(1); }
    while (run.length && isFunctionWord(run.at(-1)!) ) run = run.slice(0, -1);
    // "two years" / "ten customers": a leading numeral belongs to the list frame, not to the topic phrase.
    while (run.length > 1 && isNumberToken(run[0])) run = run.slice(1);
    const words = run.map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '')).filter(Boolean);
    const content = words.filter(w => !isFunctionWord(w) && !isNumberToken(w));
    if (words.length && words.length <= 4 && content.length) {
      const head = lower(words.at(-1)!);
      if (!isGenericWord(head) && !isNumberToken(head) && head.length >= 3 && !isGerund(head)) out.push({ text: words.join(' '), head, words: words.map(lower), sentence: sentence.index, proper: proper && words.every(w => /^\p{Lu}/u.test(w)), definite });
    }
    run = []; proper = false; definite = false;
  };
  tokens.forEach((token, i) => {
    const w = lower(token);
    const isProper = i > 0 && properToken(token);
    const det = DETERMINERS.has(w) || POSSESSIVES.has(w);
    const internalOf = (w === 'of' || w === 'for') && run.length > 0 && i + 1 < tokens.length && isNounish(tokens[i + 1]);
    const ok = isNounish(token) || isNumberToken(token) && run.length > 0 || isProper || (det && run.length === 0) || internalOf;
    if (!ok || (run.length && det && !internalOf)) { flush(); if (det && !ok) return; if (!ok) return; }
    run.push(token); if (isProper) proper = true;
    if (PUNCT_BREAK.test(token)) flush();
  });
  flush();
  // De-duplicate within the sentence.
  return out.filter((p, i, a) => a.findIndex(o => o.words.join(' ') === p.words.join(' ')) === i);
}

type Scored = { phrase: string; score: number; count: number; proper: boolean };

function rankPhrases(sentences: Sentence[], extra: string[]): { ranked: Scored[]; all: NounPhrase[] } {
  const counts = new Map<string, Scored>();
  const all: NounPhrase[] = [];
  for (const s of sentences) {
    if (!s.complete && s.words.length < 4) continue;
    for (const p of nounPhrases(s)) {
      all.push(p);
      const key = p.words.join(' ');
      const entry = counts.get(key) ?? { phrase: p.text, score: 0, count: 0, proper: false };
      entry.count++; entry.proper ||= p.proper;
      entry.score += 1 + (p.words.length >= 2 ? .9 : 0) + (s.kind === 'QUESTION' ? .5 : 0) + (p.proper ? .6 : 0);
      counts.set(key, entry);
    }
  }
  for (const text of extra) for (const word of splitTokens(text)) {
    if (properToken(word) && isNounish(word)) { const key = lower(word); const e = counts.get(key) ?? { phrase: word.replace(/[^\p{L}\p{N}'’-]/gu, ''), score: 0, count: 0, proper: true }; e.count++; e.score += 1.2; counts.set(key, e); }
  }
  // A single common word is topical only if it recurs; multi-word phrases and proper names stand on one mention.
  const ranked = [...counts.values()].filter(e => e.count >= 2 || e.phrase.split(' ').length >= 2 || e.proper)
    .map(e => ({ ...e, score: e.score + Math.min(e.count, 5) * .4 }))
    .sort((a, b) => b.score - a.score);
  // Remove phrases fully contained in a higher ranked, longer phrase ("debate" inside "campus debate") unless they recur on their own.
  const kept: Scored[] = [];
  for (const e of ranked) {
    const lowerPhrase = lower(e.phrase);
    if (kept.some(k => lower(k.phrase) !== lowerPhrase && (lower(k.phrase).includes(lowerPhrase) || lowerPhrase.includes(lower(k.phrase))) && e.count <= k.count + 1)) continue;
    kept.push(e);
  }
  return { ranked: kept, all };
}

const NUMERAL = /^(?:\d[\d,.]*%?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|dozen)$/iu;

/** The first complete clause of a long sentence, cut at a coordinating boundary (", and", ", but", ";"), so a 30-word sentence still yields its main statement. */
function firstClause(text: string): string | null {
  for (const piece of cleanClause(text).split(/,\s+(?:and|but|so|which|while|because)\s+|;\s+|\s+—\s+/iu)) {
    const clause = cleanClause(piece);
    if (isClause(clause) && wordsLower(clause).length >= 5) return clause;
  }
  return null;
}
function takeClause(text: string): string | null {
  const cleaned = cleanClause(text.split(/(?<=[.!?])\s+/u)[0] ?? '');
  return isClause(cleaned) ? cleaned : null;
}
function takeVerbPhrase(text: string): string | null {
  const cleaned = cleanClause(text.split(/(?<=[.!?])\s+|[,;:]\s+(?:and|but|because|so)\b/u)[0] ?? '');
  return isBaseVerbPhrase(cleaned) ? cleaned : null;
}
const numSlot = (text: string, sentence: number): Slot => ({ kind: 'NUM', text, sentence });
const slot = (kind: SlotKind, text: string, sentence: number): Slot => ({ kind, text, sentence });

function frameMeta(s: Sentence, text: string) {
  return { hedged: HEDGES.test(text), firstPerson: wordsLower(text).some(w => FIRST_PERSON.has(w)), speaker: s.speaker };
}

/** All typed frames of one sentence; later layers bind templates to these slots. */
export function framesOf(s: Sentence, _all?: Sentence[]): Frame[] {
  const frames: Frame[] = [];
  if (!s.complete) return frames;
  const text = s.text.replace(/\.{3}|…/gu, ',');
  const body = dedupeRepeats(text.replace(/[.!?]+$/u, ''));
  const push = (type: FrameType, slots: Record<string, Slot>, strength: number, textForMeta = body) =>
    frames.push({ type, sentence: s.index, slots, strength, ...frameMeta(s, textForMeta) });
  const lowerBody = body.toLowerCase();

  // REASON: effect because cause / the reason ... is ...
  let m = body.match(/^(?<effect>.{12,}?),?\s+because\s+(?<cause>.{8,})$/iu);
  if (m?.groups) {
    const effect = takeClause(m.groups.effect), cause = takeClause(m.groups.cause);
    if (effect && cause && !META_TALK.test(effect)) push('REASON', { effect: slot('CLAUSE', effect, s.index), cause: slot('CLAUSE', cause, s.index) }, .85);
  }
  m = body.match(/\bthe (?:(?:real|main|biggest|only|simple|actual|whole) )?reason (?:why |that |for which )?(?<effect>.{8,}?) (?:is|was) (?:that |because |simply |just )?(?<cause>.{8,})$/iu);
  if (m?.groups) {
    const effect = takeClause(m.groups.effect), cause = takeClause(m.groups.cause);
    if (effect && cause) push('REASON', { effect: slot('CLAUSE', effect, s.index), cause: slot('CLAUSE', cause, s.index) }, .95);
  }
  // CONTRAST
  m = body.match(/\b(?:it(?:'s| is)|this is|that(?:'s| is)) not (?<a>.{3,}?),?\s+(?:but |it(?:'s| is) |it is )(?<b>.{3,})$/iu) ?? body.match(/\bnot (?<a>[^,]{3,}?),?\s+but\s+(?<b>.{3,})$/iu);
  if (m?.groups) {
    const a = cleanClause(m.groups.a), b = cleanClause(m.groups.b);
    if (a && b && wordsLower(a).length <= 7 && wordsLower(b).length <= 9 && !DANGLING_TAIL.has(wordsLower(a).at(-1)!) && !DANGLING_TAIL.has(wordsLower(b).at(-1)!))
      push('CONTRAST', { a: slot('PHRASE', a, s.index), b: slot('PHRASE', b, s.index) }, .95);
  }
  m = body.match(/^(?<b>.{6,}?)\s+(?:instead of|rather than)\s+(?<a>.{4,})$/iu);
  if (m?.groups) {
    const a = cleanClause(m.groups.a), b = cleanClause(m.groups.b);
    if (a && b && wordsLower(a).length <= 7 && wordsLower(b).length <= 9) push('CONTRAST', { a: slot('PHRASE', a, s.index), b: slot('PHRASE', b, s.index), instead: slot('PHRASE', 'instead', s.index) }, .75);
  }
  // "X, not Y": the turn is stated without "but".
  m = body.match(/^(?<b>.{12,}?),\s+not\s+(?<a>[^,]{3,40})$/iu);
  if (m?.groups && !frames.some(f => f.type === 'CONTRAST')) {
    const a = cleanClause(m.groups.a), b = takeClause(m.groups.b);
    if (b && a && wordsLower(a).length <= 7 && !DANGLING_TAIL.has(wordsLower(a).at(-1)!)) push('CONTRAST', { claim: slot('CLAUSE', takeClause(body) ?? cleanClause(body), s.index), turnB: slot('CLAUSE', b, s.index) }, .55);
  }
  if (/\b(?:but|however|although|yet|despite|except)\b/iu.test(body) && !frames.some(f => f.type === 'CONTRAST')) {
    // "X, but Y": when Y is a complete clause with its own noun subject, Y is the turn the sentence is about.
    const turn = body.match(/^(?<a>.{10,}?),?\s+but\s+(?<b>.{12,})$/iu);
    const b = turn?.groups ? takeClause(turn.groups.b) : null, a = turn?.groups ? takeClause(turn.groups.a) : null;
    const lead = b ? wordsLower(b).find(w => !DETERMINERS.has(w) && !POSSESSIVES.has(w)) ?? '' : '';
    const nounLead = !!lead && !SUBJECT_PRONOUNS.has(lead) && !FIRST_PERSON.has(lead) && !FILLERS.has(lead) && !isFunctionWord(lead) && !isGenericWord(lead);
    push('CONTRAST', { claim: slot('CLAUSE', takeClause(body) ?? cleanClause(body), s.index),
      ...(a && b && nounLead ? { turnA: slot('CLAUSE', a, s.index), turnB: slot('CLAUSE', b, s.index) } : {}) }, .45);
  }
  // CONDITION
  m = body.match(/^(?:(?:it|that|which|this) means (?:that )?|so |then |and |but |because )?(?:if|when|once|after)\s+(?<cond>[^,]{8,}?),\s*(?<result>.{6,})$/iu);
  if (m?.groups) {
    const cond = takeClause(m.groups.cond), result = takeClause(m.groups.result);
    const word = lowerBody.match(/\b(?:if|when|once|after)\b/u)?.[0] ?? 'when';
    if (cond && result) push('CONDITION', { cond: slot('CLAUSE', cond, s.index), result: slot('CLAUSE', result, s.index), marker: slot('PHRASE', word, s.index) }, .8);
  }
  // ADVICE / WARNING: "you should X", "never X", imperatives
  m = body.match(/\b(?:you|we)\s+(?:should|need to|have to|must|ought to|gotta|got to)\s+(?<vp>.{6,})$/iu);
  const adviceVp = m?.groups ? takeVerbPhrase(m.groups.vp) : null;
  // A prohibition is advice only when it addresses the viewer: an imperative opener or "you should never". "They never talk to
  // customers" describes someone else, and turning it into "Never talk to customers" would invert the speaker's meaning.
  const negVp = body.match(/^(?:(?:and|but|so|just|please|okay|now)[, ]+)?(?:never|don'?t|do not|stop|avoid)\s+(?<vp>.{5,})$/iu)
    ?? body.match(/\byou\s+(?:should|must|need to|have to|ought to)\s+(?:never|not|avoid|stop)\s+(?<vp>.{5,})$/iu);
  const negPhrase = negVp?.groups ? takeVerbPhrase(negVp.groups.vp) : null;
  if (adviceVp) push('ADVICE', { vp: slot('VP', adviceVp, s.index) }, .8);
  else {
    const first = lowerBody.split(' ')[0];
    // "Email feels productive": a word that is also a verb, followed by a finite verb, is a subject noun, not an imperative.
    const second = s.words[1] ?? '';
    const subjectNoun = !!second && (isAuxiliary(second) || (isVerbForm(second) && baseVerb(second) !== second && !isGerund(second)));
    if (isVerbForm(first) && baseVerb(first) === first && !AUXILIARIES.has(first) && !SUBJECT_PRONOUNS.has(first) && !subjectNoun && s.words.length >= 3 && s.words.length <= 16) {
      const vp = takeVerbPhrase(body);
      if (vp) push('ADVICE', { vp: slot('VP', vp, s.index) }, .7);
    }
  }
  if (negPhrase) {
    const word = /\bnever\b/iu.test(body) ? 'Never' : /\bstop\b/iu.test(body) ? 'Stop' : /\bavoid\b/iu.test(body) ? 'Avoid' : "Don't";
    push('WARNING', { vp: slot('VP', negPhrase, s.index), lead: slot('PHRASE', word, s.index) }, .8);
  }
  // LEAD: "the biggest mistake is ..."
  // An optional relative clause between the noun and the verb ("the lesson I learned after changing my schedule was ...") is dropped from the hook.
  m = body.match(/^(?:and |but |so )?(?<lead>(?:the|a|my|your|this|one)?\s*(?:[\p{L}'’-]+\s+){0,3}?(?:mistake|problem|secret|reason|key|trick|rule|truth|lesson|difference|answer|risk|danger|myth|goal|issue|trap|challenge|catch|downside|upside|mindset|habit|sign|priority|strategy|principle|punchline|twist|moral|takeaway))(?:\s+(?:i|we|you|they)\s+[^,]{2,48}?)?\s+(?:is|was|are|were)\s+(?:that\s+|to\s+)?(?<rest>.{8,})$/iu);
  if (m?.groups) {
    const lead = cleanClause(m.groups.lead);
    // "the lesson is simple: the market decides" -> keep the clause after the colon, not the adjective before it.
    const restRaw = m.groups.rest.replace(/^[^:]{1,24}:\s+(?=.{12,})/u, '');
    const rest = cleanClause(restRaw);
    const head = lower(lead.split(' ').at(-1)!);
    const leadWords = wordsLower(lead);
    if (LEAD_NOUNS.has(head) && leadWords.length <= 5 && rest && !DANGLING_TAIL.has(wordsLower(rest).at(-1)!) && wordsLower(rest).length <= 18
      && (isClause(rest) || isBaseVerbPhrase(rest) || wordsLower(rest).some(isGerund))) push('LEAD', { lead: slot('NP', lead, s.index), rest: slot('PHRASE', rest, s.index), head: slot('PHRASE', head, s.index) }, .9);
  }
  // NUMBER: "three reasons startups fail", "ninety percent of ..."
  const tokens = splitTokens(body);
  tokens.forEach((token, i) => {
    const w = lower(token);
    if (!NUMERAL.test(w) || i + 1 >= tokens.length) return;
    const next = lower(tokens[i + 1]);
    // A count of time units ("two months") is a duration, not a list of reasons or steps.
    if (LIST_NOUNS.has(next) && !/^(?:times|years|months|weeks|days|hours|minutes|seconds|people)$/u.test(next)) {
      const tail = tokens.slice(i, i + 8).join(' ').replace(/[,;:.!?]+$/u, '');
      const trimmed = tail.split(/[,;:]/u)[0];
      const tw = wordsLower(trimmed);
      if (tw.length >= 3 && !DANGLING_TAIL.has(tw.at(-1)!)) push('NUMBER', { phrase: slot('PHRASE', trimmed, s.index), num: numSlot(token, s.index), noun: slot('PHRASE', next, s.index) }, .75);
    }
    const spokenNumber = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)$/u.test(w) && /^(?:percent|million|billion|thousand|dollars?|times|x)$/iu.test(tokens[i + 1]?.replace(/[^\p{L}%]/gu, '') ?? '');
    if ((spokenNumber || /%$|^(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)$/u.test(w)) && (spokenNumber || /\b(?:percent|%|million|billion|thousand|dollars?|x|times)\b|\$|%/iu.test(tokens.slice(i, i + 3).join(' ') + tokens[i - 1]))) {
      const claim = takeClause(body);
      if (claim) push('NUMBER', { claim: slot('CLAUSE', claim, s.index), num: numSlot(token, s.index) }, .7);
    }
  });
  // REVEAL
  for (const marker of REVEAL_MARKERS) {
    const found = marker.exec(body);
    if (!found) continue;
    const rest = cleanClause(body.slice(found.index + found[0].length));
    const restClause = takeClause(rest);
    push('REVEAL', { marker: slot('PHRASE', found[0].toLowerCase(), s.index), ...(restClause ? { rest: slot('CLAUSE', restClause, s.index) } : {}),
      phrase: slot('PHRASE', cleanClause(body.slice(found.index)), s.index) }, .7);
    break;
  }
  // MYTH
  m = body.match(/\b(?:everyone|most people|a lot of people|many people|people|they|some people|we all)\s+(?:think|believe|say|assume|thought|used to think|tend to think)\s+(?:that\s+)?(?<claim>.{10,})$/iu);
  if (m?.groups) { const claim = takeClause(m.groups.claim); if (claim) push('MYTH', { claim: slot('CLAUSE', claim, s.index) }, .75); }
  // OPINION (attributed): "The council said the rules protect residents", "He argued the subsidy created jobs". Only the CLAIM is used, so the
  // hook ("Do the rules protect residents?") needs no pronoun and no attribution.
  m = body.match(/^(?:and |but |so |well )?(?:he|she|they|[\p{Lu}][\p{L}'’-]+(?: [\p{Lu}][\p{L}'’-]+)?|the [\p{L}]+(?: [\p{L}]+)?)\s+(?:argued|argues|said|says|claimed|claims|believes?|believed|insisted|insists|admitted|warned|predicted|suggested|noted|maintained|contended|thinks?|thought)\s+(?:that\s+)?(?<claim>.{14,})$/u);
  if (m?.groups && !/^[\p{Lu}]/u.test(m.groups.claim.charAt(0)) || (m?.groups && /^(?:the|a|an)\s/iu.test(m.groups.claim))) {
    const claim = m?.groups ? (takeClause(m.groups.claim) ?? firstClause(m.groups.claim)) : null;
    const leadWord = claim ? wordsLower(claim)[0] : '';
    if (claim && !SUBJECT_PRONOUNS.has(leadWord) && !/^(?:this|that|these|those|it)$/u.test(leadWord) && !/\b(?:i|me|my|we|our)\b/iu.test(claim)) push('OPINION', { claim: slot('CLAUSE', claim, s.index) }, .6);
  }
  // OPINION: "I don't believe that money was stolen" states a claim the clip then argues for or against; the claim itself is the topic.
  m = body.match(/^(?:and |but |so |well )?i\s+(?:really |do not |don't |do |honestly |still )*(?:believe|think|feel|say|know|agree|disagree)\s+(?:that\s+)?(?:you can say\s+(?:that\s+)?)?(?<claim>.{14,})$/iu);
  if (m?.groups) {
    const claim = takeClause(m.groups.claim);
    if (claim && !/\b(?:i|me|my|we|our)\b/iu.test(claim)) push('OPINION', { claim: slot('CLAUSE', claim, s.index) }, .7);
  }
  // EMOTION
  if (wordsLower(body).some(w => EMOTION_WORDS.has(w)) && !HEDGES.test(body)) push('EMOTION', { line: slot('CLAUSE', takeClause(body) ?? cleanClause(body), s.index) }, .55);
  // STORY setup from a gerund: "After losing my job I called my sister" -> "What happened after losing my job".
  m = body.match(/\b(?<marker>after|before)\s+(?<event>[a-z]+ing\s+(?:my|our|the|a|an|his|her|their|that|this|these|those)\s+[^,]{3,30}?)(?:,|\s+(?:i|we|they|he|she)\b|$)/iu);
  if (m?.groups && isGerund(m.groups.event.split(' ')[0]) && !HEDGES.test(body)) {
    const event = cleanClause(m.groups.event);
    if (wordsLower(event).length >= 3 && !DANGLING_TAIL.has(wordsLower(event).at(-1)!)) push('STORY', { event: slot('PHRASE', event, s.index), marker: slot('PHRASE', m.groups.marker.toLowerCase(), s.index) }, .55);
  }
  // STORY setup: narrative opener with a past-tense event clause
  m = body.match(/\b(?:when|after|once|the day|the moment)\s+(?<event>(?:i|we|they|he|she|my|our|the)\s+[^,]{8,}?)(?:,|$)/iu);
  if (m?.groups && /\b(?:ed|was|were|had|did|went|got|made|took|came|saw|told|found|decided|started|tried|lost|left)\b/iu.test(m.groups.event)) {
    const event = takeClause(m.groups.event);
    if (event) push('STORY', { event: slot('CLAUSE', event, s.index), marker: slot('PHRASE', lowerBody.match(/\b(?:when|after|once|the day|the moment)\b/u)?.[0] ?? 'when', s.index) }, .65);
  }
  // CLAIM: absolutes / superlatives / opinion statements
  if ((ABSOLUTES.test(body) || /\b(?:the (?:real|biggest|main|only|best|worst)|is (?:not|never|always)|should(?:n't| not)?|must|has to|have to|actually)\b/iu.test(body)) && !HEDGES.test(body)) {
    const claim = takeClause(body);
    if (claim) push('CLAIM', { claim: slot('CLAUSE', claim, s.index) }, .6);
  }
  // A list item ("Third, the founders stop trusting each other") is one part of an enumeration; as a headline it would overstate itself.
  const listItem = /^(?:and\s+)?(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth|fifth|finally|lastly|next|also|plus|number\s+\w+|one|two|three)\b[,:]/iu.test(body);
  // CLAIM (general): a short, standalone statement with a noun subject that says something causal or negated about it
  // ("Grief does not follow a schedule", "Chasing approval makes every decision depend on someone else").
  if (!listItem && !frames.some(f => f.type === 'CLAIM') && s.standalone && s.kind !== 'QUESTION' && !HEDGES.test(body) && s.words.length >= 5 && s.words.length <= 34) {
    const wl = wordsLower(body);
    const lead = wl.find(w => !DETERMINERS.has(w) && !POSSESSIVES.has(w)) ?? '';
    // A first-person statement is allowed here (the hook gate rejects it in a multi-speaker clip); "you" and third-person pronouns are not a subject.
    const nounSubject = !!lead && !(SUBJECT_PRONOUNS.has(lead) && !/^(?:i|we)$/u.test(lead)) && !FILLERS.has(lead) && !/^(?:there|here|let's|let)$/u.test(lead)
      && (isNounish(lead) || isGerund(lead) || /^(?:i|we)$/u.test(lead)) && !isGenericWord(lead);
    const causal = /\b(?:makes?|causes?|leads? to|creates?|destroys?|kills?|ruins?|means|requires?|depends? on|turns? into|drives?|prevents?|protects?|improves?|reduces?|increases?|helps?|keeps?|gives?|needs?|allows?|lets?|stops?|stays?|starts? with|comes? from|does(?:n't| not)|do(?:n't| not)|is(?:n't| not)|are(?:n't| not)|can(?:'t|not)|never)\b/iu.test(body);
    // Any plain statement with its own noun subject can headline a clip; a causal or negated one is stronger. The hook gate decides.
    if (nounSubject) { const claim = takeClause(body) ?? firstClause(body); if (claim) push('CLAIM', { claim: slot('CLAUSE', claim, s.index) }, causal ? .55 : .42); }
  }
  // CONCLUSION
  if (/^(?:so (?:basically|the|that['’]?s|in other words|this means|which means|what)|that['’]?s why|which means|the point is|the lesson|bottom line|in the end|at the end of the day|the takeaway|ultimately|therefore|finally|that['’]?s what|in other words|what this means)\b/iu.test(body) || /\b(?:the (?:bottom line|takeaway|lesson|point)|in the end|at the end of the day)\b/iu.test(body))
    push('CONCLUSION', { line: slot('CLAUSE', takeClause(body) ?? cleanClause(body), s.index) }, .7);
  // WARNING by vocabulary
  if (!frames.some(f => f.type === 'WARNING') && wordsLower(body).some(w => WARNING_WORDS.has(w)) && /\b(?:mistake|danger|risk|warning|trap|wrong|scam|costly|fail)\b/iu.test(body)) {
    const claim = takeClause(body); if (claim) push('WARNING', { claim: slot('CLAUSE', claim, s.index) }, .55);
  }
  // BEFORE/AFTER: "from X to Y"
  m = body.match(/\bfrom\s+(?<a>[^,]{3,24}?)\s+to\s+(?<b>[^,.]{3,30})$/iu);
  if (m?.groups) {
    const phrase = cleanClause(`from ${m.groups.a} to ${m.groups.b}`);
    const wl = wordsLower(phrase);
    if (wl.length >= 4 && wl.length <= 10 && !DANGLING_TAIL.has(wl.at(-1)!)) push('BEFORE_AFTER', { phrase: slot('PHRASE', phrase, s.index) }, .5);
  }
  return frames;
}

const QUESTION_STARTS = new Set(['why', 'how', 'what', 'when', 'where', 'who', 'which', 'do', 'does', 'did', 'is', 'are', 'was', 'were', 'can', 'could', 'should', 'would', 'will', 'have', 'has']);
const DISAGREE_OPENERS = /^(?:no\b|wait\b|but\b|actually\b|i (?:disagree|don'?t think so|don'?t agree)|that'?s (?:not|wrong|false)|hold on|come on|really\b|that'?s not true|i'd push back)/iu;

/** Frames that need two sentences: a question and its answer, or a claim and a reply that pushes back. */
export function crossSentenceFrames(sentences: Sentence[]): Frame[] { return qaFrames(sentences); }
function qaFrames(sentences: Sentence[]): Frame[] {
  const out: Frame[] = [];
  sentences.forEach((q, i) => {
    if (q.kind !== 'QUESTION' || !q.complete || q.words.length < 4 || q.words.length > 22) return;
    if (!QUESTION_STARTS.has(q.words[0]) && !/\?$/u.test(q.text)) return;
    // Answer: the next complete statement(s), by another speaker or after a short beat by the same one.
    const answer = sentences.slice(i + 1, i + 4).find(s => s.complete && s.kind !== 'QUESTION' && s.words.length >= 4);
    if (!answer) return;
    const cleanQ = stripEdgePunct(cleanClause(q.text)).replace(/^[\p{L}]+,\s+(?=(?:how|why|what|do|does|did|is|are|can|could|should|would|will)\b)/iu, '');
    const text = cap(cleanQ) + '?';
    out.push({ type: 'QA', sentence: q.index, slots: { question: slot('QUESTION', text, q.index), answer: slot('CLAUSE', cleanClause(answer.text), answer.index) },
      strength: q.speaker !== answer.speaker ? .95 : .8, hedged: false, firstPerson: q.words.some(w => FIRST_PERSON.has(w)), speaker: q.speaker });
  });
  sentences.forEach((s, i) => {
    const prev = sentences[i - 1];
    if (!prev || !prev.complete || !s.complete || !s.speaker || s.speaker === prev.speaker || prev.kind === 'QUESTION') return;
    if (DISAGREE_OPENERS.test(s.text)) {
      const claim = takeClause(prev.text.replace(/[.!?]+$/u, ''));
      if (claim) out.push({ type: 'DISAGREEMENT', sentence: s.index, slots: { claim: slot('CLAUSE', claim, prev.index), reply: slot('CLAUSE', cleanClause(s.text), s.index) },
        strength: .8, hedged: false, firstPerson: false, speaker: prev.speaker });
    }
  });
  return out;
}

const NAME_OPENERS = new Set(['well', 'now', 'so', 'yeah', 'yep', 'okay', 'ok', 'oh', 'um', 'uh', 'like', 'also', 'because', 'but', 'and', 'hey', 'look', 'listen', 'see', 'right', 'sure', 'exactly',
  'maybe', 'actually', 'basically', 'honestly', 'anyway', 'then', 'first', 'second', 'third', 'finally', 'next', 'yes', 'no', 'wow', 'thanks', 'thank', 'please', 'today', 'tomorrow', 'yesterday',
  'what', 'when', 'where', 'why', 'how', 'who', 'which', 'if', 'for', 'it', 'there', 'here', 'this', 'that', 'these', 'those', 'they', 'we', 'you', 'he', 'she', 'my', 'our', 'your', 'their', 'some', 'every', 'all']);
/** Capitalised names exactly as written in the evidence. A sentence-initial capital proves nothing unless the word is capitalised elsewhere too. */
const properNames = (text: string) => {
  const found: string[] = [];
  // OCR text arrives line by line; a line break ends a name run as firmly as a full stop does.
  const sentences = text.split(/(?<=[.!?])\s+|\n+/u);
  const midCapitalised = new Set<string>();
  for (const sentence of sentences) splitTokens(sentence).forEach((token, i) => {
    const clean = token.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '');
    if (i > 0 && properToken(token) && clean.length >= 2) midCapitalised.add(clean.toLowerCase());
  });
  for (const sentence of sentences) {
    const tokens = splitTokens(sentence);
    let run: string[] = [];
    const flush = () => { if (run.length) found.push(run.join(' ')); run = []; };
    tokens.forEach((token, i) => {
      const clean = token.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '');
      const lowerClean = clean.toLowerCase();
      const title = /^(?:Mr|Mrs|Ms|Dr|Prof|Professor)$/u.test(clean);
      let ok = properToken(token) && clean.length >= 2 && !NAME_OPENERS.has(lowerClean) && !isFunctionWord(clean);
      if (ok && i === 0 && !title && !/^\p{Lu}{2,}$/u.test(clean) && !midCapitalised.has(lowerClean) && !properToken(tokens[1] ?? '')) ok = false;
      if (ok) run.push(clean); else flush();
      if (/[,;:]$/u.test(token)) flush();
    });
    flush();
  }
  // "Professor Randall Kennedy" keeps its title only when a name follows.
  return found.map(n => n.replace(/^(?:Mr|Mrs|Ms|Dr|Prof|Professor)$/u, '')).filter(n => n.length >= 2);
};

function claimScore(s: Sentence, topicWords: Set<string>, multi: boolean): number {
  if (!s.complete || s.kind === 'QUESTION') return -9;
  const words = s.words;
  let score = 0;
  const stems = contentStems(s.text);
  score += Math.min(3, stems.filter(w => topicWords.has(w)).length) * .8;
  if (/\b(?:is|are|should|need|needs|must|never|always|problem|key|reason|because|means|matters?|wrong|true|real)\b/iu.test(s.text)) score += 1.2;
  if (ABSOLUTES.test(s.text)) score += .8;
  if (/\d/u.test(s.text)) score += .4;
  if (HEDGES.test(s.text)) score -= 1.6;
  if (!s.standalone) score -= 1.4;
  if (multi && words.some(w => FIRST_PERSON.has(w))) score -= 1.2;
  if (words.length < 6) score -= 1.2; else if (words.length <= 22) score += .8; else if (words.length > 32) score -= 1.5;
  if (FILLERS.has(words[0])) score -= .4;
  return score;
}

/** Sentence-first analysis of the evidence. */
export function analyzeEvidence(evidence: FreeEvidence, precomputed?: Sentence[]): FreeAnalysis {
  const transcript = evidence.transcript || evidence.visibleText || '';
  const sentences = precomputed ?? sentencesFromText(transcript, evidence.speakerTurns?.length ? evidence.speakerTurns : undefined);
  const speakers = [...new Set(sentences.map(s => s.speaker).filter((s): s is string => !!s))];
  // Diarization labels of "unknown" carry no information. Without real labels an interview is recognised from its own wording.
  const realSpeakers = speakers.filter(s => !/^(?:unknown|speaker_?unknown|none|null|)$/iu.test(s));
  const dialogueCues = /\b(?:welcome (?:back )?to|my guest|our guest|thank(?:s| you) for having me|as you (?:said|mentioned|asked)|you asked|good question|great question|tell (?:us|me) about|nice to meet you|joining (?:me|us))\b/iu.test(transcript);
  const monologue = realSpeakers.length > 1 ? false : realSpeakers.length === 1 ? true : !dialogueCues;
  const evidenceText = [evidence.transcript, evidence.visibleText, evidence.visualSummary, evidence.sourceTitle, evidence.sourceCaption].filter(Boolean).join('\n');
  const { ranked, all } = rankPhrases(sentences, [evidence.visibleText ?? '']);
  const phrases = all;
  const topicWords = new Set(ranked.slice(0, 6).flatMap(r => contentStems(r.phrase)));
  const topic = ranked[0]?.phrase ?? '';
  const subtopic = ranked.find(r => lower(r.phrase) !== lower(topic) && !lower(r.phrase).includes(lower(topic)) && !lower(topic).includes(lower(r.phrase)))?.phrase ?? '';
  const frames: Frame[] = [...sentences.flatMap(s => framesOf(s, sentences)), ...qaFrames(sentences)];

  const claimCandidates = sentences.map(s => ({ s, score: claimScore(s, topicWords, !monologue) })).sort((a, b) => b.score - a.score || a.s.index - b.s.index);
  const best = claimCandidates[0]?.score > -5 ? claimCandidates[0].s : undefined;
  const mainClaim = best ? cleanClause(best.text) : '';
  const qa = frames.filter(f => f.type === 'QA').sort((a, b) => b.strength - a.strength)[0];
  const question = qa?.slots.question.text ?? sentences.find(s => s.kind === 'QUESTION' && s.complete && s.words.length >= 4)?.text ?? '';
  const answer = qa?.slots.answer.text ?? '';
  const conclusionFrame = [...frames].filter(f => f.type === 'CONCLUSION').sort((a, b) => b.sentence - a.sentence)[0];
  const lastStatement = [...sentences].reverse().find(s => s.complete && s.kind !== 'QUESTION' && s.words.length >= 4);
  const conclusion = conclusionFrame ? conclusionFrame.slots.line.text : '';
  const payoff = conclusion || (lastStatement ? cleanClause(lastStatement.text) : '');
  const contrastFrame = [...frames].filter(f => f.type === 'CONTRAST').sort((a, b) => b.strength - a.strength)[0];
  const tension = contrastFrame ? (contrastFrame.slots.claim?.text ?? `${contrastFrame.slots.a?.text ?? ''} / ${contrastFrame.slots.b?.text ?? ''}`) : '';
  const contrast = contrastFrame?.slots.a && contrastFrame.slots.b ? `not ${contrastFrame.slots.a.text}: ${contrastFrame.slots.b.text}` : '';
  const numbers: Array<{ text: string; context: string }> = [];
  for (const s of sentences) for (const token of splitTokens(s.text)) if (/\d/u.test(token) && numbers.length < 8) numbers.push({ text: token.replace(/[^\p{N}%.,$]/gu, ''), context: s.text.slice(0, 160) });
  const entities = [...new Set([...properNames(transcript), ...properNames(evidence.visibleText ?? ''), ...properNames(evidence.sourceTitle ?? '')])].slice(0, 12);
  const importantFacts = sentences.filter(s => s.complete && (/\d/u.test(s.text) || entities.some(e => s.text.includes(e)))).map(s => cleanClause(s.text)).slice(0, 5);
  const supportedClaims = claimCandidates.filter(c => c.score > 0).slice(0, 8).sort((a, b) => a.s.index - b.s.index).map(c => cleanClause(c.s.text));
  const importantPhrases = ranked.slice(0, 8).map(r => r.phrase);
  const keywords = ranked.slice(0, 12).map(r => r.phrase);
  const topicCounts = Object.fromEntries(ranked.slice(0, 20).map(r => [r.phrase.toLowerCase(), r.count]));

  // Participants: only what the turns themselves show.
  const questioning = new Set(sentences.filter((s, i) => s.kind === 'QUESTION' && sentences[i + 1] && sentences[i + 1].speaker !== s.speaker && s.speaker).map(s => s.speaker!));
  const answering = new Set(sentences.filter((s, i) => i > 0 && sentences[i - 1].kind === 'QUESTION' && sentences[i - 1].speaker !== s.speaker && s.speaker).map(s => s.speaker!));
  const hostSpoken = /\b(?:welcome (?:back )?to|my guest|our guest|today(?:'s)? guest|i['’]?m your host|joining me|joined by)\b/iu.test(transcript);
  const participants = speakers.map(id => ({ id,
    role: questioning.has(id) && !answering.has(id) ? (hostSpoken ? 'HOST' : 'INTERVIEWER') : answering.has(id) && !questioning.has(id) ? (hostSpoken ? 'GUEST' : 'INTERVIEWEE') : 'SPEAKER',
    evidence: questioning.has(id) || answering.has(id) ? 'diarized question and answer turn' : 'speaker diarization' }));

  const keyMoments: KeyMoment[] = frames.map(f => ({ kind: f.type, sentence: f.sentence, strength: f.strength,
    text: Object.values(f.slots).find(x => x.kind !== 'NUM' && x.text.length > 8)?.text ?? sentences[f.sentence]?.text ?? '',
    ...(sentences[f.sentence]?.start !== undefined ? { start: sentences[f.sentence].start } : {}), ...(sentences[f.sentence]?.end !== undefined ? { end: sentences[f.sentence].end } : {}) }))
    .sort((a, b) => b.strength - a.strength).slice(0, 24);
  const sceneContext = [evidence.sceneType, ...(evidence.visibleText ? ['on-screen text'] : [])].filter((v): v is string => !!v);
  return { version: FREE_ANALYSIS_VERSION, sentences, speakers, monologue, topic, subtopic, mainClaim, question, answer, tension, contrast, payoff, conclusion, importantFacts,
    importantPhrases, keywords, topicCounts, numbers, entities, supportedClaims, participants, sceneContext, phrases, frames, keyMoments, evidenceText };
}

export const analysisKey = (a: FreeAnalysis) => createHash('sha256').update(JSON.stringify({ v: a.version, t: a.evidenceText })).digest('hex');
export { cap as capitalize, isGenericWord as isGenericPhraseWord };

const analysisCache = new Map<string, FreeAnalysis>();
/** Analysis is deterministic per evidence, so each stage (understanding, hooks, boundaries, zoom) shares one computation. */
export function cachedAnalysis(evidence: FreeEvidence): FreeAnalysis {
  const key = createHash('sha256').update(JSON.stringify([FREE_ANALYSIS_VERSION, evidence.transcript, evidence.speakerTurns ?? null, evidence.visibleText ?? '', evidence.sourceTitle ?? ''])).digest('hex');
  const known = analysisCache.get(key);
  if (known) { analysisCache.delete(key); analysisCache.set(key, known); return known; }
  const fresh = analyzeEvidence(evidence);
  analysisCache.set(key, fresh);
  if (analysisCache.size > 200) analysisCache.delete(analysisCache.keys().next().value as string);
  return fresh;
}
