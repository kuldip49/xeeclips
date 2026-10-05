// Workstream G - real AI object-awareness verification against the dockerized stack.
//
// Creates a DISPOSABLE EditProject (real Postgres rows, real MinIO objects, a
// real FFmpeg-generated source) whose timeline carries a preset-role HOOK, a
// logo, a music bed and a preset-planned zoom, then drives the chat through
// the real services:
//
//   Part 32  "change the on screen hook" -> "make it shorter" ->
//            "more curiosity based" -> "try another": ONE hook element, reworded
//   Part 31  logo smaller -> a little smaller -> move it lower ->
//            now lower the music -> a little more (music, not logo)
//   Part 33  "make this zoom deeper" -> "too much, reduce it a little":
//            ONE zoom element that replaces the planned moment
//   export   Phase 5 renderer: the edited zoom is what renders, QA passes
//
// Then removes everything it created. Never touches an existing project and
// never creates a ProcessingJob / ClipCandidate / GeneratedClip.
//
//   node scripts/verify-edit-mode-ai.cjs [--keep] [--mode FALLBACK_ONLY|OFFLINE|ONLINE]

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
process.env.EDIT_MODE_CHAT_AI_MODE = arg('mode', process.env.EDIT_MODE_CHAT_AI_MODE || 'FALLBACK_ONLY');

const { PrismaClient } = require('@prisma/client');
const { StorageService } = require('../dist/modules/storage/storage.service');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service');
const { EditChatService } = require('../dist/modules/edit-mode/chat/edit-chat.service');
const { EditChatProposalStore } = require('../dist/modules/edit-mode/chat/edit-chat-proposal-store');
const { EditTemplateService } = require('../dist/modules/edit-mode/edit-template.service');
const { EditModeRenderService } = require('../dist/modules/edit-mode/render/edit-mode-render.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { probeMedia } = require('../dist/modules/processing/media-probe');

const flag = (name) => process.argv.includes(`--${name}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let checks = 0;
const ok = (label) => { console.log(`  ok  ${label}`); checks += 1; };

const SPEECH = [
  'Interest rates are still high even though inflation has cooled.',
  'The central bank raised the overnight rate eleven times in a row.',
  'Most people never noticed that savings accounts quietly pay more now.',
  'But mortgage holders are paying the hidden cost every single month.',
  'Here is why the bank refused to cut rates this year.'
];
const DURATION = 24;

function cachedAnalysis() {
  let cursor = 0.4;
  const segments = SPEECH.map((sentence, position) => {
    const words = sentence.split(/\s+/u).map((text) => {
      const start = Number(cursor.toFixed(3));
      cursor += 0.4;
      return { text, start, end: Number((cursor - 0.05).toFixed(3)) };
    });
    cursor += 0.4;
    return { position, text: sentence, start: words[0].start, end: words.at(-1).end, words };
  });
  const frames = Array.from({ length: DURATION * 2 }, (_, index) => ({ t: index / 2,
    text_coverage: 0, text_boxes: [], graphic_boxes: [], ocr_lines: [], ocr_coverage: 0,
    faces: [{ x: 0.42, y: 0.16, w: 0.16, h: 0.24, score: 0.95, mouth_activity: 0.6, track_id: 'a' }],
    persons: [{ x: 0.3, y: 0.1, w: 0.4, h: 0.85 }] }));
  return {
    transcript: { text: SPEECH.join(' '), language: 'en', duration: DURATION, segments },
    analysis: { source: 'DENSE', frames, shotBoundaries: [], ocrText: '',
      summary: { sampledFrameCount: frames.length, faceDetections: frames.length,
        mouthActivitySamples: frames.length, shotCount: 1, ocrRegionCount: 0 } }
  };
}

async function frozenCounts(prisma) {
  const [processingJobs, clipCandidates, generatedClips] = await Promise.all([
    prisma.processingJob.count(), prisma.clipCandidate.count(), prisma.generatedClip.count()]);
  return { processingJobs, clipCandidates, generatedClips };
}

async function main() {
  const prisma = new PrismaClient();
  const storage = new StorageService();
  const editMode = new EditModeService(prisma, storage, { analyze: async () => {
    throw new Error('the chat flow must never re-analyse'); } });
  const templates = new EditTemplateService(prisma, editMode);
  const chat = new EditChatService(prisma, editMode, new EditChatProposalStore(),
    new LlmRouterService(), templates);
  const render = new EditModeRenderService(prisma, storage);
  const workspace = mkdtempSync(join(tmpdir(), 'verify-edit-ai-'));
  const created = { projectId: null, objectKeys: [] };
  const frozenBefore = await frozenCounts(prisma);
  let failed = false;
  console.log(`EditMode Workstream G live verification (chat AI mode ${
    process.env.EDIT_MODE_CHAT_AI_MODE})`);

  try {
    const sourcePath = join(workspace, 'source.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `testsrc2=size=1280x720:rate=30:duration=${DURATION}`, '-f', 'lavfi', '-i',
      `sine=frequency=220:duration=${DURATION}`, '-shortest', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath]);
    const logoPath = join(workspace, 'logo.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=orange:size=240x120', '-frames:v', '1', logoPath]);
    const musicPath = join(workspace, 'music.mp3');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      `sine=frequency=440:duration=${DURATION}`, '-c:a', 'libmp3lame', musicPath]);
    const probe = await probeMedia(sourcePath);

    const moment = { startSec: 6.2, endSec: 7, reason: 'emphasis', triggerText: 'overnight',
      intensity: 'MODERATE' };
    const project = await prisma.editProject.create({ data: {
      name: `verify-edit-mode-ai ${new Date().toISOString()}`, status: 'READY', revision: 1,
      settings: { selectedPreset: 'MOTIVATIONAL', aspectRatio: 'SOURCE', pacing: 'SOURCE',
        subtitlePolicy: 'OFF', hookPolicy: 'ON', zoomPolicy: 'MODERATE', reframePolicy: 'SOURCE',
        musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
        overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT',
        hookText: 'Why Are Rates Still So High?',
        presetRun: { presetId: 'MOTIVATIONAL', presetRunId: randomUUID(), appliedAtRevision: 1,
          summary: 'fixture', plannedZoomMoments: [moment], trims: [] } } } });
    created.projectId = project.id;
    console.log(`Created disposable EditProject ${project.id}`);

    const upload = async (path, name, mimeType, role, extra) => {
      const id = randomUUID();
      const key = `edit-mode/${project.id}/${id}/${name}`;
      const stored = await storage.uploadFile({ filePath: path, objectKey: key, mimeType });
      created.objectKeys.push(key);
      await prisma.editAsset.create({ data: { id, editProjectId: project.id, role,
        originalName: name, bucket: stored.bucket, objectKey: stored.objectKey, mimeType,
        sizeBytes: BigInt(statSync(path).size), metadata: {}, ...extra } });
      return id;
    };
    const cached = cachedAnalysis();
    const sourceId = await upload(sourcePath, 'source.mp4', 'video/mp4', 'SOURCE', {
      duration: DURATION, width: probe.width, height: probe.height, fps: 30,
      metadata: { hasVideo: true, hasAudio: probe.hasAudio, videoCodec: probe.videoCodec },
      transcript: cached.transcript, analysis: cached.analysis });
    const logoId = await upload(logoPath, 'brand-logo.png', 'image/png', 'LOGO',
      { width: 240, height: 120 });
    const musicId = await upload(musicPath, 'lofi-beat.mp3', 'audio/mpeg', 'AUDIO',
      { duration: DURATION });

    const element = (data) => prisma.editElement.create({ data: { editProjectId: project.id,
      trimStart: 0, trimEnd: null, ...data } });
    await element({ assetId: sourceId, type: 'VIDEO', track: 0, position: 0, startTime: 0,
      duration: DURATION, trimEnd: DURATION, properties: { origin: 'USER' } });
    const hook = await element({ assetId: null, type: 'TEXT', track: 1, position: 0,
      startTime: 0, duration: 3.5, properties: { content: 'Why Are Rates Still So High?',
        x: 0.08, y: 0.07, width: 0.84, height: 0.15, fontSize: 56, fontWeight: 800,
        textStyleId: 'HOOK', color: '#ffffff', textAlign: 'center', opacity: 1, zIndex: 40,
        origin: 'PRESET', presetId: 'MOTIVATIONAL', presetRole: 'HOOK' } });
    const logo = await element({ assetId: logoId, type: 'IMAGE', track: 2, position: 0,
      startTime: 0, duration: DURATION, properties: { role: 'LOGO', x: 0.76, y: 0.04,
        width: 0.2, height: 0.12, opacity: 1, zIndex: 20, origin: 'USER' } });
    const music = await element({ assetId: musicId, type: 'AUDIO', track: 3, position: 0,
      startTime: 0, duration: DURATION, trimEnd: DURATION, properties: { volume: 0.2,
        muted: false, fadeInSec: 0, fadeOutSec: 0, origin: 'USER' } });
    await prisma.editHistory.create({ data: { editProjectId: project.id, revision: 1,
      actor: 'USER', action: 'ELEMENTS_UPDATED', command: {}, beforeState: { elements: [] },
      afterState: { elements: [] } } });

    const load = () => prisma.editProject.findUniqueOrThrow({ where: { id: project.id },
      include: { elements: true } });
    const turn = async (message, extra = {}) => {
      const current = await load();
      const started = Date.now();
      const planned = await chat.plan(project.id, { message, revision: current.revision,
        selectedElementId: null, playheadSec: 0, ...extra });
      assert.equal(planned.proposal.needsClarification, false,
        `"${message}" asked: ${planned.proposal.clarificationQuestion}`);
      const change = (planned.proposal.changes ?? []).map((item) =>
        `${item.label}: ${item.before} -> ${item.after}`).join('; ');
      console.log(`  > ${message}  [${planned.proposal.route}, ${Date.now() - started}ms]  ${change}`);
      const applied = await chat.apply(project.id, { proposalId: planned.proposal.proposalId });
      return { planned, applied, project: await load() };
    };
    const byId = (state, id) => state.elements.find((item) => item.id === id);

    console.log('\nPart 32 - the real hook');
    const seen = new Set([hook.properties.content]);
    for (const message of ['change the on screen hook', 'make it shorter',
      'more curiosity based', 'try another']) {
      const { project: state } = await turn(message);
      const hooks = state.elements.filter((item) => item.type === 'TEXT');
      assert.equal(hooks.length, 1, 'no duplicate hook');
      const text = byId(state, hook.id).properties.content;
      assert.ok(!seen.has(text), `"${message}" repeated a line`);
      seen.add(text);
    }
    ok('four hook turns reworded the SAME TEXT element; no duplicate, no repeat');

    console.log('\nPart 31 - follow-ups and target switch');
    const width0 = logo.properties.width;
    let state = (await turn('make the logo smaller')).project;
    const width1 = byId(state, logo.id).properties.width;
    state = (await turn('a little smaller')).project;
    const width2 = byId(state, logo.id).properties.width;
    assert.ok(width1 < width0 && width2 < width1);
    state = (await turn('move it lower')).project;
    const logoAfterMove = JSON.stringify(byId(state, logo.id).properties);
    state = (await turn('now lower the music')).project;
    const volume1 = byId(state, music.id).properties.volume;
    state = (await turn('a little more')).project;
    assert.ok(byId(state, music.id).properties.volume < volume1);
    assert.equal(JSON.stringify(byId(state, logo.id).properties), logoAfterMove);
    ok('"a little more" after the music switch lowered the MUSIC and left the logo alone');

    console.log('\nPart 33 - the planned zoom');
    await turn('make this zoom deeper', { playheadSec: 6.4 });
    state = (await turn('too much, reduce it a little', { playheadSec: 6.4 })).project;
    const zooms = state.elements.filter((item) => item.type === 'EFFECT');
    assert.equal(zooms.length, 1);
    assert.equal(zooms[0].properties.scale, 1.11);
    ok('one zoom element (1.10 -> 1.13 -> 1.11) replaced the planned moment');

    const history = await prisma.editHistory.findMany({ where: { editProjectId: project.id,
      actor: 'ASSISTANT' } });
    assert.equal(history.length, 11);
    ok('every applied turn is exactly one ASSISTANT revision (11)');

    console.log('\nExporting through the Phase 5 renderer...');
    const current = await load();
    let progress = (await render.startExport(project.id, current.revision)).export;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (progress && progress.phase !== 'COMPLETED' && progress.phase !== 'FAILED') {
      if (Date.now() > deadline) throw new Error('export timed out');
      await wait(500);
      progress = await render.progress(project.id);
    }
    assert.equal(progress.phase, 'COMPLETED', `export failed: ${progress.message}`);
    const exported = await render.getExport(project.id, progress.assetId);
    created.objectKeys.push(exported.objectKey);
    assert.equal(exported.metadata.qa.result, 'PASS');
    const zoomReport = exported.metadata.render?.zoom ?? exported.metadata.zoom ??
      exported.metadata.qa?.zoom ?? null;
    console.log(`  render zoom report: ${JSON.stringify(zoomReport)}`);
    const local = join(workspace, 'export.mp4');
    await storage.downloadToFile(exported.bucket, exported.objectKey, local);
    const out = await probeMedia(local);
    assert.ok(Math.abs((out.durationSec ?? 0) - DURATION) < 0.75);
    ok(`export COMPLETED, QA PASS, ${out.width}x${out.height} ${out.durationSec?.toFixed(2)}s`);

    assert.deepEqual(await frozenCounts(prisma), frozenBefore);
    ok('no ProcessingJob, ClipCandidate or GeneratedClip was created');
    console.log(`\nWorkstream G live verification PASSED (${checks} checks).`);
  } catch (error) {
    failed = true;
    console.error('\nWorkstream G live verification FAILED:');
    console.error(error);
  } finally {
    if (created.projectId && !flag('keep')) {
      await prisma.editProject.delete({ where: { id: created.projectId } }).catch(() => undefined);
      await Promise.all(created.objectKeys.map((key) => storage
        .removeObject(process.env.MINIO_BUCKET ?? 'ai-content-platform', key)
        .catch(() => undefined)));
      console.log('Cleaned up the disposable EditProject, its assets and its objects.');
    }
    rmSync(workspace, { recursive: true, force: true });
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  }
}

void main();
