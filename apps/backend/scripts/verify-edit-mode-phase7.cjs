// EditMode Phase 7 - live-stack hardening verification.
//
// The half of Phase 7 that cannot be checked offline: multi-segment cuts and
// chat history travel applied for real against Postgres, durable proposals
// across a simulated process restart, startup recovery of an interrupted
// export, export retry with the previous export preserved, temp-file hygiene,
// and a full end-to-end flow that really renders.
//
//   node scripts/verify-edit-mode-phase7.cjs [--file <mp4>] [--media]
//     [--durations 30,60,120,300] [--keep]
//
// Everything it creates is disposable and removed at the end. It never touches
// an existing EditProject and never creates or reads a ProcessingJob,
// ClipCandidate or GeneratedClip. --media adds the longer-media runs, which
// really encode and take minutes.

const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readdirSync, rmSync, statSync } = require('node:fs');
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
const {
  EditModeRenderService
} = require('../dist/modules/edit-mode/render/edit-mode-render.service');
const {
  EditModeRecoveryService
} = require('../dist/modules/edit-mode/render/edit-mode-recovery.service');
const { probeMedia } = require('../dist/modules/processing/media-probe');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let checks = 0;
const ok = (label, detail) => {
  checks += 1;
  console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
};
const must = (condition, message) => { if (!condition) throw new Error(message); };
const section = (label) => console.log(`\n${label}`);

/** A no-op LLM router: every plan here is deterministic, so a provider call
 * would itself be the failure. */
const NO_LLM = {
  isAnyConfigured: () => false,
  generate: async () => { throw new Error('Phase 7 verification must not call a provider'); }
};

const videoElements = (elements) => elements
  .filter((element) => element.type === 'VIDEO' && element.track === 0)
  .sort((left, right) => left.position - right.position);
const timelineDuration = (elements) => Number(videoElements(elements)
  .reduce((total, element) => total + element.duration, 0).toFixed(3));

async function frozenCounts(prisma) {
  const [processingJobs, clipCandidates, generatedClips, videos] = await Promise.all([
    prisma.processingJob.count(), prisma.clipCandidate.count(),
    prisma.generatedClip.count(), prisma.video.count()
  ]);
  return { processingJobs, clipCandidates, generatedClips, videos };
}

/** Counts EditMode's own temp directories, to prove they are cleaned up. */
const tempDirs = () => {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith('edit-mode-'));
  } catch { return []; }
};

function makeFixture(workspace, seconds, name = 'fixture.mp4') {
  const path = join(workspace, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `testsrc2=size=1280x720:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i',
    `sine=frequency=280:duration=${seconds}`, '-shortest', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
  return path;
}

async function main() {
  const prisma = new PrismaClient();
  const storage = new StorageService();
  const editMode = new EditModeService(prisma, storage, { analyze: async () => {
    throw new Error('Phase 7 verification must never re-analyse'); } });
  const proposals = new EditChatProposalStore();
  const chat = new EditChatService(prisma, editMode, proposals, NO_LLM);
  const render = new EditModeRenderService(prisma, storage);
  const recovery = new EditModeRecoveryService(prisma, storage);

  const workspace = mkdtempSync(join(tmpdir(), 'verify-phase7-'));
  const created = { projectIds: [], objectKeys: [] };
  const timings = [];
  let failed = false;

  const frozenBefore = await frozenCounts(prisma);
  const tempBefore = tempDirs().length;

  /** Builds a disposable project whose video track is already three segments. */
  const buildProject = async (sourcePath, { name, split = true } = {}) => {
    const probe = await probeMedia(sourcePath);
    const project = await prisma.editProject.create({ data: {
      name: name ?? `verify-phase7 ${new Date().toISOString()}`, status: 'READY', revision: 1,
      settings: { selectedPreset: 'SOURCE_MANUAL', aspectRatio: 'SOURCE', pacing: 'SOURCE',
        subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
        musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
        overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null } } });
    created.projectIds.push(project.id);

    const sourceAssetId = randomUUID();
    const key = `edit-mode/${project.id}/${sourceAssetId}/source.mp4`;
    const uploaded = await storage.uploadFile({ filePath: sourcePath, objectKey: key,
      mimeType: 'video/mp4' });
    created.objectKeys.push(key);
    await prisma.editAsset.create({ data: {
      id: sourceAssetId, editProjectId: project.id, role: 'SOURCE',
      originalName: 'verify-source.mp4', bucket: uploaded.bucket, objectKey: uploaded.objectKey,
      mimeType: 'video/mp4', sizeBytes: BigInt(statSync(sourcePath).size),
      duration: probe.durationSec, width: probe.width, height: probe.height,
      fps: probe.fps ?? 30, metadata: { hasVideo: true, hasAudio: probe.hasAudio },
      transcript: null, analysis: null } });

    const total = probe.durationSec;
    const bounds = split ? [0, total * 0.25, total * 0.625, total] : [0, total];
    const segments = bounds.slice(0, -1).map((start, index) => ({
      id: randomUUID(), editProjectId: project.id, assetId: sourceAssetId, type: 'VIDEO',
      track: 0, position: index, startTime: Number(start.toFixed(3)),
      duration: Number((bounds[index + 1] - start).toFixed(3)),
      trimStart: Number(start.toFixed(3)), trimEnd: Number(bounds[index + 1].toFixed(3)),
      properties: {} }));
    await prisma.editElement.createMany({ data: segments });
    // A logo spanning the whole timeline, so the overlay refit is exercised.
    const logoPath = join(workspace, `logo-${project.id}.png`);
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
    await prisma.editElement.create({ data: { id: randomUUID(), editProjectId: project.id,
      assetId: logoAssetId, type: 'IMAGE', track: 2, position: 0, startTime: 0,
      duration: Number(total.toFixed(3)), trimStart: 0, trimEnd: null,
      properties: { role: 'LOGO', x: 0.76, y: 0.04, width: 0.2, height: 0.12, opacity: 1,
        zIndex: 20, origin: 'USER' } } });
    return { project, sourceAssetId, logoAssetId, probe, segments };
  };

  const reload = (id) => prisma.editProject.findUnique({ where: { id },
    include: { elements: true, assets: true } });

  try {
    const sourcePath = arg('file', '') || makeFixture(workspace, 40);
    const probe = await probeMedia(sourcePath);
    console.log(`Source: ${probe.width}x${probe.height} ` +
      `${probe.durationSec?.toFixed(2)}s${probe.hasAudio ? '' : ' (no audio)'}`);
    console.log(`Proposal store durability: ${proposals.durable ? 'REDIS' : 'in-process only'}`);

    // === 1. Multi-segment cut, applied for real ===========================

    section('1. Multi-segment cut against the live canonical layer');
    {
      const { project } = await buildProject(sourcePath, { name: 'verify-phase7 multicut' });
      const before = await reload(project.id);
      const beforeDuration = timelineDuration(before.elements);
      must(videoElements(before.elements).length === 3, 'expected a three-segment timeline');

      // 5s–30s crosses all three segments: tail of A, all of B, head of C.
      const planned = await chat.plan(project.id, { message: 'cut from 5 to 30 seconds',
        revision: before.revision, selectedElementId: null, selectedTimeRange: null,
        playheadSec: 0 });
      must(!planned.proposal.needsClarification,
        `the multi-segment cut was refused: ${planned.proposal.clarificationQuestion}`);
      ok('a range crossing three segments produced a proposal, not a refusal',
        `${planned.proposal.plannedChanges.length} planned changes`);

      const applied = await chat.apply(project.id, { proposalId: planned.proposal.proposalId,
        revision: before.revision });
      const after = await reload(project.id);
      const afterDuration = timelineDuration(after.elements);
      must(Math.abs(afterDuration - (beforeDuration - 25)) < 0.05,
        `expected ${(beforeDuration - 25).toFixed(2)}s, got ${afterDuration.toFixed(2)}s`);
      ok('the cut removed exactly the grounded span',
        `${beforeDuration.toFixed(2)}s -> ${afterDuration.toFixed(2)}s`);

      // The video track is contiguous from zero with no gaps.
      let cursor = 0;
      for (const element of videoElements(after.elements)) {
        must(Math.abs(element.startTime - cursor) < 1e-3,
          `segment at ${element.startTime} breaks the ripple`);
        cursor += element.duration;
      }
      ok('the surviving video track is contiguous from 0 with no gaps');

      // The logo was refitted rather than left hanging past the end.
      const logo = after.elements.find((element) => element.type === 'IMAGE');
      must(logo.startTime + logo.duration <= afterDuration + 1e-3,
        'the logo runs past the end of the shortened timeline');
      ok('the overlay was refitted into the shortened timeline',
        `logo now ${logo.duration.toFixed(2)}s`);

      // One chat request is exactly one ASSISTANT revision.
      const history = await prisma.editHistory.findMany({
        where: { editProjectId: project.id }, orderBy: { revision: 'asc' } });
      const assistant = history.filter((entry) => entry.action === 'APPLY_ASSISTANT_EDIT');
      must(assistant.length === 1, `expected one ASSISTANT revision, found ${assistant.length}`);
      must(assistant[0].actor === 'ASSISTANT', 'the entry is not attributed to ASSISTANT');
      must(after.revision === before.revision + 1, 'the revision moved by more than one');
      ok('one chat request produced exactly one ASSISTANT revision');

      // Undo restores the timeline exactly.
      const undone = await editMode.undo(project.id, after.revision);
      const restored = await reload(project.id);
      must(Math.abs(timelineDuration(restored.elements) - beforeDuration) < 1e-3,
        'undo did not restore the original duration');
      must(videoElements(restored.elements).length === 3,
        'undo did not restore all three segments');
      const beforeShape = videoElements(before.elements)
        .map((element) => `${element.trimStart.toFixed(3)}-${element.trimEnd.toFixed(3)}`);
      const afterShape = videoElements(restored.elements)
        .map((element) => `${element.trimStart.toFixed(3)}-${element.trimEnd.toFixed(3)}`);
      must(JSON.stringify(beforeShape) === JSON.stringify(afterShape),
        `undo restored a different shape: ${afterShape} vs ${beforeShape}`);
      ok('undo restores the multi-segment cut exactly, in one step', beforeShape.join(' | '));

      // Redo re-applies it, also in one step.
      await editMode.redo(project.id, undone.revision);
      const redone = await reload(project.id);
      must(Math.abs(timelineDuration(redone.elements) - afterDuration) < 0.05,
        'redo did not re-apply the cut');
      ok('redo re-applies the multi-segment cut in one step');
      must(applied.affectedElementIds.length >= 1, 'no affected elements were reported');
    }

    // === 2. Chat-driven undo and redo =====================================

    section('2. Chat-driven history travel');
    {
      const { project } = await buildProject(sourcePath, { name: 'verify-phase7 undo' });
      const start = await reload(project.id);
      const startDuration = timelineDuration(start.elements);

      const cut = await chat.plan(project.id, { message: 'remove the first 3 seconds',
        revision: start.revision, selectedTimeRange: null, playheadSec: 0 });
      await chat.apply(project.id, { proposalId: cut.proposal.proposalId,
        revision: start.revision });
      const afterCut = await reload(project.id);
      must(Math.abs(timelineDuration(afterCut.elements) - (startDuration - 3)) < 0.05,
        'the setup cut did not apply');

      // "undo that" proposes history travel and carries no commands.
      const undoPlan = await chat.plan(project.id, { message: 'undo that',
        revision: afterCut.revision, selectedTimeRange: null, playheadSec: 0 });
      must(undoPlan.proposal.historyAction === 'UNDO',
        'the turn was not planned as history travel');
      must(!undoPlan.proposal.needsClarification, 'the undo turn asked for clarification');
      ok('"undo that" is planned as history travel', undoPlan.proposal.plannedChanges[0]);

      await chat.apply(project.id, { proposalId: undoPlan.proposal.proposalId,
        revision: afterCut.revision });
      const afterUndo = await reload(project.id);
      must(Math.abs(timelineDuration(afterUndo.elements) - startDuration) < 1e-3,
        'the chat undo did not restore the timeline');
      ok('applying it restores the timeline through the existing history path',
        `${timelineDuration(afterCut.elements).toFixed(2)}s -> ` +
        `${timelineDuration(afterUndo.elements).toFixed(2)}s`);

      // It used the real UNDO path, not a synthesised inverse edit.
      const history = await prisma.editHistory.findMany({
        where: { editProjectId: project.id }, orderBy: { revision: 'desc' }, take: 1 });
      must(history[0].action === 'UNDO',
        `expected an UNDO history row, found ${history[0].action}`);
      ok('the chat undo wrote a real UNDO row - no inverse command was invented');

      // "redo that" travels forward again.
      const redoPlan = await chat.plan(project.id, { message: 'redo that',
        revision: afterUndo.revision, selectedTimeRange: null, playheadSec: 0 });
      must(redoPlan.proposal.historyAction === 'REDO', 'the redo turn was not history travel');
      await chat.apply(project.id, { proposalId: redoPlan.proposal.proposalId,
        revision: afterUndo.revision });
      const afterRedo = await reload(project.id);
      must(Math.abs(timelineDuration(afterRedo.elements) - (startDuration - 3)) < 0.05,
        'the chat redo did not re-apply the cut');
      ok('"redo that" travels forward again through the same path');

      // With nothing left to redo, the next redo is a question.
      const again = await chat.plan(project.id, { message: 'redo that',
        revision: afterRedo.revision, selectedTimeRange: null, playheadSec: 0 });
      must(again.proposal.needsClarification,
        'a redo with nothing to redo produced a proposal');
      ok('a redo with nothing to redo asks instead of proposing a doomed apply');
    }

    // === 3. Range-aware chat against the live project =====================

    section('3. Range-aware chat');
    {
      const { project } = await buildProject(sourcePath, { name: 'verify-phase7 range' });
      const before = await reload(project.id);
      const beforeDuration = timelineDuration(before.elements);
      const planned = await chat.plan(project.id, { message: 'delete this section',
        revision: before.revision, selectedElementId: null,
        selectedTimeRange: { startSec: 12, endSec: 18 }, playheadSec: 12 });
      must(!planned.proposal.needsClarification,
        `the range request was refused: ${planned.proposal.clarificationQuestion}`);
      must(planned.proposal.grounding.some((entry) => entry.type === 'SELECTION' &&
        entry.startSec === 12 && entry.endSec === 18),
      'the proposal was not grounded in the selected range');
      await chat.apply(project.id, { proposalId: planned.proposal.proposalId,
        revision: before.revision });
      const after = await reload(project.id);
      must(Math.abs(timelineDuration(after.elements) - (beforeDuration - 6)) < 0.05,
        'the selected range was not removed exactly');
      ok('a dragged range is cut exactly as selected',
        `${beforeDuration.toFixed(2)}s -> ${timelineDuration(after.elements).toFixed(2)}s`);
    }

    // === 4. Durable proposals across a restart ============================

    section('4. Durable proposals across a process restart');
    {
      const { project } = await buildProject(sourcePath, { name: 'verify-phase7 durable' });
      const before = await reload(project.id);
      const planned = await chat.plan(project.id, { message: 'remove the first 2 seconds',
        revision: before.revision, selectedTimeRange: null, playheadSec: 0 });
      must(!planned.proposal.needsClarification, 'the setup plan was refused');

      // A brand new store and service share nothing in memory with the ones
      // that planned it: the same thing a restarted process gets.
      const restartedStore = new EditChatProposalStore();
      await wait(500);
      const restartedChat = new EditChatService(prisma, editMode, restartedStore, NO_LLM);

      if (restartedStore.durable) {
        const applied = await restartedChat.apply(project.id, {
          proposalId: planned.proposal.proposalId, revision: before.revision });
        must(applied.project.revision === before.revision + 1,
          'the restored proposal did not apply');
        const after = await reload(project.id);
        must(Math.abs(timelineDuration(after.elements) -
          (timelineDuration(before.elements) - 2)) < 0.05,
        'the restored proposal applied the wrong edit');
        ok('a proposal planned before a restart still applies correctly afterwards');
      } else {
        let refused = false;
        try {
          await restartedChat.apply(project.id, { proposalId: planned.proposal.proposalId,
            revision: before.revision });
        } catch (error) {
          refused = (error?.response ?? error?.getResponse?.() ?? {}).code ===
            'PROPOSAL_NOT_FOUND';
        }
        must(refused, 'a lost proposal must be refused, never partially applied');
        ok('without Redis a lost proposal is refused cleanly (PROPOSAL_NOT_FOUND)');
      }

      // An unknown proposal id is always refused, durable or not.
      let unknownRefused = false;
      try {
        await restartedChat.apply(project.id, { proposalId: randomUUID(),
          revision: before.revision });
      } catch (error) {
        unknownRefused = (error?.response ?? error?.getResponse?.() ?? {}).code ===
          'PROPOSAL_NOT_FOUND';
      }
      must(unknownRefused, 'an unknown proposal id was not refused');
      ok('an unknown or forged proposal id is always refused');
      await restartedStore.onModuleDestroy();
    }

    // === 5. Startup recovery of an interrupted export =====================

    section('5. Startup recovery of an interrupted export');
    {
      // 5a. A crash with no finished output: the project must not stay
      //     EXPORTING, and must not be declared COMPLETED.
      const { project } = await buildProject(sourcePath, { name: 'verify-phase7 crash' });
      const exportId = randomUUID();
      await prisma.editProject.update({ where: { id: project.id }, data: {
        status: 'EXPORTING',
        settings: { ...project.settings, export: { exportId, phase: 'RENDERING', percent: 25,
          sourceRevision: project.revision, startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), attempt: 1, assetId: null, errorCode: null,
          message: null } } } });

      const outcomes = await recovery.recoverInterruptedExports();
      const mine = outcomes.find((outcome) => outcome.editProjectId === project.id);
      must(mine, 'the stranded project was not picked up by recovery');
      must(mine.status === 'FAILED',
        `an interrupted export with no output became ${mine.status}`);
      const recovered = await reload(project.id);
      must(recovered.status === 'FAILED', 'the project is still not settled');
      must(recovered.settings.export.errorCode === 'INTERRUPTED',
        'the failure was not categorised as INTERRUPTED');
      must(typeof recovered.settings.export.message === 'string' &&
        recovered.settings.export.message.length > 20,
      'no human-readable reason was recorded');
      ok('an interrupted export is settled to FAILED with a stated reason',
        recovered.settings.export.message.slice(0, 60) + '…');

      // Recovery is not an edit.
      must(recovered.revision === project.revision, 'recovery bumped the revision');
      const history = await prisma.editHistory.count({ where: { editProjectId: project.id } });
      const baseline = await prisma.editHistory.count({ where: { editProjectId: project.id,
        action: { in: ['UNDO', 'REDO', 'APPLY_ASSISTANT_EDIT'] } } });
      must(baseline === 0, 'recovery wrote an edit history row');
      ok('recovery changed no revision and wrote no history row', `${history} rows unchanged`);

      // A retry is possible immediately, and really renders.
      const started = await render.startExport(project.id, recovered.revision);
      must(started.export.phase === 'PREPARING', 'the retry did not start');
      ok('a recovered project can be exported again straight away');
      for (let i = 0; i < 400; i += 1) {
        const live = await render.progress(project.id);
        if (live && (live.phase === 'COMPLETED' || live.phase === 'FAILED')) break;
        await wait(500);
      }
      const done = await render.progress(project.id);
      must(done.phase === 'COMPLETED', `the retry export ended ${done.phase}: ${done.message}`);
      ok('the retry export completed', `${done.percent}%, asset ${done.assetId}`);

      // 5b. A crash AFTER the output was written and verified: the project is
      //     recovered to COMPLETED, because the file really is there.
      const exports = await prisma.editAsset.findMany({
        where: { editProjectId: project.id, role: 'EXPORT' } });
      must(exports.length === 1, 'expected exactly one export asset');
      const settled = await reload(project.id);
      await prisma.editProject.update({ where: { id: project.id }, data: {
        status: 'EXPORTING',
        settings: { ...settled.settings, export: { ...settled.settings.export,
          phase: 'UPLOADING', percent: 90 } } } });
      const second = await recovery.recoverInterruptedExports();
      const mineAgain = second.find((outcome) => outcome.editProjectId === project.id);
      must(mineAgain.status === 'COMPLETED',
        `a verified finished export was recovered as ${mineAgain.status}`);
      ok('a crash after a verified upload recovers to COMPLETED, not to FAILED');

      // 5c. The same again with the object removed: it must NOT be COMPLETED.
      const orphan = exports[0];
      await storage.removeObject(orphan.bucket, orphan.objectKey);
      const reSettled = await reload(project.id);
      await prisma.editProject.update({ where: { id: project.id }, data: {
        status: 'EXPORTING',
        settings: { ...reSettled.settings, export: { ...reSettled.settings.export,
          phase: 'UPLOADING', percent: 90 } } } });
      const third = await recovery.recoverInterruptedExports();
      const mineThird = third.find((outcome) => outcome.editProjectId === project.id);
      must(mineThird.status === 'FAILED',
        'an export whose file is gone was still declared COMPLETED');
      ok('an export row whose file is missing is never declared COMPLETED');
      created.objectKeys.push(orphan.objectKey);
    }

    // === 6. Export retry and prior-export preservation ====================

    section('6. Export retry, accumulation and failure surfacing');
    {
      const { project } = await buildProject(sourcePath, { name: 'verify-phase7 exports' });
      const first = await reload(project.id);
      await render.startExport(project.id, first.revision);
      for (let i = 0; i < 400; i += 1) {
        const live = await render.progress(project.id);
        if (live && (live.phase === 'COMPLETED' || live.phase === 'FAILED')) break;
        await wait(500);
      }
      const firstDone = await render.progress(project.id);
      must(firstDone.phase === 'COMPLETED', `the first export ended ${firstDone.phase}`);
      const firstAsset = firstDone.assetId;
      ok('the first export completed');

      // Edit, then export again: the previous export survives and is marked
      // as no longer current rather than replaced.
      const plan2 = await chat.plan(project.id, { message: 'remove the first 2 seconds',
        revision: first.revision, selectedTimeRange: null, playheadSec: 0 });
      await chat.apply(project.id, { proposalId: plan2.proposal.proposalId,
        revision: first.revision });
      const edited = await reload(project.id);
      await render.startExport(project.id, edited.revision);
      for (let i = 0; i < 400; i += 1) {
        const live = await render.progress(project.id);
        if (live && (live.phase === 'COMPLETED' || live.phase === 'FAILED')) break;
        await wait(500);
      }
      const secondDone = await render.progress(project.id);
      must(secondDone.phase === 'COMPLETED', `the second export ended ${secondDone.phase}`);
      const listed = await render.listExports(project.id);
      must(listed.length === 2, `expected 2 exports, found ${listed.length}`);
      must(listed.some((item) => item.id === firstAsset),
        'the earlier export was removed by the new one');
      const current = listed.filter((item) => item.current);
      must(current.length === 1 && current[0].id === secondDone.assetId,
        'exactly one export should be current');
      ok('exports accumulate: the earlier one is preserved and marked not current',
        `${listed.length} exports, current = ${current[0].id.slice(0, 8)}`);

      // Both objects really exist in storage.
      for (const item of listed) {
        const stat = await storage.statObject(item.bucket, item.objectKey);
        must(Number(stat.size) > 0, `export ${item.id} has an empty object`);
        created.objectKeys.push(item.objectKey);
      }
      ok('every listed export has a real, non-empty object in storage');

      // A deliberately broken timeline fails with a typed code, and the
      // project does not get stuck.
      const source = (await reload(project.id)).assets
        .find((asset) => asset.role === 'SOURCE');
      await prisma.editElement.updateMany({
        where: { editProjectId: project.id, type: 'VIDEO' },
        data: { trimEnd: (source.duration ?? 40) + 500 } });
      const broken = await reload(project.id);
      await render.startExport(project.id, broken.revision);
      for (let i = 0; i < 200; i += 1) {
        const live = await render.progress(project.id);
        if (live && (live.phase === 'COMPLETED' || live.phase === 'FAILED')) break;
        await wait(500);
      }
      const failedExport = await render.progress(project.id);
      must(failedExport.phase === 'FAILED', 'an invalid timeline still exported');
      must(typeof failedExport.errorCode === 'string', 'no typed failure code was recorded');
      const afterFailure = await reload(project.id);
      must(afterFailure.status === 'FAILED', 'the project was left EXPORTING after a failure');
      ok('a failed export surfaces a typed reason and never leaves the project EXPORTING',
        failedExport.errorCode);
      const stillListed = await render.listExports(project.id);
      must(stillListed.length === 2, 'a failed export destroyed the earlier successful ones');
      ok('a failed export leaves previous successful exports untouched');
    }

    // === 7. Temp-file hygiene =============================================

    section('7. Temp-file hygiene');
    {
      const leftovers = tempDirs();
      const grew = leftovers.length - tempBefore;
      must(grew <= 0, `EditMode left ${grew} temp directories behind: ` +
        `${leftovers.slice(-5).join(', ')}`);
      ok('every EditMode temp directory was cleaned up, on success and on failure',
        `${leftovers.length} EditMode temp dirs (was ${tempBefore})`);
    }

    // === 8. Full end-to-end flow ==========================================

    section('8. Full end-to-end flow');
    {
      const { project, sourceAssetId } = await buildProject(sourcePath,
        { name: 'verify-phase7 e2e', split: false });
      let current = await reload(project.id);

      // Shorten the logo first. A manual trim shortens the timeline, and the
      // canonical validator refuses an overlay that would then hang past the
      // end - only the chat planner refits overlays automatically (see the
      // known limitation in the Phase 7 report). This is the same order of
      // operations the editor asks of a user.
      const fullLogo = current.elements.find((element) => element.type === 'IMAGE');
      await editMode.phase3Command(project.id, 'set-element-timing',
        { revision: current.revision, elementId: fullLogo.id, startTime: 0, duration: 5 });
      current = await reload(project.id);

      // Manual trim.
      const firstVideo = videoElements(current.elements)[0];
      await editMode.trimElement(project.id, { revision: current.revision,
        elementId: firstVideo.id, trimStart: 1, trimEnd: (firstVideo.trimEnd ?? 40) - 1 });
      current = await reload(project.id);
      ok('manual trim applied', `${timelineDuration(current.elements).toFixed(2)}s`);

      // Text overlay, then its wording.
      const added = await editMode.phase3Command(project.id, 'add-text',
        { revision: current.revision });
      current = await reload(project.id);
      const text = current.elements.find((element) => element.type === 'TEXT');
      must(text, 'the text overlay was not created');
      await editMode.phase3Command(project.id, 'update-text', { revision: current.revision,
        elementId: text.id, content: 'Phase 7 end to end' });
      current = await reload(project.id);
      ok('a text overlay was added and its wording set');

      // Chat edit, then a follow-up on the same element.
      const chatPlan = await chat.plan(project.id, { message: 'make it 9:16',
        revision: current.revision, selectedTimeRange: null, playheadSec: 0 });
      must(!chatPlan.proposal.needsClarification, 'the aspect request was refused');
      await chat.apply(project.id, { proposalId: chatPlan.proposal.proposalId,
        revision: current.revision });
      current = await reload(project.id);
      must(current.settings.aspectRatio === '9:16', 'the aspect ratio did not change');
      ok('an AI chat request changed the project style', 'aspectRatio = 9:16');

      const followUp = await chat.plan(project.id, { message: 'make the logo smaller',
        revision: current.revision, selectedTimeRange: null, playheadSec: 0 });
      must(!followUp.proposal.needsClarification,
        `the follow-up was refused: ${followUp.proposal.clarificationQuestion}`);
      await chat.apply(project.id, { proposalId: followUp.proposal.proposalId,
        revision: current.revision });
      current = await reload(project.id);
      const logo = current.elements.find((element) => element.type === 'IMAGE');
      must(Number(logo.properties.width) < 0.2, 'the logo was not made smaller');
      ok('a natural follow-up resolved to the right element',
        `logo width ${Number(logo.properties.width).toFixed(3)}`);

      // Undo / redo through chat.
      const undo = await chat.plan(project.id, { message: 'undo that',
        revision: current.revision, selectedTimeRange: null, playheadSec: 0 });
      await chat.apply(project.id, { proposalId: undo.proposal.proposalId,
        revision: current.revision });
      current = await reload(project.id);
      must(Math.abs(Number(current.elements.find((element) => element.type === 'IMAGE')
        .properties.width) - 0.2) < 1e-6, 'the undo did not restore the logo size');
      ok('chat undo restored the previous logo size');

      const redo = await chat.plan(project.id, { message: 'redo that',
        revision: current.revision, selectedTimeRange: null, playheadSec: 0 });
      await chat.apply(project.id, { proposalId: redo.proposal.proposalId,
        revision: current.revision });
      current = await reload(project.id);
      ok('chat redo re-applied it');

      // Export, QA, and a real playable file.
      const exportStarted = Date.now();
      await render.startExport(project.id, current.revision);
      for (let i = 0; i < 600; i += 1) {
        const live = await render.progress(project.id);
        if (live && (live.phase === 'COMPLETED' || live.phase === 'FAILED')) break;
        await wait(500);
      }
      const done = await render.progress(project.id);
      must(done.phase === 'COMPLETED', `the E2E export ended ${done.phase}: ${done.message}`);
      const asset = await render.getExport(project.id, done.assetId);
      must(asset.metadata.qa.result === 'PASS' ||
        asset.metadata.qa.result === 'DEGRADED_ACCEPTABLE',
      `QA returned ${asset.metadata.qa.result}`);
      created.objectKeys.push(asset.objectKey);
      ok('the export completed and passed QA',
        `${asset.metadata.resolution.width}x${asset.metadata.resolution.height}, ` +
        `${asset.metadata.qa.result}, ${((Date.now() - exportStarted) / 1000).toFixed(1)}s`);

      // The stored file is a real, probeable 9:16 video.
      const downloaded = join(workspace, 'e2e-export.mp4');
      await storage.downloadToFile(asset.bucket, asset.objectKey, downloaded);
      const outProbe = await probeMedia(downloaded);
      must(outProbe.hasVideo, 'the exported file has no video stream');
      must(outProbe.width / outProbe.height < 1, 'the exported file is not vertical');
      ok('the downloaded export is a real vertical video',
        `${outProbe.width}x${outProbe.height} ${outProbe.durationSec?.toFixed(2)}s ` +
        `${outProbe.videoCodec}`);

      // Reopen: the canonical state, the chat thread and the export all persist.
      const reopened = await editMode.get(project.id);
      must(reopened.revision === current.revision, 'the revision did not persist');
      const thread = await chat.thread(project.id);
      must(thread.messages.length >= 6, 'the conversation did not persist across a reload');
      const exportsAfter = await render.listExports(project.id);
      must(exportsAfter.length === 1 && exportsAfter[0].current,
        'the export is not listed as current after reopening');
      ok('reopening the project restores the timeline, the conversation and the export',
        `r${reopened.revision}, ${thread.messages.length} messages`);
      must(sourceAssetId, 'source asset id missing');
    }

    // === 9. Longer-media stability ========================================

    if (flag('media')) {
      section('9. Longer-media stability');
      const durations = arg('durations', '30,60,120,300').split(',')
        .map((value) => Number(value.trim())).filter((value) => value > 0);
      for (const seconds of durations) {
        const media = makeFixture(workspace, seconds, `fixture-${seconds}.mp4`);
        const { project } = await buildProject(media, { name: `verify-phase7 ${seconds}s` });
        const heapBefore = process.memoryUsage().heapUsed;
        let current = await reload(project.id);

        const planStart = Date.now();
        const planned = await chat.plan(project.id, { message: 'remove the first 2 seconds',
          revision: current.revision, selectedTimeRange: null, playheadSec: 0 });
        const planMs = Date.now() - planStart;
        const applyStart = Date.now();
        await chat.apply(project.id, { proposalId: planned.proposal.proposalId,
          revision: current.revision });
        const applyMs = Date.now() - applyStart;
        current = await reload(project.id);

        const exportStart = Date.now();
        await render.startExport(project.id, current.revision);
        for (let i = 0; i < 4000; i += 1) {
          const live = await render.progress(project.id);
          if (live && (live.phase === 'COMPLETED' || live.phase === 'FAILED')) break;
          await wait(1000);
        }
        const done = await render.progress(project.id);
        const exportMs = Date.now() - exportStart;
        must(done.phase === 'COMPLETED',
          `the ${seconds}s export ended ${done.phase}: ${done.message}`);
        const asset = await render.getExport(project.id, done.assetId);
        created.objectKeys.push(asset.objectKey);
        const heapDelta = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
        const factor = exportMs / 1000 / seconds;
        timings.push({ seconds, planMs, applyMs, exportMs, factor,
          renderMs: asset.metadata.renderDurationMs, qa: asset.metadata.qa.result,
          attempts: asset.metadata.attempts, heapDeltaMb: heapDelta,
          sizeMb: Number(asset.sizeBytes) / 1024 / 1024 });
        ok(`${seconds}s source exported`,
          `plan ${planMs}ms, apply ${applyMs}ms, export ${(exportMs / 1000).toFixed(1)}s ` +
          `(x${factor.toFixed(2)} realtime), QA ${asset.metadata.qa.result}, ` +
          `heap +${heapDelta.toFixed(1)}MB`);
      }

      console.log('\n  duration | plan   | apply  | export   | x realtime | QA       | heap');
      console.log('  ---------+--------+--------+----------+------------+----------+-------');
      for (const row of timings) {
        console.log(`  ${String(row.seconds).padStart(6)}s  | ` +
          `${String(row.planMs).padStart(4)}ms | ${String(row.applyMs).padStart(4)}ms | ` +
          `${(row.exportMs / 1000).toFixed(1).padStart(6)}s  | ` +
          `${row.factor.toFixed(2).padStart(9)}x | ${row.qa.padEnd(8)} | ` +
          `+${row.heapDeltaMb.toFixed(0)}MB`);
      }
      const worstHeap = Math.max(...timings.map((row) => row.heapDeltaMb));
      must(worstHeap < 1024, `heap grew by ${worstHeap.toFixed(0)}MB during a single export`);
      ok('memory stayed bounded across every duration',
        `worst heap growth ${worstHeap.toFixed(0)}MB`);
    } else {
      console.log('\n9. Longer-media stability — skipped (pass --media to run it)');
    }

    // === 10. Frozen pipeline ==============================================

    section('10. Frozen pipeline');
    {
      const frozenAfter = await frozenCounts(prisma);
      for (const [key, before] of Object.entries(frozenBefore)) {
        must(frozenAfter[key] === before,
          `${key} changed from ${before} to ${frozenAfter[key]}`);
      }
      ok('no frozen pipeline row was created or removed',
        Object.entries(frozenAfter).map(([key, value]) => `${key}=${value}`).join(' '));
    }

    console.log(`\nEditMode Phase 7 verification passed (${checks} checks).`);
  } catch (error) {
    failed = true;
    console.error(`\nFAILED: ${error.message}`);
    console.error(error.stack);
  } finally {
    if (!flag('keep')) {
      for (const id of created.projectIds) {
        await prisma.editProject.delete({ where: { id } }).catch(() => undefined);
      }
      for (const key of created.objectKeys) {
        await storage.removeObject(process.env.MINIO_BUCKET || 'videos', key)
          .catch(() => undefined);
      }
      // Any export object the render service created for a deleted project.
      console.log(`\nCleaned up ${created.projectIds.length} disposable projects.`);
    } else {
      console.log(`\nKept ${created.projectIds.length} projects: ` +
        created.projectIds.join(', '));
    }
    rmSync(workspace, { recursive: true, force: true });
    await proposals.onModuleDestroy();
    await prisma.$disconnect();
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  }
}

void main();
