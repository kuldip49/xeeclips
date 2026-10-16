import { transcriptBoundaryWords } from '../content-intelligence/clip-boundary.service';
import { applyCorrection, assessEnding, ASR_ENDING_POLICY, decideTailCorrection, tailPassFromResponse } from '../content-intelligence/ending-evidence';
import { record } from './quick-reframe-plan';

/** Reuse the current local ending checks without selecting, shortening or splitting the user's full video. */
export async function refineReframeTranscript(value: unknown, duration: number,
  request: (body: { model: 'base' | 'strong'; window_start: number; window_end: number; final_word_end: number }) => Promise<unknown>) {
  const transcript = record(value);
  if (record(transcript.quickReframeTail).version === 1) return value;
  const segments = (Array.isArray(transcript.segments) ? transcript.segments : []).map(record);
  let words = transcriptBoundaryWords(segments);
  const last = words.at(-1);
  if (!last || last.correction) return value;
  const assessed = assessEnding({ words, index: words.length - 1, startIndex: 0, sourceEnd: duration });
  // Missing probabilities are not invented, and low probability alone is not a reason to rerun ASR.
  if (assessed.state === 'ASR_RELIABLE' || typeof last.confidence !== 'number' || last.confidence >= ASR_ENDING_POLICY.lowConfidence) return value;
  const window = { window_start: Math.max(0, last.end - 8), window_end: Math.min(duration, last.end + 1), final_word_end: last.end };
  const base = tailPassFromResponse(await request({ ...window, model: 'base' }).catch(() => null), last.end);
  if (base) words = words.map(word => word === last ? { ...word, tailPass: base } : word);
  const checked = assessEnding({ words, index: words.length - 1, startIndex: 0, sourceEnd: duration });
  const strong = base && checked.state !== 'ASR_RELIABLE' && base.acoustics.speechContinues !== true && base.acoustics.eof !== 'VOICE_CONTINUING'
    ? tailPassFromResponse(await request({ ...window, model: 'strong' }).catch(() => null), last.end) : null;
  const decision = strong ? decideTailCorrection(words, words.length - 1, strong) : null;
  if (strong && decision?.correction) words = applyCorrection(words, decision.correction, strong);
  const final = words.at(-1)!;
  const revised = segments.map(segment => {
    if (!Array.isArray(segment.words)) return segment;
    let changed = false;
    const updated = segment.words.map(raw => {
      const word = record(raw);
      if (Number(word.start) !== last.start || Number(word.end) !== last.end) return raw;
      changed = true; return { ...word, ...final, ...(strong ? { strongTail: strong } : {}) };
    });
    return changed ? { ...segment, words: updated, text: updated.map(raw => String(record(raw).text ?? '')).join(' ') } : segment;
  });
  return { ...transcript, segments: revised,
    ...(typeof transcript.text === 'string' ? { text: revised.map(segment => String(segment.text ?? '')).join(' ') } : {}),
    quickReframeTail: { version: 1, state: checked.state, strongChecked: !!strong, corrected: !!decision?.correction } };
}
