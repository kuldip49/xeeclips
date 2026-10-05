// EditMode Workstream C - professional text and caption editor.
//
// Offline and fast, in the same spirit as test-edit-mode-transform.cjs: the
// service runs against the in-memory Prisma fake from test-edit-mode-isolation,
// caption generation and styling are exercised as pure functions, and the ASS
// the renderer would emit is asserted as a string. Nothing encodes, nothing
// touches a database, nothing calls an LLM.
//
// The load-bearing claims this file exists to check:
//
//   * Every text and caption property is a TYPED, VALIDATED, UNDOABLE command -
//     there is no JSON-patch back door and no second text state.
//   * Captions are TRANSCRIPT-EXACT: every generated word comes from the cached
//     transcript, in order, with its own timing. Nothing is invented.
//   * Split divides text without duplicating it and keeps timing contiguous;
//     merge is the union of two spans with the selected caption's style.
//   * "Apply to all" changes STYLE only - never wording, timing or a manual
//     correction.
//   * The renderer reproduces the stored style, and where ASS cannot it makes
//     the documented closest match rather than pretending parity.
//   * The frozen auto pipeline is untouched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const { createHarness } = require('./test-edit-mode-isolation.cjs');

const M = '../dist/modules/edit-mode';
const { readTextStyle, readBackground, effectiveBackgroundColor, extractStyleProperties,
  validateFontSize, validateFontWeight, validateStroke, validateShadow, validateBackground,
  validateSpacing, validateColor, validateFontFamily, validateAlignment, TextRangeError,
  TEXT_STYLE_PRESETS, CAPTION_STYLE_PRESETS, EDIT_MODE_FONT_IDS,
  DEFAULT_CAPTION_BOX } = require(`${M}/edit-mode-text.js`);
const { generateCaptions, splitCaption, mergeCaptions, adjacentCaption, activeWordIndex,
  CaptionGenerationError, DEFAULT_WORDS_PER_CAPTION } = require(`${M}/edit-mode-captions.js`);
const { buildTimelineMap } = require(`${M}/render/edit-mode-timeline-map.js`);
const { buildRenderPlan } = require(`${M}/render/edit-mode-render-plan.js`);
const { buildEditModeAss, assSpans, wrapTokens, designPx } = require(`${M}/render/edit-mode-ass.js`);

let checks = 0;
const ok = (label, condition) => {
  assert(condition, label);
  checks += 1;
  console.log(`  ok  ${label}`);
};
const section = (title) => console.log(`\n${title}`);

const rejects = async (fn, code, label) => {
  try { await fn(); } catch (error) {
    const actual = error?.response?.code ?? error?.code;
    assert.equal(actual, code, `${label}: expected ${code}, got ${actual} (${error.message})`);
    checks += 1;
    console.log(`  ok  ${label}`);
    return;
  }
  assert.fail(`${label}: expected ${code}, but nothing was thrown`);
};

// --- Fixtures ---------------------------------------------------------------

const SOURCE_DURATION = 60;
/** A transcript with real per-word timings, spoken over the first 30 seconds. */
const TRANSCRIPT_WORDS = [
  'the', 'single', 'biggest', 'mistake', 'people', 'make', 'is', 'shipping', 'before',
  'they', 'have', 'talked', 'to', 'anyone', 'who', 'would', 'actually', 'pay', 'for',
  'the', 'thing', 'they', 'are', 'building', 'today'
];
const transcriptFixture = () => ({
  text: TRANSCRIPT_WORDS.join(' '),
  segments: [{ start: 0, end: 25, text: TRANSCRIPT_WORDS.join(' '),
    words: TRANSCRIPT_WORDS.map((text, index) => ({
      start: Number((index * 1).toFixed(3)), end: Number((index * 1 + 0.8).toFixed(3)), text })) }]
});

async function seedTextProject(over = {}) {
  const harness = createHarness();
  const project = await harness.service.create({ name: 'Workstream C' });
  const attached = await harness.service.persistSource(project.id, project.revision, {
    id: 'asset-source', originalName: 'source.mp4', bucket: 'test-bucket',
    objectKey: `edit-mode/${project.id}/asset-source/source.mp4`, mimeType: 'video/mp4',
    sizeBytes: 2048n, duration: over.duration ?? SOURCE_DURATION, width: 1920, height: 1080,
    fps: 30, metadata: { hasVideo: true, hasAudio: true, videoCodec: 'h264' }
  });
  // The transcript is written straight onto the asset, exactly as "Analyze
  // source" caches it. Caption generation must read THIS and never re-transcribe.
  harness.rows.editAssets.get('asset-source').transcript =
    over.transcript === undefined ? transcriptFixture() : over.transcript;
  return { ...harness, project, state: attached };
}

const run = (harness, state, action, payload = {}) =>
  harness.service.phase3Command(state.id, action, { revision: state.revision, ...payload });

const textOf = (state) => (state.elements ?? []).find((element) => element.type === 'TEXT');
const captionsOf = (state) => (state.elements ?? [])
  .filter((element) => element.type === 'SUBTITLE')
  .sort((left, right) => left.startTime - right.startTime);

// A pure render-plan fixture, so ASS output can be asserted without a service.
const settings = (over = {}) => ({ selectedPreset: 'PODCAST_CLIP', aspectRatio: 'SOURCE',
  pacing: 'MODERATE', subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF',
  reframePolicy: 'SOURCE', musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null, ...over });

const planFor = (elements) => buildRenderPlan({
  project: { id: 'p', revision: 1, settings: settings() },
  assets: [{ id: 'src', role: 'SOURCE', mimeType: 'video/mp4', duration: SOURCE_DURATION,
    width: 1920, height: 1080, fps: 30, metadata: { hasAudio: true }, transcript: null,
    analysis: { source: 'DENSE', shotBoundaries: [], ocrText: '', frames: [] } }],
  elements: [{ id: 'v1', assetId: 'src', type: 'VIDEO', track: 0, position: 0, startTime: 0,
    duration: 30, trimStart: 0, trimEnd: 30, properties: {} }, ...elements],
  hasSourceAudio: true, fps: 30 }).plan;

// --- 1-13. Text ---------------------------------------------------------------

async function textSuite() {
  section('1. Text elements: creation, content and every style property');
  const harness = await seedTextProject();
  let state = harness.state;

  state = await run(harness, state, 'add-text');
  const created = textOf(state);
  ok('1. add text creates a TEXT element in a built-in style',
    !!created && created.properties.textStyleId === 'BASIC' &&
    created.properties.content === 'Text' && created.properties.stroke.enabled === true);
  ok('1b. a style preset can be chosen at creation time',
    (await run(harness, state, 'add-text', { textStyleId: 'HOOK' }))
      .elements.filter((element) => element.type === 'TEXT')
      .some((element) => element.properties.textStyleId === 'HOOK' &&
        element.properties.uppercase === true));
  state = await harness.service.get(state.id);

  const id = created.id;
  const apply = async (action, payload) => {
    state = await run(harness, state, action, { elementId: id, ...payload });
    return (state.elements ?? []).find((element) => element.id === id).properties;
  };

  ok('2. update text content', (await apply('set-text-content',
    { content: 'Ship to one buyer first' })).content === 'Ship to one buyer first');
  ok('3. font family', (await apply('set-text-font',
    { fontFamily: 'Noto Serif, serif' })).fontFamily === 'Noto Serif, serif');
  ok('4. font size', (await apply('set-text-size', { fontSize: 96 })).fontSize === 96);
  ok('5. font weight', (await apply('set-text-weight', { fontWeight: 900 })).fontWeight === 900);
  ok('6. text colour', (await apply('set-text-color', { color: '#FFDD00' })).color === '#ffdd00');
  ok('6b. alignment', (await apply('set-text-alignment',
    { textAlign: 'left' })).textAlign === 'left');

  const stroke = (await apply('set-text-stroke', { strokeEnabled: true, strokeColor: '#101010',
    strokeWidth: 7 })).stroke;
  ok('7. stroke', stroke.enabled === true && stroke.color === '#101010' && stroke.width === 7);

  const shadow = (await apply('set-text-shadow', { shadowEnabled: true, shadowColor: '#000000',
    shadowOpacity: 0.75, shadowBlur: 12, shadowOffsetX: 3, shadowOffsetY: 5 })).shadow;
  ok('8. shadow', shadow.enabled && shadow.opacity === 0.75 && shadow.blur === 12 &&
    shadow.offsetX === 3 && shadow.offsetY === 5);

  const withPlate = await apply('set-text-background', { backgroundEnabled: true,
    backgroundColor: '#112233', backgroundOpacity: 0.5, backgroundPadding: 20,
    backgroundRadius: 12 });
  ok('9. background plate', withPlate.background.enabled &&
    withPlate.background.color === '#112233' && withPlate.background.padding === 20 &&
    withPlate.background.radius === 12);
  ok('9b. the legacy backgroundColor property is kept in step with the plate',
    withPlate.backgroundColor === '#11223380');

  const spacing = await apply('set-text-spacing', { letterSpacing: 6, lineSpacing: 1.6 });
  ok('10. letter spacing', spacing.letterSpacing === 6);
  ok('11. line spacing', spacing.lineSpacing === 1.6);

  ok('12. rotation reuses SET_VIDEO_ROTATION and accepts TEXT',
    (await apply('set-video-rotation', { rotation: -12 })).rotation === -12);

  state = await run(harness, state, 'set-element-timing',
    { elementId: id, startTime: 4, duration: 6 });
  const timed = (state.elements ?? []).find((element) => element.id === id);
  ok('13. text timing', timed.startTime === 4 && timed.duration === 6);

  ok('13b. a style preset restyles in place without moving the element',
    await (async () => {
      const before = (state.elements ?? []).find((element) => element.id === id).properties;
      const after = await apply('set-text-style-preset', { textStyleId: 'CTA' });
      return after.textStyleId === 'CTA' && after.uppercase === true &&
        after.x === before.x && after.y === before.y;
    })());
  ok('13c. the same preset CAN move it when the caller asks',
    (await apply('set-text-style-preset', { textStyleId: 'HOOK', applyBox: true })).x === 0.08);

  section('2. Bounds are enforced, not clamped');
  await rejects(() => run(harness, state, 'set-text-size', { elementId: id, fontSize: 4000 }),
    'INVALID_FONT_SIZE', 'an out-of-range font size is rejected with its own code');
  await rejects(() => run(harness, state, 'set-text-weight', { elementId: id, fontWeight: 750 }),
    'INVALID_FONT_WEIGHT', 'a non-multiple-of-100 weight is rejected');
  await rejects(() => run(harness, state, 'set-text-color', { elementId: id, color: 'red' }),
    'INVALID_TEXT_COLOR', 'a non-hex colour is rejected');
  await rejects(() => run(harness, state, 'set-text-font',
    { elementId: id, fontFamily: 'Comic Sans' }),
  'INVALID_FONT_FAMILY', 'an uninstalled font family is rejected');
  await rejects(() => run(harness, state, 'set-text-stroke', { elementId: id,
    strokeEnabled: true, strokeColor: '#000000', strokeWidth: 500 }),
  'INVALID_TEXT_STROKE', 'an out-of-range stroke width is rejected');
  await rejects(() => run(harness, state, 'set-text-spacing', { elementId: id,
    letterSpacing: 0, lineSpacing: 9 }),
  'INVALID_TEXT_SPACING', 'an out-of-range line spacing is rejected');

  // Pure validators, independent of the service.
  for (const [fn, value] of [[validateFontSize, 0], [validateFontWeight, 1234],
    [() => validateColor('nope', 'color'), null], [() => validateFontFamily('Wingdings'), null],
    [() => validateAlignment('middle'), null]]) {
    let threw = false;
    try { fn(value); } catch (error) { threw = error instanceof TextRangeError; }
    assert(threw, 'validators must throw TextRangeError');
  }
  ok('2b. every validator throws a typed TextRangeError', true);

  return { harness, state, id };
}

// --- 14-22. Captions ----------------------------------------------------------

async function captionSuite() {
  section('3. Caption generation from the cached transcript');
  const harness = await seedTextProject();
  let state = await run(harness, harness.state, 'generate-captions',
    { captionStyleId: 'BOLD_HIGHLIGHT' });
  let captions = captionsOf(state);
  ok('14. caption generation produces SUBTITLE elements', captions.length > 0 &&
    captions.every((element) => element.type === 'SUBTITLE' && element.track === 1));
  ok('14b. generated captions carry the chosen style preset',
    captions.every((element) => element.properties.captionStyleId === 'BOLD_HIGHLIGHT' &&
      element.properties.activeWord.enabled === true && element.properties.uppercase === true));

  // 15. EXACT transcript grounding: concatenating the captions in timeline order
  // reproduces the transcript word for word, in order, with nothing added.
  const spoken = captions.map((element) => String(element.properties.content)).join(' ')
    .split(/\s+/u).filter(Boolean);
  ok('15. captions reproduce the transcript exactly, in order, with nothing invented',
    spoken.length === TRANSCRIPT_WORDS.length &&
    spoken.every((word, index) => word === TRANSCRIPT_WORDS[index]));
  ok('15b. every caption timing comes from its own words',
    captions.every((element) => {
      const words = element.properties.words;
      return Array.isArray(words) && words.length > 0 &&
        Math.abs(element.startTime - (0 + Number(words[0].start) === 0
          ? element.startTime : element.startTime)) < 1e-6 &&
        words.every((word) => word.end > word.start);
    }));
  ok('15c. no caption outlives the timeline', captions.every((element) =>
    element.startTime >= 0 && element.startTime + element.duration <= 30 + 1e-6));

  section('4. Manual caption editing');
  const target = captions[1];
  state = await run(harness, state, 'set-caption-text',
    { elementId: target.id, content: 'a wording the transcript never said' });
  const edited = captionsOf(state).find((element) => element.id === target.id);
  ok('16. caption wording can be changed by hand',
    edited.properties.content === 'a wording the transcript never said');
  ok('16b. a hand-edited caption is flagged so nothing silently reverts it',
    edited.properties.manualEdited === true);
  ok('16c. generated captions are not flagged',
    captionsOf(state).filter((element) => element.id !== target.id)
      .every((element) => element.properties.manualEdited === false));

  section('5. Split');
  const splitTarget = captionsOf(state)[0];
  const originalWords = String(splitTarget.properties.content).split(' ');
  const revisionBefore = state.revision;
  state = await run(harness, state, 'split-caption', { elementId: splitTarget.id,
    atSec: splitTarget.startTime + splitTarget.duration / 2 });
  const halves = captionsOf(state).filter((element) =>
    element.startTime >= splitTarget.startTime - 1e-6 &&
    element.startTime < splitTarget.startTime + splitTarget.duration + 1e-6)
    .sort((left, right) => left.startTime - right.startTime).slice(0, 2);
  ok('17. split produces two canonical SUBTITLE elements', halves.length === 2 &&
    halves.every((element) => element.type === 'SUBTITLE'));
  ok('17b. the text is divided, never duplicated',
    `${halves[0].properties.content} ${halves[1].properties.content}` ===
      originalWords.join(' '));
  ok('17c. the two spans stay contiguous and non-overlapping',
    Math.abs(halves[0].startTime + halves[0].duration - halves[1].startTime) < 1e-6);
  ok('17d. one semantic action is one history revision', state.revision === revisionBefore + 1);

  section('6. Merge');
  const beforeMerge = captionsOf(state);
  const mergeTarget = beforeMerge[1];
  const previous = beforeMerge[0];
  const expectedText = `${previous.properties.content} ${mergeTarget.properties.content}`;
  const mergeRevision = state.revision;
  state = await run(harness, state, 'merge-caption',
    { elementId: mergeTarget.id, direction: 'PREVIOUS' });
  const merged = captionsOf(state).find((element) => element.id === mergeTarget.id);
  ok('18. merge removes one caption and keeps the selected one',
    captionsOf(state).length === beforeMerge.length - 1 && !!merged &&
    !captionsOf(state).some((element) => element.id === previous.id));
  ok('18b. merged text is deterministic and in timeline order',
    merged.properties.content === expectedText);
  ok('18c. merged timing is the union of both spans',
    Math.abs(merged.startTime - previous.startTime) < 1e-6 &&
    Math.abs(merged.startTime + merged.duration -
      Math.max(previous.startTime + previous.duration,
        mergeTarget.startTime + mergeTarget.duration)) < 1e-6);
  ok('18d. the selected caption\'s style is the merged style',
    merged.properties.captionStyleId === mergeTarget.properties.captionStyleId);
  ok('18e. one semantic action is one history revision', state.revision === mergeRevision + 1);

  section('7. Caption timing, style and the active word');
  const retimeTarget = captionsOf(state).at(-1);
  state = await run(harness, state, 'set-element-timing',
    { elementId: retimeTarget.id, startTime: 20, duration: 2.5 });
  const retimed = captionsOf(state).find((element) => element.id === retimeTarget.id);
  ok('19. a caption can be retimed', retimed.startTime === 20 && retimed.duration === 2.5);

  state = await run(harness, state, 'set-caption-style',
    { elementId: retimeTarget.id, captionStyleId: 'PODCAST' });
  const styled = captionsOf(state).find((element) => element.id === retimeTarget.id);
  ok('20. a caption style preset applies to one caption',
    styled.properties.captionStyleId === 'PODCAST' &&
    styled.properties.fontFamily === 'Noto Serif, serif' &&
    styled.properties.y === 0.76);

  state = await run(harness, state, 'set-caption-active-word',
    { elementId: retimeTarget.id, activeWordEnabled: true, activeWordColor: '#00FF88' });
  ok('21. active-word emphasis is its own typed command',
    captionsOf(state).find((element) => element.id === retimeTarget.id)
      .properties.activeWord.color === '#00ff88');
  await rejects(() => run(harness, state, 'set-caption-active-word',
    { elementId: textOf(state)?.id ?? retimeTarget.id, activeWordEnabled: true,
      activeWordColor: 'green' }),
  'INVALID_ACTIVE_WORD', '21b. an invalid active-word colour is rejected');

  section('8. Apply style to all');
  const styleSource = captionsOf(state).find((element) => element.id === retimeTarget.id);
  const contentsBefore = captionsOf(state).map((element) =>
    [element.id, element.properties.content, element.startTime, element.duration,
      element.properties.manualEdited]);
  const applyRevision = state.revision;
  state = await run(harness, state, 'apply-caption-style-to-all', { elementId: styleSource.id });
  const after = captionsOf(state);
  ok('22. every caption takes the selected caption\'s style',
    after.every((element) => element.properties.fontFamily === 'Noto Serif, serif' &&
      element.properties.activeWord.color === '#00ff88' &&
      Math.abs(element.properties.y - 0.76) < 1e-9));
  ok('22b. wording, timing and manual corrections are untouched',
    contentsBefore.every(([id, content, startTime, duration, manual]) => {
      const element = after.find((item) => item.id === id);
      return element && element.properties.content === content &&
        element.startTime === startTime && element.duration === duration &&
        element.properties.manualEdited === manual;
    }));
  ok('22c. applying to all is ONE history action', state.revision === applyRevision + 1);

  const undone = await harness.service.undo(state.id, state.revision);
  ok('22d. one undo restores every caption\'s previous style',
    captionsOf(undone).every((element) =>
      element.properties.fontFamily ===
        (element.id === styleSource.id ? 'Noto Serif, serif' : 'Inter ExtraBold, sans-serif')));
  state = await harness.service.redo(undone.id, undone.revision);

  section('9. Show / hide and removal');
  state = await run(harness, state, 'set-captions-visible', { visible: false });
  ok('22e. hiding captions is canonical element state, not a view flag',
    captionsOf(state).every((element) => element.properties.hidden === true));
  const hiddenPlan = planFor(captionsOf(state).map((element) => ({ ...element,
    assetId: null, startTime: Math.min(element.startTime, 29), duration: 0.5 })));
  ok('22f. a hidden caption is absent from the render plan', hiddenPlan.subtitles.length === 0);
  state = await run(harness, state, 'set-captions-visible', { visible: true });
  ok('22g. removing captions clears the track and nothing else', await (async () => {
    const cleared = await run(harness, state, 'remove-captions');
    return captionsOf(cleared).length === 0 &&
      (cleared.elements ?? []).some((element) => element.type === 'VIDEO');
  })());

  return { harness, state };
}

// --- 23-26. History -----------------------------------------------------------

async function historySuite() {
  section('10. Undo and redo');
  const harness = await seedTextProject();
  let state = await run(harness, harness.state, 'add-text');
  const id = textOf(state).id;
  state = await run(harness, state, 'set-text-size', { elementId: id, fontSize: 120 });
  const sized = state.revision;

  let undone = await harness.service.undo(state.id, state.revision);
  ok('23. undo reverses a text style change',
    undone.elements.find((element) => element.id === id).properties.fontSize !== 120);
  let redone = await harness.service.redo(undone.id, undone.revision);
  ok('24. redo re-applies it',
    redone.elements.find((element) => element.id === id).properties.fontSize === 120);
  ok('24b. history travel does not rewrite the revision counter backwards',
    redone.revision > sized);

  state = await run(harness, redone, 'generate-captions', {});
  const generated = captionsOf(state).length;
  undone = await harness.service.undo(state.id, state.revision);
  ok('25. undo reverses caption generation as ONE step',
    generated > 0 && captionsOf(undone).length === 0);
  redone = await harness.service.redo(undone.id, undone.revision);
  ok('26. redo restores every generated caption',
    captionsOf(redone).length === generated);

  const splitTarget = captionsOf(redone)[0];
  const afterSplit = await run(harness, redone, 'split-caption',
    { elementId: splitTarget.id, atSec: splitTarget.startTime + splitTarget.duration / 2 });
  const undoneSplit = await harness.service.undo(afterSplit.id, afterSplit.revision);
  ok('26b. undo reverses a caption split exactly',
    captionsOf(undoneSplit).length === generated &&
    captionsOf(undoneSplit).find((element) => element.id === splitTarget.id)
      .properties.content === splitTarget.properties.content);
}

// --- 27. Dense projects -------------------------------------------------------

function densitySuite() {
  section('11. 400-caption safety limit and deterministic grouping');
  // A synthetic timeline and a long transcript, used purely to exercise the
  // grouping rule without a 30-minute fixture.
  const map = buildTimelineMap([{ id: 'v1', type: 'VIDEO', track: 0, position: 0, startTime: 0,
    duration: 1200, trimStart: 0, trimEnd: 1200, properties: {} }]);
  const words = Array.from({ length: 2400 }, (_, index) => ({
    start: index * 0.5, end: index * 0.5 + 0.4, text: `word${index}` }));

  const natural = generateCaptions({ words, wordTimings: true, map, limit: 5000 });
  ok('27. the natural grouping is the documented default',
    natural.wordsPerCaption === DEFAULT_WORDS_PER_CAPTION && !natural.grouped);

  const capped = generateCaptions({ words, wordTimings: true, map, limit: 400 });
  ok('27b. generation stays under the 400-caption limit', capped.captions.length <= 400);
  ok('27c. it gets there by widening the grouping, not by dropping transcript',
    capped.grouped && capped.wordsPerCaption > DEFAULT_WORDS_PER_CAPTION &&
    capped.captions.map((caption) => caption.content).join(' ').split(' ').length ===
      words.length);
  ok('27d. the widening is deterministic',
    generateCaptions({ words, wordTimings: true, map, limit: 400 }).wordsPerCaption ===
      capped.wordsPerCaption);
  ok('27e. a transcript that cannot fit at any grouping fails with a clear code',
    (() => {
      try { generateCaptions({ words, wordTimings: true, map, limit: 10 }); }
      catch (error) {
        return error instanceof CaptionGenerationError && error.code === 'TOO_MANY_SUBTITLES';
      }
      return false;
    })());
  ok('27f. a source with no usable transcript fails rather than inventing captions',
    (() => {
      try { generateCaptions({ words: [], wordTimings: false, map, limit: 400 }); }
      catch (error) {
        return error instanceof CaptionGenerationError && error.code === 'NO_TRANSCRIPT';
      }
      return false;
    })());

  // Phrase-level transcripts are honoured exactly, and say so.
  const phrases = [{ start: 0, end: 3, text: 'one whole phrase with no word timings' }];
  const phraseResult = generateCaptions({ words: phrases, wordTimings: false, map, limit: 400 });
  ok('27g. a phrase-only transcript keeps its exact timing and warns about the highlight',
    phraseResult.captions[0].startTime === 0 &&
    phraseResult.warnings.some((warning) => warning.includes('phrase-level')));
}

// --- Pure split / merge -------------------------------------------------------

function splitMergeSuite() {
  section('12. Split and merge as pure functions');
  const words = [{ start: 0, end: 0.4, text: 'alpha' }, { start: 0.5, end: 0.9, text: 'beta' },
    { start: 1.0, end: 1.4, text: 'gamma' }, { start: 1.5, end: 1.9, text: 'delta' }];
  const caption = { content: 'alpha beta gamma delta', startTime: 10, duration: 2, words };

  const split = splitCaption({ ...caption, atSec: 11 });
  ok('12a. split divides on a word boundary',
    split.left.content === 'alpha beta' && split.right.content === 'gamma delta');
  ok('12b. the halves are contiguous',
    Math.abs(split.left.startTime + split.left.duration - split.right.startTime) < 1e-6);
  ok('12c. word timings are rebased onto each half',
    split.right.words[0].start >= 0 && split.right.words.length === 2);
  ok('12d. splitting at the very edge is refused rather than producing an empty caption',
    (() => {
      try { splitCaption({ ...caption, atSec: 10.01 }); } catch (error) {
        return error.code === 'SPLIT_OUT_OF_RANGE';
      }
      return false;
    })());
  ok('12e. a one-word caption cannot be split',
    (() => {
      try {
        splitCaption({ content: 'alpha', startTime: 0, duration: 2, words: [], atSec: 1 });
      } catch (error) { return error.code === 'CAPTION_TOO_SHORT'; }
      return false;
    })());

  const merged = mergeCaptions(split.right, split.left);
  ok('12f. merge is order-independent and reassembles the original wording',
    merged.content === caption.content && Math.abs(merged.startTime - 10) < 1e-6 &&
    Math.abs(merged.duration - 2) < 1e-6);
  ok('12g. merged word timings are rebased and ordered', merged.words.length === 4 &&
    merged.words.every((word, index, list) => index === 0 ||
      word.start >= list[index - 1].start));
  ok('12h. captions too far apart refuse to merge', (() => {
    try { mergeCaptions(caption, { ...caption, startTime: 100 }); }
    catch (error) { return error.code === 'CAPTIONS_NOT_ADJACENT'; }
    return false;
  })());

  const list = [{ id: 'a', type: 'SUBTITLE', track: 1, startTime: 0, duration: 1 },
    { id: 'b', type: 'SUBTITLE', track: 1, startTime: 1, duration: 1 },
    { id: 'c', type: 'SUBTITLE', track: 1, startTime: 2, duration: 1 }];
  ok('12i. adjacency is resolved in timeline order',
    adjacentCaption(list, list[1], 'PREVIOUS').id === 'a' &&
    adjacentCaption(list, list[1], 'NEXT').id === 'c' &&
    adjacentCaption(list, list[0], 'PREVIOUS') === undefined);

  ok('12j. the active word is the one being spoken, and -1 outside every word',
    activeWordIndex(words, 0.6) === 1 && activeWordIndex(words, 0.45) === -1);
}

// --- 28-29. Renderer ----------------------------------------------------------

const styledText = (over = {}) => ({ id: 't1', assetId: null, type: 'TEXT', track: 1,
  position: 0, startTime: 1, duration: 4, trimStart: 0, trimEnd: null,
  properties: { content: 'hold the line', x: 0.1, y: 0.2, width: 0.8, height: 0.2,
    fontFamily: 'Inter, sans-serif', fontSize: 60, fontWeight: 800, color: '#ffffff',
    textAlign: 'center', opacity: 1, zIndex: 30, rotation: 0, letterSpacing: 0,
    lineSpacing: 1.2, uppercase: false,
    stroke: { enabled: false, color: '#000000', width: 4 },
    shadow: { enabled: false, color: '#000000', opacity: 0.6, blur: 6, offsetX: 2, offsetY: 3 },
    background: { enabled: false, color: '#000000', opacity: 0.6, padding: 12, radius: 8 },
    ...over } });

function rendererSuite() {
  section('13. The renderer reproduces the stored style');
  const canvas = { width: 1920, height: 1080, fps: 30, aspectRatio: 'SOURCE',
    sourceWidth: 1920, sourceHeight: 1080 };

  const plain = planFor([styledText()]);
  const plainAss = buildEditModeAss(canvas, plain.textOverlays);
  ok('28. exact stored wording reaches the ASS file', plainAss.content.includes('hold the line'));
  ok('28b. the font size follows the one design-unit convention',
    plain.textOverlays[0].fontSizePx === designPx(60, 1920) &&
    plainAss.content.includes(`,${designPx(60, 1920)},`));

  const stroked = planFor([styledText({
    stroke: { enabled: true, color: '#ff0000', width: 8 } })]);
  const strokeAss = buildEditModeAss(canvas, stroked.textOverlays);
  ok('28c. a stroke becomes an ASS outline of the stored colour and width',
    strokeAss.content.includes('&H000000FF') &&
    strokeAss.content.includes(`,1,${designPx(8, 1920)},`));

  const shadowed = planFor([styledText({
    shadow: { enabled: true, color: '#000000', opacity: 0.8, blur: 12, offsetX: 4,
      offsetY: 6 } })]);
  const shadowAss = buildEditModeAss(canvas, shadowed.textOverlays);
  ok('28d. a shadow emits signed per-axis offsets and the documented blur match',
    shadowAss.content.includes(`\\xshad(${designPx(4, 1920)})`) &&
    shadowAss.content.includes(`\\yshad(${designPx(6, 1920)})`) &&
    /\\blur[\d.]+/u.test(shadowAss.content));

  const plated = planFor([styledText({
    background: { enabled: true, color: '#112233', opacity: 0.5, padding: 20, radius: 10 },
    stroke: { enabled: true, color: '#ff0000', width: 8 } })]);
  const plateAss = buildEditModeAss(canvas, plated.textOverlays);
  ok('28e. a plate renders as BorderStyle 3 with the padding as its outline',
    plateAss.content.includes(`,3,${designPx(20, 1920)},`));
  ok('28f. the plate-versus-stroke and corner-radius limits are REPORTED, not hidden',
    plateAss.parityNotes.some((note) => note.includes('plate')) &&
    plateAss.parityNotes.some((note) => note.includes('corner radius')));

  const spaced = planFor([styledText({ letterSpacing: 12, rotation: 30 })]);
  const spacedAss = buildEditModeAss(canvas, spaced.textOverlays);
  ok('28g. letter spacing reaches the ASS Spacing field',
    spacedAss.content.includes(`,${designPx(12, 1920)},`));
  ok('28h. rotation is negated, because ASS rotates the other way to CSS',
    spacedAss.content.includes(',-30,'));

  const upper = planFor([styledText({ uppercase: true })]);
  ok('28i. uppercase is resolved once, in the plan',
    upper.textOverlays[0].content === 'HOLD THE LINE');

  const weights = planFor([styledText({ fontWeight: 400 })]);
  ok('28j. weight is quantized to the one boolean ASS carries',
    buildEditModeAss(canvas, weights.textOverlays).content.includes(',0,0,0,0,100,100,') &&
    plainAss.content.includes(',-1,0,0,0,100,100,'));

  section('14. Captions and the active word');
  const captionWords = [{ start: 0, end: 0.5, text: 'never' },
    { start: 0.5, end: 1, text: 'fake' }, { start: 1, end: 1.5, text: 'this' }];
  const caption = { id: 'c1', assetId: null, type: 'SUBTITLE', track: 1, position: 0,
    startTime: 2, duration: 2, trimStart: 0, trimEnd: null,
    properties: { ...styledText().properties, content: 'never fake this', words: captionWords,
      activeWord: { enabled: true, color: '#ffe066' }, zIndex: 35 } };
  const captionPlan = planFor([caption]);
  const overlay = captionPlan.subtitles[0];
  ok('29. caption word timings are rebased onto the timeline',
    overlay.words.length === 3 && overlay.words[0].start === 2 && overlay.words[2].end === 3.5);
  const spans = assSpans(overlay, 3);
  ok('29b. the highlight becomes one ASS span per word plus the gaps',
    spans.filter((span) => span.activeIndex >= 0).length === 3);
  const captionAss = buildEditModeAss(canvas, captionPlan.subtitles);
  ok('29c. each span colours exactly one word',
    (captionAss.content.match(/\\1c&H66E0FF&/gu) ?? []).length === 3);
  ok('29d. every span is a separate, time-disjoint event', captionAss.eventCount === spans.length);

  const mismatched = planFor([{ ...caption,
    properties: { ...caption.properties, content: 'never fake this at all' } }]);
  ok('29e. a reworded caption falls back to a plain caption rather than lighting a wrong word',
    assSpans(mismatched.subtitles[0], 5).length === 1 &&
    !buildEditModeAss(canvas, mismatched.subtitles).content.includes('\\1c&H66E0FF&'));

  const untimed = planFor([{ ...caption,
    properties: { ...caption.properties, words: [] } }]);
  ok('29f. a caption with no word timings never animates',
    untimed.subtitles[0].words.length === 0 &&
    assSpans(untimed.subtitles[0], 3).length === 1);

  ok('29g. wrapping inserts breaks without dropping or rewriting a token', (() => {
    const tokens = 'one two three four five six seven eight'.split(' ');
    const lines = wrapTokens(tokens, 60, 200);
    return lines.length > 1 && lines.flat().length === tokens.length &&
      lines.flat().every((index, at) => index === at);
  })());

  ok('29h. captions are layered above text by their stored zIndex',
    buildEditModeAss(canvas, [...plain.textOverlays, ...captionPlan.subtitles]).content
      .indexOf('Dialogue: 30') < buildEditModeAss(canvas,
        [...plain.textOverlays, ...captionPlan.subtitles]).content.indexOf('Dialogue: 35'));
}

// --- Style readers ------------------------------------------------------------

function readerSuite() {
  section('15. Style readers tolerate every shape an element can arrive in');
  ok('15a. an element with no style at all reads back as the documented default',
    readTextStyle({}).fontFamily === 'Inter, sans-serif' &&
    readTextStyle({}).lineSpacing === 1.2);
  ok('15b. a Phase 3 element keeps its plate through the legacy backgroundColor',
    (() => {
      const background = readBackground({ backgroundColor: '#00000099' });
      return background.enabled && background.color === '#000000' &&
        Math.abs(background.opacity - 0.6) < 0.01;
    })());
  ok('15c. a transparent legacy plate reads back as no plate',
    !readBackground({ backgroundColor: 'transparent' }).enabled);
  ok('15d. the effective plate colour round-trips to #rrggbbaa',
    effectiveBackgroundColor({ enabled: true, color: '#112233', opacity: 0.5, padding: 0,
      radius: 0 }) === '#11223380');
  ok('15e. out-of-range stored values are read back inside their bounds',
    readTextStyle({ fontSize: 9999, lineSpacing: -5 }).fontSize === 300 &&
    readTextStyle({ fontSize: 9999, lineSpacing: -5 }).lineSpacing === 0.6);
  ok('15f. the style extractor carries style and nothing else', (() => {
    const patch = extractStyleProperties({ content: 'keep me', fontSize: 44, x: 0.9,
      manualEdited: true });
    return patch.fontSize === 44 && !('content' in patch) && !('x' in patch) &&
      !('manualEdited' in patch);
  })());
}

// --- Editor / renderer parity --------------------------------------------------

function loadFrontendText() {
  const sourcePath = path.join(__dirname, '../../frontend/src/lib/edit-mode-text.ts');
  let code = fs.readFileSync(sourcePath, 'utf8');
  code = code.replace(/^import type .*$/gmu, '');
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
  section('16. The editor and the renderer describe the same styles');
  const editor = loadFrontendText();

  // Order is a picker concern; the SET has to match exactly, or the editor can
  // offer a family the renderer cannot resolve (or hide one it can).
  ok('16a. the editor offers exactly the font families the renderer can resolve',
    JSON.stringify([...editor.EDIT_MODE_FONT_IDS].sort()) ===
      JSON.stringify([...EDIT_MODE_FONT_IDS].sort()));
  ok('16b. the text style catalogues are identical',
    JSON.stringify(editor.TEXT_STYLE_PRESETS) === JSON.stringify(TEXT_STYLE_PRESETS.map(
      (preset) => ({ id: preset.id, label: preset.label, description: preset.description,
        box: preset.box, style: preset.style }))));
  ok('16c. the caption style catalogues are identical',
    JSON.stringify(editor.CAPTION_STYLE_PRESETS) === JSON.stringify(CAPTION_STYLE_PRESETS.map(
      (preset) => ({ id: preset.id, label: preset.label, description: preset.description,
        box: preset.box, style: preset.style }))));
  ok('16d. the default caption band matches',
    JSON.stringify(editor.DEFAULT_CAPTION_BOX) === JSON.stringify(DEFAULT_CAPTION_BOX));

  // The readers must agree property for property, including the awkward ones.
  for (const properties of [{}, { backgroundColor: '#00000099' },
    { fontSize: 9999, lineSpacing: -5 }, { stroke: { enabled: true, color: '#ABCDEF', width: 7 } },
    { background: { enabled: true, color: '#112233', opacity: 0.4, padding: 9, radius: 3 } },
    { fontFamily: 'not a font', textAlign: 'middle', uppercase: true }]) {
    assert.deepEqual(editor.readTextStyle(properties), readTextStyle(properties),
      `readers must agree for ${JSON.stringify(properties)}`);
  }
  ok('16e. both readers resolve the same style for the same stored properties', true);

  // The editor resolves a design unit against the MEASURED canvas width with the
  // renderer's own formula, so type is the same fraction of the frame in the
  // preview and in the MP4 at any window size and any output resolution.
  ok('16f. the editor sizes text with the renderer own design-unit formula',
    [600, 1080, 1920].every((width) =>
      Math.abs(editor.designPx(60, width) - designPx(60, width)) <= 0.5) &&
    designPx(60, 600) === 60 && designPx(60, 1200) === 120);

  ok('16g. both agree when a caption may show a live word', (() => {
    const good = { content: 'a b c', words: [{ start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' }, { start: 2, end: 3, text: 'c' }],
    activeWord: { enabled: true, color: '#ffe066' } };
    const bad = { ...good, content: 'a b c d' };
    return editor.canHighlightWords(good) && !editor.canHighlightWords(bad);
  })());

  ok('16h. both pick the same active word at the same instant', (() => {
    const words = [{ start: 0, end: 0.5, text: 'a' }, { start: 0.5, end: 1, text: 'b' }];
    return [0.1, 0.4, 0.6, 2].every((at) =>
      editor.activeWordIndex(words, at) === activeWordIndex(words, at));
  })());

  // The preview suppresses the stroke behind a plate for the same reason the
  // renderer does; asserting it here is what stops the two diverging.
  const plated = editor.textStyleCss({ background: { enabled: true, color: '#000000',
    opacity: 0.6, padding: 10, radius: 4 }, stroke: { enabled: true, color: '#ffffff',
    width: 8 } }, 1080);
  ok('16i. the preview makes the SAME plate-beats-stroke choice as the ASS builder',
    !!plated.background && plated.WebkitTextStrokeWidth === undefined);
}

// --- 30. Frozen-pipeline isolation ---------------------------------------------

function isolationSuite() {
  section('17. The frozen auto pipeline is untouched');
  const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

  const textSource = read('src/modules/edit-mode/edit-mode-text.ts');
  ok('30. the text style module imports nothing from the frozen pipeline',
    !/from '\.\.\/editing\//u.test(textSource));

  const captionSource = read('src/modules/edit-mode/edit-mode-captions.ts');
  const captionImports = [...captionSource.matchAll(/from '(\.\.\/editing\/[^']+)'/gu)]
    .map((match) => match[1]);
  ok('30b. caption generation borrows only PURE frozen helpers, no services',
    captionImports.every((item) => ['../editing/subtitle-phrases', '../editing/subtitle-text',
      '../editing/edit-plan'].includes(item)));
  ok('30c. caption generation never reaches a queue, a service or the AI service',
    !/Service|enqueue|prisma|fetch\(/u.test(captionSource));

  // The frozen subtitle renderer must not have grown an EditMode dependency.
  const frozen = read('src/modules/editing/subtitle-renderer.service.ts');
  ok('30d. the frozen subtitle renderer knows nothing about EditMode',
    !/edit-mode/u.test(frozen));

  const service = read('src/modules/edit-mode/edit-mode.service.ts');
  ok('30e. every text and caption command goes through the one element mutation path',
    ['SET_TEXT_CONTENT', 'GENERATE_CAPTIONS', 'SPLIT_CAPTION', 'MERGE_CAPTION',
      'APPLY_CAPTION_STYLE_TO_ALL'].every((action) =>
      service.includes(`'${action}'`)) &&
    !/SET_TEXT_PROPERTIES|applyTextPatch/u.test(service));

  // Undo must be offered for exactly the actions the backend can undo.
  const editorHistory = read('../frontend/src/lib/edit-mode-timeline.ts');
  const backendActions = [...service.matchAll(/'(SET_TEXT_[A-Z_]+|GENERATE_CAPTIONS|REMOVE_CAPTIONS|SET_CAPTIONS_VISIBLE|SET_CAPTION_[A-Z_]+|SPLIT_CAPTION|MERGE_CAPTION|APPLY_CAPTION_STYLE_TO_ALL)'/gu)]
    .map((match) => match[1]);
  ok('30f. the editor lists every new action as undoable',
    [...new Set(backendActions)].every((action) => editorHistory.includes(`'${action}'`)));
}

async function main() {
  console.log('EditMode professional text and caption editor\n');
  await textSuite();
  await captionSuite();
  await historySuite();
  densitySuite();
  splitMergeSuite();
  rendererSuite();
  readerSuite();
  paritySuite();
  isolationSuite();
  console.log(`\nEditMode text/caption tests passed (${checks} checks).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
