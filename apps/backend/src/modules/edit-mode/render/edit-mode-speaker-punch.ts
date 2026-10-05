// Automatic 2 speaker punch-in.
//
// The tracked camera solves the widest crop that fills the card (about 87% of a 16:9
// frame), so a talking head stays small. Automatic 2 tightens that crop on the person the
// camera is following: the face fills a set share of the card, and the framing alternates
// between a medium-close and a close-up at sentence ends so long takes do not sit static.
//
// Every interval is validated against the analysis frames before it is kept: the target
// face stays whole with headroom, and no other face is left half-cut (each is either fully
// inside the tighter window or clearly outside it). An interval that cannot be made safe
// keeps the camera's own framing. Two-person framing (the camera holding a pair) is never
// punched. Automatic 1 never calls this.

import type { AnalysisFrame } from '../../editing/edit-analysis';
import type { CropWindow } from '../../editing/reframe.service';
import { zoomWindow } from '../../editing/zoom-planner';
import type { RenderFrameSegment } from './edit-mode-render.types';
import type { TimelineMap } from './edit-mode-timeline-map';

export const AUTOMATIC_2_PUNCH = {
  /** Face height as a share of the card: close-up and medium-close. */
  closeFaceHeight: 0.40,
  mediumFaceHeight: 0.31,
  maxScale: 1.8,
  /** A smaller tightening is not worth a reframe; the camera's framing is kept. */
  minScale: 1.1,
  scaleStep: 0.04,
  /** Where the face centre sits in the tightened window. */
  faceCenterX: 0.5,
  faceCenterY: 0.45,
  minIntervalSec: 1.5,
  /** Framing changes only at a sentence end, at most this often. */
  beatSpacingSec: 6,
  minTailSec: 3,
  headroom: 0.10,
  targetInside: 0.97,
  /** Another face must be at least this inside, or at most `otherOutside` inside. */
  otherInside: 0.97,
  otherOutside: 0.35,
  minFaceArea: 0.0015,
  /** Adjacent same-subject intervals closer than this ratio would read as a glitch. */
  minVisibleChange: 1.12
} as const;

export type SpeakerPunch = { startSec: number; endSec: number; scale: number;
  anchorX: number; anchorY: number; framing: 'CLOSE' | 'MEDIUM'; trackId: string | null };

type Box = { x: number; y: number; w: number; h: number; trackId?: string | null };
type SpeakerSegment = { startSec: number; endSec: number;
  targetFace: { x: number; y: number; w: number; h: number }; trackId: string | null };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const round = (value: number) => Number(value.toFixed(4));
const inside = (box: Box, window: CropWindow) => {
  const w = Math.max(0, Math.min(box.x + box.w, window.x + window.w) - Math.max(box.x, window.x));
  const h = Math.max(0, Math.min(box.y + box.h, window.y + window.h) - Math.max(box.y, window.y));
  return box.w * box.h > 0 ? w * h / (box.w * box.h) : 1;
};
const centre = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** Sentence ends on the exported timeline (source words -> timeline seconds). */
export function sentenceBeats(words: Array<{ text: string; end: number }>, map: TimelineMap) {
  return words.filter((word) => /[.?!]["'”’)]*$/u.test(word.text.trim()))
    .flatMap((word) => map.toTimeline(word.end)).sort((a, b) => a - b);
}

/** Zoom anchor that puts a crop-relative point at `target` in a window `scale` times tighter. */
const anchorFor = (point: number, target: number, scale: number) =>
  clamp((point - target / scale) / (1 - 1 / scale), 0, 1);

export function planSpeakerPunch(input: {
  frames: AnalysisFrame[]; frameSegments: RenderFrameSegment[];
  speakerSegments: SpeakerSegment[]; cropAt: (t: number) => CropWindow;
  beats: number[]; durationSec: number;
}): SpeakerPunch[] {
  const P = AUTOMATIC_2_PUNCH;
  // 1. Candidate intervals: FILL shots with a face, split at camera speaker switches and
  //    then at sentence ends so the framing can alternate.
  const raw: Array<{ startSec: number; endSec: number; segment: SpeakerSegment | null }> = [];
  for (const shot of input.frameSegments) {
    if (shot.layout !== 'FILL' || shot.faceCount < 1) continue;
    const cuts = [shot.startSec, ...input.speakerSegments.map((segment) => segment.startSec)
      .filter((t) => t > shot.startSec + P.minIntervalSec && t < shot.endSec - P.minIntervalSec),
    shot.endSec].sort((a, b) => a - b);
    for (let index = 0; index < cuts.length - 1; index++) {
      const start = cuts[index];
      const end = cuts[index + 1];
      const mid = (start + end) / 2;
      const segment = input.speakerSegments.find((item) =>
        mid >= item.startSec - 1e-6 && mid <= item.endSec + 1e-6) ?? null;
      let from = start;
      for (const beat of input.beats) {
        if (beat - from >= P.beatSpacingSec && end - beat >= P.minTailSec) {
          raw.push({ startSec: from, endSec: beat, segment });
          from = beat;
        }
      }
      raw.push({ startSec: from, endSec: end, segment });
    }
  }

  // 2. Fit each interval, alternating medium/close within one continuous take.
  const fit = (startSec: number, endSec: number, segment: SpeakerSegment | null,
    framing: 'CLOSE' | 'MEDIUM'): SpeakerPunch | null => {
    if (endSec - startSec < P.minIntervalSec) return null;
    if (segment?.trackId === 'pair') return null;
    const frames = input.frames.filter((frame) => frame.t >= startSec && frame.t < endSec);
    const samples = frames.flatMap((frame) => {
      const faces = frame.faces.filter((face) => face.w * face.h >= P.minFaceArea);
      if (!faces.length) return [];
      const reference = segment?.targetFace ?? faces.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
      const target = (segment?.trackId && faces.find((face) => face.trackId === segment.trackId)) ||
        faces.slice().sort((a, b) => Math.hypot(centre(a).x - centre(reference).x,
          centre(a).y - centre(reference).y) - Math.hypot(centre(b).x - centre(reference).x,
          centre(b).y - centre(reference).y))[0];
      return [{ t: frame.t, target, others: faces.filter((face) => face !== target) }];
    });
    if (samples.length < 2) return null;
    const relative = samples.map((sample) => {
      const crop = input.cropAt(sample.t);
      return { x: (centre(sample.target).x - crop.x) / crop.w,
        y: (centre(sample.target).y - crop.y) / crop.h, h: sample.target.h / crop.h };
    });
    const faceHeight = Math.max(...relative.map((item) => item.h));
    const share = framing === 'CLOSE' ? P.closeFaceHeight : P.mediumFaceHeight;
    let scale = Math.min(P.maxScale, share / Math.max(faceHeight, 1e-3));
    const pointX = median(relative.map((item) => item.x));
    const pointY = median(relative.map((item) => item.y));
    while (scale >= P.minScale) {
      const anchorX = anchorFor(pointX, P.faceCenterX, scale);
      const anchorY = anchorFor(pointY, P.faceCenterY, scale);
      const safe = samples.every((sample) => {
        const window = zoomWindow(input.cropAt(sample.t), scale, anchorX, anchorY);
        if (inside(sample.target, window) < P.targetInside) return false;
        if ((sample.target.y - window.y) / window.h < P.headroom) return false;
        return sample.others.every((face) => {
          const share = inside(face, window);
          return share >= P.otherInside || share <= P.otherOutside;
        });
      });
      if (safe) return { startSec: round(startSec), endSec: round(endSec), scale: round(scale),
        anchorX: round(anchorX), anchorY: round(anchorY), framing,
        trackId: segment?.trackId ?? samples[0].target.trackId ?? null };
      scale = Number((scale - P.scaleStep).toFixed(4));
    }
    return null;
  };

  const punches: SpeakerPunch[] = [];
  let framing: 'CLOSE' | 'MEDIUM' = 'MEDIUM';
  let previous: (typeof raw)[number] | null = null;
  for (const item of raw) {
    // Only a sentence-end split of the same take and subject alternates the framing;
    // a new shot or a speaker switch restarts on the medium-close framing.
    const continuous = !!previous && Math.abs(item.startSec - previous.endSec) < 1e-3 &&
      previous.segment === item.segment;
    framing = continuous ? (framing === 'CLOSE' ? 'MEDIUM' : 'CLOSE') : 'MEDIUM';
    const punch = fit(item.startSec, item.endSec, item.segment, framing);
    previous = item;
    if (!punch) continue;
    const last = punches.at(-1);
    // Same subject, same take, and the safe scales ended up nearly equal: one interval,
    // not a jump that reads as a glitch.
    if (last && Math.abs(last.endSec - punch.startSec) < 1e-3 && last.trackId === punch.trackId &&
      Math.max(last.scale, punch.scale) / Math.min(last.scale, punch.scale) < P.minVisibleChange) {
      const merged = fit(last.startSec, punch.endSec, item.segment, last.framing);
      if (merged) { punches[punches.length - 1] = merged; continue; }
    }
    punches.push(punch);
  }
  return punches.filter((punch) => punch.endSec <= input.durationSec + 1e-6);
}

export const punchAt = (punches: SpeakerPunch[], t: number) =>
  punches.find((punch) => t >= punch.startSec && t < punch.endSec) ?? null;

/** zoompan stage reproducing the punches on the camera's card-sized output. */
export function punchFilter(punches: SpeakerPunch[], width: number, height: number, fps: number) {
  const piecewise = (value: (punch: SpeakerPunch) => number, fallback: string) =>
    punches.reduceRight((next, punch) => {
      const from = Math.round(punch.startSec * fps);
      const to = Math.max(from, Math.round(punch.endSec * fps) - 1);
      return `if(between(on\\,${from}\\,${to})\\,${value(punch).toFixed(4)}\\,${next})`;
    }, fallback);
  return `,zoompan=z='${piecewise((punch) => punch.scale, '1')}':` +
    `x='(iw-iw/zoom)*(${piecewise((punch) => punch.anchorX, '0.5')})':` +
    `y='(ih-ih/zoom)*(${piecewise((punch) => punch.anchorY, '0.5')})':` +
    `d=1:s=${width}x${height}:fps=${fps}`;
}
