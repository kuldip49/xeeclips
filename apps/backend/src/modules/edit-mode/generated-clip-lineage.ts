import { buildTimelineMap } from './render/edit-mode-timeline-map';

export type GeneratedClipSourceMode = 'ORIGINAL_VIDEO' | 'FLATTENED_GENERATED_OUTPUT';

export type GeneratedClipLineage = {
  schemaVersion: 1;
  originKind: 'GENERATED_CLIP';
  sourceMode: GeneratedClipSourceMode;
  generatedClipId: string;
  originalVideoId: string;
  clipCandidateId: string | null;
  generatedStart: number;
  generatedEnd: number;
  generatedDuration: number;
  currentSourceStart: number;
  currentSourceEnd: number;
  processingType: string;
  variantKey: string;
  aspectRatio: string;
  targetPlatform: string | null;
  [key: string]: unknown;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

export function readGeneratedClipLineage(settings: unknown): GeneratedClipLineage | null {
  const origin = record(record(settings)?.origin);
  if (!origin || origin.originKind !== 'GENERATED_CLIP' || origin.schemaVersion !== 1 ||
    (origin.sourceMode !== 'ORIGINAL_VIDEO' && origin.sourceMode !== 'FLATTENED_GENERATED_OUTPUT') ||
    typeof origin.generatedClipId !== 'string' || typeof origin.originalVideoId !== 'string') return null;
  return origin as GeneratedClipLineage;
}

/** Canonical timeline -> original-video mapping. Flattened AI output deliberately
 * returns null because Step 3 does not reconstruct its edit plan. */
export function buildOriginalSourceMap(settings: unknown, elements: Parameters<typeof buildTimelineMap>[0]) {
  const lineage = readGeneratedClipLineage(settings);
  const timeline = buildTimelineMap(elements);
  return {
    ...timeline,
    lineage,
    toOriginal(timelineSec: number) {
      return lineage?.sourceMode === 'ORIGINAL_VIDEO' ? timeline.toSource(timelineSec) : null;
    },
    toTimelineFromOriginal(originalSec: number) {
      return lineage?.sourceMode === 'ORIGINAL_VIDEO' ? timeline.toTimeline(originalSec) : [];
    }
  };
}
