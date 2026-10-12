// A styled project (StyleOne / StyleTwo) persists time-keyed geometry beside its elements:
// `resolvedVisualLayout.cameraPath` (the camera crop the PREVIEW follows) and, for StyleTwo,
// `frameSegments` (which spans are fitted vs filled). Both are written in EXPORTED-TIMELINE seconds at
// the moment the style was applied.
//
// The export never reads them - it recomputes the camera from the cached analysis on the CURRENT
// timeline - so after any edit that moves footage on the timeline (a trim, a split, a ripple delete, a
// speed change, a reorder) the preview would keep following the camera of the OLD timeline while the
// export follows the new one. This module re-keys that geometry through SOURCE time: an instant of the
// old timeline is the source second it showed, and that second's place on the new timeline is where the
// keyframe now belongs. Footage that no longer exists on the timeline drops out; the new edges are
// interpolated from the old path. Pure; no I/O.

import { buildRenderPlan } from './render/edit-mode-render-plan';
import { buildTimelineMap, type TimelineMap } from './render/edit-mode-timeline-map';

type MapInput = Parameters<typeof buildTimelineMap>[0];
type Key = { t: number; x: number; y: number; w: number; h: number; [extra: string]: unknown };
type FrameSegment = { startSec: number; endSec: number; layout: string; [extra: string]: unknown };

const EPS = 1e-6;
const round = (value: number) => Number(value.toFixed(4));
const isKey = (value: unknown): value is Key => !!value && typeof value === 'object' &&
  ['t', 'x', 'y', 'w', 'h'].every((field) => Number.isFinite(Number((value as Record<string, unknown>)[field])));

/** The path sampled at `t`, linearly between neighbours and held at both ends - how the preview reads it. */
function sample(path: Key[], t: number): Key {
  if (t <= path[0].t) return path[0];
  const last = path[path.length - 1];
  if (t >= last.t) return last;
  const after = path.findIndex((key) => key.t >= t);
  const right = path[after], left = path[after - 1];
  const mix = (t - left.t) / Math.max(1e-3, right.t - left.t);
  return { ...left, t, x: left.x + (right.x - left.x) * mix, y: left.y + (right.y - left.y) * mix,
    w: left.w + (right.w - left.w) * mix, h: left.h + (right.h - left.h) * mix };
}

/** Old-timeline instant that shows the same SOURCE second as new-timeline instant `t`, if any. */
function oldInstantOf(t: number, now: TimelineMap, was: TimelineMap): number | null {
  const source = now.toSource(Math.min(t, Math.max(0, now.durationSec - EPS)));
  if (source == null) return null;
  const found = was.toTimeline(source);
  return found.length ? found[0] : null;
}

const signature = (map: TimelineMap) => JSON.stringify(map.segments.map((segment) => [segment.sourceStart,
  segment.sourceEnd, segment.timelineStart, segment.timelineEnd, segment.speed]));

/**
 * The layout re-keyed for the new VIDEO track, or null when nothing needs to change (the VIDEO track did
 * not move any footage, or the layout carries no time-keyed geometry).
 */
export function retimeResolvedLayout(layout: unknown, before: MapInput, after: MapInput):
  Record<string, unknown> | null {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return null;
  const source = layout as Record<string, unknown>;
  const cameraPath = Array.isArray(source.cameraPath) ? source.cameraPath.filter(isKey) as Key[] : [];
  const frameSegments = Array.isArray(source.frameSegments)
    ? source.frameSegments.filter((item): item is FrameSegment => !!item && typeof item === 'object' &&
      Number.isFinite(Number((item as FrameSegment).startSec)) && Number.isFinite(Number((item as FrameSegment).endSec))) : [];
  if (!cameraPath.length && !frameSegments.length) return null;
  const was = buildTimelineMap(before), now = buildTimelineMap(after);
  if (!now.segments.length || signature(was) === signature(now)) return null;
  const total = now.durationSec;
  const next: Record<string, unknown> = { ...source };

  if (cameraPath.length) {
    const sorted = [...cameraPath].sort((a, b) => a.t - b.t);
    const keys = new Map<number, Key>();
    const put = (key: Key) => { keys.set(round(key.t), { ...key, t: round(key.t),
      x: round(key.x), y: round(key.y), w: round(key.w), h: round(key.h) }); };
    // Every old keyframe that still has footage on the timeline moves with that footage.
    for (const key of sorted) {
      const second = was.toSource(key.t);
      if (second == null) continue;
      const placed = now.toTimeline(second)[0];
      if (placed !== undefined && placed >= -EPS && placed <= total + EPS) put({ ...key, t: Math.min(total, Math.max(0, placed)) });
    }
    // The new edges, and every join between segments, take the camera the old path had there.
    const anchors = new Set<number>([0, total]);
    for (const segment of now.segments) { anchors.add(segment.timelineStart); anchors.add(Math.max(0, segment.timelineEnd - 0.001)); }
    for (const anchor of anchors) {
      const old = oldInstantOf(anchor, now, was);
      if (old != null) put({ ...sample(sorted, old), t: anchor });
    }
    if (keys.size) next.cameraPath = [...keys.values()].sort((a, b) => a.t - b.t);
  }

  if (frameSegments.length) {
    const sorted = [...frameSegments].sort((a, b) => a.startSec - b.startSec);
    const layoutAt = (oldT: number) => (sorted.find((item) => oldT >= item.startSec - EPS && oldT < item.endSec - EPS)
      ?? sorted[sorted.length - 1]).layout;
    const breaks = new Set<number>([0, total]);
    for (const segment of now.segments) { breaks.add(segment.timelineStart); breaks.add(segment.timelineEnd); }
    for (const item of sorted) for (const edge of [item.startSec, item.endSec]) {
      const second = was.toSource(Math.min(edge, Math.max(0, was.durationSec - EPS)));
      const placed = second == null ? undefined : now.toTimeline(second)[0];
      if (placed !== undefined && placed > EPS && placed < total - EPS) breaks.add(placed);
    }
    const edges = [...breaks].filter((t) => t >= -EPS && t <= total + EPS).sort((a, b) => a - b);
    const out: FrameSegment[] = [];
    for (let i = 0; i + 1 < edges.length; i++) {
      const start = edges[i], end = edges[i + 1];
      if (end - start < EPS) continue;
      const old = oldInstantOf((start + end) / 2, now, was);
      const layoutName = old == null ? out[out.length - 1]?.layout ?? sorted[0].layout : layoutAt(old);
      const last = out[out.length - 1];
      if (last && last.layout === layoutName && Math.abs(last.endSec - start) < 1e-3) last.endSec = round(end);
      else out.push({ startSec: round(start), endSec: round(end), layout: layoutName });
    }
    if (out.length) next.frameSegments = out;
  }
  return next;
}

type PlanAssetRow = { id: string; role: string; mimeType: string; duration: number | null; width: number | null;
  height: number | null; fps: number | null; metadata: unknown; transcript: unknown; analysis: unknown };
type PlanElementRow = { id: string; assetId?: string | null; type: string; track: number; position: number;
  startTime: number; duration: number; trimStart?: number; trimEnd?: number | null; properties?: unknown };

/**
 * The layout a styled project should carry after its VIDEO track moved footage.
 *
 * The persisted camera path is what the PREVIEW follows, and the export re-plans the camera on the
 * current timeline (speaker punches, shot changes and the smoothing all depend on it), so re-keying the
 * old path cannot reproduce it. For a StyleOne / StyleTwo project the path is therefore RECOMPUTED with
 * the very planner the export runs, sampled exactly as the style compiler samples it. Quick Reframe's
 * fixed whole-frame camera, and any project whose analysis is missing, fall back to re-keying the old
 * geometry through source time (`retimeResolvedLayout`). Returns null when nothing needs to change.
 */
export function refreshStyledLayout(input: {
  settings: Record<string, unknown>; assets: PlanAssetRow[]; before: PlanElementRow[]; after: PlanElementRow[];
  revision: number; projectId: string;
}): Record<string, unknown> | null {
  const layout = input.settings.resolvedVisualLayout as Record<string, unknown> | undefined;
  if (!layout || typeof layout !== 'object' || !Array.isArray(layout.cameraPath)) return null;
  const retimed = retimeResolvedLayout(layout, input.before, input.after);
  if (!retimed) return null;
  const profile = layout.editingProfile;
  const planned = (profile === 'AUTOMATIC_2' || profile === 'AUTOMATIC_3_STYLE_TWO') &&
    input.settings.quickReframeStyleOne !== true && input.settings.quickReframeStyleTwo !== true;
  if (!planned) return retimed;
  try {
    const built = buildRenderPlan({ project: { id: input.projectId, revision: input.revision, settings: input.settings },
      assets: input.assets, elements: input.after as never, hasSourceAudio: true, fps: 30 });
    const duration = built.plan.durationSec;
    if (!(duration > 0) || !built.evidence.cropAt) return retimed;
    const times = new Set<number>();
    for (let t = 0; t <= duration + 1e-6; t += 0.1) times.add(Number(Math.min(t, duration).toFixed(3)));
    built.evidence.speakerSegments?.slice(1).forEach((segment: { startSec: number }) => times.add(segment.startSec));
    const cameraPath = [...times].sort((a, b) => a - b).map((t) => {
      const crop = built.evidence.cropAt(t);
      return { t, x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    });
    const next: Record<string, unknown> = { ...layout, cameraPath };
    if (profile === 'AUTOMATIC_3_STYLE_TWO') {
      const source = input.assets.find((asset) => asset.role === 'SOURCE');
      next.frameSegments = built.plan.frameSegments.map(({ startSec, endSec, layout: kind }) => ({ startSec, endSec, layout: kind }));
      const crop = built.evidence.informationCrop;
      next.informationCrop = crop && source?.width && source?.height ? { x: crop.x / source.width, y: crop.y / source.height,
        w: crop.width / source.width, h: crop.height / source.height } : null;
    }
    return next;
  } catch { return retimed; }
}
