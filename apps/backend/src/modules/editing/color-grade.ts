import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
export type GradePreset = 'CLEAN_SOCIAL' | 'WARM_TALKING_HEAD' | 'COOL_DOCUMENTARY' |
  'NEUTRAL_EDUCATIONAL' | 'SOURCE_ALREADY_GRADED' | 'NO_CHANGE';
export const GRADE_PRESET_NAMES: GradePreset[] = ['CLEAN_SOCIAL', 'WARM_TALKING_HEAD',
  'COOL_DOCUMENTARY', 'NEUTRAL_EDUCATIONAL', 'SOURCE_ALREADY_GRADED', 'NO_CHANGE'];
export type ImageStats = { brightness: number; contrast: number;
  saturation: number; highlightClipping: number; shadowClipping?: number;
  meanR?: number; meanG?: number; meanB?: number; sharpness?: number; chroma?: number };
// `vibrance` replaces most of the old flat saturation push: it lifts muted
// colours and leaves already-saturated ones (skin above all) alone, which is the
// difference between "graded" and "filtered". `sCurve` is a gentle contrast
// S-curve for richness that a linear contrast multiplier cannot give without
// crushing the ends.
export const GRADE_PRESETS: Record<GradePreset, { contrast: number;
  saturation: number; brightness: number; gamma: number; sharpen: number;
  redShift: number; blueShift: number; vibrance: number; sCurve: number }> = {
  CLEAN_SOCIAL: { contrast: 1.04, saturation: 1.03, brightness: 0,
    gamma: 1, sharpen: .28, redShift: 0, blueShift: 0, vibrance: .22, sCurve: 1 },
  WARM_TALKING_HEAD: { contrast: 1.04, saturation: 1.03, brightness: .004,
    gamma: 1.01, sharpen: .25, redShift: .018, blueShift: -.014, vibrance: .2, sCurve: .9 },
  COOL_DOCUMENTARY: { contrast: 1.05, saturation: 1.01, brightness: 0,
    gamma: .99, sharpen: .25, redShift: -.012, blueShift: .016, vibrance: .16, sCurve: 1 },
  NEUTRAL_EDUCATIONAL: { contrast: 1.03, saturation: 1.02, brightness: .004,
    gamma: 1, sharpen: .3, redShift: 0, blueShift: 0, vibrance: .18, sCurve: .8 },
  SOURCE_ALREADY_GRADED: { contrast: 1.01, saturation: 1, brightness: 0,
    gamma: 1, sharpen: .12, redShift: 0, blueShift: 0, vibrance: .08, sCurve: .35 },
  // A true no-op: identity values, used when the source is already well balanced
  // and touching it would only add risk, not quality.
  NO_CHANGE: { contrast: 1, saturation: 1, brightness: 0, gamma: 1, sharpen: 0, redShift: 0,
    blueShift: 0, vibrance: 0, sCurve: 0 }
};

// Tone curve: a restrained S for richness, plus an explicit highlight rolloff
// and shadow floor driven by what the source actually does, so the grade never
// clips highlights or crushes blacks that were fine before it ran.
export function toneCurvePoints(amount: number, stats: ImageStats) {
  const lift = Math.min(.035, .03 * amount);
  const points: Array<[number, number]> = [[0, 0]];
  // Protect shadows that are already close to clipping instead of deepening them.
  const shadowPressure = (stats.shadowClipping ?? 0) > .02 ? -1 : 1;
  points.push([.08, Number((.08 + (shadowPressure < 0 ? lift * .8 : 0)).toFixed(4))]);
  points.push([.25, Number((.25 - lift * shadowPressure).toFixed(4))]);
  points.push([.75, Number((.75 + lift).toFixed(4))]);
  // Tame highlights when the source is already hot; otherwise keep a soft rolloff.
  const rolloff = (stats.highlightClipping ?? 0) > .02 ? .04 * amount : .015 * amount;
  points.push([.92, Number((.92 - rolloff).toFixed(4))]);
  points.push([1, 1]);
  return points;
}

export async function sampleImageStats(path: string,
  crop?: { width: number; height: number; x?: number; y: number }): Promise<ImageStats> {
  const cropFilter = crop ? `crop=${crop.width}:${crop.height}:` +
    `${crop.x ?? 0}:${crop.y},` : '';
  const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', path,
    '-vf', `fps=1,${cropFilter}scale=64:64,format=rgb24`, '-frames:v', '24',
    '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 500000 });
  return statsFromRgb(stdout as Buffer, 64);
}

export function statsFromRgb(pixels: Buffer, width = 64): ImageStats {
  let sum = 0, sumSq = 0, saturation = 0, clipped = 0, crushed = 0, r = 0, g = 0, b = 0, edges = 0;
  let chroma = 0;
  const count = Math.floor(pixels.length / 3);
  for (let index = 0; index < count * 3; index += 3) {
    const pr = pixels[index] / 255, pg = pixels[index + 1] / 255, pb = pixels[index + 2] / 255;
    const y = .2126 * pr + .7152 * pg + .0722 * pb;
    sum += y; sumSq += y * y; r += pr; g += pg; b += pb;
    const hi = Math.max(pr, pg, pb), lo = Math.min(pr, pg, pb);
    saturation += hi ? (hi - lo) / hi : 0;
    chroma += hi - lo;
    if (y > .98) clipped++;
    if (y < .02) crushed++;
    const pixel = index / 3;
    if (pixel % width < width - 1 && index + 5 < pixels.length) {
      const next = .2126 * pixels[index + 3] / 255 + .7152 * pixels[index + 4] / 255 +
        .0722 * pixels[index + 5] / 255;
      edges += Math.abs(next - y);
    }
  }
  if (!count) return { brightness: .5, contrast: .2,
    saturation: .3, highlightClipping: 0, shadowClipping: 0, meanR: .5, meanG: .5, meanB: .5, sharpness: 0 };
  const brightness = sum / count;
  return { brightness, contrast: Math.sqrt(Math.max(0, sumSq / count -
    brightness * brightness)), saturation: saturation / count,
    highlightClipping: clipped / count, shadowClipping: crushed / count,
    meanR: r / count, meanG: g / count, meanB: b / count, sharpness: edges / count,
    chroma: chroma / count };
}

export function isAlreadyGraded(stats: ImageStats) {
  return stats.contrast > .29 || stats.saturation > .56 || stats.highlightClipping > .035;
}

// Well-exposed, naturally balanced footage: correct exposure, controlled
// highlights/shadows, no strong white-balance cast. Nothing here needs fixing,
// so the conservative choice is to leave it alone rather than apply a preset
// "for consistency".
export function looksAlreadyBalanced(stats: ImageStats) {
  const cast = Math.abs((stats.meanR ?? .5) - (stats.meanB ?? .5));
  return stats.brightness >= .38 && stats.brightness <= .62 &&
    stats.contrast >= .15 && stats.contrast <= .29 &&
    stats.saturation >= .18 && stats.saturation <= .5 &&
    (stats.highlightClipping ?? 0) <= .015 && (stats.shadowClipping ?? 0) <= .02 && cast <= .05;
}

// Deterministic mood/preset reconciliation: Luna's mood is honored unless the
// source is already graded (then only a minimal polish is applied) or already
// looks naturally balanced (then NO_CHANGE is the conservative, correct call).
export function resolveGradePreset(requested: string | undefined, stats: ImageStats): GradePreset {
  if (isAlreadyGraded(stats)) return 'SOURCE_ALREADY_GRADED';
  if (looksAlreadyBalanced(stats)) return 'NO_CHANGE';
  return GRADE_PRESET_NAMES.includes(requested as GradePreset) &&
    requested !== 'SOURCE_ALREADY_GRADED' && requested !== 'NO_CHANGE'
    ? requested as GradePreset : 'CLEAN_SOCIAL';
}

/** Choose the grade before the expensive encode. Sources already near clipping,
 * heavily saturated, or strongly cast receive a conservative pass up front. */
export function predictGradeStrength(preset: GradePreset, stats: ImageStats) {
  if (preset === 'NO_CHANGE') return { strength: 0, reason: 'SOURCE_BALANCED_NO_CHANGE' };
  const cast = Math.abs((stats.meanR ?? .5) - (stats.meanB ?? .5));
  const highRisk = stats.highlightClipping > .03 || (stats.shadowClipping ?? 0) > .04 ||
    stats.saturation > .62 || cast > .14;
  const strength = highRisk ? .65 : 1;
  return { strength, reason: highRisk ? 'SOURCE_STATS_CONSERVATIVE_GRADE' : 'SOURCE_STATS_STANDARD_GRADE' };
}

export function gradingFilter(preset: GradePreset, stats: ImageStats, strengthScale = 1) {
  if (preset === 'NO_CHANGE') return { filter: 'null',
    values: { contrast: 1, saturation: 1, brightness: 0, gamma: 1, sharpen: 0, redShift: 0,
      blueShift: 0, vibrance: 0, toneCurve: [] as Array<[number, number]> },
    report: { exposureAdjustment: 0, contrastAdjustment: 0, saturationAdjustment: 0,
      temperatureAdjustment: 0, sharpnessAdjustment: 0, gammaAdjustment: 0, vibranceAdjustment: 0,
      toneCurveAmount: 0 },
    alreadyGraded: true };
  const settings = GRADE_PRESETS[preset];
  const alreadyGraded = isAlreadyGraded(stats);
  const strength = (alreadyGraded ? .35 : stats.contrast < .17 ? 1 : .8) * strengthScale;
  const contrast = 1 + (settings.contrast - 1) * strength;
  const saturation = 1 + (settings.saturation - 1) * strength *
    (stats.saturation < .18 ? 1.3 : 1);
  // Exposure: pull toward a mid-key target, stronger for under-exposed sources.
  const exposure = alreadyGraded ? 0 : Math.max(-.035, Math.min(.05,
    (.45 - stats.brightness) * (stats.brightness < .33 ? .3 : .15)));
  // Exposure is applied through gamma so black levels are not lifted.
  const brightness = settings.brightness * strength;
  const gamma = settings.gamma * (1 + exposure * 3);
  const sharpen = settings.sharpen * strength;
  // White balance: neutralize strong casts before applying the preset tint.
  const cast = (stats.meanR ?? .5) - (stats.meanB ?? .5);
  const castCorrection = alreadyGraded ? 0 : cast > .12 ? -.02 : cast < -.08 ? .02 : 0;
  const redShift = settings.redShift * strength + castCorrection;
  const blueShift = settings.blueShift * strength - castCorrection;
  const vibrance = settings.vibrance * strength;
  const curveAmount = settings.sCurve * strength;
  const toneCurve = curveAmount > .02 ? toneCurvePoints(curveAmount, stats) : [];
  const curveFilter = toneCurve.length ?
    `,curves=all='${toneCurve.map(([x, y]) => `${x}/${y}`).join(' ')}'` : '';
  return { filter: `eq=contrast=${contrast.toFixed(4)}:` +
    `saturation=${saturation.toFixed(4)}:brightness=${brightness.toFixed(4)}:` +
    `gamma=${gamma.toFixed(4)}` + curveFilter +
    (vibrance > .01 ? `,vibrance=intensity=${vibrance.toFixed(3)}` : '') +
    (redShift || blueShift ? `,colorbalance=rm=${redShift.toFixed(4)}:` +
      `bm=${blueShift.toFixed(4)}:rh=${(redShift / 2).toFixed(4)}:bh=${(blueShift / 2).toFixed(4)}` : '') +
    `,unsharp=5:5:${sharpen.toFixed(3)}:5:5:0`,
    values: { contrast, saturation, brightness, gamma, sharpen, redShift, blueShift, vibrance, toneCurve },
    report: { exposureAdjustment: Number(exposure.toFixed(4)),
      contrastAdjustment: Number((contrast - 1).toFixed(4)),
      saturationAdjustment: Number((saturation - 1).toFixed(4)),
      temperatureAdjustment: Number((redShift - blueShift).toFixed(4)),
      sharpnessAdjustment: Number(sharpen.toFixed(4)), gammaAdjustment: Number((gamma - 1).toFixed(4)),
      vibranceAdjustment: Number(vibrance.toFixed(4)), toneCurveAmount: Number(curveAmount.toFixed(4)) },
    alreadyGraded };
}
