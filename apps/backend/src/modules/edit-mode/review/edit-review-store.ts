import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import type { EditReview } from './edit-review.types';

const TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'editmode:review:latest:';

@Injectable()
export class EditReviewStore implements OnModuleDestroy {
  private readonly logger = new Logger(EditReviewStore.name);
  private readonly memory = new Map<string, { review: EditReview; expiresAt: number }>();
  private redis: Redis | null = null;
  private usable = true;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url || (process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS ?? 'true').toLowerCase() === 'false') {
      this.usable = false;
      return;
    }
    try {
      this.redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1,
        enableOfflineQueue: false, connectTimeout: 2000,
        retryStrategy: (times) => Math.min(times * 500, 5000) });
      this.redis.on('error', (error) => this.degrade(error));
      void this.redis.connect().catch((error) => this.degrade(error));
    } catch (error) { this.degrade(error); }
  }

  async onModuleDestroy() { await this.redis?.quit().catch(() => undefined); }
  private get durable() { return this.usable && this.redis?.status === 'ready'; }
  private degrade(error: unknown) {
    if (!this.usable) return;
    this.usable = false;
    this.logger.warn(JSON.stringify({ event: 'edit_mode_review_store_degraded',
      reason: error instanceof Error ? error.message : String(error) }));
  }

  async save(review: EditReview) {
    if (this.durable && this.redis) {
      try { await this.redis.set(`${PREFIX}${review.editProjectId}`, JSON.stringify(review),
        'PX', TTL_MS); return review; } catch (error) { this.degrade(error); }
    }
    this.memory.set(review.editProjectId, { review, expiresAt: Date.now() + TTL_MS });
    return review;
  }

  async get(editProjectId: string): Promise<EditReview | null> {
    if (this.durable && this.redis) {
      try {
        const raw = await this.redis.get(`${PREFIX}${editProjectId}`);
        return raw ? JSON.parse(raw) as EditReview : null;
      } catch (error) { this.degrade(error); }
    }
    const entry = this.memory.get(editProjectId);
    if (!entry || entry.expiresAt <= Date.now()) { this.memory.delete(editProjectId); return null; }
    return entry.review;
  }
}
