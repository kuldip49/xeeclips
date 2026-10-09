import type { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import type { TailRequest } from '../content-intelligence/clip-boundary.service';
import { tailPassFromResponse, type Correction, type TailPass } from '../content-intelligence/ending-evidence';
import { postAiServiceJson } from './ai-service-http';

type StoredSegment = { id: string; start: number; end: number; text?: string; words: unknown };
type TimedWord = { start: number; end: number; text: string; confidence?: number | null; tailPass?: TailPass; strongTail?: TailPass;
  correction?: Correction; asrText?: string };
type Video = { id: string; audioBucket: string | null; audioObjectKey: string | null };

/**
 * Bounded tail checks for clip endings, shared by analysis and export.
 *
 * - One window of at most ~9 s per request, never the whole source, never a loop.
 * - Cached per media identity (video + audio object), tail interval and model: in memory for this probe, and persistently on the
 *   transcript word (`tailPass` for the normal model, `strongTail` for the stronger one), so later stages and reruns reuse it.
 * - A failure returns null and the strict verdict stands; it never throws into the pipeline.
 * - A correction never overwrites history: the base reading stays in `asrText` / `asrConfidence` and `correction` records the provenance.
 */
export class EndingTailProbe {
  private readonly cache = new Map<string, Promise<TailPass | null>>();
  private readonly aiServiceUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
  constructor(private readonly prisma: PrismaService, private readonly logger: Logger) {}

  verifier(video: Video, segments: StoredSegment[], words: TimedWord[], model: 'base' | 'strong') {
    return (request: TailRequest): Promise<TailPass | null> => {
      const key = ['acoustics-v2', video.id, video.audioBucket, video.audioObjectKey, request.wordStart, request.wordEnd,
        request.windowStart, request.windowEnd, model,
        model === 'strong' ? process.env.WHISPER_TAIL_MODEL_NAME ?? 'strong' : process.env.WHISPER_MODEL ?? 'base',
        model === 'strong' ? process.env.WHISPER_TAIL_MODEL_VERSION ?? '1' : process.env.WHISPER_MODEL_VERSION ?? '1'].join('|');
      let known = this.cache.get(key);
      if (!known) this.cache.set(key, known = this.fetch(video, segments, words, request, model, key));
      return known;
    };
  }

  private async fetch(video: Video, segments: StoredSegment[], words: TimedWord[], request: TailRequest, model: 'base' | 'strong', cacheKey: string): Promise<TailPass | null> {
    const word = words.find(w => w.start === request.wordStart && w.end === request.wordEnd);
    const stored = model === 'base' ? word?.tailPass : word?.strongTail;
    if (stored?.cacheKey === cacheKey) return stored;
    if (process.env.ENDING_TAIL_VERIFICATION_ENABLED?.toLowerCase() === 'false' || !video.audioBucket || !video.audioObjectKey) return null;
    if (model === 'strong' && process.env.ENDING_STRONG_TAIL_ENABLED?.toLowerCase() === 'false') return null;
    try {
      const transcript = await this.prisma.transcript.findUnique({ where: { videoId: video.id }, select: { language: true } });
      const response = await postAiServiceJson(`${this.aiServiceUrl}/tail-transcriptions`, {
        bucket: video.audioBucket, object_key: video.audioObjectKey, window_start: request.windowStart, window_end: request.windowEnd,
        final_word_end: request.wordEnd, task: 'transcribe', model, ...(transcript?.language ? { language: transcript.language } : {}) },
      Math.min(Number(process.env.AI_SERVICE_TIMEOUT_MS) || 120_000, model === 'strong' ? 300_000 : 120_000));
      if (!response.ok) {
        this.logger.warn(`Ending tail check (${model}) unavailable (${response.status}); the strict ending verdict stands`);
        return null;
      }
      const pass = tailPassFromResponse(await response.json(), request.wordEnd);
      if (!pass) return null;
      pass.cacheKey = cacheKey;
      await this.storeOnWord(segments, request, word, model === 'base' ? { tailPass: pass } : { strongTail: pass });
      this.logger.log(JSON.stringify({ event: 'ending_tail_check', model: pass.model ?? model, wordEnd: request.wordEnd,
        window: [pass.windowStart, pass.windowEnd], words: pass.words.length, eof: pass.acoustics.eof ?? null }));
      return pass;
    } catch (error) {
      this.logger.warn(`Ending tail check (${model}) failed: ` + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }

  /** Persist an adopted or confirmed correction (with provenance) on the transcript word and its segment text. */
  async persistCorrection(segments: StoredSegment[], words: TimedWord[], correction: Correction, strong: TailPass | undefined): Promise<void> {
    const word = words.find(w => w.start === correction.wordStart && w.end === correction.wordEnd);
    const patch: Record<string, unknown> = { correction, ...(strong ? { strongTail: strong } : {}) };
    if (correction.kind === 'ADOPT') Object.assign(patch, { asrText: word?.asrText ?? correction.from, asrConfidence: correction.originalConfidence,
      text: correction.to, confidence: correction.confidence });
    await this.storeOnWord(segments, correction, word, patch, correction.kind === 'ADOPT' ? { from: correction.from, to: correction.to } : undefined);
  }

  private async storeOnWord(segments: StoredSegment[], at: { wordStart?: number; wordEnd?: number; start?: number; end?: number },
    word: TimedWord | undefined, patch: Record<string, unknown>, replaceText?: { from: string; to: string }) {
    const start = at.wordStart ?? at.start!, end = at.wordEnd ?? at.end!;
    const segment = segments.find(s => s.start <= start + .001 && s.end >= end - .001 && Array.isArray(s.words));
    if (word) Object.assign(word, patch);
    if (!segment) return;
    const stored = (segment.words as Array<Record<string, unknown>>).map(w => w.start === start && w.end === end ? { ...w, ...patch } : w);
    const data: Prisma.TranscriptSegmentUpdateInput = { words: stored as unknown as Prisma.InputJsonValue };
    if (replaceText && typeof segment.text === 'string' && segment.text.includes(replaceText.from))
      data.text = segment.text.slice(0, segment.text.lastIndexOf(replaceText.from)) + replaceText.to
        + segment.text.slice(segment.text.lastIndexOf(replaceText.from) + replaceText.from.length);
    await this.prisma.transcriptSegment.update({ where: { id: segment.id }, data });
    segment.words = stored;
    if (data.text) segment.text = data.text as string;
  }
}
