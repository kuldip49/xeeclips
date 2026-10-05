import type { EditElement } from './edit-mode-types';

/**
 * Windowing for the caption side panel.
 *
 * A dense project carries 400 captions. Listing all of them in a 268px rail
 * would mount 400 interactive rows for no benefit: the list exists to FIND a
 * caption, and a window around the playhead plus a search box does that in a
 * bounded number of nodes. This is the panel's half of the same rule
 * `edit-mode-viewport.ts` enforces on the timeline.
 *
 * Pure — no DOM, no React — so the bound can be asserted directly by
 * scripts/test-timeline-virtualization.cjs.
 */

/** The most caption rows the panel will ever put in the DOM at once. */
export const MAX_CAPTION_ROWS = 40;

export type CaptionListMode = 'ALL' | 'WINDOW' | 'SEARCH';

export type CaptionListResult = {
  rows: EditElement[];
  /** How many captions the mode matched, before the row cap. */
  total: number;
  mode: CaptionListMode;
};

export function captionRows(captions: EditElement[], playheadSec: number,
  query: string): CaptionListResult {
  const term = query.trim().toLowerCase();
  const sorted = [...captions].sort((left, right) => left.startTime - right.startTime ||
    left.id.localeCompare(right.id));
  if (term) {
    const hits = sorted.filter((element) =>
      String(element.properties.content ?? '').toLowerCase().includes(term));
    return { rows: hits.slice(0, MAX_CAPTION_ROWS), total: hits.length, mode: 'SEARCH' };
  }
  if (sorted.length <= MAX_CAPTION_ROWS) {
    return { rows: sorted, total: sorted.length, mode: 'ALL' };
  }
  // Centre the window on the caption under the playhead, then clamp it into the
  // list so the head and the tail of the project are both reachable.
  let index = sorted.findIndex((element) =>
    playheadSec < element.startTime + element.duration);
  if (index < 0) index = sorted.length - 1;
  const start = Math.max(0, Math.min(sorted.length - MAX_CAPTION_ROWS,
    index - Math.floor(MAX_CAPTION_ROWS / 2)));
  return { rows: sorted.slice(start, start + MAX_CAPTION_ROWS), total: sorted.length,
    mode: 'WINDOW' };
}
