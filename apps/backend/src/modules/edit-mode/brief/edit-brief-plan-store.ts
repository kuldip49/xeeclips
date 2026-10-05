import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import type { BriefPlan } from './edit-brief.types';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'editmode:brief:active:';

@Injectable()
export class EditBriefPlanStore implements OnModuleDestroy {
  private readonly logger = new Logger(EditBriefPlanStore.name);
  private readonly memory = new Map<string, BriefPlan>();
  private redis: Redis | null = null;
  private usable = true;
  private warned = false;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url || (process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS ?? 'true').toLowerCase() === 'false') {
      this.usable = false; return;
    }
    try {
      this.redis = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1,
        enableOfflineQueue: false, connectTimeout: 2000,
        retryStrategy: (times) => Math.min(times * 500, 5000) });
      this.redis.on('error', (error) => this.reportDegraded(error));
      this.redis.on('ready', () => { this.warned = false; });
      void this.redis.connect().catch((error) => this.reportDegraded(error));
    } catch (error) { this.degrade(error); }
  }
  async onModuleDestroy() { await this.redis?.quit().catch(() => undefined); }
  private get durable() { return this.usable && this.redis?.status === 'ready'; }
  private degrade(error: unknown) {
    if (!this.usable) return;
    this.usable = false;
    this.reportDegraded(error);
  }
  private reportDegraded(error: unknown) {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(JSON.stringify({ event: 'edit_mode_brief_store_degraded',
      reason: error instanceof Error ? error.message : String(error),
      detail: 'Brief plans remain available in this process only.' }));
  }
  async save(plan: BriefPlan) {
    const next = { ...plan, updatedAt: new Date().toISOString() };
    // Keep an in-process copy even while Redis is healthy. If Redis is briefly
    // unavailable, an already-active supervised plan must remain resumable.
    this.memory.set(plan.editProjectId, next);
    if (this.durable && this.redis) {
      try { await this.redis.set(`${PREFIX}${plan.editProjectId}`, JSON.stringify(next),
        'PX', TTL_MS); return next; } catch (error) { this.reportDegraded(error); }
    }
    return next;
  }
  async get(editProjectId: string): Promise<BriefPlan | null> {
    if (this.durable && this.redis) {
      try { const raw = await this.redis.get(`${PREFIX}${editProjectId}`);
        if (raw) {
          const plan = JSON.parse(raw) as BriefPlan;
          this.memory.set(editProjectId, plan);
          return plan;
        }
      } catch (error) { this.reportDegraded(error); }
    }
    return this.memory.get(editProjectId) ?? null;
  }
}
