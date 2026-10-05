import { readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ClipRenderDispatcher, ClipRenderRequest, clipRenderQueueJobId } from './clip-selection.service';

export const CLIP_RENDER_QUEUE = 'clip-rendering';
export const RENDER_CLIPS_JOB = 'render-clips';

const PENDING_STATES = new Set(['active', 'waiting', 'waiting-children', 'delayed', 'prioritized']);

type Handlers = {
  process: (request: ClipRenderRequest) => Promise<void>;
  failed: (request: ClipRenderRequest, error: Error) => Promise<void>;
};

/**
 * Durable clip rendering. The request state lives in PostgreSQL; Redis only carries the work, so
 * a job interrupted by a restart is redelivered by BullMQ's stalled-job check and resumes.
 */
@Injectable()
export class ClipRenderQueueService implements ClipRenderDispatcher, OnModuleDestroy {
  private readonly logger = new Logger(ClipRenderQueueService.name);
  private readonly connection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379',
    { maxRetriesPerRequest: null });
  private readonly queue = new Queue<ClipRenderRequest>(CLIP_RENDER_QUEUE,
    { connection: this.connection });
  private worker?: Worker<ClipRenderRequest>;

  start(handlers: Handlers) {
    if (this.worker) return;
    this.worker = new Worker<ClipRenderRequest>(CLIP_RENDER_QUEUE, async (job) => {
      if (job.name === RENDER_CLIPS_JOB) await handlers.process(job.data);
    }, { connection: this.connection,
      concurrency: Math.max(1, Number(process.env.CLIP_RENDER_CONCURRENCY) || 1),
      // A restart or crash mid-request stalls the job; it resumes (finished clips are reused),
      // so a couple of stalls must not fail a long request outright (BullMQ's default is 1).
      maxStalledCount: Math.max(1, Number(process.env.CLIP_RENDER_MAX_STALLS) || 5) });
    // Batch source copies (one per request, ~source size) left behind by a killed process.
    void readdir(tmpdir()).then((names) => Promise.all(names
      .filter((name) => name.startsWith('ai-content-clip-batch-'))
      .map((name) => rm(join(tmpdir(), name), { recursive: true, force: true }))))
      .catch(() => undefined);
    this.worker.on('failed', (job, error) => {
      if (job?.name === RENDER_CLIPS_JOB) void handlers.failed(job.data, error).catch((failure) =>
        this.logger.error('Could not persist clip render failure', failure));
    });
  }

  async dispatch(request: ClipRenderRequest) {
    // A deterministic id makes a resent request a no-op while the original is still live.
    await this.queue.add(RENDER_CLIPS_JOB, request, { jobId: clipRenderQueueJobId(request),
      attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
  }

  async isPending(request: ClipRenderRequest) {
    const job = await this.queue.getJob(clipRenderQueueJobId(request));
    if (!job) return false;
    return PENDING_STATES.has(await job.getState());
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }
}
