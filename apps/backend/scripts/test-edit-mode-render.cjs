// EditMode Phase 5 - render planning, validation and filter-graph unit coverage.
//
// Offline and fast: every assertion here is about the deterministic plan the
// exporter builds from canonical state, the typed errors it refuses to render,
// the ASS it burns in and the exact FFmpeg graph it emits. Nothing encodes.
// The real-media path is covered by test-edit-mode-export.cjs and
// verify-edit-mode-export.cjs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = '../dist/modules/edit-mode/render';
const { buildRenderPlan, EditExportError,
  EDIT_MODE_GRADES } = require(`${R}/edit-mode-render-plan.js`);
const { validateRenderPlan } = require(`${R}/edit-mode-render-validate.js`);
const { buildFfmpegArgs } = require(`${R}/edit-mode-filtergraph.js`);
const { buildEditModeAss, fontSizePx, toAssColor,
  wrapToWidth } = require(`${R}/edit-mode-ass.js`);
const { buildTimelineMap, remapAnalysisFrames,
  timelineShotBoundaries } = require(`${R}/edit-mode-timeline-map.js`);
const { EDIT_MODE_ZOOM_SCALES, editModeZoomScaleAt,
  zoomEnvelopeExpression } = require(`${R}/edit-mode-zoom.js`);
const { resolveCanvas } = require(`${R}/edit-mode-camera.js`);
const { qaFrameNumbers, framingChecks, EDIT_MODE_QA } = require(`${R}/edit-mode-qa.js`);

// --- Fixtures ---------------------------------------------------------------

const SOURCE_DURATION = 20;
const SPEECH = ('Most investors lose money because they try to time the market instead of ' +
  'staying invested and the compounding never gets a chance to work').split(/\s+/u);

function transcriptFixture(startAt = 0.5, step = 0.38) {
  let cursor = startAt;
  const words = SPEECH.map((text) => {
    const start = Number(cursor.toFixed(3));
    cursor += step;
    return { start, end: Number((cursor - 0.04).toFixed(3)), text };
  });
  return { text: SPEECH.join(' '), language: 'en', duration: SOURCE_DURATION,
    segments: [{ position: 0, start: words[0].start, end: words[words.length - 1].end,
      text: SPEECH.join(' '), words }] };
}

const frames = (build) => Array.from({ length: SOURCE_DURATION * 2 }, (_, index) => ({
  t: index / 2, text_coverage: 0, text_boxes: [], graphic_boxes: [], ocr_lines: [],
  ocr_coverage: 0, faces: [], persons: [], ...build(index / 2) }));

/** One large centred face: a talking head the camera can safely track. */
const talkingHead = () => ({ source: 'DENSE', shotBoundaries: [], ocrText: '',
  frames: frames(() => ({ faces: [{ x: 0.38, y: 0.16, w: 0.24, h: 0.3, score: 0.95,
    mouth_activity: 0.6, track_id: 'a' }], persons: [{ x: 0.3, y: 0.14, w: 0.4, h: 0.82 }] })) });

/** A face hard against the left edge: a 9:16 crop that punches in on it loses it. */
const edgeFace = () => ({ source: 'DENSE', shotBoundaries: [], ocrText: '',
  frames: frames(() => ({ faces: [
    { x: 0.02, y: 0.3, w: 0.16, h: 0.2, score: 0.95, mouth_activity: 0.6, track_id: 'a' },
    { x: 0.8, y: 0.3, w: 0.16, h: 0.2, score: 0.94, mouth_activity: 0.5, track_id: 'b' }],
  persons: [{ x: 0.0, y: 0.2, w: 0.25, h: 0.8 }, { x: 0.75, y: 0.2, w: 0.25, h: 0.8 }] })) });

/** A slide whose readable region is a tight box, not the whole frame. */
const slide = () => ({ source: 'DENSE', shotBoundaries: [], ocrText: 'Annualised real return',
  frames: frames(() => ({ text_coverage: 0.42, ocr_coverage: 0.42,
    text_boxes: [{ x: 0.3, y: 0.18, w: 0.4, h: 0.34 }],
    ocr_lines: ['Annualised real return by decade', 'Equities 6.8 percent',
      'Bonds 2.1 percent', 'Cash minus 0.4 percent', 'Source: long run market study'] })) });

const sourceAsset = (analysis, over = {}) => ({ id: 'src', role: 'SOURCE',
  mimeType: 'video/mp4', duration: SOURCE_DURATION, width: 1920, height: 1080, fps: 30,
  metadata: { hasAudio: true }, transcript: transcriptFixture(), analysis, ...over });
const imageAsset = (id, role = 'IMAGE') => ({ id, role, mimeType: 'image/png', duration: null,
  width: 400, height: 200, fps: null, metadata: {}, transcript: null, analysis: null });
const audioAsset = (id) => ({ id, role: 'AUDIO', mimeType: 'audio/wav', duration: 30,
  width: null, height: null, fps: null, metadata: {}, transcript: null, analysis: null });

const videoElement = (id, position, trimStart, trimEnd, startTime) => ({ id, assetId: 'src',
  type: 'VIDEO', track: 0, position, startTime, duration: trimEnd - trimStart, trimStart,
  trimEnd, properties: {} });

const settings = (over = {}) => ({ selectedPreset: 'PODCAST_CLIP', aspectRatio: '9:16',
  pacing: 'MODERATE', subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF',
  reframePolicy: 'AUTO', musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null, ...over });

const plan = (over = {}) => buildRenderPlan({
  project: { id: 'project-1', revision: over.revision ?? 4, settings: over.settings ?? settings() },
  assets: over.assets ?? [sourceAsset(talkingHead())],
  elements: over.elements ?? [videoElement('v1', 0, 0, 12, 0)],
  hasSourceAudio: over.hasSourceAudio ?? true, fps: over.fps ?? 30,
  imageStats: over.imageStats, suppressedZoomIds: over.suppressedZoomIds,
  zoomScaleCeilings: over.zoomScaleCeilings, widenShots: over.widenShots,
  informationFitShots: over.informationFitShots });

const graphOf = (built, over = {}) => {
  const args = buildFfmpegArgs({ plan: built.plan, sourcePath: '/tmp/source.mp4',
    overlayPaths: over.overlayPaths ?? {}, audioPaths: over.audioPaths ?? {},
    assFileName: over.assFileName ?? null, outputPath: '/tmp/out.mp4',
    informationCrop: built.evidence.informationCrop,
    fitExpression: built.evidence.fitExpression,
    informationFitExpression: built.evidence.informationFitExpression,
    cameraFilter: built.evidence.cameraFilter });
  return { args, graph: args[args.indexOf('-filter_complex') + 1] };
};

const rejects = (fn, code) => {
  try { fn(); } catch (error) {
    assert(error instanceof EditExportError, `expected EditExportError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code} to be thrown`);
};

// --- 1. Timeline mapping ----------------------------------------------------

function timelineMapping() {
  // Split + trim + delete + reorder all reduce to an ordered segment list.
  const map = buildTimelineMap([
    videoElement('b', 0, 12, 16, 0),   // the later half of the source plays first
    videoElement('a', 1, 2, 5, 4),
    { id: 'text', assetId: null, type: 'TEXT', track: 1, position: 0, startTime: 0,
      duration: 2, trimStart: 0, trimEnd: null, properties: {} }
  ]);
  assert.equal(map.segments.length, 2, 'only track-0 VIDEO elements make segments');
  assert.equal(map.durationSec, 7);
  assert.deepEqual(map.segments.map((s) => [s.sourceStart, s.sourceEnd, s.timelineStart]),
    [[12, 16, 0], [2, 5, 4]]);
  // Reordering means the mapping is not monotonic - which is exactly why
  // EditMode cannot use the frozen clipStart+cuts mapper.
  assert.equal(map.toSource(1), 13);
  assert.equal(map.toSource(5), 3);
  assert.deepEqual(map.toTimeline(13), [1]);
  assert.deepEqual(map.toTimeline(8), [], 'a deleted source instant survives nowhere');

  // A range used twice appears twice on the exported timeline.
  const reused = buildTimelineMap([videoElement('a', 0, 0, 2, 0), videoElement('b', 1, 0, 2, 2)]);
  assert.deepEqual(reused.toTimeline(1), [1, 3]);
  assert.equal(remapAnalysisFrames([{ t: 1, faces: [{ timestamp: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }],
    persons: [], textCoverage: 0, textBoxes: [], ocrLines: [] }], reused).length, 2);

  // A segment join is a hard visual discontinuity even without a shot change.
  assert.deepEqual(timelineShotBoundaries([], map), [4]);
  assert.deepEqual(timelineShotBoundaries([14], map), [2, 4]);
  console.log('  timeline mapping: trim, split, delete, reorder, reuse, boundaries');
}

// --- 2. Video timeline rendering -------------------------------------------

function videoTimeline() {
  const simple = plan();
  assert.equal(simple.plan.videoSegments.length, 1);
  assert.equal(simple.plan.durationSec, 12);
  const single = graphOf(simple).graph;
  assert(single.includes('[v0]null[vcat]'), 'a single segment needs no concat');
  assert(!single.includes('concat=n='));

  const split = plan({ elements: [videoElement('a', 0, 0, 4, 0), videoElement('b', 1, 6, 9, 4)] });
  assert.equal(split.plan.durationSec, 7);
  const cut = graphOf(split).graph;
  assert(cut.includes('trim=start=0.000:end=4.000'));
  assert(cut.includes('trim=start=6.000:end=9.000'));
  assert(cut.includes('concat=n=2:v=1:a=1[vcat][acat]'), 'segments join with audio in sync');
  assert(cut.includes('atrim=start=6.000:end=9.000'), 'audio is trimmed with its own video');
  assert(cut.includes('afade=t=in:d=0.012'), 'joins are de-clicked');

  // Reorder: the source ranges are emitted in timeline order, not source order.
  const reordered = plan({ elements: [videoElement('b', 0, 6, 9, 0), videoElement('a', 1, 0, 4, 3)] });
  assert.deepEqual(reordered.plan.videoSegments.map((s) => s.sourceStart), [6, 0]);
  const order = graphOf(reordered).graph;
  assert(order.indexOf('trim=start=6.000') < order.indexOf('trim=start=0.000:end=4.000'));

  // A timeline with no playable clip is refused, not rendered empty.
  rejects(() => plan({ elements: [] }), 'INVALID_TIMELINE');
  console.log('  video timeline: trims, splits, reorder, concat, audio sync');
}

// --- 3. Aspect ratio and canvas --------------------------------------------

function aspectRatios() {
  assert.deepEqual(resolveCanvas('9:16', 1920, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(resolveCanvas('16:9', 1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(resolveCanvas('1:1', 1920, 1080), { width: 1080, height: 1080 });
  assert.deepEqual(resolveCanvas('SOURCE', 1280, 720), { width: 1280, height: 720 });
  // A SOURCE export stays inside sane limits instead of re-encoding 4K.
  assert.deepEqual(resolveCanvas('SOURCE', 3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(resolveCanvas('SOURCE', 0, 0), { width: 1920, height: 1080 });

  for (const [ratio, width, height] of [['9:16', 1080, 1920], ['16:9', 1920, 1080],
    ['1:1', 1080, 1080]]) {
    const built = plan({ settings: settings({ aspectRatio: ratio }) });
    assert.equal(built.plan.canvas.width, width);
    assert.equal(built.plan.canvas.height, height);
    const { args } = graphOf(built);
    assert(args.includes('libx264') && args.includes('yuv420p'));
    assert(args.includes('-movflags') && args.includes('+faststart'));
    assert(args.includes('aac'), 'MP4/H.264/AAC is the export contract');
  }
  console.log('  aspect ratios: 9:16, 16:9, 1:1, SOURCE with bounded dimensions');
}

// --- 4. Reframe -------------------------------------------------------------

function reframe() {
  // SOURCE never crops: a 16:9 source in a 9:16 canvas is fitted whole.
  const source = plan({ settings: settings({ reframePolicy: 'SOURCE' }) });
  assert.deepEqual(source.plan.frameSegments.map((s) => s.layout), ['FIT']);
  assert(source.evidence.fitExpression, 'the fitted branch must be enabled');
  assert(graphOf(source).graph.includes('boxblur'), 'a fitted layer sits on a blurred fill');

  // A source already the shape of the canvas is not letterboxed.
  const vertical = plan({ settings: settings({ aspectRatio: '9:16', reframePolicy: 'SOURCE' }),
    assets: [sourceAsset(talkingHead(), { width: 1080, height: 1920 })] });
  assert.deepEqual(vertical.plan.frameSegments.map((s) => s.layout), ['FILL']);
  assert.equal(vertical.evidence.fitExpression, '');

  // FACE_FOCUSED tracks a real detection and says so in the reason.
  const faces = plan({ settings: settings({ reframePolicy: 'FACE_FOCUSED' }) });
  assert.deepEqual(faces.plan.frameSegments.map((s) => s.layout), ['FILL']);
  assert(faces.plan.frameSegments[0].reason.includes('FACE_FOCUSED'));
  assert(faces.evidence.cameraFilter.includes('crop=1080:1920'));

  // No reliable face: nothing is invented, the classifier's own call stands.
  const blank = plan({ assets: [sourceAsset({ source: 'DENSE', frames: [], shotBoundaries: [],
    ocrText: '' })], settings: settings({ reframePolicy: 'FACE_FOCUSED' }) });
  assert.equal(blank.plan.frameSegments[0].faceCount, 0);
  assert(!blank.plan.frameSegments[0].reason.includes('FACE_FOCUSED'));
  assert(blank.plan.warnings.some((item) => item.includes('no cached visual analysis')));

  // Multiple important faces are kept together rather than cropped apart.
  const pair = plan({ assets: [sourceAsset(edgeFace())],
    settings: settings({ reframePolicy: 'AUTO' }) });
  assert.equal(pair.plan.frameSegments[0].layout, 'FIT',
    'a pair too wide for the crop is fitted, not cut in half');

  // Slides keep their information region.
  const information = plan({ assets: [sourceAsset(slide())],
    settings: settings({ reframePolicy: 'INFORMATION_PRESERVING',
      informationRegionPolicy: 'PRESERVE' }) });
  assert.deepEqual(information.plan.frameSegments.map((s) => s.layout), ['INFORMATION_FIT']);
  assert(information.evidence.informationCrop, 'a tight region produces a real crop');
  assert(graphOf(information).graph.includes(
    `crop=${information.evidence.informationCrop.width}:${information.evidence.informationCrop.height}`));
  console.log('  reframe: SOURCE, AUTO, FACE_FOCUSED, INFORMATION_PRESERVING');
}

// --- 5. Semantic zoom -------------------------------------------------------

const zoomSettings = (over = {}) => settings({ zoomPolicy: 'MODERATE',
  reframePolicy: 'FACE_FOCUSED',
  presetRun: { presetId: 'PODCAST_CLIP', presetRunId: 'run-1', appliedAtRevision: 3,
    summary: '', trims: [],
    plannedZoomMoments: over.moments ?? [{ startSec: 3, endSec: 4, reason: 'STATISTIC',
      triggerText: 'compounding', intensity: 'MODERATE' }] },
  ...over.style });

function semanticZoom() {
  // OFF renders nothing and emits no zoompan at all.
  const off = plan({ settings: zoomSettings({ style: { zoomPolicy: 'OFF' } }) });
  assert.equal(off.plan.zoomEvents.length, 0);
  assert(!graphOf(off).graph.includes('zoompan'));

  // A safe beat on a talking head renders, bounded and settled.
  const safe = plan({ settings: zoomSettings() });
  assert.equal(safe.plan.zoomEvents.length, 1);
  const event = safe.plan.zoomEvents[0];
  assert.equal(event.peakScale, EDIT_MODE_ZOOM_SCALES.MODERATE);
  assert(event.peakScale <= 1.15, 'no arbitrary extreme punch-in');
  assert(event.startSec < event.peakStartSec && event.peakEndSec < event.endSec);
  assert(Math.abs(editModeZoomScaleAt([event], event.startSec) - 1) < 1e-6);
  assert(Math.abs(editModeZoomScaleAt([event], event.endSec) - 1) < 1e-6,
    'the camera returns to baseline');
  assert(Math.abs(editModeZoomScaleAt([event],
    (event.peakStartSec + event.peakEndSec) / 2) - event.peakScale) < 1e-6);
  const zoomed = graphOf(safe).graph;
  assert(zoomed.includes('zoompan'));
  assert(zoomed.includes(zoomEnvelopeExpression(safe.plan.zoomEvents)));

  // A beat the footage cannot carry is suppressed LOCALLY, not globally.
  const unsafe = plan({ assets: [sourceAsset(edgeFace())],
    settings: zoomSettings({ moments: [
      { startSec: 3, endSec: 4, reason: 'STATISTIC', triggerText: 'compounding',
        intensity: 'STRONG' },
      { startSec: 9, endSec: 10, reason: 'REVEAL', triggerText: 'invested', intensity: 'STRONG' }
    ] }) });
  assert.equal(unsafe.plan.zoomEvents.length, 0);
  assert.equal(unsafe.plan.zoomRejections.length, 2);
  assert(unsafe.plan.zoomRejections.every((item) => item.reason));

  // A beat whose words were trimmed away disappears with the cut.
  const trimmed = plan({ settings: zoomSettings(),
    elements: [videoElement('a', 0, 8, 16, 0)] });
  assert.equal(trimmed.plan.zoomEvents.length, 0);
  assert.equal(trimmed.plan.zoomRejections[0].reason, 'TRIGGER_REMOVED_FROM_TIMELINE');

  // An information shot is never punched into.
  const slideZoom = plan({ assets: [sourceAsset(slide())],
    settings: zoomSettings({ style: { reframePolicy: 'INFORMATION_PRESERVING',
      informationRegionPolicy: 'PRESERVE' } }) });
  assert.equal(slideZoom.plan.zoomEvents.length, 0);
  assert(slideZoom.plan.zoomRejections[0].reason.startsWith('SHOT_'));

  // A QA repair suppresses exactly the event it names and nothing else.
  const two = [{ startSec: 3, endSec: 4, reason: 'STATISTIC', triggerText: 'compounding',
    intensity: 'MODERATE' },
  { startSec: 8, endSec: 9, reason: 'REVEAL', triggerText: 'invested', intensity: 'MODERATE' }];
  const both = plan({ settings: zoomSettings({ moments: two }) });
  assert.equal(both.plan.zoomEvents.length, 2);
  const repaired = plan({ settings: zoomSettings({ moments: two }),
    suppressedZoomIds: [both.plan.zoomEvents[0].id] });
  assert.equal(repaired.plan.zoomEvents.length, 1, 'only the named zoom is dropped');
  assert.equal(repaired.plan.zoomEvents[0].id, both.plan.zoomEvents[1].id);

  // A reduced ceiling lowers that one move instead of removing it.
  const reduced = plan({ settings: zoomSettings({ moments: two }),
    zoomScaleCeilings: { [both.plan.zoomEvents[0].id]: 1.05 } });
  assert.equal(reduced.plan.zoomEvents[0].peakScale, 1.05);
  assert.equal(reduced.plan.zoomEvents[0].reducedFromScale, EDIT_MODE_ZOOM_SCALES.MODERATE);
  assert.equal(reduced.plan.zoomEvents[1].peakScale, EDIT_MODE_ZOOM_SCALES.MODERATE);
  console.log('  semantic zoom: OFF, safe render, local suppression, repair, bounded scales');
}

// --- 6. Grading -------------------------------------------------------------

function grading() {
  const none = plan({ settings: settings({ gradingPolicy: 'NONE' }) });
  assert.equal(none.plan.grading.filter, 'null');
  assert(!graphOf(none).graph.includes('curves='));

  for (const policy of ['SUBTLE', 'CLEAN', 'WARM', 'CONTRAST']) {
    const built = plan({ settings: settings({ gradingPolicy: policy }) });
    assert.equal(built.plan.grading.policy, policy);
    assert.equal(built.plan.grading.preset, EDIT_MODE_GRADES[policy].preset);
    assert(built.plan.grading.filter.startsWith('eq=contrast='));
    assert(graphOf(built).graph.includes(built.plan.grading.filter));
  }
  // Restrained, never LUT-like: the strongest EditMode grade stays gentle.
  const contrast = plan({ settings: settings({ gradingPolicy: 'CONTRAST' }) });
  const value = Number(/contrast=([\d.]+)/u.exec(contrast.plan.grading.filter)[1]);
  assert(value > 1 && value < 1.12, `contrast ${value} must stay restrained`);
  console.log('  grading: NONE is a true no-op; SUBTLE/CLEAN/WARM/CONTRAST stay restrained');
}

// --- 7. Text, image and logo overlays --------------------------------------

const textElement = (id, over = {}) => ({ id, assetId: null, type: over.type ?? 'TEXT',
  track: 1, position: 0, startTime: over.startTime ?? 1, duration: over.duration ?? 3,
  trimStart: 0, trimEnd: null,
  properties: { content: 'Compound interest beats timing', x: 0.1, y: 0.4, width: 0.8,
    height: 0.16, fontSize: 48, fontWeight: 700, fontFamily: 'Arial, sans-serif',
    textAlign: 'center', color: '#ffffff', backgroundColor: 'transparent', opacity: 1,
    zIndex: 30, ...over.properties } });

const imageElement = (id, assetId, over = {}) => ({ id, assetId, type: 'IMAGE', track: 2,
  position: 0, startTime: over.startTime ?? 0, duration: over.duration ?? 5, trimStart: 0,
  trimEnd: null, properties: { x: 0.6, y: 0.05, width: 0.3, height: 0.1, opacity: 1,
    zIndex: 10, role: 'IMAGE', preserveAspectRatio: true, ...over.properties } });

function overlays() {
  const built = plan({ assets: [sourceAsset(talkingHead()), imageAsset('img'),
    imageAsset('logo', 'LOGO')],
  elements: [videoElement('v1', 0, 0, 12, 0),
    imageElement('i1', 'img', { properties: { zIndex: 10, opacity: 0.75 } }),
    imageElement('i2', 'logo', { startTime: 2, duration: 4,
      properties: { role: 'LOGO', zIndex: 20, x: 0.02, y: 0.02, width: 0.18, height: 0.08 } })] });
  assert.equal(built.plan.visualOverlays.length, 2);
  const [image, logo] = built.plan.visualOverlays;
  assert.equal(image.role, 'IMAGE');
  assert.equal(logo.role, 'LOGO');
  // The normalized box resolves to canvas pixels, top-left anchored, exactly as
  // the editor preview draws it.
  assert.equal(image.x, Math.round(0.6 * 1080));
  assert.equal(image.y, Math.round(0.05 * 1920));
  assert.equal(image.width, Math.round(0.3 * 1080));
  assert.equal(image.height, Math.round(0.1 * 1920));

  const { graph } = graphOf(built, { overlayPaths: { i1: '/tmp/i1.png', i2: '/tmp/i2.png' } });
  assert(graph.includes('colorchannelmixer=aa=0.7500'), 'opacity is honoured');
  assert(graph.includes("enable='between(t\\,2.000\\,6.000)'"), 'overlay timing is honoured');
  assert(graph.includes('force_original_aspect_ratio=decrease'), 'aspect ratio is preserved');
  // zIndex decides the compositing order, not the element order.
  assert(graph.indexOf('[ov0]') < graph.indexOf('[ov1]'));
  assert(/\[vov0\]\[ov1\]overlay/u.test(graph), 'the higher zIndex composites last');

  const flat = plan({ assets: [sourceAsset(talkingHead()), imageAsset('img')],
    elements: [videoElement('v1', 0, 0, 12, 0),
      imageElement('i1', 'img', { properties: { preserveAspectRatio: false } })] });
  assert(!graphOf(flat, { overlayPaths: { i1: '/tmp/i1.png' } }).graph
    .includes('force_original_aspect_ratio=decrease'));
  console.log('  overlays: image, logo, placement, opacity, timing, zIndex order');
}

// --- 8. Text and subtitle rendering ----------------------------------------

function textRendering() {
  // The preview sizes text at fontSize/6 cqw; the renderer uses the same formula.
  assert.equal(fontSizePx(48, 1080), Math.round(48 * 1080 / 600));
  assert.equal(toAssColor('#ffffff'), '&H00FFFFFF');
  assert.equal(toAssColor('#00000099'), '&H66000000');
  assert.equal(toAssColor('#ffffff', 0.5), '&H80FFFFFF');
  assert.deepEqual(wrapToWidth('one two three', 40, 10000), ['one two three']);
  assert(wrapToWidth('one two three four five six seven', 40, 120).length > 1);

  const built = plan({ elements: [videoElement('v1', 0, 0, 12, 0),
    textElement('t1', { properties: { zIndex: 30, textAlign: 'center' } }),
    textElement('t2', { type: 'SUBTITLE', startTime: 4, duration: 2,
      properties: { content: 'staying invested', zIndex: 35, y: 0.73,
        backgroundColor: '#00000099' } })] });
  assert.equal(built.plan.textOverlays.length, 1);
  assert.equal(built.plan.subtitles.length, 1);

  const ass = buildEditModeAss(built.plan.canvas, [...built.plan.textOverlays,
    ...built.plan.subtitles]);
  assert(ass.content.includes('PlayResX: 1080') && ass.content.includes('PlayResY: 1920'));
  assert.equal(ass.eventCount, 2);
  // The stored wording is what is drawn: line breaks may be added to fit the
  // element's own box, but no word is dropped, added or rewritten.
  const drawn = ass.content.split('\n').filter((line) => line.startsWith('Dialogue:'))
    .map((line) => line.replace(/^.*\{[^}]*\}/u, '').replace(/\\N/gu, ' '));
  assert.deepEqual(drawn, ['Compound interest beats timing', 'staying invested']);
  // zIndex is the ASS layer, so the canonical stacking is what libass composites.
  assert(/Dialogue: 30,0:00:01\.00,0:00:04\.00,/u.test(ass.content));
  assert(/Dialogue: 35,0:00:04\.00,0:00:06\.00,/u.test(ass.content));
  assert(ass.content.includes('\\pos(540,'), 'positioned from the normalized box');
  // A background colour becomes an opaque ASS box; transparent text keeps a stroke.
  const styles = ass.content.split('\n').filter((line) => line.startsWith('Style:'));
  assert(styles[0].includes(',1,'), 'unboxed text uses BorderStyle 1');
  assert(styles[1].includes('&H66000000'), 'the caption plate carries its own alpha');
  console.log('  text: exact wording, preview-matched sizing, colours, timing, zIndex layers');
}

// --- 9. Subtitles from a policy-only project -------------------------------

function subtitlesFromTranscript() {
  const off = plan({ settings: settings({ subtitlePolicy: 'OFF' }) });
  assert.equal(off.plan.subtitles.length, 0);
  assert.equal(off.plan.subtitlesFromTranscript, false);

  const built = plan({ settings: settings({ subtitlePolicy: 'ALWAYS' }) });
  assert(built.plan.subtitles.length > 3, 'captions come from the cached transcript');
  assert.equal(built.plan.subtitlesFromTranscript, true);
  const words = new Set(SPEECH.map((word) => word.toLowerCase().replace(/[^a-z]/gu, '')));
  for (const caption of built.plan.subtitles) {
    // No hallucinated caption text: every word is a transcript word.
    for (const word of caption.content.split(/\s+/u)) {
      assert(words.has(word.toLowerCase().replace(/[^a-z]/gu, '')),
        `caption word "${word}" is not in the transcript`);
    }
    assert(caption.endSec <= built.plan.durationSec + 1e-6);
    assert(caption.startSec >= 0);
  }
  // Timings are the transcript's own, remapped onto the exported timeline.
  const transcript = transcriptFixture();
  const first = built.plan.subtitles[0];
  assert.equal(first.startSec, transcript.segments[0].words[0].start);

  // A caption never outlives the clip its words were spoken in.
  const cut = plan({ settings: settings({ subtitlePolicy: 'ALWAYS' }),
    elements: [videoElement('a', 0, 0, 3, 0), videoElement('b', 1, 10, 13, 3)] });
  for (const caption of cut.plan.subtitles) {
    const segment = cut.plan.videoSegments.find((item) => caption.startSec >= item.timelineStart &&
      caption.startSec < item.timelineEnd);
    assert(caption.endSec <= segment.timelineEnd + 1e-6, 'a caption is held at its own cut');
  }

  // Without word timings nothing is invented: the policy is reported, not faked.
  const untimed = plan({ settings: settings({ subtitlePolicy: 'ALWAYS' }),
    assets: [sourceAsset(talkingHead(), { transcript: { text: 'hello', segments: [
      { start: 0, end: 4, text: 'hello there' }] } })] });
  assert.equal(untimed.plan.subtitles.length, 0);
  assert(untimed.plan.warnings.some((item) => item.includes('no word timings')));

  // Caption elements already on the timeline are used verbatim instead.
  const authored = plan({ settings: settings({ subtitlePolicy: 'ALWAYS' }),
    elements: [videoElement('v1', 0, 0, 12, 0),
      textElement('s1', { type: 'SUBTITLE', properties: { content: 'exactly this' } })] });
  assert.equal(authored.plan.subtitles.length, 1);
  assert.equal(authored.plan.subtitles[0].content, 'exactly this');
  assert.equal(authored.plan.subtitlesFromTranscript, false);
  console.log('  subtitles: transcript-exact render-time captions, held at cuts, no invention');
}

// --- 10. Audio and music ----------------------------------------------------

const audioElement = (id, over = {}) => ({ id, assetId: 'mus', type: 'AUDIO', track: 3,
  position: 0, startTime: over.startTime ?? 0, duration: over.duration ?? 6, trimStart: 0,
  trimEnd: over.trimEnd ?? 6, properties: { volume: 0.25, muted: false, fadeInSec: 0,
    fadeOutSec: 0, duckUnderSpeech: false, duckLevel: 0.25, attackMs: 150, releaseMs: 350,
    ...over.properties } });

function audio() {
  const withMusic = plan({ assets: [sourceAsset(talkingHead()), audioAsset('mus')],
    elements: [videoElement('v1', 0, 0, 12, 0),
      audioElement('a1', { startTime: 2, properties: { volume: 0.3, fadeInSec: 0.5,
        fadeOutSec: 1 } })] });
  assert.equal(withMusic.plan.audioTracks.length, 1);
  const track = withMusic.plan.audioTracks[0];
  assert.equal(track.volume, 0.3);
  assert.equal(track.duckUnderSpeech, false);
  assert.equal(track.attackMs, 150, 'Phase 3 ducking properties are preserved on the plan');

  const { graph } = graphOf(withMusic, { audioPaths: { a1: '/tmp/music.wav' } });
  assert(graph.includes('volume=0.3000'));
  assert(graph.includes('afade=t=in:st=0:d=0.500'));
  assert(graph.includes('afade=t=out:st=5.000:d=1.000'));
  assert(graph.includes('adelay=2000:all=1'), 'music starts where the timeline says');
  assert(graph.includes('amix=inputs=2'), 'dialogue and music are mixed');
  assert(graph.includes('normalize=0'), 'element levels are not renormalised');
  assert(graph.includes('alimiter'), 'the summed mix cannot clip');

  // Muted or silent music contributes nothing and is not even decoded.
  const muted = plan({ assets: [sourceAsset(talkingHead()), audioAsset('mus')],
    elements: [videoElement('v1', 0, 0, 12, 0),
      audioElement('a1', { properties: { muted: true } })] });
  const mutedGraph = graphOf(muted, { audioPaths: { a1: '/tmp/music.wav' } });
  assert(!mutedGraph.graph.includes('amix='));
  assert(!mutedGraph.args.includes('/tmp/music.wav'));

  // A source without audio exports a video-only file rather than silence.
  const silent = plan({ hasSourceAudio: false });
  const silentGraph = graphOf(silent);
  assert(!silentGraph.graph.includes('[acat]'));
  assert(!silentGraph.args.includes('-c:a'));
  console.log('  audio: source mix, music volume, mute, fades, delay, clipping guard');
}

// --- 11. Pre-render validation ---------------------------------------------

function preRenderValidation() {
  const assets = [sourceAsset(talkingHead()), imageAsset('img'), audioAsset('mus')];
  const good = plan({ assets, elements: [videoElement('v1', 0, 0, 12, 0),
    imageElement('i1', 'img')] });
  assert.equal(validateRenderPlan(good.plan, { assets,
    sourceProbe: { hasVideo: true, hasAudio: true, durationSec: SOURCE_DURATION } }), true);

  // A missing overlay asset is refused while planning, before any encode.
  rejects(() => plan({ assets: [sourceAsset(talkingHead())],
    elements: [videoElement('v1', 0, 0, 12, 0), imageElement('i1', 'gone')] }), 'ASSET_MISSING');
  rejects(() => plan({ assets: [sourceAsset(talkingHead())],
    elements: [videoElement('v1', 0, 0, 12, 0), audioElement('a1')] }), 'ASSET_MISSING');
  rejects(() => plan({ assets: [imageAsset('img')] }), 'SOURCE_MISSING');

  // A trim past the end of the source, and an impossible trim.
  rejects(() => validateRenderPlan(
    plan({ elements: [videoElement('v1', 0, 0, 900, 0)] }).plan,
    { assets, sourceProbe: null }), 'INVALID_TIMELINE');
  rejects(() => plan({ elements: [videoElement('v1', 0, 8, 4, 0)] }), 'INVALID_TIMELINE');
  rejects(() => plan({ elements: [videoElement('v1', 0, -4, -1, 0)] }), 'INVALID_TIMELINE');

  // A source with no video stream is unsupported, not a failed render.
  rejects(() => validateRenderPlan(good.plan, { assets,
    sourceProbe: { hasVideo: false, hasAudio: true, durationSec: 12 } }), 'UNSUPPORTED_MEDIA');
  // An overlay whose file type the renderer cannot decode.
  rejects(() => validateRenderPlan(good.plan,
    { assets: assets.map((asset) => asset.id === 'img'
      ? { ...asset, mimeType: 'image/tiff' } : asset), sourceProbe: null }), 'UNSUPPORTED_MEDIA');

  // An element placed outside the frame, an empty text element, a bad fade.
  const outside = plan({ assets, elements: [videoElement('v1', 0, 0, 12, 0),
    imageElement('i1', 'img', { properties: { x: 0.95, width: 0.3 } })] });
  outside.plan.visualOverlays[0].x = 2000;
  rejects(() => validateRenderPlan(outside.plan, { assets, sourceProbe: null }),
    'INVALID_TIMELINE');
  const empty = plan({ elements: [videoElement('v1', 0, 0, 12, 0),
    textElement('t1', { properties: { content: '   ' } })] });
  rejects(() => validateRenderPlan(empty.plan, { assets, sourceProbe: null }), 'INVALID_TIMELINE');
  const fade = plan({ assets, elements: [videoElement('v1', 0, 0, 12, 0),
    audioElement('a1', { duration: 2, properties: { fadeInSec: 2, fadeOutSec: 2 } })] });
  rejects(() => validateRenderPlan(fade.plan, { assets, sourceProbe: null }), 'INVALID_TIMELINE');

  // An invalid canvas never reaches FFmpeg.
  const canvas = plan();
  canvas.plan.canvas.width = 1081;
  rejects(() => validateRenderPlan(canvas.plan, { assets, sourceProbe: null }),
    'INVALID_TIMELINE');
  console.log('  pre-render validation: missing/unsupported media and impossible timelines');
}

// --- 12. QA sampling is bounded --------------------------------------------

function boundedQa() {
  const many = [videoElement('v1', 0, 0, 12, 0)];
  const built = plan({ settings: settings({ subtitlePolicy: 'ALWAYS' }), elements: many });
  const numbers = qaFrameNumbers(built.plan, built.evidence);
  assert(numbers.length > 0 && numbers.length <= EDIT_MODE_QA.maxFrames,
    `QA sampled ${numbers.length} frames, above the bound`);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  assert(numbers.every((value) => Number.isInteger(value) && value >= 0));
  // The set spans the timeline rather than clustering on one event class.
  assert(numbers[numbers.length - 1] > built.plan.durationSec * built.plan.canvas.fps * 0.5);
  console.log(`  QA sampling stays bounded (${numbers.length} frames)`);
}

// --- 13. Framing QA classification and repair ------------------------------

/** A hand-built evidence set: it puts a detection exactly where the camera is,
 * or exactly where it is not, so the classifier's verdict is deterministic. */
const evidenceWith = (over) => ({ shots: over.shots ?? [], informationRegion: null,
  informationCrop: null, frames: over.frames, cropAt: over.cropAt,
  fitExpression: '', informationFitExpression: '', cameraFilter: '', renderHeight: 1920 });

const analysisFrame = (t, over = {}) => ({ t, faces: [], persons: [], textCoverage: 0,
  textBoxes: [], ocrLines: [], ...over });

function framingQa() {
  const base = plan();
  const framed = { x: 0.3, y: 0.05, w: 0.4, h: 0.9 };

  // A subject squarely inside the camera window passes.
  const safe = framingChecks(base.plan, evidenceWith({
    frames: [analysisFrame(1, { faces: [{ timestamp: 1, x: 0.4, y: 0.2, w: 0.15, h: 0.2 }] })],
    cropAt: () => framed }));
  assert.equal(safe.checks[0].result, 'PASS');
  assert.equal(safe.subjectSafetyRatio, 1);

  // A subject the crop cuts in half is a VISIBLE defect: REPAIR_REQUIRED, never
  // filed as acceptable degradation, and the repair widens that one shot.
  const unsafe = framingChecks(base.plan, evidenceWith({
    frames: [analysisFrame(1, { faces: [{ timestamp: 1, x: 0.22, y: 0.2, w: 0.16, h: 0.2 }] })],
    cropAt: () => framed }));
  assert.equal(unsafe.checks[0].result, 'REPAIR_REQUIRED');
  assert.deepEqual(unsafe.checks[0].repair, { kind: 'WIDEN_CROP', shotIndex: 0 });
  assert(unsafe.subjectSafetyRatio < EDIT_MODE_QA.subjectSafetyTarget);

  // The same failure under an active zoom blames the zoom, not the crop, so the
  // repair drops one move instead of giving up the framing for the whole shot.
  const zoomed = plan({ settings: zoomSettings() });
  const event = zoomed.plan.zoomEvents[0];
  const peak = (event.peakStartSec + event.peakEndSec) / 2;
  const duringZoom = framingChecks(zoomed.plan, evidenceWith({
    frames: [analysisFrame(peak, { faces: [{ timestamp: peak, x: 0.22, y: 0.2, w: 0.16, h: 0.2 }] })],
    cropAt: () => framed }));
  assert.equal(duringZoom.checks[0].result, 'REPAIR_REQUIRED');
  assert.deepEqual(duringZoom.checks[0].repair, { kind: 'SUPPRESS_ZOOM', zoomEventId: event.id });
  // And applying exactly that repair re-plans without it, leaving nothing else
  // disabled - the global zoom policy is untouched.
  const afterRepair = plan({ settings: zoomSettings(), suppressedZoomIds: [event.id] });
  assert.equal(afterRepair.plan.zoomEvents.length, 0);
  assert.equal(afterRepair.plan.policies.zoomPolicy, 'MODERATE');

  // Widening a shot really does change the render: the crop becomes a fit.
  const widened = plan({ widenShots: [0] });
  assert.equal(widened.plan.frameSegments[0].layout, 'FIT');
  assert(widened.plan.frameSegments[0].reason.includes('QA_SUBJECT_SAFETY_REPAIR'));
  assert.equal(framingChecks(widened.plan, evidenceWith({
    frames: [analysisFrame(1, { faces: [{ timestamp: 1, x: 0.22, y: 0.2, w: 0.16, h: 0.2 }] })],
    cropAt: () => framed })).checks[0].result, 'PASS', 'a fitted shot cannot clip its subject');

  // Information that the crop cuts off is repaired by fitting that shot to its
  // readable region rather than rendering a chart illegibly.
  const slidePlan = plan({ assets: [sourceAsset(slide())],
    settings: settings({ reframePolicy: 'AUTO', informationRegionPolicy: 'IGNORE' }) });
  slidePlan.plan.frameSegments.forEach((segment) => { segment.layout = 'FILL'; });
  slidePlan.evidence.shots.forEach((shot) => { shot.informationMode = true; });
  const cropped = framingChecks(slidePlan.plan, evidenceWith({
    shots: slidePlan.evidence.shots,
    frames: [analysisFrame(1, { textBoxes: [{ x: 0.05, y: 0.15, w: 0.9, h: 0.3 }] })],
    cropAt: () => framed }));
  assert.equal(cropped.checks[1].result, 'REPAIR_REQUIRED');
  assert.deepEqual(cropped.checks[1].repair, { kind: 'INFORMATION_FIT', shotIndex: 0 });
  const repairedSlide = plan({ assets: [sourceAsset(slide())],
    settings: settings({ reframePolicy: 'AUTO', informationRegionPolicy: 'IGNORE' }),
    informationFitShots: [0] });
  assert.equal(repairedSlide.plan.frameSegments[0].layout, 'INFORMATION_FIT');
  assert(repairedSlide.plan.frameSegments[0].reason.includes('QA_INFORMATION_REPAIR'));
  console.log('  framing QA: subject safety, information readability, local repair selection');
}

// --- 14. Determinism and isolation -----------------------------------------

function determinism() {
  const a = JSON.stringify(plan().plan);
  const b = JSON.stringify(plan().plan);
  assert.equal(a, b, 'the same canonical state must produce the same plan');

  const changed = plan({ settings: settings({ gradingPolicy: 'CLEAN' }) });
  assert.notEqual(JSON.stringify(changed.plan), a);
  assert.equal(plan().plan.sourceRevision, 4, 'the plan captures the revision it was built from');

  const root = path.join(__dirname, '../src/modules/edit-mode/render');
  // Comments are allowed to name what EditMode deliberately avoids; the CODE
  // must not reference any of it, so comments are stripped before scanning.
  const strip = (content) => content.replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '').replace(/\s\/\/.*$/gmu, '');
  const sources = fs.readdirSync(root).map((file) => [file,
    strip(fs.readFileSync(path.join(root, file), 'utf8'))]);
  const forbidden = ['ProcessingQueueService', 'VideoProcessorService', 'ClipSelectionService',
    'ClipRenderQueueService', 'ClipExportService', 'processingJob', 'clipCandidate',
    'generatedClip', 'GeneratedClip', 'ClipCandidate', 'ProcessingJob', 'BullMQ', 'bullmq',
    'LlmRouterService', 'LlmProviderService', '@nestjs/bull', 'Queue'];
  for (const [file, content] of sources) {
    for (const token of forbidden) {
      assert(!content.includes(token),
        `${file} must not reference ${token}: EditMode rendering is isolated`);
    }
  }
  console.log('  determinism and isolation: no queue, no clip pipeline, no LLM in the render path');
}

// --- Runner -----------------------------------------------------------------

function main() {
  console.log('EditMode Phase 5 render planning:');
  timelineMapping();
  videoTimeline();
  aspectRatios();
  reframe();
  semanticZoom();
  grading();
  overlays();
  textRendering();
  subtitlesFromTranscript();
  audio();
  preRenderValidation();
  boundedQa();
  framingQa();
  determinism();
  console.log('EditMode render planning tests passed.');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = { talkingHead, edgeFace, slide, sourceAsset, imageAsset, audioAsset,
  videoElement, textElement, imageElement, audioElement, settings, transcriptFixture,
  SOURCE_DURATION, SPEECH };
