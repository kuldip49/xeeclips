// Manual zoom/pan, its precedence over automatic zoom, and music/media in the export graph.
// Offline: pure planning + the in-memory harness. Nothing encodes (see verify-editor-trim-zoom-media.cjs).
const assert = require('node:assert/strict');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');
const zoomLib = require('@ai-content-platform/shared/manual-zoom.cjs');
const R = '../dist/modules/edit-mode/render';
const { buildRenderPlan } = require(`${R}/edit-mode-render-plan.js`);
const { buildFfmpegArgs } = require(`${R}/edit-mode-filtergraph.js`);

const near = (actual, expected, label, tolerance = 1e-4) =>
  assert(Math.abs(actual - expected) < tolerance, `${label}: expected ${expected}, got ${actual}`);

// ---- Planning fixtures (same shape the render tests use) ---------------------------------------
const DURATION = 20;
const SPEECH = ('Most investors lose money because they try to time the market instead of ' +
  'staying invested and the compounding never gets a chance to work').split(/\s+/u);
const transcript = (() => {
  let cursor = 0.5;
  const words = SPEECH.map((text) => { const start = Number(cursor.toFixed(3)); cursor += 0.38;
    return { start, end: Number((cursor - 0.04).toFixed(3)), text }; });
  return { text: SPEECH.join(' '), language: 'en', duration: DURATION,
    segments: [{ position: 0, start: words[0].start, end: words.at(-1).end, text: SPEECH.join(' '), words }] };
})();
const analysis = { source: 'DENSE', shotBoundaries: [], ocrText: '',
  frames: Array.from({ length: DURATION * 2 }, (_, index) => ({ t: index / 2, text_coverage: 0,
    text_boxes: [], graphic_boxes: [], ocr_lines: [], ocr_coverage: 0,
    faces: [{ x: 0.38, y: 0.16, w: 0.24, h: 0.3, score: 0.95, mouth_activity: 0.6, track_id: 'a' }],
    persons: [{ x: 0.3, y: 0.14, w: 0.4, h: 0.82 }] })) };
const source = { id: 'src', role: 'SOURCE', mimeType: 'video/mp4', duration: DURATION, width: 1920,
  height: 1080, fps: 30, metadata: { hasAudio: true }, transcript, analysis };
const music = { id: 'mus', role: 'AUDIO', mimeType: 'audio/wav', duration: 30, width: null, height: null,
  fps: null, metadata: {}, transcript: null, analysis: null };
const image = { id: 'img', role: 'IMAGE', mimeType: 'image/png', duration: null, width: 400, height: 200,
  fps: null, metadata: {}, transcript: null, analysis: null };
const video = (id, position, trimStart, trimEnd, startTime, properties = {}) => ({ id, assetId: 'src',
  type: 'VIDEO', track: 0, position, startTime, duration: trimEnd - trimStart, trimStart, trimEnd, properties });
const settings = (over = {}) => ({ selectedPreset: 'PODCAST_CLIP', aspectRatio: '9:16', pacing: 'MODERATE',
  subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'CENTERED', musicPolicy: 'KEEP_EXISTING',
  gradingPolicy: 'NONE', textPolicy: 'OFF', overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT',
  hookText: null, ...over });
const zoomEffect = (id, startTime, duration) => ({ id, assetId: null, type: 'EFFECT', track: 4, position: 0,
  startTime, duration, trimStart: 0, trimEnd: null, properties: { effect: 'ZOOM', scale: 1.1, enabled: true,
    claimsMoment: null, triggerText: 'compounding', semanticReason: 'EDITED_ZOOM', focusX: null, focusY: null,
    focusTrackId: null } });
const plan = (elements, over = {}) => buildRenderPlan({ project: { id: 'p', revision: 3,
  settings: over.settings ?? settings() }, assets: over.assets ?? [source], elements, hasSourceAudio: true, fps: 30 });
const graphOf = (built, over = {}) => {
  const args = buildFfmpegArgs({ plan: built.plan, sourcePath: '/tmp/source.mp4',
    overlayPaths: over.overlayPaths ?? {}, audioPaths: over.audioPaths ?? {}, assFileName: null,
    outputPath: '/tmp/out.mp4', informationCrop: built.evidence.informationCrop,
    fitExpression: built.evidence.fitExpression, informationFitExpression: built.evidence.informationFitExpression,
    cameraFilter: built.evidence.cameraFilter });
  return args[args.indexOf('-filter_complex') + 1];
};

async function zoomEvents() {
  const state = await seedAnalyzedProject(createHarness());
  let project = await state.service.get(state.project.id);
  const run = async (action, payload) => project = await state.service.phase3Command(project.id, action,
    { revision: project.revision, ...payload });
  await run('add-zoom', { startTime: 2, duration: 3, scale: 1.1 });
  await assert.rejects(run('add-zoom', { startTime: 4, duration: 2, scale: 1.1 }),
    (error) => error.getResponse?.().code === 'ZOOM_OVERLAP', 'a zoom overlapping another is refused in plain words');
  await assert.rejects(run('add-zoom', { startTime: 8, duration: 0.3, scale: 1.1 }),
    (error) => error.getResponse?.().code === 'ZOOM_TOO_SHORT', 'a zero-length / 1-frame zoom is refused');
  await run('add-zoom', { startTime: 5, duration: 2, scale: 1.1 }); // adjacent is fine
  await run('add-zoom', { startTime: 9, duration: 2, scale: 1.1 });
  const ids = project.elements.filter((e) => e.type === 'EFFECT').map((e) => e.id);
  // Trim the head by 6.2 s: the zoom at 2-5 is gone, 5-7 is clipped to 0.8 s (below the settle minimum) and goes,
  // 9-11 follows its footage to 2.8-4.8 with its full length.
  const video = project.elements.find((e) => e.type === 'VIDEO');
  project = await state.service.trimElement(project.id, { revision: project.revision, elementId: video.id,
    trimStart: 6.2, trimEnd: video.trimEnd });
  const left = project.elements.filter((e) => e.type === 'EFFECT');
  assert.equal(left.length, 1, 'no zoom is left outside, or clipped to a sliver at, the trimmed edge');
  near(left[0].startTime, 2.8, 'the surviving zoom follows its footage'); near(left[0].duration, 2, 'at full length');
  assert.equal(ids.length, 3);
  project = await state.service.undo(project.id, project.revision);
  assert.equal(project.elements.filter((e) => e.type === 'EFFECT').length, 3, 'undo restores every zoom');
}

async function commands() {
  const state = await seedAnalyzedProject(createHarness());
  let project = await state.service.get(state.project.id);
  const run = async (action, payload) => project = await state.service.phase3Command(project.id,
    action, { revision: project.revision, ...payload });
  const target = project.elements.find((e) => e.type === 'VIDEO').id;
  const props = () => project.elements.find((e) => e.id === target).properties;

  await run('set-video-scale', { elementId: target, scale: 1.15 });
  near(props().scale, 1.15, 'scale stored');
  await run('set-video-position', { elementId: target, x: 0.05, y: -0.03 });
  near(props().offsetX, 0.05, 'pan x'); near(props().offsetY, -0.03, 'pan y');
  // A pan the picture cannot cover is stored at the limit - never as a value the export would clamp.
  await run('set-video-position', { elementId: target, x: 0.9, y: -0.9 });
  near(props().offsetX, 0.075, 'pan x limited to (1.15-1)/2'); near(props().offsetY, -0.075, 'pan y limited');
  // Changing the zoom re-clamps the stored pan in the SAME revision (one undo restores both).
  const beforeScale = project.revision;
  await run('set-video-scale', { elementId: target, scale: 1.05 });
  near(props().offsetX, 0.025, 'pan re-clamped when zooming out'); near(props().offsetY, -0.025, 'pan y re-clamped');
  assert.equal(project.revision, beforeScale + 1, 'one revision');
  project = await state.service.undo(project.id, project.revision);
  near(props().scale, 1.15, 'undo restores scale'); near(props().offsetX, 0.075, 'undo restores pan');
  project = await state.service.redo(project.id, project.revision);
  near(props().scale, 1.05, 'redo re-applies scale'); near(props().offsetX, 0.025, 'redo re-applies pan');
  // Back to neutral at 1x: a pan cannot exist without a zoom.
  await run('set-video-scale', { elementId: target, scale: 1 });
  assert.equal(props().offsetX, 0); assert.equal(props().offsetY, 0);
  await assert.rejects(state.service.phase3Command(project.id, 'set-video-scale',
    { revision: project.revision, elementId: target, scale: 9 }), (e) => e.getStatus?.() === 400);
}

function precedenceAndGraph() {
  // --- automatic zoom is kept when the user has not zoomed ---
  const zoom = zoomEffect('z1', 6, 4);
  const plain = plan([video('v1', 0, 0, 14, 0), zoom], { settings: settings({ zoomPolicy: 'MODERATE' }) });
  assert.equal(plain.plan.zoomEvents.length, 1, 'an automatic/template zoom still renders');
  assert(!/mzbase/u.test(graphOf(plain)), 'an unzoomed project adds no manual zoom stage');

  // --- ...and stands aside over a manually zoomed segment (never stacks) ---
  const manual = plan([video('v1', 0, 0, 14, 0, { scale: 1.15, offsetX: 0.05, offsetY: -0.02 }), zoom],
    { settings: settings({ zoomPolicy: 'MODERATE' }) });
  assert.equal(manual.plan.zoomEvents.length, 0, 'automatic zoom is suppressed under a manual zoom');
  assert(manual.plan.zoomRejections.some((r) => r.reason === 'MANUAL_ZOOM_OVERRIDES'), 'and the reason is recorded');
  const graph = graphOf(manual);
  assert(!/zoompan/u.test(graph), 'no automatic punch-in is emitted');
  const stage = zoomLib.manualZoomFilter(zoomLib.readManualZoom({ scale: 1.15, offsetX: 0.05, offsetY: -0.02 }), 1080, 1920);
  assert(graph.includes(stage), 'the shared geometry is the only manual zoom math');
  assert.equal((graph.match(/scale=1242:2208/gu) || []).length, 1, 'applied once, never twice');
  assert(/enable='between\(t\\,0\.000\\,13\.999\)'/u.test(graph), 'gated to its own segment');
  // --- the source-frame chain carries no scale/offset any more ---
  assert(!/crop=1920:1080/u.test(graph), 'no scale/crop pair on the raw source frame');

  // --- a zoom confined to ONE of two segments leaves the other untouched and keeps its auto zoom ---
  const two = plan([video('a', 0, 0, 7, 0, { scale: 1.2 }), video('b', 1, 7, 14, 7), zoomEffect('z2', 9, 4)],
    { settings: settings({ zoomPolicy: 'MODERATE' }) });
  assert.equal(two.plan.zoomEvents.length, 1, 'the segment without a manual zoom keeps its automatic zoom');
  const twoGraph = graphOf(two);
  assert.equal((twoGraph.match(/overlay=0:0:enable='between\(t\\,0\.000/gu) || []).length, 1, 'only segment a is gated');
  // zoom-out pads instead of cropping
  const out = graphOf(plan([video('v1', 0, 0, 10, 0, { scale: 0.8 })]));
  assert(/pad=1080:1920:/u.test(out) && /scale=864:1536/u.test(out), 'zoom out shrinks and pads inside the window');
  // --- StyleTwo manual crop carries its own scale: the generic stage must not apply it again ---
}

function music_and_media() {
  const els = [video('v1', 0, 3, 17, 0),
    { id: 'm1', assetId: 'mus', type: 'AUDIO', track: 3, position: 0, startTime: 1, duration: 8, trimStart: 4,
      trimEnd: 12, properties: { volume: 0.2, muted: false, fadeInSec: 0.5, fadeOutSec: 1, duckEnabled: false } },
    { id: 'i1', assetId: 'img', type: 'IMAGE', track: 2, position: 0, startTime: 2, duration: 5, trimStart: 0,
      trimEnd: null, properties: { role: 'IMAGE', x: 0.1, y: 0.2, width: 0.5, height: 0.25, opacity: 0.6,
        zIndex: 2, rotation: 0 } }];
  const built = plan(els, { assets: [source, music, image] });
  assert.equal(built.plan.durationSec, 14);
  const track = built.plan.audioTracks[0];
  assert.deepEqual([track.startSec, track.endSec, track.trimStart, track.trimEnd, track.volume], [1, 9, 4, 12, 0.2]);
  const graph = graphOf(built, { overlayPaths: { i1: '/tmp/i.png' }, audioPaths: { m1: '/tmp/m.wav' } });
  assert(/atrim=start=4\.000:end=12\.000/u.test(graph) || /atrim=start=4:end=12/u.test(graph), 'music reads its own window');
  assert(/volume=0\.2000/u.test(graph) && /adelay=1000:all=1/u.test(graph), 'music volume and start');
  assert(/amix=inputs=2:duration=longest:dropout_transition=0:normalize=0/u.test(graph), 'source + music mixed at set levels');
  assert(/alimiter=/u.test(graph), 'the sum is limited, never clipped');
  assert(/atrim=start=0:end=14/u.test(graph), 'the mix stops at the export end');
  // image geometry: normalized box -> pixels of the 1080x1920 canvas
  const overlay = built.plan.visualOverlays[0];
  assert.deepEqual([overlay.x, overlay.y, overlay.width, overlay.height, overlay.opacity],
    [108, 384, 540, 480, 0.6]);
  assert(/between\(t\\,2\.000\\,7\.000\)/u.test(graph), 'overlay timing is on the exported timeline');
}

(async () => {
  const sections = [['manual zoom commands', commands], ['zoom events: overlap, minimum length, trim', zoomEvents], ['precedence and graph', async () => precedenceAndGraph()],
    ['music and media plan', async () => music_and_media()]];
  for (const [name, fn] of sections) { await fn(); console.log(`  ok  ${name}`); }
  console.log('editor zoom/music/media: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
