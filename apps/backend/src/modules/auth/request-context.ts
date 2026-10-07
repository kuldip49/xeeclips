import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestIdentity = { userId?: string; admin?: boolean; adminView?: boolean };
export const requestIdentity = new AsyncLocalStorage<RequestIdentity>();

/** All HTTP queries are scoped. Queue workers have no HTTP context and are trusted internally. */
export function ownerFilter(model: string, userId: string): Record<string, unknown> | null {
  if (['Project', 'EditProject', 'ReferenceAsset', 'SavedStyle', 'EditTemplate'].includes(model)) return { userId };
  if (['Video', 'VideoImport'].includes(model)) return { project: { userId } };
  if (['ProcessingJob', 'VideoProcessingStage', 'Transcript', 'TranscriptChunk', 'VideoUnderstanding', 'ClipCandidate', 'GeneratedClip'].includes(model)) return { video: { project: { userId } } };
  if (['QuickReframe', 'EditAsset', 'EditElement', 'EditHistory'].includes(model)) return { editProject: { userId } };
  if (model === 'TranscriptSegment') return { transcript: { video: { project: { userId } } } };
  if (['ChunkAnalysis', 'VisualAnalysis'].includes(model)) return { chunk: { video: { project: { userId } } } };
  if (model === 'VideoUnderstandingChapter') return { understanding: { video: { project: { userId } } } };
  return null;
}
