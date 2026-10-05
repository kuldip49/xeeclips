// EditMode timeline track state - Workstream E.
//
// Visibility and lock are the two things the professional timeline needs that
// did NOT previously have a command: `hidden` was honoured by the render plan
// and `locked` by the preview, but nothing could set either. This file checks
// that they are now real canonical state and not a decoration:
//
//   1. SET_ELEMENT_VISIBLE / SET_ELEMENT_LOCKED are ordinary typed commands, so
//      they inherit validation, history and undo like every other one.
//   2. The BULK form (elementType instead of elementId) is ONE revision, which
//      is what makes "hide the captions" affordable on a 400-caption track.
//   3. Hiding reaches the RENDERER: a hidden overlay is absent from the export
//      exactly as it is absent from the preview. This is the claim that
//      separates a real visibility toggle from an editor-only eye icon.
//   4. The type rules hold: footage cannot be hidden (the track is sequential),
//      audio is silenced with mute, and anything can be locked.
//
// Offline: nothing encodes, nothing touches a database, nothing is left behind.

const assert = require('node:assert/strict');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

const M = '../dist/modules/edit-mode';
const { buildRenderPlan } = require(`${M}/render/edit-mode-render-plan.js`);

let checks = 0;
const ok = (label, condition) => {
  assert(condition, label);
  checks += 1;
  console.log(`  ok  ${label}`);
};
const section = (title) => console.log(`\n${title}`);

// --- 1. The command layer ----------------------------------------------------

async function commandSuite() {
  section('1. Visibility and lock are typed, canonical, undoable commands');
  const state = await seedAnalyzedProject(createHarness());
  const { service, rows } = state;
  const id = state.project.id;
  let project = state.analyzed;

  // Two library assets, injected straight into the harness the way an upload
  // would have left them, so the overlay and music commands have something to
  // point at.
  for (const asset of [
    { id: 'asset-logo', role: 'LOGO', originalName: 'logo.png', mimeType: 'image/png',
      bucket: 'test-bucket', objectKey: `edit-mode/${id}/asset-logo/logo.png`,
      sizeBytes: 512n, duration: null, width: 400, height: 200, fps: null, metadata: {} },
    { id: 'asset-music', role: 'AUDIO', originalName: 'bed.wav', mimeType: 'audio/wav',
      bucket: 'test-bucket', objectKey: `edit-mode/${id}/asset-music/bed.wav`,
      sizeBytes: 4096n, duration: 30, width: null, height: null, fps: null, metadata: {} }
  ]) rows.editAssets.set(asset.id, { ...asset, editProjectId: id, transcript: null, analysis: null,
    createdAt: new Date(), updatedAt: new Date() });

  const run = async (action, payload) => {
    project = await service.phase3Command(id, action, { revision: project.revision, ...payload });
    return project;
  };
  const refused = async (action, payload, match) => {
    try { await service.phase3Command(id, action, { revision: project.revision, ...payload }); }
    catch (error) {
      const body = typeof error.getResponse === 'function' ? error.getResponse() : {};
      const text = JSON.stringify(body);
      assert(text.includes(match), `expected a refusal mentioning ${match}, got ${text}`);
      return true;
    }
    assert.fail(`expected ${action} to be refused`);
  };
  const byType = (type) => (project.elements ?? []).filter((element) => element.type === type);
  const hidden = (element) => element.properties.hidden === true;
  const locked = (element) => element.properties.locked === true;

  await run('add-text', { content: 'First' });
  await run('add-text', { content: 'Second' });
  await run('add-logo', { assetId: 'asset-logo' });
  await run('add-audio', { assetId: 'asset-music' });
  ok('fixture: two text elements, one overlay and one music clip exist',
    byType('TEXT').length === 2 && byType('IMAGE').length === 1 && byType('AUDIO').length === 1);
  ok('a freshly created element reads back visible and unlocked',
    byType('TEXT').every((element) => !hidden(element) && !locked(element)));

  // --- single-element form ---------------------------------------------------
  const oneText = byType('TEXT')[0].id;
  let before = project.revision;
  await run('set-element-visible', { elementId: oneText, visible: false });
  ok('SET_ELEMENT_VISIBLE hides exactly the element it was given',
    byType('TEXT').filter(hidden).length === 1 &&
    hidden(byType('TEXT').find((element) => element.id === oneText)));
  ok('...in exactly one revision', project.revision === before + 1);

  project = await service.undo(id, project.revision);
  ok('undo brings the hidden element back', !byType('TEXT').some(hidden));
  project = await service.redo(id, project.revision);
  ok('redo hides it again', byType('TEXT').filter(hidden).length === 1);

  // --- bulk form -------------------------------------------------------------
  before = project.revision;
  await run('set-element-visible', { elementType: 'TEXT', visible: false });
  ok('the bulk form hides every element on the track',
    byType('TEXT').length === 2 && byType('TEXT').every(hidden));
  ok('...still in exactly one revision - this is what makes a 400-caption track affordable',
    project.revision === before + 1);
  await run('set-element-visible', { elementType: 'TEXT', visible: true });
  ok('the bulk form shows them all again', !byType('TEXT').some(hidden));

  await run('set-element-visible', { elementType: 'IMAGE', visible: false });
  ok('overlays hide through the same command', byType('IMAGE').every(hidden));
  ok('...and hiding one track leaves the others alone', !byType('TEXT').some(hidden));
  await run('set-element-visible', { elementType: 'IMAGE', visible: true });

  // --- type rules ------------------------------------------------------------
  const videoId = byType('VIDEO')[0].id;
  ok('footage cannot be hidden - the VIDEO track is sequential',
    await refused('set-element-visible', { elementId: videoId, visible: false },
      'INVALID_ELEMENT_TYPE'));
  ok('music cannot be hidden either - it is silenced with mute',
    await refused('set-element-visible', { elementId: byType('AUDIO')[0].id, visible: false },
      'INVALID_ELEMENT_TYPE'));
  ok('a non-boolean is refused rather than coerced',
    await refused('set-element-visible', { elementId: oneText, visible: 'yes' }, 'visible'));
  ok('neither an elementId nor an elementType is refused',
    await refused('set-element-visible', { visible: false }, 'INVALID_ELEMENT_TYPE'));

  // --- lock ------------------------------------------------------------------
  before = project.revision;
  await run('set-element-locked', { elementType: 'SUBTITLE', locked: true });
  ok('locking an EMPTY track is accepted and changes nothing',
    project.revision === before + 1 && byType('SUBTITLE').length === 0);

  await run('set-element-locked', { elementId: videoId, locked: true });
  ok('footage CAN be locked, unlike hidden', locked(byType('VIDEO')[0]));
  await run('set-element-locked', { elementType: 'TEXT', locked: true });
  ok('locking a track locks every element on it', byType('TEXT').every(locked));
  ok('...and does not hide anything - lock and visibility are independent',
    !byType('TEXT').some(hidden));

  // Lock guards the TIMELINE's gestures, not the server: the inspector, a
  // preset and an assistant turn must still reach a locked element, or
  // unlocking could deadlock itself.
  const lockedText = byType('TEXT')[0].id;
  await run('set-text-content', { elementId: lockedText, content: 'Edited while locked' });
  ok('a locked element is still reachable by an ordinary property command',
    byType('TEXT').find((element) => element.id === lockedText).properties.content ===
      'Edited while locked');
  await run('set-element-locked', { elementType: 'TEXT', locked: false });
  ok('a track unlocks again', !byType('TEXT').some(locked));

  // --- bulk mute -------------------------------------------------------------
  before = project.revision;
  await run('set-audio-muted', { muted: true });
  ok('SET_AUDIO_MUTED without an elementId mutes every music clip in one revision',
    byType('AUDIO').every((element) => element.properties.muted === true) &&
    project.revision === before + 1);
  await run('set-audio-muted', { elementId: byType('AUDIO')[0].id, muted: false });
  ok('...and the single-element form still works',
    byType('AUDIO').every((element) => element.properties.muted === false));

  return project;
}

// --- 2. Hiding reaches the renderer -----------------------------------------

function renderSuite() {
  section('2. A hidden element is absent from the EXPORT, not just the preview');
  const source = { id: 'src', role: 'SOURCE', mimeType: 'video/mp4', duration: 20,
    width: 1920, height: 1080, fps: 30, metadata: { hasAudio: true }, transcript: null,
    analysis: null };
  const logo = { id: 'logo', role: 'LOGO', mimeType: 'image/png', duration: null,
    width: 400, height: 200, fps: null, metadata: {}, transcript: null, analysis: null };
  const video = { id: 'v1', assetId: 'src', type: 'VIDEO', track: 0, position: 0, startTime: 0,
    duration: 12, trimStart: 0, trimEnd: 12, properties: {} };
  const overlay = (over) => ({ id: 'img1', assetId: 'logo', type: 'IMAGE', track: 2, position: 0,
    startTime: 1, duration: 5, trimStart: 0, trimEnd: null,
    properties: { x: 0.1, y: 0.1, width: 0.2, height: 0.1, opacity: 1, zIndex: 20, ...over } });
  const text = (over) => ({ id: 'txt1', assetId: null, type: 'TEXT', track: 1, position: 0,
    startTime: 2, duration: 4, trimStart: 0, trimEnd: null,
    properties: { content: 'Hook', x: 0.1, y: 0.1, width: 0.8, height: 0.2, fontSize: 40,
      color: '#ffffff', ...over } });
  const settings = { selectedPreset: 'PODCAST_CLIP', aspectRatio: '9:16', pacing: 'MODERATE',
    subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'NONE',
    musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
    overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null };
  const plan = (elements) => buildRenderPlan({
    project: { id: 'p', revision: 4, settings },
    assets: [source, logo], elements, hasSourceAudio: true, fps: 30 }).plan;

  const shown = plan([video, overlay(), text()]);
  ok('a visible overlay and a visible text layer are both in the plan',
    shown.visualOverlays.length === 1 && shown.textOverlays.length === 1);

  const hiddenOverlay = plan([video, overlay({ hidden: true }), text()]);
  ok('a hidden IMAGE overlay is dropped from the render plan',
    hiddenOverlay.visualOverlays.length === 0);
  ok('...and hiding it leaves the text layer untouched',
    hiddenOverlay.textOverlays.length === 1);

  const hiddenText = plan([video, overlay(), text({ hidden: true })]);
  ok('a hidden TEXT layer is dropped from the render plan',
    hiddenText.textOverlays.length === 0 && hiddenText.visualOverlays.length === 1);

  const bothHidden = plan([video, overlay({ hidden: true }), text({ hidden: true })]);
  ok('a fully hidden overlay track exports as if it were not there',
    bothHidden.visualOverlays.length === 0 && bothHidden.textOverlays.length === 0);

  // Lock is an editing guard, not a render instruction: a locked element must
  // still appear. Getting this backwards would silently drop work on export.
  const lockedPlan = plan([video, overlay({ locked: true }), text({ locked: true })]);
  ok('a LOCKED element still renders - lock protects it, it does not remove it',
    lockedPlan.visualOverlays.length === 1 && lockedPlan.textOverlays.length === 1);
}

async function main() {
  const project = await commandSuite();
  renderSuite();
  section('Summary');
  console.log(`  EditMode track state: ${checks} checks passed`);
  console.log(`  final revision after the command suite: ${project.revision}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
