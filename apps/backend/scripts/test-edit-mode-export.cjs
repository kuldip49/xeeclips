// EditMode Phase 5 - real-media export lifecycle.
//
// Drives EditModeRenderService end to end against REAL FFmpeg renders of
// synthetic fixtures, with an in-memory EditProject store and a local-filesystem
// stand-in for MinIO. Every export here encodes an actual MP4, probes it and
// runs the real EditMode QA, so the assertions are about files that exist, not
// plans that were written down.
//
// It also holds the isolation invariants: no ProcessingJob, ClipCandidate or
// GeneratedClip row is created, no frozen queue or exporter is reachable, and
// no LLM is called.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createHarness } = require('./test-edit-mode-isolation.cjs');
const {
  EditModeRenderService
} = require('../dist/modules/edit-mode/render/edit-mode-render.service.js');
const fixtures = require('./test-edit-mode-render.cjs');
const { adaptAutomaticEditPlan } =
  require('../dist/modules/edit-mode/generated-clip-edit-plan-adapter.js');

const BUCKET = 'test-bucket';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls the in-memory progress until the export reaches a terminal phase. */
async function settle(service, projectId, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const progress = await service.progress(projectId);
    if (progress && (progress.phase === 'COMPLETED' || progress.phase === 'FAILED')) return progress;
    if (Date.now() > deadline) assert.fail(`export did not settle (phase ${progress?.phase})`);
    await wait(120);
  }
}

// --- Harness ----------------------------------------------------------------

function createExportHarness(directory) {
  const harness = createHarness();
  const objects = new Map();
  const storage = {
    uploaded: [], downloaded: [],
    async downloadToFile(bucket, objectKey, filePath) {
      storage.downloaded.push(objectKey);
      const source = objects.get(objectKey);
      if (!source) throw new Error(`no such object: ${objectKey}`);
      fs.copyFileSync(source, filePath);
    },
    async uploadFile({ filePath, objectKey }) {
      const target = path.join(directory, 'storage', objectKey.replace(/[\\/]/gu, '_'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(filePath, target);
      objects.set(objectKey, target);
      storage.uploaded.push(objectKey);
      return { bucket: BUCKET, objectKey };
    },
    async statObject() { return { size: 1 }; },
    put(objectKey, filePath) { objects.set(objectKey, filePath); },
    localPath(objectKey) { return objects.get(objectKey); }
  };
  // The shared harness has no editAsset.findMany; exports need to list their own.
  harness.prisma.editAsset.findMany = async ({ where }) =>
    [...harness.rows.editAssets.values()]
      .filter((asset) => asset.editProjectId === where.editProjectId &&
        (!where.role || asset.role === where.role))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((asset) => ({ ...asset }));
  const service = new EditModeRenderService(harness.prisma, storage);
  return { ...harness, storage, objects, service };
}

/** Seeds a project straight into the store, the way Phases 1-4 would have left it. */
function seedProject(harness, { settings, elements, assets, revision = 4, status = 'READY' }) {
  const id = `project-${harness.rows.editProjects.size + 1}`;
  const now = new Date();
  harness.rows.editProjects.set(id, { id, name: 'Export project', sourceProjectId: null,
    status, settings, revision, createdAt: now, updatedAt: now });
  for (const asset of assets) {
    harness.rows.editAssets.set(asset.id, { ...asset, editProjectId: id,
      bucket: BUCKET, objectKey: asset.objectKey, sizeBytes: 1024n,
      originalName: asset.id, createdAt: now, updatedAt: now });
  }
  elements.forEach((element, index) => {
    harness.rows.editElements.set(element.id, { ...element, editProjectId: id, position:
      element.position ?? index, createdAt: now, updatedAt: now });
  });
  return id;
}

// --- Media fixtures ---------------------------------------------------------

function buildMedia(directory) {
  const source = path.join(directory, 'source.mp4');
  const silent = path.join(directory, 'silent.mp4');
  const logo = path.join(directory, 'logo.png');
  const music = path.join(directory, 'music.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=640x360:rate=30:duration=20', '-f', 'lavfi', '-i',
    'sine=frequency=320:duration=20', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', source]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=640x360:rate=30:duration=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-an', silent]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=orange:s=200x100:d=1', '-frames:v', '1', logo]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'sine=frequency=900:duration=20', music]);
  return { source, silent, logo, music };
}

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams',
  '-show_format', '-of', 'json', file], { encoding: 'utf8' }));

const assetRow = (id, role, mimeType, objectKey, over = {}) => ({ id, role, mimeType, objectKey,
  duration: 20, width: null, height: null, fps: null, metadata: {}, transcript: null,
  analysis: null, ...over });

// --- Tests ------------------------------------------------------------------

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-mode-export-test-'));
  const media = buildMedia(directory);
  const frozenBefore = { processingJobs: 0, clipCandidates: 0, generatedClips: 0 };
  let harness;
  try {
    harness = createExportHarness(directory);
    frozenBefore.processingJobs = harness.rows.processingJobs.size;
    frozenBefore.clipCandidates = harness.rows.clipCandidates.size;
    frozenBefore.generatedClips = harness.rows.generatedClips.size;
    harness.storage.put('src.mp4', media.source);
    harness.storage.put('silent.mp4', media.silent);
    harness.storage.put('logo.png', media.logo);
    harness.storage.put('music.wav', media.music);

    const source = (over = {}) => assetRow('src', 'SOURCE', 'video/mp4', 'src.mp4',
      { width: 640, height: 360, fps: 30, metadata: { hasAudio: true },
        transcript: fixtures.transcriptFixture(),
        analysis: fixtures.talkingHead(), ...over });

    // --- 1. A complete export: cuts, reorder, overlays, captions, music ------
    const full = seedProject(harness, {
      revision: 6,
      settings: { selectedPreset: 'PODCAST_CLIP', aspectRatio: '9:16', pacing: 'MODERATE',
        subtitlePolicy: 'ALWAYS', hookPolicy: 'AUTO', zoomPolicy: 'MODERATE',
        reframePolicy: 'FACE_FOCUSED', musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'CLEAN',
        textPolicy: 'MINIMAL', overlayPolicy: 'MINIMAL', informationRegionPolicy: 'RESPECT',
        hookText: 'Compound interest beats timing',
        presetRun: { presetId: 'PODCAST_CLIP', presetRunId: 'run-1', appliedAtRevision: 5,
          summary: '', trims: [], plannedZoomMoments: [
            { startSec: 3, endSec: 4, reason: 'STATISTIC', triggerText: 'compounding',
              intensity: 'MODERATE' }] } },
      assets: [source(), assetRow('logo', 'LOGO', 'image/png', 'logo.png',
        { duration: null, width: 200, height: 100 }),
      assetRow('mus', 'AUDIO', 'audio/wav', 'music.wav')],
      elements: [
        // A split whose second half is reordered ahead of nothing, plus a trim.
        { id: 'v1', assetId: 'src', type: 'VIDEO', track: 0, position: 0, startTime: 0,
          duration: 4, trimStart: 1, trimEnd: 5, properties: {} },
        { id: 'v2', assetId: 'src', type: 'VIDEO', track: 0, position: 1, startTime: 4,
          duration: 3, trimStart: 12, trimEnd: 15, properties: {} },
        { id: 't1', assetId: null, type: 'TEXT', track: 1, position: 0, startTime: 0,
          duration: 2.5, trimStart: 0, trimEnd: null,
          properties: { content: 'Compound interest beats timing', x: 0.08, y: 0.1,
            width: 0.84, height: 0.18, fontSize: 52, fontWeight: 700,
            fontFamily: 'Arial, sans-serif', textAlign: 'center', color: '#ffffff',
            backgroundColor: 'transparent', opacity: 1, zIndex: 30, origin: 'PRESET',
            presetId: 'PODCAST_CLIP', presetRole: 'HOOK' } },
        { id: 'i1', assetId: 'logo', type: 'IMAGE', track: 2, position: 0, startTime: 0.5,
          duration: 5, trimStart: 0, trimEnd: null,
          properties: { x: 0.74, y: 0.04, width: 0.22, height: 0.06, opacity: 0.85,
            zIndex: 20, role: 'LOGO', preserveAspectRatio: true } },
        { id: 'a1', assetId: 'mus', type: 'AUDIO', track: 3, position: 0, startTime: 0,
          duration: 7, trimStart: 0, trimEnd: 7,
          properties: { volume: 0.18, muted: false, fadeInSec: 0.4, fadeOutSec: 0.8,
            duckUnderSpeech: false, duckLevel: 0.25, attackMs: 150, releaseMs: 350 } }
      ]
    });

    const started = await harness.service.startExport(full, 6);
    assert.equal(started.export.phase, 'PREPARING');
    assert.equal(started.export.sourceRevision, 6);
    assert.equal(harness.rows.editProjects.get(full).status, 'EXPORTING');

    // A second export while one is running is refused, not queued.
    await assert.rejects(harness.service.startExport(full, 6),
      (error) => error.getStatus() === 409 &&
        error.getResponse().code === 'EXPORT_ALREADY_RUNNING');

    const done = await settle(harness.service, full);
    assert.equal(done.phase, 'COMPLETED', `export failed: ${done.errorCode} ${done.message}`);
    assert.equal(done.percent, 100);
    assert(done.assetId);
    assert.equal(harness.rows.editProjects.get(full).status, 'COMPLETED');

    const exports = await harness.service.listExports(full);
    assert.equal(exports.length, 1);
    const asset = exports[0];
    assert.equal(asset.role, 'EXPORT', 'the export is stored as EditAsset(role: EXPORT)');
    assert.equal(asset.mimeType, 'video/mp4');
    assert.equal(asset.sourceRevision, 6, 'the export records the revision it came from');
    assert.equal(asset.current, true, 'it is the current result while the timeline has not moved');
    assert(asset.objectKey.startsWith(`edit-mode/${full}/exports/`),
      `export lives in the EditMode namespace: ${asset.objectKey}`);
    assert(asset.objectKey.endsWith('/final.mp4'));
    assert(harness.storage.uploaded.includes(asset.objectKey));

    const metadata = asset.metadata;
    assert.equal(metadata.preset, 'PODCAST_CLIP');
    assert.equal(metadata.aspectRatio, '9:16');
    assert.deepEqual(metadata.resolution, { width: 1080, height: 1920 });
    assert(metadata.durationSec > 6.8 && metadata.durationSec < 7.2);
    assert.deepEqual(metadata.codec, { video: 'h264', audio: 'aac' });
    assert(metadata.fileSizeBytes > 0 && metadata.bitrate > 0);
    assert(metadata.renderDurationMs > 0);
    assert(['PASS', 'DEGRADED_ACCEPTABLE'].includes(metadata.qa.result), metadata.qa.result);
    assert(metadata.qa.checks.some((check) => check.id === 'SUBJECT_SAFETY'));
    assert.equal(metadata.segments, 2);
    assert.equal(metadata.overlays, 1);
    assert.equal(metadata.textElements, 1);
    assert(metadata.subtitles > 0 && metadata.subtitlesFromTranscript === true);
    assert.equal(metadata.audioTracks, 1);
    assert.equal(metadata.zoom.rendered, 1);
    assert.equal(metadata.grading.policy, 'CLEAN');
    assert.equal(metadata.attempts, 1, 'a clean export renders exactly once');
    assert.equal(metadata.stale, false);

    // The stored file really is the described video.
    const rendered = probe(harness.storage.localPath(asset.objectKey));
    const video = rendered.streams.find((stream) => stream.codec_type === 'video');
    const audio = rendered.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(video.width, 1080);
    assert.equal(video.height, 1920);
    assert.equal(video.codec_name, 'h264');
    assert.equal(audio.codec_name, 'aac');
    assert(Math.abs(Number(rendered.format.duration) - 7) < 0.35);
    assert.equal(Number(asset.sizeBytes), fs.statSync(harness.storage.localPath(asset.objectKey)).size);
    const containerTags = JSON.stringify(rendered.format.tags ?? {});
    assert.doesNotMatch(containerTags, /made with ai|openai|chatgpt|watermark|ai-content-platform/iu,
      'the MP4 container must not carry app/provider branding or an AI watermark tag');
    const streamTags = JSON.stringify(rendered.streams.map((stream) => stream.tags ?? {}));
    assert.doesNotMatch(streamTags, /made with ai|openai|chatgpt|watermark|ai-content-platform/iu,
      'video/audio stream metadata must not carry app/provider branding');
    const watermarkRenderSource = fs.readdirSync(path.join(__dirname, '../src/modules/edit-mode/render'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => fs.readFileSync(path.join(__dirname, '../src/modules/edit-mode/render', name), 'utf8'))
      .join('\n');
    assert.doesNotMatch(watermarkRenderSource, /made with ai|openai|chatgpt|app watermark/iu,
      'the render path contains no inserted provider/app branding');
    console.log(`  full export: 2 segments, hook, logo, ${metadata.subtitles} captions, ` +
      `music, 1 zoom -> ${metadata.qa.result}`);
    console.log(`  watermark: none; container tags: ${containerTags || '{}'}`);

    // --- 1a. Step 4 reconstructed AI_EDITED canonical export ----------------
    const automaticTranscript = [{ start: 1, end: 12,
      text: 'One useful idea survives the automatic cut and remains editable', words: [
        { start: 1, end: 1.4, text: 'One' }, { start: 1.4, end: 1.9, text: 'useful' },
        { start: 1.9, end: 2.3, text: 'idea' }, { start: 2.3, end: 2.8, text: 'survives' },
        { start: 8, end: 8.4, text: 'the' }, { start: 8.4, end: 9, text: 'automatic' },
        { start: 9, end: 9.4, text: 'cut' }, { start: 9.4, end: 9.8, text: 'and' },
        { start: 9.8, end: 10.4, text: 'remains' }, { start: 10.4, end: 11, text: 'editable' }
      ] }];
    let automaticId = 0;
    const reconstructed = adaptAutomaticEditPlan({ sourceAssetId: 'auto-src',
      sourceDuration: 20, transcriptSegments: automaticTranscript,
      idFactory: (kind) => `auto-${kind}-${automaticId++}`,
      editPlan: { version: 1, clipStartSec: 1, clipEndSec: 12, aspectRatio: '9:16',
        openingStrategy: { hookStartSec: 1, removeWeakLeadIn: false, reason: 'Context' },
        endingStrategy: { payoffEndSec: 12, reason: 'Payoff' }, musicMood: 'NONE',
        preserveInformation: false,
        onScreenHook: { enabled: true, text: 'One useful idea', startSec: 1, endSec: 3,
          position: 'TOP', style: 'CLEAN' }, operations: [], retentionMoments: [],
        onScreenText: [], subtitleStyle: { enabled: true, template: 'EDUCATION_CLEAN',
          position: 'BOTTOM', maxWordsPerLine: 4, highlightCurrentWord: true,
          animationStyle: 'WORD_HIGHLIGHT' }, subtitleTheme: 'CLEAN_WHITE',
        subtitleEmphasis: [], platformPreset: 'YOUTUBE_SHORTS', gradePreset: 'CLEAN_SOCIAL',
        audio: { normalize: false, removeLongPauses: true }, pacingNotes: [] },
      editTelemetry: { timelineSegments: [
        { sourceStart: 1, sourceEnd: 4, finalStart: 0, finalEnd: 3 },
        { sourceStart: 8, sourceEnd: 12, finalStart: 3, finalEnd: 7 }
      ], zoomEvents: [{ startSec: 3.25, endSec: 5.1, peakScale: 1.1,
        focusX: 0.5, focusY: 0.45, triggerText: 'automatic', semanticReason: 'Key claim' }],
      grading: { selectedPreset: 'CLEAN_SOCIAL' }, reframeSource: 'FACE' } });
    assert.equal(reconstructed.mode, 'CANONICAL');
    const reconstructedProject = seedProject(harness, { revision: 1,
      settings: reconstructed.settingsPatch,
      assets: [source({ id: 'auto-src', transcript: { segments: automaticTranscript } })],
      elements: reconstructed.elements });
    await harness.service.startExport(reconstructedProject, 1);
    const reconstructedDone = await settle(harness.service, reconstructedProject);
    assert.equal(reconstructedDone.phase, 'COMPLETED',
      `reconstructed export failed: ${reconstructedDone.errorCode} ${reconstructedDone.message}`);
    const reconstructedExport = (await harness.service.listExports(reconstructedProject))[0];
    assert(Math.abs(reconstructedExport.metadata.durationSec - 7) < 0.1);
    assert.equal(reconstructedExport.metadata.segments, 2);
    assert.equal(reconstructedExport.metadata.textElements, 1);
    assert(reconstructedExport.metadata.subtitles >= 2);
    assert.equal(reconstructedExport.metadata.subtitlesFromTranscript, false,
      'stored canonical captions, not a render-time transcript path, own the export');
    assert(['PASS', 'DEGRADED_ACCEPTABLE'].includes(reconstructedExport.metadata.qa.result));
    const reconstructedProbe = probe(harness.storage.localPath(reconstructedExport.objectKey));
    assert.equal(reconstructedProbe.streams.find((stream) => stream.codec_type === 'video').width,
      1080);
    assert(Math.abs(Number(reconstructedProbe.format.duration) - 7) < 0.35);
    console.log(`  Step 4 reconstructed AI_EDITED: 2 canonical cuts, hook, captions, zoom/color ` +
      `state -> ${reconstructedExport.metadata.qa.result}`);

    // --- 1b. Step 3 shared original source + updated generated range --------
    // The editor identity key deliberately does not exist in storage. A NORMAL
    // generated project must resolve the shared original Video key and render
    // the post-boundary range (initial 1..6, start moved +2 => 3..6).
    const sharedDownloadStart = harness.storage.downloaded.length;
    const shared = seedProject(harness, {
      revision: 2,
      settings: { selectedPreset: 'SOURCE_MANUAL', aspectRatio: 'SOURCE',
        reframePolicy: 'SOURCE', gradingPolicy: 'NONE', subtitlePolicy: 'OFF',
        hookPolicy: 'OFF', zoomPolicy: 'OFF', musicPolicy: 'KEEP_EXISTING',
        origin: { schemaVersion: 1, originKind: 'GENERATED_CLIP',
          sourceMode: 'ORIGINAL_VIDEO', generatedClipId: 'normal-real-export',
          originalVideoId: 'video-real-export', clipCandidateId: null,
          generatedStart: 1, generatedEnd: 6, generatedDuration: 5,
          currentSourceStart: 3, currentSourceEnd: 6, processingType: 'NORMAL_CLIPS',
          variantKey: 'NORMAL_CLIPS:SOURCE', aspectRatio: 'SOURCE', targetPlatform: null } },
      assets: [source({ id: 'shared-src', objectKey: 'logical/shared-source.mp4', storageObjectKey: 'src.mp4',
        storageOwnership: 'SHARED', sourceVideoId: 'video-real-export' })],
      elements: [{ id: 'shared-v1', assetId: 'shared-src', type: 'VIDEO', track: 0,
        position: 0, startTime: 0, duration: 3, trimStart: 3, trimEnd: 6,
        properties: {} }]
    });
    await harness.service.startExport(shared, 2);
    const sharedDone = await settle(harness.service, shared);
    assert.equal(sharedDone.phase, 'COMPLETED');
    const sharedExport = (await harness.service.listExports(shared))[0];
    assert(Math.abs(sharedExport.metadata.durationSec - 3) < 0.08,
      `updated source range should export ~3s, got ${sharedExport.metadata.durationSec}`);
    const sharedDownloads = harness.storage.downloaded.slice(sharedDownloadStart);
    assert(sharedDownloads.includes('src.mp4'), 'export must read the original Video object');
    assert(!sharedDownloads.includes('logical/shared-source.mp4'),
      'export must not treat the editor identity key as stored media');
    console.log('  Step 3 shared source: updated 3..6s original interval -> 3s real export');

    // --- 2. Repeated exports accumulate; a stale one is detectable -----------
    harness.rows.editProjects.get(full).revision = 7;   // the timeline moved on
    const second = await harness.service.startExport(full, 7);
    assert.equal(second.export.sourceRevision, 7);
    const secondDone = await settle(harness.service, full);
    assert.equal(secondDone.phase, 'COMPLETED');
    const both = await harness.service.listExports(full);
    assert.equal(both.length, 2, 'a new export never overwrites the previous asset');
    assert.notEqual(both[0].id, both[1].id);
    assert.notEqual(both[0].objectKey, both[1].objectKey);
    assert.deepEqual([...both].map((item) => item.sourceRevision).sort(), [6, 7]);
    const older = both.find((item) => item.sourceRevision === 6);
    assert.equal(older.current, false, 'the v1 export is no longer the current result');
    assert.equal(both.find((item) => item.sourceRevision === 7).current, true);
    const single = await harness.service.getExport(full, older.id);
    assert.equal(single.id, older.id);
    assert.equal(single.current, false);
    console.log('  repeated exports: v1 and v2 both retained, currency tracked per revision');

    // --- 3. An export rendered from a revision that moved is not the result --
    const drifting = seedProject(harness, { revision: 2,
      settings: { selectedPreset: 'MINIMAL', aspectRatio: 'SOURCE', reframePolicy: 'SOURCE',
        zoomPolicy: 'OFF', gradingPolicy: 'NONE', subtitlePolicy: 'OFF' },
      assets: [source()],
      elements: [{ id: 'dv1', assetId: 'src', type: 'VIDEO', track: 0, position: 0,
        startTime: 0, duration: 3, trimStart: 0, trimEnd: 3, properties: {} }] });
    await harness.service.startExport(drifting, 2);
    harness.rows.editProjects.get(drifting).revision = 3;   // edited mid-render
    const drifted = await settle(harness.service, drifting);
    assert.equal(drifted.phase, 'COMPLETED');
    const driftedAssets = await harness.service.listExports(drifting);
    assert.equal(driftedAssets[0].metadata.stale, true);
    assert.equal(driftedAssets[0].sourceRevision, 2);
    assert.equal(driftedAssets[0].current, false);
    assert.equal(harness.rows.editProjects.get(drifting).status, 'READY',
      'a stale export is retained but is not declared the project result');
    console.log('  stale export: retained, flagged, and not marked as the project result');

    // --- 4. A silent source exports a video-only file -----------------------
    const silent = seedProject(harness, { revision: 1,
      settings: { selectedPreset: 'MINIMAL', aspectRatio: '1:1', reframePolicy: 'AUTO',
        zoomPolicy: 'OFF', gradingPolicy: 'SUBTLE', subtitlePolicy: 'OFF' },
      assets: [assetRow('src2', 'SOURCE', 'video/mp4', 'silent.mp4', { width: 640, height: 360,
        fps: 30, metadata: { hasAudio: false }, analysis: fixtures.talkingHead() })],
      elements: [{ id: 'sv1', assetId: 'src2', type: 'VIDEO', track: 0, position: 0,
        startTime: 0, duration: 3, trimStart: 2, trimEnd: 5, properties: {} }] });
    await harness.service.startExport(silent, 1);
    const silentDone = await settle(harness.service, silent);
    assert.equal(silentDone.phase, 'COMPLETED', silentDone.message ?? '');
    const silentAsset = (await harness.service.listExports(silent))[0];
    assert.deepEqual(silentAsset.metadata.resolution, { width: 1080, height: 1080 });
    const silentProbe = probe(harness.storage.localPath(silentAsset.objectKey));
    assert(!silentProbe.streams.some((stream) => stream.codec_type === 'audio'),
      'a source with no audio exports no audio stream rather than silence');
    console.log('  silent source: 1:1 export with no fabricated audio track');

    // --- 5. Typed failures --------------------------------------------------
    const noSource = seedProject(harness, { revision: 0, status: 'DRAFT',
      settings: {}, assets: [], elements: [] });
    await assert.rejects(harness.service.startExport(noSource, 0),
      (error) => error.getResponse().code === 'SOURCE_MISSING');

    const missing = seedProject(harness, { revision: 1,
      settings: { aspectRatio: 'SOURCE', reframePolicy: 'SOURCE' },
      assets: [source()],
      elements: [{ id: 'mv1', assetId: 'src', type: 'VIDEO', track: 0, position: 0,
        startTime: 0, duration: 2, trimStart: 0, trimEnd: 2, properties: {} },
      { id: 'mi1', assetId: 'nope', type: 'IMAGE', track: 2, position: 0, startTime: 0,
        duration: 2, trimStart: 0, trimEnd: null,
        properties: { x: 0.1, y: 0.1, width: 0.2, height: 0.2, opacity: 1, zIndex: 10 } }] });
    await harness.service.startExport(missing, 1);
    const missingDone = await settle(harness.service, missing);
    assert.equal(missingDone.phase, 'FAILED');
    assert.equal(missingDone.errorCode, 'ASSET_MISSING');
    assert(missingDone.message.includes('no longer'));
    assert.equal(harness.rows.editProjects.get(missing).status, 'FAILED');
    assert.equal((await harness.service.listExports(missing)).length, 0,
      'a failed export stores no asset');

    const impossible = seedProject(harness, { revision: 1,
      settings: { aspectRatio: 'SOURCE', reframePolicy: 'SOURCE' },
      assets: [source()],
      elements: [{ id: 'iv1', assetId: 'src', type: 'VIDEO', track: 0, position: 0,
        startTime: 0, duration: 400, trimStart: 0, trimEnd: 400, properties: {} }] });
    await harness.service.startExport(impossible, 1);
    const impossibleDone = await settle(harness.service, impossible);
    assert.equal(impossibleDone.phase, 'FAILED');
    assert.equal(impossibleDone.errorCode, 'INVALID_TIMELINE');

    await assert.rejects(harness.service.startExport(full, 999),
      (error) => error.getStatus() === 409 && error.getResponse().code === 'STALE_REVISION');
    await assert.rejects(harness.service.startExport('no-such-project', 0),
      (error) => error.getStatus() === 404);
    console.log('  typed failures: SOURCE_MISSING, ASSET_MISSING, INVALID_TIMELINE, stale revision');

    // --- 6. Exporting is not an edit ---------------------------------------
    const project = harness.rows.editProjects.get(full);
    assert.equal(project.revision, 7, 'rendering never bumps the timeline revision');
    const historyActions = [...harness.rows.editHistory.values()]
      .filter((row) => row.editProjectId === full).map((row) => row.action);
    assert.deepEqual(historyActions, [],
      'an export writes no history revision, so undo/redo is untouched');
    assert(project.settings.export, 'progress is persisted on settings, not on a job row');
    assert.equal(project.settings.export.phase, 'COMPLETED');
    assert.equal(project.settings.selectedPreset, 'PODCAST_CLIP',
      'the style block survives progress writes');

    // --- 7. Isolation -------------------------------------------------------
    assert.equal(harness.rows.processingJobs.size, frozenBefore.processingJobs);
    assert.equal(harness.rows.clipCandidates.size, frozenBefore.clipCandidates);
    assert.equal(harness.rows.generatedClips.size, frozenBefore.generatedClips);
    const renderSource = fs.readFileSync(path.join(__dirname,
      '../src/modules/edit-mode/render/edit-mode-render.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
    for (const token of ['ProcessingQueueService', 'VideoProcessorService',
      'ClipSelectionService', 'ClipRenderQueueService', 'ClipExportService', 'processingJob',
      'clipCandidate', 'generatedClip', 'bullmq', '@nestjs/bull', 'LlmRouterService']) {
      assert(!renderSource.includes(token),
        `the render service must not reference ${token}`);
    }
    const controller = fs.readFileSync(path.join(__dirname,
      '../src/modules/edit-mode/edit-mode.controller.ts'), 'utf8');
    for (const route of ['projects/:id/export', 'projects/:id/exports',
      'projects/:id/exports/:assetId', 'assets/:assetId/file']) {
      assert(controller.includes(`'${route}'`), `missing EditMode route ${route}`);
    }
    assert(!/@Controller\((?!'edit-mode')/u.test(controller),
      'every export route stays under /edit-mode');
    console.log('  isolation: no frozen rows, no frozen services, routes stay under /edit-mode');

    console.log('EditMode export tests passed.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { createExportHarness, seedProject, buildMedia, settle };
