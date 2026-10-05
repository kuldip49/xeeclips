import type { ChatProposalView } from '../chat/edit-chat.types';
import type { EditReviewView } from '../review/edit-review.types';

export const BRIEF_PLAN_STATUSES = ['PENDING', 'PLANNING', 'AWAITING_CONFIRMATION', 'APPLIED',
  'REVISING', 'SKIPPED', 'FAILED', 'COMPLETED', 'STOPPED'] as const;
export type BriefPlanStatus = typeof BRIEF_PLAN_STATUSES[number];

export type BriefStep = {
  id: string;
  label: string;
  originalInstruction: string;
  interpretedGoal: string;
  resolvedTargets: string[];
  proposedCommands: string[];
  status: BriefPlanStatus;
  warnings: string[];
  affectedHandles: string[];
  projectRevision: number;
  resultSummary: string;
  /** Server-only pointer to the G proposal. */
  proposalId: string | null;
  instruction: string;
  kind: 'EDIT' | 'REVIEW' | 'UNSUPPORTED';
};

export type BriefPlan = {
  planId: string;
  editProjectId: string;
  originalBrief: string;
  status: BriefPlanStatus;
  steps: BriefStep[];
  currentStepIndex: number;
  protectedConstraints: string[];
  unaccountedInstructions: string[];
  revision: number;
  activeProposal: ChatProposalView | null;
  /** Server-only G proposal for a temporary edit made while the plan is paused. */
  interruptionProposalId: string | null;
  finalReview: EditReviewView | null;
  createdAt: string;
  updatedAt: string;
};

export type BriefPlanView = Omit<BriefPlan, 'editProjectId' | 'steps' | 'interruptionProposalId'> & {
  steps: Array<Omit<BriefStep, 'proposalId' | 'instruction'>>;
};

export function briefPlanView(plan: BriefPlan): BriefPlanView {
  const { editProjectId: _project, interruptionProposalId: _interruption, steps, ...rest } = plan;
  return { ...rest, steps: steps.map(({ proposalId: _proposal, instruction: _instruction,
    ...step }) => step) };
}
