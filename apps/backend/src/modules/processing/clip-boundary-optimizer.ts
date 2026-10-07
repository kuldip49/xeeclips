import { ClipBoundaryService, type BoundaryWord } from '../content-intelligence/clip-boundary.service';
export type TranscriptWord = BoundaryWord;
const service = new ClipBoundaryService();
/** Compatibility adapter. Every candidate path uses the same semantic repair and QA. */
export function optimizeClipBoundaries(candidate: { startTime: number; endTime: number; transcriptText: string }, words: TranscriptWord[]) {
  const result = service.repair(candidate, words);
  return { ...result, openingStrength: result.qa.START_COMPLETE && result.qa.CONTEXT_SUFFICIENT ? 85 : 25,
    endingStrength: result.qa.END_COMPLETE && result.qa.THOUGHT_COMPLETE ? 90 : 20,
    leadingTrimmedMs: Math.round(Math.max(0, result.startAdjustment) * 1000),
    trailingWasteMs: Math.round(Math.max(0, -result.endAdjustment) * 1000) };
}
