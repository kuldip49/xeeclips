// Workstream G: a zoom is an editable object.
//
// Before G a zoom only existed as preset INTENT: `settings.presetRun
// .plannedZoomMoments` (source seconds) multiplied by one project-wide
// `zoomPolicy`. There was no way to make ONE zoom deeper, move it, or remove it
// without re-planning the whole preset - so "make this zoom deeper" had no
// canonical command to land on.
//
// A zoom event is now an ordinary timeline element of the long-reserved EFFECT
// type: it has a stable id, a start and a duration on the edited timeline, and a
// bounded peak scale. That buys it everything the timeline already guarantees -
// validation after every command, retiming under speed changes
// (`retimeOverlays` moves every non-VIDEO element), one history row per edit and
// undo/redo - without a schema change.
//
// Editing a PRESET-planned moment does not duplicate it. The first edit writes a
// zoom element that CLAIMS the moment (`claimsMoment` = the moment's key), and
// the render plan then renders the element in the moment's place. Removing a
// claimed moment leaves a disabled claim behind, so the preset moment does not
// silently come back.
//
// The bounds are the renderer's own: nothing below the smallest visible punch-in
// and nothing above the STRONG ceiling the Phase 5 zoom planner allows. The
// renderer still runs every event through its subject/information safety check
// and may reduce or skip one; a stored scale is a request, never a promise.

export const ZOOM_EFFECT = 'ZOOM' as const;

/** Smallest visible punch-in. Matches EDIT_MODE_ZOOM.minScale. */
export const MIN_ZOOM_SCALE = 1.03;
/** The STRONG ceiling. Matches EDIT_MODE_ZOOM_SCALES.STRONG. */
export const MAX_ZOOM_SCALE = 1.15;
/** One "more"/"less" step. Matches the renderer's own reduction step x1.5. */
export const ZOOM_SCALE_STEP = 0.03;
/** A new zoom with no stated strength: the MODERATE preset scale. */
export const DEFAULT_ZOOM_SCALE = 1.1;
/** Shortest zoom worth adding: ramp in + minimum hold + ramp out. */
export const MIN_ZOOM_DURATION_SEC = 1.1;
/** A zoom with no stated length holds for about one spoken beat. */
export const DEFAULT_ZOOM_DURATION_SEC = 1.6;

export type ZoomEffect = {
  effect: typeof ZOOM_EFFECT;
  scale: number;
  /** False only for a claim that removes a preset moment. */
  enabled: boolean;
  /** The preset moment this element replaces, or null for a free zoom. */
  claimsMoment: string | null;
  triggerText: string;
  semanticReason: string;
  focusX: number | null;
  focusY: number | null;
  focusTrackId: string | null;
};

export class ZoomRangeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

const round = (value: number) => Number(value.toFixed(4));

/** A preset moment's identity: its source second and its trigger word. Stable
 *  across cuts (it is in SOURCE time) and across preset reapply (same evidence
 *  yields the same moment). */
export const zoomMomentKey = (moment: { startSec: number; triggerText?: string | null }) =>
  `m${Number(moment.startSec).toFixed(3)}-${String(moment.triggerText ?? '')
    .replace(/[^\p{L}\p{N}]/gu, '').slice(0, 24).toLowerCase()}`;

export function validateZoomScale(value: unknown): number {
  const scale = Number(value);
  if (!Number.isFinite(scale) || scale < MIN_ZOOM_SCALE - 1e-9 || scale > MAX_ZOOM_SCALE + 1e-9) {
    throw new ZoomRangeError('INVALID_ZOOM_SCALE',
      `Zoom strength must be between ${MIN_ZOOM_SCALE}x and ${MAX_ZOOM_SCALE}x`);
  }
  return round(scale);
}

/** Reads an EFFECT element's zoom, or null when it is not a zoom. */
export function readZoomEffect(properties: unknown): ZoomEffect | null {
  const value = record(properties);
  if (value.effect !== ZOOM_EFFECT) return null;
  const scale = Number(value.scale);
  return {
    effect: ZOOM_EFFECT,
    scale: Number.isFinite(scale)
      ? round(Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, scale))) : DEFAULT_ZOOM_SCALE,
    enabled: value.enabled !== false,
    claimsMoment: typeof value.claimsMoment === 'string' && value.claimsMoment
      ? value.claimsMoment : null,
    triggerText: typeof value.triggerText === 'string' ? value.triggerText.slice(0, 120) : '',
    semanticReason: typeof value.semanticReason === 'string'
      ? value.semanticReason.slice(0, 120) : 'EDITED_ZOOM',
    focusX: Number.isFinite(Number(value.focusX)) ? Math.max(.1, Math.min(.9, Number(value.focusX))) : null,
    focusY: Number.isFinite(Number(value.focusY)) ? Math.max(.1, Math.min(.9, Number(value.focusY))) : null,
    focusTrackId: typeof value.focusTrackId === 'string' ? value.focusTrackId : null
  };
}

/** The stored properties for a new zoom element. Every field is validated. */
export function zoomProperties(input: Record<string, unknown>): Record<string, unknown> {
  const scale = validateZoomScale(input.scale ?? DEFAULT_ZOOM_SCALE);
  const claimsMoment = input.claimsMoment == null ? null : String(input.claimsMoment);
  if (claimsMoment !== null && !/^m\d+\.\d{3}-[\p{L}\p{N}]{0,24}$/u.test(claimsMoment)) {
    throw new ZoomRangeError('INVALID_ZOOM_CLAIM', 'claimsMoment is not a preset zoom moment key');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new ZoomRangeError('INVALID_ZOOM', 'enabled must be a boolean');
  }
  return {
    effect: ZOOM_EFFECT, scale, enabled: input.enabled !== false, claimsMoment,
    triggerText: typeof input.triggerText === 'string' ? input.triggerText.slice(0, 120) : '',
    semanticReason: typeof input.semanticReason === 'string'
      ? input.semanticReason.slice(0, 120) : 'EDITED_ZOOM',
    focusX: Number.isFinite(Number(input.focusX)) ? Math.max(.1, Math.min(.9, Number(input.focusX))) : null,
    focusY: Number.isFinite(Number(input.focusY)) ? Math.max(.1, Math.min(.9, Number(input.focusY))) : null,
    focusTrackId: typeof input.focusTrackId === 'string' ? input.focusTrackId.slice(0, 120) : null
  };
}

/**
 * Everything a stored EFFECT element must satisfy, re-checked on every
 * validation because a timeline can also arrive from a history restore.
 *
 * Length is deliberately NOT checked here. A speed change retimes every
 * overlay and can squeeze a zoom below the length it needs to settle; refusing
 * the speed change for that would block an edit the user actually asked for.
 * The renderer already skips a zoom too short to ease in and out
 * (SHOT_TOO_SHORT_FOR_A_SETTLED_ZOOM), and ADD_ZOOM refuses to create one.
 */
export function assertStoredZoom(properties: unknown) {
  const value = record(properties);
  if (value.effect !== ZOOM_EFFECT) {
    throw new ZoomRangeError('UNSUPPORTED_EFFECT', 'The only supported effect is a zoom');
  }
  validateZoomScale(value.scale);
}
