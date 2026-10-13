import { cachedAnalysis, type FreeAnalysis } from './free-analysis';
import { evaluateExistingHook, generateFreeHooks, simpleFallbackHook, type FreeHook } from './free-hooks';
import { freeDraftCopy } from './free-copy';
import { hookFitsTemplates } from '../content-intelligence/hook-fit';
import { HOOK_POLICY, type CreativeDraft, type CreativeHook, type HookCandidate, type HookCategory } from '../content-intelligence/creative-quality.service';
import type { ContentEvidence } from '../content-intelligence/content-understanding.service';

/**
 * XeeFree creative generation: the local counterpart of the shared writer + reviewer. No network, no model, no Pro escalation.
 * Hooks come from the typed-slot engine and its twelve-point gate; copy comes from grounded spans of the clip.
 */
export type FreeCreativeOptions = { exclude?: string[]; direction?: string; category?: HookCategory; hooksOnly?: boolean;
  /** A hook already on the clip. `manual` means the user typed or edited it: it is kept unless they explicitly ask for a rewrite. */
  existingHook?: { text: string; category?: HookCategory; manual?: boolean }; rewrite?: boolean };
export type FreeCreativeTrace = { engine: 'XEEFREE_HOOKS_V1'; candidates: number; gated: number; kept: number; simpleFallback: boolean;
  rejectedByGate: Record<string, number>; preserved: 'NONE' | 'MANUAL' | 'STRONG_EXISTING'; existingProblems: string[]; languageUnverified?: string };
export type FreeCreative = { draft: CreativeDraft; hooks: CreativeHook[]; trace: FreeCreativeTrace; analysis: FreeAnalysis };

const pct = (value: number) => Math.max(0, Math.min(1, value / 100));

export function toCreativeHook(h: FreeHook): CreativeHook {
  const fit = hookFitsTemplates(h.text);
  return { text: h.text, category: h.category, score: h.composite - (fit.all ? 0 : 3), recommended: false, source: 'LOCAL', engine: 'XEEFREE',
    ...(h.copyAllowed ? { directQuote: true } : {}),
    support: h.slots.map(s => s.text).join(' | ').slice(0, 200),
    CLICKABILITY_SCORE: h.scores.clickability, CONTEXT_SCORE: h.scores.context,
    components: { relevance: pct(h.scores.context), factualGrounding: pct(h.scores.grounding), faithfulness: pct(h.scores.grounding), novelty: pct(h.scores.novelty),
      specificity: pct(h.scores.specificity), clarity: pct(h.scores.clarity), curiosity: /^(?:why|how|what|is it true|here)/iu.test(h.text) || /\?$/u.test(h.text) ? 1 : .5,
      emotionalPull: h.category === 'EMOTIONAL' ? 1 : .5, tension: ['CONTRARIAN', 'TENSION', 'CONFLICT', 'MISTAKE', 'WARNING'].includes(h.category) ? 1 : .5,
      mobileReadability: h.text.split(/\s+/u).length <= 16 ? 1 : .85, audienceFit: pct(h.scores.clickability), toneFit: 1, transcriptCopySimilarity: h.copyAllowed ? .6 : .2,
      genericness: 0, misleadingRisk: pct(h.scores.misleadingRisk), templateFit: fit.all ? 1 : 0 } };
}

const asCandidate = (h: CreativeHook): HookCandidate => ({ text: h.text, category: h.category, ...(h.directQuote ? { directQuote: true } : {}), ...(h.support ? { support: h.support } : {}) });
const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function freeCreative(evidence: ContentEvidence, options: FreeCreativeOptions = {}): FreeCreative {
  const analysis = cachedAnalysis({ transcript: evidence.transcript || evidence.visibleText || '', speakerTurns: evidence.speakerTurns, visibleText: evidence.visibleText,
    visualSummary: evidence.visualSummary, sceneType: evidence.sceneType, sourceTitle: evidence.sourceTitle, sourceCaption: evidence.sourceCaption });
  const result = generateFreeHooks(analysis, evidence, { exclude: options.exclude, direction: options.direction, category: options.category, limit: 8 });
  const rejectedByGate: Record<string, number> = {};
  for (const r of result.rejected) for (const g of r.failed) rejectedByGate[g] = (rejectedByGate[g] ?? 0) + 1;
  let chosen = result.hooks.map(toCreativeHook);
  let simpleFallback = false;
  if (!chosen.length) {
    const simple = simpleFallbackHook(analysis, evidence, { exclude: options.exclude });
    if (simple) { chosen = [toCreativeHook(simple)]; simpleFallback = true; }
  }
  // The engine's own order is final: it already weighs the direction, the category and the clip's own answered question.

  // Existing hook policy. A user's own hook always wins unless they asked for a rewrite; a generated one is kept when it still passes
  // the gate strongly and the best new hook is not clearly better ("do not replace a good hook for the sake of replacing it").
  let preserved: FreeCreativeTrace['preserved'] = 'NONE';
  const existingProblems: string[] = [];
  const existing = options.existingHook && !options.rewrite ? options.existingHook : undefined;
  if (existing && existing.text.trim()) {
    const judged = evaluateExistingHook(existing.text, analysis, evidence, existing.category);
    existingProblems.push(...judged.failed);
    const asHook: CreativeHook = { ...toCreativeHook(judged), existing: true };
    const best = chosen[0];
    if (existing.manual) { chosen = [asHook, ...chosen.filter(h => norm(h.text) !== norm(asHook.text))]; preserved = 'MANUAL'; }
    else if (judged.passed && (!best || best.score - asHook.score < HOOK_POLICY.existingHookMargin)) {
      chosen = [asHook, ...chosen.filter(h => norm(h.text) !== norm(asHook.text))]; preserved = 'STRONG_EXISTING';
    }
  }
  chosen.forEach((h, i) => { h.recommended = i === 0; });

  const copy = freeDraftCopy(analysis, chosen.map(h => h.text));
  const draft: CreativeDraft = { hooks: chosen.map(asCandidate), ...copy };
  return { draft, hooks: chosen, analysis, trace: { engine: 'XEEFREE_HOOKS_V1', candidates: result.candidateCount, gated: result.gated.length, kept: chosen.length,
    simpleFallback, rejectedByGate, preserved, existingProblems, ...(result.languageUnverified ? { languageUnverified: result.languageUnverified } : {}) } };
}
