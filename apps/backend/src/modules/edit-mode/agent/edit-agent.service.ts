// Step 7 + 8: the professional AI editor agent.
//
//   OBSERVE     reload the persisted EditProject (persisted state wins over memory)
//   UNDERSTAND  split the request into clauses; every clause gets a ledger entry
//   PLAN        deterministic fast path -> natural-language layer -> OpenAI (tools only)
//   EXECUTE     validated canonical tools (one assistant revision = one undo step)
//   RELOAD      read the canonical state back from the database
//   VERIFY      prove each clause's expected mutation from reloaded state
//   CORRECT     re-run a clause once when its tool reported DONE but state disagrees
//   REVIEW      evidence-based self-review for substantial tasks (no fake scores)
//
// The agent owns no mutation code. Every edit reaches EditModeService through
// the same typed commands, constraint enforcement, validation and history the
// manual editor uses. It never runs a shell, FFmpeg, raw SQL or DOM clicks.

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LlmRouterService } from '../../processing/llm-router.service';
import { aiAvailable, aiUnavailable, type AiAvailability } from '../../ai/ai-availability';
import { EditModeService, type AssistantBundleCommand } from '../edit-mode.service';
import { EditTemplateService } from '../edit-template.service';
import { EditChatService } from '../chat/edit-chat.service';
import { chatPlannerAiMode } from '../chat/edit-chat-planner';
import type { ChatContext } from '../chat/edit-chat-context';
import { parseNaturalRequest, splitClauses, type ClauseLedgerEntry } from '../chat/edit-chat-intents';
import { planDeterministicChat } from '../chat/edit-chat-deterministic';
import { resolveChatPlan } from '../chat/edit-chat-resolver';
import { boundChatThread, readChatThread, type ChatMessage } from '../chat/edit-chat.types';
import { EditReviewService } from '../review/edit-review.service';
import { EditModeRenderService } from '../render/edit-mode-render.service';
import { blockingEditConstraint, readEditConstraints,
  type EditCommandResult, type EditConstraint } from '../edit-command-scope';
import { agentTool, isDestructive, type ToolProject } from './edit-agent-tools';
import { fastPath, normalizeRequest, savedStyleRequest } from './edit-agent-fastpath';
import { SavedStylesService } from '../styles/saved-styles.service';
import { resolveCreativeStyle } from '../styles/creative-style-resolver';
import { compileCreativeStyle } from '../styles/creative-style-commands';
import type { StyleCategory } from '../styles/creative-style-library';
import { planClausesWithOpenAi } from './edit-agent-planner';
import { AGENT_AUTONOMY_MODES, type AgentAutonomy, type AgentRun, type AgentRunInput,
  type AgentToolCall, type LedgerEntry, type PlanSource } from './edit-agent.types';

const MAX_MESSAGE_CHARS = 1500;
const MAX_CLAUSES = 16;
const MAX_STORED_RUNS = 5;
/** Actions that remove material or restructure the timeline. */
const DESTRUCTIVE_ACTIONS = new Set(['DELETE_ELEMENT', 'TRIM_ELEMENT', 'REMOVE_CAPTIONS',
  'REGENERATE_CAPTIONS']);
// Commands built by a registry tool: that tool's own `destructive` judgment
// (e.g. seconds actually removed) is authoritative, so the blanket action set
// above only classifies parser-produced commands.
const TOOL_JUDGED = new WeakSet<AssistantBundleCommand>();

type Via = { kind: 'TEMPLATE'; templateId: string } |
  { kind: 'SOURCE_BOUNDARY'; payload: Record<string, number>; fallback?: AssistantBundleCommand[] } |
  { kind: 'REVIEW' } | { kind: 'EXPORT' };

/** Internal execution unit behind one ledger entry. */
type Unit = {
  entry: LedgerEntry;
  commands: AssistantBundleCommand[];
  via: Via[];
  /** Tool calls with their own verifier; parser/hook commands use the generic one. */
  toolCalls: AgentToolCall[];
  results: EditCommandResult[];
  /** Why the AI planner could not help with this clause, when it could not. */
  ai?: AiAvailability;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const readAutonomy = (value: unknown, fallback: AgentAutonomy = 'AI_ASSISTED'): AgentAutonomy => {
  const mode = String(value ?? '').trim().toUpperCase();
  return (AGENT_AUTONOMY_MODES as readonly string[]).includes(mode) ? mode as AgentAutonomy : fallback;
};

@Injectable()
export class EditAgentService {
  private readonly logger = new Logger(EditAgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly editMode: EditModeService,
    private readonly chat: EditChatService,
    private readonly templates: EditTemplateService,
    private readonly reviews: EditReviewService,
    private readonly render: EditModeRenderService,
    private readonly llm: LlmRouterService,
    @Optional() private readonly savedStyles?: SavedStylesService
  ) {}

  /** Last runs, autonomy preference and whether the AI planner is reachable. */
  async state(id: string) {
    const project = await this.prisma.editProject.findUnique({ where: { id },
      select: { settings: true, revision: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    const agent = record(record(project.settings).agent);
    return { revision: project.revision, autonomy: readAutonomy(agent.autonomy),
      runs: Array.isArray(agent.runs) ? agent.runs : [], ai: this.aiConfigured() };
  }

  async setAutonomy(id: string, value: unknown) {
    const autonomy = readAutonomy(value, 'AI_ASSISTED');
    const project = await this.prisma.editProject.findUnique({ where: { id }, select: { settings: true } });
    if (!project) throw new NotFoundException('EditProject not found');
    const settings = record(project.settings);
    await this.prisma.editProject.update({ where: { id }, data: { settings: { ...settings,
      agent: { ...record(settings.agent), autonomy } } as Prisma.InputJsonValue } });
    return { autonomy };
  }

  private aiConfigured(): AiAvailability {
    // A cheap, call-free check used for UI state; a real call can still fail.
    const mode = chatPlannerAiMode().toUpperCase();
    if (mode !== 'ONLINE') return aiUnavailable('DISABLED');
    return process.env.OPENAI_API_KEY?.trim() ? aiAvailable() : aiUnavailable('NOT_CONFIGURED');
  }

  // ===========================================================================
  // RUN
  // ===========================================================================

  async run(id: string, input: AgentRunInput): Promise<AgentRun> {
    if (chatPlannerAiMode().toUpperCase() === 'ONLINE' && input.aiConsent !== true) {
      throw new ForbiddenException('Allow Ask AI before sending a request.');
    }
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message && !input.confirmRunId) throw new BadRequestException({ code: 'EMPTY_MESSAGE',
      message: 'Tell the editor what to change' });
    if (message.length > MAX_MESSAGE_CHARS) throw new BadRequestException({
      code: 'MESSAGE_TOO_LONG', message: `Keep the instruction under ${MAX_MESSAGE_CHARS} characters` });
    const started = Date.now();
    const stored = await this.state(id);
    const autonomy = readAutonomy(input.autonomy, stored.autonomy);
    const constraints = readEditConstraints(input.constraints, 'TASK');
    const runId = randomUUID();

    // Confirmation of held destructive clauses ("yes, do it").
    const quick = message ? fastPath(normalizeRequest(message)) : null;
    if (input.confirmRunId || quick?.intent === 'CONFIRM') {
      return this.confirm(id, runId, message || 'confirm', input, stored.runs, constraints, autonomy);
    }

    // OBSERVE: persisted state wins.
    const { project, context } = await this.chat.loadContext(id, message, input);
    const normalized = normalizeRequest(message);
    const clauses = splitClauses(normalized).slice(0, MAX_CLAUSES);
    const originals = splitClauses(message);
    const clauseText = (index: number) => originals.length === clauses.length
      ? originals[index] : clauses[index];

    // "finish it": inspect the project and complete what the last run left open.
    if (clauses.length === 1 && fastPath(clauses[0])?.intent === 'FINISH') {
      return this.finish(id, runId, message, input, stored.runs, constraints, autonomy, context,
        project.revision, started);
    }

    const units = await this.plan(runId, message, normalized, clauses, clauseText, context, autonomy);
    return this.executeAndReport({ id, runId, message, input, units, constraints, autonomy,
      context, startedRevision: project.revision, started });
  }

  // ===========================================================================
  // PLAN
  // ===========================================================================

  private async plan(runId: string, message: string, normalized: string, clauses: string[],
    clauseText: (index: number) => string, context: ChatContext, autonomy: AgentAutonomy) {
    const units: Unit[] = clauses.map((_clause, index) => ({ entry: this.entry(index,
      clauseText(index)), commands: [], via: [], toolCalls: [], results: [] }));

    // Natural-language layer over the WHOLE request so pronouns carry across
    // clauses ("move the captions ... make them yellow"). Its outcome for a
    // clause is used only when no fast path claimed that clause.
    let ledger: ClauseLedgerEntry[] = [];
    try { parseNaturalRequest(normalized, context, { maxIntents: MAX_CLAUSES, ledger }); }
    catch (error) { this.logger.warn(JSON.stringify({ event: 'edit_agent_parser_failed',
      reason: error instanceof Error ? error.message : String(error) })); }
    // The parser splits the text itself. If its split does not line up with
    // ours (e.g. pre-split review instructions containing "and"), parse each
    // clause on its own so an outcome can never be attributed to the wrong clause.
    if (ledger.length !== clauses.length) {
      ledger = clauses.map((clause) => {
        const own: ClauseLedgerEntry[] = [];
        try { parseNaturalRequest(clause, context, { maxIntents: MAX_CLAUSES, ledger: own }); }
        catch { /* treated as unparsed */ }
        return own.length === 1 ? own[0] : { clause, outcomes: own.flatMap((item) => item.outcomes),
          unparsed: !own.length || own.some((item) => item.unparsed) };
      });
    }

    const forModel: Array<{ index: number; clause: string }> = [];
    for (const [index, clause] of clauses.entries()) {
      const unit = units[index];
      // Step 17: "use my usual podcast captions" -> ONE saved style by stable id.
      const saved = savedStyleRequest(clause);
      if (saved && this.savedStyles) {
        const found = await this.savedStyles.resolveByName(saved.category as StyleCategory, saved.spoken);
        if ('question' in found) { this.settle(unit, 'NEEDS_INPUT', found.question); continue; }
        const resolved = resolveCreativeStyle({ components: { [saved.category]: found.style.id },
          saved: { [found.style.id]: { category: found.style.category, spec: found.style.spec,
            name: found.style.name } } });
        const compiled = compileCreativeStyle(resolved, context, { hookOptions: [],
          hasWordTimings: context.project.hasWordTimings });
        unit.entry.intent = `Apply your saved style "${found.style.name}" (${found.style.id})`;
        unit.entry.planSource = 'DETERMINISTIC_FAST_PATH';
        if (!compiled.commands.length) {
          this.settle(unit, 'UNSUPPORTED', compiled.skipped.join('; ') || 'Nothing to apply for that style here.');
          continue;
        }
        this.addCommands(unit, compiled.commands, compiled.lines);
        continue;
      }
      const fp = fastPath(clause);
      if (fp && 'calls' in fp) {
        unit.entry.intent = fp.intent;
        unit.entry.planSource = 'DETERMINISTIC_FAST_PATH';
        await this.applyCalls(unit, fp.calls, context);
        continue;
      }
      if (fp) { // FINISH/CONFIRM mixed into a longer request
        this.settle(unit, 'NEEDS_INPUT', 'Send "finish it" or "yes, do it" on its own.');
        continue;
      }
      const parsed = ledger[index];
      if (!parsed || parsed.unparsed || !parsed.outcomes.length) {
        // A single timeline-shaped instruction ("remove this part") is the
        // direct planner's job before any model is asked.
        if (clauses.length === 1) {
          const direct = planDeterministicChat(normalized, context);
          if (direct && !direct.needsClarification && direct.commands.length) {
            const resolution = resolveChatPlan(direct.commands, direct.grounding, context);
            if (resolution.ok) {
              unit.entry.intent = direct.summary || clause;
              unit.entry.planSource = 'DETERMINISTIC_PARSER';
              this.addCommands(unit, resolution.commands.map(toBundle), resolution.plannedChanges);
              continue;
            }
          }
        }
        forModel.push({ index, clause: unit.entry.clause });
        continue;
      }
      for (const outcome of parsed.outcomes) {
        unit.entry.planSource = 'DETERMINISTIC_PARSER';
        if (outcome.type === 'COMMANDS') {
          const resolution = resolveChatPlan(outcome.commands, outcome.grounding, context);
          if (!resolution.ok) { this.settle(unit, 'NEEDS_INPUT', resolution.question); break; }
          unit.entry.intent = outcome.summary || clause;
          this.addCommands(unit, resolution.commands.map(toBundle), resolution.plannedChanges);
        } else if (outcome.type === 'HOOK') {
          const hook = await this.chat.agentHookCommands(outcome.mode, outcome.target, context);
          if ('question' in hook) { this.settle(unit, 'NEEDS_INPUT', hook.question); break; }
          unit.entry.intent = `Hook: ${outcome.mode.toLowerCase()}`;
          unit.entry.planSource = hook.source === 'LLM' ? 'CREATIVE_OPENAI' : 'CREATIVE_DETERMINISTIC';
          this.addCommands(unit, hook.commands, [hook.line]);
        } else if (outcome.type === 'TEMPLATE') {
          unit.entry.intent = `Apply the ${outcome.template.name} template`;
          this.addToolCalls(unit, [{ tool: 'template.apply', args: { templateId: outcome.template.id } }], context);
        } else if (outcome.type === 'QUESTION') {
          this.settle(unit, 'NEEDS_INPUT', outcome.question); break;
        } else if (outcome.type === 'UNSUPPORTED') {
          this.settle(unit, 'UNSUPPORTED', outcome.message); break;
        }
      }
    }

    // OpenAI for what the deterministic layers could not understand (vague,
    // creative, Hindi/Hinglish/mixed). Honest when AI is unavailable.
    if (forModel.length) {
      const { plans, ai } = await planClausesWithOpenAi({ llm: this.llm, logger: this.logger,
        message, clauses: forModel, context });
      for (const pending of forModel) {
        const unit = units[pending.index];
        const plan = plans.find((item) => item.index === pending.index);
        if (!plan) {
          this.settle(unit, 'UNSUPPORTED', ai.state === 'AVAILABLE'
            ? 'The AI planner did not return a plan for this clause.'
            : `This needs the AI editor to understand. ${ai.message}`);
          // Keep the real availability (e.g. AUTH_FAILED), not just its sentence.
          if (ai.state !== 'AVAILABLE') unit.ai = ai;
          continue;
        }
        unit.entry.planSource = 'OPENAI';
        unit.entry.intent = plan.intent || pending.clause;
        if (plan.unsupported) { this.settle(unit, 'UNSUPPORTED', plan.unsupported); continue; }
        if (plan.question && !plan.calls.length) { this.settle(unit, 'NEEDS_INPUT', plan.question); continue; }
        await this.applyCalls(unit, plan.calls, context);
        if (!unit.commands.length && !unit.via.length && unit.entry.status === 'DONE') {
          this.settle(unit, 'UNSUPPORTED', 'Nothing supported was planned for this clause.');
        }
      }
    }

    // Autonomy: destructive work waits for a yes unless autonomy was granted.
    for (const unit of units) {
      if (unit.entry.status !== 'DONE') continue;
      const destructive = unit.entry.destructive || unit.commands.some((command) =>
        !TOOL_JUDGED.has(command) && DESTRUCTIVE_ACTIONS.has(command.action));
      unit.entry.destructive = destructive;
      const holdWording = autonomy === 'HYBRID' && unit.commands.some((command) =>
        ['SET_TEXT_CONTENT', 'SET_CAPTION_TEXT'].includes(command.action));
      if (autonomy === 'MANUAL' || ((destructive || holdWording) && autonomy !== 'AI_AUTONOMOUS')) {
        this.settle(unit, 'NEEDS_CONFIRMATION', autonomy === 'MANUAL'
          ? 'Manual mode: I planned this but did not apply it. Say "yes, do it" to apply.'
          : destructive ? 'This removes or restructures material. Say "yes, do it" to apply it.'
            : 'This rewrites wording. Say "yes, do it" to apply it.', true);
      }
    }
    return units;
  }

  /** Registry calls, with creative hook wording routed through the grounded writer. */
  private async applyCalls(unit: Unit, calls: AgentToolCall[], context: ChatContext) {
    for (const call of calls) {
      if (unit.entry.status !== 'DONE') return;
      if (call.tool !== 'hook.write') { this.addToolCalls(unit, [call], context); continue; }
      const mode = String(call.args.mode ?? 'NEW').toUpperCase();
      const target = context.elements.find((view) => view.semantic === 'HOOK') ?? null;
      const hook = await this.chat.agentHookCommands(mode === 'SHORTER' && target ? 'SHORTER'
        : target ? 'ANOTHER' : 'NEW', target, context);
      if ('question' in hook) { this.settle(unit, 'NEEDS_INPUT', hook.question); return; }
      unit.entry.planSource = hook.source === 'LLM' ? 'CREATIVE_OPENAI' : unit.entry.planSource;
      unit.entry.toolCalls.push(call);
      this.addCommands(unit, hook.commands, [hook.line]);
    }
  }

  private entry(index: number, clause: string): LedgerEntry {
    return { index, clause, intent: clause, planSource: 'NONE' as PlanSource, toolCalls: [],
      plannedChanges: [], status: 'DONE', verification: 'PENDING', detail: '', destructive: false,
      commandStatuses: [], affectedElementIds: [], evidence: [], attempts: 0 };
  }

  /** Marks a unit as not executing (question, unsupported, held). */
  private settle(unit: Unit, status: LedgerEntry['status'], detail: string, keepPlan = false) {
    unit.entry.status = status;
    unit.entry.detail = detail;
    unit.entry.verification = 'NOT_APPLICABLE';
    if (!keepPlan) { unit.commands = []; unit.via = []; }
  }

  private addCommands(unit: Unit, commands: AssistantBundleCommand[], lines: string[]) {
    unit.commands.push(...commands);
    unit.entry.plannedChanges.push(...lines);
    unit.entry.toolCalls.push(...commands.map((command) => ({ tool: `canonical.${command.action}`,
      args: command.payload })));
  }

  private addToolCalls(unit: Unit, calls: AgentToolCall[], context: ChatContext) {
    for (const call of calls) {
      const tool = agentTool(call.tool);
      if (!tool) { this.settle(unit, 'UNSUPPORTED', `Unknown tool ${call.tool}`); return; }
      let built;
      try { built = tool.build(call.args, context); }
      catch (error) { this.settle(unit, 'FAILED', error instanceof Error ? error.message : 'Tool failed'); return; }
      if ('question' in built) { this.settle(unit, 'NEEDS_INPUT', built.question); return; }
      if ('unsupported' in built) { this.settle(unit, 'UNSUPPORTED', built.unsupported); return; }
      unit.entry.toolCalls.push(call);
      unit.toolCalls.push(call);
      unit.entry.destructive ||= isDestructive(tool, call.args, context);
      unit.entry.plannedChanges.push(...built.lines);
      if ('commands' in built) {
        built.commands.forEach((command) => TOOL_JUDGED.add(command));
        unit.commands.push(...built.commands);
      }
      else if (built.via === 'TEMPLATE') unit.via.push({ kind: 'TEMPLATE', templateId: built.templateId });
      else if (built.via === 'SOURCE_BOUNDARY') unit.via.push({ kind: 'SOURCE_BOUNDARY', payload: built.payload,
        fallback: built.fallback });
      else unit.via.push({ kind: built.via });
    }
  }

  // ===========================================================================
  // EXECUTE -> RELOAD -> VERIFY -> CORRECT -> REVIEW
  // ===========================================================================

  private async executeAndReport(input: { id: string; runId: string; message: string;
    input: AgentRunInput; units: Unit[]; constraints: EditConstraint[]; autonomy: AgentAutonomy;
    context: ChatContext; startedRevision: number; started: number; forceReview?: boolean }): Promise<AgentRun> {
    const { id, runId, units, constraints } = input;
    const revisions: number[] = [];
    const before = await this.snapshot(id);
    const live = units.filter((unit) => unit.entry.status === 'DONE');

    // Structural/template work first, so the element bundle runs against it.
    for (const unit of live) {
      for (const via of unit.via) {
        if (via.kind === 'TEMPLATE' || via.kind === 'SOURCE_BOUNDARY') {
          await this.runVia(id, unit, via, constraints, revisions);
        }
      }
    }
    await this.executeBundle(id, runId, input.message, live.filter((unit) =>
      unit.entry.status === 'DONE' && unit.commands.length), constraints, revisions, 1);

    // RELOAD + VERIFY
    let after = await this.snapshot(id);
    const retry: Unit[] = [];
    for (const unit of live) {
      if (unit.entry.status !== 'DONE') continue;
      const verdict = this.verify(unit, before, after, input.context);
      unit.entry.evidence = verdict.evidence;
      unit.entry.verification = verdict.ok ? 'VERIFIED' : 'FAILED';
      if (!verdict.ok && unit.commands.length) retry.push(unit);
    }
    // CORRECT: once, with the SAME absolute commands (relative intents were
    // resolved against the original state, so a re-run cannot compound).
    if (retry.length) {
      this.logger.warn(JSON.stringify({ event: 'edit_agent_verification_failed', editProjectId: id,
        runId, clauses: retry.map((unit) => unit.entry.index) }));
      for (const unit of retry) { unit.entry.attempts += 1; unit.results = []; }
      await this.executeBundle(id, runId, `${input.message} (correction)`, retry, constraints,
        revisions, 2);
      after = await this.snapshot(id);
      for (const unit of retry) {
        if (unit.entry.status !== 'DONE') continue;
        const verdict = this.verify(unit, before, after, input.context);
        unit.entry.evidence = [...verdict.evidence, 'after one correction attempt'];
        unit.entry.verification = verdict.ok ? 'VERIFIED' : 'FAILED';
        if (!verdict.ok) {
          unit.entry.status = 'FAILED';
          unit.entry.detail = `The edit ran but the result could not be verified: ${verdict.evidence.join('; ')}`;
        }
      }
    }

    // Read-only / terminal tools.
    let review: AgentRun['review'] = null;
    const wantsReview = live.some((unit) => unit.via.some((via) => via.kind === 'REVIEW'));
    const substantial = input.forceReview || units.length >= 3 ||
      units.some((unit) => unit.entry.planSource === 'OPENAI');
    const changed = units.some((unit) => unit.entry.status === 'DONE' && unit.commands.length);
    if (wantsReview || (substantial && changed)) review = await this.selfReview(id);
    for (const unit of live) {
      if (unit.via.some((via) => via.kind === 'REVIEW')) {
        unit.entry.verification = review ? 'VERIFIED' : 'FAILED';
        unit.entry.evidence.push(review ? `${review.items.length} review findings` : 'review unavailable');
      }
      if (unit.via.some((via) => via.kind === 'EXPORT') && unit.entry.status === 'DONE') {
        try {
          const current = await this.snapshot(id);
          const started = await this.render.startExport(id, current.revision);
          unit.entry.verification = 'VERIFIED';
          unit.entry.evidence.push(`export ${started.export?.exportId ?? ''} started at revision ${current.revision}`);
        } catch (error) {
          unit.entry.status = 'FAILED';
          unit.entry.detail = error instanceof Error ? error.message : 'Export could not start';
        }
      }
    }

    const final = await this.snapshot(id);
    const ai = units.some((unit) => unit.entry.planSource === 'OPENAI' ||
      unit.entry.planSource === 'CREATIVE_OPENAI') ? aiAvailable()
      : units.some((unit) => /needs the AI editor/u.test(unit.entry.detail))
        ? this.aiFromDetail(units) : this.aiConfigured();
    const run: AgentRun = { runId, editProjectId: id, message: input.message,
      autonomy: input.autonomy, startedRevision: input.startedRevision,
      finalRevision: final.revision, revisions, ledger: units.map((unit) => unit.entry), review, ai,
      constraints, summary: this.summarize(units), createdAt: new Date().toISOString() };
    await this.persist(id, run, units);
    this.logger.log(JSON.stringify({ event: 'edit_agent_run', editProjectId: id, runId,
      clauses: units.length, statuses: units.map((unit) => unit.entry.status),
      verification: units.map((unit) => unit.entry.verification), revisions,
      sources: units.map((unit) => unit.entry.planSource), ms: Date.now() - input.started }));
    return run;
  }

  private aiFromDetail(units: Unit[]): AiAvailability {
    const known = units.find((unit) => unit.ai)?.ai;
    if (known) return known;
    const detail = units.find((unit) => /needs the AI editor/u.test(unit.entry.detail))?.entry.detail ?? '';
    return { ...aiUnavailable('UNKNOWN'), message: detail.replace(/^This needs the AI editor to understand\. /u, '') };
  }

  private async runVia(id: string, unit: Unit, via: Via, constraints: EditConstraint[],
    revisions: number[]) {
    const current = await this.snapshot(id);
    try {
      if (via.kind === 'TEMPLATE') {
        const applied = await this.templates.apply(id, { templateId: via.templateId,
          revision: current.revision, constraints });
        revisions.push(applied.project.revision);
        unit.entry.commandStatuses.push('DONE');
      } else if (via.kind === 'SOURCE_BOUNDARY') {
        // Task constraints bind AI here too, not only inside element bundles.
        const blocked = blockingEditConstraint('ADJUST_SOURCE_RANGE', 'AI_ACTION', constraints,
          current.elements.filter((item) => item.type === 'VIDEO'));
        if (blocked) {
          unit.entry.status = 'BLOCKED_BY_CONSTRAINT';
          unit.entry.detail = `Blocked by ${blocked.type}`;
          unit.entry.commandStatuses.push('BLOCKED_BY_CONSTRAINT');
          return;
        }
        const adjusted = await this.editMode.adjustSourceRange(id, { revision: current.revision,
          ...via.payload });
        revisions.push(adjusted.revision);
        unit.entry.commandStatuses.push('DONE');
      }
    } catch (error) {
      const response = error instanceof BadRequestException ? record(error.getResponse()) : {};
      // A project without original-source lineage (legacy/manual) moves the same
      // boundary with the canonical segment trim instead, in the element bundle.
      if (via.kind === 'SOURCE_BOUNDARY' && via.fallback?.length &&
        String(response.code ?? '') === 'ORIGINAL_SOURCE_UNAVAILABLE') {
        unit.commands.push(...via.fallback);
        unit.entry.evidence.push('no original-source lineage: moved the boundary with a segment trim');
        return;
      }
      unit.entry.status = /UNSUPPORTED/u.test(String(response.code ?? '')) ? 'UNSUPPORTED' : 'FAILED';
      unit.entry.detail = String(response.message ?? (error instanceof Error ? error.message : 'Failed'));
      unit.entry.verification = 'NOT_APPLICABLE';
      unit.entry.commandStatuses.push(unit.entry.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'FAILED');
    }
  }

  /** One canonical assistant bundle for every executable clause: one undo step. */
  private async executeBundle(id: string, runId: string, message: string, units: Unit[],
    constraints: EditConstraint[], revisions: number[], attempt: number) {
    const executable = units.filter((unit) => unit.commands.length);
    if (!executable.length) return;
    const commands: AssistantBundleCommand[] = [];
    const owners: Unit[] = [];
    // Plan-local refs are namespaced per clause so two clauses cannot collide.
    for (const unit of executable) {
      for (const command of unit.commands) {
        const prefix = `c${unit.entry.index}-`;
        const payload = { ...command.payload };
        if (typeof payload.ref === 'string') payload.ref = prefix + payload.ref;
        commands.push(command.kind === 'ELEMENT'
          ? { ...command, payload, ...(command.ref ? { ref: prefix + command.ref } : {}) }
          : command);
        owners.push(unit);
      }
    }
    const current = await this.snapshot(id);
    try {
      const result = await this.editMode.applyAssistantBundle(id, current.revision, {
        proposalId: `${runId}:${attempt}`, summary: `AI editor: ${message.slice(0, 160)}`,
        userMessage: message, commands, constraints, actor: 'AI_ACTION', onInvalid: 'CONTINUE' });
      if (result.revision !== current.revision) revisions.push(result.revision);
      result.commandResults.forEach((commandResult, index) => {
        const unit = owners[index];
        unit.results.push(commandResult);
        unit.entry.commandStatuses.push(commandResult.status);
        unit.entry.affectedElementIds = [...new Set([...unit.entry.affectedElementIds,
          ...commandResult.affectedElementIds])];
        if (commandResult.status === 'BLOCKED_BY_CONSTRAINT') {
          this.logger.warn(JSON.stringify({ event: 'edit_agent_constraint_block', editProjectId: id,
            runId, clause: unit.entry.index, action: commandResult.action,
            constraint: commandResult.constraint }));
        }
      });
      for (const unit of executable) {
        const statuses = unit.results.map((item) => item.status);
        if (statuses.length && statuses.every((status) => status === 'BLOCKED_BY_CONSTRAINT')) {
          unit.entry.status = 'BLOCKED_BY_CONSTRAINT';
          unit.entry.detail = `Blocked by ${[...new Set(unit.results.map((item) => item.constraint))].join(', ')}`;
          unit.entry.verification = 'NOT_APPLICABLE';
        } else if (!statuses.includes('DONE')) {
          unit.entry.status = statuses.includes('UNSUPPORTED') ? 'UNSUPPORTED' : 'FAILED';
          unit.entry.detail = unit.results.map((item) => item.message).filter(Boolean).join('; ') ||
            'The editor rejected this change.';
          unit.entry.verification = 'NOT_APPLICABLE';
        } else if (statuses.some((status) => status !== 'DONE')) {
          unit.entry.detail = `Partly applied: ${unit.results.filter((item) => item.status !== 'DONE')
            .map((item) => `${item.action} ${item.status}${item.message ? ` (${item.message})` : ''}`).join('; ')}`;
        }
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The edit could not be applied';
      for (const unit of executable) {
        unit.entry.status = 'FAILED';
        unit.entry.detail = text;
        unit.entry.verification = 'NOT_APPLICABLE';
        unit.entry.commandStatuses.push('FAILED');
      }
    }
  }

  private async snapshot(id: string): Promise<ToolProject> {
    const project = await this.prisma.editProject.findUnique({ where: { id }, include: {
      elements: { orderBy: [{ track: 'asc' }, { position: 'asc' }] } } });
    if (!project) throw new NotFoundException('EditProject not found');
    return { revision: project.revision, settings: record(project.settings),
      elements: project.elements.map((item) => ({ id: item.id, type: item.type,
        startTime: item.startTime, duration: item.duration, trimStart: item.trimStart,
        trimEnd: item.trimEnd, properties: record(item.properties) })) };
  }

  /** Tool verifiers where they exist; otherwise a generic value check. */
  private verify(unit: Unit, before: ToolProject, after: ToolProject, context: ChatContext) {
    const evidence: string[] = [];
    let ok = true;
    for (const call of unit.toolCalls) {
      const tool = agentTool(call.tool);
      if (!tool?.verify) continue;
      const verdict = tool.verify(call.args, after, before, context);
      evidence.push(...verdict.evidence);
      ok &&= verdict.ok;
    }
    const verifiedByTool = unit.toolCalls.some((call) => agentTool(call.tool)?.verify);
    if (!verifiedByTool) {
      const generic = genericVerify(unit.commands, unit.results, after);
      evidence.push(...generic.evidence);
      ok &&= generic.ok;
    }
    return { ok, evidence };
  }

  private async selfReview(id: string): Promise<AgentRun['review']> {
    try {
      const current = await this.snapshot(id);
      const review = await this.reviews.review(id, { revision: current.revision });
      return { summary: review.summary, items: review.findings.slice(0, 8).map((finding) => ({
        dimension: finding.dimension, severity: finding.severity, title: finding.title,
        evidence: finding.evidence, suggestion: finding.suggestion })) };
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'edit_agent_review_failed',
        reason: error instanceof Error ? error.message : String(error) }));
      return null;
    }
  }

  private summarize(units: Unit[]) {
    const count = (status: LedgerEntry['status']) => units.filter((unit) => unit.entry.status === status).length;
    const parts = [`${count('DONE')} of ${units.length} done`];
    for (const [status, label] of [['NEEDS_CONFIRMATION', 'waiting for your OK'],
      ['NEEDS_INPUT', 'need more detail'], ['BLOCKED_BY_CONSTRAINT', 'blocked by your constraints'],
      ['UNSUPPORTED', 'not supported'], ['FAILED', 'failed']] as const) {
      if (count(status)) parts.push(`${count(status)} ${label}`);
    }
    return parts.join(', ') + '.';
  }

  /** Stores the run (bounded) and mirrors it into the chat thread. */
  private async persist(id: string, run: AgentRun, units: Unit[]) {
    const project = await this.prisma.editProject.findUnique({ where: { id }, select: { settings: true } });
    if (!project) return;
    const settings = record(project.settings);
    const agent = record(settings.agent);
    const runs = [{ ...run, ledger: run.ledger }, ...(Array.isArray(agent.runs) ? agent.runs : [])]
      .slice(0, MAX_STORED_RUNS);
    const thread = readChatThread(settings);
    const now = new Date().toISOString();
    const lines = run.ledger.map((entry) => `${statusIcon(entry.status)} ${entry.clause}` +
      (entry.detail ? ` - ${entry.detail}` : entry.plannedChanges.length
        ? ` - ${entry.plannedChanges.slice(0, 2).join('; ')}` : ''));
    const messages: ChatMessage[] = [
      ...(run.message ? [{ id: randomUUID(), role: 'USER' as const, text: run.message, createdAt: now }] : []),
      { id: randomUUID(), role: 'ASSISTANT' as const, text: `${run.summary}\n${lines.join('\n')}`,
        createdAt: now, plannedChanges: lines }
    ];
    const affected = units.flatMap((unit) => unit.entry.affectedElementIds);
    const next = boundChatThread({ ...thread, messages: [...thread.messages, ...messages],
      lastAffectedElementIds: affected.length ? [...new Set(affected)] : thread.lastAffectedElementIds,
      lastAppliedSummary: run.summary, lastAppliedAtRevision: run.finalRevision });
    await this.prisma.editProject.update({ where: { id }, data: { settings: { ...settings,
      chat: JSON.parse(JSON.stringify(next)), agent: { ...agent, runs } } as Prisma.InputJsonValue } });
  }

  // ===========================================================================
  // Follow-ups: confirmation and "finish it"
  // ===========================================================================

  private async confirm(id: string, runId: string, message: string, input: AgentRunInput,
    runs: unknown[], constraints: EditConstraint[], autonomy: AgentAutonomy): Promise<AgentRun> {
    const wanted = typeof input.confirmRunId === 'string' ? input.confirmRunId : null;
    const last = (runs as AgentRun[]).find((run) => !wanted || run.runId === wanted);
    const held = last?.ledger.filter((entry) => entry.status === 'NEEDS_CONFIRMATION') ?? [];
    const { project, context } = await this.chat.loadContext(id, message, input);
    if (!held.length) {
      const unit: Unit = { entry: this.entry(0, message), commands: [], via: [], toolCalls: [], results: [] };
      this.settle(unit, 'NEEDS_INPUT', 'There is nothing waiting for confirmation.');
      return this.executeAndReport({ id, runId, message, input, units: [unit], constraints,
        autonomy, context, startedRevision: project.revision, started: Date.now() });
    }
    // Re-plan each held clause against the CURRENT project (persisted state
    // wins), then execute it now that the user said yes.
    const units = await this.replanEntries(held, runId, context);
    return this.executeAndReport({ id, runId, message, input, units, constraints, autonomy,
      context, startedRevision: project.revision, started: Date.now() });
  }

  /**
   * Re-plans earlier clauses against the CURRENT project (persisted state wins):
   * registry tool calls are rebuilt from their arguments; anything that came
   * from the natural-language layer (ids, times) is re-derived from its words,
   * never replayed with stale ids.
   */
  private async replanEntries(entries: LedgerEntry[], runId: string, context: ChatContext) {
    const units: Unit[] = [];
    for (const previous of entries) {
      const registryOnly = previous.toolCalls.length > 0 &&
        previous.toolCalls.every((call) => !call.tool.startsWith('canonical.'));
      if (registryOnly) {
        const unit: Unit = { entry: { ...this.entry(units.length, previous.clause),
          intent: previous.intent, planSource: previous.planSource },
        commands: [], via: [], toolCalls: [], results: [] };
        this.addToolCalls(unit, previous.toolCalls, context);
        units.push(unit);
        continue;
      }
      const normalized = normalizeRequest(previous.clause);
      const [unit] = await this.plan(runId, previous.clause, normalized, [normalized],
        () => previous.clause, context, 'AI_AUTONOMOUS');
      unit.entry.index = units.length;
      units.push(unit);
    }
    return units;
  }

  private async finish(id: string, runId: string, message: string, input: AgentRunInput,
    runs: unknown[], constraints: EditConstraint[], autonomy: AgentAutonomy, context: ChatContext,
    revision: number, started: number): Promise<AgentRun> {
    const last = (runs as AgentRun[])[0];
    // 1. What the last run could not complete for a transient reason.
    const retryable = last?.ledger.filter((entry) => entry.status === 'FAILED' ||
      (entry.status === 'DONE' && entry.verification === 'FAILED')) ?? [];
    const units = await this.replanEntries(retryable, runId, context);
    // 2. Held destructive work stays held unless autonomy allows it.
    for (const entry of last?.ledger.filter((item) => item.status === 'NEEDS_CONFIRMATION') ?? []) {
      const [unit] = await this.replanEntries([entry], runId, context);
      unit.entry.index = units.length;
      if (autonomy !== 'AI_AUTONOMOUS') {
        this.settle(unit, 'NEEDS_CONFIRMATION', 'Still waiting for your OK - say "yes, do it".', true);
      }
      units.push(unit);
    }
    // 3. Inspect the project and act on the review's non-destructive suggestions.
    const review = await this.selfReview(id);
    const instructions = await this.reviewInstructions(id, review);
    if (instructions.length) {
      const normalized = instructions.map(normalizeRequest);
      const planned = await this.plan(runId, instructions.join(', '), normalized.join(', '),
        normalized, (index) => instructions[index], context, autonomy === 'AI_AUTONOMOUS'
          ? autonomy : 'AI_ASSISTED');
      for (const unit of planned) { unit.entry.index = units.length; units.push(unit); }
    }
    if (!units.length) {
      const unit: Unit = { entry: this.entry(0, message), commands: [], via: [], toolCalls: [], results: [] };
      this.settle(unit, 'SKIPPED', 'Nothing left to do: the last request is complete and the review found no supported fixes.');
      units.push(unit);
    }
    return this.executeAndReport({ id, runId, message, input, units, constraints, autonomy,
      context, startedRevision: revision, started, forceReview: true });
  }

  /** Natural-language fixes the review offered for real problems (bounded). */
  private async reviewInstructions(id: string, review: AgentRun['review']) {
    if (!review) return [];
    const stored = await this.reviews.latest(id);
    return (stored?.findings ?? []).filter((finding) => finding.severity !== 'LOOKS_GOOD' &&
      finding.applyInstruction).slice(0, 3).map((finding) => String(finding.applyInstruction));
  }
}

const toBundle = (command: { kind: string; action: string; ref?: string;
  payload: unknown }): AssistantBundleCommand => command.kind === 'SETTINGS'
  ? { kind: 'SETTINGS', action: command.action, payload: record(command.payload) }
  : { kind: 'ELEMENT', action: command.action, ...(command.ref ? { ref: command.ref } : {}),
    payload: record(command.payload) };

const statusIcon = (status: LedgerEntry['status']) => ({ DONE: '[done]',
  NEEDS_CONFIRMATION: '[needs OK]', UNSUPPORTED: '[unsupported]', FAILED: '[failed]',
  SKIPPED: '[skipped]', BLOCKED_BY_CONSTRAINT: '[blocked]', NEEDS_INPUT: '[question]' })[status];

/** Payload keys whose value must be readable back from the element afterwards. */
const VALUE_KEYS = ['volume', 'fontSize', 'color', 'opacity', 'scale', 'content', 'speed',
  'fontWeight', 'textAlign', 'rotation'];
const COLOR_KEYS = ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'saturation',
  'temperature', 'tint', 'sharpness', 'fade', 'vignette'];

/** Generic verification for commands without a tool verifier. */
export function genericVerify(commands: AssistantBundleCommand[], results: EditCommandResult[],
  after: ToolProject) {
  const evidence: string[] = [];
  let ok = results.length > 0 && results.some((result) => result.status === 'DONE');
  commands.forEach((command, index) => {
    const result = results[index];
    if (!result || result.status !== 'DONE') return;
    const payload = command.payload;
    const targets = result.affectedElementIds.map((id) => after.elements.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => !!item);
    for (const key of VALUE_KEYS) {
      if (payload[key] === undefined || !targets.length) continue;
      const hits = targets.filter((item) => {
        const value = item.properties[key];
        return typeof payload[key] === 'number' ? Math.abs(Number(value) - Number(payload[key])) < 1e-3
          : String(value).toLowerCase() === String(payload[key]).toLowerCase();
      });
      evidence.push(`${key}=${String(payload[key])} on ${hits.length}/${targets.length}`);
      ok &&= hits.length === targets.length;
    }
    for (const key of COLOR_KEYS) {
      if (payload[key] === undefined || !targets.length) continue;
      const hits = targets.filter((item) => Math.abs(Number(record(item.properties.colorAdjustments)[key]) -
        Number(payload[key])) < 1e-3);
      evidence.push(`${key}=${String(payload[key])} on ${hits.length}/${targets.length}`);
      ok &&= hits.length === targets.length;
    }
    if (!evidence.length) evidence.push(result.affectedCount
      ? `${command.action}: ${result.affectedCount} element(s) changed`
      : `${command.action}: already in that state (no change needed)`);
  });
  return { ok, evidence };
}
