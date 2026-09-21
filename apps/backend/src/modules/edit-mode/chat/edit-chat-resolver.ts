// Grounding and validation: logical handles become real ids, or the turn stops.
//
// Everything the planner produced is symbolic. This is where it meets the live
// project: "the logo" must be exactly one logo, "this" must be something the
// user actually selected, "12 to 17 seconds" must fit inside the timeline that
// exists right now, and an asset handle must name a file that was really
// uploaded. Anything that cannot be resolved becomes a question for the user,
// never a best guess.
//
// The output is a command bundle addressed entirely by real ids plus plan-local
// refs - the same shape the preset bundle uses - so the canonical layer can
// execute it through the ordinary element mutation path.

import type { EditProjectStyle } from '../presets/edit-preset-policy';
import {
  requiredConfidenceFor, type ChatCommand, type ChatElementAction, type ChatGrounding,
  type ChatSettingsAction, type ChatTarget
} from './edit-chat-commands';
import { assetIdForHandle, elementIdForHandle, type ChatContext,
  type ChatElementView } from './edit-chat-context';

export type ResolvedChatCommand =
  | { kind: 'ELEMENT'; action: ChatElementAction; ref?: string;
      payload: Record<string, unknown>; reason: string }
  | { kind: 'SETTINGS'; action: ChatSettingsAction;
      payload: Partial<EditProjectStyle>; reason: string };

export type ChatResolution =
  | { ok: true; commands: ResolvedChatCommand[]; affectedElements: string[];
      plannedChanges: string[]; warnings: string[] }
  | { ok: false; question: string; warnings: string[] };

const TIME_PARAMETERS = ['startTime', 'trimStart', 'trimEnd', 'playheadSec'] as const;

const percent = (value: unknown) => `${Math.round(Number(value) * 100)}%`;
const seconds = (value: unknown) => `${Number(value).toFixed(1)}s`;

/** Roles an ADD_ command needs the asset to have. */
const ADD_ASSET_ROLE: Partial<Record<ChatElementAction, string>> = {
  ADD_IMAGE: 'IMAGE', ADD_LOGO: 'LOGO', ADD_AUDIO: 'AUDIO'
};

const describe = (element: ChatElementView | undefined, fallback = 'the element') =>
  element ? element.label.toLowerCase() : fallback;

/**
 * Resolves one target handle to a live element, or explains why it cannot.
 *
 * `ref` targets are left symbolic: they point at something this same bundle
 * creates, so they are resolved during execution exactly as a preset ref is.
 */
function resolveTarget(target: ChatTarget, context: ChatContext,
  createdRefs: Set<string>): { id?: string; ref?: string; atSec?: number; question?: string } {
  if (target.kind === 'REF') {
    if (!target.ref || !createdRefs.has(target.ref)) {
      return { question: 'That refers to something this edit has not created.' };
    }
    return { ref: target.ref };
  }
  if (target.kind === 'SELECTED') {
    const handle = context.selection.selectedElementHandle;
    if (!handle) {
      return { question: 'Which element do you mean? Select it on the timeline or preview first, ' +
        'or name it (for example "the logo" or "the text").' };
    }
    return { id: elementIdForHandle(context, handle) };
  }
  if (target.kind === 'LAST') {
    const handle = context.recent.lastAffectedHandles[0];
    if (!handle) {
      return { question: 'I am not sure which element you mean - there is no recent one to ' +
        'refer back to. Select it, or name it.' };
    }
    return { id: elementIdForHandle(context, handle) };
  }
  if (target.kind === 'ELEMENT') {
    const id = target.handle ? elementIdForHandle(context, target.handle) : undefined;
    return id ? { id } : { question: 'That element is no longer on the timeline.' };
  }
  if (target.kind === 'AT_TIME') {
    // Left symbolic on purpose. A cut can be several commands long, and each
    // split changes which segment covers a second, so the segment is looked up
    // against the live timeline as the bundle executes rather than now.
    const atSec = Number(target.atSec);
    const hit = context.elements.find((element) => element.role === 'VIDEO' &&
      atSec >= element.startSec - 1e-6 && atSec < element.endSec - 1e-6);
    if (!hit) return { question: `There is no video segment at ${seconds(atSec)}.` };
    return { atSec };
  }
  // ROLE
  const matches = context.elements.filter((element) => element.role === target.role);
  if (!matches.length) {
    const noun = String(target.role ?? 'element').toLowerCase();
    return { question: `There is no ${noun} on the timeline yet.` };
  }
  if (matches.length > 1) {
    const selected = matches.find((element) => element.selected);
    if (selected) return { id: selected.id };
    return { question: `There are ${matches.length} of those (${matches
      .map((element) => element.label).join(', ')}). Which one do you mean?` };
  }
  return { id: matches[0].id };
}

/** The strongest grounding confidence backing this turn. */
const groundingConfidence = (grounding: ChatGrounding[]) =>
  grounding.reduce((best, entry) => Math.max(best, entry.confidence), 0);

/**
 * Turns a validated plan into an executable bundle.
 *
 * Besides handle resolution this enforces the two invariants a language model
 * cannot be trusted with: every timestamp must fall inside the timeline that
 * exists now, and a destructive command must be backed by stronger grounding
 * than a cosmetic one.
 */
export function resolveChatPlan(commands: ChatCommand[], grounding: ChatGrounding[],
  context: ChatContext): ChatResolution {
  const warnings: string[] = [];
  const resolved: ResolvedChatCommand[] = [];
  const affected = new Set<string>();
  const plannedChanges: string[] = [];
  const createdRefs = new Set<string>();
  const byId = new Map(context.elements.map((element) => [element.id, element]));
  const duration = context.project.timelineDurationSec;
  const confidence = groundingConfidence(grounding);

  for (const command of commands) {
    if (command.kind === 'SETTINGS') {
      resolved.push({ kind: 'SETTINGS', action: command.action,
        payload: command.parameters, reason: command.reason });
      for (const [field, value] of Object.entries(command.parameters)) {
        plannedChanges.push(field === 'hookText'
          ? (value === null ? 'Remove the on-screen hook'
            : `Set the hook to "${String(value)}"`)
          : `Set ${field.replace(/([A-Z])/gu, ' $1').toLowerCase().trim()} to ${String(value)}`);
      }
      continue;
    }

    // Destructive work needs more evidence before it is even offered.
    const required = requiredConfidenceFor(command);
    if (confidence > 0 && confidence < required) {
      return { ok: false, warnings, question: 'I am not confident enough about which part of ' +
        'the video you mean to propose that cut. Can you point at it - select the range on the ' +
        'timeline, or give me the seconds?' };
    }

    const payload: Record<string, unknown> = { ...command.parameters };
    let target: ChatElementView | undefined;

    if (command.target) {
      const outcome = resolveTarget(command.target, context, createdRefs);
      if (outcome.question) return { ok: false, question: outcome.question, warnings };
      if (outcome.ref) payload.ref = outcome.ref;
      else if (outcome.atSec !== undefined) {
        payload.atSec = outcome.atSec;
        // Recorded for the preview wording only; the command binds at execution.
        target = context.elements.find((element) => element.role === 'VIDEO' &&
          outcome.atSec! >= element.startSec - 1e-6 && outcome.atSec! < element.endSec - 1e-6);
      } else if (outcome.id) {
        payload.elementId = outcome.id;
        affected.add(outcome.id);
        target = byId.get(outcome.id);
      }
    }

    if (command.assetHandle) {
      const assetId = assetIdForHandle(context, command.assetHandle);
      const asset = context.assets.find((item) => item.handle === command.assetHandle);
      const expected = ADD_ASSET_ROLE[command.action];
      if (!assetId || !asset) {
        return { ok: false, warnings, question: 'I could not find that file in this project. ' +
          'Upload it first, then ask me again.' };
      }
      if (expected && asset.role !== expected) {
        return { ok: false, warnings, question: `"${asset.filename}" is stored as a ${
          asset.role.toLowerCase()}, not a ${expected.toLowerCase()}. Which file did you mean?` };
      }
      payload.assetId = assetId;
    }

    // Every timestamp is checked against the timeline that exists right now.
    for (const key of TIME_PARAMETERS) {
      if (payload[key] === undefined) continue;
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value < -1e-6) {
        return { ok: false, warnings, question: `That time (${String(payload[key])}) is not a ` +
          'valid position in this video. Which second did you mean?' };
      }
      const ceiling = key === 'trimStart' || key === 'trimEnd'
        ? Math.max(duration, context.project.sourceDurationSec) : duration;
      if (value > ceiling + 1e-6) {
        return { ok: false, warnings, question: `This video is ${seconds(duration)} long, so ${
          seconds(value)} is past the end. Which time did you mean?` };
      }
    }
    if (payload.duration !== undefined) {
      const value = Number(payload.duration);
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, warnings,
          question: 'That duration is not valid. How long should it be?' };
      }
      const startTime = Number(payload.startTime ?? target?.startSec ?? 0);
      if (startTime + value > duration + 1e-6) {
        warnings.push(`Shortened to fit: the timeline ends at ${seconds(duration)}.`);
        payload.duration = Number(Math.max(0.05, duration - startTime).toFixed(3));
      }
    }

    if (command.ref) createdRefs.add(command.ref);
    resolved.push({ kind: 'ELEMENT', action: command.action,
      ...(command.ref ? { ref: command.ref } : {}), payload, reason: command.reason });
    plannedChanges.push(describeChange(command.action, payload, target, context));
  }

  return { ok: true, commands: resolved, affectedElements: [...affected],
    plannedChanges, warnings };
}

/** One plain sentence per command, for the proposal card. No JSON is shown. */
function describeChange(action: ChatElementAction, payload: Record<string, unknown>,
  target: ChatElementView | undefined, context: ChatContext): string {
  const name = describe(target);
  switch (action) {
    case 'TRIM_ELEMENT': {
      const start = Number(payload.trimStart ?? 0);
      const end = Number(payload.trimEnd ?? 0);
      return `Trim ${name} to ${seconds(start)}–${seconds(end)} of its source`;
    }
    case 'SPLIT_ELEMENT':
      return `Split ${name} at ${seconds(payload.playheadSec)}`;
    case 'DELETE_ELEMENT':
      return `Remove ${name} from the timeline and close the gap`;
    case 'REORDER_ELEMENT':
      return `Move ${name} to position ${Number(payload.toPosition) + 1}`;
    case 'ADD_IMAGE': case 'ADD_LOGO': {
      const asset = context.assets.find((item) => item.id === payload.assetId);
      return `Add ${action === 'ADD_LOGO' ? 'the logo' : 'the image'}${
        asset ? ` ${asset.filename}` : ''} to the video`;
    }
    case 'ADD_TEXT':
      return 'Add a text overlay';
    case 'ADD_AUDIO': {
      const asset = context.assets.find((item) => item.id === payload.assetId);
      return `Add ${asset ? asset.filename : 'the audio track'} as background audio`;
    }
    case 'MOVE_ELEMENT':
      return `Move ${name} to ${percent(payload.x)} across, ${percent(payload.y)} down`;
    case 'RESIZE_ELEMENT':
      return `Resize ${name} to ${percent(payload.width)} of the frame width`;
    case 'SET_ELEMENT_TIMING':
      return `Show ${name} from ${seconds(payload.startTime)} for ${seconds(payload.duration)}`;
    case 'SET_ELEMENT_OPACITY':
      return `Set ${name} opacity to ${percent(payload.opacity)}`;
    case 'SET_ELEMENT_Z_INDEX':
      return `Bring ${name} to layer ${String(payload.zIndex)}`;
    case 'UPDATE_TEXT':
      return `Change ${name} to read "${String(payload.content ?? '').slice(0, 60)}"`;
    case 'DUPLICATE_ELEMENT':
      return `Duplicate ${name}`;
    case 'REMOVE_ELEMENT':
      return `Remove ${name}`;
    case 'SET_AUDIO_VOLUME':
      return `Set ${name} volume to ${percent(payload.volume)}`;
    case 'SET_AUDIO_MUTED':
      return payload.muted === true ? `Mute ${name}` : `Unmute ${name}`;
    case 'SET_AUDIO_FADE':
      return `Fade ${name} in over ${seconds(payload.fadeInSec)} and out over ${
        seconds(payload.fadeOutSec)}`;
    default:
      return `Update ${name}`;
  }
}
