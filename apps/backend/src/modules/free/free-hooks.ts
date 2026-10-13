import { HEDGES, DETERMINERS, FILLERS, baseVerb, isGerund, FIRST_PERSON, GENERIC_WORDS, NEGATIONS, PREPOSITIONS, QUESTION_WORDS, THIRD_PERSON_PRONOUNS, contentStems, isFunctionWord, isGenericWord,
  isNounish, isNumberToken, isVerbForm, lower, splitTokens, stem, wordsOf } from './free-lexicon';
import { capitalize, cleanClause, isBaseVerbPhrase, isClause, type FreeAnalysis, type Frame, type FrameType, type Slot, type SlotKind } from './free-analysis';
import { hookLanguageProblems } from '../content-intelligence/hook-language';
import { inventedNames, type HookCategory } from '../content-intelligence/creative-quality.service';
import { spokenRegister, type ContentEvidence } from '../content-intelligence/content-understanding.service';

/**
 * XeeFree hook engine.
 *
 * Hooks are NOT built from frequent transcript words dropped into a template. Each candidate is bound to a typed frame found in the
 * clip (a reason, a contrast, a question that the clip answers, a "mistake is..." statement...) and every template slot only accepts a
 * span of the right grammatical type taken whole from the transcript: a CLAUSE slot a finite clause with its own subject, a VP slot a
 * phrase that starts with a base verb, an NP slot a noun phrase with a non-generic head. A span that does not fit its slot cannot
 * be placed, so "What's behind tell and reason?" is unconstructible rather than merely filtered.
 *
 * Every candidate must then pass twelve deterministic checks. There is no model reviewer, so the checks are structural and strict;
 * when nothing clever passes, the clearest grounded hook wins ("clear > fancy").
 */
export const FREE_HOOK_GATES = ['GRAMMAR_OK', 'MEANING_CLEAR', 'CONTEXT_COMPLETE', 'GROUNDED', 'NO_WORD_SALAD', 'NO_DANGLING_PRONOUN', 'NO_TRANSCRIPT_COPY',
  'NO_UNSUPPORTED_NAME', 'NO_UNSUPPORTED_NUMBER', 'NO_MISLEADING_CLAIM', 'NATURAL_HEADLINE', 'CLICKABLE_ENOUGH'] as const;
export type FreeHookGateName = typeof FREE_HOOK_GATES[number];
export type FreeHookGate = Record<FreeHookGateName, boolean>;

export type HookSlotRef = { type: SlotKind; text: string; sentence: number };
export type FreeHookCandidate = { text: string; category: HookCategory; family: string; template: string; slots: HookSlotRef[]; frame: FrameType;
  hedged: boolean; copyAllowed: boolean; firstPerson: boolean; /** The clip itself supplies the answer to the question this hook asks. */ answered?: boolean };
export type FreeHookScores = { clarity: number; specificity: number; clickability: number; novelty: number; context: number; grounding: number; misleadingRisk: number };
export type FreeHook = FreeHookCandidate & { gate: FreeHookGate; failed: FreeHookGateName[]; detail: string[]; scores: FreeHookScores; composite: number; passed: boolean; templateFit?: boolean };

/** Words a template contributes. They are not evidence-bearing, so they are exempt from the grounding comparison. */
const TEMPLATE_WORDS = new Set(['why', 'how', 'what', 'happens', 'happened', 'when', 'if', 'after', 'the', 'real', 'reason', 'truth', 'about', 'is', 'it', 'true', 'that', 'myth',
  'to', 'not', 'but', 'instead', 'of', 'never', 'stop', 'avoid', "don't", 'dont', 'mistake', 'turns', 'out', 'from', 'a', 'an', 'you', 'your', 'do', 'does', 'did', 'and', 'because',
  'lesson', 'problem', 'key', 'secret', 'trap', 'rule', 'difference', 'answer', 'risk', 'danger', 'goal', 'issue', 'challenge', 'catch', 'surprise', 'unexpected', 'it\'s', 'its']);
const SHOCK_WORDS = /\b(?:shocking|shocked|secret|exposed|exposes|expose|insane|crazy|unbelievable|devastating|destroyed|destroys|nobody|no one|everyone|everybody|always|never|worst|best|only|guaranteed|proof|proven|scam|lie|lies|liar|fraud|illegal|banned)\b/giu;
const HEADLINE_BAD_WORDS = /\b(?:um|uh|uhh|umm|erm|gonna|wanna|gotta|kinda|sorta|yeah|yep|okay|ok|y'know|like,|you know|i mean|basically|literally|whatever|blah)\b/iu;
const PROFANITY = /\b(?:fuck\w*|shit\w*|bitch\w*|bastard\w*|asshole\w*|ass|dick\w*|pussy|cunt\w*|whore\w*|slut\w*|nigg\w*|fag\w*|retard\w*|damn\w*|crap\w*|piss\w*|bullshit)\b/iu;
const LIKE_BEFORE = new Set(['would', 'do', 'does', 'did', "don't", "doesn't", "didn't", 'looks', 'looked', 'look', 'feels', 'felt', 'feel', 'seems', 'seem', 'sounds', 'sound', 'something', 'anything', 'nothing',
  'everything', 'just', 'more', 'much', 'exactly', 'treat', 'treated', 'act', 'acts', 'acted', 'behave', 'behaves', 'taste', 'tastes', 'smell', 'smells', 'really', 'very', 'so', 'not', 'never', 'someone',
  'anyone', 'everyone', 'nobody', 'somebody', 'things', 'stuff', 'people', 'you', 'we', 'i', 'they', 'would', 'might', 'could', 'should', 'a', 'an', 'works', 'work', 'think', 'thinks']);
const LIKE_AFTER = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'our', 'their', 'me', 'you', 'him', 'us', 'them', 'it', 'someone', 'something', 'anyone', 'everyone', 'nothing']);
/** "like" as a filler ("going to be like", "to like offend") rather than a verb or a comparison. Conservative: doubtful uses are rejected. */
const fillerLike = (words: string[]) => words.some((w, i) => w === 'like' && !LIKE_BEFORE.has(words[i - 1] ?? '') && !LIKE_AFTER.has(words[i + 1] ?? ''))
  || words.at(-1) === 'like';
const WEAK_END = new Set(['like', 'kind', 'sort', 'such', 'and', 'but', 'or', 'because', 'so', 'if', 'when', 'while', 'that', 'which', 'who', 'to', 'of', 'for', 'with', 'from', 'by', 'at', 'in', 'on', 'the', 'a', 'an',
  'my', 'your', 'his', 'her', 'its', 'our', 'their', 'is', 'are', 'was', 'were', 'than', 'as', 'about', 'into', 'then', 'also', 'not', 'no', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should']);
const NUMBER_EQUIVALENT: Record<string, string> = { '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten', '11': 'eleven', '12': 'twelve', '20': 'twenty', '100': 'hundred' };

const norm = (value: string) => wordsOf(value).join(' ');
const tail = (clause: string) => clause.replace(/[.!?]+$/u, '');

/** A span placed after a template word must not keep a sentence-initial capital unless the word is genuinely proper in the transcript. */
function fitCase(span: string, transcript: string): string {
  const first = splitTokens(span)[0] ?? '';
  const bare = first.replace(/[^\p{L}'’-]/gu, '');
  if (!bare || bare === 'I' || /^I['’]/u.test(bare) || /^\p{Lu}{2,}$/u.test(bare)) return span;
  const asProper = new RegExp(`(?<=[a-z,;:)] )${bare}\\b`, 'u');
  if (asProper.test(transcript)) return span;
  return span.charAt(0).toLowerCase() + span.slice(1);
}
const slotRef = (slot: Slot): HookSlotRef => ({ type: slot.kind, text: slot.text, sentence: slot.sentence });
const SUBORDINATORS = /^(?:if|when|because|although|though|while|since|as|after|before|once|unless|whereas|whether|until|so that|even if|even though)\b/iu;
/**
 * Shortens a long statement to its main clause. A fragment that is only a subordinate lead-in ("If you may recall yesterday") is never
 * returned as if it were the point of the sentence: the main clause is chosen, or the whole statement is kept for the gate to judge.
 */
const compressClause = (clause: string, maxWords = 16): string => {
  const value = cleanClause(tail(clause));
  if (wordsOf(value).length <= maxWords) return value;
  for (const cut of [/;\s+/u, /\s+[—–-]\s+/u, /,\s+(?:and|but|so|because|which|while)\s+/iu, /,\s+/u, /\s+and\s+(?=(?:the|a|an|my|your|our|their|most|many|some|every)?\s*\p{L}+\s+\p{L}+\s+\p{L}+)/iu]) {
    const pieces = value.split(cut).map(p => cleanClause(p)).filter(Boolean);
    if (pieces.length < 2) continue;
    // A bare comma only separates clauses when what follows is itself a clause ("in small, cheap ways" is one phrase, not two).
    if (cut.source === ',\s+' && !pieces.slice(1).every(p => isClause(p))) continue;
    const usable = pieces.filter(p => isClause(p) && wordsOf(p).length >= 5 && wordsOf(p).length <= maxWords && !SUBORDINATORS.test(p));
    if (usable.length) return usable.sort((a, b) => wordsOf(b).length - wordsOf(a).length)[0];
  }
  return value;
};

const AUX_INVERT = new Set(['is', 'are', 'was', 'were', 'am', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', "don't", "doesn't", "didn't", "can't", "won't", "isn't", "aren't", "wasn't", "weren't", "couldn't", "shouldn't", "wouldn't", "haven't", "hasn't"]);
const PRE_VERB_ADVERBS = new Set(['never', 'always', 'really', 'just', 'also', 'still', 'often', 'rarely', 'usually', 'even', 'only', 'ever', 'already', 'actually']);
/**
 * "most startups fail" -> "do most startups fail"; "the plan backfired" cannot be inverted safely (unknown base form) and returns null.
 * Subject-verb inversion needs the verb's base form, so it is attempted only for verbs the lexicon knows; otherwise the embedded form
 * ("Why most startups fail") is used instead of a guess.
 */
export function invertClause(clause: string): string | null {
  const tokens = splitTokens(tail(clause));
  // An auxiliary wins; otherwise the first PURE verb. A word that is also a common noun ("market", "work", "plan") is not trusted as the verb.
  // The main verb is the EARLIEST auxiliary or pure verb ("confusion means they are bad": "means", not the later "are").
  const at = tokens.findIndex((token, i) => i > 0 && (AUX_INVERT.has(lower(token)) || (isVerbForm(token) && !isNounish(token) && !DETERMINERS.has(lower(token)))));
  if (at < 1 || at > 6) return null;
  const subject = tokens.slice(0, at), verb = tokens[at], rest = tokens.slice(at + 1);
  if (subject.some(t => /[,;:]/u.test(t) || PRE_VERB_ADVERBS.has(lower(t)) || /^(?:and|or|but|because|that|which|who)$/iu.test(t))) return null;
  if (!subject.some(t => isNounish(t) || /^(?:i|you|we|they|people|everyone|nobody|everybody)$/iu.test(t))) return null;
  if (rest.length && PRE_VERB_ADVERBS.has(lower(rest[0])) && !AUX_INVERT.has(lower(verb))) return null;
  const v = lower(verb);
  const lastSubject = lower(subject.at(-1)!);
  let head: string;
  if (AUX_INVERT.has(v)) head = v;
  else if (baseVerb(v) === v && (/^(?:i|you|we|they|people)$/u.test(lastSubject) || /s$/u.test(lastSubject))) head = 'do';
  else if (baseVerb(v) && baseVerb(v) !== v && /s$/u.test(v) && !/ed$/u.test(v) && !/(?:ss|us|is)$/u.test(v) && !/s$/u.test(lastSubject)) head = 'does';
  else if (baseVerb(v) && baseVerb(v) !== v && !/s$/u.test(v)) head = 'did';
  else return null;
  const main = AUX_INVERT.has(v) ? [] : [baseVerb(v) ?? v];
  return [head, ...subject, ...main, ...rest].join(' ');
}

type Draft = { text: string; category: HookCategory; family: string; template: string; slots: HookSlotRef[]; frame: Frame; copyAllowed?: boolean; answered?: boolean };

/** Explicit pushback after a claim makes its premise disputed, even when
 * local diarization assigns the exchange to one speaker. */
function disputedEffect(analysis: FreeAnalysis, effect: Slot): boolean {
  const sentence = analysis.sentences.findIndex(s => s.index === effect.sentence);
  return sentence >= 0 && analysis.sentences.slice(sentence + 1, sentence + 3).some(s =>
    /^(?:i disagree\b|i (?:do not|don't) agree\b|that(?:'s| is) (?:wrong|false|not true)\b)/iu.test(s.text));
}

function draftsFor(frame: Frame, analysis: FreeAnalysis): Draft[] {
  const out: Draft[] = [];
  const t = analysis.evidenceText;
  const add = (category: HookCategory, family: string, template: string, parts: Array<string | (Slot & { shown?: string })>, extra: Partial<Draft> = {}) => {
    const slots = parts.filter((p): p is Slot & { shown?: string } => typeof p !== 'string');
    const text = parts.map(p => typeof p === 'string' ? p : p.shown ?? p.text).join('').replace(/\s+/gu, ' ').trim();
    out.push({ text, category, family, template, slots: slots.map(slotRef), frame, ...extra });
  };
  const cased = (slot: Slot): Slot => ({ ...slot, text: fitCase(tail(slot.text), t) });
  const S = frame.slots;
  switch (frame.type) {
    case 'QA': {
      const q = S.question;
      if (q) add('QUESTION', 'Question', 'QUOTED_QUESTION', [{ ...q, text: q.text }], { copyAllowed: true });
      break;
    }
    case 'REASON': {
      const effect = S.effect && cased(S.effect), cause = S.cause && cased(S.cause);
      if (!effect) break;
      if (disputedEffect(analysis, effect)) {
        const inverted = invertClause(effect.text);
        if (inverted) add('QUESTION', 'Question', 'DISPUTED_CLAIM_QUESTION',
          [{ ...effect, shown: capitalize(inverted) }, '?'], { answered: true });
        break;
      }
      add('CURIOSITY', 'Curiosity Gap', 'WHY_CLAUSE', ['Why ', effect]);
      if (/\breason\b/iu.test(t)) add('CURIOSITY', 'Curiosity Gap', 'REAL_REASON', ['The real reason ', effect]);
      if (cause) {
        add('BOLD', 'Bold Claim', 'CLAUSE_BECAUSE_CLAUSE', [capitalize(effect.text) === effect.text ? effect : { ...effect, text: capitalize(effect.text) }, ' because ', cause]);
        const inverted = invertClause(effect.text);
        if (inverted) add('QUESTION', 'Question', 'WHY_DO_CLAUSE_Q', ['Why ', { ...effect, shown: inverted }, '?'], { answered: true });
        add('CURIOSITY', 'Curiosity Gap', 'HERES_WHY', ["Here's why ", effect]);
      }
      break;
    }
    case 'LEAD': {
      const lead = S.lead, rest = S.rest, head = S.head?.text ?? '';
      if (!lead || !rest) break;
      const category: HookCategory = head === 'mistake' ? 'MISTAKE' : /^(?:problem|issue|trap|risk|danger|catch|downside|challenge)$/u.test(head) ? 'WARNING'
        : /^(?:secret|truth|answer|difference|reason)$/u.test(head) ? 'HIDDEN_TRUTH' : head === 'myth' ? 'MYTH_REALITY' : 'AUTHORITY';
      add(category, category === 'MISTAKE' ? 'Mistake' : category === 'WARNING' ? 'Warning' : category === 'HIDDEN_TRUTH' ? 'Hidden Truth' : 'Advice', 'LEAD_COLON_REST',
        [{ ...lead, text: capitalize(lead.text) }, ': ', { ...rest, text: tail(rest.text) }]);
      break;
    }
    case 'CONTRAST': {
      if (S.a && S.b) {
        const a = { ...S.a, text: tail(S.a.text) }, b = { ...S.b, text: tail(S.b.text) };
        if (S.instead) add('CONTRARIAN', 'Contrarian', 'B_INSTEAD_OF_A', [{ ...b, text: capitalize(b.text) }, ' instead of ', a]);
        else {
          add('CONTRARIAN', 'Contrarian', 'ITS_NOT_A_ITS_B', ["It's not ", a, ", it's ", b]);
          add('CONTRARIAN', 'Contrarian', 'NOT_A_BUT_B', ['Not ', a, ' but ', b]);
        }
      } else if (S.claim && isClause(S.claim.text)) {
        if (S.turnB && wordsOf(S.turnB.text).length <= 10) add('UNEXPECTED_RESULT', 'Unexpected Result', 'THE_TURN', [{ ...S.turnB, text: capitalize(tail(S.turnB.text)) }], { copyAllowed: true });
        if (wordsOf(S.claim.text).length <= 14) add('TENSION', 'Tension', 'IS_IT_TRUE', ['Is it true that ', cased(S.claim), '?']);
      }
      break;
    }
    case 'CONDITION': {
      const cond = S.cond && cased(S.cond), marker = (S.marker?.text ?? 'when').toLowerCase();
      if (!cond) break;
      // "What happens if the market crashes" needs a present-tense condition; a past one ("if the example worked") reads as a story, so it is
      // either asked in the past ("What happened when ...") or not asked at all ("if").
      const verb = wordsOf(cond.text).find((w, i) => i > 0 && (isVerbForm(w) && !isGerund(w) || /^(?:was|were|did|had)$/u.test(w))) ?? '';
      const past = /^(?:was|were|did|had)$/u.test(verb) || (!!baseVerb(verb) && baseVerb(verb) !== verb && !/s$/u.test(verb));
      if (past && marker === 'if') break;
      add('TENSION', 'Tension', 'WHAT_HAPPENS_WHEN', [past ? 'What happened when ' : marker === 'if' ? 'What happens if ' : 'What happens when ', cond]);
      break;
    }
    case 'ADVICE': {
      const vp = S.vp && { ...S.vp, text: tail(S.vp.text) };
      if (!vp) break;
      const first = lower(vp.text.split(' ')[0]);
      if (first === 'never' || first === 'not') break;
      add('AUTHORITY', 'Advice', 'HOW_TO_VP', ['How to ', { ...vp, text: fitCase(vp.text, t) }]);
      break;
    }
    case 'WARNING': {
      const vp = S.vp && { ...S.vp, text: tail(S.vp.text) };
      if (vp && S.lead) add('WARNING', 'Warning', 'LEAD_VP', [S.lead.text + ' ', { ...vp, text: fitCase(vp.text, t) }]);
      else if (S.claim && isClause(S.claim.text)) add('WARNING', 'Warning', 'WARNING_CLAIM', [{ ...S.claim, text: compressClause(S.claim.text) }], { copyAllowed: true });
      break;
    }
    case 'NUMBER': {
      const phrase = S.phrase, claim = S.claim;
      if (phrase) {
        const compressed = compressClause(phrase.text, 14);
        add(S.noun?.text === 'mistakes' ? 'MISTAKE' : 'BOLD', S.noun?.text === 'mistakes' ? 'Mistake' : 'Bold Claim', isClause(compressed) ? 'NUMBER_CLAUSE' : 'NUMBER_PHRASE',
          [{ ...phrase, text: capitalize(compressed) }], { copyAllowed: true });
      }
      if (claim) add('BOLD', 'Bold Claim', 'NUMBER_CLAIM', [{ ...claim, text: capitalize(compressClause(claim.text, 16)) }], { copyAllowed: true });
      break;
    }
    case 'REVEAL': {
      const marker = S.marker?.text ?? '', rest = S.rest && { ...S.rest, text: tail(S.rest.text) }, phrase = S.phrase;
      if (/turns? out/iu.test(marker) && rest) add('UNEXPECTED_RESULT', 'Unexpected Result', 'TURNS_OUT', ['Turns out, ', { ...rest, text: fitCase(rest.text, t) }]);
      else if (/the (?:truth|secret)/iu.test(marker) && rest) add('HIDDEN_TRUTH', 'Hidden Truth', 'THE_TRUTH_REST', [/secret/iu.test(marker) ? 'The secret: ' : 'The truth: ', { ...rest, text: fitCase(rest.text, t) }]);
      else if (/what (?:nobody|no one|most people|everyone)/iu.test(marker) && phrase && wordsOf(phrase.text).length >= 5 && wordsOf(phrase.text).length <= 14)
        add('REVEAL', 'Reveal', 'MARKER_PHRASE', [{ ...phrase, text: capitalize(tail(phrase.text)) }], { copyAllowed: true });
      break;
    }
    case 'MYTH': {
      const claim = S.claim && cased(S.claim);
      if (!claim) break;
      add('MYTH_REALITY', 'Myth', 'THE_MYTH_THAT', ['The myth that ', claim]);
      add('CHALLENGE', 'Challenge', 'IS_IT_TRUE', ['Is it true that ', claim, '?']);
      break;
    }
    case 'OPINION': {
      const claim = S.claim && cased(S.claim);
      if (!claim) break;
      const inverted = invertClause(claim.text);
      add('CHALLENGE', 'Challenge', 'IS_IT_TRUE', ['Is it true that ', claim, '?']);
      if (inverted) add('QUESTION', 'Question', 'INVERTED_OPINION_Q', [{ ...claim, shown: capitalize(inverted) }, '?'], { answered: true });
      break;
    }
    case 'DISAGREEMENT': {
      const claim = S.claim && cased(S.claim);
      if (claim) add('CONFLICT', 'Conflict', 'IS_IT_TRUE', ['Is it true that ', claim, '?']);
      break;
    }
    case 'STORY': {
      const event = S.event && cased(S.event), marker = (S.marker?.text ?? 'when').toLowerCase();
      if (!event) break;
      add('STORY', 'Story Tease', 'WHAT_HAPPENED', [marker === 'after' ? 'What happened after ' : 'What happened when ', event]);
      break;
    }
    case 'EMOTION': {
      const line = S.line;
      if (line && isClause(line.text) && wordsOf(line.text).length <= 13) add('EMOTIONAL', 'Emotional', 'EMOTION_LINE', [{ ...line, text: capitalize(tail(line.text)) }], { copyAllowed: true });
      break;
    }
    case 'CLAIM': {
      const claim = S.claim;
      if (claim) add('BOLD', 'Bold Claim', 'CLAIM_LINE', [{ ...claim, text: capitalize(compressClause(claim.text)) }], { copyAllowed: true });
      break;
    }
    case 'BEFORE_AFTER': {
      if (S.phrase) add('BEFORE_AFTER', 'Before/After', 'FROM_TO', [{ ...S.phrase, text: capitalize(tail(S.phrase.text)) }], { copyAllowed: true });
      break;
    }
    case 'CONCLUSION': {
      const line = S.line;
      if (line && /\b(?:takeaway|lesson|bottom line|point)\b/iu.test(line.text)) add('PROFESSIONAL', 'Problem/Solution', 'CONCLUSION_LINE', [{ ...line, text: capitalize(compressClause(line.text)) }], { copyAllowed: true });
      break;
    }
    default: break;
  }
  return out;
}

const stemSet = (text: string) => new Set(contentStems(text));
const hasNumberEquivalent = (token: string, evidenceNorm: string) => {
  const w = lower(token);
  const alt = NUMBER_EQUIVALENT[w] ?? Object.entries(NUMBER_EQUIVALENT).find(([, word]) => word === w)?.[0];
  return evidenceNorm.split(' ').includes(w) || (!!alt && evidenceNorm.split(' ').includes(alt));
};

/** The strict, deterministic gate. `analysis` provides the monologue flag and sentence sources; `evidence` the raw grounding text. */
export function gateHook(c: FreeHookCandidate, analysis: FreeAnalysis, evidence: ContentEvidence, opts: { existing?: boolean } = {}): { gate: FreeHookGate; detail: string[]; scores: FreeHookScores } {
  const gate = Object.fromEntries(FREE_HOOK_GATES.map(g => [g, true])) as FreeHookGate;
  const detail: string[] = [];
  const fail = (name: FreeHookGateName, why: string) => { gate[name] = false; detail.push(`${name}: ${why}`); };
  const text = c.text.replace(/[’‘]/gu, "'").trim();
  const words = wordsOf(text);
  const body = text.replace(/[?!.]+$/u, '');
  const bodyWords = wordsOf(body);
  const evidenceNorm = norm(analysis.evidenceText + '\n' + (evidence.previousContext ?? '').slice(-0));
  const evidenceStems = stemSet(analysis.evidenceText);
  const content = words.filter(w => !isFunctionWord(w) && !FILLERS.has(w));

  // GRAMMAR_OK -------------------------------------------------------------------------------------------------------------
  // "It's not X, it's Y" opens with an idiomatic "It", not a pronoun that needs an antecedent.
  const language = hookLanguageProblems(text).filter(problem => !(c.template === 'ITS_NOT_A_ITS_B' && problem === 'NO_DANGLING_PRONOUN'));
  if (language.length) fail('GRAMMAR_OK', 'known broken pattern ' + language.join(','));
  if (/^there\s+(?:is|are|was|were)\b/iu.test(body)) fail('NATURAL_HEADLINE', 'an existential opener ("There are...") is not a headline');
  if (/\b(\p{L}+)\s+\1\b/iu.test(body) && !/\b(?:that that|had had)\b/iu.test(body)) fail('GRAMMAR_OK', 'repeated adjacent word');
  if (/\b(i|we|you|he|she|they)\s+(?:start(?:ed|s)?|stop(?:ped|s)?|began|finished|walked|ran|left|arrived)\s+\1\b/iu.test(body))
    fail('GRAMMAR_OK', 'two bare clauses joined without punctuation or a connector');
  if (!/^[\p{Lu}\p{N}"'“]/u.test(text)) fail('GRAMMAR_OK', 'does not start with a capital');
  const last = bodyWords.at(-1) ?? '';
  // A headline that ends on "it", "them", "this" leaves the reader asking "what?" ("We even played a game with it").
  if (WEAK_END.has(last) && last !== 'you') fail('GRAMMAR_OK', 'ends on a function word');
  if (/^(?:it|them|him|her|this|that|these|those)$/u.test(last) && !c.template.startsWith('QUOTED')) fail('GRAMMAR_OK', 'ends on a pronoun');
  if (/^(?:and|but|so|because|then|or|which|that)\b/iu.test(body)) fail('GRAMMAR_OK', 'starts with a continuation word');
  let run = 0, longestRun = 0;
  for (const w of bodyWords) { run = isFunctionWord(w) && !QUESTION_WORDS.has(w) ? run + 1 : 0; longestRun = Math.max(longestRun, run); }
  if (longestRun >= 5) fail('GRAMMAR_OK', 'too many consecutive function words');
  if ((text.match(/[()"“”]/gu) ?? []).length % 2 === 1 || /\.{2,}|,,|\s[,.;:]/u.test(text)) fail('GRAMMAR_OK', 'unbalanced or doubled punctuation');
  // Each typed slot must still satisfy its type in place.
  if (!opts.existing) for (const s of c.slots) {
    if (s.type === 'CLAUSE' && !isClause(s.text)) fail('GRAMMAR_OK', `slot "${s.text}" is not a clause`);
    if (s.type === 'VP' && !isBaseVerbPhrase(s.text)) fail('GRAMMAR_OK', `slot "${s.text}" is not a base verb phrase`);
    if (s.type === 'QUESTION' && !(/\?$/u.test(s.text) && (QUESTION_WORDS.has(lower(s.text.split(' ')[0])) || /^(?:do|does|did|is|are|was|were|can|could|should|would|will|have|has)\b/iu.test(s.text)))) fail('GRAMMAR_OK', `slot "${s.text}" is not a question`);
    if (s.type === 'NP') { const sw = wordsOf(s.text); if (!sw.length || isFunctionWord(sw.at(-1)!) || isGenericWord(sw.at(-1)!)) fail('GRAMMAR_OK', `slot "${s.text}" is not a noun phrase`); }
  }

  // MEANING_CLEAR ----------------------------------------------------------------------------------------------------------
  const specific = content.filter(w => !isGenericWord(w));
  if (words.length < 4) fail('MEANING_CLEAR', 'fewer than four words');
  if (specific.length < 2) fail('MEANING_CLEAR', 'fewer than two specific content words');
  if (content.length && content.filter(isGenericWord).length / content.length > .4) fail('MEANING_CLEAR', 'dominated by generic words');
  if (words.length > 24) fail('MEANING_CLEAR', 'too long to read at a glance');
  // A headline must be about what the clip is about: it shares a topic term, an entity or a number with the clip's own key phrases.
  const topicStems = new Set([...analysis.keywords.slice(0, 10), ...analysis.entities].flatMap(contentStems));
  // Only a generic statement needs this: a hook built from a typed frame (reason, question, lead...) is about the clip by construction, and an
  // opening statement defines the topic. A fallback line from the middle of the clip must share a topic term, a name or a number.
  const needsTopic = c.frame === 'CLAIM' && !c.slots.some(s => s.sentence >= 0 && s.sentence <= 1);
  if (!opts.existing && needsTopic && topicStems.size >= 2 && !contentStems(body).some(s => topicStems.has(s)) && !words.some(isNumberToken))
    fail('MEANING_CLEAR', 'shares no topic term, name or number with the clip');

  // CONTEXT_COMPLETE / NO_DANGLING_PRONOUN --------------------------------------------------------------------------------
  // The template's own "it" in "Is it true that ...?" is not a reference.
  const scanBody = body.replace(/^is it true that\s+/iu, '');
  const scanWords = wordsOf(scanBody);
  const firstWord = scanWords[0] ?? '';
  const refIndex = scanWords.findIndex(w => THIRD_PERSON_PRONOUNS.has(w) || /^(?:this|these|those)$/u.test(w));
  const isQuestionWord = QUESTION_WORDS.has(firstWord);
  if ((THIRD_PERSON_PRONOUNS.has(firstWord) || /^(?:this|these|those|that)$/u.test(firstWord) && !isQuestionWord) && !(c.template === 'ITS_NOT_A_ITS_B' && firstWord === 'it')) fail('NO_DANGLING_PRONOUN', 'opens with a pronoun that has no antecedent');
  if (refIndex > 0) {
    const before = scanWords.slice(0, refIndex).filter(w => isNounish(w) && !isGenericWord(w) && !isVerbForm(w));
    if (!before.length) fail('NO_DANGLING_PRONOUN', `"${scanWords[refIndex]}" has no noun before it`);
    // A plural pronoun needs a plural antecedent: "Does confusion mean they are bad at it?" has nothing for "they" to point at.
    else if (/^(?:they|them|their|these|those)$/u.test(scanWords[refIndex]) && !before.some(w => /(?:[^s]s|ies)$/u.test(w) && !/(?:ss|us|is|ness|ics)$/u.test(w) || /^(?:people|children|men|women|everyone|everybody|team|teams|company|companies)$/u.test(w)))
      fail('NO_DANGLING_PRONOUN', `"${scanWords[refIndex]}" has no plural noun before it`);
  }
  if (/^(?:why|how|what|when|where)$/u.test(firstWord) && bodyWords.length < 4) fail('CONTEXT_COMPLETE', 'question stem without a complete clause');
  if (/\b(?:the|this|that) (?:one|other|same|thing|guy|man|woman|girl|boy)\b/iu.test(scanBody)) fail('CONTEXT_COMPLETE', 'unresolved reference to a person or thing');
  // "the opposite", "the reverse", "the same": anaphora that only makes sense after the sentence it answers.
  if (/\b(?:the (?:opposite|reverse|contrary|rest|latter|former|above|following|previous|next)|the same (?:thing|way|reason))\b/iu.test(scanBody)) fail('CONTEXT_COMPLETE', 'refers back to something the hook never states');
  if (/\b(?:does|do|did|is|was|are|were|can|could|will|would|should)\s+(?:it|that|this)\b/iu.test(scanBody)) fail('CONTEXT_COMPLETE', 'asks about "it/that/this" with nothing to refer to');
  scanWords.forEach((w, i) => {
    if (!/^(?:this|that|these|those)$/u.test(w)) return;
    const prev = scanWords[i - 1] ?? '', next = scanWords[i + 1] ?? '';
    if (!next || !isNounish(next) || /^(?:true|know|knew|say|said|think|thought|believe|fact|mean|means|realize|sure|clear|show|shows|proves|learn|hope|wish|claim|claims|argue|guess|saying|suggests|notice|ensure|so|assume|imagine|suppose|find|found)$/u.test(prev)) return;
    if (!scanWords.slice(0, i).includes(next)) fail('CONTEXT_COMPLETE', `"${w} ${next}" refers to something the hook never introduces`);
  });
  if (/\b(?:he|she)\b/iu.test(scanBody)) fail('CONTEXT_COMPLETE', 'gendered pronoun without a named antecedent');

  // GROUNDED ---------------------------------------------------------------------------------------------------------------
  const claimed = content.filter(w => !TEMPLATE_WORDS.has(w) && !isNumberToken(w));
  const missing = claimed.filter(w => !evidenceStems.has(stem(w)) && !evidenceNorm.split(' ').includes(w));
  if (claimed.length && missing.length / claimed.length > .1) fail('GROUNDED', `words absent from the clip: ${missing.slice(0, 4).join(', ')}`);
  if (!opts.existing) for (const s of c.slots) if (s.type !== 'NUM' && !norm(analysis.evidenceText).includes(norm(s.text).replace(/^(?:it s|its) /u, ''))) {
    if (!norm(analysis.evidenceText).includes(norm(tail(s.text)))) fail('GROUNDED', `slot "${s.text.slice(0, 40)}" is not a span of the clip`);
  }

  // NO_WORD_SALAD ----------------------------------------------------------------------------------------------------------
  const genericRun = bodyWords.filter((w, i) => isGenericWord(w) && (isGenericWord(bodyWords[i + 1] ?? '') || isGenericWord(bodyWords[i + 2] ?? ''))).length;
  if (genericRun >= 2) fail('NO_WORD_SALAD', 'generic words cluster together');
  if (/\b(?:and|or)\b/iu.test(body) && bodyWords.some((w, i) => /^(?:and|or)$/u.test(w) && (isVerbForm(bodyWords[i - 1] ?? '') && isVerbForm(bodyWords[i + 1] ?? '') || isGenericWord(bodyWords[i - 1] ?? '') && isGenericWord(bodyWords[i + 1] ?? ''))))
    fail('NO_WORD_SALAD', 'joins two bare verbs or generic words');
  if (!c.slots.length && !opts.existing) fail('NO_WORD_SALAD', 'not built from a typed slot');
  if (c.slots.some(s => s.type === 'NP' && isGenericWord(wordsOf(s.text).at(-1) ?? ''))) fail('NO_WORD_SALAD', 'generic noun-phrase head');

  // NO_TRANSCRIPT_COPY -----------------------------------------------------------------------------------------------------
  const hookNorm = norm(body);
  let copied = false;
  for (const s of analysis.sentences) {
    const sn = norm(s.text);
    if (!sn) continue;
    // A whole sentence of nine words or more, or any verbatim run of eleven or more, is a subtitle rather than a headline. A compact
    // phrase lifted from inside a sentence ("Not talent but a habit of shrinking the problem") is a quotable line and is allowed.
    // A whole sentence of more than ten words is a subtitle even for a quotable claim line (nine and ten are a short quotable sentence);
    // a template-built hook that reproduces a whole sentence of nine words or more is a copy.
    const plainQuote = c.template === 'SIMPLE_CLAIM' || opts.existing && isClause(body) && readable({ text: body, words: bodyWords });
    if (sn === hookNorm && (bodyWords.length > (plainQuote ? 14 : 10) || (bodyWords.length >= 9 && !c.copyAllowed))) copied = true;
    if (sn !== hookNorm && sn.includes(hookNorm) && bodyWords.length >= 11 && !c.copyAllowed) copied = true;
    // A quotable claim line may be part of a sentence, but more than sixteen verbatim words is a subtitle, not a pull quote.
    if (sn !== hookNorm && sn.includes(hookNorm) && bodyWords.length > 16 && c.copyAllowed) copied = true;
  }
  if (copied) fail('NO_TRANSCRIPT_COPY', 'verbatim transcript sentence');
  if (/\b\d{1,2}:\d{2}\b|\[[^\]]*\]/u.test(text)) fail('NO_TRANSCRIPT_COPY', 'timestamp or caption artefact');

  // NO_UNSUPPORTED_NAME / NO_UNSUPPORTED_NUMBER ------------------------------------------------------------------------------
  const invented = inventedNames(text, evidence);
  if (invented.length) fail('NO_UNSUPPORTED_NAME', invented.join(', '));
  for (const token of splitTokens(body)) if (isNumberToken(token) && !hasNumberEquivalent(token.replace(/[^\p{L}\p{N}%.,$]/gu, ''), evidenceNorm) && !evidence.transcript.includes(token.replace(/[^\p{N}%.,$]/gu, '')))
    fail('NO_UNSUPPORTED_NUMBER', token);

  // NO_MISLEADING_CLAIM ----------------------------------------------------------------------------------------------------
  for (const frame of analysis.frames) {
    const effect = frame.type === 'REASON' ? frame.slots.effect : undefined;
    if (!effect || !disputedEffect(analysis, effect)) continue;
    const inverted = invertClause(effect.text);
    const neutral = /^(?:is it true|does|do|did|is|are|can|could|should|would|will)\b/iu.test(body);
    const asserts = norm(body).includes(norm(effect.text)) && !neutral;
    const presupposes = inverted && /^(?:why|how|here's why|the real reason)\b/iu.test(body) && norm(body).includes(norm(inverted));
    if (asserts || presupposes) fail('NO_MISLEADING_CLAIM', 'the following reply disputes this premise; use a neutral question');
  }
  const strong = ['BOLD', 'MISTAKE', 'HIDDEN_TRUTH', 'REVEAL', 'UNEXPECTED_RESULT', 'CONTRARIAN', 'WARNING', 'MYTH_REALITY'].includes(c.category);
  if (c.hedged && strong) fail('NO_MISLEADING_CLAIM', 'the speaker hedged; a bold hook would overstate it');
  if (!opts.existing && HEDGES.test(body)) fail('NO_MISLEADING_CLAIM', 'a hedge ("I don\'t know", "maybe") does not belong in a headline');
  for (const m of text.matchAll(SHOCK_WORDS)) if (!new RegExp(`\\b${m[0]}\\b`, 'iu').test(analysis.evidenceText)) fail('NO_MISLEADING_CLAIM', `intensity word "${m[0]}" not said in the clip`);
  if (!analysis.monologue && (c.firstPerson || bodyWords.some(w => FIRST_PERSON.has(w)))) fail('NO_MISLEADING_CLAIM', 'first-person wording in a multi-speaker clip would misattribute the speaker');
  // Polarity: a negation that precedes the quoted span in its sentence but is missing from the span would invert the meaning.
  // A question does not assert the claim it asks about, so a negation in the speaker's own framing cannot be inverted by it.
  if (!opts.existing && !/\?$/u.test(text)) for (const s of c.slots) {
    if (s.type === 'NUM' || s.sentence < 0) continue;
    const sentence = analysis.sentences[s.sentence]?.text ?? '';
    const at = norm(sentence).indexOf(norm(tail(s.text)).slice(0, 24));
    if (at > 0) {
      const lead = norm(sentence).slice(0, at), spanWords = wordsOf(s.text);
      const negatedBefore = lead.split(' ').some(w => NEGATIONS.has(w) || /n't$/u.test(w));
      // The template may supply the negation itself ("It's not X, it's Y"); that carries the meaning as well as the span would.
      const hookBeforeSlot = norm(text.slice(0, Math.max(0, text.toLowerCase().indexOf(s.text.toLowerCase().slice(0, 12)))));
      const negatedInside = spanWords.some(w => NEGATIONS.has(w) || /n't$/u.test(w)) || hookBeforeSlot.split(' ').some(w => NEGATIONS.has(w) || /n't$/u.test(w));
      if (negatedBefore && !negatedInside && !/^(?:not|never|don't|do not|stop|avoid)$/iu.test(text.split(' ')[0])) fail('NO_MISLEADING_CLAIM', 'a negation before the quoted span is not carried into the hook');
    }
  }
  if (c.category === 'QUESTION' && !c.answered && !analysis.frames.some(f => f.type === 'QA' && f.slots.question?.text === text)) fail('NO_MISLEADING_CLAIM', 'the clip never answers this question');

  // NATURAL_HEADLINE ------------------------------------------------------------------------------------------------------
  if (HEADLINE_BAD_WORDS.test(body)) fail('NATURAL_HEADLINE', 'spoken filler in a headline');
  if (PROFANITY.test(body)) fail('NATURAL_HEADLINE', 'profanity is not brand-safe in a headline');
  if (fillerLike(bodyWords)) fail('NATURAL_HEADLINE', 'the filler word "like"');
  if (words.length > 22) fail('NATURAL_HEADLINE', 'longer than 22 words');
  if ((body.match(/[,;]/gu) ?? []).length > 2) fail('NATURAL_HEADLINE', 'too many clauses');
  if (/[.!](?=\s\p{L})/u.test(body)) fail('NATURAL_HEADLINE', 'more than one sentence');
  if (/\b[A-Z]{5,}\b/u.test(body)) fail('NATURAL_HEADLINE', 'shouting');
  if (bodyWords.filter(w => DETERMINERS.has(w) || PREPOSITIONS.has(w)).length / Math.max(1, bodyWords.length) > .5) fail('NATURAL_HEADLINE', 'mostly connective words');

  const scores = scoreHook(c, analysis, gate);
  if (scores.clickability < 58) fail('CLICKABLE_ENOUGH', `clickability proxy ${scores.clickability}`);
  return { gate, detail, scores };
}

// A question the clip itself answers and a reason it explains are the strongest honest hooks; "Is it true that..." is formulaic and ranks lower.
const FAMILY_BASE: Record<string, number> = { Question: 74, 'Curiosity Gap': 70, Contrarian: 74, 'Bold Claim': 60, Mistake: 72, Warning: 68, 'Hidden Truth': 72, Tension: 66, Advice: 64,
  'Story Tease': 68, Reveal: 66, 'Unexpected Result': 70, Conflict: 64, Emotional: 60, Myth: 72, Challenge: 62, 'Before/After': 62, 'Problem/Solution': 60 };

function scoreHook(c: FreeHookCandidate, analysis: FreeAnalysis, gate: FreeHookGate): FreeHookScores {
  const words = wordsOf(c.text);
  const content = words.filter(w => !isFunctionWord(w));
  const specific = content.filter(w => !isGenericWord(w));
  const entityHit = analysis.entities.some(e => c.text.includes(e));
  const numberHit = words.some(isNumberToken);
  // A counted list ("Three reasons startups fail") is a classic, strong, deliberately short headline: it is neither penalised for brevity nor left at the flat-claim base.
  const counted = c.template === 'NUMBER_PHRASE' || c.template === 'NUMBER_CLAUSE';
  let clickability = (FAMILY_BASE[c.family] ?? 60) + (counted ? 8 : 0);
  clickability += entityHit ? 5 : 0; clickability += numberHit ? 4 : 0;
  clickability += /\b(?:you|your)\b/iu.test(c.text) ? 4 : 0;
  clickability += /^(?:why|how|what happens)/iu.test(c.text) ? 3 : 0;
  clickability += /\b(?:not|instead|but|never|stop|mistake|wrong|myth|truth)\b/iu.test(c.text) ? 4 : 0;
  clickability += Math.min(6, Math.max(0, specific.length - 1) * 2);
  clickability -= words.length > 16 ? 5 : 0; clickability -= words.length < 4 ? 8 : words.length < 6 && !counted ? 4 : 0;
  clickability -= content.filter(isGenericWord).length * 3;
  clickability = Math.max(0, Math.min(95, Math.round(clickability)));
  const specificity = Math.max(0, Math.min(100, Math.round(specific.length / Math.max(1, content.length) * 70 + (entityHit ? 15 : 0) + (numberHit ? 10 : 0) + Math.min(5, specific.length))));
  const clarityFails = ['GRAMMAR_OK', 'MEANING_CLEAR', 'NO_WORD_SALAD', 'NATURAL_HEADLINE'].filter(g => !gate[g as FreeHookGateName]).length;
  // Short reads faster on a phone: every word past fourteen costs clarity, so a tight hook beats a sprawling one of equal appeal.
  const clarity = Math.max(0, 96 - clarityFails * 30 - Math.max(0, words.length - 14) * 2 - (words.length < 5 ? 10 : 0));
  const context = ['CONTEXT_COMPLETE', 'NO_DANGLING_PRONOUN'].every(g => gate[g as FreeHookGateName]) ? 92 : 40;
  const grounding = gate.GROUNDED && gate.NO_UNSUPPORTED_NAME && gate.NO_UNSUPPORTED_NUMBER ? 95 : 40;
  const risk = (gate.NO_MISLEADING_CLAIM ? 6 : 60) + (c.hedged ? 12 : 0) + (gate.NO_TRANSCRIPT_COPY ? 0 : 20);
  const quoted = new Set(analysis.sentences.map(s => norm(s.text)));
  // A deliberately quoted line (the clip's own question, a compact claim) is not a stock template: it is slightly less novel than a composed hook, not "generic".
  const novelty = quoted.has(norm(c.text)) ? 70 : 90;
  return { clarity, specificity, clickability, novelty, context, grounding, misleadingRisk: Math.min(100, risk) };
}

export const compositeScore = (s: FreeHookScores) => Math.max(0, Math.min(100, Math.round(s.clickability * .30 + s.clarity * .22 + s.specificity * .14 + s.grounding * .12 + s.context * .10 + s.novelty * .04 + 8 - s.misleadingRisk * .30)));

const hasAll = (g: FreeHookGate) => FREE_HOOK_GATES.every(name => g[name]);

export type FreeHookOptions = { exclude?: string[]; direction?: string; category?: HookCategory; limit?: number };
export type FreeHookResult = { hooks: FreeHook[]; candidateCount: number; rejected: Array<{ text: string; failed: FreeHookGateName[]; detail: string[] }>; gated: FreeHook[];
  /** Set for Hindi / Hinglish / other non-English speech: hooks are verbatim lines and the English-only checks did not run. */
  languageUnverified?: string };

const similarity = (a: string, b: string) => {
  const x = new Set(contentStems(a)), y = new Set(contentStems(b));
  if (!x.size || !y.size) return 0;
  let shared = 0; for (const w of x) if (y.has(w)) shared++;
  return shared / Math.max(x.size, y.size);
};

/** Direction text shifts the ranking, never the gate: a user preference cannot make an unsafe hook acceptable. */
function directionBias(direction: string | undefined, hook: FreeHook): number {
  if (!direction) return 0;
  const d = direction.toLowerCase();
  const wc = wordsOf(hook.text).length;
  let bias = 0;
  if (/\b(?:shorter|short|concise|brief|tighter)\b/u.test(d)) bias += wc <= 9 ? 8 : wc <= 12 ? 3 : -6;
  if (/\b(?:longer|detailed|more context)\b/u.test(d)) bias += wc >= 11 ? 5 : -2;
  if (/\bquestion|ask\b/u.test(d)) bias += hook.category === 'QUESTION' || /\?$/u.test(hook.text) ? 10 : 0;
  if (/\b(?:bold|stronger|punchy|provocative|clickbait|interesting)\b/u.test(d)) bias += ['BOLD', 'CONTRARIAN', 'MISTAKE', 'HIDDEN_TRUTH', 'WARNING'].includes(hook.category) ? 8 : 0;
  if (/\b(?:clearer|clear|simple|simpler|plain)\b/u.test(d)) bias += (hook.scores.clarity - 80) * .3 - hook.scores.misleadingRisk * .1;
  if (/\b(?:curious|curiosity|intrigu|mystery)\b/u.test(d)) bias += ['CURIOSITY', 'HIDDEN_TRUTH', 'REVEAL', 'STORY'].includes(hook.category) ? 8 : 0;
  if (/\b(?:warn|warning|careful|danger)\b/u.test(d)) bias += ['WARNING', 'MISTAKE'].includes(hook.category) ? 8 : 0;
  if (/\b(?:advice|tip|how to|actionable)\b/u.test(d)) bias += hook.category === 'AUTHORITY' ? 8 : 0;
  return bias;
}

/**
 * Hindi, Hinglish and other non-English speech. The grammar, pronoun and clause checks above are English-only, so no English template is
 * ever applied to it. The clip's own strongest complete lines are offered verbatim and are held below the acceptance bar: the package
 * is flagged for review and says why. This is deliberately NOT a certified language path.
 */
function unverifiedLanguageHooks(analysis: FreeAnalysis, options: FreeHookOptions): FreeHook[] {
  const seen = new Set((options.exclude ?? []).map(norm));
  const lines = analysis.sentences.filter(s => s.complete && s.words.length >= 4 && s.words.length <= 16 && s.kind !== 'FRAGMENT')
    .sort((a, b) => Math.abs(a.words.length - 10) - Math.abs(b.words.length - 10) || a.index - b.index);
  const gate = Object.fromEntries(FREE_HOOK_GATES.map(g => [g, true])) as FreeHookGate;
  const out: FreeHook[] = [];
  for (const s of lines) {
    const text = s.text.replace(/\s+/gu, ' ').trim();
    if (!text || seen.has(norm(text)) || out.some(h => norm(h.text) === norm(text)) || PROFANITY.test(text)) continue;
    out.push({ text, category: 'PROFESSIONAL', family: 'Quoted line', template: 'UNVERIFIED_LANGUAGE_QUOTED_LINE', slots: [{ type: 'PHRASE', text, sentence: s.index }], frame: 'CLAIM',
      hedged: false, copyAllowed: true, firstPerson: false, gate, failed: [], detail: ['LANGUAGE_UNVERIFIED: English-only checks were not applied'],
      scores: { clarity: 70, specificity: 50, clickability: 60, novelty: 60, context: 70, grounding: 90, misleadingRisk: 20 }, composite: 66, passed: true });
    // One quoted line is enough: the rest stay available for captions, which may not repeat a hook.
    if (out.length >= 1) break;
  }
  return out;
}

/** Generate, gate, de-duplicate and order hooks. Deterministic: the same evidence always yields the same list. */
export function generateFreeHooks(analysis: FreeAnalysis, evidence: ContentEvidence, options: FreeHookOptions = {}): FreeHookResult {
  const register = spokenRegister(evidence.transcript || evidence.visibleText || '');
  if (register !== 'English') {
    const hooks = unverifiedLanguageHooks(analysis, options);
    return { hooks, candidateCount: hooks.length, rejected: [], gated: hooks, languageUnverified: register };
  }
  const drafts = analysis.frames.flatMap(f => draftsFor(f, analysis).map(d => ({ d, f })));
  const seen = new Set((options.exclude ?? []).map(norm));
  const rejected: FreeHookResult['rejected'] = [];
  const gated: FreeHook[] = [];
  const candidates = new Map<string, FreeHookCandidate>();
  for (const { d } of drafts) {
    let text = d.text.replace(/\s+([?!.,])/gu, '$1').replace(/\?{2,}/gu, '?');
    if (d.category !== 'QUESTION' && !/^(?:why|how|what|is|do|does|did|can)\b/iu.test(text)) text = text.replace(/[.]+$/u, '');
    if (!/\?$/u.test(text) && /^(?:is it true that)\b/iu.test(text)) text += '?';
    text = text.charAt(0).toUpperCase() + text.slice(1);
    const key = norm(text);
    if (!key || candidates.has(key) || seen.has(key)) continue;
    candidates.set(key, { text, category: d.category, family: d.family, template: d.template, slots: d.slots, frame: d.frame.type, hedged: d.frame.hedged,
      copyAllowed: !!d.copyAllowed, firstPerson: d.frame.firstPerson, ...(d.answered ? { answered: true } : {}) });
  }
  for (const c of candidates.values()) {
    const { gate, detail, scores } = gateHook(c, analysis, evidence);
    const failed = FREE_HOOK_GATES.filter(g => !gate[g]);
    const similarityToExcluded = Math.max(0, ...(options.exclude ?? []).map(x => similarity(c.text, x)));
    const scoresAdj = { ...scores, novelty: Math.round(scores.novelty * (1 - similarityToExcluded * .6)) };
    const hook: FreeHook = { ...c, gate, failed, detail, scores: scoresAdj, composite: compositeScore(scoresAdj), passed: failed.length === 0 };
    if (hook.passed) gated.push(hook); else rejected.push({ text: c.text, failed, detail });
  }
  // The clip's own answered question is the most faithful headline it can have, so it wins a near tie against a constructed one.
  const rank = (h: FreeHook) => h.composite + directionBias(options.direction, h) + (options.category && h.category === options.category ? 12 : 0)
    + (h.template === 'QUOTED_QUESTION' ? 4 : 0);
  const ordered = [...gated].sort((a, b) => rank(b) - rank(a) || a.text.localeCompare(b.text));
  // Variety: a near-duplicate of a better hook is dropped, and no family supplies more than two of the visible options.
  const kept: FreeHook[] = [];
  for (const hook of ordered) {
    if (kept.some(k => similarity(k.text, hook.text) >= .72)) continue;
    if (kept.filter(k => k.family === hook.family).length >= 2) continue;
    kept.push(hook);
    if (kept.length >= (options.limit ?? 8)) break;
  }
  return { hooks: kept, candidateCount: candidates.size, rejected, gated: ordered };
}

/**
 * The simplest honest hook: the clip's strongest complete claim or payoff, compressed, when the richer families produced nothing that
 * passes. It still has to pass the same gate. Returns null when even that is unsafe, and the caller keeps its hook list empty.
 */
export function simpleFallbackHook(analysis: FreeAnalysis, evidence: ContentEvidence, options: FreeHookOptions = {}): FreeHook | null {
  const options2: FreeHookOptions = { ...options, limit: 1 };
  // Ladder: the clip's own best claims first, then any other complete, standalone, readable statement. Every rung faces the full gate.
  const clauses = analysis.sentences.filter(s => s.complete && !SUBORDINATORS.test(cleanClause(s.text)))
    .flatMap(s => {
      const parts = s.text.split(/[,;]\s+/u);
      return parts.map((raw, index) => ({ line: cleanClause(raw), prefix: parts.slice(0, index + 1).join(', ') }))
        .filter(({ line, prefix }) => !HEDGES.test(prefix) && isClause(line) && wordsOf(line).length >= 6 && wordsOf(line).length <= 16
          && !SUBORDINATORS.test(line) && readable({ text: line, words: wordsOf(line) }))
        .map(({ line }) => line);
    });
  const lines = [analysis.mainClaim, analysis.payoff, ...analysis.supportedClaims,
    ...clauses,
    ...analysis.sentences.filter(s => s.standalone && s.kind !== 'QUESTION' && s.words.length >= 6 && s.words.length <= 26 && readable(s)).map(s => s.text)].filter(Boolean)
    .filter((line, i, all) => all.indexOf(line) === i).slice(0, 40);
  const hedged = (value: string) => HEDGES.test(value);
  let best: FreeHook | null = null;
  for (const line of lines) {
    const clause = compressClause(line, 14);
    if (!isClause(clause) || hedged(clause)) continue;
    const text = capitalize(tail(clause));
    const candidate: FreeHookCandidate = { text, category: 'PROFESSIONAL', family: 'Problem/Solution', template: 'SIMPLE_CLAIM', slots: [{ type: 'CLAUSE', text: clause, sentence: analysis.sentences.findIndex(s => norm(s.text).includes(norm(clause).slice(0, 30))) }],
      frame: 'CLAIM', hedged: false, copyAllowed: wordsOf(text).length <= 14, firstPerson: wordsOf(text).some(w => FIRST_PERSON.has(w)) };
    if ((options2.exclude ?? []).some(x => norm(x) === norm(text))) continue;
    const { gate, detail, scores } = gateHook(candidate, analysis, evidence);
    const failed = FREE_HOOK_GATES.filter(g => !gate[g]);
    if (!failed.length) {
      const hook: FreeHook = { ...candidate, gate, failed, detail, scores, composite: compositeScore(scores), passed: true };
      if (!best || hook.composite > best.composite) best = hook;
      if (best.composite >= 75) return best;
    }
  }
  return best;
}
/** A sentence that reads cleanly enough to quote: no filler, not a run-on, not heavily comma-spliced. */
export function readable(s: { text: string; words: string[] }): boolean {
  const commas = (s.text.match(/,/gu) ?? []).length;
  return s.words.length <= 28 && commas <= 3 && !s.words.some(w => FILLERS.has(w)) && !/\b(?:kind of|sort of|you know|i mean)\b/iu.test(s.text) && !PROFANITY.test(s.text) && !fillerLike(s.words);
}

export { GENERIC_WORDS };

/**
 * Judges a hook that already exists on a clip (generated earlier or typed by the user) with the same gate. It has no slots, so the
 * slot-structure checks do not apply; every language, grounding, naming, numbering and misleading-claim check still does.
 */
export function evaluateExistingHook(text: string, analysis: FreeAnalysis, evidence: ContentEvidence, category: HookCategory = 'PROFESSIONAL'): FreeHook {
  // Reopening a saved contrast must recognise the same idiomatic dummy "it" as
  // generation. Grounding, negation and all other gates still run on its text.
  const template = /^it's not .+, it's .+$/iu.test(text.replace(/[’‘]/gu, "'")) ? 'ITS_NOT_A_ITS_B' : 'EXISTING';
  const candidate: FreeHookCandidate = { text: text.replace(/\s+/gu, ' ').trim(), category, family: 'Existing', template, slots: [], frame: 'CLAIM',
    hedged: false, copyAllowed: true, firstPerson: wordsOf(text).some(w => FIRST_PERSON.has(w)) };
  const { gate, detail, scores } = gateHook(candidate, analysis, evidence, { existing: true });
  const failed = FREE_HOOK_GATES.filter(g => !gate[g]);
  return { ...candidate, gate, failed, detail, scores, composite: compositeScore(scores), passed: failed.length === 0 };
}
