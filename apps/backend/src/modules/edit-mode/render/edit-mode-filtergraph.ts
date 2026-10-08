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

import { duckVolumeExpression } from '../edit-mode-audio';
import type { RenderPlan } from './edit-mode-render.types';
import { colorAdjustmentFilter } from './edit-mode-color-filter';
import { atempoChain, overlayTransformFilter,
  segmentTransformFilter } from './edit-mode-segment-filter';
import { zoomAnchorExpression, zoomEnvelopeExpression } from './edit-mode-zoom';

export type GraphInput = {
  /** Trusted, validated source-local preparation (Quick Reframe masks). Absent for existing editors. */
  sourcePreparation?: { graph: string[]; videoLabel: string };
  /** Keep the source audio level and ending untouched in a single-video cleanup. */
  preserveSourceAudio?: boolean;
  plan: RenderPlan;
  sourcePath: string;
  /** elementId -> local file for every image overlay. */
  overlayPaths: Record<string, string>;
  /** elementId -> local file for every audio element. */
  audioPaths: Record<string, string>;
  /** Written next to the working directory; empty when there is no text at all. */
  assFileName: string | null;
  /** Optional extra libass font directory (local QA on hosts without the image fonts). */
  fontsDir?: string;
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
  crop?: string, background: 'BLUR' | 'BLACK' | 'WHITE' = 'BLUR',
  manualCropExpression = '') {
  const pre = crop ? `crop=${crop},` : '';
  graph.push(`[${source}]${pre}split=2[${out}a][${out}b]`);
  // Step 10: a solid backdrop is the same full-canvas layer painted over, so the
  // graph shape (and its timing) is identical whichever background is chosen.
  const backdrop = background === 'BLUR'
    ? `boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.1:saturation=0.75`
    : `drawbox=x=0:y=0:w=iw:h=ih:color=${background === 'WHITE' ? 'white' : 'black'}@1:t=fill`;
  // Manual crop has priority over every fitted-background policy. This box is
  // drawn on the BACKGROUND branch before the retained video is overlaid, so it
  // can only affect uncovered canvas pixels and can never darken the footage.
  const cropBackdrop = manualCropExpression
    ? `,drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='${manualCropExpression}'`
    : '';
  graph.push(`[${out}a]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},${backdrop}${cropBackdrop}[${out}bg]`);
  graph.push(`[${out}b]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `setsar=1[${out}fg]`);
  graph.push(`[${out}bg][${out}fg]overlay=(W-w)/2:(H-h)/2[${out}]`);
}

export function buildFfmpegArgs(input: GraphInput): string[] {
  const { plan } = input;
  const { width, height, fps } = plan.canvas;
  const graph: string[] = [];
  const args: string[] = ['-v', 'error', '-y', '-i', input.sourcePath];
  if (input.sourcePreparation) graph.push(...input.sourcePreparation.graph);
  const sourceVideo = input.sourcePreparation?.videoLabel ?? '0:v';

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
  const manualCropExpression = segments.filter((segment) => segment.crop.left > 0 ||
    segment.crop.right > 0 || segment.crop.top > 0 || segment.crop.bottom > 0)
    .map((segment) => `between(t\\,${seconds(segment.timelineStart)}\\,` +
      `${seconds(Math.max(segment.timelineStart, segment.timelineEnd - 0.001))})`).join('+');
  // When crop creates black padding, grade the source before geometry. Applying
  // a warm/bright grade after compositing could lift #000000; doing it here
  // leaves video colour unchanged while keeping generated background pure black.
  const gradeBeforeGeometry = Boolean(manualCropExpression) &&
    Boolean(plan.grading.filter && plan.grading.filter !== 'null');
  // The source's own audio is built at all only when the source HAS audio and at
  // least one segment still wants to be heard. "Mute the original video" is
  // therefore a graph with no dialogue branch rather than one that decodes,
  // resamples and concatenates audio in order to multiply it by zero.
  const sourceAudible = segments.some((segment) => !segment.sourceMuted && segment.sourceVolume > 0);
  const withAudio = plan.hasSourceAudio && sourceAudible;
  if (n > 1) {
    graph.push(`[${sourceVideo}]split=${n}${segments.map((_, i) => `[vs${i}]`).join('')}`);
    if (withAudio) graph.push(`[0:a]asplit=${n}${segments.map((_, i) => `[as${i}]`).join('')}`);
  }
  segments.forEach((segment, i) => {
    // Speed is applied as a PTS rescale on the segment's own timebase, so the
    // segment occupies (source range / speed) on the exported timeline - exactly
    // the length the canonical timeline says it does.
    const speed = segment.speed > 0 ? segment.speed : 1;
    // At 1x this stays the exact string it has always been, so an untouched
    // timeline still produces byte-identical FFmpeg arguments.
    const retime = Math.abs(speed - 1) < 1e-6
      ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed.toFixed(6)}`;
    const transform = segmentTransformFilter(segment, plan.canvas.sourceWidth,
      plan.canvas.sourceHeight);
    // Colour first, on the source pixels, then geometry - the order the preview
    // composes in, and the order that keeps crop/rotation/pad black genuinely
    // black. See edit-mode-color-filter.ts for the full rationale.
    const color = colorAdjustmentFilter(segment.color);
    graph.push(`[${n > 1 ? `vs${i}` : sourceVideo}]trim=start=${seconds(segment.sourceStart)}:` +
      `end=${seconds(segment.sourceEnd)},setpts=${retime}` +
      `${color ? `,${color}` : ''}` +
      `${gradeBeforeGeometry ? `,${plan.grading.filter}` : ''}` +
      `${transform ? `,${transform}` : ''}[v${i}]`);
    if (withAudio) {
      // A 12 ms fade at each join removes the click a hard audio cut produces
      // without being audible as a fade. A single-segment export gets none.
      // The fade is timed on the OUTPUT length, after atempo has resampled it.
      const length = (segment.sourceEnd - segment.sourceStart) / speed;
      const tempo = atempoChain(speed);
      const fades = n > 1 ? `,afade=t=in:d=0.012,afade=t=out:` +
        `st=${seconds(Math.max(0, length - 0.012))}:d=0.012` : '';
      // Source level is per SEGMENT, so a split timeline can mute one clip and
      // leave the next at full level. At 1 it emits nothing, keeping an
      // untouched timeline's arguments byte-identical.
      const gain = segment.sourceMuted ? 0 : segment.sourceVolume;
      const level = Math.abs(gain - 1) < 1e-6 ? '' : `,volume=${gain.toFixed(4)}`;
      graph.push(`[${n > 1 ? `as${i}` : '0:a'}]atrim=start=${seconds(segment.sourceStart)}:` +
        `end=${seconds(segment.sourceEnd)},asetpts=PTS-STARTPTS` +
        `${tempo ? `,${tempo}` : ''}${level}${fades}[a${i}]`);
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
  const layoutFrame = plan.canvas.visualLayout?.videoFrame;
  const useLayoutFrame = layoutFrame?.mode === 'CARD';
  // A resolved card is the canonical composition. Dynamic FIT branches would
  // otherwise create an unused overlay output and fight the exact card frame.
  const useFit = Boolean(input.fitExpression) && !useLayoutFrame;
  const useInformationFit = Boolean(input.informationFitExpression && input.informationCrop) && !useLayoutFrame;
  // Inside a fixed card (Automatic 2) graphics/screenshots are still fitted, but the
  // fitted layer is confined to the card: the outer geometry never changes.
  const cardFit = useLayoutFrame && Boolean(input.fitExpression);
  const cardInfoFit = useLayoutFrame && Boolean(input.informationFitExpression && input.informationCrop);
  const branches = useLayoutFrame
    ? ['vlayoutsrc', ...(cardFit ? ['vfitsrc'] : []), ...(cardInfoFit ? ['vinfosrc'] : [])]
    : ['vfillsrc', ...(useFit ? ['vfitsrc'] : []), ...(useInformationFit ? ['vinfosrc'] : [])];
  graph.push(`[vcat]fps=${fps},setsar=1` +
    (branches.length > 1 ? `,split=${branches.length}${branches.map((b) => `[${b}]`).join('')}`
      : `[${branches[0]}]`));

  const zoomFor = (zoomWidth: number, zoomHeight: number) => plan.zoomEvents.length
    ? `,zoompan=z='${zoomEnvelopeExpression(plan.zoomEvents)}':` +
      `x='(iw-iw/zoom)*(${zoomAnchorExpression(plan.zoomEvents, 'focusX')})':` +
      `y='(ih-ih/zoom)*(${zoomAnchorExpression(plan.zoomEvents, 'focusY')})':` +
      `d=1:s=${zoomWidth}x${zoomHeight}:fps=${fps}`
    : '';
  if (!useLayoutFrame) graph.push(`[vfillsrc]${input.cameraFilter}${zoomFor(width, height)}[vfill]`);

  let composited = 'vfill';
  if (useFit) {
    fittedLayer(graph, 'vfitsrc', 'vfit', width, height, undefined,
      plan.canvas.fitBackground ?? 'BLUR', manualCropExpression);
    graph.push(`[${composited}][vfit]overlay=0:0:enable='${input.fitExpression}'[vfitted]`);
    composited = 'vfitted';
  }
  if (useInformationFit && input.informationCrop) {
    const crop = input.informationCrop;
    fittedLayer(graph, 'vinfosrc', 'vinfo', width, height,
      `${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
      plan.canvas.fitBackground ?? 'BLUR', manualCropExpression);
    graph.push(`[${composited}][vinfo]overlay=0:0:` +
      `enable='${input.informationFitExpression}'[vinfofitted]`);
    composited = 'vinfofitted';
  }
  if (useLayoutFrame && layoutFrame) {
    const frameWidth = Math.max(2, Math.round(layoutFrame.width * width));
    const frameHeight = Math.max(2, Math.round(layoutFrame.height * height));
    const frameX = Math.round(layoutFrame.x * width);
    const frameY = Math.round(layoutFrame.y * height);
    const background = plan.canvas.visualLayout?.background.color ?? '#000000';
    const cropBackdrop = manualCropExpression && plan.canvas.visualLayout?.editingProfile !== 'AUTOMATIC_3_STYLE_TWO'
      ? `,drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='${manualCropExpression}'`
      : '';
    graph.push(`color=c=${background}:s=${width}x${height}:r=${fps}` +
      `${cropBackdrop}[vlayoutbg]`);
    // Camera resolution happens first, preserving the face/information-safe
    // crop, then the result fills the intentional picture region.
    // Automatic 2's camera is already solved at the card aspect. Keep zoompan
    // at that same size; emitting a 9:16 zoom surface here would create a
    // second centre crop and cut the speaker's forehead again.
    graph.push(`[vlayoutsrc]${input.cameraFilter}${zoomFor(frameWidth, frameHeight)},` +
      `scale=${frameWidth}:${frameHeight}:` +
      `force_original_aspect_ratio=increase,crop=${frameWidth}:${frameHeight}[vlayoutfg]`);
    graph.push(`[vlayoutbg][vlayoutfg]overlay=${frameX}:${frameY}[vlaidout]`);
    composited = 'vlaidout';
    // Information-safe shots: the whole frame (or its readable region) is fitted
    // inside the card on black, never face-cropped or filled.
    if (cardFit) {
      fittedLayer(graph, 'vfitsrc', 'vfit', frameWidth, frameHeight, undefined, 'BLACK');
      graph.push(`[${composited}][vfit]overlay=${frameX}:${frameY}:enable='${input.fitExpression}'[vcardfit]`);
      composited = 'vcardfit';
    }
    if (cardInfoFit && input.informationCrop) {
      const crop = input.informationCrop;
      fittedLayer(graph, 'vinfosrc', 'vinfo', frameWidth, frameHeight,
        `${crop.width}:${crop.height}:${crop.x}:${crop.y}`, 'BLACK');
      graph.push(`[${composited}][vinfo]overlay=${frameX}:${frameY}:` +
        `enable='${input.informationFitExpression}'[vcardinfo]`);
      composited = 'vcardinfo';
    }
  }

  // --- Grading --------------------------------------------------------------
  if (!gradeBeforeGeometry && plan.grading.filter && plan.grading.filter !== 'null') {
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
    // Crop and flip happen on the source pixels, before the overlay is sized;
    // rotation happens after, so the angle is the one seen on the canvas. rgba
    // is established first so a rotated overlay opens transparent corners, not
    // black ones. This is the same order the preview's CSS transform composes in.
    const shape = overlayTransformFilter({ crop: overlay.crop, rotation: 0,
      flipH: overlay.flipH, flipV: overlay.flipV });
    const spin = overlayTransformFilter({ crop: { left: 0, right: 0, top: 0, bottom: 0 },
      rotation: overlay.rotation, flipH: false, flipV: false });
    graph.push(`[${inputIndex}:v]${shape ? `${shape},` : ''}${fit},format=rgba` +
      `${spin ? `,${spin}` : ''},` +
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
    graph.push(`[${composited}]ass=${input.assFileName}${input.fontsDir ? `:fontsdir=${input.fontsDir}` : ''},format=yuv420p[vout]`);
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
    // Ducking comes LAST, after adelay, because the automation is written in
    // EXPORTED-timeline seconds and only after the delay does this stream's `t`
    // mean that. It is applied only to a track that explicitly asked for it, and
    // only when the cached transcript actually yielded speech windows - the
    // source's own speech is never ducked by anything here.
    const duckExpression = track.duckUnderSpeech && plan.duckingAvailable
      ? duckVolumeExpression(plan.speechWindows, track.duckLevel, track.attackMs,
        track.releaseMs) : '';
    // Commas inside the expression would otherwise read as filter separators.
    const duck = duckExpression
      ? `,volume=volume='${duckExpression.replace(/,/gu, '\\,')}':eval=frame` : '';
    graph.push(`[${inputIndex}:a]atrim=start=${seconds(track.trimStart)}:` +
      `end=${seconds(track.trimEnd)},asetpts=PTS-STARTPTS,` +
      `aformat=sample_rates=48000:channel_layouts=stereo,` +
      `atrim=start=0:end=${seconds(length)},asetpts=PTS-STARTPTS,` +
      `volume=${track.volume.toFixed(4)}${fadeIn}${fadeOut}${delay}${duck}[${label}]`);
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
    if (input.preserveSourceAudio) graph.push('[amixed]anull[aout]');
    else graph.push('[amixed]alimiter=level_in=1:level_out=1:limit=0.95:attack=5:release=50,' +
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
