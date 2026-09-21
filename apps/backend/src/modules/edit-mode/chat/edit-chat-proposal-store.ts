// Durable server-side storage for chat proposals.
//
// The client is never trusted to send commands back. It holds a proposalId and
// nothing else; the authoritative bundle stays here between plan and apply. So
// a tampered request cannot introduce a command the planner never produced and
// the validator never saw.
//
// Phase 7 makes this survive a backend restart. The bundle is written to Redis
// - already required by the stack, and reached here through EditMode's own
// connection and its own `editmode:` key namespace, so nothing about the frozen
// processing queue is shared or touched. No queue, worker or job is created:
// this is a plain expiring key-value read and write. Redis rather than a
// settings-JSON block on EditProject because a proposal is not project state:
// it must not
// ride along in every project response, must not enter an EditHistory snapshot,
// and must not have to be excluded by hand from undo. Redis also expires it
// natively, so an abandoned project needs no sweeper.
//
// DEGRADED MODE: when Redis cannot be reached the store falls back to the
// in-process map it used in Phase 6. Proposals then behave exactly as before -
// valid for minutes, lost on restart - and the next Apply returns
// PROPOSAL_NOT_FOUND, which the UI surfaces as "regenerate this proposal".
// Nothing is ever half-applied either way: Apply is a single transaction that
// either finds a complete proposal or does nothing at all.

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import type { ChatProposal } from './edit-chat.types';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
/** Per project, so one busy project cannot evict another's proposal. */
export const MAX_PROPOSALS_PER_PROJECT = 8;
const MAX_TOTAL_IN_MEMORY = 500;
/** EditMode's own namespace. Nothing else in the stack writes these keys. */
const KEY_PREFIX = 'editmode:chat:proposal:';
const INDEX_PREFIX = 'editmode:chat:proposals:';

const proposalKey = (proposalId: string) => `${KEY_PREFIX}${proposalId}`;
const indexKey = (editProjectId: string) => `${INDEX_PREFIX}${editProjectId}`;

@Injectable()
export class EditChatProposalStore implements OnModuleDestroy {
  private readonly logger = new Logger(EditChatProposalStore.name);
  /** The fallback used when Redis is unreachable, and the only store in tests
   * that run without one. */
  private readonly memory = new Map<string, ChatProposal>();
  private redis: Redis | null = null;
  private redisUsable = true;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url || (process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS ?? 'true').toLowerCase() === 'false') {
      this.redisUsable = false;
      return;
    }
    try {
      this.redis = new IORedis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 2000,
        // EditMode never blocks an edit on Redis: a failed command degrades to
        // the in-process map rather than propagating out of a chat turn.
        retryStrategy: (times) => Math.min(times * 500, 5000)
      });
      this.redis.on('error', (error) => this.degrade(error));
      void this.redis.connect().catch((error) => this.degrade(error));
    } catch (error) {
      this.degrade(error);
    }
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }

  /** True when proposals currently survive a restart. Surfaced for diagnostics. */
  get durable() {
    return this.redisUsable && this.redis?.status === 'ready';
  }

  private degrade(error: unknown) {
    if (!this.redisUsable) return;
    this.redisUsable = false;
    this.logger.warn(JSON.stringify({ event: 'edit_mode_chat_proposal_store_degraded',
      reason: error instanceof Error ? error.message : String(error),
      detail: 'Chat proposals are held in process only and will not survive a restart.' }));
  }

  private ttlMs() {
    const configured = Number(process.env.EDIT_MODE_CHAT_PROPOSAL_TTL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
  }

  /** Drops expired in-memory entries. Redis expires its own keys. */
  private sweepMemory(now = Date.now()) {
    for (const [id, proposal] of this.memory) {
      if (proposal.expiresAt <= now) this.memory.delete(id);
    }
  }

  async save(proposal: Omit<ChatProposal, 'createdAt' | 'expiresAt'>): Promise<ChatProposal> {
    const now = Date.now();
    const ttl = this.ttlMs();
    const stored: ChatProposal = { ...proposal, createdAt: now, expiresAt: now + ttl };

    if (this.durable && this.redis) {
      try {
        const index = indexKey(stored.editProjectId);
        // Keep only the newest few per project; an older pending proposal is
        // superseded the moment the user asks for something else.
        const existing = await this.redis.zrange(index, 0, -1);
        const surplus = existing.slice(0, Math.max(0, existing.length -
          (MAX_PROPOSALS_PER_PROJECT - 1)));
        const pipeline = this.redis.multi();
        for (const staleId of surplus) {
          pipeline.del(proposalKey(staleId));
          pipeline.zrem(index, staleId);
        }
        pipeline.set(proposalKey(stored.proposalId), JSON.stringify(stored), 'PX', ttl);
        pipeline.zadd(index, stored.createdAt, stored.proposalId);
        // The index itself expires a little after the longest-lived member, so
        // an abandoned project leaves nothing behind.
        pipeline.pexpire(index, ttl + 60_000);
        await pipeline.exec();
        return stored;
      } catch (error) {
        this.degrade(error);
      }
    }

    this.sweepMemory(now);
    const mine = [...this.memory.values()]
      .filter((entry) => entry.editProjectId === stored.editProjectId)
      .sort((left, right) => right.createdAt - left.createdAt);
    for (const stale of mine.slice(MAX_PROPOSALS_PER_PROJECT - 1)) {
      this.memory.delete(stale.proposalId);
    }
    if (this.memory.size >= MAX_TOTAL_IN_MEMORY) {
      const oldest = [...this.memory.values()]
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (oldest) this.memory.delete(oldest.proposalId);
    }
    this.memory.set(stored.proposalId, stored);
    return stored;
  }

  async get(proposalId: string, editProjectId: string): Promise<ChatProposal | null> {
    if (this.durable && this.redis) {
      try {
        const raw = await this.redis.get(proposalKey(proposalId));
        if (raw) {
          const proposal = JSON.parse(raw) as ChatProposal;
          // Both checks still run in code: a key surviving its PX by a moment,
          // or one belonging to another project, must not be applied here.
          if (proposal.editProjectId !== editProjectId) return null;
          if (proposal.expiresAt <= Date.now()) {
            await this.remove(proposalId, editProjectId);
            return null;
          }
          return proposal;
        }
        return null;
      } catch (error) {
        this.degrade(error);
      }
    }
    this.sweepMemory();
    const proposal = this.memory.get(proposalId);
    if (!proposal || proposal.editProjectId !== editProjectId) return null;
    return proposal;
  }

  async update(proposalId: string, editProjectId: string,
    changes: Partial<ChatProposal>): Promise<ChatProposal | null> {
    const proposal = await this.get(proposalId, editProjectId);
    if (!proposal) return null;
    const next = { ...proposal, ...changes };
    if (this.durable && this.redis) {
      try {
        // The remaining TTL is preserved: a state change is not a renewal.
        const remaining = Math.max(1, next.expiresAt - Date.now());
        await this.redis.set(proposalKey(proposalId), JSON.stringify(next), 'PX', remaining);
        return next;
      } catch (error) {
        this.degrade(error);
      }
    }
    this.memory.set(proposalId, next);
    return next;
  }

  async remove(proposalId: string, editProjectId: string) {
    if (this.durable && this.redis) {
      try {
        await this.redis.multi()
          .del(proposalKey(proposalId))
          .zrem(indexKey(editProjectId), proposalId)
          .exec();
        return;
      } catch (error) {
        this.degrade(error);
      }
    }
    this.memory.delete(proposalId);
  }

  /** Test and diagnostic hook: how many proposals this project currently holds. */
  async countFor(editProjectId: string): Promise<number> {
    if (this.durable && this.redis) {
      try {
        const ids = await this.redis.zrange(indexKey(editProjectId), 0, -1);
        const live = await Promise.all(ids.map((id) => this.get(id, editProjectId)));
        return live.filter(Boolean).length;
      } catch (error) {
        this.degrade(error);
      }
    }
    this.sweepMemory();
    return [...this.memory.values()]
      .filter((entry) => entry.editProjectId === editProjectId).length;
  }
}
