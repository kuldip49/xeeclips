import { BadRequestException, ConflictException, Injectable, NotFoundException,
  OnApplicationBootstrap, Optional, UnprocessableEntityException } from "@nestjs/common";
import { ProcessingStage } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { randomUUID } from "crypto";
import { extname } from "path";
import { PrismaService } from "../database/prisma.service";
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
import { isVideoTooLong, parseTargetPlatform, VIDEO_TOO_LONG_MESSAGE }
  from '../processing/clip-selection-policy';
import { normalizeAiProcessingMode } from '../processing/ai-processing-mode';
import { parseProcessingType, parseOutputAspectRatio } from '../processing/processing-type';
import { isRetryableErrorCode, MEDIA_ERROR_MESSAGES, MediaErrorCode } from '../processing/media-probe';

const execFileAsync = promisify(execFile);

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

const serializeCandidate = <T extends {
  contentPotential: number;
  [key: string]: unknown;
}>(candidate: T) => ({
  ...candidate,
  recommendationTier: recommendationTierForScore(candidate.contentPotential)
});

const serializeGeneratedClip = (clip: {
  sizeBytes: bigint;
  id: string;
  candidate?: ({ contentPotential: number; [key: string]: unknown }) | null;
  [key: string]: unknown;
}) => ({
  ...clip,
  candidate: clip.candidate ? serializeCandidate(clip.candidate) : clip.candidate,
  sizeBytes: Number(clip.sizeBytes),
  playbackUrl: `/generated-clips/${clip.id}/file`
});

const serializeVideo = (video: {
  sizeBytes: bigint;
  bitrate?: bigint | null;
  transcript?: { id: string } | null;
  _count?: { chunks: number };
  [key: string]: unknown;
}) => {
  const { transcript, _count, ...data } = video;
  return {
    ...data,
    hasTranscript: !!transcript,
    hasChunks: (_count?.chunks ?? 0) > 0,
    sizeBytes: Number(video.sizeBytes),
    bitrate: video.bitrate == null ? video.bitrate : Number(video.bitrate)
  };
};

@Injectable()
export class VideosService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly processingQueue: ProcessingQueueService,
    private readonly clipExporter: ClipExportService = new ClipExportService(prisma, storage),
    @Optional() private readonly clipRenderQueue?: ClipRenderQueueService
  ) {
    this.clipSelection = new ClipSelectionService(prisma, clipExporter, clipRenderQueue);
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
        generatedClips: { select: { bucket: true, objectKey: true } }
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
      ...video.generatedClips
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
      where: { videoId }, orderBy: { createdAt: 'asc' }, include: { candidate: true }
    });
    return clips.map(serializeGeneratedClip);
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

  async createFromUpload(projectId: string, file: Express.Multer.File, requestedAiMode?: unknown,
    requestedProcessingType?: unknown, requestedAspectRatio?: unknown, requestedPlatform?: unknown) {
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
    if (isVideoTooLong(await probeUploadDuration(file.buffer, file.originalname))) {
      throw new BadRequestException({ code: 'VIDEO_TOO_LONG', message: VIDEO_TOO_LONG_MESSAGE });
    }

    const objectKey = `projects/${projectId}/videos/${randomUUID()}${extname(file.originalname)}`;
    const stored = await this.storage.uploadVideo({
      buffer: file.buffer,
      objectKey,
      mimeType: file.mimetype
    });

    const video = await this.prisma.video.create({
      data: {
        projectId,
        originalName: file.originalname,
        objectKey: stored.objectKey,
        bucket: stored.bucket,
        mimeType: file.mimetype,
        sizeBytes: BigInt(file.size),
        targetPlatform,
        processingJobs: { create: { status: "PENDING", aiMode, processingType,
          outputAspectRatio } },
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
