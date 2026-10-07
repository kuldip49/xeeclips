import { UsageService } from '../auth/usage.service';
import { Injectable, Logger } from '@nestjs/common';
import { AiProcessingMode, ClipCandidate, Prisma, ProcessingJob, Video } from '@prisma/client';
import { execFile } from 'child_process';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { EditPlanService, EditPlanResult } from '../editing/edit-plan.service';
import { EditingPlanValidator } from '../editing/editing-plan-validator';
import { evaluateLoop, LoopDecision, VideoEditExecutorService } from '../editing/video-edit-executor.service';
import { SubtitleRendererService } from '../editing/subtitle-renderer.service';
import { AUTOMATIC_RAW, rawEditPlan } from '../editing/raw-edit-plan';
import { ReframeService } from '../editing/reframe.service';
import type { TimedWord } from '../editing/edit-plan';
import { LlmRouterService } from '../processing/llm-router.service';
import { createPerformanceTelemetry, performanceContext } from '../processing/performance-telemetry';
import { parseOutputAspectRatio, parseProcessingType } from '../processing/processing-type';
import { AiProcessingMode as EditAiMode, normalizeAiProcessingMode } from '../processing/ai-processing-mode';
import type { EditPlan } from '../editing/edit-plan';
import { BoundaryDecision, optimizeEditBoundaries } from '../editing/edit-boundaries';
import { buildEditedTimeline, EditedTimeline } from '../editing/edit-timeline';
import { analysisFromStoredChunks, EditAnalysis, requestDenseAnalysis } from '../editing/edit-analysis';
import { EditQualityError } from '../editing/edit-quality-gate';
import { clipVariantKey, FINAL_CLIP_MAX_SECONDS, FINAL_CLIP_MIN_SECONDS, isReusableClipVariant,
  TargetPlatform } from '../processing/clip-selection-policy';
import { packagingTelemetry } from '../processing/platform-packaging';
import { ContentPackagingService, packagingTelemetryOf } from '../editing/content-packaging.service';
import type { OutputAspectRatio, ProcessingType } from '../processing/processing-type';
import { detectSponsorSegment } from '../editing/sponsor-segment';
import { probeMedia } from '../processing/media-probe';

export type ClipExportOptions = {
  processingType: ProcessingType;
  aspectRatio?: OutputAspectRatio;
  targetPlatform?: TargetPlatform | null;
  preparedSourcePath?: string;
  rank?: number;
  generationJobId?: string;
  generationRequestKey?: string;
  /** Last-resort renders (fill tiers): keep a clip whose final pixel QA fails, as DEGRADED. */
  acceptDegradedQuality?: boolean;
  templateId?: string;
  styleVariant?: string;
};

export type ClipExportBatchSource = { sourcePath: string; preparationMs: number;
  dispose: () => Promise<void> };

export type ClipFailureType = 'PERSISTENCE_FAILED' | 'STORAGE_FAILED' | 'CONTRACT_VIOLATION';
export class ClipInfrastructureError extends Error {
  constructor(readonly failureType: ClipFailureType, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ClipInfrastructureError';
  }
}

/** A variant has one canonical storage address across retries and jobs. */
export function renderedClipObjectKey(projectId: string, videoId: string, rangeKey: string,
  variantKey: string) {
  const identity = createHash('sha256').update(JSON.stringify({ videoId, rangeKey, variantKey }))
    .digest('hex').slice(0, 32);
  return `projects/${projectId}/videos/${videoId}/clips/${identity}.mp4`;
}

const execFileAsync = promisify(execFile);
function clipProcessTimeoutMs() {
  const configured = Number(process.env.CLIP_PROCESS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ?
    Math.max(60_000, Math.floor(configured)) : 20 * 60_000;
}
type ClipProbe = { format?: { duration?: string }; streams?: Array<{
  codec_type?: string; codec_name?: string; width?: number; height?: number;
}> };

export function forceLandscapeEditorialFrame(plan: EditPlan, sourceWidth: number,
  sourceHeight: number, targetPlatform: TargetPlatform | null = null): EditPlan {
  if (targetPlatform) plan = { ...plan, platformPreset: targetPlatform };
  if (plan.aspectRatio !== '9:16' || sourceWidth <= sourceHeight) return plan;
  // Never generic black bars: keep a source-aware mode, defaulting to the gradient.
  const backgroundMode = plan.backgroundMode === 'SOFT_BLUR_EXTENSION' ||
    plan.backgroundMode === 'SOURCE_MATCH_SOLID' ? plan.backgroundMode : 'SOURCE_MATCH_GRADIENT';
  return { ...plan, platformPreset: targetPlatform ?? 'INSTAGRAM_REELS',
    videoTemplate: 'EDITORIAL_FRAME', recommendedTemplate: 'EDITORIAL_FRAME',
    backgroundMode,
    onScreenHook: plan.onScreenHook.enabled ? { ...plan.onScreenHook,
      startSec: plan.clipStartSec, endSec: plan.clipEndSec } : plan.onScreenHook };
}

export type NormalClipFormat = 'SOURCE' | 'VERTICAL_9_16';

// Normal clips always use the 1080x1920 canvas. This is format adaptation only, not editing: the
// whole source frame is kept (fit, never cropped) over a blurred copy of itself, so there are no
// black bars and no hook, subtitles, music, grading or zooms.
const VERTICAL_FIT_FILTER = '[0:v:0]split=2[bg][fg];' +
  '[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2[bgb];' +
  '[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs];' +
  '[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]';

export async function exportClipFile(
  sourcePath: string, outputPath: string, startTime: number, endTime: number,
  format: NormalClipFormat = 'SOURCE'
) {
  const duration = endTime - startTime;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 ||
    duration < FINAL_CLIP_MIN_SECONDS || duration > FINAL_CLIP_MAX_SECONDS)
    throw new Error(`Clip range must be between ${FINAL_CLIP_MIN_SECONDS} and ${FINAL_CLIP_MAX_SECONDS} seconds`);
  if (format === 'VERTICAL_9_16') {
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', '-ss', startTime.toFixed(3), '-i', sourcePath, '-t', duration.toFixed(3),
      '-filter_complex', VERTICAL_FIT_FILTER, '-map', '[v]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', outputPath
    ], { maxBuffer: 10 * 1024 * 1024, timeout: clipProcessTimeoutMs(), killSignal: 'SIGKILL' });
    return probeExportedClip(outputPath, duration);
  }
  await execFileAsync('ffmpeg', [
    '-v', 'error', '-y', '-i', sourcePath,
    '-ss', startTime.toFixed(3), '-t', duration.toFixed(3),
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', outputPath
  ], { maxBuffer: 10 * 1024 * 1024, timeout: clipProcessTimeoutMs(), killSignal: 'SIGKILL' });
  return probeExportedClip(outputPath, duration);
}

async function probeExportedClip(outputPath: string, duration: number) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' });
  const probe = JSON.parse(stdout) as ClipProbe;
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const actualDuration = Number(probe.format?.duration);
  const outputStat = await stat(outputPath);
  if (!video || !video.width || !video.height || !video.codec_name || !outputStat.size ||
    !Number.isFinite(actualDuration) || actualDuration <= 0 || Math.abs(actualDuration - duration) > 1.5)
    throw new Error('FFmpeg clip failed ffprobe validation');
  return { duration: actualDuration, width: video.width, height: video.height,
    codec: video.codec_name, sizeBytes: outputStat.size };
}

// Context seconds kept around an EDITED_CLIPS candidate so the edit can
// complete a thought or open on a stronger sentence.
export const EDIT_WINDOW_PADDING_SEC = 4;

/** Clamp candidate and padding against the downloaded file, before any trim encode. */
export function clampEditWindowToSource(candidateStart: number, candidateEnd: number,
  probedDuration: number, paddingSec = EDIT_WINDOW_PADDING_SEC) {
  if (!Number.isFinite(probedDuration) || probedDuration <= 0 ||
    !Number.isFinite(candidateStart) || !Number.isFinite(candidateEnd) ||
    candidateStart < 0 || candidateStart >= probedDuration) {
    throw new Error('Editing source trim is outside the probed media duration');
  }
  // FFmpeg receives millisecond precision. Floor so formatting cannot round
  // the requested final frame beyond the source's probed end.
  const safeEnd = Math.floor(probedDuration * 1000) / 1000;
  const end = Math.min(candidateEnd, safeEnd);
  if (!(end > candidateStart) || end - candidateStart < FINAL_CLIP_MIN_SECONDS)
    throw new Error('Editing source trim is too short after clamping');
  return { candidateEnd: end, windowStart: Math.max(0, candidateStart - paddingSec),
    windowEnd: Math.min(safeEnd, end + paddingSec) };
}

export async function exportSourceWindow(sourcePath: string, outputPath: string,
  startTime: number, endTime: number) {
  const duration = endTime - startTime;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || duration <= 1)
    throw new Error('Invalid editing source window');
  // Input seeking decodes from the prior keyframe, so the window is frame accurate.
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-ss', startTime.toFixed(3), '-i', sourcePath,
    '-t', duration.toFixed(3), '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-avoid_negative_ts', 'make_zero', outputPath],
  { maxBuffer: 10 * 1024 * 1024, timeout: clipProcessTimeoutMs(), killSignal: 'SIGKILL' });
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
    '-of', 'json', outputPath], { maxBuffer: 10 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' });
  const probe = JSON.parse(stdout) as ClipProbe;
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const actual = Number(probe.format?.duration);
  if (!video?.width || !video.height || !Number.isFinite(actual) || Math.abs(actual - duration) > 1)
    throw new Error('Editing source window failed ffprobe validation');
  return { duration: actual, width: video.width, height: video.height };
}

type TimedSegment = { start: number; end: number; text: string; words: unknown; speaker: string | null };
export function timedWords(segments: TimedSegment[], start: number, end: number): TimedWord[] {
  const words = segments.flatMap((segment) => {
    const raw = Array.isArray(segment.words) ? segment.words : [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const word = item as { start?: unknown; end?: unknown; text?: unknown };
      return typeof word.start === 'number' && typeof word.end === 'number' &&
        typeof word.text === 'string' && word.end > start && word.start < end
        ? [{ start: word.start, end: word.end, text: word.text }] : [];
    });
  });
  if (words.length) return words.sort((a, b) => a.start - b.start);
  // Segment-level transcripts: spread tokens evenly (no word timing available).
  return segments.flatMap((segment) => {
    if (segment.end <= start || segment.start >= end) return [];
    const tokens = segment.text.trim().split(/\s+/u).filter(Boolean);
    const span = Math.max(.01, segment.end - segment.start);
    return tokens.map((text, index) => ({
      start: segment.start + span * index / tokens.length,
      end: segment.start + span * (index + 1) / tokens.length, text }));
  });
}

type PreparedEdit = { plan: EditPlan; boundary: BoundaryDecision; timeline: EditedTimeline;
  loop: LoopDecision };

@Injectable()
export class ClipExportService {
  private async publish<T>(jobId: string | undefined, write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (!jobId) return write(this.prisma);
    return this.prisma.$transaction(async tx => {
      const output = await write(tx);
      const job = await tx.processingJob.findUnique({ where: { id: jobId } });
      if (job?.creditReservationKey) await new UsageService(this.prisma).settleInTransaction(tx, job.creditReservationKey, true);
      return output;
    });
  }
  private readonly logger = new Logger(ClipExportService.name);
  // Recently used music track ids per source video, so a source doesn't hear
  // the same bed on every clip. Process-local and small: a soft variety signal,
  // not a durability guarantee.
  private readonly recentMusicTracks = new Map<string, string[]>();
  // Headlines and mechanisms already delivered for this source video, so a batch
  // of clips does not open five times on the same construction. Per-process and
  // advisory only: the scorer applies a penalty, never a hard ban on quality.
  private readonly recentHooks = new Map<string, { texts: string[]; mechanisms: string[] }>();
  // Candidate renders finish concurrently. Serialize only the compact job-level
  // telemetry merge so one candidate cannot overwrite another candidate's totals.
  private readonly telemetryWrites = new Map<string, Promise<void>>();

  private noteHook(videoId: string, text: string, mechanism: string) {
    if (!text) return;
    const recent = this.recentHooks.get(videoId) ?? { texts: [], mechanisms: [] };
    this.recentHooks.set(videoId, {
      texts: [...recent.texts.filter((item) => item !== text), text].slice(-8),
      mechanisms: [...recent.mechanisms, mechanism].filter(Boolean).slice(-8) });
  }
  private noteMusicTrack(videoId: string, trackId: string | null) {
    if (!trackId) return;
    const recent = this.recentMusicTracks.get(videoId) ?? [];
    this.recentMusicTracks.set(videoId, [...recent.filter((id) => id !== trackId), trackId].slice(-3));
  }
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService,
    private readonly editPlans: EditPlanService =
      new EditPlanService(new LlmRouterService(), new EditingPlanValidator()),
    private readonly executor: VideoEditExecutorService =
      new VideoEditExecutorService(new SubtitleRendererService(), new ReframeService()),
    private readonly contentPackager: ContentPackagingService =
      new ContentPackagingService(new LlmRouterService())) {}

  /** One source download per selection request. Candidate windows remain isolated
   * in their own temp directories, while all workers read this immutable file. */
  async prepareBatchSource(video: Video): Promise<ClipExportBatchSource> {
    const started = Date.now();
    const directory = await mkdtemp(join(tmpdir(), 'ai-content-clip-batch-'));
    const sourcePath = join(directory, basename(video.objectKey) || 'source-video');
    try {
      await this.storage.downloadToFile(video.bucket, video.objectKey, sourcePath);
      return { sourcePath, preparationMs: Date.now() - started,
        dispose: () => rm(directory, { recursive: true, force: true }) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async export(video: Video, candidate: ClipCandidate, options?: ClipExportOptions) {
    const exportStarted = Date.now();
    let cachedJob: ProcessingJob | null | undefined;
    const latestJob = async () => cachedJob !== undefined ? cachedJob : (cachedJob = await this.prisma.processingJob
      .findFirst({ where: { videoId: video.id }, orderBy: { createdAt: 'desc' } }));
    const processingType = options?.processingType ??
      parseProcessingType((await latestJob())?.processingType);
    const targetPlatform = options ? options.targetPlatform ?? null
      : ((video as Video & { targetPlatform?: TargetPlatform | null }).targetPlatform ?? null);
    const variantKey = clipVariantKey(processingType, targetPlatform, options?.templateId,
      options?.generationRequestKey);
    const variantWhere = { videoId_rangeKey_variantKey: { videoId: video.id,
      rangeKey: candidate.rangeKey, variantKey } };
    const objectKey = renderedClipObjectKey(video.projectId, video.id, candidate.rangeKey,
      variantKey);
    if (!Number.isFinite(candidate.startTime) || !Number.isFinite(candidate.endTime) ||
      candidate.startTime < 0 || candidate.endTime <= candidate.startTime ||
      (video.duration != null && candidate.endTime > video.duration + 0.5))
      throw new Error('Invalid source range for clip export');
    const keyOwner = await this.prisma.generatedClip.findUnique({ where: { objectKey } });
    if (keyOwner && (keyOwner.videoId !== video.id || keyOwner.rangeKey !== candidate.rangeKey ||
      keyOwner.variantKey !== variantKey))
      throw new ClipInfrastructureError('PERSISTENCE_FAILED',
        `Rendered clip key is owned by a different variant: ${objectKey}`);
    // Each output variant is stored separately: Normal never replaces AI Edited or vice versa.
    const existing = await this.prisma.generatedClip.findUnique({ where: variantWhere });
    if (existing && isReusableClipVariant(existing)) {
      if (options?.templateId && existing.templateId && existing.templateId !== options.templateId)
        throw new ClipInfrastructureError('CONTRACT_VIOLATION',
          `Stored clip template ${existing.templateId} differs from ${options.templateId}`);
      const reused = options?.generationJobId ? await this.publish(options.generationJobId, tx => tx.generatedClip.update({
        where: { id: existing.id }, data: {
          generationJobId: options.generationJobId,
          templateId: options.templateId ?? null,
          requestedTemplate: options.templateId ?? null,
          effectiveTemplate: options.templateId ?? null,
          styleVariant: options.styleVariant ?? options.templateId ?? null,
          requestedClipIndex: options.rank ?? null
        } })) : existing;
      this.logger.log(JSON.stringify({ event: 'clip_export_performance', videoId: video.id,
        rangeKey: candidate.rangeKey, variantKey, exportMs: Date.now() - exportStarted, cacheHits: 1 }));
      return reused;
    }
    if (existing) {
      // Same variant rendered in an outdated format (source-aspect Normal): re-render it.
      await this.prisma.generatedClip.delete({ where: { id: existing.id } });
      await this.storage.removeObject(existing.bucket, existing.objectKey).catch((error: unknown) =>
        this.logger.warn(`Could not remove outdated clip ${existing.objectKey}: ${
          error instanceof Error ? error.message : String(error)}`));
      if (existing.thumbnailObjectKey)
        await this.storage.removeObject(existing.bucket, existing.thumbnailObjectKey).catch(() => undefined);
    }
    const directory = await mkdtemp(join(tmpdir(), 'ai-content-clip-'));
    try {
      const sourcePreparationStarted = Date.now();
      const sourcePath = options?.preparedSourcePath ??
        join(directory, basename(video.objectKey) || 'source-video');
      const baselinePath = join(directory, 'selected-clip.mp4');
      if (!options?.preparedSourcePath)
        await this.storage.downloadToFile(video.bucket, video.objectKey, sourcePath);
      const sourcePreparationMs = options?.preparedSourcePath ? 0 : Date.now() - sourcePreparationStarted;
      const job = await latestJob();
      const aspectRatio = options?.aspectRatio ?? parseOutputAspectRatio(job?.outputAspectRatio);
      let outputPath = baselinePath;
      let metadata: { duration: number; width: number; height: number; codec: string;
        sizeBytes: number } = { duration: 0, width: 0, height: 0, codec: '', sizeBytes: 0 };
      let editPlan: Prisma.InputJsonValue | undefined;
      let editTelemetry: Prisma.InputJsonValue | undefined;
      let contentPackaging: Prisma.InputJsonValue | undefined;
      let thumbnailPath: string | null = null;
      let clipStart = candidate.startTime;
      let clipEnd = candidate.endTime;
      if (processingType !== 'EDITED_CLIPS') {
        metadata = await exportClipFile(sourcePath, baselinePath, candidate.startTime, candidate.endTime,
          'VERTICAL_9_16');
      } else {
        const edited = await this.renderEdited(video, candidate, job, sourcePath, directory, aspectRatio,
          targetPlatform, options?.rank, options?.templateId, options?.acceptDegradedQuality === true);
        outputPath = edited.outputPath;
        metadata = edited.metadata;
        editPlan = edited.editPlan;
        editTelemetry = edited.editTelemetry;
        contentPackaging = edited.contentPackaging;
        clipStart = edited.clipStart;
        clipEnd = edited.clipEnd;
        thumbnailPath = edited.thumbnailPath;
      }
      const storageStarted = Date.now();
      let stored: { bucket: string; objectKey: string };
      try {
        stored = await this.storage.uploadFile({ filePath: outputPath, objectKey, mimeType: 'video/mp4' });
      } catch (error) {
        throw new ClipInfrastructureError('STORAGE_FAILED', 'Clip upload failed', error);
      }
      // The designed cover ships with the clip; a cover failure never fails the export.
      let thumbnail: { objectKey: string; width: number; height: number } | null = null;
      if (thumbnailPath) {
        try {
          const coverKey = `${objectKey.replace(/\.mp4$/u, '')}-cover.jpg`;
          const uploaded = await this.storage.uploadFile({ filePath: thumbnailPath,
            objectKey: coverKey, mimeType: 'image/jpeg' });
          thumbnail = { objectKey: uploaded.objectKey, width: metadata.width, height: metadata.height };
        } catch (error) {
          this.logger.warn(`Clip thumbnail upload failed: ${
            error instanceof Error ? error.message : String(error)}`);
        }
      }
      const storageMs = Date.now() - storageStarted;
      if (editTelemetry && typeof editTelemetry === 'object' && !Array.isArray(editTelemetry))
        Object.assign(editTelemetry, { sourcePreparationMs,
          sourceCacheHit: Boolean(options?.preparedSourcePath), storageMs,
          totalCandidateMs: Date.now() - exportStarted });
      let clip;
      try { clip = await this.publish(options?.generationJobId, tx => tx.generatedClip.upsert({
        where: variantWhere,
        create: {
          videoId: video.id, candidateId: candidate.id, rangeKey: candidate.rangeKey,
          startTime: clipStart, endTime: clipEnd,
          duration: metadata.duration, bucket: stored.bucket, objectKey: stored.objectKey,
          mimeType: 'video/mp4', sizeBytes: BigInt(metadata.sizeBytes),
          width: metadata.width, height: metadata.height, codec: metadata.codec,
          processingType, targetPlatform, variantKey,
          generationJobId: options?.generationJobId ?? null,
          templateId: options?.templateId ?? null,
          requestedTemplate: options?.templateId ?? null,
          effectiveTemplate: options?.templateId ?? null,
          styleVariant: options?.styleVariant ?? options?.templateId ?? null,
          requestedClipIndex: options?.rank ?? null,
          aspectRatio: processingType === 'EDITED_CLIPS' ? aspectRatio : '9:16',
          ...(thumbnail ? { thumbnailObjectKey: thumbnail.objectKey, thumbnailMimeType: 'image/jpeg',
            thumbnailWidth: thumbnail.width, thumbnailHeight: thumbnail.height } : {}),
          ...(editPlan ? { editPlan } : {}), ...(editTelemetry ? { editTelemetry } : {}),
          ...(contentPackaging ? { contentPackaging } : {})
        }, update: {}
      })); } catch (error) {
        // A concurrent retry may have committed the identical variant. Reuse only
        // after checking its canonical identity; never hide a different owner.
        const winner = await this.prisma.generatedClip.findUnique({ where: variantWhere });
        if (winner?.objectKey === objectKey && winner.templateId === (options?.templateId ?? null))
          clip = winner;
        else throw new ClipInfrastructureError('PERSISTENCE_FAILED',
          `GeneratedClip persistence failed for ${variantKey}`, error);
      }
      if (job && editTelemetry && typeof editTelemetry === 'object' &&
        !Array.isArray(editTelemetry)) {
        const previousWrite = this.telemetryWrites.get(job.id) ?? Promise.resolve();
        let releaseWrite!: () => void;
        const writeComplete = new Promise<void>((resolve) => { releaseWrite = resolve; });
        const writeTail = previousWrite.catch(() => undefined).then(() => writeComplete);
        this.telemetryWrites.set(job.id, writeTail);
        await previousWrite.catch(() => undefined);
        try {
        const freshJob = await this.prisma.processingJob.findFirst({ where: { id: job.id } });
        const previous = freshJob?.telemetry && typeof freshJob.telemetry === 'object' &&
          !Array.isArray(freshJob.telemetry) ? freshJob.telemetry as Record<string, unknown> : {};
        const aggregated = { ...previous, ...editTelemetry } as Record<string, unknown>;
        for (const key of ['editOperationCount', 'weakLeadInRemovedMs', 'trimCount',
          'silenceRemovedMs', 'pauseRemovalCount', 'retentionEditCount', 'zoomCount',
          'zoomInCount', 'zoomOutCount', 'reframeCount', 'onScreenTextCount', 'renderMs',
          'editingPlanLlmCalls', 'subtitlePhraseCount', 'highlightedWordCount',
          'hookWordCount', 'overlayCollisionRepairs', 'faceAvoidanceAdjustments',
          'speakerSwitchCount', 'reframeAdjustmentCount', 'cropMovementDistance',
          'editRenderAttempts', 'shotChangeReframeCount', 'sourcePreparationMs', 'storageMs',
           'planMs', 'preRenderValidationMs', 'baseRenderMs', 'overlayRenderMs',
           'qualityCheckMs', 'repairMs', 'fullRenderAttempts', 'overlayOnlyRepairCount',
           'gradingRepairAttempts', 'gradingRepairRenderMs', 'preRenderRejectedCount',
           'preRenderRepairCount', 'skippedBeforeRenderCount', 'wastedRenderMs',
            'cameraRepairAttemptCount', 'cameraRepairSuccessCount',
            'qaToolFailureCount',
            'qaNormalFrameCount', 'qaHardCutFrameCount',
           'nominalRequiredZoomCount', 'eligibleSafeZoomCount',
           'effectiveRequiredZoomCount', 'actualZoomCount',
           'packagingMs', 'entityCount', 'resolvedPersonCount', 'namedSpeakerCount',
           'identityFallbackCount', 'hookCandidateCount', 'hashtagCount',
           'oneLinePhraseCount', 'twoLinePhraseCount', 'activeWordHighlightCount',
           'subtitleCollisionRepairs']) {
          aggregated[key] = (Number(previous[key]) || 0) +
            (Number((editTelemetry as Record<string, unknown>)[key]) || 0);
        }
        aggregated.editedClipCount = (Number(previous.editedClipCount) || 0) + 1;
        const status = String((editTelemetry as Record<string, unknown>).editQualityStatus ?? '');
        if (status) aggregated[`editQuality${status[0]}${status.slice(1).toLowerCase()}Count`] =
          (Number(previous[`editQuality${status[0]}${status.slice(1).toLowerCase()}Count`]) || 0) + 1;
        const previousZoomCount = Number(previous.zoomCount) || 0;
        const clipZoomCount = Number((editTelemetry as Record<string, unknown>).zoomCount) || 0;
        const weightedZoom = (Number(previous.averageZoomScale) || 0) * previousZoomCount +
          (Number((editTelemetry as Record<string, unknown>).averageZoomScale) || 0) * clipZoomCount;
        aggregated.averageZoomScale = previousZoomCount + clipZoomCount
          ? weightedZoom / (previousZoomCount + clipZoomCount) : 0;
        aggregated.timelineRemapApplied = Boolean(previous.timelineRemapApplied ||
          (editTelemetry as Record<string, unknown>).timelineRemapApplied);
        const editCalls = Number((editTelemetry as Record<string, unknown>).editingPlanLlmCalls) || 0;
        aggregated.totalLlmCalls = (Number(previous.totalLlmCalls) || 0) + editCalls;
        aggregated.cloudLlmCalls = (Number(previous.cloudLlmCalls) || 0) + editCalls;
        aggregated.totalCloudLlmCalls = (Number(previous.totalCloudLlmCalls) || 0) + editCalls;
        const previousRoles = previous.llmRequestCountByRole &&
          typeof previous.llmRequestCountByRole === 'object' &&
          !Array.isArray(previous.llmRequestCountByRole)
          ? previous.llmRequestCountByRole as Record<string, number> : {};
        aggregated.llmRequestCountByRole = { ...previousRoles,
          editingPlan: (previousRoles.editingPlan || 0) + editCalls };
        if (editCalls) {
          const providers = previous.llmRequestCountByProvider &&
            typeof previous.llmRequestCountByProvider === 'object' &&
            !Array.isArray(previous.llmRequestCountByProvider)
            ? previous.llmRequestCountByProvider as Record<string, number> : {};
          aggregated.llmRequestCountByProvider = { ...providers,
            openai: (providers.openai || 0) + editCalls };
        }
        // Per-clip detail stays on GeneratedClip; keep the job aggregate compact.
        for (const key of ['timelineSegments', 'timelineCuts', 'shots', 'speakerSegments',
           'rawCropCenters', 'stabilizedCropCenters', 'subtitlePositions', 'zoomEvents',
           'zoomMeasurements', 'editQualityChecks', 'editRepairs', 'lunaAttemptQualityReport',
           'gradingRepairs'])
          delete aggregated[key];
        await this.prisma.processingJob.update({ where: { id: job.id },
          data: { telemetry: aggregated as Prisma.InputJsonValue } });
        } finally {
          releaseWrite();
          if (this.telemetryWrites.get(job.id) === writeTail) this.telemetryWrites.delete(job.id);
        }
      }
      return clip;
    } finally {
      this.logger.log(JSON.stringify({ event: 'clip_export_performance', videoId: video.id,
        rangeKey: candidate.rangeKey, exportMs: Date.now() - exportStarted, cacheHits: 0 }));
      await rm(directory, { recursive: true, force: true });
    }
  }

  // EDITED_CLIPS: the candidate is source material. The edit gets its own
  // timeline inside a padded source window and must pass the quality gate.
  private async renderEdited(video: Video, candidate: ClipCandidate,
    job: { aiMode: AiProcessingMode | null } | null, sourcePath: string, directory: string,
    aspectRatio: ReturnType<typeof parseOutputAspectRatio>, targetPlatform: TargetPlatform | null,
    rank?: number, templateId?: string, acceptDegradedQuality = false) {
    const processingType = 'EDITED_CLIPS' as const;
    const candidateStarted = Date.now();
    const sourceProbe = await probeMedia(sourcePath);
    const sourceWindow = clampEditWindowToSource(candidate.startTime, candidate.endTime,
      sourceProbe.videoDurationSec ?? sourceProbe.durationSec ?? Number.NaN);
    if (sourceWindow.candidateEnd < candidate.endTime - 1e-6) {
      this.logger.warn(JSON.stringify({ event: 'clip_source_trim_clamped', videoId: video.id,
        candidateId: candidate.id, previousEnd: candidate.endTime,
        correctedEnd: sourceWindow.candidateEnd,
        probedDurationSec: sourceProbe.videoDurationSec ?? sourceProbe.durationSec }));
      candidate = { ...candidate, endTime: sourceWindow.candidateEnd };
    }
    this.logger.log(JSON.stringify({ event: 'clip_candidate_stage', videoId: video.id,
      candidateId: candidate.id, stage: 'PLANNING' }));
    const windowStart = sourceWindow.windowStart;
    const windowEnd = sourceWindow.windowEnd;
    const windowPath = join(directory, 'edit-window.mp4');
    const context = await this.prisma.video.findUniqueOrThrow({ where: { id: video.id },
      select: { transcript: { include: { segments: { orderBy: { position: 'asc' } } } },
        understanding: { select: { summary: true, mainTopic: true, contentType: true } },
        project: { select: { name: true, description: true } },
        chunks: { where: { startTime: { lt: windowEnd }, endTime: { gt: windowStart } },
          select: { startTime: true, endTime: true, visualAnalysis: true } } } });
    const segments = (context.transcript?.segments ?? []) as TimedSegment[];
    const words = timedWords(segments, candidate.startTime, candidate.endTime);
    const windowWords = timedWords(segments, windowStart, windowEnd)
      .filter((word) => word.start >= windowStart && word.end <= windowEnd);
    // Transcript-only rejection precedes even the intermediate FFmpeg encode.
    const boundaryPrecheck = optimizeEditBoundaries({ words: windowWords,
      candidateStart: candidate.startTime, candidateEnd: candidate.endTime, windowStart, windowEnd,
      planCuts: [], hints: { loopSuitable: false } });
    if (!boundaryPrecheck.clipStartNatural && !boundaryPrecheck.clipStartContextComplete) {
      const report = { preRenderClassification: 'SKIP_BEFORE_RENDER', candidateSkippedBeforeRender: true,
        candidateId: candidate.id, rank, preRenderRejectReason: 'UNREPAIRABLE_START_CONTEXT',
        preRenderRejectReasons: ['UNREPAIRABLE_START_CONTEXT'],
        timeSpentBeforeRejectMs: Date.now() - candidateStarted, llmCallsBeforeReject: 0,
        analysisMsBeforeReject: 0, preRenderRejectedCount: 1, skippedBeforeRenderCount: 1,
        preRenderRepairCount: boundaryPrecheck.openingRepairAttempted ? 1 : 0,
        fullRenderAttempts: 0, gradingRepairAttempts: 0, gradingRepairRenderMs: 0,
        wastedRenderMs: 0, boundary: boundaryPrecheck };
      this.logger.warn(JSON.stringify({ event: 'candidatePreRenderRejected', ...report }));
      throw new EditQualityError('Edited clip rejected before source-window render: unusable start context', report);
    }
    const window = await exportSourceWindow(sourcePath, windowPath, windowStart, windowEnd);
    const candidateChunks = context.chunks.filter((chunk) =>
      chunk.startTime < candidate.endTime && chunk.endTime > candidate.startTime);
    let lastSpeaker: string | null = null;
    const speakerChangeTimes: number[] = [];
    for (const segment of segments) {
      if (!segment.speaker) continue;
      if (lastSpeaker && lastSpeaker !== segment.speaker &&
        segment.start >= windowStart && segment.start <= windowEnd)
        speakerChangeTimes.push(segment.start);
      lastSpeaker = segment.speaker;
    }
    const analysisStarted = Date.now();
    const dense = await requestDenseAnalysis(this.storage, windowPath, windowStart, windowEnd, this.logger);
    const analysis: EditAnalysis = dense ?? { ...analysisFromStoredChunks(
      context.chunks as Parameters<typeof analysisFromStoredChunks>[0], windowStart, windowEnd),
    fallbackReason: 'DENSE_ANALYSIS_UNAVAILABLE' };
    const sponsor = detectSponsorSegment({ words: windowWords,
      candidateStart: candidate.startTime, candidateEnd: candidate.endTime,
      ocrText: analysis.ocrText,
      shotBoundaries: analysis.shotBoundaries });
    const analysisMs = Date.now() - analysisStarted;
    if (sponsor.rejected) throw new EditQualityError('Edited clip rejected: internal sponsor segment',
      { preRenderClassification: 'SKIP_BEFORE_RENDER', candidateSkippedBeforeRender: true,
        candidateId: candidate.id, rank, preRenderRejectReason: 'IMPOSSIBLE_SPONSOR_INTERRUPTION',
        preRenderRejectReasons: ['IMPOSSIBLE_SPONSOR_INTERRUPTION'],
        timeSpentBeforeRejectMs: Date.now() - candidateStarted, llmCallsBeforeReject: 0,
        analysisMsBeforeReject: analysisMs, preRenderRejectedCount: 1, skippedBeforeRenderCount: 1,
        preRenderRepairCount: 0, fullRenderAttempts: 0, gradingRepairAttempts: 0,
        gradingRepairRenderMs: 0, wastedRenderMs: 0,
        sponsorSegmentDetected: true, sponsorSegmentTrimmed: false, sponsor });
    const preflightTimeline = buildEditedTimeline({ candidateStart: candidate.startTime,
      candidateEnd: candidate.endTime, rawStart: candidate.startTime, rawEnd: candidate.endTime,
      editedStart: boundaryPrecheck.editedStart, editedEnd: boundaryPrecheck.editedEnd,
      cuts: boundaryPrecheck.cuts });
    const structuralPreflight = this.executor.preflightStructure({ analysis,
      timeline: preflightTimeline, sourceWidth: window.width, sourceHeight: window.height,
      speakerChangeTimes, platformPreset: targetPlatform ?? 'UNIVERSAL' });
    if (structuralPreflight.classification === 'SKIP_BEFORE_RENDER') {
      const reasons = structuralPreflight.failures.map((failure) => failure.reason);
      throw new EditQualityError('Edited clip rejected before planning: impossible camera geometry', {
        preRenderClassification: 'SKIP_BEFORE_RENDER', candidateSkippedBeforeRender: true,
        candidateId: candidate.id, rank, preRenderRejectReason: reasons.join('|'),
        preRenderRejectReasons: reasons, timeSpentBeforeRejectMs: Date.now() - candidateStarted,
        llmCallsBeforeReject: 0, analysisMsBeforeReject: analysisMs,
        preRenderRejectedCount: 1, skippedBeforeRenderCount: 1,
        preRenderRepairCount: 0, fullRenderAttempts: 0, wastedRenderMs: 0,
        structuralPreflight });
    }
    const aiMode = normalizeAiProcessingMode(job?.aiMode ?? AiProcessingMode.FALLBACK_ONLY);
    const editMetrics = createPerformanceTelemetry(aiMode, processingType, aspectRatio);
    const hookMemory = this.recentHooks.get(video.id) ?? { texts: [], mechanisms: [] };
    const packagingStarted = Date.now();
    const storedHooks = Array.isArray(candidate.hooks) ? candidate.hooks.flatMap((item) =>
      item && typeof item === 'object' && !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).text === 'string' ?
        [(item as Record<string, unknown>).text as string] : []) : [];
    const speakerTrackIds = [...new Set(segments.map((segment) => segment.speaker)
      .filter((speaker): speaker is string => Boolean(speaker)))];
    let contentPackaging = await performanceContext.run(editMetrics, () => this.contentPackager.create({
      aiMode, transcript: candidate.transcriptText,
      title: candidate.title || candidate.titleCandidate || video.originalName,
      synopsis: candidate.synopsis, wholeVideoSummary: context.understanding?.summary ?? '',
      originalName: video.originalName,
      sourceDescription: context.project.description ?? '', channelName: context.project.name,
      ocrText: analysis.ocrText, speakerTrackIds,
      existingHooks: [candidate.bestHook, candidate.hookCandidate,
        ...(candidate.alternateHooks ?? []), ...storedHooks].filter(Boolean),
      existingCaption: candidate.caption || candidate.captionCandidate,
      existingHashtags: candidate.hashtags ?? [], targetPlatform }));
    const packagingMs = Date.now() - packagingStarted;
    const baseContext = { start: candidate.startTime, end: candidate.endTime, aspectRatio, targetPlatform,
      transcript: candidate.transcriptText, words,
      title: candidate.title || candidate.titleCandidate || video.originalName,
      synopsis: candidate.synopsis, windowStart, windowEnd, windowWords,
      usedHookTexts: hookMemory.texts, usedHookMechanisms: hookMemory.mechanisms,
      packaging: contentPackaging };
    const planStarted = Date.now();
    const result = await performanceContext.run(editMetrics, () => this.editPlans.create({
      ...baseContext, aiMode, wholeVideoSummary: context.understanding?.summary ?? '',
      clipUnderstanding: candidate.clipUnderstanding,
      visualEvidence: { candidate: candidate.evidence,
        chunks: candidateChunks.map((chunk) => ({ startTime: chunk.startTime,
          endTime: chunk.endTime, visualAnalysis: chunk.visualAnalysis })),
        editAnalysis: { source: analysis.source, shotBoundaries: analysis.shotBoundaries,
          ocrText: analysis.ocrText.slice(0, 1500),
          textCoverage: analysis.frames.length ? Number((analysis.frames.reduce((sum, frame) =>
            sum + frame.textCoverage, 0) / analysis.frames.length).toFixed(3)) : 0,
          maxFaces: Math.max(0, ...analysis.frames.map((frame) => frame.faces.length)) } }
    }));
    let planMs = Date.now() - planStarted;
    // Headline realignment state, filled in by prepare() below.
    let hookRealigned = false;
    let hookFinalText = result.hookFinalText;
    let hookRealignedMechanism = result.hookMechanism;
    const prepare = async (source: EditPlan, fromLuna: boolean,
      hookPool: EditPlanResult['hookCandidates']): Promise<PreparedEdit> => {
      const framed = forceLandscapeEditorialFrame(source, window.width, window.height, targetPlatform);
      const plan = templateId === AUTOMATIC_RAW ? rawEditPlan(framed) : framed;
      const planCuts = plan.operations.filter((operation) =>
        operation.type === 'TRIM' || operation.type === 'REMOVE_SILENCE')
        .map((operation) => ({ start: operation.startSec, end: operation.endSec }));
      const decide = (loopSuitable: boolean) => optimizeEditBoundaries({ words: windowWords,
        candidateStart: candidate.startTime, candidateEnd: candidate.endTime, windowStart, windowEnd,
        planCuts, hints: fromLuna ? { hookStartSec: plan.openingStrategy.hookStartSec,
          payoffEndSec: plan.endingStrategy?.payoffEndSec,
          contextRequiredFromSec: plan.openingStrategy.contextRequiredFromSec,
          newTopicBeginsAfterSec: plan.endingStrategy?.newTopicBeginsAfterSec,
          loopSuitable } : { loopSuitable: false } });
      const toTimeline = (decision: BoundaryDecision) => buildEditedTimeline({
        candidateStart: candidate.startTime, candidateEnd: candidate.endTime,
        rawStart: candidate.startTime, rawEnd: candidate.endTime,
        editedStart: decision.editedStart, editedEnd: decision.editedEnd, cuts: decision.cuts });
      const applySponsorTrim = (decision: BoundaryDecision): BoundaryDecision => !sponsor.trimmed ? decision : ({ ...decision,
        editedStart: sponsor.trimStartTo ?? decision.editedStart,
        editedEnd: sponsor.trimEndTo ?? decision.editedEnd,
        optimizedStartSec: sponsor.trimStartTo ?? decision.optimizedStartSec,
        optimizedEndSec: sponsor.trimEndTo ?? decision.optimizedEndSec,
        openingReason: sponsor.trimStartTo != null ? 'SPONSOR_SEGMENT_TRIMMED' : decision.openingReason,
        endingReason: sponsor.trimEndTo != null ? 'SPONSOR_SEGMENT_TRIMMED' : decision.endingReason });
      let boundary = applySponsorTrim(decide(false));
      let timeline = toTimeline(boundary);
      const loop = await evaluateLoop(windowPath, windowStart, timeline, plan, boundary);
      if (loop.loopApplied) {
        boundary = applySponsorTrim(decide(true));
        timeline = toTimeline(boundary);
      }
      const invalidTimeline = !Number.isFinite(timeline.editedStart) || !Number.isFinite(timeline.editedEnd) ||
        timeline.editedEnd <= timeline.editedStart || timeline.editedDuration <= 0 || !timeline.segments.length;
      const badStart = !boundary.clipStartNatural && !boundary.clipStartContextComplete;
      if (invalidTimeline || badStart) {
        const preRenderRejectReason = invalidTimeline ? 'BROKEN_TIMELINE_OR_INVALID_RANGE' :
          'UNREPAIRABLE_START_CONTEXT';
        const report = { preRenderClassification: 'SKIP_BEFORE_RENDER', candidateSkippedBeforeRender: true,
          candidateId: candidate.id, rank, preRenderRejectReason,
          timeSpentBeforeRejectMs: Date.now() - candidateStarted,
          llmCallsBeforeReject: editMetrics.llmRequestCountByRole.editingPlan ?? 0,
          analysisMsBeforeReject: analysisMs, planMs, preRenderRejectedCount: 1,
          skippedBeforeRenderCount: 1, preRenderRepairCount: boundary.openingRepairAttempted ? 1 : 0,
          fullRenderAttempts: 0, gradingRepairAttempts: 0, gradingRepairRenderMs: 0,
          wastedRenderMs: 0, boundary };
        this.logger.warn(JSON.stringify({ event: 'candidatePreRenderRejected', ...report }));
        throw new EditQualityError(`Edited clip rejected before render: ${preRenderRejectReason}`, report);
      }
      // §35/§36: the content package must describe the clip that actually ships.
      // Boundary optimisation can add or drop the lines a headline was grounded
      // in, so the already-generated candidate pool is re-scored against the
      // final spoken words. No extra model call: when the boundaries did not
      // move, the deterministic scorer returns the same headline.
      const spoken = windowWords.filter((word) =>
        word.start >= timeline.editedStart - .001 && word.end <= timeline.editedEnd + .001 &&
        !boundary.cuts.some((cut) => word.start < cut.end && cut.start < word.end));
      const finalTranscript = spoken.map((word) => word.text).join(' ').trim();
      let hooked = plan;
      if (plan.onScreenHook.enabled && finalTranscript &&
        finalTranscript !== candidate.transcriptText.trim()) {
        const realigned = this.editPlans.realignHook(plan,
          { ...baseContext, aiMode, wholeVideoSummary: '', clipUnderstanding: null,
            visualEvidence: {}, start: timeline.editedStart, end: timeline.editedEnd,
            transcript: finalTranscript, words: spoken },
          hookPool.map((item) => ({ text: item.text,
            source: fromLuna ? 'LUNA_CANDIDATE' as const : 'DETERMINISTIC' as const })));
        hookRealigned = realigned.hookFinalText !== plan.onScreenHook.text;
        hookFinalText = realigned.hookFinalText;
        hookRealignedMechanism = realigned.hookMechanism;
        hooked = realigned.plan;
      }
      return { plan: { ...hooked, clipStartSec: timeline.editedStart, clipEndSec: timeline.editedEnd,
        onScreenHook: hooked.onScreenHook.enabled ? { ...hooked.onScreenHook,
          startSec: timeline.editedStart, endSec: timeline.editedEnd } : hooked.onScreenHook },
      boundary, timeline, loop };
    };
    const outputPath = join(directory, 'edited-clip.mp4');
    // Automatic 2 never ships this render: it is the card's temporary preview and the
    // source of the editable plan, and the canonical Automatic 2 export (with its own QA
    // and repair pass) replaces it. So it is encoded cheaply and Automatic 1's pixel QA
    // (hook, subtitle, background, camera-transition checks of a layout Automatic 2
    // discards) neither runs nor rejects the candidate. Automatic 1 is unchanged.
    const temporaryPreview = templateId === 'AUTOMATIC_2';
    const render = (input: PreparedEdit) => this.executor.execute(windowPath, outputPath,
      input.plan, windowWords, [], [], speakerChangeTimes, { inputOffsetSec: windowStart,
        timeline: input.timeline, analysis, boundary: input.boundary, loop: input.loop,
        seed: candidate.rangeKey, candidateId: candidate.id, rank,
        avoidMusicTrackIds: this.recentMusicTracks.get(video.id) ?? [],
        ...(temporaryPreview ? { qa: false, previewEncode: true } : {}),
        // Raw: Automatic 1's framing in the middle of the canvas on a plain dark surround.
        ...(templateId === AUTOMATIC_RAW ? { sfxDisabled: true, gradeDisabled: true,
          backgroundMode: 'DARK_NEUTRAL' as const } : {}),
        ...(acceptDegradedQuality ? { acceptDegradedQuality: true } : {}) });
    let planResult = result;
    let prepared = await prepare(result.plan, result.source === 'LUNA', result.hookCandidates);
    let source = result.source;
    let fallbackReason = result.fallbackReason || analysis.fallbackReason;
    let lunaAttemptQualityReport: unknown = null;
    let rendered;
    this.logger.log(JSON.stringify({ event: 'clip_candidate_stage', videoId: video.id,
      candidateId: candidate.id, stage: 'PRE_RENDER_VALIDATION' }));
    try {
      rendered = await render(prepared);
    } catch (error) {
      if (error instanceof EditQualityError) {
        const prior = error.report && typeof error.report === 'object' && !Array.isArray(error.report) ?
          error.report as Record<string, unknown> : {};
        throw new EditQualityError(error.message, { ...prior, candidateId: candidate.id,
          planMs, analysisMsBeforeReject: analysisMs,
          timeSpentBeforeRejectMs: Date.now() - candidateStarted,
          llmCallsBeforeReject: editMetrics.llmRequestCountByRole.editingPlan ?? 0 });
      }
      if (source === 'DETERMINISTIC_FALLBACK') throw error;
      // Retry once with the deterministic editor (no further LLM call).
      lunaAttemptQualityReport = error instanceof EditQualityError ? error.report : null;
      const fallbackPlanStarted = Date.now();
      planResult = await this.editPlans.create({ ...baseContext,
        aiMode: EditAiMode.FALLBACK_ONLY, wholeVideoSummary: '', clipUnderstanding: null,
        visualEvidence: {} });
      planMs += Date.now() - fallbackPlanStarted;
      hookRealigned = false;
      hookFinalText = planResult.hookFinalText;
      hookRealignedMechanism = planResult.hookMechanism;
      prepared = await prepare(planResult.plan, false, planResult.hookCandidates);
      source = 'DETERMINISTIC_FALLBACK';
      fallbackReason = (error instanceof EditQualityError ? 'LUNA_EDIT_QUALITY_FAILED: ' :
        'LUNA_EDIT_RENDER_FAILED: ') + (error instanceof Error ? error.message.slice(0, 160) : String(error));
      rendered = await render(prepared);
    }
    this.logger.log(JSON.stringify({ event: 'clip_candidate_stage', videoId: video.id,
      candidateId: candidate.id, stage: 'QUALITY_CHECK', status: rendered.quality.status }));
    const { plan, timeline, boundary, loop } = prepared;
    const visual = rendered.visual;
    this.noteMusicTrack(video.id, visual.music.trackId);
    this.noteHook(video.id, hookFinalText, hookRealignedMechanism);
    const quality = rendered.quality;
    const measured = quality.measurements;
    const zoomCount = visual.zoomCount;
    const trims = plan.operations.filter((operation) => operation.type === 'TRIM');
    const subtitleTelemetry = {
      subtitleTemplate: visual.subtitleTemplate,
      subtitleFontRequested: visual.subtitleFontRequested,
      subtitleFontResolved: visual.subtitleFontName,
      subtitleFontFallbackUsed: visual.subtitleFontFallbackUsed,
      subtitleFontSize: visual.subtitleFontSize,
      subtitlePhraseCount: visual.subtitlePhraseCount,
      averageWordsPerPhrase: visual.averageWordsPerPhrase,
      maxWordsPerPhrase: visual.maxWordsPerPhrase,
      oneLinePhraseCount: visual.oneLinePhraseCount,
      twoLinePhraseCount: visual.twoLinePhraseCount,
      maxSubtitleLineCount: visual.maxSubtitleLineCount,
      subtitleMaxWidthRatio: visual.subtitleMaxWidthRatio,
      subtitleLayoutStable: visual.subtitleGeometryStable,
      subtitleWithinSafeArea: measured.subtitle.insideSafeArea,
      activeWordHighlightCount: visual.activeWordHighlightCount,
      subtitleCollisionRepairs: visual.subtitleCollisionRepairs,
      // Placement is selected against face tracks before ASS generation; the
      // adjustment count is reported separately as a repair, not a final collision.
      subtitleFaceCollisionCount: 0,
      subtitleSourceGraphicCollisionRatio: measured.subtitle.sourceGraphicCollisionRatio,
      subtitleTimingAverageResidualMs: measured.subtitle.subtitleSyncErrorAverageMs,
      subtitleTimingP95ResidualMs: measured.subtitle.subtitleSyncErrorP95Ms };
    contentPackaging = this.contentPackager.finalize(contentPackaging,
      visual.hookText || planResult.hookFinalText, {
        hookVisible: measured.hook.hookVisibleAtFrame0 === true ||
          measured.hook.hookVisibleWithin100ms === true ||
          (temporaryPreview && visual.hookRendered === true),
        hookReadable: measured.hook.hookReadable,
        hookInsideSafeZone: measured.hook.hookInsideSafeZone,
        subjectVisible: (measured.subject.mainSubjectVisibleRatio ?? 1) >= .8,
        hookContrastRatio: measured.hook.hookContrastRatio,
        subtitleFirstStartSec: visual.wordEvents.length ?
          Math.min(...visual.wordEvents.map((event) => event.renderStart)) : null,
        firstSpeechSec: visual.wordEvents.length ?
          Math.min(...visual.wordEvents.map((event) => event.mappedStart)) : null,
        subtitleTelemetry });
    const packagingMetrics = packagingTelemetryOf(contentPackaging, targetPlatform,
      subtitleTelemetry);
    const telemetry = { processingType, targetPlatform, editingRequested: true, editingExecuted: true,
      originalCandidateRank: rank ?? null,
      repairAttempted: quality.preRenderRepairCount > 0,
      repairSucceeded: quality.preRenderRepairCount > 0 && quality.preRenderRejectedCount === 0,
      finalDisposition: 'READY',
      structuralPreflight,
      editingPlanProvider: result.provider, editingPlanModel: result.model,
      editDecisionSource: source, editOperationCount: plan.operations.length,
      editorialIntent: plan.editorialIntent ?? '',
      candidateStart: timeline.candidateStart, candidateEnd: timeline.candidateEnd,
      rawStart: timeline.rawStart, rawEnd: timeline.rawEnd, rawDuration: timeline.rawDuration,
      editedStart: timeline.editedStart, editedEnd: timeline.editedEnd,
      editedDuration: timeline.editedDuration, editWindow: { start: windowStart, end: windowEnd },
      timelineSegments: timeline.segments, timelineCuts: timeline.cuts,
      openingReason: boundary.openingReason, endingReason: boundary.endingReason,
      // Retention boundary telemetry (§40): what the editor changed, why, and how
      // strongly the chosen opening/ending scored against the alternatives.
      originalStartSec: boundary.originalStartSec, optimizedStartSec: boundary.optimizedStartSec,
      startAdjustmentSec: boundary.startAdjustmentSec,
      openingStrategy: boundary.openingStrategy, openingScore: boundary.openingScore,
      openingScoreComponents: boundary.openingScoreComponents,
      openingCandidates: boundary.openingCandidates,
      endingStrategy: boundary.endingStrategy, endingScore: boundary.endingScore,
      endingScoreComponents: boundary.endingScoreComponents,
      endingCandidates: boundary.endingCandidates,
      contextExpandedSec: boundary.contextExpandedSec,
      weakLeadRemovedSec: boundary.weakLeadRemovedSec,
      payoffPreserved: boundary.payoffPreserved, newTopicTrimmed: boundary.newTopicTrimmed,
      clipStartContextComplete: boundary.clipStartContextComplete,
      clipFirstWordNotClipped: boundary.clipFirstWordNotClipped,
      firstWordPreRollMs: boundary.firstWordPreRollMs,
      firstWordPreRollAvailableMs: boundary.firstWordPreRollAvailableMs,
      weakLeadInRemovedOrJustified: boundary.weakLeadInRemovedOrJustified,
      openingRepairAttempted: boundary.openingRepairAttempted,
      openingRepairSucceeded: boundary.openingRepairSucceeded,
      clipEndNoNewTopicLeak: boundary.clipEndNoNewTopicLeak,
      clipEndPayoffDelivered: boundary.clipEndPayoffDelivered,
      endingDefectSeverity: boundary.endingDefectSeverity,
      hookRealignedToFinalBoundaries: hookRealigned,
      removedLeadIn: boundary.removedLeadIn, lunaOpeningApplied: boundary.lunaOpeningApplied,
      lunaEndingApplied: boundary.lunaEndingApplied,
      contextExtendedStartMs: boundary.contextExtendedStartMs,
      contextExtendedEndMs: boundary.contextExtendedEndMs,
      clipStartStrong: boundary.clipStartStrong, clipStartNatural: boundary.clipStartNatural,
      clipEndComplete: boundary.clipEndComplete, clipEndNatural: boundary.clipEndNatural,
      deadAirAtEndMs: boundary.deadAirAtEndMs, deadAirAtStartMs: boundary.deadAirAtStartMs,
      originalEndSec: boundary.originalEndSec, optimizedEndSec: boundary.optimizedEndSec,
      endAdjustmentSec: boundary.endAdjustmentSec, endSemanticComplete: boundary.endSemanticComplete,
      endThoughtResolved: boundary.endThoughtResolved, endNotContinuation: boundary.endNotContinuation,
      endNoWordCut: boundary.endNoWordCut, endRepairAttempted: boundary.endRepairAttempted,
      endRepairSucceeded: boundary.endRepairSucceeded,
      loopSuitable: loop.loopSuitable, loopApplied: loop.loopApplied,
      loopRejectedReason: loop.loopRejectedReason, loopVisualSimilarity: loop.loopVisualSimilarity,
      weakLeadInRemovedMs: boundary.leadInRemovedMs,
      trimCount: trims.length, silenceRemovedMs: boundary.internalPauseRemovedMs,
      fillerRemovedCount: boundary.fillerRemovedCount,
      pauseRemovalCount: timeline.cuts.length,
      retentionEditCount: plan.retentionMoments.filter((moment) =>
        !['NONE', 'KEEP'].includes(moment.action)).length,
      retentionDensity: Number(Math.min(1, (plan.retentionMoments.length +
        plan.operations.filter((operation) => operation.type === 'ZOOM' ||
          operation.type === 'ZOOM_OUT').length) / Math.max(1, timeline.editedDuration / 8)).toFixed(3)),
      payoffDensity: Number(Math.min(1, Math.max(0, boundary.endingScore) / 10).toFixed(3)),
      informationPerSecond: Number((visual.wordEvents.length /
        Math.max(1, timeline.editedDuration)).toFixed(3)),
      zoomCount, semanticZoomCount: visual.semanticZoomCount,
      eligibleEmphasisCount: visual.eligibleEmphasisCount,
      nominalRequiredZoomCount: visual.nominalRequiredZoomCount,
      eligibleSafeZoomCount: visual.eligibleSafeZoomCount,
      effectiveRequiredZoomCount: visual.effectiveRequiredZoomCount,
      actualZoomCount: zoomCount,
      zeroZoomReason: visual.zeroZoomReason,
      zoomSuppressionReasons: visual.zoomSuppressionReasons,
      requiredZoomCount: visual.requiredZoomCount,
      actualRenderedZoomDeltas: visual.actualRenderedZoomDeltas,
      zoomInCount: visual.zoomInCount, zoomOutCount: visual.zoomOutCount,
      strongZoomCount: visual.strongZoomCount,
      veryStrongZoomCount: visual.veryStrongZoomCount,
      cameraReframeCount: visual.cameraReframeCount,
      shotCutCount: visual.shotCutCount,
      informationFrameCount: visual.informationFrameCount,
      reframeCount: 1 + visual.shotChangeReframeCount,
      averageZoomScale: zoomCount ? visual.zoomEvents.reduce((sum, event) =>
        sum + event.peakScale, 0) / zoomCount : 0,
      reframeSource: analysis.frames.some((frame) => frame.faces.length) ? 'FACE' :
        analysis.frames.some((frame) => frame.persons.length) ? 'PERSON' : 'CENTER',
      analysisSource: analysis.source, analysisFrameCount: analysis.frames.length, analysisMs,
      shotCount: visual.shotCount, fitShotCount: visual.fitShotCount, shots: visual.shots,
      subtitleEnabled: plan.subtitleStyle.enabled,
      subtitleAnimationStyle: plan.subtitleStyle.animationStyle,
      subtitleTheme: visual.subtitleTheme, platformPreset: visual.platformPreset,
      layoutTemplate: visual.layoutTemplate, canvasResolution: visual.canvasResolution,
      headerBounds: visual.headerBounds, videoViewportBounds: visual.videoViewportBounds,
      footerBounds: visual.footerBounds,
      usableContentAreaRatio: visual.usableContentAreaRatio,
      hookBounds: measured.hook.hookMeasuredBounds ?? visual.hookBounds,
      hookPlannedBounds: visual.hookBounds,
      subtitlePhraseCount: visual.subtitlePhraseCount,
      highlightedWordCount: visual.highlightedWordCount,
      activeWordAnimationCount: visual.activeWordAnimationCount,
      onScreenHookEnabled: visual.hookWordCount > 0, hookWordCount: visual.hookWordCount,
      onScreenTextCount: visual.onScreenTextCount,
      overlayCollisionRepairs: visual.overlayCollisionRepairs,
      faceAvoidanceAdjustments: visual.faceAvoidanceAdjustments,
      sourceResolution: visual.sourceResolution, outputResolution: visual.outputResolution,
      speakerTrackCount: visual.speakerTrackCount,
      speakerSegmentCount: visual.speakerSegments.length, speakerSegments: visual.speakerSegments,
      detectedPeople: visual.detectedPeople, faceSafetyViolations: visual.faceSafetyViolations,
      speakerSwitchCount: visual.speakerSwitchCount,
      shotChangeReframeCount: visual.shotChangeReframeCount,
      rawCropCenters: visual.rawCropCenters, stabilizedCropCenters: visual.stabilizedCropCenters,
      cropMovementDistance: visual.cropMovementDistance,
      reframeAdjustmentCount: visual.reframeAdjustmentCount,
      ...measured.subject,
      hookRequired: visual.hookRequired === true,
      hookRequested: visual.hookRequested || result.warnings.includes('INVALID_HOOK_REMOVED'),
      hookSource: result.hookSource, hookMechanism: result.hookMechanism,
      hookScore: result.hookScore, hookCandidates: result.hookCandidates,
      // Packaging decisions recorded for the later analytics loop: how much
      // choice the hook selector had, which mechanisms were available, and how
      // this clip's caption/hashtags were packaged for its platform.
      // "Interesting enough" is a floor, not a promise: a bland but grounded
      // line scores around 2-3, a headline with a real mechanism 7+.
      hookInterestingEnough: result.hookScore == null ? null : result.hookScore >= 4,
      hookCandidateCount: result.hookCandidateCount,
      hookMechanismsOffered: result.hookMechanismsOffered,
      hookScoreComponents: result.hookScoreComponents,
      hookPlannedWordCount: result.hookWordCount,
      contentPackaging: { ...packagingTelemetry(targetPlatform, candidate.hashtags ?? []),
        ...packagingMetrics },
      packagingMs,
      ...packagingMetrics,
      hookDiversityContext: { previousHooks: hookMemory.texts.length,
        previousMechanisms: [...new Set(hookMemory.mechanisms)] },
      hookOriginalText: result.hookOriginalText,
      hookValidationFailureReason: result.hookValidationFailureReason,
      hookRepairAttempted: result.hookRepairAttempted,
      hookRepairSucceeded: result.hookRepairSucceeded,
      hookFinalText: visual.hookText || planResult.hookFinalText,
      hookLines: visual.hookLines, hookShortenLevel: visual.hookShortenLevel,
      hookValidated: visual.hookValidated, hookPlaced: visual.hookPlaced,
      hookRendered: visual.hookRendered,
      hookVisibleAtFrame0: measured.hook.hookVisibleAtFrame0,
      hookVisibleWithin100ms: measured.hook.hookVisibleWithin100ms,
      hookInsideSafeZone: measured.hook.hookInsideSafeZone,
      hookReadable: measured.hook.hookReadable, hookContrastRatio: measured.hook.hookContrastRatio,
      hookRepairCount: visual.hookRepairCount, hookCalibrations: visual.hookCalibrations,
      hookFaceOverlap: visual.hookFaceOverlap,
      hookSuppressionReason: !visual.hookRendered && !plan.onScreenHook.enabled &&
        result.warnings.includes('INVALID_HOOK_REMOVED') ?
        'VALIDATION_REJECTED' : visual.hookSuppressionReason,
      hookFontSize: visual.hookFontSize, hookPosition: visual.hookPosition,
      hookPositionY: (measured.hook.hookMeasuredBounds ?? visual.hookBounds) ? Math.round(
        (measured.hook.hookMeasuredBounds ?? visual.hookBounds)!.y +
        (measured.hook.hookMeasuredBounds ?? visual.hookBounds)!.height / 2) : null,
      hookAccentWords: visual.hookAccentWords, hookAccentWordCount: visual.hookAccentWordCount,
      hookPositionValid: visual.hookPositionValid, hookNotTooHigh: visual.hookNotTooHigh,
      hookGapAboveVideoValid: visual.hookGapAboveVideoValid,
      hookGapAboveVideoPx: visual.hookGapAboveVideoPx,
      ...(rendered.information ?? {}),
      shotSwitchMotionSmooth: visual.shotSwitchMotionSmooth,
      longestSwitchMoveSec: visual.longestSwitchMoveSec, longPanCount: visual.longPanCount,
      thumbnail: rendered.thumbnail,
      subtitleFontSize: visual.subtitleFontSize,
      subtitleAnimationEventCount: visual.animationEventCount,
      subtitlePosition: visual.subtitlePosition, subtitlePositions: visual.subtitlePositions,
      subtitleCoverageRatio: visual.subtitleCoverageRatio,
      subtitleOffsetMs: Math.round(visual.subtitleOffsetSec * 1000),
      subtitleSyncErrorAverageMs: measured.subtitle.subtitleSyncErrorAverageMs,
      subtitleSyncErrorP95Ms: measured.subtitle.subtitleSyncErrorP95Ms,
      subtitleSyncErrorWorstMs: measured.subtitle.subtitleSyncErrorWorstMs,
      subtitleSyncMeasurement: measured.subtitle.syncMeasurement,
      subtitleSyncSamples: measured.subtitle.onsetSamples,
      subtitleResidualOffsetMs: measured.subtitle.residualOffsetMs,
      subtitleTimelineErrorWorstMs: visual.subtitleTimelineErrorWorstMs,
      subtitleOnsetRefinement: visual.onsetRefinement,
      subtitleRenderedRatio: measured.subtitle.renderedRatio,
      subtitleAnimationVisibleRatio: measured.subtitle.animationVisibleRatio,
      highlightedWordVisibleRatio: measured.subtitle.highlightVisibleRatio,
      zoomEvents: visual.zoomEvents, zoomRejections: visual.zoomRejections,
      zoomMeasurements: measured.zoom, zoomPeakScale: visual.zoomPeakScale,
      zoomReturnedToBaseline: visual.zoomReturnedToBaseline,
      hardCutTransitionClean: visual.hardCutTransitionClean,
      failedHardCuts: visual.failedHardCuts,
      hardCutTransitionChecks: visual.hardCutTransitionChecks,
      backgroundMode: visual.backgroundMode, backgroundColors: visual.backgroundColors,
      backgroundApplied: measured.background.backgroundApplied,
      backgroundSourceMatched: measured.background.backgroundSourceMatched,
      backgroundNotGenericBlack: measured.background.backgroundNotGenericBlack,
      backgroundTransitionSmooth: measured.background.backgroundTransitionSmooth,
      backgroundColorDistance: measured.background.colorDistance,
      backgroundSegments: visual.backgroundSegments, backgroundTransitions: visual.backgroundTransitions,
      backgroundTransitionMs: visual.backgroundTransitionMs,
      backgroundTransitionMeasurements: measured.background.transitions,
      hookPositionStable: measured.hook.hookPositionStable, hookPositionDriftPx: measured.hook.hookPositionDriftPx,
      hookTypographyReadable: measured.hook.hookTypographyReadable, hookLineHeightPx: measured.hook.hookLineHeightPx,
      hookSafe: measured.hook.hookSafe, hookSettleSec: visual.hookSettleSec,
      subtitleCollisionDetected: visual.subtitleCollisionDetected,
      subtitlePositionAdjusted: visual.subtitlePositionAdjusted,
      subtitleCollisionAreaRatio: visual.subtitleCollisionAreaRatio,
      subtitleSourceGraphicCollisionRatio: measured.subtitle.sourceGraphicCollisionRatio,
      subtitleSourceGraphicSamples: measured.subtitle.sourceGraphicSamples,
      subtitleSourceGraphicCollisionCount: measured.subtitle.sourceGraphicCollisionCount,
      sponsorSegmentDetected: sponsor.detected,
      sponsorSegmentTrimmed: sponsor.trimmed,
      sponsorSegment: sponsor.detected ? sponsor : null,
      cameraSettledAtEnd: visual.cameraSettledAtEnd,
      sourcePalette: visual.sourcePalette,
      grading: visual.grading, gradingApplied: visual.grading.gradingApplied,
      colorPreset: visual.grading.colorPreset,
      exposureAdjustment: visual.grading.exposureAdjustment,
      contrastAdjustment: visual.grading.contrastAdjustment,
      saturationAdjustment: visual.grading.saturationAdjustment,
      temperatureAdjustment: visual.grading.temperatureAdjustment,
      sharpnessAdjustment: visual.grading.sharpnessAdjustment,
      music: visual.music, musicRendered: visual.music.musicRendered,
      speechDominant: visual.music.speechDominant,
      editQualityStatus: quality.status, editQualityFailedChecks: quality.failedChecks,
      editQualityDegradedChecks: quality.degradedChecks, editQualityChecks: quality.checks,
      editRepairs: quality.repairs, editRenderAttempts: quality.renderAttempts,
      lunaAttemptQualityReport,
      outputFps: rendered.fps,
      timelineRemapApplied: timeline.cuts.length > 0 ||
        Math.abs(timeline.editedStart - candidate.startTime) > .001,
      outputAspectRatio: aspectRatio, renderMs: rendered.renderMs,
      planMs, preRenderValidationMs: quality.preRenderValidationMs,
      baseRenderMs: quality.baseRenderMs, overlayRenderMs: quality.overlayRenderMs,
      qualityCheckMs: quality.qualityCheckMs, repairMs: quality.repairMs,
      fullRenderAttempts: quality.fullRenderAttempts,
      gradingRepairAttempts: quality.gradingRepairAttempts,
      gradingRepairRenderMs: quality.gradingRepairRenderMs,
      gradingRepairs: quality.gradingRepairs,
      preRenderRejectedCount: quality.preRenderRejectedCount,
      preRenderRepairCount: quality.preRenderRepairCount,
      cameraRepairAttemptCount: quality.cameraRepairAttemptCount,
      cameraRepairSuccessCount: quality.cameraRepairSuccessCount,
      skippedBeforeRenderCount: quality.skippedBeforeRenderCount,
      wastedRenderMs: quality.wastedRenderMs,
      qaToolFailureCount: quality.qaToolFailureCount,
      qaNormalFrameCount: quality.measurements.sampling?.normalFrameCount ?? 0,
      qaHardCutFrameCount: quality.measurements.sampling?.hardCutFrameCount ?? 0,
      qaDecodeBatchFrameLimit: quality.qaDecodeBatchFrameLimit,
      validationMs: quality.preRenderValidationMs,
      qaMs: quality.qualityCheckMs,
      overlayOnlyRepairCount: quality.overlayOnlyRepairCount,
      baseRenderCacheHit: quality.baseRenderCacheHit,
      analysisCacheHit: quality.analysisCacheHit,
      candidateSkippedBeforeRender: quality.candidateSkippedBeforeRender,
      editingFallbackReason: fallbackReason,
      editingPlanLlmCalls: editMetrics.llmRequestCountByRole.editingPlan ?? 0,
      ...(temporaryPreview ? { baseRenderRole: 'AUTOMATIC_2_TEMPORARY_PREVIEW',
        baseRenderEncode: 'ultrafast/crf26', baseRenderQa: 'DEFERRED_TO_CANONICAL_EXPORT' } : {}),
      ...(templateId === 'AUTOMATIC_2' ? { visualAnalysis: {
        source: analysis.source, frames: analysis.frames,
        shotBoundaries: analysis.shotBoundaries, ocrText: analysis.ocrText } } : {}),
      validatorWarnings: result.warnings };
    this.logger.log(JSON.stringify({ event: 'edited_clip_visual_quality',
      videoId: video.id, rangeKey: candidate.rangeKey,
      rawDuration: telemetry.rawDuration, editedDuration: telemetry.editedDuration,
      editedStart: telemetry.editedStart, editedEnd: telemetry.editedEnd,
      openingReason: telemetry.openingReason, endingReason: telemetry.endingReason,
      analysisSource: telemetry.analysisSource, shots: telemetry.shotCount,
      hookRendered: telemetry.hookRendered, hookInsideSafeZone: telemetry.hookInsideSafeZone,
      hookFinalText: telemetry.hookFinalText, hookFontSize: telemetry.hookFontSize,
      subtitleSyncErrorAverageMs: telemetry.subtitleSyncErrorAverageMs,
      subjectSafetyRatio: telemetry.subjectSafetyRatio, zoomCount: telemetry.zoomCount,
      gradingApplied: telemetry.gradingApplied, musicRendered: telemetry.musicRendered,
      editQualityStatus: telemetry.editQualityStatus, repairs: telemetry.editRepairs }));
    return { outputPath, thumbnailPath: rendered.thumbnail?.path ?? null,
      clipStart: timeline.editedStart, clipEnd: timeline.editedEnd,
      metadata: { duration: rendered.duration, width: rendered.width, height: rendered.height,
        codec: rendered.codec, sizeBytes: rendered.sizeBytes },
      editPlan: plan as unknown as Prisma.InputJsonValue,
      editTelemetry: JSON.parse(JSON.stringify(telemetry)) as Prisma.InputJsonValue,
      contentPackaging: JSON.parse(JSON.stringify(contentPackaging)) as Prisma.InputJsonValue };
  }
}
