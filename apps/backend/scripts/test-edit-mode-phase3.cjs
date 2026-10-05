const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

const expectStatus = async (promise, status) => assert.rejects(promise,
  (error) => typeof error.getStatus === 'function' && error.getStatus() === status);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function wav(seconds = 1, rate = 8000) {
  const samples = Math.floor(seconds * rate); const dataSize = samples * 2;
  const out = Buffer.alloc(44 + dataSize); out.write('RIFF'); out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8); out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(dataSize, 40);
  return out;
}
const file = (originalname, mimetype, buffer) => ({ originalname, mimetype, buffer, size: buffer.length });

function frontendSuite() {
  const sourcePath = path.join(__dirname, '../../frontend/src/lib/edit-mode-timeline.ts');
  const output = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const compiled = new Module(sourcePath, module); compiled.filename = sourcePath;
  compiled.paths = module.paths; compiled._compile(output, sourcePath);
  const elements = [
    { id: 'early', type: 'TEXT', startTime: 1, duration: 2, properties: { zIndex: 30 } },
    { id: 'back', type: 'IMAGE', startTime: 0, duration: 5, properties: { zIndex: 10 } },
    { id: 'late', type: 'AUDIO', startTime: 4, duration: 1, properties: {} }
  ];
  assert.deepEqual(compiled.exports.elementsAtTime(elements, 2).map((item) => item.id),
    ['back', 'early'], 'visibility is time-based and zIndex sorted');
  const preview = fs.readFileSync(path.join(__dirname,
    '../../frontend/src/components/edit-mode/edit-preview.tsx'), 'utf8');
  // Preview gestures stay a typed union. Workstream C widened it with 'rotate',
  // so this pins the two Phase 3 gestures rather than the whole union.
  assert(preview.includes("'move' | 'resize'"));
  assert(preview.includes('onPointerUp') || preview.includes("addEventListener('pointerup'"));
}

async function main() {
  frontendSuite();
  const state = await seedAnalyzedProject(createHarness());
  state.service.probeAssetMedia = async (path) => path.endsWith('.wav')
    ? { hasVideo: false, hasAudio: true, videoCodec: null, audioCodec: 'pcm_s16le',
      videoStreamIndex: null, audioStreamIndex: 0, durationSec: 1, formatName: 'wav', fps: undefined,
      width: null, height: null, bitrate: 128000n }
    : { hasVideo: true, hasAudio: false, videoCodec: 'png', audioCodec: null,
      videoStreamIndex: 0, audioStreamIndex: null, durationSec: null, formatName: 'image2', fps: 25,
      width: 1, height: 1, bitrate: undefined };
  let revision = state.analyzed.revision;
  await expectStatus(state.service.uploadAsset(state.project.id,
    file('bad.exe', 'application/octet-stream', Buffer.from('bad')), 'IMAGE', revision), 400);
  const imageUpload = await state.service.uploadAsset(state.project.id,
    file('photo.png', 'image/png', png), 'IMAGE', revision); revision = imageUpload.revision;
  const logoUpload = await state.service.uploadAsset(state.project.id,
    file('logo.png', 'image/png', png), 'LOGO', revision); revision = logoUpload.revision;
  const audioBuffer = wav();
  const audioUpload = await state.service.uploadAsset(state.project.id,
    file('music.wav', 'audio/wav', audioBuffer), 'AUDIO', revision); revision = audioUpload.revision;
  assert(imageUpload.asset.objectKey.includes(`/assets/${imageUpload.asset.id}/`));
  assert.equal(logoUpload.asset.role, 'LOGO'); assert(audioUpload.asset.duration > 0);

  let project = await state.service.get(state.project.id);
  const run = async (action, payload = {}) => {
    project = await state.service.phase3Command(state.project.id, action,
      { revision: project.revision, ...payload }); return project;
  };
  await run('add-image', { assetId: imageUpload.asset.id });
  const image = project.elements.find((item) => item.assetId === imageUpload.asset.id);
  assert(image && image.type === 'IMAGE');
  project = await state.service.undo(state.project.id, project.revision);
  assert(!project.elements.some((item) => item.id === image.id), 'undo add removes overlay');
  project = await state.service.redo(state.project.id, project.revision);
  assert(project.elements.some((item) => item.id === image.id), 'redo add restores same overlay');
  await run('add-logo', { assetId: logoUpload.asset.id });
  await run('add-text');
  await run('add-audio', { assetId: audioUpload.asset.id });
  const text = project.elements.find((item) => item.type === 'TEXT');
  const audio = project.elements.find((item) => item.type === 'AUDIO');
  assert.equal(project.elements.find((item) => item.assetId === logoUpload.asset.id).properties.role, 'LOGO');
  assert(text && audio); assert.equal(audio.properties.volume, 0.25);

  await run('move-element', { elementId: image.id, x: 0.1, y: 0.2 });
  assert.equal(project.elements.find((item) => item.id === image.id).properties.x, 0.1);
  project = await state.service.undo(state.project.id, project.revision);
  project = await state.service.redo(state.project.id, project.revision);
  assert(Math.abs(project.elements.find((item) => item.id === image.id).properties.y - 0.2) < 1e-9);
  await run('resize-element', { elementId: image.id, width: 0.3, height: 0.3 });
  await run('set-element-opacity', { elementId: image.id, opacity: 0.4 });
  await run('set-element-z-index', { elementId: image.id, zIndex: 77 });
  await run('set-element-timing', { elementId: image.id, startTime: 1, duration: 4 });
  assert.deepEqual(project.elements.find((item) => item.id === image.id).startTime, 1);

  await run('update-text', { elementId: text.id, content: 'Phase 3', fontSize: 64,
    fontWeight: 800, color: '#00ffcc', textAlign: 'center' });
  assert.equal(project.elements.find((item) => item.id === text.id).properties.content, 'Phase 3');
  project = await state.service.undo(state.project.id, project.revision);
  assert.equal(project.elements.find((item) => item.id === text.id).properties.content, 'Text');
  project = await state.service.redo(state.project.id, project.revision);

  await run('set-audio-volume', { elementId: audio.id, volume: 0.6 });
  await run('set-audio-muted', { elementId: audio.id, muted: true });
  await run('set-audio-fade', { elementId: audio.id, fadeInSec: 0.2, fadeOutSec: 0.2 });
  assert.deepEqual(Object.fromEntries(['volume', 'muted', 'fadeInSec', 'fadeOutSec'].map((key) =>
    [key, project.elements.find((item) => item.id === audio.id).properties[key]])),
  { volume: 0.6, muted: true, fadeInSec: 0.2, fadeOutSec: 0.2 });
  project = await state.service.undo(state.project.id, project.revision);
  project = await state.service.redo(state.project.id, project.revision);
  assert.equal(project.elements.find((item) => item.id === audio.id).properties.fadeInSec, 0.2);

  const beforeDuplicate = new Set(project.elements.map((item) => item.id));
  await run('duplicate-element', { elementId: image.id });
  const duplicate = project.elements.find((item) => !beforeDuplicate.has(item.id));
  assert(duplicate && duplicate.assetId === image.assetId, 'duplicate references existing bytes');
  await run('remove-element', { elementId: duplicate.id });
  assert(!project.elements.some((item) => item.id === duplicate.id), 'overlay delete is non-ripple');
  await expectStatus(state.service.deleteAsset(state.project.id, imageUpload.asset.id, project.revision), 409);
  await expectStatus(state.service.phase3Command(state.project.id, 'move-element',
    { revision: project.revision - 1, elementId: image.id, x: 0.2, y: 0.2 }), 409);
  const reloaded = await state.service.get(state.project.id);
  assert.equal(reloaded.elements.find((item) => item.id === text.id).properties.content, 'Phase 3');
  const history = await state.service.history(state.project.id);
  assert(history.some((entry) => entry.action === 'ADD_IMAGE'));
  assert(history.some((entry) => entry.action === 'SET_AUDIO_FADE'));
  assert.deepEqual([state.rows.processingJobs.size, state.rows.clipCandidates.size,
    state.rows.generatedClips.size], [1, 1, 1], 'Phase 3 never invokes the frozen pipeline');
  console.log('EditMode Phase 3 tests passed: asset validation/storage, all element commands, persistence, conflicts, undo/redo, and frozen-pipeline isolation.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
