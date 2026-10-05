import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { EditChatService } from '../chat/edit-chat.service';
import type { ChatProposalView } from '../chat/edit-chat.types';
import { EditReviewService } from '../review/edit-review.service';
import { builtinTemplateList } from '../templates/edit-template-library';
import { EditBriefPlanStore } from './edit-brief-plan-store';
import { briefPlanView, type BriefPlan, type BriefPlanView, type BriefStep } from './edit-brief.types';

type Runtime = { selectedElementId?: unknown; selectedTimeRange?: unknown; playheadSec?: unknown };
type PlanInput = Runtime & { brief?: unknown; revision?: unknown };
type RespondInput = Runtime & { message?: unknown; revision?: unknown };

type StepSeed = Pick<BriefStep, 'label' | 'interpretedGoal' | 'instruction' | 'kind'> &
  { warning?: string; target?: string };

const confirmations = /^(yes|yep|okay|ok|go ahead|apply it|apply|continue|next)$/i;
const skip = /^(skip|skip it|not this one)$/i;
const stop = /^(stop|cancel|cancel the edit|don'?t continue)$/i;
const revisions = /^(no|change it|shorter|too much|less|more subtle|move it lower|try another)/i;

@Injectable()
export class EditBriefService {
  constructor(private readonly prisma: PrismaService, private readonly store: EditBriefPlanStore,
    private readonly chat: EditChatService, private readonly reviews: EditReviewService) {}

  async current(id: string): Promise<BriefPlanView | null> {
    const plan = await this.store.get(id);
    return plan ? briefPlanView(plan) : null;
  }

  async create(id: string, input: PlanInput): Promise<BriefPlanView> {
    const brief = typeof input.brief === 'string' ? input.brief.trim() : '';
    if (!brief) throw new BadRequestException({ code: 'EMPTY_BRIEF',
      message: 'Describe the edit you want to make' });
    if (brief.length > 4000) throw new BadRequestException({ code: 'BRIEF_TOO_LONG',
      message: 'Keep the editing brief under 4000 characters' });
    const project = await this.prisma.editProject.findUnique({ where: { id }, include: {
      assets: true, elements: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    if (input.revision !== undefined && Number(input.revision) !== project.revision) {
      throw new BadRequestException({ code: 'STALE_REVISION',
        message: 'The project changed. Start the plan from the current edit.' });
    }
    const { seeds, constraints, unaccounted } = this.parse(brief,
      project.assets.map((asset) => ({ role: asset.role, name: asset.originalName })));
    const now = new Date().toISOString();
    let plan: BriefPlan = { planId: randomUUID(), editProjectId: id, originalBrief: brief,
      status: 'PENDING', steps: seeds.map((seed) => ({ id: randomUUID(), label: seed.label,
        originalInstruction: brief, interpretedGoal: seed.interpretedGoal,
        resolvedTargets: seed.target ? [seed.target] : [], proposedCommands: [],
        status: seed.kind === 'UNSUPPORTED' ? 'SKIPPED' : 'PENDING',
        warnings: seed.warning ? [seed.warning] : [], affectedHandles: [],
        projectRevision: project.revision,
        resultSummary: seed.kind === 'UNSUPPORTED' ? 'Unsupported capability; no edit was made.' : '',
        proposalId: null,
        instruction: seed.instruction, kind: seed.kind })), currentStepIndex: 0,
      protectedConstraints: constraints, unaccountedInstructions: unaccounted,
      revision: project.revision, activeProposal: null, interruptionProposalId: null,
      finalReview: null,
      createdAt: now, updatedAt: now };
    plan = await this.store.save(plan);
    plan = await this.prepare(plan, input);
    return briefPlanView(plan);
  }

  async respond(id: string, input: RespondInput): Promise<{ plan: BriefPlanView;
    project?: unknown }> {
    let plan = await this.store.get(id);
    if (!plan) throw new NotFoundException({ code: 'BRIEF_PLAN_NOT_FOUND',
      message: 'Start an AI Edit Plan first' });
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message) throw new BadRequestException({ code: 'EMPTY_RESPONSE', message: 'Type a response' });
    if (plan.status === 'STOPPED' || plan.status === 'COMPLETED') {
      return { plan: briefPlanView(plan) };
    }
    if (stop.test(message)) {
      plan = await this.store.save({ ...plan, status: 'STOPPED', activeProposal: null });
      return { plan: briefPlanView(plan) };
    }
    const step = plan.steps[plan.currentStepIndex];
    if (!step) {
      plan = await this.store.save({ ...plan, status: 'COMPLETED', activeProposal: null });
      return { plan: briefPlanView(plan) };
    }
    if (skip.test(message)) {
      step.status = 'SKIPPED'; step.resultSummary = 'Skipped by user.'; step.proposalId = null;
      plan = await this.advance(plan);
      return { plan: briefPlanView(plan) };
    }
    if (revisions.test(message)) {
      if (step.proposalId) await this.chat.cancel(id, { proposalId: step.proposalId });
      step.status = 'REVISING';
      step.instruction = this.refine(step.instruction, message);
      step.resultSummary = `Revised: ${message}`;
      plan.activeProposal = null; step.proposalId = null;
      plan = await this.store.save(plan);
      plan = await this.prepare(plan, input);
      return { plan: briefPlanView(plan) };
    }
    if (confirmations.test(message)) {
      if (plan.interruptionProposalId) {
        const applied = await this.chat.apply(id, { proposalId: plan.interruptionProposalId,
          revision: input.revision ?? plan.revision });
        plan.interruptionProposalId = null; plan.activeProposal = null;
        plan.revision = applied.project.revision;
        step.warnings = step.warnings.filter((warning) => !warning.startsWith('A temporary chat edit'));
        plan = await this.store.save(plan);
        plan = await this.prepare(plan, { ...input, selectedElementId: input.selectedElementId }, true);
        return { plan: briefPlanView(plan), project: applied.project };
      }
      // A completed step waits for Continue before the next one is prepared.
      if (step.status === 'APPLIED' || step.status === 'COMPLETED' || step.status === 'SKIPPED') {
        plan = await this.advance(plan);
        if (plan.status !== 'COMPLETED') plan = await this.prepare(plan, input);
        return { plan: briefPlanView(plan) };
      }
      if (step.kind === 'REVIEW') {
        const review = await this.reviews.review(id, { ...input, message: 'review my edit' });
        step.status = 'COMPLETED'; step.resultSummary = review.summary;
        plan.finalReview = review; plan.revision = review.revision;
        plan = await this.advance(plan);
        return { plan: briefPlanView(plan) };
      }
      if (!step.proposalId) {
        plan = await this.prepare(plan, input);
        return { plan: briefPlanView(plan) };
      }
      try {
        const applied = await this.chat.apply(id, { proposalId: step.proposalId,
          revision: input.revision ?? plan.revision });
        step.status = 'APPLIED'; step.projectRevision = applied.project.revision;
        step.resultSummary = plan.activeProposal?.summary ?? 'Applied through the canonical editor.';
        step.proposalId = null; plan.activeProposal = null; plan.revision = applied.project.revision;
        plan.status = 'APPLIED';
        plan = await this.store.save(plan);
        return { plan: briefPlanView(plan), project: applied.project };
      } catch (error) {
        // Manual changes are authoritative. Re-ground this step instead of
        // overwriting newer work with a stale plan.
        step.status = 'REVISING'; step.proposalId = null; plan.activeProposal = null;
        step.warnings.push('The project changed, so this step was re-planned from current state.');
        plan = await this.store.save(plan);
        plan = await this.prepare(plan, input, true);
        return { plan: briefPlanView(plan) };
      }
    }

    // A scoped interruption uses G, then leaves the main semantic step pinned.
    // The proposal is displayed in the ordinary proposal card and can be
    // applied there; the next Continue will re-ground the plan step.
    if (/before continuing|first,|quickly|for now/i.test(message)) {
      const interruption = await this.chat.plan(id, { ...input, message });
      plan.activeProposal = this.redact(interruption.proposal);
      plan.interruptionProposalId = interruption.proposal.needsClarification
        ? null : interruption.proposal.proposalId;
      plan.status = 'AWAITING_CONFIRMATION';
      step.warnings.push('A temporary chat edit is pending; the plan will resume from current state.');
      plan = await this.store.save(plan);
      return { plan: briefPlanView(plan) };
    }
    throw new BadRequestException({ code: 'BRIEF_RESPONSE_NOT_UNDERSTOOD',
      message: 'Use Apply, Change, Skip, Continue, or Stop for the current plan step.' });
  }

  private async prepare(plan: BriefPlan, runtime: Runtime, forceCurrentRevision = false) {
    const step = plan.steps[plan.currentStepIndex];
    if (!step) return this.store.save({ ...plan, status: 'COMPLETED', activeProposal: null });
    if (step.kind === 'UNSUPPORTED') {
      step.status = 'SKIPPED'; step.resultSummary = 'Unsupported capability; no edit was made.';
      return this.advance(plan);
    }
    const project = await this.prisma.editProject.findUnique({ where: { id: plan.editProjectId },
      select: { revision: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    plan.revision = project.revision; step.projectRevision = project.revision;
    if (step.kind === 'REVIEW') {
      step.status = 'AWAITING_CONFIRMATION'; step.proposedCommands = ['Run a read-only final review'];
      step.resultSummary = 'Ready to review the current edit.';
      return this.store.save({ ...plan, status: 'AWAITING_CONFIRMATION', activeProposal: null });
    }
    step.status = 'PLANNING'; plan.status = 'PLANNING';
    plan = await this.store.save(plan);
    const result = await this.chat.plan(plan.editProjectId, { ...runtime, message: step.instruction,
      revision: forceCurrentRevision ? project.revision : project.revision });
    step.proposalId = result.proposal.needsClarification ? null : result.proposal.proposalId;
    step.status = result.proposal.needsClarification ? 'FAILED' : 'AWAITING_CONFIRMATION';
    step.proposedCommands = result.proposal.plannedChanges.slice(0, 12);
    step.warnings = [...new Set([...step.warnings, ...result.proposal.warnings,
      ...(result.proposal.needsClarification ? [result.proposal.clarificationQuestion] : [])])];
    step.resultSummary = result.proposal.summary;
    // Grounding descriptions are safe public handles/evidence; actual element ids are not copied.
    step.affectedHandles = result.proposal.grounding.map((item) => item.evidence).slice(0, 6);
    plan.activeProposal = this.redact(result.proposal);
    plan.status = step.status;
    return this.store.save(plan);
  }

  private async advance(plan: BriefPlan) {
    let next = plan.currentStepIndex + 1;
    while (next < plan.steps.length && plan.steps[next].kind === 'UNSUPPORTED') {
      plan.steps[next].status = 'SKIPPED';
      plan.steps[next].resultSummary = 'Unsupported capability; no edit was made.';
      next += 1;
    }
    plan.currentStepIndex = next; plan.activeProposal = null;
    plan.status = next >= plan.steps.length ? 'COMPLETED' : 'PENDING';
    return this.store.save(plan);
  }

  private redact(proposal: ChatProposalView): ChatProposalView {
    return { ...proposal, affectedElements: [] };
  }

  private refine(instruction: string, response: string) {
    const value = response.toLowerCase();
    if (value.startsWith('shorter')) return `${instruction} Make the result shorter.`;
    if (value.includes('more subtle') || value === 'less' || value === 'too much') {
      return `${instruction} Use a more subtle result than the previous proposal.`;
    }
    if (value.includes('move it lower')) return `${instruction} Move the active target lower.`;
    if (value.includes('try another')) return `${instruction} Try another version.`;
    return `${instruction} Revise the current step: ${response}`;
  }

  private parse(brief: string, assets: Array<{ role: string; name: string }>) {
    const text = brief.toLowerCase(); const seeds: StepSeed[] = []; const constraints: string[] = [];
    const covered: string[] = [];
    const add = (match: boolean, seed: StepSeed, token: string) => {
      if (match) { seeds.push(seed); covered.push(token); }
    };
    const explicitTemplate = /(?:use|apply)\s+([\w -]+?)\s+template/i.exec(brief);
    const namedTemplate = builtinTemplateList().find((item) =>
      text.includes(`use ${item.name.toLowerCase()}`) || text.includes(`apply ${item.name.toLowerCase()}`));
    add(!!explicitTemplate || !!namedTemplate || text.includes('template'), { label: 'Template', interpretedGoal: 'Apply the named template first.',
      instruction: namedTemplate ? `Apply the ${namedTemplate.name} template.` : explicitTemplate
        ? `Apply the ${explicitTemplate[1].trim()} template.` : 'Apply the requested template.',
      kind: 'EDIT', target: 'template' }, 'template');
    add(/hook|opening stronger|stronger opening|curiosity/.test(text), { label: 'Hook',
      interpretedGoal: 'Strengthen the opening while keeping it grounded in the source.',
      instruction: /curiosity/.test(text) ? 'Make the existing hook more curiosity-based.'
        : /short/.test(text) ? 'Make the existing hook shorter.' : 'Make the existing hook stronger.',
      kind: 'EDIT', target: 'hook' }, 'hook');
    add(/pacing|trim|pause|cuts?/.test(text) && !/don'?t change (?:my )?cuts?/.test(text),
      { label: 'Pacing', interpretedGoal: 'Tighten weak pacing without broad timeline changes.',
        instruction: 'Tighten the weakest low-information pause while preserving unrelated cuts.',
        kind: 'EDIT', target: 'video timeline' }, 'pacing');
    add(/caption|subtitle/.test(text), { label: 'Captions',
      interpretedGoal: 'Keep existing captions readable without replacing manual corrections.',
      instruction: `${/smaller/.test(text) ? 'Make the existing captions smaller' : /bigger/.test(text)
        ? 'Make the existing captions bigger' : 'Make the existing captions easier to read'}. ` +
        'Do not regenerate captions or change manual corrections.', kind: 'EDIT', target: 'captions' }, 'captions');
    add(/zoom/.test(text), { label: 'Zoom', interpretedGoal: 'Use safe emphasis zooms only at meaningful moments.',
      instruction: `${/strong/.test(text) ? 'Use strong' : /moderate/.test(text) ? 'Use moderate' : 'Use subtle'} ` +
        'zooms only when something important is said. Preserve face and information regions.',
      kind: 'EDIT', target: 'zooms' }, 'zoom');
    if (/logo/.test(text)) {
      const logos = assets.filter((asset) => asset.role === 'LOGO');
      seeds.push(logos.length === 1 ? { label: 'Logo', interpretedGoal: 'Place the existing logo as requested.',
        instruction: `Keep the existing logo ${/small/.test(text) ? 'small ' : ''}${/bottom right/.test(text)
          ? 'in the bottom right' : /lower/.test(text) ? 'lower in the frame' : 'unobtrusive'}.`,
        kind: 'EDIT', target: 'logo' } : logos.length === 0
        ? { label: 'Logo', interpretedGoal: 'Use the requested logo.', instruction: '', kind: 'UNSUPPORTED',
          warning: 'No logo asset is available; other steps can continue.', target: 'logo' }
        : { label: 'Logo', interpretedGoal: 'Use the requested logo.',
          instruction: `Make the logo ${/small/.test(text) ? 'smaller' : 'unobtrusive'}.`, kind: 'EDIT',
          warning: 'Multiple logo assets are available; choose one for this step.', target: 'logo' });
      covered.push('logo');
    }
    add(/music|audio|duck|speech/.test(text), { label: 'Audio',
      interpretedGoal: 'Balance existing audio while protecting speech.',
      instruction: /don'?t use music|no music/.test(text) ? 'Mute the existing music.'
        : 'Keep the existing music low under speech and use gentle fades.', kind: 'EDIT', target: 'music' }, 'audio');
    add(/color|colour|warm|cool|contrast|saturat|exposure/.test(text), { label: 'Color',
      interpretedGoal: 'Apply a concrete, editable color adjustment.',
      instruction: /warm/.test(text) ? 'Make the existing video colors slightly warmer.'
        : 'Apply a subtle, consistent color treatment to the video.', kind: 'EDIT', target: 'video color' }, 'color');
    if (/don'?t change[^.]{0,80}crop|preserve (?:my )?(?:manual )?crop/.test(text)) {
      constraints.push('Preserve manual crop');
    }
    if (/don'?t change[^.]{0,80}speed|preserve (?:my )?speed/.test(text)) {
      constraints.push('Preserve speed');
    }
    if (/don'?t change[^.]{0,80}cuts?|preserve (?:my )?cuts?/.test(text)) {
      constraints.push('Preserve cuts');
    }
    if (/3d|particle explosion|generate (?:a )?(?:logo|music|image)|invent/.test(text)) {
      seeds.push({ label: 'Unsupported capability', interpretedGoal: 'Requested generated asset or effect.',
        instruction: '', kind: 'UNSUPPORTED', warning: 'This editor cannot create that asset or effect.' });
    }
    seeds.push({ label: 'Final review', interpretedGoal: 'Review the resulting canonical edit.',
      instruction: '', kind: 'REVIEW', target: 'current project' });
    const unaccounted = seeds.length === 1 ? [brief] : [];
    return { seeds, constraints, unaccounted };
  }
}
