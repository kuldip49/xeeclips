// EditMode Phase 6 + Workstream G: the AI chat editor.
import { editProjectEvidence } from '../../content-intelligence/edit-project-evidence';
//
//   message + selection + range + playhead
//     -> bounded structured context: objects behind opaque handles, semantic
//        roles, the conversational active target (+ transcript search)
//     -> history travel | unsupported capability | natural-language layer
//        (deterministic, works OFFLINE) | Phase 6 direct planner | model
//     -> validated ChatIntent (creative hook wording and templates are
//        fulfilled through their own grounded paths)
//     -> grounding + resolution against the live project
//     -> PROPOSAL with concrete before -> after lines (nothing written)
//     -> user Apply
//     -> canonical EditMode bundle -> ONE ASSISTANT history revision
//        (a template goes through Workstream F's own apply -> ONE TEMPLATE revision)
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
import { EditTemplateService } from '../edit-template.service';
import { buildPresetEvidence } from '../presets/edit-preset-evidence';
import { readEditProjectStyle } from '../presets/edit-preset-policy';
import { builtinTemplateList } from '../templates/edit-template-library';
import { validateChatIntent, type ChatCommand, type ChatGrounding,
  type ChatIntent } from './edit-chat-commands';
import { buildChatContext, type ChatContext, type ChatElementView } from './edit-chat-context';
import { fallbackUnsupported, historyTravel, planDeterministicChat } from './edit-chat-deterministic';
import { deterministicHookSuggestions, modelHookSuggestions, type HookMode,
  type HookSuggestion } from './edit-chat-hook';
import { parseNaturalRequest, unsupportedCapability, type ClauseOutcome,
  type FollowUp } from './edit-chat-intents';
import { planWithLlm } from './edit-chat-planner';
import { EditChatProposalStore } from './edit-chat-proposal-store';
import { resolveChatPlan, type ResolvedChatCommand } from './edit-chat-resolver';
import {
  boundChatThread, CHAT_MAX_TRIED_HOOKS, proposalView, readChatThread, type ChatActiveTarget,
  type ChatChange, type ChatMessage, type ChatOutcomeCode, type ChatProposal, type ChatRoute,
  type ChatThread
} from './edit-chat.types';

const MAX_MESSAGE_CHARS = 1000;
const MAX_CONTEXT_TEMPLATES = 24;

/** Time parameters that make a plan sensitive to the timeline changing. */
const TIME_SENSITIVE = ['startTime', 'duration', 'trimStart', 'trimEnd', 'playheadSec', 'atSec',
  'targetAtSec'];

/** One planned turn, before it becomes a stored proposal. */
type PlannedTurn = {
  intent: ChatIntent;
  route: ChatRoute;
  followUp: FollowUp | null;
  hookOffered: { elementId: string | null; text: string } | null;
  code?: ChatOutcomeCode;
};

@Injectable()
export class EditChatService {
  private readonly logger = new Logger(EditChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly editMode: EditModeService,
    private readonly proposals: EditChatProposalStore,
    private readonly llm: LlmRouterService,
    private readonly templates: EditTemplateService
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
    const started = Date.now();
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message) throw new BadRequestException({ code: 'EMPTY_MESSAGE',
      message: 'Type what you would like to change' });
    if (message.length > MAX_MESSAGE_CHARS) throw new BadRequestException({
      code: 'MESSAGE_TOO_LONG',
      message: `Keep the instruction under ${MAX_MESSAGE_CHARS} characters` });

    const { project, context, thread } = await this.loadContext(id, message, input);
    const proposalId = randomUUID();
    const userMessage = this.message('USER', message);
    const selectionId = context.runtime.selectedElementId;

    // --- 1. History travel ------------------------------------------------------
    // "undo that" is the Undo button reached by typing. The proposal carries no
    // commands; Apply calls the existing history path.
    const travel = historyTravel(message);
    if (travel?.historyAction) {
      const availability = await this.editMode.historyAvailability(id);
      const direction = travel.historyAction;
      const possible = direction === 'UNDO' ? availability.canUndo : availability.canRedo;
      const targetAction = direction === 'UNDO' ? availability.undoAction
        : availability.redoAction;
      if (!possible) {
        this.telemetry('edit_mode_chat_clarification', { editProjectId: id,
          reason: `NOTHING_TO_${direction}` });
        return this.clarificationTurn({ id, thread, userMessage, proposalId, context,
          planner: 'DETERMINISTIC', baseRevision: project.revision, message,
          summary: travel.summary, grounding: travel.grounding, warnings: [],
          route: 'HISTORY',
          question: direction === 'UNDO'
            ? 'There is nothing to undo yet - this is the project as it was first saved.'
            : 'There is nothing to redo. Undo something first, then ask me to redo it.' });
      }
      const line = `${direction === 'UNDO' ? 'Undo' : 'Redo'} ${
        describeHistoryAction(targetAction)}`;
      const stored = await this.proposals.save({
        proposalId, editProjectId: id, baseRevision: project.revision, state: 'READY',
        userMessage: message, summary: `${line}?`, plannedChanges: [line], changes: [],
        warnings: [], needsClarification: false, clarificationQuestion: '',
        affectedElements: [], plannedDurationSec: context.project.timelineDurationSec,
        grounding: travel.grounding, commands: [], resolvedTargets: {}, planner: 'DETERMINISTIC',
        route: 'HISTORY', historyAction: direction
      });
      const assistant = this.message('ASSISTANT', stored.summary,
        { proposalId, state: 'READY', plannedChanges: [line] });
      const next = this.appendMessages(thread, [userMessage, assistant]);
      await this.persistThread(id, next);
      this.telemetry('edit_mode_chat_planned', { editProjectId: id, route: 'HISTORY',
        historyAction: direction, commandCount: 0, ms: Date.now() - started });
      return { proposal: proposalView(stored), messages: next.messages };
    }

    // --- 2. A capability the editor does not have --------------------------------
    const unsupported = unsupportedCapability(message);
    if (unsupported) {
      this.telemetry('edit_mode_chat_unsupported', { editProjectId: id });
      return this.clarificationTurn({ id, thread, userMessage, proposalId, context,
        planner: 'DETERMINISTIC', baseRevision: project.revision, message,
        summary: 'That edit is not available.', grounding: [], warnings: [],
        code: 'UNSUPPORTED_EDIT_CAPABILITY', route: 'NONE', question: unsupported });
    }

    // --- 3. Plan -------------------------------------------------------------------
    const planned = await this.planTurn(id, message, context);
    if ('template' in planned) {
      return this.templateTurn({ id, thread, userMessage, proposalId, context, message,
        baseRevision: project.revision, template: planned.template, started });
    }
    const { intent, route, followUp, hookOffered } = planned;
    const planner: ChatProposal['planner'] = route === 'LLM' || route === 'CREATIVE_LLM'
      ? 'LLM' : 'DETERMINISTIC';

    if (intent.needsClarification || !intent.commands.length) {
      const code = planned.code ?? (intent.intent === 'UNSUPPORTED'
        ? 'UNSUPPORTED_EDIT_CAPABILITY' : undefined);
      this.telemetry('edit_mode_chat_clarification', { editProjectId: id, route,
        reason: code ?? intent.intent, ms: Date.now() - started });
      return this.clarificationTurn({ id, thread, userMessage, proposalId, context, planner,
        baseRevision: project.revision, message, summary: intent.summary,
        grounding: intent.grounding, warnings: intent.warnings, code, route,
        question: intent.clarificationQuestion || intent.summary ||
          'I need a bit more detail before I can change anything.' });
    }

    const resolution = resolveChatPlan(intent.commands, intent.grounding, context);
    if (!resolution.ok) {
      this.telemetry('edit_mode_chat_clarification', { editProjectId: id, route,
        reason: 'UNRESOLVED_TARGET', ms: Date.now() - started });
      return this.clarificationTurn({ id, thread, userMessage, proposalId, context, planner,
        baseRevision: project.revision, message, summary: intent.summary,
        grounding: intent.grounding, warnings: [...intent.warnings, ...resolution.warnings],
        code: 'NEEDS_TARGET', route, question: resolution.question });
    }

    const stored = await this.proposals.save({
      proposalId, editProjectId: id, baseRevision: project.revision, state: 'READY',
      userMessage: message, summary: intent.summary || 'Apply these changes?',
      plannedChanges: resolution.plannedChanges, changes: resolution.changes,
      warnings: [...new Set([...intent.warnings, ...resolution.warnings])],
      needsClarification: false, clarificationQuestion: '',
      affectedElements: resolution.affectedElements,
      plannedDurationSec: context.project.timelineDurationSec, grounding: intent.grounding,
      commands: resolution.commands,
      resolvedTargets: Object.fromEntries(resolution.affectedElements.map((value, index) =>
        [index, value])),
      planner, route,
      followUp: followUp ? { ...followUp, selectionId, revision: project.revision } : null,
      hookOffered
    });
    const assistant = this.message('ASSISTANT', stored.summary,
      { proposalId, state: 'READY', plannedChanges: resolution.plannedChanges });
    const remembered: ChatThread = { ...thread,
      lastProposal: stored.followUp ?? thread.lastProposal,
      hook: hookOffered ? this.rememberHook(thread, hookOffered) : thread.hook };
    const next = this.appendMessages(remembered, [userMessage, assistant]);
    await this.persistThread(id, next);
    this.telemetry('edit_mode_chat_planned', { editProjectId: id, planner, route, kind: 'EDIT',
      commandCount: resolution.commands.length,
      destructive: resolution.commands.some((command) => command.kind === 'ELEMENT' &&
        ['TRIM_ELEMENT', 'DELETE_ELEMENT', 'SPLIT_ELEMENT', 'REMOVE_ELEMENT']
          .includes(command.action)),
      segmentsTouched: resolution.affectedElements.length,
      durable: this.proposals.durable, ms: Date.now() - started });
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
    if (proposal.needsClarification || (!proposal.commands.length && !proposal.historyAction &&
      !proposal.templateAction)) {
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
      const rebase = proposal.templateAction
        ? { ok: false as const, reason: 'The project changed after this template preview.' }
        : this.canRebase(proposal, project.elements);
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

    if (proposal.templateAction) return this.applyTemplate(id, proposal, project.revision);

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

    // The applied turn becomes the reference point for the next follow-up:
    // "a little more" repeats this family on these elements.
    const applied = readChatThread(result.project.settings);
    const created = result.affectedElementIds.filter((elementId) =>
      !project.elements.some((element) => element.id === elementId));
    const active = proposal.followUp ? {
      ...proposal.followUp,
      elementIds: proposal.followUp.elementIds.length ? proposal.followUp.elementIds
        : created.length ? created : proposal.followUp.elementIds,
      revision: result.project.revision
    } : applied.active;
    const hookElement = proposal.hookOffered
      ? proposal.hookOffered.elementId ?? created[0] ?? null : null;
    const withTargets = boundChatThread({ ...applied,
      lastAffectedElementIds: [...result.affectedElementIds, ...applied.lastAffectedElementIds],
      lastAppliedSummary: proposal.summary,
      lastAppliedAtRevision: result.project.revision,
      active,
      hook: hookElement ? { ...applied.hook, elementId: hookElement } : applied.hook });
    await this.editMode.saveChatThread(id, this.threadJson(withTargets));

    await this.proposals.remove(proposalId, id);
    this.telemetry('edit_mode_chat_applied', { editProjectId: id, proposalId,
      planner: proposal.planner, route: proposal.route, commandCount: proposal.commands.length,
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

  // --- planning -----------------------------------------------------------------

  /**
   * Chooses how this turn is planned.
   *
   * The deterministic natural-language layer goes first because it is exact,
   * instant and works OFFLINE. The Phase 6 direct planner covers timeline
   * shapes (cuts, ranges, splits, adding uploads, aspect ratio). A model is
   * asked only for what neither understood, and only where the frozen routing
   * allows one (ONLINE). Nothing matched is an honest question, never a menu.
   */
  private async planTurn(id: string, message: string, context: ChatContext):
    Promise<PlannedTurn | { template: { id: string; name: string } }> {
    const natural = parseNaturalRequest(message, context);
    if (natural) {
      const templates = natural.outcomes.filter((outcome) => outcome.type === 'TEMPLATE');
      if (templates.length) {
        if (natural.outcomes.length === 1 && !natural.unparsed.length) {
          const template = templates[0] as Extract<ClauseOutcome, { type: 'TEMPLATE' }>;
          return { template: { id: template.template.id, name: template.template.name } };
        }
        return this.question('A template restyles the whole project, so apply it on its own ' +
          'first, then ask for the other changes.', 'DETERMINISTIC');
      }
      const question = natural.outcomes.find((outcome) => outcome.type === 'QUESTION') as
        Extract<ClauseOutcome, { type: 'QUESTION' }> | undefined;
      if (question) {
        const held = natural.outcomes.length > 1 ? ' (I have held the other changes until this is ' +
          'clear.)' : '';
        return this.question(`${question.question}${held}`, 'DETERMINISTIC',
          question.code ?? undefined);
      }
      return this.assembleNatural(id, message, natural.outcomes, natural.unparsed, context);
    }

    const direct = planDeterministicChat(message, context);
    if (direct) return { intent: direct, route: 'DETERMINISTIC', followUp: null, hookOffered: null };

    const model = await this.tryLlm(message, context);
    if (model) {
      return { intent: model, route: 'LLM', followUp: modelFollowUp(model, context),
        hookOffered: null,
        ...(model.intent === 'UNSUPPORTED' ? { code: 'UNSUPPORTED_EDIT_CAPABILITY' as const } : {}) };
    }
    return { intent: fallbackUnsupported(context), route: 'NONE', followUp: null,
      hookOffered: null, code: 'NOT_UNDERSTOOD' };
  }

  /** Combines the clauses of one message into one bounded command bundle. */
  private async assembleNatural(id: string, message: string, outcomes: ClauseOutcome[],
    unparsed: string[], context: ChatContext): Promise<PlannedTurn> {
    const commands: ChatCommand[] = [];
    const grounding: ChatGrounding[] = [];
    const warnings: string[] = [];
    const summaries: string[] = [];
    let followUp: FollowUp | null = null;
    let hookOffered: PlannedTurn['hookOffered'] = null;
    let route: ChatRoute = 'DETERMINISTIC';

    for (const outcome of outcomes) {
      if (outcome.type === 'COMMANDS') {
        commands.push(...outcome.commands);
        grounding.push(...outcome.grounding);
        warnings.push(...outcome.warnings);
        summaries.push(outcome.summary);
        if (outcome.followUp) followUp = outcome.followUp;
        continue;
      }
      if (outcome.type === 'UNSUPPORTED') {
        return this.question(outcome.message, 'DETERMINISTIC', 'UNSUPPORTED_EDIT_CAPABILITY');
      }
      if (outcome.type !== 'HOOK') continue;
      const creative = await this.writeHook(outcome.mode, outcome.target, context);
      if ('question' in creative) return this.question(creative.question, creative.route, creative.code);
      route = creative.suggestion.source === 'LLM' ? 'CREATIVE_LLM' : 'CREATIVE_DETERMINISTIC';
      hookOffered = { elementId: outcome.target?.id ?? null, text: creative.suggestion.text };
      commands.push(...hookCommands(creative.suggestion.text, outcome.target, context));
      grounding.push({ type: 'TRANSCRIPT', confidence: 0.85,
        evidence: `Written from the video's own words (${creative.suggestion.source === 'LLM'
          ? 'model' : 'deterministic'} candidate, grounding-checked).` });
      summaries.push(outcome.target ? hookSummary(outcome.mode) : 'Add an opening hook.');
      followUp = { family: 'CONTENT', direction: 1, vector: null, task: 'HOOK_REWRITE',
        elementIds: outcome.target ? [outcome.target.id] : [] };
    }

    // Clauses nothing understood: ONLINE, the model may plan just those; they
    // are never silently dropped.
    if (unparsed.length) {
      const rest = unparsed.join(', ');
      const model = commands.length ? await this.tryLlm(rest, context) : null;
      if (model && !model.needsClarification && model.commands.length) {
        commands.push(...model.commands);
        grounding.push(...model.grounding);
        summaries.push(model.summary);
        route = 'LLM';
      } else if (commands.length) {
        warnings.push(`I did not act on "${rest}" - I could not tell what to change there.`);
      } else {
        const planned = await this.planTurn(id, rest, context);
        if (!('template' in planned)) return planned;
      }
    }
    return {
      intent: { intent: 'EDIT_PROJECT', summary: summaries.join(' '), commands, grounding,
        warnings, needsClarification: false, clarificationQuestion: '' },
      route, followUp, hookOffered
    };
  }

  /**
   * Step 7 agent seam: grounded hook wording resolved all the way to canonical
   * bundle commands (or an honest question). Same writer, same grounding gate.
   */
  async agentHookCommands(mode: HookMode, target: ChatElementView | null, context: ChatContext):
    Promise<{ commands: AssistantBundleCommand[]; line: string; text: string;
      source: 'LLM' | 'DETERMINISTIC' } | { question: string }> {
    const creative = await this.writeHook(mode, target, context);
    if ('question' in creative) return { question: creative.question };
    const text = creative.suggestion.text;
    const resolution = resolveChatPlan(hookCommands(text, target, context), [], context);
    if (!resolution.ok) return { question: resolution.question };
    return { commands: resolution.commands.map(toBundleCommand),
      line: target ? `Hook -> "${text}"` : `Add hook "${text}"`, text,
      source: creative.suggestion.source === 'LLM' ? 'LLM' : 'DETERMINISTIC' };
  }

  /**
   * Wording for the hook: model candidates ONLINE, grounded deterministic
   * candidates always, each through the same grounding gate. OFFLINE never
   * calls a model (the frozen router allows no model for this role offline).
   */
  private async writeHook(mode: HookMode, target: ChatElementView | null, context: ChatContext):
    Promise<{ suggestion: HookSuggestion } |
      { question: string; route: ChatRoute; code: ChatOutcomeCode }> {
    const current = target ? String(target.properties.content ?? '').trim() || null : null;
    const memory = context.runtime.thread.hook;
    const tried = (memory.elementId === (target?.id ?? null) ? memory.tried : [])
      .slice(-CHAT_MAX_TRIED_HOOKS);
    if (!context.transcript.available) {
      return { question: 'I write hooks from what is said in the video, and this source has not ' +
        'been analysed yet. Run "Analyze source" first - or tell me the exact wording and I will ' +
        'use it.', route: 'NONE', code: 'CREATIVE_UNAVAILABLE' };
    }
    const input = { mode, current, tried, opening: context.transcript.opening,
      transcript: context.runtime.creativeEvidence?.transcript ?? context.runtime.groundingText,
      evidence: context.runtime.creativeEvidence };
    const model = await modelHookSuggestions({ llm: this.llm, logger: this.logger, ...input });
    if (model.suggestions.length) return { suggestion: model.suggestions[0] };
    const local = deterministicHookSuggestions(input);
    if (local.length) return { suggestion: local[0] };
    const why = mode === 'SHORTER'
      ? 'That hook is already about as short as a complete headline can be.'
      : `I couldn't find another headline that is supported by what is said in the video${
        tried.length ? ` - I have already shown you ${tried.length}` : ''}.`;
    return { question: `${why}${model.attempted ? '' : ` ${mode === 'SHORTER'
      ? 'Rewording it more tightly' : 'Writing a fresh angle'} needs ONLINE AI mode; direct edits ` +
      'still work.'} You can also tell me the exact wording.`,
    route: model.attempted ? 'CREATIVE_LLM' : 'CREATIVE_DETERMINISTIC',
    code: 'CREATIVE_UNAVAILABLE' };
  }

  private question(question: string, route: ChatRoute, code?: ChatOutcomeCode): PlannedTurn {
    return { intent: { intent: 'NEEDS_CLARIFICATION', summary: question, commands: [],
      grounding: [], warnings: [], needsClarification: true, clarificationQuestion: question },
    route, followUp: null, hookOffered: null, ...(code ? { code } : {}) };
  }

  // --- templates --------------------------------------------------------------

  /**
   * A template turn is Workstream F's own PREVIEW, verbatim: the same diff the
   * Templates panel shows, and nothing the chat invented. Apply is F's own apply.
   */
  private async templateTurn(input: { id: string; thread: ChatThread; userMessage: ChatMessage;
    proposalId: string; context: ChatContext; message: string; baseRevision: number;
    template: { id: string; name: string }; started: number }) {
    const preview = await this.templates.preview(input.id,
      { templateId: input.template.id, revision: input.baseRevision });
    const changes: ChatChange[] = preview.changes.slice(0, 12).map((change) => ({
      label: change.label, before: change.from, after: change.to
    }));
    const plannedChanges = [
      ...preview.changes.slice(0, 12).map((change) => `${change.label}: ${change.to}`),
      ...preview.preserved.slice(0, 6).map((kept) => `Keep ${kept.label} (${kept.reason})`)
    ];
    const summary = `Apply the ${input.template.name} template?`;
    const stored = await this.proposals.save({
      proposalId: input.proposalId, editProjectId: input.id, baseRevision: input.baseRevision,
      state: 'READY', userMessage: input.message, summary, plannedChanges, changes,
      warnings: preview.warnings, needsClarification: false, clarificationQuestion: '',
      affectedElements: [], plannedDurationSec: input.context.project.timelineDurationSec,
      grounding: [{ type: 'CONTEXT', confidence: 0.95,
        evidence: `Template "${input.template.name}" named in the request.` }],
      commands: [], resolvedTargets: {}, planner: 'DETERMINISTIC', route: 'TEMPLATE',
      templateAction: { templateId: input.template.id, templateName: input.template.name }
    });
    const assistant = this.message('ASSISTANT', summary,
      { proposalId: input.proposalId, state: 'READY', plannedChanges });
    const next = this.appendMessages(input.thread, [input.userMessage, assistant]);
    await this.persistThread(input.id, next);
    this.telemetry('edit_mode_chat_planned', { editProjectId: input.id, route: 'TEMPLATE',
      templateId: input.template.id, changeCount: preview.changes.length,
      ms: Date.now() - input.started });
    return { proposal: proposalView(stored), messages: next.messages };
  }

  private async applyTemplate(id: string, proposal: ChatProposal, revision: number) {
    const action = proposal.templateAction!;
    await this.proposals.update(proposal.proposalId, id, { state: 'APPLYING' });
    let result: Awaited<ReturnType<EditTemplateService['apply']>>;
    try {
      result = await this.templates.apply(id, { templateId: action.templateId, revision });
    } catch (error) {
      await this.proposals.update(proposal.proposalId, id, { state: 'FAILED' });
      const failed = this.appendMessages(readChatThread(await this.settings(id)),
        [this.message('SYSTEM_STATUS', `The template was not applied: ${
          error instanceof Error ? error.message : 'unknown error'}`,
        { proposalId: proposal.proposalId, state: 'FAILED' })]);
      await this.persistThread(id, failed);
      throw error;
    }
    const thread = readChatThread(result.project.settings);
    const next = boundChatThread({ ...this.appendMessages(thread,
      [this.message('SYSTEM_STATUS', `Applied the ${action.templateName} template.`,
        { proposalId: proposal.proposalId, state: 'APPLIED',
          plannedChanges: proposal.plannedChanges })]),
    lastAppliedSummary: proposal.summary, lastAppliedAtRevision: result.project.revision });
    await this.editMode.saveChatThread(id, this.threadJson(next));
    await this.proposals.remove(proposal.proposalId, id);
    this.telemetry('edit_mode_chat_applied', { editProjectId: id,
      proposalId: proposal.proposalId, route: 'TEMPLATE', templateId: action.templateId,
      revision: result.project.revision });
    return {
      proposal: proposalView({ ...proposal, state: 'APPLIED' as const }),
      project: { ...result.project, settings: { ...(result.project.settings as object),
        chat: this.threadJson(next) } },
      affectedElementIds: [] as string[],
      messages: next.messages
    };
  }

  // --- internals ------------------------------------------------------------

  private rememberHook(thread: ChatThread, offered: { elementId: string | null; text: string }) {
    const same = thread.hook.elementId === offered.elementId;
    return { elementId: offered.elementId,
      tried: [...(same ? thread.hook.tried : []), offered.text].slice(-CHAT_MAX_TRIED_HOOKS) };
  }

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
    warnings: string[]; question: string; code?: ChatOutcomeCode; route?: ChatRoute;
  }) {
    const assistant = this.message('ASSISTANT', input.question,
      { proposalId: input.proposalId, state: 'NEEDS_CLARIFICATION' });
    const next = this.appendMessages(input.thread, [input.userMessage, assistant]);
    await this.persistThread(input.id, next);
    const stored = await this.proposals.save({
      proposalId: input.proposalId, editProjectId: input.id, baseRevision: input.baseRevision,
      state: 'NEEDS_CLARIFICATION', userMessage: input.message, summary: input.summary,
      plannedChanges: [], changes: [], warnings: input.warnings, needsClarification: true,
      clarificationQuestion: assistant.text, affectedElements: [],
      plannedDurationSec: input.context.project.timelineDurationSec,
      grounding: input.grounding, commands: [], resolvedTargets: {}, planner: input.planner,
      ...(input.code ? { code: input.code } : {}), route: input.route ?? 'NONE'
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
    lastAppliedAtRevision: project.revision, active: null });
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
  /** Public for the Step 7 agent: the SAME bounded context the chat plans from. */
  async loadContext(id: string, message: string, input: {
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
    const userTemplates = await this.templates.list().then((library) => library.user)
      .catch(() => []);
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
      templates: [
        ...builtinTemplateList().map((template) => ({ id: template.id, name: template.name,
          source: 'BUILTIN' as const })),
        ...userTemplates.map((template) => ({ id: template.id, name: template.name,
          source: 'USER' as const }))
      ].slice(0, MAX_CONTEXT_TEMPLATES),
      selection: {
        selectedElementId: typeof input.selectedElementId === 'string'
          ? input.selectedElementId : null,
        selectedTimeRange: parseRange(input.selectedTimeRange),
        playheadSec: Number.isFinite(Number(input.playheadSec)) ? Number(input.playheadSec) : 0
      }
    });
    context.runtime.creativeEvidence = editProjectEvidence(project);
    return { project, context, thread };
  }

  /**
   * Runs the model planner, converting every failure into "no plan".
   *
   * A provider outage, a timeout, a truncated response or a model emitting
   * malformed or unsupported commands all land here. None of them can mutate
   * anything: the turn degrades to an honest question.
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
  APPLY_TEMPLATE: 'the template you applied',
  APPLY_ASSISTANT_EDIT: 'the last edit I made',
  TRIM_ELEMENT: 'the trim', SPLIT_ELEMENT: 'the split',
  DELETE_ELEMENT: 'the segment removal', MOVE_ELEMENT: 'the move',
  ADD_TEXT: 'the text you added', ADD_IMAGE: 'the image you added',
  ADD_LOGO: 'the logo you added', ADD_AUDIO: 'the audio you added',
  REMOVE_ELEMENT: 'the removal', UPDATE_TEXT: 'the text change',
  SET_TEXT_CONTENT: 'the text change', SET_AUDIO_VOLUME: 'the volume change',
  SET_AUDIO_MUTED: 'the mute change', ADD_ZOOM: 'the zoom you added',
  SET_ZOOM_SCALE: 'the zoom change', APPLY_COLOR_FILTER: 'the colour look'
};

const describeHistoryAction = (action: string | null) =>
  (action && HISTORY_ACTION_LABELS[action]) || 'the last change';

const HOOK_SUMMARIES: Record<HookMode, string> = {
  REWRITE: 'Change the hook.', STRONGER: 'Make the hook stronger.',
  SHORTER: 'Make the hook shorter.', CURIOSITY: 'Make the hook more curiosity-driven.',
  ANOTHER: 'Try a different hook.', NEW: 'Add an opening hook.'
};
const hookSummary = (mode: HookMode) => HOOK_SUMMARIES[mode];

/**
 * The commands for a hook's new wording. An existing hook is re-worded IN
 * PLACE - same element, same style, same timing - so there is never a second
 * hook. A new one is born in the Hook style with its role recorded, the way a
 * preset-created hook is.
 */
function hookCommands(text: string, target: ChatElementView | null,
  context: ChatContext): ChatCommand[] {
  if (target) {
    return [{ kind: 'ELEMENT', action: 'SET_TEXT_CONTENT',
      target: { kind: 'ELEMENT', handle: target.handle }, parameters: { content: text },
      reason: 'Rewords the existing hook in place.' }];
  }
  const length = Math.round(Math.min(3.5, context.project.timelineDurationSec * 0.4) * 100) / 100;
  return [
    { kind: 'ELEMENT', action: 'ADD_TEXT', ref: 'newhook', reason: 'Adds the opening hook.',
      parameters: { content: text, textStyleId: 'HOOK', semanticRole: 'HOOK', applyBox: true } },
    { kind: 'ELEMENT', action: 'SET_ELEMENT_TIMING', target: { kind: 'REF', ref: 'newhook' },
      parameters: { startTime: 0, duration: length }, reason: 'A hook opens the video.' }
  ];
}

/** The follow-up shape of a model plan: one target, one family, when it is that simple. */
function modelFollowUp(intent: ChatIntent, context: ChatContext): FollowUp | null {
  const elements = intent.commands.filter((command) => command.kind === 'ELEMENT');
  if (elements.length !== 1 || elements[0].kind !== 'ELEMENT') return null;
  const command = elements[0];
  const handle = command.target?.kind === 'ELEMENT' ? command.target.handle : undefined;
  const view = handle ? context.elements.find((element) => element.handle === handle) : undefined;
  const family: Record<string, string> = { RESIZE_ELEMENT: 'SCALE', SET_TEXT_SIZE: 'TEXT_SIZE',
    SET_AUDIO_VOLUME: 'VOLUME', SET_ZOOM_SCALE: 'ZOOM', SET_VIDEO_ROTATION: 'ROTATION',
    SET_SPEED: 'SPEED', SET_TEXT_CONTENT: 'CONTENT' };
  if (!view || view.virtual || !family[command.action]) return null;
  return { family: family[command.action], direction: 1, vector: null,
    task: command.action === 'SET_TEXT_CONTENT' && view.semantic === 'HOOK' ? 'HOOK_REWRITE'
      : `${view.semantic}_${family[command.action]}`, elementIds: [view.id] };
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
export type { ChatActiveTarget };
