import { Injectable } from '@nestjs/common';
import { evidenceText, normalize, terms, type ContentEvidence, type ContentUnderstanding } from './content-understanding.service';
export const HOOK_CATEGORIES = ['BOLD', 'CURIOSITY', 'CONTRARIAN', 'SARCASTIC', 'HUMOROUS', 'EMOTIONAL', 'QUESTION', 'AUTHORITY', 'STORY', 'WARNING', 'PROFESSIONAL'] as const;
export type HookCategory = typeof HOOK_CATEGORIES[number];
export type CreativeHook = { text: string; category: HookCategory; score: number; recommended: boolean; source: 'OPENAI' | 'LOCAL';
  components?: Record<string, number> };
export type CreativeDraft = { hooks: Array<{ text: string; category: HookCategory }>; synopsis: string;
  captions: Array<{ style: 'Concise' | 'Engaging' | 'Professional' | 'Humorous' | 'Conversational' | 'Bold'; text: string }>;
  hashtagSets: Array<{ label: 'Focused' | 'Niche' | 'Broad'; hashtags: string[] }>; supportingLine: string };
export type QualityResult = { passed: boolean; score: number; failures: string[] };
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
const generic = /(?:this (?:video|clip) (?:discusses|talks|shows)|watch (?:till|until) the end|you won't believe|guaranteed viral|go viral|change your life|secret to success|worth discussing|the context makes the moment land)/iu;
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
/** Paraphrase-only (low word overlap) failures; a passing semantic review may clear these, never hard failures. */
export const SEMANTIC_REVIEWABLE_FAILURES = new Set(['CAPTION_LOW_OVERLAP', 'HASHTAG_LOW_OVERLAP', 'SUPPORTING_LINE_LOW_OVERLAP']);
const relevantTag = (tag: string, e: ContentEvidence) => terms(evidenceText(e)).some(w => normalize(tag).includes(w));
@Injectable()
export class CreativeQualityService {
  rank(candidates: CreativeDraft['hooks'], evidence: ContentEvidence, u: ContentUnderstanding, source: CreativeHook['source'] = 'OPENAI', exclude: string[] = []): CreativeHook[] {
    const seen = new Set(exclude.map(normalize)), accepted: CreativeHook[] = [];
    for (const candidate of candidates ?? []) {
      if (typeof candidate?.text !== 'string' || !HOOK_CATEGORIES.includes(candidate.category)) continue;
      const text = candidate.text.replace(/\s+/gu, ' ').trim(), count = text.split(' ').length;
      if (seen.has(normalize(text)) || text.length > 64 || count < 3 || count > 12 || !grounded(text, evidence)) continue;
      const copy = transcriptSimilarity(text, evidence.transcript); if (copy.copied) continue;
      if (candidate.category === 'HUMOROUS' && !u.humorSupported || candidate.category === 'SARCASTIC' && !u.sarcasmSupported) continue;
      const key = concepts(text), known = new Set(concepts(evidenceText(evidence)));
      const relevance = Math.min(1, key.filter(w => known.has(w)).length / Math.max(1, key.length) * 2);
      const curiosity = /\?|cost|why|hidden|truth|risk|instead|actually|without|behind/iu.test(text) ? 1 : .5;
      const emotional = /boundaries|fear|approval|loss|trust|risk|hope|regret|cost/iu.test(text) ? 1 : .5;
      const reusableFrame = /^(?:what's behind|.+: what actually matters|.+ through the lens of)/iu.test(text);
      const components = { relevance, faithfulness: 1, novelty: (1 - copy.similarity * .5) * (reusableFrame ? .45 : 1), clarity: 1,
        curiosity, emotionalPull: emotional, brevity: 1 - text.length / 200, mobileReadability: 1, toneFit: 1 };
      const score = Math.round(Object.values(components).reduce((a,b) => a+b,0) / Object.keys(components).length * 100);
      seen.add(normalize(text)); accepted.push({ text, category: candidate.category, score, recommended: false, source, components });
    }
    accepted.sort((a,b) => b.score-a.score);
    const kept: CreativeHook[] = [];
    for (const h of accepted) {
      if (kept.filter(k => k.category === h.category).length >= 2) continue;
      const keys = terms(h.text);
      if (kept.some(k => keys.filter(w => terms(k.text).includes(w)).length / Math.max(1, Math.max(keys.length, terms(k.text).length)) >= .8)) continue;
      kept.push(h); if (kept.length >= 16) break;
    }
    if (kept[0]) kept[0].recommended = true;
    return kept;
  }
  evaluate(d: CreativeDraft, hooks: CreativeHook[], e: ContentEvidence, hooksOnly = false): QualityResult {
    const failures: string[] = [];
    if (!hooks.length) failures.push('NO_NOVEL_GROUNDED_HOOK');
    if (hooks.length < 3) failures.push('INSUFFICIENT_DISTINCT_HOOKS');
    if (!hooksOnly) {
      if (!grounded(d.synopsis ?? '', e) || terms(d.synopsis ?? '').filter(t => terms(e.transcript + ' ' + (e.visibleText ?? '')).includes(t)).length < 2)
        failures.push('SYNOPSIS_NOT_SPECIFIC');
      if (!d.captions?.length || d.captions.some(c => !factual(c.text, e) || hooks.some(h => normalize(h.text) === normalize(c.text)))) failures.push('CAPTION_UNGROUNDED_OR_REPEATED');
      else if (d.captions.some(c => !grounded(c.text, e))) failures.push('CAPTION_LOW_OVERLAP');
      if (new Set(d.captions?.map(c => normalize(c.text))).size !== d.captions?.length) failures.push('DUPLICATE_CAPTIONS');
      if (d.hashtagSets?.length !== 3 || new Set(d.hashtagSets.map(s=>s.label)).size !== 3 || d.hashtagSets.some(s => !s.hashtags.length || s.hashtags.some(t => spam.test(t)))) failures.push('IRRELEVANT_HASHTAGS');
      else if (d.hashtagSets.some(s => s.hashtags.some(t => !relevantTag(t, e)))) failures.push('HASHTAG_LOW_OVERLAP');
      if (d.supportingLine && (!factual(d.supportingLine, e) || hooks.some(h => normalize(h.text) === normalize(d.supportingLine)))) failures.push('SUPPORTING_LINE_FILLER');
      else if (d.supportingLine && !grounded(d.supportingLine, e)) failures.push('SUPPORTING_LINE_LOW_OVERLAP');
    }
    return this.result(hooks, failures);
  }
  /** A supported semantic review clears paraphrase-only failures; hard failures always remain. */
  afterSemanticReview(q: QualityResult, hooks: CreativeHook[]): QualityResult {
    return this.result(hooks, q.failures.filter(f => !SEMANTIC_REVIEWABLE_FAILURES.has(f)));
  }
  private result(hooks: CreativeHook[], failures: string[]): QualityResult {
    const score = Math.max(0, (hooks[0]?.score ?? 0) - failures.length * 15);
    const threshold = Number(process.env.CREATIVE_QUALITY_THRESHOLD || 75);
    return { passed: failures.length === 0 && score >= (Number.isFinite(threshold) ? Math.max(0, Math.min(100, threshold)) : 75), score, failures };
  }
}
export const sharedQuality = new CreativeQualityService();
