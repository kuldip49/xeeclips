import { AUTOMATIC_RAW } from '../editing/raw-edit-plan';
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ClipCandidate, ClipRenderStatus, Prisma, ProcessingJob, Video } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { generatedClipEditLink } from '../edit-mode/generated-clip-edit-link';
import { interpretBriefDeterministic, type InterpretedBrief } from '../edit-mode/styles/creative-brief';
import { hasContentIntent, matchesIntent, rankByIntent } from '../edit-mode/styles/creative-intent';
import { resolveCreativeStyle } from '../edit-mode/styles/creative-style-resolver';
import { fullTemplate, STYLE_CATEGORIES, type StyleCategory } from '../edit-mode/styles/creative-style-library';
import { ClipExportService, ClipInfrastructureError } from './clip-export.service';
import { EditQualityError } from '../editing/edit-quality-gate';
import { generateCandidateRanges, ScoredClipCandidate } from '../processing/clip-candidates';
import { optimizeClipBoundaries, TranscriptWord } from '../processing/clip-boundary-optimizer';
import {
  buildContentFingerprint,
  CLIP_CONTENT_PROMPT_VERSION,
  fallbackContent
} from '../processing/openai-clip-judge.service';
import {
  clipVariantKey,
  defaultClipCountForMax,
  evaluateFillUsability,
  type FillTier,
  isDuplicateOfAny,
  isNearDuplicateOfAny,
  isVideoTooLong,
  maxClipCountForDuration,
  OutputStyle,
  parseOutputStyle,
  processingTypeForOutputStyle,
  qualityBand,
  rankUsableCandidates,
  userAiModeLabel,
  validateRequestedClipCount,
  VIDEO_TOO_LONG_MESSAGE
} from '../processing/clip-selection-policy';

/** Step 9-12: optional unified-generation inputs. All optional. */
export type GenerationRequest = {
  templateId: string | null;
  components: Partial<Record<StyleCategory, string>>;
  brief: string;
  referenceId: string | null;
  /**
   * What the user SELECTED at the top level (AI_EDITED "Automatic edit", NORMAL "Clean cuts",
   * or a template id). Configuration, not the resolved plan: a styled request renders a clean
   * cut, so outputStyle alone cannot tell the UI which look was chosen.
   */
  look?: string | null;
};
export type ClipCreationRequest = { requestedClipCount: unknown; outputStyle: OutputStyle | null;
  generation?: GenerationRequest | null;
  /** An explicit user "generate again": a finished identical request is re-run (fresh
   * renders under a new request key) instead of being answered as already satisfied. */
  regenerate?: boolean };

export function parseGenerationRequest(value: unknown): GenerationRequest | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('generation must be an object');
  const raw = value as Record<string, unknown>;
  const text = (item: unknown, max: number) => typeof item === 'string' ? item.trim().slice(0, max) : '';
  const components: Partial<Record<StyleCategory, string>> = {};
  const rawComponents = raw.components && typeof raw.components === 'object' && !Array.isArray(raw.components)
    ? raw.components as Record<string, unknown> : {};
  for (const category of STYLE_CATEGORIES) {
    const id = text(rawComponents[category], 80);
    if (id) components[category] = id;
  }
  const rawTemplate = text(raw.templateId, 80) || text(raw.look, 80);
  const templateId = rawTemplate === 'AI_EDITED' ? 'AUTOMATIC_1' : rawTemplate || null;
  const rawLook = text(raw.look, 80);
  const look = rawLook === 'AI_EDITED' ? 'AUTOMATIC_1' : rawLook || templateId;
  const generation = { templateId, components,
    brief: text(raw.brief, 1500), referenceId: text(raw.referenceId, 80) || null, look };
  return generation.templateId || generation.brief || generation.referenceId ||
    generation.look || Object.keys(components).length ? generation : null;
}

export function parseClipCreationRequest(value: unknown): ClipCreationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Selection body is required');
  const body = value as Record<string, unknown>;
  // `count` is the pre-redesign field name; duration fields are no longer user-controlled.
  const requestedClipCount = body.requestedClipCount ?? body.count;
  if (requestedClipCount === undefined)
    throw new BadRequestException('requestedClipCount is required');
  return {
    requestedClipCount,
    outputStyle: body.outputStyle == null ? null : parseOutputStyle(body.outputStyle),
    generation: parseGenerationRequest(body.generation),
    regenerate: body.regenerate === true
  };
}

/** What a request's generation settings persist as (ProcessingJob.generationSettings). */
export type StoredGenerationSettings = GenerationRequest & {
  requestedTemplate: string;
  effectiveTemplate: string;
  interpreted: Pick<InterpretedBrief, 'intent' | 'styleHints' | 'templateHint' | 'source'> & {
    aiState: string };
  resolved: ReturnType<typeof resolveCreativeStyle>;
  referenceStyle: Record<string, unknown> | null;
  key: string;
};

/** Optional collaborators the Nest service wires in (AI brief reading, styling). */
export type ClipSelectionHooks = {
  interpretBrief?: (brief: string, aiMode: string) => Promise<InterpretedBrief>;
  semanticIntentScores?: (candidates: ClipCandidate[], settings: StoredGenerationSettings,
    aiMode: string) => Promise<Map<string, number> | null>;
  referenceStyle?: (referenceId: string) => Promise<Record<string, unknown> | null>;
  /** Step 17: user-saved component styles by stable id. */
  savedStyles?: (ids: string[]) => Promise<NonNullable<Parameters<typeof resolveCreativeStyle>[0]['saved']>>;
  afterDelivery?: (videoId: string) => Promise<void>;
};

export const readGenerationSettings = (value: unknown): StoredGenerationSettings | null =>
  value && typeof value === 'object' && !Array.isArray(value) &&
    (value as Record<string, unknown>).resolved ? value as StoredGenerationSettings : null;

const EXPANSION_MARKER = 'candidateExpansion';
const FILL_MARKER = 'candidateFill';
const evidenceOf = (candidate: ClipCandidate) =>
  candidate.evidence && typeof candidate.evidence === 'object' && !Array.isArray(candidate.evidence)
    ? candidate.evidence as Record<string, unknown> : {};
const isExpansionCandidate = (candidate: ClipCandidate) => evidenceOf(candidate)[EXPANSION_MARKER] === true;
const fillTierOf = (candidate: ClipCandidate): FillTier | null => {
  const tier = evidenceOf(candidate)[FILL_MARKER];
  return tier === 1 || tier === 2 || tier === 3 ? tier : null;
};

/**
 * Canonical selection order: the analysis pool first, then expansion candidates that do not
 * duplicate it. Expansion therefore never displaces clips a user has already received.
 */
export function orderCandidatesForSelection(candidates: ClipCandidate[], videoDuration: number | null) {
  const primary = rankUsableCandidates(candidates.filter((item) =>
    !isExpansionCandidate(item) && !fillTierOf(item)), videoDuration);
  const expansion = rankUsableCandidates(candidates.filter(isExpansionCandidate), videoDuration);
  const ordered = [...primary.ordered];
  let crossPoolDuplicateCount = 0;
  for (const candidate of expansion.ordered) {
    if (isDuplicateOfAny(candidate, ordered)) crossPoolDuplicateCount++;
    else ordered.push(candidate);
  }
  // Fill candidates come last, tier by tier, so they can only ever complete a request -
  // never displace a stronger, distinct moment.
  // Overlapping a distinct moment is the point of a fill (it is only reached once those are
  // used), so a fill only has to differ from other fills and never repeat a range exactly.
  const fillRejected: Array<{ candidate: ClipCandidate; reason: string }> = [];
  const fills: ClipCandidate[] = [];
  const sameRange = (a: ClipCandidate, b: ClipCandidate) =>
    Math.abs(a.startTime - b.startTime) < 1 && Math.abs(a.endTime - b.endTime) < 1;
  for (const tier of [1, 2, 3] as FillTier[]) {
    for (const candidate of candidates.filter((item) => fillTierOf(item) === tier)
      .sort((a, b) => b.contentPotential - a.contentPotential || a.startTime - b.startTime)) {
      const verdict = evaluateFillUsability(candidate, videoDuration);
      if (!verdict.usable) fillRejected.push({ candidate, reason: verdict.reason });
      else if (ordered.some((other) => sameRange(candidate, other)) ||
        isNearDuplicateOfAny(candidate, fills, tier)) crossPoolDuplicateCount++;
      else { ordered.push(candidate); fills.push(candidate); }
    }
  }
  const rejected = [...primary.rejected, ...expansion.rejected, ...fillRejected];
  const hardFailureReasonCounts = rejected.reduce<Record<string, number>>((counts, item) => {
    counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
  if (crossPoolDuplicateCount) hardFailureReasonCounts.DUPLICATE_OF_STRONGER_SELECTION =
    (hardFailureReasonCounts.DUPLICATE_OF_STRONGER_SELECTION ?? 0) + crossPoolDuplicateCount;
  return { ordered, rejectedCount: rejected.length + crossPoolDuplicateCount,
    semanticDuplicateRejectedCount:
      (hardFailureReasonCounts.DUPLICATE_OF_STRONGER_SELECTION ?? 0),
    hardFailureReasonCounts };
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

type ResultClip = {
  id: string; startTime: number; endTime: number; duration: number; sizeBytes: bigint;
  processingType: string; aspectRatio: string; width: number; height: number;
  thumbnailObjectKey?: string | null;
  editTelemetry: Prisma.JsonValue | null; contentPackaging?: Prisma.JsonValue | null;
  targetPlatform?: string | null; candidate: ClipCandidate | null;
  editProject?: { id: string; settings?: Prisma.JsonValue } | null;
  generationJobId?: string | null; templateId?: string | null;
  requestedTemplate?: string | null; effectiveTemplate?: string | null;
  styleVariant?: string | null; requestedClipIndex?: number | null;
};

/**
 * Statuses a generationStyle record can legitimately carry. Anything else found in storage is
 * treated as STYLE_UNKNOWN rather than trusted or flagged as a failure.
 */
const KNOWN_STYLE_STATUSES = new Set(['BASE_READY', 'STYLE_APPLYING', 'STYLE_READY', 'STYLE_FAILED',
  'EXPORT_READY', 'SKIPPED', 'STYLING', 'RENDERING', 'READY', 'FAILED']);

/**
 * Step 14 + backward-compatibility: the canonical styled render of a clip (its EditProject
 * export), when ready.
 *
 * `generationStyle.templateId` was added by the template-contract work; historical rows predate
 * it and store no templateId at all. The old comparison (`style.templateId !== requestedTemplate`)
 * read that absence as a template MISMATCH and marked every one of those clips STYLE_FAILED, even
 * though the render itself succeeded (status EXPORT_READY, a real exportAssetId on disk). Missing
 * historical metadata must never by itself mean failure - only a recorded failure, or a genuine
 * identity mismatch we can actually prove, does.
 *
 * This is the single place that resolves readiness; getResults() reuses it for its aggregate
 * counts so the per-card and aggregate views can never disagree.
 */
export function resolveGenerationStyleReadiness(clip: ResultClip) {
  const style = jsonObject(jsonObject(clip.editProject?.settings).generationStyle);
  if (typeof style.status !== 'string') return null;
  const applied = Array.isArray(style.lines) ? (style.lines as unknown[]).map(String).slice(0, 12) : [];
  const skipped = Array.isArray(style.skipped) ? (style.skipped as unknown[]).map(String).slice(0, 8) : [];
  const recordedError = typeof style.error === 'string' ? style.error : null;
  const fail = (error: string) =>
    ({ status: 'STYLE_FAILED' as const, playbackUrl: null, applied, skipped, error, legacy: false });

  if (style.status === 'STYLE_FAILED' || style.status === 'FAILED') return fail(recordedError ?? 'Styling failed.');
  if (!KNOWN_STYLE_STATUSES.has(style.status)) return { status: 'STYLE_UNKNOWN' as const, playbackUrl: null,
    applied, skipped, error: recordedError, legacy: false };

  const assetId = typeof style.exportAssetId === 'string' && style.exportAssetId.length > 0
    ? style.exportAssetId : null;
  const recordedReady = (style.status === 'EXPORT_READY' || style.status === 'READY') && assetId;
  // Not (yet) a ready export: pass the in-progress/terminal status through unchanged. There is no
  // template identity to check until an export asset actually exists.
  if (!recordedReady) return { status: style.status as string, playbackUrl: null, applied, skipped,
    error: recordedError, legacy: false };

  const playbackUrl = `/edit-mode/assets/${encodeURIComponent(assetId)}/file`;
  const expectedTemplate = clip.requestedTemplate ?? clip.templateId ?? null;
  const storedTemplate = typeof style.templateId === 'string' ? style.templateId : null;

  if (storedTemplate) {
    // Modern record with its own templateId: a real, provable identity check.
    if (expectedTemplate && storedTemplate !== expectedTemplate)
      return fail('Template identity does not match the selected template.');
    return { status: style.status as string, playbackUrl, applied, skipped, error: recordedError, legacy: false };
  }
  if (expectedTemplate) {
    // Pre-template-contract style state: no templateId was ever recorded on it, but the
    // GeneratedClip row's own requestedTemplate/effectiveTemplate/templateId are already
    // required (by the `ordered` filter in getResults) to agree with the current request's
    // template, and a real exportAssetId is proof the styled render itself succeeded - that is
    // trustworthy provenance even without generationStyle.templateId.
    return { status: style.status as string, playbackUrl, applied, skipped, error: recordedError, legacy: true };
  }
  // Fully legacy: neither the style record nor the GeneratedClip row carries a template identity
  // (it predates template provenance entirely). We still have a recorded ready status and a real
  // export asset, so treat it as styled rather than manufacture a failure nobody recorded.
  return { status: 'LEGACY_STYLE_READY' as const, playbackUrl, applied, skipped, error: recordedError, legacy: true };
}

/**
 * The user-facing clip card: content package and AI mode only, no scoring internals. The AI mode
 * is the job's effectiveAiMode; per-candidate deterministic fallback stays in telemetry.
 */
export function toClipCard(clip: ResultClip, effectiveAiMode: unknown, position: number) {
  const candidate = clip.candidate;
  const telemetry = jsonObject(clip.editTelemetry);
  const packaging = jsonObject(clip.contentPackaging);
  const captions = jsonObject(packaging.captions);
  const hashtagSets = jsonObject(packaging.hashtags);
  const platformKey = clip.targetPlatform === 'INSTAGRAM_REELS' ? 'instagramReels' :
    clip.targetPlatform === 'TIKTOK' ? 'tiktok' : 'youtubeShorts';
  const packagedCaption = typeof captions[platformKey] === 'string' ?
    String(captions[platformKey]).trim() : '';
  const packagedHashtags = Array.isArray(hashtagSets[platformKey]) ?
    (hashtagSets[platformKey] as unknown[]).filter((item): item is string =>
      typeof item === 'string') : [];
  const renderedHook = clip.processingType === 'EDITED_CLIPS' && telemetry.hookRendered === true &&
    typeof telemetry.hookFinalText === 'string' ? telemetry.hookFinalText.trim() : '';
  const hook = renderedHook || candidate?.bestHook || candidate?.hookCandidate || '';
  return {
    id: clip.id,
    ...generatedClipEditLink(clip.editProject),
    position,
    playbackUrl: `/generated-clips/${clip.id}/file`,
    // The designed cover carrying the same headline. The player uses it as the
    // poster, so the hook is on screen before playback starts.
    posterUrl: clip.thumbnailObjectKey ? `/generated-clips/${clip.id}/poster` : null,
    outputStyle: clip.processingType === 'EDITED_CLIPS' ? 'AI_EDITED' as const : 'NORMAL' as const,
    durationSec: Math.round(clip.duration * 10) / 10,
    width: clip.width,
    height: clip.height,
    hook,
    synopsis: candidate?.synopsis ?? '',
    caption: clip.processingType === 'EDITED_CLIPS' && packagedCaption ? packagedCaption :
      candidate?.caption || candidate?.captionCandidate || '',
    hashtags: clip.processingType === 'EDITED_CLIPS' && packagedHashtags.length ? packagedHashtags :
      candidate?.hashtags ?? [],
    aiModeUsed: userAiModeLabel(effectiveAiMode),
    generationJobId: clip.generationJobId ?? null,
    templateId: clip.templateId ?? null,
    requestedTemplate: clip.requestedTemplate ?? clip.templateId ?? null,
    effectiveTemplate: clip.effectiveTemplate ?? clip.templateId ?? null,
    styleVariant: clip.styleVariant ?? null,
    requestedClipIndex: clip.requestedClipIndex ?? position,
    sourceRange: { startTime: clip.startTime, endTime: clip.endTime },
    style: resolveGenerationStyleReadiness(clip)
  };
}

/** One persisted clip request; `requestedAt` (clipRequestedAt) identifies it across restarts. */
export type ClipRenderRequest = { videoId: string; processingJobId: string; requestedAt: string };

export interface ClipRenderDispatcher {
  dispatch(request: ClipRenderRequest): Promise<void>;
  /** true while queued or running, false when there is no live work, null when unknown. */
  isPending(request: ClipRenderRequest): Promise<boolean | null>;
}

export const clipRenderQueueJobId = (request: ClipRenderRequest) =>
  `clips-${request.processingJobId}-${Date.parse(request.requestedAt)}`;

const ACTIVE_RENDER_STATES: ClipRenderStatus[] = ['QUEUED', 'RENDERING'];
const RENDER_FAILED_MESSAGE = 'Clips could not be created. Please try again.';
const RENDER_QUEUE_FAILED_MESSAGE = 'Clips could not be queued. Please try again.';
export const RENDER_INTERRUPTED_MESSAGE = 'Clip creation was interrupted. Please try again.';
// Grace period between persisting QUEUED and the queue accepting the job. Live queue work is
// never treated as stale, whatever its age.
const staleRenderMs = () => Math.max(1000, Number(process.env.CLIP_RENDER_STALE_MS) || 120_000);
export function aiEditedRenderConcurrency() {
  const raw = process.env.AI_EDITED_RENDER_CONCURRENCY;
  if (raw == null || raw.trim() === '') return 2;
  const configured = Number(raw);
  return Number.isFinite(configured) ? Math.max(1, Math.min(4, Math.floor(configured))) : 2;
}

const isActiveRender = (job: Pick<ProcessingJob, 'clipRenderStatus'> | null) =>
  !!job?.clipRenderStatus && ACTIVE_RENDER_STATES.includes(job.clipRenderStatus);

const templateForJob = (job: Pick<ProcessingJob, 'generationSettings' | 'outputStyle'> | null) => {
  const settings = readGenerationSettings(job?.generationSettings);
  return settings?.effectiveTemplate ?? settings?.requestedTemplate ?? settings?.templateId ??
    (job?.outputStyle === 'AI_EDITED' ? 'AUTOMATIC_1' : null);
};
const variantTemplateForJob = (job: Pick<ProcessingJob, 'generationSettings'> | null) => {
  const settings = readGenerationSettings(job?.generationSettings);
  return settings?.effectiveTemplate ?? settings?.requestedTemplate ?? settings?.templateId ?? null;
};

const deliveryState = (job: Pick<ProcessingJob, 'clipRenderStatus' | 'requestedClipCount' |
  'selectedCandidateIds'> | null) => {
  if (!job?.clipRenderStatus || job.clipRenderStatus === 'IDLE') return null;
  if (job.clipRenderStatus === 'QUEUED' || job.clipRenderStatus === 'RENDERING') return 'IN_PROGRESS';
  const delivered = job.selectedCandidateIds.length;
  if (job.clipRenderStatus === 'FAILED' || delivered === 0) return 'FAILED';
  return delivered === job.requestedClipCount ? 'COMPLETE' : 'PARTIAL';
};

const requestOf = (job: Pick<ProcessingJob, 'id' | 'videoId' | 'clipRequestedAt'>):
  ClipRenderRequest | null => job.clipRequestedAt ? { videoId: job.videoId,
  processingJobId: job.id, requestedAt: job.clipRequestedAt.toISOString() } : null;

type RequestUpdate = (data: Prisma.ProcessingJobUpdateManyMutationInput) => Promise<void>;
class SupersededRequestError extends Error {}

export class ClipSelectionService {
  private readonly logger = new Logger(ClipSelectionService.name);
  private readonly dispatcher: ClipRenderDispatcher;

  constructor(private readonly prisma: PrismaService, private readonly exporter: ClipExportService,
    dispatcher?: ClipRenderDispatcher, private readonly hooks: ClipSelectionHooks = {}) {
    this.dispatcher = dispatcher ?? this.inlineDispatcher();
  }

  /** Brief + template + components + reference -> the settings a request is served with. */
  async buildGenerationSettings(generation: GenerationRequest | null | undefined, aiMode = 'FALLBACK_ONLY') {
    if (!generation) return null;
    const requestedTemplate = generation.templateId ??
      (generation.look === 'AUTOMATIC_2' || generation.look === AUTOMATIC_RAW ? generation.look : 'AUTOMATIC_1');
    const raw = requestedTemplate === AUTOMATIC_RAW;
    if (requestedTemplate !== 'AUTOMATIC_1' && !raw && !fullTemplate(requestedTemplate)) {
      throw new BadRequestException(`Unknown generation template "${requestedTemplate}"`);
    }
    const interpreted = generation.brief
      ? await (this.hooks.interpretBrief?.(generation.brief, aiMode).catch(() => null) ?? null) ??
        { ...interpretBriefDeterministic(generation.brief), ai: { state: this.hooks.interpretBrief ? 'UNKNOWN' : 'NOT_REQUESTED' } }
      : { ...interpretBriefDeterministic(''), ai: { state: 'NOT_REQUESTED' } };
    const referenceStyle = generation.referenceId
      ? await (this.hooks.referenceStyle?.(generation.referenceId).catch(() => null) ?? null) : null;
    const savedIds = Object.values(generation.components).filter((id): id is string =>
      !!id && /^[0-9a-f-]{36}$/iu.test(id));
    const saved = savedIds.length ? await (this.hooks.savedStyles?.(savedIds).catch(() => ({})) ?? {}) : {};
    // Raw draws nothing on top of the footage, so brief style words, picked components and a
    // reference never turn into captions or overlays; the brief still steers clip selection.
    const resolved = raw ? resolveCreativeStyle({}) : resolveCreativeStyle({
      instruction: interpreted.styleHints,
      components: generation.components,
      reference: referenceStyle ? (referenceStyle.choices as never) : undefined,
      // Automatic 1 is the baseline editor, not an empty/unknown style bundle.
      templateId: requestedTemplate === 'AUTOMATIC_1' ? interpreted.templateHint : requestedTemplate,
      saved
    });
    const effectiveTemplate = requestedTemplate;
    const settings: StoredGenerationSettings = { ...generation, templateId: requestedTemplate,
      look: requestedTemplate, requestedTemplate, effectiveTemplate,
      interpreted: { intent: interpreted.intent, styleHints: interpreted.styleHints,
        templateHint: interpreted.templateHint, source: interpreted.source,
        aiState: String((interpreted.ai as { state?: string }).state ?? 'UNKNOWN') },
      resolved, referenceStyle, key: '' };
    settings.key = JSON.stringify({ t: requestedTemplate, c: generation.components,
      b: generation.brief, r: generation.referenceId, l: requestedTemplate });
    return settings;
  }

  /**
   * Without a queue (scripts/tests) work runs in this process. Its pending set is lost on a
   * restart, which persisted state plus stale recovery handle exactly like a lost queue job.
   */
  private inlineDispatcher(): ClipRenderDispatcher {
    const pending = new Set<string>();
    return {
      dispatch: async (request) => {
        const key = clipRenderQueueJobId(request);
        if (pending.has(key)) return;
        pending.add(key);
        const work = this.processRequest(request)
          .catch((error: unknown) => this.markFailed(request, error))
          .finally(() => pending.delete(key));
        if (process.env.CLIP_SELECTION_SYNC === 'true') await work;
      },
      isPending: async (request) => pending.has(clipRenderQueueJobId(request))
    };
  }

  private async loadVideo(videoId: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId },
      include: { processingJobs: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    if (!video) throw new NotFoundException('Video not found');
    const job = video.processingJobs[0] ?? null;
    return { video, job: job ? await this.recoverStaleRender(job) : null };
  }

  /**
   * Deterministic recovery for a request left QUEUED/RENDERING by a restart or a lost queue job:
   * past the grace window and with no live queue work, it becomes a retryable FAILED. Live or
   * unknown queue state is left alone so an active render is never duplicated.
   */
  async recoverStaleRender<T extends ProcessingJob>(job: T): Promise<T> {
    const request = requestOf(job);
    if (!isActiveRender(job) || !request) return job;
    const since = (job.clipRenderStartedAt ?? job.clipRequestedAt ?? new Date(0)).getTime();
    if (Date.now() - since < staleRenderMs()) return job;
    const pending = await this.dispatcher.isPending(request).catch(() => null);
    if (pending !== false) return job;
    const recovered = await this.prisma.processingJob.updateMany({
      where: { id: job.id, clipRequestedAt: job.clipRequestedAt,
        clipRenderStatus: { in: ACTIVE_RENDER_STATES } },
      data: { clipRenderStatus: 'FAILED', clipRenderError: RENDER_INTERRUPTED_MESSAGE } });
    if (!recovered.count) return job;
    this.logger.warn(JSON.stringify({ event: 'clip_render_stale_recovered', ...request,
      previousStatus: job.clipRenderStatus }));
    return { ...job, clipRenderStatus: 'FAILED', clipRenderError: RENDER_INTERRUPTED_MESSAGE };
  }

  /** Startup sweep; requests still inside the grace window are rechecked on the next read. */
  async recoverStaleRenders() {
    const jobs = await this.prisma.processingJob.findMany({
      where: { clipRenderStatus: { in: ACTIVE_RENDER_STATES } } });
    for (const job of jobs) await this.recoverStaleRender(job);
  }

  async getAnalysis(videoId: string) {
    const { video, job } = await this.loadVideo(videoId);
    const tooLong = isVideoTooLong(video.duration) || job?.errorCode === 'VIDEO_TOO_LONG';
    const analysisStatus = tooLong ? 'REJECTED' : job?.status === 'COMPLETED' ? 'READY'
      : job?.status === 'FAILED' ? 'FAILED' : 'ANALYZING';
    const maxClipCount = analysisStatus === 'READY' ? maxClipCountForDuration(video.duration) : 0;
    let usableCandidateCount = 0;
    if (analysisStatus === 'READY') {
      const candidates = await this.prisma.clipCandidate.findMany({ where: { videoId } });
      usableCandidateCount = orderCandidatesForSelection(candidates, video.duration).ordered.length;
    }
    return {
      videoId,
      durationSec: video.duration,
      targetPlatform: video.targetPlatform ?? null,
      analysisStatus,
      rejectionMessage: tooLong ? VIDEO_TOO_LONG_MESSAGE : null,
      maxClipCount,
      defaultClipCount: defaultClipCountForMax(maxClipCount),
      candidateAvailability: analysisStatus !== 'READY' ? 'PENDING'
        : usableCandidateCount > 0 ? 'AVAILABLE' : 'EXPANSION_REQUIRED',
      clipRequest: job?.clipRenderStatus && job.clipRenderStatus !== 'IDLE' ? {
        status: job.clipRenderStatus,
        outputStyle: job.outputStyle,
        requestedClipCount: job.requestedClipCount,
        returnedClipCount: job.selectedCandidateIds.length,
        deliveryStatus: deliveryState(job),
        requestedTemplate: templateForJob(job),
        effectiveTemplate: templateForJob(job),
        // A completed request can legitimately contain fewer clips than requested,
        // but that shortfall must never be silent.
        error: job.clipRenderError,
        generation: readGenerationSettings(job.generationSettings)
      } : null
    };
  }

  async getResults(videoId: string) {
    const { video, job } = await this.loadVideo(videoId);
    const ids = job?.selectedCandidateIds ?? [];
    // Only the requested variant is listed; other styles of the same moments stay stored.
    const templateId = templateForJob(job);
    // Scoped by generationJobId + processingType + targetPlatform - the real, stable columns
    // that together identify "this request's output" - rather than variantKey, a rendering-cache
    // key whose format has changed over time and would silently exclude any clip rendered before
    // that format changed (the P0 that made every existing clip's Edit button unreachable).
    // `job.id` (ProcessingJob) is one row reused across every clip-generation request for this
    // video, so generationJobId alone does not distinguish "this request" from an earlier one
    // that used the same output style/platform (e.g. the user regenerates an identical look) -
    // processingType/targetPlatform narrow that, and sorting oldest-first so the Map below keeps
    // the LAST (most recently produced) row per candidate breaks any remaining tie in favor of
    // the current request's result.
    const clips = ids.length && job ? await this.prisma.generatedClip.findMany({
      where: { videoId, candidateId: { in: ids }, generationJobId: job.id,
        processingType: processingTypeForOutputStyle(job.outputStyle ?? 'NORMAL'),
        targetPlatform: video.targetPlatform ?? null },
      orderBy: { createdAt: 'asc' },
      include: { candidate: true, editProject: { select: { id: true, settings: true } } } }) : [];
    const byCandidate = new Map(clips.map((clip) => [clip.candidateId, clip]));
    const effectiveAiMode = jsonObject(job?.telemetry).effectiveAiMode ?? job?.aiMode;
    const ordered = ids.map((id) => byCandidate.get(id))
      .filter((clip): clip is NonNullable<typeof clip> => !!clip &&
        (!readGenerationSettings(job?.generationSettings) || (clip.generationJobId === job?.id &&
          clip.requestedTemplate === templateId && clip.effectiveTemplate === templateId &&
          clip.templateId === templateId)));
    const status = job?.clipRenderStatus && job.clipRenderStatus !== 'IDLE'
      ? job.clipRenderStatus : null;
    const cards = ordered.map((clip, index) => toClipCard(clip, effectiveAiMode, index + 1));
    const settings = readGenerationSettings(job?.generationSettings);
    const requiresStyle = settings?.resolved.styled === true;
    // Reuse each card's already-resolved style (same resolveGenerationStyleReadiness() call
    // toClipCard made) so the aggregate counts and the per-card view can never disagree.
    const styleReady = requiresStyle ? cards.filter((clip) =>
      ['EXPORT_READY', 'READY', 'LEGACY_STYLE_READY'].includes(clip.style?.status ?? '')).length
      : cards.length;
    const styleActive = requiresStyle && cards.some((clip) => ['STYLE_APPLYING', 'STYLE_READY',
      'STYLING', 'RENDERING'].includes(clip.style?.status ?? ''));
    const styleFailed = requiresStyle
      ? cards.filter((clip) => clip.style?.status === 'STYLE_FAILED').length : 0;
    const finalDeliveryStatus = requiresStyle
      ? styleReady === (job?.requestedClipCount ?? 0) ? 'COMPLETE'
        : styleActive || cards.length > styleReady + styleFailed ? 'IN_PROGRESS'
          : styleFailed > 0 || status === 'FAILED' ? 'FAILED'
            : styleReady > 0 ? 'PARTIAL' : 'IN_PROGRESS'
      : deliveryState(job);
    return {
      status,
      outputStyle: job?.outputStyle ?? null,
      requestedClipCount: job?.requestedClipCount ?? null,
      deliveredClipCount: styleReady,
      deliveryStatus: finalDeliveryStatus,
      requestedTemplate: templateId,
      effectiveTemplate: templateId,
      error: job?.clipRenderError ?? (styleFailed
        ? `${styleFailed} clip${styleFailed === 1 ? '' : 's'} could not be styled with ${templateId}.` : null),
      clips: cards
    };
  }

  /**
   * Persists QUEUED, then dispatches. Safe to resend: an identical request that is still active,
   * or already fully delivered, returns the current state without starting another render.
   */
  async create(videoId: string, request: ClipCreationRequest) {
    const { video, job } = await this.loadVideo(videoId);
    if (isVideoTooLong(video.duration)) throw new BadRequestException(VIDEO_TOO_LONG_MESSAGE);
    const maxClipCount = maxClipCountForDuration(video.duration);
    const requestedClipCount = validateRequestedClipCount(request.requestedClipCount, maxClipCount);
    if (!job || job.status !== 'COMPLETED')
      throw new ConflictException('Video analysis is not complete yet');
    const generationSettings = await this.buildGenerationSettings(request.generation,
      String(jsonObject(job.telemetry).effectiveAiMode ?? job.aiMode));
    // A styled automatic request keeps the golden AI_EDITED selection/edit
    // pipeline, then applies only its canonical style delta in EditMode.
    const outputStyle: OutputStyle = request.outputStyle ?? (generationSettings?.resolved.styled
      ? 'AI_EDITED' : job.processingType === 'EDITED_CLIPS' ? 'AI_EDITED' : 'NORMAL');
    const generationKey = generationSettings?.key ?? '';
    const identical = (current: ProcessingJob) => current.outputStyle === outputStyle &&
      current.requestedClipCount === requestedClipCount &&
      (readGenerationSettings(current.generationSettings)?.key ?? '') === generationKey;
    const alreadySatisfied = async (current: ProcessingJob) => {
      if (isActiveRender(current)) {
        if (!identical(current)) throw new ConflictException('Clips are already being created');
        // Same queue job id: a no-op for live work, and restores a dispatch lost before enqueue.
        const pending = requestOf(current);
        if (pending) await this.dispatcher.dispatch(pending).catch(() => undefined);
        return true;
      }
      // Retries/double-submits of a finished request stay no-ops; an explicit regenerate
      // (the user pressing the button again) starts a new request.
      return !request.regenerate && current.clipRenderStatus === 'COMPLETED' && identical(current) &&
        current.selectedCandidateIds.length === requestedClipCount;
    };
    if (await alreadySatisfied(job)) return this.getAnalysis(videoId);

    const requestedAt = new Date();
    // Conditional claim so concurrent POSTs cannot both start a request.
    const claimed = await this.prisma.processingJob.updateMany({
      where: { id: job.id, OR: [{ clipRenderStatus: null },
        { clipRenderStatus: { notIn: ACTIVE_RENDER_STATES } }] },
      data: { outputStyle, requestedClipCount, maxClipCount,
        generationSettings: generationSettings
          ? generationSettings as unknown as Prisma.InputJsonValue : Prisma.DbNull,
        processingType: processingTypeForOutputStyle(outputStyle), selectedCandidateIds: [],
        clipRenderStatus: 'QUEUED', clipRenderError: null, clipRequestedAt: requestedAt,
        clipRenderStartedAt: null } });
    if (!claimed.count) {
      const current = await this.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
      if (await alreadySatisfied(current)) return this.getAnalysis(videoId);
      throw new ConflictException('Clips are already being created');
    }
    const renderRequest = { videoId, processingJobId: job.id, requestedAt: requestedAt.toISOString() };
    try {
      await this.dispatcher.dispatch(renderRequest);
    } catch (error) {
      await this.markFailed(renderRequest, error, RENDER_QUEUE_FAILED_MESSAGE);
      throw new ServiceUnavailableException(RENDER_QUEUE_FAILED_MESSAGE);
    }
    return this.getAnalysis(videoId);
  }

  /** Persists FAILED for this request only; a newer request is never overwritten. */
  async markFailed(request: ClipRenderRequest, error: unknown, message = RENDER_FAILED_MESSAGE) {
    this.logger.error(`Clip creation failed for ${request.videoId}: ${
      error instanceof Error ? error.stack ?? error.message : String(error)}`);
    await this.prisma.processingJob.updateMany({ where: { id: request.processingJobId,
      clipRequestedAt: new Date(request.requestedAt), clipRenderStatus: { in: ACTIVE_RENDER_STATES } },
    data: { clipRenderStatus: 'FAILED', clipRenderError: message } }).catch(() => undefined);
  }

  /**
   * Worker entry point. A request found RENDERING is a queue redelivery after an interruption and
   * resumes; already rendered variants are reused, so nothing is rendered twice.
   */
  async processRequest(request: ClipRenderRequest) {
    const requestedAt = new Date(request.requestedAt);
    const job = await this.prisma.processingJob.findUnique({ where: { id: request.processingJobId } });
    if (!job || job.clipRequestedAt?.getTime() !== requestedAt.getTime() || !isActiveRender(job) ||
      !job.outputStyle || !job.requestedClipCount) {
      this.logger.log(JSON.stringify({ event: 'clip_render_request_skipped', ...request,
        status: job?.clipRenderStatus ?? null }));
      return;
    }
    const update: RequestUpdate = async (data) => {
      const result = await this.prisma.processingJob.updateMany({
        where: { id: job.id, clipRequestedAt: requestedAt }, data });
      if (!result.count) throw new SupersededRequestError('Clip request was superseded');
    };
    try {
      await update({ clipRenderStatus: 'RENDERING', clipRenderStartedAt: new Date() });
      const video = await this.prisma.video.findUniqueOrThrow({ where: { id: request.videoId } });
      await this.render(video, job.id, job.requestedClipCount,
        job.maxClipCount ?? maxClipCountForDuration(video.duration), job.outputStyle, update,
        readGenerationSettings(job.generationSettings),
        String(jsonObject(job.telemetry).effectiveAiMode ?? job.aiMode), request.requestedAt);
      // Styling runs after delivery, in the editor, on each clip's own project.
      if (this.hooks.afterDelivery) void this.hooks.afterDelivery(request.videoId).catch((error) =>
        this.logger.warn(JSON.stringify({ event: 'generation_styling_trigger_failed',
          videoId: request.videoId, error: error instanceof Error ? error.message : String(error) })));
    } catch (error) {
      if (error instanceof SupersededRequestError) return;
      throw error;
    }
  }

  private async render(video: Video, jobId: string, requestedClipCount: number,
    maxClipCount: number, outputStyle: OutputStyle, update: RequestUpdate,
    generation: StoredGenerationSettings | null = null, aiMode = 'FALLBACK_ONLY',
    requestedAt?: string) {
    const started = Date.now();
    let candidates = await this.prisma.clipCandidate.findMany({ where: { videoId: video.id } });
    let { ordered } = orderCandidatesForSelection(candidates, video.duration);
    // Step 11: the brief decides WHICH moments. The quality-ordered, de-duplicated
    // usable pool is re-ranked by intent (and filtered for "only X").
    const intent = generation?.interpreted.intent;
    let intentSummary: Record<string, unknown> | null = null;
    const applyIntent = async (pool: ClipCandidate[]) => {
      if (!intent || !hasContentIntent(intent)) return pool;
      const semantic = await (this.hooks.semanticIntentScores?.(pool, generation!, aiMode)
        .catch(() => null) ?? null);
      const ranked = rankByIntent(pool, intent, semantic ?? undefined);
      intentSummary = { modes: intent.modes, topics: intent.topics, strict: intent.strict,
        semanticScoring: !!semantic, poolSize: pool.length, excludedCount: ranked.excludedCount,
        top: ranked.scores.filter((score) => !score.excluded)
          .sort((a, b) => b.finalScore - a.finalScore).slice(0, requestedClipCount)
          .map((score) => ({ candidateId: score.candidateId, intentScore: score.intentScore,
            qualityScore: score.qualityScore, reason: score.reason })) };
      this.logger.log(JSON.stringify({ event: 'clip_intent_ranking', videoId: video.id, ...intentSummary }));
      return ranked.ordered;
    };
    ordered = await applyIntent(ordered);
    const initialUsable = ordered.length;
    let additionalCandidateCount = 0;
    let candidateExpansionTriggered = false;
    const processingType = processingTypeForOutputStyle(outputStyle);
    const targetPlatform = video.targetPlatform ?? null;
    const requestedTemplate = generation?.requestedTemplate ?? generation?.templateId ??
      (outputStyle === 'AI_EDITED' ? 'AUTOMATIC_1' : null);
    const effectiveTemplate = generation?.effectiveTemplate ?? requestedTemplate;
    if (requestedTemplate !== effectiveTemplate) {
      throw new Error(`Template contract violation: requested ${requestedTemplate}, effective ${effectiveTemplate}`);
    }
    const selectedByIndex = new Map<number, ClipCandidate>();
    let renderFailures = 0;
    let fullRenderAttempts = 0, gradingRepairAttempts = 0, gradingRepairRenderMs = 0;
    let qaToolFailureCount = 0;
    let maximumQaFrameCount = 0, maximumQaDecodeBatchFrames = 0;
    let preRenderRejectedCount = 0, preRenderRepairCount = 0, skippedBeforeRenderCount = 0;
    let cameraRepairAttemptCount = 0, cameraRepairSuccessCount = 0;
    let startContextEarlyRejectCount = 0;
    let hardEditRejectedCount = 0, repairableRejectedCount = 0, repairedCandidateCount = 0;
    const preRenderRejectReasonCounts: Record<string, number> = {};
    let wastedRenderMs = 0;
    const candidatePerformance: Array<Record<string, unknown>> = [];
    let nextIndex = 0, inFlight = 0, attempted = 0;
    let fatalError: ClipInfrastructureError | null = null;
    const completionMs: number[] = [];
    const concurrency = processingType === 'EDITED_CLIPS' ? aiEditedRenderConcurrency() : 1;
    const batchExporter = this.exporter as ClipExportService & { prepareBatchSource?:
      (video: Video) => Promise<{ sourcePath: string; preparationMs: number; dispose: () => Promise<void> }> };
    const batchSource = processingType === 'EDITED_CLIPS' && batchExporter.prepareBatchSource ?
      await batchExporter.prepareBatchSource(video) : null;
    let publishChain = Promise.resolve();
    const orderedSelected = () => [...selectedByIndex.entries()].sort((a, b) => a[0] - b[0])
      .map(([, candidate]) => candidate).slice(0, requestedClipCount);
    const publish = () => {
      publishChain = publishChain.then(() => update({
        selectedCandidateIds: orderedSelected().map((item) => item.id) }));
      return publishChain;
    };
    const worker = async (workerIndex: number) => {
      while (true) {
        // Reserving in-flight slots prevents the pool from rendering more clips
        // than can still be returned, while a failure releases its slot at once.
        if (fatalError || selectedByIndex.size + inFlight >= requestedClipCount ||
          nextIndex >= ordered.length) return;
        const index = nextIndex++;
        const candidate = ordered[index];
        inFlight++; attempted++;
        const candidateStarted = Date.now();
        this.logger.log(JSON.stringify({ event: 'clip_candidate_stage', videoId: video.id,
          candidateId: candidate.id, rank: index + 1, workerIndex, stage: 'RENDERING_BASE' }));
        try {
          const exported = await this.exporter.export(video, candidate, { processingType, targetPlatform,
            aspectRatio: '9:16', rank: index + 1,
            generationJobId: jobId, templateId: effectiveTemplate ?? undefined,
            generationRequestKey: requestedAt ? `${jobId}:${requestedAt}` : undefined,
            styleVariant: effectiveTemplate ?? undefined,
            // Fill renders, and every Raw render (unpolished by design, like Automatic 2 which
            // skips this QA), keep a clip whose final pixel QA still fails after repairs as
            // DEGRADED instead of discarding a full render. Automatic 1 stays strict.
            ...(fillTierOf(candidate) || effectiveTemplate === AUTOMATIC_RAW ? { acceptDegradedQuality: true } : {}),
            ...(batchSource ? { preparedSourcePath: batchSource.sourcePath } : {}) });
          // Lightweight test/dry-run exporters may intentionally return no row;
          // production returns GeneratedClip with per-candidate telemetry.
          const metrics = jsonObject(exported?.editTelemetry);
          fullRenderAttempts += Number(metrics.fullRenderAttempts) || 0;
          gradingRepairAttempts += Number(metrics.gradingRepairAttempts) || 0;
          gradingRepairRenderMs += Number(metrics.gradingRepairRenderMs) || 0;
          preRenderRepairCount += Number(metrics.preRenderRepairCount) || 0;
          if (Number(metrics.preRenderRepairCount) > 0) repairedCandidateCount++;
          cameraRepairAttemptCount += Number(metrics.cameraRepairAttemptCount) || 0;
          cameraRepairSuccessCount += Number(metrics.cameraRepairSuccessCount) || 0;
          wastedRenderMs += Number(metrics.wastedRenderMs) || 0;
          qaToolFailureCount += Number(metrics.qaToolFailureCount) || 0;
          maximumQaFrameCount = Math.max(maximumQaFrameCount, Number(metrics.qaNormalFrameCount) || 0);
          maximumQaDecodeBatchFrames = Math.max(maximumQaDecodeBatchFrames,
            Number(metrics.qaDecodeBatchFrameLimit) || 0);
          candidatePerformance.push({ candidateId: candidate.id, rank: index + 1,
            originalCandidateRank: index + 1,
            hardUsabilityStatus: 'USABLE',
            editRepairAttempted: Number(metrics.preRenderRepairCount) > 0,
            editRepairSucceeded: Number(metrics.preRenderRepairCount) > 0 &&
              Number(metrics.preRenderRejectedCount) === 0,
            repairAttempted: Number(metrics.preRenderRepairCount) > 0,
            repairSucceeded: Number(metrics.preRenderRepairCount) > 0 &&
              Number(metrics.preRenderRejectedCount) === 0,
            analysisMs: Number(metrics.analysisMs) || 0,
            planMs: Number(metrics.planMs) || 0,
            planningMs: Number(metrics.planMs) || 0,
            validationMs: Number(metrics.validationMs ?? metrics.preRenderValidationMs) || 0,
            renderMs: Number(metrics.baseRenderMs ?? metrics.renderMs) || 0,
            qaMs: Number(metrics.qaMs ?? metrics.qualityCheckMs) || 0,
            storageMs: Number(metrics.storageMs) || 0,
            repairMs: Number(metrics.repairMs) || 0,
            totalMs: Date.now() - candidateStarted, disposition: 'READY',
            finalDisposition: 'READY' });
          selectedByIndex.set(index, candidate);
          completionMs.push(Date.now() - started);
          await publish();
          this.logger.log(JSON.stringify({ event: 'clip_candidate_stage', videoId: video.id,
            candidateId: candidate.id, rank: index + 1, workerIndex, stage: 'COMPLETE',
            templateId: effectiveTemplate, renderStatus: 'SUCCEEDED',
            styleStatus: generation?.resolved.styled ? 'PENDING' : 'NOT_REQUESTED',
            totalCandidateMs: Date.now() - candidateStarted }));
        } catch (error) {
          if (error instanceof SupersededRequestError) throw error;
          if (error instanceof ClipInfrastructureError) {
            fatalError = error;
            this.logger.error(JSON.stringify({ event: 'clip_infrastructure_failure', videoId: video.id,
              candidateId: candidate.id, failureStage: error.failureType,
              wastedMs: Date.now() - candidateStarted, error: error.message }));
            return;
          }
          renderFailures++;
          const report = error instanceof EditQualityError ? jsonObject(error.report) : {};
          const skipped = report.candidateSkippedBeforeRender === true ||
            report.preRenderClassification === 'SKIP_BEFORE_RENDER';
          const failureType = error instanceof EditQualityError ?
            'CANDIDATE_REJECTED_QUALITY' : 'RENDER_FAILED';
          fullRenderAttempts += Number(report.fullRenderAttempts) || 0;
          gradingRepairAttempts += Number(report.gradingRepairAttempts) || 0;
          gradingRepairRenderMs += Number(report.gradingRepairRenderMs) || 0;
          preRenderRepairCount += Number(report.preRenderRepairCount) || 0;
          cameraRepairAttemptCount += Number(report.cameraRepairAttemptCount) || 0;
          cameraRepairSuccessCount += Number(report.cameraRepairSuccessCount) || 0;
          wastedRenderMs += Number(report.wastedRenderMs) || 0;
          qaToolFailureCount += Number(report.qaToolFailureCount) || 0;
          maximumQaFrameCount = Math.max(maximumQaFrameCount, Number(report.qaNormalFrameCount) || 0);
          if (skipped) { preRenderRejectedCount++; skippedBeforeRenderCount++; }
          const repairAttempted = Number(report.preRenderRepairCount) > 0;
          if (repairAttempted) repairableRejectedCount++;
          else if (skipped) hardEditRejectedCount++;
          const rejection = { candidateId: candidate.id, rank: index + 1,
            failureType,
            originalCandidateRank: index + 1,
            hardUsabilityStatus: repairAttempted ? 'REPAIR_FAILED' :
              skipped ? 'HARD_REJECTED' : 'EXECUTION_FAILED',
            editRepairAttempted: repairAttempted, editRepairSucceeded: false,
            repairAttempted,
            repairSucceeded: false,
            preRenderRejectReason: String(report.preRenderRejectReason ??
              (skipped ? 'STRUCTURAL_PRE_RENDER_VALIDATION' : 'POST_RENDER_OR_EXECUTION_FAILURE')),
            timeSpentBeforeRejectMs: Number(report.timeSpentBeforeRejectMs) || Date.now() - candidateStarted,
            llmCallsBeforeReject: Number(report.llmCallsBeforeReject) || 0,
            analysisMsBeforeReject: Number(report.analysisMsBeforeReject) || 0 };
          const reasons = Array.isArray(report.preRenderRejectReasons) ?
            report.preRenderRejectReasons.map(String) : [rejection.preRenderRejectReason];
          for (const reason of reasons) preRenderRejectReasonCounts[reason] =
            (preRenderRejectReasonCounts[reason] ?? 0) + 1;
          if (reasons.includes('UNREPAIRABLE_START_CONTEXT')) startContextEarlyRejectCount++;
          this.logger.warn(JSON.stringify({ event: 'candidate_rejected_cost', videoId: video.id,
            ...rejection }));
          candidatePerformance.push({ ...rejection,
            analysisMs: Number(report.analysisMs ?? report.analysisMsBeforeReject) || 0,
            planMs: Number(report.planMs) || 0,
            planningMs: Number(report.planMs) || 0,
            validationMs: Number(report.preRenderValidationMs) || 0,
            renderMs: Number(report.baseRenderMs) || 0,
            qaMs: Number(report.qualityCheckMs) || 0,
            storageMs: Number(report.storageMs) || 0,
            repairMs: Number(report.repairMs) || 0,
            failureStage: failureType,
            wastedMs: Date.now() - candidateStarted,
            totalMs: Date.now() - candidateStarted,
            disposition: skipped ? 'SKIP_BEFORE_RENDER' : 'FAILED',
            finalDisposition: skipped ? 'SKIP_BEFORE_RENDER' : 'FAILED' });
          this.logger.warn(JSON.stringify({ event: 'clip_candidate_stage', videoId: video.id,
            candidateId: candidate.id, rank: index + 1, workerIndex, stage: 'FAILED',
            totalCandidateMs: Date.now() - candidateStarted,
            error: error instanceof Error ? error.message : String(error) }));
        } finally { inFlight--; }
      }
    };
    let stopReason = 'REQUESTED_COUNT_DELIVERED';
    let fillTier: 0 | FillTier = 0;
    let fillCandidateCount = 0;
    try {
      // Exhaust the current ranked pool first. If edit-stage failures still leave
      // a shortfall, expand from persisted transcript/chunk data and continue;
      // no transcription, whole-video understanding, or visual analysis is rerun.
      while (selectedByIndex.size < requestedClipCount) {
        const available = ordered.length - nextIndex;
        if (available > 0) await Promise.all(Array.from({ length: Math.min(concurrency,
          requestedClipCount - selectedByIndex.size, available) }, (_, index) => worker(index)));
        if (fatalError) throw fatalError;
        if (selectedByIndex.size >= requestedClipCount) break;
        candidateExpansionTriggered = true;
        const accept = intent && intent.topics.length ? (text: string) => matchesIntent(text, intent) : undefined;
        // Distinct moments first; once those are exhausted, the fill tiers make sure the request
        // still delivers exactly the number of clips asked for.
        let added = 0;
        let fillRows: ClipCandidate[] = [];
        while (true) {
          if (fillTier === 0) {
            added = await this.expandCandidates(video, candidates, ordered,
              requestedClipCount - selectedByIndex.size, accept);
          } else {
            fillRows = await this.fillCandidates(video, candidates, ordered,
              [...selectedByIndex.values()], requestedClipCount - selectedByIndex.size, fillTier, accept);
            added = fillRows.length;
          }
          if (added || fillTier >= 3) break;
          fillTier = (fillTier + 1) as 0 | FillTier;
        }
        additionalCandidateCount += added;
        if (fillTier > 0) fillCandidateCount += added;
        if (!added) {
          stopReason = 'NO_ADDITIONAL_USABLE_MOMENTS';
          break;
        }
        candidates = await this.prisma.clipCandidate.findMany({ where: { videoId: video.id } });
        const known = new Set(ordered.map((candidate) => candidate.id));
        const appended = await applyIntent(fillRows.length ? fillRows.filter((candidate) => !known.has(candidate.id))
          : orderCandidatesForSelection(candidates, video.duration).ordered
            .filter((candidate) => !known.has(candidate.id)));
        if (!appended.length) {
          if (fillTier < 3) { fillTier = (fillTier + 1) as 0 | FillTier; continue; }
          stopReason = 'EXPANSION_ONLY_PRODUCED_DUPLICATES_OR_OFF_INTENT';
          break;
        }
        // Never reorder candidates already attempted or delivered. Newly
        // discovered moments are deterministic fallbacks after the saved pool.
        ordered.push(...appended);
      }
      await publishChain;
    } finally { await batchSource?.dispose(); }
    const selected = orderedSelected();
    const job = await this.prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    const bands = selected.map((candidate) => qualityBand(candidate.contentPotential));
    const preservedTopN = [...selectedByIndex.keys()].filter((index) => index < requestedClipCount).length;
    const topNPreservationRate = requestedClipCount ?
      Number((preservedTopN / requestedClipCount).toFixed(4)) : 1;
    const finalUsability = orderCandidatesForSelection(candidates, video.duration);
    const hardFailureReasonCounts = { ...finalUsability.hardFailureReasonCounts };
    for (const item of candidatePerformance) {
      if (item.hardUsabilityStatus !== 'HARD_REJECTED') continue;
      const reason = String(item.preRenderRejectReason ?? 'HARD_EDIT_FAILURE');
      hardFailureReasonCounts[reason] = (hardFailureReasonCounts[reason] ?? 0) + 1;
    }
    const hardRejectedCount = finalUsability.rejectedCount + hardEditRejectedCount;
    const originalRankOfDeliveredClips = [...selectedByIndex.keys()]
      .sort((a, b) => a - b).slice(0, requestedClipCount).map((index) => index + 1);
    // Candidate rank is useful telemetry, but requestedClipIndex is delivery
    // provenance and must be dense (1..delivered) even after backfill skips.
    await this.prisma.$transaction(selected.map((candidate, index) =>
      this.prisma.generatedClip.updateMany({ where: { videoId: video.id,
        candidateId: candidate.id, generationJobId: jobId, processingType },
      data: { requestedClipIndex: index + 1 } })));
    const deliveredClipCount = selected.length;
    const replacementCandidateCount = [...selectedByIndex.keys()].filter((index) =>
      index >= requestedClipCount).length;
    const shortfall = deliveredClipCount < requestedClipCount;
    const partialReason = shortfall && renderFailures === 0 ? (intentSummary && Number(intentSummary['excludedCount']) > 0
      ? 'INSUFFICIENT_ON_INTENT_SOURCE_MOMENTS'
      : 'INSUFFICIENT_DISTINCT_SOURCE_MOMENTS') : null;
    const shortfallReason = shortfall && renderFailures > 0 ?
      'CANDIDATE_RENDER_FAILURES_EXHAUSTED_POOL' : partialReason;
    const unusableCandidateCount = hardRejectedCount + repairableRejectedCount;
    const reasons = Object.entries(hardFailureReasonCounts)
      .sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason}=${count}`);
    const offIntent = intentSummary && Number(intentSummary['excludedCount']) > 0
      ? ` ${String(intentSummary['excludedCount'])} moments did not match your brief and were left out.` : '';
    const shortfallMessage = shortfall ? `Requested ${requestedClipCount}; delivered ${
      deliveredClipCount}. Reason: ${shortfallReason}.${offIntent} No additional distinct usable clips remained after hard validation and ` +
      `deterministic repair. Unusable candidates: ${unusableCandidateCount}. Hard failures: ${
        reasons.length ? reasons.join(', ') : 'none'}; repair failures: ${repairableRejectedCount}.` : null;
    const clipSelection = {
      sourceDurationSec: video.duration, videoDurationSec: video.duration, maxClipCount, requestedClipCount,
      requestedTemplate, effectiveTemplate,
      deliveredClipCount,
      candidatePoolSize: ordered.length, candidatePoolCount: ordered.length,
      usableCandidateCount: ordered.length, initialUsableCandidateCount: initialUsable,
      returnedClipCount: selected.length, targetPlatform, outputStyle,
      highQualitySelectedCount: bands.filter((band) => band === 'high').length,
      mediumQualitySelectedCount: bands.filter((band) => band === 'medium').length,
      fallbackUsableSelectedCount: bands.filter((band) => band === 'fallbackUsable').length,
      candidateExpansionTriggered, additionalCandidateCount, expandedCandidateCount: additionalCandidateCount,
      fillTierReached: fillTier, fillCandidateCount,
      replacementCandidateCount, additionalSemanticCalls: 0,
      renderFailures, selectionMs: Date.now() - started,
      selectedCandidateCount: selected.length, renderRequestedCount: attempted,
      renderSucceededCount: selected.length, renderFailedCount: renderFailures,
      eligibleCandidateCount: ordered.length, styledCount: generation?.resolved.styled ? 0 : selected.length,
      backfillAttempts: replacementCandidateCount, failedCandidateCount: renderFailures,
      renderConcurrency: concurrency,
      completedCount: selected.length, deliveredCount: selected.length,
      failedCount: Math.max(0, renderFailures - skippedBeforeRenderCount),
      skippedCount: skippedBeforeRenderCount + Math.max(0, ordered.length - attempted),
      sourcePreparationMs: batchSource?.preparationMs ?? 0,
      timeToFirstClipMs: completionMs[0] ?? null,
      timeToHalfRequestedMs: completionMs[Math.max(0, Math.ceil(requestedClipCount / 2) - 1)] ?? null,
      timeToSecondClipMs: completionMs[1] ?? null,
      timeToAllClipsMs: Date.now() - started,
      totalBatchMs: Date.now() - started,
      fullRenderAttempts, gradingRepairAttempts, gradingRepairRenderMs,
      preRenderRejectedCount, preRenderRepairCount, skippedBeforeRenderCount,
      cameraRepairAttemptCount, cameraRepairSuccessCount, startContextEarlyRejectCount,
      preRenderRejectReasonCounts, hardRejectedCount, repairableRejectedCount,
      repairedCandidateCount, unusableCandidateCount, hardFailureReasonCounts,
      semanticDuplicateRejectedCount: finalUsability.semanticDuplicateRejectedCount,
      originalRankOfDeliveredClips, topNPreservationRate, wastedRenderMs, qaToolFailureCount,
      maximumQaFrameCount, maximumQaDecodeBatchFrames,
      candidatePerformance,
      intent: intentSummary,
      deliveryStatus: !selected.length || shortfall && renderFailures > 0 ? 'FAILED' :
        shortfall ? 'PARTIAL' : 'COMPLETE',
      failureReason: shortfall && renderFailures > 0 ? shortfallReason : null,
      partialReason,
      totalWallMs: Date.now() - started,
      deliveryStopReason: selected.length >= requestedClipCount ? 'REQUESTED_COUNT_DELIVERED' : stopReason
    };
    if (selected.length < requestedClipCount) {
      this.logger.warn(JSON.stringify({ event: 'clip_delivery_stopped', videoId: video.id,
        requestedClipCount, deliveredClipCount: selected.length, reason: clipSelection.deliveryStopReason,
        attempted, renderFailures, expansionTriggered: candidateExpansionTriggered,
        additionalCandidateCount, intentExcluded: intentSummary?.['excludedCount'] ?? 0 }));
    }
    this.logger.log(JSON.stringify({ event: 'clip_selection_summary', videoId: video.id,
      ...clipSelection }));
    await update({
      selectedCandidateIds: selected.map((item) => item.id),
      clipRenderStatus: selected.length && !(shortfall && renderFailures > 0) ? 'COMPLETED' : 'FAILED',
      clipRenderError: shortfallMessage ?? (selected.length ? null : ordered.length
        ? 'Clips could not be created. Please try again.'
        : 'No usable moments were found in this video.'),
      telemetry: { ...jsonObject(job.telemetry), clipSelection } as Prisma.InputJsonValue });
  }

  /**
   * Deterministic, LLM-free expansion over the persisted transcript analysis. Whisper, whole-video
   * understanding and visual analysis are reused, never rerun.
   */
  private async expandCandidates(video: Video, existing: ClipCandidate[],
    ordered: ClipCandidate[], shortfall: number, accept?: (transcript: string) => boolean) {
    const context = await this.prisma.video.findUniqueOrThrow({ where: { id: video.id }, select: {
      chunks: { include: { analysis: true }, orderBy: { position: 'asc' } },
      understanding: { include: { chapters: { orderBy: { position: 'asc' } } } },
      transcript: { select: { segments: { select: { words: true } } } }
    } });
    if (!context.chunks?.length) return 0;
    const understanding = context.understanding;
    const raw = generateCandidateRanges(video.id, context.chunks, understanding ? {
      mainTopic: understanding.mainTopic, topics: understanding.topics,
      summary: understanding.summary, keyClaims: understanding.keyClaims,
      questions: understanding.questions, chapters: understanding.chapters
    } : null, 400);
    const words: TranscriptWord[] = (context.transcript?.segments ?? []).flatMap((segment) =>
      Array.isArray(segment.words) ? (segment.words as Array<Partial<TranscriptWord>>)
        .filter((word): word is TranscriptWord => !!word && Number.isFinite(word.start) &&
          Number.isFinite(word.end) && typeof word.text === 'string') : []);
    const knownKeys = new Set(existing.map((candidate) => candidate.rangeKey));
    const round2 = (value: number) => Math.round(value * 100) / 100;
    const accepted: ScoredClipCandidate[] = [];
    const target = shortfall + Math.max(2, Math.ceil(shortfall / 2));
    for (const candidate of raw) {
      if (accepted.length >= target) break;
      if (candidate.reject) continue;
      const optimized = optimizeClipBoundaries(candidate, words);
      const startTime = round2(optimized.startTime);
      const endTime = round2(optimized.endTime);
      const rangeKey = `${startTime.toFixed(3)}:${endTime.toFixed(3)}`;
      const next: ScoredClipCandidate = { ...candidate, startTime, endTime, rangeKey,
        duration: round2(endTime - startTime), transcriptText: optimized.transcriptText,
        openingStrength: optimized.openingStrength, endingStrength: optimized.endingStrength,
        rank: 0 };
      if (knownKeys.has(rangeKey)) continue;
      // Step 11: a topic brief only adds moments that are actually about it.
      if (accept && !accept(next.transcriptText)) continue;
      const probe = { ...next, rank: 0 };
      if (isDuplicateOfAny(probe, ordered) || isDuplicateOfAny(probe, accepted)) continue;
      accepted.push(next);
    }
    if (!accepted.length) return 0;
    await this.persistExtraCandidates(video, existing, accepted, { [EXPANSION_MARKER]: true },
      'Candidate expansion after analysis; transcript-based content');
    return accepted.length;
  }

  /**
   * Fill tiers (after every distinct moment is used): tier 1-2 re-admit analysed moments that
   * were weaker or partly overlapping; tier 3 slides sentence-aligned windows across the
   * transcript, so even a short source yields the requested count. Deterministic and LLM-free.
   */
  private async fillCandidates(video: Video, existing: ClipCandidate[], ordered: ClipCandidate[],
    delivered: ClipCandidate[], shortfall: number, tier: FillTier,
    accept?: (transcript: string) => boolean): Promise<ClipCandidate[]> {
    const context = await this.prisma.video.findUniqueOrThrow({ where: { id: video.id }, select: {
      chunks: { include: { analysis: true }, orderBy: { position: 'asc' } },
      understanding: { include: { chapters: { orderBy: { position: 'asc' } } } },
      transcript: { select: { segments: { select: { words: true } } } }
    } });
    if (!context.chunks?.length) return [];
    const understanding = context.understanding;
    const raw = generateCandidateRanges(video.id, context.chunks, understanding ? {
      mainTopic: understanding.mainTopic, topics: understanding.topics,
      summary: understanding.summary, keyClaims: understanding.keyClaims,
      questions: understanding.questions, chapters: understanding.chapters
    } : null, 400);
    const words: TranscriptWord[] = (context.transcript?.segments ?? []).flatMap((segment) =>
      Array.isArray(segment.words) ? (segment.words as Array<Partial<TranscriptWord>>)
        .filter((word): word is TranscriptWord => !!word && Number.isFinite(word.start) &&
          Number.isFinite(word.end) && typeof word.text === 'string') : []);
    if (!raw.length || !words.length) return [];
    // What a new fill must differ from: clips actually delivered and the other fills. Moments
    // that failed or were never reached do not occupy their range.
    const occupied = [...delivered, ...ordered.filter((candidate) => fillTierOf(candidate))];
    const knownKeys = new Set(existing.map((candidate) => candidate.rangeKey));
    const round2 = (value: number) => Math.round(value * 100) / 100;
    const target = shortfall + Math.max(2, Math.ceil(shortfall / 2));
    const accepted: ScoredClipCandidate[] = [];
    const consider = (base: ScoredClipCandidate, startTime: number, endTime: number) => {
      const optimized = optimizeClipBoundaries({ startTime, endTime,
        transcriptText: words.filter((word) => word.start >= startTime - .01 && word.end <= endTime + .01)
          .map((word) => word.text).join(' ') }, words);
      const start = round2(optimized.startTime);
      const end = round2(optimized.endTime);
      const rangeKey = `${start.toFixed(3)}:${end.toFixed(3)}`;
      const next: ScoredClipCandidate = { ...base, startTime: start, endTime: end, rangeKey,
        duration: round2(end - start), transcriptText: optimized.transcriptText,
        openingStrength: optimized.openingStrength, endingStrength: optimized.endingStrength,
        reject: false, rank: 0 };
      if (knownKeys.has(rangeKey) || (accept && !accept(next.transcriptText))) return;
      if (!evaluateFillUsability(next, video.duration).usable) return;
      if (isNearDuplicateOfAny(next, occupied, tier) || isNearDuplicateOfAny(next, accepted, tier)) return;
      knownKeys.add(rangeKey);
      accepted.push(next);
    };
    if (tier < 3) {
      for (const candidate of [...raw].sort((a, b) => b.contentPotential - a.contentPotential)) {
        if (accepted.length >= target) break;
        consider(candidate, candidate.startTime, candidate.endTime);
      }
    } else {
      // Sentence starts (or long pauses) are the only places a window may begin or end.
      const starts = words.map((word, index) => index === 0 || /[.?!]["')\]]?$/.test(words[index - 1].text) ||
        word.start - words[index - 1].end > .6 ? index : -1).filter((index) => index >= 0);
      const sourceEnd = Math.min(video.duration ?? words[words.length - 1].end, words[words.length - 1].end);
      for (const length of [30, 22, 45, 16, 60]) {
        for (const startIndex of starts) {
          if (accepted.length >= target) break;
          const startTime = words[startIndex].start;
          const limit = Math.min(sourceEnd, startTime + length);
          if (limit - startTime < 15) continue;
          // End on the last sentence end inside the window (or the last word, failing that).
          let endIndex = -1;
          for (let index = startIndex; index < words.length && words[index].end <= limit + .01; index++) {
            if (/[.?!]["')\]]?$/.test(words[index].text) || index === words.length - 1) endIndex = index;
          }
          if (endIndex < 0 || words[endIndex].end - startTime < 15) continue;
          const base = raw.reduce((best, item) => {
            const overlap = Math.min(item.endTime, words[endIndex].end) - Math.max(item.startTime, startTime);
            const bestOverlap = Math.min(best.endTime, words[endIndex].end) - Math.max(best.startTime, startTime);
            return overlap > bestOverlap ? item : best;
          }, raw[0]);
          consider({ ...base, reason: `Fill window (${length}s) to deliver the requested clip count`,
            contentPotential: Math.min(base.contentPotential, 45) }, startTime, words[endIndex].end);
        }
      }
    }
    if (!accepted.length) return [];
    return this.persistExtraCandidates(video, existing, accepted, { [FILL_MARKER]: tier },
      `Fill tier ${tier}: delivers the requested clip count after distinct moments ran out`);
  }

  private async persistExtraCandidates(video: Video, existing: ClipCandidate[],
    accepted: ScoredClipCandidate[], marker: Record<string, unknown>, fallbackReason: string) {
    let rank = existing.reduce((maximum, candidate) => Math.max(maximum, candidate.rank ?? 0), 0);
    const created: ClipCandidate[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const candidate of accepted) {
        const content = fallbackContent(candidate, video.targetPlatform ?? null);
        const data = {
          videoId: video.id, rangeKey: candidate.rangeKey,
          startTime: candidate.startTime, endTime: candidate.endTime, duration: candidate.duration,
          transcriptText: candidate.transcriptText,
          titleCandidate: content.title ?? '', hookCandidate: content.bestHook ?? '',
          captionCandidate: content.caption ?? '', synopsis: content.synopsis ?? '',
          hashtags: content.hashtags ?? [], reason: candidate.reason,
          hookScore: candidate.hookScore, sourceHookScore: candidate.sourceHookScore,
          informationScore: candidate.informationScore, emotionScore: 0, controversyScore: 0,
          standaloneScore: candidate.standaloneScore, viralPotentialScore: candidate.overallScore,
          heuristicScore: candidate.heuristicScore, payoffScore: candidate.payoffScore,
          flowScore: candidate.flowScore, retentionScore: candidate.retentionScore,
          shareabilityScore: candidate.shareabilityScore,
          contentPotential: candidate.contentPotential, overallScore: candidate.overallScore,
          reject: false, topic: candidate.topic, rejectionReason: '',
          judgeSource: 'HEURISTIC_FALLBACK', rank: ++rank,
          bestHook: content.bestHook ?? '', alternateHooks: content.alternateHooks ?? [],
          hooks: (content.hooks ?? []) as Prisma.InputJsonValue,
          generatedHookScore: content.generatedHookScore ?? 0,
          selectedHookStrategy: content.selectedHookStrategy ?? 'educational/value',
          title: content.title ?? '', caption: content.caption ?? '', cta: content.cta ?? '',
          contentType: content.contentType ?? '', whySelected: content.whySelected ?? candidate.reason,
          promptVersion: CLIP_CONTENT_PROMPT_VERSION, generationStatus: 'FALLBACK',
          fallbackReason,
          contentFingerprint: buildContentFingerprint(candidate, video.targetPlatform ?? null),
          evidence: marker as Prisma.InputJsonValue,
          generationMode: 'DETERMINISTIC_FALLBACK', fallbackUsed: true,
          decisionSource: 'DETERMINISTIC_FALLBACK',
          openingStrength: candidate.openingStrength ?? 0,
          endingStrength: candidate.endingStrength ?? 0
        };
        created.push(await tx.clipCandidate.create({ data }));
      }
    });
    return created;
  }
}
