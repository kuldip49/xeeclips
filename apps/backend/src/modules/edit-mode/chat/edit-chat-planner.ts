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
import { createPerformanceTelemetry,
  performanceContext } from '../../processing/performance-telemetry';
import type { ChatContext } from './edit-chat-context';
import {
  CHAT_INTENT_SCHEMA, CHAT_MAX_MODEL_COMMANDS, validateChatIntent, type ChatIntent
} from './edit-chat-commands';

/** The role Phase 6 routes through. It already exists; nothing frozen changes. */
export const CHAT_PLANNER_ROLE = 'editingPlan' as const;

/**
 * The AI mode an EditMode chat turn runs under.
 *
 * The router reads its mode from the per-request AsyncLocalStorage context the
 * frozen video pipeline establishes for a processing job. EditMode is not a
 * processing job and never runs inside that context, so before Phase 7 every
 * chat turn saw the store's default - FALLBACK_ONLY - and no provider was ever
 * reached, however the environment was configured. The Phase 7 soak is what
 * surfaced that: 0% of turns reached a model with ONLINE fully configured.
 *
 * So EditMode declares its own mode, from its own setting, and runs the
 * planning call inside its own context. This changes nothing about the frozen
 * pipeline: a processing job still establishes its own context and is entirely
 * unaffected by what EditMode does in its own.
 *
 * EDIT_MODE_CHAT_AI_MODE wins when set; otherwise the deployment's declared
 * AI_PROCESSING_MODE is used. With neither set the production policy applies:
 * ONLINE (OpenAI) - the router still requires a configured, enabled OpenAI
 * provider, so a deployment without a key reports NOT_CONFIGURED and plans
 * deterministically. Set FALLBACK_ONLY to force rules-only explicitly.
 * (Previously the unset default was FALLBACK_ONLY, which silently kept the AI
 * editor off OpenAI even with a valid key.)
 */
export const chatPlannerAiMode = () =>
  (process.env.EDIT_MODE_CHAT_AI_MODE || process.env.AI_PROCESSING_MODE || '').trim() ||
  'ONLINE';

const SYSTEM_PROMPT = [
  'You convert one editing instruction into structured commands for a video editor.',
  '',
  'Rules you must follow exactly:',
  '- Only use the actions listed in the schema. Never invent an action.',
  '- Never output FFmpeg, shell commands, SQL, code, file paths or database ids.',
  '- Address things ONLY by the opaque handles in the context: "text:hook", "logo:main",',
  '  "audio:music1", "caption:12", "video:2", "zoom:1", "asset:logo1". A handle that is not',
  '  in the context does not exist. Three handles address a whole track: "captions:all"',
  '  (every caption), "video:all" (every video segment) and "audio:source" (the sound',
  '  recorded with the video).',
  '- Every element has a "semantic" role (HOOK, CTA, TITLE, CAPTION, LOGO, MUSIC,',
  '  SOURCE_VIDEO, ZOOM...). "The hook" is the element whose semantic is HOOK.',
  '- To change what the hook (or any text) SAYS, use SET_TEXT_CONTENT on that element.',
  '  Never create a second hook when one exists.',
  '- Target kinds: ELEMENT with a handle is the normal case. AT_TIME ({"atSec":12.5}) is only',
  '  for SPLIT_ELEMENT / cutting video. SELECTED = what the user selected. LAST = what the',
  '  previous turn changed ("it", "a little more"). REF = something an earlier command in',
  '  THIS plan created via its own "ref".',
  '- parameters is a short list of {name, number, text, flag}: set the one value field that',
  '  matches the parameter and leave the other two null. Only include parameters you set.',
  '- RELATIVE requests ("smaller", "a little louder", "warmer") are computed from the',
  '  CURRENT values in the context and emitted as absolute values. "A little" is a small',
  '  step; do not jump to an extreme.',
  '- Units: positions, sizes and opacity are 0..1 fractions of the frame; volume is a gain',
  '  0..2 (0.25 = 25%); colour controls are -1..1 (sharpness/fade/vignette 0..1); rotation',
  '  is degrees clockwise; zoom scale is 1.03..1.15; speed 0.25..4.',
  '- Change ONLY what was asked. Never touch captions, music, logo, colour, crop, zoom or',
  '  the template unless the instruction names them.',
  '- Address files ONLY by an asset handle from the asset list. If the file the user named',
  '  is not in that list, set needsClarification and say it is not uploaded.',
  '- Never invent a timestamp. Use only: the numbers the user stated, the playhead, the',
  '  selected range, or the startSec/endSec of a supplied transcript window.',
  '- Never invent transcript wording, speaker names, or facts about the video.',
  '- If the instruction is genuinely ambiguous (two logos, nothing selected), set',
  '  needsClarification with ONE short question instead of guessing.',
  '- If the editor has no command for what is asked (transitions, stabilisation...), set',
  '  intent UNSUPPORTED and say so plainly in clarificationQuestion.',
  '- Text the user dictated is used verbatim.',
  '- Give each grounding entry an honest confidence. Cuts and deletions need strong evidence.'
].join('\n');

/** The prompt body: a compact JSON view of everything addressable. */
function userPrompt(message: string, context: ChatContext): string {
  const view = {
    instruction: message,
    project: {
      timelineDurationSec: context.project.timelineDurationSec,
      aspectRatio: context.project.aspectRatio,
      zoomPolicy: context.project.style.zoomPolicy,
      reframePolicy: context.project.style.reframePolicy,
      currentTemplate: context.project.currentTemplate,
      hasTranscript: context.project.hasTranscript
    },
    tracks: context.tracks,
    selection: context.selection,
    elements: context.elements.map((element) => ({
      handle: element.handle, semantic: element.semantic, label: element.label,
      startSec: element.startSec, endSec: element.endSec, selected: element.selected,
      properties: element.properties
    })),
    assets: context.assets.map((asset) => ({
      handle: asset.handle, role: asset.role, filename: asset.filename,
      durationSec: asset.durationSec, inUse: asset.inUse
    })),
    transcriptWindows: context.transcript.windows.map((window) => ({
      startSec: window.startSec, endSec: window.endSec,
      confidence: window.confidence, text: window.text
    })),
    recent: context.recent,
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

  // One context for the whole turn, so the configuration check and the call it
  // guards agree about which mode they are in.
  const telemetry = createPerformanceTelemetry(chatPlannerAiMode());
  const result = await performanceContext.run(telemetry, async () => {
    if (!llm.isAnyConfigured(CHAT_PLANNER_ROLE)) return null;
    return llm.generate<unknown>({
      role: CHAT_PLANNER_ROLE,
      request: {
        schemaName: 'edit_mode_chat_plan',
        schema: CHAT_INTENT_SCHEMA,
        role: CHAT_PLANNER_ROLE,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: userPrompt(message, context),
        // Workstream G's parameter LIST keeps a command to the values it sets,
        // but a strict response is still verbose; the Phase 7 soak hit
        // truncation (which arrives as "not valid JSON") at 1600.
        options: { temperature: 0.1,
          maxOutputTokens: Number(process.env.EDIT_MODE_CHAT_MAX_OUTPUT_TOKENS) || 4000 }
      }
    });
  });
  if (!result) return null;
  // Malformed output throws out of validateChatIntent and is handled by the
  // caller, which falls back rather than mutating anything.
  const intent = validateChatIntent(result.data, { maxCommands: CHAT_MAX_MODEL_COMMANDS });
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
