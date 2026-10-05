import type { EditElement } from './edit-mode-types';

/**
 * Timeline snapping ("magnet").
 *
 * Pure — no DOM, no React — so the rules are exercised directly by
 * scripts/test-timeline-ux.cjs.
 *
 * The threshold is a PIXEL distance converted to seconds at the current zoom,
 * not a fixed number of seconds. A fixed time threshold would feel magnetic
 * when zoomed out and useless when zoomed in, which is exactly backwards: what
 * the user is judging is how close two things look, and that is pixels.
 */

/** How close, on screen, an edge has to come before it snaps. */
export const SNAP_THRESHOLD_PX = 8;

export type SnapKind = 'PLAYHEAD' | 'CLIP' | 'TEXT' | 'CAPTION' | 'IMAGE' | 'AUDIO' | 'PROJECT';

export type TimelineSnapCandidate = { atSec: number; kind: SnapKind; label: string };

export type TimelineSnapResult = {
  seconds: number;
  /** The candidate that won, or null when nothing was close enough. This is
   *  what the visible snap guide is drawn from — no guide means no snap. */
  guide: TimelineSnapCandidate | null;
};

const KIND_BY_TYPE: Record<string, SnapKind> = {
  VIDEO: 'CLIP', TEXT: 'TEXT', SUBTITLE: 'CAPTION', IMAGE: 'IMAGE', AUDIO: 'AUDIO'
};

const LABELS: Record<SnapKind, string> = {
  PLAYHEAD: 'Playhead', CLIP: 'Clip edge', TEXT: 'Text edge', CAPTION: 'Caption edge',
  IMAGE: 'Image edge', AUDIO: 'Music edge', PROJECT: 'Project edge'
};

/** Kinds in priority order: with two candidates equally close, the earlier kind
 *  wins, so an edge sitting under the playhead snaps to the playhead. */
const PRIORITY: SnapKind[] = ['PLAYHEAD', 'PROJECT', 'CLIP', 'TEXT', 'CAPTION', 'IMAGE', 'AUDIO'];

/**
 * Every second an edge can snap to: the playhead, the project's two ends, and
 * both ends of every other element.
 *
 * `excludeIds` drops the elements being dragged, so a clip cannot snap to
 * itself. The result is sorted by time and deduplicated, which is what lets
 * `snapSeconds` binary-search it once per pointer move instead of scanning
 * hundreds of captions.
 */
export function snapCandidates(elements: EditElement[], input: {
  playheadSec: number; durationSec: number; excludeIds?: Iterable<string>;
  includePlayhead?: boolean;
}): TimelineSnapCandidate[] {
  const excluded = new Set(input.excludeIds ?? []);
  const best = new Map<number, TimelineSnapCandidate>();
  const offer = (atSec: number, kind: SnapKind) => {
    if (!Number.isFinite(atSec) || atSec < 0) return;
    const at = Math.round(atSec * 1000) / 1000;
    const existing = best.get(at);
    if (existing && PRIORITY.indexOf(existing.kind) <= PRIORITY.indexOf(kind)) return;
    best.set(at, { atSec: at, kind, label: LABELS[kind] });
  };
  offer(0, 'PROJECT');
  offer(input.durationSec, 'PROJECT');
  if (input.includePlayhead !== false) offer(input.playheadSec, 'PLAYHEAD');
  for (const element of elements) {
    if (excluded.has(element.id)) continue;
    const kind = KIND_BY_TYPE[element.type];
    if (!kind) continue;
    offer(element.startTime, kind);
    offer(element.startTime + element.duration, kind);
  }
  return [...best.values()].sort((left, right) => left.atSec - right.atSec);
}

/** Index of the first candidate at or after `seconds`. */
function lowerBound(candidates: TimelineSnapCandidate[], seconds: number) {
  let low = 0; let high = candidates.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (candidates[mid].atSec < seconds) low = mid + 1; else high = mid;
  }
  return low;
}

/**
 * Snaps one second value.
 *
 * `enabled: false` returns the value untouched with no guide, which is what the
 * Snap toggle (and holding a modifier to override) does — snapping is always
 * escapable, never a constraint the user cannot get out of.
 */
export function snapSeconds(seconds: number, candidates: TimelineSnapCandidate[],
  pxPerSecond: number, options?: { enabled?: boolean; thresholdPx?: number }): TimelineSnapResult {
  if (options?.enabled === false || !candidates.length || !(pxPerSecond > 0)) {
    return { seconds, guide: null };
  }
  const threshold = (options?.thresholdPx ?? SNAP_THRESHOLD_PX) / pxPerSecond;
  const start = lowerBound(candidates, seconds);
  let winner: TimelineSnapCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  // Walk out from the insertion point in both directions and stop as soon as
  // the gap exceeds the threshold: the list is sorted, so nothing further out
  // can be closer.
  for (let index = start; index < candidates.length; index += 1) {
    const distance = candidates[index].atSec - seconds;
    if (distance > threshold) break;
    if (distance < bestDistance) { bestDistance = distance; winner = candidates[index]; }
  }
  for (let index = start - 1; index >= 0; index -= 1) {
    const distance = seconds - candidates[index].atSec;
    if (distance > threshold) break;
    if (distance < bestDistance ||
      (distance === bestDistance && winner &&
        PRIORITY.indexOf(candidates[index].kind) < PRIORITY.indexOf(winner.kind))) {
      bestDistance = distance; winner = candidates[index];
    }
  }
  return winner ? { seconds: winner.atSec, guide: winner } : { seconds, guide: null };
}
