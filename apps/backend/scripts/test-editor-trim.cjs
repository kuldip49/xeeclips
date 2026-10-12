// Canonical VIDEO trim: one source range, everything else keeps its place against the CONTENT.
// Offline: in-memory harness, no database, storage, accounts or AI calls.
const assert = require('node:assert/strict');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

const near = (actual, expected, label) =>
  assert(Math.abs(actual - expected) < 1e-4, `${label}: expected ${expected}, got ${actual}`);

async function main() {
  const state = await seedAnalyzedProject(createHarness());
  state.rows.editAssets.set('test-music', { id: 'test-music', editProjectId: state.project.id,
    role: 'AUDIO', duration: 60, originalName: 'music.mp3', mimeType: 'audio/mpeg' });
  let project = await state.service.get(state.project.id);
  const run = async (action, payload) => project = await state.service.phase3Command(project.id,
    action, { revision: project.revision, ...payload });
  const trim = async (payload) => project = await state.service.trimElement(project.id,
    { revision: project.revision, ...payload });
  const byId = (id) => project.elements.find((element) => element.id === id);
  const video = project.elements.find((element) => element.type === 'VIDEO');
  assert.equal(video.duration, 12.5);

  // A caption, a text, a zoom, an image-like overlay window and a music bed, all in timeline seconds.
  await run('add-text', { text: 'early', startTime: 0, duration: 2 });
  const early = project.elements.filter((element) => element.type === 'TEXT').at(-1);
  await run('set-element-timing', { elementId: early.id, startTime: 0.5, duration: 1.5 });
  await run('add-text', { text: 'middle', startTime: 0, duration: 2 });
  const middle = project.elements.filter((element) => element.type === 'TEXT').at(-1);
  await run('set-element-timing', { elementId: middle.id, startTime: 5, duration: 2 });
  await run('add-text', { text: 'late', startTime: 0, duration: 2 });
  const late = project.elements.filter((element) => element.type === 'TEXT').at(-1);
  await run('set-element-timing', { elementId: late.id, startTime: 10, duration: 2 });
  await run('add-zoom', { startTime: 6, duration: 2, scale: 1.1 });
  const zoom = project.elements.find((element) => element.type === 'EFFECT');
  await run('add-audio', { assetId: 'test-music', startTime: 0 });
  const music = project.elements.find((element) => element.type === 'AUDIO');
  assert.equal(music.duration, 12.5);

  // ---- Trim ~3 s off the head and ~2 s off the tail --------------------------------------------
  await trim({ elementId: video.id, trimStart: 3, trimEnd: 10.5 });
  near(byId(video.id).duration, 7.5, 'video length');
  assert.equal(byId(video.id).trimStart, 3); assert.equal(byId(video.id).trimEnd, 10.5);
  // Content-anchored: shifted by the 3 s head cut, NEVER scaled by 7.5/12.5.
  assert.equal(byId(early.id), undefined, 'a caption wholly inside the cut head is removed');
  near(byId(middle.id).startTime, 2, 'middle caption start'); near(byId(middle.id).duration, 2, 'middle caption length');
  near(byId(zoom.id).startTime, 3, 'zoom start'); near(byId(zoom.id).duration, 2, 'zoom length');
  // 10-12 s on a clip now ending at source 10.5: only the first half-second survives, clipped.
  near(byId(late.id).startTime, 7, 'late caption start'); near(byId(late.id).duration, 0.5, 'late caption clipped at the tail');
  // Music keeps playing the same moment of the song under the same moment of the footage.
  near(byId(music.id).startTime, 0, 'music start'); near(byId(music.id).duration, 7.5, 'music length');
  near(byId(music.id).trimStart, 3, 'music read window advances by the removed prefix');
  near(byId(music.id).trimEnd, 10.5, 'music read window end');
  const trimmed = project;

  // ---- Undo restores EXACTLY, Redo re-applies exactly -------------------------------------------
  project = await state.service.undo(project.id, project.revision);
  near(byId(video.id).duration, 12.5, 'undo video length');
  near(byId(early.id).startTime, 0.5, 'undo early'); near(byId(late.id).startTime, 10, 'undo late');
  near(byId(zoom.id).startTime, 6, 'undo zoom'); near(byId(music.id).trimStart, 0, 'undo music');
  project = await state.service.redo(project.id, project.revision);
  assert.deepEqual(project.elements.map((e) => [e.id, e.startTime, e.duration, e.trimStart, e.trimEnd]).sort(),
    trimmed.elements.map((e) => [e.id, e.startTime, e.duration, e.trimStart, e.trimEnd]).sort(), 'redo is exact');

  // ---- Extending the head again restores footage; layers keep their content ---------------------
  await trim({ elementId: video.id, trimStart: 1, trimEnd: 10.5 });
  near(byId(video.id).duration, 9.5, 'extended length');
  near(byId(middle.id).startTime, 4, 'middle after head extended by 2'); near(byId(zoom.id).startTime, 5, 'zoom follows');
  near(byId(music.id).startTime, 2, 'music follows the footage when the head grows');

  // ---- Refusals are plain-worded and leave the project untouched --------------------------------
  const revision = project.revision;
  for (const [payload, pattern] of [
    [{ trimStart: 6, trimEnd: 5 }, /trim start must be before the trim end/],
    [{ trimStart: 5, trimEnd: 5.01 }, /shorter than/],
    [{ trimStart: -1, trimEnd: 5 }, /before the beginning/],
    [{ trimStart: 1, trimEnd: 99 }, /beyond the end of the source/]]) {
    await assert.rejects(state.service.trimElement(project.id, { revision, elementId: video.id, ...payload }),
      (error) => pattern.test(JSON.stringify(error.getResponse?.() ?? error.message)));
  }
  assert.equal((await state.service.get(project.id)).revision, revision, 'a refused trim stores nothing');

  // ---- Split, then trim ONE segment: layers on the other segment only shift ---------------------
  project = await state.service.splitElement(project.id, { revision: project.revision,
    elementId: video.id, playheadSec: 4 });
  const [first, second] = project.elements.filter((e) => e.type === 'VIDEO').sort((a, b) => a.position - b.position);
  const lateStart = byId(middle.id)?.startTime, zoomStart = byId(zoom.id)?.startTime;
  await trim({ elementId: first.id, trimStart: first.trimStart + 1, trimEnd: first.trimEnd });
  const afterSplitTrim = project.elements.filter((e) => e.type === 'VIDEO').sort((a, b) => a.position - b.position);
  near(afterSplitTrim[0].duration, first.duration - 1, 'first segment shortened');
  near(afterSplitTrim[1].startTime, second.startTime - 1, 'second segment slides left');
  near(byId(zoom.id).startTime, zoomStart - 1, 'a zoom on the second segment shifts, it is not scaled');
  near(byId(zoom.id).duration, 2, 'zoom length unchanged');
  if (lateStart !== undefined && byId(middle.id)) near(byId(middle.id).startTime, lateStart - 1, 'caption shift');

  // ---- Generated-clip lineage follows the trim; the original choice stays for audit -------------
  const row = state.rows.editProjects.get(project.id);
  const outerNow = [Math.min(...project.elements.filter((e) => e.type === 'VIDEO').map((e) => e.trimStart)),
    Math.max(...project.elements.filter((e) => e.type === 'VIDEO').map((e) => e.trimEnd))];
  const lineage = { schemaVersion: 1, originKind: 'GENERATED_CLIP', sourceMode: 'ORIGINAL_VIDEO',
    generatedClipId: 'clip-1', originalVideoId: 'video-1', clipCandidateId: null,
    generatedStart: 100, generatedEnd: 112.5, generatedDuration: 12.5, currentSourceStart: outerNow[0],
    currentSourceEnd: outerNow[1], processingType: 'NORMAL', variantKey: 'v', aspectRatio: '9:16',
    targetPlatform: null };
  state.rows.editProjects.set(project.id, { ...row, settings: { ...row.settings, origin: lineage } });
  const videos = () => project.elements.filter((e) => e.type === 'VIDEO' && e.track === 0)
    .sort((a, b) => a.position - b.position);
  const outerStart = Math.min(...videos().map((e) => e.trimStart));
  await trim({ elementId: videos()[0].id, trimStart: outerStart + 0.5, trimEnd: videos()[0].trimEnd });
  let origin = (await state.service.get(project.id)).settings.origin;
  near(origin.currentSourceStart, outerStart + 0.5, 'currentSourceStart follows the handle');
  near(origin.currentSourceEnd, Math.max(...videos().map((e) => e.trimEnd)), 'currentSourceEnd follows');
  assert.equal(origin.generatedStart, 100); assert.equal(origin.generatedEnd, 112.5);
  project = await state.service.undo(project.id, project.revision);
  origin = (await state.service.get(project.id)).settings.origin;
  near(origin.currentSourceStart, outerStart, 'undo restores the lineage with the trim');
  project = await state.service.redo(project.id, project.revision);
  origin = (await state.service.get(project.id)).settings.origin;
  near(origin.currentSourceStart, outerStart + 0.5, 'redo re-applies it');
  // ---- Styled projects: the preview's camera path / frame segments follow the footage -----------
  {
    const row2 = state.rows.editProjects.get(project.id);
    const total = videos().reduce((sum, e) => sum + e.duration, 0);
    const path = Array.from({ length: Math.ceil(total) + 1 }, (_, i) => ({ t: Math.min(i, total), x: Math.min(i, total) / 100, y: 0, w: 0.5, h: 1 }));
    state.rows.editProjects.set(project.id, { ...row2, settings: { ...row2.settings, resolvedVisualLayout: {
      version: 1, editingProfile: 'AUTOMATIC_2', cameraPath: path,
      frameSegments: [{ startSec: 0, endSec: total / 2, layout: 'FILL' }, { startSec: total / 2, endSec: total, layout: 'FIT' }] } } });
    project = await state.service.get(project.id);
    const first = videos()[0];
    // Head trim of 1.5 s on the first segment: the camera that used to be at timeline 5 s is at 3.5 s.
    await trim({ elementId: first.id, trimStart: first.trimStart + 1.5, trimEnd: first.trimEnd });
    const layout = (await state.service.get(project.id)).settings.resolvedVisualLayout;
    const at = (t) => layout.cameraPath.find((key) => Math.abs(key.t - t) < 1e-3);
    assert(at(3.5), 'a keyframe followed its footage to 3.5 s');
    near(at(3.5).x, 0.05, 'and kept the camera it had at old timeline 5 s');
    near(layout.cameraPath[0].t, 0, 'the new first edge is a keyframe'); near(layout.cameraPath[0].x, 0.015, 'taking the camera the old path had at the cut point');
    assert(layout.cameraPath.every((key) => key.t >= -1e-6), 'no keyframe is left before the new start');
    assert(layout.frameSegments[0].startSec === 0 && layout.frameSegments.at(-1).endSec > 0, 'frame segments still cover the timeline');
    // Undo restores the old path exactly with the old trim.
    project = await state.service.undo(project.id, project.revision);
    const restored = (await state.service.get(project.id)).settings.resolvedVisualLayout;
    assert.deepEqual(restored.cameraPath, path, 'undo restores the original camera path');
    project = await state.service.redo(project.id, project.revision);
  }
  console.log('trim: content-anchored retiming, undo/redo, refusals, split segment: PASS');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
