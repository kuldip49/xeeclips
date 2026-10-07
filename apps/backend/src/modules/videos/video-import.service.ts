import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy,
  OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { VideosService } from './videos.service';
import { AttemptLog, DownloadResult, ImportError, importFailure, ImportMetadata, parseYouTubeUrl,
  YouTubeImportAdapter } from './youtube-import.adapter';
import { normalizeImportedMedia, NormalizedMedia } from './media-normalize';
import { normalizeAiProcessingMode } from '../processing/ai-processing-mode';
import { parseProcessingType, parseOutputAspectRatio } from '../processing/processing-type';
import { parseTargetPlatform } from '../processing/clip-selection-policy';
import { StorageService } from '../storage/storage.service';
import { parseAutoGeneration } from './auto-generation';
import { ClipCreationRequest } from './clip-selection.service';
import { Prisma } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { UsageService } from '../auth/usage.service';
import { randomUUID } from 'crypto';

const QUEUE = 'video-import';
const JOB = 'import-youtube';

@Injectable()
export class VideoImportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoImportService.name);
  private readonly adapter = new YouTubeImportAdapter();
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379',
    { maxRetriesPerRequest: null });
  private readonly queue = new Queue<{ importId: string }, unknown, string>(QUEUE, { connection: this.connection });
  private worker?: Worker<{ importId: string }>;
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly prisma: PrismaService, private readonly videos: VideosService,
    private readonly storage: StorageService) {}

  async onModuleInit() {
    const enabled = process.env.YOUTUBE_IMPORT_APPROVED === 'true';
    // Log the retriever actually on PATH so a stale or missing binary is visible at startup.
    void this.adapter.describeBinary().then((binary) => {
      const { config } = this.adapter;
      this.logger.log(JSON.stringify({ event: 'youtube_import_config', enabled, ...binary,
        connectTimeoutSec: config.connectTimeoutSec, totalTimeoutSec: config.totalTimeoutMs / 1000,
        stallTimeoutSec: config.stallTimeoutMs / 1000, maxDurationSec: config.maxDuration,
        maxBytes: config.maxBytes, maxAttempts: config.maxAttempts }));
      if (enabled && !binary.version) this.logger.error(`YouTube importing is enabled but ${binary.binary} could not be run`);
    });
    this.worker = new Worker(QUEUE, async (job) => this.process(job.data.importId),
      { connection: new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379',
        { maxRetriesPerRequest: null }), concurrency: this.adapter.config.concurrency });
    this.worker.on('error', (error) => this.logger.error(`Import worker: ${error.message}`));
    // This process is the only import worker, so a row still IMPORTING at boot lost its worker to
    // a crash (a clean shutdown requeues its own imports). Two quiet minutes is enough to be sure.
    const staleAfterMs = 2 * 60_000;
    await this.prisma.videoImport.updateMany({ where: { status: 'IMPORTING',
      updatedAt: { lt: new Date(Date.now() - staleAfterMs) } },
      data: { status: 'PENDING', stage: 'FETCHING_INFO', progress: 0 } });
    const pending = await this.prisma.videoImport.findMany({ where: { status: 'PENDING' },
      select: { id: true } });
    for (const row of pending) await this.enqueue(row.id);
  }

  async onModuleDestroy() {
    // A restart is not a user cancel: interrupted imports go back to PENDING and resume on boot.
    for (const controller of this.running.values()) controller.abort(new ImportError('IMPORT_INTERRUPTED',
      'Import was interrupted by a restart and will resume.'));
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }

  async submit(body: Record<string, unknown>) {
    const parsed = parseYouTubeUrl(body.url);
    if (body.rightsConfirmed !== true) throw new ImportError('MEDIA_ACCESS_DENIED',
      'Confirm you have the right to process this video, or upload the video file instead.');
    // Deployment-level eligibility stays a server decision; users only see the outcome.
    if (process.env.YOUTUBE_IMPORT_APPROVED !== 'true') throw new ImportError('IMPORT_UNAVAILABLE',
      "YouTube links can't be imported right now. You can upload the video file instead.");
    if (typeof body.projectId !== 'string') throw new ImportError('INVALID_PROJECT', 'Select a project.');
    const project = await this.prisma.project.findUnique({ where: { id: body.projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');
    const settings = {
      aiMode: normalizeAiProcessingMode(body.aiMode),
      processingType: parseProcessingType(body.processingType),
      outputAspectRatio: parseOutputAspectRatio(body.aspectRatio),
      targetPlatform: parseTargetPlatform(body.targetPlatform)
    };
    // One-step entry: the chosen template/count/brief travel with the import and are handed
    // to clip selection once the canonical Video's analysis completes.
    const autoGeneration = parseAutoGeneration(body.generationRequest);
    const autoGenerationJson = autoGeneration
      ? autoGeneration as unknown as Prisma.InputJsonValue : Prisma.DbNull;
    const where = { projectId_provider_externalVideoId: {
      projectId: project.id, provider: 'YOUTUBE', externalVideoId: parsed.externalVideoId } };
    const found = await this.prisma.videoImport.findUnique({ where });
    if (found) {
      // The latest choice wins, so a resubmitted link never resets the user's settings.
      const existing = await this.prisma.$transaction(async tx => {
        const row = await tx.videoImport.update({ where: { id: found.id }, data: { autoGeneration: autoGenerationJson } });
        return ['PENDING', 'IMPORTING'].includes(row.status) ? this.reserveImport(tx, row) : row;
      });
      if (existing.status === 'READY' && existing.videoId) {
        if (autoGeneration) await this.videos.requestAutoGeneration(existing.videoId, autoGeneration);
        return this.publicJob(existing);
      }
      if (existing.status === 'PENDING' || existing.status === 'IMPORTING') return this.publicJob(existing);
      return this.retry(existing.id);
    }
    const row = await this.prisma.$transaction(async tx => {
      const row = await tx.videoImport.upsert({ where, update: {},
      create: { projectId: project.id, provider: 'YOUTUBE',
        externalVideoId: parsed.externalVideoId, sourceUrl: parsed.sourceUrl, ...settings,
        autoGeneration: autoGenerationJson } });
      return row.status === 'PENDING' ? this.reserveImport(tx, row) : row;
    });
    if (row.status === 'READY' && row.videoId) return this.publicJob(row);
    if (row.status === 'IMPORT_FAILED' || row.status === 'CANCELLED' || row.status === 'READY')
      return this.retry(row.id);
    try { await this.enqueue(row.id); } catch {
      await this.fail(row.id, 'IMPORT_UNAVAILABLE', "YouTube import isn't available right now. You can upload the video file instead.");
      throw new ImportError('IMPORT_UNAVAILABLE', "YouTube import isn't available right now. You can upload the video file instead.");
    }
    return this.publicJob(row);
  }

  async list(projectId: string) {
    return (await this.prisma.videoImport.findMany({ where: { projectId },
      orderBy: { createdAt: 'desc' } })).map((row) => this.publicJob(row));
  }

  private async reserveImport(tx: Prisma.TransactionClient, row: Prisma.VideoImportGetPayload<{}>) {
    await tx.$queryRaw`SELECT id FROM "VideoImport" WHERE id = ${row.id} FOR UPDATE`;
    row = await tx.videoImport.findUniqueOrThrow({ where: { id: row.id } });
    if (!row.autoGeneration) return row;
    const reservation = row.creditReservationKey ? await tx.creditReservation.findUnique({ where: { jobKey: row.creditReservationKey } }) : null;
    if (reservation?.status === 'RESERVED') return row;
    const key = `import:${row.id}:${randomUUID()}`;
    const owner = await tx.project.findUniqueOrThrow({ where: { id: row.projectId } });
    await new UsageService(this.prisma).reserve(tx, owner.userId, key, 'CREATE_CLIPS', `import:${row.id}`);
    return tx.videoImport.update({ where: { id: row.id }, data: { creditReservationKey: key } });
  }

  async get(id: string) {
    const row = await this.prisma.videoImport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Import not found');
    return this.publicJob(row);
  }

  async retry(id: string) {
    const row = await this.prisma.videoImport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Import not found');
    if (row.status === 'READY' && row.videoId) return this.publicJob(row);
    if (row.status === 'IMPORTING' || row.status === 'PENDING')
      throw new ConflictException('Import is already running');
    const queued = await this.queue.getJob(id);
    if (queued && await queued.isActive()) throw new ConflictException('Import is still stopping');
    if (queued) await queued.remove();
    const updated = await this.prisma.$transaction(async tx => {
      const row = await tx.videoImport.update({ where: { id }, data: { status: 'PENDING', stage: 'FETCHING_INFO', progress: 0, error: null, errorCode: null } });
      return this.reserveImport(tx, row);
    });
    try { await this.enqueue(id); } catch {
      await this.fail(id, 'IMPORT_UNAVAILABLE', 'Import could not be queued. Please try again.');
      throw new ImportError('IMPORT_UNAVAILABLE', 'Import could not be queued. Please try again.');
    }
    return this.publicJob(updated);
  }

  async cancel(id: string) {
    const row = await this.prisma.videoImport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Import not found');
    if (row.status === 'READY') throw new ConflictException('Import is already complete');
    if (row.stage === 'PREPARING_SOURCE')
      throw new ConflictException('Source storage is finalizing; wait for it to finish');
    if (row.status === 'CANCELLED' || row.status === 'IMPORT_FAILED') return this.publicJob(row);
    const changed = await this.prisma.videoImport.updateMany({ where: { id,
      status: { in: ['PENDING', 'IMPORTING'] }, stage: { not: 'PREPARING_SOURCE' } }, data: {
      status: 'CANCELLED', stage: 'CANCELLED', errorCode: 'IMPORT_CANCELLED',
      error: 'Import cancelled.' } });
    if (!changed.count) throw new ConflictException('Import is already finalizing');
    this.running.get(id)?.abort();
    const queued = await this.queue.getJob(id);
    if (queued && !await queued.isActive()) await queued.remove().catch(() => undefined);
    await this.refundImport(id);
    return this.get(id);
  }

  private async enqueue(importId: string) {
    const existing = await this.queue.getJob(importId);
    if (existing && ['completed', 'failed'].includes(await existing.getState()))
      await existing.remove();
    await this.queue.add(JOB, { importId }, { jobId: importId, attempts: 1,
      removeOnComplete: 100, removeOnFail: 100 });
  }

  private async process(importId: string) {
    const row = await this.prisma.videoImport.findUnique({ where: { id: importId } });
    if (!row || row.status !== 'PENDING') return;
    const started = Date.now();
    const abort = new AbortController();
    this.running.set(importId, abort);
    const cancellation = setInterval(() => {
      void this.prisma.videoImport.findUnique({ where: { id: importId }, select: { status: true } })
        .then((value) => { if (!value || value.status === 'CANCELLED') abort.abort(); })
        .catch(() => undefined);
    }, 1000);
    // One budget for the whole import, sized for long sources (YOUTUBE_IMPORT_TOTAL_TIMEOUT).
    const deadline = setTimeout(() => abort.abort(importFailure('NETWORK_TIMEOUT',
      `Import exceeded ${Math.round(this.adapter.config.totalTimeoutMs / 1000)}s total`)),
      this.adapter.config.totalTimeoutMs);
    let directory: string | undefined;
    let phase: 'metadata' | 'download' | 'validate' | 'storage' = 'metadata';
    const attempts: AttemptLog[] = [];
    const timings = { metadataMs: 0, downloadMs: 0, normalizeMs: 0, storageMs: 0 };
    let download: DownloadResult | undefined;
    let normalized: NormalizedMedia | undefined;
    let metadata: ImportMetadata | undefined;
    const mark = (key: keyof typeof timings, from: number) => { timings[key] = Date.now() - from; return Date.now(); };
    try {
      const claimed = await this.prisma.videoImport.updateMany({
        where: { id: importId, status: 'PENDING' },
        data: { status: 'IMPORTING', stage: 'FETCHING_INFO', progress: 0 }
      });
      if (!claimed.count) return;
      const existingVideo = await this.prisma.video.findFirst({ where: { projectId: row.projectId,
        sourceType: 'YOUTUBE', externalVideoId: row.externalVideoId } });
      if (existingVideo) {
        phase = 'storage';
        const cachedStat = await this.storage.statObject(existingVideo.bucket, existingVideo.objectKey).catch(() => {
          throw importFailure('STORAGE_FAILED', 'Previously imported source is missing from storage');
        });
        if (BigInt(cachedStat.size) !== existingVideo.sizeBytes)
          throw importFailure('STORAGE_FAILED', 'Previously imported source is incomplete in storage');
        const reused = await this.prisma.videoImport.updateMany({
          where: { id: importId, status: 'IMPORTING' }, data: {
          videoId: existingVideo.id, status: 'READY', stage: 'READY', progress: 100 } });
        if (!reused.count) throw new ImportError('IMPORT_CANCELLED', 'Import cancelled.');
        const request = row.autoGeneration as unknown as ClipCreationRequest | null;
        if (request) await this.videos.requestAutoGeneration(existingVideo.id, request, row.creditReservationKey);
        return;
      }
      let clock = Date.now();
      metadata = await this.adapter.metadata(row.sourceUrl, abort.signal, attempts);
      clock = mark('metadataMs', clock);
      await this.prisma.videoImport.update({ where: { id: importId }, data: {
        title: metadata.title?.slice(0, 300), durationSec: metadata.duration,
        thumbnailUrl: metadata.thumbnail?.slice(0, 1000), stage: 'DOWNLOADING', progress: 1 } });
      phase = 'download';
      directory = await mkdtemp(join(tmpdir(), 'youtube-import-'));
      const estimate = metadata.estimatedBytes;
      download = await this.adapter.download(row.sourceUrl, directory, abort.signal, async (bytes) => {
        if (estimate) await this.prisma.videoImport.update({ where: { id: importId }, data: {
          progress: Math.min(89, Math.max(1, Math.round(90 * bytes / estimate))) } });
      }, attempts);
      clock = mark('downloadMs', clock);
      await this.prisma.videoImport.update({ where: { id: importId }, data: {
        stage: 'VALIDATING', progress: 90 } });
      phase = 'validate';
      normalized = await normalizeImportedMedia(download.filePath, directory, abort.signal);
      clock = mark('normalizeMs', clock);
      // Never accept a truncated retrieval: the stored source must cover the whole video.
      const probed = normalized.probe.durationSec ?? 0;
      if (probed < metadata.duration * 0.97 - 2)
        throw importFailure('MEDIA_INVALID', `retrieved ${probed}s of ${metadata.duration}s`);
      if (probed > this.adapter.maxDuration + 5)
        throw new ImportError('DURATION_LIMIT', `This video is longer than the ${Math.floor(this.adapter.maxDuration / 60)} minute limit. Upload a shorter video instead.`, `probed=${probed}`);
      const finalizing = await this.prisma.videoImport.updateMany({
        where: { id: importId, status: 'IMPORTING' },
        data: { stage: 'PREPARING_SOURCE', progress: 95 }
      });
      if (!finalizing.count) throw new ImportError('IMPORT_CANCELLED', 'Import cancelled.');
      phase = 'storage';
      // Reuse the upload path verbatim: it stores the file, creates the canonical Video,
      // and enqueues the existing media processor. No generation logic lives here.
      const video = await this.videos.createFromUpload(row.projectId, {
        path: normalized.filePath, originalname: `${(metadata.title || row.externalVideoId).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 200)}.mp4`,
        mimetype: 'video/mp4', size: normalized.size
      } as Express.Multer.File, row.aiMode, row.processingType, row.outputAspectRatio,
      row.targetPlatform, { sourceUrl: row.sourceUrl, externalVideoId: row.externalVideoId, creditReservationKey: row.creditReservationKey },
      row.autoGeneration as unknown as ClipCreationRequest | null);
      const storedVideo = await this.prisma.video.findUniqueOrThrow({ where: { id: video.id },
        select: { bucket: true, objectKey: true, sizeBytes: true } });
      const storedStat = await this.storage.statObject(storedVideo.bucket, storedVideo.objectKey);
      if (BigInt(storedStat.size) !== storedVideo.sizeBytes)
        throw importFailure('STORAGE_FAILED', 'Stored object size does not match the normalized file');
      mark('storageMs', clock);
      await this.prisma.videoImport.update({ where: { id: importId }, data: {
        videoId: video.id, status: 'READY', stage: 'READY', progress: 100 } });
      this.logger.log(JSON.stringify({ event: 'external_video_import', provider: 'YOUTUBE',
        externalVideoId: row.externalVideoId, importJobId: importId, videoId: video.id, stage: 'READY',
        durationSec: normalized.probe.durationSec, formatStep: download.formatStep,
        formatId: download.formatId, vcodec: download.vcodec, acodec: download.acodec,
        resolution: `${normalized.probe.width}x${normalized.probe.height}`, protocols: download.protocols,
        mediaHosts: download.mediaHosts, bytesDownloaded: download.size, storedBytes: normalized.size,
        normalization: normalized.action, attempts, ...timings, wallMs: Date.now() - started }));
    } catch (error) {
      const fallbackCode = phase === 'download' ? 'DOWNLOAD_FAILED' : phase === 'validate'
        ? 'MEDIA_INVALID' : phase === 'storage' ? 'STORAGE_FAILED' : 'UNKNOWN_PROVIDER_ERROR';
      const failure = error instanceof ImportError ? error
        : importFailure(fallbackCode, error instanceof Error ? error.message : String(error));
      if (failure.code === 'IMPORT_INTERRUPTED') await this.prisma.videoImport.updateMany({
        where: { id: importId, status: 'IMPORTING' },
        data: { status: 'PENDING', stage: 'FETCHING_INFO', progress: 0 } });
      else if (failure.code !== 'IMPORT_CANCELLED') await this.fail(importId, failure.code, failure.message);
      this.logger.warn(JSON.stringify({ event: 'external_video_import', provider: 'YOUTUBE',
        externalVideoId: row.externalVideoId, importJobId: importId, stage: 'IMPORT_FAILED', phase,
        category: failure.code, reason: failure.detail ?? failure.message, title: metadata?.title ?? null,
        durationSec: metadata?.duration ?? null, formatStep: download?.formatStep ?? null,
        attempts, ...timings, wallMs: Date.now() - started }));
    } finally {
      this.running.delete(importId);
      clearInterval(cancellation);
      clearTimeout(deadline);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async fail(id: string, code: string, message: string) {
    await this.prisma.videoImport.updateMany({ where: { id, status: { not: 'CANCELLED' } },
      data: { status: 'IMPORT_FAILED', stage: 'IMPORT_FAILED', errorCode: code, error: message } });
    await this.refundImport(id);
  }

  private async refundImport(id: string) {
    const row = await this.prisma.videoImport.findUnique({ where: { id } });
    if (!row?.creditReservationKey) return;
    const reservation = await this.prisma.creditReservation.findUnique({ where: { jobKey: row.creditReservationKey } });
    // A transferred reservation belongs to the canonical generation job, which settles it.
    if (reservation?.resourceId === `import:${id}`) await new UsageService(this.prisma).settle(row.creditReservationKey, false);
  }

  private publicJob(row: { id: string; projectId: string; videoId: string | null;
    sourceUrl: string; externalVideoId: string; status: string; stage: string; progress: number;
    errorCode: string | null; error: string | null; title: string | null;
    durationSec: number | null; thumbnailUrl: string | null; createdAt: Date;
    updatedAt: Date }) {
    return row;
  }
}
