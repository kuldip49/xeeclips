import { FIRST_PERSON, SUBJECT_PRONOUNS, baseVerb, isGenericWord, isNounish, isNumberToken, isVerbForm, splitTokens, wordsOf } from './free-lexicon';
import { capitalize, cleanClause, type FreeAnalysis } from './free-analysis';
import { readable, simpleFallbackHook } from './free-hooks';
import { looksEnglish, type Sentence } from './free-sentences';
import { spokenRegister, topicTerms } from '../content-intelligence/content-understanding.service';
import type { CreativeDraft } from '../content-intelligence/creative-quality.service';

/**
 * Grounded synopsis, captions and hashtags for XeeFree. Every sentence is a span of the clip: either quoted verbatim (so the shared
 * factual check can verify it) or a lightly cleaned statement attributed to "the speaker". Nothing is invented, and a speaker is never
 * named: identity comes only from text, and "Speaker A/B" appears only when the transcript itself carries separate speaker labels.
 */
const SENTENCE_END = /[.!?]+$/u;
const trimTo = (value: string, max: number) => {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const at = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' — '));
  return (at > max * .55 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(' '))).replace(/[,;:\s]+$/u, '');
};
const TERMINAL_MARK = /[.!?।॥]+$/u;
const sentence = (value: string) => { const raw = cleanClause(value).trim(); const mark = raw.match(TERMINAL_MARK)?.[0] ?? ''; const v = raw.replace(TERMINAL_MARK, '').trim(); return v ? capitalize(v) + (/[।॥]/u.test(mark) ? '।' : '.') : ''; };
const HINGLISH_STOP = new Set(['jab', 'tab', 'maine', 'humne', 'hum', 'tum', 'aap', 'yeh', 'ye', 'woh', 'wo', 'kya', 'kab', 'kaise', 'kyun', 'aur', 'ya', 'par', 'lekin', 'se', 'ko', 'ka', 'ki', 'ke', 'me', 'mein', 'hai', 'hain', 'tha', 'thi', 'the', 'ho', 'hoga', 'hogi', 'nahi', 'nahin', 'mat', 'bhi', 'hi', 'toh', 'to', 'ek', 'kuch', 'sab', 'har', 'apne', 'apni', 'apna', 'mera', 'meri', 'tera', 'teri', 'uska', 'uski', 'mila', 'liye', 'karna', 'karke', 'kiya', 'kisi', 'peeche', 'zaroori', 'better']);
const firstPerson = (value: string) => wordsOf(value).some(w => FIRST_PERSON.has(w));
const startsUnresolved = (s: Sentence) => /^(?:he|she|they|him|her|them|his|their|it|its|this|that|these|those|and|but|because|which|so)\b/iu.test(s.text);

function speakerLabel(analysis: FreeAnalysis, s: Sentence) {
  const real = analysis.speakers.filter(x => !/^(?:unknown|none|null|)$/iu.test(x));
  if (real.length < 2 || !s.speaker) return 'The speaker';
  return `Speaker ${String.fromCharCode(65 + Math.max(0, real.indexOf(s.speaker)))}`;
}

/** One synopsis line for a sentence: a verbatim quote when it reads cleanly, an attributed paraphrase for a plain third-person statement. */
function describe(analysis: FreeAnalysis, s: Sentence, verb: 'says' | 'explains' | 'asks' | 'concludes'): string {
  const who = speakerLabel(analysis, s);
  const verbatim = s.text.trim();
  // Another language is quoted as spoken, with no English connective wording around it.
  if (!looksEnglish(s.words)) return `“${verbatim}”`;
  if (s.kind === 'QUESTION') return `${who} asks: “${verbatim}”`;
  const first = wordsOf(verbatim)[0] ?? '';
  // A paraphrase ("The speaker explains that ...") is only safe for a plain third-person statement with its own noun subject.
  const paraphrasable = !startsUnresolved(s) && !firstPerson(verbatim) && wordsOf(verbatim).length <= 24 && !SUBJECT_PRONOUNS.has(first)
    && !/^(?:let's|let|there's|here's|that's|it's|this|you|your|please|okay|well|yes|no)$/u.test(first) && !(isVerbForm(first) && baseVerb(first) === first);
  if (paraphrasable) {
    const clause = cleanClause(verbatim).replace(TERMINAL_MARK, '');
    const said = verb === 'concludes' ? 'concludes' : verb === 'asks' ? 'says' : verb;
    return `${who} ${said} that ${clause.charAt(0).toLowerCase() + clause.slice(1)}.`;
  }
  return `${who} ${verb === 'asks' ? 'says' : verb === 'concludes' ? 'ends with' : verb}: “${verbatim}”`;
}

export function freeSynopsis(analysis: FreeAnalysis): string {
  const usable = analysis.sentences.filter(s => s.complete && s.words.length >= 4 && readable(s));
  if (!usable.length) return '';
  const used = new Set<number>();
  const take = (s: Sentence | undefined) => { if (!s || used.has(s.index) || !usable.includes(s)) return undefined; used.add(s.index); return s; };
  const bySentence = (index: number | undefined) => usable.find(s => s.index === index);
  const paragraphs: string[] = [];
  const qa = analysis.frames.find(f => f.type === 'QA');
  const claimSentence = usable.find(s => cleanClause(s.text) === analysis.mainClaim);
  const opening = take(bySentence(qa?.sentence)) ?? take(claimSentence) ?? take(usable[0]);
  if (opening) paragraphs.push(describe(analysis, opening, opening.kind === 'QUESTION' ? 'asks' : 'explains'));
  const support = analysis.frames.filter(f => ['REASON', 'CONTRAST', 'LEAD', 'ADVICE', 'NUMBER', 'CONDITION', 'MYTH', 'STORY'].includes(f.type)).sort((a, b) => b.strength - a.strength);
  const dev: Sentence[] = [];
  for (const f of support) { const s = take(bySentence(f.sentence)); if (s) dev.push(s); if (dev.length >= 2) break; }
  if (!dev.length) { const next = take(usable.find(s => !used.has(s.index) && s.index > (opening?.index ?? -1))); if (next) dev.push(next); }
  if (dev.length) paragraphs.push(dev.map(s => describe(analysis, s, 'says')).join(' '));
  const closingText = analysis.conclusion || analysis.payoff;
  const closing = take(usable.find(s => cleanClause(s.text) === closingText)) ?? take([...usable].reverse().find(s => !used.has(s.index)));
  if (closing) paragraphs.push(describe(analysis, closing, 'concludes'));
  return paragraphs.filter(Boolean).join('\n\n');
}

const tagFor = (phrase: string) => {
  const raw = splitTokens(phrase).map(t => t.replace(/[^\p{L}\p{M}\p{N}]/gu, '')).filter(t => t && !/^\d+$/u.test(t));
  if (!raw.length || raw.length > 3) return '';
  const out = raw.map(p => /^\p{Lu}.*\p{Lu}/u.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
  return /^[\p{L}\p{M}\p{N}_]{3,30}$/u.test(out) ? '#' + out : '';
};
const NOT_A_TAG = new Set(['there', 'here', 'first', 'second', 'third', 'fourth', 'fifth', 'finally', 'lastly', 'next', 'another', 'every', 'always', 'never', 'sometimes', 'something', 'anything', 'everything', 'nothing', 'because', 'before', 'after', 'while', 'when', 'where', 'which', 'would', 'could', 'should', 'about', 'around', 'really', 'still', 'again', 'maybe', 'stop', 'start', 'make', 'made', 'takes', 'take', 'goes', 'went']);
const BANNED_TAG = /^#(?:viral|fyp|foryou|trending|reels|shorts|thing|things|people|job|time|way|lot|man|kind|part|point|case|place|world|life|day|year)$/iu;
/** Words that are almost always modifiers, never a subject worth a hashtag (no part-of-speech tagger, so a short stoplist stands in). */
const WEAK_TAG_WORDS = new Set(['entire', 'whole', 'same', 'other', 'different', 'real', 'hidden', 'safe', 'good', 'bad', 'great', 'best', 'better', 'worse', 'worst', 'important', 'certain',
  'sure', 'early', 'late', 'free', 'full', 'hard', 'easy', 'possible', 'likely', 'enough', 'right', 'wrong', 'big', 'small', 'large', 'little', 'long', 'short', 'high', 'low', 'new', 'old', 'first',
  'last', 'next', 'single', 'simple', 'actual', 'main', 'major', 'huge', 'true', 'false', 'clear', 'open', 'close', 'ready', 'common', 'special', 'particular', 'general', 'own', 'next']);

export function freeHashtags(analysis: FreeAnalysis): string[] {
  const unique: string[] = [];
  const add = (t: string) => { if (t && !BANNED_TAG.test(t) && !unique.some(u => u.toLowerCase() === t.toLowerCase())) unique.push(t); };
  // Hindi / Hinglish / other scripts: the English noun-phrase model does not apply, so use the frequency terms (with the shared Hindi stop list).
  if (spokenRegister(analysis.sentences.map(s => s.text).join(' ')) !== 'English') {
    for (const term of topicTerms(analysis.sentences.map(s => s.text).join(' '))) { if (!HINGLISH_STOP.has(term.toLowerCase())) add(tagFor(term)); if (unique.length >= 6) break; }
    return unique;
  }
  const weak = (phrase: string) => wordsOf(phrase).some(w => WEAK_TAG_WORDS.has(w)) && wordsOf(phrase).length === 1;
  // A tag is a thing, not a number, an ordinal or a stray adverb; and "reasons startups" / "founders stop" are two nouns or a noun and a verb glued
  // together by the phrase chunker, not a name anybody searches for.
  const plural = (w: string) => /[^s]s$/u.test(w) && !/(?:ss|us|is|ics|ness)$/u.test(w);
  const usable = (phrase: string) => {
    const w = wordsOf(phrase);
    if (w.some(x => isNumberToken(x) || NOT_A_TAG.has(x))) return false;
    if (w.length === 2 && plural(w[0])) return false;
    return !weak(phrase);
  };
  for (const e of analysis.entities) add(tagFor(e));
  for (const k of analysis.keywords) if (usable(k) && !wordsOf(k).some(w => WEAK_TAG_WORDS.has(w) && wordsOf(k).indexOf(w) === wordsOf(k).length - 1)) add(tagFor(k));
  if (unique.length < 4) {
    // Sparse clip: the most frequent specific nouns, so the three tag sets are never empty.
    const counts = new Map<string, { word: string; n: number }>();
    for (const s of analysis.sentences) for (const w of splitTokens(s.text)) {
      const bare = w.replace(/[^\p{L}\p{N}'’-]/gu, '');
      if (bare.length < 4 || !isNounish(bare) || isGenericWord(bare) || WEAK_TAG_WORDS.has(bare.toLowerCase()) || NOT_A_TAG.has(bare.toLowerCase()) || isNumberToken(bare)) continue;
      const key = bare.toLowerCase(), cur = counts.get(key) ?? { word: bare, n: 0 };
      cur.n++; counts.set(key, cur);
    }
    for (const { word } of [...counts.values()].sort((a, b) => b.n - a.n)) add(tagFor(word));
  }
  return unique;
}

/** A question to the audience. It names a topic only when the clip clearly dwells on one (a name, or a phrase said at least twice). */
const audienceQuestion = (analysis: FreeAnalysis) => {
  const topic = analysis.entities[0] ?? analysis.keywords.find(k => {
    const w = wordsOf(k);
    return w.length <= 3 && isNounish(w.at(-1)!) && !isGenericWord(w.at(-1)!) && !WEAK_TAG_WORDS.has(w[0]) && (analysis.topicCounts[k.toLowerCase()] ?? 0) >= 2;
  });
  return topic ? `What is your experience with ${topic}?` : 'What do you think?';
};

const audienceFriendlyTopic = (analysis: FreeAnalysis) => {
  const words = wordsOf(analysis.topic);
  return words.length >= 1 && words.length <= 3 && !WEAK_TAG_WORDS.has(words[0]) && !isGenericWord(words.at(-1)!) && (analysis.topicCounts[analysis.topic.toLowerCase()] ?? 0) >= 2;
};
const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/**
 * Five caption styles built from distinct lines of the clip. `avoid` holds the hook texts: a caption never repeats a hook (the package
 * would drop it), so a line already used as a hook is replaced by another line, or decorated with an audience prompt.
 */
export function freeCaptions(analysis: FreeAnalysis, avoid: string[] = []): CreativeDraft['captions'] {
  const blocked = new Set(avoid.map(norm));
  if (spokenRegister(analysis.sentences.map(s => s.text).join(' ')) !== 'English') {
    // No English decoration ("What do you think?") on another language: distinct plain lines of the clip, in the five styles.
    const lines = [analysis.mainClaim, analysis.payoff, ...analysis.supportedClaims].map(c => cleanClause(c)).filter((c, i, a) => c && a.indexOf(c) === i && !blocked.has(norm(c)));
    const styles: CreativeDraft['captions'][number]['style'][] = ['Concise', 'Engaging', 'Professional', 'Conversational', 'Bold'];
    return lines.slice(0, 5).map((text, i) => ({ style: styles[i], text: sentence(text) }));
  }
  const readableLine = (value: string) => analysis.sentences.some(s => cleanClause(s.text) === value && readable(s));
  // Prefer a cleanly readable claim/payoff; otherwise the best complete, standalone statement of the clip, so a rambling clip still
  // gets grounded captions rather than none.
  const fallback = analysis.sentences.filter(s => s.standalone && s.kind !== 'QUESTION' && s.words.length >= 5 && s.words.length <= 30).map(s => cleanClause(s.text))[0] ?? '';
  const claim = readableLine(analysis.mainClaim) ? cleanClause(analysis.mainClaim) : fallback;
  const payoff = readableLine(analysis.payoff) ? cleanClause(analysis.payoff) : fallback;
  const line = (value: string, max: number) => { const t = trimTo(sentence(value).replace(/\.$/u, ''), max); return t ? t + '.' : ''; };
  const question = audienceQuestion(analysis);
  const anchor = payoff || claim;
  const others = analysis.supportedClaims.map(c => cleanClause(c)).filter(c => c && analysis.sentences.some(s => cleanClause(s.text) === c && readable(s)));
  const pool = [claim, anchor, ...others].filter((c, i, a) => c && a.indexOf(c) === i);
  const free = (exclude: string[] = []) => pool.find(c => !blocked.has(norm(line(c, 200))) && !exclude.includes(c));
  const out: CreativeDraft['captions'] = [];
  const used: string[] = [];
  const concise = free();
  if (concise) { out.push({ style: 'Concise', text: line(concise, 140) }); used.push(concise); }
  if (claim) out.push({ style: 'Engaging', text: [line(claim, 180), question].filter(Boolean).join('\n\n') });
  const professionalLine = anchor ?? claim;
  if (analysis.topic && professionalLine && audienceFriendlyTopic(analysis) && !professionalLine.toLowerCase().startsWith(analysis.topic.toLowerCase()))
    out.push({ style: 'Professional', text: `${capitalize(analysis.topic)}: ${trimTo(cleanClause(professionalLine).replace(SENTENCE_END, ''), 180)}.` });
  else {
    // No clean topic label: a different line of the clip, never filler.
    const alternate = pool.find(c => c !== concise && !blocked.has(norm(line(c, 200))));
    if (alternate) out.push({ style: 'Professional', text: line(alternate, 170) });
    else if (professionalLine) out.push({ style: 'Professional', text: `Key point: ${line(professionalLine, 160)}` });
  }
  if (anchor) out.push({ style: 'Conversational', text: [line(anchor, 160), question === 'What do you think?' ? 'Does this match what you have seen?' : question].join('\n\n') });
  const boldLine = free(used) ?? claim;
  if (boldLine) out.push({ style: 'Bold', text: blocked.has(norm(line(boldLine, 140))) || used.includes(boldLine) ? `${line(boldLine, 120)}\n\nAgree or disagree?` : line(boldLine, 140) });
  return out.filter((c, i, a) => c.text && !blocked.has(norm(c.text)) && a.findIndex(o => norm(o.text) === norm(c.text)) === i);
}

export function freeDraftCopy(analysis: FreeAnalysis, avoid: string[] = []): Omit<CreativeDraft, 'hooks'> {
  const tags = freeHashtags(analysis);
  const reliable = analysis.sentences.filter(s => s.standalone && readable(s) &&
    !startsUnresolved({ ...s, text: cleanClause(s.text) }));
  const fallback = reliable.length ? null : simpleFallbackHook(analysis, { transcript: analysis.evidenceText });
  if (fallback) {
    // When ASR joins many clauses into a rambling sentence, reuse the literal
    // clause that passed every hook gate as attributed copy. Do not manufacture
    // a synopsis from dangling references such as "it's not just that".
    const quote = fallback.text.replace(/[.!?]+$/u, '');
    return { synopsis: `The speaker says: “${quote}.”`,
      captions: [
        { style: 'Professional', text: `The speaker says: “${quote}.”` },
        { style: 'Engaging', text: `“${quote}.”\n\n${audienceQuestion(analysis)}` }
      ], hashtagSets: [{ label: 'Focused', hashtags: tags.slice(0, 5) },
        { label: 'Niche', hashtags: tags.slice(1, 6).length ? tags.slice(1, 6) : tags.slice(0, 1) },
        { label: 'Broad', hashtags: tags.slice(0, 3) }], supportingLine: '' };
  }
  return { synopsis: freeSynopsis(analysis), captions: freeCaptions(analysis, avoid),
    hashtagSets: [{ label: 'Focused', hashtags: tags.slice(0, 5) }, { label: 'Niche', hashtags: tags.slice(1, 6).length ? tags.slice(1, 6) : tags.slice(0, 1) },
      { label: 'Broad', hashtags: tags.slice(0, 3) }], supportingLine: '' };
}
