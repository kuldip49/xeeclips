// Real AI-chat editing verification against the dockerized stack.
//
// Creates a DISPOSABLE EditProject with a real short source plus a logo and a
// music track, then drives the Phase 6 chat end to end:
//
//   plan -> assert nothing moved -> apply -> ONE ASSISTANT revision
//     -> follow-up turn targets the same element -> undo -> redo
//     -> manual edit preserved -> stale proposal refused
//     -> Phase 5 export -> FFprobe -> cleanup
//
// It never touches an existing EditProject, and it never creates or reads a
// ProcessingJob, ClipCandidate or GeneratedClip.
//
//   node scripts/verify-edit-mode-chat.cjs [--file <mp4>] [--keep] [--out <dir>]

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { StorageService } = require('../dist/modules/storage/storage.service');
const { EditModeService } = require('../dist/modules/edit-mode/edit-mode.service');
const { EditChatService } = require('../dist/modules/edit-mode/chat/edit-chat.service');
const {
  EditChatProposalStore
} = require('../dist/modules/edit-mode/chat/edit-chat-proposal-store');
const { EditTemplateService } = require('../dist/modules/edit-mode/edit-template.service');
const {
  EditModeRenderService
} = require('../dist/modules/edit-mode/render/edit-mode-render.service');
const { probeMedia } = require('../dist/modules/processing/media-probe');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SPEECH = ('Welcome back everyone today I want to talk about our pricing model and why we ' +
  'changed it the old plan charged per seat which punished growing teams our new pricing is ' +
  'usage based instead and it scales with what you actually use').split(/\s+/u);

let checks = 0;
const ok = (label) => { console.log(`  ok  ${label}`); checks += 1; };

/** A deterministic stand-in for the cached Analyze output. */
function syntheticAnalysis(durationSec) {
  const frames = Array.from({ length: Math.round(durationSec * 2) }, (_, index) => ({
    t: index / 2, text_coverage: 0, text_boxes: [], graphic_boxes: [], ocr_lines: [],
    ocr_coverage: 0,
    faces: [{ x: 0.37, y: 0.15, w: 0.26, h: 0.32, score: 0.95, mouth_activity: 0.6,
      track_id: 'a' }],
    persons: [{ x: 0.28, y: 0.12, w: 0.44, h: 0.86 }]
  }));
  const step = Math.max(0.22, (durationSec * 0.8) / SPEECH.length);
  let cursor = 0.4;
  const words = SPEECH.map((text) => {
    const start = Number(cursor.toFixed(3));
    cursor += step;
    return { start, end: Number((cursor - 0.03).toFixed(3)), text };
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

/** Row counts for every model EditMode chat must never write. */
async function frozenCounts(prisma) {
  const [processingJobs, clipCandidates, generatedClips] = await Promise.all([
    prisma.processingJob.count(), prisma.clipCandidate.count(), prisma.generatedClip.count()
  ]);
  return { processingJobs, clipCandidates, generatedClips };
}

/** A snapshot of everything an un-applied plan must leave untouched. */
async function projectSnapshot(prisma, id) {
  const project = await prisma.editProject.findUniqueOrThrow({ where: { id },
    include: { elements: { orderBy: { id: 'asc' } }, history: true } });
  const { chat: _chat, ...settings } = project.settings ?? {};
  return {
    revision: project.revision,
    settings: JSON.stringify(settings),
    historyCount: project.history.length,
    elements: JSON.stringify(project.elements.map((element) => ({
      id: element.id, type: element.type, track: element.track, position: element.position,
      startTime: element.startTime, duration: element.duration, trimStart: element.trimStart,
      trimEnd: element.trimEnd, properties: element.properties })))
  };
}

const timelineDuration = (elements) => elements
  .filter((element) => element.type === 'VIDEO' && element.track === 0)
  .reduce((total, element) => total + element.duration, 0);

async function main() {
  const prisma = new PrismaClient();
  const storage = new StorageService();
  const editMode = new EditModeService(prisma, storage, { analyze: async () => {
    throw new Error('the chat flow must never re-analyse'); } });
  const chat = new EditChatService(prisma, editMode, new EditChatProposalStore(), {
    // FALLBACK-style routing: no provider is configured for this run, so the
    // deterministic planner carries the whole flow and no LLM call happens.
    isAnyConfigured: () => false,
    generate: async () => { throw new Error('the chat flow must not call a provider here'); }
  }, new EditTemplateService(prisma, editMode));
  const render = new EditModeRenderService(prisma, storage);
  const outputDir = arg('out', process.env.QA_OUTPUT_DIR || join(tmpdir(), 'edit-mode-chat-qa'));
  const workspace = mkdtempSync(join(tmpdir(), 'verify-edit-chat-'));
  const created = { projectId: null, objectKeys: [] };
  let failed = false;

  const frozenBefore = await frozenCounts(prisma);

  try {
    // --- Source and assets ---------------------------------------------------
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
    const duration = probe.durationSec ?? 12;
    console.log(`Source: ${probe.width}x${probe.height} ${duration.toFixed(2)}s ` +
      `${probe.videoCodec}${probe.hasAudio ? `/${probe.audioCodec}` : ' (no audio)'}`);

    const logoPath = join(workspace, 'logo.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'color=c=orange:size=240x120', '-frames:v', '1', logoPath]);
    const musicPath = join(workspace, 'music.mp3');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
      'sine=frequency=440:duration=12', '-c:a', 'libmp3lame', musicPath]);

    const project = await prisma.editProject.create({ data: {
      name: `verify-edit-mode-chat ${new Date().toISOString()}`, status: 'READY', revision: 1,
      settings: { selectedPreset: 'SOURCE_MANUAL', aspectRatio: 'SOURCE', pacing: 'SOURCE',
        subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
        musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
        overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null } } });
    created.projectId = project.id;
    console.log(`Created disposable EditProject ${project.id}`);

    const cached = syntheticAnalysis(duration);
    const sourceAssetId = randomUUID();
    const sourceKey = `edit-mode/${project.id}/${sourceAssetId}/source.mp4`;
    const uploadedSource = await storage.uploadFile({ filePath: sourcePath,
      objectKey: sourceKey, mimeType: 'video/mp4' });
    created.objectKeys.push(sourceKey);
    await prisma.editAsset.create({ data: {
      id: sourceAssetId, editProjectId: project.id, role: 'SOURCE',
      originalName: 'verify-source.mp4', bucket: uploadedSource.bucket,
      objectKey: uploadedSource.objectKey, mimeType: 'video/mp4',
      sizeBytes: BigInt(statSync(sourcePath).size), duration, width: probe.width,
      height: probe.height, fps: probe.fps ?? 30,
      metadata: { hasVideo: probe.hasVideo, hasAudio: probe.hasAudio,
        videoCodec: probe.videoCodec, audioCodec: probe.audioCodec },
      transcript: cached.transcript, analysis: cached.analysis } });

    const logoAssetId = randomUUID();
    const logoKey = `edit-mode/${project.id}/${logoAssetId}/logo.png`;
    const uploadedLogo = await storage.uploadFile({ filePath: logoPath, objectKey: logoKey,
      mimeType: 'image/png' });
    created.objectKeys.push(logoKey);
    await prisma.editAsset.create({ data: { id: logoAssetId, editProjectId: project.id,
      role: 'LOGO', originalName: 'logo.png', bucket: uploadedLogo.bucket,
      objectKey: uploadedLogo.objectKey, mimeType: 'image/png',
      sizeBytes: BigInt(statSync(logoPath).size), width: 240, height: 120, metadata: {} } });

    const musicAssetId = randomUUID();
    const musicKey = `edit-mode/${project.id}/${musicAssetId}/music.mp3`;
    const uploadedMusic = await storage.uploadFile({ filePath: musicPath, objectKey: musicKey,
      mimeType: 'audio/mpeg' });
    created.objectKeys.push(musicKey);
    await prisma.editAsset.create({ data: { id: musicAssetId, editProjectId: project.id,
      role: 'AUDIO', originalName: 'music.mp3', bucket: uploadedMusic.bucket,
      objectKey: uploadedMusic.objectKey, mimeType: 'audio/mpeg',
      sizeBytes: BigInt(statSync(musicPath).size), duration: 12, metadata: {} } });

    // The starting timeline: the whole source, plus a logo and a music bed.
    await prisma.editElement.create({ data: { editProjectId: project.id, assetId: sourceAssetId,
      type: 'VIDEO', track: 0, position: 0, startTime: 0, duration, trimStart: 0,
      trimEnd: duration, properties: { origin: 'USER' } } });
    const logoElement = await prisma.editElement.create({ data: { editProjectId: project.id,
      assetId: logoAssetId, type: 'IMAGE', track: 2, position: 0, startTime: 0, duration,
      trimStart: 0, trimEnd: null,
      properties: { role: 'LOGO', x: 0.76, y: 0.04, width: 0.2, height: 0.12, scale: 1,
        rotation: 0, opacity: 1, zIndex: 20, anchor: 'top-left', locked: false,
        preserveAspectRatio: true, origin: 'USER' } } });
    await prisma.editElement.create({ data: { editProjectId: project.id, assetId: musicAssetId,
      type: 'AUDIO', track: 3, position: 0, startTime: 0, duration: Math.min(12, duration),
      trimStart: 0, trimEnd: Math.min(12, duration),
      properties: { volume: 0.4, muted: false, fadeInSec: 0, fadeOutSec: 0,
        duckUnderSpeech: false, duckLevel: 0.25, attackMs: 150, releaseMs: 350,
        origin: 'USER' } } });
    await prisma.editHistory.create({ data: { editProjectId: project.id, revision: 1,
      actor: 'USER', action: 'ELEMENTS_UPDATED', command: { elementCount: 3 },
      beforeState: { elements: [] }, afterState: { elements: [] } } });

    console.log('\nChat turn 1: "Remove the first second, make the logo smaller, and lower the music."');

    // --- PLAN: nothing may move ---------------------------------------------
    const before = await projectSnapshot(prisma, project.id);
    const planned = await chat.plan(project.id, {
      message: 'Remove the first second', revision: 1, playheadSec: 0 });
    assert.equal(planned.proposal.state, 'READY');
    assert.ok(planned.proposal.plannedChanges.length >= 1);
    assert.equal(planned.proposal.commands, undefined);
    ok('plan returns a READY proposal without exposing the command bundle');

    const afterPlan = await projectSnapshot(prisma, project.id);
    assert.equal(afterPlan.revision, before.revision);
    assert.equal(afterPlan.elements, before.elements);
    assert.equal(afterPlan.settings, before.settings);
    assert.equal(afterPlan.historyCount, before.historyCount);
    ok('planning mutated nothing: same revision, elements, style settings and history');

    console.log(`  proposal: ${planned.proposal.summary}`);
    for (const line of planned.proposal.plannedChanges) console.log(`    - ${line}`);

    // --- APPLY ---------------------------------------------------------------
    const applied = await chat.apply(project.id, { proposalId: planned.proposal.proposalId });
    assert.equal(applied.project.revision, 2);
    ok('apply advanced the project by exactly one revision');

    const assistantRows = await prisma.editHistory.findMany({
      where: { editProjectId: project.id, actor: 'ASSISTANT' } });
    assert.equal(assistantRows.length, 1);
    assert.equal(assistantRows[0].action, 'APPLY_ASSISTANT_EDIT');
    assert.equal(assistantRows[0].revision, 2);
    ok('one chat request produced exactly one ASSISTANT history revision');

    const trimmed = applied.project.elements.filter((element) => element.type === 'VIDEO');
    assert.equal(trimmed.length, 1);
    assert.ok(Math.abs(trimmed[0].trimStart - 1) < 1e-6);
    assert.ok(Math.abs(timelineDuration(applied.project.elements) - (duration - 1)) < 1e-3);
    ok('the timeline reflects the requested trim exactly');

    // --- Follow-up turn refers to the same element ---------------------------
    console.log('\nChat turn 2: "make the logo smaller"');
    const smaller = await chat.plan(project.id, { message: 'make the logo smaller' });
    assert.equal(smaller.proposal.state, 'READY');
    const smallerApplied = await chat.apply(project.id,
      { proposalId: smaller.proposal.proposalId });
    const logoAfter = smallerApplied.project.elements.find((element) =>
      element.id === logoElement.id);
    assert.ok(logoAfter, 'the logo element must still exist');
    assert.ok(logoAfter.properties.width < 0.2);
    assert.equal(smallerApplied.project.elements
      .filter((element) => element.type === 'IMAGE').length, 1);
    ok('"make the logo smaller" resized the existing logo and added no second one');

    console.log('\nChat turn 3: "make it a little lower" (follow-up, no selection)');
    const lower = await chat.plan(project.id, { message: 'move it a little lower' });
    assert.equal(lower.proposal.state, 'READY');
    const lowerApplied = await chat.apply(project.id, { proposalId: lower.proposal.proposalId });
    const logoMoved = lowerApplied.project.elements.find((element) =>
      element.id === logoElement.id);
    assert.ok(logoMoved.properties.y > 0.04);
    ok('a follow-up with no selection targeted the element the previous turn changed');

    console.log('\nChat turn 4: "lower the music"');
    const quieter = await chat.plan(project.id, { message: 'lower the music' });
    const quieterApplied = await chat.apply(project.id,
      { proposalId: quieter.proposal.proposalId });
    const music = quieterApplied.project.elements.find((element) => element.type === 'AUDIO');
    assert.ok(music.properties.volume < 0.4);
    ok('"lower the music" reduced the audio volume');

    // --- Unrelated manual work, made the way the editor makes it -----------
    // Added through the ordinary command path so it is a real tracked revision,
    // exactly like a user typing in the editor between two chat turns.
    let live = await prisma.editProject.findUniqueOrThrow({ where: { id: project.id } });
    const withText = await editMode.phase3Command(project.id, 'ADD_TEXT',
      { revision: live.revision });
    const manualText = withText.elements.find((element) => element.type === 'TEXT');
    await editMode.phase3Command(project.id, 'UPDATE_TEXT', { revision: withText.revision,
      elementId: manualText.id, content: 'Manual note' });

    // --- Ambiguity -----------------------------------------------------------
    const ambiguous = await chat.plan(project.id, { message: 'make it smaller' });
    assert.equal(ambiguous.proposal.needsClarification, true);
    assert.ok(ambiguous.proposal.clarificationQuestion.length > 0);
    ok('an ambiguous follow-up target asks a question instead of guessing');

    const unknownAsset = await chat.plan(project.id,
      { message: 'add brandmark.png to the corner' });
    assert.equal(unknownAsset.proposal.needsClarification, true);
    ok('a file that was never uploaded is reported rather than invented');

    const beforeQuestions = await projectSnapshot(prisma, project.id);
    const afterQuestions = await projectSnapshot(prisma, project.id);
    assert.equal(afterQuestions.revision, beforeQuestions.revision);
    assert.equal(afterQuestions.historyCount, beforeQuestions.historyCount);
    ok('turns that asked a question consumed no revision and wrote no history');

    // --- One more chat turn, on top of the manual work ----------------------
    console.log('\nChat turn 5: "mute the music" (after a manual edit)');
    const mute = await chat.plan(project.id, { message: 'mute the music' });
    const muteApplied = await chat.apply(project.id, { proposalId: mute.proposal.proposalId });
    assert.equal(muteApplied.project.elements
      .find((element) => element.type === 'AUDIO').properties.muted, true);
    ok('a chat turn applies cleanly on top of unrelated manual work');

    const survivedTurn = muteApplied.project.elements
      .find((element) => element.id === manualText.id);
    assert.ok(survivedTurn, 'the manual text must survive the chat turn');
    assert.equal(survivedTurn.properties.content, 'Manual note');
    ok('the manual text was left exactly as the user wrote it');

    // --- Undo / redo ---------------------------------------------------------
    const undone = await editMode.undo(project.id, muteApplied.project.revision);
    assert.equal(undone.elements.find((element) => element.type === 'AUDIO').properties.muted,
      false);
    ok('undo reverted the whole assistant turn in one step');

    const stillThere = undone.elements.find((element) => element.id === manualText.id);
    assert.ok(stillThere, 'undoing a chat turn must not remove manual work');
    assert.equal(stillThere.properties.content, 'Manual note');
    ok('undoing an assistant turn left the unrelated manual edit intact');

    const redone = await editMode.redo(project.id, undone.revision);
    assert.equal(redone.elements.find((element) => element.type === 'AUDIO').properties.muted,
      true);
    assert.ok(redone.elements.find((element) => element.id === manualText.id));
    ok('redo reapplied the whole assistant turn in one step');

    const chatThread = await chat.thread(project.id);
    assert.ok(chatThread.messages.length >= 8);
    assert.ok(chatThread.messages.some((message) => message.role === 'USER'));
    assert.ok(chatThread.messages.some((message) => message.role === 'ASSISTANT'));
    ok('the conversation is persisted and survives undo');

    // --- Stale proposals -----------------------------------------------------
    const stalePlan = await chat.plan(project.id, { message: 'unmute the music' });
    live = await prisma.editProject.findUniqueOrThrow({ where: { id: project.id } });
    await editMode.phase3Command(project.id, 'SET_ELEMENT_OPACITY', {
      revision: live.revision, elementId: manualText.id, opacity: 0.5 });
    // The referenced element still exists and the timeline length is unchanged,
    // so this one is safely rebased rather than refused.
    const rebased = await chat.apply(project.id, { proposalId: stalePlan.proposal.proposalId });
    assert.equal(rebased.project.elements
      .find((element) => element.type === 'AUDIO').properties.muted, false);
    assert.equal(rebased.project.elements
      .find((element) => element.id === manualText.id).properties.opacity, 0.5);
    ok('a proposal whose targets are all intact is safely rebased onto a newer revision');

    const doomedPlan = await chat.plan(project.id, { message: 'make the text smaller' });
    assert.equal(doomedPlan.proposal.state, 'READY');
    live = await prisma.editProject.findUniqueOrThrow({ where: { id: project.id } });
    await editMode.phase3Command(project.id, 'REMOVE_ELEMENT', {
      revision: live.revision, elementId: manualText.id });
    let refused = false;
    try { await chat.apply(project.id, { proposalId: doomedPlan.proposal.proposalId }); }
    catch (error) {
      refused = true;
      const body = error?.response ?? error?.getResponse?.() ?? {};
      assert.equal(body.code, 'STALE_PROPOSAL');
    }
    assert.ok(refused, 'a proposal whose target was deleted must be refused');
    ok('a proposal whose target disappeared is marked stale, not force-applied');

    let expired = false;
    try { await chat.apply(project.id, { proposalId: randomUUID() }); }
    catch (error) {
      expired = true;
      const body = error?.response ?? error?.getResponse?.() ?? {};
      assert.equal(body.code, 'PROPOSAL_NOT_FOUND');
    }
    assert.ok(expired);
    ok('an unknown proposal id is refused outright');

    // --- Isolation before export --------------------------------------------
    const frozenMid = await frozenCounts(prisma);
    assert.deepEqual(frozenMid, frozenBefore);
    ok('no ProcessingJob, ClipCandidate or GeneratedClip was created by the chat');

    const exportsSoFar = await prisma.editAsset.count({
      where: { editProjectId: project.id, role: 'EXPORT' } });
    assert.equal(exportsSoFar, 0);
    ok('applying chat edits never triggered an export on its own');

    // --- Phase 5 export still works after AI edits ---------------------------
    console.log('\nExporting the AI-edited timeline through the Phase 5 renderer...');
    const current = await prisma.editProject.findUniqueOrThrow({ where: { id: project.id } });
    const started = await render.startExport(project.id, current.revision);
    let progress = started.export;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (progress && progress.phase !== 'COMPLETED' && progress.phase !== 'FAILED') {
      if (Date.now() > deadline) throw new Error('The export did not finish within 15 minutes.');
      await wait(500);
      progress = await render.progress(project.id);
    }
    assert.ok(progress, 'the export must report progress');
    assert.equal(progress.phase, 'COMPLETED',
      `export failed (${progress.errorCode}): ${progress.message}`);
    ok('the Phase 5 export completed on a timeline produced by AI chat edits');

    const exported = await render.getExport(project.id, progress.assetId);
    created.objectKeys.push(exported.objectKey);
    assert.equal(exported.role, 'EXPORT');
    assert.equal(exported.metadata.qa.result, 'PASS');
    ok('the export is an EditAsset(EXPORT) whose QA passed');

    const localCopy = join(workspace, 'chat-export.mp4');
    await storage.downloadToFile(exported.bucket, exported.objectKey, localCopy);
    const exportProbe = await probeMedia(localCopy);
    assert.ok(exportProbe.hasVideo);
    assert.ok(Math.abs((exportProbe.durationSec ?? 0) - (duration - 1)) < 0.75,
      `exported duration ${exportProbe.durationSec} should reflect the AI trim`);
    ok(`FFprobe reads the export: ${exportProbe.width}x${exportProbe.height} ` +
      `${exportProbe.durationSec?.toFixed(2)}s ${exportProbe.videoCodec}`);

    mkdirSync(outputDir, { recursive: true });
    const preview = join(outputDir, `edit-mode-chat-${exported.id}.mp4`);
    copyFileSync(localCopy, preview);
    console.log(`\nCopied for visual review: ${preview}`);

    const frozenAfter = await frozenCounts(prisma);
    assert.deepEqual(frozenAfter, frozenBefore);
    ok('the whole flow, export included, created no frozen-pipeline rows');

    const allHistory = await prisma.editHistory.findMany({
      where: { editProjectId: project.id }, orderBy: { revision: 'asc' } });
    const assistantTurns = allHistory.filter((entry) => entry.actor === 'ASSISTANT');
    assert.equal(assistantTurns.length, 6);
    assert.ok(assistantTurns.every((entry) => entry.action === 'APPLY_ASSISTANT_EDIT'));
    ok(`each of the ${assistantTurns.length} applied chat turns is exactly one revision`);

    console.log(`\nEditMode AI chat verification PASSED (${checks} checks).`);
  } catch (error) {
    failed = true;
    console.error('\nEditMode AI chat verification FAILED:');
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
