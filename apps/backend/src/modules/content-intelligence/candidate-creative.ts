import type { ScoredClipCandidate } from '../processing/clip-candidates';
import type { GeneratedContent, HookStrategy } from '../processing/openai-clip-judge.service';
import type { ContentEvidence } from './content-understanding.service';
import { localUnderstanding } from './content-understanding.service';
import { deterministicCreative, type CreativePackage } from './creative-package.service';
import { sharedQuality } from './creative-quality.service';
import type { HookCategory } from './creative-quality.service';
import type { BoundaryQa } from './clip-boundary.service';
const strategyFor: Record<HookCategory, HookStrategy> = { BOLD:'strong claim', CURIOSITY:'curiosity',
  CONTRARIAN:'contradiction', SARCASTIC:'opinion/debate', HUMOROUS:'surprising fact', EMOTIONAL:'emotional tension',
  QUESTION:'question', AUTHORITY:'educational/value', STORY:'story setup', WARNING:'warning', PROFESSIONAL:'educational/value',
  HIDDEN_TRUTH:'curiosity', UNEXPECTED_RESULT:'surprising fact', TENSION:'emotional tension', CHALLENGE:'question',
  CONFLICT:'opinion/debate', MISTAKE:'warning', WAIT_UNTIL:'story setup', MYTH_REALITY:'contradiction', BEFORE_AFTER:'story setup', REVEAL:'curiosity' };

export function candidateEvidence(c: ScoredClipCandidate): ContentEvidence {
  const e = c.evidence ?? {};
  const signals = Array.isArray(e.visualSignals) ? e.visualSignals as Array<Record<string, unknown>> : [];
  return { sourceId: c.videoId, startTime: c.startTime, endTime: c.endTime, transcript: c.transcriptText,
    boundaryQa: e.boundaryQa as BoundaryQa | undefined,
    previousContext: c.previousTranscriptContext, nextContext: c.nextTranscriptContext,
    speakerTurns: Array.isArray(e.speakerTurns) ? e.speakerTurns as Array<{speaker:string;text:string}> : undefined,
    sourceTitle: c.overallVideoTopic, analysis: c.clipUnderstanding,
    visibleText: signals.map(s => typeof s.ocrText === 'string' ? s.ocrText : '').filter(Boolean).join('\n'),
    visualSummary: JSON.stringify({ metrics: e.candidateVisualEvidence ?? {}, moments: e.importantMoments ?? [] }).slice(0, 1500),
    sceneType: typeof c.clipUnderstanding?.contentType === 'string' ? c.clipUnderstanding.contentType : undefined };
}
export function candidateContent(p: Pick<CreativePackage, 'hooks' | 'synopsis' | 'hashtagSets' | 'understanding'> & { captions: Array<{text:string}> }): GeneratedContent {
  const hooks = p.hooks.map(h => ({ text: h.text, style: strategyFor[h.category], score: h.score }));
  const strategy = hooks[0]?.style ?? 'curiosity';
  return { bestHook: hooks[0]?.text ?? '', alternateHooks: hooks.slice(1).map(h => h.text), generatedHookScore: hooks[0]?.score ?? 0,
    selectedHookStrategy: strategy, title: p.understanding.mainTopic.slice(0, 100), synopsis: p.synopsis,
    caption: p.captions[0]?.text ?? '', hashtags: p.hashtagSets.find(s => s.label === 'Focused')?.hashtags ?? [],
    cta: '', topic: p.understanding.mainTopic, contentType: p.understanding.sceneContext,
    whySelected: p.understanding.watchReason || p.understanding.bestAngle, hooks,
    hookOptions: hooks.map(h => ({ hook: h.text, strategy: h.style, score: h.score,
      components: { relevance: h.score, clarity: h.score, curiosity: h.score, payoffAlignment: h.score, specificity: h.score } })),
    creativeCandidates: { sharedPackage: p } };
}
export function fallbackCandidateContent(c: ScoredClipCandidate, platform?: string | null): GeneratedContent {
  const evidence = candidateEvidence(c), understanding = localUnderstanding(evidence), draft = deterministicCreative(evidence, understanding);
  const style = platform === 'INSTAGRAM_REELS' ? 'Engaging' : platform === 'TIKTOK' ? 'Concise' : 'Professional';
  const hooks = sharedQuality.rank(draft.hooks,evidence,understanding,'LOCAL'), quality = sharedQuality.evaluate(draft,hooks,evidence);
  const p: CreativePackage = {...draft,captions:[...draft.captions].sort((a,b)=>Number(b.style===style)-Number(a.style===style))
    .map((c,i)=>({...c,recommended:i===0})),version:2,understanding,hooks,selectedHook:hooks[0]?.text ?? '',quality,
    status:quality.passed?'ACCEPTED':'NEEDS_REVIEW',warnings:quality.passed?[]:['Review the limited local suggestions.'],
    tone:understanding.emotionalAngle,contextSummary:[understanding.centralClaim,understanding.payoff].join(' '),
    internal:{routes:[],escalations:0,understandingVersion:understanding.version}};
  return candidateContent(p);
}
