// The Raw look: Automatic 1's edit (selection, boundaries, framing, speaker switching, zoom)
// with every presentation layer removed. Offline; run after `npm run build`.
const assert = require('node:assert/strict');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan.js');
const { rawEditPlan, AUTOMATIC_RAW } = require('../dist/modules/editing/raw-edit-plan.js');
const { parseAutoGeneration } = require('../dist/modules/videos/auto-generation.js');
const { ClipSelectionService } = require('../dist/modules/videos/clip-selection.service.js');

const base = fallbackEditPlan(10, 40);
const decorated = { ...base, hookRequired: true,
  onScreenHook: { ...base.onScreenHook, enabled: true, text: 'Why this matters' },
  onScreenText: [{ text: 'Stat', startSec: 12, endSec: 14, position: 'TOP', emphasis: 'STRONG' }],
  subtitleEmphasis: [{ word: 'matters' }],
  musicMood: 'ENERGETIC_LIGHT', gradePreset: 'WARM_TALKING_HEAD',
  operations: [
    { type: 'TRIM', startSec: 10, endSec: 10.6, reason: 'lead-in', scale: null, focusX: null, focusY: null, target: null, words: [] },
    { type: 'ZOOM', startSec: 15, endSec: 17, reason: 'emphasis', scale: 1.15, focusX: .5, focusY: .4, target: 'FACE', words: [] },
    { type: 'ZOOM_OUT', startSec: 25, endSec: 27, reason: 'reveal', scale: 1.1, focusX: .5, focusY: .5, target: 'CENTER', words: [] },
    { type: 'REFRAME', startSec: 20, endSec: 24, reason: 'speaker change', scale: null, focusX: .3, focusY: .4, target: 'PERSON', words: [] },
    { type: 'WORD_HIGHLIGHT', startSec: 18, endSec: 18.4, reason: 'key word', scale: null, focusX: null, focusY: null, target: null, words: ['matters'] }],
  retentionMoments: [
    { startSec: 15, endSec: 17, action: 'ZOOM', reason: 'beat' },
    { startSec: 18, endSec: 19, action: 'TEXT_EMPHASIS', reason: 'text' },
    { startSec: 19, endSec: 20, action: 'SUBTITLE_EMPHASIS', reason: 'caption' }] };

const raw = rawEditPlan(decorated);
// Nothing drawn or mixed on top.
assert.equal(raw.onScreenHook.enabled, false);
assert.equal(raw.onScreenHook.text, '');
assert.equal(raw.hookRequired, false);
assert.equal(raw.subtitleStyle.enabled, false);
assert.deepEqual(raw.onScreenText, []);
assert.deepEqual(raw.subtitleEmphasis, []);
assert.equal(raw.musicMood, 'NONE');
assert.equal(raw.gradePreset, 'NO_CHANGE');
assert(!raw.operations.some((operation) => operation.type === 'WORD_HIGHLIGHT'));
assert(!raw.retentionMoments.some((moment) => /TEXT_EMPHASIS|SUBTITLE_EMPHASIS/.test(moment.action)));
// Automatic 1's framing (video in the middle, information kept) on a plain dark surround.
assert.equal(raw.backgroundMode, 'DARK_NEUTRAL');
assert.equal(raw.videoTemplate, decorated.videoTemplate);
assert.equal(raw.preserveInformation, decorated.preserveInformation);
// Everything that decides what is shown and the camera moves is untouched.
assert.deepEqual(raw.operations.map((operation) => operation.type), ['TRIM', 'ZOOM', 'ZOOM_OUT', 'REFRAME']);
assert.equal(raw.clipStartSec, decorated.clipStartSec);
assert.equal(raw.clipEndSec, decorated.clipEndSec);
assert.deepEqual(raw.openingStrategy, decorated.openingStrategy);
assert.equal(raw.aspectRatio, decorated.aspectRatio);
assert.deepEqual(raw.audio, decorated.audio);
// The input plan is not mutated.
assert.equal(decorated.onScreenHook.enabled, true);

// Requests: Raw is accepted end to end and never becomes an EditMode style pass.
assert.equal(parseAutoGeneration(JSON.stringify({ requestedClipCount: 3, outputStyle: 'AI_EDITED',
  generation: { templateId: AUTOMATIC_RAW, look: AUTOMATIC_RAW, components: {}, brief: '', referenceId: null } }))
  .generation.templateId, AUTOMATIC_RAW);
(async () => {
  const service = new ClipSelectionService({}, {}, { dispatch: async () => undefined, isPending: async () => false });
  const settings = await service.buildGenerationSettings({ templateId: AUTOMATIC_RAW, look: AUTOMATIC_RAW,
    components: { CAPTIONS: 'CAP_YELLOW_ACTIVE' }, brief: 'captions lower, warm colour, find the funny moments',
    referenceId: null });
  assert.equal(settings.requestedTemplate, AUTOMATIC_RAW);
  assert.equal(settings.effectiveTemplate, AUTOMATIC_RAW);
  assert.equal(settings.resolved.styled, false, 'style words and picked components never style a Raw clip');
  console.log('Raw template checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
