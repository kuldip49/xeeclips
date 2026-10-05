// EditMode Phase 5 timeline mapping.
//
// The canonical VIDEO track is an ORDERED list of source ranges. Trims change a
// range, splits produce two, deletions drop one and a move reorders them - so
// unlike the frozen auto pipeline (one clip window plus a set of cuts) the
// EditMode timeline is not expressible as `clipStart + cuts`, and the shared
// `createTimelineMapper` cannot describe it.
//
// This module is the EditMode-local equivalent: an ordered segment list plus the
// two mappings every timed layer goes through. Everything here is pure.

import type { AnalysisFrame } from '../../editing/edit-analysis';
import type { VisualTrack } from '../../editing/reframe.service';
import { readSourceAudio } from '../edit-mode-audio';
import { readColor } from '../edit-mode-color';
import { readSpeed, readTransform, readScale } from '../edit-mode-transform';
import { readFrameLayout } from '../edit-mode-framing';
import type { RenderVideoSegment } from './edit-mode-render.types';

export type TimelineMap = {
  segments: RenderVideoSegment[];
  durationSec: number;
  /** Exported-timeline instant -> source instant, or null outside the timeline. */
  toSource(timelineSec: number): number | null;
  /** Source instant -> every exported instant it survives at (a reused range
   * appears more than once; a removed range yields none). */
  toTimeline(sourceSec: number): number[];
};

const round = (value: number) => Number(value.toFixed(6));

/**
 * Builds the ordered segment list from track-0 VIDEO elements.
 *
 * Speed separates two lengths that used to be one number: the SOURCE range a
 * segment reads, and the TIMELINE span it occupies. The timeline span is the
 * source range divided by the playback rate, and both mappings below convert
 * between them, so analysis frames, captions and zoom events all stay attached
 * to the right footage when a clip is sped up or slowed down.
 */
export function buildTimelineMap(elements: Array<{
  id: string; type: string; track: number; position: number; startTime: number;
  duration: number; trimStart?: number; trimEnd?: number | null; properties?: unknown;
}>): TimelineMap {
  const videos = elements
    .filter((element) => element.type === 'VIDEO' && element.track === 0)
    .sort((left, right) => left.position - right.position ||
      left.startTime - right.startTime);
  const segments: RenderVideoSegment[] = [];
  let cursor = 0;
  for (const element of videos) {
    const sourceStart = Math.max(0, element.trimStart ?? 0);
    const sourceEnd = element.trimEnd == null ? sourceStart + element.duration : element.trimEnd;
    const length = sourceEnd - sourceStart;
    if (!(length > 0)) continue;
    const speed = readSpeed(element.properties);
    const transform = readTransform(element.properties);
    const properties = element.properties && typeof element.properties === 'object'
      ? element.properties as Record<string, unknown> : {};
    const sourceAudio = readSourceAudio(element.properties);
    const span = length / speed;
    segments.push({ elementId: element.id, sourceStart: round(sourceStart),
      sourceEnd: round(sourceEnd), timelineStart: round(cursor),
      timelineEnd: round(cursor + span),
      speed, crop: transform.crop, rotation: transform.rotation,
      flipH: transform.flipH, flipV: transform.flipV,
      scale: readScale(element.properties),
      offsetX: Number(properties.offsetX) || 0, offsetY: Number(properties.offsetY) || 0,
      // Colour and source-audio level travel with the segment for the same
      // reason crop does: a split can leave the two halves graded differently,
      // and one half muted.
      color: readColor(element.properties),
      sourceVolume: sourceAudio.volume, sourceMuted: sourceAudio.muted,
      frameLayout: readFrameLayout(element.properties) });
    cursor += span;
  }
  const durationSec = round(cursor);
  return {
    segments,
    durationSec,
    toSource(timelineSec: number) {
      const segment = segments.find((item) => timelineSec >= item.timelineStart - 1e-6 &&
        timelineSec < item.timelineEnd + 1e-6);
      return segment
        ? segment.sourceStart + (timelineSec - segment.timelineStart) * segment.speed
        : null;
    },
    toTimeline(sourceSec: number) {
      return segments.filter((item) => sourceSec >= item.sourceStart - 1e-6 &&
        sourceSec < item.sourceEnd - 1e-6)
        .map((item) => round(item.timelineStart +
          (sourceSec - item.sourceStart) / item.speed));
    }
  };
}

const remapTrack = (track: VisualTrack, t: number): VisualTrack => ({ ...track, timestamp: t });

/**
 * Analysis frames projected onto the exported timeline.
 *
 * A frame whose source instant was deleted disappears; one inside a range used
 * twice appears twice. This is what lets the camera, the zoom validator and QA
 * all reason about a reordered timeline with the frozen, source-time analysis.
 */
export function remapAnalysisFrames(frames: AnalysisFrame[], map: TimelineMap): AnalysisFrame[] {
  const remapped: AnalysisFrame[] = [];
  for (const frame of frames) {
    for (const t of map.toTimeline(frame.t)) {
      remapped.push({ ...frame, t,
        faces: frame.faces.map((face) => remapTrack(face, t)),
        persons: frame.persons.map((person) => remapTrack(person, t)) });
    }
  }
  return remapped.sort((left, right) => left.t - right.t);
}

/** Source shot boundaries projected onto the exported timeline, plus a boundary
 * at every segment join - a cut between two source ranges is a hard visual
 * discontinuity even when the analysis saw no shot change. */
export function timelineShotBoundaries(sourceBoundaries: number[], map: TimelineMap): number[] {
  const boundaries = new Set<number>();
  for (const segment of map.segments) {
    if (segment.timelineStart > 1e-6) boundaries.add(round(segment.timelineStart));
  }
  for (const boundary of sourceBoundaries) {
    for (const t of map.toTimeline(boundary)) {
      if (t > 1e-6 && t < map.durationSec - 1e-6) boundaries.add(round(t));
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}
