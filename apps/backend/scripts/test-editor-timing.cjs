const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');
function load(file) {
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded.require = name => name.startsWith('./') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, file);
  return loaded.exports;
}
const { trimSpan, moveSpan } = load(path.resolve(__dirname, '../../frontend/src/lib/edit-mode-timeline-gestures.ts'));
async function main() {
  const state = await seedAnalyzedProject(createHarness());
  state.rows.editAssets.get('asset-source').duration = 21.02;
  const video = [...state.rows.editElements.values()][0]; video.duration = video.trimEnd = 21.02;
  state.rows.editAssets.set('test-music', { id: 'test-music', editProjectId: state.project.id,
    role: 'AUDIO', duration: 185.28, originalName: 'music.mp3', mimeType: 'audio/mpeg' });
  let project = await state.service.get(state.project.id);
  const run = async (action, payload) => project = await state.service.phase3Command(project.id,
    action, { revision: project.revision, ...payload });
  await run('add-audio', { assetId: 'test-music', startTime: 0.69 });
  const id = project.elements.find(e => e.type === 'AUDIO').id;
  const audio = () => project.elements.find(e => e.id === id);
  const commit = async element => run('set-element-timing', { elementId: id,
    startTime: element.startTime, duration: element.duration, trimStart: element.trimStart, trimEnd: element.trimEnd });
  // Exact numerical reproduction from the reported live music edit.
  const left = trimSpan(audio(), 'left', 0, 21.02, 185.28);
  assert.equal(left.startTime, 0.69); assert.equal(left.trimStart, 0);
  assert(Math.abs(left.duration - (left.trimEnd - left.trimStart)) < 1e-8);
  await commit(left);
  await commit(trimSpan(audio(), 'left', 4, 21.02, 185.28));
  await commit(trimSpan(audio(), 'left', -20, 21.02, 185.28));
  assert(Math.abs(audio().startTime - 0.69) < 1e-8);
  await commit(moveSpan(audio(), 0, 21.02));
  await run('set-audio-trim', { elementId: id, trimStart: 180, trimEnd: 185.28 });
  await commit(trimSpan(audio(), 'right', 100, 21.02, 185.28));
  assert.equal(audio().trimEnd, 185.28);
  await run('duplicate-element', { elementId: id });
  project = await state.service.undo(project.id, project.revision);
  project = await state.service.redo(project.id, project.revision);
  await run('set-speed', { elementId: video.id, speed: 0.5 });
  for (const element of project.elements.filter(e => e.type === 'AUDIO')) assert(element.trimEnd <= 185.28 + 1e-6);
  project = await state.service.undo(project.id, project.revision);
  await run('set-audio-trim', { elementId: id, trimStart: 0, trimEnd: 20 });
  project = await state.service.splitElement(project.id, { revision: project.revision,
    elementId: video.id, playheadSec: 10 });
  project = await state.service.deleteElement(project.id, { revision: project.revision, elementId: video.id });
  assert.equal(audio().duration, 10);
  assert.equal(audio().trimStart, 10);
  assert.equal(audio().trimEnd, 20);
  assert(project.elements.every(element => element.startTime + element.duration <= 11.02 + 1e-6));
  project = await state.service.undo(project.id, project.revision);
  project = await state.service.undo(project.id, project.revision);
  // Large-timeline edits must write just the row that actually changed.
  for (let index = 0; index < 300; index++) state.rows.editElements.set(`caption-${index}`, {
    id: `caption-${index}`, editProjectId: project.id, assetId: null, type: 'SUBTITLE', track: 1,
    position: index, startTime: index / 20, duration: 0.2, trimStart: 0, trimEnd: null,
    properties: { content: 'Synthetic caption' }
  });
  const writes = { update: 0, create: 0, delete: 0 };
  for (const [method, key] of [['updateMany', 'update'], ['createMany', 'create'], ['deleteMany', 'delete']]) {
    const original = state.prisma.editElement[method];
    state.prisma.editElement[method] = async args => { writes[key]++; return original(args); };
  }
  await run('set-audio-volume', { elementId: id, volume: 0.6 });
  assert.deepEqual(writes, { update: 1, create: 0, delete: 0 });
  const full = await state.service.history(project.id);
  const compact = await state.service.history(project.id, true);
  assert.equal(full.length, compact.length); assert(compact.every(entry => !entry.beforeState && !entry.afterState));
  assert(JSON.stringify(compact).length < JSON.stringify(full).length / 3);
  await state.service.undo(project.id, project.revision);
  console.log('PASS: exact phone trim, both source bounds, move, duplicate, speed, undo/redo, 300-caption single-row persistence and compact history');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

