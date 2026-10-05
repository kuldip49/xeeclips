import { BadRequestException } from '@nestjs/common';

// Step 5: canonical edit scope, execution origin and user constraints.
//
// Scope says WHICH canonical elements one command targets. Constraints say what
// an automated task (or, for PROJECT locks, anyone) is NOT allowed to change.
// Both are enforced at the command layer in EditModeService - never only in a
// prompt, a planner or the frontend - so every path (manual editor, template,
// AI bundle, future agent tool) is held to exactly the same rule.

/** Canonical target cardinality. Commands opt in to the scopes they support. */
export const EDIT_COMMAND_SCOPES = [
  'SELECTED_ELEMENT', 'SELECTED_ELEMENTS', 'TRACK', 'CURRENT_VIDEO_SEGMENT',
  'ALL_VIDEO_SEGMENTS', 'PROJECT'
] as const;
export type EditCommandScope = typeof EDIT_COMMAND_SCOPES[number];

/** Who is executing a command. Task constraints bind automation only. */
export const EDIT_COMMAND_ACTORS = [
  'MANUAL_USER_ACTION', 'AI_ACTION', 'TEMPLATE_ACTION', 'SYSTEM_ACTION'
] as const;
export type EditCommandActor = typeof EDIT_COMMAND_ACTORS[number];

export const EDIT_CONSTRAINT_TYPES = [
  'PROTECT_CUTS', 'PROTECT_CROP', 'PROTECT_CAPTION_TEXT', 'PROTECT_CAPTION_STYLE',
  'PROTECT_HOOK_TEXT', 'PROTECT_LOGO_POSITION', 'PROTECT_AUDIO', 'PROTECT_COLOR',
  'PROTECT_TIMELINE_STRUCTURE', 'TARGET_RANGE_ONLY'
] as const;
export type EditConstraintType = typeof EDIT_CONSTRAINT_TYPES[number];

export const EDIT_CONSTRAINT_ROLES = ['HOOK', 'LOGO', 'CAPTIONS', 'SOURCE_AUDIO', 'MUSIC'] as const;

export type EditConstraint = {
  type: EditConstraintType;
  /** TASK constraints bind automated work. PROJECT constraints also bind manual commands. */
  lifetime?: 'TASK' | 'PROJECT';
  target?:
    | { kind: 'PROJECT' }
    | { kind: 'RANGE'; startSec: number; endSec: number }
    | { kind: 'ELEMENT'; elementId: string }
    | { kind: 'SEMANTIC_OBJECT'; role: typeof EDIT_CONSTRAINT_ROLES[number] };
};

export const EDIT_COMMAND_RESULT_STATUSES = [
  'DONE', 'BLOCKED_BY_CONSTRAINT', 'UNSUPPORTED', 'INVALID', 'FAILED', 'SKIPPED'
] as const;
export type EditCommandResultStatus = typeof EDIT_COMMAND_RESULT_STATUSES[number];

/** One field that a command changed, for verification-friendly results. */
export type EditFieldChange = { field: string; before: unknown; after: unknown };

export type EditCommandResult = {
  index: number;
  action: string;
  status: EditCommandResultStatus;
  scope: EditCommandScope;
  affectedElementIds: string[];
  affectedCount: number;
  /** Project revision this result belongs to (the new one when DONE). */
  revision?: number;
  constraint?: EditConstraintType;
  code?: string;
  message?: string;
  /** Distinct property values written, bounded - never the whole element. */
  changes?: EditFieldChange[];
  settingsChanged?: string[];
};

const SCOPE_ALIASES: Record<string, EditCommandScope> = {
  CURRENT_SEGMENT: 'CURRENT_VIDEO_SEGMENT', ALL_SEGMENTS: 'ALL_VIDEO_SEGMENTS',
  SELECTED: 'SELECTED_ELEMENT', GLOBAL: 'TRACK', ALL: 'TRACK'
};

export function readEditCommandScope(value: unknown, fallback: EditCommandScope): EditCommandScope {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toUpperCase();
  const scope = SCOPE_ALIASES[normalized] ?? normalized;
  if (!(EDIT_COMMAND_SCOPES as readonly string[]).includes(scope)) {
    throw new BadRequestException({ code: 'INVALID_EDIT_SCOPE',
      message: `scope must be one of ${EDIT_COMMAND_SCOPES.join(', ')}` });
  }
  return scope as EditCommandScope;
}

export function assertEditScope(action: string, scope: EditCommandScope,
  supported: readonly EditCommandScope[]) {
  if (!supported.includes(scope)) throw new BadRequestException({ code: 'UNSUPPORTED_EDIT_SCOPE',
    message: `${action} does not support ${scope}; supported scopes: ${supported.join(', ')}` });
}

export function readEditCommandActor(value: unknown, fallback: EditCommandActor): EditCommandActor {
  if (value === undefined || value === null || value === '') return fallback;
  const actor = String(value).trim().toUpperCase();
  if (!(EDIT_COMMAND_ACTORS as readonly string[]).includes(actor)) {
    throw new BadRequestException({ code: 'INVALID_ACTOR',
      message: `actor must be one of ${EDIT_COMMAND_ACTORS.join(', ')}` });
  }
  return actor as EditCommandActor;
}

const MAX_CONSTRAINTS = 32;

/** Validates caller-supplied constraints. Unknown shapes are refused, never
 * silently dropped: a guardrail the caller thinks is active must be active. */
export function readEditConstraints(value: unknown,
  defaultLifetime: 'TASK' | 'PROJECT' = 'TASK'): EditConstraint[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
    message: 'constraints must be an array' });
  if (value.length > MAX_CONSTRAINTS) throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
    message: `At most ${MAX_CONSTRAINTS} constraints are supported` });
  return value.map((raw) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const type = String(item.type ?? '').toUpperCase();
    if (!(EDIT_CONSTRAINT_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
        message: `Unknown constraint type "${String(item.type)}"` });
    }
    const lifetime = item.lifetime === undefined ? defaultLifetime
      : String(item.lifetime).toUpperCase();
    if (lifetime !== 'TASK' && lifetime !== 'PROJECT') {
      throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
        message: 'constraint lifetime must be TASK or PROJECT' });
    }
    const constraint: EditConstraint = { type: type as EditConstraintType, lifetime };
    const target = item.target && typeof item.target === 'object'
      ? item.target as Record<string, unknown> : undefined;
    // A range constraint may carry its range at the top level for convenience.
    const rangeStart = target?.startSec ?? item.startSec ?? item.start;
    const rangeEnd = target?.endSec ?? item.endSec ?? item.end;
    if (type === 'TARGET_RANGE_ONLY' || target?.kind === 'RANGE') {
      const startSec = Number(rangeStart);
      const endSec = Number(rangeEnd);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 ||
        endSec <= startSec) {
        throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
          message: 'A range constraint needs a finite start and an end after it' });
      }
      constraint.target = { kind: 'RANGE', startSec, endSec };
      return constraint;
    }
    if (!target || target.kind === undefined || target.kind === 'PROJECT') {
      if (target) constraint.target = { kind: 'PROJECT' };
      return constraint;
    }
    if (target.kind === 'ELEMENT') {
      if (typeof target.elementId !== 'string' || !target.elementId) {
        throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
          message: 'An element constraint needs an elementId' });
      }
      constraint.target = { kind: 'ELEMENT', elementId: target.elementId };
      return constraint;
    }
    if (target.kind === 'SEMANTIC_OBJECT') {
      const role = String(target.role ?? '').toUpperCase();
      if (!(EDIT_CONSTRAINT_ROLES as readonly string[]).includes(role)) {
        throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
          message: `Semantic constraint role must be one of ${EDIT_CONSTRAINT_ROLES.join(', ')}` });
      }
      constraint.target = { kind: 'SEMANTIC_OBJECT',
        role: role as typeof EDIT_CONSTRAINT_ROLES[number] };
      return constraint;
    }
    throw new BadRequestException({ code: 'INVALID_CONSTRAINT',
      message: 'constraint target kind must be PROJECT, RANGE, ELEMENT or SEMANTIC_OBJECT' });
  });
}

/** Persistent project locks live on settings.projectConstraints. */
export function readProjectConstraints(settings: unknown): EditConstraint[] {
  const record = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, unknown> : {};
  try {
    return readEditConstraints(record.projectConstraints, 'PROJECT')
      .map((constraint) => ({ ...constraint, lifetime: 'PROJECT' as const }));
  } catch {
    // A malformed stored value must not brick the project; it is ignored and
    // reported by the constraints endpoint rather than enforced half-way.
    return [];
  }
}

const CUT_ACTIONS = new Set(['TRIM_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT',
  'REORDER_ELEMENT', 'ADJUST_SOURCE_RANGE', 'SET_SPEED', 'SET_SOURCE_BOUNDARY']);
const CROP_ACTIONS = new Set(['SET_VIDEO_CROP', 'SET_VIDEO_REFRAME', 'SET_ASPECT_RATIO', 'SET_FIT_BACKGROUND',
  'SET_AUTO_REFRAME', 'SET_VIDEO_FRAMING', 'SET_REFRAME_POLICY', 'SET_VIDEO_SCALE',
  'SET_VIDEO_POSITION']);
const CAPTION_TEXT_ACTIONS = new Set(['SET_CAPTION_TEXT', 'GENERATE_CAPTIONS',
  'REGENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SPLIT_CAPTION', 'MERGE_CAPTION']);
const CAPTION_STYLE_ACTIONS = new Set(['SET_CAPTION_STYLE', 'APPLY_CAPTION_STYLE_TO_ALL',
  'SET_CAPTIONS_VISIBLE', 'SET_CAPTION_ACTIVE_WORD', 'SET_SUBTITLE_POLICY']);
const TEXT_STYLE_PREFIX = 'SET_TEXT_';
const AUDIO_ACTIONS = new Set(['SET_AUDIO_VOLUME', 'SET_AUDIO_MUTED', 'SET_AUDIO_FADE',
  'SET_AUDIO_TRIM', 'SET_AUDIO_DUCKING', 'SET_SOURCE_AUDIO_VOLUME', 'SET_SOURCE_AUDIO_MUTED',
  'ADD_AUDIO']);
const COLOR_ACTIONS = new Set(['SET_VIDEO_EXPOSURE', 'SET_VIDEO_BRIGHTNESS',
  'SET_VIDEO_CONTRAST', 'SET_VIDEO_HIGHLIGHTS', 'SET_VIDEO_SHADOWS', 'SET_VIDEO_SATURATION',
  'SET_VIDEO_TEMPERATURE', 'SET_VIDEO_TINT', 'SET_VIDEO_SHARPNESS', 'SET_VIDEO_FADE',
  'SET_VIDEO_VIGNETTE', 'RESET_VIDEO_ADJUSTMENTS', 'APPLY_COLOR_FILTER',
  'PASTE_VIDEO_ADJUSTMENTS', 'SET_COLOR_GRADE']);
const STRUCTURE_ACTIONS = new Set(['SPLIT_ELEMENT', 'DELETE_ELEMENT', 'REORDER_ELEMENT',
  'ADJUST_SOURCE_RANGE', 'SET_SOURCE_BOUNDARY', 'REMOVE_ELEMENT', 'GENERATE_CAPTIONS',
  'REGENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SPLIT_CAPTION', 'MERGE_CAPTION', 'TRIM_ELEMENT',
  'SET_SPEED']);
const POSITION_ACTIONS = new Set(['MOVE_ELEMENT', 'RESIZE_ELEMENT']);
const HOOK_TEXT_ACTIONS = new Set(['SET_TEXT_CONTENT', 'UPDATE_TEXT', 'REMOVE_ELEMENT']);

export type ConstraintElement = { id: string; type: string; startTime: number; duration: number;
  properties?: unknown };

export function semanticRole(element: { properties?: unknown } | undefined) {
  const p = element?.properties && typeof element.properties === 'object'
    ? element.properties as Record<string, unknown> : {};
  for (const key of ['templateRole', 'presetRole', 'role']) {
    const role = String(p[key] ?? '').toUpperCase();
    if (role === 'HOOK' || role === 'LOGO' || role === 'CTA') return role;
  }
  return String(p.presetRole ?? p.templateRole ?? p.role ?? '').toUpperCase();
}

/** Every constraint type an action touches for one target (a command can hit several). */
export function constraintTypesFor(action: string, target: ConstraintElement | undefined):
  Set<EditConstraintType> {
  const types = new Set<EditConstraintType>();
  if (CUT_ACTIONS.has(action) && (!target || target.type === 'VIDEO')) types.add('PROTECT_CUTS');
  if (CROP_ACTIONS.has(action) && (!target || target.type === 'VIDEO')) types.add('PROTECT_CROP');
  if (CAPTION_TEXT_ACTIONS.has(action)) types.add('PROTECT_CAPTION_TEXT');
  if (CAPTION_STYLE_ACTIONS.has(action) ||
    (action.startsWith(TEXT_STYLE_PREFIX) && action !== 'SET_TEXT_CONTENT' &&
      target?.type === 'SUBTITLE') ||
    (POSITION_ACTIONS.has(action) && target?.type === 'SUBTITLE') ||
    (action === 'SET_ELEMENT_OPACITY' && target?.type === 'SUBTITLE')) {
    types.add('PROTECT_CAPTION_STYLE');
  }
  if (HOOK_TEXT_ACTIONS.has(action) && semanticRole(target) === 'HOOK') types.add('PROTECT_HOOK_TEXT');
  if ((POSITION_ACTIONS.has(action) || action === 'REMOVE_ELEMENT') &&
    semanticRole(target) === 'LOGO') types.add('PROTECT_LOGO_POSITION');
  if (AUDIO_ACTIONS.has(action)) types.add('PROTECT_AUDIO');
  if (action === 'REMOVE_ELEMENT' && target?.type === 'AUDIO') types.add('PROTECT_AUDIO');
  if (COLOR_ACTIONS.has(action)) types.add('PROTECT_COLOR');
  if (STRUCTURE_ACTIONS.has(action) && (action !== 'REMOVE_ELEMENT' || target?.type === 'VIDEO')) {
    types.add('PROTECT_TIMELINE_STRUCTURE');
  }
  return types;
}

function appliesToTarget(constraint: EditConstraint, targets: ConstraintElement[]) {
  const target = constraint.target;
  if (!target || target.kind === 'PROJECT') return true;
  if (!targets.length) return target.kind !== 'ELEMENT';
  if (target.kind === 'ELEMENT') return targets.some((item) => item.id === target.elementId);
  if (target.kind === 'SEMANTIC_OBJECT') {
    if (target.role === 'CAPTIONS') return targets.some((item) => item.type === 'SUBTITLE');
    if (target.role === 'MUSIC') return targets.some((item) => item.type === 'AUDIO');
    if (target.role === 'SOURCE_AUDIO') return targets.some((item) => item.type === 'VIDEO');
    return targets.some((item) => semanticRole(item) === target.role);
  }
  return targets.some((item) => item.startTime < target.endSec &&
    item.startTime + item.duration > target.startSec);
}

/** Whether a constraint binds this actor. Task guardrails never block a direct user edit. */
export function constraintBindsActor(constraint: EditConstraint, actor: EditCommandActor) {
  if (actor === 'SYSTEM_ACTION') return false;
  if (actor === 'MANUAL_USER_ACTION') return constraint.lifetime === 'PROJECT';
  return true;
}

const outsideRange = (item: ConstraintElement, startSec: number, endSec: number) =>
  item.startTime < startSec - 1e-6 || item.startTime + item.duration > endSec + 1e-6;

/** Returns the first enforceable constraint for a command BEFORE it runs.
 * Manual actions ignore task-only guardrails. */
export function blockingEditConstraint(action: string, actor: EditCommandActor,
  constraints: readonly EditConstraint[], targets: ConstraintElement[]): EditConstraint | null {
  for (const constraint of constraints) {
    if (!constraintBindsActor(constraint, actor)) continue;
    if (constraint.type === 'TARGET_RANGE_ONLY') {
      const range = constraint.target;
      if (!range || range.kind !== 'RANGE') continue;
      // No concrete target (a project-wide setting) cannot be proven in range.
      if (!targets.length || targets.some((item) => outsideRange(item, range.startSec, range.endSec))) {
        return constraint;
      }
      continue;
    }
    const hit = (targets.length ? targets : [undefined]).some((target) =>
      constraintTypesFor(action, target).has(constraint.type) &&
      appliesToTarget(constraint, target ? [target] : []));
    if (hit) return constraint;
  }
  return null;
}

/**
 * Post-execution range check. A command that looked in-range can still ripple
 * (a trim moves every later caption), so the ACTUAL diff is checked too: every
 * element the command changed, added or removed must lie inside the range.
 */
export function rangeViolation(actor: EditCommandActor, constraints: readonly EditConstraint[],
  before: ConstraintElement[], after: ConstraintElement[]): EditConstraint | null {
  const ranges = constraints.filter((constraint) => constraint.type === 'TARGET_RANGE_ONLY' &&
    constraint.target?.kind === 'RANGE' && constraintBindsActor(constraint, actor));
  if (!ranges.length) return null;
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const touched: ConstraintElement[] = [];
  for (const item of after) {
    const prior = beforeById.get(item.id);
    if (!prior) touched.push(item);
    else if (JSON.stringify(prior) !== JSON.stringify(item)) touched.push(prior, item);
  }
  for (const item of before) if (!afterById.has(item.id)) touched.push(item);
  for (const constraint of ranges) {
    const range = constraint.target as { kind: 'RANGE'; startSec: number; endSec: number };
    if (touched.some((item) => outsideRange(item, range.startSec, range.endSec))) return constraint;
  }
  return null;
}

/** Bounded, verification-friendly description of what a command wrote. */
export function describeChanges(before: Array<{ id: string; properties?: unknown;
  startTime: number; duration: number; trimStart?: number | null; trimEnd?: number | null }>,
after: typeof before, limit = 24) {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterIds = new Set(after.map((item) => item.id));
  const affected: string[] = [];
  const seen = new Map<string, EditFieldChange>();
  for (const item of after) {
    const prior = beforeById.get(item.id);
    if (!prior) { affected.push(item.id); continue; }
    if (JSON.stringify(prior) === JSON.stringify(item)) continue;
    affected.push(item.id);
    const priorProps = (prior.properties ?? {}) as Record<string, unknown>;
    const nextProps = (item.properties ?? {}) as Record<string, unknown>;
    const fields: Array<[string, unknown, unknown]> = [
      ['startTime', prior.startTime, item.startTime], ['duration', prior.duration, item.duration],
      ['trimStart', prior.trimStart ?? null, item.trimStart ?? null],
      ['trimEnd', prior.trimEnd ?? null, item.trimEnd ?? null],
      ...[...new Set([...Object.keys(priorProps), ...Object.keys(nextProps)])]
        .map((key) => [`properties.${key}`, priorProps[key], nextProps[key]] as [string, unknown, unknown])
    ];
    for (const [field, a, b] of fields) {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      // Keyed by field and value, so 400 captions set to one size read as one change.
      const key = `${field}:${JSON.stringify(b)}`;
      if (!seen.has(key) && seen.size < limit) seen.set(key, { field, before: a, after: b });
    }
  }
  for (const item of before) if (!afterIds.has(item.id)) affected.push(item.id);
  return { affectedElementIds: [...new Set(affected)], changes: [...seen.values()] };
}
