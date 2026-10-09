import { creativeService, publicCreativePackage } from '../content-intelligence/creative-package.service';
import type { ReframeContentUnderstanding, ReframeHashtagSet, ReframePostCopy, ReframeSocialCaption, ReframeSocialSource } from '@ai-content-platform/shared';
import type { LlmRouterService } from '../processing/llm-router.service';
import type { BoundaryQa } from '../content-intelligence/clip-boundary.service';
import { createPerformanceTelemetry, performanceContext } from '../processing/performance-telemetry';

export const CAPTION_STYLES = ['Concise', 'Engaging', 'Professional', 'Conversational', 'Bold', 'Humorous'] as const;
export const HASHTAG_GROUPS = ['Focused', 'Broad', 'Niche'] as const;
export const REWRITE_DIRECTIONS = ['Shorter', 'More engaging', 'Professional', 'Casual', 'Stronger opening', 'Cleaner CTA'] as const;
export type PostCopyContext = { transcript: string; visibleText: string; subtitleText: string;
  sourceId?: string; transcriptVersion?: string; visualVersion?: string; sceneType?: string; visualSummary?: string;
  speakerTurns?:Array<{speaker:string;text:string}>; template?:string; boundaryQa?:BoundaryQa;
  sourceContext: ReframeSocialSource | null; selectedHook: string; editingDirection: string; purpose: string; selectedCaption: string };
const text = (value: unknown, limit = 2200) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const normal = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const STOP = new Set('the and for that this with from your you are was were have has will can not but into about their they its our how what when where why video watch more only then than also just very really some one all people think know want need like make get good best new help helps here point takeaway closer look consider worth discussing start'.split(' '));
const words = (value: string) => [...new Set((value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => !STOP.has(w)))];
export function emptyPostCopy(): ReframePostCopy {
  return { version: 0, generatedCaptions: [], generatedHashtagSets: [], selectedCaption: '', selectedHashtags: [] };
}
export function normalizeHashtags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value.filter((v): v is string => typeof v === 'string').map(v => `#${v.trim().replace(/^#+/u, '')}`)
    .filter(v => /^#[\p{L}\p{N}_]{1,60}$/u.test(v));
  return [...new Map(tags.map(v => [v.toLowerCase(), v])).values()].slice(0, 15);
}
/** Both prompt and fallback use a bounded whitelist. No URLs, author labels, media metadata or IDs go to AI. */
export function minimalPostContext(c: PostCopyContext) {
  return { transcript: text(c.transcript, 9000), visibleText: text(c.visibleText, 2200), subtitleText: text(c.subtitleText, 2200),
    sourcePostText: text(c.sourceContext?.sourcePostText, 4000), sourceHashtags: normalizeHashtags(c.sourceContext?.sourceHashtags),
    selectedHook: text(c.selectedHook, 200), editingDirection: text(c.editingDirection, 500), purpose: text(c.purpose, 500),
    selectedCaption: text(c.selectedCaption) };
}
const evidenceOf = (c: ReturnType<typeof minimalPostContext>) => [c.transcript, c.visibleText, c.subtitleText].filter(Boolean).join('\n');
/** Reject unsupported numbers, copied originals, empty marketing and lines with no actual-video grounding. */
export function groundedCaption(value: string, evidence: string, original: string) {
  const key = normal(value), actual = normal(evidence);
  if (!key || key === normal(original) || /guaranteed|go viral|best viral|won.t believe|watch till the end/iu.test(value)) return false;
  const numbers: string[] = value.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  const supportedNumbers: string[] = evidence.match(/\d+(?:[.,]\d+)?/gu) ?? [];
  if (numbers.some(n => !supportedNumbers.includes(n))) return false;
  const quoted = [...value.matchAll(/[“"]([^”"]+)[”"]/gu)].map(m => normal(m[1]));
  if (quoted.some(q => !actual.includes(q))) return false;
  const keys = words(value), facts = new Set(words(evidence));
  return keys.length > 0 && keys.filter(k => facts.has(k)).length / keys.length >= .4;
}
/** Legacy endpoint adapter; copy and hooks share evidence, cache, routing and quality. */
export async function generatePostCopy(router: LlmRouterService, context: PostCopyContext, external: boolean, rewrite = '') {
  const p = await performanceContext.run(createPerformanceTelemetry(external ? 'ONLINE' : 'FALLBACK_ONLY'), () => creativeService(router).create({
    external, evidence: { sourceId: context.sourceId, transcriptVersion: context.transcriptVersion, visualVersion: context.visualVersion,
      transcript: context.transcript, visibleText: [context.visibleText, context.subtitleText].filter(Boolean).join('\n'),
      visualSummary: context.visualSummary, sceneType: context.sceneType,
      speakerTurns:context.speakerTurns,template:context.template,boundaryQa:context.boundaryQa,
      sourceTitle: context.sourceContext?.sourcePostTitle, sourceCaption: context.sourceContext?.sourcePostText,
      sourceHashtags: context.sourceContext?.sourceHashtags, intent: context.purpose },
    selectedHook: context.selectedHook, existingHook: context.selectedHook ? {text:context.selectedHook} : undefined,
    direction: [context.editingDirection, rewrite].filter(Boolean).join('; ') }));
  const u = p.understanding;
  return { generatedCaptions: p.captions, generatedHashtagSets: p.hashtagSets,
    understanding: { topic: u.mainTopic, mainMessage: u.centralClaim, audience: u.audience, tone: u.emotionalAngle,
      keyPoints: u.supportedClaims, importantEntities: u.keyEntities, callToAction: '', existingCaptionIntent: context.sourceContext?.sourcePostText ?? '' },
    synopsis: p.synopsis, creativePackage: publicCreativePackage(p), internal: p.internal, warnings: p.warnings };
}
