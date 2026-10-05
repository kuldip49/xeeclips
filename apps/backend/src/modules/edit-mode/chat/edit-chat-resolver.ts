// Grounding and validation: logical handles become real ids, or the turn stops.
//
// Everything the planner produced is symbolic. This is where it meets the live
// project: "logo:main" must be exactly one logo, "this" must be something the
// user actually selected, "12 to 17 seconds" must fit inside the timeline that
// exists right now, and an asset handle must name a file that was really
// uploaded. Anything that cannot be resolved becomes a question for the user,
// never a best guess.
//
// The output is a command bundle addressed entirely by real ids plus plan-local
// refs - the same shape the preset bundle uses - so the canonical layer can
// execute it through the ordinary element mutation path.
//
// Workstream G adds three things here:
//   * whole-track handles: captions:all (one bulk command), video:all (one
//     command per segment), audio:source (the source-audio bulk form);
//   * preset-planned zooms: editing one writes a zoom element that CLAIMS it,
//     so the edit replaces the planned moment instead of duplicating it;
//   * a before -> after line per change, computed from the live state, so the
//     proposal card can say "Music 20% -> 14%" instead of showing a command.

import type { EditProjectStyle } from '../presets/edit-preset-policy';
import { EDIT_MODE_ZOOM } from '../render/edit-mode-zoom';
import {
  requiredConfidenceFor, type ChatCommand, type ChatElementAction, type ChatElementCommand,
  type ChatGrounding, type ChatSettingsAction, type ChatTarget
} from './edit-chat-commands';
import { assetIdForHandle, viewForHandle, type ChatContext,
  type ChatElementView } from './edit-chat-context';
import type { ChatChange } from './edit-chat.types';

export type ResolvedChatCommand =
  | { kind: 'ELEMENT'; action: ChatElementAction; ref?: string;
      payload: Record<string, unknown>; reason: string }
  | { kind: 'SETTINGS'; action: ChatSettingsAction;
      payload: Partial<EditProjectStyle>; reason: string };

export type ChatResolution =
  | { ok: true; commands: ResolvedChatCommand[]; affectedElements: string[];
      plannedChanges: string[]; changes: ChatChange[]; warnings: string[] }
  | { ok: false; question: string; warnings: string[] };

const TIME_PARAMETERS = ['startTime', 'trimStart', 'trimEnd', 'playheadSec', 'atSec',
  'targetAtSec'] as const;

const percent = (value: unknown) => `${Math.round(Number(value) * 100)}%`;
const seconds = (value: unknown) => `${Number(value).toFixed(1)}s`;
const signed = (value: unknown) => {
  const number = Math.round(Number(value) * 100);
  return number > 0 ? `+${number}` : String(number);
};
const quote = (value: unknown) => `"${String(value ?? '').slice(0, 80)}"`;

/** Roles an ADD_ command needs the asset to have. */
const ADD_ASSET_ROLE: Partial<Record<ChatElementAction, string>> = {
  ADD_IMAGE: 'IMAGE', ADD_LOGO: 'LOGO', ADD_AUDIO: 'AUDIO'
};

/**
 * Which element types each action may touch. Checked here so a mismatch is a
 * plain question ("the logo has no volume") rather than a rejected apply.
 */
const VISUAL = ['IMAGE', 'TEXT', 'SUBTITLE'];
const TEXTUAL = ['TEXT', 'SUBTITLE'];
const ACTION_TYPES: Partial<Record<ChatElementAction, string[]>> = {
  TRIM_ELEMENT: ['VIDEO'], SPLIT_ELEMENT: ['VIDEO'], DELETE_ELEMENT: ['VIDEO'],
  REORDER_ELEMENT: ['VIDEO'], SET_SPEED: ['VIDEO'], SET_VIDEO_SCALE: ['VIDEO'],
  SET_VIDEO_POSITION: ['VIDEO'], SET_VIDEO_CROP: ['VIDEO', 'IMAGE'],
  SET_VIDEO_FLIP: ['VIDEO', 'IMAGE'], SET_VIDEO_ROTATION: ['VIDEO', 'IMAGE', 'TEXT', 'SUBTITLE'],
  MOVE_ELEMENT: VISUAL, RESIZE_ELEMENT: VISUAL, SET_ELEMENT_OPACITY: VISUAL,
  SET_ELEMENT_Z_INDEX: VISUAL, SET_ELEMENT_VISIBLE: VISUAL,
  SET_ELEMENT_TIMING: ['IMAGE', 'TEXT', 'SUBTITLE', 'AUDIO', 'EFFECT'],
  REMOVE_ELEMENT: ['IMAGE', 'TEXT', 'SUBTITLE', 'AUDIO'], DUPLICATE_ELEMENT: ['IMAGE', 'TEXT'],
  UPDATE_TEXT: ['TEXT'], SET_TEXT_CONTENT: ['TEXT'], SET_TEXT_STYLE_PRESET: ['TEXT'],
  SET_TEXT_FONT: TEXTUAL, SET_TEXT_SIZE: TEXTUAL, SET_TEXT_WEIGHT: TEXTUAL,
  SET_TEXT_COLOR: TEXTUAL, SET_TEXT_ALIGNMENT: TEXTUAL, SET_TEXT_STROKE: TEXTUAL,
  SET_TEXT_SHADOW: TEXTUAL, SET_TEXT_BACKGROUND: TEXTUAL, SET_TEXT_SPACING: TEXTUAL,
  SET_TEXT_CASE: TEXTUAL, SET_CAPTION_TEXT: ['SUBTITLE'], SPLIT_CAPTION: ['SUBTITLE'],
  MERGE_CAPTION: ['SUBTITLE'], SET_CAPTION_STYLE: ['SUBTITLE'],
  SET_CAPTION_ACTIVE_WORD: ['SUBTITLE'], APPLY_CAPTION_STYLE_TO_ALL: ['SUBTITLE'],
  SET_AUDIO_VOLUME: ['AUDIO'], SET_AUDIO_MUTED: ['AUDIO'], SET_AUDIO_FADE: ['AUDIO'],
  SET_AUDIO_TRIM: ['AUDIO'], SET_AUDIO_DUCKING: ['AUDIO'],
  SET_SOURCE_AUDIO_VOLUME: ['VIDEO'], SET_SOURCE_AUDIO_MUTED: ['VIDEO'],
  SET_ZOOM_SCALE: ['EFFECT'], REMOVE_ZOOM: ['EFFECT'],
  SET_ELEMENT_LOCKED: ['VIDEO', 'AUDIO', 'TEXT', 'SUBTITLE', 'IMAGE']
};
const COLOR_ACTIONS: Partial<Record<ChatElementAction, string>> = {
  SET_VIDEO_EXPOSURE: 'exposure', SET_VIDEO_BRIGHTNESS: 'brightness',
  SET_VIDEO_CONTRAST: 'contrast', SET_VIDEO_HIGHLIGHTS: 'highlights',
  SET_VIDEO_SHADOWS: 'shadows', SET_VIDEO_SATURATION: 'saturation',
  SET_VIDEO_TEMPERATURE: 'temperature', SET_VIDEO_TINT: 'tint',
  SET_VIDEO_SHARPNESS: 'sharpness', SET_VIDEO_FADE: 'fade', SET_VIDEO_VIGNETTE: 'vignette'
};
for (const action of [...Object.keys(COLOR_ACTIONS), 'RESET_VIDEO_ADJUSTMENTS',
  'APPLY_COLOR_FILTER'] as ChatElementAction[]) ACTION_TYPES[action] = ['VIDEO'];

/** Commands that accept the caption track (elementType SUBTITLE) as a target. */
const CAPTION_TRACK_ACTIONS = new Set<ChatElementAction>(['SET_TEXT_FONT', 'SET_TEXT_SIZE',
  'SET_TEXT_WEIGHT', 'SET_TEXT_COLOR', 'SET_TEXT_ALIGNMENT', 'SET_TEXT_STROKE',
  'SET_TEXT_SHADOW', 'SET_TEXT_BACKGROUND', 'SET_TEXT_SPACING', 'SET_TEXT_CASE',
  'SET_CAPTION_ACTIVE_WORD', 'MOVE_ELEMENT', 'SET_ELEMENT_VISIBLE']);

type Resolved = { id?: string; ref?: string; atSec?: number; view?: ChatElementView;
  aggregate?: 'CAPTIONS' | 'VIDEO' | 'SOURCE_AUDIO'; question?: string };

/**
 * Resolves one target to a live element, or explains why it cannot.
 *
 * `ref` targets are left symbolic: they point at something this same bundle
 * creates, so they are resolved during execution exactly as a preset ref is.
 */
function resolveTarget(target: ChatTarget, context: ChatContext,
  createdRefs: Set<string>): Resolved {
  if (target.kind === 'REF') {
    if (!target.ref || !createdRefs.has(target.ref)) {
      return { question: 'That refers to something this edit has not created.' };
    }
    return { ref: target.ref };
  }
  if (target.kind === 'SELECTED') {
    const handle = context.selection.selectedElementHandle;
    const view = handle ? viewForHandle(context, handle) : undefined;
    if (!view) {
      return { question: 'Which element do you mean? Select it on the timeline or preview first, ' +
        'or name it (for example "the logo" or "the hook").' };
    }
    return { id: view.id, view };
  }
  if (target.kind === 'LAST') {
    const handle = context.recent.active?.handles[0] ?? context.recent.lastAffectedHandles[0];
    const view = handle ? viewForHandle(context, handle) : undefined;
    if (!view) {
      return { question: 'I am not sure which element you mean - there is no recent one to ' +
        'refer back to. Select it, or name it.' };
    }
    return { id: view.virtual ? undefined : view.id, view };
  }
  if (target.kind === 'ELEMENT') {
    const handle = target.handle ?? '';
    if (handle === 'captions:all') {
      return context.tracks.captions.count ? { aggregate: 'CAPTIONS' }
        : { question: 'There are no captions on the timeline yet. Say "add captions" first.' };
    }
    if (handle === 'video:all') return { aggregate: 'VIDEO' };
    if (handle === 'audio:source') return { aggregate: 'SOURCE_AUDIO' };
    const view = viewForHandle(context, handle);
    if (!view) return { question: 'That element is no longer on the timeline.' };
    return { id: view.virtual ? undefined : view.id, view };
  }
  if (target.kind === 'AT_TIME') {
    // Left symbolic on purpose. A cut can be several commands long, and each
    // split changes which segment covers a second, so the segment is looked up
    // against the live timeline as the bundle executes rather than now.
    const atSec = Number(target.atSec);
    const hit = context.elements.find((element) => element.role === 'VIDEO' &&
      atSec >= element.startSec - 1e-6 && atSec < element.endSec - 1e-6);
    if (!hit) return { question: `There is no video segment at ${seconds(atSec)}.` };
    return { atSec, view: hit };
  }
  // ROLE: legacy type roles, or a Workstream G semantic role.
  const semantic = ['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD'].includes(String(target.role));
  const matches = context.elements.filter((element) => semantic
    ? element.semantic === target.role : element.role === target.role);
  if (!matches.length) {
    const noun = String(target.role ?? 'element').toLowerCase().replace('_', ' ');
    return { question: `There is no ${noun} on the timeline yet.` };
  }
  if (matches.length > 1) {
    const selected = matches.find((element) => element.selected);
    if (selected) return { id: selected.id, view: selected };
    return { question: `There are ${matches.length} of those (${matches
      .map((element) => element.label).join(', ')}). Which one do you mean?` };
  }
  return { id: matches[0].virtual ? undefined : matches[0].id, view: matches[0] };
}

/** The strongest grounding confidence backing this turn. */
const groundingConfidence = (grounding: ChatGrounding[]) =>
  grounding.reduce((best, entry) => Math.max(best, entry.confidence), 0);

/**
 * An edit of a preset-planned zoom, re-expressed as the zoom element that
 * replaces it. The moment keeps its place and length; only what was asked for
 * changes.
 */
function claimPlannedZoom(command: ChatElementCommand, view: ChatElementView):
  { action: ChatElementAction; payload: Record<string, unknown> } | null {
  const base = { startTime: view.startSec,
    duration: Math.max(Number((view.endSec - view.startSec).toFixed(3)),
      EDIT_MODE_ZOOM.rampInSec + EDIT_MODE_ZOOM.minHoldSec + EDIT_MODE_ZOOM.rampOutSec),
    scale: Number(view.properties.scale), claimsMoment: view.momentKey,
    triggerText: String(view.properties.triggerText ?? '') };
  if (command.action === 'SET_ZOOM_SCALE') {
    return { action: 'ADD_ZOOM', payload: { ...base, scale: command.parameters.scale } };
  }
  if (command.action === 'REMOVE_ZOOM') {
    return { action: 'ADD_ZOOM', payload: { ...base, enabled: false } };
  }
  if (command.action === 'SET_ELEMENT_TIMING') {
    return { action: 'ADD_ZOOM', payload: { ...base,
      startTime: command.parameters.startTime ?? base.startTime,
      duration: command.parameters.duration ?? base.duration } };
  }
  return null;
}

/**
 * Turns a validated plan into an executable bundle.
 *
 * Besides handle resolution this enforces the invariants a language model
 * cannot be trusted with: every timestamp must fall inside the timeline that
 * exists now, a command must suit the type of what it targets, and a
 * destructive command must be backed by stronger grounding than a cosmetic one.
 */
export function resolveChatPlan(commands: ChatCommand[], grounding: ChatGrounding[],
  context: ChatContext): ChatResolution {
  const warnings: string[] = [];
  const resolved: ResolvedChatCommand[] = [];
  const affected = new Set<string>();
  const plannedChanges: string[] = [];
  const changes: ChatChange[] = [];
  const createdRefs = new Set<string>();
  const duration = context.project.timelineDurationSec;
  const confidence = groundingConfidence(grounding);
  const note = (described: Described | null) => {
    if (!described) return;
    if (!plannedChanges.includes(described.line)) plannedChanges.push(described.line);
    if (!described.change) return;
    // Two commands on the same property (a resize that recentres after a
    // move) are ONE change to the user: first "before", last "after".
    const same = changes.find((item) => item.label === described.change!.label);
    if (same) same.after = described.change.after;
    else changes.push(described.change);
  };

  for (const command of commands) {
    if (command.kind === 'SETTINGS') {
      resolved.push({ kind: 'SETTINGS', action: command.action,
        payload: command.parameters, reason: command.reason });
      for (const [field, value] of Object.entries(command.parameters)) {
        const label = field.replace(/([A-Z])/gu, ' $1').toLowerCase().trim();
        const before = (context.project.style as unknown as Record<string, unknown>)[field];
        note({ line: `Set ${label} to ${String(value)}`,
          change: { label: label[0].toUpperCase() + label.slice(1),
            before: String(before ?? '-'), after: String(value) } });
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

    let action = command.action;
    let payload: Record<string, unknown> = { ...command.parameters };
    let target: ChatElementView | undefined;

    if (command.target) {
      const outcome = resolveTarget(command.target, context, createdRefs);
      if (outcome.question) return { ok: false, question: outcome.question, warnings };
      if (outcome.ref) payload.ref = outcome.ref;
      else if (outcome.aggregate === 'CAPTIONS') {
        if (action === 'SET_CAPTION_STYLE' || action === 'APPLY_CAPTION_STYLE_TO_ALL') {
          // One reference caption takes the style, then the whole track copies
          // it - the two existing commands, in the order the Captions panel uses.
          const reference = context.runtime.captionIds[0];
          if (action === 'SET_CAPTION_STYLE') {
            resolved.push({ kind: 'ELEMENT', action: 'SET_CAPTION_STYLE',
              payload: { ...payload, elementId: reference }, reason: command.reason });
          }
          action = 'APPLY_CAPTION_STYLE_TO_ALL';
          payload = { elementId: reference };
        } else if (action === 'SET_CAPTIONS_VISIBLE' || action === 'REMOVE_CAPTIONS' ||
          action === 'GENERATE_CAPTIONS') {
          // Already track-wide.
        } else if (CAPTION_TRACK_ACTIONS.has(action)) {
          payload.elementType = 'SUBTITLE';
          payload.scope = 'TRACK';
        } else {
          return { ok: false, warnings, question: 'I can only restyle, move, show or hide the ' +
            'captions as a group. Which caption did you mean?' };
        }
      } else if (outcome.aggregate === 'SOURCE_AUDIO') {
        if (action !== 'SET_SOURCE_AUDIO_VOLUME' && action !== 'SET_SOURCE_AUDIO_MUTED') {
          return { ok: false, warnings,
            question: 'The original sound can only be made louder, quieter or muted.' };
        }
        payload.scope = 'ALL_VIDEO_SEGMENTS';
      } else if (outcome.aggregate === 'VIDEO') {
        payload.scope = 'ALL_VIDEO_SEGMENTS';
        const allowed = ACTION_TYPES[action];
        if (allowed && !allowed.includes('VIDEO')) {
          return { ok: false, warnings, question: 'That change does not apply to the video.' };
        }
      } else if (outcome.atSec !== undefined) {
        payload.targetAtSec = outcome.atSec;
        // Recorded for the preview wording only; the command binds at execution.
        target = outcome.view;
      } else if (outcome.view?.virtual) {
        const claim = claimPlannedZoom(command, outcome.view);
        if (!claim) {
          return { ok: false, warnings, question: 'That zoom was planned by the preset; I can ' +
            'make it stronger or weaker, move it, or remove it.' };
        }
        action = claim.action;
        payload = claim.payload;
        target = outcome.view;
      } else if (outcome.id) {
        target = outcome.view;
        payload.elementId = outcome.id;
        affected.add(outcome.id);
      }
      const allowed = ACTION_TYPES[action];
      if (target && !target.virtual && allowed && !allowed.includes(target.type)) {
        return { ok: false, warnings, question: mismatchQuestion(action, target) };
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
    // A created hook or CTA carries its role the same way a preset-created one
    // does, so templates, later chat turns and "the hook" all recognise it.
    if (action === 'ADD_TEXT' && typeof payload.semanticRole === 'string') {
      payload.presetRole = payload.semanticRole;
    }
    delete payload.semanticRole;

    // Every timestamp is checked against the timeline that exists right now.
    for (const key of TIME_PARAMETERS) {
      if (payload[key] === undefined) continue;
      const value = Number(payload[key]);
      if (!Number.isFinite(value) || value < -1e-6) {
        return { ok: false, warnings, question: `That time (${String(payload[key])}) is not a ` +
          'valid position in this video. Which second did you mean?' };
      }
      const ceiling = key === 'trimStart' || key === 'trimEnd'
        ? Math.max(duration, context.project.sourceDurationSec,
          ...context.assets.map((asset) => asset.durationSec ?? 0)) : duration;
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

    const wholeVideo = payload.scope === 'ALL_VIDEO_SEGMENTS';
    if (wholeVideo) {
      const segments = context.elements.filter((element) => element.role === 'VIDEO');
      for (const segment of segments) affected.add(segment.id);
      note(describeChange(action, payload, undefined, context, segments.length));
    }
    if (command.ref) createdRefs.add(command.ref);
    resolved.push({ kind: 'ELEMENT', action,
      ...(command.ref ? { ref: command.ref } : {}), payload, reason: command.reason });
    // A whole-video change was described once above with its fan-out; describing
    // it again here (with no single target) produced a phantom "the element" line.
    if (!wholeVideo) note(describeChange(action, payload, target, context));
  }

  return { ok: true, commands: resolved, affectedElements: [...affected],
    plannedChanges, changes, warnings };
}

function mismatchQuestion(action: ChatElementAction, target: ChatElementView) {
  const name = target.label.toLowerCase();
  if (action.startsWith('SET_AUDIO') || action.startsWith('SET_SOURCE_AUDIO')) {
    return `${target.label} has no sound of its own. Did you mean the music or the original audio?`;
  }
  if (COLOR_ACTIONS[action] || action === 'APPLY_COLOR_FILTER') {
    return `Colour changes apply to the video, not to ${name}. Should I change the video's colour?`;
  }
  if (action.startsWith('SET_TEXT') || action.startsWith('SET_CAPTION')) {
    return `${target.label} is not text. Which text did you mean?`;
  }
  return `I can't do that to ${name}. Which element did you mean?`;
}

type Described = { line: string; change?: ChatChange };

/** The display name for a change line: "Music (song.mp3)", "Hook", "Video segment 2". */
const nameOf = (target: ChatElementView | undefined, payload: Record<string, unknown>,
  context: ChatContext) => {
  if (payload.elementType === 'SUBTITLE') return 'Captions';
  if (!target) return 'the element';
  if (target.semantic === 'HOOK') return 'Hook';
  if (target.semantic === 'CTA') return 'Call to action';
  if (target.semantic === 'SOURCE_VIDEO') {
    return context.tracks.videoSegments > 1 ? `Video ${target.handle.split(':')[1]}` : 'Video';
  }
  if (target.semantic === 'MUSIC') return 'Music';
  if (target.semantic === 'LOGO') return 'Logo';
  if (target.semantic === 'ZOOM') return `Zoom at ${target.startSec.toFixed(1)}s`;
  return target.label;
};

/**
 * One plain sentence per command for the proposal card, plus a concrete
 * before -> after pair where there is a single value to show. No JSON.
 */
function describeChange(action: ChatElementAction, payload: Record<string, unknown>,
  target: ChatElementView | undefined, context: ChatContext, fanOut = 1): Described {
  const name = nameOf(target, payload, context);
  const props = target?.properties ?? {};
  const captions = context.tracks.captions;
  const bulk = payload.elementType === 'SUBTITLE';
  const change = (label: string, before: unknown, after: unknown): Described['change'] =>
    ({ label, before: String(before), after: String(after) });
  const scope = fanOut > 1 ? `the video (${fanOut} segments)` : name.toLowerCase();
  const colorKey = COLOR_ACTIONS[action];
  if (colorKey) {
    const color = (props.color ?? {}) as Record<string, number>;
    const label = `${colorKey[0].toUpperCase()}${colorKey.slice(1)}`;
    return { line: `Set ${colorKey} on ${scope} to ${signed(payload[colorKey])}`,
      change: change(fanOut > 1 ? `${label} (video)` : `${label} (${name})`,
        signed(color[colorKey] ?? 0), signed(payload[colorKey])) };
  }
  switch (action) {
    case 'TRIM_ELEMENT':
      return { line: `Trim ${name.toLowerCase()} to ${seconds(payload.trimStart)}–${
        seconds(payload.trimEnd)} of its source` };
    case 'SPLIT_ELEMENT':
      return { line: `Split the video at ${seconds(payload.playheadSec)}` };
    case 'DELETE_ELEMENT':
      return { line: `Remove ${name.toLowerCase()} from the timeline and close the gap` };
    case 'REORDER_ELEMENT':
      return { line: `Move ${name.toLowerCase()} to position ${Number(payload.toPosition) + 1}` };
    case 'ADD_IMAGE': case 'ADD_LOGO': {
      const asset = context.assets.find((item) => item.id === payload.assetId);
      return { line: `Add ${action === 'ADD_LOGO' ? 'the logo' : 'the image'}${
        asset ? ` ${asset.filename}` : ''} to the video` };
    }
    case 'ADD_TEXT': {
      const role = payload.presetRole === 'HOOK' ? 'hook' : payload.presetRole === 'CTA'
        ? 'call to action' : 'text overlay';
      return { line: `Add a ${role}${payload.content ? ` reading ${quote(payload.content)}` : ''}`,
        ...(payload.content ? { change: change(role === 'hook' ? 'Hook' : 'New text', '(none)',
          quote(payload.content)) } : {}) };
    }
    case 'ADD_AUDIO': {
      const asset = context.assets.find((item) => item.id === payload.assetId);
      return { line: `Add ${asset ? asset.filename : 'the audio track'} as background audio` };
    }
    case 'MOVE_ELEMENT': {
      if (bulk) {
        return { line: `Move the captions to ${percent(payload.y)} down the frame`,
          change: change('Caption position', `${percent(captions.y ?? 0)} down`,
            `${percent(payload.y)} down`) };
      }
      return { line: `Move ${name.toLowerCase()} to ${percent(payload.x)} across, ${
        percent(payload.y)} down`,
      change: change(`${name} position`, `${percent(props.x)}, ${percent(props.y)}`,
        `${percent(payload.x)}, ${percent(payload.y)}`) };
    }
    case 'RESIZE_ELEMENT':
      return { line: `Resize ${name.toLowerCase()} to ${percent(payload.width)} of the frame width`,
        change: change(`${name} size`, `${percent(props.width)} wide`,
          `${percent(payload.width)} wide`) };
    case 'SET_ELEMENT_TIMING':
      return { line: `Show ${name.toLowerCase()} from ${seconds(payload.startTime)} for ${
        seconds(payload.duration)}`,
      change: change(`${name} timing`, target
        ? `${seconds(target.startSec)}–${seconds(target.endSec)}` : '-',
      `${seconds(payload.startTime)}–${seconds(Number(payload.startTime) +
        Number(payload.duration))}`) };
    case 'SET_ELEMENT_OPACITY':
      return { line: `Set ${name.toLowerCase()} opacity to ${percent(payload.opacity)}`,
        change: change(`${name} opacity`, percent(props.opacity ?? 1), percent(payload.opacity)) };
    case 'SET_ELEMENT_Z_INDEX':
      return { line: `Put ${name.toLowerCase()} on layer ${String(payload.zIndex)}`,
        change: change(`${name} layer`, props.zIndex ?? '-', payload.zIndex) };
    case 'SET_ELEMENT_VISIBLE':
      return { line: `${payload.visible === false ? 'Hide' : 'Show'} ${bulk ? 'the captions'
        : name.toLowerCase()}` };
    case 'SET_ELEMENT_LOCKED':
      return { line: `${payload.locked === true ? 'Lock' : 'Unlock'} ${name.toLowerCase()}` };
    case 'UPDATE_TEXT': case 'SET_TEXT_CONTENT':
      return { line: `Change ${name.toLowerCase()} to read ${quote(payload.content)}`,
        change: change(name, quote(props.content), quote(payload.content)) };
    case 'SET_TEXT_SIZE':
      return { line: `Set ${bulk ? 'caption' : name.toLowerCase()} text size to ${
        Math.round(Number(payload.fontSize))}`,
      change: change(`${bulk ? 'Caption' : name} text size`,
        Math.round(Number(bulk ? captions.fontSize : props.fontSize)),
        Math.round(Number(payload.fontSize))) };
    case 'SET_TEXT_WEIGHT':
      return { line: `Set ${bulk ? 'caption' : name.toLowerCase()} weight to ${payload.fontWeight}`,
        change: change(`${bulk ? 'Caption' : name} weight`, props.fontWeight ?? '-',
          payload.fontWeight) };
    case 'SET_TEXT_COLOR':
      return { line: `Colour ${bulk ? 'the captions' : name.toLowerCase()} ${payload.color}`,
        change: change(`${bulk ? 'Caption' : name} colour`, props.color ?? '-', payload.color) };
    case 'SET_TEXT_FONT':
      return { line: `Use the ${String(payload.fontFamily).split(',')[0]} font for ${
        bulk ? 'the captions' : name.toLowerCase()}` };
    case 'SET_TEXT_ALIGNMENT':
      return { line: `Align ${bulk ? 'the captions' : name.toLowerCase()} ${payload.textAlign}` };
    case 'SET_TEXT_STROKE':
      return { line: `${payload.strokeEnabled === false ? 'Remove the outline from' : 'Outline'} ${
        bulk ? 'the captions' : name.toLowerCase()}` };
    case 'SET_TEXT_SHADOW':
      return { line: `${payload.shadowEnabled === false ? 'Remove the shadow from' : 'Add a shadow to'} ${
        bulk ? 'the captions' : name.toLowerCase()}` };
    case 'SET_TEXT_BACKGROUND':
      return { line: `${payload.backgroundEnabled === false ? 'Remove the background from'
        : 'Put a background behind'} ${bulk ? 'the captions' : name.toLowerCase()}` };
    case 'SET_TEXT_SPACING':
      return { line: `Adjust the letter spacing of ${bulk ? 'the captions' : name.toLowerCase()}` };
    case 'SET_TEXT_CASE':
      return { line: `${payload.uppercase ? 'Show' : 'Stop showing'} ${bulk ? 'the captions'
        : name.toLowerCase()} in capitals` };
    case 'SET_TEXT_STYLE_PRESET':
      return { line: `Restyle ${name.toLowerCase()} with the ${String(payload.textStyleId)
        .toLowerCase().replace('_', ' ')} style`,
      change: change(`${name} style`, String(props.textStyleId ?? 'custom').toLowerCase(),
        String(payload.textStyleId).toLowerCase()) };
    case 'GENERATE_CAPTIONS':
      return { line: captions.count
        ? `Regenerate all captions from the transcript (replaces the ${captions.count} current lines)`
        : 'Add captions from the transcript' };
    case 'REMOVE_CAPTIONS':
      return { line: `Remove all ${captions.count} captions` };
    case 'SET_CAPTIONS_VISIBLE':
      return { line: payload.visible === false ? 'Hide the captions' : 'Show the captions' };
    case 'SET_CAPTION_TEXT':
      return { line: `Change ${name.toLowerCase()} to read ${quote(payload.content)}`,
        change: change('Caption', quote(props.content), quote(payload.content)) };
    case 'SPLIT_CAPTION':
      return { line: `Split ${name.toLowerCase()} at ${seconds(payload.atSec)}` };
    case 'MERGE_CAPTION':
      return { line: `Merge ${name.toLowerCase()} with the ${
        String(payload.direction ?? 'NEXT').toLowerCase()} caption` };
    case 'SET_CAPTION_STYLE':
      return { line: `Use the ${String(payload.captionStyleId).toLowerCase().replace('_', ' ')
      } caption style`,
      change: change('Caption style', String(captions.styleId ?? 'custom').toLowerCase(),
        String(payload.captionStyleId).toLowerCase()) };
    case 'APPLY_CAPTION_STYLE_TO_ALL':
      return { line: `Apply that caption style to all ${captions.count} captions` };
    case 'SET_CAPTION_ACTIVE_WORD':
      return { line: payload.activeWordEnabled === false
        ? `Turn off the spoken-word highlight`
        : `Highlight each spoken word in ${String(payload.activeWordColor ?? 'colour')}`,
      change: change('Spoken-word highlight', captions.activeWordOn ? 'on' : 'off',
        payload.activeWordEnabled === false ? 'off' : String(payload.activeWordColor ?? 'on')) };
    case 'RESET_VIDEO_ADJUSTMENTS':
      return { line: `Reset the colour of ${scope}` };
    case 'APPLY_COLOR_FILTER':
      return { line: `Apply the ${String(payload.filterId).toLowerCase().replace(/_/gu, ' ')
      } look to ${scope}`,
      change: change(fanOut > 1 ? 'Look (video)' : `Look (${name})`,
        String(props.colorFilter ?? 'none').toLowerCase().replace(/_/gu, ' '),
        String(payload.filterId).toLowerCase().replace(/_/gu, ' ')) };
    case 'SET_VIDEO_CROP': {
      const crop = (props.crop ?? {}) as Record<string, number>;
      const kept = (l: number, r: number, t: number, b: number) =>
        `${Math.round((1 - l - r) * 100)}% × ${Math.round((1 - t - b) * 100)}% of the frame`;
      return { line: `Crop ${scope} to ${kept(Number(payload.cropLeft ?? 0),
        Number(payload.cropRight ?? 0), Number(payload.cropTop ?? 0),
        Number(payload.cropBottom ?? 0))}`,
      change: change(fanOut > 1 ? 'Crop (video)' : `Crop (${name})`,
        kept(crop.left ?? 0, crop.right ?? 0, crop.top ?? 0, crop.bottom ?? 0),
        kept(Number(payload.cropLeft ?? 0), Number(payload.cropRight ?? 0),
          Number(payload.cropTop ?? 0), Number(payload.cropBottom ?? 0))) };
    }
    case 'SET_VIDEO_ROTATION':
      return { line: `Rotate ${scope} to ${Number(payload.rotation).toFixed(1)}°`,
        change: change(fanOut > 1 ? 'Rotation (video)' : `Rotation (${name})`,
          `${Number(props.rotation ?? 0).toFixed(1)}°`, `${Number(payload.rotation).toFixed(1)}°`) };
    case 'SET_VIDEO_FLIP':
      return { line: `Flip ${scope}${payload.flipH ? ' horizontally' : ''}${
        payload.flipV ? ' vertically' : ''}${!payload.flipH && !payload.flipV ? ' back' : ''}` };
    case 'SET_VIDEO_SCALE':
      return { line: `Scale ${scope} to ${Math.round(Number(payload.scale) * 100)}%`,
        change: change(fanOut > 1 ? 'Scale (video)' : `Scale (${name})`,
          `${Math.round(Number(props.scale ?? 1) * 100)}%`,
          `${Math.round(Number(payload.scale) * 100)}%`) };
    case 'SET_VIDEO_POSITION':
      return { line: `Reposition ${scope}` ,
        change: change(`Position (${name})`, `${signed(props.offsetX ?? 0)}, ${signed(props.offsetY ?? 0)}`,
          `${signed(payload.x)}, ${signed(payload.y)}`) };
    case 'SET_SPEED':
      return { line: `Play ${scope} at ${Number(payload.speed)}x`,
        change: change(fanOut > 1 ? 'Speed (video)' : `Speed (${name})`,
          `${Number(props.speed ?? 1)}x`, `${Number(payload.speed)}x`) };
    case 'DUPLICATE_ELEMENT':
      return { line: `Duplicate ${name.toLowerCase()}` };
    case 'REMOVE_ELEMENT':
      return { line: `Remove ${name.toLowerCase()}` };
    case 'SET_AUDIO_VOLUME':
      return { line: `Set ${name.toLowerCase()} volume to ${percent(payload.volume)}`,
        change: change(`${name} volume`, percent(props.volume), percent(payload.volume)) };
    case 'SET_AUDIO_MUTED':
      return { line: payload.muted === true ? `Mute ${name.toLowerCase()}`
        : `Unmute ${name.toLowerCase()}` };
    case 'SET_AUDIO_FADE':
      return { line: `Fade ${name.toLowerCase()} in over ${seconds(payload.fadeInSec)} and out over ${
        seconds(payload.fadeOutSec)}`,
      change: change(`${name} fades`, `in ${seconds(props.fadeInSec ?? 0)}, out ${
        seconds(props.fadeOutSec ?? 0)}`,
      `in ${seconds(payload.fadeInSec)}, out ${seconds(payload.fadeOutSec)}`) };
    case 'SET_AUDIO_TRIM':
      return { line: `Use ${seconds(payload.trimStart)}–${seconds(payload.trimEnd)} of ${
        name.toLowerCase()}` };
    case 'SET_AUDIO_DUCKING':
      return { line: payload.duckEnabled === false ? `Stop lowering ${name.toLowerCase()} under speech`
        : `Lower ${name.toLowerCase()} automatically while someone is speaking`,
      change: change(`${name} ducking`, props.duckEnabled ? 'on' : 'off',
        payload.duckEnabled === false ? 'off' : 'on') };
    case 'SET_SOURCE_AUDIO_VOLUME':
      return { line: `Set the original sound to ${percent(payload.volume)}`,
        change: change('Original sound', percent(context.tracks.sourceAudio.volume),
          percent(payload.volume)) };
    case 'SET_SOURCE_AUDIO_MUTED':
      return { line: payload.muted === true ? 'Mute the original sound'
        : 'Unmute the original sound' };
    case 'ADD_ZOOM':
      if (payload.claimsMoment && payload.enabled === false) {
        return { line: `Remove ${name.toLowerCase()}` };
      }
      if (payload.claimsMoment) {
        return { line: `Change ${name.toLowerCase()} to ${Number(payload.scale).toFixed(2)}x`,
          change: change(name, `${Number(props.scale ?? 1).toFixed(2)}x`,
            `${Number(payload.scale).toFixed(2)}x`) };
      }
      return { line: `Zoom in to ${Number(payload.scale).toFixed(2)}x from ${
        seconds(payload.startTime)} to ${seconds(Number(payload.startTime) +
        Number(payload.duration))}` };
    case 'SET_ZOOM_SCALE':
      return { line: `Change ${name.toLowerCase()} to ${Number(payload.scale).toFixed(2)}x`,
        change: change(name, `${Number(props.scale ?? 1).toFixed(2)}x`,
          `${Number(payload.scale).toFixed(2)}x`) };
    case 'REMOVE_ZOOM':
      return { line: `Remove ${name.toLowerCase()}` };
    default:
      return { line: `Update ${name.toLowerCase()}` };
  }
}
