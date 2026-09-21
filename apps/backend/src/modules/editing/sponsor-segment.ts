import type { TimedWord } from './edit-plan';

export type SponsorSegmentDecision = {
  detected: boolean; trimmed: boolean; rejected: boolean;
  startSec: number | null; endSec: number | null; confidence: number; reason: string;
  trimStartTo?: number; trimEndTo?: number;
};

const SPONSOR = /^(?:this (?:video|episode|show) is sponsored by|sponsored by|thanks to (?:our )?sponsor|brought to you by|today'?s sponsor|our partner|use (?:the )?code|promo code|link in (?:the )?description|free trial|limited time offer)\b/iu;
const PROMO_OCR = /\b(?:sponsor(?:ed)?|promo code|use code|shop now|limited offer|free trial)\b/iu;
const terminal = (text: string) => /[.!?]["')\]]?$/u.test(text.trim());

/** Detects explicit promotional interruptions inside the already-selected edit
 * window. It does not discover or rank clips; it only protects final delivery. */
export function detectSponsorSegment(input: { words: TimedWord[]; candidateStart: number;
  candidateEnd: number; ocrText?: string; shotBoundaries?: number[] }): SponsorSegmentDecision {
  const words = input.words.filter((word) => word.end > input.candidateStart &&
    word.start < input.candidateEnd).sort((a, b) => a.start - b.start);
  const hit = words.findIndex((_, index) => SPONSOR.test(words.slice(index, index + 9)
    .map((word) => word.text).join(' ')));
  const ocrSignal = PROMO_OCR.test(input.ocrText ?? '');
  if (hit < 0) return { detected: false, trimmed: false, rejected: false,
    startSec: null, endSec: null, confidence: ocrSignal ? .35 : 0,
    reason: ocrSignal ? 'OCR_PROMO_CUE_WITHOUT_TRANSCRIPT_MATCH' : 'NO_SPONSOR_SIGNAL' };

  let first = hit;
  while (first > 0 && !terminal(words[first - 1].text) &&
    words[hit].start - words[first - 1].start < 10) first--;
  let last = Math.min(words.length - 1, hit + 8);
  while (last < words.length - 1 && !terminal(words[last].text) &&
    words[last + 1].end - words[hit].start < 14) last++;
  const startSec = Math.max(input.candidateStart, words[first].start);
  const endSec = Math.min(input.candidateEnd, words[last].end);
  const duration = input.candidateEnd - input.candidateStart;
  const leading = startSec <= input.candidateStart + Math.min(3, duration * .2);
  const trailing = endSec >= input.candidateEnd - Math.min(3, duration * .2);
  const nextShot = (input.shotBoundaries ?? []).find((time) => time >= endSec - .4 && time <= endSec + 1);
  const previousShot = [...(input.shotBoundaries ?? [])].reverse()
    .find((time) => time <= startSec + .4 && time >= startSec - 1);
  const confidence = Math.min(1, .82 + (ocrSignal ? .1 : 0) +
    (nextShot != null || previousShot != null ? .08 : 0));
  if (leading) {
    const trimStartTo = nextShot ?? endSec;
    if (input.candidateEnd - trimStartTo >= 15) return { detected: true, trimmed: true,
      rejected: false, startSec, endSec, confidence, reason: 'LEADING_SPONSOR_TRIMMED', trimStartTo };
  }
  if (trailing) {
    const trimEndTo = previousShot ?? startSec;
    if (trimEndTo - input.candidateStart >= 15) return { detected: true, trimmed: true,
      rejected: false, startSec, endSec, confidence, reason: 'TRAILING_SPONSOR_TRIMMED', trimEndTo };
  }
  return { detected: true, trimmed: false, rejected: true, startSec, endSec, confidence,
    reason: 'INTERNAL_SPONSOR_BREAK_REJECTED' };
}
