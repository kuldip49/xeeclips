import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { stat } from 'fs/promises';
import { availableParallelism } from 'os';
import { EditPlan, TimedWord } from './edit-plan';
import { SubtitleRendererService } from './subtitle-renderer.service';
import { OUTPUT_DIMENSIONS, ReframeService, VisualTrack } from './reframe.service';
import { createTimelineMapper, Cut } from './timeline-remap';
import { gradingFilter, predictGradeStrength, resolveGradePreset, sampleImageStats, statsFromRgb } from './color-grade';
import { BackgroundMode, PLATFORM_LAYOUT_PRESETS, Rect, chooseVideoTemplate,
  sourceAwarePlatformLayout, usableContentAreaRatio } from './platform-layout';
import { backgroundColors, buildPaletteSegments, DEFAULT_SOURCE_PALETTE, paletteFromPixels,
  PaletteSegment, paletteTrackFilter, PaletteTrack, sampleSourceFrames, SampledFrame, SourcePalette,
  tintAt } from './source-palette';
import { buildEditedTimeline, EditedTimeline, finalToSource } from './edit-timeline';
import type { AnalysisFrame, EditAnalysis } from './edit-analysis';
import { classifyShots, fitEnableExpression, Shot } from './shot-classifier';
import { detectInformationRegions, regionCropRect } from './information-region';
import { planZoomEvents, ZoomEvent, zoomAnchorExpression, zoomExpression, zoomScaleAt } from './zoom-planner';
import { loadSfxLibrary, selectSfx, sfxGainDb, sfxPolicy, SfxAsset, SfxType } from './sfx-library';
import { measureSubjectSafety } from './subject-safety';
import { chooseThumbnailTime, ThumbnailChoice } from './thumbnail-frame';
import { hookAccentBudget } from './hook-accent';
import { HOOK_LENGTH } from './hook-generator';
import { HOOK_TYPE } from './text-layout';
import { INLINE_FALLBACK_TRACK, loadMusicLibrary, musicGainDb, musicPolicy, MusicMood, MusicTrack,
  selectMusicTrack } from './music-library';
import { ZOOM_INTENSITY_BANDS, ZOOM_TUNING } from './zoom-planner';
import { collisionAreaRatio, HOOK_PLATE, SUBTITLE_TIMING } from './subtitle-renderer.service';
import { check, EditQualityError, evaluateGate, fullRenderRepairActions, QualityCheck, RepairAction,
  repairInvalidation, RepairLog } from './edit-quality-gate';
import { assToRgb, audioEnvelope, contrastRatio, estimateZoom, extractFrames, firstOnsetSec, Frame,
  luminance, maskAgreement, meanDb, measureOnsetOffsets, measureOnsets, median, percentile, probeMask,
  normalQaFrameNumbers, MAX_NORMAL_QA_FRAMES, MAX_QA_DECODE_BATCH_FRAMES, QA_SCALE, rectMask, regionStats, renderAssProbe,
  toGray } from './render-qa';
import type { BoundaryDecision } from './edit-boundaries';
import { hookMetaLanguageFree } from './editing-plan-validator';

const execFileAsync = promisify(execFile);
export function ffmpegThreadsPerRender() {
  const raw = process.env.FFMPEG_THREADS_PER_RENDER;
  const configured = Number(raw);
  if (raw != null && raw.trim() !== '' && Number.isFinite(configured))
    return Math.max(1, Math.min(16, Math.floor(configured)));
  const concurrency = Math.max(1, Math.min(4, Number(process.env.AI_EDITED_RENDER_CONCURRENCY) || 2));
  return Math.max(1, Math.min(8, Math.floor(availableParallelism() / concurrency)));
}
type ProbeResult = { streams: Array<{ codec_type: string; codec_name?: string; width?: number;
  height?: number; avg_frame_rate?: string; start_time?: string }>; format?: { duration?: string } };
async function probe(path: string) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_streams',
    '-show_format', '-of', 'json', path], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout) as ProbeResult;
}

export function subtitleRetimeDecision(offsetsSec: number[]) {
  if (offsetsSec.length < 4) return null;
  const residualSec = median(offsetsSec);
  const spreadMs = median(offsetsSec.map((value) => Math.abs(value - residualSec))) * 1000;
  const averageMs = offsetsSec.reduce((sum, value) => sum + Math.abs(value), 0) /
    offsetsSec.length * 1000;
  const adjustedAverageMs = offsetsSec.reduce((sum, value) => sum + Math.abs(value - residualSec), 0) /
    offsetsSec.length * 1000;
  if (Math.abs(residualSec) < .01 || spreadMs > 60 || averageMs <= 50 ||
    adjustedAverageMs >= averageMs - 5) return null;
  return { offsetSec: Math.max(-.3, Math.min(.3, residualSec)),
    residualMs: Math.round(residualSec * 1000), averageMs: Math.round(averageMs * 10) / 10,
    adjustedAverageMs: Math.round(adjustedAverageMs * 10) / 10, spreadMs: Math.round(spreadMs) };
}

async function renderSpeechQa(inputPath: string, outputPath: string,
  segments: Array<{ start: number; end: number }>) {
  const graph: string[] = [];
  if (segments.length > 1)
    graph.push(`[0:a]asplit=${segments.length}${segments.map((_, index) => `[as${index}]`).join('')}`);
  segments.forEach((segment, index) => {
    const source = segments.length > 1 ? `as${index}` : '0:a';
    graph.push(`[${source}]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},` +
      `asetpts=PTS-STARTPTS[a${index}]`);
  });
  if (segments.length > 1)
    graph.push(`${segments.map((_, index) => `[a${index}]`).join('')}concat=n=${segments.length}:v=0:a=1[acat]`);
  else graph.push('[a0]anull[acat]');
  graph.push('[acat]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=70,' +
    'acompressor=threshold=0.1:ratio=2.5:attack=15:release=250:makeup=1.4,' +
    'aresample=16000,aformat=channel_layouts=mono[speech]');
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', inputPath, '-filter_complex', graph.join(';'),
    '-map', '[speech]', '-vn', '-c:a', 'pcm_s16le', outputPath], { maxBuffer: 10 * 1024 * 1024 });
}

// Legacy helpers kept for callers that only have a plan and cuts.
export function buildZoomEvents(plan: EditPlan, cuts: Cut[],
  focalAt: (t: number) => { x: number; y: number } = () => ({ x: .5, y: .5 }),
  fps = 30, words: TimedWord[] = []) {
  return planZoomEvents({ plan, cuts, words, fps, focalAt }).events;
}
export function buildZoomExpression(plan: EditPlan, cuts: Cut[], fps = 30, words: TimedWord[] = []) {
  return zoomExpression(buildZoomEvents(plan, cuts, undefined, fps, words));
}
// Ambient editorial background: the running footage, heavily blurred at low
// resolution, temporally smoothed (shot cuts become ~1/3 s dissolves), darkened,
// desaturated and mixed with the per-scene palette tint.
export const AMBIENT_BACKGROUND = { width: 216, height: 384, sigma: 16, smoothFrames: 11,
  luma: .62, chroma: .62, tintWeight: .45 } as const;
// A slower fade-in reads as a bed that was always there rather than one that
// was switched on; the long tail lets the clip finish rather than stop.
export const MUSIC_MIX = { fadeInSec: .9, fadeOutSec: 1.8,
  // Carve the band speech lives in out of the bed, so the music can sit at a
  // useful level without ever competing with the voice.
  speechCarve: 'equalizer=f=2400:width_type=o:width=2:g=-4,equalizer=f=400:width_type=o:width=1.5:g=-2',
  // Fast enough to duck before the word lands, slow enough not to pump.
  duck: 'sidechaincompress=threshold=0.03:ratio=8:attack=12:release=520' } as const;
/**
 * Sound design sits under everything else (§16/§17). Each effect is trimmed to a
 * short window, ducked by the speech it plays beneath, and the whole bus is
 * limited so a stacked effect and a loud word can never clip together.
 */
export const SFX_MIX = {
  // Longest window a single effect may occupy, so a long asset cannot drone on.
  maxLengthSec: 1.2, fadeInSec: .01, fadeOutSec: .06,
  // Faster and gentler than the music duck: the effect must still be audible
  // under the voice, just never in front of it.
  duck: 'sidechaincompress=threshold=0.08:ratio=3:attack=5:release=180',
  // Peak ceiling for the whole effects bus, well under the speech it joins.
  limit: 'alimiter=limit=0.25:attack=2:release=60:level=disabled',
  // Effects must land within this of the motion they belong to (§15).
  timingToleranceSec: .1
} as const;
export function ambientBackgroundFilter(source: string, tint: string, output: string,
  canvas: { width: number; height: number }, extraDarken = 0) {
  const { width: w, height: h } = AMBIENT_BACKGROUND;
  const luma = Math.max(.25, AMBIENT_BACKGROUND.luma - extraDarken * .3).toFixed(3);
  const chroma = AMBIENT_BACKGROUND.chroma.toFixed(3);
  // blend "average" mixes 50/50 at opacity 1; lower opacity shifts toward the footage.
  const opacity = (AMBIENT_BACKGROUND.tintWeight * 2).toFixed(3);
  return [
    `[${source}]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h},` +
      `gblur=sigma=${AMBIENT_BACKGROUND.sigma},tmix=frames=${AMBIENT_BACKGROUND.smoothFrames},` +
      `lutyuv=y='16+(val-16)*${luma}':u='128+(val-128)*${chroma}':v='128+(val-128)*${chroma}',` +
      `format=yuv444p[ambraw]`,
    `[${tint}]scale=${w}:${h}:flags=bilinear,format=yuv444p[ambtint]`,
    `[ambraw][ambtint]blend=all_mode=average:all_opacity=${opacity}:shortest=0,` +
      `scale=${canvas.width}:${canvas.height}:flags=bicubic,format=yuv420p[${output}]`
  ];
}
// Expected ambient header color for a source color: darkened footage mixed with the tint.
export function expectedAmbientColor(tint: number[], sourceMean: number[], extraDarken = 0) {
  const luma = Math.max(.25, AMBIENT_BACKGROUND.luma - extraDarken * .3);
  // Scaling Y and chroma about their offsets by the same factor scales full-range RGB.
  return tint.map((value, i) => value * AMBIENT_BACKGROUND.tintWeight +
    sourceMean[i] * luma * (1 - AMBIENT_BACKGROUND.tintWeight));
}

export type RenderOptions = {
  hookFontScale: number; hookShortenLevel: number; hookWidthScale: number; headerDarken: number;
  zoomDisabled: boolean; zoomScaleCap?: number; zoomScaleFloor?: number;
  fitShots: number[]; forceInformationFit: boolean; subtitleOffsetSec: number;
  subtitleFontScale: number; emphasisBoost: boolean; backgroundMode?: BackgroundMode;
  useDefaultPalette: boolean; musicAttempt: number; musicGainOffsetDb: number;
  musicDisabled: boolean; gradeStrength: number; responsiveCamera: boolean;
  hookHeightScale: number; singlePalette: boolean; musicUseInline: boolean;
  sfxDisabled: boolean; sfxGainOffsetDb: number;
  zoomRepairAttempted: boolean; subtitleRetimeAttempted: boolean;
  cameraStructuralRepair: boolean;
  zoomSuppressions: Array<{ triggerTimestamp: number; reason: string }>;
};
export const DEFAULT_RENDER_OPTIONS: RenderOptions = { hookFontScale: 1, hookShortenLevel: 0,
  hookWidthScale: 1, headerDarken: 0, zoomDisabled: false, fitShots: [],
  forceInformationFit: false, subtitleOffsetSec: 0, subtitleFontScale: 1, emphasisBoost: false,
  useDefaultPalette: false, musicAttempt: 0, musicGainOffsetDb: 0, musicDisabled: false,
  gradeStrength: 1, responsiveCamera: false, hookHeightScale: 1, singlePalette: false,
  musicUseInline: false, sfxDisabled: false, sfxGainOffsetDb: 0,
  zoomRepairAttempted: false, subtitleRetimeAttempted: false,
  cameraStructuralRepair: false, zoomSuppressions: [] };

export type PreRenderFailure = { reason: 'INVALID_CROP' | 'STALE_INTERPOLATION' |
  'INVALID_HARD_CUT_RESET' | 'CAMERA_ACTIVE_IN_FINAL_FREEZE' | 'ZOOM_CROSSES_SHOT_BOUNDARY' |
  'ZOOM_ACTIVE_IN_FINAL_FREEZE' | 'INVALID_FACE_CROP_STATE' | 'INFORMATION_CROP_OUT_OF_BOUNDS' |
  'ZOOM_COVERAGE_IMPOSSIBLE'; timestamp: number; shotBeforeId: number | null;
  shotAfterId: number | null; detail: string };

export type PreRenderClassification = 'READY' | 'REPAIRABLE_PRE_RENDER' | 'SKIP_BEFORE_RENDER';

/** Tier-A validation: rejects structural camera defects before FFmpeg spends
 * time encoding pixels. It observes the exact camera plan used by the renderer. */
export function validatePreRenderCamera(camera: ReturnType<ReframeService['plan']>,
  shots: Shot[], finalDuration: number): PreRenderFailure[] {
  const failures: PreRenderFailure[] = [];
  const finiteCrop = (t: number) => {
    const crop = camera.cropAt(t);
    return [crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) && crop.w > 0 && crop.h > 0;
  };
  for (let index = 1; index < shots.length; index++) {
    const at = shots[index].start;
    if (!finiteCrop(Math.max(0, at - .001)) || !finiteCrop(at + .001))
      failures.push({ reason: 'INVALID_CROP', timestamp: at, shotBeforeId: index - 1,
        shotAfterId: index, detail: 'Non-finite crop at hard-cut boundary' });
    const move = camera.cameraMoves.find((item) => item.snapped && Math.abs(item.t - at) <= .12);
    const before = camera.cropAt(Math.max(0, at - .002));
    const after = camera.cropAt(at + .002);
    const changed = Math.hypot(after.x - before.x, after.y - before.y) > .003;
    if (shots[index - 1]?.layout === 'FIT' || shots[index]?.layout === 'FIT') continue;
    if (changed && (!move || move.durationSec > .01))
      failures.push({ reason: 'STALE_INTERPOLATION', timestamp: at, shotBeforeId: index - 1,
        shotAfterId: index, detail: 'Cross-shot crop change is not an immediate reset' });
    if (changed && !camera.shotCutResetsCamera)
      failures.push({ reason: 'INVALID_HARD_CUT_RESET', timestamp: at, shotBeforeId: index - 1,
        shotAfterId: index, detail: 'Camera state was not reset at the hard cut' });
  }
  const from = camera.cropAt(Math.max(0, finalDuration - .4));
  const to = camera.cropAt(Math.max(0, finalDuration - .02));
  const velocity = Math.max(Math.abs(to.x - from.x) / Math.max(.001, to.w),
    Math.abs(to.y - from.y) / Math.max(.001, to.h));
  if (velocity > .01 && shots[shots.length - 1]?.layout !== 'FIT') failures.push({ reason: 'CAMERA_ACTIVE_IN_FINAL_FREEZE',
    timestamp: Math.max(0, finalDuration - .4), shotBeforeId: shots.length - 1,
    shotAfterId: null, detail: `Final crop delta ${velocity.toFixed(4)}` });
  return failures;
}

export function validatePreRenderStructure(input: {
  camera: ReturnType<ReframeService['plan']>; shots: Shot[]; finalDuration: number;
  zoomPlan: ReturnType<typeof planZoomEvents>;
  informationRegions?: Array<{ region: { x: number; y: number; w: number; h: number } }>;
}): PreRenderFailure[] {
  const failures = validatePreRenderCamera(input.camera, input.shots, input.finalDuration);
  const boundaries = input.shots.slice(1).map((shot) => shot.start);
  for (const event of input.zoomPlan.events) {
    const crossing = boundaries.find((at) => event.startSec < at - .001 && event.endSec > at + .001);
    if (crossing != null) failures.push({ reason: 'ZOOM_CROSSES_SHOT_BOUNDARY', timestamp: crossing,
      shotBeforeId: Math.max(0, input.shots.findIndex((shot) => shot.start === crossing) - 1),
      shotAfterId: input.shots.findIndex((shot) => shot.start === crossing),
      detail: `Zoom ${event.startSec.toFixed(3)}-${event.endSec.toFixed(3)} crosses a shot cut` });
    if (event.endSec > input.finalDuration - .4 + .001)
      failures.push({ reason: 'ZOOM_ACTIVE_IN_FINAL_FREEZE', timestamp: event.endSec,
        shotBeforeId: input.shots.length - 1, shotAfterId: null,
        detail: 'Semantic zoom has not returned before the final freeze window' });
    if (!event.faceLockValid || !event.subjectSafeDuringZoom)
      failures.push({ reason: 'INVALID_FACE_CROP_STATE', timestamp: event.startSec,
        shotBeforeId: input.shots.findIndex((shot) => event.startSec >= shot.start && event.startSec < shot.end),
        shotAfterId: null, detail: 'Zoom subject/crop lock is structurally unsafe' });
  }
  for (const entry of input.informationRegions ?? []) {
    const region = entry.region;
    if (![region.x, region.y, region.w, region.h].every(Number.isFinite) || region.w <= 0 || region.h <= 0 ||
      region.x < 0 || region.y < 0 || region.x + region.w > 1.0001 || region.y + region.h > 1.0001)
      failures.push({ reason: 'INFORMATION_CROP_OUT_OF_BOUNDS', timestamp: 0,
        shotBeforeId: null, shotAfterId: null, detail: 'Detected information crop falls outside source bounds' });
  }
  if (!input.zoomPlan.zoomCoverageValid)
    failures.push({ reason: 'ZOOM_COVERAGE_IMPOSSIBLE', timestamp: 0, shotBeforeId: null,
      shotAfterId: null, detail: `${input.zoomPlan.events.length}/${input.zoomPlan.requiredZoomCount} safe zooms` });
  return failures;
}

export function classifyPreRenderFailures(failures: PreRenderFailure[]): PreRenderClassification {
  if (!failures.length) return 'READY';
  const unrecoverable = failures.some((failure) => ['INVALID_CROP', 'ZOOM_COVERAGE_IMPOSSIBLE']
    .includes(failure.reason));
  return unrecoverable ? 'SKIP_BEFORE_RENDER' : 'REPAIRABLE_PRE_RENDER';
}

/** Maps structural zoom failures to only the event(s) that caused them.  This
 * is intentionally pure so a late final-freeze conflict can never become a
 * clip-wide "disable zoom" repair again. */
export function localZoomSuppressions(failures: PreRenderFailure[], events: ZoomEvent[]) {
  const result: Array<{ triggerTimestamp: number; reason: string }> = [];
  for (const failure of failures.filter((item) => item.reason === 'ZOOM_CROSSES_SHOT_BOUNDARY' ||
    item.reason === 'ZOOM_ACTIVE_IN_FINAL_FREEZE')) {
    const affected = events.filter((event) => failure.reason === 'ZOOM_CROSSES_SHOT_BOUNDARY' ?
      event.startSec < failure.timestamp && event.endSec > failure.timestamp :
      Math.abs(event.endSec - failure.timestamp) <= .05);
    for (const event of affected) if (!result.some((item) =>
      Math.abs(item.triggerTimestamp - event.triggerTimestamp) <= .08))
      result.push({ triggerTimestamp: event.triggerTimestamp, reason: failure.reason });
  }
  return result;
}
// Music repair ladder: another library track, then (when music is required) the
// in-graph generated bed, then no music (the gate then reports DEGRADED).
function escalateMusic(options: RenderOptions, required: boolean) {
  options.musicAttempt++;
  if (options.musicAttempt < 2) return;
  if (required && !options.musicUseInline) options.musicUseInline = true;
  else options.musicDisabled = true;
}

// The headline is white with one or two accent words, and the primary accent
// (red) has a relative luminance of about .4 - below probeMask's default .5. The
// hook mask must include the accent words or QA measures only part of the
// headline: a line that happens to hold the accent alone would read as missing.
export const HOOK_MASK_MIN_LUMINANCE = .3;
/**
 * The headline is dark charcoal (plus one accent colour) on a near-white plate,
 * so its glyphs are the DARK pixels inside the plate rather than the bright ones
 * in the header. The mask is therefore taken over the plate's own rectangle,
 * inset a few pixels so the plate's antialiased edge cannot join the mask.
 */
export function hookGlyphMask(frame: Frame, plateAtScale: Rect | null) {
  const inset = 4;
  const region = plateAtScale ? { x: plateAtScale.x + inset, y: plateAtScale.y + inset,
    width: Math.max(1, plateAtScale.width - inset * 2),
    height: Math.max(1, plateAtScale.height - inset * 2) } : undefined;
  return probeMask(frame, { maxLuminance: HOOK_PLATE.maxTextLuminance, region });
}
// The glyph block inside a plate: the plate minus its padding and the fit's own
// stroke padding, which is what the fitted width/height were measured without.
export function hookGlyphExtent(plate: Rect) {
  return { width: Math.max(1, plate.width - HOOK_PLATE.padX * 2 - HOOK_TYPE.strokePad * 2),
    height: Math.max(1, plate.height - HOOK_PLATE.padY * 2 - HOOK_TYPE.strokePad * 2) };
}

export type LoopDecision = { loopSuitable: boolean; loopApplied: boolean; loopRejectedReason: string;
  loopVisualSimilarity: number | null };

export type ExecuteContext = {
  // Source time of the first frame of `inputPath`. Defaults to plan.clipStartSec.
  inputOffsetSec?: number;
  timeline?: EditedTimeline;
  analysis?: EditAnalysis;
  boundary?: BoundaryDecision;
  loop?: LoopDecision;
  seed?: string;
  maxAttempts?: number;
  qa?: boolean;
  musicDirectory?: string;
  avoidMusicTrackIds?: string[];
  sfxDirectory?: string;
  candidateId?: string;
  rank?: number;
};

// Visual continuity check between the first and last edited frames.
export async function evaluateLoop(inputPath: string, inputOffset: number, timeline: EditedTimeline,
  plan: EditPlan, boundary?: BoundaryDecision): Promise<LoopDecision> {
  const base = { loopSuitable: plan.loopSuitable === true, loopApplied: false,
    loopVisualSimilarity: null as number | null };
  if (!plan.loopSuitable) return { ...base, loopRejectedReason: 'NOT_EDITORIALLY_SUITABLE' };
  if (boundary && !boundary.clipEndComplete) return { ...base, loopRejectedReason: 'ENDING_INCOMPLETE' };
  try {
    const grab = async (t: number) => {
      const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-ss', Math.max(0, t).toFixed(3),
        '-i', inputPath, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 });
      return stdout as Buffer;
    };
    const first = await grab(timeline.editedStart - inputOffset + .05);
    const last = await grab(timeline.editedEnd - inputOffset - .12);
    let diff = 0;
    for (let i = 0; i < Math.min(first.length, last.length); i++) diff += Math.abs(first[i] - last[i]);
    const similarity = 1 - diff / Math.max(1, Math.min(first.length, last.length)) / 255;
    if (similarity < .9) return { ...base, loopVisualSimilarity: similarity,
      loopRejectedReason: 'VISUAL_DISCONTINUITY' };
    return { ...base, loopApplied: true, loopVisualSimilarity: similarity, loopRejectedReason: '' };
  } catch (error) {
    return { ...base, loopRejectedReason: `LOOP_CHECK_FAILED:${error instanceof Error ? error.message.slice(0, 80) : ''}` };
  }
}

// Energy onsets on real speech are noisy (breaths, soft consonants); only
// offsets inside the typical transcript error range are trusted.
const SNAP_RANGE = { min: -.12, max: .25 };
// Snaps Whisper word starts to the measured speech onset in the source audio.
// Words without a clear onset get the (shrunk) median correction.
export async function refineWordOnsets(inputPath: string, inputOffset: number, words: TimedWord[],
  timeline: EditedTimeline) {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const envelope = await audioEnvelope(inputPath);
  const offsets = measureOnsets(envelope, sorted.map((word, index) => ({
    start: word.start - inputOffset, end: word.end - inputOffset,
    gapBefore: index === 0 ? 1 : word.start - sorted[index - 1].end })));
  const measured = offsets.map((offset, index) => ({ offset, word: sorted[index] }))
    .filter((item): item is { offset: number; word: TimedWord } => item.offset != null &&
      item.word.start >= timeline.editedStart - .5 && item.word.end <= timeline.editedEnd + .5 &&
      item.offset >= SNAP_RANGE.min && item.offset <= SNAP_RANGE.max);
  const values = measured.map((item) => item.offset);
  // Consistent measurements (small spread) are trusted fully; noisy ones are shrunk.
  const center = values.length ? median(values) : 0;
  const spread = values.length ? median(values.map((value) => Math.abs(value - center))) : 1;
  const shared = values.length >= 5 ? Math.max(-.15, Math.min(.15,
    spread <= .03 ? center : center * values.length / (values.length + 3))) : 0;
  // Local RMS prominence is kept on each timed word for semantic peak ranking.
  // It is relative to this clip's own speech, so a calm speaker can still have
  // meaningful local peaks without being compared with a louder recording.
  const wordDb = sorted.map((word) => {
    const first = Math.max(0, Math.floor((word.start - inputOffset) / envelope.hopSec));
    const last = Math.min(envelope.db.length - 1,
      Math.ceil((word.end - inputOffset) / envelope.hopSec));
    let peak = -100;
    for (let i = first; i <= last; i++) peak = Math.max(peak, envelope.db[i]);
    return peak;
  });
  const energyFloor = percentile(wordDb, .25);
  const energyPeak = percentile(wordDb, .9);
  let snapped = 0;
  const refined = sorted.map((word, index) => {
    const own = offsets[index];
    const usable = own != null && own >= SNAP_RANGE.min && own <= SNAP_RANGE.max;
    const shift = usable ? own! : shared;
    if (usable) snapped++;
    const previousStart = index > 0 ? sorted[index - 1].start + .02 : -Infinity;
    const start = Math.max(previousStart, Math.min(word.end - .05, word.start + shift));
    const audioEnergyScore = Math.max(0, Math.min(1,
      (wordDb[index] - energyFloor) / Math.max(3, energyPeak - energyFloor)));
    return { ...word, start, audioEnergyScore: Number(audioEnergyScore.toFixed(3)) };
  });
  const abs = values.map((value) => Math.abs(value) * 1000);
  return { words: refined, stats: { whisperOnsetSamples: values.length,
    whisperOnsetErrorAvgMs: abs.length ? round(abs.reduce((a, b) => a + b, 0) / abs.length, 1) : null,
    whisperOnsetErrorP95Ms: abs.length ? round(percentile(abs, .95), 1) : null,
    whisperOnsetMedianMs: values.length ? Math.round(median(values) * 1000) : null,
    snappedWordCount: snapped, sharedCorrectionMs: Math.round(shared * 1000) } };
}

function legacyAnalysis(faceTracks: VisualTrack[], personTracks: VisualTrack[]): EditAnalysis {
  const frames = new Map<number, AnalysisFrame>();
  const add = (key: 'faces' | 'persons', track: VisualTrack) => {
    const frame = frames.get(track.timestamp) ?? { t: track.timestamp, faces: [], persons: [],
      textCoverage: 0, textBoxes: [], ocrLines: [] };
    frame[key].push(track);
    frames.set(track.timestamp, frame);
  };
  faceTracks.forEach((track) => add('faces', track));
  personTracks.forEach((track) => add('persons', track));
  return { source: frames.size ? 'STORED_SPARSE' : 'NONE',
    frames: [...frames.values()].sort((a, b) => a.t - b.t), shotBoundaries: [], ocrText: '',
    fallbackReason: '', runtimeMs: 0 };
}

const round = (value: number | null | undefined, digits = 3) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const scaleRect = (rect: Rect, factor: number): Rect => ({ x: Math.floor(rect.x * factor),
  y: Math.floor(rect.y * factor), width: Math.ceil(rect.width * factor), height: Math.ceil(rect.height * factor) });
const inside = (inner: Rect, outer: Rect, margin = 0) => inner.x >= outer.x - margin &&
  inner.y >= outer.y - margin && inner.x + inner.width <= outer.x + outer.width + margin &&
  inner.y + inner.height <= outer.y + outer.height + margin;

@Injectable()
export class VideoEditExecutorService {
  private readonly logger = new Logger(VideoEditExecutorService.name);
  constructor(private readonly subtitles: SubtitleRendererService,
    private readonly reframe: ReframeService) {}

  /** Cheap, decode-free camera feasibility used before packaging/plan LLMs. */
  preflightStructure(input: { analysis: EditAnalysis; timeline: EditedTimeline;
    sourceWidth: number; sourceHeight: number; speakerChangeTimes?: number[];
    platformPreset: EditPlan['platformPreset'] }) {
    const started = Date.now();
    const output = OUTPUT_DIMENSIONS['9:16'];
    const baseLayout = PLATFORM_LAYOUT_PRESETS[input.platformPreset] ?? PLATFORM_LAYOUT_PRESETS.UNIVERSAL;
    const layout = sourceAwarePlatformLayout(baseLayout, input.sourceWidth, input.sourceHeight);
    const faces = input.analysis.frames.flatMap((frame) => frame.faces);
    const people = input.analysis.frames.flatMap((frame) => frame.persons);
    const makeCamera = (shots: Shot[]) => this.reframe.plan('9:16', faces, people,
      input.timeline.editedStart, input.timeline.cuts, input.sourceWidth, input.sourceHeight,
      input.speakerChangeTimes ?? [], 30, layout.videoViewport, true, { shots });
    const base = makeCamera([]);
    const shots = classifyShots(input.analysis, input.timeline, base.cropWidth,
      { preserveInformation: true });
    const camera = makeCamera(shots);
    const failures = validatePreRenderCamera(camera, shots, input.timeline.editedDuration);
    return { classification: classifyPreRenderFailures(failures), failures,
      repairRequired: failures.some((failure) => ['STALE_INTERPOLATION',
        'INVALID_HARD_CUT_RESET', 'CAMERA_ACTIVE_IN_FINAL_FREEZE'].includes(failure.reason)),
      shotCount: shots.length, zoomEligibleShotCount: shots.filter((shot) => shot.zoomAllowed).length,
      usableContentAreaRatio: usableContentAreaRatio(layout),
      outputResolution: output, runtimeMs: Date.now() - started };
  }

  async execute(inputPath: string, outputPath: string, plan: EditPlan, words: TimedWord[],
    faceTracks: VisualTrack[] = [], personTracks: VisualTrack[] = [],
    speakerChangeTimes: number[] = [], context: ExecuteContext = {}) {
    const started = Date.now();
    const directory = dirname(outputPath);
    const inputProbe = await probe(inputPath);
    const hasAudio = inputProbe.streams.some((stream) => stream.codec_type === 'audio');
    const sourceVideo = inputProbe.streams.find((stream) => stream.codec_type === 'video');
    if (!sourceVideo?.width || !sourceVideo.height) throw new Error('Source video has no dimensions');
    const rate = sourceVideo.avg_frame_rate?.split('/').map(Number) ?? [];
    const sourceFps = rate.length === 2 && rate[1] > 0 ? rate[0] / rate[1] : 30;
    const fps = Math.max(30, Math.min(60, Math.round(sourceFps)));
    const inputOffset = context.inputOffsetSec ?? plan.clipStartSec;
    const planCuts = plan.operations.filter((operation) =>
      operation.type === 'TRIM' || operation.type === 'REMOVE_SILENCE')
      .map((operation) => ({ start: operation.startSec, end: operation.endSec }));
    const timeline = context.timeline ?? buildEditedTimeline({ candidateStart: plan.clipStartSec,
      candidateEnd: plan.clipEndSec, editedStart: plan.clipStartSec, editedEnd: plan.clipEndSec,
      cuts: planCuts });
    // The render plan always spans the final edited range.
    const renderPlan: EditPlan = { ...plan, clipStartSec: timeline.editedStart, clipEndSec: timeline.editedEnd };
    const cuts = timeline.cuts;
    const finalDuration = timeline.editedDuration;
    if (context.boundary && !context.boundary.clipStartNatural &&
      !context.boundary.clipStartContextComplete) {
      throw new EditQualityError('Edited clip rejected before render: unusable start context', {
        preRenderClassification: 'SKIP_BEFORE_RENDER', candidateSkippedBeforeRender: true,
        preRenderRejectedCount: 1, skippedBeforeRenderCount: 1, preRenderRepairCount:
          context.boundary.openingRepairAttempted ? 1 : 0,
        preRenderRejectReason: 'UNREPAIRABLE_START_CONTEXT', fullRenderAttempts: 0,
        preRenderRejectReasons: ['UNREPAIRABLE_START_CONTEXT'],
        wastedRenderMs: 0, boundary: { clipStartNatural: context.boundary.clipStartNatural,
          clipStartContextComplete: context.boundary.clipStartContextComplete,
          openingRepairAttempted: context.boundary.openingRepairAttempted,
          openingRepairSucceeded: context.boundary.openingRepairSucceeded } });
    }
    const mapper = createTimelineMapper(timeline.editedStart, cuts);
    const analysis = context.analysis ?? legacyAnalysis(faceTracks, personTracks);
    const allFaces = analysis.frames.flatMap((frame) => frame.faces);
    const allPersons = analysis.frames.flatMap((frame) => frame.persons);
    const { width, height } = OUTPUT_DIMENSIONS[plan.aspectRatio];
    const template = chooseVideoTemplate(sourceVideo.width, sourceVideo.height,
      plan.videoTemplate, plan.recommendedTemplate);
    const editorial = plan.aspectRatio === '9:16' && template === 'EDITORIAL_FRAME';
    const baseLayout = PLATFORM_LAYOUT_PRESETS[plan.platformPreset] ?? PLATFORM_LAYOUT_PRESETS.UNIVERSAL;
    const layout = editorial ? sourceAwarePlatformLayout(baseLayout,
      sourceVideo.width, sourceVideo.height) : baseLayout;
    const viewport = editorial ? layout.videoViewport : { x: 0, y: 0, width, height };
    const cameraFor = (shots: Shot[], responsive = false, structuralRepair = false) => this.reframe.plan(plan.aspectRatio,
      allFaces, allPersons, timeline.editedStart, cuts, sourceVideo.width!, sourceVideo.height!,
      speakerChangeTimes, fps, editorial ? layout.videoViewport : undefined, editorial,
      { shots, responsive, structuralRepair });
    const baseCamera = cameraFor([]);
    const baseShots = classifyShots(analysis, timeline, baseCamera.cropWidth,
      { preserveInformation: plan.preserveInformation });
    const rangeInInput = { start: Math.max(0, timeline.editedStart - inputOffset),
      duration: timeline.sourceSpan };
    // One small decode of the edited span feeds the clip palette and every scene palette.
    let sampledPalette: SourcePalette | null = null;
    let sourceFrames: SampledFrame[] = [];
    if (editorial) {
      try {
        sourceFrames = await sampleSourceFrames(inputPath, rangeInInput);
        sampledPalette = sourceFrames.length ?
          paletteFromPixels(Buffer.concat(sourceFrames.map((frame) => frame.rgb))) : DEFAULT_SOURCE_PALETTE;
      } catch { sampledPalette = DEFAULT_SOURCE_PALETTE; }
    }
    const sourceStats = await sampleImageStats(inputPath).catch(() => ({ brightness: .5, contrast: .2,
      saturation: .3, highlightClipping: 0 }));
    const gradePreset = resolveGradePreset(plan.gradePreset, sourceStats);
    const gradePrediction = predictGradeStrength(gradePreset, sourceStats);
    const policy = musicPolicy();
    const requestedMood: MusicMood = plan.musicMood ?? 'CLEAN_NEUTRAL';
    // The editorial mood is never overridden: NONE is a legitimate, final decision,
    // not something the render layer second-guesses because a bed is "expected".
    const mood: MusicMood = requestedMood;
    // With music disabled by policy the decision itself is NO_MUSIC, so the whole
    // music QA family reports N/A instead of failing an edit for a missing bed.
    const musicDecision: 'USE_MUSIC' | 'NO_MUSIC' =
      !policy.enabled || mood === 'NONE' ? 'NO_MUSIC' : 'USE_MUSIC';
    // "Required" only ever forces a bed when the editorial layer actually asked for one.
    const musicRequired = policy.enabled && policy.required && hasAudio && musicDecision === 'USE_MUSIC';
    const library = policy.enabled && hasAudio && mood !== 'NONE' ?
      await loadMusicLibrary(context.musicDirectory) : { tracks: [] as MusicTrack[], problems: [] as string[] };
    const musicTracks = library.tracks.length || !musicRequired ? library.tracks : [INLINE_FALLBACK_TRACK];
    const musicApplicable = policy.enabled && hasAudio && mood !== 'NONE' && musicTracks.length > 0;
    const sfxSettings = sfxPolicy();
    const sfxLibrary = sfxSettings.enabled && hasAudio ?
      await loadSfxLibrary(context.sfxDirectory) : { assets: [] as SfxAsset[], problems: [] as string[] };
    const musicContext = { requestedMood, required: musicRequired, libraryProblems: library.problems,
      musicDecision };
    const avoidMusicTrackIds = new Set(context.avoidMusicTrackIds ?? []);
    const loop = context.loop ?? { loopSuitable: plan.loopSuitable === true, loopApplied: false,
      loopRejectedReason: plan.loopSuitable ? 'NOT_EVALUATED' : 'NOT_EDITORIALLY_SUITABLE',
      loopVisualSimilarity: null };
    const qaEnabled = context.qa !== false;
    const maxAttempts = Math.max(1, Math.min(2, context.maxAttempts ??
      (Number(process.env.MAX_FULL_VIDEO_RENDER_ATTEMPTS) ||
        Number(process.env.EDIT_MAX_RENDER_ATTEMPTS) || 2)));

    let renderWords = words;
    let onsetRefinement: Awaited<ReturnType<typeof refineWordOnsets>>['stats'] | null = null;
    if (hasAudio && qaEnabled && words.length) {
      try {
        const refined = await refineWordOnsets(inputPath, inputOffset, words, timeline);
        renderWords = refined.words;
        onsetRefinement = refined.stats;
        // Keep emphasis anchored to the same spoken words after the onset snap.
        const sortedOriginal = [...words].sort((a, b) => a.start - b.start);
        renderPlan.subtitleEmphasis = renderPlan.subtitleEmphasis.map((item) => {
          const original = sortedOriginal.find((word) => Math.abs(word.start - item.startSec) < .05);
          const index = original ? sortedOriginal.indexOf(original) : -1;
          const next = index >= 0 ? refined.words[index] : undefined;
          return next ? { ...item, startSec: next.start, endSec: next.end } : item;
        });

      } catch (error) {
        this.logger.warn(`Word onset refinement skipped: ${error instanceof Error ? error.message : error}`);
      }
    }
    const options: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, fitShots: [],
      gradeStrength: gradePrediction.strength };
    const repairs: RepairLog[] = [];
    const attempts: Array<Record<string, unknown>> = [];
    let preRenderValidationMs = 0;
    let overlayOnlyRepairCount = 0;
    let result: Awaited<ReturnType<VideoEditExecutorService['renderAttempt']>> | null = null;
    let cachedBasePlan: { shots: Shot[]; camera: ReturnType<ReframeService['plan']>;
      zoomPlan: ReturnType<typeof planZoomEvents> } | null = null;
    let basePlanInvalidated = true;
    let basePlanCacheHits = 0;
    let preRenderRepairCount = 0;
    let cameraRepairAttemptCount = 0;
    let cameraRepairSuccessCount = 0;
    let cameraRepairPending = false;
    let preRenderClassification: PreRenderClassification = 'READY';
    const gradingRepairs: Array<Record<string, unknown>> = [];
    let pendingGradingRepair: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let structuralRepairPass = 0;
      while (true) {
        if (!cachedBasePlan || basePlanInvalidated) {
          const shots = baseShots.map((shot, index) => {
            const forceFit = options.fitShots.includes(index) ||
              (options.forceInformationFit && (shot.informationMode || shot.textCoverage >= .04));
            return forceFit ? { ...shot, layout: 'FIT' as const, zoomAllowed: false,
              frameMode: shot.informationMode ? 'INFORMATION_REGION' as const : 'SOURCE_COMPOSITION' as const,
              reason: `${shot.reason}+REPAIR_FIT` } : shot;
          });
          const camera = cameraFor(shots, options.responsiveCamera, options.cameraStructuralRepair);
          const zoomPlan = planZoomEvents({ plan: renderPlan, cuts, words: renderWords, fps, shots,
            cropAt: camera.cropAt, frames: analysis.frames, scaleCap: options.zoomScaleCap,
            scaleFloor: options.zoomScaleFloor, disabled: options.zoomDisabled, finalDuration,
            sourceWidth: sourceVideo.width, sourceHeight: sourceVideo.height,
            sfxDisabled: options.sfxDisabled || !sfxSettings.enabled || !hasAudio,
            zoomSuppressions: options.zoomSuppressions });
          cachedBasePlan = { shots, camera, zoomPlan };
          basePlanInvalidated = false;
        } else basePlanCacheHits++;
        const validationStarted = Date.now();
        const informationRegions = options.forceInformationFit ? [] : detectInformationRegions(
          analysis.frames, cachedBasePlan.shots,
          { width, height: cachedBasePlan.camera.renderResolution.height },
          { width: sourceVideo.width, height: sourceVideo.height });
        const preRenderFailures = validatePreRenderStructure({ ...cachedBasePlan, finalDuration,
          informationRegions });
        preRenderValidationMs += Date.now() - validationStarted;
        preRenderClassification = classifyPreRenderFailures(preRenderFailures);
        if (preRenderClassification === 'READY') {
          if (cameraRepairPending) { cameraRepairSuccessCount++; cameraRepairPending = false; }
          break;
        }
        if (preRenderClassification === 'REPAIRABLE_PRE_RENDER' && structuralRepairPass === 0) {
          structuralRepairPass++; preRenderRepairCount++;
          const cameraReasons = new Set(['STALE_INTERPOLATION', 'INVALID_HARD_CUT_RESET',
            'CAMERA_ACTIVE_IN_FINAL_FREEZE']);
          const cameraFailures = preRenderFailures.filter((failure) => cameraReasons.has(failure.reason));
          if (cameraFailures.length) {
            cameraRepairAttemptCount++;
            cameraRepairPending = true;
            options.cameraStructuralRepair = true;
          }
          const affectedShots = preRenderFailures.filter((failure) =>
            failure.reason === 'INFORMATION_CROP_OUT_OF_BOUNDS')
            .flatMap((failure) =>
            [failure.shotBeforeId, failure.shotAfterId]).filter((index): index is number => index != null && index >= 0);
          if (preRenderFailures.some((failure) => failure.reason === 'INFORMATION_CROP_OUT_OF_BOUNDS'))
            options.forceInformationFit = true;
          const localZoomFailures = preRenderFailures.filter((failure) =>
            failure.reason === 'ZOOM_CROSSES_SHOT_BOUNDARY' ||
            failure.reason === 'ZOOM_ACTIVE_IN_FINAL_FREEZE');
          for (const suppression of localZoomSuppressions(localZoomFailures,
            cachedBasePlan.zoomPlan.events)) if (!options.zoomSuppressions.some((item) =>
            Math.abs(item.triggerTimestamp - suppression.triggerTimestamp) <= .08))
            options.zoomSuppressions.push(suppression);
          if (preRenderFailures.some((failure) => failure.reason === 'INVALID_FACE_CROP_STATE'))
            options.responsiveCamera = true;
          options.fitShots.push(...affectedShots.filter((index) => !options.fitShots.includes(index)));
          repairs.push({ repairReason: `PRE_RENDER_STRUCTURE:${preRenderFailures.map((item) => item.reason).join('|')}`,
            repairAction: localZoomFailures.length ?
              'ZOOM_LOCAL_REPAIR' : preRenderFailures.some((failure) => failure.reason === 'INFORMATION_CROP_OUT_OF_BOUNDS') ?
                'INFORMATION_FIT' : cameraFailures.length ? 'CAMERA_TRAJECTORY_RESET' :
                  'SUBJECT_REFRAME', repairAttempt: 0, repairResult: 'FIXED' });
          cachedBasePlan = null; basePlanInvalidated = true;
          continue;
        }
        this.logger.warn(JSON.stringify({ event: 'candidatePreRenderRejected',
          candidateId: context.candidateId, rank: context.rank,
          preRenderClassification: 'SKIP_BEFORE_RENDER', reasons: preRenderFailures }));
        throw new EditQualityError('Edited clip failed pre-render structural validation', {
          preRenderClassification: 'SKIP_BEFORE_RENDER', candidateSkippedBeforeRender: true,
          preRenderRejectReason: preRenderFailures.map((failure) => failure.reason).join('|'),
          preRenderRejectReasons: preRenderFailures.map((failure) => failure.reason),
          preRenderRejectedCount: 1, skippedBeforeRenderCount: 1, preRenderRepairCount,
          cameraRepairAttemptCount, cameraRepairSuccessCount,
          preRenderValidationMs, fullRenderAttempts: 0, wastedRenderMs: 0, preRenderFailures });
      }
      const { shots, camera, zoomPlan } = cachedBasePlan!;
      const palette = options.useDefaultPalette ? DEFAULT_SOURCE_PALETTE : sampledPalette;
      const bgMode: BackgroundMode = options.backgroundMode ??
        (renderPlan.backgroundMode === 'SOURCE_MATCH_SOLID' ? 'SOURCE_MATCH_SOLID' : 'SOFT_BLUR_EXTENSION');
      const paletteSegments: PaletteSegment[] = !palette ? [] :
        options.useDefaultPalette || options.singlePalette || !sourceFrames.length ?
          [{ start: 0, end: finalDuration, palette, shotIndexes: baseShots.map((_, index) => index) }] :
          buildPaletteSegments(baseShots, sourceFrames, inputOffset,
            bgMode === 'SOURCE_MATCH_SOLID' ? bgMode : 'SOURCE_MATCH_GRADIENT', finalDuration);
      const track = !musicApplicable || options.musicDisabled ? null : options.musicUseInline ?
        INLINE_FALLBACK_TRACK :
        selectMusicTrack(musicTracks, mood, context.seed ?? `${plan.clipStartSec}`, options.musicAttempt,
          avoidMusicTrackIds, { energy: plan.musicEnergy, texture: plan.musicTexture });
      try {
        result = await this.renderAttempt({ inputPath, outputPath, directory, plan: renderPlan,
          words: renderWords,
          inputOffset, timeline, mapper, analysis, shots, camera, zoomPlan, palette, paletteSegments, bgMode,
          editorial, layout, viewport,
          template, width, height, fps, hasAudio, gradePreset, sourceStats, track, mood, musicContext, loop,
          avoidMusicTrackIds, options, qaEnabled, finalDuration, sourceWidth: sourceVideo.width,
          sourceHeight: sourceVideo.height,
          sfx: { assets: sfxLibrary.assets, problems: sfxLibrary.problems,
            enabled: sfxSettings.enabled && hasAudio, allowGenerated: sfxSettings.allowGenerated,
            seed: context.seed ?? `${plan.clipStartSec}` } });
      } catch (error) {
        // A failed music graph must not fail the edit: retry with the next music option.
        if (track && attempt < maxAttempts) {
          repairs.push({ repairReason: `MUSIC_RENDER_ERROR:${error instanceof Error ? error.message.slice(0, 120) : ''}`,
            repairAction: 'MUSIC_RETRY', repairAttempt: attempt, repairResult: 'PENDING' });
          escalateMusic(options, musicRequired);
          basePlanInvalidated = false;
          continue;
        }
        throw error;
      }
      const checks = this.buildChecks(result, { plan: renderPlan, hasAudio, editorial, musicApplicable,
        musicRequired, boundary: context.boundary, loop, qaEnabled, timeline, width, height, layout });
      const gate = evaluateGate(checks);
      result.checks = checks;
      result.gate = gate;
      const gradingChecks = Object.fromEntries(checks.filter((item) =>
        ['gradingApplied', 'gradingDecisionValid', 'exposureNatural', 'highlightSafe', 'shadowSafe',
          'saturationNatural', 'whiteBalanceNatural', 'gradingNotOverprocessed', 'gradingLooksNatural']
          .includes(item.name)).map((item) => [item.name, item.passed]));
      if (pendingGradingRepair) {
        pendingGradingRepair.gradingChecksAfter = gradingChecks;
        pendingGradingRepair.gradingMetricsAfter = result.grading;
        pendingGradingRepair.gradingRepairRenderMs = result.baseRenderMs;
        const beforeFailures = Number(pendingGradingRepair.gradingFailureCountBefore) || 0;
        const afterFailures = Object.values(gradingChecks).filter((value) => value === false).length;
        pendingGradingRepair.gradingImprovement = beforeFailures - afterFailures;
        pendingGradingRepair = null;
      }
      if (result.preRenderRepairs.length) repairs.push(...result.preRenderRepairs);
      preRenderValidationMs += result.subtitlePreflightMs;
      overlayOnlyRepairCount += result.preRenderOverlayRepairCount;
      attempts.push({ attempt, status: gate.status, failedChecks: gate.failedChecks,
        degradedChecks: gate.degradedChecks, renderMs: result.renderMs,
        baseRenderMs: result.baseRenderMs,
        overlayRepairMs: result.overlayRepairMs, qualityCheckMs: result.qualityCheckMs,
        qaToolFailureCount: result.qaToolFailureCount,
        subtitleSync: { samples: result.measurements.subtitle.onsetSamples,
          residualMs: result.measurements.subtitle.residualOffsetMs,
          averageMs: result.measurements.subtitle.subtitleSyncErrorAverageMs,
          spreadMs: result.measurements.subtitle.residualSpreadMs,
          offsetMs: Math.round(options.subtitleOffsetSec * 1000) } });
      for (const log of repairs.filter((item) => item.repairResult === 'PENDING'))
        log.repairResult = checks.some((item) => item.repair === log.repairAction && item.passed === false) ?
          'NOT_FIXED' : 'FIXED';
      if (gate.status === 'PASSED' || attempt === maxAttempts) break;
      const permitted = fullRenderRepairActions(checks, result.grading);
      if (permitted.grading.allowed) {
        pendingGradingRepair = { gradingRepairReason: permitted.grading.reason,
          gradingChecksBefore: gradingChecks, gradingMetricsBefore: result.grading,
          gradingFailureCountBefore: Object.values(gradingChecks).filter((value) => value === false).length,
          gradingImprovement: 0, gradingRepairRenderMs: 0 };
        gradingRepairs.push(pendingGradingRepair);
      }
      const applied = this.applyRepairs(permitted.actions, options, result, shots, attempt, repairs);
      if (!applied.length) break;
      basePlanInvalidated = repairInvalidation(applied).base;
    }
    if (!result) throw new Error('Edited clip was not rendered');
    result.grading.gradingRepairReason = String(gradingRepairs.at(-1)?.gradingRepairReason ?? '');
    Object.assign(result.grading, { gradePredictionReason: gradePrediction.reason,
      predictedGradeStrength: gradePrediction.strength });
    const gate = result.gate!;
    const discardedAttempts = gate.status === 'FAILED' ? attempts : attempts.slice(0, -1);
    const report = { status: gate.status, failedChecks: gate.failedChecks, degradedChecks: gate.degradedChecks,
      checks: gate.summary, repairs, attempts, renderAttempts: attempts.length,
      fullRenderAttempts: attempts.length, overlayOnlyRepairCount, baseRenderCacheHit: false,
      analysisCacheHit: context.analysis != null, candidateSkippedBeforeRender: false,
      preRenderClassification, preRenderRejectedCount: 0, skippedBeforeRenderCount: 0,
      preRenderRepairCount, cameraRepairAttemptCount, cameraRepairSuccessCount,
      basePlanCacheHits, gradingRepairs,
      gradingRepairAttempts: gradingRepairs.length,
      gradingRepairRenderMs: gradingRepairs.reduce((sum, item) =>
        sum + Number(item.gradingRepairRenderMs ?? 0), 0),
      wastedRenderMs: discardedAttempts.reduce((sum, item) => sum + Number(item.baseRenderMs ?? 0), 0),
      gradePrediction,
      preRenderValidationMs,
      baseRenderMs: attempts.reduce((sum, item) => sum + Number(item.baseRenderMs ?? 0), 0),
      overlayRenderMs: attempts.reduce((sum, item) => sum + Number(item.overlayRepairMs ?? 0), 0),
      qualityCheckMs: attempts.reduce((sum, item) => sum + Number(item.qualityCheckMs ?? 0), 0),
      qaToolFailureCount: attempts.reduce((sum, item) => sum + Number(item.qaToolFailureCount ?? 0), 0),
      qaNormalFrameCount: result.measurements.sampling.normalFrameCount,
      qaHardCutFrameCount: result.measurements.sampling.hardCutFrameCount,
      qaDecodeBatchFrameLimit: MAX_QA_DECODE_BATCH_FRAMES,
      repairMs: attempts.reduce((sum, item, index) => sum + Number(item.overlayRepairMs ?? 0) +
        (index ? Number(item.baseRenderMs ?? 0) + Number(item.qualityCheckMs ?? 0) : 0), 0) };
    this.logger.log(JSON.stringify({ event: 'edited_clip_quality_gate', ...report }));
    if (gate.status === 'FAILED')
      throw new EditQualityError(`Edited clip failed quality gate: ${gate.failedChecks.join(', ')}`,
        { ...report, checkDetails: result.checks.filter((item) => item.passed === false),
          measurements: result.measurements });
    const { visual } = result;
    const visibleZooms = qaEnabled ? result.measurements.zoom.filter((item) =>
      item.visibleScaleDeltaValid === true).length : result.zoomEvents.length;
    const checkPassed = (name: string) => result.checks.find((item) => item.name === name)?.passed ?? null;
    return { duration: result.duration, width, height, codec: 'h264', fps, sizeBytes: result.sizeBytes,
      renderMs: Date.now() - started, hasAudio, cuts, thumbnail: result.thumbnail,
      information: result.information,
      timeline, quality: { ...report, checkDetails: result.checks, measurements: result.measurements },
      visual: { ...visual, sourceResolution: result.camera.sourceResolution,
        hookRequired: plan.hookRequired === true || plan.onScreenHook.enabled,
        hookOriginalText: plan.onScreenHook.text,
        hookValidationFailureReason: '', hookRepairAttempted: false,
        hookRepairSucceeded: false, hookFinalText: visual.hookText,
        hookRendered: qaEnabled ? result.measurements.hook.hookRendered : visual.hookRendered,
        hookRepairCount: repairs.filter((item) => item.repairAction.startsWith('HOOK')).length,
        outputResolution: result.camera.outputResolution,
        speakerTrackCount: result.camera.speakerTrackCount,
        speakerSegments: result.camera.speakerSegments,
        detectedPeople: result.camera.detectedPeople,
        faceSafetyViolations: result.camera.faceSafetyViolations,
        speakerSwitchCount: result.camera.speakerSwitchCount,
        shotChangeReframeCount: result.camera.shotChangeReframeCount,
        cameraMoves: result.camera.cameraMoves,
        longestSwitchMoveSec: result.camera.longestSwitchMoveSec,
        longPanCount: result.camera.longPanCount,
        shotSwitchMotionSmooth: result.camera.shotSwitchMotionSmooth,
        speakerSwitchSmooth: result.camera.speakerSwitchSmooth,
        cameraNoLongPan: result.camera.cameraNoLongPan,
        cameraTargetStable: result.camera.cameraTargetStable,
        shotCutResetsCamera: result.camera.shotCutResetsCamera,
        rawCropCenters: result.camera.rawCropCenters,
        stabilizedCropCenters: result.camera.stabilizedCropCenters,
        cropMovementDistance: result.camera.cropMovementDistance,
        reframeAdjustmentCount: result.camera.reframeAdjustmentCount,
        cameraReframeCount: result.camera.cameraReframeCount,
        shotCutCount: Math.max(0, result.shots.length - 1),
        analysisSource: analysis.source, analysisFrameCount: analysis.frames.length,
        shots: result.shots.map((shot) => ({ start: round(shot.start), end: round(shot.end),
          sourceStart: round(shot.sourceStart), sourceEnd: round(shot.sourceEnd),
          shotClass: shot.shotClass, frameMode: shot.frameMode, layout: shot.layout, zoomAllowed: shot.zoomAllowed,
          informationMode: shot.informationMode, faceCount: shot.faceCount,
          textCoverage: round(shot.textCoverage), samples: shot.sampleCount, reason: shot.reason })),
        shotCount: result.shots.length,
        fitShotCount: result.shots.filter((shot) => shot.layout === 'FIT').length,
        zoomCount: visibleZooms,
        semanticZoomCount: visibleZooms,
        strongZoomCount: result.zoomEvents.filter((event) => event.intensity === 'STRONG').length,
        veryStrongZoomCount: result.zoomEvents.filter((event) => event.intensity === 'VERY_STRONG').length,
        informationFrameCount: result.shots.filter((shot) => shot.informationMode).length,
        eligibleEmphasisCount: result.eligibleEmphasisCount,
        eligibleSafeZoomCount: result.eligibleSafeZoomCount,
        nominalRequiredZoomCount: result.nominalRequiredZoomCount,
        effectiveRequiredZoomCount: result.effectiveRequiredZoomCount,
        actualZoomCount: result.actualZoomCount,
        zeroZoomReason: result.zeroZoomReason,
        zoomSuppressionReasons: result.zoomSuppressionReasons,
        requiredZoomCount: result.requiredZoomCount,
        zoomCoverageValid: visibleZooms >= result.requiredZoomCount,
        actualRenderedZoomDeltas: result.measurements.zoom.map((item) => item.actualRenderedScaleDelta),
        zoomEvents: result.zoomEvents.map((event) => ({ ...event,
          returnedToBaseline: event.zoomReturned })),
        zoomRejections: result.zoomRejections,
        zoomPeakScale: Math.max(1, ...result.zoomEvents.map((event) => event.peakScale)),
        zoomReturnedToBaseline: result.zoomEvents.every((event) => event.zoomReturned),
        zoomInCount: result.zoomEvents.filter((event) => event.kind === 'IN').length,
        zoomOutCount: result.zoomEvents.filter((event) => event.kind === 'OUT').length,
        zoomIntensities: result.zoomEvents.map((event) => event.intensity),
        zoomSemanticReasons: result.zoomEvents.map((event) => event.semanticReason),
        hardCutTransitionClean: result.measurements.transitions.hardCutTransitionClean,
        failedHardCuts: result.measurements.transitions.failedHardCuts,
        hardCutTransitionChecks: result.measurements.transitions.checks,
        subtitleSourceGraphicCollisionCount:
          result.measurements.subtitle.sourceGraphicCollisionCount,
        cameraSettledAtEnd: checkPassed('cameraSettledAtEnd'),
        sfx: result.sfx,
        platformPreset: plan.platformPreset, layoutTemplate: template,
        canvasResolution: { width, height },
        headerBounds: editorial ? layout.headerBounds : null,
        videoViewportBounds: editorial ? layout.videoViewport : null,
        usableContentAreaRatio: editorial ? usableContentAreaRatio(layout) : 1,
        footerBounds: editorial ? layout.footerBounds : null,
        template, backgroundMode: editorial ? result.backgroundMode : null,
        backgroundColors: editorial ? result.backgroundColors : null,
        backgroundSegments: editorial ? result.backgroundSegments : [],
        backgroundTransitions: editorial ? result.backgroundTransitions : [],
        backgroundTransitionMs: editorial ? result.backgroundTransitionMs : null,
        sourcePalette: editorial ? result.palette : null,
        grading: result.grading, onsetRefinement,
        music: result.music, loop,
        subjectSafety: result.measurements.subject } };
  }

  private applyRepairs(actions: RepairAction[], options: RenderOptions,
    result: NonNullable<Awaited<ReturnType<VideoEditExecutorService['renderAttempt']>>>,
    shots: Shot[], attempt: number, log: RepairLog[]) {
    const applied: RepairAction[] = [];
    const record = (action: RepairAction, reason: string) => {
      log.push({ repairReason: reason, repairAction: action, repairAttempt: attempt, repairResult: 'PENDING' });
      applied.push(action);
    };
    for (const action of actions) {
      if (action === 'HOOK_REFIT') {
        if (options.hookFontScale > .62) options.hookFontScale = Number((options.hookFontScale * .86).toFixed(3));
        else options.hookShortenLevel++;
        record(action, 'HOOK_NOT_RENDERED_OR_OUTSIDE_SAFE_ZONE');
      } else if (action === 'HOOK_CONTRAST' && options.headerDarken < .6) {
        options.headerDarken += .25; record(action, 'HOOK_LOW_CONTRAST');
      } else if (action === 'SUBJECT_REFRAME') {
        if (result.zoomEvents.length && (result.measurements.subject.subjectSafeDuringZoomRatio ?? 1) < .95) {
          if ((options.zoomScaleCap ?? 1.22) > 1.13) options.zoomScaleCap = (options.zoomScaleCap ?? 1.18) - .03;
          else for (const event of result.zoomEvents.filter((item) => !item.subjectSafeDuringZoom))
            if (!options.zoomSuppressions.some((item) =>
              Math.abs(item.triggerTimestamp - event.triggerTimestamp) <= .08))
              options.zoomSuppressions.push({ triggerTimestamp: event.triggerTimestamp,
                reason: 'SUBJECT_UNSAFE_DURING_ZOOM' });
          record(action, 'SUBJECT_UNSAFE_DURING_ZOOM');
        }
        const unsafe = result.measurements.subject.unsafeShotIndexes.filter((index) =>
          !options.fitShots.includes(index) && shots[index]?.layout === 'FILL');
        if (unsafe.length && !options.responsiveCamera) {
          options.responsiveCamera = true; record(action, `SUBJECT_UNSAFE_RESPONSIVE_CAMERA:${unsafe.join('|')}`);
        } else if (unsafe.length) {
          options.fitShots.push(...unsafe); record(action, `SUBJECT_UNSAFE_FIT_SHOTS:${unsafe.join('|')}`);
        }
      } else if (action === 'INFORMATION_FIT' && !options.forceInformationFit) {
        options.forceInformationFit = true; record(action, 'INFORMATION_CLIPPED');
      } else if (action === 'SUBTITLE_RETIME' && !options.subtitleRetimeAttempted) {
        const residual = result.measurements.subtitle.residualOffsetMs;
        if (residual != null && result.measurements.subtitle.onsetSamples >= 4) {
          options.subtitleRetimeAttempted = true;
          options.subtitleOffsetSec = Math.max(-.3, Math.min(.3, options.subtitleOffsetSec + residual / 1000));
          record(action, `SUBTITLE_SYNC_OFFSET_${Math.round(residual)}MS`);
        }
      } else if (action === 'SUBTITLE_REFIT' && options.subtitleFontScale > .8) {
        options.subtitleFontScale *= .9; record(action, 'SUBTITLE_OUTSIDE_SAFE_AREA');
      } else if (action === 'SUBTITLE_EMPHASIS_REBUILD' && !options.emphasisBoost) {
        options.emphasisBoost = true; record(action, 'SUBTITLE_EMPHASIS_NOT_VISIBLE');
      } else if (action === 'BACKGROUND_REGENERATE') {
        // Ambient extension -> plain source-matched gradient -> neutral palette.
        if (result.backgroundMode === 'SOFT_BLUR_EXTENSION') {
          options.backgroundMode = 'SOURCE_MATCH_GRADIENT'; record(action, 'AMBIENT_BACKGROUND_REJECTED');
        } else if (!options.useDefaultPalette) {
          options.useDefaultPalette = true; record(action, 'BACKGROUND_STILL_MISSING');
        }
      } else if (action === 'BACKGROUND_SMOOTH' && !options.singlePalette) {
        options.singlePalette = true; record(action, 'BACKGROUND_TRANSITION_ABRUPT');
      } else if (action === 'MUSIC_RETRY' && !options.musicDisabled) {
        escalateMusic(options, result.music.musicRequired);
        options.musicGainOffsetDb -= 5;
        record(action, 'MUSIC_MISSING_OR_MASKING_SPEECH');
      } else if (action === 'ZOOM_STRENGTHEN' && !options.zoomRepairAttempted && !options.zoomDisabled) {
        const repairs = result.zoomEvents.map((event, index) => {
          const measured = result.measurements.zoom[index]?.visibleScaleDelta ?? 0;
          return Math.min(ZOOM_INTENSITY_BANDS[event.intensity].max,
            event.peakScale + Math.max(0, event.minVisibleScaleDelta - measured) + .02);
        });
        options.zoomScaleFloor = Math.min(ZOOM_TUNING.maxScale, Math.max(1.2, ...repairs));
        options.zoomRepairAttempted = true;
        record(action, 'ZOOM_NOT_VISIBLE_ONE_DETERMINISTIC_REPAIR');
      } else if (action === 'ZOOM_LOCAL_REPAIR') {
        const unsafe = result.zoomEvents.filter((event) => !event.informationSafeDuringZoom ||
          !event.subjectSafeDuringZoom || !event.zoomReturned ||
          event.endSec > result.duration - .4 + .001);
        let added = 0;
        for (const event of unsafe) if (!options.zoomSuppressions.some((item) =>
          Math.abs(item.triggerTimestamp - event.triggerTimestamp) <= .08)) {
          options.zoomSuppressions.push({ triggerTimestamp: event.triggerTimestamp,
            reason: !event.informationSafeDuringZoom ? 'INFORMATION_UNSAFE' :
              !event.subjectSafeDuringZoom ? 'SUBJECT_UNSAFE' : 'FINAL_FREEZE' });
          added++;
        }
        if (added) record(action, `LOCAL_ZOOM_EVENTS_REMOVED:${added}`);
      } else if (action === 'ZOOM_DISABLE' && !options.zoomDisabled) {
        options.zoomDisabled = true; record(action, 'ZOOM_UNSAFE');
      } else if (action === 'GRADE_STRENGTHEN' && options.gradeStrength < 1.5 &&
        result.grading.selectedPreset !== 'NO_CHANGE') {
        options.gradeStrength = 1.6; record(action, 'GRADING_NOT_MEASURABLE');
      } else if (action === 'GRADE_SAFETY' && options.gradeStrength > .25 &&
        result.grading.selectedPreset !== 'NO_CHANGE') {
        options.gradeStrength = Math.max(.25, Number((options.gradeStrength * .35).toFixed(3)));
        record(action, 'SEVERE_GRADING_SAFETY_REDUCTION');
      } else if (action === 'SFX_QUIET' && !options.sfxDisabled) {
        // Speech priority is absolute: pull the effects down, and if that is
        // still not enough the next repair drops them entirely.
        if (options.sfxGainOffsetDb > -8) {
          options.sfxGainOffsetDb -= 5; record(action, 'SFX_MASKING_SPEECH');
        } else { options.sfxDisabled = true; record(action, 'SFX_STILL_MASKING_SPEECH'); }
      } else if (action === 'SFX_DISABLE' && !options.sfxDisabled) {
        options.sfxDisabled = true; record(action, 'SFX_UNUSABLE');
      }
    }
    return applied;
  }

  private async renderAttempt(input: {
    inputPath: string; outputPath: string; directory: string; plan: EditPlan; words: TimedWord[];
    inputOffset: number; timeline: EditedTimeline; mapper: ReturnType<typeof createTimelineMapper>;
    analysis: EditAnalysis; shots: Shot[]; camera: ReturnType<ReframeService['plan']>;
    zoomPlan: ReturnType<typeof planZoomEvents>;
    palette: SourcePalette | null; paletteSegments: PaletteSegment[]; bgMode: BackgroundMode;
    editorial: boolean; layout: typeof PLATFORM_LAYOUT_PRESETS['UNIVERSAL'];
    viewport: Rect; template: string; width: number; height: number; fps: number; hasAudio: boolean;
    gradePreset: ReturnType<typeof resolveGradePreset>; sourceStats: Awaited<ReturnType<typeof sampleImageStats>>;
    track: MusicTrack | null; mood: MusicMood; loop: LoopDecision; options: RenderOptions;
    musicContext: { requestedMood: MusicMood; required: boolean; libraryProblems: string[];
      musicDecision: 'USE_MUSIC' | 'NO_MUSIC' };
    avoidMusicTrackIds: Set<string>;
    sfx: { assets: SfxAsset[]; problems: string[]; enabled: boolean; allowGenerated: boolean;
      seed: string };
    qaEnabled: boolean; finalDuration: number; sourceWidth: number; sourceHeight: number;
  }) {
    const renderStarted = Date.now();
    const { plan, words, timeline, mapper, camera, shots, width, height, fps, options, editorial,
      layout, directory } = input;
    const cuts = timeline.cuts;
    const segments = timeline.segments.map((segment) => ({
      start: Math.max(0, segment.sourceStart - input.inputOffset),
      end: Math.max(0, segment.sourceEnd - input.inputOffset) }));
    const zoomPlan = input.zoomPlan;
    const zoomEvents = zoomPlan.events;
    // Caption placement only needs to know where the accepted zooms are (source time).
    const renderPlan: EditPlan = { ...plan, operations: [
      ...plan.operations.filter((operation) => operation.type !== 'ZOOM' &&
        operation.type !== 'ZOOM_OUT'),
      ...zoomEvents.flatMap((event) => {
        const startSec = finalToSource(timeline, event.startSec);
        const endSec = finalToSource(timeline, event.endSec);
        return startSec == null || endSec == null ? [] : [{ type: 'ZOOM' as const, startSec, endSec,
          reason: 'planned', scale: event.peakScale, focusX: event.focusX, focusY: event.focusY,
          target: null, words: [], triggerText: event.triggerText }];
      }) ] };
    const canvasFaces = input.analysis.frames.flatMap((frame) => frame.faces)
      .map(camera.sourceToCanvas).filter((track) => track.w > 0 && track.h > 0);
    const canvasPersons = input.analysis.frames.flatMap((frame) => frame.persons)
      .map(camera.sourceToCanvas).filter((track) => track.w > 0 && track.h > 0);
    // Information shots get their own FIT branch, cropped to the region that
    // actually carries the information so it renders as large - and as readable
    // - as the viewport allows. Everything else keeps the plain whole-frame fit.
    const infoRegions = options.forceInformationFit ? [] :
      detectInformationRegions(input.analysis.frames, shots,
        { width, height: camera.renderResolution.height },
        { width: input.sourceWidth, height: input.sourceHeight });
    const infoEntries = infoRegions.map((entry, index) => ({ ...entry, index,
      expression: fitEnableExpression([entry.shot]) }));
    const fitExpression = fitEnableExpression(shots,
      (shot) => !infoEntries.some((entry) => entry.shot === shot));

    // Caption placement hints (canvas px) for FIT frames and burned-in source text.
    const sourceAspect = input.sourceHeight / input.sourceWidth;
    const fitHeight = Math.min(camera.renderResolution.height, Math.round(width * sourceAspect));
    const fitBottom = camera.padTop + (camera.renderResolution.height + fitHeight) / 2;
    const fitTop = camera.padTop + (camera.renderResolution.height - fitHeight) / 2;
    // The same geometry for the region-cropped information branch: the region is
    // closer to the viewport's aspect ratio, so it draws larger than a whole-frame
    // fit and captions have to clear a different edge.
    const infoBoxes = infoEntries.map((entry) => {
      const regionW = entry.region.w * input.sourceWidth;
      const regionH = entry.region.h * input.sourceHeight;
      const scale = Math.min(width / regionW, camera.renderResolution.height / regionH);
      const drawWidth = regionW * scale;
      const drawHeight = regionH * scale;
      return { ...entry, scale, drawWidth, drawHeight,
        left: (width - drawWidth) / 2,
        top: camera.padTop + (camera.renderResolution.height - drawHeight) / 2,
        bottom: camera.padTop + (camera.renderResolution.height + drawHeight) / 2 };
    });
    // Burned-in source text (canvas px) on the final timeline; FIT shots map
    // through the fitted frame, FILL shots through the camera crop.
    const textFrames = input.analysis.frames.filter((frame) =>
      (frame.textBoxes.length || frame.graphicBoxes?.length) &&
      !input.mapper.removed(frame.t, frame.t + .001)).map((frame) => {
      const t = input.mapper.point(frame.t);
      const shot = shots.find((item) => t >= item.start && t < item.end);
      const fit = shot?.layout === 'FIT';
      const infoBox = infoBoxes.find((entry) => entry.shot === shot);
      const viaRegion = Boolean(fit && infoBox && shot?.informationMode);
      const boxes = [...frame.textBoxes, ...(frame.graphicBoxes ?? [])];
      return { t, boxes: boxes.filter((box) => box.w * box.h >= .001 || box.w >= .12 || box.h >= .045)
        .map((box): Rect => {
        if (viaRegion) return {
          x: infoBox!.left + (box.x - infoBox!.region.x) * input.sourceWidth * infoBox!.scale,
          y: infoBox!.top + (box.y - infoBox!.region.y) * input.sourceHeight * infoBox!.scale,
          width: box.w * input.sourceWidth * infoBox!.scale,
          height: box.h * input.sourceHeight * infoBox!.scale };
        if (fit) return { x: box.x * width, y: fitTop + box.y * fitHeight, width: box.w * width,
          height: box.h * fitHeight };
        const mapped = camera.sourceToCanvas({ timestamp: frame.t, x: box.x, y: box.y, w: box.w, h: box.h });
        return { x: mapped.x * width, y: mapped.y * height, width: mapped.w * width, height: mapped.h * height };
      }).filter((box) => box.width > 0 && box.height > 0) };
    });
    const textBoxesAt = (start: number, end: number) => textFrames
      .filter((frame) => frame.t >= start - .2 && frame.t <= end + .2).flatMap((frame) => frame.boxes);
    const placementAt = (start: number, end: number) => {
      const overlapping = shots.filter((shot) => shot.start < end && shot.end > start);
      // Captions sit below the fitted image, so the relevant edge is the bottom
      // of whichever fitted layer is on screen.
      const infoBox = infoBoxes.find((entry) => overlapping.includes(entry.shot));
      if (infoBox && infoBox.drawHeight < camera.renderResolution.height - 40)
        return { fitBottom: infoBox.bottom };
      if (overlapping.some((shot) => shot.layout === 'FIT') && fitHeight < camera.renderResolution.height - 40)
        return { fitBottom };
      const boxes = textBoxesAt(start, end);
      return boxes.length ? { sourceTextBoxes: boxes } : {};
    };
    const assPath = join(directory, 'edit.ass');
    const hookOnlyPath = join(directory, 'thumbnail-hook.ass');
    const writeAss = () => this.subtitles.write(assPath, renderPlan, words, cuts, width, height,
      undefined, canvasFaces, canvasPersons, editorial, layout, { fps, hookOnlyPath,
        hookFontScale: options.hookFontScale, hookShortenLevel: options.hookShortenLevel,
        hookWidthScale: options.hookWidthScale, hookHeightScale: options.hookHeightScale,
        subtitleOffsetSec: options.subtitleOffsetSec,
        emphasisBoost: options.emphasisBoost, subtitleFontScale: options.subtitleFontScale,
        placementAt: editorial ? placementAt : undefined,
        // Caption placement is decided once per shot, never per phrase (§29).
        shotRanges: shots.map((shot) => ({ start: shot.start, end: shot.end })) });
    let visual = await writeAss();
    // Hook calibration against real libass glyph bounds (no video render needed).
    let hookCalibrations = 0;
    // The hook is measured once its entrance has settled.
    const hookSettleFrame = Math.ceil((visual.hookSettleSec ?? 0) * fps) + 1;
    if (input.qaEnabled && visual.hookPlaced && visual.hookZone) {
      for (; hookCalibrations < 4; hookCalibrations++) {
        const probeFrame = (await renderAssProbe(directory, 'edit.ass', { width, height }, fps, [hookSettleFrame],
          Math.round(width * QA_SCALE), Math.round(height * QA_SCALE))).get(hookSettleFrame);
        const zone = scaleRect(visual.hookZone!, QA_SCALE);
        const mask = probeFrame && visual.hookPlateBounds ?
          hookGlyphMask(probeFrame, scaleRect(visual.hookPlateBounds, QA_SCALE)) : null;
        if (!mask?.bounds || !visual.hookBounds) break;
        const fits = inside(mask.bounds, zone, 1);
        // Measured glyph extent vs. the estimate (both without plate padding or
        // the fit's stroke padding).
        const expected = hookGlyphExtent(visual.hookBounds);
        const widthRatio = mask.bounds.width / QA_SCALE / expected.width;
        const heightRatio = mask.bounds.height / QA_SCALE / expected.height;
        const nextWidth = Math.max(.6, Math.min(1.6, options.hookWidthScale * widthRatio * (fits ? 1.02 : 1.06)));
        const nextHeight = Math.max(.6, Math.min(1.6, options.hookHeightScale * heightRatio * (fits ? 1.02 : 1.06)));
        if (fits && Math.abs(nextWidth - options.hookWidthScale) < .05 &&
          Math.abs(nextHeight - options.hookHeightScale) < .05) break;
        options.hookWidthScale = nextWidth;
        options.hookHeightScale = nextHeight;
        if (!fits && hookCalibrations === 3) options.hookFontScale *= .9;
        visual = await writeAss();
        if (!visual.hookPlaced) break;
      }
    }

    // Subtitle timing is an audio/ASS concern. Measure and deterministically
    // repair it before the expensive video encode so a 20-80 ms correction can
    // never trigger a second camera/zoom/reframe pass.
    const speechQa = join(directory, 'qa-speech.wav');
    const preRenderRepairs: RepairLog[] = [];
    let preRenderOverlayRepairCount = 0;
    let overlayRepairMs = 0;
    let subtitlePreflightMs = 0;
    if (input.qaEnabled && input.hasAudio && visual.wordEvents.length &&
      !options.subtitleRetimeAttempted) {
      const validationStarted = Date.now();
      try {
        await renderSpeechQa(input.inputPath, speechQa, segments);
        const speech = await audioEnvelope(speechQa);
        const offsets = measureOnsetOffsets(speech, visual.wordEvents.map((event) => ({
          start: event.renderStart, end: event.renderEnd,
          gapBefore: gapBefore(words, event, mapper) })));
        const decision = subtitleRetimeDecision(offsets);
        if (decision) {
          options.subtitleRetimeAttempted = true;
          options.subtitleOffsetSec = Math.max(-.3, Math.min(.3,
            options.subtitleOffsetSec + decision.offsetSec));
          visual = await writeAss();
          preRenderOverlayRepairCount = 1;
          preRenderRepairs.push({ repairReason: `SUBTITLE_SYNC_OFFSET_${decision.residualMs}MS`,
            repairAction: 'SUBTITLE_RETIME', repairAttempt: 0, repairResult: 'PENDING' });
          overlayRepairMs = Date.now() - validationStarted;
        }
      } catch (error) {
        this.logger.warn(`Subtitle preflight skipped: ${error instanceof Error ? error.message : error}`);
      }
      subtitlePreflightMs = Date.now() - validationStarted;
    }

    // --- Filter graph ---
    const graph: string[] = [];
    const n = segments.length;
    const bgMode = input.bgMode;
    const blurBackground = editorial && bgMode === 'SOFT_BLUR_EXTENSION';
    if (n > 1) {
      graph.push(`[0:v]split=${n}${segments.map((_, i) => `[vs${i}]`).join('')}`);
      if (input.hasAudio) graph.push(`[0:a]asplit=${n}${segments.map((_, i) => `[as${i}]`).join('')}`);
    }
    segments.forEach((segment, i) => {
      graph.push(`[${n > 1 ? `vs${i}` : '0:v'}]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},` +
        `setpts=PTS-STARTPTS[v${i}]`);
      if (input.hasAudio) {
        const length = segment.end - segment.start;
        const fades = n > 1 ? `,afade=t=in:d=0.012,afade=t=out:st=${Math.max(0, length - .012).toFixed(3)}:d=0.012` : '';
        graph.push(`[${n > 1 ? `as${i}` : '0:a'}]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},` +
          `asetpts=PTS-STARTPTS${fades}[a${i}]`);
      }
    });
    if (n > 1) graph.push(segments.map((_, i) => `[v${i}]${input.hasAudio ? `[a${i}]` : ''}`).join('') +
      `concat=n=${n}:v=1:a=${input.hasAudio ? 1 : 0}[vcat]${input.hasAudio ? '[acat]' : ''}`);
    else {
      graph.push('[v0]null[vcat]');
      if (input.hasAudio) graph.push('[a0]anull[acat]');
    }
    const videoBranches = ['vfillsrc', ...(fitExpression ? ['vfitsrc'] : []),
      ...infoEntries.map((entry) => `vinfosrc${entry.index}`),
      ...(blurBackground ? ['vbgsrc'] : [])];
    graph.push(`[vcat]fps=${fps},setsar=1,split=${videoBranches.length}${videoBranches.map((b) => `[${b}]`).join('')}`);
    const renderHeight = camera.renderResolution.height;
    const anchorX = zoomAnchorExpression(zoomEvents, 'focusX');
    const anchorY = zoomAnchorExpression(zoomEvents, 'focusY');
    graph.push(`[vfillsrc]${camera.filter},zoompan=z='${zoomExpression(zoomEvents)}':` +
      `x='(iw-iw/zoom)*(${anchorX})':y='(ih-ih/zoom)*(${anchorY})':` +
      `d=1:s=${width}x${renderHeight}:fps=${fps}[vfill]`);
    // One fitted layer: the source (optionally pre-cropped to `crop`) scaled to
    // fit the viewport, centred over a blurred fill of itself.
    const fittedLayer = (source: string, out: string, crop?: string) => {
      const pre = crop ? `crop=${crop},` : '';
      graph.push(`[${source}]${pre}split=2[${out}a][${out}b]`);
      graph.push(`[${out}a]scale=${width}:${renderHeight}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${renderHeight},boxblur=luma_radius=28:luma_power=2,eq=brightness=-0.1:saturation=0.75[${out}bg]`);
      graph.push(`[${out}b]scale=${width}:${renderHeight}:force_original_aspect_ratio=decrease,setsar=1[${out}fg]`);
      graph.push(`[${out}bg][${out}fg]overlay=(W-w)/2:(H-h)/2[${out}]`);
    };
    let composited = 'vfill';
    if (fitExpression) {
      fittedLayer('vfitsrc', 'vfit');
      graph.push(`[${composited}][vfit]overlay=0:0:enable='${fitExpression}'[vfitted]`);
      composited = 'vfitted';
    }
    for (const entry of infoEntries) {
      const crop = regionCropRect(entry.region,
        { width: input.sourceWidth, height: input.sourceHeight });
      const layer = `vinfo${entry.index}`;
      fittedLayer(`vinfosrc${entry.index}`, layer,
        `${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
      const out = `vinfocomp${entry.index}`;
      graph.push(`[${composited}][${layer}]overlay=0:0:enable='${entry.expression}'[${out}]`);
      composited = out;
    }
    graph.push(`[${composited}]null[vcomp]`);
    const grading = gradingFilter(input.gradePreset, input.sourceStats, options.gradeStrength);
    graph.push(`[vcomp]split=2[vmain][vqa]`);
    graph.push(`[vqa]scale=180:${Math.round(180 * renderHeight / width / 2) * 2},format=yuv420p[vqaout]`);
    graph.push(`[vmain]${grading.filter}[vgraded]`);
    let paletteTrack: PaletteTrack | null = null;
    if (editorial && input.palette && input.paletteSegments.length) {
      // Scene palettes cross-fade into each other; the ambient mode lays them over
      // the blurred running footage, the source-match modes show them directly.
      const tintMode: BackgroundMode = bgMode === 'SOURCE_MATCH_SOLID' ? bgMode : 'SOURCE_MATCH_GRADIENT';
      paletteTrack = paletteTrackFilter(input.paletteSegments.map((segment) => ({ start: segment.start,
        colors: backgroundColors(segment.palette, tintMode, options.headerDarken) })),
      input.finalDuration, fps, 'tintraw');
      graph.push(...paletteTrack.graph);
      graph.push(`[tintraw]tpad=stop_mode=clone:stop_duration=1[tint]`);
      if (blurBackground) graph.push(...ambientBackgroundFilter('vbgsrc', 'tint', 'vbg', { width, height },
        options.headerDarken));
      else graph.push(`[tint]scale=${width}:${height}:flags=bilinear,format=yuv420p[vbg]`);
      graph.push(`[vbg][vgraded]overlay=0:${camera.padTop}[vcanvas]`);
    } else if (camera.padTop || renderHeight !== height) {
      graph.push(`[vgraded]pad=${width}:${height}:0:${camera.padTop}:color=0x15171C[vcanvas]`);
    } else graph.push('[vgraded]null[vcanvas]');
    // Cover frame: the same canvas (background, grade, framing) carrying only the
    // headline - no captions, no callouts - so the thumbnail is unmistakably the
    // same piece of work as the clip.
    const thumbnail = chooseThumbnailTime({ frames: input.analysis.frames, shots,
      finalDuration: input.finalDuration, toFinal: (t) => mapper.point(t),
      removed: (start, end) => mapper.removed(start, end),
      informationHeavy: plan.preserveInformation === true ||
        shots.some((shot) => shot.informationMode) });
    const thumbnailPath = join(directory, 'thumbnail.jpg');
    graph.push(`[vcanvas]split=2[vcanvasmain][vcanvasthumb]`);
    graph.push(`[vcanvasmain]ass=edit.ass,format=yuv420p[vout]`);
    graph.push(`[vcanvasthumb]trim=start=${thumbnail.atSec.toFixed(3)}:` +
      `end=${(thumbnail.atSec + 2 / fps).toFixed(3)},setpts=PTS-STARTPTS,` +
      `ass=thumbnail-hook.ass,format=yuvj420p[vthumb]`);

    const musicOn = Boolean(input.track && input.hasAudio);
    const gainDb = input.track ? musicGainDb(input.track, input.mood) + options.musicGainOffsetDb : 0;
    // Short clips keep both fades inside the clip.
    const fades = { in: Math.min(MUSIC_MIX.fadeInSec, input.finalDuration / 4),
      out: Math.min(MUSIC_MIX.fadeOutSec, input.finalDuration / 3) };
    // --- Sound design: one effect per accepted camera-motion event ---
    // The zoom planner already decided what each effect is for; here it only
    // becomes a file (or a generated source) and a level.
    const sfxPlan = !input.hasAudio || options.sfxDisabled || !input.sfx.enabled ? [] :
      zoomEvents.flatMap((event, index) => {
        if (!event.sfxEnabled) return [];
        const asset = selectSfx(input.sfx.assets, event.sfxType, input.sfx.seed, index,
          input.sfx.allowGenerated);
        if (!asset) return [];
        const length = Math.min(SFX_MIX.maxLengthSec, input.finalDuration - event.sfxAtSec);
        if (length < .12) return [];
        return [{ event, index, asset, type: event.sfxType, atSec: event.sfxAtSec, length,
          gainDb: sfxGainDb(asset, event.sfxType) + options.sfxGainOffsetDb }];
      });
    const sfxOn = sfxPlan.length > 0;
    // Input indexes: 0 is the source, then the music bed, then one per effect.
    const sfxInputBase = 1 + (musicOn ? 1 : 0);
    if (input.hasAudio) {
      graph.push(`[acat]aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=70,` +
        `acompressor=threshold=0.1:ratio=2.5:attack=15:release=250:makeup=1.4[sp0]`);
      const speechBranches = ['spmix', 'spqa', ...(musicOn ? ['spsc'] : []), ...(sfxOn ? ['spsfx'] : [])];
      graph.push(`[sp0]asplit=${speechBranches.length}${speechBranches.map((b) => `[${b}]`).join('')}`);
      const mixInputs = ['spmix'];
      const d = input.finalDuration;
      if (musicOn) {
        graph.push(`[1:a]atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,` +
          `${MUSIC_MIX.speechCarve},volume=${gainDb.toFixed(1)}dB,afade=t=in:st=0:d=${fades.in.toFixed(3)},` +
          `afade=t=out:st=${Math.max(0, d - fades.out).toFixed(3)}:d=${fades.out.toFixed(3)},asplit=2[mus][musbed]`);
        graph.push(`[musbed]aresample=16000,aformat=channel_layouts=mono[mubedqa]`);
        graph.push(`[mus][spsc]${MUSIC_MIX.duck}[duck]`);
        graph.push(`[duck]asplit=2[duckmix][duckqa]`);
        graph.push(`[duckqa]aresample=16000,aformat=channel_layouts=mono[muqaout]`);
        mixInputs.push('duckmix');
      }
      if (sfxOn) {
        sfxPlan.forEach((item, i) => {
          const fadeOutAt = Math.max(0, item.length - SFX_MIX.fadeOutSec);
          graph.push(`[${sfxInputBase + i}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
            `atrim=0:${item.length.toFixed(3)},asetpts=PTS-STARTPTS,` +
            `volume=${item.gainDb.toFixed(1)}dB,` +
            `afade=t=in:st=0:d=${SFX_MIX.fadeInSec.toFixed(3)},` +
            `afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${SFX_MIX.fadeOutSec.toFixed(3)},` +
            `adelay=${Math.round(item.atSec * 1000)}:all=1[sfx${i}]`);
        });
        graph.push(sfxPlan.length > 1 ?
          `${sfxPlan.map((_, i) => `[sfx${i}]`).join('')}amix=inputs=${sfxPlan.length}:` +
            `duration=longest:normalize=0[sfxsum]` :
          `[sfx0]anull[sfxsum]`);
        // Pad to the full clip so the bus can be mixed against speech with
        // duration=first, then duck it under the voice and cap its peaks.
        graph.push(`[sfxsum]apad,atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS[sfxbus]`);
        graph.push(`[sfxbus][spsfx]${SFX_MIX.duck}[sfxducked]`);
        graph.push(`[sfxducked]${SFX_MIX.limit},asplit=2[sfxmix][sfxqa]`);
        graph.push(`[sfxqa]aresample=16000,aformat=channel_layouts=mono[sfxqaout]`);
        mixInputs.push('sfxmix');
      }
      let mixLabel = 'spmix';
      if (mixInputs.length > 1) {
        graph.push(`${mixInputs.map((label) => `[${label}]`).join('')}` +
          `amix=inputs=${mixInputs.length}:duration=first:normalize=0[mix]`);
        mixLabel = 'mix';
      }
      const loudness = plan.audio.normalize ? 'loudnorm=I=-16:TP=-1.5:LRA=11' : 'anull';
      // The edited tail always sits past the last spoken word (see BOUNDARY_TUNING
      // tailSec), so a short fade here never clips speech - it just softens the
      // otherwise-hard stop into something that reads as deliberately finished.
      const endFadeSec = Math.min(.15, input.finalDuration / 6);
      const loopFades = input.loop.loopApplied ?
        `,afade=t=in:d=0.06,afade=t=out:st=${Math.max(0, input.finalDuration - .12).toFixed(3)}:d=0.12` :
        `,afade=t=out:st=${Math.max(0, input.finalDuration - endFadeSec).toFixed(3)}:d=${endFadeSec.toFixed(3)}`;
      graph.push(`[${mixLabel}]${loudness}${loopFades},aresample=48000[aout]`);
      graph.push(`[spqa]aresample=16000,aformat=channel_layouts=mono[spqaout]`);
    }
    const qaView = join(directory, 'qa-view.mkv');
    const musicQa = join(directory, 'qa-music.wav');
    const musicBedQa = join(directory, 'qa-music-bed.wav');
    const sfxQa = join(directory, 'qa-sfx.wav');
    const musicInput = !musicOn ? [] : input.track!.path.startsWith('lavfi:') ?
      ['-f', 'lavfi', '-i', input.track!.path.slice('lavfi:'.length)] :
      ['-stream_loop', '-1', '-i', input.track!.path];
    const sfxInputs = sfxPlan.flatMap((item) => item.asset.path.startsWith('lavfi:') ?
      ['-f', 'lavfi', '-i', item.asset.path.slice('lavfi:'.length)] : ['-i', item.asset.path]);
    const renderThreads = ffmpegThreadsPerRender();
    const args = ['-v', 'error', '-y', '-filter_complex_threads', String(renderThreads),
      '-i', input.inputPath, ...musicInput, ...sfxInputs,
      '-filter_complex', graph.join(';'),
      '-map', '[vout]', ...(input.hasAudio ? ['-map', '[aout]'] : []),
      '-t', input.finalDuration.toFixed(3),
      '-c:v', 'libx264', '-threads', String(renderThreads),
      '-preset', process.env.EDIT_RENDER_PRESET || 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-r', String(fps),
      ...(input.hasAudio ? ['-c:a', 'aac', '-b:a', '160k'] : []),
      '-movflags', '+faststart', input.outputPath,
      '-map', '[vthumb]', '-frames:v', '1', '-q:v', '2', thumbnailPath,
      '-map', '[vqaout]', '-c:v', 'ffv1', qaView,
      ...(input.hasAudio ? ['-map', '[spqaout]', '-c:a', 'pcm_s16le', speechQa] : []),
      ...(musicOn ? ['-map', '[muqaout]', '-c:a', 'pcm_s16le', musicQa,
        '-map', '[mubedqa]', '-c:a', 'pcm_s16le', musicBedQa] : []),
      ...(sfxOn ? ['-map', '[sfxqaout]', '-c:a', 'pcm_s16le', sfxQa] : [])];
    const baseRenderStarted = Date.now();
    try {
      await execFileAsync('ffmpeg', args, { cwd: directory, maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      const failedRenderMs = Date.now() - baseRenderStarted;
      throw new EditQualityError('Edited clip FFmpeg render failed', {
        preRenderClassification: 'READY', candidateSkippedBeforeRender: false,
        preRenderRejectedCount: 0, skippedBeforeRenderCount: 0,
        fullRenderAttempts: 1, gradingRepairAttempts: 0, gradingRepairRenderMs: 0,
        wastedRenderMs: failedRenderMs, baseRenderMs: failedRenderMs,
        renderFailureReason: error instanceof Error ? error.message.slice(0, 240) : String(error) });
    }
    const baseRenderMs = Date.now() - baseRenderStarted;
    const renderMs = Date.now() - renderStarted;

    const outputProbe = await probe(input.outputPath);
    const video = outputProbe.streams.find((stream) => stream.codec_type === 'video');
    const audio = outputProbe.streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(outputProbe.format?.duration);
    const sizeBytes = (await stat(input.outputPath)).size;
    const avOffsetMs = video && audio ? Math.round(Math.abs(Number(audio.start_time ?? 0) -
      Number(video.start_time ?? 0)) * 1000) : 0;

    const qualityStarted = Date.now();
    const measurementInput = { ...input, visual, zoomEvents, renderHeight, paletteTrack,
      blurBackground, qaView, speechQa, musicQa, musicBedQa, musicOn, duration, hookSettleFrame,
      textBoxesAt, fades, thumbnailPath, thumbnail, sfxQa, sfxOn, sfxPlan };
    let qaToolFailureCount = 0;
    let measurements: Awaited<ReturnType<VideoEditExecutorService['measure']>>;
    try { measurements = await this.measure(measurementInput); }
    catch (firstError) {
      qaToolFailureCount++;
      this.logger.warn(JSON.stringify({ event: 'QA_TOOL_FAILURE_RETRY', outputPath: input.outputPath,
        error: firstError instanceof Error ? firstError.message.slice(0, 240) : String(firstError) }));
      try { measurements = await this.measure(measurementInput); }
      catch (secondError) {
        qaToolFailureCount++;
        throw new EditQualityError('Final visual QA failed twice on the same rendered file', {
          preRenderClassification: 'READY', candidateSkippedBeforeRender: false,
          fullRenderAttempts: 1, baseRenderMs, wastedRenderMs: baseRenderMs,
          qaToolFailureCount, qaRetriedSameRenderedFile: true,
          qaToolFailureReason: secondError instanceof Error ? secondError.message.slice(0, 240) : String(secondError) });
      }
    }
    const qualityCheckMs = Date.now() - qualityStarted;
    return { duration, sizeBytes, renderMs, baseRenderMs, qualityCheckMs, qaToolFailureCount,
      overlayRepairMs, subtitlePreflightMs,
      preRenderOverlayRepairCount, preRenderRepairs, visual: { ...visual, hookCalibrations },
      thumbnail: { ...thumbnail, path: thumbnailPath, ...measurements.thumbnail },
      camera, shots, zoomEvents, zoomRejections: zoomPlan.rejected,
      eligibleEmphasisCount: zoomPlan.eligibleEmphasisCount,
      eligibleSafeZoomCount: zoomPlan.eligibleSafeZoomCount,
      nominalRequiredZoomCount: zoomPlan.nominalRequiredZoomCount,
      effectiveRequiredZoomCount: zoomPlan.effectiveRequiredZoomCount,
      actualZoomCount: zoomPlan.actualZoomCount,
      zeroZoomReason: zoomPlan.zeroZoomReason,
      zoomSuppressionReasons: zoomPlan.zoomSuppressionReasons,
      requiredZoomCount: zoomPlan.requiredZoomCount,
      zoomCoverageValid: zoomPlan.zoomCoverageValid,
      // Information framing: which region was maximised, and how much larger the
      // content renders than a plain whole-frame fit would have made it.
      information: { informationRegion: infoEntries.length === 1 ? {
        x: round(infoEntries[0].region.x, 4), y: round(infoEntries[0].region.y, 4),
        w: round(infoEntries[0].region.w, 4), h: round(infoEntries[0].region.h, 4) } : null,
      informationRegions: infoEntries.map((entry, index) => ({ shotStart: round(entry.shot.start),
        shotEnd: round(entry.shot.end), x: round(entry.region.x, 4), y: round(entry.region.y, 4),
        w: round(entry.region.w, 4), h: round(entry.region.h, 4),
        readabilityGain: entry.region.readabilityGain, coverage: entry.region.coverage,
        meaningfulRegionWidthPx: Math.round(infoBoxes[index]?.drawWidth ?? 0),
        meaningfulRegionHeightPx: Math.round(infoBoxes[index]?.drawHeight ?? 0) })),
      informationReadabilityGain: infoEntries.length ?
        Math.min(...infoEntries.map((entry) => entry.region.readabilityGain)) : null,
      informationScaleGain: infoEntries.length ?
        Math.min(...infoEntries.map((entry) => entry.region.readabilityGain)) : null,
      informationRegionCoverage: infoEntries.length ?
        Math.min(...infoEntries.map((entry) => entry.region.coverage)) : null,
      informationRegionSamples: infoEntries.reduce((sum, entry) => sum + entry.region.sampleCount, 0) || null,
      informationShotCount: shots.filter((shot) => shot.informationMode).length,
      informationFitForced: options.forceInformationFit,
      informationRenderedHeightPx: infoBoxes.length ? Math.round(Math.min(...infoBoxes.map((box) => box.drawHeight))) :
        shots.some((shot) => shot.layout === 'FIT') ? fitHeight : null,
      meaningfulRegionPixelSize: infoBoxes.length ? {
        width: Math.round(Math.min(...infoBoxes.map((box) => box.drawWidth))),
        height: Math.round(Math.min(...infoBoxes.map((box) => box.drawHeight))) } : null },
      backgroundMode: bgMode, backgroundColors: paletteTrack?.colors[0] ?? [], palette: input.palette,
      backgroundSegments: paletteTrack ? input.paletteSegments.map((segment) => ({
        start: round(segment.start), end: round(segment.end), shotIndexes: segment.shotIndexes,
        dominant: segment.palette.dominant, temperature: segment.palette.temperature,
        colors: backgroundColors(segment.palette, bgMode === 'SOURCE_MATCH_SOLID' ? bgMode :
          'SOURCE_MATCH_GRADIENT', options.headerDarken) })) : [],
      backgroundTransitions: paletteTrack?.boundaries.map((bound) => round(bound)) ?? [],
      backgroundTransitionMs: paletteTrack ? Math.round(paletteTrack.fadeSec * 1000) : null,
      grading: { selectedPreset: input.gradePreset, requestedPreset: plan.gradePreset ?? 'CLEAN_SOCIAL',
        gradingApplied: measurements.grading.gradingApplied, colorPreset: input.gradePreset,
        gradingDecision: input.gradePreset === 'NO_CHANGE' ? 'NO_CHANGE' : 'GRADED',
        gradingStrength: input.gradePreset === 'NO_CHANGE' ? 0 : options.gradeStrength,
        gradingRepairReason: '',
        ...grading.report, filterValues: grading.values, alreadyGraded: grading.alreadyGraded,
        before: measurements.grading.before, after: measurements.grading.after,
        measuredDelta: measurements.grading.delta, directionMatched: measurements.grading.directionMatched,
        exposureNatural: measurements.grading.exposureNatural, highlightSafe: measurements.grading.highlightSafe,
        shadowSafe: measurements.grading.shadowSafe, saturationNatural: measurements.grading.saturationNatural,
        whiteBalanceNatural: measurements.grading.whiteBalanceNatural,
        gradingNotOverprocessed: measurements.grading.notOverprocessed,
        strengthScale: options.gradeStrength },
      music: { musicMood: input.mood, musicRequested: input.mood !== 'NONE',
        musicDecision: input.musicContext.musicDecision,
        musicMoodRequested: input.musicContext.requestedMood,
        musicMoodOverridden: input.mood !== input.musicContext.requestedMood,
        musicRequired: input.musicContext.required,
        trackId: input.track?.id ?? null, trackTitle: input.track?.title ?? null,
        trackMoods: input.track?.moods ?? [],
        musicReusePenalty: input.track ? input.avoidMusicTrackIds.has(input.track.id) : null,
        musicSelectionReason: !musicOn ? '' : input.avoidMusicTrackIds.has(input.track!.id) ?
          'BEST_MATCH_DESPITE_RECENT_REUSE' : 'MOOD_MATCHED',
        license: input.track?.license ?? null, gainDb: musicOn ? round(gainDb, 1) : null,
        fadeInMs: musicOn ? Math.round(fades.in * 1000) : null,
        fadeOutMs: musicOn ? Math.round(fades.out * 1000) : null,
        musicRendered: measurements.audio.musicRendered, speechDominant: measurements.audio.speechDominant,
        speechToMusicDb: measurements.audio.speechToMusicDb,
        musicFadeInDb: measurements.audio.musicFadeInDb, musicFadeOutDb: measurements.audio.musicFadeOutDb,
        libraryProblems: input.musicContext.libraryProblems,
        musicSkippedReason: musicOn ? '' :
          input.musicContext.musicDecision === 'NO_MUSIC' && input.mood !== 'NONE' ? 'DISABLED_BY_POLICY' :
          input.mood === 'NONE' ? 'MOOD_NONE' :
          !input.hasAudio ? 'NO_SOURCE_AUDIO' : options.musicDisabled ? 'DISABLED_AFTER_REPAIR' :
          'NO_LICENSED_TRACK_OR_DISABLED' },
      sfx: { sfxEnabled: input.sfx.enabled && !options.sfxDisabled,
        sfxCount: sfxPlan.length,
        sfxEvents: sfxPlan.map((item) => ({ sfxType: item.type, atSec: round(item.atSec, 3),
          assetId: item.asset.id, assetTitle: item.asset.title, license: item.asset.license,
          generated: item.asset.generated, gainDb: round(item.gainDb, 1),
          lengthSec: round(item.length, 3), semanticReason: item.event.semanticReason,
          zoomKind: item.event.kind })),
        libraryProblems: input.sfx.problems,
        assetCount: input.sfx.assets.length,
        generatedAllowed: input.sfx.allowGenerated,
        sfxGainOffsetDb: round(options.sfxGainOffsetDb, 1),
        sfxSkippedReason: sfxOn ? '' : !input.hasAudio ? 'NO_SOURCE_AUDIO' :
          !input.sfx.enabled ? 'DISABLED_BY_POLICY' : options.sfxDisabled ? 'DISABLED_AFTER_REPAIR' :
          !zoomEvents.length ? 'NO_MOTION_EVENTS' : 'NO_SFX_ASSET',
        sfxRendered: measurements.audio.sfxRendered,
        sfxMeanDb: measurements.audio.sfxMeanDb, sfxPeakDb: measurements.audio.sfxPeakDb,
        speechToSfxDb: measurements.audio.speechToSfxDb,
        sfxUnderSpeech: measurements.audio.sfxUnderSpeechDb,
        sfxTimingValid: measurements.audio.sfxTimingValid,
        sfxWorstOffsetMs: measurements.audio.sfxWorstOffsetMs,
        sfxOnsets: measurements.audio.sfxOnsets },
      video, audio, avOffsetMs, fps: input.fps, measurements,
      checks: [] as QualityCheck[], gate: null as ReturnType<typeof evaluateGate> | null };
  }

  private async measure(input: Parameters<VideoEditExecutorService['renderAttempt']>[0] & {
    visual: Awaited<ReturnType<SubtitleRendererService['write']>>; zoomEvents: ZoomEvent[];
    renderHeight: number; paletteTrack: PaletteTrack | null; blurBackground: boolean; qaView: string;
    speechQa: string; musicQa: string; musicBedQa: string; musicOn: boolean; duration: number;
    hookSettleFrame: number; textBoxesAt: (start: number, end: number) => Rect[];
    fades: { in: number; out: number }; thumbnailPath: string; thumbnail: ThumbnailChoice;
    sfxQa: string; sfxOn: boolean;
    sfxPlan: Array<{ event: ZoomEvent; type: SfxType; atSec: number; gainDb: number;
      asset: SfxAsset; length: number }> }) {
    const { visual, fps, width, height, editorial, layout, camera, timeline } = input;
    const subject = measureSubjectSafety({ frames: input.analysis.frames, shots: input.shots,
      cropAt: camera.cropAt, clipStart: timeline.editedStart, cuts: timeline.cuts,
      zoomEvents: input.zoomEvents, fps, finalDuration: input.finalDuration });
    const empty = {
      subject,
      hook: { hookRendered: visual.hookRendered, hookInsideSafeZone: visual.hookRendered ? true : null,
        hookVisibleAtFrame0: null as boolean | null,
        hookVisibleWithin100ms: null as boolean | null,
        hookReadable: null as boolean | null, hookContrastRatio: null as number | null,
        hookMeasuredBounds: null as Rect | null, hookAgreement: null as number | null,
        hookPositionStable: null as boolean | null, hookPositionDriftPx: null as number | null,
        hookLineHeightPx: null as number | null, hookTypographyReadable: null as boolean | null,
        hookBackgroundContrastValid: null as boolean | null,
        hookSafe: null as boolean | null },
      subtitle: { sampled: 0, renderedRatio: null as number | null, animationVisibleRatio: null as number | null,
        highlightVisibleRatio: null as number | null, insideSafeArea: null as boolean | null,
        measuredBounds: null as Rect | null, onsetSamples: 0, residualOffsetMs: null as number | null,
        residualSpreadMs: null as number | null,
        subtitleSyncErrorAverageMs: visual.subtitleTimelineErrorAverageMs,
        subtitleSyncErrorP95Ms: visual.subtitleTimelineErrorWorstMs,
        subtitleSyncErrorWorstMs: visual.subtitleTimelineErrorWorstMs,
        syncMeasurement: 'TIMELINE_ONLY', finalAudioLagMs: null as number | null,
        sourceGraphicSamples: 0, sourceGraphicCollisionRatio: null as number | null,
        sourceGraphicCollisionCount: 0 },
      zoom: input.zoomEvents.map((event) => ({ triggerText: event.triggerText, estimatedScale: null as number | null,
        plannedScalePeak: event.peakScale, actualRenderedScalePeak: null as number | null,
        actualRenderedScaleDelta: null as number | null, actualIntensity: event.intensity,
        visibleScaleDelta: null as number | null, visibleScaleDeltaValid: null as boolean | null,
        zoomVisible: null as boolean | null, zoomReturnedMeasured: null as boolean | null })),
      transitions: { sampled: 0, invalidCount: 0, hardCutTransitionClean: null as boolean | null,
        failedHardCuts: [] as Array<Record<string, unknown>>,
        checks: [] as Array<{ atSec: number; invalid: boolean; reason: string | null }> },
      background: { backgroundApplied: null as boolean | null, backgroundSourceMatched: null as boolean | null,
        headerMean: null as number[] | null, footerMean: null as number[] | null, colorDistance: null as number | null,
        backgroundNotGenericBlack: null as boolean | null, backgroundTransitionSmooth: null as boolean | null,
        transitions: [] as Array<{ at: number; jump: number; total: number; smooth: boolean }> },
      grading: { gradingApplied: null as boolean | null, before: null as unknown, after: null as unknown,
        delta: null as Record<string, number> | null, directionMatched: null as boolean | null,
        exposureNatural: null as boolean | null, highlightSafe: null as boolean | null,
        shadowSafe: null as boolean | null, saturationNatural: null as boolean | null,
        whiteBalanceNatural: null as boolean | null, notOverprocessed: null as boolean | null },
      thumbnail: { thumbnailGenerated: null as boolean | null, thumbnailContainsHook: null as boolean | null,
        thumbnailReadable: null as boolean | null, thumbnailHookContrastRatio: null as number | null,
        thumbnailHookCoverage: null as number | null, thumbnailBrightness: null as number | null,
        thumbnailSharpness: null as number | null },
      audio: { audioValid: input.hasAudio ? null as boolean | null : null, musicRendered: null as boolean | null,
        speechDominant: null as boolean | null, speechToMusicDb: null as number | null,
        speechMeanDb: null as number | null, musicFadeInDb: null as number | null,
        musicFadeOutDb: null as number | null, musicFadeInValid: null as boolean | null,
        musicFadeOutValid: null as boolean | null,
        sfxRendered: null as boolean | null, sfxMeanDb: null as number | null,
        sfxUnderSpeechDb: null as boolean | null, speechToSfxDb: null as number | null,
        sfxPeakDb: null as number | null,
        sfxOnsets: [] as Array<{ type: SfxType; plannedSec: number; measuredSec: number | null;
          offsetMs: number | null }>,
        sfxTimingValid: null as boolean | null, sfxWorstOffsetMs: null as number | null },
      sampling: { normalFrameCount: 0, hardCutFrameCount: 0,
        maximumNormalFrameCount: MAX_NORMAL_QA_FRAMES,
        normalFrameNumbers: [] as number[], subtitleFrameNumbers: [] as number[],
        gradeFrameNumbers: [] as number[], zoomTripletFrameNumbers: [] as number[] }
    };
    if (!input.qaEnabled) return empty;
    const half = { width: Math.round(width * QA_SCALE), height: Math.round(height * QA_SCALE) };
    const lastFrame = Math.max(0, Math.floor(input.duration * fps) - 2);
    const hookFrames = visual.hookPlaced ? [...new Set([
      0, Math.min(Math.max(1, Math.round(fps * .1)), lastFrame),
      Math.floor(lastFrame / 2), lastFrame
    ])] : [];
    // Frames around each palette crossfade: just before/after the midpoint and well outside it.
    const fadeFrames = input.paletteTrack ? Math.round(input.paletteTrack.fadeSec * fps) : 0;
    const transitionFrames = (input.paletteTrack?.boundaries ?? []).slice(0, 3).map((bound) => {
      const at = Math.round(bound * fps);
      return { at: bound, frames: [at - fadeFrames - 3, at - 2, at + 2, at + fadeFrames + 3]
        .map((n) => Math.max(0, Math.min(lastFrame, n))) };
    });
    const events = visual.wordEvents;
    const keywordEvents = events.filter((event) => event.keyword);
    const plainEvents = events.filter((event) => !event.keyword);
    const pick = <T>(items: T[], count: number) => items.length <= count ? items :
      Array.from({ length: count }, (_, i) => items[Math.floor((i + .5) * items.length / count)]);
    const sampledEvents = [...pick(keywordEvents, 2), ...pick(plainEvents, 4)]
      .map((event) => ({ event, frame: Math.min(event.startFrame + 2, event.endFrame - 1) }))
      .filter((item) => item.frame >= 0 && item.frame <= lastFrame);
    // Before/after samples must stay inside the zoom's own shot.
    const zoomFrames = input.zoomEvents.map((event) => {
      const shot = input.shots.find((item) => event.startSec >= item.start - 1e-6 && event.startSec < item.end);
      const shotStart = shot ? Math.ceil(shot.start * fps) : 0;
      const shotEnd = shot ? Math.floor(shot.end * fps) - 1 : lastFrame;
      const settled = Math.max(event.endFrame, Math.min(lastFrame, shotEnd, event.endFrame + 3));
      const verification = event.verificationFrameTimes.map((time) =>
        Math.max(shotStart, Math.min(shotEnd, Math.round(time * fps))));
      // A pull back has no un-zoomed frame before it - the tight frame is
      // established across the cut - so its baseline is the settled frame it
      // returns to, and the zoomed sample is taken right after the start.
      if (event.kind === 'OUT')
        return { before: settled, peak: Math.min(lastFrame, event.startFrame + 2), after: settled,
          verification };
      return { before: Math.max(shotStart, event.startFrame - 3),
        peak: Math.min(lastFrame, event.startFrame + event.rampInFrames + 2),
        after: settled, verification };
    });
    const gradeFrames = [.15, .38, .62, .85].map((p) => Math.floor(lastFrame * p));
    const hardCutFrames = input.shots.slice(1).map((shot, index) => ({ at: shot.start,
      shotBeforeId: index, shotAfterId: index + 1,
      frames: [-3, -2, -1, 0, 1, 2, 3, 6].map((offset) =>
        Math.max(0, Math.min(lastFrame, Math.round(shot.start * fps) + offset))) }));
    const timelineFrames = [0, Math.round(fps * .1), Math.round(fps), Math.floor(lastFrame / 2),
      Math.max(0, lastFrame - Math.round(fps * .4)), lastFrame]
      .map((frame) => Math.max(0, Math.min(lastFrame, frame)));
    // Background/grading need more than a single potentially atypical frame,
    // while at least one real caption frame must survive a zoom-heavy sample.
    // These remain inside 24 frames with the planner's five-event zoom ceiling.
    const essentialGradeFrames = [gradeFrames[0], gradeFrames[2]];
    // Prefer a normal caption over an emphasized transition frame: the former
    // is stable for the full word interval and is the strongest burn-in probe.
    const essentialSubtitleEvent = sampledEvents.find((item) => !item.event.keyword) ?? sampledEvents[0];
    const essentialSubtitleFrames = essentialSubtitleEvent ? [essentialSubtitleEvent.frame] : [];
    const mandatoryFrames = [...new Set([...timelineFrames, ...hookFrames,
      ...essentialGradeFrames, ...essentialSubtitleFrames])];
    const informationFrames = input.shots.filter((shot) => shot.informationMode)
      .map((shot) => Math.max(0, Math.min(lastFrame, Math.round((shot.start + shot.end) / 2 * fps))));
    const normalOutputFrames = normalQaFrameNumbers(mandatoryFrames,
      zoomFrames.map((item) => [item.before, item.peak, item.after]), [
        zoomFrames.flatMap((item) => item.verification), informationFrames,
        sampledEvents.map((item) => item.frame), gradeFrames,
        transitionFrames.flatMap((item) => item.frames)
      ]);
    const sampledEventsForQa = sampledEvents.filter((item) =>
      normalOutputFrames.includes(item.frame));
    const hardCutOutputFrames = [...new Set(hardCutFrames.flatMap((item) => item.frames))];
    empty.sampling.normalFrameCount = normalOutputFrames.length;
    empty.sampling.hardCutFrameCount = hardCutOutputFrames.length;
    empty.sampling.normalFrameNumbers = normalOutputFrames;
    empty.sampling.subtitleFrameNumbers = sampledEventsForQa.map((item) => item.frame);
    empty.sampling.gradeFrameNumbers = gradeFrames.filter((frame) => normalOutputFrames.includes(frame));
    empty.sampling.zoomTripletFrameNumbers = zoomFrames.flatMap((item) =>
      [item.before, item.peak, item.after]).filter((frame) => normalOutputFrames.includes(frame));
    const [normalOutput, hardCutOutput, probeFrames, qaFrames] = await Promise.all([
      extractFrames(input.outputPath, normalOutputFrames, half.width, half.height),
      // Hard-cut checks are intentionally decoded separately in small batches;
      // they never enlarge the normal 24-frame acceptance sample expression.
      extractFrames(input.outputPath, hardCutOutputFrames, half.width, half.height),
      renderAssProbe(input.directory, 'edit.ass', { width, height }, fps,
        [...hookFrames, ...sampledEventsForQa.map((item) => item.frame)], half.width, half.height),
      extractFrames(input.qaView, gradeFrames, 180, Math.round(180 * input.renderHeight / width / 2) * 2)
    ]);
    const output = new Map<number, Frame>([...normalOutput, ...hardCutOutput]);
    const viewportHalf = scaleRect(input.viewport, QA_SCALE);
    const headerHalf = editorial ? scaleRect(layout.headerBounds, QA_SCALE) : null;
    const footerHalf = editorial ? scaleRect(layout.footerBounds, QA_SCALE) : null;

    // Hook
    const hook = { ...empty.hook };
    if (visual.hookPlaced && visual.hookZone) {
      // The headline is dark text on its own white plate, so the glyph mask is
      // taken over the plate rather than over the whole (dark) header band.
      const plateHalf = visual.hookPlateBounds ? scaleRect(visual.hookPlateBounds, QA_SCALE) : null;
      // Each sampled frame is compared with its own probe (the hook may animate in).
      const perFrame = hookFrames.map((frame) => {
        const probeFrame = probeFrames.get(frame);
        const out = output.get(frame);
        const frameMask = probeFrame ? hookGlyphMask(probeFrame, plateHalf) : null;
        return { frame, mask: frameMask, agreement: probeFrame && out && frameMask ?
          maskAgreement(probeFrame, out, frameMask) : 0 };
      });
      const visible = (item: typeof perFrame[number] | undefined) => Boolean(item &&
        (item.mask?.pixels.length ?? 0) >= 150 && item.agreement >= .85);
      hook.hookVisibleAtFrame0 = visible(perFrame.find((item) => item.frame === 0));
      hook.hookVisibleWithin100ms = perFrame.filter((item) => item.frame <= Math.ceil(fps * .1))
        .some(visible);
      const mask = perFrame[0]?.mask ?? null;
      hook.hookAgreement = round(Math.min(...perFrame.map((item) => item.agreement)));
      hook.hookRendered = perFrame.every((item) => (item.mask?.pixels.length ?? 0) >= 150 &&
        item.agreement >= .85);
      const settled = perFrame.map((item) => item.mask?.bounds).filter((item): item is Rect => Boolean(item));
      const measured = settled.length ? settled.reduce(union) : null;
      hook.hookMeasuredBounds = measured ? scaleRect(measured, 1 / QA_SCALE) : null;
      hook.hookInsideSafeZone = Boolean(hook.hookMeasuredBounds &&
        inside(hook.hookMeasuredBounds, visual.hookZone, 2) &&
        inside(hook.hookMeasuredBounds, { x: 0, y: 0, width, height }));
      // Once settled the hook must not move: compare the glyph bounds of every sample.
      if (settled.length === perFrame.length && settled.length > 1) {
        const drift = Math.max(...settled.slice(1).flatMap((bounds) => [bounds.x - settled[0].x,
          bounds.y - settled[0].y, bounds.width - settled[0].width, bounds.height - settled[0].height]
          .map(Math.abs))) / QA_SCALE;
        hook.hookPositionDriftPx = round(drift, 1);
        hook.hookPositionStable = drift <= 4;
      }
      if (hook.hookMeasuredBounds) {
        const bottom = hook.hookMeasuredBounds.y + hook.hookMeasuredBounds.height;
        const bands = mask ? textLineBands(mask, probeFrames.get(hookFrames[0])?.width ?? 1) : [];
        hook.hookLineHeightPx = bands.length ? round(Math.min(...bands) / QA_SCALE, 1) : null;
        hook.hookSafe = hook.hookInsideSafeZone && (!editorial || (bottom <= layout.headerBounds.y +
          layout.headerBounds.height && bottom <= layout.videoViewport.y));
      }
      // Contrast of the headline against ITS OWN PLATE (§20/§21): the plate is
      // what sits behind the glyphs now, so measuring against the header band
      // would be measuring the wrong two colours.
      const contrasts = perFrame.flatMap(({ frame, mask: frameMask }) => {
        const out = output.get(frame);
        if (!out || !frameMask?.bounds || !frameMask.pixels.length) return [];
        const inMask = frameMask.pixels.reduce((sum, pixel) => sum + luminance(out.data[pixel * 3],
          out.data[pixel * 3 + 1], out.data[pixel * 3 + 2]), 0) / frameMask.pixels.length;
        const around = regionStats(out, plateHalf ?? headerHalf ??
          { x: frameMask.bounds.x - 30, y: frameMask.bounds.y - 30,
            width: frameMask.bounds.width + 60, height: frameMask.bounds.height + 60 },
        dilate(frameMask, out.width, 5));
        return around.count ? [contrastRatio(inMask, around.medianLuminance)] : [];
      });
      if (contrasts.length && mask?.bounds) {
        hook.hookContrastRatio = round(Math.min(...contrasts), 2);
        hook.hookReadable = (hook.hookContrastRatio ?? 0) >= (editorial ? 4.5 : 3);
        // The plate carries the contrast, so this is the plate-vs-text ratio.
        hook.hookBackgroundContrastValid = hook.hookReadable;
        // Readable headline: contrast, line count within the fit ladder's limit,
        // and lines tall enough on a phone.
        hook.hookTypographyReadable = hook.hookReadable &&
          visual.hookLines.length <= HOOK_TYPE.maxLines &&
          (hook.hookLineHeightPx ?? 0) >= 28;
      }
    }

    // Subtitles
    const subtitle = { ...empty.subtitle };
    if (sampledEventsForQa.length) {
      let rendered = 0, animated = 0, animatedTotal = 0, keywordVisible = 0, keywordTotal = 0;
      let collisionSamples = 0, collisionWorst = 0, collisionCount = 0;
      let bounds: Rect | null = null;
      for (const { event, frame } of sampledEventsForQa) {
        const probeFrame = probeFrames.get(frame);
        const out = output.get(frame);
        if (!probeFrame || !out) continue;
        const region = { x: viewportHalf.x, y: viewportHalf.y, width: viewportHalf.width, height: viewportHalf.height };
        const mask = probeMask(probeFrame, { region });
        if (mask.bounds) bounds = bounds ? union(bounds, mask.bounds) : mask.bounds;
        // Rendered caption glyphs vs burned-in source text on screen at that moment.
        const sourceText = editorial && mask.bounds ?
          input.textBoxesAt(event.renderStart, event.renderEnd) : [];
        if (sourceText.length && mask.bounds) {
          const ratio = collisionAreaRatio(scaleRect(mask.bounds, 1 / QA_SCALE), sourceText);
          collisionSamples++;
          collisionWorst = Math.max(collisionWorst, ratio);
          if (ratio > .06) collisionCount++;
        }
        if (mask.pixels.length >= 80 && maskAgreement(probeFrame, out, mask) >= .8) rendered++;
        if (event.activeColor && input.plan.subtitleStyle.highlightCurrentWord) {
          const color = assToRgb(event.activeColor);
          const colored = probeMask(probeFrame, { region, color, tolerance: 40 });
          const visible = colored.pixels.length >= 20 && maskAgreement(probeFrame, out, colored, 50) >= .7;
          if (event.keyword) { keywordTotal++; if (visible) keywordVisible++; }
          else { animatedTotal++; if (visible) animated++; }
        }
      }
      subtitle.sampled = sampledEventsForQa.length;
      subtitle.renderedRatio = round(rendered / sampledEventsForQa.length);
      subtitle.animationVisibleRatio = animatedTotal ? round(animated / animatedTotal) : null;
      subtitle.highlightVisibleRatio = keywordTotal ? round(keywordVisible / keywordTotal) : null;
      subtitle.measuredBounds = bounds ? scaleRect(bounds, 1 / QA_SCALE) : null;
      const safeArea = editorial ? layout.videoViewport : { x: 0, y: 0, width, height };
      subtitle.insideSafeArea = subtitle.measuredBounds ? inside(subtitle.measuredBounds, safeArea, 2) : null;
      subtitle.sourceGraphicSamples = collisionSamples;
      subtitle.sourceGraphicCollisionRatio = collisionSamples ? round(collisionWorst) : null;
      subtitle.sourceGraphicCollisionCount = collisionCount;
    }
    const audio = { ...empty.audio };
    if (input.hasAudio) {
      try {
        const speech = await audioEnvelope(input.speechQa);
        const final = await audioEnvelope(input.outputPath);
        const lag = envelopeLag(speech.db, final.db, 30);
        subtitle.finalAudioLagMs = lag * 10;
        const offsets = measureOnsetOffsets(speech, events.map((event) => ({
          start: event.renderStart - lag * speech.hopSec, end: event.renderEnd,
          gapBefore: gapBefore(input.words, event, input.mapper) })));
        subtitle.onsetSamples = offsets.length;
        if (offsets.length >= 4) {
          const abs = offsets.map((value) => Math.abs(value) * 1000);
          subtitle.residualOffsetMs = Math.round(median(offsets) * 1000);
          subtitle.residualSpreadMs = Math.round(median(offsets.map((value) =>
            Math.abs(value - median(offsets)))) * 1000);
          subtitle.subtitleSyncErrorAverageMs = round(abs.reduce((a, b) => a + b, 0) / abs.length, 1)!;
          subtitle.subtitleSyncErrorP95Ms = round(percentile(abs, .95), 1)!;
          subtitle.subtitleSyncErrorWorstMs = round(Math.max(...abs), 1)!;
          subtitle.syncMeasurement = 'AUDIO_ONSET';
        }
        const finalMean = meanDb(final, [{ start: 0, end: input.duration }]);
        const finalPeak = Math.max(...final.db);
        audio.audioValid = finalMean > -45 && finalPeak < -.3;
        const speechRanges = events.map((event) => ({ start: event.renderStart, end: event.renderEnd }));
        audio.speechMeanDb = round(meanDb(speech, speechRanges), 1);
        if (input.musicOn) {
          const music = await audioEnvelope(input.musicQa);
          const musicMean = meanDb(music, [{ start: 0, end: input.duration }]);
          const musicUnderSpeech = meanDb(music, speechRanges);
          audio.musicRendered = musicMean > -55;
          audio.speechToMusicDb = round((audio.speechMeanDb ?? -100) - musicUnderSpeech, 1);
          audio.speechDominant = (audio.speechToMusicDb ?? 0) >= 10;
          // Fades on the un-ducked bed: the edges must sit clearly below the steady level.
          const bed = await audioEnvelope(input.musicBedQa);
          const d = input.duration, { in: fadeIn, out: fadeOut } = input.fades;
          const edge = Math.min(.08, fadeIn / 4);
          audio.musicFadeInDb = round(meanDb(bed, [{ start: fadeIn + .1, end: fadeIn + .6 }]) -
            meanDb(bed, [{ start: 0, end: edge }]), 1);
          audio.musicFadeOutDb = round(meanDb(bed, [{ start: Math.max(0, d - fadeOut - .7), end: d - fadeOut - .1 }]) -
            meanDb(bed, [{ start: d - Math.min(.12, fadeOut / 4), end: d }]), 1);
          audio.musicFadeInValid = (audio.musicFadeInDb ?? 0) >= 6;
          audio.musicFadeOutValid = (audio.musicFadeOutDb ?? 0) >= 6;
        } else audio.speechDominant = true;
        if (input.sfxOn && input.sfxPlan.length) {
          // The effects bus is rendered on its own, so presence, level and timing
          // are all measured directly rather than inferred from the final mix.
          const sfx = await audioEnvelope(input.sfxQa);
          audio.sfxMeanDb = round(meanDb(sfx, input.sfxPlan.map((item) => ({ start: item.atSec,
            end: Math.min(input.duration, item.atSec + item.length) }))), 1);
          const windowPeak = Math.max(-100, ...input.sfxPlan.flatMap((item) => {
            const from = Math.max(0, Math.floor(item.atSec / sfx.hopSec));
            const to = Math.min(sfx.db.length, Math.ceil((item.atSec + item.length) / sfx.hopSec));
            return Array.from(sfx.db.slice(from, to));
          }));
          audio.sfxPeakDb = round(windowPeak, 1);
          // Most of an effect's window is its own tail, so presence is a peak
          // question rather than a mean one.
          audio.sfxRendered = windowPeak > -55;
          // Only the speech that an effect actually plays under matters here.
          const overlapping = speechRanges.filter((range) => input.sfxPlan.some((item) =>
            range.start < item.atSec + item.length && range.end > item.atSec));
          const underSpeech = overlapping.length ? meanDb(sfx, overlapping) : null;
          audio.speechToSfxDb = underSpeech == null ? null :
            round((audio.speechMeanDb ?? -100) - underSpeech, 1);
          // Speech always wins: an effect that is not clearly below the voice it
          // plays under is a mixing error, not a stylistic choice (§16/§17).
          audio.sfxUnderSpeechDb = audio.speechToSfxDb == null ? true :
            audio.speechToSfxDb >= 10;
          audio.sfxOnsets = input.sfxPlan.map((item) => {
            const measured = firstOnsetSec(sfx, Math.max(0, item.atSec - .25),
              Math.min(input.duration, item.atSec + .35));
            return { type: item.type, plannedSec: round(item.atSec, 3)!,
              measuredSec: measured == null ? null : round(measured, 3)!,
              offsetMs: measured == null ? null : Math.round((measured - item.atSec) * 1000) };
          });
          const offsets = audio.sfxOnsets.map((item) => item.offsetMs)
            .filter((value): value is number => value != null);
          audio.sfxWorstOffsetMs = offsets.length ? Math.max(...offsets.map(Math.abs)) : null;
          audio.sfxTimingValid = offsets.length === audio.sfxOnsets.length &&
            (audio.sfxWorstOffsetMs ?? 0) <= SFX_MIX.timingToleranceSec * 1000;
        }
      } catch (error) {
        this.logger.warn(`Audio QA failed: ${error instanceof Error ? error.message : error}`);
        audio.audioValid = false;
      }
    }

    // Zoom visibility on the final viewport
    const zoom = input.zoomEvents.map((event, index) => {
      const frames = zoomFrames[index];
      const [before, peak, after] = [frames.before, frames.peak, frames.after].map((n) => output.get(n));
      if (!before || !peak || !after) return { triggerText: event.triggerText, estimatedScale: null,
        zoomVisible: null, zoomReturnedMeasured: null };
      const size = { width: 96, height: Math.round(96 * viewportHalf.height / viewportHalf.width) };
      const g = (frame: Frame) => toGray(frame, viewportHalf, size.width, size.height);
      const atPeak = estimateZoom(g(before), g(peak), size.width, size.height, event.focusX, event.focusY);
      const atEnd = estimateZoom(g(before), g(after), size.width, size.height, event.focusX, event.focusY);
      // The rendered scale change, not the planned one (§13): a move that plans
      // 1.26 and renders 1.04 is a failed move however correct its plan was.
      const visibleScaleDelta = round(Math.max(0, atPeak.estimatedScale - 1), 3);
      return { triggerText: event.triggerText, estimatedScale: atPeak.estimatedScale,
        plannedScalePeak: event.peakScale, actualRenderedScalePeak: atPeak.estimatedScale,
        actualRenderedScaleDelta: visibleScaleDelta, actualIntensity: event.intensity, visibleScaleDelta,
        visibleScaleDeltaValid: (visibleScaleDelta ?? 0) >= event.minVisibleScaleDelta &&
          atPeak.bestError < atPeak.identityError * .92,
        zoomVisible: atPeak.estimatedScale >= 1 + (event.peakScale - 1) * .5 &&
          atPeak.bestError < atPeak.identityError * .92,
        // A pull back settles on the baseline by construction; its `before` and
        // `after` samples are the same frame, so there is nothing to measure.
        zoomReturnedMeasured: event.kind === 'OUT' ? null : atEnd.estimatedScale <= 1.04 };
    });

    // Hard-cut QA: frames immediately after a source cut must already resemble
    // the new stable composition and must never be a blank/solid intermediate.
    const frameDistance = (a: Frame, b: Frame) => {
      const step = Math.max(4, Math.floor(a.data.length / 12000 / 4) * 4);
      let total = 0, count = 0;
      for (let i = 0; i < Math.min(a.data.length, b.data.length); i += step) {
        total += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]); count += 3;
      }
      return count ? total / count / 255 : 0;
    };
    const transitionChecks = hardCutFrames.map(({ at, shotBeforeId, shotAfterId, frames }) => {
      const values = frames.map((frame) => output.get(frame));
      const common = { atSec: round(at, 3)!, timestamp: round(at, 3)!, cutTimestamp: round(at, 3)!,
        shotBeforeId, shotAfterId,
        frameBefore: frames[2], frameAfter: frames[7], sampledFrames: frames };
      if (values.some((frame) => !frame)) return { ...common, invalid: true, reason: 'MISSING_SAMPLE',
        score: null, measurement: null };
      const before = values[2]!, stableAfter = values[7]!;
      const intermediates = values.slice(3, 6) as Frame[];
      const intermediateStats = intermediates.map((frame) => regionStats(frame, viewportHalf));
      const blank = intermediateStats.some((stats) => stats.brightness < .02 && stats.contrast < .003);
      const endpointChange = frameDistance(before, stableAfter);
      const postDistances = intermediates.slice(1).map((frame) => ({
        toAfter: frameDistance(frame, stableAfter), toBefore: frameDistance(frame, before) }));
      const staleScore = Math.max(0, ...postDistances.map((item) => item.toAfter - item.toBefore));
      const stale = endpointChange > .08 && staleScore > .06;
      return { ...common, invalid: blank || stale,
        reason: blank ? 'BLANK_FRAME' : stale ? 'STALE_INTERPOLATION' : null,
        score: round(blank ? 1 : staleScore, 4),
        measurement: { endpointChange: round(endpointChange, 4),
          worstPostToAfter: round(Math.max(0, ...postDistances.map((item) => item.toAfter)), 4),
          worstPostToBefore: round(Math.min(1, ...postDistances.map((item) => item.toBefore)), 4),
          brightnessMin: round(Math.min(...intermediateStats.map((item) => item.brightness)), 4),
          contrastMin: round(Math.min(...intermediateStats.map((item) => item.contrast)), 4) } };
    });
    const transitions = { sampled: transitionChecks.length,
      invalidCount: transitionChecks.filter((item) => item.invalid).length,
      hardCutTransitionClean: transitionChecks.length ? transitionChecks.every((item) => !item.invalid) : null,
      failedHardCuts: transitionChecks.filter((item) => item.invalid),
      checks: transitionChecks };

    // Background
    const background = { ...empty.background };
    const track = input.paletteTrack;
    if (editorial && headerHalf && footerHalf && track) {
      // The headline's white plate is a large bright rectangle inside the header,
      // so the WHOLE plate - not just its glyphs - is excluded before the header's
      // colour is measured against the expected ambient/tint colour.
      const plateHalf = visual.hookPlateBounds ? scaleRect(visual.hookPlateBounds, QA_SCALE) : null;
      const hookMaskFrame = probeFrames.get(hookFrames[0]);
      const exclude = hookMaskFrame && plateHalf ?
        dilate(rectMask(hookMaskFrame, plateHalf), hookMaskFrame.width, 8) : undefined;
      const areas = (frame: Frame) => [regionStats(frame, headerHalf, exclude),
        regionStats(frame, { ...footerHalf, height: footerHalf.height - 1 })];
      const channelDistance = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      const samples = gradeFrames.flatMap((n) => {
        const frame = output.get(n);
        const source = qaFrames.get(n);
        if (!frame) return [];
        const [header, footer] = areas(frame);
        const t = n / fps;
        const sourceMean = source ? regionStats(source, { x: 0, y: 0, width: source.width,
          height: source.height }).mean : null;
        // Expected colors: the tint itself, or the tint mixed with the darkened footage.
        const expected = ([0, 1] as const).map((row) => input.blurBackground ?
          sourceMean ? expectedAmbientColor(tintAt(track, t, row), sourceMean, input.options.headerDarken) : null :
          tintAt(track, t, row));
        const distance = expected[0] && expected[1] ? Math.max(channelDistance(header.mean, expected[0]),
          channelDistance(footer.mean, expected[1])) : null;
        return [{ header, footer, distance }];
      });
      if (samples.length) {
        const first = samples[Math.min(1, samples.length - 1)];
        background.headerMean = first.header.mean.map((value) => Math.round(value));
        background.footerMean = first.footer.mean.map((value) => Math.round(value));
        const distances = samples.map((item) => item.distance).filter((item): item is number => item != null);
        const distance = distances.length ? median(distances) : null;
        background.colorDistance = round(distance, 1);
        const flatBlack = samples.some((item) => item.header.brightness < .03 && item.header.saturation < .08 &&
          item.header.contrast <= .004);
        const sampledPalette = input.palette !== null && input.palette !== DEFAULT_SOURCE_PALETTE;
        if (input.blurBackground) {
          const textured = samples.some((item) => item.header.contrast > .004);
          background.backgroundApplied = !flatBlack && (textured || (distance ?? Infinity) <= 45);
          background.backgroundSourceMatched = (distance ?? Infinity) <= 45;
        } else {
          background.backgroundApplied = (distance ?? Infinity) <= 40 && !(flatBlack && sampledPalette);
          background.backgroundSourceMatched = background.backgroundApplied && sampledPalette;
        }
        background.backgroundNotGenericBlack = !flatBlack && (input.blurBackground || sampledPalette);
      }
      // A crossfade spreads the change: the step across its midpoint is a fraction of the total change.
      background.transitions = transitionFrames.flatMap(({ at, frames: [far0, a, b, far1] }) => {
        const [f0, fa, fb, f1] = [far0, a, b, far1].map((n) => output.get(n));
        if (!f0 || !fa || !fb || !f1) return [];
        const means = (frame: Frame) => areas(frame).map((stats) => stats.mean);
        const [m0, ma, mb, m1] = [f0, fa, fb, f1].map(means);
        const jump = Math.max(channelDistance(ma[0], mb[0]), channelDistance(ma[1], mb[1]));
        const total = Math.max(channelDistance(m0[0], m1[0]), channelDistance(m0[1], m1[1]));
        return [{ at: round(at)!, jump: round(jump, 1)!, total: round(total, 1)!,
          smooth: jump <= Math.max(10, total * .6) }];
      });
      background.backgroundTransitionSmooth = background.transitions.length ?
        background.transitions.every((item) => item.smooth) : null;
    }

    // Grading: ungraded tap vs final viewport (upper half, captions excluded)
    const grading = { ...empty.grading };
    const before: number[][] = [];
    const after: number[][] = [];
    for (const n of gradeFrames) {
      const pre = qaFrames.get(n);
      const out = output.get(n);
      if (!pre || !out) continue;
      const preTop = cropFrame(pre, { x: 0, y: 0, width: pre.width, height: Math.floor(pre.height * .5) });
      const outTop = cropFrame(out, { x: viewportHalf.x, y: viewportHalf.y, width: viewportHalf.width,
        height: Math.floor(viewportHalf.height * .5) }, pre.width, Math.floor(pre.height * .5));
      const a = statsFromRgb(preTop.data, preTop.width);
      const b = statsFromRgb(outTop.data, outTop.width);
      before.push([a.brightness, a.contrast, a.chroma ?? 0, a.sharpness ?? 0,
        a.highlightClipping ?? 0, a.shadowClipping ?? 0]);
      after.push([b.brightness, b.contrast, b.chroma ?? 0, b.sharpness ?? 0,
        b.highlightClipping ?? 0, b.shadowClipping ?? 0]);
    }
    if (before.length) {
      const avg = (rows: number[][], i: number) => rows.reduce((sum, row) => sum + row[i], 0) / rows.length;
      const [bb, bc, bs, bsh, bhi, blo] = [0, 1, 2, 3, 4, 5].map((i) => avg(before, i));
      const [ab, ac, as, ash, ahi, alo] = [0, 1, 2, 3, 4, 5].map((i) => avg(after, i));
      grading.before = { brightness: round(bb), contrast: round(bc), chroma: round(bs), sharpness: round(bsh) };
      grading.after = { brightness: round(ab), contrast: round(ac), chroma: round(as), sharpness: round(ash) };
      grading.delta = { brightness: round(ab - bb, 4)!, contrast: round(ac - bc, 4)!,
        chroma: round(as - bs, 4)!, sharpness: round(ash - bsh, 4)! };
      const magnitude = Math.abs(ab - bb) + Math.abs(ac - bc) + Math.abs(as - bs) + Math.abs(ash - bsh);
      const intended = gradingFilter(input.gradePreset, input.sourceStats, input.options.gradeStrength).report;
      // Each intended direction must be visible (small tolerance for measurement noise).
      const directionOk = (intended.saturationAdjustment < .02 || as - bs >= -.002) &&
        (intended.contrastAdjustment < .02 || ac - bc >= -.002) &&
        (Math.abs(intended.exposureAdjustment) < .01 || Math.sign(ab - bb) === Math.sign(intended.exposureAdjustment) ||
          Math.abs(ab - bb) < .004);
      grading.directionMatched = directionOk;
      grading.gradingApplied = input.gradePreset === 'NO_CHANGE' ? magnitude < .02 :
        input.gradePreset === 'SOURCE_ALREADY_GRADED' ? magnitude < .06 : magnitude >= .004 && directionOk;
      // Conservative-grading safety net: none of these ever block delivery (a
      // measurement blip shouldn't sink an otherwise-fine clip), they only
      // surface when the render pushed exposure/color further than intended.
      grading.exposureNatural = Math.abs(ab - bb) <= .12;
      grading.highlightSafe = ahi <= Math.max(.05, bhi + .03);
      grading.shadowSafe = alo <= Math.max(.06, blo + .03);
      grading.saturationNatural = (as - bs) <= .18;
      grading.whiteBalanceNatural = Math.abs(intended.temperatureAdjustment) <= .06;
      grading.notOverprocessed = magnitude <= .35 && grading.exposureNatural && grading.saturationNatural;
    }
    // Thumbnail: the cover must exist, carry the headline, and be readable.
    const thumbnail = { ...empty.thumbnail };
    try {
      const cover = (await extractFrames(input.thumbnailPath, [0], half.width, half.height)).get(0);
      thumbnail.thumbnailGenerated = Boolean(cover);
      if (cover) {
        const stats = statsFromRgb(cover.data, cover.width);
        thumbnail.thumbnailBrightness = round(stats.brightness);
        thumbnail.thumbnailSharpness = round(stats.sharpness);
        // The cover carries the identical hook dialogue as the clip, so the clip's
        // own hook probe is the exact glyph mask the cover must contain.
        const probe = visual.hookPlaced ? (await renderAssProbe(input.directory,
          'thumbnail-hook.ass', { width, height }, fps, [1], half.width, half.height)).get(1) : null;
        const coverPlate = visual.hookPlateBounds ?
          scaleRect(visual.hookPlateBounds, QA_SCALE) : null;
        const mask = probe && coverPlate ? hookGlyphMask(probe, coverPlate) : null;
        if (mask?.pixels.length) {
          const agreement = maskAgreement(probe!, cover, mask);
          thumbnail.thumbnailHookCoverage = round(agreement);
          thumbnail.thumbnailContainsHook = mask.pixels.length >= 150 && agreement >= .85;
          const inMask = mask.pixels.reduce((sum, pixel) => sum + luminance(cover.data[pixel * 3],
            cover.data[pixel * 3 + 1], cover.data[pixel * 3 + 2]), 0) / mask.pixels.length;
          const around = regionStats(cover, coverPlate ?? headerHalf ??
            { x: 0, y: 0, width: cover.width, height: cover.height },
          dilate(mask, cover.width, 5));
          if (around.count) {
            thumbnail.thumbnailHookContrastRatio = round(contrastRatio(inMask, around.medianLuminance), 2);
            thumbnail.thumbnailReadable = (thumbnail.thumbnailHookContrastRatio ?? 0) >= 4.5 &&
              (stats.brightness ?? 0) >= .06;
          }
        } else if (!visual.hookPlaced) thumbnail.thumbnailContainsHook = null;
      }
    } catch (error) {
      this.logger.warn(`Thumbnail QA failed: ${error instanceof Error ? error.message : error}`);
      thumbnail.thumbnailGenerated = false;
    }
    return { subject, hook, subtitle, zoom, transitions, background, grading, audio, thumbnail,
      sampling: empty.sampling };
  }

  private buildChecks(result: Awaited<ReturnType<VideoEditExecutorService['renderAttempt']>>, context: {
    plan: EditPlan; hasAudio: boolean; editorial: boolean; musicApplicable: boolean; musicRequired: boolean;
    boundary?: BoundaryDecision; loop: LoopDecision; qaEnabled: boolean; timeline: EditedTimeline;
    width: number; height: number; layout: typeof PLATFORM_LAYOUT_PRESETS['UNIVERSAL'] }): QualityCheck[] {
    const { measurements: m, visual } = result;
    const qa = context.qaEnabled;
    const b = context.boundary;
    // An AI_EDITED clip must carry a headline, so the hook checks stay applicable
    // even when the renderer failed to place one: a missing hook is a BASELINE
    // failure, never "N/A".
    const hookRequired = context.plan.hookRequired === true || context.plan.onScreenHook.enabled;
    const subtitleRequired = context.plan.subtitleStyle.enabled && visual.wordEvents.length > 0;
    const zoomApplicable = result.zoomEvents.length > 0;
    const sfxApplicable = result.sfx.sfxCount > 0;
    const subject = m.subject;
    const hookMeasured = hookRequired && qa && Boolean(visual.hookPlaced);
    const musicOn = result.music.trackId != null;
    const collisionMeasured = subtitleRequired && qa && context.editorial && m.subtitle.sourceGraphicSamples > 0;
    const renderedZoomCount = qa ? m.zoom.filter((item) => item.visibleScaleDeltaValid === true).length :
      result.zoomEvents.length;
    const renderedZoomCoverageValid = renderedZoomCount >= result.requiredZoomCount;
    // The last moment anything is still animating or moving on screen, used by
    // the ending checks below.
    const lastSubtitleEndSec = visual.wordEvents.length ?
      round(Math.max(...visual.wordEvents.map((event) => event.renderEnd))) : null;
    const endSec = context.timeline.editedDuration;
    const endMotion = (() => {
      const before = result.camera.cropAt(Math.max(0, endSec - .4));
      const after = result.camera.cropAt(Math.max(0, endSec - .02));
      if (!before || !after || !(after.w > 0)) return null;
      // Movement as a share of the crop itself, so it means the same thing at
      // any source resolution.
      return round(Math.max(Math.abs(after.x - before.x) / after.w,
        Math.abs(after.y - before.y) / Math.max(1, after.h)), 4);
    })();
    const finalScaleVelocity = (() => {
      const from = Math.max(0, endSec - .4), to = Math.max(from + .001, endSec - .02);
      return round(Math.abs(zoomScaleAt(result.zoomEvents, to, result.fps) -
        zoomScaleAt(result.zoomEvents, from, result.fps)) / (to - from), 4);
    })();
    const shotCutAtEnd = result.shots.some((shot) =>
      shot.start > 0 && shot.start > endSec - .4 && shot.start < endSec);
    const cohesionParts = [m.background.backgroundApplied, m.background.backgroundSourceMatched,
      m.background.backgroundNotGenericBlack, m.background.backgroundTransitionSmooth ?? true,
      !hookMeasured || m.hook.hookReadable, !hookMeasured || m.hook.hookPositionStable !== false,
      !subtitleRequired || (m.subtitle.renderedRatio ?? 0) >= .8,
      !collisionMeasured || (m.subtitle.sourceGraphicCollisionRatio ?? 0) <= .06];
    return [
      check('videoValid', { applicable: true, passed: Boolean(result.video && result.video.codec_name === 'h264' && result.sizeBytes > 0) }),
      check('outputResolutionValid', { applicable: true,
        passed: result.video?.width === context.width && result.video?.height === context.height }),
      check('durationValid', { applicable: true, value: round(result.duration),
        passed: Number.isFinite(result.duration) && Math.abs(result.duration - context.timeline.editedDuration) <= .25 }),
      check('audioValid', { applicable: context.hasAudio, passed: Boolean(result.audio) && m.audio.audioValid !== false &&
        result.avOffsetMs <= 60, value: { avOffsetMs: result.avOffsetMs } }),
      // --- start quality (§28) ---
      check('clipStartStrong', { applicable: Boolean(b), severity: 'ENHANCEMENT', passed: b?.clipStartStrong }),
      check('clipStartNatural', { applicable: Boolean(b), severity: 'ENHANCEMENT', passed: b?.clipStartNatural }),
      // A clip a cold viewer cannot follow is not a cosmetic defect: opening on
      // a pronoun with no antecedent loses the viewer in the first second.
      check('clipStartContextComplete', { applicable: Boolean(b), severity: 'ENHANCEMENT',
        passed: b?.clipStartContextComplete, value: b?.openingStrategy }),
      // A chopped first consonant is audible on every play, so it blocks delivery.
      check('clipFirstWordNotClipped', { applicable: Boolean(b),
        passed: b?.clipFirstWordNotClipped, value: b?.firstWordPreRollMs }),
      // §6 targets roughly 60-150ms of speech pre-roll, but only when the source
      // offers the room: back-to-back word timestamps are not an edit defect.
      check('firstWordPreRollNatural', {
        applicable: Boolean(b) && (b?.firstWordPreRollAvailableMs ?? 0) >= 60,
        severity: 'ENHANCEMENT', passed: (b?.firstWordPreRollMs ?? 0) >= 60,
        value: { preRollMs: b?.firstWordPreRollMs,
          availableMs: b?.firstWordPreRollAvailableMs } }),
      check('weakLeadInRemovedOrJustified', { applicable: Boolean(b), severity: 'ENHANCEMENT',
        passed: b?.weakLeadInRemovedOrJustified, value: b?.removedLeadIn }),
      // §20: the headline's promise has to start being paid off immediately, so
      // the hook and the delivered opening must describe the same first seconds.
      check('hookStartAligned', { applicable: Boolean(b) && hookRequired,
        severity: 'ENHANCEMENT',
        passed: Math.abs(context.plan.onScreenHook.startSec - (b?.editedStart ?? 0)) <= .25,
        value: { hookStartSec: context.plan.onScreenHook.startSec, editedStart: b?.editedStart } }),
      // --- end quality (§29, §31) ---
      // A clip that stops mid-sentence is a serious editorial defect and must
      // not quietly pass; a finished thought that merely lacks punch degrades.
      check('clipEndComplete', { applicable: Boolean(b),
        severity: b?.endingDefectSeverity === 'SERIOUS' ? 'BASELINE' : 'ENHANCEMENT',
        passed: b?.clipEndComplete,
        value: { severity: b?.endingDefectSeverity, reason: b?.endingReason,
          repairAttempted: b?.endRepairAttempted, repairSucceeded: b?.endRepairSucceeded } }),
      check('clipEndNatural', { applicable: Boolean(b),
        severity: b?.endingDefectSeverity === 'SERIOUS' ? 'BASELINE' : 'ENHANCEMENT',
        passed: b?.clipEndNatural }),
      check('clipEndNotContinuation', { applicable: Boolean(b),
        severity: b?.endNotContinuation === false ? 'BASELINE' : 'ENHANCEMENT',
        passed: b?.endNotContinuation, value: b?.endingStrategy }),
      // Reported, never scored: "did this land a payoff" is a lexical guess, and
      // a clip that simply finishes its thought well must not be degraded for it.
      check('clipEndPayoffDelivered', { applicable: Boolean(b), required: false,
        severity: 'ENHANCEMENT', passed: b?.clipEndPayoffDelivered, value: b?.endingScore }),
      check('clipEndNoNewTopicLeak', { applicable: Boolean(b), severity: 'ENHANCEMENT',
        passed: b?.clipEndNoNewTopicLeak, value: b?.newTopicTrimmed }),
      check('deadAirAtEndAcceptable', { applicable: Boolean(b), severity: 'ENHANCEMENT',
        passed: (b?.deadAirAtEndMs ?? 0) <= 400, value: b?.deadAirAtEndMs }),
      // §17: enough tail to avoid a chopped word, not so much that the clip
      // hangs on silence. Measured against the tail this clip actually asked for.
      check('audioTailNatural', { applicable: Boolean(b) && context.hasAudio,
        severity: 'ENHANCEMENT',
        passed: (b?.deadAirAtEndMs ?? 0) >= Math.round((b?.tailSec ?? 0) * 1000 * .5) &&
          (b?.deadAirAtEndMs ?? 0) <= 500, value: b?.deadAirAtEndMs }),
      // §19: the last caption has to finish on screen rather than being cut off
      // with the video.
      check('lastSubtitleComplete', { applicable: subtitleRequired,
        severity: 'ENHANCEMENT', passed: lastSubtitleEndSec == null ||
          lastSubtitleEndSec <= context.timeline.editedDuration + .02,
        value: { lastSubtitleEndSec, editedDuration: round(context.timeline.editedDuration) } }),
      // §18: nothing may still be moving when the last frame lands. The threshold
      // is a reframe still in progress, not the sub-percent drift the stabilizer
      // always carries - that is invisible and failing it would mean nothing.
      check('cameraSettledAtEnd', { applicable: qa && endMotion != null, severity: 'ENHANCEMENT',
        passed: (endMotion ?? 0) <= .01 && (finalScaleVelocity ?? 0) <= .01 && !shotCutAtEnd,
        value: { finalCropVelocity: endMotion, finalScaleVelocity, shotCutAtEnd } }),
      check('zoomSettledAtEnd', { applicable: zoomApplicable, severity: 'ENHANCEMENT',
        passed: result.zoomEvents.every((event) => event.endSec <=
          context.timeline.editedDuration - .15 || event.zoomReturned),
        repair: 'ZOOM_DISABLE' }),
      // A headline has to be a complete thought, not a three-word fragment (§15).
      check('hookWordCountValid', { applicable: hookRequired && Boolean(visual.hookPlaced),
        passed: visual.hookWordCount >= HOOK_LENGTH.min,
        value: { words: visual.hookWordCount, minimum: HOOK_LENGTH.min } }),
      check('hookMetaLanguageFree', { applicable: hookRequired,
        passed: hookMetaLanguageFree(context.plan.onScreenHook.text),
        value: context.plan.onScreenHook.text }),
      check('hookBackgroundRendered', { applicable: hookRequired && Boolean(visual.hookPlaced),
        passed: visual.hookBackgroundRendered === true, repair: 'HOOK_REFIT',
        value: visual.hookPlateBounds }),
      check('hookBackgroundContrastValid', { applicable: hookMeasured &&
        m.hook.hookBackgroundContrastValid != null, severity: 'ENHANCEMENT',
      passed: m.hook.hookBackgroundContrastValid, repair: 'HOOK_CONTRAST',
      value: m.hook.hookContrastRatio }),
      // One accent colour family per headline, never a mix (§22/§23).
      check('hookAccentColorSingleFamily', { applicable: hookRequired &&
        Boolean(visual.hookPlaced) && visual.hookAccentWordCount > 0,
      passed: visual.hookAccentColorSingleFamily === true,
      value: { family: visual.hookAccentFamily, words: visual.hookAccentWords } }),
      check('hookTextPresent', { applicable: hookRequired,
        passed: Boolean(context.plan.onScreenHook.enabled && context.plan.onScreenHook.text.trim()),
        repair: 'HOOK_REFIT', value: context.plan.onScreenHook.text,
        detail: visual.hookSuppressionReason || undefined }),
      check('hookRendered', { applicable: hookRequired, passed: m.hook.hookRendered, repair: 'HOOK_REFIT',
        detail: visual.hookSuppressionReason || undefined }),
      check('hookVisibleAtFrame0', { applicable: hookRequired && qa,
        passed: m.hook.hookVisibleAtFrame0 === true || m.hook.hookVisibleWithin100ms === true,
        repair: 'HOOK_REFIT', value: { frame0: m.hook.hookVisibleAtFrame0,
          within100ms: m.hook.hookVisibleWithin100ms } }),
      check('hookInsideSafeZone', { applicable: hookRequired,
        passed: Boolean(visual.hookPlaced) && m.hook.hookInsideSafeZone !== false,
        repair: 'HOOK_REFIT', value: m.hook.hookMeasuredBounds }),
      check('hookReadable', { applicable: hookMeasured, severity: 'ENHANCEMENT',
        passed: m.hook.hookReadable, repair: 'HOOK_CONTRAST', value: m.hook.hookContrastRatio }),
      check('hookTypographyReadable', { applicable: hookMeasured && m.hook.hookReadable != null,
        severity: 'ENHANCEMENT', passed: m.hook.hookTypographyReadable, repair: 'HOOK_CONTRAST',
        value: { lines: visual.hookLines.length, minLineHeightPx: m.hook.hookLineHeightPx,
          contrast: m.hook.hookContrastRatio } }),
      check('hookPositionStable', { applicable: hookMeasured && m.hook.hookPositionStable != null,
        passed: m.hook.hookPositionStable, repair: 'HOOK_REFIT', value: m.hook.hookPositionDriftPx }),
      check('hookSafe', { applicable: hookMeasured && m.hook.hookSafe != null,
        passed: m.hook.hookSafe, repair: 'HOOK_REFIT', value: m.hook.hookMeasuredBounds }),
      // The caption face the renderer asked for is the one fontconfig resolved:
      // a missing font falls back visibly instead of silently changing the look.
      check('subtitleFontValid', { applicable: subtitleRequired,
        severity: 'ENHANCEMENT', passed: visual.subtitleFontAvailable === true,
        value: { requested: visual.subtitleFontRequested, used: visual.subtitleFontName } }),
      // One baseline per shot and one font size for the whole clip (§28/§33).
      check('subtitlePositionStable', { applicable: subtitleRequired && context.editorial,
        passed: visual.subtitleBaselineCount <= Math.max(1, result.shots.length),
        value: { baselines: visual.subtitleBaselineCount, shots: result.shots.length,
          alternates: visual.subtitleAlternateBaselines } }),
      check('subtitlePhraseSizeValid', { applicable: subtitleRequired, severity: 'ENHANCEMENT',
        passed: visual.subtitleGeometryStable === true &&
          visual.subtitlePhraseCount > 0,
        value: { fontSize: visual.subtitleFontSize, phrases: visual.subtitlePhraseCount } }),
      // The active word changes colour only, so it can never shift the block.
      check('activeWordDoesNotMoveBlock', { applicable: subtitleRequired,
        passed: SUBTITLE_TIMING.activeScale === 100 && SUBTITLE_TIMING.keywordScale === 100 &&
          SUBTITLE_TIMING.keywordActiveScale === 100,
        value: { activeScale: SUBTITLE_TIMING.activeScale } }),
      check('subtitleRendered', { applicable: subtitleRequired && qa,
        passed: (m.subtitle.renderedRatio ?? 0) >= .8, value: m.subtitle.renderedRatio }),
      check('subtitleCoverageValid', { applicable: subtitleRequired,
        passed: visual.subtitleCoverageRatio >= .98, value: round(visual.subtitleCoverageRatio) }),
      check('subtitleInsideSafeArea', { applicable: subtitleRequired && qa && m.subtitle.insideSafeArea != null,
        passed: m.subtitle.insideSafeArea, repair: 'SUBTITLE_REFIT', value: m.subtitle.measuredBounds }),
      check('subtitleSyncValid', { applicable: subtitleRequired,
        // A baseline failure needs a consistent offset; scattered residuals are measurement noise.
        passed: visual.subtitleTimelineErrorWorstMs <= 40 &&
          (m.subtitle.residualOffsetMs == null || Math.abs(m.subtitle.residualOffsetMs) <= 80 ||
            m.subtitle.onsetSamples < 5 || (m.subtitle.residualSpreadMs ?? Infinity) > 60),
        repair: 'SUBTITLE_RETIME', value: { residualOffsetMs: m.subtitle.residualOffsetMs,
          timelineWorstMs: visual.subtitleTimelineErrorWorstMs } }),
      // Tight sync is the point of word-level captions (§30). The number a viewer
      // perceives is the RESIDUAL - the consistent offset of the whole track -
      // and SUBTITLE_RETIME shifts the track by exactly that, so it is held to
      // 50 ms. This metric is the actual mean absolute onset error, so the
      // telemetry and the validator intentionally use the same threshold.
      check('subtitleSyncAverageValid', { applicable: subtitleRequired && m.subtitle.syncMeasurement === 'AUDIO_ONSET',
        severity: 'ENHANCEMENT', passed: m.subtitle.subtitleSyncErrorAverageMs <= 50,
        repair: 'SUBTITLE_RETIME',
        value: { averageMs: m.subtitle.subtitleSyncErrorAverageMs,
          residualMs: m.subtitle.residualOffsetMs } }),
      check('subtitleAnimationVisible', { applicable: subtitleRequired && qa &&
        context.plan.subtitleStyle.highlightCurrentWord && m.subtitle.animationVisibleRatio != null,
      severity: 'ENHANCEMENT', passed: (m.subtitle.animationVisibleRatio ?? 0) >= .75,
      repair: 'SUBTITLE_EMPHASIS_REBUILD', value: m.subtitle.animationVisibleRatio }),
      check('highlightedWordVisible', { applicable: subtitleRequired && qa && m.subtitle.highlightVisibleRatio != null,
        severity: 'ENHANCEMENT', passed: (m.subtitle.highlightVisibleRatio ?? 0) >= .66,
        repair: 'SUBTITLE_EMPHASIS_REBUILD', value: m.subtitle.highlightVisibleRatio }),
      check('subtitleSourceGraphicCollisionSafe', { applicable: collisionMeasured, severity: 'ENHANCEMENT',
        passed: (m.subtitle.sourceGraphicCollisionRatio ?? 0) <= .06 &&
          m.subtitle.sourceGraphicCollisionCount === 0,
        value: { worstAreaRatio: m.subtitle.sourceGraphicCollisionRatio, samples: m.subtitle.sourceGraphicSamples,
          collisionCount: m.subtitle.sourceGraphicCollisionCount,
          adjustedPhrases: visual.subtitlePositionAdjusted } }),
      check('hardCutTransitionClean', { applicable: qa && m.transitions.sampled > 0,
        passed: m.transitions.hardCutTransitionClean, value: m.transitions.checks }),
      check('mainSubjectVisible', { applicable: subject.mainSubjectRequired,
        passed: (subject.subjectSafetyRatio ?? 1) >= .8, repair: 'SUBJECT_REFRAME', value: subject.subjectSafetyRatio }),
      check('subjectSafetyTarget', { applicable: subject.mainSubjectRequired,
        passed: (subject.subjectSafetyRatio ?? 1) >= .95, repair: 'SUBJECT_REFRAME', value: subject.subjectSafetyRatio }),
      check('headroomSafe', { applicable: subject.mainSubjectRequired,
        passed: (subject.headroomSafeRatio ?? 1) >= .95, repair: 'SUBJECT_REFRAME', value: subject.headroomSafeRatio }),
      check('twoPersonPreserved', { applicable: subject.twoPersonApplicable,
        passed: (subject.twoPersonPreservedRatio ?? 1) >= .8, repair: 'SUBJECT_REFRAME',
        value: subject.twoPersonPreservedRatio }),
      check('informationPreserved', { applicable: subject.informationModeApplicable,
        passed: (subject.informationPreservedRatio ?? 1) >= .95, repair: 'INFORMATION_FIT',
        value: subject.informationPreservedRatio }),
      // Preserving the information is the baseline; rendering it large enough to
      // actually read is the goal. Only measurable when a region was detected, and
      // only a degradation - a clip whose graphics genuinely fill the frame has
      // nothing to gain and must not be failed for it.
      check('informationReadable', { applicable: result.shots.some((shot) => shot.informationMode) &&
        result.information.informationRenderedHeightPx != null,
      passed: (result.information.informationRenderedHeightPx ?? 0) >=
        context.layout.videoViewport.height * .5 ||
        (result.information.informationScaleGain ?? 1) >= 1.15,
      repair: 'INFORMATION_FIT', value: { renderedHeightPx: result.information.informationRenderedHeightPx,
        gain: result.information.informationScaleGain,
        coverage: result.information.informationRegionCoverage } }),
      check('zoomVisible', { applicable: zoomApplicable && qa, severity: 'ENHANCEMENT',
        passed: m.zoom.every((item) => item.zoomVisible !== false), repair: 'ZOOM_STRENGTHEN',
        value: m.zoom.map((item) => item.estimatedScale) }),
      // The measured scale change on the finished frame, against the floor for
      // the intensity the move claims to be.
      check('zoomVisibleScaleDeltaValid', { applicable: zoomApplicable && qa &&
        m.zoom.some((item) => item.visibleScaleDelta != null), severity: 'ENHANCEMENT',
      passed: m.zoom.every((item) => item.visibleScaleDeltaValid !== false),
      repair: 'ZOOM_STRENGTHEN',
      value: result.zoomEvents.map((event, index) => ({ intensity: event.intensity,
        required: event.minVisibleScaleDelta, measured: m.zoom[index]?.visibleScaleDelta })) }),
      // Every accepted move is a semantic zoom by construction: reframing and
      // shot changes are produced by the camera planner and never land here, so
      // this counts real emphasis rather than repositioning (§12).
      check('zoomNotJustReframe', { applicable: zoomApplicable,
        passed: result.zoomEvents.every((event) => event.motionKind === 'SEMANTIC_ZOOM'),
        value: { semanticZoom: result.zoomEvents.length,
          cameraReframe: result.camera.reframeAdjustmentCount,
          shotChange: Math.max(0, result.shots.length - 1) } }),
      // A push that starts after its word has been spoken is late, not emphatic.
      check('zoomWordAnchorValid', { applicable: zoomApplicable, severity: 'ENHANCEMENT',
        passed: result.zoomEvents.every((event) =>
          event.zoomTriggeredOnStrongWord && event.zoomStartsBeforeWord),
        value: result.zoomEvents.map((event) => ({ word: event.triggerText,
          startsBeforeWord: event.zoomStartsBeforeWord })) }),
      check('zoomPeakTimingValid', { applicable: zoomApplicable, severity: 'ENHANCEMENT',
        passed: result.zoomEvents.every((event) => event.zoomPeakSynced),
        value: result.zoomEvents.map((event) => event.peakOffsetFromWordMs) }),
      check('faceZoomLockValid', { applicable: zoomApplicable &&
        result.zoomEvents.some((event) => event.trackId != null), severity: 'ENHANCEMENT',
      passed: result.zoomEvents.every((event) => event.faceLockValid), repair: 'SUBJECT_REFRAME',
      value: result.zoomEvents.map((event) => ({ word: event.triggerText,
        trackId: event.trackId, confidence: event.faceConfidence })) }),
      // --- Motion discipline (§20/§3/§21) ---
      // Every move names the beat it serves; motion without one is decoration.
      // Only a clip that can actually carry motion is judged on having it: an
      // information-heavy or wide-shot clip where every shot forbids a push is
      // meant to stay stable (§14), not to be marked down for it.
      check('semanticZoomCountValid', { applicable: context.editorial &&
        context.timeline.editedDuration >= ZOOM_TUNING.twoEventMinDurationSec &&
        result.shots.some((shot) => shot.zoomAllowed),
      severity: 'ENHANCEMENT',
      passed: renderedZoomCoverageValid && result.zoomEvents.length <= ZOOM_TUNING.maxZooms,
      value: { events: renderedZoomCount, required: result.requiredZoomCount,
        durationSec: round(context.timeline.editedDuration),
        rejected: result.zoomRejections.length } }),
      check('zeroZoomSanity', { applicable: context.editorial &&
        result.eligibleEmphasisCount >= 2 && result.shots.some((shot) => shot.zoomAllowed),
      passed: result.zeroZoomReason !== 'ZERO_ZOOM_CAUSED_BY_REPAIR_BUG',
      repair: 'ZOOM_LOCAL_REPAIR', value: { zeroZoomReason: result.zeroZoomReason,
        eligibleSafeZoomCount: result.eligibleSafeZoomCount,
        effectiveRequiredZoomCount: result.effectiveRequiredZoomCount,
        zoomSuppressionReasons: result.zoomSuppressionReasons } }),
      check('zoomCoverageValid', { applicable: context.editorial &&
        result.requiredZoomCount > 0 &&
        !result.shots.some((shot) => shot.informationMode &&
          shot.end - shot.start >= context.timeline.editedDuration * .5),
      severity: 'ENHANCEMENT', passed: renderedZoomCoverageValid,
      value: { eligibleEmphasisCount: result.eligibleEmphasisCount,
        requiredZoomCount: result.requiredZoomCount, semanticZoomCount: renderedZoomCount } }),
      check('zoomSemanticallyJustified', { applicable: zoomApplicable, severity: 'ENHANCEMENT',
        passed: result.zoomEvents.every((event) => Boolean(event.semanticReason.trim())),
        value: result.zoomEvents.map((event) => event.semanticReason) }),
      // The rendered scale must still sit inside the band its intensity claims.
      check('zoomIntensityValid', { applicable: zoomApplicable, severity: 'ENHANCEMENT',
        passed: result.zoomEvents.every((event) => {
          const band = ZOOM_INTENSITY_BANDS[event.intensity];
          return event.peakScale >= band.min - .005 && event.peakScale <= band.max + .005 &&
            event.peakScale <= ZOOM_TUNING.maxScale + 1e-6;
        }),
        value: result.zoomEvents.map((event) => `${event.intensity}:${event.peakScale}`) }),
      check('zoomSubjectSafe', { applicable: zoomApplicable,
        passed: result.zoomEvents.every((event) => event.subjectSafeDuringZoom),
        repair: 'SUBJECT_REFRAME' }),
      check('zoomInformationSafe', { applicable: zoomApplicable,
        passed: result.zoomEvents.every((event) => event.informationSafeDuringZoom),
        repair: 'ZOOM_LOCAL_REPAIR' }),
      // No move may still be travelling on the final frame (§21).
      check('zoomSettledBeforeEnd', { applicable: zoomApplicable,
        passed: result.zoomEvents.every((event) =>
          event.endSec <= context.timeline.editedDuration - .4), repair: 'ZOOM_LOCAL_REPAIR' }),
      // --- Sound design (§15/§16/§8/§14) ---
      check('sfxTimingValid', { applicable: sfxApplicable && qa && m.audio.sfxTimingValid != null,
        severity: 'ENHANCEMENT', passed: m.audio.sfxTimingValid, repair: 'SFX_DISABLE',
        value: m.audio.sfxWorstOffsetMs }),
      check('sfxSpeechSafe', { applicable: sfxApplicable && qa && m.audio.sfxUnderSpeechDb != null,
        severity: 'ENHANCEMENT', passed: m.audio.sfxUnderSpeechDb, repair: 'SFX_QUIET',
        value: m.audio.speechToSfxDb }),
      // Sound design follows motion, so it inherits the motion budget (§8).
      check('sfxNotOverused', { applicable: sfxApplicable, severity: 'ENHANCEMENT',
        passed: result.sfx.sfxCount <= Math.max(1, Math.min(ZOOM_TUNING.maxZooms,
          Math.round(context.timeline.editedDuration * ZOOM_TUNING.eventsPerSec))),
        repair: 'SFX_DISABLE', value: result.sfx.sfxCount }),
      // Each effect is the one its own edit event calls for, never a decoration
      // chosen independently of the cut.
      check('sfxMatchesEvent', { applicable: sfxApplicable, severity: 'ENHANCEMENT',
        passed: result.sfx.sfxEvents.every((item, index) =>
          item.sfxType === result.zoomEvents.filter((event) => event.sfxEnabled)[index]?.sfxType),
        value: result.sfx.sfxEvents.map((item) => `${item.zoomKind}:${item.sfxType}`) }),
      check('sfxRendered', { applicable: sfxApplicable && qa && m.audio.sfxRendered != null,
        severity: 'ENHANCEMENT', passed: m.audio.sfxRendered, value: m.audio.sfxMeanDb }),
      check('zoomTimingValid', { applicable: zoomApplicable, severity: 'ENHANCEMENT',
        passed: result.zoomEvents.every((event) => event.zoomPeakSynced && event.zoomTriggeredOnStrongWord) }),
      check('zoomReturned', { applicable: zoomApplicable, severity: 'ENHANCEMENT',
        passed: result.zoomEvents.every((event) => event.zoomReturned) &&
          m.zoom.every((item) => item.zoomReturnedMeasured !== false) }),
      check('subjectSafeDuringZoom', { applicable: zoomApplicable && subject.subjectSafeDuringZoomRatio != null,
        passed: (subject.subjectSafeDuringZoomRatio ?? 1) >= .95, repair: 'SUBJECT_REFRAME',
        value: subject.subjectSafeDuringZoomRatio }),
      check('informationSafeDuringZoom', { applicable: zoomApplicable,
        passed: result.zoomEvents.every((event) => event.informationSafeDuringZoom), repair: 'ZOOM_LOCAL_REPAIR' }),
      check('backgroundApplied', { applicable: context.editorial && qa,
        passed: m.background.backgroundApplied, repair: 'BACKGROUND_REGENERATE', value: m.background.headerMean }),
      check('backgroundSourceMatched', { applicable: context.editorial && qa, severity: 'ENHANCEMENT',
        passed: m.background.backgroundSourceMatched, value: m.background.colorDistance,
        // The ambient estimate is approximate; only the plain tint modes are regenerated for it.
        ...(result.backgroundMode === 'SOFT_BLUR_EXTENSION' ? {} : { repair: 'BACKGROUND_REGENERATE' as const }) }),
      check('backgroundNotGenericBlack', { applicable: context.editorial && qa, severity: 'ENHANCEMENT',
        passed: m.background.backgroundNotGenericBlack, repair: 'BACKGROUND_REGENERATE',
        value: m.background.headerMean }),
      check('backgroundTransitionSmooth', { applicable: context.editorial && qa &&
        m.background.backgroundTransitionSmooth != null, severity: 'ENHANCEMENT',
        passed: m.background.backgroundTransitionSmooth, repair: 'BACKGROUND_SMOOTH',
        value: m.background.transitions }),
      check('gradingApplied', { applicable: qa && m.grading.gradingApplied != null, severity: 'ENHANCEMENT',
        passed: m.grading.gradingApplied, value: m.grading.delta }),
      // Same measurement as gradingApplied, named for the editorial decision it
      // confirms (NO_CHANGE staying a no-op, or a chosen preset being visible).
      check('gradingDecisionValid', { applicable: qa && m.grading.gradingApplied != null,
        severity: 'ENHANCEMENT', passed: m.grading.gradingApplied, value: result.grading.gradingDecision }),
      check('exposureNatural', { applicable: qa && m.grading.exposureNatural != null,
        severity: 'ENHANCEMENT', passed: m.grading.exposureNatural, repair: 'GRADE_SAFETY' }),
      check('highlightSafe', { applicable: qa && m.grading.highlightSafe != null,
        severity: 'ENHANCEMENT', passed: m.grading.highlightSafe, repair: 'GRADE_SAFETY' }),
      check('shadowSafe', { applicable: qa && m.grading.shadowSafe != null,
        severity: 'ENHANCEMENT', passed: m.grading.shadowSafe, repair: 'GRADE_SAFETY' }),
      check('saturationNatural', { applicable: qa && m.grading.saturationNatural != null,
        severity: 'ENHANCEMENT', passed: m.grading.saturationNatural, repair: 'GRADE_SAFETY' }),
      check('whiteBalanceNatural', { applicable: qa && m.grading.whiteBalanceNatural != null,
        severity: 'ENHANCEMENT', passed: m.grading.whiteBalanceNatural, repair: 'GRADE_SAFETY' }),
      check('gradingNotOverprocessed', { applicable: qa && m.grading.notOverprocessed != null,
        severity: 'ENHANCEMENT', passed: m.grading.notOverprocessed, repair: 'GRADE_SAFETY' }),
      // Required music that cannot be rendered after the repair ladder degrades the
      // edit (never a silent "fully edited" clip); masking speech still fails it.
      check('musicRendered', { applicable: context.musicApplicable && qa && musicOn,
        severity: 'ENHANCEMENT', passed: m.audio.musicRendered, repair: 'MUSIC_RETRY' }),
      check('musicPresentWhenRequired', { applicable: context.musicRequired, severity: 'ENHANCEMENT',
        passed: musicOn, repair: 'MUSIC_RETRY', detail: result.music.musicSkippedReason || undefined }),
      check('musicMoodSelected', { applicable: context.musicRequired || musicOn, severity: 'ENHANCEMENT',
        passed: result.music.musicMood !== 'NONE' && musicOn &&
          result.music.trackMoods.includes(result.music.musicMood),
        value: { mood: result.music.musicMood, requested: result.music.musicMoodRequested,
          track: result.music.trackId } }),
      check('speechDominant', { applicable: context.hasAudio && musicOn && qa,
        passed: m.audio.speechDominant, repair: 'MUSIC_RETRY', value: m.audio.speechToMusicDb }),
      check('musicFadeInValid', { applicable: musicOn && qa && m.audio.musicFadeInValid != null,
        severity: 'ENHANCEMENT', passed: m.audio.musicFadeInValid, value: m.audio.musicFadeInDb }),
      check('musicFadeOutValid', { applicable: musicOn && qa && m.audio.musicFadeOutValid != null,
        severity: 'ENHANCEMENT', passed: m.audio.musicFadeOutValid, value: m.audio.musicFadeOutDb }),
      check('musicVarietyValid', { applicable: musicOn, severity: 'ENHANCEMENT',
        passed: result.music.musicReusePenalty !== true, value: result.music.musicSelectionReason }),
      // Composite of the measured style checks above (no separate metric).
      check('finalVisualCohesionPass', { applicable: context.editorial && qa, severity: 'ENHANCEMENT',
        passed: cohesionParts.every((part) => part === true) }),
      check('loopValid', { applicable: context.loop.loopApplied, severity: 'ENHANCEMENT',
        passed: (context.loop.loopVisualSimilarity ?? 0) >= .9 }),
      // --- Hook placement (deterministic layout, measured against the preset) ---
      check('hookPositionValid', { applicable: hookRequired && context.editorial,
        passed: visual.hookPositionValid === true, repair: 'HOOK_REFIT', value: visual.hookBounds }),
      check('hookNotTooHigh', { applicable: hookRequired && context.editorial,
        passed: visual.hookNotTooHigh === true, repair: 'HOOK_REFIT', value: visual.hookBounds?.y }),
      check('hookGapAboveVideoValid', { applicable: hookRequired && context.editorial,
        passed: visual.hookGapAboveVideoValid === true, repair: 'HOOK_REFIT',
        value: visual.hookGapAboveVideoPx }),
      // A controlled number of accent words, scaled to the headline's length:
      // one or two on a short line, up to four on a long one, never the whole
      // headline and never a multicolour word salad.
      check('hookAccentWordsValid', { applicable: hookRequired && Boolean(visual.hookPlaced) &&
        visual.hookWordCount >= 2, severity: 'ENHANCEMENT',
      passed: visual.hookAccentWordCount >= 1 &&
        visual.hookAccentWordCount <= hookAccentBudget(visual.hookWordCount) &&
        visual.hookAccentWordCount < visual.hookWordCount,
      value: { words: visual.hookAccentWords, budget: hookAccentBudget(visual.hookWordCount) } }),
      // Emphasis spread across the line, not clustered into one bright blob.
      check('hookAccentDistributionValid', { applicable: hookRequired &&
        Boolean(visual.hookPlaced) && visual.hookAccentWordCount > 1, severity: 'ENHANCEMENT',
      passed: visual.hookAccentDistributionValid === true,
      value: visual.hookAccentIndexes }),
      // Up to three lines; more than that is not a headline any more.
      check('hookLineCountValid', { applicable: hookRequired && Boolean(visual.hookPlaced),
        severity: 'ENHANCEMENT',
        passed: visual.hookLineCount >= 1 && visual.hookLineCount <= HOOK_TYPE.maxLines,
        value: visual.hookLineCount }),
      // A long headline must have been fitted by using the header space and the
      // long-hook size floor - not by cutting the wording that made it strong.
      check('hookLongTextFitValid', { applicable: hookRequired && Boolean(visual.hookPlaced) &&
        visual.hookWordCount >= HOOK_TYPE.longWords, severity: 'ENHANCEMENT',
      passed: visual.hookShortenLevel === 0 && visual.hookFontSize >= HOOK_TYPE.longMinFont,
      value: { shortenLevel: visual.hookShortenLevel, fontSize: visual.hookFontSize,
        lines: visual.hookLineCount } }),
      // A readable size at any length: below the long-hook floor the headline
      // stops being a headline.
      check('hookFontReadable', { applicable: hookRequired && Boolean(visual.hookPlaced),
        severity: 'ENHANCEMENT', passed: visual.hookFontSize >= HOOK_TYPE.longMinFont,
        value: visual.hookFontSize }),
      // --- Music: the editorial decision, its execution and its balance ---
      check('musicDecisionValid', { applicable: context.hasAudio, severity: 'ENHANCEMENT',
        passed: result.music.musicDecision === 'NO_MUSIC' ? !musicOn :
          musicOn || result.music.musicSkippedReason !== '',
        value: { decision: result.music.musicDecision, mood: result.music.musicMood,
          skipped: result.music.musicSkippedReason } }),
      check('musicQualityAcceptable', { applicable: musicOn && qa, severity: 'ENHANCEMENT',
        passed: m.audio.musicRendered === true && result.music.trackMoods.length > 0 &&
          m.audio.musicFadeInValid !== false && m.audio.musicFadeOutValid !== false,
        repair: 'MUSIC_RETRY',
        value: { track: result.music.trackId, gainDb: result.music.gainDb } }),
      // Audible enough to support the clip, never close to competing with speech.
      check('musicSpeechBalanceValid', { applicable: musicOn && qa && m.audio.speechToMusicDb != null,
        severity: 'ENHANCEMENT', passed: (m.audio.speechToMusicDb ?? 0) >= 10,
        repair: 'MUSIC_RETRY', value: m.audio.speechToMusicDb }),
      // --- Grading: natural, not filtered (composite of the measured guards) ---
      check('gradingLooksNatural', { applicable: qa && m.grading.notOverprocessed != null,
        severity: 'ENHANCEMENT', passed: [m.grading.exposureNatural, m.grading.highlightSafe,
          m.grading.shadowSafe, m.grading.saturationNatural, m.grading.whiteBalanceNatural,
          m.grading.notOverprocessed].every((part) => part !== false),
        repair: 'GRADE_SAFETY', value: m.grading.delta }),
      // --- Camera: subject changes must cut or settle, never drift ---
      check('shotSwitchMotionSmooth', { applicable: result.camera.shotSwitchMotionSmooth != null,
        severity: 'ENHANCEMENT', passed: result.camera.shotSwitchMotionSmooth,
        value: { longestMoveSec: result.camera.longestSwitchMoveSec,
          longPans: result.camera.longPanCount } }),
      check('speakerSwitchSmooth', { applicable: result.camera.speakerSwitchCount > 0,
        severity: 'ENHANCEMENT', passed: result.camera.speakerSwitchSmooth !== false,
        value: result.camera.longestSwitchMoveSec }),
      check('cameraNoLongPan', { applicable: result.camera.cameraMoves.length > 0,
        severity: 'ENHANCEMENT', passed: result.camera.cameraNoLongPan,
        value: result.camera.longPanCount }),
      check('cameraTargetStable', { applicable: result.camera.speakerTrackCount > 0,
        severity: 'ENHANCEMENT', passed: result.camera.cameraTargetStable,
        value: result.camera.keyCount }),
      check('shotCutResetsCamera', { applicable: result.shots.length > 1,
        severity: 'ENHANCEMENT', passed: result.camera.shotCutResetsCamera,
        value: result.camera.shotChangeReframeCount }),
      check('informationTransitionClean', { applicable: result.shots.some((shot, index) =>
        index > 0 && shot.informationMode !== result.shots[index - 1].informationMode),
      severity: 'ENHANCEMENT', passed: result.camera.cameraNoLongPan &&
        result.camera.shotCutResetsCamera }),
      // --- Thumbnail: a real cover, carrying the clip's own headline ---
      // The cover the viewer sees before pressing play must exist for an edited
      // clip, so it is baseline there and an enhancement elsewhere.
      check('thumbnailGenerated', { applicable: qa,
        severity: hookRequired ? 'BASELINE' : 'ENHANCEMENT',
        passed: m.thumbnail.thumbnailGenerated, repair: 'HOOK_REFIT',
        value: result.thumbnail.reason }),
      // Deterministic: the hook-only overlay was written and burned into the
      // cover, so the cover carries the same wording, breaks and accent colours.
      check('thumbnailMatchesHookText', { applicable: qa && hookRequired,
        severity: 'BASELINE', passed: visual.hookOnlyRendered === true,
        repair: 'HOOK_REFIT', value: visual.hookText }),
      // Pixel agreement between the cover's glyphs and the clip's hook probe is a
      // correlation measurement, so it degrades rather than blocks delivery.
      check('thumbnailContainsHook', { applicable: qa && hookRequired && Boolean(visual.hookPlaced),
        severity: 'ENHANCEMENT', passed: m.thumbnail.thumbnailContainsHook,
        value: m.thumbnail.thumbnailHookCoverage }),
      check('thumbnailReadable', { applicable: qa && m.thumbnail.thumbnailReadable != null,
        severity: 'ENHANCEMENT', passed: m.thumbnail.thumbnailReadable,
        value: m.thumbnail.thumbnailHookContrastRatio })
    ];
  }
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function dilate(mask: { pixels: number[]; bounds: Rect | null }, width: number, radius: number) {
  const set = new Set<number>();
  for (const pixel of mask.pixels) {
    const x = pixel % width, y = Math.floor(pixel / width);
    for (let dy = -radius; dy <= radius; dy += 2)
      for (let dx = -radius; dx <= radius; dx += 2)
        if (x + dx >= 0 && x + dx < width && y + dy >= 0) set.add((y + dy) * width + x + dx);
  }
  return { pixels: [...set], bounds: mask.bounds };
}
// Heights (px) of the text lines in a glyph mask: runs of rows that contain glyph pixels.
function textLineBands(mask: { pixels: number[] }, width: number) {
  const rows = [...new Set(mask.pixels.map((pixel) => Math.floor(pixel / width)))].sort((a, b) => a - b);
  const bands: number[] = [];
  let start = rows[0], previous = rows[0];
  for (const row of rows.slice(1)) {
    if (row - previous > 2) { bands.push(previous - start + 1); start = row; }
    previous = row;
  }
  if (rows.length) bands.push(previous - start + 1);
  // Ignore specks (accents, punctuation) that form their own tiny band.
  const tallest = Math.max(0, ...bands);
  return bands.filter((band) => band >= tallest * .35);
}
function cropFrame(frame: Frame, region: Rect, outWidth?: number, outHeight?: number): Frame {
  const width = outWidth ?? region.width, height = outHeight ?? region.height;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.width - 1, Math.floor(region.x + (x + .5) * region.width / width));
      const sy = Math.min(frame.height - 1, Math.floor(region.y + (y + .5) * region.height / height));
      frame.data.copy(data, (y * width + x) * 3, (sy * frame.width + sx) * 3, (sy * frame.width + sx) * 3 + 3);
    }
  }
  return { width, height, data };
}
// Lag (in hops) of envelope `b` relative to `a`, by normalized cross-correlation.
export function envelopeLag(a: Float32Array, b: Float32Array, maxLag: number) {
  const prepare = (values: Float32Array) => {
    const out = Float32Array.from(values, (value) => Math.max(0, value + 60));
    const mean = out.reduce((sum, value) => sum + value, 0) / Math.max(1, out.length);
    return out.map((value) => value - mean);
  };
  const x = prepare(a), y = prepare(b);
  let best = 0, bestScore = -Infinity;
  const length = Math.min(x.length, y.length);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = Math.max(0, -lag); i < Math.min(length, length - lag); i++) score += x[i] * y[i + lag];
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  return best;
}
// Pause before a word on the final timeline (cuts can shorten source pauses).
function gapBefore(words: TimedWord[], event: { sourceStart: number },
  mapper: ReturnType<typeof createTimelineMapper>) {
  const index = words.findIndex((word) => Math.abs(word.start - event.sourceStart) < 1e-6);
  if (index < 0) return 0;
  if (index === 0) return 1;
  const previous = words[index - 1];
  if (mapper.removed(previous.end - .001, previous.end)) return words[index].start - previous.end;
  return mapper.point(words[index].start) - mapper.point(previous.end);
}
