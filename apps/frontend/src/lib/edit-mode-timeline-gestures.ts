import { MIN_VIDEO_DURATION_SEC } from './edit-mode-timeline';
import type { EditElement } from './edit-mode-types';

/**
 * The geometry of a timeline gesture: what a trim or a move produces, given the
 * second the pointer is asking for.
 *
 * Pure — no DOM, no React, no commands — so every rule below (minimum duration,
 * source bounds, project bounds, how an AUDIO trim carries its read window) is
 * exercised directly by scripts/test-timeline-ux.cjs. The component's job is
 * only to turn pixels into a target second, snap it, call one of these, and
 * hand the result to the local preview. Exactly one canonical command is issued
 * per completed gesture, on pointer release.
 */

/** The shortest an element may be made by dragging. Shorter than a VIDEO
 *  segment's floor, because a caption legitimately can be very short. */
export const MIN_SPAN_SEC = 0.1;

/** Half of the backend's MIN_CAPTION_SEC: the smallest half a caption split may
 *  leave behind. Kept in step with edit-mode-captions.ts on the server. */
export const MIN_CAPTION_SPLIT_SEC = 0.175;

export type TrimEdge = 'left' | 'right';

/**
 * A VIDEO edge drag retrims the SOURCE: the segment shows a different part of
 * the footage, and the track is re-laid end to end afterwards. `targetSec` is
 * the timeline second the dragged edge is being pulled to.
 */
export function trimVideo(element: EditElement, edge: TrimEdge, targetSec: number,
  sourceDurationSec: number): EditElement {
  const trimStart = element.trimStart;
  const trimEnd = element.trimEnd ?? trimStart + element.duration;
  const speed = Math.max(0.0001, Number(element.properties.speed ?? 1) || 1);
  // A sped-up segment covers more source seconds per timeline second, so a
  // pixel drag has to be scaled by the rate or a 2x clip trims at half speed.
  const deltaSourceSec = (targetSec - (edge === 'left'
    ? element.startTime : element.startTime + element.duration)) * speed;
  if (edge === 'left') {
    const nextStart = Math.max(0,
      Math.min(trimEnd - MIN_VIDEO_DURATION_SEC, trimStart + deltaSourceSec));
    return { ...element, trimStart: nextStart, duration: (trimEnd - nextStart) / speed };
  }
  const nextEnd = Math.max(trimStart + MIN_VIDEO_DURATION_SEC,
    Math.min(sourceDurationSec > 0 ? sourceDurationSec : trimEnd + deltaSourceSec,
      trimEnd + deltaSourceSec));
  return { ...element, trimEnd: nextEnd, duration: (nextEnd - trimStart) / speed };
}

/**
 * Every other track's edge drag resizes the element's TIMELINE span.
 *
 * An AUDIO element carries a read window over its asset, so moving its left
 * edge also moves `trimStart` — otherwise the music would restart from a
 * different place every time the clip was shortened. Text, captions and images
 * have no source to window, so their trim fields are left alone.
 */
export function trimSpan(element: EditElement, edge: TrimEdge, targetSec: number,
  timelineDurationSec: number): EditElement {
  const end = element.startTime + element.duration;
  const audio = element.type === 'AUDIO';
  if (edge === 'left') {
    const nextStart = Math.max(0, Math.min(end - MIN_SPAN_SEC, targetSec));
    const removed = nextStart - element.startTime;
    return { ...element, startTime: nextStart, duration: end - nextStart,
      trimStart: audio ? Math.max(0, element.trimStart + removed) : element.trimStart,
      trimEnd: element.trimEnd };
  }
  const nextEnd = Math.max(element.startTime + MIN_SPAN_SEC,
    Math.min(timelineDurationSec, targetSec));
  const duration = nextEnd - element.startTime;
  return { ...element, duration,
    trimEnd: audio ? element.trimStart + duration : element.trimEnd };
}

/**
 * A whole-element move along its track. The element keeps its length and its
 * source window; only where it sits changes. Clamped into the project, so a
 * drag can never produce timing the backend would refuse.
 */
export function moveSpan(element: EditElement, targetStartSec: number,
  timelineDurationSec: number): EditElement {
  const startTime = Math.max(0,
    Math.min(Math.max(0, timelineDurationSec - element.duration), targetStartSec));
  return { ...element, startTime };
}

/**
 * Whether the playhead is somewhere the selected element can actually be split.
 *
 * Used to enable or explain the Split button rather than letting the user press
 * it and read a server error. The floor on each side is the same one the
 * backend's INVALID_SPLIT guard uses, so the button agrees with the command.
 */
export function splitAvailability(element: EditElement | undefined | null,
  playheadSec: number): { canSplit: boolean; reason: string } {
  if (!element) return { canSplit: false, reason: 'Select a clip or caption to split.' };
  if (element.properties.locked === true) {
    return { canSplit: false, reason: 'This track is locked. Unlock it to split.' };
  }
  if (element.type !== 'VIDEO' && element.type !== 'SUBTITLE') {
    return { canSplit: false, reason: 'Only video clips and captions can be split.' };
  }
  // The floors mirror the server's own guards exactly (INVALID_SPLIT for a
  // clip, SPLIT_OUT_OF_RANGE for a caption), so the button is never offered for
  // a cut the command would then refuse.
  const floor = element.type === 'VIDEO' ? MIN_VIDEO_DURATION_SEC : MIN_CAPTION_SPLIT_SEC;
  const offset = playheadSec - element.startTime;
  if (offset <= floor || element.duration - offset <= floor) {
    return { canSplit: false,
      reason: 'Move the playhead further inside the selected item to split it.' };
  }
  if (element.type === 'SUBTITLE' &&
    String(element.properties.content ?? '').split(/\s+/u).filter(Boolean).length < 2) {
    return { canSplit: false, reason: 'A caption of one word cannot be split.' };
  }
  return { canSplit: true, reason: 'Split at the playhead (S)' };
}
