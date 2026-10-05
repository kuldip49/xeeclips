const assert = require('node:assert/strict');
const { automatic2InformationFit, planCamera } = require(
  '../dist/modules/edit-mode/render/edit-mode-camera.js');
const { normalizeProbedSourceTrims } = require(
  '../dist/modules/edit-mode/render/edit-mode-source-trim.js');
const { buildTimelineMap } = require(
  '../dist/modules/edit-mode/render/edit-mode-timeline-map.js');
const { clampEditWindowToSource } = require(
  '../dist/modules/videos/clip-export.service.js');
const { analysisFramesFromCache } = require(
  '../dist/modules/edit-mode/presets/edit-preset-evidence.js');

const frame = (t, overrides = {}) => ({ t, faces: [], persons: [],
  textBoxes: [], graphicBoxes: [], textCoverage: 0, ocrCoverage: 0,
  ocrLines: [], ...overrides });
const screen = [0, 2, 4, 6].map((t) => frame(t, {
  textBoxes: [{ x: .1, y: .1, w: .55, h: .25 }],
  ocrLines: ['File Edit View Window Help'], edgeDensity: .19
}));
const graphic = [0, 2, 4].map((t) => frame(t, {
  graphicBoxes: [{ x: .1, y: .1, w: .5, h: .3 }],
  ocrLines: ['Quarterly revenue growth'], edgeDensity: .2
}));
const subtitle = [0, 2, 4].map((t) => frame(t, {
  faces: [{ x: .35, y: .2, w: .2, h: .3, timestamp: t,
    confidence: .9 }],
  textBoxes: [{ x: .2, y: .82, w: .6, h: .08 }],
  ocrLines: ['A short subtitle']
}));
assert.equal(automatic2InformationFit(screen, 16 / 9), true);
assert.equal(automatic2InformationFit(graphic, 16 / 9), true);
assert.equal(automatic2InformationFit(subtitle, 16 / 9), false);
assert.equal(automatic2InformationFit([frame(0, { visualLabels: ['presentation slide'] })],
  16 / 9), true);
const cached = analysisFramesFromCache({ source: 'DENSE', frames: [{ t: 2,
  faces: [{ x: .1, y: .2, w: .2, h: .3, confidence: .9,
    mouthActivity: .8, trackId: 'speaker-a' }], persons: [],
  textCoverage: .1, graphicBoxes: [{ x: .2, y: .2, w: .4, h: .2 }],
  ocrLines: ['Slide title'], edgeDensity: .2 }], shotBoundaries: [3] });
assert.equal(cached.frames[0].faces[0].mouthActivity, .8);
assert.equal(cached.frames[0].faces[0].trackId, 'speaker-a');
assert.equal(cached.frames[0].graphicBoxes.length, 1);

const element = (overrides = {}) => ({ id: 'video', assetId: 'source', type: 'VIDEO',
  track: 0, position: 0, startTime: 0, duration: 8, trimStart: 0, trimEnd: 8,
  properties: { frameLayout: 'FILL' }, ...overrides });
const map = buildTimelineMap([element()]);
const camera = (frames, speakerSafe) => planCamera({
  policy: 'AUTO', preserveInformation: true, aspectRatio: '9:16',
  canvas: { width: 1080, height: 1920, fps: 30 },
  viewport: { x: 0, y: 610, width: 1080, height: 700 },
  source: { width: 1920, height: 1080 }, frames, boundaries: [], map,
  speakerSafe
});
const screenPlan = camera(screen, true);
assert.equal(screenPlan.frameSegments[0].layout, 'FIT');
assert.equal(screenPlan.shots[0].zoomAllowed, false);
assert(screenPlan.fitExpression || screenPlan.informationFitExpression);
assert.equal(camera(screen, false).frameSegments[0].layout, 'FILL',
  'Automatic 1 keeps the stored frame layout');
assert.equal(camera(subtitle, true).frameSegments[0].layout, 'FILL',
  'ordinary talking head subtitles do not force information fit');

const trimmed = normalizeProbedSourceTrims([
  element({ id: 'pre-roll', trimStart: .1, trimEnd: 3.1, duration: 3,
    properties: {} }),
  element({ id: 'post-roll', position: 1, trimStart: 28, trimEnd: 30.4,
    duration: 1.2, properties: { speed: 2 } })
], 'source', 30.1234568);
assert.equal(trimmed.corrections.length, 1);
assert.equal(trimmed.elements[1].trimEnd, 30.123456);
assert.equal(trimmed.elements[1].duration, 1.061728);
const remapped = buildTimelineMap(trimmed.elements);
assert.equal(remapped.segments[1].sourceEnd, 30.123456);
assert.equal(remapped.segments[1].timelineEnd, 4.061728);
assert(remapped.segments.every((segment) => segment.sourceEnd <= 30.1234568));
assert.throws(() => normalizeProbedSourceTrims([
  element({ trimStart: 30.2, trimEnd: 30.4 })
], 'source', 30.1234568), /cannot fit/);
assert.throws(() => normalizeProbedSourceTrims([
  element({ trimStart: 0, trimEnd: 400, duration: 400 })
], 'source', 30.1234568), /cannot fit/, 'a gross overrun is a broken timeline, never silently truncated');

const padded = clampEditWindowToSource(10, 30.4, 30.1234568);
assert.deepEqual(padded, { candidateEnd: 30.123, windowStart: 6,
  windowEnd: 30.123 });
assert.throws(() => clampEditWindowToSource(29, 30.4, 30.1234568),
  /too short/);

// Real failure (Fed explainer, 2026-10-03): a chart wiped to the speaker with no detected
// hard cut, and the chart frames carried no OCR/text evidence. The whole clip became one
// FILL shot and the chart was cropped at both sides.
const { automatic2ContentBoundaries } = require(
  '../dist/modules/edit-mode/render/edit-mode-camera.js');
const face = (t) => ({ x: .4, y: .2, w: .2, h: .3, timestamp: t, confidence: .9 });
const wiped = [];
for (let t = 0; t < 20; t += .25) wiped.push(frame(t, { edgeDensity: .086 }));
for (let t = 20; t < 36; t += .25) wiped.push(frame(t, { faces: t === 30 ? [] : [face(t)] }));
const splits = automatic2ContentBoundaries(wiped, [12.2], 36);
assert.equal(splits.length, 1, 'one split at the chart -> speaker wipe; the lone missed face never splits');
assert(Math.abs(splits[0] - 19.875) < .2);
assert.deepEqual(automatic2ContentBoundaries(wiped, [19.9], 36), [], 'a detected cut is not duplicated');
const wipeMap = buildTimelineMap([element({ duration: 36, trimEnd: 36 })]);
const wipePlan = (speakerSafe) => planCamera({ policy: 'AUTO', preserveInformation: true,
  aspectRatio: '9:16', canvas: { width: 1080, height: 1920, fps: 30 },
  viewport: { x: 0, y: 610, width: 1080, height: 700 }, source: { width: 1280, height: 720 },
  frames: wiped, boundaries: [12.2], map: wipeMap, speakerSafe });
const wipeShots = wipePlan(true).frameSegments;
assert(wipeShots.filter((shot) => shot.endSec <= 20.1).every((shot) => shot.layout === 'FIT'),
  'faceless landscape chart shots are fitted whole, not cropped');
assert(wipeShots.filter((shot) => shot.startSec >= 19.8).every((shot) => shot.layout === 'FILL'),
  'speaker shots keep face-focused FILL');
assert(wipePlan(false).frameSegments.every((shot) => shot.layout === 'FILL'),
  'Automatic 1 framing is unchanged');
assert.equal(automatic2InformationFit(subtitle, 16 / 9), false, 'faced shots never take the faceless rule');
assert.equal(automatic2InformationFit([frame(0), frame(1)], 9 / 16), false,
  'portrait sources are not pillarboxed by the faceless rule');

// Real failure: a 69-character hook at the fitted minimum size was emitted as ONE ASS line
// (~1046 px) because the export wrapper under-measured EB Garamond.
const { wrapTokens, fontWidthScale } = require('../dist/modules/edit-mode/render/edit-mode-ass.js');
const { buildEditModeAss } = require('../dist/modules/edit-mode/render/edit-mode-ass.js');
const hookTokens = 'First the Healthiest Version of You is Apparently the Person Who Shops'.split(' ');
const hookPx = 22 * 1080 / 600;
const wrapped = wrapTokens(hookTokens, hookPx, .95 * 1080,
  { widthScale: fontWidthScale('EB Garamond, serif'), balance: true, glyphWidthEm: .4 });
assert.equal(wrapped.length, 2, 'long Automatic 2 hook breaks into two lines');
for (const line of wrapped)
  assert(line.map((at) => hookTokens[at]).join(' ').length * .4 * hookPx <= .95 * 1080);
assert.equal(typeof buildEditModeAss, 'function');

const { chooseSupportingLine } = require('../dist/modules/edit-mode/styles/creative-style-commands.js');
assert.equal(chooseSupportingLine([{ text:
  'What makes First, the healthiest version of you is apparently the person useful in practice.' }],
  'First the Healthiest Version of You'), null, 'fallback question template is filler');
// Real failure: the on-screen hook came from the existing hook element while the
// duplicate check compared against a different layout hook.
const shown = 'Nobody Thinks that the Fed is Going to Cut the Interest Rates';
assert.equal(chooseSupportingLine([{ text: 'Nobody thinks that the fed is going to cut the interest rates.' }],
  ['A different layout hook entirely', shown]), null, 'supporting line never repeats the shown hook');
assert.equal(chooseSupportingLine([{ text: 'Your mortgage payment keeps climbing while savings finally pay more.' }],
  ['A different layout hook entirely', shown]),
  'Your mortgage payment keeps climbing while savings finally pay more.');

// Speaker punch-in (2026-10-03): a small talking head is tightened so the face reads big,
// alternating medium/close at sentence ends, never cutting a second face in half.
const { planSpeakerPunch, AUTOMATIC_2_PUNCH } = require(
  '../dist/modules/edit-mode/render/edit-mode-speaker-punch.js');
const { zoomWindow } = require('../dist/modules/editing/zoom-planner.js');
const talk = [];
for (let t = 0; t < 20; t += .25) talk.push(frame(t, { faces: [{ x: .44, y: .2, w: .12, h: .22,
  timestamp: t, confidence: .9, trackId: 'a' }] }));
const baseCrop = () => ({ x: .066, y: 0, w: .868, h: 1 });
const talkSegments = [{ startSec: 0, endSec: 20, targetFace: { x: .44, y: .2, w: .12, h: .22 },
  trackId: 'a' }];
const fill = [{ shotIndex: 0, startSec: 0, endSec: 20, layout: 'FILL', faceCount: 1 }];
const punches = planSpeakerPunch({ frames: talk, frameSegments: fill, speakerSegments: talkSegments,
  cropAt: baseCrop, beats: [7.1, 13.4], durationSec: 20 });
assert(punches.length >= 2, 'long take is split at sentence ends');
assert.deepEqual(punches.slice(0, 2).map((punch) => punch.framing), ['MEDIUM', 'CLOSE']);
for (const punch of punches) {
  assert(punch.scale >= AUTOMATIC_2_PUNCH.minScale && punch.scale <= AUTOMATIC_2_PUNCH.maxScale);
  const window = zoomWindow(baseCrop(), punch.scale, punch.anchorX, punch.anchorY);
  const face = talk[0].faces[0];
  assert(face.x >= window.x && face.x + face.w <= window.x + window.w, 'face stays whole');
  assert((face.y - window.y) / window.h >= AUTOMATIC_2_PUNCH.headroom, 'headroom kept');
  const share = face.h / window.h;
  assert(share > .2, `face fills the card (${share.toFixed(2)})`);
}
// A second face half-inside the tightened window would be cut: that interval keeps the
// camera's own framing or a scale that keeps the second face whole/outside.
const pair = talk.map((item) => ({ ...item, faces: [...item.faces,
  { x: .6, y: .25, w: .1, h: .17, timestamp: item.t, confidence: .9, trackId: 'b' }] }));
for (const punch of planSpeakerPunch({ frames: pair, frameSegments: fill,
  speakerSegments: talkSegments, cropAt: baseCrop, beats: [], durationSec: 20 })) {
  const window = zoomWindow(baseCrop(), punch.scale, punch.anchorX, punch.anchorY);
  const other = pair[0].faces[1];
  const w = Math.max(0, Math.min(other.x + other.w, window.x + window.w) - Math.max(other.x, window.x));
  const share = w / other.w;
  assert(share >= .97 || share <= .35, 'no half-cut second face');
}
assert.equal(planSpeakerPunch({ frames: pair, frameSegments: fill, speakerSegments: [{ ...talkSegments[0],
  trackId: 'pair' }], cropAt: baseCrop, beats: [], durationSec: 20 }).length, 0,
  'a two-shot held by the camera is never punched');

// Hook colour (user choice 2026-10-03): white text, only the highlighted words red.
const lib = require('../dist/modules/edit-mode/styles/creative-style-library.js');
const { semanticHookRuns } = require('../dist/modules/edit-mode/styles/creative-style-commands.js');
const hookStyle = lib.componentStylesFor('HOOK').find((item) => item.id ===
  lib.fullTemplate('AUTOMATIC_2').components.HOOK).spec;
assert.equal(hookStyle.color, '#FFFFFF');
assert.equal(hookStyle.semanticHighlightColor, '#E53935');
const hookRuns = semanticHookRuns('Why the 2026 budget breaks Medicare', hookStyle.color,
  hookStyle.semanticHighlightColor);
assert(hookRuns.some((run) => run.color === '#E53935'), 'some words are highlighted red');
assert(hookRuns.every((run) => ['#FFFFFF', '#E53935'].includes(run.color)), 'only white and red');
assert.equal(hookRuns.filter((run) => run.color === '#E53935').length <= 2, true);

console.log('Automatic 2 graphic fit, content splits, hook wrap, support filler, source trim and ' +
  'Automatic 1 isolation passed');
