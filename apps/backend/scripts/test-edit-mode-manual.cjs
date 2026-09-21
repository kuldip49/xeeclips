const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

const videos = (project) => project.elements.filter((element) => element.type === 'VIDEO')
  .sort((a, b) => a.position - b.position);
const assertNormalized = (project) => {
  let start = 0;
  videos(project).forEach((element, position) => {
    assert.equal(element.position, position);
    assert(Math.abs(element.startTime - start) < 1e-6, 'track 0 must be ripple-normalized');
    start += element.duration;
  });
};
const expectStatus = async (promise, status) => {
  await assert.rejects(promise, (error) => typeof error.getStatus === 'function' && error.getStatus() === status);
};

async function splitSuite() {
  const state = await seedAnalyzedProject(createHarness());
  const original = state.analyzed.elements[0];
  const split = await state.service.splitElement(state.project.id, {
    revision: state.analyzed.revision, elementId: original.id, playheadSec: 5
  });
  assert.equal(videos(split).length, 2, 'split creates two persisted rows');
  assert.deepEqual(videos(split).map((item) => [item.startTime, item.duration, item.trimStart, item.trimEnd]),
    [[0, 5, 0, 5], [5, 7.5, 5, 12.5]]);
  assert.equal(videos(split)[0].assetId, videos(split)[1].assetId);
  assertNormalized(split);
  await expectStatus(state.service.splitElement(state.project.id, {
    revision: state.analyzed.revision, elementId: original.id, playheadSec: 2
  }), 409);
  await expectStatus(state.service.splitElement(state.project.id, {
    revision: split.revision, elementId: videos(split)[0].id, playheadSec: 0
  }), 400);
  const undone = await state.service.undo(state.project.id, split.revision);
  assert.equal(videos(undone).length, 1, 'undo split restores one row');
  const redone = await state.service.redo(state.project.id, undone.revision);
  assert.equal(videos(redone).length, 2, 'redo split restores both rows');
  return { state, split: redone };
}

async function trimSuite() {
  const state = await seedAnalyzedProject(createHarness());
  const original = state.analyzed.elements[0];
  const left = await state.service.trimElement(state.project.id, {
    revision: state.analyzed.revision, elementId: original.id, trimStart: 1.5, trimEnd: 12.5
  });
  assert.deepEqual([videos(left)[0].startTime, videos(left)[0].duration, videos(left)[0].trimStart],
    [0, 11, 1.5]);
  let restored = await state.service.undo(state.project.id, left.revision);
  assert.equal(videos(restored)[0].trimStart, 0, 'undo left trim');
  restored = await state.service.redo(state.project.id, restored.revision);
  assert.equal(videos(restored)[0].trimStart, 1.5, 'redo left trim');
  const right = await state.service.trimElement(state.project.id, {
    revision: restored.revision, elementId: original.id, trimStart: 1.5, trimEnd: 10
  });
  assert.equal(videos(right)[0].duration, 8.5, 'right trim updates duration');
  const undoRight = await state.service.undo(state.project.id, right.revision);
  assert.equal(videos(undoRight)[0].trimEnd, 12.5, 'undo right trim');
  const redoRight = await state.service.redo(state.project.id, undoRight.revision);
  assert.equal(videos(redoRight)[0].trimEnd, 10, 'redo right trim');
  await expectStatus(state.service.trimElement(state.project.id, {
    revision: redoRight.revision, elementId: original.id, trimStart: -1, trimEnd: 10
  }), 400);
  await expectStatus(state.service.trimElement(state.project.id, {
    revision: redoRight.revision, elementId: original.id, trimStart: 9.99, trimEnd: 10
  }), 400);
}

async function deleteAndMoveSuite() {
  const { state, split } = await splitSuite();
  const first = videos(split)[0];
  const second = videos(split)[1];
  const deleted = await state.service.deleteElement(state.project.id, {
    revision: split.revision, elementId: first.id
  });
  assert.equal(videos(deleted).length, 1);
  assert.equal(videos(deleted)[0].id, second.id);
  assert.equal(videos(deleted)[0].startTime, 0, 'delete ripples later segments left');
  const undoDelete = await state.service.undo(state.project.id, deleted.revision);
  assert.equal(videos(undoDelete).length, 2, 'undo delete restores segment');
  const redoDelete = await state.service.redo(state.project.id, undoDelete.revision);
  assert.equal(videos(redoDelete).length, 1, 'redo delete removes segment again');

  const other = await seedAnalyzedProject(createHarness());
  let project = await other.service.splitElement(other.project.id, {
    revision: other.analyzed.revision, elementId: other.analyzed.elements[0].id, playheadSec: 4
  });
  project = await other.service.splitElement(other.project.id, {
    revision: project.revision, elementId: videos(project)[1].id, playheadSec: 8
  });
  const originalOrder = videos(project).map((item) => item.id);
  project = await other.service.moveElement(other.project.id, {
    revision: project.revision, elementId: originalOrder[2], toPosition: 0, track: 0
  });
  assert.deepEqual(videos(project).map((item) => item.id),
    [originalOrder[2], originalOrder[0], originalOrder[1]], 'move reorders persisted rows');
  assert.deepEqual(videos(project).map((item) => [item.trimStart, item.trimEnd]),
    [[8, 12.5], [0, 4], [4, 8]], 'move preserves source ranges');
  assertNormalized(project);
  const reloaded = await other.service.get(other.project.id);
  assert.deepEqual(videos(reloaded).map((item) => item.id), videos(project).map((item) => item.id),
    'timeline survives reload');
}

function frontendSuite() {
  const sourcePath = path.join(__dirname, '../../frontend/src/lib/edit-mode-timeline.ts');
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const compiled = new Module(sourcePath, module);
  compiled.filename = sourcePath;
  compiled.paths = module.paths;
  compiled._compile(output, sourcePath);
  const { resolvePreviewPosition, normalizeVideoTrack } = compiled.exports;
  const elements = [
    { id: 'a', type: 'VIDEO', track: 0, position: 0, startTime: 0, duration: 5,
      trimStart: 10, trimEnd: 15, properties: {} },
    { id: 'b', type: 'VIDEO', track: 0, position: 1, startTime: 99, duration: 5,
      trimStart: 32, trimEnd: 37, properties: {} }
  ];
  assert.equal(resolvePreviewPosition(normalizeVideoTrack(elements), 7).sourceTime, 34,
    'timeline 7 maps to source 34 through the second cut');
  const timelineSource = fs.readFileSync(path.join(__dirname,
    '../../frontend/src/components/edit-mode/edit-timeline.tsx'), 'utf8');
  assert(timelineSource.includes('onSelect(element.id)'), 'timeline segment selection is wired');
  const controllerSource = fs.readFileSync(path.join(__dirname,
    '../src/modules/edit-mode/edit-mode.controller.ts'), 'utf8');
  for (const route of ["commands/trim", "commands/split", "commands/delete", "commands/move",
    "projects/:id/undo", "projects/:id/redo"]) {
    assert(controllerSource.includes(route), `manual command route missing: ${route}`);
  }
}

async function main() {
  await splitSuite();
  await trimSuite();
  await deleteAndMoveSuite();
  frontendSuite();
  const isolation = await seedAnalyzedProject(createHarness());
  const before = [isolation.rows.processingJobs.size, isolation.rows.clipCandidates.size,
    isolation.rows.generatedClips.size];
  await isolation.service.trimElement(isolation.project.id, { revision: isolation.analyzed.revision,
    elementId: isolation.analyzed.elements[0].id, trimStart: 1, trimEnd: 12.5 });
  assert.deepEqual([isolation.rows.processingJobs.size, isolation.rows.clipCandidates.size,
    isolation.rows.generatedClips.size], before, 'manual editing cannot touch automatic-pipeline records');
  console.log('EditMode Phase 2 tests passed: selection wiring, split, trim, ripple delete, move, normalization, conflicts, undo/redo, reload, preview mapping, and isolation.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
