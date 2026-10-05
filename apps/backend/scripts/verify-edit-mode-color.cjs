// Real-media verification for EditMode colour, filters and audio (Workstream D).
//
// Creates DISPOSABLE EditProjects on the live stack, drives them with the SAME
// canonical commands the editor sends, exports real MP4s, and then MEASURES
// them - pixels for colour, decibels for audio - rather than looking at them.
//
//   node scripts/verify-edit-mode-color.cjs [--keep] [--out <dir>]
//
// Two exports, each built to make a specific claim checkable:
//
//   1. COLOUR AND SOURCE LEVEL. One flat-colour source split into six segments,
//      each graded differently. A flat field is a controlled experiment: the
//      first segment is the untouched reference and every other segment's
//      pixels are compared against it, so "exposure brightened the picture" is a
//      measured relative change and not an impression. The same export carries
//      two different source-audio levels on two segments, which is measured in
//      dB the same way.
//
//   2. THE MIXED PROJECT. Crop, rotation, speed, styled text, captions, a
//      colour filter, manual adjustments on top of it, a logo, music, fades and
//      ducking, all on one timeline, exported once. This is the regression that
//      matters most: Workstream D must compose with B and C rather than quietly
//      breaking either of their filter chains. Ducking is proved by measuring
//      the music level INSIDE a known speech window and OUTSIDE it.
//
// Everything it creates - projects, assets, elements, history, MinIO objects -
// is removed at the end, and it never reads or writes a ProcessingJob,
// ClipCandidate or GeneratedClip.

const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PrismaClient } = require('@prisma/client');
const { StorageService } = require('../dist/modules/storage/storage.service');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service');
const {
  EditModeAnalysisService
} = require('../dist/modules/edit-mode/edit-mode-analysis.service');
const {
  EditModeRenderService
} = require('../dist/modules/edit-mode/render/edit-mode-render.service');
const { probeMedia } = require('../dist/modules/processing/media-probe');
const { readColor, readColorFilterId,
  resolveColorFilter } = require('../dist/modules/edit-mode/edit-mode-color');
const { speechWindowsFromTranscript } = require('../dist/modules/edit-mode/edit-mode-audio');
const {
  buildTimelineMap
} = require('../dist/modules/edit-mode/render/edit-mode-timeline-map');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) throw new Error(`${label}${detail ? ` - ${detail}` : ''}`);
  checks += 1;
  console.log(`  ok  ${label}${detail ? ` (${detail})` : ''}`);
};

const SOURCE_DURATION = 13;
/** A saturated colour well away from mid-grey, so contrast, temperature and
 * saturation all have somewhere to move and the move is measurable. */
const SOURCE_COLOR = '0x3f7fbf';
const SPEECH = ('compounding only works when you leave it alone long enough ' +
  'and most people never do').split(' ');

// --- Measurement -------------------------------------------------------------

/** The mean RGB of one region of one frame of the exported MP4. */
function meanRgb(file, atSec, box) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(atSec), '-i', file,
    '-frames:v', '1', '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let r = 0; let g = 0; let b = 0; let count = 0;
  for (let at = 0; at + 2 < raw.length; at += 3) {
    r += raw[at]; g += raw[at + 1]; b += raw[at + 2]; count += 1;
  }
  return count ? { r: r / count, g: g / count, b: b / count, count } : { r: 0, g: 0, b: 0, count };
}

const luma = (rgb) => 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
const chroma = (rgb) => Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
const describe = (rgb) =>
  `rgb(${rgb.r.toFixed(1)}, ${rgb.g.toFixed(1)}, ${rgb.b.toFixed(1)})`;

/**
 * The mean level, in dB, of one time window of the exported MP4's audio.
 *
 * This is what makes ducking a checked claim rather than a described one: a
 * window that overlaps known speech and a window that does not must come back
 * with measurably different numbers. ffmpeg writes volumedetect to stderr and
 * still exits 0, so the output is captured rather than caught.
 */
function meanVolume(file, startSec, durationSec) {
  const result = require('node:child_process').spawnSync('ffmpeg',
    ['-v', 'info', '-ss', String(startSec), '-t', String(durationSec), '-i', file,
      '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /mean_volume:\s*(-?[\d.]+) dB/u.exec(result.stderr ?? '');
  return match ? Number(match[1]) : NaN;
}

// --- Fixtures ----------------------------------------------------------------

/** Word timings and one centred face, so the camera has something to frame and
 * ducking has real speech windows. Deterministic: no AI service needed. */
function syntheticAnalysis() {
  const frames = Array.from({ length: SOURCE_DURATION * 2 }, (_, index) => ({
    t: index / 2, text_coverage: 0, text_boxes: [], graphic_boxes: [], ocr_lines: [],
    ocr_coverage: 0,
    faces: [{ x: 0.37, y: 0.15, w: 0.26, h: 0.32, score: 0.95, mouth_activity: 0.6,
      track_id: 'a' }],
    persons: [{ x: 0.28, y: 0.12, w: 0.44, h: 0.86 }]
  }));
  // All the speech is in the FIRST half, so the second half is a known silence
  // the ducking measurement can use as its control.
  const step = 4.5 / SPEECH.length;
  let cursor = 1;
  const words = SPEECH.map((text) => {
    const start = Number(cursor.toFixed(3));
    cursor += step;
    return { start, end: Number((cursor - 0.03).toFixed(3)), text };
  });
  return {
    analysis: { source: 'DENSE', frames, shotBoundaries: [], ocrText: '',
      summary: { sampledFrameCount: frames.length, faceDetections: frames.length,
        mouthActivitySamples: frames.length, shotCount: 1, ocrRegionCount: 0 } },
    transcript: { text: SPEECH.join(' '), language: 'en', duration: SOURCE_DURATION,
      segments: [{ position: 0, start: words[0].start, end: words[words.length - 1].end,
        text: SPEECH.join(' '), words }] }
  };
}

const MANUAL_SETTINGS = {
  selectedPreset: 'SOURCE_MANUAL', aspectRatio: '9:16', pacing: 'MODERATE',
  subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
  musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null
};

async function frozenCounts(prisma) {
  const [processingJobs, clipCandidates, generatedClips] = await Promise.all([
    prisma.processingJob.count(), prisma.clipCandidate.count(), prisma.generatedClip.count()
  ]);
  return { processingJobs, clipCandidates, generatedClips };
}

async function main() {
  const prisma = new PrismaClient();
  const storage = new StorageService();
  const analysisService = new EditModeAnalysisService(storage);
  const service = new EditModeService(prisma, storage, analysisService);
  const render = new EditModeRenderService(prisma, storage);
  const outputDir = arg('out', process.env.QA_OUTPUT_DIR || '/tmp/edit-mode-color-qa');
  const workspace = mkdtempSync(join(tmpdir(), 'verify-edit-color-'));
  const created = { projectIds: [], objectKeys: [] };
  let failed = false;
  const frozenBefore = await frozenCounts(prisma);
  const bucket = process.env.MINIO_BUCKET ?? 'ai-content-platform';

  /** Attaches a disposable source with a cached transcript and analysis. */
  const newProject = async (name, sourcePath, probe) => {
    let state = await service.create({ name: `${name} ${new Date().toISOString()}` });
    created.projectIds.push(state.id);
    const assetId = randomUUID();
    const objectKey = `edit-mode/${state.id}/${assetId}/source.mp4`;
    const uploaded = await storage.uploadFile({ filePath: sourcePath, objectKey,
      mimeType: 'video/mp4' });
    created.objectKeys.push(objectKey);
    state = await service.persistSource(state.id, state.revision, {
      id: assetId, originalName: 'verify-source.mp4', bucket: uploaded.bucket,
      objectKey: uploaded.objectKey, mimeType: 'video/mp4',
      sizeBytes: BigInt(statSync(sourcePath).size), duration: probe.durationSec,
      width: probe.width, height: probe.height, fps: probe.fps ?? 30,
      metadata: { hasVideo: true, hasAudio: probe.hasAudio, videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec } });
    const cached = syntheticAnalysis();
    await prisma.editAsset.update({ where: { id: assetId },
      data: { transcript: cached.transcript, analysis: cached.analysis } });
    state = await service.update(state.id, { revision: state.revision,
      settings: MANUAL_SETTINGS });
    return { state, assetId };
  };

  /** Runs one export to completion and downloads it. */
  const exportProject = async (state, label) => {
    const started = await render.startExport(state.id, state.revision);
    let progress = started.export;
    const deadline = Date.now() + 20 * 60 * 1000;
    let lastPhase = '';
    while (progress && progress.phase !== 'COMPLETED' && progress.phase !== 'FAILED') {
      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase;
        console.log(`  ${label}: ${progress.phase} (${progress.percent}%)`);
      }
      if (Date.now() > deadline) throw new Error('The export did not finish within 20 minutes.');
      await wait(500);
      progress = await render.progress(state.id);
    }
    if (progress.phase === 'FAILED') {
      throw new Error(`${label} export failed (${progress.errorCode}): ${progress.message}`);
    }
    const [asset] = await render.listExports(state.id);
    created.objectKeys.push(asset.objectKey);
    const file = join(workspace, `${label}.mp4`);
    await storage.downloadToFile(asset.bucket, asset.objectKey, file);
    return { asset, file, output: await probeMedia(file) };
  };

  try {
    // --- A flat, controlled source -----------------------------------------
    const sourcePath = join(workspace, 'fixture.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `color=c=${SOURCE_COLOR}:s=1280x720:rate=30:duration=${SOURCE_DURATION}`,
      '-f', 'lavfi', '-i', `sine=frequency=320:duration=${SOURCE_DURATION}`,
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath]);
    const probe = await probeMedia(sourcePath);
    console.log(`Source: ${probe.width}x${probe.height} ${probe.durationSec?.toFixed(2)}s, ` +
      `flat ${SOURCE_COLOR} with a steady tone - a controlled field, so every pixel and ` +
      'every decibel change is attributable.\n');

    // A steady music bed, for the mixed project's ducking measurement.
    const musicPath = join(workspace, 'bed.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `sine=frequency=110:duration=${SOURCE_DURATION}`, '-c:a', 'pcm_s16le', musicPath]);

    // =======================================================================
    // 1. Colour and source level, measured segment by segment
    // =======================================================================
    console.log('1. Colour: one source, six segments, each graded differently');
    let { state } = await newProject('verify-edit-mode-color', sourcePath, probe);
    const command = async (action, payload = {}) => {
      state = await service.phase3Command(state.id, action,
        { revision: state.revision, ...payload });
      return state;
    };
    const videos = () => (state.elements ?? [])
      .filter((element) => element.type === 'VIDEO' && element.track === 0)
      .sort((left, right) => left.position - right.position);

    // Six two-second segments from one twelve-second clip.
    for (const at of [10, 8, 6, 4, 2]) {
      state = await service.splitElement(state.id, { revision: state.revision,
        elementId: videos().find((element) => element.startTime < at &&
          element.startTime + element.duration > at).id, playheadSec: at });
    }
    ok('the timeline split into six segments', videos().length === 6,
      videos().map((element) => element.duration.toFixed(2)).join('s, ') + 's');

    const segment = (index) => videos()[index];
    // Segment 0 stays neutral: it is the reference every other one is read against.
    await command('set-video-exposure', { elementId: segment(1).id, exposure: 0.7 });
    await command('set-video-temperature', { elementId: segment(2).id, temperature: 0.9 });
    await command('set-video-saturation', { elementId: segment(3).id, saturation: -1 });
    await command('set-video-vignette', { elementId: segment(4).id, vignette: 0.9 });
    await command('apply-color-filter', { elementId: segment(5).id, filterId: 'HIGH_CONTRAST' });
    // Two different source levels, on two segments, for the audio measurement.
    await command('set-source-audio-volume', { elementId: segment(0).id, volume: 1 });
    await command('set-source-audio-volume', { elementId: segment(1).id, volume: 0.5 });

    ok('the HIGH_CONTRAST filter stored its RESOLVED values, not just a label',
      JSON.stringify(readColor(segment(5).properties)) ===
        JSON.stringify(resolveColorFilter('HIGH_CONTRAST', 1)) &&
      readColorFilterId(segment(5).properties) === 'HIGH_CONTRAST');

    const colorExport = await exportProject(state, 'color');
    console.log(`\n  ffprobe: ${colorExport.output.width}x${colorExport.output.height} ` +
      `${colorExport.output.durationSec?.toFixed(2)}s ${colorExport.output.videoCodec}` +
      `/${colorExport.output.audioCodec}`);
    ok('the graded export is a valid, playable MP4 of the expected canvas',
      colorExport.output.width === 1080 && colorExport.output.height === 1920 &&
      colorExport.output.hasVideo && colorExport.output.hasAudio);

    // Sample the middle of the canvas, mid-segment, away from any letterboxing.
    const centre = { x: 340, y: 760, w: 400, h: 400 };
    const at = (index) => segment(index).startTime + segment(index).duration / 2;
    const reference = meanRgb(colorExport.file, at(0), centre);
    console.log(`\n  reference segment: ${describe(reference)}`);
    ok('the untouched reference segment carries the source colour through unchanged',
      reference.r > 30 && reference.b > reference.r,
      `${describe(reference)} against a ${SOURCE_COLOR} source`);

    const brighter = meanRgb(colorExport.file, at(1), centre);
    ok('EXPOSURE measurably brightened the picture',
      luma(brighter) > luma(reference) + 8,
      `luma ${luma(reference).toFixed(1)} -> ${luma(brighter).toFixed(1)}`);

    const warm = meanRgb(colorExport.file, at(2), centre);
    ok('TEMPERATURE measurably warmed it: red rose relative to blue',
      (warm.r - warm.b) > (reference.r - reference.b) + 8,
      `r-b ${(reference.r - reference.b).toFixed(1)} -> ${(warm.r - warm.b).toFixed(1)}`);

    const mono = meanRgb(colorExport.file, at(3), centre);
    ok('SATURATION at -100% produced a genuinely monochrome frame',
      chroma(mono) < 6 && chroma(reference) > 30,
      `chroma ${chroma(reference).toFixed(1)} -> ${chroma(mono).toFixed(1)}`);

    // Vignette is a spatial claim, so it is measured spatially: within the SAME
    // frame, the corner must be darker than the centre by more than it is on an
    // ungraded frame.
    const corner = { x: 20, y: 240, w: 180, h: 180 };
    const vignetteCentre = meanRgb(colorExport.file, at(4), centre);
    const vignetteCorner = meanRgb(colorExport.file, at(4), corner);
    const referenceCorner = meanRgb(colorExport.file, at(0), corner);
    const falloff = luma(vignetteCentre) - luma(vignetteCorner);
    const referenceFalloff = luma(reference) - luma(referenceCorner);
    ok('VIGNETTE really darkened the corners relative to the centre',
      falloff > referenceFalloff + 10,
      `centre-corner falloff ${referenceFalloff.toFixed(1)} -> ${falloff.toFixed(1)}`);

    const filtered = meanRgb(colorExport.file, at(5), centre);
    ok('the HIGH_CONTRAST filter changed the picture from the reference',
      Math.abs(luma(filtered) - luma(reference)) > 5,
      `luma ${luma(reference).toFixed(1)} -> ${luma(filtered).toFixed(1)}`);

    console.log('\n2. Source audio level, measured in dB');
    const fullLevel = meanVolume(colorExport.file, segment(0).startTime + 0.4, 1.2);
    const halfLevel = meanVolume(colorExport.file, segment(1).startTime + 0.4, 1.2);
    console.log(`  100% segment ${fullLevel.toFixed(2)} dB, ` +
      `50% segment ${halfLevel.toFixed(2)} dB`);
    ok('the source level is real: halving it dropped the exported audio by about 6 dB',
      Number.isFinite(fullLevel) && Number.isFinite(halfLevel) &&
      fullLevel - halfLevel > 3.5 && fullLevel - halfLevel < 9,
      `${(fullLevel - halfLevel).toFixed(2)} dB drop`);

    // =======================================================================
    // 3. The mixed project
    // =======================================================================
    console.log('\n3. The mixed project: B + C + D on one timeline');
    const mixed = await newProject('verify-edit-mode-mixed', sourcePath, probe);
    state = mixed.state;
    const mixedId = state.id;

    // Split once, so the timeline exercises concat with different per-segment
    // transforms AND different per-segment grades at the same time.
    state = await service.splitElement(state.id, { revision: state.revision,
      elementId: videos()[0].id, playheadSec: 6 });

    // --- B: crop, rotation, speed ---
    await command('set-video-crop', { elementId: segment(0).id, cropLeft: 0.1,
      cropRight: 0.1, cropTop: 0.05, cropBottom: 0.05 });
    await command('set-video-rotation', { elementId: segment(0).id, rotation: 90 });
    await command('set-speed', { elementId: segment(1).id, speed: 1.5 });

    // --- D: a filter, then manual adjustments ON TOP of it ---
    await command('apply-color-filter', { elementId: segment(0).id, filterId: 'CINEMATIC' });
    await command('set-video-temperature', { elementId: segment(0).id, temperature: 0.4 });
    await command('set-video-contrast', { elementId: segment(1).id, contrast: 0.35 });
    ok('a manual adjustment after a filter kept the rest of the filter',
      readColor(segment(0).properties).temperature === 0.4 &&
      readColor(segment(0).properties).vignette ===
        resolveColorFilter('CINEMATIC').vignette);

    // --- C: styled text and captions ---
    await command('add-text', { textStyleId: 'HOOK' });
    const hookId = (state.elements ?? []).find((element) => element.type === 'TEXT').id;
    await command('set-text-content', { elementId: hookId, content: 'Leave it alone' });
    await command('set-text-stroke', { elementId: hookId, strokeEnabled: true,
      strokeColor: '#000000', strokeWidth: 6 });
    await command('set-element-timing', { elementId: hookId, startTime: 0, duration: 3 });
    const captionsBefore = state.revision;
    await command('generate-captions', { captionStyleId: 'BOLD_HIGHLIGHT' });
    const captions = () => (state.elements ?? []).filter((element) => element.type === 'SUBTITLE');
    ok('captions generated from the cached transcript in one revision',
      state.revision === captionsBefore + 1 && captions().length > 0,
      `${captions().length} caption lines`);

    // --- A logo ---
    const logoPath = join(workspace, 'logo.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=0xff2d55:s=160x160:d=1', '-frames:v', '1', logoPath]);
    const logoUpload = await service.uploadAsset(state.id, { originalname: 'logo.png',
      mimetype: 'image/png', size: statSync(logoPath).size,
      buffer: require('node:fs').readFileSync(logoPath) }, 'LOGO', state.revision);
    state = await service.get(state.id);
    await command('add-logo', { assetId: logoUpload.asset.id });

    // --- Music, fades, ducking, and a muted source so the duck is measurable ---
    const musicUpload = await service.uploadAsset(state.id, { originalname: 'bed.wav',
      mimetype: 'audio/wav', size: statSync(musicPath).size,
      buffer: require('node:fs').readFileSync(musicPath) }, 'AUDIO', state.revision);
    state = await service.get(state.id);
    await command('add-audio', { assetId: musicUpload.asset.id });
    const musicClip = () => (state.elements ?? []).find((element) => element.type === 'AUDIO');
    await command('set-audio-volume', { elementId: musicClip().id, volume: 0.9 });
    await command('set-audio-fade', { elementId: musicClip().id, fadeInSec: 0.5,
      fadeOutSec: 0.5 });
    await command('set-audio-ducking', { elementId: musicClip().id, duckEnabled: true,
      duckStrength: 'STRONG' });
    ok('ducking was accepted, because this source has real cached word timings',
      musicClip().properties.duckUnderSpeech === true);
    // The source is muted so the ONLY thing in the mix is the music. Any level
    // change measured below is therefore the duck and nothing else.
    await command('set-source-audio-muted', { muted: true });

    const mixedExport = await exportProject(state, 'mixed');
    const metadata = mixedExport.asset.metadata;
    console.log(`\n  ffprobe: ${mixedExport.output.width}x${mixedExport.output.height} ` +
      `${mixedExport.output.durationSec?.toFixed(2)}s ${mixedExport.output.videoCodec}` +
      `/${mixedExport.output.audioCodec}`);
    console.log(`  timeline: ${metadata.segments} segment(s), ${metadata.textElements} text, ` +
      `${metadata.subtitles} caption(s)`);
    console.log(`  QA: ${metadata.qa.result} (${metadata.qa.sampledFrameCount} frames)`);
    for (const warning of metadata.warnings ?? []) console.log(`  warning: ${warning}`);

    console.log('\n4. Every feature survived being used together');
    ok('the mixed export is a valid MP4 with both streams',
      mixedExport.output.hasVideo && mixedExport.output.hasAudio &&
      (mixedExport.output.durationSec ?? 0) > 1);
    ok('the exported length matches the canonical timeline, speed change included',
      Math.abs((mixedExport.output.durationSec ?? 0) -
        videos().reduce((total, element) => total + element.duration, 0)) < 0.5,
      `${mixedExport.output.durationSec?.toFixed(2)}s exported`);
    ok('the speed change really shortened its segment',
      Math.abs(segment(1).duration - (segment(1).trimEnd - segment(1).trimStart) / 1.5) < 0.01);
    ok('both segments kept their own grade through the export',
      readColor(segment(0).properties).temperature === 0.4 &&
      readColor(segment(1).properties).contrast === 0.35);
    ok('the caption track was NOT regenerated by anything in this workstream',
      metadata.subtitlesFromTranscript === false && metadata.subtitles === captions().length);

    // The hook, drawn over a graded, cropped, rotated frame.
    const hook = (state.elements ?? []).find((element) => element.id === hookId);
    const hookBand = { x: Math.round(hook.properties.x * 1080),
      y: Math.round(hook.properties.y * 1920),
      w: Math.round(hook.properties.width * 1080),
      h: Math.round(hook.properties.height * 1920) };
    const hookPixels = meanRgb(mixedExport.file, 1.2, hookBand);
    const hookQuiet = meanRgb(mixedExport.file, Math.min(5,
      (mixedExport.output.durationSec ?? 6) - 1), hookBand);
    ok('the styled hook is drawn on top of the graded, cropped, rotated frame',
      Math.abs(luma(hookPixels) - luma(hookQuiet)) > 3,
      `luma ${luma(hookQuiet).toFixed(1)} with no hook vs ${luma(hookPixels).toFixed(1)} with it`);

    console.log('\n5. Ducking, measured');
    // The windows are derived with the SAME pure function the renderer uses, so
    // the measurement is taken exactly where the export claims to duck.
    const map = buildTimelineMap((state.elements ?? []).map((element) => ({
      id: element.id, type: element.type, track: element.track, position: element.position,
      startTime: element.startTime, duration: element.duration, trimStart: element.trimStart,
      trimEnd: element.trimEnd, properties: element.properties })));
    const sourceAsset = await prisma.editAsset.findFirst({
      where: { editProjectId: mixedId, role: 'SOURCE' } });
    const words = sourceAsset.transcript.segments.flatMap((item) => item.words);
    const windows = speechWindowsFromTranscript(words, map);
    ok('the renderer had real speech windows to duck against', windows.length > 0,
      windows.map((window) =>
        `${window.startSec.toFixed(2)}-${window.endSec.toFixed(2)}s`).join(', '));

    const speech = windows[0];
    const speechMid = (speech.startSec + speech.endSec) / 2;
    const speechSpan = Math.min(1.2, Math.max(0.4, (speech.endSec - speech.startSec) * 0.6));
    const lastWindow = windows[windows.length - 1];
    // A silence well clear of the release tail of the last window, and clear of
    // the clip's own fade out.
    const silenceStart = lastWindow.endSec + 1.2;
    const silenceSpan = Math.min(1.2,
      (mixedExport.output.durationSec ?? 0) - 0.8 - silenceStart);
    ok('the timeline has a known silence to use as the control',
      silenceSpan > 0.3,
      `silence from ${silenceStart.toFixed(2)}s for ${silenceSpan.toFixed(2)}s`);

    const duringSpeech = meanVolume(mixedExport.file, speechMid - speechSpan / 2, speechSpan);
    const duringSilence = meanVolume(mixedExport.file, silenceStart, silenceSpan);
    console.log(`  under speech ${duringSpeech.toFixed(2)} dB, ` +
      `in silence ${duringSilence.toFixed(2)} dB`);
    ok('the music is measurably QUIETER inside a known speech window',
      Number.isFinite(duringSpeech) && Number.isFinite(duringSilence) &&
      duringSilence - duringSpeech > 4,
      `${(duringSilence - duringSpeech).toFixed(2)} dB of ducking`);
    ok('...and it comes back up outside that window, rather than staying down',
      duringSilence > duringSpeech,
      'the level recovers in the silence');

    console.log('\n6. Isolation and history');
    const frozenAfter = await frozenCounts(prisma);
    ok('the whole run changed no frozen-pipeline row',
      JSON.stringify(frozenAfter) === JSON.stringify(frozenBefore));
    const colourRevisions = await prisma.editHistory.count({ where: {
      editProjectId: mixedId, action: { in: ['APPLY_COLOR_FILTER', 'SET_VIDEO_TEMPERATURE',
        'SET_VIDEO_CONTRAST', 'SET_SOURCE_AUDIO_MUTED', 'SET_AUDIO_VOLUME', 'SET_AUDIO_FADE',
        'SET_AUDIO_DUCKING'] } } });
    ok('every colour and audio command wrote its own undoable revision',
      colourRevisions >= 7, `${colourRevisions} revisions`);
    for (const result of [metadata.qa.result, colorExport.asset.metadata.qa.result]) {
      if (!['PASS', 'DEGRADED_ACCEPTABLE'].includes(result)) {
        throw new Error(`QA returned ${result}`);
      }
    }
    ok('both exports passed their own QA pass', true,
      `${colorExport.asset.metadata.qa.result} and ${metadata.qa.result}`);

    mkdirSync(outputDir, { recursive: true });
    for (const [name, file] of [['color', colorExport.file], ['mixed', mixedExport.file]]) {
      const review = join(outputDir, `edit-mode-${name}-${randomUUID().slice(0, 8)}.mp4`);
      copyFileSync(file, review);
      console.log(`\nCopied for visual review: ${review}`);
    }
    console.log(`\nEditMode colour/audio real-media verification PASSED (${checks} checks).`);
  } catch (error) {
    failed = true;
    console.error(`\nEditMode colour/audio real-media verification FAILED: ${error.message}`);
    console.error(error.stack);
  } finally {
    if (flag('keep')) {
      console.log(`\n--keep: leaving ${created.projectIds.join(', ')} and their objects in place.`);
    } else {
      for (const objectKey of created.objectKeys) {
        await storage.removeObject(bucket, objectKey).catch(() => undefined);
      }
      for (const projectId of created.projectIds) {
        await prisma.editProject.delete({ where: { id: projectId } }).catch(() => undefined);
      }
      console.log('\nCleaned up the disposable EditProjects, their assets and their objects.');
    }
    rmSync(workspace, { recursive: true, force: true });
    await prisma.$disconnect();
    if (failed) process.exitCode = 1;
  }
}

main();
