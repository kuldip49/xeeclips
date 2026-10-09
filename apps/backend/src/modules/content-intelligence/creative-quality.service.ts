import { Injectable } from '@nestjs/common';
import { evidenceText, normalize, terms, type ContentEvidence, type ContentUnderstanding } from './content-understanding.service';
import { hookFitsTemplates } from './hook-fit';
export const HOOK_CATEGORIES = ['BOLD', 'CURIOSITY', 'CONTRARIAN', 'SARCASTIC', 'HUMOROUS', 'EMOTIONAL', 'QUESTION', 'AUTHORITY', 'STORY', 'WARNING', 'PROFESSIONAL',
  'HIDDEN_TRUTH', 'UNEXPECTED_RESULT', 'TENSION', 'CHALLENGE', 'CONFLICT', 'MISTAKE', 'WAIT_UNTIL', 'MYTH_REALITY', 'BEFORE_AFTER', 'REVEAL'] as const;
export const HOOK_POLICY = { minWords: 4, normalMin: 8, normalMax: 14, longMax: 22, maxWords: 26, maxCharacters: 320,
  clickabilityThreshold: 70, contextThreshold: 65, specificityThreshold: 45, noveltyThreshold: 60,
  groundingThreshold: 70, misleadingRiskMax: 30, naturalnessThreshold: 70,
  /** A generated rewrite replaces an existing, already-acceptable hook only when it is better by at least this many composite points. */
  existingHookMargin: 8 } as const;
export type HookCategory = typeof HOOK_CATEGORIES[number];
/** The semantic reviewer's verdict on one hook. Present only when a model judged meaning, not word overlap. */
export type HookReview = { approved: boolean; clickability: number; context: number; grounding: number;
  misleadingRisk: number; specificity: number; naturalness: number; summaryLike: boolean; unclearReference: boolean; issue: string; why: string };
export type CreativeHook = { text: string; category: HookCategory; score: number; recommended: boolean; source: 'OPENAI' | 'LOCAL';
  components?: Record<string, number>; CLICKABILITY_SCORE?: number; CONTEXT_SCORE?: number;
  directQuote?: boolean; support?: string; review?: HookReview; existing?: boolean };
export type HookCandidate = { text: string; category: HookCategory; directQuote?: boolean; support?: string; review?: HookReview };
export type CreativeDraft = { hooks: HookCandidate[]; synopsis: string;
  captions: Array<{ style: 'Concise' | 'Engaging' | 'Professional' | 'Humorous' | 'Conversational' | 'Bold'; text: string }>;
  hashtagSets: Array<{ label: 'Focused' | 'Niche' | 'Broad'; hashtags: string[] }>; supportingLine: string };
export type QualityResult = { passed: boolean; score: number; failures: string[] };

/**
 * One definition of a strong hook. The writer is told to optimise for exactly this and the
 * reviewer scores exactly this, so the two can never disagree about what "good" means.
 */
export const HOOK_RUBRIC = [
  'A strong hook is judged on seven things, and the same seven decide whether it is accepted:',
  '(1) Clickability: a viewer stops scrolling because of tension, contrast, stakes or a surprising reframing that the clip then pays off.',
  '(2) Curiosity gap: it opens a question or gap that the clip actually answers. Never promise an explanation, result or reveal the clip does not deliver.',
  '(3) Specificity: it is anchored in this clip\'s own subject, claim or turn, not a template that would fit any video.',
  '(4) Contextual relevance: it is about what the delivered clip is really about.',
  '(5) Truthful framing: every claim, implication and question must be supported by the clip, and a hook may claim only as much as the moment it rests on actually shows: an example is an example, not a general mechanism, cause, scale, intent or blame; a mismatch or a check is not an explanation; do not attribute names, labels, statements, actions or intentions to a person, company or product unless the clip itself does; a why/how question promises an explanation, so the clip itself must give it.',
  '(6) Natural language and stand-alone clarity: it sounds like something a person would say and makes sense to someone who has not heard the clip, so name the subject instead of leaning on an unresolved "it", "this" or "they"; no forced template, filler or translation-ese.',
  '(7) Audience appeal: someone who cares about this topic would want to keep watching.',
  'GROUNDING MEANS the implied claim, tension or question is supported by the clip. It does NOT mean the hook reuses the transcript\'s words. '
  + 'A hook can share almost no vocabulary with the transcript and still be strongly grounded. Example: transcript "I kept saying yes to everything until I realized I had no time left for myself." '
  + 'Good hook: "The hidden cost of always being the \'nice\' one" (grounded: the clip is about what constant agreeableness costs the speaker).',
  'Inference is allowed, invention is not. Framings like "the real reason...", "what nobody tells you...", "this changes how you see...", "the uncomfortable truth...", "why this keeps happening..." '
  + 'are fine ONLY when the clip actually supports that framing. Never invent facts, names, numbers, quotes, outcomes, authority, controversy, accusations or events the clip does not establish, '
  + 'and never imply a cause or result the clip does not state.'
].join(' ');

export function transcriptSimilarity(hook: string, transcript: string) {
  const h = normalize(hook).split(' ').filter(Boolean), t = normalize(transcript).split(' ');
  let run = 0, longest = 0, prev = new Array(t.length + 1).fill(0);
  for (const word of h) { const next = new Array(t.length + 1).fill(0);
    t.forEach((other, j) => { if (word === other) { run = prev[j] + 1; next[j + 1] = run; longest = Math.max(longest, run); } }); prev = next; }
  const sentences = transcript.split(/(?<=[.!?।])\s+/u);
  const similarity = Math.max(0, ...sentences.map(s => { const known = new Set(normalize(s).split(' '));
    return h.filter(w => known.has(w)).length / Math.max(1, h.length); }));
  return { longestRun: longest, copied: longest >= 5 || (longest >= 3 && longest / Math.max(1, h.length) >= .7) || similarity >= .9, similarity };
}
export const normalizeTags = (values: unknown) => Array.isArray(values) ? [...new Set(values.filter((v): v is string => typeof v === 'string')
  .map(v => '#' + v.replace(/^#+/u, '').trim()).filter(v => /^#[\p{L}\p{M}\p{N}_]{1,60}$/u.test(v)))].slice(0, 8) : [];
const generic = /(?:this (?:video|clip) (?:discusses|talks|shows)|watch (?:till|until) the end|you (?:won['’]t|wont|will not|will never|can['’]t|cannot) (?:even )?believe|guaranteed viral|go viral|change your life|secret to success|worth discussing|the context makes the moment land)/iu;
const spam = /^#(?:viral|fyp|foryou|trending|reels|shorts)$/iu;
const concept = (word:string) => /^[a-z]+$/u.test(word) ? word.replace(/ies$/u,'y').replace(/(?<!s)s$/u,'') : word;
const concepts = (text:string) => terms(text).map(concept);
/** Hard factual checks: no filler, invented numbers, quotes or attributed names. */
export function factual(text: string, e: ContentEvidence) {
  const evidence = evidenceText(e);
  if (!text.trim() || generic.test(text)) return false;
  const nums = text.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  const supportedNumbers: string[] = evidence.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  if (nums.some(n => !supportedNumbers.includes(n))) return false;
  if ([...text.matchAll(/[“"]([^”"]+)[”"]/gu)].some(m => !normalize(evidence).includes(normalize(m[1])))) return false;
  // Names/organizations in title case require literal textual support. Never trust a generated identity.
  if ([...text.matchAll(/\b(?:by|with|from|says|said|according to)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/gu)]
    .some(m => !normalize(evidence).includes(normalize(m[1])))) return false;
  return true;
}
/** Factual and lexically close to the evidence. Low overlap alone is not proof of an invented claim. */
export function grounded(text: string, e: ContentEvidence) {
  const known = new Set(concepts(evidenceText(e))), keys = concepts(text);
  return factual(text, e) && keys.filter(k => known.has(k)).length / Math.max(1, keys.length) >= .2;
}
/**
 * Mid-sentence title-case words the clip never mentions are invented identities (people, brands, places).
 * A sentence-initial capital is ordinary grammar and is ignored; a brand split into words ("Uber Eats")
 * is supported by its joined spelling ("UberEats").
 */
export function inventedNames(text: string, e: ContentEvidence): string[] {
  const known = new Set(normalize(evidenceText(e)).split(' ').filter(Boolean));
  // Derivational forms count as support (America/American, Somali/Somalia): a long shared stem, not just a plural.
  const stems = [...known].filter(k => k.length >= 5);
  const has = (w: string) => known.has(w) || known.has(w.replace(/s$/u, '')) || known.has(w + 's')
    || (w.length >= 5 && stems.some(k => k.startsWith(w) || w.startsWith(k)));
  const words = text.split(/\s+/u).filter(Boolean), missing: string[] = [];
  let phrase: string[] = [];
  // "UberEats" in a hook is supported by "Uber Eats" in the clip, and the reverse.
  const supportedWord = (w: string) => {
    const parts = w.match(/[A-Z][a-z]+/gu) ?? [];
    return has(w.toLowerCase()) || (parts.length > 1 && parts.every(part => has(part.toLowerCase())));
  };
  const flush = () => {
    if (phrase.length && !has(phrase.join('').toLowerCase()) && !phrase.every(supportedWord)) missing.push(phrase.join(' '));
    phrase = [];
  };
  // A Title Case headline capitalises ordinary words ("Are", "Your") by style, so a plain capital proves nothing there;
  // only unmistakable brands (CamelCase) and acronyms are checked in that case.
  const long = words.filter(w => w.replace(/[^\p{L}]/gu, '').length >= 3);
  const titleCase = long.length >= 4 && long.filter(w => /^\p{Lu}/u.test(w.replace(/^[^\p{L}]+/u, ''))).length / long.length >= .6;
  words.forEach((raw, i) => {
    const clean = raw.replace(/^[^\p{L}]+|[^\p{L}-]+$/gu, '').replace(/['’]s$/u, '');
    const sentenceStart = i === 0 || /[.!?:;—–]$/u.test(words[i - 1]);
    const parts = clean.split('-').filter(Boolean);
    const plainWord = (p: string) => /^[A-Z][a-z]+$/u.test(p);
    const proper = !sentenceStart && parts.length > 0 && parts.every(p => p.length >= 3 && /^(?:[A-Z][a-z]+(?:[A-Z][a-z]+)*|[A-Z]{3,})$/u.test(p) && !(titleCase && plainWord(p)));
    if (proper) phrase.push(...parts); else flush();
  });
  flush();
  return missing;
}
/** Hard (objective) screen applied to every hook before any quality judgement. */
export type HookRejectionCode = 'SCHEMA_INVALID' | 'DUPLICATE_OR_EXCLUDED' | 'LENGTH_POLICY' | 'FACTUAL_FILTER' | 'INVENTED_NAME'
  | 'SUMMARY_STYLE' | 'TRANSCRIPT_COPY' | 'HUMOR_NOT_SUPPORTED' | 'LEXICAL_UNGROUNDED' | 'LOW_CONTEXT_LEXICAL' | 'NEAR_DUPLICATE'
  | 'CATEGORY_CAP' | 'NOT_REVIEWED' | 'REVIEW_NOT_APPROVED' | 'LOW_CLICKABILITY' | 'LOW_CONTEXT' | 'LOW_SPECIFICITY'
  | 'GENERIC_SUMMARY' | 'LOW_NOVELTY' | 'LOW_GROUNDING' | 'MISLEADING' | 'UNRESOLVED_PRONOUN' | 'UNCLEAR_REFERENCE' | 'LOW_NATURALNESS' | 'UNSUPPORTED_DETAIL';
export type HookRejection = { text: string; category?: string; code: HookRejectionCode; detail: string;
  scores?: { clickability: number; context: number; grounding: number; misleadingRisk: number; specificity: number; naturalness?: number } };
export type ScreenedHook = { text: string; category: HookCategory; count: number; directQuote: boolean; support?: string;
  review?: HookReview; copy: ReturnType<typeof transcriptSimilarity> };

/** Paraphrase-only (low word overlap) failures; a passing semantic review may clear these, never hard failures. */
export const SEMANTIC_REVIEWABLE_FAILURES = new Set(['CAPTION_LOW_OVERLAP', 'HASHTAG_LOW_OVERLAP', 'SUPPORTING_LINE_LOW_OVERLAP', 'SYNOPSIS_LOW_OVERLAP']);
const relevantTag = (tag: string, e: ContentEvidence) => terms(evidenceText(e)).some(w => normalize(tag).includes(w));
const summaryHook = /^(?:how .+ works?|they (?:talk|discuss)|.+ is important|this is why .+ matters|an? (?:overview|guide|discussion) (?:of|about))/iu;
const leadingPronoun = /^[^\p{L}]*(?:they|them|their|theirs|he|him|his|she|her|hers)(?![\p{L}])/iu;
const pct = (v: number | undefined) => Math.round((v ?? 0) * 100);
export const hookMeetsThreshold = (h: CreativeHook) => (h.CLICKABILITY_SCORE ?? 0) >= HOOK_POLICY.clickabilityThreshold
  && (h.CONTEXT_SCORE ?? 0) >= HOOK_POLICY.contextThreshold && pct(h.components?.specificity) >= HOOK_POLICY.specificityThreshold
  && pct(h.components?.novelty) >= HOOK_POLICY.noveltyThreshold
  && (h.components?.factualGrounding === undefined || pct(h.components.factualGrounding) >= HOOK_POLICY.groundingThreshold)
  && (h.components?.misleadingRisk === undefined || pct(h.components.misleadingRisk) <= HOOK_POLICY.misleadingRiskMax)
  && (!h.review || pct(h.components?.clarity) >= HOOK_POLICY.naturalnessThreshold) && !h.review?.unclearReference;
const cue = /\?|\b(?:why|hidden|truth|risk|instead|actually|without|behind|cost|wrong|until|mistake|problem|ends|begin|versus|exposed|changes|despite|unexpected|disagree|respect)\b|क्यों|कैसे|सच|गलती|कीमत|लेकिन|kya|kyun|kaise|lekin|galti/iu;
const reusableFrameRe = /^(?:what's behind|.+: what actually matters|.+ through the lens of)/iu;
/** Points of appeal a hook may lose for not fitting every template at a readable size. */
const TEMPLATE_FIT_PENALTY = 10;
const appeal = (h: CreativeHook) => h.score - (h.components?.templateFit === 0 ? TEMPLATE_FIT_PENALTY : 0);
/**
 * Choosing among hooks that ALL clear every bar. Tier 0 = comfortably grounded (grounding >=85, misleading risk <=15, well inside the
 * 70/30 bars): such a hook always outranks a marginal one, so a punchier but riskier claim never wins on appeal alone. Within a tier the
 * more clickable, more specific hook wins, so a safe but slogan-like line does not beat a real hook. Bars and the composite are unchanged.
 */
const pickScore = (h: CreativeHook) => { const r = h.review!, c = h.components!;
  return r.clickability * .45 + r.specificity * .15 + r.context * .10 + r.grounding * .10 + (100 - r.misleadingRisk) * .10
    + (c.novelty ?? 0) * 100 * .05 + (c.mobileReadability ?? 1) * 100 * .05 - (c.templateFit === 0 ? TEMPLATE_FIT_PENALTY : 0); };
const safetyTier = (h: CreativeHook) => h.review!.grounding >= 85 && h.review!.misleadingRisk <= 15 ? 0 : 1;
const selectionOrder = (a: CreativeHook, b: CreativeHook) => a.review && b.review ? safetyTier(a) - safetyTier(b) || pickScore(b) - pickScore(a) : appeal(b) - appeal(a);
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const score100 = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v)) : undefined;

/** Parses one reviewer entry. Anything incomplete is treated as unreviewed, never as approved. */
export function parseHookReview(raw: unknown): HookReview | undefined {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return undefined;
  const [clickability, context, grounding, misleadingRisk, specificity, naturalness] =
    ['clickability', 'context', 'grounding', 'misleadingRisk', 'specificity', 'naturalness'].map(k => score100(r[k]));
  if ([clickability, context, grounding, misleadingRisk, specificity, naturalness].some(v => v === undefined) || typeof r.approved !== 'boolean') return undefined;
  return { approved: r.approved, clickability: clickability!, context: context!, grounding: grounding!, misleadingRisk: misleadingRisk!,
    specificity: specificity!, naturalness: naturalness!, summaryLike: r.summaryLike === true, unclearReference: r.unclearReference === true,
    issue: typeof r.issue === 'string' ? r.issue.slice(0, 300) : '', why: typeof r.why === 'string' ? r.why.slice(0, 300) : '' };
}
/** Which numeric bars a reviewed hook misses. Empty means every bar is met. */
export function reviewMisses(r: HookReview, novelty: number): Array<{ code: HookRejectionCode; detail: string }> {
  const out: Array<{ code: HookRejectionCode; detail: string }> = [];
  if (r.grounding < HOOK_POLICY.groundingThreshold) out.push({ code: 'LOW_GROUNDING', detail: `grounding ${r.grounding}<${HOOK_POLICY.groundingThreshold}` });
  if (r.misleadingRisk > HOOK_POLICY.misleadingRiskMax) out.push({ code: 'MISLEADING', detail: `misleading risk ${r.misleadingRisk}>${HOOK_POLICY.misleadingRiskMax}` });
  if (r.summaryLike) out.push({ code: 'GENERIC_SUMMARY', detail: 'reads as a topic summary, not a hook' });
  if (r.unclearReference) out.push({ code: 'UNCLEAR_REFERENCE', detail: 'depends on a pronoun or reference a viewer who has not heard the clip cannot resolve' });
  if (r.naturalness < HOOK_POLICY.naturalnessThreshold) out.push({ code: 'LOW_NATURALNESS', detail: `naturalness ${r.naturalness}<${HOOK_POLICY.naturalnessThreshold}` });
  if (r.specificity < HOOK_POLICY.specificityThreshold) out.push({ code: 'LOW_SPECIFICITY', detail: `specificity ${r.specificity}<${HOOK_POLICY.specificityThreshold}` });
  if (r.clickability < HOOK_POLICY.clickabilityThreshold) out.push({ code: 'LOW_CLICKABILITY', detail: `clickability ${r.clickability}<${HOOK_POLICY.clickabilityThreshold}` });
  if (r.context < HOOK_POLICY.contextThreshold) out.push({ code: 'LOW_CONTEXT', detail: `context ${r.context}<${HOOK_POLICY.contextThreshold}` });
  if (novelty * 100 < HOOK_POLICY.noveltyThreshold) out.push({ code: 'LOW_NOVELTY', detail: `novelty ${Math.round(novelty * 100)}<${HOOK_POLICY.noveltyThreshold}` });
  if (!out.length && !r.approved) out.push({ code: 'REVIEW_NOT_APPROVED', detail: r.issue || 'reviewer did not approve' });
  return out;
}
/** Plain-language instruction per failure kind; the stronger model is told exactly what went wrong. */
const INSTRUCTION: Partial<Record<HookRejectionCode, (r: HookRejection) => string>> = {
  GENERIC_SUMMARY: () => 'Previous hook was too generic: it summarised the topic. Increase specificity and stakes using the concrete turn of this clip.',
  LOW_SPECIFICITY: () => 'Previous hook was too generic. Increase specificity and stakes: name the concrete element of this clip that creates the tension.',
  LOW_CLICKABILITY: () => 'Previous hook was flat. Sharpen the curiosity gap or tension so a viewer needs the answer, while staying inside what the clip delivers.',
  LOW_GROUNDING: r => `Previous hook was not supported by the clip${r.detail ? ` (${r.detail})` : ''}. Keep the curiosity but remove the unsupported implication.`,
  MISLEADING: r => `Previous hook was misleading${r.detail ? ` (${r.detail})` : ''}. Keep the curiosity but remove the unsupported implication; promise only what the clip delivers.`,
  LOW_CONTEXT: () => 'Previous hook drifted from what the clip actually delivers. Re-anchor it in the clip\'s own subject.',
  LOW_NOVELTY: () => 'Previous hook echoed the transcript or a reusable template. Reframe it in new words.',
  TRANSCRIPT_COPY: () => 'Previous hook copied transcript wording. Reframe it in new words.',
  FACTUAL_FILTER: r => `Previous hook contained an unsupported number, quote or name${r.detail ? ` (${r.detail})` : ''}. Use only what the clip states.`,
  INVENTED_NAME: r => `Previous hook named something the clip never mentions (${r.detail}). Use only names the clip contains.`,
  SUMMARY_STYLE: () => 'Previous hook read like a topic description. Make it a hook with tension or a question the clip answers.',
  LENGTH_POLICY: () => 'Previous hook broke the 4-26 word limit.',
  UNSUPPORTED_DETAIL: r => `Previous hook added a speed or intensity claim the clip never makes (${r.detail}). Say only what is heard or shown.`,
  UNRESOLVED_PRONOUN: () => 'Previous hook opened with a pronoun (they, he, she) that has no antecedent for a viewer. Name the subject instead.',
  UNCLEAR_REFERENCE: () => 'Previous hook relied on a reference a viewer cannot resolve on their own. Name the subject plainly.',
  LOW_NATURALNESS: () => 'Previous hook sounded stilted or machine-written. Say it the way a person would.',
  HUMOR_NOT_SUPPORTED: () => 'Humor or sarcasm is not supported by this clip. Write sincerely.',
  REVIEW_NOT_APPROVED: r => `The reviewer rejected a previous hook: ${r.detail}`
};
export function rejectionGuidance(rejections: HookRejection[]) {
  const counts = new Map<string, { n: number; text: string }>();
  for (const r of rejections) {
    const make = INSTRUCTION[r.code]; if (!make) continue;
    const text = make(r), cur = counts.get(r.code);
    if (cur) cur.n++; else counts.set(r.code, { n: 1, text });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map(v => v.text);
}

@Injectable()
export class CreativeQualityService {
  /**
   * Objective gates only: structure, duplicates, length, invented facts/names, summary wording,
   * transcript copying and unsupported humor. Word overlap with the transcript is deliberately NOT here:
   * whether a paraphrased claim is supported is a question of meaning.
   */
  screen(candidates: Array<Partial<HookCandidate>> | undefined, evidence: ContentEvidence, u: ContentUnderstanding, exclude: string[] = [],
    options: { strictReference?: boolean } = {}) {
    const seen = new Set(exclude.map(normalize)), passed: ScreenedHook[] = [], rejected: HookRejection[] = [];
    for (const candidate of candidates ?? []) {
      const raw = typeof candidate?.text === 'string' ? candidate.text : '';
      if (typeof candidate?.text !== 'string' || !HOOK_CATEGORIES.includes(candidate.category as HookCategory)) {
        rejected.push({ text: raw, category: candidate?.category, code: 'SCHEMA_INVALID', detail: 'missing text or unknown category' }); continue; }
      const category = candidate.category as HookCategory;
      const text = candidate.text.replace(/\s+/gu, ' ').trim(), count = text.split(' ').length, reject = (code: HookRejectionCode, detail: string) =>
        void rejected.push({ text, category, code, detail });
      if (seen.has(normalize(text))) { reject('DUPLICATE_OR_EXCLUDED', 'already used or excluded'); continue; }
      if (text.length > HOOK_POLICY.maxCharacters || count < HOOK_POLICY.minWords || count > HOOK_POLICY.maxWords) { reject('LENGTH_POLICY', `${count} words`); continue; }
      if (!factual(text, evidence)) { reject('FACTUAL_FILTER', 'unsupported number, quote, attributed name or filler claim'); continue; }
      // Speed/intensity adverbs ("instantly", "in seconds") are claims about HOW FAST or HOW MUCH; the reviewer misses them, so check objectively.
      const evidenceNorm = normalize(evidenceText(evidence));
      const unsupportedDetail = [...text.matchAll(/\b(?:instantly|immediately|in seconds|within seconds|right away|in an instant|overnight)\b/giu)].map(m => m[0]).find(w => !evidenceNorm.includes(normalize(w)));
      if (unsupportedDetail) { reject('UNSUPPORTED_DETAIL', `"${unsupportedDetail}"`); continue; }
      const invented = inventedNames(text, evidence);
      if (invented.length) { reject('INVENTED_NAME', invented.join(', ')); continue; }
      if (summaryHook.test(text)) { reject('SUMMARY_STYLE', 'topic-description wording'); continue; }
      // A model-written hook that opens with a third-person pronoun has no antecedent for a viewer who has not heard the clip.
      // (Not applied to locally shortened user wording, which may legitimately keep the user's own opening.)
      if (options.strictReference && leadingPronoun.test(text)) { reject('UNRESOLVED_PRONOUN', 'opens with a pronoun that has no antecedent'); continue; }
      const copy = transcriptSimilarity(text, evidence.transcript);
      // Quotes are opt-in and require a strong, exact, supported line; ordinary copied subtitles are refused.
      const directQuote = candidate.directQuote === true && normalize(evidence.transcript).includes(normalize(text))
        && cue.test(text) && count >= 8 && /[?!]|\b(?:never|wrong|cost|risk)\b/iu.test(text);
      if (copy.copied && !directQuote) { reject('TRANSCRIPT_COPY', `longest run ${copy.longestRun} words, similarity ${copy.similarity.toFixed(2)}`); continue; }
      if (category === 'HUMOROUS' && !u.humorSupported || category === 'SARCASTIC' && !u.sarcasmSupported) { reject('HUMOR_NOT_SUPPORTED', category); continue; }
      seen.add(normalize(text));
      passed.push({ text, category, count, directQuote, copy, support: typeof candidate.support === 'string' ? candidate.support.slice(0, 200) : undefined,
        review: candidate.review });
    }
    return { passed, rejected };
  }
  /** Keyword/lexical heuristics. Authoritative only for locally generated hooks that no model reviewed. */
  private heuristic(s: ScreenedHook, evidence: ContentEvidence) {
    const key = concepts(s.text), known = new Set(concepts([evidence.transcript, evidence.visibleText, evidence.visualSummary].filter(Boolean).join(' ')));
    const overlap = key.filter(w => known.has(w));
    const relevance = Math.min(1, overlap.length / Math.max(1, key.length) * 2);
    const contextScore = Math.round(Math.min(1, relevance * .65 + Math.min(1, overlap.length / 2) * .35) * 100);
    const curiosity = cue.test(s.text) ? 1 : .35;
    const emotional = /boundaries|fear|approval|loss|trust|risk|hope|regret|cost/iu.test(s.text) ? 1 : .5;
    const reusableFrame = reusableFrameRe.test(s.text);
    const tension = /\b(?:but|until|wrong|cost|problem|risk|without|ends|boundary|boundaries|disagree|versus|mistake|instead)\b|लेकिन|गलती|नुकसान|lekin|galti/iu.test(s.text) ? 1 : .45;
    const specificity = Math.min(1, overlap.length / 2);
    const novelty = s.directQuote ? .65 : (1 - s.copy.similarity * .45) * (reusableFrame ? .45 : 1);
    const readability = s.count <= 22 ? 1 : .85;
    const clickability = Math.round((curiosity * .4 + tension * .2 + emotional * .15 + specificity * .15 + novelty * .1) * 100);
    return { overlap, relevance, contextScore, curiosity, emotional, reusableFrame, tension, specificity, novelty, readability, clickability };
  }
  private build(s: ScreenedHook, evidence: ContentEvidence, source: CreativeHook['source']): CreativeHook {
    const h = this.heuristic(s, evidence), r = s.review;
    const base = { source, recommended: false, text: s.text, category: s.category, ...(s.directQuote ? { directQuote: true } : {}),
      ...(s.support ? { support: s.support } : {}) };
    if (!r) {
      const components = { relevance: h.relevance, factualGrounding: 1, faithfulness: 1, novelty: h.novelty, specificity: h.specificity, clarity: 1,
        curiosity: h.curiosity, emotionalPull: h.emotional, tension: h.tension, mobileReadability: h.readability, audienceFit: 1, toneFit: 1,
        transcriptCopySimilarity: s.copy.similarity, genericness: h.reusableFrame ? 1 : 0, misleadingRisk: 0 };
      return { ...base, score: Math.round(h.contextScore * .35 + h.clickability * .35 + h.novelty * 15 + h.readability * 10 + h.specificity * 5),
        components, CLICKABILITY_SCORE: h.clickability, CONTEXT_SCORE: h.contextScore };
    }
    // A semantic verdict replaces the keyword proxies. Novelty stays objective: it measures copying of the transcript.
    const components = { relevance: r.context / 100, factualGrounding: r.grounding / 100, faithfulness: r.grounding / 100, novelty: h.novelty,
      specificity: r.specificity / 100, clarity: r.naturalness / 100, curiosity: h.curiosity, emotionalPull: h.emotional, tension: h.tension,
      mobileReadability: h.readability, audienceFit: r.clickability / 100, toneFit: 1, transcriptCopySimilarity: s.copy.similarity,
      genericness: r.summaryLike || h.reusableFrame ? 1 : 0, misleadingRisk: r.misleadingRisk / 100, templateFit: hookFitsTemplates(s.text).all ? 1 : 0 };
    // Grounding, context and misleading risk are already pass/fail bars; among hooks that clear them, appeal decides the order.
    // Safety is weighed as heavily as appeal: of two hooks that clear the bars, the better-supported one is chosen.
    const score = Math.round(clamp(r.clickability * .35 + r.context * .15 + r.grounding * .20 + r.specificity * .15
      + h.novelty * 100 * .05 + h.readability * 100 * .05 - r.misleadingRisk * .30));
    return { ...base, score, components, CLICKABILITY_SCORE: r.clickability, CONTEXT_SCORE: r.context, review: r };
  }
  /**
   * Chooses which screened hooks the semantic reviewer sees: one per mechanism first, in a fixed priority order,
   * so a single flat or over-reaching angle can never crowd out the rest. Word-overlap is never used to order them.
   */
  shortlist(passed: ScreenedHook[], limit = 8): ScreenedHook[] {
    const order: HookCategory[] = ['CURIOSITY', 'TENSION', 'HIDDEN_TRUTH', 'CONTRARIAN', 'QUESTION', 'STORY', 'BOLD', 'EMOTIONAL',
      'REVEAL', 'MISTAKE', 'MYTH_REALITY', 'UNEXPECTED_RESULT', 'CONFLICT', 'CHALLENGE', 'WARNING', 'AUTHORITY', 'BEFORE_AFTER', 'WAIT_UNTIL', 'PROFESSIONAL', 'HUMOROUS', 'SARCASTIC'];
    const byCategory = new Map<HookCategory, ScreenedHook[]>();
    for (const s of passed) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);
    const picked: ScreenedHook[] = [];
    for (let round = 0; picked.length < limit && round < 4; round++) for (const c of order) {
      const s = byCategory.get(c)?.[round]; if (!s || picked.length >= limit) continue;
      const keys = terms(s.text);
      if (picked.some(k => { const o = terms(k.text); return keys.filter(w => o.includes(w)).length / Math.max(1, Math.max(keys.length, o.length)) >= .8; })) continue;
      picked.push(s);
    }
    return picked;
  }
  /** Joins reviewer entries (by position) to the shortlisted hooks and applies every numeric bar. */
  applyReviews(shortlist: ScreenedHook[], reviews: unknown[], evidence: ContentEvidence, source: CreativeHook['source'] = 'OPENAI') {
    const approved: CreativeHook[] = [], rejected: HookRejection[] = [];
    shortlist.forEach((s, i) => {
      const entry = (reviews.find(r => (r as { index?: unknown })?.index === i) ?? undefined), review = parseHookReview(entry);
      if (!review) { rejected.push({ text: s.text, category: s.category, code: 'NOT_REVIEWED', detail: 'reviewer returned no complete verdict' }); return; }
      const hook = this.build({ ...s, review }, evidence, source), misses = reviewMisses(review, hook.components!.novelty);
      const scores = { clickability: review.clickability, context: review.context, grounding: review.grounding,
        misleadingRisk: review.misleadingRisk, specificity: review.specificity, naturalness: review.naturalness };
      if (misses.length) for (const m of misses) rejected.push({ text: s.text, category: s.category, code: m.code,
        detail: [m.detail, review.issue].filter(Boolean).join(' - '), scores });
      else approved.push(hook);
    });
    return { approved: this.order(approved), rejected };
  }
  /** The hook as the pipeline would score it for this review, whether or not it clears every bar (benchmarks and calibration). */
  scoreReviewed(screened: ScreenedHook, review: HookReview, evidence: ContentEvidence, source: CreativeHook['source'] = 'OPENAI'): CreativeHook {
    return this.build({ ...screened, review }, evidence, source);
  }
  private order(hooks: CreativeHook[]) {
    // Among hooks that already clear every bar, one that needs no shortening in any template is preferred unless it
    // trails the best by more than TEMPLATE_FIT_PENALTY points of appeal. A long hook is never rejected for length.
    hooks.sort((a, b) => Number(hookMeetsThreshold(b)) - Number(hookMeetsThreshold(a)) || selectionOrder(a, b));
    hooks.forEach((h, i) => { h.recommended = i === 0; });
    return hooks;
  }
  /**
   * "Do not replace a good hook for the sake of replacing it." A generated rewrite must beat the existing hook by a meaningful
   * margin (HOOK_POLICY.existingHookMargin composite points) or solve a known problem; otherwise the existing hook stays.
   * Known problems: the existing hook fails the objective screen or any reviewer bar, does not reach the composite quality bar,
   * or does not fit the templates while a generated one does. The existing hook is judged by the same screen and reviewer.
   */
  chooseAgainstExisting(generated: CreativeHook[], existing: CreativeHook | undefined, existingProblems: string[], qualityBar: number) {
    const bestGenerated = generated[0];
    if (!existing) return { hooks: generated, preserved: false, reason: existingProblems.length ? `existing hook has a known problem: ${existingProblems.join('; ')}` : 'no existing hook' };
    const problems = [...existingProblems];
    if (!hookMeetsThreshold(existing)) problems.push('misses a quality bar');
    if (existing.score < qualityBar) problems.push(`composite ${existing.score} below the ${qualityBar} bar`);
    if (existing.components?.templateFit === 0 && generated.some(h => h.components?.templateFit === 1)) problems.push('does not fit the templates');
    existing.existing = true;
    const byAppeal = (list: CreativeHook[]) => list.sort(selectionOrder);
    if (problems.length) return { hooks: bestGenerated ? generated : [], preserved: false, reason: `existing hook has a known problem: ${problems.join('; ')}` };
    if (!bestGenerated) return { hooks: [existing], preserved: true, reason: 'no generated hook was approved; the existing hook is acceptable' };
    const gain = appeal(bestGenerated) - appeal(existing);
    if (gain >= HOOK_POLICY.existingHookMargin) return { hooks: byAppeal([...generated, existing]).map((h, i) => ({ ...h, recommended: i === 0 })), preserved: false,
      reason: `generated hook beats the existing hook by ${gain} points (needs ${HOOK_POLICY.existingHookMargin})` };
    const rest = byAppeal([...generated]);
    return { hooks: [existing, ...rest].map((h, i) => ({ ...h, recommended: i === 0 })), preserved: true,
      reason: `existing hook kept: the best generated hook is ${gain} points better (needs ${HOOK_POLICY.existingHookMargin})` };
  }
  /**
   * Ranks hooks. Hooks that carry a semantic review are trusted (their meaning was judged, so paraphrase is fine).
   * Unreviewed hooks keep the conservative lexical rule: they must visibly share concepts with the clip.
   */
  rankDetailed(candidates: Array<Partial<HookCandidate>> | undefined, evidence: ContentEvidence, u: ContentUnderstanding,
    source: CreativeHook['source'] = 'OPENAI', exclude: string[] = []) {
    const { passed, rejected } = this.screen(candidates, evidence, u, exclude), accepted: CreativeHook[] = [];
    for (const s of passed) {
      if (s.review) {
        const hook = this.build(s, evidence, source), misses = reviewMisses(s.review, hook.components!.novelty);
        if (misses.length) { for (const m of misses) rejected.push({ text: s.text, category: s.category, code: m.code, detail: m.detail }); continue; }
        accepted.push(hook); continue;
      }
      if (!grounded(s.text, evidence)) { rejected.push({ text: s.text, category: s.category, code: 'LEXICAL_UNGROUNDED', detail: 'too little vocabulary shared with the clip (unreviewed hook)' }); continue; }
      const hook = this.build(s, evidence, source);
      if ((hook.CONTEXT_SCORE ?? 0) < HOOK_POLICY.contextThreshold) { rejected.push({ text: s.text, category: s.category, code: 'LOW_CONTEXT_LEXICAL', detail: `lexical context ${hook.CONTEXT_SCORE}` }); continue; }
      accepted.push(hook);
    }
    accepted.sort((a,b) => Number(hookMeetsThreshold(b)) - Number(hookMeetsThreshold(a)) || selectionOrder(a, b));
    const kept: CreativeHook[] = [];
    for (const h of accepted) {
      if (kept.filter(k => k.category === h.category).length >= 2) { rejected.push({ text: h.text, category: h.category, code: 'CATEGORY_CAP', detail: 'two hooks of this category already kept' }); continue; }
      const keys = terms(h.text);
      if (kept.some(k => keys.filter(w => terms(k.text).includes(w)).length / Math.max(1, Math.max(keys.length, terms(k.text).length)) >= .8)) {
        rejected.push({ text: h.text, category: h.category, code: 'NEAR_DUPLICATE', detail: 'near-identical to a kept hook' }); continue; }
      kept.push(h); if (kept.length >= 16) break;
    }
    if (kept[0]) kept[0].recommended = true;
    return { kept, rejected };
  }
  rank(candidates: Array<Partial<HookCandidate>> | undefined, evidence: ContentEvidence, u: ContentUnderstanding, source: CreativeHook['source'] = 'OPENAI', exclude: string[] = []): CreativeHook[] {
    return this.rankDetailed(candidates, evidence, u, source, exclude).kept;
  }
  evaluate(d: CreativeDraft, hooks: CreativeHook[], e: ContentEvidence, hooksOnly = false): QualityResult {
    const failures: string[] = [];
    // One approved hook is a complete result: alternates are a convenience, not a quality property.
    if (!hooks.length) failures.push('NO_NOVEL_GROUNDED_HOOK');
    if (hooks[0]) {
      if ((hooks[0].CLICKABILITY_SCORE ?? 0) < HOOK_POLICY.clickabilityThreshold) failures.push('HOOK_LOW_CLICKABILITY');
      if ((hooks[0].CONTEXT_SCORE ?? 0) < HOOK_POLICY.contextThreshold) failures.push('HOOK_LOW_CONTEXT');
      if (pct(hooks[0].components?.specificity) < HOOK_POLICY.specificityThreshold) failures.push('HOOK_LOW_SPECIFICITY');
      if (pct(hooks[0].components?.novelty) < HOOK_POLICY.noveltyThreshold) failures.push('HOOK_LOW_NOVELTY');
      if (hooks[0].components?.factualGrounding !== undefined && pct(hooks[0].components.factualGrounding) < HOOK_POLICY.groundingThreshold) failures.push('HOOK_LOW_GROUNDING');
      if (hooks[0].components?.misleadingRisk !== undefined && pct(hooks[0].components.misleadingRisk) > HOOK_POLICY.misleadingRiskMax) failures.push('HOOK_MISLEADING');
    }
    if (!hooksOnly) failures.push(...this.copyFailures(d, hooks, e));
    return this.result(hooks, failures);
  }
  /** Deterministic checks of everything except the hooks (synopsis, captions, hashtags, supporting line). */
  copyFailures(d: CreativeDraft, hooks: Array<{ text: string }>, e: ContentEvidence): string[] {
    const failures: string[] = [];
    // Filler or an invented number/quote/name is a hard failure. A faithful paraphrase that merely shares few words with
    // the transcript (common with garbled speech recognition) is a question of meaning, so the reviewer decides it.
    if (!factual(d.synopsis ?? '', e)) failures.push('SYNOPSIS_NOT_SPECIFIC');
    else if (!grounded(d.synopsis ?? '', e) || terms(d.synopsis ?? '').filter(t => terms(e.transcript + ' ' + (e.visibleText ?? '')).includes(t)).length < 2)
      failures.push('SYNOPSIS_LOW_OVERLAP');
    if (!d.captions?.length || d.captions.some(c => !factual(c.text, e) || hooks.some(h => normalize(h.text) === normalize(c.text)))) failures.push('CAPTION_UNGROUNDED_OR_REPEATED');
    else if (d.captions.some(c => !grounded(c.text, e))) failures.push('CAPTION_LOW_OVERLAP');
    if (new Set(d.captions?.map(c => normalize(c.text))).size !== d.captions?.length) failures.push('DUPLICATE_CAPTIONS');
    if (d.hashtagSets?.length !== 3 || new Set(d.hashtagSets.map(s=>s.label)).size !== 3 || d.hashtagSets.some(s => !s.hashtags.length || s.hashtags.some(t => spam.test(t)))) failures.push('IRRELEVANT_HASHTAGS');
    else if (d.hashtagSets.some(s => s.hashtags.some(t => !relevantTag(t, e)))) failures.push('HASHTAG_LOW_OVERLAP');
    if (d.supportingLine && (!factual(d.supportingLine, e) || hooks.some(h => normalize(h.text) === normalize(d.supportingLine)))) failures.push('SUPPORTING_LINE_FILLER');
    else if (d.supportingLine && !grounded(d.supportingLine, e)) failures.push('SUPPORTING_LINE_LOW_OVERLAP');
    return failures;
  }
  /** A supported semantic review clears paraphrase-only failures; hard failures always remain. */
  afterSemanticReview(q: QualityResult, hooks: CreativeHook[]): QualityResult {
    return this.result(hooks, q.failures.filter(f => !SEMANTIC_REVIEWABLE_FAILURES.has(f)));
  }
  /** The composite bar a package's best hook must clear (CREATIVE_QUALITY_THRESHOLD, default 75). */
  qualityBar(): number {
    const threshold = Number(process.env.CREATIVE_QUALITY_THRESHOLD || 75);
    return Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 75;
  }
  private result(hooks: CreativeHook[], failures: string[]): QualityResult {
    const score = Math.max(0, (hooks[0]?.score ?? 0) - failures.length * 15);
    return { passed: failures.length === 0 && score >= this.qualityBar(), score, failures };
  }
}
export const sharedQuality = new CreativeQualityService();
