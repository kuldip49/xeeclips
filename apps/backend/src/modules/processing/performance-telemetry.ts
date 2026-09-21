import { AsyncLocalStorage } from 'async_hooks';
import { AiProcessingMode, normalizeAiProcessingMode } from './ai-processing-mode';
import { DEFAULT_PROCESSING_TYPE, DEFAULT_OUTPUT_ASPECT_RATIO,
  ProcessingType, OutputAspectRatio } from './processing-type';

export const timingFields = ['audioExtractionMs', 'transcriptionMs', 'frameExtractionMs',
  'multimodalMs', 'wholeVideoUnderstandingMs', 'candidateGenerationMs', 'candidateShortlistMs',
  'boundaryOptimizationMs', 'clipUnderstandingMs', 'creativeGenerationMs', 'criticMs',
  'exportMs', 'totalMs'] as const;
export type ClipDecisionSource = 'LUNA' | 'DETERMINISTIC_HIGH_CONFIDENCE' | 'DETERMINISTIC_FALLBACK';
export function createPerformanceTelemetry(aiMode: unknown = AiProcessingMode.FALLBACK_ONLY,
  processingType: ProcessingType = DEFAULT_PROCESSING_TYPE,
  outputAspectRatio: OutputAspectRatio = DEFAULT_OUTPUT_ASPECT_RATIO) {
  const effectiveAiMode = normalizeAiProcessingMode(aiMode);
  return { ...Object.fromEntries(timingFields.map(key => [key, 0])) as Record<typeof timingFields[number], number>,
    requestedAiMode: effectiveAiMode, effectiveAiMode,
    processingType, editingRequested: processingType === 'EDITED_CLIPS',
    editingExecuted: false, editingPlanProvider: '', editingPlanModel: '',
    editDecisionSource: '' as '' | 'LUNA' | 'DETERMINISTIC_FALLBACK',
    editOperationCount: 0, weakLeadInRemovedMs: 0, trimCount: 0,
    silenceRemovedMs: 0, pauseRemovalCount: 0, retentionEditCount: 0,
    zoomCount: 0, zoomInCount: 0, zoomOutCount: 0, reframeCount: 0,
    averageZoomScale: 0, subtitlePhraseCount: 0, highlightedWordCount: 0,
    hookWordCount: 0, overlayCollisionRepairs: 0, faceAvoidanceAdjustments: 0,
    sourceResolution: null as null | { width: number; height: number },
    outputResolution: null as null | { width: number; height: number },
    speakerTrackCount: 0, speakerSwitchCount: 0,
    rawCropCenters: [] as Array<{ t: number; x: number; y: number }>,
    stabilizedCropCenters: [] as Array<{ t: number; x: number; y: number }>,
    cropMovementDistance: 0, reframeAdjustmentCount: 0,
    hookRequested: false, hookValidated: false, hookPlaced: false,
    hookRendered: false, hookSuppressionReason: '', hookFontSize: 0,
    hookPosition: null as null | { x: number; y: number },
    subtitleFontSize: 0, subtitlePosition: 0,
    subtitlePositions: [] as Array<{ start: number; end: number; y: number }>,
    zoomEvents: [] as Array<Record<string, number>>,
    zoomPeakScale: 1, zoomReturnedToBaseline: true,
    timelineRemapApplied: false, subtitleTheme: '', platformPreset: '',
    subtitleEnabled: false, subtitleAnimationStyle: '',
    onScreenHookEnabled: false, onScreenTextCount: 0,
    outputAspectRatio: processingType === 'EDITED_CLIPS' ? outputAspectRatio : 'SOURCE',
    renderMs: 0, editingFallbackReason: '',
    rawCandidateCount: 0, preScoredCandidateCount: 0, aiShortlistCount: 0, shortlistCount: 0,
    highConfidenceSkippedCount: 0,
    highConfidenceRejectedBy: { heuristicScore: 0, standaloneScore: 0, payoffScore: 0,
      hookScore: 0, flowScore: 0, informationScore: 0 } as Record<string, number>,
    lunaCandidateCount: 0, localLlmCandidateCount: 0,
    finalCandidateCount: 0, creativePackageCount: 0,
    llmRequestCountByRole: {} as Record<string, number>, retryCount: 0, failoverCount: 0,
    llmRequestCountByProvider: {} as Record<string, number>,
    llmRequestCountByRoleProvider: {} as Record<string, number>,
    llmSuccessCountByRoleProvider: {} as Record<string, number>,
    successfulCallsByProvider: {} as Record<string, number>,
    failedCallsByProvider: {} as Record<string, number>,
    providerFallbackChainUsed: [] as string[],
    schemaRepairCount: 0, cacheHits: 0, circuitOpenCount: 0, criticCount: 0,
    repairCount: 0, mechanicalComponentRepairCount: 0,
    callBudgetDeniedCount: 0, callBudgetDeniedByRole: {} as Record<string, number>,
    totalLlmCalls: 0, cloudLlmCalls: 0, localLlmCalls: 0,
    // Deprecated compatibility alias. Unlike the old implementation, this is cloud-only.
    totalCloudLlmCalls: 0,
    wholeVideoUnderstanding: { provider: '', model: '', success: false },
    wholeVideoNormalizationApplied: false, chapterCountBefore: 0, chapterCountAfter: 0,
    chaptersReordered: false, chapterOverlapRepairs: 0, chapterBoundaryClamps: 0,
    wholeVideoFallbackReason: '',
    clipUnderstanding: { provider: '', model: '', success: false, inputChars: 0,
      latencyMs: 0, outputTokens: 0, fallbackUsed: false, fallbackReason: '' },
    candidateJudge: { provider: '', model: '', success: false },
    selectedClipIds: [] as string[],
    selectedClipTimestamps: [] as Array<{ startTime: number; endTime: number }>,
    clipDecisionSource: 'DETERMINISTIC_FALLBACK' as ClipDecisionSource,
    deterministicFallbackUsed: false,
    fallbackReason: '' };
}
export const performanceContext = new AsyncLocalStorage<ReturnType<typeof createPerformanceTelemetry>>();
export function currentAiProcessingMode() {
  return performanceContext.getStore()?.effectiveAiMode ?? AiProcessingMode.FALLBACK_ONLY;
}
const unavailableProviderModels = new WeakMap<object, Set<string>>();
export function markProviderModelUnavailable(key: string) {
  const current = performanceContext.getStore();
  if (!current) return false;
  let unavailable = unavailableProviderModels.get(current);
  if (!unavailable) { unavailable = new Set(); unavailableProviderModels.set(current, unavailable); }
  unavailable.add(key);
  return true;
}
export function isProviderModelUnavailable(key: string) {
  const current = performanceContext.getStore();
  return !!current && unavailableProviderModels.get(current)?.has(key) === true;
}
export function resetProviderModelAvailability() {
  const current = performanceContext.getStore();
  if (current) unavailableProviderModels.delete(current);
}
export function countPerformance(key: 'retryCount' | 'failoverCount' | 'schemaRepairCount' |
  'cacheHits' | 'circuitOpenCount' | 'criticCount' | 'repairCount' |
  'mechanicalComponentRepairCount') {
  const current = performanceContext.getStore();
  if (current) current[key]++;
}

export function countLlmRequest(role: string, provider: string) {
  const current = performanceContext.getStore();
  if (!current) return;
  const local = ['ollama', 'local'].includes(provider.trim().toLowerCase());
  current.totalLlmCalls++;
  if (local) current.localLlmCalls++;
  else {
    current.cloudLlmCalls++;
    current.totalCloudLlmCalls++;
  }
  current.llmRequestCountByRole[role] = (current.llmRequestCountByRole[role] || 0) + 1;
  current.llmRequestCountByProvider[provider] = (current.llmRequestCountByProvider[provider] || 0) + 1;
  const pair = role + ':' + provider;
  current.llmRequestCountByRoleProvider[pair] = (current.llmRequestCountByRoleProvider[pair] || 0) + 1;
}

export function countLlmSuccess(role: string, provider: string) {
  const current = performanceContext.getStore();
  if (!current) return;
  const key = role + ':' + provider;
  current.llmSuccessCountByRoleProvider[key] =
    (current.llmSuccessCountByRoleProvider[key] || 0) + 1;
  current.successfulCallsByProvider[provider] =
    (current.successfulCallsByProvider[provider] || 0) + 1;
}

export function countLlmFailure(provider: string) {
  const current = performanceContext.getStore();
  if (current) current.failedCallsByProvider[provider] =
    (current.failedCallsByProvider[provider] || 0) + 1;
}

export type ChapterNormalizationTelemetry = {
  chapterCountBefore: number;
  chapterCountAfter: number;
  chaptersReordered: boolean;
  chapterOverlapRepairs: number;
  chapterBoundaryClamps: number;
  wholeVideoNormalizationApplied: boolean;
};

export function recordChapterNormalization(telemetry: ChapterNormalizationTelemetry) {
  const current = performanceContext.getStore();
  if (!current) return;
  current.chapterCountBefore = telemetry.chapterCountBefore;
  current.chapterCountAfter = telemetry.chapterCountAfter;
  current.chaptersReordered = telemetry.chaptersReordered;
  current.chapterOverlapRepairs = telemetry.chapterOverlapRepairs;
  current.chapterBoundaryClamps = telemetry.chapterBoundaryClamps;
  current.wholeVideoNormalizationApplied = telemetry.wholeVideoNormalizationApplied;
}

export function recordWholeVideoFallbackReason(reason: string) {
  const current = performanceContext.getStore();
  if (current) current.wholeVideoFallbackReason = reason;
}

export function recordProviderChain(provider: string) {
  const current = performanceContext.getStore();
  if (current && !current.providerFallbackChainUsed.includes(provider))
    current.providerFallbackChainUsed.push(provider);
}

const budget = (name: string, fallback: number) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

// Role-aware sub-budgets: critic/componentRepair calls scale with how many final candidates a
// longer video can carry (maximumClipCountForDuration tops out at 30), not a single fixed cap
// sized for a short video. Critic now runs batched (several candidates per call), so its budget
// stays lower than repair, which still runs one call per candidate needing a fix.
// A denied call is never handed to countLlmRequest (it never reaches the provider), so without
// this it would vanish from the job's telemetry entirely: totalLlmCalls/repairCount would read
// as if the job stayed comfortably under budget even when a role was repeatedly denied. Recording
// the denial here, at the point of rejection, keeps the final pipeline_performance_summary honest
// about real budget pressure instead of only ever showing calls that were actually admitted.
export function assertLlmCallBudget(role: string, isRetry: boolean) {
  const current = performanceContext.getStore();
  if (!current) return;
  if (current.totalLlmCalls >= budget('LLM_JOB_MAX_CALLS', 60) ||
    role === 'critic' && current.criticCount >= budget('LLM_JOB_MAX_CRITIC_CALLS', 10) ||
    role === 'componentRepair' && current.repairCount >= budget('LLM_JOB_MAX_REPAIR_CALLS', 16) ||
    isRetry && current.retryCount >= budget('LLM_JOB_MAX_RETRY_CALLS', 12)) {
    current.callBudgetDeniedCount++;
    current.callBudgetDeniedByRole[role] = (current.callBudgetDeniedByRole[role] || 0) + 1;
    throw new Error('LLM_CALL_BUDGET_EXCEEDED');
  }
}

const stageTiming: Record<string, typeof timingFields[number]> = {
  EXTRACT_AUDIO: 'audioExtractionMs', TRANSCRIBE: 'transcriptionMs',
  MULTIMODAL_UNDERSTANDING: 'multimodalMs', WHOLE_VIDEO_UNDERSTANDING: 'wholeVideoUnderstandingMs',
  GENERATE_CLIP_CANDIDATES: 'candidateGenerationMs', CLIP_UNDERSTANDING: 'clipUnderstandingMs',
  CONTENT_GENERATION: 'creativeGenerationMs', CRITIC_VALIDATION: 'criticMs' };
export class PerformanceStageClock {
  private readonly starts = new Map<string, number>();
  constructor(private readonly metrics: ReturnType<typeof createPerformanceTelemetry>,
    private readonly now: () => number = Date.now) {}
  checkpoint(stage: string, status: string) {
    const key = stageTiming[stage];
    if (!key) return;
    if (status === 'PROCESSING' && !this.starts.has(stage)) this.starts.set(stage, this.now());
    if (['COMPLETED', 'SKIPPED', 'FAILED'].includes(status) && this.starts.has(stage)) {
      this.metrics[key] += this.now() - this.starts.get(stage)!;
      this.starts.delete(stage);
    }
  }
}
