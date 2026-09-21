import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BackgroundMode } from './platform-layout';

const execFileAsync = promisify(execFile);
const hex = (rgb: number[]) => '#' + rgb.map((part) =>
  Math.round(Math.min(255, Math.max(0, part))).toString(16).padStart(2, '0')).join('').toUpperCase();
const darken = (rgb: number[], factor: number) => rgb.map((value) =>
  Math.min(255, Math.max(0, value * factor)));
const relativeLuminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((value) => {
    const c = value / 255;
    return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
};
// Darken until white text on this color reaches the requested contrast ratio.
export function ensureContrastWithWhite(rgb: number[], ratio = 7): number[] {
  let color = [...rgb];
  for (let step = 0; step < 40 && 1.05 / (relativeLuminance(color) + .05) < ratio; step++)
    color = darken(color, .9);
  return color;
}
// Pull very saturated colors toward their luminance so the frame stays calm.
const desaturate = (rgb: number[], amount: number) => {
  const lum = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  return rgb.map((value) => value + (lum - value) * amount);
};
export const parseHex = (color: string) => [0, 1, 2].map((index) =>
  parseInt(color.slice(1 + index * 2, 3 + index * 2), 16));

export type SourcePalette = { dominant: string; secondary: string; darkVariant: string;
  lightVariant: string; accent: string; textColor: string; brightness: number;
  saturation: number; temperature: 'WARM' | 'COOL' | 'NEUTRAL' };
export const DEFAULT_SOURCE_PALETTE: SourcePalette = {
  dominant: '#171A20', secondary: '#252A33', darkVariant: '#14171D',
  lightVariant: '#1C2027', accent: '#7A8EA8', textColor: '#FFFFFF',
  brightness: .5, saturation: .3, temperature: 'NEUTRAL'
};

export type SampledFrame = { t: number; rgb: Buffer };
// One small decode pass over the edited span; every palette reuses it.
// `t` is the input-file time of each sample.
export async function sampleSourceFrames(path: string,
  range?: { start: number; duration: number }, fps = 2, size = 32): Promise<SampledFrame[]> {
  const rate = range ? Math.max(fps, 6 / Math.max(.5, range.duration)) : .2;
  const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error',
    ...(range ? ['-ss', range.start.toFixed(3), '-t', range.duration.toFixed(3)] : []), '-i', path,
    '-vf', `fps=${rate.toFixed(4)},scale=${size}:${size}:flags=area,format=rgb24`,
    '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  const pixels = stdout as Buffer;
  const frameBytes = size * size * 3;
  return Array.from({ length: Math.floor(pixels.length / frameBytes) }, (_, index) => ({
    t: (range?.start ?? 0) + index / rate,
    rgb: pixels.subarray(index * frameBytes, (index + 1) * frameBytes) }));
}
export async function sampleSourcePalette(path: string,
  range?: { start: number; duration: number }): Promise<SourcePalette> {
  return paletteFromPixels(Buffer.concat((await sampleSourceFrames(path, range)).map((frame) => frame.rgb)));
}
export function paletteFromPixels(pixels: Buffer): SourcePalette {
  const buckets = new Map<string, { count: number; rgb: number[] }>();
  let brightness = 0, saturation = 0, count = 0;
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
    const hi = Math.max(...rgb), lo = Math.min(...rgb);
    brightness += (.2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]) / 255;
    saturation += hi ? (hi - lo) / hi : 0;
    count++;
    const key = rgb.map((value) => Math.round(value / 32)).join(':');
    const bucket = buckets.get(key) ?? { count: 0, rgb: [0, 0, 0] };
    bucket.count++;
    rgb.forEach((value, index) => bucket.rgb[index] += value);
    buckets.set(key, bucket);
  }
  if (!count) return DEFAULT_SOURCE_PALETTE;
  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  const color = (bucket: typeof sorted[number] | undefined) => bucket ?
    bucket.rgb.map((value) => value / bucket.count) : [23, 26, 32];
  const dominant = color(sorted[0]);
  const secondary = color(sorted.find((bucket) => bucket !== sorted[0] &&
    Math.hypot(...bucket.rgb.map((value, index) =>
      value / bucket.count - dominant[index])) > 25));
  const meanSaturation = saturation / count;
  const calm = (rgb: number[]) => desaturate(rgb, meanSaturation > .5 ? .35 : .15);
  const darkVariant = ensureContrastWithWhite(darken(calm(dominant), .62));
  const accent = darken(secondary, .75).map((value) => Math.max(80, value));
  return { dominant: hex(dominant), secondary: hex(secondary),
    darkVariant: hex(darkVariant), lightVariant: hex(darken(dominant, 1.2)),
    accent: hex(accent), textColor: '#FFFFFF',
    brightness: brightness / count,
    saturation: meanSaturation,
    temperature: dominant[0] > dominant[2] + 8 ? 'WARM' :
      dominant[2] > dominant[0] + 8 ? 'COOL' : 'NEUTRAL' };
}
export function backgroundColors(palette: SourcePalette, mode: BackgroundMode, extraDarken = 0) {
  const factor = Math.max(.3, 1 - extraDarken);
  if (mode === 'DARK_NEUTRAL') return ['#15171C', '#15171C'];
  const top = hex(darken(parseHex(palette.darkVariant), factor));
  const secondary = parseHex(palette.secondary);
  const bottom = hex(darken(ensureContrastWithWhite(darken(desaturate(secondary, .2), .58)), factor));
  return mode === 'SOURCE_MATCH_SOLID' ? [top, top] : [top, bottom];
}

// One palette per meaningful visual scene, on the final timeline. Short shots
// and shots whose rendered colors barely differ share a palette, so the frame
// only shifts color on real scene changes.
export type PaletteSegment = { start: number; end: number; palette: SourcePalette; shotIndexes: number[] };
export const PALETTE_TUNING = { minSegmentSec: 1.2, minColorDistance: 12, fadeSec: .4 } as const;
export function buildPaletteSegments(shots: Array<{ start: number; end: number;
  sourceStart: number; sourceEnd: number }>, frames: SampledFrame[], inputOffset: number,
  mode: BackgroundMode, finalDuration: number): PaletteSegment[] {
  const pixelsFor = (sourceStart: number, sourceEnd: number) => {
    const inside = frames.filter((frame) => frame.t + inputOffset >= sourceStart - 1e-6 &&
      frame.t + inputOffset < sourceEnd);
    if (inside.length || !frames.length) return inside.map((frame) => frame.rgb);
    const middle = (sourceStart + sourceEnd) / 2 - inputOffset;
    return [[...frames].sort((a, b) => Math.abs(a.t - middle) - Math.abs(b.t - middle))[0].rgb];
  };
  const ordered = shots.length ? shots.map((shot, index) => ({ ...shot, index })) :
    [{ start: 0, end: finalDuration, sourceStart: -Infinity, sourceEnd: Infinity, index: -1 }];
  type Group = { start: number; end: number; pixels: Buffer[]; palette: SourcePalette; shotIndexes: number[] };
  const groups: Group[] = [];
  const distance = (a: SourcePalette, b: SourcePalette) => {
    const [at, ab] = backgroundColors(a, mode).map(parseHex);
    const [bt, bb] = backgroundColors(b, mode).map(parseHex);
    return Math.max(Math.hypot(...at.map((v, i) => v - bt[i])), Math.hypot(...ab.map((v, i) => v - bb[i])));
  };
  const absorb = (group: Group, other: { pixels: Buffer[]; end: number; shotIndexes: number[] }) => {
    group.pixels.push(...other.pixels);
    group.end = Math.max(group.end, other.end);
    group.shotIndexes.push(...other.shotIndexes);
    if (group.pixels.length) group.palette = paletteFromPixels(Buffer.concat(group.pixels));
  };
  for (const shot of ordered) {
    const pixels = pixelsFor(shot.sourceStart, shot.sourceEnd);
    const palette = pixels.length ? paletteFromPixels(Buffer.concat(pixels)) : DEFAULT_SOURCE_PALETTE;
    const shotIndexes = shot.index >= 0 ? [shot.index] : [];
    const last = groups[groups.length - 1];
    if (last && (last.end - last.start < PALETTE_TUNING.minSegmentSec ||
      distance(last.palette, palette) < PALETTE_TUNING.minColorDistance)) {
      absorb(last, { pixels, end: shot.end, shotIndexes });
      continue;
    }
    groups.push({ start: shot.start, end: shot.end, pixels, palette, shotIndexes });
  }
  const tail = groups[groups.length - 1];
  if (groups.length > 1 && tail.end - tail.start < PALETTE_TUNING.minSegmentSec) {
    groups.pop();
    absorb(groups[groups.length - 1], tail);
  }
  return groups.map((group, index) => ({ start: index === 0 ? 0 : group.start,
    end: index === groups.length - 1 ? finalDuration : group.end,
    palette: group.palette, shotIndexes: group.shotIndexes }));
}

export type PaletteTrack = { graph: string[]; colors: string[][]; boundaries: number[]; fadeSec: number };
// Header/footer tint on the final timeline: a 2x4 top/bottom color card per
// segment, cross-faded at segment boundaries. Scaled up bilinearly, the header
// shows the pure top color and the footer the pure bottom color.
export function paletteTrackFilter(segments: Array<{ start: number; colors: string[] }>,
  duration: number, fps: number, output: string, fadeSec: number = PALETTE_TUNING.fadeSec): PaletteTrack {
  const snap = (t: number) => Math.round(t * fps) / fps;
  const fade = Math.max(2, Math.round(fadeSec * fps)) / fps;
  const total = snap(duration);
  const colors = [segments[0].colors];
  const boundaries: number[] = [];
  for (const segment of segments.slice(1)) {
    const bound = snap(segment.start);
    const previous = boundaries[boundaries.length - 1] ?? -Infinity;
    // Every card must outlast its crossfades.
    if (bound - fade < Math.max(fade / 2, previous + fade) || bound + fade > total) continue;
    boundaries.push(bound);
    colors.push(segment.colors);
  }
  const graph: string[] = [];
  colors.forEach(([top, bottom], i) => {
    const from = i === 0 ? 0 : boundaries[i - 1] - fade / 2;
    const to = i === colors.length - 1 ? total : boundaries[i] + fade / 2;
    const d = (to - from).toFixed(4);
    graph.push(`color=c=${top.replace('#', '0x')}:s=2x2:r=${fps}:d=${d},format=yuv444p[pt${i}]`);
    graph.push(`color=c=${bottom.replace('#', '0x')}:s=2x2:r=${fps}:d=${d},format=yuv444p[pb${i}]`);
    graph.push(`[pt${i}][pb${i}]vstack,settb=1/${fps}[${colors.length === 1 ? output : `pc${i}`}]`);
  });
  let previous = 'pc0';
  boundaries.forEach((bound, i) => {
    const label = i === boundaries.length - 1 ? output : `px${i}`;
    graph.push(`[${previous}][pc${i + 1}]xfade=transition=fade:duration=${fade.toFixed(4)}:` +
      `offset=${(bound - fade / 2).toFixed(4)}[${label}]`);
    previous = label;
  });
  return { graph, colors, boundaries, fadeSec: fade };
}
// Expected tint (RGB) at final time t; row 0 = header color, 1 = footer color.
export function tintAt(track: Pick<PaletteTrack, 'colors' | 'boundaries' | 'fadeSec'>, t: number, row: 0 | 1) {
  let color = parseHex(track.colors[0][row]);
  track.boundaries.forEach((bound, i) => {
    const progress = Math.max(0, Math.min(1, (t - (bound - track.fadeSec / 2)) / track.fadeSec));
    const next = parseHex(track.colors[i + 1][row]);
    color = color.map((value, c) => value + (next[c] - value) * progress);
  });
  return color;
}
