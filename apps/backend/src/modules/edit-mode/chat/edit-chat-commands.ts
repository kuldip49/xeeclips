// The closed vocabulary an AI chat turn is allowed to produce.
//
// The planner - LLM or deterministic - never writes EditElement rows, never
// patches settings and never emits FFmpeg. It emits this union, the union is
// validated here, and the canonical EditMode layer executes each command
// through exactly the same element mutation and validation path the manual
// editor and the preset planner use.
//
// Targets are LOGICAL handles, not database ids. The model is never asked to
// invent a UUID: it says "text:hook" or "logo:main" or "the selected element",
// and the backend resolver turns that into a real EditElement id against the
// live project. An unresolvable handle is a rejected command, not a guess.
//
// Workstream G widened the vocabulary from the Phase 3 overlay set to every
// manual primitive Workstreams B-F built (transform, text, captions, colour,
// audio, zoom), and REMOVED `SET_HOOK`: it wrote `settings.hookText`, which
// nothing renders, so "change the hook" used to be accepted and then change
// nothing on screen. The hook is a TEXT element and is edited as one.

import { BadRequestException } from '@nestjs/common';
import type { StrictJsonSchema } from '../../processing/llm-provider.service';
import {
  EDIT_ASPECT_RATIOS, GRADING_POLICIES, REFRAME_POLICIES, SUBTITLE_POLICIES, ZOOM_POLICIES,
  type EditProjectStyle
} from '../presets/edit-preset-policy';

/** Element actions. Every one of these already exists in the manual editor. */
export const CHAT_ELEMENT_ACTIONS = [
  // Video timeline
  'TRIM_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT', 'REORDER_ELEMENT',
  // Video transform (Workstream B)
  'SET_VIDEO_CROP', 'SET_VIDEO_ROTATION', 'SET_VIDEO_FLIP', 'SET_VIDEO_SCALE',
  'SET_VIDEO_POSITION', 'SET_SPEED',
  // Overlays
  'ADD_IMAGE', 'ADD_LOGO', 'ADD_TEXT', 'ADD_AUDIO', 'MOVE_ELEMENT', 'RESIZE_ELEMENT',
  'SET_ELEMENT_TIMING', 'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'UPDATE_TEXT',
  'DUPLICATE_ELEMENT', 'REMOVE_ELEMENT', 'SET_ELEMENT_VISIBLE', 'SET_ELEMENT_LOCKED',
  // Text (Workstream C)
  'SET_TEXT_CONTENT', 'SET_TEXT_FONT', 'SET_TEXT_SIZE', 'SET_TEXT_WEIGHT', 'SET_TEXT_COLOR',
  'SET_TEXT_ALIGNMENT', 'SET_TEXT_STROKE', 'SET_TEXT_SHADOW', 'SET_TEXT_BACKGROUND',
  'SET_TEXT_SPACING', 'SET_TEXT_STYLE_PRESET', 'SET_TEXT_CASE',
  // Captions (Workstream C)
  'GENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SET_CAPTIONS_VISIBLE', 'SET_CAPTION_TEXT',
  'SPLIT_CAPTION', 'MERGE_CAPTION', 'SET_CAPTION_STYLE', 'SET_CAPTION_ACTIVE_WORD',
  'APPLY_CAPTION_STYLE_TO_ALL',
  // Colour (Workstream D)
  'SET_VIDEO_EXPOSURE', 'SET_VIDEO_BRIGHTNESS', 'SET_VIDEO_CONTRAST', 'SET_VIDEO_HIGHLIGHTS',
  'SET_VIDEO_SHADOWS', 'SET_VIDEO_SATURATION', 'SET_VIDEO_TEMPERATURE', 'SET_VIDEO_TINT',
  'SET_VIDEO_SHARPNESS', 'SET_VIDEO_FADE', 'SET_VIDEO_VIGNETTE', 'RESET_VIDEO_ADJUSTMENTS',
  'APPLY_COLOR_FILTER',
  // Audio (Workstream D)
  'SET_AUDIO_VOLUME', 'SET_AUDIO_MUTED', 'SET_AUDIO_FADE', 'SET_AUDIO_TRIM', 'SET_AUDIO_DUCKING',
  'SET_SOURCE_AUDIO_VOLUME', 'SET_SOURCE_AUDIO_MUTED',
  // Zoom (Workstream G)
  'ADD_ZOOM', 'SET_ZOOM_SCALE', 'REMOVE_ZOOM'
] as const;
export type ChatElementAction = typeof CHAT_ELEMENT_ACTIONS[number];

/** Project style actions. Each sets typed fields of the settings style block.
 *  SET_HOOK is deliberately absent - see the file header. */
export const CHAT_SETTINGS_ACTIONS = ['SET_PROJECT_STYLE', 'SET_ASPECT_RATIO',
  'SET_SUBTITLE_POLICY', 'SET_AUTO_REFRAME', 'SET_AUTO_ZOOM', 'SET_COLOR_GRADE'] as const;
export type ChatSettingsAction = typeof CHAT_SETTINGS_ACTIONS[number];

/** Actions that remove or shorten material. Held to a higher grounding bar. */
export const DESTRUCTIVE_CHAT_ACTIONS = new Set<ChatElementAction>([
  'TRIM_ELEMENT', 'DELETE_ELEMENT', 'REMOVE_ELEMENT', 'SPLIT_ELEMENT', 'REMOVE_CAPTIONS'
]);

/** Actions that act on a whole track and need no target at all. */
export const TARGETLESS_CHAT_ACTIONS = new Set<ChatElementAction>([
  'GENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SET_CAPTIONS_VISIBLE', 'SET_SOURCE_AUDIO_VOLUME',
  'SET_SOURCE_AUDIO_MUTED', 'ADD_ZOOM'
]);

/**
 * How a command names the element it acts on.
 *
 * SELECTED   - whatever the user has selected in the editor right now.
 * LAST       - the element the previous chat turn created or changed.
 * REF        - an element created earlier in THIS plan, by planner-local handle.
 * ROLE       - the single element playing a role ("the logo", "the hook").
 * AT_TIME    - the video segment covering a timeline second.
 * ELEMENT    - an opaque handle taken from the context the backend supplied,
 *              including the whole-track handles captions:all / video:all /
 *              audio:source.
 */
export const CHAT_TARGET_KINDS = ['SELECTED', 'LAST', 'REF', 'ROLE', 'AT_TIME', 'ELEMENT'] as const;
export type ChatTargetKind = typeof CHAT_TARGET_KINDS[number];

/** Roles a ROLE target may name. These map to element type + metadata, not ids. */
export const CHAT_TARGET_ROLES = ['LOGO', 'IMAGE', 'TEXT', 'MUSIC', 'SUBTITLE', 'VIDEO',
  'HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'ZOOM'] as const;
export type ChatTargetRole = typeof CHAT_TARGET_ROLES[number];

export type ChatTarget = {
  kind: ChatTargetKind;
  /** REF: a handle this same plan created. */
  ref?: string;
  /** ROLE: which role to look for. */
  role?: ChatTargetRole;
  /** AT_TIME: seconds on the edited timeline. */
  atSec?: number;
  /** ELEMENT: a handle from the supplied context, never a raw UUID. */
  handle?: string;
};

export type ChatElementCommand = {
  kind: 'ELEMENT';
  action: ChatElementAction;
  target?: ChatTarget;
  /** Planner-local handle for an element this command creates. */
  ref?: string;
  /** An asset handle from the supplied asset catalogue, for ADD_IMAGE/LOGO/AUDIO. */
  assetHandle?: string;
  parameters: Record<string, unknown>;
  reason: string;
};

export type ChatSettingsCommand = {
  kind: 'SETTINGS';
  action: ChatSettingsAction;
  parameters: Partial<EditProjectStyle>;
  reason: string;
};

export type ChatCommand = ChatElementCommand | ChatSettingsCommand;

export const CHAT_GROUNDING_TYPES = ['TRANSCRIPT', 'SELECTION', 'ASSET', 'ANALYSIS',
  'PLAYHEAD', 'TIMESTAMP', 'CONTEXT'] as const;
export type ChatGroundingType = typeof CHAT_GROUNDING_TYPES[number];

export type ChatGrounding = {
  type: ChatGroundingType;
  confidence: number;
  evidence: string;
  /** Resolved timeline seconds, when the grounding produced a range. */
  startSec?: number;
  endSec?: number;
};

/** The complete, validated planner output for one chat turn. */
export type ChatIntent = {
  intent: 'EDIT_PROJECT' | 'NEEDS_CLARIFICATION' | 'UNSUPPORTED';
  summary: string;
  commands: ChatCommand[];
  grounding: ChatGrounding[];
  warnings: string[];
  needsClarification: boolean;
  clarificationQuestion: string;
  /**
   * History travel rather than an edit. Only the deterministic planner ever
   * sets this - it is absent from CHAT_INTENT_SCHEMA and `validateChatIntent`
   * never produces it, so a model cannot ask for an undo it did not witness.
   */
  historyAction?: 'UNDO' | 'REDO';
};

// --- Confidence policy ------------------------------------------------------

/** Below this, nothing is proposed: the user is asked to clarify instead. */
export const CHAT_MIN_CONFIDENCE = 0.45;
/** Cosmetic, easily reversed commands may proceed from here up. */
export const CHAT_SAFE_CONFIDENCE = 0.6;
/** Destructive commands need this much before they may be proposed at all. */
export const CHAT_DESTRUCTIVE_CONFIDENCE = 0.75;

/** Hard cap on a model plan. Part 19: a normal turn is a few direct intents,
 *  and a whole-project brief is a different feature. */
export const CHAT_MAX_MODEL_COMMANDS = 8;

/**
 * The bar a command must clear, given how much damage it can do.
 *
 * Destructive edits are still proposal-first like everything else, but a weakly
 * grounded cut is worse than a weakly grounded opacity change, so it takes more
 * evidence before it is even offered.
 */
export const requiredConfidenceFor = (command: ChatCommand): number =>
  command.kind === 'ELEMENT' && DESTRUCTIVE_CHAT_ACTIONS.has(command.action)
    ? CHAT_DESTRUCTIVE_CONFIDENCE : CHAT_SAFE_CONFIDENCE;

// --- Validation -------------------------------------------------------------

const reject = (message: string, code = 'INVALID_CHAT_COMMAND'): never => {
  throw new BadRequestException({ code, message });
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

const boundedString = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : '';

/** Opaque handles: "text:hook", "caption:42", "asset:logo1". Never a UUID. */
const HANDLE_PATTERN = /^[a-z][a-z0-9_]{0,31}(?::[a-z0-9_]{1,32})?$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-/iu;

const SETTINGS_FIELDS: Record<ChatSettingsAction, readonly (keyof EditProjectStyle)[]> = {
  SET_PROJECT_STYLE: ['aspectRatio', 'subtitlePolicy', 'zoomPolicy', 'reframePolicy',
    'gradingPolicy', 'textPolicy', 'overlayPolicy', 'musicPolicy',
    'informationRegionPolicy', 'pacing'],
  SET_ASPECT_RATIO: ['aspectRatio'],
  SET_SUBTITLE_POLICY: ['subtitlePolicy'],
  SET_AUTO_REFRAME: ['reframePolicy'],
  SET_AUTO_ZOOM: ['zoomPolicy'],
  SET_COLOR_GRADE: ['gradingPolicy']
};

const SETTINGS_ENUMS: Partial<Record<keyof EditProjectStyle, readonly string[]>> = {
  aspectRatio: EDIT_ASPECT_RATIOS, subtitlePolicy: SUBTITLE_POLICIES,
  zoomPolicy: ZOOM_POLICIES, reframePolicy: REFRAME_POLICIES, gradingPolicy: GRADING_POLICIES
};

/**
 * Parameter keys a chat command may carry, by value type. Anything else is
 * dropped, so a model cannot smuggle a field the manual editor would never
 * accept. The VALUES are bounds-checked by the canonical layer, which is the
 * same code the inspector reaches - this list only closes the vocabulary.
 */
export const CHAT_NUMBER_PARAMETERS = ['trimStart', 'trimEnd', 'playheadSec', 'toPosition',
  'startTime', 'duration', 'x', 'y', 'width', 'height', 'opacity', 'zIndex', 'fontSize',
  'fontWeight', 'volume', 'fadeInSec', 'fadeOutSec', 'rotation', 'scale', 'speed',
  'cropLeft', 'cropRight', 'cropTop', 'cropBottom', 'strokeWidth', 'shadowOpacity',
  'shadowBlur', 'backgroundOpacity', 'backgroundPadding', 'letterSpacing', 'lineSpacing',
  'atSec', 'exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'saturation',
  'temperature', 'tint', 'sharpness', 'fade', 'vignette', 'strength'] as const;
export const CHAT_STRING_PARAMETERS = ['content', 'fontFamily', 'textAlign', 'color',
  'backgroundColor', 'strokeColor', 'shadowColor', 'activeWordColor', 'textStyleId',
  'captionStyleId', 'direction', 'filterId', 'duckStrength', 'triggerText',
  'semanticRole'] as const;
export const CHAT_BOOLEAN_PARAMETERS = ['muted', 'flipH', 'flipV', 'strokeEnabled',
  'shadowEnabled', 'backgroundEnabled', 'uppercase', 'activeWordEnabled', 'visible',
  'duckEnabled', 'applyBox', 'locked'] as const;
const PARAMETER_TYPES = new Map<string, 'number' | 'string' | 'boolean'>([
  ...CHAT_NUMBER_PARAMETERS.map((key) => [key, 'number'] as const),
  ...CHAT_STRING_PARAMETERS.map((key) => [key, 'string'] as const),
  ...CHAT_BOOLEAN_PARAMETERS.map((key) => [key, 'boolean'] as const)
]);
/** Style fields a SETTINGS command may carry in the model's parameter list. */
const STYLE_PARAMETERS = ['aspectRatio', 'subtitlePolicy', 'zoomPolicy', 'reframePolicy',
  'gradingPolicy', 'textPolicy', 'overlayPolicy', 'musicPolicy', 'informationRegionPolicy',
  'pacing'] as const;

/** Text roles a created TEXT element may carry (stored as presetRole). */
export const CHAT_TEXT_ROLES = ['HOOK', 'CTA'] as const;

/**
 * Parameters arrive either as a plain object (the deterministic planner, tests)
 * or as the model's closed list of {name, number, text, flag} entries. Both end
 * up as the same typed object.
 */
function readParameters(raw: unknown): Record<string, unknown> {
  if (!Array.isArray(raw)) return asRecord(raw);
  const out: Record<string, unknown> = {};
  for (const item of raw.slice(0, 24)) {
    const entry = asRecord(item);
    const name = String(entry.name ?? '');
    const type = PARAMETER_TYPES.get(name) ??
      ((STYLE_PARAMETERS as readonly string[]).includes(name) ? 'string' : undefined);
    if (!type) continue;
    const value = type === 'number' ? entry.number : type === 'string' ? entry.text : entry.flag;
    if (value !== null && value !== undefined) out[name] = value;
  }
  return out;
}

const validateTarget = (value: unknown): ChatTarget | undefined => {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  const kind = String(record.kind ?? '');
  if (!(CHAT_TARGET_KINDS as readonly string[]).includes(kind)) {
    reject(`Unsupported target kind "${kind}"`);
  }
  const target: ChatTarget = { kind: kind as ChatTargetKind };
  if (kind === 'REF') {
    if (!HANDLE_PATTERN.test(String(record.ref ?? ''))) reject('REF target needs a plan-local ref');
    target.ref = String(record.ref);
  }
  if (kind === 'ROLE') {
    const role = String(record.role ?? '');
    if (!(CHAT_TARGET_ROLES as readonly string[]).includes(role)) {
      reject(`Unsupported target role "${role}"`);
    }
    target.role = role as ChatTargetRole;
  }
  if (kind === 'AT_TIME') {
    const atSec = Number(record.atSec);
    if (!Number.isFinite(atSec) || atSec < 0) reject('AT_TIME target needs a non-negative atSec');
    target.atSec = atSec;
  }
  if (kind === 'ELEMENT') {
    const handle = String(record.handle ?? '');
    // A raw database id is refused by name, not just by pattern: it is the one
    // thing the model must never be able to address directly.
    if (UUID_PATTERN.test(handle)) {
      reject('Elements are addressed by context handle, never by database id', 'RAW_ID_REJECTED');
    }
    if (!HANDLE_PATTERN.test(handle)) {
      reject('ELEMENT target needs an element handle from the supplied context', 'UNKNOWN_HANDLE');
    }
    target.handle = handle;
  }
  return target;
};

const validateElementCommand = (record: Record<string, unknown>): ChatElementCommand => {
  const action = String(record.action ?? '').toUpperCase() as ChatElementAction;
  if (!(CHAT_ELEMENT_ACTIONS as readonly string[]).includes(action)) {
    reject(`Unsupported command "${record.action}"`, 'UNSUPPORTED_COMMAND');
  }
  const raw = readParameters(record.parameters);
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const type = PARAMETER_TYPES.get(key);
    if (!type) continue;
    // A strict-schema response sends null for keys it is not setting. Null
    // means "not set", exactly like absent.
    if (value === null || value === undefined) continue;
    if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        reject(`Parameter "${key}" must be a finite number`);
      }
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') reject(`Parameter "${key}" must be true or false`);
    } else {
      if (typeof value !== 'string') reject(`Parameter "${key}" must be text`);
      if (key === 'semanticRole' && !(CHAT_TEXT_ROLES as readonly string[]).includes(value as string)) {
        reject('semanticRole must be HOOK or CTA');
      }
    }
    parameters[key] = typeof value === 'string' ? value.slice(0, 2000) : value;
  }
  const command: ChatElementCommand = { kind: 'ELEMENT', action, parameters,
    reason: boundedString(record.reason, 300) };
  const target = validateTarget(record.target);
  if (target) command.target = target;
  if (record.ref !== undefined && record.ref !== null) {
    if (!HANDLE_PATTERN.test(String(record.ref))) reject('ref is invalid');
    command.ref = String(record.ref);
  }
  if (record.assetHandle !== undefined && record.assetHandle !== null) {
    if (!HANDLE_PATTERN.test(String(record.assetHandle))) reject('assetHandle is invalid');
    command.assetHandle = String(record.assetHandle);
  }
  // Creating commands need an asset (except text); mutating commands need a
  // target, except the ones that act on a whole track.
  const creates = action.startsWith('ADD_');
  if (creates && action !== 'ADD_TEXT' && action !== 'ADD_ZOOM' && !command.assetHandle) {
    reject(`${action} needs an uploaded asset`, 'MISSING_ASSET');
  }
  if (!creates && !TARGETLESS_CHAT_ACTIONS.has(action) && !command.target) {
    reject(`${action} needs a target element`, 'MISSING_TARGET');
  }
  return command;
};

const validateSettingsCommand = (record: Record<string, unknown>): ChatSettingsCommand => {
  const action = String(record.action ?? '').toUpperCase() as ChatSettingsAction;
  if (!(CHAT_SETTINGS_ACTIONS as readonly string[]).includes(action)) {
    reject(`Unsupported command "${record.action}"`, 'UNSUPPORTED_COMMAND');
  }
  const raw = readParameters(record.parameters);
  const parameters: Partial<EditProjectStyle> = {};
  for (const field of SETTINGS_FIELDS[action]) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    const options = SETTINGS_ENUMS[field];
    if (options && !options.includes(String(value))) {
      reject(`${String(field)} must be one of ${options.join(', ')}`);
    }
    (parameters as Record<string, unknown>)[field] = String(value);
  }
  if (!Object.keys(parameters).length) reject(`${action} set no supported field`);
  return { kind: 'SETTINGS', action, parameters, reason: boundedString(record.reason, 300) };
};

const validateGrounding = (value: unknown): ChatGrounding[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((item): ChatGrounding[] => {
    const record = asRecord(item);
    const type = String(record.type ?? '').toUpperCase();
    if (!(CHAT_GROUNDING_TYPES as readonly string[]).includes(type)) return [];
    const confidence = Number(record.confidence);
    const entry: ChatGrounding = {
      type: type as ChatGroundingType,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
      evidence: boundedString(record.evidence, 400)
    };
    // `null` is "no range", and must not become 0 - a grounding that claimed
    // 0s would be a real timestamp the transcript check would then honour.
    if (record.startSec !== null && record.startSec !== undefined &&
      Number.isFinite(Number(record.startSec))) entry.startSec = Number(record.startSec);
    if (record.endSec !== null && record.endSec !== undefined &&
      Number.isFinite(Number(record.endSec))) entry.endSec = Number(record.endSec);
    return [entry];
  });
};

/**
 * Validates raw planner output into a ChatIntent, or throws.
 *
 * This is the only door into the chat command path. A local model that emits
 * prose, a shell command, an unknown action, a raw id or a malformed target
 * fails here, before anything is resolved and long before anything is written.
 */
export function validateChatIntent(value: unknown, options: { maxCommands?: number } = {}):
  ChatIntent {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    reject('The planner returned no usable output', 'MALFORMED_PLAN');
  }
  const declared = String(record.intent ?? 'EDIT_PROJECT').toUpperCase();
  const intent = declared === 'NEEDS_CLARIFICATION' || declared === 'UNSUPPORTED'
    ? declared as ChatIntent['intent'] : 'EDIT_PROJECT';
  const rawCommands = Array.isArray(record.commands) ? record.commands : [];
  const maxCommands = options.maxCommands ?? 12;
  if (rawCommands.length > maxCommands) {
    reject(`A single chat turn may plan at most ${maxCommands} commands`, 'PLAN_TOO_LARGE');
  }
  const commands = rawCommands.map((item) => {
    const entry = asRecord(item);
    const action = String(entry.action ?? '').toUpperCase();
    return (CHAT_SETTINGS_ACTIONS as readonly string[]).includes(action)
      ? validateSettingsCommand(entry) : validateElementCommand(entry);
  });

  const needsClarification = record.needsClarification === true || intent === 'NEEDS_CLARIFICATION';
  const clarificationQuestion = boundedString(record.clarificationQuestion, 300);
  if (needsClarification && !clarificationQuestion) {
    reject('A clarification request must include a question', 'MISSING_CLARIFICATION');
  }
  if (!needsClarification && intent === 'EDIT_PROJECT' && !commands.length) {
    reject('The planner proposed no commands and asked no question', 'EMPTY_PLAN');
  }
  // A plan-local ref must be created before it is used.
  const created = new Set<string>();
  for (const command of commands) {
    if (command.kind !== 'ELEMENT') continue;
    if (command.target?.kind === 'REF' && !created.has(command.target.ref!)) {
      reject(`The plan references "${command.target.ref}" before creating it`, 'UNKNOWN_REF');
    }
    if (command.ref) created.add(command.ref);
  }

  return {
    intent: needsClarification ? 'NEEDS_CLARIFICATION' : intent,
    summary: boundedString(record.summary, 400),
    commands,
    grounding: validateGrounding(record.grounding),
    warnings: (Array.isArray(record.warnings) ? record.warnings : [])
      .slice(0, 8).map((item) => boundedString(item, 300)).filter(Boolean),
    needsClarification,
    clarificationQuestion
  };
}

/**
 * The strict schema the ONLINE structured-generation route enforces.
 *
 * Shaped for OpenAI-style STRICT structured outputs: every object sets
 * `additionalProperties: false` and lists every property as required, so an
 * optional field is a NULLABLE required field. The Phase 7 soak is what forced
 * that - the provider rejected the Phase 6 shape with HTTP 400.
 *
 * Workstream G changes one thing on purpose. Parameters are no longer an object
 * that repeats all ~70 keys on every command - that grew each command to
 * hundreds of tokens and was already truncating at Phase 7 sizes. They are a
 * short list of {name, number, text, flag} entries whose `name` is a closed
 * enum. It is still strict, still closed (an unknown name cannot be emitted),
 * and it only carries the parameters a command actually sets.
 */
const nullable = (type: string) => ({ type: [type, 'null'] });

export const CHAT_INTENT_SCHEMA: StrictJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'summary', 'commands', 'grounding', 'warnings',
    'needsClarification', 'clarificationQuestion'],
  properties: {
    intent: { type: 'string', enum: ['EDIT_PROJECT', 'NEEDS_CLARIFICATION', 'UNSUPPORTED'] },
    summary: { type: 'string' },
    commands: {
      type: 'array', maxItems: CHAT_MAX_MODEL_COMMANDS,
      items: {
        type: 'object', additionalProperties: false,
        required: ['action', 'parameters', 'reason', 'ref', 'assetHandle', 'target'],
        properties: {
          action: { type: 'string',
            enum: [...CHAT_ELEMENT_ACTIONS, ...CHAT_SETTINGS_ACTIONS] as unknown as string[] },
          reason: { type: 'string' },
          ref: nullable('string'),
          assetHandle: nullable('string'),
          target: {
            type: ['object', 'null'], additionalProperties: false,
            required: ['kind', 'ref', 'role', 'atSec', 'handle'],
            properties: {
              kind: { type: 'string', enum: [...CHAT_TARGET_KINDS] as unknown as string[] },
              ref: nullable('string'),
              role: { type: ['string', 'null'],
                enum: [...CHAT_TARGET_ROLES, null] as unknown as string[] },
              atSec: nullable('number'),
              handle: nullable('string')
            }
          },
          parameters: {
            type: 'array', maxItems: 16,
            items: {
              type: 'object', additionalProperties: false,
              required: ['name', 'number', 'text', 'flag'],
              properties: {
                name: { type: 'string', enum: [...CHAT_NUMBER_PARAMETERS,
                  ...CHAT_STRING_PARAMETERS, ...CHAT_BOOLEAN_PARAMETERS,
                  ...STYLE_PARAMETERS] as unknown as string[] },
                number: nullable('number'),
                text: nullable('string'),
                flag: nullable('boolean')
              }
            }
          }
        }
      }
    },
    grounding: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'confidence', 'evidence', 'startSec', 'endSec'],
        properties: {
          type: { type: 'string', enum: [...CHAT_GROUNDING_TYPES] as unknown as string[] },
          confidence: { type: 'number' },
          evidence: { type: 'string' },
          startSec: nullable('number'),
          endSec: nullable('number')
        }
      }
    },
    warnings: { type: 'array', maxItems: 8, items: { type: 'string' } },
    needsClarification: { type: 'boolean' },
    clarificationQuestion: { type: 'string' }
  }
};

/** The strict schema for one creative hook request. */
export const CHAT_HOOK_SCHEMA: StrictJsonSchema = {
  type: 'object', additionalProperties: false, required: ['candidates'],
  properties: {
    candidates: {
      type: 'array', maxItems: 5,
      items: {
        type: 'object', additionalProperties: false, required: ['text'],
        properties: { text: { type: 'string' } }
      }
    }
  }
};
