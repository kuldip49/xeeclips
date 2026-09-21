import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { ClipCandidate, ClipRenderStatus, Prisma, ProcessingJob, Video } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ClipExportService } from './clip-export.service';
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
  isDuplicateOfAny,
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

export type ClipCreationRequest = { requestedClipCount: unknown; outputStyle: OutputStyle | null };

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
    outputStyle: body.outputStyle == null ? null : parseOutputStyle(body.outputStyle)
  };
}

const EXPANSION_MARKER = 'candidateExpansion';
const isExpansionCandidate = (candidate: ClipCandidate) =>
  !!candidate.evidence && typeof candidate.evidence === 'object' &&
  !Array.isArray(candidate.evidence) &&
  (candidate.evidence as Record<string, unknown>)[EXPANSION_MARKER] === true;

/**
 * Canonical selection order: the analysis pool first, then expansion candidates that do not
 * duplicate it. Expansion therefore never displaces clips a user has already received.
 */
export function orderCandidatesForSelection(candidates: ClipCandidate[], videoDuration: number | null) {
  const primary = rankUsableCandidates(candidates.filter((item) => !isExpansionCandidate(item)),
    videoDuration);
  const expansion = rankUsableCandidates(candidates.filter(isExpansionCandidate), videoDuration);
  const ordered = [...primary.ordered];
  let crossPoolDuplicateCount = 0;
  for (const candidate of expansion.ordered) {
    if (isDuplicateOfAny(candidate, ordered)) crossPoolDuplicateCount++;
    else ordered.push(candidate);
  }
  const rejected = [...primary.rejected, ...expansion.rejected];
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
};

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
    aiModeUsed: userAiModeLabel(effectiveAiMode)
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

const requestOf = (job: Pick<ProcessingJob, 'id' | 'videoId' | 'clipRequestedAt'>):
  ClipRenderRequest | null => job.clipRequestedAt ? { videoId: job.videoId,
  processingJobId: job.id, requestedAt: job.clipRequestedAt.toISOString() } : null;

type RequestUpdate = (data: Prisma.ProcessingJobUpdateManyMutationInput) => Promise<void>;
class SupersededRequestError extends Error {}

export class ClipSelectionService {
  private readonly logger = new Logger(ClipSelectionService.name);
  private readonly dispatcher: ClipRenderDispatcher;

  constructor(private readonly prisma: PrismaService, private readonly exporter: ClipExportService,
    dispatcher?: ClipRenderDispatcher) {
    this.dispatcher = dispatcher ?? this.inlineDispatcher();
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
        // A completed request can legitimately contain fewer clips than requested,
        // but that shortfall must never be silent.
        error: job.clipRenderError
      } : null
    };
  }

  async getResults(videoId: string) {
    const { video, job } = await this.loadVideo(videoId);
    const ids = job?.selectedCandidateIds ?? [];
    // Only the requested variant is listed; other styles of the same moments stay stored.
    const variantKey = job?.outputStyle ? clipVariantKey(
      processingTypeForOutputStyle(job.outputStyle), video.targetPlatform ?? null) : null;
    const clips = ids.length && variantKey ? await this.prisma.generatedClip.findMany({
      where: { videoId, candidateId: { in: ids }, variantKey }, include: { candidate: true } }) : [];
    const byCandidate = new Map(clips.map((clip) => [clip.candidateId, clip]));
    const effectiveAiMode = jsonObject(job?.telemetry).effectiveAiMode ?? job?.aiMode;
    const ordered = ids.map((id) => byCandidate.get(id))
      .filter((clip): clip is NonNullable<typeof clip> => !!clip);
    const status = job?.clipRenderStatus && job.clipRenderStatus !== 'IDLE'
      ? job.clipRenderStatus : null;
    return {
      status,
      outputStyle: job?.outputStyle ?? null,
      requestedClipCount: job?.requestedClipCount ?? null,
      error: job?.clipRenderError ?? null,
      clips: ordered.map((clip, index) => toClipCard(clip, effectiveAiMode, index + 1))
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
    const outputStyle: OutputStyle = request.outputStyle ??
      (job.processingType === 'EDITED_CLIPS' ? 'AI_EDITED' : 'NORMAL');
    const identical = (current: ProcessingJob) => current.outputStyle === outputStyle &&
      current.requestedClipCount === requestedClipCount;
    const alreadySatisfied = async (current: ProcessingJob) => {
      if (isActiveRender(current)) {
        if (!identical(current)) throw new ConflictException('Clips are already being created');
        // Same queue job id: a no-op for live work, and restores a dispatch lost before enqueue.
        const pending = requestOf(current);
        if (pending) await this.dispatcher.dispatch(pending).catch(() => undefined);
        return true;
      }
      return current.clipRenderStatus === 'COMPLETED' && identical(current) &&
        current.selectedCandidateIds.length === requestedClipCount;
    };
    if (await alreadySatisfied(job)) return this.getAnalysis(videoId);

    const requestedAt = new Date();
    // Conditional claim so concurrent POSTs cannot both start a request.
    const claimed = await this.prisma.processingJob.updateMany({
      where: { id: job.id, OR: [{ clipRenderStatus: null },
        { clipRenderStatus: { notIn: ACTIVE_RENDER_STATES } }] },
      data: { outputStyle, requestedClipCount, maxClipCount,
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
        job.maxClipCount ?? maxClipCountForDuration(video.duration), job.outputStyle, update);
    } catch (error) {
      if (error instanceof SupersededRequestError) return;
      throw error;
    }
  }

  private async render(video: Video, jobId: string, requestedClipCount: number,
    maxClipCount: number, outputStyle: OutputStyle, update: RequestUpdate) {
    const started = Date.now();
    let candidates = await this.prisma.clipCandidate.findMany({ where: { videoId: video.id } });
    let { ordered } = orderCandidatesForSelection(candidates, video.duration);
    const initialUsable = ordered.length;
    let additionalCandidateCount = 0;
    let candidateExpansionTriggered = false;
    const processingType = processingTypeForOutputStyle(outputStyle);
    const targetPlatform = video.targetPlatform ?? null;
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
        if (selectedByIndex.size + inFlight >= requestedClipCount || nextIndex >= ordered.length) return;
        const index = nextIndex++;
        const candidate = ordered[index];
        inFlight++; attempted++;
        const candidateStarted = Date.now();
        this.logger.log(JSON.stringify({ event: 'clip_candidate_stage', videoId: video.id,
          candidateId: candidate.id, rank: index + 1, workerIndex, stage: 'RENDERING_BASE' }));
        try {
          const exported = await this.exporter.export(video, candidate, { processingType, targetPlatform,
            aspectRatio: '9:16', rank: index + 1,
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
            totalCandidateMs: Date.now() - candidateStarted }));
        } catch (error) {
          if (error instanceof SupersededRequestError) throw error;
          renderFailures++;
          const report = error instanceof EditQualityError ? jsonObject(error.report) : {};
          const skipped = report.candidateSkippedBeforeRender === true ||
            report.preRenderClassification === 'SKIP_BEFORE_RENDER';
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
    try {
      // Exhaust the current ranked pool first. If edit-stage failures still leave
      // a shortfall, expand from persisted transcript/chunk data and continue;
      // no transcription, whole-video understanding, or visual analysis is rerun.
      while (selectedByIndex.size < requestedClipCount) {
        const available = ordered.length - nextIndex;
        if (available > 0) await Promise.all(Array.from({ length: Math.min(concurrency,
          requestedClipCount - selectedByIndex.size, available) }, (_, index) => worker(index)));
        if (selectedByIndex.size >= requestedClipCount) break;
        candidateExpansionTriggered = true;
        const added = await this.expandCandidates(video, candidates, ordered,
          requestedClipCount - selectedByIndex.size);
        additionalCandidateCount += added;
        if (!added) break;
        candidates = await this.prisma.clipCandidate.findMany({ where: { videoId: video.id } });
        const refreshed = orderCandidatesForSelection(candidates, video.duration).ordered;
        const known = new Set(ordered.map((candidate) => candidate.id));
        const appended = refreshed.filter((candidate) => !known.has(candidate.id));
        if (!appended.length) break;
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
    const deliveredClipCount = selected.length;
    const replacementCandidateCount = [...selectedByIndex.keys()].filter((index) =>
      index >= requestedClipCount).length;
    const shortfall = deliveredClipCount < requestedClipCount;
    const unusableCandidateCount = hardRejectedCount + repairableRejectedCount;
    const reasons = Object.entries(hardFailureReasonCounts)
      .sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason}=${count}`);
    const shortfallMessage = shortfall ? `Requested ${requestedClipCount}; delivered ${
      deliveredClipCount}. No additional distinct usable clips remained after hard validation and ` +
      `deterministic repair. Unusable candidates: ${unusableCandidateCount}. Hard failures: ${
        reasons.length ? reasons.join(', ') : 'none'}; repair failures: ${repairableRejectedCount}.` : null;
    const clipSelection = {
      sourceDurationSec: video.duration, videoDurationSec: video.duration, maxClipCount, requestedClipCount,
      deliveredClipCount,
      candidatePoolSize: ordered.length,
      usableCandidateCount: ordered.length, initialUsableCandidateCount: initialUsable,
      returnedClipCount: selected.length, targetPlatform, outputStyle,
      highQualitySelectedCount: bands.filter((band) => band === 'high').length,
      mediumQualitySelectedCount: bands.filter((band) => band === 'medium').length,
      fallbackUsableSelectedCount: bands.filter((band) => band === 'fallbackUsable').length,
      candidateExpansionTriggered, additionalCandidateCount, expandedCandidateCount: additionalCandidateCount,
      replacementCandidateCount, additionalSemanticCalls: 0,
      renderFailures, selectionMs: Date.now() - started,
      selectedCandidateCount: selected.length, renderConcurrency: concurrency,
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
      candidatePerformance
    };
    this.logger.log(JSON.stringify({ event: 'clip_selection_summary', videoId: video.id,
      ...clipSelection }));
    await update({
      selectedCandidateIds: selected.map((item) => item.id),
      clipRenderStatus: selected.length || !ordered.length ? 'COMPLETED' : 'FAILED',
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
    ordered: ClipCandidate[], shortfall: number) {
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
      const probe = { ...next, rank: 0 };
      if (isDuplicateOfAny(probe, ordered) || isDuplicateOfAny(probe, accepted)) continue;
      accepted.push(next);
    }
    if (!accepted.length) return 0;
    let rank = existing.reduce((maximum, candidate) => Math.max(maximum, candidate.rank ?? 0), 0);
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
          fallbackReason: 'Candidate expansion after analysis; transcript-based content',
          contentFingerprint: buildContentFingerprint(candidate, video.targetPlatform ?? null),
          evidence: { [EXPANSION_MARKER]: true } as Prisma.InputJsonValue,
          generationMode: 'DETERMINISTIC_FALLBACK', fallbackUsed: true,
          decisionSource: 'DETERMINISTIC_FALLBACK',
          openingStrength: candidate.openingStrength ?? 0,
          endingStrength: candidate.endingStrength ?? 0
        };
        await tx.clipCandidate.create({ data });
      }
    });
    return accepted.length;
  }
}
