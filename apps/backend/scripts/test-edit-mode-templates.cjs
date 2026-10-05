// EditMode templates - Workstream F.
//
// Offline and deterministic. Two halves:
//
//   * the PURE half - the versioned schema, the version reader, the built-in
//     library, and the ownership/diff planner - exercised as plain functions;
//   * the COMMAND half - preview, apply, undo, redo, CRUD and cross-project
//     portability - exercised against the in-memory harness through exactly the
//     same service the HTTP API calls.
//
// The load-bearing claims this file exists to check:
//
//   1. A template is a POLICY. Applying one creates no second project model and
//      no second mutation path: every effect is a canonical command.
//   2. PREVIEW writes nothing at all.
//   3. Manual work survives. Caption WORDING and TIMING, the text of anything
//      the user wrote, and the cuts are never touched - by construction, because
//      no command in a template plan can reach them.
//   4. Re-applying a template restores what it still owns and preserves what the
//      user has changed since.
//   5. One apply is one history revision, one undo and one redo.
//   6. A template is portable: nothing source-specific leaks into it.

const assert = require('node:assert/strict');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

const M = '../dist/modules/edit-mode';
const {
  MAX_TEMPLATE_NAME_LENGTH, SUPPORTED_TEMPLATE_VERSIONS, TEMPLATE_DEFAULTS,
  TEMPLATE_SCHEMA_VERSION, TemplateSchemaError, readTemplate, templatePayload,
  validateTemplateInput
} = require(`${M}/templates/edit-template-schema.js`);
const {
  BUILTIN_TEMPLATES, BUILTIN_TEMPLATE_IDS, builtinTemplateList, isBuiltinTemplateId
} = require(`${M}/templates/edit-template-library.js`);
const {
  CAPTION_TRACK_KEY, captionBox, logoBox, planTemplate, readTemplateRun, resolvedCaptions,
  templateDefaults
} = require(`${M}/templates/edit-template-plan.js`);
const { EditTemplateService, MAX_USER_TEMPLATES } = require(`${M}/edit-template.service.js`);
const { DEFAULT_EDIT_PROJECT_STYLE, readEditProjectStyle } = require(`${M}/presets/edit-preset-policy.js`);
const { readColor, resolveColorFilter } = require(`${M}/edit-mode-color.js`);
const { readAudioState } = require(`${M}/edit-mode-audio.js`);
const { buildRenderPlan } = require(`${M}/render/edit-mode-render-plan.js`);

let checks = 0;
const ok = (label, condition) => { assert(condition, label); checks += 1; console.log(`  ok  ${label}`); };
const section = (title) => console.log(`\n${title}`);

const rejects = (fn, code) => {
  try { fn(); } catch (error) {
    assert(error instanceof TemplateSchemaError, `expected TemplateSchemaError, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
};

// --- 1. Schema ---------------------------------------------------------------

function schemaSuite() {
  section('1. Template schema');
  ok('there is exactly one current schema version', TEMPLATE_SCHEMA_VERSION === 1 &&
    SUPPORTED_TEMPLATE_VERSIONS.includes(1));

  const empty = readTemplate({});
  ok('an empty template normalizes to the documented defaults',
    JSON.stringify({ project: empty.project, captions: empty.captions, color: empty.color,
      zoom: empty.zoom }) ===
    JSON.stringify({ project: TEMPLATE_DEFAULTS.project, captions: TEMPLATE_DEFAULTS.captions,
      color: TEMPLATE_DEFAULTS.color, zoom: TEMPLATE_DEFAULTS.zoom }));
  ok('a missing optional field reads as its default, not as undefined',
    empty.audio.duckStrength === TEMPLATE_DEFAULTS.audio.duckStrength &&
    empty.assets.logoAssetId === null);

  const partial = readTemplate({ version: 1, captions: { styleId: 'PODCAST' },
    color: { filterId: 'WARM' } });
  ok('a partial template keeps what it states and defaults the rest',
    partial.captions.styleId === 'PODCAST' && partial.color.filterId === 'WARM' &&
    partial.captions.placement === TEMPLATE_DEFAULTS.captions.placement);

  ok('an unknown enum value falls back rather than poisoning the template',
    readTemplate({ version: 1, captions: { styleId: 'NOT_A_STYLE' } }).captions.styleId ===
      TEMPLATE_DEFAULTS.captions.styleId);
  ok('an out-of-range number is clamped into its real bound',
    readTemplate({ version: 1, logo: { scale: 99 } }).logo.scale === 0.5 &&
    readTemplate({ version: 1, audio: { musicVolume: -5 } }).audio.musicVolume === 0);
  ok('a nonsense assetId is dropped rather than stored',
    readTemplate({ version: 1, assets: { logoAssetId: '../../etc/passwd' } })
      .assets.logoAssetId === null);
  ok('a legal assetId survives',
    readTemplate({ version: 1, assets: { logoAssetId: 'asset-logo-1' } })
      .assets.logoAssetId === 'asset-logo-1');

  // 2. Version reader.
  section('2. Version reader');
  ok('an unknown MAJOR version is refused, not half-read',
    rejects(() => readTemplate({ version: 99 }), 'UNSUPPORTED_TEMPLATE_VERSION'));
  ok('a non-numeric version is refused',
    rejects(() => readTemplate({ version: 'banana' }), 'INVALID_TEMPLATE_VERSION'));
  ok('a FUTURE MINOR of a supported major still reads, with new fields defaulted',
    readTemplate({ version: 1.7, captions: { styleId: 'SOCIAL' }, somethingNew: true })
      .captions.styleId === 'SOCIAL');
  ok('a round trip through templatePayload is stable',
    JSON.stringify(readTemplate(templatePayload(partial))) ===
    JSON.stringify(readTemplate(templatePayload(readTemplate(templatePayload(partial))))));

  // 24/25. Saving is stricter than reading.
  section('3. Saving validates strictly');
  ok('a template with no name is refused',
    rejects(() => validateTemplateInput({}), 'INVALID_TEMPLATE_NAME'));
  ok('an over-long name is refused',
    rejects(() => validateTemplateInput({ name: 'x'.repeat(MAX_TEMPLATE_NAME_LENGTH + 1) }),
      'INVALID_TEMPLATE_NAME'));
  ok('an explicitly wrong enum is an ERROR when saving, not a silent fallback',
    rejects(() => validateTemplateInput({ name: 'T', captions: { styleId: 'NOPE' } }),
      'INVALID_TEMPLATE_FIELD'));
  ok('an out-of-range number is an error when saving',
    rejects(() => validateTemplateInput({ name: 'T', logo: { scale: 9 } }),
      'INVALID_TEMPLATE_FIELD'));
  ok('a valid save is stamped USER and the current version',
    validateTemplateInput({ name: 'Mine', captions: { styleId: 'SOCIAL' } }).source === 'USER');
}

// --- 4. Built-ins ------------------------------------------------------------

function builtinSuite() {
  section('4. Built-in template library');
  const list = builtinTemplateList();
  ok('all twelve built-ins are present', list.length === 12 &&
    BUILTIN_TEMPLATE_IDS.length === 12);
  ok('every id is unique', new Set(BUILTIN_TEMPLATE_IDS).size === 12);
  ok('every name is unique', new Set(list.map((item) => item.name)).size === 12);
  ok('the twelve names the brief asked for are all there',
    ['Clean Reel', 'Bold Social', 'Podcast Pro', 'Educational', 'Product Promo',
      'Minimal Business', 'Motivational', 'Cinematic', 'Talking Head', 'Screen Tutorial',
      'Gaming Clip', 'News / Explainer'].every((name) =>
      list.some((item) => item.name === name)));
  ok('every built-in is marked BUILTIN', list.every((item) => item.source === 'BUILTIN'));
  ok('every built-in carries a short style description',
    list.every((item) => item.description.length > 10 && item.description.length <= 200));
  ok('no built-in binds an asset - they are portable by construction',
    list.every((item) => !item.assets.logoAssetId && !item.assets.musicAssetId));
  ok('every built-in is at the current schema version',
    list.every((item) => item.version === TEMPLATE_SCHEMA_VERSION));
  ok('the library is deterministic - reading it twice gives identical definitions',
    JSON.stringify(builtinTemplateList()) === JSON.stringify(builtinTemplateList()));
  ok('isBuiltinTemplateId recognises a built-in and rejects anything else',
    isBuiltinTemplateId('CLEAN_REEL') && !isBuiltinTemplateId('MY_TEMPLATE'));

  // Each template has to be meaningfully DIFFERENT, or the library is decoration.
  const fingerprints = list.map((item) => JSON.stringify(templatePayload(item)));
  ok('no two built-ins are the same policy', new Set(fingerprints).size === 12);

  // The specific intents the brief named.
  ok('Screen Tutorial protects on-screen information and does not zoom',
    BUILTIN_TEMPLATES.SCREEN_TUTORIAL.zoom === 'OFF' &&
    BUILTIN_TEMPLATES.SCREEN_TUTORIAL.informationRegion === 'PRESERVE' &&
    BUILTIN_TEMPLATES.SCREEN_TUTORIAL.reframe === 'INFORMATION_PRESERVING');
  ok('Educational keeps movement minimal and framing information-safe',
    BUILTIN_TEMPLATES.EDUCATIONAL.zoom === 'OFF' &&
    BUILTIN_TEMPLATES.EDUCATIONAL.informationRegion === 'PRESERVE');
  ok('Podcast Pro is speech-first: face framing, ducked music, quiet bed',
    BUILTIN_TEMPLATES.PODCAST_PRO.reframe === 'FACE_FOCUSED' &&
    BUILTIN_TEMPLATES.PODCAST_PRO.audio.duckEnabled &&
    BUILTIN_TEMPLATES.PODCAST_PRO.audio.musicVolume <= 0.2);
  ok('Cinematic actually uses the cinematic grade',
    BUILTIN_TEMPLATES.CINEMATIC.color.filterId === 'CINEMATIC');
  ok('Gaming Clip is the most aggressive on zoom and contrast',
    BUILTIN_TEMPLATES.GAMING_CLIP.zoom === 'STRONG' &&
    BUILTIN_TEMPLATES.GAMING_CLIP.color.filterId === 'HIGH_CONTRAST');
  ok('Bold Social and Motivational both use bold highlighted captions',
    BUILTIN_TEMPLATES.BOLD_SOCIAL.captions.styleId === 'BOLD_HIGHLIGHT' &&
    BUILTIN_TEMPLATES.MOTIVATIONAL.captions.styleId === 'BOLD_HIGHLIGHT');
  ok('Minimal Business is restrained: no zoom, quiet grade, small logo',
    BUILTIN_TEMPLATES.MINIMAL_BUSINESS.zoom === 'OFF' &&
    BUILTIN_TEMPLATES.MINIMAL_BUSINESS.color.strength <= 0.5 &&
    BUILTIN_TEMPLATES.MINIMAL_BUSINESS.logo.scale <= 0.14);
  ok('News / Explainer keeps captions low and framing information-safe',
    BUILTIN_TEMPLATES.NEWS_EXPLAINER.captions.placement === 'LOWER' &&
    BUILTIN_TEMPLATES.NEWS_EXPLAINER.informationRegion === 'PRESERVE');

  // Resolution helpers.
  section('5. Placement resolution');
  ok('a LOWER placement resolves to the safe caption band',
    captionBox(BUILTIN_TEMPLATES.CLEAN_REEL).y > 0.7);
  ok('a CENTER placement lifts captions off the bottom',
    captionBox(BUILTIN_TEMPLATES.BOLD_SOCIAL).y === 0.6);
  ok('an UPPER placement keeps captions clear of lower-screen UI',
    captionBox(BUILTIN_TEMPLATES.SCREEN_TUTORIAL).y < 0.2);
  ok('a PRESET placement defers to the caption style itself',
    JSON.stringify(captionBox(readTemplate({ version: 1, captions: { styleId: 'PODCAST',
      placement: 'PRESET' } }))) === JSON.stringify({ x: 0.08, y: 0.76, width: 0.84,
      height: 0.12 }));
  ok('an explicit uppercase override beats the caption preset',
    resolvedCaptions(readTemplate({ version: 1, captions: { styleId: 'CLEAN',
      uppercase: true } })).uppercase === true);
  ok('a null override inherits the caption preset',
    resolvedCaptions(readTemplate({ version: 1, captions: { styleId: 'BOLD_HIGHLIGHT' } }))
      .uppercase === true);
  const box = logoBox(BUILTIN_TEMPLATES.CLEAN_REEL, { width: 0.2, height: 0.1 });
  ok('a TOP_RIGHT logo lands inside the frame with a margin',
    box.x > 0.5 && box.x + box.width <= 1 && box.y < 0.1);
  ok('the logo keeps its own aspect ratio when the template resizes it',
    Math.abs(box.height / box.width - 0.5) < 1e-6);
  ok('a KEEP placement produces no box, so nothing moves',
    logoBox(readTemplate({ version: 1 }), { width: 0.2, height: 0.1 }) === null);
}

// --- 6. The planner: ownership, diff, preservation ---------------------------

const element = (id, type, properties = {}, over = {}) => ({
  id, type, track: type === 'VIDEO' ? 0 : type === 'SUBTITLE' ? 1 : 2, position: 0,
  assetId: over.assetId ?? null,
  properties: { startTime: 0, duration: 5, ...properties }, ...over
});

const scene = () => [
  element('v1', 'VIDEO', { speed: 1 }, { assetId: 'src' }),
  element('c1', 'SUBTITLE', { content: 'First corrected line', startTime: 0, duration: 2,
    captionStyleId: 'CLEAN', x: 0.1, y: 0.73, width: 0.8, height: 0.13, uppercase: false,
    activeWord: { enabled: false, color: '#ffe066' }, manualEdited: true }),
  element('c2', 'SUBTITLE', { content: 'Second line', startTime: 2, duration: 2,
    captionStyleId: 'CLEAN', x: 0.1, y: 0.73, width: 0.8, height: 0.13 }),
  element('t-manual', 'TEXT', { content: 'My own headline', origin: 'USER',
    textStyleId: 'BASIC' }),
  element('t-hook', 'TEXT', { content: 'Preset hook', origin: 'PRESET', presetRole: 'HOOK',
    textStyleId: 'BASIC' }),
  element('logo1', 'IMAGE', { role: 'LOGO', x: 0.4, y: 0.4, width: 0.2, height: 0.1 },
    { assetId: 'asset-logo' }),
  element('mus1', 'AUDIO', { volume: 0.9, fadeInSec: 0, fadeOutSec: 0, duckUnderSpeech: false },
    { assetId: 'asset-music' })
];

const planFor = (template, over = {}) => planTemplate({
  template, style: { ...DEFAULT_EDIT_PROJECT_STYLE }, elements: over.elements ?? scene(),
  assets: over.assets ?? [{ id: 'src', role: 'SOURCE' }, { id: 'asset-logo', role: 'LOGO' },
    { id: 'asset-music', role: 'AUDIO' }],
  previousRun: over.previousRun ?? null,
  duckingAvailable: over.duckingAvailable ?? true });

function plannerSuite() {
  section('6. The planner: what a template may and may not touch');
  const plan = planFor(BUILTIN_TEMPLATES.PODCAST_PRO);
  const actions = plan.commands.filter((command) => command.kind === 'ELEMENT')
    .map((command) => command.action);

  ok('a plan is made of canonical command names only',
    actions.every((action) => ['SET_CAPTION_STYLE', 'MOVE_ELEMENT', 'RESIZE_ELEMENT',
      'SET_CAPTION_ACTIVE_WORD', 'SET_TEXT_CASE', 'APPLY_CAPTION_STYLE_TO_ALL',
      'SET_TEXT_STYLE_PRESET', 'APPLY_COLOR_FILTER', 'SET_AUDIO_VOLUME', 'SET_AUDIO_FADE',
      'SET_AUDIO_DUCKING'].includes(action)));
  ok('NO command in a template plan can create or delete an element',
    !actions.some((action) => action.startsWith('ADD_') || action.startsWith('REMOVE_') ||
      action.startsWith('DELETE_') || action === 'DUPLICATE_ELEMENT'));
  ok('NO command in a template plan writes caption or text CONTENT',
    !actions.some((action) => ['SET_CAPTION_TEXT', 'SET_TEXT_CONTENT', 'UPDATE_TEXT',
      'GENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SPLIT_CAPTION', 'MERGE_CAPTION']
      .includes(action)));
  ok('NO command in a template plan writes element TIMING or the cut list',
    !actions.some((action) => ['SET_ELEMENT_TIMING', 'TRIM_ELEMENT', 'SPLIT_ELEMENT',
      'SET_SPEED', 'SET_VIDEO_CROP', 'SET_VIDEO_ROTATION', 'SET_VIDEO_FLIP'].includes(action)));
  ok('the whole caption track is restyled by ONE command, whatever its length',
    actions.filter((action) => action === 'APPLY_CAPTION_STYLE_TO_ALL').length === 1);
  ok('project-level style is one SETTINGS command',
    plan.commands.filter((command) => command.kind === 'SETTINGS').length === 1);

  const settings = plan.commands.find((command) => command.kind === 'SETTINGS').payload;
  ok('the SETTINGS command carries exactly the render-visible project policy',
    settings.aspectRatio === '9:16' && settings.zoomPolicy === 'SUBTLE' &&
    settings.reframePolicy === 'FACE_FOCUSED' && settings.pacing === 'MODERATE');

  section('7. The bounded diff');
  ok('the diff is human-readable lines, never raw JSON',
    plan.changes.every((change) => typeof change.label === 'string' &&
      typeof change.from === 'string' && typeof change.to === 'string' &&
      !change.to.includes('{')));
  ok('the diff names the aspect-ratio change',
    plan.changes.some((change) => change.label === 'Aspect ratio' && change.to === '9:16'));
  ok('the diff names the caption style change',
    plan.changes.some((change) => change.label === 'Caption style' && change.to === 'Podcast'));
  ok('the diff names the colour change',
    plan.changes.some((change) => change.facet === 'COLOR'));
  ok('the diff names the music volume change with percentages',
    plan.changes.some((change) => change.label === 'Music volume' && change.from === '90%' &&
      change.to === '15%'));
  ok('a change line is only emitted when the value actually differs',
    plan.changes.every((change) => change.from !== change.to));
  // A diff that grew with the timeline would stop being readable exactly when it
  // mattered. This is the case the browser pass caught: 57 logo overlays turned
  // a four-line logo diff into 114 lines.
  const denseScene = (() => {
    const many = [element('v1', 'VIDEO', {}, { assetId: 'src' }),
      element('m1', 'AUDIO', { volume: 0.9 }, { assetId: 'asset-music' })];
    for (let index = 0; index < 400; index += 1) {
      many.push(element(`cap-${index}`, 'SUBTITLE', { content: `line ${index}`,
        startTime: index * 0.1, duration: 0.09, captionStyleId: 'CLEAN' }));
    }
    for (let index = 0; index < 57; index += 1) {
      many.push(element(`logo-${index}`, 'IMAGE', { role: 'LOGO', x: 0.4, y: 0.4,
        width: 0.2, height: 0.1 }, { assetId: 'asset-logo' }));
    }
    for (let index = 0; index < 8; index += 1) {
      many.push(element(`vid-${index}`, 'VIDEO', {}, { assetId: 'src' }));
    }
    return many;
  })();
  const dense = planFor(BUILTIN_TEMPLATES.BOLD_SOCIAL, { elements: denseScene });
  ok('the diff stays bounded on a 400-caption, 57-logo, 9-clip project',
    dense.changes.length <= 20);
  ok('the preserved list stays bounded too', dense.preserved.length <= 12);
  ok('the warning list carries each cause once, not once per element',
    dense.warnings.length === new Set(dense.warnings).size);
  ok('no diff LABEL is ever repeated',
    dense.changes.length === new Set(dense.changes.map((item) => item.label)).size);
  ok('no preserved LABEL is ever repeated',
    dense.preserved.length === new Set(dense.preserved.map((item) => item.label)).size);
  ok('...while the COMMANDS still cover every element that needs one',
    dense.commands.filter((command) => command.facet === 'LOGO').length === 114 &&
    dense.commands.filter((command) => command.facet === 'COLOR').length === 9);

  section('8. Preservation');
  ok('caption WORDING is named as preserved',
    plan.preserved.some((item) => /caption wording/iu.test(item.label)));
  ok('caption TIMING is named as preserved',
    plan.preserved.some((item) => /caption timing/iu.test(item.label)));
  ok('the user\'s own text is named as preserved',
    plan.preserved.some((item) => /your text/iu.test(item.label)));
  ok('cuts, trims and splits are named as preserved',
    plan.preserved.some((item) => /cuts, trims/iu.test(item.label)));
  ok('crop/rotation/flip/speed are named as preserved',
    plan.preserved.some((item) => /crop, rotation/iu.test(item.label)));
  ok('every preserved entry explains WHY',
    plan.preserved.every((item) => item.reason.length > 10));

  section('9. Text ownership');
  const textCommands = plan.commands.filter((command) => command.action === 'SET_TEXT_STYLE_PRESET');
  ok('the preset-authored hook IS restyled',
    textCommands.some((command) => command.elementId === 't-hook'));
  ok('the user\'s own text is NOT restyled',
    !textCommands.some((command) => command.elementId === 't-manual'));
  ok('a restyle never moves text the user placed',
    textCommands.every((command) => command.payload.applyBox === false));

  section('10. Re-apply preserves what the user changed since');
  // Apply once, then pretend the user changed three things, then re-apply.
  const first = planFor(BUILTIN_TEMPLATES.PODCAST_PRO);
  const run = { templateId: 'PODCAST_PRO', templateName: 'Podcast Pro', templateRunId: 'run-1',
    source: 'BUILTIN', appliedAtRevision: 5, imprints: first.imprints };
  ok('the first apply records an imprint for every facet it wrote',
    first.imprints.some((entry) => entry.elementId === CAPTION_TRACK_KEY) &&
    first.imprints.some((entry) => entry.facet === 'COLOR') &&
    first.imprints.some((entry) => entry.facet === 'AUDIO') &&
    first.imprints.some((entry) => entry.facet === 'LOGO'));

  // Nothing changed since: the template still owns everything it wrote.
  const applied = scene().map((item) => {
    if (item.type === 'SUBTITLE') {
      return { ...item, properties: { ...item.properties, captionStyleId: 'PODCAST',
        x: 0.1, y: 0.73, width: 0.8, height: 0.13, uppercase: false,
        activeWord: { enabled: true, color: '#7dd3fc' } } };
    }
    if (item.type === 'VIDEO') {
      return { ...item, properties: { ...item.properties, colorFilterId: 'CLEAN',
        colorFilterStrength: 0.8 } };
    }
    if (item.type === 'AUDIO') {
      return { ...item, properties: { ...item.properties, volume: 0.15, fadeInSec: 1,
        fadeOutSec: 1.2, duckUnderSpeech: true, duckStrength: 'STRONG' } };
    }
    if (item.properties.role === 'LOGO') {
      const target = logoBox(BUILTIN_TEMPLATES.PODCAST_PRO, { width: 0.2, height: 0.1 });
      return { ...item, properties: { ...item.properties, ...target } };
    }
    return item;
  });
  const untouched = planFor(BUILTIN_TEMPLATES.PODCAST_PRO,
    { elements: applied, previousRun: run });
  ok('re-applying an untouched project re-writes everything it owns',
    untouched.commands.some((command) => command.facet === 'CAPTIONS') &&
    untouched.commands.some((command) => command.facet === 'COLOR') &&
    untouched.commands.some((command) => command.facet === 'AUDIO') &&
    untouched.commands.some((command) => command.facet === 'LOGO'));

  // Now the user moves the logo, changes the music and restyles the captions.
  const edited = applied.map((item) => {
    if (item.properties.role === 'LOGO') {
      return { ...item, properties: { ...item.properties, x: 0.33, y: 0.44 } };
    }
    if (item.type === 'AUDIO') {
      return { ...item, properties: { ...item.properties, volume: 0.77 } };
    }
    if (item.type === 'SUBTITLE') {
      return { ...item, properties: { ...item.properties, captionStyleId: 'HIGH_CONTRAST' } };
    }
    return item;
  });
  const reapplied = planFor(BUILTIN_TEMPLATES.PODCAST_PRO,
    { elements: edited, previousRun: run });
  ok('a logo the user moved is PRESERVED on re-apply',
    !reapplied.commands.some((command) => command.facet === 'LOGO') &&
    reapplied.preserved.some((item) => /logo placement/iu.test(item.label)));
  ok('music the user re-levelled is PRESERVED on re-apply',
    !reapplied.commands.some((command) => command.facet === 'AUDIO') &&
    reapplied.preserved.some((item) => /music levels/iu.test(item.label)));
  ok('captions the user restyled are PRESERVED on re-apply',
    !reapplied.commands.some((command) => command.facet === 'CAPTIONS') &&
    reapplied.preserved.some((item) => /caption styling/iu.test(item.label)));
  ok('...while the untouched colour grade is still re-applied',
    reapplied.commands.some((command) => command.facet === 'COLOR'));
  ok('a preserved facet keeps its old imprint, so ownership is not silently lost',
    reapplied.imprints.some((entry) => entry.elementId === CAPTION_TRACK_KEY &&
      entry.fingerprint === first.imprints.find((item) =>
        item.elementId === CAPTION_TRACK_KEY).fingerprint));
  ok('project-level style is re-applied regardless - it is inherently project-wide',
    reapplied.commands.some((command) => command.kind === 'SETTINGS'));

  section('11. Missing pieces degrade, never fail');
  const noLogo = planFor(BUILTIN_TEMPLATES.CLEAN_REEL,
    { elements: scene().filter((item) => item.properties.role !== 'LOGO') });
  ok('a template with a logo placement and no logo warns and invents nothing',
    !noLogo.commands.some((command) => command.facet === 'LOGO') &&
    noLogo.warnings.some((warning) => /no logo/iu.test(warning)));
  const noMusic = planFor(BUILTIN_TEMPLATES.CLEAN_REEL,
    { elements: scene().filter((item) => item.type !== 'AUDIO') });
  ok('a template with audio defaults and no music fabricates no audio track',
    !noMusic.commands.some((command) => command.facet === 'AUDIO') &&
    noMusic.warnings.some((warning) => /no music/iu.test(warning)));
  const noCaptions = planFor(BUILTIN_TEMPLATES.CLEAN_REEL,
    { elements: scene().filter((item) => item.type !== 'SUBTITLE') });
  ok('a template never generates captions where there are none',
    !noCaptions.commands.some((command) => command.facet === 'CAPTIONS') &&
    noCaptions.warnings.some((warning) => /no captions/iu.test(warning)));
  ok('ducking without word timings is stored but not applied, and says so',
    (() => {
      const noWords = planFor(BUILTIN_TEMPLATES.PODCAST_PRO, { duckingAvailable: false });
      const duck = noWords.commands.find((command) => command.action === 'SET_AUDIO_DUCKING');
      return duck.payload.duckEnabled === false &&
        noWords.warnings.some((warning) => /Analyze source/iu.test(warning));
    })());
  // The imprint records what the template WROTE, not what it wished for. With
  // ducking unavailable the two differ, and an imprint of the wish would make
  // the next apply mistake the template's own work for a user edit.
  ok('with ducking unavailable, a re-apply still owns the music it set',
    (() => {
      const first = planFor(BUILTIN_TEMPLATES.PODCAST_PRO, { duckingAvailable: false });
      const written = scene().map((item) => item.type === 'AUDIO'
        ? { ...item, properties: { ...item.properties,
          volume: BUILTIN_TEMPLATES.PODCAST_PRO.audio.musicVolume,
          fadeInSec: BUILTIN_TEMPLATES.PODCAST_PRO.audio.fadeInSec,
          fadeOutSec: BUILTIN_TEMPLATES.PODCAST_PRO.audio.fadeOutSec,
          duckUnderSpeech: false,
          duckStrength: BUILTIN_TEMPLATES.PODCAST_PRO.audio.duckStrength } }
        : item);
      const again = planFor(BUILTIN_TEMPLATES.PODCAST_PRO, { elements: written,
        duckingAvailable: false,
        previousRun: { templateId: 'PODCAST_PRO', templateName: 'Podcast Pro',
          templateRunId: 'r', source: 'BUILTIN', appliedAtRevision: 1,
          imprints: first.imprints } });
      return again.commands.some((command) => command.facet === 'AUDIO') &&
        !again.preserved.some((item) => /music levels/iu.test(item.label));
    })());

  section('12. Optional asset binding');
  const boundPresent = planFor(readTemplate({ ...templatePayload(BUILTIN_TEMPLATES.CLEAN_REEL),
    assets: { logoAssetId: 'asset-logo', musicAssetId: 'asset-music' } },
  { id: 'BOUND', name: 'Bound', source: 'USER' }));
  ok('a bound asset that IS in the project is reported as available',
    boundPresent.preserved.some((item) => /bound logo/iu.test(item.label)));
  const boundMissing = planFor(readTemplate({ ...templatePayload(BUILTIN_TEMPLATES.CLEAN_REEL),
    assets: { logoAssetId: 'asset-elsewhere' } }, { id: 'B2', name: 'B2', source: 'USER' }));
  ok('a bound asset that is MISSING warns clearly and does not fail the template',
    boundMissing.warnings.some((warning) => /not in this project/iu.test(warning)) &&
    boundMissing.commands.length > 1);

  section('13. Template defaults for things that do not exist yet');
  const defaults = templateDefaults(BUILTIN_TEMPLATES.GAMING_CLIP);
  ok('defaults carry the audio and text policy for later use',
    defaults.musicVolume === BUILTIN_TEMPLATES.GAMING_CLIP.audio.musicVolume &&
    defaults.textStyleId === BUILTIN_TEMPLATES.GAMING_CLIP.text.defaultStyleId);
  ok('readTemplateRun rejects malformed settings rather than trusting them',
    readTemplateRun({ templateRun: { nope: true } }) === null &&
    readTemplateRun(null) === null &&
    readTemplateRun({ templateRun: { templateId: 'X', templateRunId: 'r', imprints: 'bad' } })
      .imprints.length === 0);
}

// --- 14. The command layer ---------------------------------------------------

/** A project with a source, a logo and a music file. `suffix` gives the second
 *  project genuinely DIFFERENT asset ids, which is what makes the cross-project
 *  and missing-bound-asset tests mean something. */
async function seedProject(suffix = '') {
  const state = await seedAnalyzedProject(createHarness());
  const id = state.project.id;
  for (const asset of [
    { id: `asset-logo${suffix}`, role: 'LOGO', originalName: 'logo.png', mimeType: 'image/png',
      bucket: 'test-bucket', objectKey: `edit-mode/${id}/asset-logo/logo.png`,
      sizeBytes: 512n, duration: null, width: 400, height: 200, fps: null, metadata: {} },
    { id: `asset-music${suffix}`, role: 'AUDIO', originalName: 'bed.wav', mimeType: 'audio/wav',
      bucket: 'test-bucket', objectKey: `edit-mode/${id}/asset-music/bed.wav`,
      sizeBytes: 4096n, duration: 30, width: null, height: null, fps: null, metadata: {} }
  ]) {
    state.rows.editAssets.set(asset.id, { ...asset, editProjectId: id, transcript: null,
      analysis: null, createdAt: new Date(), updatedAt: new Date() });
  }
  return state;
}

async function commandSuite() {
  section('14. Preview, apply, undo and redo through the canonical layer');
  const state = await seedProject();
  const { service, prisma } = state;
  const templates = new EditTemplateService(prisma, service);
  const id = state.project.id;
  let project = state.analyzed;
  const run = async (action, payload) => {
    project = await service.phase3Command(id, action, { revision: project.revision, ...payload });
    return project;
  };
  const byType = (type) => (project.elements ?? []).filter((element) => element.type === type);
  const reload = async () => { project = await service.get(id); return project; };

  // A project with real manual work in it (Part 28).
  await run('add-text', { content: 'Text' });
  const manualTextId = byType('TEXT')[0].id;
  await run('set-text-content', { elementId: manualTextId, content: 'My own headline' });
  await run('add-logo', { assetId: 'asset-logo' });
  const logoId = byType('IMAGE')[0].id;
  await run('move-element', { elementId: logoId, x: 0.33, y: 0.44 });
  await run('add-audio', { assetId: 'asset-music' });
  const musicId = byType('AUDIO')[0].id;
  await run('set-audio-volume', { elementId: musicId, volume: 0.85 });
  await run('set-video-contrast', { elementId: byType('VIDEO')[0].id, contrast: 0.42 });
  // A real cut, so "the cuts survived" is a claim about an actually-split track.
  project = await service.splitElement(id, { revision: project.revision,
    elementId: byType('VIDEO')[0].id, playheadSec: 5 });

  // Captions, then a manual correction to one of them.
  const source = state.rows.editAssets.get('asset-source');
  source.transcript = { text: 'one two three four five six', language: 'en', duration: 12.5,
    segments: [{ position: 0, start: 0, end: 6, text: 'one two three four five six',
      words: ['one', 'two', 'three', 'four', 'five', 'six'].map((text, index) => ({
        text, start: index, end: index + 0.9 })) }] };
  await run('generate-captions', { captionStyleId: 'CLEAN' });
  const captionsBefore = byType('SUBTITLE');
  ok('fixture: captions were generated from the cached transcript', captionsBefore.length >= 2);
  const correctedId = captionsBefore[0].id;
  await run('set-caption-text', { elementId: correctedId, content: 'Manually corrected wording' });
  const correctedBefore = byType('SUBTITLE').find((item) => item.id === correctedId);
  const timingsBefore = byType('SUBTITLE').map((item) =>
    `${item.id}:${item.startTime}:${item.duration}`).join('|');
  const cutsBefore = byType('VIDEO').map((item) =>
    `${item.id}:${item.trimStart}:${item.trimEnd}`).join('|');

  // --- PREVIEW writes nothing ------------------------------------------------
  const revisionBeforePreview = project.revision;
  const elementsBeforePreview = JSON.stringify(project.elements);
  const settingsBeforePreview = JSON.stringify(project.settings);
  const historyBefore = state.rows.editHistory.size;
  const preview = await templates.preview(id, { templateId: 'PODCAST_PRO',
    revision: project.revision });
  await reload();
  ok('PREVIEW returns a named, described proposal',
    preview.mode === 'PREVIEW' && preview.templateName === 'Podcast Pro' &&
    preview.changes.length > 0 && preview.preserved.length > 0);
  ok('PREVIEW never leaks the command list to the client',
    preview.commands === undefined && preview.imprints === undefined);
  ok('PREVIEW does not change the revision', project.revision === revisionBeforePreview);
  ok('PREVIEW does not change a single element',
    JSON.stringify(project.elements) === elementsBeforePreview);
  ok('PREVIEW does not change settings',
    JSON.stringify(project.settings) === settingsBeforePreview);
  ok('PREVIEW writes no history row', state.rows.editHistory.size === historyBefore);

  // --- APPLY -----------------------------------------------------------------
  const applied = await templates.apply(id, { templateId: 'PODCAST_PRO',
    revision: project.revision });
  project = applied.project;
  ok('APPLY is exactly ONE revision', project.revision === revisionBeforePreview + 1);
  ok('APPLY writes exactly one history row',
    state.rows.editHistory.size === historyBefore + 1);
  const entry = [...state.rows.editHistory.values()].at(-1);
  ok('the history row is actor TEMPLATE, action APPLY_TEMPLATE',
    entry.actor === 'TEMPLATE' && entry.action === 'APPLY_TEMPLATE');
  ok('the history row records templateId, templateName and templateRunId',
    entry.command.templateId === 'PODCAST_PRO' && entry.command.templateName === 'Podcast Pro' &&
    typeof entry.command.templateRunId === 'string');

  section('15. What the template changed');
  const style = readEditProjectStyle(project.settings);
  ok('project style now matches the template',
    style.aspectRatio === '9:16' && style.zoomPolicy === 'SUBTLE' &&
    style.reframePolicy === 'FACE_FOCUSED');
  ok('every caption carries the template caption style',
    byType('SUBTITLE').every((item) => item.properties.captionStyleId === 'PODCAST'));
  ok('the colour filter resolved to concrete stored adjustments (no hidden state)',
    (() => {
      const video = byType('VIDEO')[0];
      const expected = resolveColorFilter('CLEAN', 0.8);
      return video.properties.colorFilterId === 'CLEAN' &&
        JSON.stringify(readColor(video.properties)) === JSON.stringify(expected);
    })());
  ok('music took the template levels, fades and ducking',
    (() => {
      const audio = readAudioState(byType('AUDIO')[0].properties);
      return audio.volume === 0.15 && audio.fadeInSec === 1 && audio.fadeOutSec === 1.2 &&
        audio.duckEnabled === true;
    })());
  ok('the logo was placed by the template',
    byType('IMAGE')[0].properties.x > 0 && byType('IMAGE')[0].properties.y < 0.1);
  ok('touched elements carry the ownership stamp',
    byType('SUBTITLE').every((item) => item.properties.templateId === 'PODCAST_PRO' &&
      typeof item.properties.templateRunId === 'string' &&
      item.properties.templateRole === 'CAPTIONS'));
  ok('the run is recorded on settings for the next apply',
    readTemplateRun(project.settings).templateId === 'PODCAST_PRO' &&
    readTemplateRun(project.settings).imprints.length > 0);
  ok('the template defaults are stored for things that do not exist yet',
    project.settings.templateDefaults.musicVolume === 0.15);

  section('16. What the template preserved (the mandatory test)');
  const correctedAfter = byType('SUBTITLE').find((item) => item.id === correctedId);
  ok('caption WORDING survived exactly',
    correctedAfter.properties.content === correctedBefore.properties.content &&
    correctedAfter.properties.content === 'Manually corrected wording');
  ok('the manual-correction flag survived',
    correctedAfter.properties.manualEdited === correctedBefore.properties.manualEdited);
  ok('caption TIMING survived exactly',
    byType('SUBTITLE').map((item) => `${item.id}:${item.startTime}:${item.duration}`)
      .join('|') === timingsBefore);
  ok('no caption was added or removed',
    byType('SUBTITLE').length === captionsBefore.length);
  ok('the user\'s own text content survived',
    byType('TEXT').find((item) => item.id === manualTextId).properties.content ===
      'My own headline');
  ok('the user\'s own text was not restyled either',
    byType('TEXT').find((item) => item.id === manualTextId).properties.textStyleId === 'BASIC');
  ok('the cuts survived exactly',
    byType('VIDEO').map((item) => `${item.id}:${item.trimStart}:${item.trimEnd}`)
      .join('|') === cutsBefore);

  section('17. Undo and redo');
  project = await service.undo(id, project.revision);
  ok('ONE undo restores the whole pre-template state',
    readEditProjectStyle(project.settings).aspectRatio === 'SOURCE' &&
    byType('SUBTITLE').every((item) => item.properties.captionStyleId === 'CLEAN') &&
    Math.abs(byType('AUDIO')[0].properties.volume - 0.85) < 1e-9);
  ok('undo also restores the manual colour tweak',
    Math.abs(readColor(byType('VIDEO')[0].properties).contrast - 0.42) < 1e-9);
  ok('undo does not touch the caption wording either',
    byType('SUBTITLE').find((item) => item.id === correctedId).properties.content ===
      'Manually corrected wording');
  project = await service.redo(id, project.revision);
  ok('ONE redo re-applies the entire template result',
    readEditProjectStyle(project.settings).aspectRatio === '9:16' &&
    byType('SUBTITLE').every((item) => item.properties.captionStyleId === 'PODCAST'));

  section('18. Re-apply after manual edits');
  await run('move-element', { elementId: byType('IMAGE')[0].id, x: 0.51, y: 0.52 });
  await run('set-audio-volume', { elementId: byType('AUDIO')[0].id, volume: 0.66 });
  const secondPreview = await templates.preview(id, { templateId: 'PODCAST_PRO',
    revision: project.revision });
  ok('the preview says the moved logo will be preserved',
    secondPreview.preserved.some((item) => /logo placement/iu.test(item.label)));
  ok('the preview says the re-levelled music will be preserved',
    secondPreview.preserved.some((item) => /music levels/iu.test(item.label)));
  const second = await templates.apply(id, { templateId: 'PODCAST_PRO',
    revision: project.revision });
  project = second.project;
  ok('re-applying really did leave the moved logo alone',
    Math.abs(byType('IMAGE')[0].properties.x - 0.51) < 1e-9);
  ok('re-applying really did leave the music level alone',
    Math.abs(byType('AUDIO')[0].properties.volume - 0.66) < 1e-9);
  ok('...and still re-applied the caption styling it owns',
    byType('SUBTITLE').every((item) => item.properties.captionStyleId === 'PODCAST'));

  section('19. A second template replaces the first cleanly');
  const third = await templates.apply(id, { templateId: 'GAMING_CLIP',
    revision: project.revision });
  project = third.project;
  ok('the new template owns the project style',
    readEditProjectStyle(project.settings).zoomPolicy === 'STRONG');
  ok('the new template restyled the captions it inherited',
    byType('SUBTITLE').every((item) => item.properties.captionStyleId === 'SOCIAL'));
  ok('caption wording is STILL intact after a second template',
    byType('SUBTITLE').find((item) => item.id === correctedId).properties.content ===
      'Manually corrected wording');
  ok('the user text is STILL intact after a second template',
    byType('TEXT').find((item) => item.id === manualTextId).properties.content ===
      'My own headline');

  section('20. The renderer sees the template');
  const plan = buildRenderPlan({
    project: { id, revision: project.revision, settings: project.settings },
    assets: [
      { id: 'asset-source', role: 'SOURCE', mimeType: 'video/mp4', duration: 12.5, width: 1920,
        height: 1080, fps: 30, metadata: { hasAudio: true }, transcript: source.transcript,
        analysis: null },
      { id: 'asset-logo', role: 'LOGO', mimeType: 'image/png', duration: null, width: 400,
        height: 200, fps: null, metadata: {}, transcript: null, analysis: null },
      { id: 'asset-music', role: 'AUDIO', mimeType: 'audio/wav', duration: 30, width: null,
        height: null, fps: null, metadata: {}, transcript: null, analysis: null }
    ],
    elements: project.elements, hasSourceAudio: true, fps: 30 }).plan;
  ok('the export canvas follows the template aspect ratio',
    plan.canvas.width === 1080 && plan.canvas.height === 1920);
  ok('the template-styled captions reach the render plan',
    plan.subtitles.length === byType('SUBTITLE').length);
  // Gaming Clip draws captions upper-case, which is a STYLE, not a rewrite: the
  // stored wording is untouched and turning the style off restores it exactly.
  ok('the manually corrected caption reaches the renderer with its own words',
    plan.subtitles.some((subtitle) =>
      subtitle.content.toLowerCase().includes('manually corrected wording')));
  ok('...drawn upper-case because the template says so, while storage is unchanged',
    plan.subtitles.some((subtitle) => subtitle.content === 'MANUALLY CORRECTED WORDING') &&
    byType('SUBTITLE').find((item) => item.id === correctedId).properties.content ===
      'Manually corrected wording');
  ok('the template grade reaches the renderer as resolved, concrete values',
    plan.videoSegments.length > 0 && plan.videoSegments.every((segment) =>
      segment.color && Number.isFinite(segment.color.contrast)) &&
    plan.videoSegments.some((segment) => segment.color.contrast !== 0));
  ok('the template-placed logo reaches the renderer inside the frame',
    plan.visualOverlays.length === 1 && plan.visualOverlays[0].x >= 0 &&
    plan.visualOverlays[0].x + plan.visualOverlays[0].width <= plan.canvas.width);

  section('21. Frozen-pipeline isolation');
  ok('applying templates created no ProcessingJob, ClipCandidate or GeneratedClip',
    state.rows.processingJobs.size === 1 && state.rows.clipCandidates.size === 1 &&
    state.rows.generatedClips.size === 1);

  return { state, templates, project, service, id };
}

// --- 22. User template CRUD + portability ------------------------------------

async function crudSuite(seeded) {
  section('22. User template CRUD');
  const { state, templates, service } = seeded;
  let project = seeded.project;
  const id = seeded.id;

  const listBefore = await templates.list();
  ok('the library lists all twelve built-ins and no user templates yet',
    listBefore.builtin.length === 12 && listBefore.user.length === 0);
  ok('the library states its scope and limits honestly',
    listBefore.scope === 'LOCAL' && /no user accounts/iu.test(listBefore.scopeNote) &&
    listBefore.limits.maxUserTemplates === MAX_USER_TEMPLATES);

  const saved = await templates.createFromProject({ editProjectId: id, name: 'My Gaming Shorts',
    description: 'How I cut my clips' });
  ok('saving captures the project style as a USER template',
    saved.source === 'USER' && saved.name === 'My Gaming Shorts' &&
    saved.project.aspectRatio === '9:16' && saved.zoom === 'STRONG');
  ok('the saved template captured the live caption style',
    saved.captions.styleId === 'SOCIAL');
  ok('the saved template captured the live music level',
    Math.abs(saved.audio.musicVolume - 0.66) < 1e-9);

  section('23. A saved template is PORTABLE');
  const payload = templatePayload(saved);
  const text = JSON.stringify(payload);
  ok('no source video id leaks into the template', !text.includes('asset-source'));
  ok('no caption wording leaks into the template', !text.includes('Manually corrected'));
  ok('no hook or text wording leaks into the template', !text.includes('My own headline'));
  ok('no logo or music asset id leaks in by default',
    saved.assets.logoAssetId === null && saved.assets.musicAssetId === null &&
    !text.includes('asset-logo') && !text.includes('asset-music'));
  ok('no element ids leak into the template', !/element-\d/u.test(text));

  const bound = await templates.createFromProject({ editProjectId: id, name: 'Bound style',
    includeLogo: true, includeMusic: true });
  ok('opt-in binding DOES record the two asset ids, and only then',
    bound.assets.logoAssetId === 'asset-logo' && bound.assets.musicAssetId === 'asset-music');

  section('24. Rename, duplicate, delete');
  const renamed = await templates.update(saved.id, { name: 'My Finance Reel' });
  ok('rename changes the name and keeps the style',
    renamed.name === 'My Finance Reel' && renamed.captions.styleId === saved.captions.styleId);
  const duplicated = await templates.duplicate(saved.id, {});
  ok('duplicate creates a second template with a distinct id and an auto name',
    duplicated.id !== saved.id && duplicated.name === 'My Finance Reel copy' &&
    JSON.stringify(templatePayload(duplicated)) === JSON.stringify(templatePayload(renamed)));
  const fromBuiltin = await templates.duplicate('CINEMATIC', { name: 'My Cinematic' });
  ok('a BUILT-IN can be duplicated into an editable user template',
    fromBuiltin.source === 'USER' && fromBuiltin.color.filterId === 'CINEMATIC');

  let refused = false;
  await templates.update('CINEMATIC', { name: 'Nope' })
    .catch((error) => { refused = /BUILTIN_TEMPLATE/u.test(JSON.stringify(error.getResponse())); });
  ok('a built-in cannot be renamed', refused);
  refused = false;
  await templates.remove('CINEMATIC')
    .catch((error) => { refused = /BUILTIN_TEMPLATE/u.test(JSON.stringify(error.getResponse())); });
  ok('a built-in cannot be deleted', refused);

  refused = false;
  await templates.create({ ...templatePayload(renamed), name: 'My Finance Reel' })
    .catch((error) => {
      refused = /DUPLICATE_TEMPLATE_NAME/u.test(JSON.stringify(error.getResponse())); });
  ok('two user templates cannot share a name', refused);

  refused = false;
  await templates.create({ name: 'Bad', captions: { styleId: 'NOT_REAL' } })
    .catch((error) => {
      refused = /INVALID_TEMPLATE_FIELD/u.test(JSON.stringify(error.getResponse())); });
  ok('an invalid template is refused at save time', refused);

  const deleted = await templates.remove(duplicated.id);
  ok('delete removes exactly that template', deleted.deleted === true &&
    (await templates.list()).user.every((item) => item.id !== duplicated.id));

  section('25. Cross-project application');
  // A SECOND project, with different assets and different content.
  const other = await seedProject('-b');
  const otherTemplates = new EditTemplateService(other.prisma, other.service);
  // The template row lives in the first harness, so it is copied across exactly
  // as a shared workspace library would serve it.
  const row = [...state.rows.editTemplates.values()].find((item) => item.id === renamed.id);
  other.rows.editTemplates.set(row.id, { ...row });
  let otherProject = other.analyzed;
  otherProject = await other.service.phase3Command(other.project.id, 'add-audio',
    { revision: otherProject.revision, assetId: 'asset-music-b' });
  const beforeCross = JSON.stringify(otherProject.elements);
  const crossPreview = await otherTemplates.preview(other.project.id,
    { templateId: renamed.id, revision: otherProject.revision });
  ok('a user template previews against a DIFFERENT project',
    crossPreview.templateName === 'My Finance Reel' && crossPreview.changes.length > 0);
  otherProject = (await otherTemplates.apply(other.project.id,
    { templateId: renamed.id, revision: otherProject.revision })).project;
  ok('the style transferred to the other project',
    readEditProjectStyle(otherProject.settings).zoomPolicy === 'STRONG' &&
    readEditProjectStyle(otherProject.settings).aspectRatio === '9:16');
  ok('no element in the other project points at the first project\'s assets',
    otherProject.elements.every((item) => !item.assetId ||
      other.rows.editAssets.has(item.assetId)));
  ok('the other project\'s own timeline is otherwise intact',
    otherProject.elements.length === JSON.parse(beforeCross).length);

  section('26. A bound template degrades gracefully in a project without the asset');
  const boundRow = [...state.rows.editTemplates.values()].find((item) => item.id === bound.id);
  other.rows.editTemplates.set(boundRow.id, { ...boundRow });
  const degraded = await otherTemplates.preview(other.project.id,
    { templateId: bound.id, revision: otherProject.revision });
  ok('the missing bound asset is reported...',
    degraded.warnings.some((warning) => /not in this project/iu.test(warning)));
  const degradedApply = await otherTemplates.apply(other.project.id,
    { templateId: bound.id, revision: otherProject.revision });
  ok('...and the rest of the template still applies',
    degradedApply.project.revision === otherProject.revision + 1 &&
    degradedApply.plan.changes.length >= 0);
  ok('no element was pointed at an asset that does not exist here',
    degradedApply.project.elements.every((item) => !item.assetId ||
      other.rows.editAssets.has(item.assetId)));

  section('27. Limits');
  ok('the documented limits are real numbers, not vague',
    MAX_USER_TEMPLATES === 100 && MAX_TEMPLATE_NAME_LENGTH === 60);

  ok('templates created no frozen-pipeline rows in either project',
    state.rows.processingJobs.size === 1 && other.rows.processingJobs.size === 1 &&
    state.rows.clipCandidates.size === 1 && other.rows.clipCandidates.size === 1);
  void service; void project;
}

async function main() {
  schemaSuite();
  builtinSuite();
  plannerSuite();
  const seeded = await commandSuite();
  await crudSuite(seeded);
  section('Summary');
  console.log(`  EditMode templates: ${checks} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
