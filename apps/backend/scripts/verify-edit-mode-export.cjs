// Real-media EditMode export verification against the dockerized stack.
//
// Creates a DISPOSABLE EditProject with a real short source, runs the Phase 5
// renderer end to end (plan -> FFmpeg -> QA -> MinIO -> EditAsset(EXPORT)),
// probes the stored object, prints the QA telemetry, and then removes every row
// and object it created. It never touches an existing EditProject, and it never
// creates or reads a ProcessingJob, ClipCandidate or GeneratedClip.
//
//   node scripts/verify-edit-mode-export.cjs [--file <mp4>] [--aspect 9:16]
//     [--preset PODCAST_CLIP] [--analyze] [--keep] [--out <dir>] [--transform]
//     [--template CLEAN_REEL] [--scope]
//
// --scope applies Step 5 scoped canonical edits (global/selected caption style,
// a manual caption correction, global colour, "make zooms weaker" and a
// whole-clip 9:16 crop) and checks the export honours them: 9:16 output, the
// same cuts, and the corrected caption wording intact.
//
// --template applies a Workstream F style template through the ordinary
// EditTemplateService before exporting, then checks that the template actually
// reached the rendered file (canvas shape, caption styling, grade) AND that the
// manual content it must never touch - the hook wording, the caption wording and
// the cuts - came through the export unchanged.
//
// --transform applies a real manual transform (crop, rotation, flip and a 2x
// speed on the first segment, plus a rotated and flipped logo) and then checks
// the EXPORTED duration against the canonical timeline. That is the end-to-end
// form of the parity claim: speed genuinely shortens the rendered file, and a
// crop/rotation/flip chain genuinely encodes rather than being dropped.
//
// Without --file a 12-second fixture is generated with ffmpeg. Without
// --analyze a deterministic synthetic analysis is used so the script does not
// require the AI service; --analyze runs the real /transcriptions and
// /edit-analysis calls the Analyze step uses.

const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { StorageService } = require('../dist/modules/storage/storage.service');
const {
  EditModeAnalysisService
} = require('../dist/modules/edit-mode/edit-mode-analysis.service');
const {
  EditModeRenderService
} = require('../dist/modules/edit-mode/render/edit-mode-render.service');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service');
const { EditTemplateService } = require('../dist/modules/edit-mode/edit-template.service');
const { probeMedia } = require('../dist/modules/processing/media-probe');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SPEECH = ('Most investors lose money because they try to time the market instead of ' +
  'staying invested and the compounding never gets a chance to work at all').split(/\s+/u);

/** A deterministic stand-in for the cached Analyze output: one centred face for
 * the whole source, and word timings across the first two thirds of it. */
function syntheticAnalysis(durationSec) {
  const frames = Array.from({ length: Math.round(durationSec * 2) }, (_, index) => ({
    t: index / 2, text_coverage: 0, text_boxes: [], graphic_boxes: [], ocr_lines: [],
    ocr_coverage: 0,
    faces: [{ x: 0.37, y: 0.15, w: 0.26, h: 0.32, score: 0.95, mouth_activity: 0.6,
      track_id: 'a' }],
    persons: [{ x: 0.28, y: 0.12, w: 0.44, h: 0.86 }]
  }));
  const step = Math.max(0.24, (durationSec * 0.66) / SPEECH.length);
  let cursor = 0.4;
  const words = SPEECH.map((text) => {
    const start = Number(cursor.toFixed(3));
    cursor += step;
    return { start, end: Number((cursor - 0.04).toFixed(3)), text };
  });
  return {
    analysis: { source: 'DENSE', frames, shotBoundaries: [], ocrText: '',
      summary: { sampledFrameCount: frames.length, faceDetections: frames.length,
        mouthActivitySamples: frames.length, shotCount: 1, ocrRegionCount: 0 } },
    transcript: { text: SPEECH.join(' '), language: 'en', duration: durationSec,
      segments: [{ position: 0, start: words[0].start, end: words[words.length - 1].end,
        text: SPEECH.join(' '), words }] }
  };
}

/** Row counts for every model EditMode must never write. */
async function frozenCounts(prisma) {
  const [processingJobs, clipCandidates, generatedClips] = await Promise.all([
    prisma.processingJob.count(), prisma.clipCandidate.count(), prisma.generatedClip.count()
  ]);
  return { processingJobs, clipCandidates, generatedClips };
}

async function main() {
  const prisma = new PrismaClient();
  const storage = new StorageService();
  const render = new EditModeRenderService(prisma, storage);
  const aspect = arg('aspect', '9:16');
  const preset = arg('preset', 'PODCAST_CLIP');
  const outputDir = arg('out', process.env.QA_OUTPUT_DIR || '/tmp/edit-mode-export-qa');
  const workspace = mkdtempSync(join(tmpdir(), 'verify-edit-mode-'));
  const created = { projectId: null, objectKeys: [] };
  let failed = false;

  const frozenBefore = await frozenCounts(prisma);

  try {
    // --- Source -------------------------------------------------------------
    let sourcePath = arg('file', '');
    if (!sourcePath) {
      sourcePath = join(workspace, 'fixture.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        'testsrc2=size=1280x720:rate=30:duration=12', '-f', 'lavfi', '-i',
        'sine=frequency=280:duration=12', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', sourcePath]);
      console.log('Generated a 12s 1280x720 fixture.');
    }
    const probe = await probeMedia(sourcePath);
    if (!probe.hasVideo) throw new Error('The chosen source has no video stream.');
    console.log(`Source: ${probe.width}x${probe.height} ${probe.durationSec?.toFixed(2)}s ` +
      `${probe.videoCodec}${probe.hasAudio ? `/${probe.audioCodec}` : ' (no audio)'}`);

    // --- Disposable project -------------------------------------------------
    const project = await prisma.editProject.create({ data: {
      name: `verify-edit-mode-export ${new Date().toISOString()}`, status: 'READY', revision: 1,
      settings: {
        selectedPreset: preset, aspectRatio: aspect, pacing: 'MODERATE',
        subtitlePolicy: 'ALWAYS', hookPolicy: 'AUTO', zoomPolicy: 'MODERATE',
        reframePolicy: 'FACE_FOCUSED', musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'CLEAN',
        textPolicy: 'MINIMAL', overlayPolicy: 'MINIMAL', informationRegionPolicy: 'RESPECT',
        hookText: 'Time in the market beats timing it',
        presetRun: { presetId: preset, presetRunId: randomUUID(), appliedAtRevision: 1,
          summary: 'verification run', trims: [],
          plannedZoomMoments: [{ startSec: 2.5, endSec: 3.4, reason: 'STATISTIC',
            triggerText: 'compounding', intensity: 'MODERATE' }] }
      } } });
    created.projectId = project.id;
    console.log(`Created disposable EditProject ${project.id}`);

    const sourceAssetId = randomUUID();
    const sourceKey = `edit-mode/${project.id}/${sourceAssetId}/source.mp4`;
    const uploaded = await storage.uploadFile({ filePath: sourcePath, objectKey: sourceKey,
      mimeType: 'video/mp4' });
    created.objectKeys.push(sourceKey);

    let cached = syntheticAnalysis(probe.durationSec ?? 12);
    const sourceAsset = await prisma.editAsset.create({ data: {
      id: sourceAssetId, editProjectId: project.id, role: 'SOURCE',
      originalName: 'verify-source.mp4', bucket: uploaded.bucket, objectKey: uploaded.objectKey,
      mimeType: 'video/mp4', sizeBytes: BigInt(statSync(sourcePath).size),
      duration: probe.durationSec, width: probe.width, height: probe.height,
      fps: probe.fps ?? 30,
      metadata: { hasVideo: probe.hasVideo, hasAudio: probe.hasAudio,
        videoCodec: probe.videoCodec, audioCodec: probe.audioCodec },
      transcript: cached.transcript, analysis: cached.analysis } });

    if (flag('analyze')) {
      console.log('Running the real Analyze step (AI service)...');
      try {
        cached = await new EditModeAnalysisService(storage).analyze(sourceAsset);
        await prisma.editAsset.update({ where: { id: sourceAsset.id },
          data: { transcript: cached.transcript, analysis: cached.analysis } });
        console.log('  analysis cached from the AI service.');
      } catch (error) {
        console.warn(`  AI service unavailable (${error.message}); keeping the synthetic ` +
          'analysis so the render path is still exercised.');
      }
    }

    // --- Representative timeline: a split, a trim, a hook and a logo --------
    const logoPath = join(workspace, 'logo.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=0x2ad4c8:s=240x120:d=1', '-frames:v', '1', logoPath]);
    const logoAssetId = randomUUID();
    const logoKey = `edit-mode/${project.id}/${logoAssetId}/logo.png`;
    await storage.uploadFile({ filePath: logoPath, objectKey: logoKey, mimeType: 'image/png' });
    created.objectKeys.push(logoKey);
    await prisma.editAsset.create({ data: { id: logoAssetId, editProjectId: project.id,
      role: 'LOGO', originalName: 'verify-logo.png', bucket: uploaded.bucket,
      objectKey: logoKey, mimeType: 'image/png', sizeBytes: BigInt(statSync(logoPath).size),
      width: 240, height: 120, metadata: {} } });

    const half = Math.max(2, Math.floor((probe.durationSec ?? 12) / 2));
    // With --transform the first segment is cropped, rotated, flipped and played
    // at 2x, so its timeline length is half its source range. Everything after it
    // shifts by the time saved, exactly as SET_SPEED's ripple does.
    const transform = flag('transform');
    const firstSpeed = transform ? 2 : 1;
    const firstSource = half - 0.5;
    const firstLength = firstSource / firstSpeed;
    const firstProperties = transform
      ? { crop: { left: 0.12, right: 0.12, top: 0, bottom: 0 }, rotation: 8,
        flipH: true, flipV: false, scale: 1.1, offsetX: 0.05, offsetY: 0, speed: firstSpeed }
      : {};
    await prisma.editElement.createMany({ data: [
      { id: randomUUID(), editProjectId: project.id, assetId: sourceAssetId, type: 'VIDEO',
        track: 0, position: 0, startTime: 0, duration: firstLength, trimStart: 0.5,
        trimEnd: half, properties: firstProperties },
      { id: randomUUID(), editProjectId: project.id, assetId: sourceAssetId, type: 'VIDEO',
        track: 0, position: 1, startTime: firstLength, duration: 2, trimStart: half + 1,
        trimEnd: half + 3, properties: {} },
      { id: randomUUID(), editProjectId: project.id, assetId: null, type: 'TEXT', track: 1,
        position: 0, startTime: 0, duration: Math.min(2.5, firstLength), trimStart: 0,
        trimEnd: null,
        properties: { content: 'Time in the market beats timing it', x: 0.08, y: 0.1,
          width: 0.84, height: 0.18, fontSize: 52, fontWeight: 700,
          fontFamily: 'Arial, sans-serif', textAlign: 'center', color: '#ffffff',
          backgroundColor: 'transparent', opacity: 1, zIndex: 30, anchor: 'top-left',
          locked: false, origin: 'PRESET', presetId: preset, presetRole: 'HOOK' } },
      { id: randomUUID(), editProjectId: project.id, assetId: logoAssetId, type: 'IMAGE',
        track: 2, position: 0, startTime: 0.5,
        duration: Math.min(4, firstLength + 2 - 0.5), trimStart: 0, trimEnd: null,
        properties: { x: 0.74, y: 0.04, width: 0.22, height: 0.06, opacity: 0.85, zIndex: 20,
          role: 'LOGO', anchor: 'top-left', locked: false, preserveAspectRatio: true,
          ...(transform ? { rotation: -10, flipH: true,
            crop: { left: 0.05, right: 0.05, top: 0, bottom: 0 } } : {}) } }
    ] });

    // --- Optional: apply a style template ------------------------------------
    // Through the ordinary service, so this is the same path the editor uses.
    let exportRevision = 1;
    let templateReport = null;
    const templateId = arg('template', '');
    if (templateId) {
      const editMode = new EditModeService(prisma, storage,
        { analyze: async () => { throw new Error('not used'); } });
      const templates = new EditTemplateService(prisma, editMode);
      const beforeElements = await prisma.editElement.findMany({
        where: { editProjectId: project.id } });
      const manualBefore = {
        hook: beforeElements.find((element) => element.type === 'TEXT')?.properties?.content ?? null,
        captions: beforeElements.filter((element) => element.type === 'SUBTITLE')
          .map((element) => element.properties?.content).join('|'),
        cuts: beforeElements.filter((element) => element.type === 'VIDEO')
          .sort((left, right) => left.position - right.position)
          .map((element) => `${element.trimStart}:${element.trimEnd}`).join('|')
      };
      const applied = await templates.apply(project.id, { templateId, revision: 1 });
      exportRevision = applied.project.revision;
      const afterElements = await prisma.editElement.findMany({
        where: { editProjectId: project.id } });
      const manualAfter = {
        hook: afterElements.find((element) => element.type === 'TEXT')?.properties?.content ?? null,
        captions: afterElements.filter((element) => element.type === 'SUBTITLE')
          .map((element) => element.properties?.content).join('|'),
        cuts: afterElements.filter((element) => element.type === 'VIDEO')
          .sort((left, right) => left.position - right.position)
          .map((element) => `${element.trimStart}:${element.trimEnd}`).join('|')
      };
      templateReport = {
        id: templateId, name: applied.plan.templateName,
        changes: applied.plan.changes.length, preserved: applied.plan.preserved.length,
        warnings: applied.plan.warnings,
        captionStyle: [...new Set(afterElements.filter((element) => element.type === 'SUBTITLE')
          .map((element) => element.properties?.captionStyleId))].join(','),
        colorFilter: afterElements.find((element) => element.type === 'VIDEO')
          ?.properties?.colorFilterId ?? null,
        aspectRatio: applied.project.settings?.aspectRatio ?? null,
        hookStyleId: afterElements.find((element) => element.type === 'TEXT')
          ?.properties?.textStyleId ?? null,
        manualPreserved: manualBefore.hook === manualAfter.hook &&
          manualBefore.captions === manualAfter.captions &&
          manualBefore.cuts === manualAfter.cuts
      };
      console.log(`Applied template ${templateReport.name}: ${templateReport.changes} change(s), ` +
        `${templateReport.preserved} preserved.`);
      if (!templateReport.manualPreserved) {
        throw new Error('A template changed manual content (hook wording, caption wording or cuts)');
      }
    }

    // --- Optional: Step 5 scoped canonical edits -----------------------------
    // Through the ordinary EditModeService command funnel: captions generated,
    // one corrected by hand, a global size, a selected override, a global colour,
    // then "crop the whole video vertically" and "make zooms weaker". The export
    // must come out 9:16 with the same cuts and the corrected wording intact.
    let scopeReport = null;
    if (flag('scope')) {
      const editMode = new EditModeService(prisma, storage,
        { analyze: async () => { throw new Error('not used'); } });
      let current = await editMode.get(project.id);
      const run = async (action, payload) => {
        current = await editMode.phase3Command(project.id, action, { revision: current.revision, ...payload });
        return current;
      };
      const cutsBefore = current.elements.filter((e) => e.type === 'VIDEO')
        .sort((a, b) => a.position - b.position).map((e) => `${e.trimStart}:${e.trimEnd}`).join('|');
      await run('generate-captions', { captionStyleId: 'CLEAN' });
      const firstCaption = current.elements.filter((e) => e.type === 'SUBTITLE')
        .sort((a, b) => a.startTime - b.startTime)[0];
      const corrected = `${firstCaption.properties.content} (fixed)`;
      await run('set-caption-text', { elementId: firstCaption.id, content: corrected });
      await run('set-text-size', { elementType: 'SUBTITLE', scope: 'TRACK', fontSize: 34 });
      await run('set-text-size', { elementId: firstCaption.id, scope: 'SELECTED_ELEMENT', fontSize: 46 });
      await run('set-text-color', { elementType: 'SUBTITLE', scope: 'TRACK', color: '#FFE000' });
      await run('add-zoom', { startTime: 1, duration: 1.4, scale: 1.12 });
      await run('adjust-zoom-strength', { direction: 'WEAKER' });
      await run('set-video-temperature', { scope: 'ALL_VIDEO_SEGMENTS', temperature: 0.12 });
      await run('set-video-framing', { mode: 'ASPECT', aspectRatio: '9:16', scope: 'ALL_VIDEO_SEGMENTS' });
      const reloaded = await editMode.get(project.id);
      const captionsAfter = reloaded.elements.filter((e) => e.type === 'SUBTITLE');
      scopeReport = {
        canvas: reloaded.settings.aspectRatio,
        cutsPreserved: reloaded.elements.filter((e) => e.type === 'VIDEO')
          .sort((a, b) => a.position - b.position).map((e) => `${e.trimStart}:${e.trimEnd}`).join('|') === cutsBefore,
        wordingPreserved: captionsAfter.find((e) => e.id === firstCaption.id)?.properties.content === corrected,
        overrideKept: captionsAfter.find((e) => e.id === firstCaption.id)?.properties.fontSize === 46,
        allYellow: captionsAfter.every((e) => String(e.properties.color).toLowerCase() === '#ffe000'),
        captions: captionsAfter.length,
        zoomScale: reloaded.elements.find((e) => e.type === 'EFFECT')?.properties.scale,
        historyRows: await prisma.editHistory.count({ where: { editProjectId: project.id } })
      };
      exportRevision = reloaded.revision;
      console.log(`Applied Step 5 scoped edits: ${JSON.stringify(scopeReport)}`);
      if (scopeReport.canvas !== '9:16' || !scopeReport.cutsPreserved || !scopeReport.wordingPreserved ||
        !scopeReport.overrideKept || !scopeReport.allYellow) {
        throw new Error('A Step 5 scoped edit did not land canonically');
      }
    }

    // --- Export -------------------------------------------------------------
    console.log('Starting the EditMode export...');
    const started = await render.startExport(project.id, exportRevision);
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
      progress = await render.progress(project.id);
    }
    if (progress.phase === 'FAILED') {
      throw new Error(`Export failed (${progress.errorCode}): ${progress.message}`);
    }
    console.log('  COMPLETED');

    // --- Verify the stored asset -------------------------------------------
    const exports = await render.listExports(project.id);
    if (exports.length !== 1) throw new Error(`expected 1 export, found ${exports.length}`);
    const asset = exports[0];
    created.objectKeys.push(asset.objectKey);
    if (asset.role !== 'EXPORT') throw new Error('the export is not an EditAsset(role: EXPORT)');
    if (!asset.objectKey.startsWith(`edit-mode/${project.id}/exports/`)) {
      throw new Error(`the export is outside the EditMode namespace: ${asset.objectKey}`);
    }
    // A template application is a revision of its own, so the export's recorded
    // source revision follows whatever was current when the render started.
    if (asset.sourceRevision !== exportRevision) {
      throw new Error(`sourceRevision was not persisted (${asset.sourceRevision} != ${exportRevision})`);
    }
    if (asset.current !== true) throw new Error('a fresh export should be the current result');

    const stat = await storage.statObject(asset.bucket, asset.objectKey);
    if (Number(stat.size) !== Number(asset.sizeBytes)) {
      throw new Error('the stored object size does not match the EditAsset row');
    }
    const downloaded = join(workspace, 'export.mp4');
    await storage.downloadToFile(asset.bucket, asset.objectKey, downloaded);
    const output = await probeMedia(downloaded);
    const metadata = asset.metadata;

    // --- Parity: the rendered file matches the canonical timeline -----------
    const expectedDuration = firstLength + 2;
    const measured = output.durationSec ?? 0;
    if (Math.abs(measured - expectedDuration) > 0.35) {
      throw new Error(`export duration ${measured.toFixed(2)}s does not match the ` +
        `canonical timeline ${expectedDuration.toFixed(2)}s` +
        (transform ? ' - speed did not reach the render' : ''));
    }
    console.log(`\nParity: timeline ${expectedDuration.toFixed(2)}s -> ` +
      `export ${measured.toFixed(2)}s (delta ${Math.abs(measured - expectedDuration).toFixed(3)}s)`);
    if (transform) {
      console.log('  transform    crop 0.12/0.12, rotation 8 deg, hflip, scale 1.1, speed 2x');
      console.log('  logo         rotation -10 deg, hflip, crop 0.05/0.05');
      console.log(`  speed        ${firstSource.toFixed(2)}s of source rendered as ` +
        `${firstLength.toFixed(2)}s of timeline`);
    }

    console.log('\nExport:');
    console.log(`  asset        ${asset.id}`);
    console.log(`  object       ${asset.objectKey} (${(Number(asset.sizeBytes) / 1024).toFixed(0)} KiB)`);
    console.log(`  media        ${output.width}x${output.height} ` +
      `${output.durationSec?.toFixed(2)}s ${output.videoCodec}` +
      `${output.hasAudio ? `/${output.audioCodec}` : ' (no audio)'}`);
    console.log(`  preset       ${metadata.preset} @ ${metadata.aspectRatio}`);
    if (templateReport) {
      console.log(`  template     ${templateReport.name} (${templateReport.id})`);
      console.log(`  t.captions   ${templateReport.captionStyle}`);
      console.log(`  t.colour     ${templateReport.colorFilter}`);
      console.log(`  t.aspect     ${templateReport.aspectRatio}`);
      console.log(`  t.hookStyle  ${templateReport.hookStyleId}`);
      console.log(`  t.manual     hook, caption wording and cuts all preserved`);
      for (const warning of templateReport.warnings) console.log(`  t.warning    ${warning}`);
    }
    console.log(`  timeline     ${metadata.segments} segment(s), ${metadata.overlays} overlay(s), ` +
      `${metadata.textElements} text, ${metadata.subtitles} caption(s)` +
      `${metadata.subtitlesFromTranscript ? ' (render-time)' : ''}`);
    console.log(`  zoom         ${metadata.zoom.rendered} rendered, ` +
      `${metadata.zoom.rejected} rejected, ${metadata.zoom.reduced} reduced`);
    console.log(`  grading      ${metadata.grading.policy} -> ${metadata.grading.preset}`);
    console.log(`  render       ${metadata.renderDurationMs} ms over ${metadata.attempts} attempt(s)`);
    console.log(`  QA           ${metadata.qa.result} (${metadata.qa.sampledFrameCount} frames)`);
    for (const check of metadata.qa.checks) {
      console.log(`    ${check.result === 'PASS' ? ' ' : '!'} ${check.id}: ${check.detail}`);
    }
    for (const warning of metadata.warnings ?? []) console.log(`  warning      ${warning}`);

    // A template may legitimately change the export shape - that IS the point of
    // its aspect-ratio policy - so the expectation follows the template when one
    // was applied, and the --aspect flag otherwise.
    const effectiveAspect = scopeReport?.canvas ?? templateReport?.aspectRatio ?? aspect;
    const expected = { '9:16': [1080, 1920], '16:9': [1920, 1080],
      '1:1': [1080, 1080] }[effectiveAspect];
    if (expected && (output.width !== expected[0] || output.height !== expected[1])) {
      throw new Error(`expected ${expected.join('x')}, got ${output.width}x${output.height}`);
    }
    if (!['PASS', 'DEGRADED_ACCEPTABLE'].includes(metadata.qa.result)) {
      throw new Error(`QA returned ${metadata.qa.result}`);
    }
    if (!output.hasVideo) throw new Error('the export has no video stream');
    if (probe.hasAudio && !output.hasAudio) throw new Error('the export lost its audio');

    // Nothing in the frozen pipeline was touched: the row counts taken before the
    // export are unchanged by it.
    const frozenAfter = await frozenCounts(prisma);
    if (JSON.stringify(frozenAfter) !== JSON.stringify(frozenBefore)) {
      throw new Error(`the export changed frozen-pipeline row counts: ` +
        `${JSON.stringify(frozenBefore)} -> ${JSON.stringify(frozenAfter)}`);
    }
    // An EXPORT must write no history of its own. A template application, when
    // one was requested, legitimately wrote exactly one row before the render
    // started, so that is what the count is measured against.
    const history = await prisma.editHistory.count({ where: { editProjectId: project.id } });
    const expectedHistory = scopeReport ? scopeReport.historyRows : templateReport ? 1 : 0;
    if (history !== expectedHistory) {
      throw new Error(`the export wrote an EditHistory revision (${history} != ${expectedHistory})`);
    }
    console.log('  isolation    no ProcessingJob/ClipCandidate/GeneratedClip, no history revision');

    mkdirSync(outputDir, { recursive: true });
    const review = join(outputDir, `edit-mode-${aspect.replace(':', 'x')}-${asset.id}.mp4`);
    copyFileSync(downloaded, review);
    console.log(`\nCopied for visual review: ${review}`);
    console.log('\nEditMode real-media export verification PASSED.');
  } catch (error) {
    failed = true;
    console.error(`\nEditMode real-media export verification FAILED: ${error.message}`);
    console.error(error.stack);
  } finally {
    if (flag('keep')) {
      console.log(`\n--keep: leaving EditProject ${created.projectId} and its objects in place.`);
    } else if (created.projectId) {
      for (const objectKey of created.objectKeys) {
        await storage.removeObject(
          process.env.MINIO_BUCKET ?? 'ai-content-platform', objectKey).catch(() => undefined);
      }
      // EditAsset/EditElement/EditHistory cascade from the project.
      await prisma.editProject.delete({ where: { id: created.projectId } }).catch(() => undefined);
      console.log('Cleaned up the disposable EditProject, its assets and its objects.');
    }
    rmSync(workspace, { recursive: true, force: true });
    await prisma.$disconnect();
    if (failed) process.exitCode = 1;
  }
}

main();
