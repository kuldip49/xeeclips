// EditMode Phase 6: the AI chat editor.
//
//   message + selection + playhead
//     -> bounded structured context (+ deterministic transcript search)
//     -> deterministic planner, or the LLM under a strict schema
//     -> validated ChatIntent
//     -> grounding + resolution against the live project
//     -> PROPOSAL (nothing written)
//     -> user Apply
//     -> canonical EditMode bundle -> ONE ASSISTANT history revision
//
// The chat is a front end to the existing editor, not a second editor. It owns
// no mutation code: every applied command goes through EditModeService, which
// runs it through the same element mutation and timeline validation the manual
// editor uses. This service never enqueues work, never creates ProcessingJob /
// ClipCandidate / GeneratedClip rows, never touches Project or Video records,
// and never triggers an export.

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { LlmRouterService } from '../../processing/llm-router.service';
import { PrismaService } from '../../database/prisma.service';
import { EditModeService, type AssistantBundleCommand } from '../edit-mode.service';
import { buildPresetEvidence } from '../presets/edit-preset-evidence';
import { readEditProjectStyle } from '../presets/edit-preset-policy';
import { validateChatIntent, type ChatIntent } from './edit-chat-commands';
import { buildChatContext, type ChatContext } from './edit-chat-context';
import { fallbackUnsupported, planDeterministicChat } from './edit-chat-deterministic';
import { planWithLlm } from './edit-chat-planner';
import { EditChatProposalStore } from './edit-chat-proposal-store';
import { resolveChatPlan, type ResolvedChatCommand } from './edit-chat-resolver';
import {
  boundChatThread, proposalView, readChatThread, type ChatMessage, type ChatProposal,
  type ChatThread
} from './edit-chat.types';

const MAX_MESSAGE_CHARS = 1000;

/** Time parameters that make a plan sensitive to the timeline changing. */
const TIME_SENSITIVE = ['startTime', 'duration', 'trimStart', 'trimEnd', 'playheadSec', 'atSec'];

@Injectable()
export class EditChatService {
  private readonly logger = new Logger(EditChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly editMode: EditModeService,
    private readonly proposals: EditChatProposalStore,
    private readonly llm: LlmRouterService
  ) {}

  /** The stored conversation for this project. */
  async thread(id: string) {
    const project = await this.prisma.editProject.findUnique({
      where: { id }, select: { settings: true, revision: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    const thread = readChatThread(project.settings);
    return { messages: thread.messages, revision: project.revision,
      lastAppliedSummary: thread.lastAppliedSummary };
  }

  /**
   * PLAN: turns one message into a proposal. Nothing about the edit is written.
   *
   * The conversation itself is persisted so the panel survives a reload, but
   * that is chat state, not project state: the revision does not move, no
   * element changes, no history row is written and no style setting changes.
   */
  async plan(id: string, input: {
    message?: unknown; revision?: unknown; selectedElementId?: unknown;
    selectedTimeRange?: unknown; playheadSec?: unknown;
  }) {
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message) throw new BadRequestException({ code: 'EMPTY_MESSAGE',
      message: 'Type what you would like to change' });
    if (message.length > MAX_MESSAGE_CHARS) throw new BadRequestException({
      code: 'MESSAGE_TOO_LONG',
      message: `Keep the instruction under ${MAX_MESSAGE_CHARS} characters` });

    const { project, context, thread } = await this.loadContext(id, message, input);

    let intent: ChatIntent;
    let planner: ChatProposal['planner'] = 'DETERMINISTIC';
    const deterministic = planDeterministicChat(message, context);
    if (deterministic) {
      intent = deterministic;
    } else {
      const llmPlan = await this.tryLlm(message, context);
      if (llmPlan) { intent = llmPlan; planner = 'LLM'; }
      else intent = fallbackUnsupported(context);
    }

    const proposalId = randomUUID();
    const userMessage = this.message('USER', message);

    if (intent.needsClarification || !intent.commands.length) {
      const assistant = this.message('ASSISTANT', intent.clarificationQuestion ||
        intent.summary || 'I need a bit more detail before I can change anything.',
      { proposalId, state: 'NEEDS_CLARIFICATION' });
      const next = this.appendMessages(thread, [userMessage, assistant]);
      await this.persistThread(id, next);
      const stored = this.proposals.save({
        proposalId, editProjectId: id, baseRevision: project.revision,
        state: 'NEEDS_CLARIFICATION', userMessage: message, summary: intent.summary,
        plannedChanges: [], warnings: intent.warnings, needsClarification: true,
        clarificationQuestion: assistant.text, affectedElements: [],
        plannedDurationSec: context.project.timelineDurationSec,
        grounding: intent.grounding, commands: [], resolvedTargets: {}, planner
      });
      return { proposal: proposalView(stored), messages: next.messages };
    }

    const resolution = resolveChatPlan(intent.commands, intent.grounding, context);
    if (!resolution.ok) {
      const assistant = this.message('ASSISTANT', resolution.question,
        { proposalId, state: 'NEEDS_CLARIFICATION' });
      const next = this.appendMessages(thread, [userMessage, assistant]);
      await this.persistThread(id, next);
      const stored = this.proposals.save({
        proposalId, editProjectId: id, baseRevision: project.revision,
        state: 'NEEDS_CLARIFICATION', userMessage: message, summary: intent.summary,
        plannedChanges: [], warnings: [...intent.warnings, ...resolution.warnings],
        needsClarification: true, clarificationQuestion: resolution.question,
        affectedElements: [], plannedDurationSec: context.project.timelineDurationSec,
        grounding: intent.grounding, commands: [],
        resolvedTargets: {}, planner
      });
      return { proposal: proposalView(stored), messages: next.messages };
    }

    const stored = this.proposals.save({
      proposalId, editProjectId: id, baseRevision: project.revision, state: 'READY',
      userMessage: message, summary: intent.summary || 'Apply these changes?',
      plannedChanges: resolution.plannedChanges,
      warnings: [...intent.warnings, ...resolution.warnings],
      needsClarification: false, clarificationQuestion: '',
      affectedElements: resolution.affectedElements,
      plannedDurationSec: context.project.timelineDurationSec, grounding: intent.grounding,
      commands: resolution.commands,
      resolvedTargets: Object.fromEntries(resolution.affectedElements.map((value, index) =>
        [index, value])),
      planner
    });
    const assistant = this.message('ASSISTANT', stored.summary,
      { proposalId, state: 'READY', plannedChanges: resolution.plannedChanges });
    const next = this.appendMessages(thread, [userMessage, assistant]);
    await this.persistThread(id, next);
    return { proposal: proposalView(stored), messages: next.messages };
  }

  /**
   * APPLY: executes the server-held bundle as one ASSISTANT revision.
   *
   * The client sends a proposalId and nothing else, so the commands executed
   * are exactly the ones that were planned and validated. Before executing,
   * the proposal is re-checked against the project as it stands now.
   */
  async apply(id: string, input: { proposalId?: unknown; revision?: unknown }) {
    const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
    const proposal = proposalId ? this.proposals.get(proposalId, id) : null;
    if (!proposal) throw new BadRequestException({ code: 'PROPOSAL_NOT_FOUND',
      message: 'That proposal has expired. Ask me again and I will re-plan it.' });
    if (proposal.state === 'APPLIED') throw new BadRequestException({ code: 'ALREADY_APPLIED',
      message: 'That proposal has already been applied' });
    if (proposal.needsClarification || !proposal.commands.length) {
      throw new BadRequestException({ code: 'NOTHING_TO_APPLY',
        message: 'That turn asked a question rather than proposing a change' });
    }

    const project = await this.prisma.editProject.findUnique({ where: { id },
      include: { elements: { select: { id: true, type: true, track: true, duration: true } } } });
    if (!project) throw new NotFoundException('EditProject not found');

    // Revision conflict: re-check rather than blindly applying.
    if (project.revision !== proposal.baseRevision) {
      const rebase = this.canRebase(proposal, project.elements);
      if (!rebase.ok) {
        this.proposals.update(proposalId, { state: 'STALE' });
        const thread = readChatThread(await this.settings(id));
        const next = this.appendMessages(thread, [this.message('SYSTEM_STATUS',
          `${rebase.reason} Ask me again and I will re-plan against the current timeline.`,
          { proposalId, state: 'STALE' })]);
        await this.persistThread(id, next);
        throw new BadRequestException({ code: 'STALE_PROPOSAL', message: rebase.reason,
          currentRevision: project.revision });
      }
    }

    this.proposals.update(proposalId, { state: 'APPLYING' });
    const thread = readChatThread(await this.settings(id));
    let result: Awaited<ReturnType<EditModeService['applyAssistantBundle']>>;
    try {
      result = await this.editMode.applyAssistantBundle(id, project.revision, {
        proposalId, summary: proposal.summary, userMessage: proposal.userMessage,
        commands: proposal.commands.map(toBundleCommand),
        chat: this.threadJson(this.appendMessages(thread, [this.message('SYSTEM_STATUS',
          proposal.summary, { proposalId, state: 'APPLIED',
            plannedChanges: proposal.plannedChanges })], {
          lastAppliedSummary: proposal.summary
        }))
      });
    } catch (error) {
      this.proposals.update(proposalId, { state: 'FAILED' });
      const message = error instanceof Error ? error.message : 'The edit could not be applied';
      const failed = this.appendMessages(readChatThread(await this.settings(id)),
        [this.message('SYSTEM_STATUS', `That edit was not applied: ${message}`,
          { proposalId, state: 'FAILED' })]);
      await this.persistThread(id, failed);
      throw error;
    }

    // The applied turn becomes the reference point for the next follow-up.
    const applied = readChatThread(result.project.settings);
    const withTargets = boundChatThread({ ...applied,
      lastAffectedElementIds: [...result.affectedElementIds, ...applied.lastAffectedElementIds],
      lastAppliedSummary: proposal.summary,
      lastAppliedAtRevision: result.project.revision });
    await this.editMode.saveChatThread(id, this.threadJson(withTargets));

    this.proposals.update(proposalId, { state: 'APPLIED' });
    this.proposals.remove(proposalId);
    this.logger.log(JSON.stringify({ event: 'edit_mode_chat_applied', editProjectId: id,
      proposalId, planner: proposal.planner, commandCount: proposal.commands.length,
      revision: result.project.revision }));
    return {
      proposal: proposalView({ ...proposal, state: 'APPLIED' }),
      project: { ...result.project, settings: { ...(result.project.settings as object),
        chat: this.threadJson(withTargets) } },
      affectedElementIds: result.affectedElementIds,
      messages: withTargets.messages
    };
  }

  /** CANCEL: drops a pending proposal. Nothing about the project changes. */
  async cancel(id: string, input: { proposalId?: unknown }) {
    const proposalId = typeof input.proposalId === 'string' ? input.proposalId : '';
    const proposal = proposalId ? this.proposals.get(proposalId, id) : null;
    if (proposal) this.proposals.remove(proposalId);
    const thread = readChatThread(await this.settings(id));
    const next = this.appendMessages(thread, [this.message('SYSTEM_STATUS',
      'Cancelled - nothing was changed.', { proposalId, state: 'CANCELLED' })]);
    await this.persistThread(id, next);
    return { cancelled: true, messages: next.messages };
  }

  // --- internals ------------------------------------------------------------

  /** Loads the project and builds the bounded context for one turn. */
  private async loadContext(id: string, message: string, input: {
    revision?: unknown; selectedElementId?: unknown;
    selectedTimeRange?: unknown; playheadSec?: unknown;
  }) {
    const project = await this.prisma.editProject.findUnique({ where: { id }, include: {
      assets: { orderBy: { createdAt: 'asc' } },
      elements: { orderBy: [{ track: 'asc' }, { position: 'asc' }] }
    } });
    if (!project) throw new NotFoundException('EditProject not found');
    if (input.revision !== undefined && Number(input.revision) !== project.revision) {
      throw new BadRequestException({ code: 'STALE_REVISION',
        message: 'This project changed in another tab. Reload before editing by chat.',
        currentRevision: project.revision });
    }
    const source = project.assets.find((asset) => asset.role === 'SOURCE');
    if (!source) throw new BadRequestException({ code: 'NO_SOURCE',
      message: 'Attach a source video before editing by chat' });

    const style = readEditProjectStyle(project.settings);
    // Cached transcript and cached visual analysis only. A chat turn never
    // re-transcribes, never re-analyses and never renders.
    const evidence = buildPresetEvidence({
      durationSec: source.duration ?? 0, width: source.width, height: source.height,
      metadata: source.metadata, transcript: source.transcript, analysis: source.analysis,
      aspectRatio: style.aspectRatio,
      preserveInformation: style.informationRegionPolicy !== 'IGNORE'
    });
    const thread = readChatThread(project.settings);
    const context = buildChatContext({
      revision: project.revision, settings: project.settings, style,
      elements: project.elements.map((element) => ({
        id: element.id, type: element.type, track: element.track, position: element.position,
        startTime: element.startTime, duration: element.duration, assetId: element.assetId,
        trimStart: element.trimStart, trimEnd: element.trimEnd,
        properties: element.properties && typeof element.properties === 'object' &&
          !Array.isArray(element.properties)
          ? element.properties as Record<string, unknown> : {}
      })),
      assets: project.assets.map((asset) => ({ id: asset.id, role: asset.role,
        originalName: asset.originalName, duration: asset.duration,
        width: asset.width, height: asset.height })),
      evidence, thread, message,
      selection: {
        selectedElementId: typeof input.selectedElementId === 'string'
          ? input.selectedElementId : null,
        selectedTimeRange: parseRange(input.selectedTimeRange),
        playheadSec: Number.isFinite(Number(input.playheadSec)) ? Number(input.playheadSec) : 0
      }
    });
    return { project, context, thread };
  }

  /**
   * Runs the model planner, converting every failure into "no plan".
   *
   * A provider outage, a timeout, a truncated response or - the case that
   * matters most for OFFLINE - a small local model emitting malformed or
   * unsupported commands all land here. None of them can mutate anything:
   * the turn degrades to the deterministic planner or to an honest refusal.
   */
  private async tryLlm(message: string, context: ChatContext): Promise<ChatIntent | null> {
    try {
      const planned = await planWithLlm({ llm: this.llm, logger: this.logger, message, context });
      return planned?.intent ?? null;
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'edit_mode_chat_plan_rejected',
        reason: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }

  /**
   * Whether a proposal built against an older revision is still safe to apply.
   *
   * Conservative on purpose. Every element the plan resolved must still exist,
   * and a plan carrying absolute times is only rebased when the timeline length
   * has not moved - otherwise "show this from 10 to 14 seconds" could land
   * somewhere the user never meant.
   */
  private canRebase(proposal: ChatProposal,
    elements: Array<{ id: string; type: string; track: number; duration: number }>):
    { ok: true } | { ok: false; reason: string } {
    const live = new Set(elements.map((element) => element.id));
    const missing = proposal.affectedElements.filter((elementId) => !live.has(elementId));
    if (missing.length) {
      return { ok: false, reason: 'The timeline changed and something this edit referred to is ' +
        'no longer there.' };
    }
    const timeSensitive = proposal.commands.some((command) => command.kind === 'ELEMENT' &&
      TIME_SENSITIVE.some((key) => command.payload[key] !== undefined));
    if (!timeSensitive) return { ok: true };
    const duration = elements.filter((element) => element.type === 'VIDEO' && element.track === 0)
      .reduce((total, element) => total + element.duration, 0);
    return Math.abs(duration - proposal.plannedDurationSec) <= 1e-3 ? { ok: true }
      : { ok: false, reason: 'The timeline length changed after this was planned, so its ' +
        'timings may no longer be right.' };
  }

  private message(role: ChatMessage['role'], text: string,
    extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id: randomUUID(), role, text, createdAt: new Date().toISOString(), ...extra };
  }

  private appendMessages(thread: ChatThread, messages: ChatMessage[],
    changes: Partial<ChatThread> = {}): ChatThread {
    return boundChatThread({ ...thread, ...changes,
      messages: [...thread.messages, ...messages] });
  }

  private threadJson(thread: ChatThread) {
    return JSON.parse(JSON.stringify(boundChatThread(thread))) as Prisma.InputJsonValue;
  }

  private async settings(id: string) {
    const project = await this.prisma.editProject.findUnique({
      where: { id }, select: { settings: true } });
    return project?.settings ?? {};
  }

  /** Writes only the conversation. Never touches revision, elements or style. */
  private async persistThread(id: string, thread: ChatThread) {
    await this.editMode.saveChatThread(id, this.threadJson(thread));
  }
}

/** A resolved chat command, in the shape the canonical bundle executor takes. */
const toBundleCommand = (command: ResolvedChatCommand): AssistantBundleCommand =>
  command.kind === 'SETTINGS'
    ? { kind: 'SETTINGS', action: command.action,
      payload: command.payload as Record<string, unknown> }
    : { kind: 'ELEMENT', action: command.action,
      ...(command.ref ? { ref: command.ref } : {}), payload: command.payload };

const parseRange = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const startSec = Number(record.startSec);
  const endSec = Number(record.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
  return { startSec, endSec };
};

/** Re-exported so tests can reach the validator through the service module. */
export { validateChatIntent };
