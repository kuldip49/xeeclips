import { createTimelineMapper, Cut } from './timeline-remap';

// One kept source range and where it lands on the final edited timeline.
export type TimelineSegment = { sourceStart: number; sourceEnd: number;
  finalStart: number; finalEnd: number };

// The EDITED_CLIPS timeline is independent from the selected candidate range.
// `raw*` is the selected source clip, `edited*` the final source bounds, and
// `segments` the source -> final map every timed layer must go through.
export type EditedTimeline = {
  candidateStart: number; candidateEnd: number;
  rawStart: number; rawEnd: number; rawDuration: number;
  editedStart: number; editedEnd: number; editedDuration: number;
  sourceSpan: number; removedDuration: number;
  cuts: Cut[]; segments: TimelineSegment[];
};

const round = (value: number) => Math.round(value * 1000) / 1000;

export function buildEditedTimeline(input: { candidateStart: number; candidateEnd: number;
  rawStart?: number; rawEnd?: number; editedStart: number; editedEnd: number;
  cuts?: Cut[] }): EditedTimeline {
  const { editedStart, editedEnd } = input;
  if (!(editedEnd > editedStart)) throw new Error('Edited timeline must have positive duration');
  const cuts = normalizeCuts(input.cuts ?? [], editedStart, editedEnd);
  const segments: TimelineSegment[] = [];
  let cursor = editedStart;
  let final = 0;
  for (const cut of [...cuts, { start: editedEnd, end: editedEnd }]) {
    if (cut.start > cursor) {
      const length = cut.start - cursor;
      segments.push({ sourceStart: round(cursor), sourceEnd: round(cut.start),
        finalStart: round(final), finalEnd: round(final + length) });
      final += length;
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (!segments.length) throw new Error('Edited timeline removed the entire clip');
  const rawStart = input.rawStart ?? input.candidateStart;
  const rawEnd = input.rawEnd ?? input.candidateEnd;
  const removedDuration = cuts.reduce((sum, cut) => sum + cut.end - cut.start, 0);
  return { candidateStart: input.candidateStart, candidateEnd: input.candidateEnd,
    rawStart, rawEnd, rawDuration: round(rawEnd - rawStart),
    editedStart: round(editedStart), editedEnd: round(editedEnd),
    editedDuration: round(final), sourceSpan: round(editedEnd - editedStart),
    removedDuration: round(removedDuration), cuts, segments };
}

// Cuts clipped to the edited range, sorted and merged.
export function normalizeCuts(cuts: Cut[], start: number, end: number): Cut[] {
  const sorted = cuts.map((cut) => ({ start: Math.max(start, cut.start), end: Math.min(end, cut.end) }))
    .filter((cut) => Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.end - cut.start > .001)
    .sort((a, b) => a.start - b.start);
  const merged: Cut[] = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.start <= last.end + .001) last.end = Math.max(last.end, cut.end);
    else merged.push({ ...cut });
  }
  return merged;
}

export function timelineMapper(timeline: EditedTimeline) {
  return createTimelineMapper(timeline.editedStart, timeline.cuts);
}

// Source time -> final time, or null when the instant was removed or is outside the edit.
export function sourceToFinal(timeline: EditedTimeline, sourceTime: number): number | null {
  const segment = timeline.segments.find((item) =>
    sourceTime >= item.sourceStart - 1e-6 && sourceTime <= item.sourceEnd + 1e-6);
  return segment ? segment.finalStart + (sourceTime - segment.sourceStart) : null;
}

export function finalToSource(timeline: EditedTimeline, finalTime: number): number | null {
  const segment = timeline.segments.find((item) =>
    finalTime >= item.finalStart - 1e-6 && finalTime <= item.finalEnd + 1e-6);
  return segment ? segment.sourceStart + (finalTime - segment.finalStart) : null;
}
