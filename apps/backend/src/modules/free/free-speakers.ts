/**
 * Active-speaker stability for XeeFree camera switching.
 *
 * Speaker-change times come from the transcript's diarization labels. Raw labels flicker: a one-word "yeah" from the other person, or a
 * mislabelled segment, produces an A->B->A pair a second apart that would make the camera cut away and straight back. A shot that short
 * reads as a glitch, so a change that is reversed within `minShotSec` is a blip and cancels with its reversal. What remains is a set of
 * changes at least `minShotSec` apart, each followed by a stable speaker. Nothing here identifies a person: it only looks at when the
 * label changed.
 *
 * The camera service then adds its own confirmation count and minimum hold on top, so this is the first of two hysteresis layers.
 */
export const SPEAKER_STABILITY = { minShotSec: 1.6, maxBlipSec: 1.6 } as const;

export function stabilizeSpeakerChanges(times: number[], options: { minShotSec?: number } = {}): { times: number[]; dropped: number } {
  const minShot = options.minShotSec ?? SPEAKER_STABILITY.minShotSec;
  const sorted = [...new Set(times.filter(t => Number.isFinite(t) && t >= 0))].sort((a, b) => a - b);
  const kept: number[] = [];
  let dropped = 0;
  for (const t of sorted) {
    // A change followed within minShot by another change is a blip: the pair cancels and the earlier speaker stays on screen.
    if (kept.length && t - kept[kept.length - 1] < minShot) { kept.pop(); dropped += 2; continue; }
    kept.push(t);
  }
  return { times: kept, dropped };
}

/** The shortest gap between consecutive changes, i.e. the shortest shot the stabilised plan can contain (Infinity with fewer than two). */
export const shortestShot = (times: number[]) => times.length < 2 ? Infinity : Math.min(...times.slice(1).map((t, i) => t - times[i]));
