// The closed vocabulary an AI chat turn is allowed to produce.
//
// The planner - LLM or deterministic - never writes EditElement rows, never
// patches settings and never emits FFmpeg. It emits this union, the union is
// validated here, and the canonical EditMode layer executes each command
// through exactly the same element mutation and validation path the manual
// editor and the preset planner use.
//
// Targets are LOGICAL handles, not database ids. The model is never asked to
// invent a UUID: it says "the selected element" or "the logo" or "the text I
// just added", and the backend resolver turns that into a real EditElement id
// against the live project. An unresolvable handle is a rejected command, not
// a guess.

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
  // Overlays
  'ADD_IMAGE', 'ADD_LOGO', 'ADD_TEXT', 'ADD_AUDIO', 'MOVE_ELEMENT', 'RESIZE_ELEMENT',
  'SET_ELEMENT_TIMING', 'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'UPDATE_TEXT',
  'DUPLICATE_ELEMENT', 'REMOVE_ELEMENT',
  // Audio
  'SET_AUDIO_VOLUME', 'SET_AUDIO_MUTED', 'SET_AUDIO_FADE'
] as const;
export type ChatElementAction = typeof CHAT_ELEMENT_ACTIONS[number];

/** Project style actions. Each sets typed fields of the settings style block. */
export const CHAT_SETTINGS_ACTIONS = ['SET_PROJECT_STYLE', 'SET_ASPECT_RATIO',
  'SET_SUBTITLE_POLICY', 'SET_AUTO_REFRAME', 'SET_AUTO_ZOOM', 'SET_COLOR_GRADE',
  'SET_HOOK'] as const;
export type ChatSettingsAction = typeof CHAT_SETTINGS_ACTIONS[number];

/** Actions that remove or shorten material. Held to a higher grounding bar. */
export const DESTRUCTIVE_CHAT_ACTIONS = new Set<ChatElementAction>([
  'TRIM_ELEMENT', 'DELETE_ELEMENT', 'REMOVE_ELEMENT', 'SPLIT_ELEMENT'
]);

/**
 * How a command names the element it acts on.
 *
 * SELECTED   - whatever the user has selected in the editor right now.
 * LAST       - the element the previous chat turn created or changed.
 * REF        - an element created earlier in THIS plan, by planner-local handle.
 * ROLE       - the single element playing a role ("the logo", "the music").
 * AT_TIME    - the video segment covering a timeline second.
 * ELEMENT    - an element handle taken from the context the backend supplied.
 */
export const CHAT_TARGET_KINDS = ['SELECTED', 'LAST', 'REF', 'ROLE', 'AT_TIME', 'ELEMENT'] as const;
export type ChatTargetKind = typeof CHAT_TARGET_KINDS[number];

/** Roles a ROLE target may name. These map to element type + properties, not ids. */
export const CHAT_TARGET_ROLES = ['LOGO', 'IMAGE', 'TEXT', 'MUSIC', 'SUBTITLE', 'VIDEO'] as const;
export type ChatTargetRole = typeof CHAT_TARGET_ROLES[number];

export type ChatTarget = {
  kind: ChatTargetKind;
  /** REF: a handle this same plan created. */
  ref?: string;
  /** ROLE: which role to look for. */
  role?: ChatTargetRole;
  /** AT_TIME: seconds on the edited timeline. */
  atSec?: number;
  /** ELEMENT: an `elementHandle` from the supplied context, never a raw UUID. */
  handle?: string;
};

export type ChatElementCommand = {
  kind: 'ELEMENT';
  action: ChatElementAction;
  target?: ChatTarget;
  /** Planner-local handle for an element this command creates. */
  ref?: string;
  /** An `assetHandle` from the supplied asset catalogue, for ADD_IMAGE/LOGO/AUDIO. */
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

const HANDLE_PATTERN = /^[a-z0-9_-]{1,64}$/iu;

const SETTINGS_FIELDS: Record<ChatSettingsAction, readonly (keyof EditProjectStyle)[]> = {
  SET_PROJECT_STYLE: ['aspectRatio', 'subtitlePolicy', 'zoomPolicy', 'reframePolicy',
    'gradingPolicy', 'hookPolicy', 'textPolicy', 'overlayPolicy', 'musicPolicy',
    'informationRegionPolicy', 'pacing'],
  SET_ASPECT_RATIO: ['aspectRatio'],
  SET_SUBTITLE_POLICY: ['subtitlePolicy'],
  SET_AUTO_REFRAME: ['reframePolicy'],
  SET_AUTO_ZOOM: ['zoomPolicy'],
  SET_COLOR_GRADE: ['gradingPolicy'],
  SET_HOOK: ['hookText', 'hookPolicy']
};

const SETTINGS_ENUMS: Partial<Record<keyof EditProjectStyle, readonly string[]>> = {
  aspectRatio: EDIT_ASPECT_RATIOS, subtitlePolicy: SUBTITLE_POLICIES,
  zoomPolicy: ZOOM_POLICIES, reframePolicy: REFRAME_POLICIES, gradingPolicy: GRADING_POLICIES
};

/** Parameter keys a chat command may carry. Anything else is dropped, so a
 * model cannot smuggle a field the manual editor would never accept. */
const ALLOWED_PARAMETERS = new Set(['trimStart', 'trimEnd', 'playheadSec', 'toPosition',
  'startTime', 'duration', 'x', 'y', 'width', 'height', 'opacity', 'zIndex', 'content',
  'fontSize', 'fontWeight', 'fontFamily', 'textAlign', 'color', 'backgroundColor',
  'volume', 'muted', 'fadeInSec', 'fadeOutSec']);

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
    if (!HANDLE_PATTERN.test(String(record.handle ?? ''))) {
      reject('ELEMENT target needs an element handle from the supplied context');
    }
    target.handle = String(record.handle);
  }
  return target;
};

const validateElementCommand = (record: Record<string, unknown>): ChatElementCommand => {
  const action = String(record.action ?? '').toUpperCase() as ChatElementAction;
  if (!(CHAT_ELEMENT_ACTIONS as readonly string[]).includes(action)) {
    reject(`Unsupported command "${record.action}"`, 'UNSUPPORTED_COMMAND');
  }
  const raw = asRecord(record.parameters);
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ALLOWED_PARAMETERS.has(key)) continue;
    // A strict-schema response sends every parameter key, with null for the
    // ones it is not setting. Null means "not set", exactly like absent.
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) {
      reject(`Parameter "${key}" must be a finite number`);
    }
    parameters[key] = value;
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
  // Creating commands need an asset (except text); mutating commands need a target.
  const creates = action.startsWith('ADD_');
  if (creates && action !== 'ADD_TEXT' && !command.assetHandle) {
    reject(`${action} needs an uploaded asset`, 'MISSING_ASSET');
  }
  if (!creates && !command.target) {
    reject(`${action} needs a target element`, 'MISSING_TARGET');
  }
  return command;
};

const validateSettingsCommand = (record: Record<string, unknown>): ChatSettingsCommand => {
  const action = String(record.action ?? '').toUpperCase() as ChatSettingsAction;
  if (!(CHAT_SETTINGS_ACTIONS as readonly string[]).includes(action)) {
    reject(`Unsupported command "${record.action}"`, 'UNSUPPORTED_COMMAND');
  }
  const raw = asRecord(record.parameters);
  const parameters: Partial<EditProjectStyle> = {};
  for (const field of SETTINGS_FIELDS[action]) {
    const value = raw[field];
    if (value === undefined) continue;
    if (value === null && field !== 'hookText') continue;
    if (field === 'hookText') {
      if (value !== null && typeof value !== 'string') reject('hookText must be a string or null');
      parameters.hookText = value === null ? null : String(value).slice(0, 200);
      continue;
    }
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
 * prose, a shell command, an unknown action or a malformed target fails here,
 * before anything is resolved and long before anything is written.
 */
export function validateChatIntent(value: unknown): ChatIntent {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    reject('The planner returned no usable output', 'MALFORMED_PLAN');
  }
  const declared = String(record.intent ?? 'EDIT_PROJECT').toUpperCase();
  const intent = declared === 'NEEDS_CLARIFICATION' || declared === 'UNSUPPORTED'
    ? declared as ChatIntent['intent'] : 'EDIT_PROJECT';
  const rawCommands = Array.isArray(record.commands) ? record.commands : [];
  if (rawCommands.length > 12) {
    reject('A single chat turn may plan at most 12 commands', 'PLAN_TOO_LARGE');
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
 * The strict schema the ONLINE/OFFLINE structured-generation route enforces.
 *
 * Shaped for OpenAI-style STRICT structured outputs, which are stricter than
 * ordinary JSON Schema in two ways that matter here: every object must set
 * `additionalProperties: false`, and every object's `required` must list every
 * one of its properties. An optional field is therefore expressed as a
 * NULLABLE required field, not as an absent one.
 *
 * The Phase 7 provider soak is what forced this: the Phase 6 shape left `ref`
 * out of the target's `required` and declared `parameters` as an open object,
 * and the provider rejected every request with HTTP 400 before the model ever
 * saw it. `validateChatIntent` treats null and absent identically, so both
 * shapes validate the same way.
 *
 * Declaring the parameter keys explicitly is a bonus: the model is now held to
 * the same allowlist the validator enforces, rather than being free to invent a
 * field that would be silently dropped afterwards.
 */
const NUMBER_PARAMETERS = ['trimStart', 'trimEnd', 'playheadSec', 'toPosition', 'startTime',
  'duration', 'x', 'y', 'width', 'height', 'opacity', 'zIndex', 'fontSize', 'fontWeight',
  'volume', 'fadeInSec', 'fadeOutSec'] as const;
const STRING_PARAMETERS = ['content', 'fontFamily', 'textAlign', 'color',
  'backgroundColor'] as const;
const BOOLEAN_PARAMETERS = ['muted'] as const;
// ELEMENT and SETTINGS commands share one `parameters` object, so the style
// fields have to be declared here too - otherwise a strict response has no
// legal way to express "set the aspect ratio" and every SETTINGS command comes
// back empty. Each is enumerated, so a policy value the editor does not
// support cannot be returned at all.
const STYLE_PARAMETERS = ['aspectRatio', 'subtitlePolicy', 'zoomPolicy', 'reframePolicy',
  'gradingPolicy', 'hookPolicy', 'textPolicy', 'overlayPolicy', 'musicPolicy',
  'informationRegionPolicy', 'pacing', 'hookText'] as const;

const nullable = (type: string) => ({ type: [type, 'null'] });

const nullableEnum = (values: readonly string[]) =>
  ({ type: ['string', 'null'], enum: [...values, null] as unknown as string[] });

const PARAMETERS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [...NUMBER_PARAMETERS, ...STRING_PARAMETERS, ...BOOLEAN_PARAMETERS,
    ...STYLE_PARAMETERS],
  properties: {
    ...Object.fromEntries(NUMBER_PARAMETERS.map((key) => [key, nullable('number')])),
    ...Object.fromEntries(STRING_PARAMETERS.map((key) => [key, nullable('string')])),
    ...Object.fromEntries(BOOLEAN_PARAMETERS.map((key) => [key, nullable('boolean')])),
    aspectRatio: nullableEnum(EDIT_ASPECT_RATIOS),
    subtitlePolicy: nullableEnum(SUBTITLE_POLICIES),
    zoomPolicy: nullableEnum(ZOOM_POLICIES),
    reframePolicy: nullableEnum(REFRAME_POLICIES),
    gradingPolicy: nullableEnum(GRADING_POLICIES),
    hookPolicy: nullable('string'),
    textPolicy: nullable('string'),
    overlayPolicy: nullable('string'),
    musicPolicy: nullable('string'),
    informationRegionPolicy: nullable('string'),
    pacing: nullable('string'),
    hookText: nullable('string')
  }
};

export const CHAT_INTENT_SCHEMA: StrictJsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['intent', 'summary', 'commands', 'grounding', 'warnings',
    'needsClarification', 'clarificationQuestion'],
  properties: {
    intent: { type: 'string', enum: ['EDIT_PROJECT', 'NEEDS_CLARIFICATION', 'UNSUPPORTED'] },
    summary: { type: 'string' },
    commands: {
      type: 'array', maxItems: 12,
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
          parameters: PARAMETERS_SCHEMA
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
