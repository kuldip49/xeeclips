import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Rect } from './platform-layout';

const execFileAsync = promisify(execFile);
export type Frame = { width: number; height: number; data: Buffer };
export type Rgb = [number, number, number];

// Output frames are inspected at half resolution.
export const QA_SCALE = .5;
// Final visual QA is deliberately small and event-driven.  Keeping both the
// overall normal sample set and each ffmpeg select expression bounded prevents
// long/high-fps sources from turning QA into an unbounded decode/OOM path.
export const MAX_NORMAL_QA_FRAMES = 24;
export const MAX_QA_DECODE_BATCH_FRAMES = 8;

export function boundedQaFrameNumbers(groups: number[][], maximum = MAX_NORMAL_QA_FRAMES) {
  const result: number[] = [];
  const seen = new Set<number>();
  const queues = groups.map((group) => [...new Set(group.filter((value) =>
    Number.isInteger(value) && value >= 0))]);
  // Round-robin preserves coverage across hooks, subtitles, zooms,
  // information shots and grading instead of letting a large early group use
  // the entire budget.
  while (result.length < maximum && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      while (queue.length && seen.has(queue[0])) queue.shift();
      const next = queue.shift();
      if (next == null) continue;
      seen.add(next); result.push(next);
      if (result.length >= maximum) break;
    }
  }
  return result.sort((a, b) => a - b);
}

/** Reserve the baseline, peak and settled frame for every planned semantic
 * zoom, then distribute the remaining bounded budget across optional checks. */
export function normalQaFrameNumbers(mandatory: number[], zoomTriplets: number[][],
  optionalGroups: number[][], maximum = MAX_NORMAL_QA_FRAMES) {
  const valid = (value: number) => Number.isInteger(value) && value >= 0;
  const critical = [...new Set([...mandatory.filter(valid),
    ...zoomTriplets.flatMap((group) => group.slice(0, 3).filter(valid))])];
  // This fallback still distributes coverage if an abnormal input supplies
  // more zooms than the planner's normal five-event ceiling.
  if (critical.length >= maximum) return boundedQaFrameNumbers([
    mandatory, ...zoomTriplets.map((group) => group.slice(0, 3))
  ], maximum);
  const criticalSet = new Set(critical);
  const optional = boundedQaFrameNumbers(optionalGroups, maximum - critical.length)
    .filter((frame) => !criticalSet.has(frame));
  return [...critical, ...optional].slice(0, maximum).sort((a, b) => a - b);
}

function selectExpression(frameNumbers: number[]) {
  return [...new Set(frameNumbers)].sort((a, b) => a - b)
    .map((n) => `eq(n\\,${n})`).join('+');
}

function splitFrames(buffer: Buffer, width: number, height: number, count: number): Frame[] {
  const size = width * height * 3;
  return Array.from({ length: Math.min(count, Math.floor(buffer.length / size)) }, (_, index) =>
    ({ width, height, data: buffer.subarray(index * size, (index + 1) * size) }));
}

// Decodes the given frame numbers (constant-fps input) as RGB frames, in ascending order.
export async function extractFrames(path: string, frameNumbers: number[], width: number,
  height: number, crop?: Rect): Promise<Map<number, Frame>> {
  const unique = [...new Set(frameNumbers.filter((n) => n >= 0))].sort((a, b) => a - b);
  if (!unique.length) return new Map();
  const cropFilter = crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` : '';
  const output = new Map<number, Frame>();
  for (let offset = 0; offset < unique.length; offset += MAX_QA_DECODE_BATCH_FRAMES) {
    const batch = unique.slice(offset, offset + MAX_QA_DECODE_BATCH_FRAMES);
    const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', path,
      '-vf', `select='${selectExpression(batch)}',${cropFilter}scale=${width}:${height}:flags=area`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: Math.max(16, batch.length * 4) * 1024 * 1024 });
    const frames = splitFrames(stdout as Buffer, width, height, batch.length);
    batch.forEach((frameNumber, index) => { if (frames[index]) output.set(frameNumber, frames[index]); });
  }
  return output;
}

// Renders an ASS file over black at the same frame numbers. The fill pixels of
// this probe are the exact glyph masks the final burn-in must contain.
export async function renderAssProbe(cwd: string, assFile: string, canvas: { width: number; height: number },
  fps: number, frameNumbers: number[], width: number, height: number): Promise<Map<number, Frame>> {
  const unique = [...new Set(frameNumbers.filter((n) => n >= 0))].sort((a, b) => a - b);
  if (!unique.length) return new Map();
  const output = new Map<number, Frame>();
  for (let offset = 0; offset < unique.length; offset += MAX_QA_DECODE_BATCH_FRAMES) {
    const batch = unique.slice(offset, offset + MAX_QA_DECODE_BATCH_FRAMES);
    const duration = (batch[batch.length - 1] + 2) / fps;
    const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      `color=c=black:s=${canvas.width}x${canvas.height}:r=${fps}:d=${duration.toFixed(3)}`,
      '-vf', `ass=${assFile},select='${selectExpression(batch)}',scale=${width}:${height}:flags=area`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { cwd, encoding: 'buffer', maxBuffer: Math.max(16, batch.length * 4) * 1024 * 1024 });
    const frames = splitFrames(stdout as Buffer, width, height, batch.length);
    batch.forEach((frameNumber, index) => { if (frames[index]) output.set(frameNumber, frames[index]); });
  }
  return output;
}

export const luminance = (r: number, g: number, b: number) => (.2126 * r + .7152 * g + .0722 * b) / 255;
export function hexToRgb(color: string): Rgb {
  const value = color.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as Rgb;
}
// ASS &HAABBGGRR -> RGB
export function assToRgb(color: string): Rgb {
  const value = color.replace(/^&H/iu, '').padStart(8, '0');
  return [parseInt(value.slice(6, 8), 16), parseInt(value.slice(4, 6), 16),
    parseInt(value.slice(2, 4), 16)];
}
const distance = (data: Buffer, index: number, color: Rgb) =>
  Math.max(Math.abs(data[index] - color[0]), Math.abs(data[index + 1] - color[1]),
    Math.abs(data[index + 2] - color[2]));

export type Mask = { pixels: number[]; bounds: Rect | null };
// Fill mask of a probe frame, optionally restricted to pixels matching `color`.
// `maxLuminance` selects DARK pixels instead of bright ones, which is how the
// headline's charcoal glyphs are separated from the near-white plate behind them.
export function probeMask(frame: Frame, options: { color?: Rgb; tolerance?: number;
  minLuminance?: number; maxLuminance?: number; region?: Rect } = {}): Mask {
  const pixels: number[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const region = options.region ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  const x1 = Math.max(0, Math.floor(region.x));
  const y1 = Math.max(0, Math.floor(region.y));
  const x2 = Math.min(frame.width, Math.ceil(region.x + region.width));
  const y2 = Math.min(frame.height, Math.ceil(region.y + region.height));
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const index = (y * frame.width + x) * 3;
      const data = frame.data;
      const match = options.color ?
        distance(data, index, options.color) <= (options.tolerance ?? 36) &&
        luminance(data[index], data[index + 1], data[index + 2]) > .2 :
        options.maxLuminance != null ?
          luminance(data[index], data[index + 1], data[index + 2]) <= options.maxLuminance :
          luminance(data[index], data[index + 1], data[index + 2]) >= (options.minLuminance ?? .5);
      if (!match) continue;
      pixels.push(y * frame.width + x);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return { pixels, bounds: pixels.length ? { x: minX, y: minY,
    width: maxX - minX + 1, height: maxY - minY + 1 } : null };
}

/** Every pixel of a rectangle as a mask, used to exclude a whole drawn region. */
export function rectMask(frame: Frame, region: Rect): Mask {
  const pixels: number[] = [];
  const x1 = Math.max(0, Math.floor(region.x));
  const y1 = Math.max(0, Math.floor(region.y));
  const x2 = Math.min(frame.width, Math.ceil(region.x + region.width));
  const y2 = Math.min(frame.height, Math.ceil(region.y + region.height));
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) pixels.push(y * frame.width + x);
  return { pixels, bounds: pixels.length ?
    { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null };
}

// Share of mask pixels whose output color matches the probe color.
export function maskAgreement(probe: Frame, output: Frame, mask: Mask, tolerance = 60) {
  if (!mask.pixels.length || probe.width !== output.width || probe.height !== output.height) return 0;
  let agree = 0;
  for (const pixel of mask.pixels) {
    const index = pixel * 3;
    const color: Rgb = [probe.data[index], probe.data[index + 1], probe.data[index + 2]];
    if (distance(output.data, index, color) <= tolerance) agree++;
  }
  return agree / mask.pixels.length;
}

export function regionStats(frame: Frame, region: Rect, exclude?: Mask) {
  const skip = new Set(exclude?.pixels ?? []);
  let r = 0, g = 0, b = 0, sum = 0, sumSq = 0, sat = 0, count = 0;
  const lums: number[] = [];
  for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(frame.height, region.y + region.height); y++) {
    for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(frame.width, region.x + region.width); x++) {
      const pixel = y * frame.width + x;
      if (skip.has(pixel)) continue;
      const index = pixel * 3;
      const [pr, pg, pb] = [frame.data[index], frame.data[index + 1], frame.data[index + 2]];
      const lum = luminance(pr, pg, pb);
      const hi = Math.max(pr, pg, pb), lo = Math.min(pr, pg, pb);
      r += pr; g += pg; b += pb; sum += lum; sumSq += lum * lum;
      sat += hi ? (hi - lo) / hi : 0; count++;
      if (count % 7 === 0) lums.push(lum);
    }
  }
  if (!count) return { mean: [0, 0, 0] as Rgb, brightness: 0, contrast: 0, saturation: 0,
    medianLuminance: 0, count: 0 };
  lums.sort((a, c) => a - c);
  const brightness = sum / count;
  return { mean: [r / count, g / count, b / count] as Rgb, brightness,
    contrast: Math.sqrt(Math.max(0, sumSq / count - brightness * brightness)),
    saturation: sat / count, medianLuminance: lums[Math.floor(lums.length / 2)] ?? brightness,
    count };
}

// WCAG-style contrast ratio between two relative luminances.
export function contrastRatio(a: number, b: number) {
  const lin = (value: number) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  const [hi, lo] = [lin(Math.max(a, b)), lin(Math.min(a, b))];
  return (hi + .05) / (lo + .05);
}

// Grayscale sampling helpers for zoom estimation.
export function toGray(frame: Frame, region: Rect, width: number, height: number) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.width - 1, Math.floor(region.x + (x + .5) * region.width / width));
      const sy = Math.min(frame.height - 1, Math.floor(region.y + (y + .5) * region.height / height));
      const index = (sy * frame.width + sx) * 3;
      out[y * width + x] = luminance(frame.data[index], frame.data[index + 1], frame.data[index + 2]);
    }
  }
  return out;
}

function bilinear(image: Float32Array, width: number, height: number, x: number, y: number) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  return image[y0 * width + x0] * (1 - fx) * (1 - fy) + image[y0 * width + x1] * fx * (1 - fy) +
    image[y1 * width + x0] * (1 - fx) * fy + image[y1 * width + x1] * fx * fy;
}

// Mean error between `after` and `before` magnified by `scale` around the
// zoompan anchor. Only the upper `rows` fraction is compared (captions live below).
export function zoomError(before: Float32Array, after: Float32Array, width: number, height: number,
  scale: number, anchorX: number, anchorY: number, rows = .55) {
  const x0 = (width - width / scale) * anchorX;
  const y0 = (height - height / scale) * anchorY;
  let error = 0, count = 0;
  for (let y = 0; y < Math.floor(height * rows); y++) {
    for (let x = 0; x < width; x++) {
      const value = bilinear(before, width, height, x0 + (x + .5) / scale - .5, y0 + (y + .5) / scale - .5);
      error += Math.abs(value - after[y * width + x]);
      count++;
    }
  }
  return count ? error / count : 0;
}

// Estimates which scale best explains the change between two viewport frames.
export function estimateZoom(before: Float32Array, after: Float32Array, width: number, height: number,
  anchorX: number, anchorY: number, maxScale = 1.3) {
  let best = { scale: 1, error: zoomError(before, after, width, height, 1, anchorX, anchorY) };
  const baseline = best.error;
  for (let scale = 1.04; scale <= maxScale + 1e-6; scale += .02) {
    const error = zoomError(before, after, width, height, scale, anchorX, anchorY);
    if (error < best.error) best = { scale, error };
  }
  return { estimatedScale: Number(best.scale.toFixed(2)), bestError: best.error, identityError: baseline };
}

// --- Audio -----------------------------------------------------------------

export async function audioEnvelope(path: string, hopSec = .01) {
  const rate = 16000;
  const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0',
    '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
  { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  const samples = stdout as Buffer;
  const hop = Math.round(rate * hopSec);
  const count = Math.floor(samples.length / 2 / hop);
  const db = new Float32Array(count);
  for (let frame = 0; frame < count; frame++) {
    let sum = 0;
    for (let i = 0; i < hop; i++) {
      const value = samples.readInt16LE((frame * hop + i) * 2) / 32768;
      sum += value * value;
    }
    db[frame] = 10 * Math.log10(sum / hop + 1e-10);
  }
  return { db, hopSec };
}

export function meanDb(envelope: { db: Float32Array; hopSec: number }, ranges: Array<{ start: number; end: number }>) {
  let power = 0, count = 0;
  for (const range of ranges) {
    for (let i = Math.max(0, Math.floor(range.start / envelope.hopSec));
      i < Math.min(envelope.db.length, Math.ceil(range.end / envelope.hopSec)); i++) {
      power += 10 ** (envelope.db[i] / 10); count++;
    }
  }
  return count ? 10 * Math.log10(power / count + 1e-10) : -100;
}

// Measures the speech onset near each word start that follows a clear pause.
// Returns, per word, the signed offset (onset - start) in seconds or null.
export function measureOnsets(envelope: { db: Float32Array; hopSec: number },
  words: Array<{ start: number; end: number; gapBefore: number }>, minGap = .18): Array<number | null> {
  const { db, hopSec } = envelope;
  // 3-hop moving average: single-hop clicks and breaths do not count as onsets.
  const smooth = Float32Array.from(db, (_, i) =>
    (db[Math.max(0, i - 1)] + db[i] + db[Math.min(db.length - 1, i + 1)]) / 3);
  const at = (t: number) => smooth[Math.max(0, Math.min(smooth.length - 1, Math.round(t / hopSec)))];
  return words.map((word) => {
    if (word.gapBefore < minGap || word.start < .3) return null;
    // Transcript times can be early or late, so the pause is estimated with a
    // low percentile over the whole gap rather than a median of its tail.
    const floorStart = word.start - Math.min(word.gapBefore, .6) + .05;
    const floorEnd = word.start - .05;
    const floorValues: number[] = [];
    for (let t = floorStart; t <= floorEnd; t += hopSec) floorValues.push(at(t));
    if (floorValues.length < 5) return null;
    floorValues.sort((a, b) => a - b);
    const floor = floorValues[Math.floor(floorValues.length * .2)];
    let peak = -100;
    for (let t = word.start; t <= Math.min(word.end, word.start + .4); t += hopSec) peak = Math.max(peak, at(t));
    if (peak - floor < 18) return null;
    const threshold = floor + Math.max(10, (peak - floor) * .5);
    // Only a rising edge counts: the previous word's tail must not be mistaken for the onset.
    let wasBelow = false;
    for (let t = word.start - .2; t <= word.start + .3; t += hopSec) {
      if (at(t) < threshold) { wasBelow = true; continue; }
      if (wasBelow && at(t + hopSec) >= threshold && at(t + 2 * hopSec) >= threshold) return t - word.start;
    }
    return null;
  });
}

export function measureOnsetOffsets(envelope: { db: Float32Array; hopSec: number },
  words: Array<{ start: number; end: number; gapBefore: number }>) {
  return measureOnsets(envelope, words).filter((value): value is number => value != null);
}

/**
 * First rising edge inside a window, used to measure where a sound effect
 * actually lands on the finished timeline. The bus it measures carries only the
 * effects, so the floor is true silence and a simple threshold crossing is the
 * onset rather than an estimate of one.
 */
export function firstOnsetSec(envelope: { db: Float32Array; hopSec: number },
  from: number, to: number): number | null {
  const { db, hopSec } = envelope;
  const first = Math.max(0, Math.floor(from / hopSec));
  const last = Math.min(db.length - 1, Math.ceil(to / hopSec));
  if (last - first < 3) return null;
  let peak = -100;
  for (let i = first; i <= last; i++) peak = Math.max(peak, db[i]);
  if (peak < -60) return null;
  // The moment the effect becomes audible at all, not the moment it is loudest:
  // a slow rising whoosh and a hard hit both start where they leave the floor,
  // and the effect's placement - not its shape - is what is being checked.
  const floor = Math.min(...Array.from(db.slice(first, last + 1)));
  const threshold = Math.min(peak - 3, Math.max(floor + 10, -70));
  for (let i = first; i <= last; i++)
    if (db[i] >= threshold) return i * hopSec;
  return null;
}

export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + .5))];
}
export function median(values: number[]) { return percentile(values, .5); }
