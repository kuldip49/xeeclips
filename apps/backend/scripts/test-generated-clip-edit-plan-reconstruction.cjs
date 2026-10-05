const assert = require('node:assert/strict');
const { adaptAutomaticEditPlan, AUTOMATIC_EDIT_ADAPTER_VERSION } =
  require('../dist/modules/edit-mode/generated-clip-edit-plan-adapter.js');
const { buildTimelineMap } =
  require('../dist/modules/edit-mode/render/edit-mode-timeline-map.js');

const plan = (over = {}) => ({
  version: 1, clipStartSec: 100, clipEndSec: 112, aspectRatio: '9:16',
  openingStrategy: { hookStartSec: 100, removeWeakLeadIn: false, reason: 'Keep context' },
  endingStrategy: { payoffEndSec: 112, reason: 'Complete payoff' },
  editorialIntent: 'Fast useful explanation', musicMood: 'NONE', preserveInformation: true,
  onScreenHook: { enabled: true, text: 'Three useful facts', startSec: 100, endSec: 103,
    position: 'TOP', style: 'IMPACT' },
  operations: [{ type: 'ZOOM', startSec: 106, endSec: 108, reason: 'Key claim',
    scale: 1.2, focusX: 0.62, focusY: 0.4, target: 'FACE', words: ['important'] }],
  retentionMoments: [],
  onScreenText: [{ text: 'Remember this', startSec: 108, endSec: 110,
    position: 'LOWER_THIRD', emphasis: 'STRONG' }],
  subtitleStyle: { enabled: true, template: 'EDUCATION_CLEAN', position: 'BOTTOM',
    maxWordsPerLine: 5, highlightCurrentWord: true, animationStyle: 'WORD_HIGHLIGHT' },
  subtitleTheme: 'CLEAN_WHITE', subtitleEmphasis: [], platformPreset: 'YOUTUBE_SHORTS',
  videoTemplate: 'EDITORIAL_FRAME', recommendedTemplate: 'EDITORIAL_FRAME',
  backgroundMode: 'SOFT_BLUR_EXTENSION', gradePreset: 'WARM_TALKING_HEAD',
  audio: { normalize: true, removeLongPauses: true }, pacingNotes: [], ...over
});

const telemetry = (over = {}) => ({
  timelineSegments: [
    { sourceStart: 100, sourceEnd: 104, finalStart: 0, finalEnd: 4 },
    { sourceStart: 106, sourceEnd: 112, finalStart: 4, finalEnd: 10 }
  ],
  zoomEvents: [{ startSec: 4.4, zoomInEndSec: 4.8, zoomOutStartSec: 5.8, endSec: 6.2,
    peakScale: 1.22, focusX: 0.62, focusY: 0.4, triggerText: 'important',
    semanticReason: 'Key claim' }],
  grading: { selectedPreset: 'WARM_TALKING_HEAD' }, reframeSource: 'FACE',
  canvasResolution: { width: 1080, height: 1920 },
  hookBounds: { x: 80, y: 120, width: 920, height: 300 },
  stabilizedCropCenters: [{ t: 0, x: 0.4 }, { t: 1, x: 0.6 }], ...over
});

const transcriptSegments = [
  { start: 100, end: 104, text: 'Three useful facts begin right here', words: [
    { start: 100, end: 100.4, text: 'Three' }, { start: 100.4, end: 100.8, text: 'useful' },
    { start: 100.8, end: 101.2, text: 'facts' }, { start: 101.2, end: 101.6, text: 'begin' },
    { start: 101.6, end: 102, text: 'right' }, { start: 102, end: 102.4, text: 'here' }
  ] },
  { start: 106, end: 112, text: 'The important detail survives the cut', words: [
    { start: 106, end: 106.4, text: 'The' }, { start: 106.4, end: 107, text: 'important' },
    { start: 107, end: 107.5, text: 'detail' }, { start: 107.5, end: 108, text: 'survives' },
    { start: 108, end: 108.4, text: 'the' }, { start: 108.4, end: 109, text: 'cut' }
  ] }
];

const adapt = (editPlan, editTelemetry, transcript = transcriptSegments) => {
  let sequence = 0;
  return adaptAutomaticEditPlan({ editPlan, editTelemetry, sourceAssetId: 'source-asset',
    sourceDuration: 300, transcriptSegments: transcript,
    idFactory: (kind) => `${kind}-${sequence++}` });
};

const result = adapt(plan(), telemetry());
assert.equal(result.mode, 'CANONICAL');
assert.equal(result.report.adapterVersion, AUTOMATIC_EDIT_ADAPTER_VERSION);
assert.equal(result.report.sourcePlanVersion, 1);
assert.equal(result.report.segmentCount, 2);
assert.equal(result.report.hookCount, 1);
assert(result.report.captionCount >= 2);
assert.equal(result.report.zoomCount, 1);
assert(result.report.unsupported.includes('BACKGROUND_MODE_SOFT_BLUR_EXTENSION'));
assert(result.report.approximations.some((item) => item.capability === 'ZOOM_STRENGTH'));
assert(result.report.approximations.some((item) => item.capability === 'DYNAMIC_REFRAME'));

const videos = result.elements.filter((element) => element.type === 'VIDEO');
assert.deepEqual(videos.map((item) => [item.trimStart, item.trimEnd, item.startTime, item.duration]),
  [[100, 104, 0, 4], [106, 112, 4, 6]], 'final telemetry, not requested operations, owns cuts');
assert(videos.every((item) => item.assetId === 'source-asset'));
assert.equal(videos[0].properties.colorFilterId, 'WARM');
assert.equal(videos[0].properties.sourceVolume, 1);

const map = buildTimelineMap(result.elements.map((element) => ({ ...element, id: element.id })));
assert.equal(map.durationSec, 10);
assert.equal(map.toSource(4.001), 106.001);
assert.deepEqual(map.toTimeline(105), [], 'removed source range has no timeline placement');

const hook = result.elements.find((element) => element.type === 'TEXT' &&
  element.properties.presetRole === 'HOOK');
assert.equal(hook.properties.content, 'Three useful facts');
assert.equal(hook.properties.origin, 'AUTOMATIC_RECONSTRUCTION');
assert.equal(hook.startTime, 0);
const captions = result.elements.filter((element) => element.type === 'SUBTITLE');
assert(captions.every((item) => item.properties.manualEdited === false));
assert(captions.every((item) => item.properties.origin === 'AUTOMATIC_RECONSTRUCTION'));
assert(captions.some((item) => item.properties.content.includes('important')));
assert(!captions.some((item) => item.properties.content.includes('facts') &&
  item.properties.content.includes('important')), 'captions cannot bridge the removed range');
const zoom = result.elements.find((element) => element.type === 'EFFECT');
assert.equal(zoom.startTime, 4.4);
assert.equal(zoom.duration, 1.8);
assert.equal(zoom.properties.scale, 1.15, 'automatic zoom is capped to canonical safe bound');
assert.equal(zoom.properties.automaticFocusX, 0.62, 'unrepresentable focus remains provenance');

const legacy = plan();
delete legacy.version;
const legacyResult = adapt(legacy, telemetry());
assert.equal(legacyResult.mode, 'CANONICAL');
assert.equal(legacyResult.report.sourcePlanVersion, 'LEGACY_V1');

const reordered = adapt(plan({ onScreenHook: { ...plan().onScreenHook, enabled: false },
  subtitleStyle: { ...plan().subtitleStyle, enabled: false } }), telemetry({
  timelineSegments: [
    { sourceStart: 106, sourceEnd: 112, finalStart: 0, finalEnd: 6 },
    { sourceStart: 100, sourceEnd: 104, finalStart: 6, finalEnd: 10 }
  ], zoomEvents: [] }), []);
assert.equal(reordered.mode, 'CANONICAL');
assert.deepEqual(reordered.elements.filter((item) => item.type === 'VIDEO')
  .map((item) => [item.trimStart, item.trimEnd]), [[106, 112], [100, 104]],
  'telemetry ordering supports a non-monotonic/reordered source timeline');

assert.deepEqual(adapt({ ...plan(), version: 2 }, telemetry()), {
  mode: 'FLATTENED_FALLBACK', reason: 'UNSUPPORTED_EDIT_PLAN_VERSION',
  details: ['Received version 2']
});
assert.equal(adapt(null, telemetry()).reason, 'MALFORMED_EDIT_PLAN');
assert.equal(adapt({ cuts: [] }, telemetry()).reason, 'MALFORMED_EDIT_PLAN');
assert.equal(adapt(plan(), {}).reason, 'MISSING_FINAL_TIMELINE');
assert.equal(adapt(plan(), telemetry({ timelineSegments: [
  { sourceStart: 100, sourceEnd: 104, finalStart: 2, finalEnd: 6 }
] })).reason, 'UNSAFE_FINAL_TIMELINE');
assert.equal(adapt(plan(), telemetry(), []).reason, 'CAPTIONS_REQUIRE_TRANSCRIPT');

const noCaptions = adapt(plan({ subtitleStyle: { ...plan().subtitleStyle, enabled: false } }),
  telemetry(), []);
assert.equal(noCaptions.mode, 'CANONICAL', 'a caption-free valid plan needs no transcript');

console.log('Automatic editPlan reconstruction tests passed: versioning, final cut mapping, hook, ' +
  'captions, overlays, zoom, color, audio/reframe provenance, legacy normalization, and safe fallback.');
