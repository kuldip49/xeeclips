// Step 7/8: the AI editor agent - types for the instruction ledger.
//
// The agent edits the canonical EditProject through validated tools (never
// shell, never FFmpeg, never raw DB, never DOM clicks). Every clause of a user
// request becomes one ledger entry that is accounted for from interpretation to
// verification, so nothing is silently dropped.

import type { EditCommandResultStatus, EditConstraint } from '../edit-command-scope';
import type { AiAvailability } from '../../ai/ai-availability';

/** How much the agent may do without asking. */
export const AGENT_AUTONOMY_MODES = ['MANUAL', 'AI_ASSISTED', 'AI_AUTONOMOUS', 'HYBRID'] as const;
export type AgentAutonomy = typeof AGENT_AUTONOMY_MODES[number];

export const LEDGER_STATUSES = ['DONE', 'NEEDS_CONFIRMATION', 'UNSUPPORTED', 'FAILED', 'SKIPPED',
  'BLOCKED_BY_CONSTRAINT', 'NEEDS_INPUT'] as const;
export type LedgerStatus = typeof LEDGER_STATUSES[number];

export const VERIFICATION_STATUSES = ['VERIFIED', 'FAILED', 'NOT_APPLICABLE', 'PENDING'] as const;
export type VerificationStatus = typeof VERIFICATION_STATUSES[number];

/** Where a clause's plan came from. Never a hidden model. */
export type PlanSource = 'DETERMINISTIC_FAST_PATH' | 'DETERMINISTIC_PARSER' | 'OPENAI' |
  'CREATIVE_OPENAI' | 'CREATIVE_DETERMINISTIC' | 'NONE';

/** One tool invocation the agent decided on, in canonical terms. */
export type AgentToolCall = {
  tool: string;
  args: Record<string, unknown>;
};

export type LedgerEntry = {
  index: number;
  /** The user's own words for this clause. */
  clause: string;
  /** What the agent understood, in plain English. */
  intent: string;
  planSource: PlanSource;
  toolCalls: AgentToolCall[];
  /** Human-readable planned change lines. */
  plannedChanges: string[];
  status: LedgerStatus;
  verification: VerificationStatus;
  /** Why it has this status (question, block reason, failure). */
  detail: string;
  destructive: boolean;
  /** Canonical command statuses returned by the command layer. */
  commandStatuses: EditCommandResultStatus[];
  affectedElementIds: string[];
  /** Verification evidence lines ("music volume 0.15 == 0.15"). */
  evidence: string[];
  attempts: number;
};

export type AgentReviewItem = {
  dimension: string;
  severity: 'NEEDS_ATTENTION' | 'COULD_IMPROVE' | 'LOOKS_GOOD';
  title: string;
  evidence: string[];
  suggestion: string | null;
};

export type AgentRun = {
  runId: string;
  editProjectId: string;
  message: string;
  autonomy: AgentAutonomy;
  startedRevision: number;
  finalRevision: number;
  /** Revisions the run produced (each is one undo step). */
  revisions: number[];
  ledger: LedgerEntry[];
  review: { summary: string; items: AgentReviewItem[] } | null;
  ai: AiAvailability;
  constraints: EditConstraint[];
  summary: string;
  createdAt: string;
};

export type AgentRunInput = {
  message?: unknown;
  revision?: unknown;
  selectedElementId?: unknown;
  selectedTimeRange?: unknown;
  playheadSec?: unknown;
  autonomy?: unknown;
  constraints?: unknown;
  /** Confirms held destructive clauses from the previous run. */
  confirmRunId?: unknown;
};
