// Chat thread state and the shapes the chat API speaks.
//
// The thread lives in EditProject.settings.chat - a bounded JSON block, not a
// new table. Phase 6 needs no schema change: EditHistoryActor already has
// ASSISTANT, element properties already carry an ASSISTANT origin, and settings
// is already free-form JSON that the canonical layer round-trips through undo.
//
// The thread is deliberately STRUCTURED rather than a pile of raw sentences.
// Follow-ups like "make it smaller" are resolved from `lastAffectedElementIds`,
// not by re-reading prose, so a follow-up cannot drift onto the wrong element
// just because the wording was similar.

import type { ChatGrounding } from './edit-chat-commands';
import type { ResolvedChatCommand } from './edit-chat-resolver';

export const CHAT_MESSAGE_ROLES = ['USER', 'ASSISTANT', 'SYSTEM_STATUS'] as const;
export type ChatMessageRole = typeof CHAT_MESSAGE_ROLES[number];

export const CHAT_PROPOSAL_STATES = ['PLANNING', 'READY', 'APPLYING', 'APPLIED', 'CANCELLED',
  'STALE', 'FAILED', 'NEEDS_CLARIFICATION'] as const;
export type ChatProposalState = typeof CHAT_PROPOSAL_STATES[number];

export type ChatMessage = {
  id: string;
  role: ChatMessageRole;
  text: string;
  createdAt: string;
  proposalId?: string;
  state?: ChatProposalState;
  /** Human-readable change lines, kept so a reloaded thread still reads well. */
  plannedChanges?: string[];
};

/** The structured memory a follow-up turn reasons over. */
export type ChatThread = {
  messages: ChatMessage[];
  /** Elements the last applied or proposed turn created or changed, newest first. */
  lastAffectedElementIds: string[];
  /** A compact record of what the last applied turn actually did. */
  lastAppliedSummary: string;
  lastAppliedAtRevision: number;
};

export const EMPTY_CHAT_THREAD: ChatThread = {
  messages: [], lastAffectedElementIds: [], lastAppliedSummary: '', lastAppliedAtRevision: -1
};

/** Hard bounds, so a long editing session cannot grow settings without limit. */
export const CHAT_MAX_MESSAGES = 40;
export const CHAT_MAX_MESSAGE_CHARS = 2000;
export const CHAT_MAX_AFFECTED_ELEMENTS = 8;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

/** Reads the thread out of settings, ignoring anything malformed. */
export function readChatThread(settings: unknown): ChatThread {
  const chat = asRecord(asRecord(settings).chat);
  const rawMessages = Array.isArray(chat.messages) ? chat.messages : [];
  const messages = rawMessages.flatMap((item): ChatMessage[] => {
    const record = asRecord(item);
    const role = String(record.role ?? '');
    if (!(CHAT_MESSAGE_ROLES as readonly string[]).includes(role)) return [];
    const state = String(record.state ?? '');
    return [{
      id: String(record.id ?? ''),
      role: role as ChatMessageRole,
      text: String(record.text ?? '').slice(0, CHAT_MAX_MESSAGE_CHARS),
      createdAt: String(record.createdAt ?? ''),
      ...(typeof record.proposalId === 'string' ? { proposalId: record.proposalId } : {}),
      ...((CHAT_PROPOSAL_STATES as readonly string[]).includes(state)
        ? { state: state as ChatProposalState } : {}),
      ...(Array.isArray(record.plannedChanges)
        ? { plannedChanges: record.plannedChanges.map((line) => String(line).slice(0, 300)) } : {})
    }];
  }).filter((message) => message.id);
  return {
    messages: messages.slice(-CHAT_MAX_MESSAGES),
    lastAffectedElementIds: (Array.isArray(chat.lastAffectedElementIds)
      ? chat.lastAffectedElementIds : []).map(String).slice(0, CHAT_MAX_AFFECTED_ELEMENTS),
    lastAppliedSummary: String(chat.lastAppliedSummary ?? '').slice(0, 400),
    lastAppliedAtRevision: Number.isFinite(Number(chat.lastAppliedAtRevision))
      ? Number(chat.lastAppliedAtRevision) : -1
  };
}

/** Trims a thread back inside its bounds before it is written to settings. */
export function boundChatThread(thread: ChatThread): ChatThread {
  return {
    messages: thread.messages.slice(-CHAT_MAX_MESSAGES).map((message) => ({
      ...message, text: message.text.slice(0, CHAT_MAX_MESSAGE_CHARS)
    })),
    lastAffectedElementIds: [...new Set(thread.lastAffectedElementIds)]
      .slice(0, CHAT_MAX_AFFECTED_ELEMENTS),
    lastAppliedSummary: thread.lastAppliedSummary.slice(0, 400),
    lastAppliedAtRevision: thread.lastAppliedAtRevision
  };
}

/** A proposal held server-side between plan and apply. */
export type ChatProposal = {
  proposalId: string;
  editProjectId: string;
  baseRevision: number;
  state: ChatProposalState;
  userMessage: string;
  summary: string;
  plannedChanges: string[];
  warnings: string[];
  needsClarification: boolean;
  clarificationQuestion: string;
  /** Resolved element ids the plan expects to still exist at apply time. */
  affectedElements: string[];
  /** Timeline length when the plan was built, used to judge a safe rebase. */
  plannedDurationSec: number;
  grounding: ChatGrounding[];
  /** The authoritative command bundle. The client never sends these back. */
  commands: ResolvedChatCommand[];
  /**
   * Set when the turn asked for history travel rather than an edit ("undo
   * that"). Apply then calls the existing undo/redo path instead of executing
   * commands - no inverse command is ever synthesised, so chat history travel
   * and button history travel are literally the same operation.
   */
  historyAction?: 'UNDO' | 'REDO';
  /** Element ids the targets resolved to when the plan was built. */
  resolvedTargets: Record<number, string>;
  planner: 'LLM' | 'DETERMINISTIC';
  createdAt: number;
  expiresAt: number;
};

/** What the client is allowed to see. `commands` is intentionally absent. */
export type ChatProposalView = Omit<ChatProposal, 'commands' | 'resolvedTargets' |
  'editProjectId' | 'createdAt'> & { expiresAt: number };

export const proposalView = (proposal: ChatProposal): ChatProposalView => {
  const { commands: _commands, resolvedTargets: _targets, editProjectId: _projectId,
    createdAt: _createdAt, ...view } = proposal;
  return view;
};
