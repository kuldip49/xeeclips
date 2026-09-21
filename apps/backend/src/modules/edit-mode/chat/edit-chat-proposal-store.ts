// Short-lived server-side storage for chat proposals.
//
// The client is never trusted to send commands back. It holds a proposalId and
// nothing else; the authoritative bundle stays here between plan and apply. So
// a tampered request cannot introduce a command the planner never produced and
// the validator never saw.
//
// This is deliberately in-process and deliberately not Redis. A proposal is
// valid for minutes, is cheap to regenerate, and is meaningless after the
// project moves on - so durability would buy nothing. RESTART LIMITATION: a
// backend restart drops pending proposals, and the next Apply returns
// PROPOSAL_NOT_FOUND, which the UI surfaces as "regenerate this proposal".
// Nothing is ever half-applied as a result: Apply is a single transaction that
// either finds a complete proposal or does nothing at all.

import { Injectable } from '@nestjs/common';
import type { ChatProposal } from './edit-chat.types';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
/** Per project, so one busy project cannot evict another's proposal. */
const MAX_PER_PROJECT = 8;
const MAX_TOTAL = 500;

@Injectable()
export class EditChatProposalStore {
  private readonly proposals = new Map<string, ChatProposal>();

  private ttlMs() {
    const configured = Number(process.env.EDIT_MODE_CHAT_PROPOSAL_TTL_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
  }

  /** Drops expired entries. Called on every read and write, so the map cannot
   * grow unbounded in a long-running process without a sweeper thread. */
  private sweep(now = Date.now()) {
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) this.proposals.delete(id);
    }
  }

  save(proposal: Omit<ChatProposal, 'createdAt' | 'expiresAt'>): ChatProposal {
    const now = Date.now();
    this.sweep(now);
    const stored: ChatProposal = { ...proposal, createdAt: now, expiresAt: now + this.ttlMs() };

    // Keep only the newest few per project; an older pending proposal is
    // superseded the moment the user asks for something else.
    const mine = [...this.proposals.values()]
      .filter((entry) => entry.editProjectId === stored.editProjectId)
      .sort((left, right) => right.createdAt - left.createdAt);
    for (const stale of mine.slice(MAX_PER_PROJECT - 1)) this.proposals.delete(stale.proposalId);
    if (this.proposals.size >= MAX_TOTAL) {
      const oldest = [...this.proposals.values()]
        .sort((left, right) => left.createdAt - right.createdAt)[0];
      if (oldest) this.proposals.delete(oldest.proposalId);
    }

    this.proposals.set(stored.proposalId, stored);
    return stored;
  }

  get(proposalId: string, editProjectId: string): ChatProposal | null {
    this.sweep();
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.editProjectId !== editProjectId) return null;
    return proposal;
  }

  update(proposalId: string, changes: Partial<ChatProposal>) {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return null;
    const next = { ...proposal, ...changes };
    this.proposals.set(proposalId, next);
    return next;
  }

  remove(proposalId: string) {
    this.proposals.delete(proposalId);
  }

  /** Test and diagnostic hook: how many proposals are currently held. */
  size() {
    this.sweep();
    return this.proposals.size;
  }
}
