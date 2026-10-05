import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { VisualTrack } from './reframe.service';

// Normalized (0..1) boxes in source-frame coordinates; times are absolute source seconds.
export type TextBox = { x: number; y: number; w: number; h: number };
export type AnalysisFrame = { t: number; faces: VisualTrack[]; persons: VisualTrack[];
  textCoverage: number; textBoxes: TextBox[]; ocrLines: string[]; ocrCoverage?: number;
  edgeDensity?: number; visualLabels?: string[];
  // Large burned-in lettering; used only to keep captions off source graphics.
  graphicBoxes?: TextBox[] };
export type EditAnalysis = {
  source: 'DENSE' | 'STORED_SPARSE' | 'NONE';
  frames: AnalysisFrame[]; shotBoundaries: number[]; ocrText: string;
  fallbackReason: string; runtimeMs: number;
};

type StoredChunk = { startTime: number; endTime: number; visualAnalysis: {
  faceTracks?: unknown; personTracks?: unknown; shotBoundaries?: unknown;
  textAreaRatio?: number; ocrText?: string; subtitleDetected?: boolean } | null };

const finiteTrack = (item: unknown): item is VisualTrack => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const track = item as Record<string, unknown>;
  return ['timestamp', 'x', 'y', 'w', 'h'].every((field) =>
    typeof track[field] === 'number' && Number.isFinite(track[field]));
};

// Builds an analysis from the per-chunk visual analysis rows (sparse samples).
export function analysisFromStoredChunks(chunks: StoredChunk[], start: number, end: number): EditAnalysis {
  const byTime = new Map<number, AnalysisFrame>();
  const boundaries: number[] = [];
  const ocr: string[] = [];
  for (const chunk of chunks) {
    const visual = chunk.visualAnalysis;
    if (!visual) continue;
    // textAreaRatio is stored as a percentage of the frame.
    const coverage = visual.subtitleDetected ? 0 : Math.max(0, Number(visual.textAreaRatio) || 0) / 100;
    if (visual.ocrText) ocr.push(visual.ocrText);
    for (const value of Array.isArray(visual.shotBoundaries) ? visual.shotBoundaries : [])
      if (typeof value === 'number' && value > start && value < end) boundaries.push(value);
    const add = (key: 'faces' | 'persons', raw: unknown) => {
      for (const track of Array.isArray(raw) ? raw.filter(finiteTrack) : []) {
        if (track.timestamp < start - .5 || track.timestamp > end + .5) continue;
        const frame = byTime.get(track.timestamp) ?? { t: track.timestamp, faces: [], persons: [],
          textCoverage: coverage, textBoxes: [], ocrLines: [] };
        frame[key].push(track);
        byTime.set(track.timestamp, frame);
      }
    };
    add('faces', visual.faceTracks);
    add('persons', visual.personTracks);
    if (coverage > 0) {
      const mid = Math.max(start, Math.min(end, (chunk.startTime + chunk.endTime) / 2));
      if (!byTime.has(mid)) byTime.set(mid, { t: mid, faces: [], persons: [], textCoverage: coverage,
        textBoxes: [], ocrLines: [] });
    }
  }
  const frames = [...byTime.values()].sort((a, b) => a.t - b.t);
  return { source: frames.length ? 'STORED_SPARSE' : 'NONE', frames,
    shotBoundaries: [...new Set(boundaries)].sort((a, b) => a - b),
    ocrText: ocr.join(' ').slice(0, 4000), fallbackReason: '', runtimeMs: 0 };
}

type DenseResponse = { frames: Array<{ t: number; faces: Array<Record<string, number | string>>;
  persons: Array<Record<string, number>>; text_coverage: number;
  text_boxes: TextBox[]; graphic_boxes?: TextBox[]; ocr_lines?: string[]; ocr_coverage?: number;
  edge_density?: number; visual_labels?: string[] }>;
  shot_boundaries: number[]; ocr_text: string };

export type DenseAnalysisDeps = {
  uploadFile(input: { filePath: string; objectKey: string; mimeType: string }): Promise<{ bucket: string; objectKey: string }>;
  removeObject(bucket: string, objectKey: string): Promise<void>;
};

// Dense, clip-local face/person/text/shot analysis from the AI service. The
// window file is uploaded to a temporary object and removed afterwards.
export async function requestDenseAnalysis(deps: DenseAnalysisDeps, windowPath: string,
  windowStart: number, windowEnd: number, logger?: Logger): Promise<EditAnalysis | null> {
  if ((process.env.EDIT_DENSE_ANALYSIS_ENABLED ?? 'true').toLowerCase() === 'false') return null;
  const started = Date.now();
  const baseUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
  const objectKey = `tmp/edit-analysis/${randomUUID()}.mp4`;
  let stored: { bucket: string; objectKey: string } | null = null;
  try {
    stored = await deps.uploadFile({ filePath: windowPath, objectKey, mimeType: 'video/mp4' });
    const response = await fetch(`${baseUrl}/edit-analysis`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(Number(process.env.EDIT_ANALYSIS_TIMEOUT_MS) || 300000),
      body: JSON.stringify({ bucket: stored.bucket, object_key: stored.objectKey,
        fps: Number(process.env.EDIT_ANALYSIS_FPS) || 4 })
    });
    if (!response.ok) throw new Error(`edit-analysis ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json() as DenseResponse;
    const toTrack = (t: number) => (box: Record<string, number | string>): VisualTrack => ({
      timestamp: t, x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h),
      confidence: box.score == null ? undefined : Number(box.score),
      mouthActivity: box.mouth_activity == null ? undefined : Number(box.mouth_activity),
      trackId: box.track_id == null ? undefined : String(box.track_id) });
    const frames: AnalysisFrame[] = body.frames.map((frame) => {
      const t = windowStart + frame.t;
      return { t, faces: frame.faces.map(toTrack(t)).filter(finiteTrack),
        persons: frame.persons.map(toTrack(t)).filter(finiteTrack),
        textCoverage: Number(frame.text_coverage) || 0, textBoxes: frame.text_boxes ?? [],
        graphicBoxes: frame.graphic_boxes ?? [],
        ocrLines: frame.ocr_lines ?? [], ocrCoverage: frame.ocr_coverage,
        edgeDensity: frame.edge_density,
        visualLabels: frame.visual_labels ?? [] };
    }).filter((frame) => frame.t <= windowEnd + .05);
    return { source: 'DENSE', frames,
      shotBoundaries: body.shot_boundaries.map((value) => windowStart + value)
        .filter((value) => value > windowStart && value < windowEnd),
      ocrText: body.ocr_text ?? '', fallbackReason: '', runtimeMs: Date.now() - started };
  } catch (error) {
    logger?.warn(`Dense edit analysis unavailable: ${error instanceof Error ? error.message : error}`);
    return null;
  } finally {
    if (stored) await deps.removeObject(stored.bucket, stored.objectKey).catch(() => undefined);
  }
}
