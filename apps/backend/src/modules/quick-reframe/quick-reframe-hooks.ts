import type { ReframeHook, ReframeHookCategory } from '@ai-content-platform/shared';
import type { LlmRouterService } from '../processing/llm-router.service';
import { createPerformanceTelemetry, performanceContext } from '../processing/performance-telemetry';
import { creativeService } from '../content-intelligence/creative-package.service';
import { HOOK_CATEGORIES, sharedQuality } from '../content-intelligence/creative-quality.service';
import { localUnderstanding, type ContentEvidence } from '../content-intelligence/content-understanding.service';
export { HOOK_CATEGORIES };
export type HookCandidate = { text: string; category?: ReframeHookCategory; source: ReframeHook['source'] };
/** Compatibility adapter; ranking is owned by the shared quality service. */
export function rankHooks(candidates: HookCandidate[], transcript: string, limit = 16): ReframeHook[] {
  const evidence = { transcript };
  return sharedQuality.rank(candidates.map(c => ({ text: c.text, category: c.category ?? 'PROFESSIONAL' })), evidence,
    localUnderstanding(evidence)).slice(0, limit);
}
export async function suggestHooks(router: LlmRouterService, transcript: string, external: boolean, exclude: string[] = [],
  context: Partial<ContentEvidence> = {}, direction = '', category?: ReframeHookCategory, currentHook = '') {
  const p = await performanceContext.run(createPerformanceTelemetry(external ? 'ONLINE' : 'FALLBACK_ONLY'), () =>
    creativeService(router).create({ evidence: { ...context, transcript }, external, hooksOnly: true, exclude, direction, category,
      existingHook: currentHook ? { text: currentHook } : undefined, changeHook: !!direction.trim() }));
  return { hooks: p.hooks, warnings: p.warnings, package: p };
}
