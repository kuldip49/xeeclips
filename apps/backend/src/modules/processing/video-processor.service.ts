import { isTransientAiServiceFailure, postAiServiceJson, waitForAiServiceHealthy, type AiServiceResponse } from './ai-service-http';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { Prisma, ProcessingStage, ProcessingStageStatus } from '@prisma/client';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises';
import IORedis from 'ioredis';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE
} from './processing.constants';

const execFileAsync = promisify(execFile);
import { buildTranscriptChunks } from './transcript-chunks';
import {
  extractAudioToWav,
  hasTrustworthyMediaMetadata,
  isMediaProcessingError,
  isStorageCorrupted,
  MediaProcessingError,
  probeMedia
} from './media-probe';
import { analyzeTranscriptChunk } from './chunk-analysis';
import { calculateClipRecommendation, generateCandidateRanges, isEligibleForCreativeGeneration,
  maximumClipCountForDuration, PRIMARY_CLIP_SCORE, recommendationTierForScore, suppressOverlapAndRank,
  shortlistForUnderstanding, shortlistForCreative, ScoredClipCandidate } from './clip-candidates';
import { createPerformanceTelemetry, performanceContext, PerformanceStageClock,
  type ClipDecisionSource } from './performance-telemetry';
import {
  applyPlatformPackaging,
  buildContentFingerprint,
  canReuseGeneratedContent,
  CLIP_CONTENT_PROMPT_VERSION,
  ClipJudgeService,
  fallbackContent,
  ensureSameVideoHookDiversity
} from './openai-clip-judge.service';
import {
  persistVideoUnderstanding,
  VideoUnderstandingService
} from './video-understanding.service';
import { applyDeterministicEvidence, ClipIntelligenceService, MultimodalObservation, VisualSignal } from
  './clip-intelligence.service';
import { ClipCriticService } from './clip-critic.service';
import { normalizeAiProcessingMode } from './ai-processing-mode';
import { parseProcessingType, parseOutputAspectRatio } from './processing-type';
import { optimizeClipBoundaries, TranscriptWord } from './clip-boundary-optimizer';
import { isVideoTooLong, maxClipCountForDuration } from './clip-selection-policy';

const round2 = (value: number) => Math.round(value * 100) / 100;

type TranscriptionResponse = {
  text: string;
  language: string | null;
  language_probability: number | null;
  duration: number | null;
  segments: Array<{
    position: number;
    start: number;
    end: number;
    text: string;
    words: Array<{ start: number; end: number; text: string; confidence: number | null }>;
    confidence: number | null;
    speaker: string | null;
  }>;
};

type VisualAnalysisResponse = {
  position: number;
  sampled_frame_count: number;
  yolo_frame_count: number;
  face_frame_count: number;
  ocr_frame_count: number;
  shot_boundaries: number[];
  scene_change_count: number;
  scene_cut_rate: number;
  average_shot_duration: number;
  visual_transition_score: number;
  average_motion: number;
  visual_novelty: number;
  face_count: number;
  face_tracks?: Array<{ timestamp: number; x: number; y: number; w: number; h: number }>;
  person_tracks?: Array<{ timestamp: number; x: number; y: number; w: number; h: number }>;
  largest_face_ratio: number;
  face_presence_ratio: number;
  average_face_count: number;
  primary_face_area_ratio: number;
  primary_face_centeredness: number;
  face_stability: number;
  talking_head_likelihood: number;
  person_presence_ratio: number;
  average_person_count: number;
  object_activity: number;
  object_diversity: number;
  detected_object_classes: string[];
  largest_person_prominence: number;
  central_person_score: number;
  detection_confidence_mean: number;
  brightness: number;
  contrast: number;
  colorfulness: number;
  sharpness_score: number;
  black_frame_ratio: number;
  ocr_text: string;
  ocr_confidence: number;
  text_area_ratio: number;
  subtitle_detected: boolean;
  title_card_presence: boolean;
};

type ErrorWithStatus = Error & {
  status?: number;
  statusCode?: number;
};

function getHttpStatus(error: unknown): number | undefined {
  const seen = new Set<object>();
  let current = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as ErrorWithStatus;
    const status = candidate.status ?? candidate.statusCode;
    if (typeof status === 'number') return status;
    current = candidate.cause;
  }

  return undefined;
}

function describeCause(cause: unknown, seen = new Set<object>()): unknown {
  if (!cause || typeof cause !== 'object') return cause;
  if (seen.has(cause)) return '[circular cause]';
  seen.add(cause);

  if (cause instanceof Error) {
    const description: Record<string, unknown> = {
      name: cause.name,
      message: cause.message,
      stack: cause.stack
    };
    const status = getHttpStatus(cause);
    if (status !== undefined) description.status = status;
    if (cause.cause !== undefined) {
      description.cause = describeCause(cause.cause, seen);
    }
    for (const key of Object.getOwnPropertyNames(cause)) {
      if (!(key in description)) {
        description[key] = (cause as unknown as Record<string, unknown>)[key];
      }
    }
    return description;
  }

  return cause;
}

function formatProcessingJobError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts = [`${error.name}: ${error.message}`];
  const status = getHttpStatus(error);
  if (status !== undefined) parts.push(`HTTP status: ${status}`);
  if (error.cause !== undefined) {
    const cause = error.cause instanceof Error
      ? formatProcessingJobError(error.cause)
      : String(error.cause);
    parts.push(`cause: ${cause}`);
  }
  return parts.join('; ');
}

function parseTranscription(value: unknown): TranscriptionResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('AI service returned an invalid transcription');
  }

  const result = value as Partial<TranscriptionResponse>;
  if (typeof result.text !== 'string' || !Array.isArray(result.segments)) {
    throw new Error('AI service returned an invalid transcription');
  }

  for (const segment of result.segments) {
    if (
      !Number.isInteger(segment.position) ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end < segment.start ||
      typeof segment.text !== 'string'
    ) {
      throw new Error('AI service returned an invalid transcript segment');
    }
    if (segment.words !== undefined && (!Array.isArray(segment.words) ||
      segment.words.some((word) => !word || !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) || word.end < word.start || typeof word.text !== 'string'))) {
      throw new Error('AI service returned invalid word timestamps');
    }
  }

  return {
    text: result.text,
    language: typeof result.language === 'string' ? result.language : null,
    language_probability: Number.isFinite(result.language_probability)
      ? result.language_probability as number
      : null,
    duration: Number.isFinite(result.duration) ? result.duration as number : null,
    segments: result.segments.map((segment) => ({ ...segment,
      words: Array.isArray(segment.words) ? segment.words : [],
      confidence: Number.isFinite(segment.confidence) ? segment.confidence : null,
      speaker: typeof segment.speaker === 'string' ? segment.speaker : null }))
  };
}

function parseVisualAnalysis(
  value: unknown,
  expectedPositions: number[]
): Map<number, VisualAnalysisResponse> {
  if (!Array.isArray(value)) {
    throw new Error('AI service returned an invalid visual analysis');
  }

  const results = new Map<number, VisualAnalysisResponse>();
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      throw new Error('AI service returned an invalid visual analysis record');
    }
    const result = item as Partial<VisualAnalysisResponse>;
    const numericMetrics = [
      result.sampled_frame_count,
      result.yolo_frame_count,
      result.face_frame_count,
      result.ocr_frame_count,
      result.scene_change_count,
      result.scene_cut_rate,
      result.average_shot_duration,
      result.visual_transition_score,
      result.average_motion,
      result.visual_novelty,
      result.face_count,
      result.largest_face_ratio,
      result.face_presence_ratio,
      result.average_face_count,
      result.primary_face_area_ratio,
      result.primary_face_centeredness,
      result.face_stability,
      result.talking_head_likelihood,
      result.person_presence_ratio,
      result.average_person_count,
      result.object_activity,
      result.object_diversity,
      result.largest_person_prominence,
      result.central_person_score,
      result.detection_confidence_mean,
      result.brightness,
      result.contrast,
      result.colorfulness,
      result.sharpness_score,
      result.black_frame_ratio,
      result.ocr_confidence,
      result.text_area_ratio
    ];
    if (
      !Number.isInteger(result.position) ||
      !Array.isArray(result.shot_boundaries) ||
      result.shot_boundaries.some((boundary) => !Number.isFinite(boundary)) ||
      numericMetrics.some((metric) => !Number.isFinite(metric)) ||
      !Number.isInteger(result.sampled_frame_count) ||
      !Number.isInteger(result.yolo_frame_count) ||
      !Number.isInteger(result.face_frame_count) ||
      !Number.isInteger(result.ocr_frame_count) ||
      !Number.isInteger(result.scene_change_count) ||
      !Number.isInteger(result.face_count) ||
      (result.face_tracks !== undefined && !Array.isArray(result.face_tracks)) ||
      (result.person_tracks !== undefined && !Array.isArray(result.person_tracks)) ||
      !Number.isInteger(result.object_diversity) ||
      !Array.isArray(result.detected_object_classes) ||
      result.detected_object_classes.some((name) => typeof name !== 'string') ||
      typeof result.ocr_text !== 'string' ||
      typeof result.subtitle_detected !== 'boolean' ||
      typeof result.title_card_presence !== 'boolean' ||
      results.has(result.position as number)
    ) {
      throw new Error('AI service returned an invalid visual analysis record');
    }
    results.set(result.position as number, result as VisualAnalysisResponse);
  }

  if (
    results.size !== expectedPositions.length ||
    expectedPositions.some((position) => !results.has(position))
  ) {
    throw new Error('AI service did not analyze every transcript chunk');
  }
  return results;
}

export function speechCoverageForRange(start: number, end: number,
  words: Array<{ start: number; end: number }>) {
  const duration = Math.max(0.001, end - start);
  const intervals = words.filter(word => Number.isFinite(word.start) &&
    Number.isFinite(word.end) && word.end > word.start && word.end > start && word.start < end)
    .map(word => [Math.max(start, word.start), Math.min(end, word.end)] as const)
    .sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let previousEnd = start;
  for (const [left, right] of intervals) {
    covered += Math.max(0, right - Math.max(previousEnd, left));
    previousEnd = Math.max(previousEnd, right);
  }
  const speechDensity = Math.round(Math.min(100, covered / duration * 100) * 100) / 100;
  return { speechDensity, silenceRatio: Math.round((100 - speechDensity) * 100) / 100 };
}

@Injectable()
export class VideoProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoProcessorService.name);
  private readonly connection = new IORedis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
    { maxRetriesPerRequest: null }
  );
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
  private readonly aiServiceTimeoutMs = Number(
    process.env.AI_SERVICE_TIMEOUT_MS ?? '1800000'
  );
  private readonly visualAnalysisEnabled =
    process.env.ENABLE_VISUAL_ANALYSIS?.toLowerCase() === 'true';
  private readonly forceReprocess =
    process.env.FORCE_REPROCESS?.toLowerCase() === 'true';
  private worker?: Worker<ProcessVideoJobData>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly clipJudge: ClipJudgeService = new ClipJudgeService(),
    private readonly understandingService: VideoUnderstandingService =
      new VideoUnderstandingService(),
    private readonly clipIntelligence: ClipIntelligenceService = new ClipIntelligenceService(),
    private readonly clipCritic: ClipCriticService = new ClipCriticService()
  ) {}

  onModuleInit() {
    this.logger.log(`Visual analysis enabled: ${this.visualAnalysisEnabled}`);
    this.worker = new Worker<ProcessVideoJobData>(
      VIDEO_PROCESSING_QUEUE,
      (job) => this.process(job),
      {
        connection: this.connection,
        concurrency: Number(process.env.VIDEO_WORKER_CONCURRENCY ?? 1)
      }
    );
    this.worker.on('failed', (job, error) => {
      this.logProcessingError(error, 'worker failure event', {
        queueJobId: job?.id ?? 'unknown'
      });
      if (job) void this.recordWorkerFailure(job, error).catch((failure) =>
        this.logger.error('Could not persist worker failure', failure)
      );
    });
  }

  private async recordWorkerFailure(job: Job<ProcessVideoJobData>, error: Error) {
    // BullMQ can fail a stalled job without entering process() again.
    const { processingJobId, videoId } = job.data;
    const mediaError = isMediaProcessingError(error) ? error : undefined;
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.processingJob.updateMany({
        where: { id: processingJobId, status: { in: ['PROCESSING', 'PENDING'] } },
        data: { status: 'FAILED', error: error.message.slice(0, 2000), completedAt: new Date(),
          errorCode: mediaError?.code ?? null, retryable: mediaError ? mediaError.retryable : true }
      });
      if (!changed.count) return;
      await tx.videoProcessingStage.updateMany({
        where: { videoId, status: 'PROCESSING' },
        data: { status: 'FAILED', error: error.message.slice(0, 2000), completedAt: new Date() }
      });
      await tx.videoProcessingStage.upsert({
        where: { videoId_stage: { videoId, stage: 'FAILED' } },
        create: { videoId, stage: 'FAILED', status: 'FAILED', error: error.message.slice(0, 2000), completedAt: new Date() },
        update: { status: 'FAILED', error: error.message.slice(0, 2000), completedAt: new Date() }
      });
    });
  }

  private logProcessingError(
    error: unknown,
    stage: string,
    context: Record<string, unknown> = {}
  ) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.logger.error({
      event: 'Processing job failed',
      ...context,
      stage,
      error: {
        name: normalized.name,
        message: normalized.message,
        stack: normalized.stack,
        cause: describeCause(normalized.cause)
      },
      httpStatus: getHttpStatus(error)
    });
  }

  private async setProgress(
    job: Job<ProcessVideoJobData>,
    processingJobId: string,
    progress: number
  ) {
    await Promise.all([
      job.updateProgress(progress),
      this.prisma.processingJob.update({
        where: { id: processingJobId },
        data: { progress }
      })
    ]);
  }

  private async requestTranscription(bucket: string, objectKey: string) {
    // A dropped connection or 5xx means the AI service crashed or restarted mid-request; it
    // comes back on its own, so wait for it and try again rather than failing the video.
    const attempts = Math.max(1, Math.min(5, Number(process.env.AI_TRANSCRIPTION_ATTEMPTS) || 3));
    for (let attempt = 1; ; attempt++) {
      this.logger.log(`Sending POST /transcriptions (attempt ${attempt}/${attempts})`);
      let response: AiServiceResponse;
      try {
        // Not fetch: its hidden 300 s headers timeout failed every source over ~50 minutes.
        response = await postAiServiceJson(`${this.aiServiceUrl}/transcriptions`,
          { bucket, object_key: objectKey }, this.aiServiceTimeoutMs);
        this.logger.log('POST completed');
      } catch (error) {
        this.logger.error(`POST failed: ${error instanceof Error ? error.message : String(error)}`);
        if (attempt >= attempts || !isTransientAiServiceFailure(error)) throw error;
        await this.awaitAiServiceRecovery(attempt);
        continue;
      }

      if (!response.ok) {
        const detail = await response.text();
        if (attempt < attempts && isTransientAiServiceFailure(null, response.status)) {
          this.logger.warn(`Transcription returned ${response.status}; retrying: ${detail.slice(0, 300)}`);
          await this.awaitAiServiceRecovery(attempt);
          continue;
        }
        throw Object.assign(new Error(
          `AI transcription request failed (${response.status}): ${detail.slice(0, 1000)}`
        ), { status: response.status });
      }

      return parseTranscription(await response.json());
    }
  }

  private async awaitAiServiceRecovery(attempt: number) {
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    const healthy = await waitForAiServiceHealthy(this.aiServiceUrl, 5 * 60_000);
    this.logger.warn(JSON.stringify({ event: 'ai_service_recovery_wait', attempt, healthy }));
  }

  private async requestVisualAnalysis(
    bucket: string,
    objectKey: string,
    videoId: string,
    chunks: Array<{ position: number; startTime: number; endTime: number }>,
    candidates: Array<{ startTime: number; endTime: number }>
  ) {
    this.logger.log('Sending POST /visual-analysis');
    // Same long-call helper as transcription (fetch's hidden 300 s headers timeout).
    const response = await postAiServiceJson(`${this.aiServiceUrl}/visual-analysis`, {
      bucket,
      object_key: objectKey,
      video_id: videoId,
      candidates: candidates.map((candidate, position) => ({
        position, start: candidate.startTime, end: candidate.endTime
      })),
      chunks: chunks.map((chunk) => ({
        position: chunk.position,
        start: chunk.startTime,
        end: chunk.endTime
      }))
    }, this.aiServiceTimeoutMs);

    if (!response.ok) {
      const detail = await response.text();
      throw Object.assign(new Error(
        `AI visual analysis request failed (${response.status}): ${detail.slice(0, 1000)}`
      ), { status: response.status });
    }

    return parseVisualAnalysis(
      await response.json(),
      chunks.map((chunk) => chunk.position)
    );
  }

  private async process(job: Job<ProcessVideoJobData>) {
    if (job.name !== PROCESS_VIDEO_JOB) return;
    const persisted = await (this.prisma.processingJob.findUniqueOrThrow as unknown as
      (args: unknown) => Promise<{ videoId: string; aiMode?: unknown }>)({
      where: { id: job.data.processingJobId },
      select: { videoId: true, aiMode: true, processingType: true, outputAspectRatio: true }
    });
    if (persisted.videoId !== job.data.videoId) throw new Error('Processing job video mismatch');
    const aiMode = normalizeAiProcessingMode(persisted.aiMode ?? job.data.aiMode);
    const processingType = parseProcessingType((persisted as typeof persisted &
      { processingType?: unknown }).processingType);
    const outputAspectRatio = parseOutputAspectRatio((persisted as typeof persisted &
      { outputAspectRatio?: unknown }).outputAspectRatio);
    return performanceContext.run(createPerformanceTelemetry(aiMode, processingType, outputAspectRatio),
      () => this.processWithTelemetry(job));
  }

  private async processWithTelemetry(job: Job<ProcessVideoJobData>) {
    if (job.name !== PROCESS_VIDEO_JOB) return;
    const { processingJobId, videoId } = job.data;
    let stage: ProcessingStage = 'UPLOADED';
    let workDirectory: string | undefined;
    let frameWork: Promise<Array<{ mimeType: string; data: string }>> | undefined;
    let understandingWork: Promise<void> | undefined;
    let understandingFailure: unknown;
    let overallProgress = 0;
    const performance = performanceContext.getStore()!;
    this.logger.log(JSON.stringify({ event: 'processing_mode', videoId, processingJobId,
      requestedAiMode: performance.requestedAiMode, effectiveAiMode: performance.effectiveAiMode,
      processingType: performance.processingType, outputAspectRatio: performance.outputAspectRatio }));
    const processStarted = Date.now();
    const stageClock = new PerformanceStageClock(performance);

    const checkpoint = async (
      name: ProcessingStage,
      status: ProcessingStageStatus,
      progress: number,
      error: string | null = null
    ) => {
      const terminal = status === 'COMPLETED' || status === 'SKIPPED' || status === 'FAILED';
      stageClock.checkpoint(name, status);
      await this.prisma.videoProcessingStage.update({
        where: { videoId_stage: { videoId, stage: name } },
        data: {
          status, progress, error,
          ...(status === 'PROCESSING' ? { startedAt: new Date(), completedAt: null } : {}),
          ...(status === 'PENDING' ? { startedAt: null, completedAt: null } : {}),
          ...(terminal ? { completedAt: new Date() } : {})
        }
      });
    };
    const run = async (
      name: ProcessingStage,
      doneAt: number,
      skipLog: string,
      hasOutput: () => Promise<boolean>,
      execute: () => Promise<void>
    ) => {
      stage = name;
      const existing = await this.prisma.videoProcessingStage.findUniqueOrThrow({
        where: { videoId_stage: { videoId, stage: name } }
      });
      if (!this.forceReprocess && await hasOutput()) {
        performance.cacheHits++;
        if (existing.status !== 'COMPLETED') await checkpoint(name, 'COMPLETED', 100);
        this.logger.log(skipLog);
      } else {
        await checkpoint(name, 'PROCESSING', 0);
        await execute();
        await checkpoint(name, 'COMPLETED', 100);
      }
      overallProgress = Math.max(overallProgress, doneAt);
      await this.setProgress(job, processingJobId, overallProgress);
    };
    try {
      await this.prisma.videoProcessingStage.createMany({
        data: Object.values(ProcessingStage).map((name) => ({
          videoId, stage: name,
          status: name === 'UPLOADED' ? 'COMPLETED' as const : 'PENDING' as const,
          progress: name === 'UPLOADED' ? 100 : 0,
          completedAt: name === 'UPLOADED' ? new Date() : null
        })),
        skipDuplicates: true
      });
      const previous = await this.prisma.processingJob.findUniqueOrThrow({
        where: { id: processingJobId }
      });
      if (previous.videoId !== videoId) throw new Error('Processing job video mismatch');
      if (previous.status === 'COMPLETED' && !this.forceReprocess) {
        await job.updateProgress(100);
        return;
      }
      overallProgress = previous.progress;
      await this.prisma.processingJob.update({
        where: { id: processingJobId },
        data: { status: 'PROCESSING', startedAt: previous.startedAt ?? new Date(),
          completedAt: null, error: null, errorCode: null, retryable: true }
      });
      await checkpoint('FAILED', 'PENDING', 0);
      let video = await this.prisma.video.findUniqueOrThrow({ where: { id: videoId } });
      // The packaging surface chosen for this video. Content generation adapts
      // caption register and hashtag strategy to it; nothing about the clip's
      // meaning or selection depends on it.
      const targetPlatform = video.targetPlatform ?? null;
      let sourcePath: string | undefined;
      const source = async () => {
        if (!sourcePath) {
          workDirectory = await mkdtemp(join(tmpdir(), 'ai-content-video-'));
          const path = join(workDirectory, basename(video.objectKey));
          await this.storage.downloadToFile(video.bucket, video.objectKey, path);
          const downloadedSizeBytes = (await stat(path)).size;
          let remoteSizeBytes: number | undefined;
          if (typeof this.storage.statObject === 'function') {
            try {
              remoteSizeBytes = Number(
                (await this.storage.statObject(video.bucket, video.objectKey)).size
              );
            } catch (error) {
              this.logger.warn('Could not stat stored object for integrity check: ' +
                (error instanceof Error ? error.message : String(error)));
            }
          }
          const storedSizeBytes = Number(video.sizeBytes);
          this.logger.log(JSON.stringify({ event: 'media_integrity_check', videoId,
            storedSizeBytes, remoteObjectSizeBytes: remoteSizeBytes ?? null,
            downloadedTempFileSizeBytes: downloadedSizeBytes }));
          if (isStorageCorrupted({ storedSizeBytes, remoteSizeBytes, downloadedSizeBytes })) {
            throw new MediaProcessingError('STORAGE_OR_DOWNLOAD_CORRUPTION');
          }
          sourcePath = path;
        }
        return sourcePath;
      };

      await run('INSPECT_MEDIA', 15, 'Skipping inspect media: existing metadata found',
        async () => hasTrustworthyMediaMetadata(video),
        async () => {
          const probe = await probeMedia(await source());
          video = await this.prisma.video.update({
            where: { id: videoId },
            data: {
              duration: probe.durationSec ?? undefined,
              fps: probe.fps, width: probe.width, height: probe.height, codec: probe.videoCodec,
              bitrate: probe.bitrate,
              hasVideo: probe.hasVideo, hasAudio: probe.hasAudio, audioCodec: probe.audioCodec,
              videoStreamIndex: probe.videoStreamIndex, audioStreamIndex: probe.audioStreamIndex,
              formatName: probe.formatName
            }
          });
          this.logger.log(JSON.stringify({ event: 'media_probe_result', videoId,
            hasVideo: probe.hasVideo, hasAudio: probe.hasAudio, videoCodec: probe.videoCodec,
            audioCodec: probe.audioCodec, videoStreamIndex: probe.videoStreamIndex,
            audioStreamIndex: probe.audioStreamIndex, durationSec: probe.durationSec,
            formatName: probe.formatName, sourceSizeBytes: Number(video.sizeBytes) }));
          if (!probe.hasVideo) throw new MediaProcessingError('NO_VIDEO_STREAM');
          if (isVideoTooLong(probe.durationSec)) throw new MediaProcessingError('VIDEO_TOO_LONG');
        });
      // Enforced on both the fresh-probe and cached-metadata paths, before any transcription,
      // LLM, or visual work is spent on the source.
      if (isVideoTooLong(video.duration)) {
        stage = 'INSPECT_MEDIA';
        throw new MediaProcessingError('VIDEO_TOO_LONG');
      }

      await run('EXTRACT_AUDIO', 25, 'Skipping extract audio: existing audio found',
        async () => !!(video.audioBucket && video.audioObjectKey),
        async () => {
          if (video.hasAudio === false) throw new MediaProcessingError('NO_AUDIO_STREAM');
          const path = await source();
          const audioPath = join(workDirectory!, 'audio.wav');
          const diagnostics = await extractAudioToWav(path, audioPath, video.duration);
          this.logger.log(JSON.stringify({ event: 'audio_extraction_result', videoId,
            recoveryAttempted: diagnostics.recoveryAttempted,
            recoverySucceeded: diagnostics.recoverySucceeded,
            primaryStderrLength: diagnostics.primaryStderrLength ?? 0 }));
          const stored = await this.storage.uploadFile({
            filePath: audioPath,
            objectKey: `projects/${video.projectId}/videos/${video.id}/audio.wav`,
            mimeType: 'audio/wav'
          });
          video = await this.prisma.video.update({
            where: { id: videoId },
            data: { audioBucket: stored.bucket, audioObjectKey: stored.objectKey }
          });
        });

      if (this.clipIntelligence.isMultimodalConfigured()) {
        const frameSource = await source();
        const frameStarted = Date.now();
        frameWork = this.extractMultimodalFrames(frameSource, workDirectory!, video.duration)
          .catch(error => { this.logger.warn('Frame sampling unavailable: ' +
            (error instanceof Error ? error.message : 'extraction failure')); return []; })
          .finally(() => { performance.frameExtractionMs += Date.now() - frameStarted; });
      }
      await run('TRANSCRIBE', 50, 'Skipping transcription: existing transcript found', async () => {
        const transcript = await this.prisma.transcript.findUnique({
          where: { videoId }, include: { _count: { select: { segments: true } } }
        });
        return !!transcript && (transcript._count.segments > 0 || transcript.text.trim() === '');
      }, async () => {
        const transcription = await this.requestTranscription(video.audioBucket!, video.audioObjectKey!);
        await this.prisma.$transaction(async (tx) => {
          const transcript = await tx.transcript.upsert({
            where: { videoId },
            create: { videoId, text: transcription.text, language: transcription.language,
              languageProbability: transcription.language_probability, duration: transcription.duration },
            update: {}
          });
          await tx.transcriptSegment.createMany({
            data: transcription.segments.map((segment) => ({ ...segment, transcriptId: transcript.id })),
            skipDuplicates: true
          });
          await tx.videoProcessingStage.update({
            where: { videoId_stage: { videoId, stage: 'TRANSCRIBE' } },
            data: { status: 'COMPLETED', progress: 100, completedAt: new Date(), error: null }
          });
        });
      });

      await run('BUILD_CHUNKS', 55, 'Skipping chunk building: existing chunks found',
        async () => {
          const [chunkCount, segmentCount] = await Promise.all([
            this.prisma.transcriptChunk.count({ where: { videoId } }),
            this.prisma.transcriptSegment.count({ where: { transcript: { videoId } } })
          ]);
          return chunkCount > 0 || segmentCount === 0;
        },
        async () => {
          const segments = await this.prisma.transcriptSegment.findMany({
            where: { transcript: { videoId } }, orderBy: { position: 'asc' }
          });
          await this.prisma.$transaction(async (tx) => {
            await tx.transcriptChunk.createMany({
              data: buildTranscriptChunks(videoId, segments), skipDuplicates: true
            });
            await tx.videoProcessingStage.update({
              where: { videoId_stage: { videoId, stage: 'BUILD_CHUNKS' } },
              data: { status: 'COMPLETED', progress: 100, completedAt: new Date(), error: null }
            });
          });
        });

      const chunks = await this.prisma.transcriptChunk.findMany({
        where: { videoId }, include: { analysis: true, visualAnalysis: true },
        orderBy: { position: 'asc' }
      });

      stage = 'WHOLE_VIDEO_UNDERSTANDING';
      let understanding = await this.prisma.videoUnderstanding.findUnique({
        where: { videoId },
        include: { chapters: { orderBy: { position: 'asc' } } }
      });
      understandingWork = (async () => {
      if (!this.forceReprocess && understanding &&
        !(performance.effectiveAiMode === 'OFFLINE' && understanding.provider !== 'deterministic')) {
        performance.cacheHits++;
        if (performance.effectiveAiMode === 'OFFLINE')
          this.logger.log(JSON.stringify({ event: 'offline_deterministic_role',
            role: 'wholeVideoUnderstanding', cacheHit: true }));
        await checkpoint('WHOLE_VIDEO_UNDERSTANDING', 'COMPLETED', 100);
        this.logger.log('Skipping whole-video understanding: cached result found');
      } else if (chunks.length === 0) {
        await checkpoint('WHOLE_VIDEO_UNDERSTANDING', 'SKIPPED', 100,
          'Transcript contains no analyzable content');
      } else {
        await checkpoint('WHOLE_VIDEO_UNDERSTANDING', 'PROCESSING', 0);
        const transcript = await this.prisma.transcript.findUnique({
          where: { videoId },
          select: { language: true }
        });
        const result = await this.understandingService.analyzeWithFallback(
          chunks.map((chunk) => ({
            position: chunk.position,
            startTime: chunk.startTime,
            endTime: chunk.endTime,
            text: chunk.text
          })),
          transcript?.language
        );
        if (result) {
          const route = this.understandingService.providerName && this.understandingService.modelName
            ? { provider: this.understandingService.providerName,
              model: this.understandingService.modelName, success: true } : null;
          performance.wholeVideoUnderstanding = route ??
            { provider: 'deterministic', model: 'transcript-extractive', success: false };
          if (!route) {
            performance.deterministicFallbackUsed = true;
            performance.fallbackReason = 'WHOLE_VIDEO_UNDERSTANDING_UNAVAILABLE';
          }
          await persistVideoUnderstanding(
            this.prisma,
            videoId,
            result,
            this.understandingService.providerName,
            this.understandingService.modelName
          );
          understanding = await this.prisma.videoUnderstanding.findUnique({
            where: { videoId },
            include: { chapters: { orderBy: { position: 'asc' } } }
          });
          await checkpoint('WHOLE_VIDEO_UNDERSTANDING', 'COMPLETED', 100);
        } else {
          performance.wholeVideoUnderstanding = { provider: 'deterministic',
            model: 'transcript-extractive', success: false };
          performance.deterministicFallbackUsed = true;
          performance.fallbackReason = 'WHOLE_VIDEO_UNDERSTANDING_UNAVAILABLE';
          await checkpoint('WHOLE_VIDEO_UNDERSTANDING', 'SKIPPED', 100,
            'Whole-video LLM analysis unavailable; using transcript heuristics');
        }
      }
      overallProgress = Math.max(overallProgress, 65);
      await this.setProgress(job, processingJobId, overallProgress);
      })().catch(error => { understandingFailure = error; });

      await run('ANALYZE_CHUNKS', 70, 'Skipping chunk analysis: existing analyses found',
        async () => chunks.every((chunk) => !!chunk.analysis),
        async () => {
          let done = chunks.filter((chunk) => chunk.analysis).length;
          for (const chunk of chunks.filter((item) => !item.analysis)) {
            await this.prisma.chunkAnalysis.upsert({
              where: { chunkId: chunk.id },
              create: { chunkId: chunk.id, ...analyzeTranscriptChunk(chunk) }, update: {}
            });
            await this.prisma.videoProcessingStage.update({
              where: { videoId_stage: { videoId, stage: 'ANALYZE_CHUNKS' } },
              data: { progress: Math.round(++done / chunks.length * 100) }
            });
          }
        });

      await understandingWork;
      if (understandingFailure) throw understandingFailure;
      const preliminaryChunks = await this.prisma.transcriptChunk.findMany({
        where: { videoId }, include: { analysis: true }, orderBy: { position: 'asc' }
      });
      const preliminaryCandidates = generateCandidateRanges(videoId, preliminaryChunks,
        understanding ? {
          mainTopic: understanding.mainTopic, topics: understanding.topics,
          summary: understanding.summary, keyClaims: understanding.keyClaims,
          questions: understanding.questions, chapters: understanding.chapters
        } : null);
      performance.rawCandidateCount = preliminaryCandidates.length;
      performance.preScoredCandidateCount = preliminaryCandidates.length;
      const shortlistStartedAt = Date.now();
      const shortlistBeforeBoundaries = shortlistForUnderstanding(
        preliminaryCandidates, video.duration ?? 0);
      performance.candidateShortlistMs += Date.now() - shortlistStartedAt;
      performance.aiShortlistCount = shortlistBeforeBoundaries.length;
      performance.shortlistCount = shortlistBeforeBoundaries.length;

      const rawTranscriptSegments = await this.prisma.transcriptSegment.findMany({
        where: { transcript: { videoId } }, select: { start: true, end: true, words: true }
      });
      const transcriptWords: TranscriptWord[] = rawTranscriptSegments.flatMap(segment =>
        Array.isArray(segment.words) ? (segment.words as Array<{
          start?: number; end?: number; text?: string }>).filter(word => word &&
            Number.isFinite(word.start) && Number.isFinite(word.end) &&
            typeof word.text === 'string') as TranscriptWord[] : []);
      const boundaryStartedAt = Date.now();
      const preliminaryShortlist = shortlistBeforeBoundaries.map((candidate) => {
        const optimized = optimizeClipBoundaries(candidate, transcriptWords);
        const startTime = round2(optimized.startTime);
        const endTime = round2(optimized.endTime);
        return { ...candidate, startTime, endTime, duration: round2(endTime - startTime),
          transcriptText: optimized.transcriptText,
          rangeKey: `${startTime.toFixed(3)}:${endTime.toFixed(3)}`,
          openingStrength: optimized.openingStrength, endingStrength: optimized.endingStrength,
          leadingTrimmedMs: optimized.leadingTrimmedMs, trailingWasteMs: optimized.trailingWasteMs };
      });
      performance.boundaryOptimizationMs += Date.now() - boundaryStartedAt;
      const visualEnabled = this.visualAnalysisEnabled ||
        (performance.effectiveAiMode === 'FALLBACK_ONLY' &&
          process.env.VISUAL_INTELLIGENCE_ENABLED?.toLowerCase() !== 'false');
      let sourceTag = '';
      if (visualEnabled && typeof this.storage.statObject === 'function') {
        try {
          sourceTag = (await this.storage.statObject(video.bucket, video.objectKey)).etag ?? '';
        } catch (error) {
          this.logger.warn('Visual source version unavailable; using stored video identity: ' +
            (error instanceof Error ? error.message : String(error)));
        }
      }
      const visualConfigFingerprint = createHash('sha256').update(JSON.stringify({
        version: 3, sourceTag, sourceSize: String(video.sizeBytes),
        settings: Object.keys(process.env).filter(key =>
          key.startsWith('VISUAL_') || key === 'YOLO_MODEL').sort().map(key =>
          [key, process.env[key]])
      })).digest('hex');
      const visualRefreshRequired = visualEnabled && chunks.some(chunk =>
        chunk.visualAnalysis && (chunk.visualAnalysis.yoloFrameCount == null ||
          chunk.visualAnalysis.configFingerprint !== visualConfigFingerprint));

      stage = 'VISUAL_ANALYSIS';
      if (!visualEnabled) {
        await checkpoint('VISUAL_ANALYSIS', 'SKIPPED', 100);
        this.logger.log('Skipping visual analysis: disabled');
      } else {
        try {
          await run('VISUAL_ANALYSIS', 75, 'Skipping visual analysis: existing analyses found',
            async () => chunks.every((chunk) => chunk.visualAnalysis?.yoloFrameCount != null &&
              chunk.visualAnalysis.configFingerprint === visualConfigFingerprint),
            async () => {
              const pending = chunks.filter((item) => this.forceReprocess ||
                item.visualAnalysis?.yoloFrameCount == null ||
                item.visualAnalysis.configFingerprint !== visualConfigFingerprint);
              const result = await this.requestVisualAnalysis(video.bucket, video.objectKey,
                `${videoId}:${sourceTag}`, chunks, preliminaryShortlist);
              let done = chunks.length - pending.length;
              for (const chunk of pending) {
                const visual = result.get(chunk.position)!;
                const metrics = { sampledFrameCount: visual.sampled_frame_count,
                    yoloFrameCount: visual.yolo_frame_count,
                    faceFrameCount: visual.face_frame_count,
                    ocrFrameCount: visual.ocr_frame_count,
                    configFingerprint: visualConfigFingerprint,
                    shotBoundaries: visual.shot_boundaries,
                    sceneChangeCount: visual.scene_change_count, sceneCutRate: visual.scene_cut_rate,
                    averageShotDuration: visual.average_shot_duration,
                    visualTransitionScore: visual.visual_transition_score,
                    averageMotion: visual.average_motion, visualNovelty: visual.visual_novelty,
                    faceCount: visual.face_count,
                    faceTracks: visual.face_tracks ?? [], personTracks: visual.person_tracks ?? [],
                    largestFaceRatio: visual.largest_face_ratio,
                    facePresenceRatio: visual.face_presence_ratio,
                    averageFaceCount: visual.average_face_count,
                    primaryFaceAreaRatio: visual.primary_face_area_ratio,
                    primaryFaceCenteredness: visual.primary_face_centeredness,
                    faceStability: visual.face_stability,
                    talkingHeadLikelihood: visual.talking_head_likelihood,
                    personPresenceRatio: visual.person_presence_ratio,
                    averagePersonCount: visual.average_person_count,
                    objectActivity: visual.object_activity, objectDiversity: visual.object_diversity,
                    detectedObjectClasses: visual.detected_object_classes,
                    largestPersonProminence: visual.largest_person_prominence,
                    centralPersonScore: visual.central_person_score,
                    detectionConfidenceMean: visual.detection_confidence_mean,
                    brightness: visual.brightness, contrast: visual.contrast,
                    colorfulness: visual.colorfulness, sharpnessScore: visual.sharpness_score,
                    blackFrameRatio: visual.black_frame_ratio, ocrText: visual.ocr_text,
                    ocrConfidence: visual.ocr_confidence, textAreaRatio: visual.text_area_ratio,
                    subtitleDetected: visual.subtitle_detected,
                    titleCardPresence: visual.title_card_presence };
                await this.prisma.visualAnalysis.upsert({ where: { chunkId: chunk.id },
                  create: { chunkId: chunk.id, ...metrics }, update: metrics });
                await this.prisma.videoProcessingStage.update({
                  where: { videoId_stage: { videoId, stage: 'VISUAL_ANALYSIS' } },
                  data: { progress: Math.round(++done / Math.max(1, chunks.length) * 100) }
                });
              }
            });
        } catch (error) {
          const reason = 'Optional visual analysis unavailable: ' +
            (error instanceof Error ? error.message : String(error));
          await checkpoint('VISUAL_ANALYSIS', 'SKIPPED', 100, reason.slice(0, 2000));
          this.logger.warn(reason);
        }
      }

      const analyzedChunks = await this.prisma.transcriptChunk.findMany({
        where: { videoId }, include: { analysis: true, visualAnalysis: true },
        orderBy: { position: 'asc' }
      });
      const visualSignals: VisualSignal[] = analyzedChunks.flatMap((chunk) =>
        chunk.visualAnalysis?.configFingerprint === visualConfigFingerprint
          ? [{ position: chunk.position, startTime: chunk.startTime,
          endTime: chunk.endTime, sceneChangeCount: chunk.visualAnalysis.sceneChangeCount,
          yoloFrameCount: chunk.visualAnalysis.yoloFrameCount,
          faceFrameCount: chunk.visualAnalysis.faceFrameCount,
          ocrFrameCount: chunk.visualAnalysis.ocrFrameCount,
          sceneCutRate: chunk.visualAnalysis.sceneCutRate,
          averageShotDuration: chunk.visualAnalysis.averageShotDuration,
          visualTransitionScore: chunk.visualAnalysis.visualTransitionScore,
          averageMotion: chunk.visualAnalysis.averageMotion, faceCount: chunk.visualAnalysis.faceCount,
          largestFaceRatio: chunk.visualAnalysis.largestFaceRatio,
          facePresenceRatio: chunk.visualAnalysis.facePresenceRatio,
          averageFaceCount: chunk.visualAnalysis.averageFaceCount,
          primaryFaceAreaRatio: chunk.visualAnalysis.primaryFaceAreaRatio,
          primaryFaceCenteredness: chunk.visualAnalysis.primaryFaceCenteredness,
          faceStability: chunk.visualAnalysis.faceStability,
          talkingHeadLikelihood: chunk.visualAnalysis.talkingHeadLikelihood,
          personPresenceRatio: chunk.visualAnalysis.personPresenceRatio,
          averagePersonCount: chunk.visualAnalysis.averagePersonCount,
          objectActivity: chunk.visualAnalysis.objectActivity,
          objectDiversity: chunk.visualAnalysis.objectDiversity,
          detectedObjectClasses: chunk.visualAnalysis.detectedObjectClasses as string[],
          largestPersonProminence: chunk.visualAnalysis.largestPersonProminence,
          centralPersonScore: chunk.visualAnalysis.centralPersonScore,
          detectionConfidenceMean: chunk.visualAnalysis.detectionConfidenceMean,
          brightness: chunk.visualAnalysis.brightness, contrast: chunk.visualAnalysis.contrast,
          colorfulness: chunk.visualAnalysis.colorfulness,
          sharpnessScore: chunk.visualAnalysis.sharpnessScore,
          visualNovelty: chunk.visualAnalysis.visualNovelty,
          blackFrameRatio: chunk.visualAnalysis.blackFrameRatio,
          ocrText: chunk.visualAnalysis.ocrText, ocrConfidence: chunk.visualAnalysis.ocrConfidence,
          textAreaRatio: chunk.visualAnalysis.textAreaRatio,
          subtitleDetected: chunk.visualAnalysis.subtitleDetected,
          titleCardPresence: chunk.visualAnalysis.titleCardPresence }] : []);
      let multimodalFrames: Array<{ mimeType: string; data: string }> = [];
      if (this.clipIntelligence.isMultimodalConfigured()) {
        try {
          multimodalFrames = await frameWork!;
        } catch (error) {
          this.logger.warn('Multimodal frame sampling unavailable; metric evidence retained: ' +
            (error instanceof Error ? error.message : String(error)));
        }
      }
      const omniSignals = visualSignals.length ? visualSignals : analyzedChunks.map((chunk) => ({
        position: chunk.position, startTime: chunk.startTime, endTime: chunk.endTime,
        sceneChangeCount: 0, sceneCutRate: 0, averageShotDuration: chunk.duration,
        visualTransitionScore: 0, averageMotion: 0, visualNovelty: 0,
        faceCount: 0, largestFaceRatio: 0, facePresenceRatio: 0, averageFaceCount: 0,
        primaryFaceAreaRatio: 0, primaryFaceCenteredness: 0, faceStability: 0,
        talkingHeadLikelihood: 0, personPresenceRatio: 0, averagePersonCount: 0,
        objectActivity: 0, objectDiversity: 0, detectedObjectClasses: [],
        largestPersonProminence: 0, centralPersonScore: 0, detectionConfidenceMean: 0,
        brightness: 0, contrast: 0, colorfulness: 0, sharpnessScore: 0,
        blackFrameRatio: 0, ocrText: '', ocrConfidence: 0, textAreaRatio: 0,
        subtitleDetected: false, titleCardPresence: false
      }));
      stage = 'MULTIMODAL_UNDERSTANDING';
      const hasMultimodalInput = omniSignals.length > 0 &&
        (visualSignals.length > 0 || multimodalFrames.length > 0);
      await checkpoint(stage, hasMultimodalInput ? 'PROCESSING' : 'SKIPPED',
        hasMultimodalInput ? 0 : 100,
        hasMultimodalInput ? null : 'No optional visual or frame evidence was available');
      let multimodalObservations: MultimodalObservation[] = [];
      let multimodalMetadata: Record<string, unknown> | null = null;
      if (hasMultimodalInput) {
        const multimodal = await this.clipIntelligence.analyzeMultimodal(videoId, omniSignals,
          multimodalFrames);
        multimodalObservations = multimodal.observations;
        multimodalMetadata = multimodal.route as unknown as Record<string, unknown> | null;
        await checkpoint(stage, 'COMPLETED', 100,
          multimodal.failureCategory ? 'Deterministic evidence fallback: ' +
            multimodal.failureCategory : null);
      } else if (performance.effectiveAiMode === 'OFFLINE') {
        this.logger.log(JSON.stringify({ event: 'offline_deterministic_role',
          role: 'multimodalUnderstanding', visualEvidenceAvailable: false }));
      }
      overallProgress = Math.max(overallProgress, 80);
      await this.setProgress(job, processingJobId, overallProgress);

      stage = 'GENERATE_CLIP_CANDIDATES';
      await understandingWork;
      if (understandingFailure) {
        stage = 'WHOLE_VIDEO_UNDERSTANDING';
        throw understandingFailure;
      }
      const candidateCount = await this.prisma.clipCandidate.count({
        where: { videoId, judgeSource: { not: 'LEGACY' } }
      });
      const incompleteCandidateCount = candidateCount
        ? await this.prisma.clipCandidate.count({
          where: {
            videoId,
            OR: [
              { generationStatus: { notIn: ['GENERATED', 'FALLBACK'] } },
              { promptVersion: { not: CLIP_CONTENT_PROMPT_VERSION } }
            ]
          }
        })
        : 0;
      if (!this.forceReprocess && !visualRefreshRequired &&
        ((candidateCount > 0 && incompleteCandidateCount === 0) || analyzedChunks.length === 0)) {
        await checkpoint('GENERATE_CLIP_CANDIDATES', 'COMPLETED', 100);
        await checkpoint('EVIDENCE_FUSION', 'COMPLETED', 100);
        await checkpoint('CLIP_UNDERSTANDING', 'COMPLETED', 100);
        await checkpoint('CONTENT_GENERATION', 'COMPLETED', 100);
        await checkpoint('CRITIC_VALIDATION', 'COMPLETED', 100);
        this.logger.log('Skipping clip candidate generation: existing candidates found');
      } else {
        await checkpoint('GENERATE_CLIP_CANDIDATES', 'PROCESSING', 0);
        let heuristicCandidates: ScoredClipCandidate[] = preliminaryShortlist;
        await checkpoint('GENERATE_CLIP_CANDIDATES', 'COMPLETED', 100);
        await checkpoint('GENERATE_CLIP_CANDIDATES', 'COMPLETED', 100);
        overallProgress = Math.max(overallProgress, 85);
        await this.setProgress(job, processingJobId, overallProgress);

        stage = 'EVIDENCE_FUSION';
        await checkpoint(stage, 'PROCESSING', 0);
        const speechWords: Array<{ start: number; end: number }> = transcriptWords;
        const evidences = heuristicCandidates.map((candidate) =>
          this.clipIntelligence.fuse(candidate, visualSignals, multimodalObservations,
            speechCoverageForRange(candidate.startTime, candidate.endTime, speechWords)));
        heuristicCandidates = heuristicCandidates.map((candidate, index) => ({
          ...(performance.effectiveAiMode === 'FALLBACK_ONLY'
            ? applyDeterministicEvidence(candidate, evidences[index]) : candidate),
          evidence: evidences[index] as unknown as Record<string, unknown>,
          providerMetadata: multimodalMetadata ? [multimodalMetadata] : [] }));
        await checkpoint(stage, 'COMPLETED', 100);
        overallProgress = Math.max(overallProgress, 88);
        await this.setProgress(job, processingJobId, overallProgress);

        stage = 'CLIP_UNDERSTANDING';
        await checkpoint(stage, 'PROCESSING', 0);
        const understood = await this.clipIntelligence.understand(heuristicCandidates, evidences,
          async (completed, total) => {
            await this.prisma.videoProcessingStage.update({
              where: { videoId_stage: { videoId, stage: 'CLIP_UNDERSTANDING' } },
              data: { progress: Math.round(completed / Math.max(1, total) * 100) }
            });
            this.logger.log(`Evaluating clip ${completed}/${total}`);
          });
        heuristicCandidates = heuristicCandidates.map((candidate, index) => ({ ...candidate,
          clipUnderstanding: understood.understandings[index] as unknown as Record<string, unknown>,
          confidence: understood.understandings[index].confidence,
          decisionSource: understood.decisionSources[index],
          providerMetadata: [...(candidate.providerMetadata ?? []),
            ...(understood.routesByCandidate[index]
              ? [understood.routesByCandidate[index] as unknown as Record<string, unknown>] : [])],
          failureCategory: understood.failureCategories[index] }));
        performance.highConfidenceSkippedCount = understood.highConfidenceSkippedCount;
        performance.highConfidenceRejectedBy = understood.highConfidenceRejectedBy;
        performance.lunaCandidateCount = understood.decisionSources.filter(source =>
          source === 'LUNA').length;
        performance.localLlmCandidateCount = understood.decisionSources.filter(source =>
          source === 'OLLAMA').length;
        const activeModelRoute = understood.routesByCandidate.find(Boolean) as
          { provider: string; model: string } | undefined;
        // A high-confidence skip is a deliberate efficiency decision, not a failure: only an
        // actual attempted call that errored (or an unexpected route/model) counts as fallback.
        const clipSucceeded = understood.failureCategories.every((failure) => !failure) &&
          understood.decisionSources.every((source, index) => source === 'DETERMINISTIC_HIGH_CONFIDENCE' ||
            (performance.effectiveAiMode === 'ONLINE' &&
              understood.routesByCandidate[index]?.provider === 'openai' &&
              understood.routesByCandidate[index]?.model === 'gpt-5.6-luna') ||
            (performance.effectiveAiMode === 'OFFLINE' &&
              understood.routesByCandidate[index]?.provider === 'ollama'));
        performance.clipUnderstanding = { ...performance.clipUnderstanding,
          provider: activeModelRoute?.provider ?? (performance.clipUnderstanding.provider || 'deterministic'),
          model: activeModelRoute?.model ?? (performance.clipUnderstanding.model || 'transcript-extractive'),
          success: clipSucceeded, fallbackUsed: !clipSucceeded };
        if (!clipSucceeded) {
          performance.clipDecisionSource = 'DETERMINISTIC_FALLBACK' as ClipDecisionSource;
          performance.deterministicFallbackUsed = true;
          performance.fallbackReason = understood.failureCategory || 'CLIP_UNDERSTANDING_UNAVAILABLE';
        } else if (performance.highConfidenceSkippedCount === heuristicCandidates.length) {
          performance.clipDecisionSource = 'DETERMINISTIC_HIGH_CONFIDENCE' as ClipDecisionSource;
        }
        await checkpoint(stage, 'COMPLETED', 100,
          understood.failureCategory ? 'Deterministic understanding fallback: ' +
            understood.failureCategory : null);
        overallProgress = Math.max(overallProgress, 90);
        await this.setProgress(job, processingJobId, overallProgress);

        const existingCandidates = await this.prisma.clipCandidate.findMany({ where: { videoId } });
        const creativeShortlist = shortlistForCreative(heuristicCandidates, video.duration ?? 0);
        const existingByRange = new Map(existingCandidates.map((candidate) =>
          [candidate.rangeKey, candidate]));
        const reused = new Map<string, (typeof heuristicCandidates)[number]>();
        const candidatesToGenerate = [];
        let belowRecommendationThresholdCount = 0;
        const belowRecommendationThreshold = new Set<string>();
        // Tiers no longer gate delivery: the strongest usable candidates up to the largest
        // requestable clip count always get a full creative package, whatever their tier.
        const deliverableKeys = new Set([...creativeShortlist].filter((candidate) => !candidate.reject)
          .sort((a, b) => b.contentPotential - a.contentPotential || a.startTime - b.startTime)
          .slice(0, maxClipCountForDuration(video.duration ?? 0))
          .map((candidate) => candidate.rangeKey));
        for (const candidate of creativeShortlist) {
          candidate.contentFingerprint = buildContentFingerprint(candidate, targetPlatform);
          const cached = existingByRange.get(candidate.rangeKey);
          const reusable = cached && canReuseGeneratedContent(candidate, cached) ? cached : null;
          // Skip the paid creativeGeneration call for a candidate that cannot be recommended
          // anyway, unless valid generated content already exists to reuse for free.
          if (!reusable && !isEligibleForCreativeGeneration(candidate) &&
            !deliverableKeys.has(candidate.rangeKey)) {
            belowRecommendationThresholdCount++;
            belowRecommendationThreshold.add(candidate.rangeKey);
            continue;
          }
          if (reusable) {
            performance.cacheHits++;
            reused.set(candidate.rangeKey, {
              ...candidate,
              hookScore: reusable.hookScore,
              sourceHookScore: reusable.sourceHookScore,
              standaloneScore: reusable.standaloneScore,
              payoffScore: reusable.payoffScore,
              flowScore: reusable.flowScore,
              informationScore: reusable.informationScore,
              retentionScore: reusable.retentionScore,
              shareabilityScore: reusable.shareabilityScore,
              contentPotential: reusable.contentPotential,
              overallScore: reusable.overallScore,
              reject: reusable.reject,
              topic: reusable.topic,
              reason: reusable.reason,
              rejectionReason: reusable.rejectionReason,
              judgeSource: reusable.judgeSource as (typeof candidate)['judgeSource'],
              bestHook: reusable.bestHook,
              alternateHooks: reusable.alternateHooks,
              hooks: reusable.hooks as (typeof candidate)['hooks'],
              generatedHookScore: reusable.generatedHookScore,
              selectedHookStrategy: reusable.selectedHookStrategy,
              title: reusable.title,
              synopsis: reusable.synopsis,
              caption: reusable.caption,
              hashtags: reusable.hashtags,
              cta: reusable.cta,
              contentType: reusable.contentType,
              whySelected: reusable.whySelected,
              provider: reusable.provider,
              model: reusable.model,
              promptVersion: reusable.promptVersion,
              generationStatus: 'GENERATED',
              fallbackReason: reusable.fallbackReason,
              evidence: reusable.evidence as Record<string, unknown>,
              clipUnderstanding: reusable.clipUnderstanding as Record<string, unknown>,
              criticResult: reusable.criticResult as Record<string, unknown>,
              providerMetadata: reusable.providerMetadata as Array<Record<string, unknown>>,
              creativeCandidates: reusable.creativeCandidates as Record<string, unknown>,
              generationQuality: reusable.generationQuality,
              confidence: reusable.confidence,
              generationMode: reusable.generationMode as (typeof candidate)['generationMode'],
              fallbackUsed: reusable.fallbackUsed,
              failureCategory: reusable.failureCategory
            });
          } else {
            candidatesToGenerate.push(candidate);
          }
        }
        performance.creativePackageCount = candidatesToGenerate.length + reused.size;
        stage = 'CONTENT_GENERATION';
        await checkpoint(stage, 'PROCESSING', 0);
        const generatedCandidates = await this.clipJudge.judgeCandidates(candidatesToGenerate,
          async (completed, total) => {
            await this.prisma.videoProcessingStage.update({
              where: { videoId_stage: { videoId, stage: 'CONTENT_GENERATION' } },
              data: { progress: Math.round(completed / Math.max(1, total) * 100) }
            });
            this.logger.log(`Generating content ${completed}/${total}`);
          }, targetPlatform);
        await checkpoint(stage, 'COMPLETED', 100);
        const judgeRoutes = generatedCandidates.flatMap((candidate) =>
          (candidate.providerMetadata ?? []).filter((item) =>
            (item as Record<string, unknown>).role === 'candidateJudge')) as Array<Record<string, unknown>>;
        if (judgeRoutes.length) {
          const route = judgeRoutes[0];
          performance.candidateJudge = { provider: String(route.provider ?? ''),
            model: String(route.model ?? ''), success: judgeRoutes.every((item) =>
              item.provider === 'openai' && item.model === 'gpt-5.6-luna') };
          if (!performance.candidateJudge.success) {
            performance.clipDecisionSource = 'DETERMINISTIC_FALLBACK';
            performance.deterministicFallbackUsed = true;
            performance.fallbackReason = 'CANDIDATE_JUDGE_UNAVAILABLE';
          }
        }
        overallProgress = Math.max(overallProgress, 95);
        await this.setProgress(job, processingJobId, overallProgress);

        stage = 'CRITIC_VALIDATION';
        await checkpoint(stage, 'PROCESSING', 0);
        // Packaging is applied last, once the package is grounded and critic-approved:
        // the hashtag set is resized to what the chosen platform rewards and an
        // over-long caption is trimmed. No claim ever changes here.
        const reviewedCandidates = (await this.clipCritic.review(generatedCandidates))
          .map((candidate) => applyPlatformPackaging(candidate, targetPlatform));
        await checkpoint(stage, 'COMPLETED', 100);
        overallProgress = Math.max(overallProgress, 98);
        await this.setProgress(job, processingJobId, overallProgress);
        const generatedByRange = new Map(reviewedCandidates.map((candidate) =>
          [candidate.rangeKey, candidate]));
        const judgedCandidates = ensureSameVideoHookDiversity(heuristicCandidates.map((candidate) =>
          reused.get(candidate.rangeKey) ?? generatedByRange.get(candidate.rangeKey) ?? {
            ...candidate, ...fallbackContent(candidate), generationStatus: 'FALLBACK' as const,
            generationMode: 'DETERMINISTIC_FALLBACK' as const, fallbackUsed: true,
            fallbackReason: belowRecommendationThreshold.has(candidate.rangeKey)
              ? 'Below the PRIMARY/SECONDARY recommendation threshold; transcript-based content retained'
              : 'Outside the AI creative shortlist; transcript-based content retained',
            promptVersion: CLIP_CONTENT_PROMPT_VERSION }));
        const candidates = suppressOverlapAndRank(judgedCandidates);
        performance.finalCandidateCount = candidates.length;
        const recommendation = calculateClipRecommendation(candidates, video.duration ?? 0);
        const selected = candidates.filter((candidate) => !candidate.reject &&
          recommendationTierForScore(candidate.contentPotential) !== null);
        performance.selectedClipTimestamps = selected.map((candidate) => ({
          startTime: candidate.startTime, endTime: candidate.endTime }));
        if (performance.effectiveAiMode === 'ONLINE' && performance.clipUnderstanding.success &&
          (!performance.candidateJudge.provider || performance.candidateJudge.success)) {
          performance.clipDecisionSource = performance.highConfidenceSkippedCount > 0 &&
            performance.lunaCandidateCount === 0
            ? 'DETERMINISTIC_HIGH_CONFIDENCE' : 'LUNA';
        } else if (performance.effectiveAiMode === 'ONLINE') {
          performance.clipDecisionSource = 'DETERMINISTIC_FALLBACK';
        }
        candidates.forEach((candidate, candidateIndex) => {
          const visual = (candidate.evidence as { candidateVisualEvidence?: Record<string, number> }
            | undefined)?.candidateVisualEvidence ?? {};
          this.logger.log(JSON.stringify({ event: 'recommendation_candidate', videoId,
            candidateIndex, startSec: candidate.startTime, endSec: candidate.endTime,
            hook: candidate.hookScore, standalone: candidate.standaloneScore,
            payoff: candidate.payoffScore, flow: candidate.flowScore,
            information: candidate.informationScore, retention: candidate.retentionScore,
            shareability: candidate.shareabilityScore, contentPotential: candidate.contentPotential,
            facePresenceRatio: visual.facePresenceRatio ?? null,
            faceProminence: visual.faceProminence ?? null,
            personPresenceRatio: visual.personPresenceRatio ?? null,
            motionScore: visual.motionScore ?? null, sceneCutRate: visual.sceneCutRate ?? null,
            ocrPresenceScore: visual.ocrPresenceScore ?? null,
            transcriptOcrAlignment: visual.transcriptOcrAlignment ?? null,
            silenceRatio: visual.silenceRatio ?? null, sharpnessScore: visual.sharpnessScore ?? null,
            recommendationTier: candidate.reject ? null : recommendationTierForScore(candidate.contentPotential),
            reasonNotPrimary: candidate.reject ? candidate.rejectionReason :
              candidate.contentPotential < PRIMARY_CLIP_SCORE ?
                `Below primary threshold ${PRIMARY_CLIP_SCORE}` : null }));
        });
        this.logger.log(JSON.stringify({ event: 'recommendation_summary', videoId,
          rawCandidateCount: performance.rawCandidateCount,
          shortlistCount: performance.aiShortlistCount,
          primaryCount: recommendation.primaryCount,
          secondaryCount: recommendation.secondaryCount,
          recommendedClipCount: recommendation.recommendedClipCount,
          maxAllowedByDuration: maximumClipCountForDuration(video.duration ?? 0),
          primaryThreshold: PRIMARY_CLIP_SCORE,
          creativeShortlistCount: creativeShortlist.length,
          creativePackageCount: performance.creativePackageCount,
          belowRecommendationThresholdSkipped: belowRecommendationThresholdCount,
          highConfidenceSkippedCount: performance.highConfidenceSkippedCount,
          highConfidenceRejectedBy: performance.highConfidenceRejectedBy }));
        await this.prisma.$transaction(async (tx) => {
          await tx.clipCandidate.updateMany({ where: { videoId }, data: { rank: null } });
          for (const candidate of candidates) {
            const data = {
              startTime: candidate.startTime,
              endTime: candidate.endTime,
              duration: candidate.duration,
              transcriptText: candidate.transcriptText,
              titleCandidate: candidate.title ?? '',
              hookCandidate: candidate.bestHook ?? '',
              captionCandidate: candidate.caption ?? '',
              synopsis: candidate.synopsis ?? '',
              hashtags: candidate.hashtags ?? [],
              reason: candidate.reason,
              hookScore: candidate.hookScore,
              sourceHookScore: candidate.sourceHookScore,
              informationScore: candidate.informationScore,
              emotionScore: 0,
              controversyScore: 0,
              standaloneScore: candidate.standaloneScore,
              viralPotentialScore: candidate.overallScore,
              heuristicScore: candidate.heuristicScore,
              payoffScore: candidate.payoffScore,
              flowScore: candidate.flowScore,
              retentionScore: candidate.retentionScore,
              shareabilityScore: candidate.shareabilityScore,
              contentPotential: candidate.contentPotential,
              generationQuality: candidate.generationQuality ?? 0,
              confidence: candidate.confidence ?? 0,
              overallScore: candidate.overallScore,
              reject: candidate.reject,
              topic: candidate.topic,
              rejectionReason: candidate.rejectionReason,
              judgeSource: candidate.judgeSource,
              rank: candidate.rank,
              bestHook: candidate.bestHook ?? '',
              alternateHooks: candidate.alternateHooks ?? [],
              hooks: candidate.hooks ?? [],
              generatedHookScore: candidate.generatedHookScore ?? 0,
              selectedHookStrategy: candidate.selectedHookStrategy ?? 'educational/value',
              title: candidate.title ?? '',
              caption: candidate.caption ?? '',
              cta: candidate.cta ?? '',
              contentType: candidate.contentType ?? '',
              whySelected: candidate.whySelected ?? candidate.reason,
              provider: candidate.provider ?? '',
              model: candidate.model ?? '',
              promptVersion: candidate.promptVersion ?? CLIP_CONTENT_PROMPT_VERSION,
              generationStatus: candidate.generationStatus ?? 'FALLBACK',
              fallbackReason: candidate.fallbackReason ?? '',
              contentFingerprint: candidate.contentFingerprint ??
                buildContentFingerprint(candidate, targetPlatform),
              evidence: (candidate.evidence ?? {}) as Prisma.InputJsonValue,
              clipUnderstanding: (candidate.clipUnderstanding ?? {}) as Prisma.InputJsonValue,
              criticResult: (candidate.criticResult ?? {}) as Prisma.InputJsonValue,
              providerMetadata: (candidate.providerMetadata ?? []) as Prisma.InputJsonValue,
              creativeCandidates: (candidate.creativeCandidates ?? {}) as Prisma.InputJsonValue,
              generationMode: candidate.generationMode ?? 'DETERMINISTIC_FALLBACK',
              fallbackUsed: candidate.fallbackUsed ?? candidate.generationStatus === 'FALLBACK',
              failureCategory: candidate.failureCategory ?? '',
              decisionSource: candidate.decisionSource ?? 'DETERMINISTIC_FALLBACK',
              openingStrength: candidate.openingStrength ?? 0,
              endingStrength: candidate.endingStrength ?? 0
            };
            await tx.clipCandidate.upsert({
              where: { videoId_rangeKey: { videoId, rangeKey: candidate.rangeKey } },
              create: { videoId, rangeKey: candidate.rangeKey, ...data },
              update: data
            });
          }
          await tx.clipCandidate.deleteMany({
            where: {
              videoId,
              ...(candidates.length
                ? { rangeKey: { notIn: candidates.map((candidate) => candidate.rangeKey) } }
                : {})
            }
          });
        });
        const persistedSelected = await this.prisma.clipCandidate.findMany({
          where: { videoId, reject: false, rank: { not: null } },
          select: { id: true, startTime: true, endTime: true },
          orderBy: { rank: 'asc' }
        });
        performance.selectedClipIds = persistedSelected.map((candidate) => candidate.id);
        await checkpoint('GENERATE_CLIP_CANDIDATES', 'COMPLETED', 100);
        this.logger.log(`Generated ${candidates.length} ranked clip candidates`);
      }

      stage = 'COMPLETED';
      await this.prisma.$transaction([
        this.prisma.videoProcessingStage.update({
          where: { videoId_stage: { videoId, stage: 'COMPLETED' } },
          data: { status: 'COMPLETED', progress: 100, completedAt: new Date(), error: null }
        }),
        this.prisma.processingJob.update({
          where: { id: processingJobId },
          data: { status: 'COMPLETED', progress: 100, completedAt: new Date(), error: null,
            telemetry: performance as unknown as Prisma.InputJsonValue }
        })
      ]);
      this.logger.log(JSON.stringify({
        requestedAiMode: performance.requestedAiMode,
        effectiveAiMode: performance.effectiveAiMode,
        provider: performance.clipUnderstanding.provider || 'openai',
        model: performance.clipUnderstanding.model || 'gpt-5.6-luna',
        clipDecisionSource: performance.clipDecisionSource,
        selectedClipCount: performance.selectedClipTimestamps.length,
        selectedClipTimestamps: performance.selectedClipTimestamps,
        cloudLlmCalls: performance.cloudLlmCalls,
        localLlmCalls: performance.localLlmCalls,
        deterministicFallbackUsed: performance.deterministicFallbackUsed,
        event: 'online_clip_verification_summary'
      }));
      await job.updateProgress(100);
      this.logger.log('Processing job completed 100%');
    } catch (error) {
      stageClock.checkpoint(stage, 'FAILED');
      this.logProcessingError(error, stage, { processingJobId, videoId });
      const message = formatProcessingJobError(error).slice(0, 2000);
      const mediaError = isMediaProcessingError(error) ? error : undefined;
      await this.prisma.$transaction([
        this.prisma.videoProcessingStage.updateMany({
          where: { videoId, stage: { in: [stage, 'FAILED'] }, status: { not: 'COMPLETED' } },
          data: { status: 'FAILED', completedAt: new Date(), error: message }
        }),
        this.prisma.processingJob.update({
          where: { id: processingJobId },
          data: { status: 'FAILED', completedAt: new Date(), error: message,
            errorCode: mediaError?.code ?? null, retryable: mediaError ? mediaError.retryable : true,
            telemetry: performance as unknown as Prisma.InputJsonValue }
        })
      ]);
      throw error;
    } finally {
      await frameWork;
      await understandingWork;
      performance.totalMs = Date.now() - processStarted;
      this.logger.log(JSON.stringify({ event: 'pipeline_performance_summary', videoId,
        processingJobId, ...performance }));
      if (workDirectory) await rm(workDirectory, { recursive: true, force: true });
    }
  }

  private async extractMultimodalFrames(sourcePath: string, directory: string,
    duration: number | null) {
    const interval = Math.max(2, (duration || 60) / 12);
    const outputPattern = join(directory, 'multimodal-frame-%03d.jpg');
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', sourcePath, '-vf',
      `fps=1/${interval},scale=480:-2`, '-frames:v', '12', '-q:v', '5', outputPattern],
    { maxBuffer: 10 * 1024 * 1024 });
    const names = (await readdir(directory)).filter((name) =>
      /^multimodal-frame-\d+\.jpg$/u.test(name)).sort();
    return Promise.all(names.map(async (name) => ({ mimeType: 'image/jpeg',
      data: (await readFile(join(directory, name))).toString('base64') })));
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.connection.quit();
  }
}
