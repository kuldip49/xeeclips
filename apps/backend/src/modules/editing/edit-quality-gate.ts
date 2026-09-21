// Deterministic final quality gate for EDITED_CLIPS. Every check first states
// whether it applies; only applicable checks can pass or fail.
export type RepairAction = 'HOOK_REFIT' | 'HOOK_CONTRAST' | 'SUBJECT_REFRAME' | 'INFORMATION_FIT' |
  'CAMERA_TRAJECTORY_RESET' |
  'SUBTITLE_RETIME' | 'SUBTITLE_REFIT' | 'SUBTITLE_EMPHASIS_REBUILD' | 'BACKGROUND_REGENERATE' | 'BACKGROUND_SMOOTH' |
  'MUSIC_RETRY' | 'ZOOM_STRENGTHEN' | 'ZOOM_DISABLE' | 'GRADE_STRENGTHEN' |
  'ZOOM_LOCAL_REPAIR' | 'GRADE_SAFETY' | 'SFX_QUIET' | 'SFX_DISABLE';
export type RepairInvalidation = { base: boolean; overlay: boolean; audio: boolean; thumbnail: boolean };
export const REPAIR_INVALIDATION: Record<RepairAction, RepairInvalidation> = {
  HOOK_REFIT: { base: false, overlay: true, audio: false, thumbnail: true },
  HOOK_CONTRAST: { base: true, overlay: true, audio: false, thumbnail: true },
  SUBJECT_REFRAME: { base: true, overlay: true, audio: false, thumbnail: true },
  INFORMATION_FIT: { base: true, overlay: true, audio: false, thumbnail: true },
  CAMERA_TRAJECTORY_RESET: { base: true, overlay: true, audio: false, thumbnail: true },
  SUBTITLE_RETIME: { base: false, overlay: true, audio: false, thumbnail: false },
  SUBTITLE_REFIT: { base: false, overlay: true, audio: false, thumbnail: false },
  SUBTITLE_EMPHASIS_REBUILD: { base: false, overlay: true, audio: false, thumbnail: false },
  BACKGROUND_REGENERATE: { base: true, overlay: true, audio: false, thumbnail: true },
  BACKGROUND_SMOOTH: { base: true, overlay: true, audio: false, thumbnail: true },
  MUSIC_RETRY: { base: false, overlay: false, audio: true, thumbnail: false },
  ZOOM_STRENGTHEN: { base: true, overlay: true, audio: true, thumbnail: true },
  ZOOM_DISABLE: { base: true, overlay: true, audio: true, thumbnail: true },
  ZOOM_LOCAL_REPAIR: { base: true, overlay: true, audio: true, thumbnail: true },
  GRADE_STRENGTHEN: { base: true, overlay: true, audio: false, thumbnail: true },
  GRADE_SAFETY: { base: true, overlay: true, audio: false, thumbnail: true },
  SFX_QUIET: { base: false, overlay: false, audio: true, thumbnail: false },
  SFX_DISABLE: { base: false, overlay: false, audio: true, thumbnail: false }
};
export function repairInvalidation(actions: RepairAction[]): RepairInvalidation {
  return actions.reduce<RepairInvalidation>((combined, action) => ({
    base: combined.base || REPAIR_INVALIDATION[action].base,
    overlay: combined.overlay || REPAIR_INVALIDATION[action].overlay,
    audio: combined.audio || REPAIR_INVALIDATION[action].audio,
    thumbnail: combined.thumbnail || REPAIR_INVALIDATION[action].thumbnail
  }), { base: false, overlay: false, audio: false, thumbnail: false });
}
// Boundary repairs (§30) are carried out by the boundary optimizer before a
// frame is rendered, so they are named here for telemetry and reporting only -
// they are deliberately never handed to the render repair loop, which would
// re-render the same clip without being able to change a word boundary.
export type BoundaryRepairAction = 'OPENING_CONTEXT_EXPAND' | 'OPENING_WEAK_LEAD_TRIM' |
  'OPENING_WORD_BOUNDARY_REPAIR' | 'ENDING_SEMANTIC_EXPAND' | 'ENDING_TRIM_NEW_TOPIC' |
  'ENDING_WORD_BOUNDARY_REPAIR' | 'ENDING_TAIL_REPAIR';
// BASELINE failures block delivery; ENHANCEMENT failures degrade it.
export type CheckSeverity = 'BASELINE' | 'ENHANCEMENT';
export type QualityCheck = {
  name: string; applicable: boolean; required: boolean; passed: boolean | null;
  severity: CheckSeverity; value?: unknown; repair?: RepairAction; detail?: string;
};
export type GateStatus = 'PASSED' | 'DEGRADED' | 'FAILED';
export type RepairLog = { repairReason: string; repairAction: RepairAction; repairAttempt: number;
  repairResult: 'FIXED' | 'NOT_FIXED' | 'PENDING' };

export function check(name: string, input: { applicable: boolean; required?: boolean;
  passed: boolean | null | undefined; severity?: CheckSeverity; value?: unknown;
  repair?: RepairAction; detail?: string }): QualityCheck {
  const applicable = input.applicable;
  return { name, applicable, required: applicable && (input.required ?? true),
    passed: applicable ? Boolean(input.passed) : null, severity: input.severity ?? 'BASELINE',
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.repair ? { repair: input.repair } : {}),
    ...(input.detail ? { detail: input.detail } : {}) };
}

export function evaluateGate(checks: QualityCheck[]) {
  const failing = checks.filter((item) => item.applicable && item.required && item.passed === false);
  const baseline = failing.filter((item) => item.severity === 'BASELINE');
  const enhancement = failing.filter((item) => item.severity === 'ENHANCEMENT');
  const status: GateStatus = baseline.length ? 'FAILED' : enhancement.length ? 'DEGRADED' : 'PASSED';
  const repairs = [...new Set(failing.map((item) => item.repair).filter(Boolean))] as RepairAction[];
  return { status, failedChecks: baseline.map((item) => item.name),
    degradedChecks: enhancement.map((item) => item.name), repairs,
    summary: Object.fromEntries(checks.map((item) => [item.name, item.applicable ? item.passed : 'N/A'])) };
}

const SEVERE_GRADING_CHECKS = new Set(['exposureNatural', 'highlightSafe', 'shadowSafe',
  'saturationNatural', 'whiteBalanceNatural', 'gradingNotOverprocessed', 'gradingLooksNatural']);

export type GradingRepairDecision = { allowed: boolean; reason: string;
  failedChecks: string[]; predictedImprovement: number };

/**
 * A grade is encoded again only when the finished pixels show a visual-safety
 * regression that a deterministic strength reduction can actually undo. A
 * score miss such as `gradingApplied` is deliberately not a rerender reason.
 */
export function gradingRepairDecision(checks: QualityCheck[], grading: {
  selectedPreset?: string; gradingStrength?: number }): GradingRepairDecision {
  const failedChecks = checks.filter((item) => item.applicable && item.passed === false &&
    SEVERE_GRADING_CHECKS.has(item.name)).map((item) => item.name);
  const deterministic = grading.selectedPreset !== 'NO_CHANGE' && (grading.gradingStrength ?? 0) > .25;
  return { allowed: failedChecks.length > 0 && deterministic,
    reason: !failedChecks.length ? 'NO_SEVERE_GRADING_FAILURE' : !deterministic ?
      'NO_DETERMINISTIC_GRADING_REPAIR' : `SEVERE_GRADING_SAFETY:${failedChecks.join('|')}`,
    failedChecks, predictedImprovement: deterministic ? failedChecks.length : 0 };
}

/** Baseline failures may still receive the one safety rerender. Enhancement
 * misses stay honestly DEGRADED; they no longer spend a second full encode. */
export function fullRenderRepairActions(checks: QualityCheck[], grading: {
  selectedPreset?: string; gradingStrength?: number }) {
  const baseline = checks.filter((item) => item.applicable && item.required &&
    item.passed === false && item.severity === 'BASELINE' && item.repair)
    .map((item) => item.repair!) as RepairAction[];
  const grade = gradingRepairDecision(checks, grading);
  if (grade.allowed) baseline.push('GRADE_SAFETY');
  return { actions: [...new Set(baseline)], grading: grade };
}

export class EditQualityError extends Error {
  constructor(message: string, readonly report: unknown) {
    super(message);
    this.name = 'EditQualityError';
  }
}
