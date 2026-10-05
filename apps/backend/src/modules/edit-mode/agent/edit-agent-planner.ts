// Step 7: OpenAI semantic planning for the clauses the deterministic layers could
// not handle (vague creative wording, Hindi/Hinglish/mixed language, imperfect
// grammar). The model sees a bounded project summary and the tool catalogue, and
// may ONLY answer with tool calls from that catalogue - validated here before
// anything runs. It never sees ids, never writes FFmpeg/SQL/shell, and it
// cannot invent a timestamp: time arguments are clamped to the timeline.

import type { Logger } from '@nestjs/common';
import type { LlmRouterService } from '../../processing/llm-router.service';
import { createPerformanceTelemetry, performanceContext } from '../../processing/performance-telemetry';
import { aiAvailable, aiUnavailable, classifyAiFailure, type AiAvailability } from '../../ai/ai-availability';
import type { ChatContext } from '../chat/edit-chat-context';
import { chatPlannerAiMode } from '../chat/edit-chat-planner';
import { agentTool, agentTools, toolCatalog } from './edit-agent-tools';
import type { AgentToolCall } from './edit-agent.types';

export const AGENT_PLANNER_ROLE = 'editingPlan' as const;
const MAX_CALLS_PER_CLAUSE = 6;

const ARG_ITEM = { type: 'object', additionalProperties: false,
  properties: { name: { type: 'string' }, number: { type: ['number', 'null'] },
    text: { type: ['string', 'null'] }, flag: { type: ['boolean', 'null'] } },
  required: ['name', 'number', 'text', 'flag'] };

export const AGENT_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    clauses: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false,
      properties: {
        index: { type: 'integer' },
        intent: { type: 'string' },
        calls: { type: 'array', maxItems: MAX_CALLS_PER_CLAUSE, items: {
          type: 'object', additionalProperties: false,
          properties: { tool: { type: 'string', enum: agentTools().map((tool) => tool.name) },
            args: { type: 'array', maxItems: 16, items: ARG_ITEM } },
          required: ['tool', 'args'] } },
        question: { type: 'string' },
        unsupported: { type: 'string' }
      },
      required: ['index', 'intent', 'calls', 'question', 'unsupported'] } }
  },
  required: ['clauses']
} as const;

const SYSTEM_PROMPT = [
  'You are the planning brain of a professional short-form video editor.',
  'Turn each numbered instruction clause into calls to the editor tools listed. You edit ONE clip.',
  'Rules:',
  '- Use ONLY the listed tools and parameters. Never output shell, FFmpeg, SQL, code or ids.',
  '- Address elements only by the handles given (text:hook, captions:all, video:all, video:2, logo:main, music:all, selected).',
  '- Understand English, Hindi, Hinglish and mixed or imperfect wording.',
  '- Vague creative requests ("make it premium", "looks cheap", "cleaner", "more energetic",',
  '  "cinematic but natural", "modern podcast style") must be translated into several concrete,',
  '  supported, NON-destructive changes chosen for THIS project (look at its current state).',
  '  Prefer subtle, tasteful values. Do not jump to extremes.',
  '- Caption STYLE changes never change caption wording. Change wording only when explicitly asked.',
  '- "the captions" = the whole caption track (scope ALL); "this caption" = SELECTED.',
  '- "the whole video/clip" = WHOLE_CLIP; "this shot/segment" = CURRENT_SEGMENT.',
  '- Music is not the video\'s own audio: use audio.music_volume for music, audio.source_volume for the voice/original sound.',
  '- Large deletions or restructuring are destructive: only plan them when clearly asked.',
  '- If a clause cannot be done with these tools, set "unsupported" to a short honest reason and no calls.',
  '- If a clause is ambiguous in a way the project state cannot resolve, set "question" and no calls.',
  '- Otherwise "question" and "unsupported" are empty strings.',
  '- Every clause index you were given must appear exactly once in your answer.'
].join('\n');

/** A compact, bounded description of the project for the model. No ids, no dumps. */
export function compactProjectView(context: ChatContext) {
  const pick = (properties: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys
    .filter((key) => properties[key] !== undefined).map((key) => [key, properties[key]]));
  return {
    durationSec: context.project.timelineDurationSec,
    style: { aspectRatio: context.project.style.aspectRatio, reframePolicy: context.project.style.reframePolicy,
      zoomPolicy: context.project.style.zoomPolicy, gradingPolicy: context.project.style.gradingPolicy },
    tracks: context.tracks,
    elements: context.elements.slice(0, 40).map((view) => ({ handle: view.handle, semantic: view.semantic,
      label: view.label, startSec: view.startSec, endSec: view.endSec, selected: view.selected || undefined,
      properties: pick(view.properties, ['content', 'fontSize', 'color', 'x', 'y', 'width', 'height',
        'volume', 'scale', 'colorAdjustments', 'colorFilterId', 'frameLayout', 'sourceVolume', 'sourceMuted']) })),
    selection: context.selection,
    templates: context.templates.slice(0, 16).map((template) => template.name),
    transcriptOpening: context.transcript.opening.slice(0, 400),
    analysis: { faceShotRatio: context.analysis.faceShotRatio,
      informationShotRatio: context.analysis.informationShotRatio },
    recent: { lastAppliedSummary: context.recent.lastAppliedSummary,
      messages: context.recent.messages.slice(-4) },
    notes: context.notes
  };
}

export type ClausePlan = { index: number; intent: string; calls: AgentToolCall[];
  question: string; unsupported: string };

/** Converts the model's name/value args to a plain object, keeping only declared params. */
function toArgs(tool: string, list: Array<{ name: string; number: number | null; text: string | null;
  flag: boolean | null }>) {
  const spec = agentTool(tool);
  const allowed = new Set([...(spec?.params.map((param) => param.name) ?? []), 'target']);
  const args: Record<string, unknown> = {};
  for (const item of list) {
    if (!allowed.has(item.name)) continue;
    args[item.name] = item.number ?? item.text ?? item.flag ?? undefined;
  }
  return args;
}

export async function planClausesWithOpenAi(input: { llm: LlmRouterService; logger: Logger;
  message: string; clauses: Array<{ index: number; clause: string }>; context: ChatContext }):
  Promise<{ plans: ClausePlan[]; ai: AiAvailability }> {
  if (!input.clauses.length) return { plans: [], ai: aiAvailable() };
  const telemetry = createPerformanceTelemetry(chatPlannerAiMode());
  try {
    const result = await performanceContext.run(telemetry, async () => {
      if (!input.llm.isAnyConfigured(AGENT_PLANNER_ROLE)) return null;
      return input.llm.generate<{ clauses: Array<{ index: number; intent: string;
        calls: Array<{ tool: string; args: Array<{ name: string; number: number | null;
          text: string | null; flag: boolean | null }> }>; question: string; unsupported: string }> }>({
        role: AGENT_PLANNER_ROLE,
        request: { schemaName: 'edit_agent_plan', schema: AGENT_PLAN_SCHEMA, role: AGENT_PLANNER_ROLE,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: JSON.stringify({ fullRequest: input.message.slice(0, 1000),
            clausesToPlan: input.clauses, project: compactProjectView(input.context),
            tools: toolCatalog() }),
          options: { temperature: 0.2,
            maxOutputTokens: Number(process.env.EDIT_AGENT_MAX_OUTPUT_TOKENS) || 3000 } } });
    });
    if (!result) {
      return { plans: [], ai: aiUnavailable(chatPlannerAiMode().toUpperCase() === 'ONLINE'
        ? 'NOT_CONFIGURED' : 'DISABLED') };
    }
    const wanted = new Set(input.clauses.map((clause) => clause.index));
    const plans = result.data.clauses.filter((plan) => wanted.has(plan.index)).map((plan) => ({
      index: plan.index, intent: String(plan.intent ?? '').slice(0, 200),
      calls: plan.calls.slice(0, MAX_CALLS_PER_CLAUSE).filter((call) => agentTool(call.tool))
        .map((call) => ({ tool: call.tool, args: toArgs(call.tool, call.args ?? []) })),
      question: String(plan.question ?? '').slice(0, 300),
      unsupported: String(plan.unsupported ?? '').slice(0, 300) }));
    input.logger.log(JSON.stringify({ event: 'edit_agent_plan', provider: result.metadata.provider,
      model: result.metadata.model, clauses: plans.length,
      calls: plans.reduce((total, plan) => total + plan.calls.length, 0) }));
    return { plans, ai: aiAvailable() };
  } catch (error) {
    const ai = classifyAiFailure(error);
    input.logger.warn(JSON.stringify({ event: 'edit_agent_plan_failed', state: ai.state,
      kind: ai.failureKind }));
    return { plans: [], ai };
  }
}
