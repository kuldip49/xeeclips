// The language-model planning step.
//
// The model's entire job is to turn one sentence into structured commands over
// a catalogue it was handed. It never sees the database, never sees FFmpeg,
// never picks a timestamp that was not already computed for it by the
// deterministic transcript search, and never returns anything but JSON matching
// CHAT_INTENT_SCHEMA. Everything it produces is validated, resolved and
// re-checked afterwards, so a bad plan is a rejected plan rather than a bad
// edit.
//
// Routing reuses the existing `editingPlan` role on the existing
// LlmRouterService. Phase 6 adds no provider, no key and no role: ONLINE,
// OFFLINE and FALLBACK_ONLY behave exactly as the rest of the system already
// defines them for that role.

import { Logger } from '@nestjs/common';
import type { LlmRouterService } from '../../processing/llm-router.service';
import type { ChatContext } from './edit-chat-context';
import {
  CHAT_INTENT_SCHEMA, validateChatIntent, type ChatIntent
} from './edit-chat-commands';

/** The role Phase 6 routes through. It already exists; nothing frozen changes. */
export const CHAT_PLANNER_ROLE = 'editingPlan' as const;

const SYSTEM_PROMPT = [
  'You convert one editing instruction into structured commands for a video editor.',
  '',
  'Rules you must follow exactly:',
  '- Only use the actions listed in the schema. Never invent an action.',
  '- Never output FFmpeg, shell commands, SQL, code, file paths or database ids.',
  '- Address elements ONLY by the handles in the supplied context, or by target kinds',
  '  SELECTED / LAST / ROLE / AT_TIME / REF. Never invent a UUID.',
  '- Address files ONLY by an assetHandle from the supplied asset list. If the file the user',
  '  named is not in that list, set needsClarification and say it is not uploaded.',
  '- Never invent a timestamp. Use only: the numbers the user stated, the playhead, the',
  '  selected range, or the startSec/endSec of a supplied transcript window.',
  '- Never invent transcript wording, speaker names, or facts about the video.',
  '- If the instruction is ambiguous - "make it smaller" with nothing selected and no obvious',
  '  target - set needsClarification with a short question instead of guessing.',
  '- Only change what was asked. Never rebuild the project or re-apply a preset.',
  '- Text the user dictated is used verbatim. Do not strengthen, embellish or fact-check it.',
  '- Give each grounding entry an honest confidence. Under-confident is safe; overconfident',
  '  is not. Cuts and deletions need strong evidence.'
].join('\n');

/** The prompt body: a compact JSON view of everything addressable. */
function userPrompt(message: string, context: ChatContext): string {
  const view = {
    instruction: message,
    project: {
      timelineDurationSec: context.project.timelineDurationSec,
      aspectRatio: context.project.style.aspectRatio,
      subtitlePolicy: context.project.style.subtitlePolicy,
      zoomPolicy: context.project.style.zoomPolicy,
      reframePolicy: context.project.style.reframePolicy,
      gradingPolicy: context.project.style.gradingPolicy,
      hookText: context.project.style.hookText,
      hasTranscript: context.project.hasTranscript
    },
    selection: context.selection,
    elements: context.elements.map((element) => ({
      handle: element.handle, role: element.role, label: element.label,
      startSec: element.startSec, endSec: element.endSec,
      selected: element.selected, properties: element.properties
    })),
    assets: context.assets.map((asset) => ({
      handle: asset.handle, role: asset.role, filename: asset.filename,
      durationSec: asset.durationSec, inUse: asset.inUse
    })),
    transcriptWindows: context.transcript.windows.map((window) => ({
      startSec: window.startSec, endSec: window.endSec,
      confidence: window.confidence, text: window.text
    })),
    analysis: context.analysis,
    recentTurns: context.recent.messages,
    lastAffected: context.recent.lastAffectedHandles,
    notes: context.notes
  };
  return [
    `Instruction: ${message}`,
    '',
    'Editor state (the only things you may address):',
    JSON.stringify(view),
    '',
    context.transcript.windows.length
      ? 'The transcriptWindows above were found by searching the transcript for this ' +
        'instruction. If the instruction refers to something said in the video, use one of ' +
        'those exact ranges. If none of them is clearly right, ask for clarification.'
      : 'No transcript window matched this instruction. Do not guess a time range from the ' +
        'video content; use stated numbers, the playhead or the selection only.'
  ].join('\n');
}

/**
 * Asks the configured model for a plan.
 *
 * Returns null when no provider is available for this AI mode, which is the
 * normal FALLBACK_ONLY path and also what happens in OFFLINE mode, where the
 * router's own role allowlist decides whether a local model may serve this
 * role. Callers treat null as "use the deterministic planner only".
 */
export async function planWithLlm(input: {
  llm: LlmRouterService;
  logger: Logger;
  message: string;
  context: ChatContext;
}): Promise<{ intent: ChatIntent; provider: string; model: string } | null> {
  const { llm, logger, message, context } = input;
  if ((process.env.EDIT_MODE_CHAT_LLM_ENABLED ?? 'true').toLowerCase() === 'false') return null;
  if (!llm.isAnyConfigured(CHAT_PLANNER_ROLE)) return null;

  const result = await llm.generate<unknown>({
    role: CHAT_PLANNER_ROLE,
    request: {
      schemaName: 'edit_mode_chat_plan',
      schema: CHAT_INTENT_SCHEMA,
      role: CHAT_PLANNER_ROLE,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userPrompt(message, context),
      options: { temperature: 0.1, maxOutputTokens: 1600 }
    }
  });
  // Malformed output throws out of validateChatIntent and is handled by the
  // caller, which falls back rather than mutating anything.
  const intent = validateChatIntent(result.data);
  const checked = rejectInventedTimestamps(intent, context);
  logger.log(JSON.stringify({ event: 'edit_mode_chat_plan', provider: result.metadata.provider,
    model: result.metadata.model, commands: checked.commands.length,
    needsClarification: checked.needsClarification }));
  return { intent: checked, provider: result.metadata.provider, model: result.metadata.model };
}

/** Tolerance when matching a model's range back to a supplied window. */
const WINDOW_TOLERANCE_SEC = 0.75;

/**
 * Refuses transcript grounding the search never offered.
 *
 * A model asked to cut "the part about pricing" can produce a confident range
 * out of nothing. Any TRANSCRIPT-grounded range must line up with one of the
 * candidate windows this backend computed, or the turn becomes a question. The
 * transcript is the authority on when something was said, not the model.
 */
export function rejectInventedTimestamps(intent: ChatIntent, context: ChatContext): ChatIntent {
  const windows = context.transcript.windows;
  const invented = intent.grounding.filter((entry) => entry.type === 'TRANSCRIPT' &&
    entry.startSec !== undefined && entry.endSec !== undefined &&
    !windows.some((window) =>
      Math.abs(window.startSec - entry.startSec!) <= WINDOW_TOLERANCE_SEC &&
      Math.abs(window.endSec - entry.endSec!) <= WINDOW_TOLERANCE_SEC));
  if (!invented.length) return intent;
  return {
    ...intent,
    intent: 'NEEDS_CLARIFICATION',
    commands: [],
    needsClarification: true,
    clarificationQuestion: windows.length
      ? 'I found a few places that could be what you mean, but none of them clearly matches. ' +
        `Did you mean around ${windows[0].startSec.toFixed(1)}s ("${
          windows[0].text.slice(0, 60)}...")?`
      : 'I could not find that part in the transcript. Can you give me the seconds, or select ' +
        'the range on the timeline?',
    warnings: [...intent.warnings,
      'A proposed time range was not backed by the transcript search and was discarded.']
  };
}
