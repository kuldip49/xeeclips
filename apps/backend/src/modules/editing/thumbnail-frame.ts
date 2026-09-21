import type { AnalysisFrame } from './edit-analysis';
import type { Shot } from './shot-classifier';

export type ThumbnailChoice = { atSec: number; reason: string; faceArea: number | null;
  textCoverage: number | null; score: number | null };

// Picks the frame the clip's cover is cut from. A cover is not a random grab:
// it wants a visible, reasonably large subject, no motion blur from a shot cut,
// and - on information-heavy clips, where the graphic *is* the point - the most
// readable frame rather than the biggest face.
export function chooseThumbnailTime(input: {
  frames: AnalysisFrame[]; shots: Shot[]; finalDuration: number;
  toFinal: (sourceTime: number) => number; removed: (start: number, end: number) => boolean;
  informationHeavy?: boolean }): ThumbnailChoice {
  const { frames, shots, finalDuration } = input;
  // Never the very first or last moments: entrances and endings are rarely the
  // strongest frame, and the hook is still animating in at the start.
  const earliest = Math.min(.8, finalDuration * .12);
  const latest = Math.max(earliest + .01, finalDuration - .6);
  const fallback = { atSec: Math.min(latest, Math.max(earliest, finalDuration * .4)),
    reason: 'NO_ANALYSIS_FRAMES', faceArea: null, textCoverage: null, score: null };
  if (!frames.length || finalDuration <= .2) return fallback;
  const cutTimes = shots.flatMap((shot) => [shot.start, shot.end]);
  let best: ThumbnailChoice | null = null;
  for (const frame of frames) {
    if (input.removed(frame.t, frame.t + .001)) continue;
    const t = input.toFinal(frame.t);
    if (!(t >= earliest && t <= latest)) continue;
    const subjects = frame.faces.length ? frame.faces : frame.persons;
    const largest = subjects.reduce((max, track) => Math.max(max, track.w * track.h), 0);
    const centered = subjects.length ? 1 - Math.min(1, Math.abs(
      subjects.reduce((sum, track) => sum + track.x + track.w / 2, 0) / subjects.length - .5) * 2) : 0;
    // Shot cuts carry motion blur and half-formed expressions.
    const cutDistance = cutTimes.length ? Math.min(...cutTimes.map((cut) => Math.abs(cut - t))) : 1;
    let score = 0;
    if (frame.faces.length) score += Math.min(.14, largest) * 24 + centered * 1.2;
    else score += Math.min(.3, largest) * 5 + centered * .5;
    score += input.informationHeavy ? frame.textCoverage * 6 : -frame.textCoverage * 2;
    score += Math.min(1, cutDistance / .5) * .8;
    // Mild preference for the body of the clip over its edges.
    const position = t / Math.max(.001, finalDuration);
    score += position >= .15 && position <= .75 ? .4 : 0;
    if (!best || score > best.score! + 1e-6) best = { atSec: Number(t.toFixed(3)),
      reason: frame.faces.length ? 'SUBJECT_FRAME' : input.informationHeavy ?
        'INFORMATION_FRAME' : 'BEST_AVAILABLE_FRAME',
      faceArea: Number(largest.toFixed(4)), textCoverage: Number(frame.textCoverage.toFixed(4)),
      score: Number(score.toFixed(4)) };
  }
  return best ?? fallback;
}
