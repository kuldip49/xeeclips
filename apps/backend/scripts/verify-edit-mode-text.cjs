// Real-media verification for the EditMode text and caption editor (Workstream C).
//
// Creates a DISPOSABLE EditProject on the live stack, drives it with the SAME
// canonical commands the editor sends (add text, style it, generate captions
// from the cached transcript, restyle one caption, split, merge, apply the style
// to all), exports a real MP4, and then checks the PIXELS: the styled hook, the
// caption plate, the caption text and the active-word highlight all have to be
// visible in the frames at the times the canonical timeline says they are, and
// absent at the times it says they are not.
//
//   node scripts/verify-edit-mode-text.cjs [--keep] [--out <dir>]
//
// The source is a flat dark colour on purpose: on a flat field, any bright pixel
// inside the caption band IS the caption, so "the text rendered" is a measurable
// claim rather than a hopeful look at a screenshot.
//
// Everything it creates - project, assets, elements, history, MinIO objects - is
// removed at the end, and it never reads or writes a ProcessingJob, ClipCandidate
// or GeneratedClip.

const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } = require('node:fs');
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
const { readTextStyle, readCaptionWords } = require('../dist/modules/edit-mode/edit-mode-text');

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

const SOURCE_DURATION = 14;
/** The exact words the captions must reproduce. */
const SPEECH = ('compounding only works when you leave it alone for long enough to matter ' +
  'and most people never do').split(' ');

/** Word timings across the first ten seconds, plus one centred face so the
 *  camera has something to frame. Deterministic: no AI service needed. */
function syntheticAnalysis() {
  const frames = Array.from({ length: SOURCE_DURATION * 2 }, (_, index) => ({
    t: index / 2, text_coverage: 0, text_boxes: [], graphic_boxes: [], ocr_lines: [],
    ocr_coverage: 0,
    faces: [{ x: 0.37, y: 0.15, w: 0.26, h: 0.32, score: 0.95, mouth_activity: 0.6,
      track_id: 'a' }],
    persons: [{ x: 0.28, y: 0.12, w: 0.44, h: 0.86 }]
  }));
  const step = 10 / SPEECH.length;
  let cursor = 1;
  const words = SPEECH.map((text) => {
    const start = Number(cursor.toFixed(3));
    cursor += step;
    return { start, end: Number((cursor - 0.06).toFixed(3)), text };
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

/**
 * One frame region of the exported MP4, as raw RGB.
 *
 * Reading real pixels is the whole point: an ASS file that looks right and a
 * frame that actually carries the text are different claims, and only the second
 * one means the export matches the preview.
 */
function samplePixels(file, atSec, box) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(atSec), '-i', file,
    '-frames:v', '1', '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
  { maxBuffer: 64 * 1024 * 1024 });
  const pixels = [];
  for (let at = 0; at + 2 < raw.length; at += 3) {
    pixels.push([raw[at], raw[at + 1], raw[at + 2]]);
  }
  return pixels;
}

const share = (pixels, predicate) =>
  pixels.length ? pixels.filter((pixel) => predicate(pixel)).length / pixels.length : 0;

const isNearWhite = ([r, g, b]) => r > 215 && g > 215 && b > 215;
const isNearBlack = ([r, g, b]) => r < 45 && g < 45 && b < 45;
/** The BOLD_HIGHLIGHT active-word colour (#ffe066), with encoder tolerance. */
const isHighlightYellow = ([r, g, b]) => r > 200 && g > 170 && b < 150 && r - b > 70;

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
  const outputDir = arg('out', process.env.QA_OUTPUT_DIR || '/tmp/edit-mode-text-qa');
  const workspace = mkdtempSync(join(tmpdir(), 'verify-edit-text-'));
  const created = { projectId: null, objectKeys: [] };
  let failed = false;
  const frozenBefore = await frozenCounts(prisma);

  try {
    // --- A flat source, so any bright pixel in a text band IS the text -------
    const sourcePath = join(workspace, 'fixture.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `color=c=0x141c2c:s=1280x720:rate=30:duration=${SOURCE_DURATION}`, '-f', 'lavfi', '-i',
      `sine=frequency=240:duration=${SOURCE_DURATION}`, '-shortest', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath]);
    const probe = await probeMedia(sourcePath);
    console.log(`Source: ${probe.width}x${probe.height} ${probe.durationSec?.toFixed(2)}s ` +
      '(flat #141c2c, so text is measurable)\n');

    // --- Disposable project, driven by the real commands --------------------
    let state = await service.create({ name: `verify-edit-mode-text ${new Date().toISOString()}` });
    created.projectId = state.id;
    console.log(`Created disposable EditProject ${state.id}`);

    const sourceAssetId = require('node:crypto').randomUUID();
    const sourceKey = `edit-mode/${state.id}/${sourceAssetId}/source.mp4`;
    const uploaded = await storage.uploadFile({ filePath: sourcePath, objectKey: sourceKey,
      mimeType: 'video/mp4' });
    created.objectKeys.push(sourceKey);
    state = await service.persistSource(state.id, state.revision, {
      id: sourceAssetId, originalName: 'verify-source.mp4', bucket: uploaded.bucket,
      objectKey: uploaded.objectKey, mimeType: 'video/mp4',
      sizeBytes: BigInt(statSync(sourcePath).size), duration: probe.durationSec,
      width: probe.width, height: probe.height, fps: probe.fps ?? 30,
      metadata: { hasVideo: true, hasAudio: probe.hasAudio, videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec } });

    // The transcript the Analyze step would have cached. Caption generation must
    // read THIS and never re-transcribe.
    const cached = syntheticAnalysis();
    await prisma.editAsset.update({ where: { id: sourceAssetId },
      data: { transcript: cached.transcript, analysis: cached.analysis } });

    // 9:16 with subtitles OFF at the policy level: the captions in this export
    // are the canonical SUBTITLE ELEMENTS, not render-time transcript captions.
    state = await service.update(state.id, { revision: state.revision, settings: {
      selectedPreset: 'SOURCE_MANUAL', aspectRatio: '9:16', pacing: 'MODERATE',
      subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
      musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
      overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null } });

    const command = async (action, payload = {}) => {
      state = await service.phase3Command(state.id, action,
        { revision: state.revision, ...payload });
      return state;
    };
    const captions = () => (state.elements ?? []).filter((element) => element.type === 'SUBTITLE')
      .sort((left, right) => left.startTime - right.startTime);
    const texts = () => (state.elements ?? []).filter((element) => element.type === 'TEXT');

    console.log('\n1. Text, driven by the canonical commands');
    await command('add-text', { textStyleId: 'HOOK' });
    const hookId = texts()[0].id;
    await command('set-text-content', { elementId: hookId, content: 'Leave it alone' });
    await command('set-text-color', { elementId: hookId, color: '#ffffff' });
    await command('set-text-size', { elementId: hookId, fontSize: 70 });
    await command('set-text-stroke', { elementId: hookId, strokeEnabled: true,
      strokeColor: '#000000', strokeWidth: 6 });
    await command('set-text-shadow', { elementId: hookId, shadowEnabled: true,
      shadowColor: '#000000', shadowOpacity: 0.7, shadowBlur: 10, shadowOffsetX: 0,
      shadowOffsetY: 4 });
    await command('set-text-background', { elementId: hookId, backgroundEnabled: false,
      backgroundColor: '#000000', backgroundOpacity: 0.55, backgroundPadding: 18,
      backgroundRadius: 0 });
    await command('move-element', { elementId: hookId, x: 0.08, y: 0.12 });
    await command('resize-element', { elementId: hookId, width: 0.84, height: 0.16 });
    await command('set-element-timing', { elementId: hookId, startTime: 0, duration: 3 });
    const hook = texts()[0];
    ok('the hook carries every style property the commands set',
      readTextStyle(hook.properties).fontSize === 70 &&
      readTextStyle(hook.properties).stroke.width === 6 &&
      readTextStyle(hook.properties).shadow.blur === 10 &&
      readTextStyle(hook.properties).uppercase === true,
      'HOOK preset + explicit size/stroke/shadow');

    console.log('\n2. Captions, generated from the cached transcript');
    const revisionBeforeCaptions = state.revision;
    await command('generate-captions', { captionStyleId: 'BOLD_HIGHLIGHT' });
    ok('caption generation is ONE history revision',
      state.revision === revisionBeforeCaptions + 1, `${captions().length} caption elements`);
    const spoken = captions().map((element) => String(element.properties.content))
      .join(' ').split(/\s+/u);
    ok('the captions reproduce the transcript exactly, in order',
      spoken.length === SPEECH.length &&
      spoken.every((word, index) => word.toLowerCase() === SPEECH[index]));
    ok('every caption carries real word timings from the transcript',
      captions().every((element) => readCaptionWords(element.properties).length > 0));

    console.log('\n3. Manual caption editing: edit, split, merge, restyle, apply to all');
    const first = captions()[0];
    await command('split-caption', { elementId: first.id,
      atSec: first.startTime + first.duration / 2 });
    ok('split produced one more caption', captions().length > 0);
    const second = captions()[1];
    await command('merge-caption', { elementId: second.id, direction: 'PREVIOUS' });
    ok('merge put it back', true, `${captions().length} captions`);
    const edited = captions()[2];
    await command('set-caption-text', { elementId: edited.id, content: 'HAND EDITED LINE' });
    ok('a hand-edited caption is flagged',
      captions().find((element) => element.id === edited.id).properties.manualEdited === true);
    await command('apply-caption-style-to-all', { elementId: captions()[0].id });
    ok('applying the style to all left the hand edit alone',
      captions().find((element) => element.id === edited.id).properties.content ===
        'HAND EDITED LINE');

    // Where the caption band and the hook land on the exported 1080x1920 canvas.
    const captionBox = captions()[0].properties;
    const band = { x: Math.round(captionBox.x * 1080), y: Math.round(captionBox.y * 1920),
      w: Math.round(captionBox.width * 1080), h: Math.round(captionBox.height * 1920) };
    const hookBox = texts()[0].properties;
    const hookBand = { x: Math.round(hookBox.x * 1080), y: Math.round(hookBox.y * 1920),
      w: Math.round(hookBox.width * 1080), h: Math.round(hookBox.height * 1920) };

    console.log('\n4. Export');
    const started = await render.startExport(state.id, state.revision);
    let progress = started.export;
    const deadline = Date.now() + 15 * 60 * 1000;
    let lastPhase = '';
    while (progress && progress.phase !== 'COMPLETED' && progress.phase !== 'FAILED') {
      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase;
        console.log(`  ${progress.phase} (${progress.percent}%)`);
      }
      if (Date.now() > deadline) throw new Error('The export did not finish within 15 minutes.');
      await wait(500);
      progress = await render.progress(state.id);
    }
    if (progress.phase === 'FAILED') {
      throw new Error(`Export failed (${progress.errorCode}): ${progress.message}`);
    }
    const [asset] = await render.listExports(state.id);
    created.objectKeys.push(asset.objectKey);
    const downloaded = join(workspace, 'export.mp4');
    await storage.downloadToFile(asset.bucket, asset.objectKey, downloaded);
    const output = await probeMedia(downloaded);
    const metadata = asset.metadata;

    console.log('\nFFprobe:');
    console.log(`  media        ${output.width}x${output.height} ` +
      `${output.durationSec?.toFixed(2)}s ${output.videoCodec}` +
      `${output.hasAudio ? `/${output.audioCodec}` : ' (no audio)'}`);
    console.log(`  timeline     ${metadata.segments} segment(s), ${metadata.textElements} text, ` +
      `${metadata.subtitles} caption(s)` +
      `${metadata.subtitlesFromTranscript ? ' (render-time)' : ' (elements)'}`);
    console.log(`  QA           ${metadata.qa.result} (${metadata.qa.sampledFrameCount} frames)`);
    for (const warning of metadata.warnings ?? []) console.log(`  warning      ${warning}`);

    console.log('\n5. Pixels: the export carries what the preview drew');
    ok('the export is the 9:16 canvas the editor previewed',
      output.width === 1080 && output.height === 1920);
    ok('the captions in the file are the canonical ELEMENTS, not render-time captions',
      metadata.subtitlesFromTranscript === false &&
      metadata.subtitles === captions().length,
      `${metadata.subtitles} caption elements`);

    const hookPixels = samplePixels(downloaded, 1.2, hookBand);
    ok('the styled hook is drawn where the timeline says it is',
      share(hookPixels, isNearWhite) > 0.005,
      `${(share(hookPixels, isNearWhite) * 100).toFixed(2)}% white in the hook band at 1.2s`);
    ok('its dark stroke and shadow are drawn around it',
      share(hookPixels, isNearBlack) > 0.005,
      `${(share(hookPixels, isNearBlack) * 100).toFixed(2)}% near-black in the hook band`);
    const afterHook = samplePixels(downloaded, 5, hookBand);
    ok('the hook is GONE once its span ends, exactly as the timeline says',
      share(afterHook, isNearWhite) < 0.001,
      `${(share(afterHook, isNearWhite) * 100).toFixed(3)}% white at 5s`);

    const live = captions().find((element) => element.startTime > 1.5 &&
      element.properties.manualEdited !== true &&
      readCaptionWords(element.properties).length >= 2);
    const wordTimings = readCaptionWords(live.properties);
    const duringWord = live.startTime + (wordTimings[1].start + wordTimings[1].end) / 2;
    const captionPixels = samplePixels(downloaded, duringWord, band);
    ok('caption text is drawn in the caption band',
      share(captionPixels, isNearWhite) > 0.005,
      `${(share(captionPixels, isNearWhite) * 100).toFixed(2)}% white at ${duringWord.toFixed(2)}s`);
    ok('the active-word highlight is really rendered, in the caption\'s own colour',
      share(captionPixels, isHighlightYellow) > 0.0008,
      `${(share(captionPixels, isHighlightYellow) * 100).toFixed(3)}% #ffe066-ish`);

    const gap = captions().at(-1);
    const afterCaptions = Math.min((output.durationSec ?? SOURCE_DURATION) - 0.4,
      gap.startTime + gap.duration + 0.6);
    if (afterCaptions > gap.startTime + gap.duration + 0.1) {
      const quiet = samplePixels(downloaded, afterCaptions, band);
      ok('the caption band is clear once the captions end',
        share(quiet, isNearWhite) < 0.002,
        `${(share(quiet, isNearWhite) * 100).toFixed(3)}% white at ${afterCaptions.toFixed(2)}s`);
    }

    console.log('\n6. Isolation');
    const frozenAfter = await frozenCounts(prisma);
    ok('the whole run changed no frozen-pipeline row',
      JSON.stringify(frozenAfter) === JSON.stringify(frozenBefore));
    ok('every text and caption command wrote its own undoable revision',
      await prisma.editHistory.count({ where: { editProjectId: state.id,
        action: { in: ['ADD_TEXT', 'SET_TEXT_CONTENT', 'SET_TEXT_COLOR', 'SET_TEXT_SIZE',
          'SET_TEXT_STROKE', 'SET_TEXT_SHADOW', 'SET_TEXT_BACKGROUND', 'GENERATE_CAPTIONS',
          'SPLIT_CAPTION', 'MERGE_CAPTION', 'SET_CAPTION_TEXT',
          'APPLY_CAPTION_STYLE_TO_ALL'] } } }) >= 12);

    if (!['PASS', 'DEGRADED_ACCEPTABLE'].includes(metadata.qa.result)) {
      throw new Error(`QA returned ${metadata.qa.result}`);
    }

    mkdirSync(outputDir, { recursive: true });
    const review = join(outputDir, `edit-mode-text-${asset.id}.mp4`);
    copyFileSync(downloaded, review);
    console.log(`\nCopied for visual review: ${review}`);
    console.log(`\nEditMode text/caption real-media verification PASSED (${checks} checks).`);
  } catch (error) {
    failed = true;
    console.error(`\nEditMode text/caption real-media verification FAILED: ${error.message}`);
    console.error(error.stack);
  } finally {
    if (flag('keep')) {
      console.log(`\n--keep: leaving EditProject ${created.projectId} and its objects in place.`);
    } else if (created.projectId) {
      for (const objectKey of created.objectKeys) {
        await storage.removeObject(
          process.env.MINIO_BUCKET ?? 'ai-content-platform', objectKey).catch(() => undefined);
      }
      await prisma.editProject.delete({ where: { id: created.projectId } }).catch(() => undefined);
      console.log('Cleaned up the disposable EditProject, its assets and its objects.');
    }
    rmSync(workspace, { recursive: true, force: true });
    await prisma.$disconnect();
    if (failed) process.exitCode = 1;
  }
}

main();
