import { UsageService } from '../auth/usage.service';
import { ModuleRef } from '@nestjs/core';
import { LlmRouterService } from '../processing/llm-router.service';
import { interpretBrief, scoreCandidatesWithOpenAi } from '../edit-mode/styles/creative-brief';
import { GenerationStylingService } from '../edit-mode/styles/generation-styling.service';
import { BadRequestException, ConflictException, Injectable, NotFoundException,
  OnApplicationBootstrap, OnModuleDestroy, Optional, UnprocessableEntityException } from "@nestjs/common";
import { Prisma, ProcessingStage } from '@prisma/client';
import { QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { VIDEO_PROCESSING_QUEUE } from '../processing/processing.constants';
import { Logger } from '@nestjs/common';
import { randomUUID } from "crypto";
import { extname } from "path";
import { PrismaService } from "../database/prisma.service";
import { generatedClipEditLink } from '../edit-mode/generated-clip-edit-link';
import { editAssetOwnsStorage, editAssetStorageLocation } from '../edit-mode/edit-asset-storage';
import { resolveGenerationStyleReadiness } from './clip-selection.service';
import { StorageService } from "../storage/storage.service";
import { ProcessingQueueService } from "../processing/processing-queue.service";

import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  calculateClipRecommendation,
  recommendationTierForScore
} from '../processing/clip-candidates';
import { ClipExportService } from './clip-export.service';
import { ClipCreationRequest, ClipSelectionService } from './clip-selection.service';
import { ClipRenderQueueService } from './clip-render-queue.service';
import { isVideoTooLong, maxClipCountForDuration, parseTargetPlatform, VIDEO_TOO_LONG_MESSAGE }
  from '../processing/clip-selection-policy';
import { normalizeAiProcessingMode } from '../processing/ai-processing-mode';
import { parseProcessingType, parseOutputAspectRatio } from '../processing/processing-type';
import { isRetryableErrorCode, MEDIA_ERROR_MESSAGES, MediaErrorCode } from '../processing/media-probe';

const execFileAsync = promisify(execFile);

/** Persist routing diagnostics server-side while keeping product responses free of model names. */
export function publicVideoMetadata<T>(value: T): T {
  if (Array.isArray(value)) return value.map(publicVideoMetadata) as T;
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const hidden = new Set(['internal', '_intelligenceInternal', 'provider', 'model', 'providerMetadata', 'routes']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !hidden.has(key))
    .map(([key, item]) => [key, publicVideoMetadata(item)])) as T;
}

/** Best-effort pre-storage duration read; the worker re-probes and remains authoritative. */
async function probeUploadDuration(buffer: Buffer, originalName: string) {
  if (!buffer?.length) return null;
  const directory = await mkdtemp(join(tmpdir(), 'ai-content-upload-'));
  try {
    const path = join(directory, `upload${extname(originalName) || '.bin'}`);
    await writeFile(path, buffer);
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 30000 });
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Same probe for an upload multer already wrote to disk (no copy, no buffer). */
async function probeUploadPath(path: string) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 30000 });
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

const serializeCandidate = <T extends {
  contentPotential: number;
  [key: string]: unknown;
}>(candidate: T) => ({
  ...publicVideoMetadata(candidate),
  recommendationTier: recommendationTierForScore(candidate.contentPotential)
});

const serializeGeneratedClip = (clip: {
  sizeBytes: bigint;
  id: string;
  candidate?: ({ contentPotential: number; [key: string]: unknown }) | null;
  editProject?: { id: string } | null;
  [key: string]: unknown;
}) => {
  const { editProject, ...data } = clip;
  return ({
  ...publicVideoMetadata(data),
  ...generatedClipEditLink(editProject),
  candidate: clip.candidate ? serializeCandidate(clip.candidate) : clip.candidate,
  sizeBytes: Number(clip.sizeBytes),
  playbackUrl: `/generated-clips/${clip.id}/file`
  });
};

const serializeVideo = (video: {
  id: string;
  sizeBytes: bigint;
  bitrate?: bigint | null;
  transcript?: { id: string } | null;
  _count?: { chunks: number };
  [key: string]: unknown;
}) => {
  const { transcript, _count, ...data } = video;
  return {
    ...publicVideoMetadata(data),
    hasTranscript: !!transcript,
    hasChunks: (_count?.chunks ?? 0) > 0,
    sizeBytes: Number(video.sizeBytes),
    bitrate: video.bitrate == null ? video.bitrate : Number(video.bitrate)
  };
};

@Injectable()
export class VideosService implements OnApplicationBootstrap, OnModuleDestroy {
  private get usage() { return new UsageService(this.prisma); }
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly processingQueue: ProcessingQueueService,
    private readonly clipExporter: ClipExportService = new ClipExportService(prisma, storage),
    @Optional() private readonly clipRenderQueue?: ClipRenderQueueService,
    @Optional() private readonly llm?: LlmRouterService,
    @Optional() private readonly moduleRef?: ModuleRef
  ) {
    // Steps 9-12: the unified-generation collaborators. Each is optional, so the
    // selection engine still runs (deterministically) in scripts and tests.
    this.clipSelection = new ClipSelectionService(prisma, clipExporter, clipRenderQueue, {
      interpretBrief: async (brief, aiMode) => interpretBrief({ brief,
        llm: aiMode === 'ONLINE' ? this.llm ?? null : null, logger: this.logger, aiMode }),
      semanticIntentScores: async (candidates, settings, aiMode) => aiMode === 'ONLINE' && this.llm
        ? scoreCandidatesWithOpenAi({ llm: this.llm, brief: settings.brief,
          intent: settings.interpreted.intent, candidates, logger: this.logger, aiMode }) : null,
      referenceStyle: async (referenceId) => {
        const reference = await this.prisma.referenceAsset.findUnique({ where: { id: referenceId } });
        return reference?.status === 'READY' && reference.derivedStyle &&
          typeof reference.derivedStyle === 'object' ? reference.derivedStyle as Record<string, unknown> : null;
      },
      savedStyles: async (ids) => {
        const rows = await this.prisma.savedStyle.findMany({ where: { id: { in: ids } } });
        return Object.fromEntries(rows.map((row) => [row.id, { category: row.category as never,
          spec: row.spec as never, name: row.name }]));
      },
      afterDelivery: async (videoId) => {
        const styling = this.moduleRef?.get(GenerationStylingService, { strict: false });
        if (styling) await styling.ensureStyled(videoId);
      }
    });
  }

  private readonly clipSelection: ClipSelectionService;

  async onApplicationBootstrap() {
    if (!this.clipRenderQueue) return;
    this.clipRenderQueue.start({
      process: (request) => this.clipSelection.processRequest(request),
      failed: (request, error) => this.clipSelection.markFailed(request, error)
    });
    // Requests orphaned by a previous shutdown become retryable instead of staying RENDERING.
    await this.clipSelection.recoverStaleRenders().catch((error: unknown) =>
      this.logger.warn(`Stale clip render recovery failed: ${
        error instanceof Error ? error.message : String(error)}`));
    // One-step entry: start the pre-selected clip request the moment analysis completes.
    // The queue id is the ProcessingJob id. The sweep covers events missed across restarts.
    this.analysisEvents = new QueueEvents(VIDEO_PROCESSING_QUEUE, { connection:
      new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null }) });
    this.analysisEvents.on('completed', ({ jobId }) => void this.startAutoGeneration(jobId));
    this.analysisEvents.on('error', (error) => this.logger.warn(`Analysis events: ${error.message}`));
    this.autoGenerationSweep = setInterval(() => void this.sweepAutoGeneration(), 15_000);
    await this.sweepAutoGeneration();
  }

  private analysisEvents?: QueueEvents;
  private autoGenerationSweep?: NodeJS.Timeout;

  async onModuleDestroy() {
    if (this.autoGenerationSweep) clearInterval(this.autoGenerationSweep);
    await this.analysisEvents?.close().catch(() => undefined);
  }

  /**
   * Attach a pre-selected clip request to an existing source (a re-imported YouTube video).
   * Starts it now when analysis is already complete, otherwise when it completes.
   */
  async requestAutoGeneration(videoId: string, request: ClipCreationRequest, reservationKey?: string | null) {
    const job = await this.prisma.processingJob.findFirst({ where: { videoId },
      orderBy: { createdAt: 'desc' } });
    if (!job) return;
    await this.prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ProcessingJob" WHERE id = ${job.id} FOR UPDATE`;
    const current = await tx.processingJob.findUniqueOrThrow({ where: { id: job.id } });
    if (reservationKey && ['QUEUED', 'RENDERING'].includes(current.clipRenderStatus ?? '')) throw new ConflictException('Generation is already in progress.');
    if (reservationKey) await tx.creditReservation.update({ where: { jobKey: reservationKey }, data: { resourceId: job.id } });
    await tx.processingJob.update({ where: { id: job.id }, data: {
      ...(reservationKey ? { creditReservationKey: reservationKey } : {}),
      autoGeneration: request as unknown as Prisma.InputJsonValue,
      autoGenerationStatus: 'PENDING', autoGenerationError: null } });
    });
    if (job.status === 'COMPLETED') await this.startAutoGeneration(job.id);
  }

  /**
   * Hands the stored request to the ordinary clip-selection path - the same call the
   * "Create clips" button makes - so there is no second generation pipeline. The claim makes
   * concurrent triggers (queue event + sweep) start it once; create() is idempotent anyway.
   */
  async startAutoGeneration(processingJobId: string) {
    try {
      const claimed = await this.prisma.processingJob.updateMany({ where: { id: processingJobId,
        status: 'COMPLETED', autoGenerationStatus: 'PENDING' },
        data: { autoGenerationStatus: 'STARTING' } });
      if (!claimed.count) return;
      const job = await this.prisma.processingJob.findUniqueOrThrow({ where: { id: processingJobId } });
      let request = job.autoGeneration as unknown as ClipCreationRequest & { adjustedFrom?: number };
      // A YouTube link's length is unknown when the user picks a count. If the count is above
      // what this video allows, make the most it allows and record the change for the page.
      const video = await this.prisma.video.findUniqueOrThrow({ where: { id: job.videoId },
        select: { duration: true } });
      const allowed = maxClipCountForDuration(video.duration);
      const asked = Number(request.requestedClipCount);
      if (allowed > 0 && Number.isFinite(asked) && asked > allowed) {
        request = { ...request, requestedClipCount: allowed, adjustedFrom: asked };
        await this.prisma.processingJob.update({ where: { id: job.id },
          data: { autoGeneration: request as unknown as Prisma.InputJsonValue } });
        this.logger.warn(JSON.stringify({ event: 'auto_generation_count_adjusted', videoId: job.videoId,
          asked, allowed, durationSec: video.duration }));
      }
      try {
        const { adjustedFrom: _adjusted, ...creation } = request;
        await this.clipSelection.create(job.videoId, { ...creation, regenerate: false });
        await this.prisma.processingJob.update({ where: { id: job.id },
          data: { autoGenerationStatus: 'STARTED', autoGenerationError: null } });
        this.logger.log(JSON.stringify({ event: 'auto_generation_started', videoId: job.videoId,
          processingJobId: job.id, requestedClipCount: request.requestedClipCount,
          templateId: request.generation?.templateId ?? null }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Clips could not be started.';
        await this.prisma.processingJob.update({ where: { id: job.id },
          data: { autoGenerationStatus: 'FAILED', autoGenerationError: message.slice(0, 500) } });
        this.logger.warn(`Auto generation for ${job.videoId} failed to start: ${message}`);
      }
    } catch (error) {
      this.logger.warn(`Auto generation check failed: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async sweepAutoGeneration() {
    try {
      // A claim left STARTING by a crash is released after two minutes.
      await this.prisma.processingJob.updateMany({ where: { autoGenerationStatus: 'STARTING',
        updatedAt: { lt: new Date(Date.now() - 120_000) } }, data: { autoGenerationStatus: 'PENDING' } });
      const ready = await this.prisma.processingJob.findMany({ where: { status: 'COMPLETED',
        autoGenerationStatus: 'PENDING' }, select: { id: true } });
      for (const job of ready) await this.startAutoGeneration(job.id);
    } catch (error) {
      this.logger.warn(`Auto generation sweep failed: ${
        error instanceof Error ? error.message : String(error)}`);
    }
  }

  async list(projectId?: string) {
    const videos = await this.prisma.video.findMany({
      where: projectId ? { projectId } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        processingStages: true,
        processingJobs: { orderBy: { createdAt: "desc" }, take: 1 },
        transcript: { select: { id: true } },
        _count: { select: { chunks: true } },
        project: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    return videos.map(serializeVideo);
  }

  async getTranscript(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        transcript: {
          include: { segments: { orderBy: { position: 'asc' } } }
        }
      }
    });

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (!video.transcript) {
      throw new NotFoundException('Transcript not found');
    }

    return video.transcript;
  }

  async getUnderstanding(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        understanding: {
          include: { chapters: { orderBy: { position: 'asc' } } }
        }
      }
    });
    if (!video) throw new NotFoundException('Video not found');
    if (!video.understanding) throw new NotFoundException('Video understanding not found');
    return video.understanding;
  }

  async retry(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: { processingJobs: { orderBy: { createdAt: 'desc' }, take: 1 } }
    });
    if (!video) throw new NotFoundException('Video not found');
    const job = video.processingJobs[0];
    if (!job) throw new ConflictException('Video has no processing job');
    const forceReprocess = process.env.FORCE_REPROCESS?.toLowerCase() === 'true';
    if (job.status === 'COMPLETED' && !forceReprocess) {
      throw new ConflictException('Video is already completed');
    }
    const errorCode = (job as typeof job & { errorCode?: string | null }).errorCode;
    if (job.status === 'FAILED' && !forceReprocess && !isRetryableErrorCode(errorCode)) {
      throw new UnprocessableEntityException({
        code: errorCode,
        message: (errorCode && MEDIA_ERROR_MESSAGES[errorCode as MediaErrorCode]) ||
          job.error || 'This video cannot be retried automatically. Please upload another source file.',
        retryable: false
      });
    }
    try {
      await this.processingQueue.resume({ videoId, processingJobId: job.id,
        aiMode: normalizeAiProcessingMode((job as typeof job & { aiMode?: unknown }).aiMode) }, async () => {
        await this.prisma.processingJob.update({
          where: { id: job.id },
          data: { status: 'PENDING', error: null, errorCode: null, retryable: true, completedAt: null }
        });
      });
    } catch (error) {
      await this.prisma.processingJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: error instanceof Error ? error.message.slice(0, 2000) : 'Retry enqueue failed' }
      });
      throw error;
    }
    return this.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
  }

  async delete(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        processingJobs: { select: { id: true } },
        generatedClips: { select: { bucket: true, objectKey: true } },
        referenceAssets: { select: { bucket: true, objectKey: true } }
      }
    });
    if (!video) throw new NotFoundException('Video not found');

    for (const job of video.processingJobs) {
      if (!await this.processingQueue.remove(job.id)) {
        throw new ConflictException('Video is currently processing');
      }
    }

    await this.prisma.video.delete({ where: { id: videoId } });
    const objects = [
      { bucket: video.bucket, objectKey: video.objectKey },
      video.audioBucket && video.audioObjectKey
        ? { bucket: video.audioBucket, objectKey: video.audioObjectKey }
        : null,
      ...video.generatedClips,
      // Unified generation objects: reference uploads (rows cascade with the Video) and the
      // cached source poster. Removing an absent poster is a harmless no-op.
      ...video.referenceAssets,
      { bucket: video.bucket, objectKey: `previews/${video.id}/poster.jpg` }
    ].filter((value): value is { bucket: string; objectKey: string } => value !== null);
    await Promise.all(objects.map(({ bucket, objectKey }) =>
      this.storage.removeObject(bucket, objectKey).catch((error) => {
        this.logger.warn(`Could not remove stored object ${bucket}/${objectKey}: ${
          error instanceof Error ? error.message : String(error)
        }`);
      })
    ));
    return { id: videoId, deleted: true };
  }

  async getChunks(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { chunks: { orderBy: { position: 'asc' } } }
    });
    if (!video) throw new NotFoundException('Video not found');
    return video.chunks;
  }

  async getChunkAnalysis(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        chunks: {
          orderBy: { position: 'asc' },
          select: { analysis: true }
        }
      }
    });
    if (!video) throw new NotFoundException('Video not found');
    return video.chunks.flatMap(({ analysis }) => analysis ? [analysis] : []);
  }

  async getClipCandidates(videoId: string, limit: number) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId }, select: { id: true }
    });
    if (!video) throw new NotFoundException('Video not found');
    const candidates = await this.prisma.clipCandidate.findMany({
      where: { videoId, reject: false, rank: { not: null } },
      orderBy: [{ contentPotential: 'desc' }, { rank: 'asc' }],
      take: limit
    });
    return candidates.map(serializeCandidate);
  }

  async getClipRecommendations(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        duration: true,
        clipCandidates: {
          where: { reject: false, rank: { not: null } },
          orderBy: [{ contentPotential: 'desc' }, { rank: 'asc' }]
        }
      }
    });
    if (!video) throw new NotFoundException('Video not found');
    const inferredDuration = video.clipCandidates.reduce((maximum, candidate) =>
      Math.max(maximum, candidate.endTime), 0);
    const videoDuration = video.duration ?? inferredDuration;
    const recommendation = calculateClipRecommendation(video.clipCandidates, videoDuration);
    const candidates = video.clipCandidates
      .filter((candidate) => recommendationTierForScore(candidate.contentPotential) !== null)
      .map(serializeCandidate);
    return { videoDuration, ...recommendation, candidates };
  }

  selectClips(videoId: string, request: ClipCreationRequest) {
    return this.clipSelection.create(videoId, request);
  }

  getClipAnalysis(videoId: string) {
    return this.clipSelection.getAnalysis(videoId);
  }

  getClipResults(videoId: string) {
    return this.clipSelection.getResults(videoId);
  }

  async getGeneratedClips(videoId: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId }, select: { id: true } });
    if (!video) throw new NotFoundException('Video not found');
    const clips = await this.prisma.generatedClip.findMany({
      where: { videoId }, orderBy: { createdAt: 'asc' },
      include: { candidate: true, editProject: { select: { id: true } } }
    });
    return clips.map(serializeGeneratedClip);
  }

  /** Public product view of persisted renders. Internal project and job identities stay server-side. */
  /**
   * Every clip, newest first, as History cards. History lists all clips, so it must not load the
   * large per-row JSON (candidate scoring, edit telemetry, edit settings, job telemetry - about
   * 50 KB per clip): only scalar columns, plus the four JSON keys the cards use, read in SQL.
   */
  async getHistory() {
    const clips = await this.prisma.generatedClip.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true, createdAt: true, duration: true, processingType: true, thumbnailObjectKey: true,
        templateId: true, requestedTemplate: true,
        candidate: { select: { bestHook: true, hookCandidate: true, synopsis:true, caption:true, hashtags:true } },
        editProject: { select: { id: true } },
        video: { select: { originalName: true,
          processingJobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { aiMode: true } } } }
      }
    });
    if (!clips.length) return [];
    const extracted = await this.prisma.$queryRaw<Array<{ id: string; hookRendered: boolean | null;
      hookFinalText: string | null; selectedHook:string|null; synopsis:string|null; captions:Prisma.JsonValue|null;
      hashtags:Prisma.JsonValue|null; understandingVersion:string|null; generationStyle: Prisma.JsonValue | null; effectiveAiMode: string | null }>>`
      SELECT g."id",
        (g."editTelemetry"->>'hookRendered') = 'true' AS "hookRendered",
        g."editTelemetry"->>'hookFinalText' AS "hookFinalText",
        g."contentPackaging"->'sharedPackage'->>'selectedHook' AS "selectedHook",
        g."contentPackaging"->>'synopsis' AS "synopsis",
        g."contentPackaging"->'sharedPackage'->'captions' AS "captions",
        g."contentPackaging"->'sharedPackage'->'hashtagSets' AS "hashtags",
        g."contentPackaging"->'sharedPackage'->'understanding'->>'version' AS "understandingVersion",
        e."settings"->'generationStyle' AS "generationStyle",
        (SELECT j."telemetry"->>'effectiveAiMode' FROM "ProcessingJob" j WHERE j."videoId" = g."videoId"
          ORDER BY j."createdAt" DESC LIMIT 1) AS "effectiveAiMode"
      FROM "GeneratedClip" g LEFT JOIN "EditProject" e ON e."generatedClipId" = g."id"
      WHERE g."id" IN (${Prisma.join(clips.map((clip) => clip.id))})`;
    const byId = new Map(extracted.map((row) => [row.id, row]));
    return clips.map((clip) => {
      const json = byId.get(clip.id);
      const editProject = clip.editProject
        ? { id: clip.editProject.id, settings: { generationStyle: json?.generationStyle ?? null } } : null;
      // Same rules as toClipCard: the rendered headline, else the candidate's hook.
      const renderedHook = clip.processingType === 'EDITED_CLIPS' && json?.hookRendered === true &&
        typeof json.hookFinalText === 'string' ? json.hookFinalText.trim() : '';
      const hook = renderedHook || json?.selectedHook || clip.candidate?.bestHook || clip.candidate?.hookCandidate || '';
      const firstCaption = Array.isArray(json?.captions) ? json.captions[0] as {text?:string}|undefined : undefined;
      const focused = Array.isArray(json?.hashtags) ? json.hashtags.find(s=>s && typeof s==='object' && !Array.isArray(s) && s.label==='Focused') as {hashtags?:string[]}|undefined : undefined;
      const styleState = resolveGenerationStyleReadiness({ editProject, templateId: clip.templateId,
        requestedTemplate: clip.requestedTemplate });
      const link = generatedClipEditLink(editProject);
      const style = clip.requestedTemplate ?? clip.templateId;
      const requiresStyle = style === 'AUTOMATIC_2';
      const styledReady = !!styleState?.playbackUrl &&
        ['EXPORT_READY', 'READY', 'LEGACY_STYLE_READY'].includes(styleState.status);
      const aiMode = json?.effectiveAiMode ?? clip.video.processingJobs[0]?.aiMode ?? '';
      return {
        id: clip.id,
        title: hook || `Clip from ${clip.video.originalName}`,
        hook, synopsis:json?.synopsis || clip.candidate?.synopsis || '',
        caption:firstCaption?.text || clip.candidate?.caption || '',
        hashtags:focused?.hashtags || clip.candidate?.hashtags || [], contentUnderstandingVersion:json?.understandingVersion || null,
        createdAt: clip.createdAt,
        duration: Math.round(clip.duration * 10) / 10,
        thumbnailUrl: clip.thumbnailObjectKey ? `/generated-clips/${clip.id}/poster` : null,
        playbackUrl: requiresStyle ? styledReady ? styleState!.playbackUrl : null : `/generated-clips/${clip.id}/file`,
        style: style === 'AUTOMATIC_2' ? 'StyleOne' : style === 'AUTOMATIC_RAW' ||
          clip.processingType === 'NORMAL_CLIPS' ? 'No Edit' : 'StyleZero',
        mode: String(aiMode) === 'ONLINE' ? 'XeePro' : 'XeeFree',
        status: requiresStyle && !styledReady
          ? styleState?.status === 'STYLE_FAILED' ? 'Something went wrong' : 'Applying style' : 'Ready',
        sourceLabel: clip.video.originalName,
        editUrl: link.editUrl,
        editable: link.isEditable,
        exportable: !requiresStyle || styledReady
      };
    });
  }

  async deleteGeneratedClip(clipId: string) {
    const clip = await this.prisma.generatedClip.findUnique({
      where: { id: clipId },
      include: { candidate: true, editProject: { include: { assets: true } } }
    });
    if (!clip) throw new NotFoundException('Clip not found');
    const generation = clip.generationJobId ? await this.prisma.processingJob.findUnique({
      where: { id: clip.generationJobId }, select: { clipRenderStatus: true } }) : null;
    if (generation && ['QUEUED', 'RENDERING'].includes(generation.clipRenderStatus ?? '')) {
      throw new ConflictException('This clip is still being created. Try again when it is ready.');
    }
    const style = resolveGenerationStyleReadiness(clip);
    if (style && ['STYLE_APPLYING', 'STYLE_READY', 'STYLING', 'RENDERING'].includes(style.status)) {
      throw new ConflictException('This clip is still being created. Try again when it is ready.');
    }
    const owned = clip.editProject?.assets.filter(editAssetOwnsStorage)
      .map(editAssetStorageLocation) ?? [];
    const objects = [
      { bucket: clip.bucket, objectKey: clip.objectKey },
      ...(clip.thumbnailObjectKey ? [{ bucket: clip.bucket, objectKey: clip.thumbnailObjectKey }] : []),
      ...owned
    ];
    // Removing storage first means a failed removal leaves a durable record for a safe retry.
    for (const object of objects) await this.storage.removeObject(object.bucket, object.objectKey);
    await this.prisma.$transaction(async (tx) => {
      if (clip.editProject) await tx.editProject.delete({ where: { id: clip.editProject.id } });
      await tx.generatedClip.delete({ where: { id: clipId } });
    });
    return { id: clipId, deleted: true };
  }

  /** Step 9.1: the uploaded source itself, range-served for the preview player. */
  async getVideoFile(videoId: string, rangeHeader?: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId },
      select: { bucket: true, objectKey: true, sizeBytes: true, mimeType: true } });
    if (!video) throw new NotFoundException('Video not found');
    const size = Number(video.sizeBytes);
    const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/u);
    if (!match) return { stream: await this.storage.getObject(video.bucket, video.objectKey),
      size, start: 0, end: size - 1, partial: false, mimeType: video.mimeType };
    const start = Math.max(0, Math.min(size - 1, match[1] ? Number(match[1]) : 0));
    const end = Math.max(start, Math.min(size - 1, match[2] ? Number(match[2]) : size - 1));
    return { stream: await this.storage.getPartialObject(video.bucket, video.objectKey, start,
      end - start + 1), size, start, end, partial: true, mimeType: video.mimeType };
  }

  /**
   * Step 9.1: a meaningful still of the source (a frame ~10% in, never a black
   * first frame), made once with FFmpeg seeking over HTTP and cached in storage.
   */
  async getVideoPoster(videoId: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId },
      select: { id: true, bucket: true, objectKey: true, duration: true } });
    if (!video) throw new NotFoundException('Video not found');
    const key = `previews/${video.id}/poster.jpg`;
    const cached = await this.storage.statObject(video.bucket, key).then(() => true, () => false);
    if (!cached) {
      const directory = await mkdtemp(join(tmpdir(), 'source-poster-'));
      try {
        const url = await this.storage.presignedGetUrl(video.bucket, video.objectKey, 300);
        const at = Math.max(0.5, Math.min(30, (video.duration ?? 10) * 0.1));
        const output = join(directory, 'poster.jpg');
        await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', url,
          '-frames:v', '1', '-vf', 'scale=720:-2', '-q:v', '4', output], { timeout: 60_000 });
        await this.storage.uploadFile({ filePath: output, objectKey: key, mimeType: 'image/jpeg' });
      } catch (error) {
        throw new NotFoundException(`Source preview not available: ${
          error instanceof Error ? error.message.slice(0, 160) : 'ffmpeg failed'}`);
      } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
    }
    return { stream: await this.storage.getObject(video.bucket, key), mimeType: 'image/jpeg' };
  }

  async getGeneratedClipFile(clipId: string, rangeHeader?: string) {
    const clip = await this.prisma.generatedClip.findUnique({ where: { id: clipId } });
    if (!clip) throw new NotFoundException('Generated clip not found');
    const size = Number(clip.sizeBytes);
    const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/u);
    if (!match) return { stream: await this.storage.getObject(clip.bucket, clip.objectKey),
      size, start: 0, end: size - 1, partial: false, mimeType: clip.mimeType };
    const requestedStart = match[1] ? Number(match[1]) : 0;
    const requestedEnd = match[2] ? Number(match[2]) : size - 1;
    const start = Math.max(0, Math.min(size - 1, requestedStart));
    const end = Math.max(start, Math.min(size - 1, requestedEnd));
    return { stream: await this.storage.getPartialObject(
      clip.bucket, clip.objectKey, start, end - start + 1
    ), size, start, end, partial: true, mimeType: clip.mimeType };
  }

  /**
   * The designed cover for an edited clip: the clip's own canvas carrying the
   * same headline, so the viewer sees the hook before pressing play instead of
   * whatever raw frame the browser decodes first.
   */
  async getGeneratedClipPoster(clipId: string) {
    const clip = await this.prisma.generatedClip.findUnique({ where: { id: clipId },
      select: { bucket: true, thumbnailObjectKey: true, thumbnailMimeType: true } });
    if (!clip) throw new NotFoundException('Generated clip not found');
    if (!clip.thumbnailObjectKey) throw new NotFoundException('Clip poster not available');
    return { stream: await this.storage.getObject(clip.bucket, clip.thumbnailObjectKey),
      mimeType: clip.thumbnailMimeType ?? 'image/jpeg' };
  }

  async getVisualAnalysis(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: {
        chunks: {
          orderBy: { position: 'asc' },
          select: { visualAnalysis: true }
        }
      }
    });
    if (!video) throw new NotFoundException('Video not found');
    return video.chunks.flatMap(({ visualAnalysis }) =>
      visualAnalysis ? [visualAnalysis] : []
    );
  }

  /**
   * Uploads arrive on disk (multer disk storage), so a long source is streamed to MinIO instead
   * of being held in Node memory (measured: +~500 MiB for a 383 MiB file). The temp file is
   * always removed, including when the upload is rejected. A buffer upload still works.
   */
  async createFromUpload(projectId: string, file: Express.Multer.File, requestedAiMode?: unknown,
    requestedProcessingType?: unknown, requestedAspectRatio?: unknown, requestedPlatform?: unknown,
    source?: { sourceUrl: string; externalVideoId: string; creditReservationKey?: string | null },
    autoGeneration?: ClipCreationRequest | null) {
    try {
      return await this.createFromUploadFile(projectId, file, requestedAiMode, requestedProcessingType,
        requestedAspectRatio, requestedPlatform, source, autoGeneration);
    } finally {
      if (file?.path) await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  private async createFromUploadFile(projectId: string, file: Express.Multer.File, requestedAiMode?: unknown,
    requestedProcessingType?: unknown, requestedAspectRatio?: unknown, requestedPlatform?: unknown,
    source?: { sourceUrl: string; externalVideoId: string; creditReservationKey?: string | null },
    autoGeneration?: ClipCreationRequest | null) {
    const aiMode = normalizeAiProcessingMode(requestedAiMode);
    const targetPlatform = parseTargetPlatform(requestedPlatform);
    const processingType = parseProcessingType(requestedProcessingType);
    const outputAspectRatio = processingType === 'EDITED_CLIPS'
      ? parseOutputAspectRatio(requestedAspectRatio) : null;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true }
    });

    if (!project) {
      throw new NotFoundException("Project not found");
    }

    // Reject over-limit sources before storing them or spending any analysis on them.
    const onDisk = typeof file.path === 'string' && file.path.length > 0;
    if (isVideoTooLong(onDisk ? await probeUploadPath(file.path)
      : await probeUploadDuration(file.buffer, file.originalname))) {
      throw new BadRequestException({ code: 'VIDEO_TOO_LONG', message: VIDEO_TOO_LONG_MESSAGE });
    }

    const objectKey = `projects/${projectId}/videos/${randomUUID()}${extname(file.originalname)}`;
    const stored = onDisk
      ? await this.storage.uploadFile({ filePath: file.path, objectKey, mimeType: file.mimetype })
      : await this.storage.uploadVideo({ buffer: file.buffer, objectKey, mimeType: file.mimetype });
    if (source) {
      try {
        const storedStat = await this.storage.statObject(stored.bucket, stored.objectKey);
        if (Number(storedStat.size) !== file.size) throw new Error('Stored source size mismatch');
      } catch (error) {
        await this.storage.removeObject(stored.bucket, stored.objectKey).catch(() => undefined);
        throw error;
      }
    }

    const video = await this.prisma.$transaction(async tx => {
      const video = await tx.video.create({
      data: {
        projectId,
        originalName: file.originalname,
        ...(source ? { sourceType: 'YOUTUBE', sourceUrl: source.sourceUrl,
          externalVideoId: source.externalVideoId } : {}),
        objectKey: stored.objectKey,
        bucket: stored.bucket,
        mimeType: file.mimetype,
        sizeBytes: BigInt(file.size),
        targetPlatform,
        processingJobs: { create: { status: "PENDING", aiMode, processingType,
          outputAspectRatio, ...(autoGeneration ? { autoGeneration,
            autoGenerationStatus: 'PENDING' } : {}) } },
        processingStages: {
          create: Object.values(ProcessingStage).map((stage) => ({
            stage,
            status: stage === 'UPLOADED' ? 'COMPLETED' : 'PENDING',
            progress: stage === 'UPLOADED' ? 100 : 0,
            startedAt: stage === 'UPLOADED' ? new Date() : null,
            completedAt: stage === 'UPLOADED' ? new Date() : null
          }))
        }
      } as never,
      include: { processingJobs: true }
    });
      if (autoGeneration) {
        const owner = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { userId: true } });
        const key = source?.creditReservationKey ?? `analysis:${video.processingJobs[0].id}`;
        await this.usage.reserve(tx, owner.userId, key, 'CREATE_CLIPS', video.processingJobs[0].id);
        await tx.creditReservation.update({ where: { jobKey: key }, data: { resourceId: video.processingJobs[0].id } });
        await tx.processingJob.update({ where: { id: video.processingJobs[0].id }, data: { creditReservationKey: key } });
      }
      return video;
    }).catch(async error => { await this.storage.removeObject(stored.bucket, stored.objectKey).catch(() => undefined); throw error; });

    const processingJob = video.processingJobs[0];
    try {
      await this.processingQueue.enqueue({
        processingJobId: processingJob.id,
        videoId: video.id,
        aiMode
      });
    } catch (error) {
      await this.prisma.processingJob.update({
        where: { id: processingJob.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: error instanceof Error
            ? error.message.slice(0, 2000)
            : "Could not enqueue processing job"
        }
      });
      throw error;
    }

    return serializeVideo(video);
  }
}
