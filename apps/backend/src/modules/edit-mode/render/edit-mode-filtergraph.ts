// EditMode Phase 5 filter graph.
//
// Pure: RenderPlan + resolved local file paths -> the exact FFmpeg argument
// vector. Keeping this a function of the plan alone is what makes an export
// deterministic and what lets the tests assert the rendered behaviour (layer
// order, timing, fades, crops) without encoding anything.
//
// Layer order is the canonical zIndex: the composited video first, then image
// and logo overlays in ascending zIndex, then the ASS layer, which carries text,
// captions and preset hooks - each as an ASS layer of its own zIndex.

import type { RenderPlan } from './edit-mode-render.types';
import { zoomAnchorExpression, zoomEnvelopeExpression } from './edit-mode-zoom';

export type GraphInput = {
  plan: RenderPlan;
  sourcePath: string;
  /** elementId -> local file for every image overlay. */
  overlayPaths: Record<string, string>;
  /** elementId -> local file for every audio element. */
  audioPaths: Record<string, string>;
  /** Written next to the working directory; empty when there is no text at all. */
  assFileName: string | null;
  outputPath: string;
  /** Source crop, in source pixels, for INFORMATION_FIT spans. */
  informationCrop: { x: number; y: number; width: number; height: number } | null;
  fitExpression: string;
  informationFitExpression: string;
  cameraFilter: string;
};

const seconds = (value: number) => value.toFixed(3);

/** One fitted layer: the source (optionally pre-cropped) scaled to fit the
 * canvas over a blurred, darkened fill of itself - so a vertical source in a
 * wide canvas is never destructively cropped to fill it. */
function fittedLayer(graph: string[], source: string, out: string, width: number, height: number,
  crop?: string) {
  const pre = crop ? `crop=${crop},` : '';
  graph.push(`[${source}]${pre}split=2[${out}a][${out}b]`);
  graph.push(`[${out}a]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},boxblur=luma_radius=28:luma_power=2,` +
    `eq=brightness=-0.1:saturation=0.75[${out}bg]`);
  graph.push(`[${out}b]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `setsar=1[${out}fg]`);
  graph.push(`[${out}bg][${out}fg]overlay=(W-w)/2:(H-h)/2[${out}]`);
}

export function buildFfmpegArgs(input: GraphInput): string[] {
  const { plan } = input;
  const { width, height, fps } = plan.canvas;
  const graph: string[] = [];
  const args: string[] = ['-v', 'error', '-y', '-i', input.sourcePath];

  // --- Extra inputs ---------------------------------------------------------
  const overlayInput = new Map<string, number>();
  const ordered = [...plan.visualOverlays].sort((left, right) => left.zIndex - right.zIndex ||
    left.startSec - right.startSec);
  for (const overlay of ordered) {
    const path = input.overlayPaths[overlay.elementId];
    if (!path) continue;
    overlayInput.set(overlay.elementId, args.filter((item) => item === '-i').length);
    args.push('-loop', '1', '-t', seconds(plan.durationSec), '-i', path);
  }
  const audioInput = new Map<string, number>();
  const audible = plan.audioTracks.filter((track) => !track.muted && track.volume > 0 &&
    input.audioPaths[track.elementId]);
  for (const track of audible) {
    audioInput.set(track.elementId, args.filter((item) => item === '-i').length);
    args.push('-i', input.audioPaths[track.elementId]);
  }

  // --- Video timeline -------------------------------------------------------
  const segments = plan.videoSegments;
  const n = segments.length;
  const withAudio = plan.hasSourceAudio;
  if (n > 1) {
    graph.push(`[0:v]split=${n}${segments.map((_, i) => `[vs${i}]`).join('')}`);
    if (withAudio) graph.push(`[0:a]asplit=${n}${segments.map((_, i) => `[as${i}]`).join('')}`);
  }
  segments.forEach((segment, i) => {
    graph.push(`[${n > 1 ? `vs${i}` : '0:v'}]trim=start=${seconds(segment.sourceStart)}:` +
      `end=${seconds(segment.sourceEnd)},setpts=PTS-STARTPTS[v${i}]`);
    if (withAudio) {
      // A 12 ms fade at each join removes the click a hard audio cut produces
      // without being audible as a fade. A single-segment export gets none.
      const length = segment.sourceEnd - segment.sourceStart;
      const fades = n > 1 ? `,afade=t=in:d=0.012,afade=t=out:` +
        `st=${seconds(Math.max(0, length - 0.012))}:d=0.012` : '';
      graph.push(`[${n > 1 ? `as${i}` : '0:a'}]atrim=start=${seconds(segment.sourceStart)}:` +
        `end=${seconds(segment.sourceEnd)},asetpts=PTS-STARTPTS${fades}[a${i}]`);
    }
  });
  if (n > 1) {
    graph.push(segments.map((_, i) => `[v${i}]${withAudio ? `[a${i}]` : ''}`).join('') +
      `concat=n=${n}:v=1:a=${withAudio ? 1 : 0}[vcat]${withAudio ? '[acat]' : ''}`);
  } else {
    graph.push('[v0]null[vcat]');
    if (withAudio) graph.push('[a0]anull[acat]');
  }

  // --- Camera, fitted layers, zoom -----------------------------------------
  const useFit = Boolean(input.fitExpression);
  const useInformationFit = Boolean(input.informationFitExpression && input.informationCrop);
  const branches = ['vfillsrc', ...(useFit ? ['vfitsrc'] : []),
    ...(useInformationFit ? ['vinfosrc'] : [])];
  graph.push(`[vcat]fps=${fps},setsar=1` +
    (branches.length > 1 ? `,split=${branches.length}${branches.map((b) => `[${b}]`).join('')}`
      : '[vfillsrc]'));

  const zoom = plan.zoomEvents.length
    ? `,zoompan=z='${zoomEnvelopeExpression(plan.zoomEvents)}':` +
      `x='(iw-iw/zoom)*(${zoomAnchorExpression(plan.zoomEvents, 'focusX')})':` +
      `y='(ih-ih/zoom)*(${zoomAnchorExpression(plan.zoomEvents, 'focusY')})':` +
      `d=1:s=${width}x${height}:fps=${fps}`
    : '';
  graph.push(`[vfillsrc]${input.cameraFilter}${zoom}[vfill]`);

  let composited = 'vfill';
  if (useFit) {
    fittedLayer(graph, 'vfitsrc', 'vfit', width, height);
    graph.push(`[${composited}][vfit]overlay=0:0:enable='${input.fitExpression}'[vfitted]`);
    composited = 'vfitted';
  }
  if (useInformationFit && input.informationCrop) {
    const crop = input.informationCrop;
    fittedLayer(graph, 'vinfosrc', 'vinfo', width, height,
      `${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
    graph.push(`[${composited}][vinfo]overlay=0:0:` +
      `enable='${input.informationFitExpression}'[vinfofitted]`);
    composited = 'vinfofitted';
  }

  // --- Grading --------------------------------------------------------------
  if (plan.grading.filter && plan.grading.filter !== 'null') {
    graph.push(`[${composited}]${plan.grading.filter}[vgraded]`);
    composited = 'vgraded';
  }

  // --- Image and logo overlays ---------------------------------------------
  ordered.forEach((overlay, index) => {
    const inputIndex = overlayInput.get(overlay.elementId);
    if (inputIndex === undefined) return;
    const fit = overlay.preserveAspectRatio
      ? `scale=${overlay.width}:${overlay.height}:force_original_aspect_ratio=decrease`
      : `scale=${overlay.width}:${overlay.height}`;
    graph.push(`[${inputIndex}:v]${fit},format=rgba,` +
      `colorchannelmixer=aa=${overlay.opacity.toFixed(4)}[ov${index}]`);
    const out = `vov${index}`;
    // The box is top-left anchored and a preserved-aspect image is centred in
    // it, matching how the editor preview draws `object-contain`.
    const x = overlay.preserveAspectRatio
      ? `${overlay.x}+(${overlay.width}-w)/2` : String(overlay.x);
    const y = overlay.preserveAspectRatio
      ? `${overlay.y}+(${overlay.height}-h)/2` : String(overlay.y);
    graph.push(`[${composited}][ov${index}]overlay=${x}:${y}:` +
      `enable='between(t\\,${seconds(overlay.startSec)}\\,${seconds(overlay.endSec)})'[${out}]`);
    composited = out;
  });

  // --- Text, captions and hooks --------------------------------------------
  if (input.assFileName) {
    graph.push(`[${composited}]ass=${input.assFileName},format=yuv420p[vout]`);
  } else {
    graph.push(`[${composited}]format=yuv420p[vout]`);
  }

  // --- Audio ----------------------------------------------------------------
  const mixInputs: string[] = [];
  if (withAudio) {
    graph.push('[acat]aformat=sample_rates=48000:channel_layouts=stereo[adialogue]');
    mixInputs.push('adialogue');
  }
  audible.forEach((track, index) => {
    const inputIndex = audioInput.get(track.elementId);
    if (inputIndex === undefined) return;
    const length = track.endSec - track.startSec;
    const label = `amus${index}`;
    const fadeIn = track.fadeInSec > 0
      ? `,afade=t=in:st=0:d=${seconds(track.fadeInSec)}` : '';
    const fadeOut = track.fadeOutSec > 0
      ? `,afade=t=out:st=${seconds(Math.max(0, length - track.fadeOutSec))}:` +
        `d=${seconds(track.fadeOutSec)}` : '';
    const delay = track.startSec > 0
      ? `,adelay=${Math.round(track.startSec * 1000)}:all=1` : '';
    graph.push(`[${inputIndex}:a]atrim=start=${seconds(track.trimStart)}:` +
      `end=${seconds(track.trimEnd)},asetpts=PTS-STARTPTS,` +
      `aformat=sample_rates=48000:channel_layouts=stereo,` +
      `atrim=start=0:end=${seconds(length)},asetpts=PTS-STARTPTS,` +
      `volume=${track.volume.toFixed(4)}${fadeIn}${fadeOut}${delay}[${label}]`);
    mixInputs.push(label);
  });
  const hasOutputAudio = mixInputs.length > 0;
  if (hasOutputAudio) {
    // normalize=0 keeps each element at the level the timeline set; the limiter
    // then catches the sum rather than letting dialogue plus music clip.
    const mixed = mixInputs.length > 1
      ? `${mixInputs.map((label) => `[${label}]`).join('')}amix=inputs=${mixInputs.length}:` +
        'duration=longest:dropout_transition=0:normalize=0[amixed]'
      : `[${mixInputs[0]}]anull[amixed]`;
    graph.push(mixed);
    // A short tail fade stops the export ending on a click.
    const endFade = Math.min(0.12, plan.durationSec / 4);
    graph.push('[amixed]alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50,' +
      `atrim=start=0:end=${seconds(plan.durationSec)},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${seconds(Math.max(0, plan.durationSec - endFade))}:` +
      `d=${seconds(endFade)},` +
      'aformat=sample_rates=48000:channel_layouts=stereo[aout]');
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (hasOutputAudio) args.push('-map', '[aout]');
  args.push('-t', seconds(plan.durationSec),
    '-c:v', 'libx264', '-preset', plan.output.preset, '-crf', String(plan.output.crf),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-profile:v', 'high', '-level', '4.1');
  if (hasOutputAudio) args.push('-c:a', 'aac', '-b:a', plan.output.audioBitrate, '-ar', '48000');
  args.push('-movflags', '+faststart', '-fflags', '+genpts', input.outputPath);
  return args;
}
