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

    // History travel: "undo that" is the Undo button reached by typing. The
    // proposal carries no commands at all; Apply calls the existing history
    // path. If there is nothing to undo, the turn becomes a question rather
    // than a proposal that would fail later.
    if (intent.historyAction) {
      const availability = await this.editMode.historyAvailability(id);
      const direction = intent.historyAction;
      const possible = direction === 'UNDO' ? availability.canUndo : availability.canRedo;
      const targetAction = direction === 'UNDO' ? availability.undoAction
        : availability.redoAction;
      if (!possible) {
        this.telemetry('edit_mode_chat_clarification', { editProjectId: id, planner,
          reason: `NOTHING_TO_${direction}` });
        return this.clarificationTurn({ id, thread, userMessage, proposalId, context, planner,
          baseRevision: project.revision, message, summary: intent.summary,
          grounding: intent.grounding, warnings: intent.warnings,
          question: direction === 'UNDO'
            ? 'There is nothing to undo yet - this is the project as it was first saved.'
            : 'There is nothing to redo. Undo something first, then ask me to redo it.' });
      }
      const line = `${direction === 'UNDO' ? 'Undo' : 'Redo'} ${
        describeHistoryAction(targetAction)}`;
      const stored = await this.proposals.save({
        proposalId, editProjectId: id, baseRevision: project.revision, state: 'READY',
        userMessage: message, summary: `${line}?`, plannedChanges: [line],
        warnings: intent.warnings, needsClarification: false, clarificationQuestion: '',
        affectedElements: [], plannedDurationSec: context.project.timelineDurationSec,
        grounding: intent.grounding, commands: [], resolvedTargets: {}, planner,
        historyAction: direction
      });
      const assistant = this.message('ASSISTANT', stored.summary,
        { proposalId, state: 'READY', plannedChanges: [line] });
      const next = this.appendMessages(thread, [userMessage, assistant]);
      await this.persistThread(id, next);
      this.telemetry('edit_mode_chat_planned', { editProjectId: id, planner,
        kind: 'HISTORY', historyAction: direction, commandCount: 0 });
      return { proposal: proposalView(stored), messages: next.messages };
    }

    if (intent.needsClarification || !intent.commands.length) {
      this.telemetry('edit_mode_chat_clarification', { editProjectId: id, planner,
        reason: intent.intent });
      return this.clarificationTurn({ id, thread, userMessage, proposalId, context, planner,
        baseRevision: project.revision, message, summary: intent.summary,
        grounding: intent.grounding, warnings: intent.warnings,
        question: intent.clarificationQuestion || intent.summary ||
          'I need a bit more detail before I can change anything.' });
    }

    const resolution = resolveChatPlan(intent.commands, intent.grounding, context);
    if (!resolution.ok) {
      this.telemetry('edit_mode_chat_clarification', { editProjectId: id, planner,
        reason: 'UNRESOLVED_TARGET' });
      return this.clarificationTurn({ id, thread, userMessage, proposalId, context, planner,
        baseRevision: project.revision, message, summary: intent.summary,
        grounding: intent.grounding, warnings: [...intent.warnings, ...resolution.warnings],
        question: resolution.question });
    }

    const stored = await this.proposals.save({
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
    this.telemetry('edit_mode_chat_planned', { editProjectId: id, planner, kind: 'EDIT',
      commandCount: resolution.commands.length,
      destructive: resolution.commands.some((command) => command.kind === 'ELEMENT' &&
        ['TRIM_ELEMENT', 'DELETE_ELEMENT', 'SPLIT_ELEMENT', 'REMOVE_ELEMENT']
          .includes(command.action)),
      segmentsTouched: resolution.affectedElements.length,
      durable: this.proposals.durable });
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
    const proposal = proposalId ? await this.proposals.get(proposalId, id) : null;
    if (!proposal) throw new BadRequestException({ code: 'PROPOSAL_NOT_FOUND',
      message: 'That proposal has expired. Ask me again and I will re-plan it.' });
    if (proposal.state === 'APPLIED') throw new BadRequestException({ code: 'ALREADY_APPLIED',
      message: 'That proposal has already been applied' });
    if (proposal.needsClarification || (!proposal.commands.length && !proposal.historyAction)) {
      throw new BadRequestException({ code: 'NOTHING_TO_APPLY',
        message: 'That turn asked a question rather than proposing a change' });
    }

    const project = await this.prisma.editProject.findUnique({ where: { id },
      include: { elements: { select: { id: true, type: true, track: true, duration: true } } } });
    if (!project) throw new NotFoundException('EditProject not found');

    // History travel is applied through the existing undo/redo path. It is not
    // rebased against a revision: "undo that" always means the step that is on
    // top of the stack now, which is exactly what the Undo button would do.
    if (proposal.historyAction) return this.applyHistoryTravel(id, proposal);

    // Revision conflict: re-check rather than blindly applying.
    if (project.revision !== proposal.baseRevision) {
      const rebase = this.canRebase(proposal, project.elements);
      if (!rebase.ok) {
        await this.proposals.update(proposalId, id, { state: 'STALE' });
        this.telemetry('edit_mode_chat_stale_proposal', { editProjectId: id, proposalId,
          plannedAtRevision: proposal.baseRevision, currentRevision: project.revision });
        const thread = readChatThread(await this.settings(id));
        const next = this.appendMessages(thread, [this.message('SYSTEM_STATUS',
          `${rebase.reason} Ask me again and I will re-plan against the current timeline.`,
          { proposalId, state: 'STALE' })]);
        await this.persistThread(id, next);
        throw new BadRequestException({ code: 'STALE_PROPOSAL', message: rebase.reason,
          currentRevision: project.revision });
      }
      // The plan was built against an older revision but nothing it depends on
      // moved, so it is applied as planned. Counted, because a rising rate here
      // is what a too-permissive rebase rule would look like.
      this.telemetry('edit_mode_chat_safe_rebase', { editProjectId: id, proposalId,
        plannedAtRevision: proposal.baseRevision, currentRevision: project.revision });
    }

    await this.proposals.update(proposalId, id, { state: 'APPLYING' });
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
      await this.proposals.update(proposalId, id, { state: 'FAILED' });
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

    await this.proposals.remove(proposalId, id);
    this.telemetry('edit_mode_chat_applied', { editProjectId: id, proposalId,
      planner: proposal.planner, commandCount: proposal.commands.length,
      affected: result.affectedElementIds.length, revision: result.project.revision });
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
    const proposal = proposalId ? await this.proposals.get(proposalId, id) : null;
    if (proposal) await this.proposals.remove(proposalId, id);
    const thread = readChatThread(await this.settings(id));
    const next = this.appendMessages(thread, [this.message('SYSTEM_STATUS',
      'Cancelled - nothing was changed.', { proposalId, state: 'CANCELLED' })]);
    await this.persistThread(id, next);
    return { cancelled: true, messages: next.messages };
  }

  // --- internals ------------------------------------------------------------

  /**
   * A turn that ends in a question rather than a proposal.
   *
   * A clarification is still recorded as a proposal - state
   * NEEDS_CLARIFICATION, no commands - so the panel has something stable to
   * show, and so an Apply against it is refused by id rather than by guesswork.
   */
  private async clarificationTurn(input: {
    id: string; thread: ChatThread; userMessage: ChatMessage; proposalId: string;
    context: ChatContext; planner: ChatProposal['planner']; baseRevision: number;
    message: string; summary: string; grounding: ChatProposal['grounding'];
    warnings: string[]; question: string;
  }) {
    const assistant = this.message('ASSISTANT', input.question,
      { proposalId: input.proposalId, state: 'NEEDS_CLARIFICATION' });
    const next = this.appendMessages(input.thread, [input.userMessage, assistant]);
    await this.persistThread(input.id, next);
    const stored = await this.proposals.save({
      proposalId: input.proposalId, editProjectId: input.id, baseRevision: input.baseRevision,
      state: 'NEEDS_CLARIFICATION', userMessage: input.message, summary: input.summary,
      plannedChanges: [], warnings: input.warnings, needsClarification: true,
      clarificationQuestion: assistant.text, affectedElements: [],
      plannedDurationSec: input.context.project.timelineDurationSec,
      grounding: input.grounding, commands: [], resolvedTargets: {}, planner: input.planner
    });
    return { proposal: proposalView(stored), messages: next.messages };
  }

  /**
   * Applies "undo that" / "redo that" through the existing history path.
   *
   * No inverse command is built and no bundle is executed: this calls the very
   * method the Undo button calls, so a chat undo and a button undo produce the
   * same EditHistory row and leave the project in the same state. If the step
   * moved between plan and apply, the canonical layer's own NOTHING_TO_UNDO is
   * surfaced as a chat message rather than as a raw error.
   */
  private async applyHistoryTravel(id: string, proposal: ChatProposal) {
    const direction = proposal.historyAction === 'REDO' ? 'REDO' : 'UNDO';
    const current = await this.prisma.editProject.findUnique({ where: { id },
      select: { revision: true } });
    if (!current) throw new NotFoundException('EditProject not found');
    let project: Awaited<ReturnType<EditModeService['undo']>>;
    try {
      project = direction === 'UNDO' ? await this.editMode.undo(id, current.revision)
        : await this.editMode.redo(id, current.revision);
    } catch (error) {
      await this.proposals.update(proposal.proposalId, id, { state: 'FAILED' });
      const reason = error instanceof Error ? error.message
        : `That ${direction.toLowerCase()} could not be applied`;
      const failed = this.appendMessages(readChatThread(await this.settings(id)),
        [this.message('SYSTEM_STATUS', `That ${direction.toLowerCase()} did not happen: ${reason}`,
          { proposalId: proposal.proposalId, state: 'FAILED' })]);
      await this.persistThread(id, failed);
      throw error;
    }
    const thread = readChatThread(project.settings);
    const next = boundChatThread({ ...this.appendMessages(thread,
      [this.message('SYSTEM_STATUS', proposal.plannedChanges[0] ?? `${direction} applied.`,
        { proposalId: proposal.proposalId, state: 'APPLIED' })]),
    // The reference point for the next follow-up is no longer valid: the
    // elements the previous turn touched may have just been restored or
    // removed, so a bare "make it smaller" must ask rather than guess.
    lastAffectedElementIds: [], lastAppliedSummary: proposal.summary,
    lastAppliedAtRevision: project.revision });
    await this.editMode.saveChatThread(id, this.threadJson(next));
    await this.proposals.remove(proposal.proposalId, id);
    this.telemetry('edit_mode_chat_applied', { editProjectId: id,
      proposalId: proposal.proposalId, planner: proposal.planner, kind: 'HISTORY',
      historyAction: direction, revision: project.revision });
    return {
      proposal: proposalView({ ...proposal, state: 'APPLIED' as const }),
      project: { ...project, settings: { ...(project.settings as object),
        chat: this.threadJson(next) } },
      affectedElementIds: [] as string[],
      messages: next.messages
    };
  }

  /**
   * One structured counter line per notable chat event.
   *
   * Deliberately free of content: ids, counts and category names only. The
   * user's instruction, the proposal's sentences and anything drawn from the
   * transcript stay out of the log, so enabling this telemetry never turns
   * application logs into a copy of someone's private video.
   */
  private telemetry(event: string, fields: Record<string, unknown>) {
    this.logger.log(JSON.stringify({ event, ...fields }));
  }

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

/** The plain-language name of the step undo/redo would travel to. */
const HISTORY_ACTION_LABELS: Record<string, string> = {
  APPLY_PRESET: 'the preset you applied',
  APPLY_ASSISTANT_EDIT: 'the last edit I made',
  TRIM_ELEMENT: 'the trim', SPLIT_ELEMENT: 'the split',
  DELETE_ELEMENT: 'the segment removal', MOVE_ELEMENT: 'the reorder',
  ADD_TEXT: 'the text you added', ADD_IMAGE: 'the image you added',
  ADD_LOGO: 'the logo you added', ADD_AUDIO: 'the audio you added',
  REMOVE_ELEMENT: 'the removal', UPDATE_TEXT: 'the text change',
  SET_AUDIO_VOLUME: 'the volume change', SET_AUDIO_MUTED: 'the mute change'
};

const describeHistoryAction = (action: string | null) =>
  (action && HISTORY_ACTION_LABELS[action]) || 'the last change';

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
