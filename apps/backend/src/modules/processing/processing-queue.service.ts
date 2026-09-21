import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  PROCESS_VIDEO_JOB,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE
} from "./processing.constants";

@Injectable()
export class ProcessingQueueService implements OnModuleDestroy {
  private readonly connection = new IORedis(
    process.env.REDIS_URL ?? "redis://localhost:6379",
    { maxRetriesPerRequest: null }
  );
  private readonly queue = new Queue<ProcessVideoJobData>(VIDEO_PROCESSING_QUEUE, {
    connection: this.connection
  });

  async enqueue(data: ProcessVideoJobData) {
    await this.queue.add(PROCESS_VIDEO_JOB, data, {
      jobId: data.processingJobId,
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100
    });
  }

  async resume(data: ProcessVideoJobData, prepare: () => Promise<void>) {
    const existing = await this.queue.getJob(data.processingJobId);
    const state = await existing?.getState();
    // The same queue id is retained across automatic and manual retries.
    if (existing && state !== 'failed' && state !== 'completed') return;
    await prepare();
    if (existing) {
      try {
        await existing.retry(state as 'failed' | 'completed');
      } catch (error) {
        // Another retry request may already have atomically moved this job.
        const current = await existing.getState();
        if (current === 'failed' || current === 'completed' || current === 'unknown') throw error;
      }
    } else {
      await this.enqueue(data);
    }
  }

  async remove(processingJobId: string) {
    const job = await this.queue.getJob(processingJobId);
    if (!job) return true;
    if (await job.isActive()) return false;
    await job.remove();
    return true;
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
