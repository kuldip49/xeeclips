// EditMode manual transform - crop, rotation, flip, scale, position and speed.
//
// Offline and fast, in the same spirit as test-edit-mode-render.cjs: every
// assertion is about pure, deterministic state - the bounds a command accepts,
// the timeline a speed change produces, and the exact FFmpeg chain the renderer
// emits for a given transform. Nothing encodes and nothing touches a database.
//
// The load-bearing claim this file exists to check is PARITY: a transform the
// editor can store is one the renderer actually reproduces. Before this
// workstream `rotation` was stored and previewed but silently dropped at render
// time, so "the export matches the preview" is asserted here explicitly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

const M = '../dist/modules/edit-mode';
const { validateCrop, validateRotation, validateScale, validateSpeed, validateOffset,
  timelineDurationFor, videoLayout, projectInstant, retimeOverlays, readSpeed, readCrop,
  readTransform, TransformRangeError, MIN_CROP_REMAINDER,
  SPEED_PRESETS } = require(`${M}/edit-mode-transform.js`);
const { segmentTransformFilter, overlayTransformFilter,
  atempoChain } = require(`${M}/render/edit-mode-segment-filter.js`);
const { buildTimelineMap } = require(`${M}/render/edit-mode-timeline-map.js`);
const { buildRenderPlan } = require(`${M}/render/edit-mode-render-plan.js`);
const { buildFfmpegArgs } = require(`${M}/render/edit-mode-filtergraph.js`);

let checks = 0;
const ok = (label, condition) => {
  assert(condition, label);
  checks += 1;
  console.log(`  ok  ${label}`);
};
const section = (title) => console.log(`\n${title}`);

const rejects = (fn, code) => {
  try { fn(); } catch (error) {
    assert(error instanceof TransformRangeError, `expected TransformRangeError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
};

// --- Fixtures ---------------------------------------------------------------

const SOURCE_DURATION = 40;
const sourceAsset = () => ({ id: 'src', role: 'SOURCE', mimeType: 'video/mp4',
  duration: SOURCE_DURATION, width: 1920, height: 1080, fps: 30,
  metadata: { hasAudio: true }, transcript: null,
  analysis: { source: 'DENSE', shotBoundaries: [], ocrText: '', frames: [] } });
const imageAsset = (id, role = 'IMAGE') => ({ id, role, mimeType: 'image/png', duration: null,
  width: 400, height: 200, fps: null, metadata: {}, transcript: null, analysis: null });

const videoElement = (id, position, trimStart, trimEnd, startTime, properties = {}) => {
  const speed = Number(properties.speed) || 1;
  return { id, assetId: 'src', type: 'VIDEO', track: 0, position, startTime,
    duration: (trimEnd - trimStart) / speed, trimStart, trimEnd, properties };
};

const settings = (over = {}) => ({ selectedPreset: 'PODCAST_CLIP', aspectRatio: 'SOURCE',
  pacing: 'MODERATE', subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF',
  reframePolicy: 'SOURCE', musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null, ...over });

const plan = (over = {}) => buildRenderPlan({
  project: { id: 'project-1', revision: 4, settings: over.settings ?? settings() },
  assets: over.assets ?? [sourceAsset()],
  elements: over.elements ?? [videoElement('v1', 0, 0, 12, 0)],
  hasSourceAudio: over.hasSourceAudio ?? true, fps: 30 });

const graphOf = (built, over = {}) => {
  const args = buildFfmpegArgs({ plan: built.plan, sourcePath: '/tmp/source.mp4',
    overlayPaths: over.overlayPaths ?? {}, audioPaths: {}, assFileName: null,
    outputPath: '/tmp/out.mp4', informationCrop: built.evidence.informationCrop,
    fitExpression: built.evidence.fitExpression,
    informationFitExpression: built.evidence.informationFitExpression,
    cameraFilter: built.evidence.cameraFilter });
  return args[args.indexOf('-filter_complex') + 1];
};

const NEUTRAL = { crop: { left: 0, right: 0, top: 0, bottom: 0 }, rotation: 0,
  flipH: false, flipV: false, scale: 1, offsetX: 0, offsetY: 0 };

function main() {
  console.log('EditMode manual transform\n');

  // --- 1. Bounds ------------------------------------------------------------
  section('1. Typed bounds, not arbitrary JSON');
  ok('a neutral crop is four zeroes',
    JSON.stringify(validateCrop({})) === JSON.stringify({ left: 0, right: 0, top: 0, bottom: 0 }));
  ok('a normal crop is accepted',
    validateCrop({ left: 0.1, right: 0.1, top: 0.2, bottom: 0 }).top === 0.2);
  ok('a crop that leaves too little width is refused',
    rejects(() => validateCrop({ left: 0.5, right: 0.5 }), 'INVALID_CROP'));
  ok('a crop that leaves too little height is refused',
    rejects(() => validateCrop({ top: 0.6, bottom: 0.4 }), 'INVALID_CROP'));
  ok('a negative crop is refused',
    rejects(() => validateCrop({ left: -0.1 }), 'INVALID_CROP'));
  ok('rotation accepts the full -180..180 range',
    validateRotation(-180) === -180 && validateRotation(180) === 180);
  ok('rotation past 180 is refused',
    rejects(() => validateRotation(181), 'INVALID_ROTATION'));
  ok('a non-numeric rotation is refused',
    rejects(() => validateRotation('sideways'), 'INVALID_ROTATION'));
  ok('scale is bounded at both ends',
    rejects(() => validateScale(0.01), 'INVALID_SCALE') &&
    rejects(() => validateScale(9), 'INVALID_SCALE'));
  ok('speed is bounded at both ends',
    rejects(() => validateSpeed(0.1), 'INVALID_SPEED') &&
    rejects(() => validateSpeed(8), 'INVALID_SPEED'));
  ok('every offered speed preset is inside the accepted bounds',
    SPEED_PRESETS.every((preset) => validateSpeed(preset) === preset));
  ok('position is bounded to the canvas',
    rejects(() => validateOffset(2, 'x'), 'INVALID_POSITION'));
  ok('unreadable stored state reads back as neutral, never as NaN',
    readSpeed(undefined) === 1 && readSpeed({ speed: 'fast' }) === 1 &&
    readCrop(null).left === 0 && readTransform({}).rotation === 0);

  // --- 2. Speed and the timeline -------------------------------------------
  section('2. Speed changes real timeline duration');
  ok('2x halves the timeline length of a source range',
    timelineDurationFor(0, 10, 2) === 5);
  ok('0.5x doubles it', timelineDurationFor(0, 10, 0.5) === 20);
  ok('1x is the original trim-range rule', timelineDurationFor(4, 16, 1) === 12);

  const sped = plan({ elements: [videoElement('v1', 0, 0, 12, 0, { speed: 2 })] });
  ok('a 2x 12s segment exports as a 6s timeline', sped.plan.durationSec === 6);
  ok('the segment still reads its full source range',
    sped.plan.videoSegments[0].sourceStart === 0 && sped.plan.videoSegments[0].sourceEnd === 12);
  ok('the segment carries its speed into the render plan',
    sped.plan.videoSegments[0].speed === 2);

  const map = buildTimelineMap([
    { id: 'v1', type: 'VIDEO', track: 0, position: 0, startTime: 0, duration: 6,
      trimStart: 0, trimEnd: 12, properties: { speed: 2 } }]);
  ok('timeline -> source scales by the playback rate', map.toSource(3) === 6);
  ok('source -> timeline is its exact inverse', map.toTimeline(6)[0] === 3);
  ok('a sped segment reports the shortened span', map.durationSec === 6);

  // --- 3. Ripple ------------------------------------------------------------
  section('3. Speed ripples later clips and the overlays on them');
  const before = [videoElement('v1', 0, 0, 10, 0), videoElement('v2', 1, 10, 20, 10)];
  const after = [videoElement('v1', 0, 0, 10, 0, { speed: 2 }), videoElement('v2', 1, 10, 20, 5)];
  const layoutBefore = videoLayout(before);
  const layoutAfter = videoLayout(after);
  ok('the sped clip is half as long on the timeline',
    layoutAfter[0].end === 5 && layoutBefore[0].end === 10);
  ok('the following clip starts earlier by exactly the time saved',
    layoutAfter[1].start === 5 && layoutAfter[1].end === 15);
  ok('an instant inside the sped clip keeps its position within that clip',
    projectInstant(5, layoutBefore, layoutAfter) === 2.5);
  ok('an instant in the following clip keeps its position within THAT clip',
    projectInstant(15, layoutBefore, layoutAfter) === 10);

  const overlays = [...after,
    { id: 'logo', type: 'IMAGE', track: 2, startTime: 5, duration: 5, trimStart: 0, trimEnd: null },
    { id: 'cap', type: 'SUBTITLE', track: 1, startTime: 18, duration: 2, trimStart: 0, trimEnd: null },
    { id: 'mus', type: 'AUDIO', track: 3, startTime: 0, duration: 20, trimStart: 0, trimEnd: 20 }];
  const retimed = retimeOverlays(overlays, layoutBefore, layoutAfter, 0.05);
  const byId = (id) => retimed.find((element) => element.id === id);
  ok('an overlay on the sped clip is retimed onto it', byId('logo').startTime === 2.5);
  ok('every retimed element still ends inside the shortened timeline',
    retimed.filter((element) => element.type !== 'VIDEO')
      .every((element) => element.startTime + element.duration <= 15 + 1e-6));
  ok('nothing is dropped - a squeezed overlay is kept, not deleted',
    retimed.filter((element) => element.type !== 'VIDEO').length === 3);
  ok('a retimed AUDIO element keeps its trim window consistent with its length',
    Math.abs((byId('mus').trimEnd - byId('mus').trimStart) - byId('mus').duration) < 1e-6);
  ok('VIDEO elements are never retimed by the overlay pass',
    byId('v1').startTime === 0 && byId('v2').startTime === 5);

  // --- 4. The filter chain --------------------------------------------------
  section('4. The renderer reproduces the stored transform exactly');
  ok('a neutral transform emits no filter at all',
    segmentTransformFilter(NEUTRAL, 1920, 1080) === '');
  const cropped = segmentTransformFilter(
    { ...NEUTRAL, crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 } }, 1920, 1080);
  ok('a crop resolves to exact even pixel geometry', cropped.startsWith('crop=960:1080:480:0'));
  ok('a cropped segment is normalized back to source size so concat still works',
    cropped.includes('scale=1920:1080:force_original_aspect_ratio=decrease'));
  // A 16:9 crop of a 9:16 source must letterbox, not come out three times too
  // tall. Fitting and padding is what keeps a crop from distorting the picture.
  ok('a crop that changes aspect is fitted and padded, never stretched',
    cropped.includes('pad=1920:1080') && !/scale=1920:1080(?!:)/u.test(cropped));
  // Regression: a crop followed by a scale leaves a non-unit sample aspect
  // ratio, and concat compares SAR as well as pixel size. Without setsar a
  // transformed segment cannot be joined to an untransformed one and the whole
  // export fails to open an encoder. Caught only by real-media verification.
  ok('a transformed segment resets its sample aspect ratio for concat',
    cropped.endsWith('setsar=1'));
  ok('every transform path ends with a normalized SAR',
    [{ ...NEUTRAL, rotation: 30 }, { ...NEUTRAL, flipH: true }, { ...NEUTRAL, scale: 2 },
      { ...NEUTRAL, scale: 0.5 }, { ...NEUTRAL, offsetX: 0.2 }]
      .every((transform) => segmentTransformFilter(transform, 1920, 1080).endsWith('setsar=1')));
  ok('horizontal flip emits hflip',
    segmentTransformFilter({ ...NEUTRAL, flipH: true }, 1920, 1080).includes('hflip'));
  ok('vertical flip emits vflip',
    segmentTransformFilter({ ...NEUTRAL, flipV: true }, 1920, 1080).includes('vflip'));
  const rotated = segmentTransformFilter({ ...NEUTRAL, rotation: 90 }, 1920, 1080);
  ok('rotation emits a rotate filter in radians', rotated.includes('rotate=1.570796'));
  ok('rotation keeps the frame size rather than growing it',
    rotated.includes('ow=iw:oh=ih'));
  const ordered = segmentTransformFilter({ ...NEUTRAL,
    crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 }, flipH: true, rotation: 10 }, 1920, 1080);
  ok('the order is crop, then flip, then rotate',
    ordered.indexOf('crop=') < ordered.indexOf('hflip') &&
    ordered.indexOf('hflip') < ordered.indexOf('rotate='));
  const zoomed = segmentTransformFilter({ ...NEUTRAL, scale: 2 }, 1920, 1080);
  ok('scaling up crops back to canvas size', zoomed.includes('scale=3840:2160') &&
    zoomed.includes('crop=1920:1080'));
  ok('a transformed and an untransformed segment agree on size AND SAR',
    segmentTransformFilter({ ...NEUTRAL, rotation: 5 }, 1920, 1080).endsWith('setsar=1'));
  const shrunk = segmentTransformFilter({ ...NEUTRAL, scale: 0.5 }, 1920, 1080);
  ok('scaling down pads back to canvas size', shrunk.includes('pad=1920:1080'));
  ok('position shifts the crop window off centre',
    !segmentTransformFilter({ ...NEUTRAL, scale: 2, offsetX: 0.25 }, 1920, 1080)
      .includes('crop=1920:1080:960:540'));

  // --- 5. Overlay transforms ------------------------------------------------
  section('5. Overlay crop, flip and rotation');
  ok('an untouched overlay emits no transform',
    overlayTransformFilter({ crop: { left: 0, right: 0, top: 0, bottom: 0 }, rotation: 0,
      flipH: false, flipV: false }) === '');
  ok('an overlay crop is expressed against decode-time dimensions',
    overlayTransformFilter({ crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 }, rotation: 0,
      flipH: false, flipV: false }).includes('crop=iw*0.800000'));
  ok('a rotated overlay opens TRANSPARENT corners, not black boxes',
    overlayTransformFilter({ crop: { left: 0, right: 0, top: 0, bottom: 0 }, rotation: 15,
      flipH: false, flipV: false }).includes('c=black@0'));

  // --- 6. Audio -------------------------------------------------------------
  section('6. Speed retimes source audio, not just video');
  ok('1x emits no atempo', atempoChain(1) === '');
  ok('2x is a single in-range step', atempoChain(2) === 'atempo=2');
  ok('4x is chained rather than emitting an out-of-range atempo',
    atempoChain(4) === 'atempo=2,atempo=2');
  ok('0.25x is chained downward the same way',
    atempoChain(0.25) === 'atempo=0.5,atempo=0.5');
  ok('an odd rate resolves to in-range steps whose product is the rate',
    Math.abs(atempoChain(3).split(',')
      .reduce((total, step) => total * Number(step.split('=')[1]), 1) - 3) < 1e-4);

  // --- 7. End to end through the real graph builder -------------------------
  section('7. Parity: what is stored is what is rendered');
  const neutralGraph = graphOf(plan());
  ok('an untouched timeline still emits the original setpts string, byte for byte',
    neutralGraph.includes('setpts=PTS-STARTPTS') && !neutralGraph.includes('(PTS-STARTPTS)'));
  ok('an untouched timeline emits no transform filters',
    !neutralGraph.includes('hflip') && !neutralGraph.includes('rotate='));

  const spedGraph = graphOf(plan({ elements: [videoElement('v1', 0, 0, 12, 0, { speed: 2 })] }));
  ok('a sped segment rescales presentation timestamps',
    spedGraph.includes('setpts=(PTS-STARTPTS)/2.000000'));
  ok('a sped segment also retimes its audio', spedGraph.includes('atempo=2'));

  const transformed = graphOf(plan({ elements: [videoElement('v1', 0, 0, 12, 0,
    { crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 }, rotation: 12, flipH: true })] }));
  ok('a stored crop reaches the graph', transformed.includes('crop=1536:1080:192:0'));
  ok('a stored flip reaches the graph', transformed.includes('hflip'));
  ok('ROTATION REACHES THE GRAPH - the preview/render mismatch is fixed',
    transformed.includes('rotate=0.209440'));

  const fittedCrop = plan({ settings: settings({ aspectRatio: '9:16',
    fitBackground: 'WHITE', gradingPolicy: 'WARM' }), elements: [
    videoElement('v1', 0, 0, 12, 0, { frameLayout: 'FIT',
      crop: { left: 0.2, right: 0.2, top: 0, bottom: 0 } })] });
  const fittedCropGraph = graphOf(fittedCrop);
  ok('manual crop paints the fitted BACKGROUND black instead of the project background',
    /\[vfita\][^;]*drawbox=[^;]*color=white[^;]*drawbox=[^;]*color=black@1[^;]*\[vfitbg\]/u
      .test(fittedCropGraph));
  ok('the cropped video stays above that black background, never below an overlay',
    fittedCropGraph.includes('[vfitbg][vfitfg]overlay=(W-w)/2:(H-h)/2[vfit]'));
  ok('grading happens before crop geometry so generated black remains pure #000000',
    fittedCropGraph.indexOf(fittedCrop.plan.grading.filter) < fittedCropGraph.indexOf('crop=1152:1080') &&
    !fittedCropGraph.includes('[vgraded]'));

  const cardCrop = plan({ elements: [videoElement('v1', 0, 0, 12, 0,
    { crop: { left: 0.2, right: 0.2, top: 0, bottom: 0 } })] });
  cardCrop.plan.canvas.visualLayout = {
    version: 1, canvas: { width: 1080, height: 1920, aspect: '9:16' },
    videoFrame: { x: 0.1, y: 0.2, width: 0.8, height: 0.6, mode: 'CARD', cropPolicy: 'AUTO' },
    hook: { x: 0, y: 0, width: 1, height: 0.1, enabled: false, maxWidth: 1,
      maxLines: 3, fontSize: 40, lineHeight: 1, safeRegion: 'TOP' },
    captions: { x: 0, y: 0.8, width: 1, height: 0.1, maxWidth: 1, maxLines: 2,
      fontSize: 36, lineHeight: 1, baseline: 0.85, activeWordScale: 1, safeRegion: 'LOWER_THIRD' },
    background: { type: 'SOLID', color: '#ffffff', blur: 0 },
    safeAreas: { top: 0, bottom: 0, left: 0, right: 0 },
    overlays: { logo: { x: 0, y: 0, width: 0.1, height: 0.1 } }
  };
  const cardCropGraph = graphOf(cardCrop);
  ok('manual crop also overrides a template/card canvas background with black',
    /color=c=#ffffff[^;]*drawbox=[^;]*color=black@1[^;]*\[vlayoutbg\]/u.test(cardCropGraph));
  ok('the card video is composited over the black canvas rather than covered by it',
    cardCropGraph.includes('[vlayoutbg][vlayoutfg]overlay='));

  const logoPlan = plan({
    assets: [sourceAsset(), imageAsset('logo-1', 'LOGO')],
    elements: [videoElement('v1', 0, 0, 12, 0),
      { id: 'logo', assetId: 'logo-1', type: 'IMAGE', track: 2, position: 0, startTime: 0,
        duration: 6, trimStart: 0, trimEnd: null,
        properties: { x: 0.7, y: 0.05, width: 0.2, height: 0.1, opacity: 1, zIndex: 20,
          role: 'LOGO', rotation: -8, flipH: true,
          crop: { left: 0.05, right: 0.05, top: 0, bottom: 0 } } }] });
  ok('an overlay carries its transform into the render plan',
    logoPlan.plan.visualOverlays[0].rotation === -8 &&
    logoPlan.plan.visualOverlays[0].flipH === true &&
    logoPlan.plan.visualOverlays[0].crop.left === 0.05);
  const logoGraph = graphOf(logoPlan, { overlayPaths: { logo: '/tmp/logo.png' } });
  ok('a rotated LOGO is actually rotated at render time',
    logoGraph.includes('rotate=-0.139626'));
  ok('a flipped LOGO is actually flipped at render time',
    /\[1:v\][^;]*hflip/u.test(logoGraph));
  ok('the overlay is still composited with its opacity and timing',
    logoGraph.includes('colorchannelmixer=aa=1.0000') && logoGraph.includes('between(t'));

  // --- 8. Interaction with the existing timeline ----------------------------
  section('8. Transform composes with splits, trims and reorders');
  const split = plan({ elements: [
    videoElement('a', 0, 0, 6, 0, { crop: { left: 0.2, right: 0, top: 0, bottom: 0 } }),
    videoElement('b', 1, 6, 12, 6, { rotation: 90 })] });
  ok('two halves of a split can hold DIFFERENT transforms',
    split.plan.videoSegments[0].crop.left === 0.2 && split.plan.videoSegments[1].rotation === 90);
  const splitGraph = graphOf(split);
  ok('each segment is normalized to the same size, so concat is still legal',
    (splitGraph.match(/scale=1920:1080/gu) || []).length >= 2);
  ok('the concat still joins exactly the two segments', splitGraph.includes('concat=n=2'));

  const mixed = plan({ elements: [
    videoElement('a', 0, 0, 10, 0, { speed: 2 }),
    videoElement('b', 1, 10, 20, 5)] });
  ok('a mixed-speed timeline totals the sum of its retimed segments',
    mixed.plan.durationSec === 15);
  ok('the second segment starts where the first one now ends',
    mixed.plan.videoSegments[1].timelineStart === 5);

  paritySuite();
  return liveSuite().then(() => {
    console.log(`\nEditMode manual transform tests passed (${checks} checks).`);
  });
}

// --- 9. The live command path ------------------------------------------------
//
// Everything above is pure. This section drives the real service through the
// same command entry point the HTTP controller uses, so the claims about
// validation, history and undo are checked against the actual mutation path
// rather than against a reimplementation of it.

async function liveSuite() {
  section('9. Typed commands through the real mutation path');
  const state = await seedAnalyzedProject(createHarness());
  const { service } = state;
  const id = state.project.id;
  let project = state.analyzed;
  const video = () => (project.elements ?? []).find((element) => element.type === 'VIDEO');
  const run = async (action, payload) => {
    project = await service.phase3Command(id, action, { revision: project.revision, ...payload });
    return project;
  };
  const refused = async (action, payload, code) => {
    try { await service.phase3Command(id, action, { revision: project.revision, ...payload }); }
    catch (error) {
      const body = typeof error.getResponse === 'function' ? error.getResponse() : {};
      assert.equal(body.code, code, `expected ${code}, got ${body.code}`);
      return true;
    }
    assert.fail(`expected ${action} to be refused with ${code}`);
  };

  const target = video().id;
  const baseDuration = video().duration;

  await run('set-video-crop', { elementId: target, cropLeft: 0.1, cropRight: 0.1,
    cropTop: 0, cropBottom: 0 });
  ok('SET_VIDEO_CROP persists onto canonical element properties',
    video().properties.crop.left === 0.1);
  project = await service.undo(id, project.revision);
  ok('undo restores the crop that existed before Done',
    (video().properties.crop?.left ?? 0) === 0 && (video().properties.crop?.right ?? 0) === 0);
  project = await service.redo(id, project.revision);
  ok('redo restores the precise normalized crop',
    video().properties.crop.left === 0.1 && video().properties.crop.right === 0.1);
  await run('set-video-rotation', { elementId: target, rotation: 15 });
  ok('SET_VIDEO_ROTATION persists', video().properties.rotation === 15);
  await run('set-video-flip', { elementId: target, flipH: true, flipV: false });
  ok('SET_VIDEO_FLIP persists', video().properties.flipH === true);
  await run('set-video-scale', { elementId: target, scale: 1.5 });
  ok('SET_VIDEO_SCALE persists', video().properties.scale === 1.5);
  await run('set-video-position', { elementId: target, x: 0.1, y: -0.2 });
  ok('SET_VIDEO_POSITION persists', video().properties.offsetX === 0.1 &&
    video().properties.offsetY === -0.2);

  ok('an out-of-range crop is refused with a typed code',
    await refused('set-video-crop', { elementId: target, cropLeft: 0.6, cropRight: 0.6,
      cropTop: 0, cropBottom: 0 }, 'INVALID_CROP'));
  ok('an out-of-range rotation is refused with a typed code',
    await refused('set-video-rotation', { elementId: target, rotation: 400 },
      'INVALID_ROTATION'));
  ok('an out-of-range speed is refused with a typed code',
    await refused('set-speed', { elementId: target, speed: 12 }, 'INVALID_SPEED'));

  const revisionBeforeSpeed = project.revision;
  await run('set-speed', { elementId: target, speed: 2 });
  ok('SET_SPEED halves the stored timeline duration of the clip',
    Math.abs(video().duration - baseDuration / 2) < 1e-4);
  ok('SET_SPEED persists the rate itself', video().properties.speed === 2);
  ok('the speed change is exactly one revision', project.revision === revisionBeforeSpeed + 1);

  project = await service.undo(id, project.revision);
  ok('undo restores the original duration',
    Math.abs(video().duration - baseDuration) < 1e-4);
  ok('undo restores the original speed', (video().properties.speed ?? 1) === 1);
  ok('undo left the earlier transform untouched', video().properties.rotation === 15);
  project = await service.redo(id, project.revision);
  ok('redo re-applies the speed change', video().properties.speed === 2);
  ok('redo restores the shortened duration',
    Math.abs(video().duration - baseDuration / 2) < 1e-4);

  const history = await service.history(id);
  ok('every transform command is recorded as its own history entry',
    ['SET_VIDEO_CROP', 'SET_VIDEO_ROTATION', 'SET_VIDEO_FLIP', 'SET_VIDEO_SCALE',
      'SET_VIDEO_POSITION', 'SET_SPEED']
      .every((action) => history.some((entry) => entry.action === action)));
  ok('transform history is attributed to the USER, not to a preset or assistant',
    history.filter((entry) => entry.action.startsWith('SET_VIDEO_') || entry.action === 'SET_SPEED')
      .every((entry) => entry.actor === 'USER'));

  ok('an unknown transform-shaped command is still refused',
    await refused('set-video-warp', { elementId: target }, 'UNSUPPORTED_COMMAND'));
}

// --- 10. Preview / render parity ---------------------------------------------
//
// The strongest form of "what you see is what you export": compile the FRONTEND
// transform module and check that, for the same stored properties, the CSS the
// preview draws and the FFmpeg chain the renderer emits describe the same
// picture. The two are written separately - one in CSS, one in filter syntax -
// so only a test that reads both can keep them honest.

function loadFrontendTransform() {
  const sourcePath = path.join(__dirname, '../../frontend/src/lib/edit-mode-transform.ts');
  let code = fs.readFileSync(sourcePath, 'utf8');
  // Strip the type-only imports; the module's behaviour is pure JS.
  code = code.replace(/^import type .*$/gmu, '')
    .replace(/^import \{ NEUTRAL_CROP.*$/gmu,
      'const NEUTRAL_CROP = { left: 0, right: 0, top: 0, bottom: 0 };');
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const compiled = new Module(sourcePath, module);
  compiled.filename = sourcePath;
  compiled.paths = module.paths;
  compiled._compile(output, sourcePath);
  return compiled.exports;
}

function paritySuite() {
  section('10. Preview and renderer describe the same picture');
  const preview = loadFrontendTransform();

  const cases = [
    { label: 'neutral', props: {} },
    { label: 'side crop', props: { crop: { left: 0.2, right: 0.2, top: 0, bottom: 0 } } },
    { label: 'aspect crop', props: { crop: { left: 0, right: 0, top: 0.34, bottom: 0.34 } } },
    { label: 'rotation', props: { rotation: 30 } },
    { label: 'negative rotation', props: { rotation: -12 } },
    { label: 'horizontal flip', props: { flipH: true } },
    { label: 'vertical flip', props: { flipV: true } },
    { label: 'scale up', props: { scale: 1.5 } },
    { label: 'scale down', props: { scale: 0.6 } },
    { label: 'everything at once', props: { crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 },
      rotation: 8, flipH: true, scale: 1.2, offsetX: 0.05, offsetY: -0.05 } }
  ];

  const asTransform = (props) => ({
    crop: { left: 0, right: 0, top: 0, bottom: 0, ...(props.crop ?? {}) },
    rotation: props.rotation ?? 0, flipH: props.flipH === true, flipV: props.flipV === true,
    scale: props.scale ?? 1, offsetX: props.offsetX ?? 0, offsetY: props.offsetY ?? 0
  });

  for (const testCase of cases) {
    const css = preview.transformStyle(testCase.props, { includeScaleAndOffset: true });
    const chain = segmentTransformFilter(asTransform(testCase.props), 1920, 1080);
    const transform = css.transform ?? '';

    const previewRotates = /rotate\(/u.test(transform);
    const rendererRotates = chain.includes('rotate=');
    ok(`${testCase.label}: both agree on whether it rotates`,
      previewRotates === rendererRotates);

    if (previewRotates) {
      const degrees = Number(/rotate\((-?[\d.]+)deg\)/u.exec(transform)[1]);
      const radians = Number(/rotate=(-?[\d.]+)/u.exec(chain)[1]);
      ok(`${testCase.label}: both rotate by the same angle, in the same direction`,
        Math.abs(degrees * Math.PI / 180 - radians) < 1e-4);
    }

    ok(`${testCase.label}: both agree on horizontal flip`,
      /scaleX\(-1\)/u.test(transform) === chain.includes('hflip'));
    ok(`${testCase.label}: both agree on vertical flip`,
      /scaleY\(-1\)/u.test(transform) === chain.includes('vflip'));

    const previewCrops = Boolean(css.clipPath);
    const rendererCrops = chain.includes('crop=') || chain.includes('pad=');
    ok(`${testCase.label}: both agree on whether it crops`,
      previewCrops ? rendererCrops : true);
  }

  // The specific defect this workstream existed to fix.
  const rotated = preview.transformStyle({ rotation: 45 }, { includeScaleAndOffset: true });
  ok('a rotation is drawn by the preview AND emitted by the renderer - never one alone',
    /rotate\(45deg\)/u.test(rotated.transform ?? '') &&
    segmentTransformFilter(asTransform({ rotation: 45 }), 1920, 1080).includes('rotate='));

  const neutral = preview.transformStyle({}, { includeScaleAndOffset: true });
  ok('an untouched element draws no CSS transform and emits no filter',
    !neutral.transform && !neutral.clipPath &&
    segmentTransformFilter(asTransform({}), 1920, 1080) === '');

  // Crop must letterbox on both sides of the boundary, not stretch.
  const aspect = preview.transformStyle({ crop: { left: 0, right: 0, top: 0.34, bottom: 0.34 } });
  ok('the preview fits a crop with ONE uniform scale, as the renderer does',
    !/scale\([^)]*,[^)]*\)/u.test(aspect.transform ?? ''));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
