/**
 * Unified clip creation (Steps 9, 10, 14, 15): look + component styles + brief +
 * reference + count, the live style preview, and the Preview / Edit / Ask AI /
 * Export result cards. The pure rules (clip-creation-state.ts and the preview
 * model in creative-generation.ts) are loaded from the shipped modules; the
 * markup contract is asserted against source, like the other UI tests.
 * Offline and deterministic.
 */
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const root = join(__dirname, '..');
require.extensions['.ts'] = (mod, filename) => {
  const js = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React }
  }).outputText;
  mod._compile(js, filename);
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    const base = join(root, 'src', request.slice(2));
    for (const candidate of [`${base}.ts`, `${base}.tsx`]) if (existsSync(candidate)) return candidate;
  }
  return resolve.call(this, request, ...rest);
};

const read = (relative) => readFileSync(join(root, relative), 'utf8');
const state = require(join(root, 'src/lib/clip-creation-state.ts'));
const creative = require(join(root, 'src/lib/creative-generation.ts'));
const panel = read('src/components/clip-creation-panel.tsx');
const setup = read('src/components/generation/generation-setup.tsx');
const preview = read('src/components/generation/style-preview.tsx');
const editorPage = read('src/components/edit-mode/edit-mode-project-route.tsx');
const rightPanel = read('src/components/edit-mode/shell/edit-right-panel.tsx');
const api = read('src/lib/api.ts');

let checks = 0;
const ok = (condition, label) => { assert(condition, label); checks += 1; };

// --- A. Enablement (unchanged rules) --------------------------------------------
const base = { analysisReady: true, outputStyle: 'NORMAL', requestedClipCount: 5,
  maxClipCount: 8, submitting: false, rendering: false };
const can = (overrides) => state.canCreateClips({ ...base, ...overrides });
ok(state.DEFAULT_OUTPUT_STYLE === 'AI_EDITED' && state.restoreOutputStyle(null) === 'AI_EDITED',
  'no previous request defaults to a usable look');
ok(can({ outputStyle: 'AI_EDITED' }) && can({ outputStyle: 'NORMAL' }), 'both base looks can submit');
ok(!can({ outputStyle: null }), 'no look means no submit');
ok(can({ requestedClipCount: 8 }) && can({ requestedClipCount: 1 }), 'the 1..max range is inclusive');
ok(!can({ requestedClipCount: 9 }) && !can({ requestedClipCount: 0 }), 'out-of-range counts are refused');
ok(!can({ maxClipCount: 0, requestedClipCount: 1 }), 'a video with no clip room cannot submit');
ok(!can({ submitting: true }) && !can({ rendering: true }) && !can({ analysisReady: false }),
  'submitting, rendering and unfinished analysis block submit');
ok(state.restoreClipCount({ maxClipCount: 8, defaultClipCount: 4, clipRequest: null }) === 4 &&
  state.restoreClipCount({ maxClipCount: 8, defaultClipCount: 4, clipRequest: { requestedClipCount: 5 } }) === 5 &&
  state.restoreClipCount({ maxClipCount: 6, defaultClipCount: 3, clipRequest: { requestedClipCount: 20 } }) === 6,
  'counts restore from the previous request and clamp');
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
for (const forbidden of ['recommendedClipCount', 'recommendedCount', 'PRIMARY', 'SECONDARY', 'processingType']) {
  ok(!stripComments(read('src/lib/clip-creation-state.ts')).includes(forbidden) &&
    !stripComments(panel).includes(forbidden), `enablement must not depend on ${forbidden}`);
}

// --- B. One look: automatic edit, clean cuts, or a full template ---------------
// 918fe9e renamed the public looks: StyleZero (AUTOMATIC_1), StyleOne (AUTOMATIC_2), No Edit (RAW).
ok(setup.includes("value: 'AUTOMATIC_1', title: 'StyleZero'") &&
  setup.includes("filter((template) => template.id === 'AUTOMATIC_2')") && setup.includes("title: 'StyleOne'") &&
  setup.includes('{ value: RAW_LOOK.value as string, title: RAW_LOOK.title'),
  'the public template picker allowlists exactly StyleZero, StyleOne and No Edit');
ok(state.restoreLook(null) === 'AUTOMATIC_1', 'no previous request -> Automatic 1');
ok(state.restoreLook({ outputStyle: 'AI_EDITED' }) === 'AUTOMATIC_1', 'a legacy base look is canonicalized');
ok(state.restoreLook({ outputStyle: 'AI_EDITED', generation: { templateId: 'AUTOMATIC_2' } }) === 'AUTOMATIC_2',
  'Automatic 2 persists across reload');
ok(state.requestOutputStyle(null, null) === null, 'no look -> nothing to send');
ok(state.requestOutputStyle('AI_EDITED', false) === 'AI_EDITED' && state.requestOutputStyle('NORMAL', false) === 'NORMAL',
  'unstyled base looks are sent as chosen');
ok(state.requestOutputStyle('AUTOMATIC_2', null) === 'AI_EDITED' && state.requestOutputStyle('AUTOMATIC_1', true) === 'AI_EDITED',
  'both public templates use the same automatic edit pipeline');

// B2. The SELECTED look survives reload even when the request rendered a clean cut to apply
// style canonically (the bug: Automatic edit + style words reloaded as "Clean cuts").
const roundTrip = (look, extra) => {
  const sent = creative.generationPayload({ templateId: state.isOutputStyle(look) ? null : look,
    components: {}, brief: '', referenceId: null, look, ...extra });
  const outputStyle = state.requestOutputStyle(look, !!sent);
  return { outputStyle, restored: state.restoreLook({ outputStyle, generation: sent }), sent };
};
const autoStyled = roundTrip('AUTOMATIC_1', { brief: 'funny moments, warm colour' });
ok(autoStyled.outputStyle === 'AI_EDITED' && autoStyled.restored === 'AUTOMATIC_1' &&
  autoStyled.sent.templateId === 'AUTOMATIC_1',
  'Automatic 1 + style words keeps the automatic editor and reloads as Automatic 1');
const autoComponent = roundTrip('AUTOMATIC_1', { components: { CAPTIONS: 'CAP_KARAOKE' } });
ok(autoComponent.restored === 'AUTOMATIC_1' && autoComponent.sent.components.CAPTIONS === 'CAP_KARAOKE',
  'Automatic edit + a component override reloads as Automatic edit with the override');
ok(roundTrip('AUTOMATIC_2', { components: { COLOR: 'COLOR_WARM' } }).restored === 'AUTOMATIC_2',
  'Automatic 2 reloads as Automatic 2');
ok(state.restoreLook({ outputStyle: 'AI_EDITED', generation: null }) === 'AUTOMATIC_1',
  'a plain Automatic edit request (no generation block) still restores');
ok(creative.generationPayload({ templateId: null, components: {}, brief: '', referenceId: null, look: 'AUTOMATIC_1' })
  ?.templateId === 'AUTOMATIC_1', 'Automatic 1 is persisted explicitly even without overrides');

// --- C. Payload: all optional ----------------------------------------------------
ok(creative.generationPayload({ templateId: null, components: {}, brief: '  ', referenceId: null }) === null,
  'upload + count only sends no generation block (existing automatic flow)');
const payload = creative.generationPayload({ templateId: 'PODCAST_PRO',
  components: { CAPTIONS: 'CAP_YELLOW_ACTIVE', COLOR: '', ZOOM: undefined }, brief: ' funny moments ', referenceId: 'r1' });
ok(payload.templateId === 'PODCAST_PRO' && payload.brief === 'funny moments' && payload.referenceId === 'r1' &&
  JSON.stringify(payload.components) === '{"CAPTIONS":"CAP_YELLOW_ACTIVE"}' && payload.look === 'PODCAST_PRO', 'empty component picks are dropped; the template is the persisted look');
ok(creative.generationPayload({ templateId: null, components: {}, brief: 'only AI and jobs', referenceId: null })
  ?.brief === 'only AI and jobs', 'a brief alone is sent (it drives clip selection)');

// --- D. Live preview model ------------------------------------------------------
const component = (category, styleId, spec, extra = {}) => ({ category, source: 'TEMPLATE', styleId,
  name: styleId, spec, supported: true, overridden: [], ...extra });
const resolved = (over = {}) => ({ templateId: 'X', styled: true, notes: [], components: {
  HOOK: component('HOOK', 'HOOK_PODCAST', { textStyle: 'HOOK', fontSize: 50, writing: 'QUESTION', position: 'TOP', plate: '#0B0F1A' }),
  CAPTIONS: component('CAPTIONS', 'CAP_YELLOW_ACTIVE', { preset: 'BOLD_HIGHLIGHT', color: '#FFFFFF', activeWord: true, activeWordColor: '#FFD400' }),
  TEXT: component('TEXT', null, null), COLOR: component('COLOR', 'COLOR_WARM', { filterId: 'WARM', strength: 0.7 }),
  ZOOM: component('ZOOM', 'ZOOM_SUBTLE', { maxCount: 2, scale: 1.05, minSpacingSec: 5 }),
  FRAMING: component('FRAMING', 'FRAME_AUTO', { reframePolicy: 'AUTO' }),
  AUDIO: component('AUDIO', 'AUDIO_PODCAST_BALANCE', { musicVolume: 0.15, ducking: 'MEDIUM' }),
  BACKGROUND: component('BACKGROUND', 'BG_FULL_FRAME', { layout: 'FILL' }),
  OVERLAY: component('OVERLAY', 'LOGO_TOP_RIGHT', { logoPosition: 'TOP_RIGHT' }), ...over } });
const model = creative.stylePreviewModel(resolved());
ok(model.hook && model.hook.box.y === 0.08 && model.hook.style.fontSize === 50 && model.hook.style.background.color === '#0B0F1A',
  'hook: size, plate and TOP position come from the resolved spec');
ok(model.captions && model.captions.activeWordColor === '#FFD400' && model.captions.style.color === '#FFFFFF',
  'captions: yellow active word over white');
ok(/sepia|hue-rotate/u.test(model.videoStyle.filter ?? ''), 'colour: warm is drawn with the editor colour mapping');
ok(model.layout === 'FILL' && model.zoomScale === 1.05 && model.logoCorner === 'TOP_RIGHT', 'layout, zoom hint, logo corner');
ok(model.badges.some((badge) => /Music 15%/u.test(badge)), 'audio is summarised, not faked visually');
const fit = creative.stylePreviewModel(resolved({ BACKGROUND: component('BACKGROUND', 'BG_BLACK', { layout: 'FIT', fitBackground: 'BLACK', hookY: 0.05 }),
  CAPTIONS: component('CAPTIONS', 'CAP_NONE', { preset: 'CLEAN', hidden: true }),
  HOOK: component('HOOK', 'HOOK_NONE', { textStyle: 'HOOK', writing: 'KEEP', none: true }) }));
ok(fit.layout === 'FIT' && fit.fitBackground === 'BLACK' && !fit.captions && !fit.hook,
  'fit-on-black, no captions, no hook');
const split = creative.stylePreviewModel(resolved({ BACKGROUND: component('BACKGROUND', 'BG_SPLIT',
  { layout: 'FIT', fitBackground: 'BLACK' }, { supported: false, note: 'needs multi-view compositing' }) }));
ok(split.unsupported.some((line) => /multi-view/u.test(line)), 'unsupported styles are listed honestly');
const plain = creative.stylePreviewModel(null);
ok(!plain.hook && plain.captions && !plain.videoStyle.filter, 'no resolution -> the plain source frame');

// --- E. Markup contract -----------------------------------------------------------
ok(setup.includes("type='radio'") && setup.includes("className='sr-only'") && setup.includes('<label key={option.value}') &&
  setup.includes('name={`look-${videoId}`}') && setup.includes('checked={selected}') && !setup.includes("role='radio'"),
  'looks are native radios wrapped by full-card labels');
ok(setup.includes('focus-within:ring-2') && setup.includes('cursor-pointer'), 'cards show focus and a pointer');
ok(setup.includes("<fieldset className='grid gap-3' disabled={disabled}>") && panel.includes('disabled={submitting} />'),
  'only a live submit freezes the choices; a queued render never traps the user');
ok(setup.includes("value: 'AUTOMATIC_1'") && !setup.includes("title: 'Clean cuts'") && !setup.includes("value: 'NORMAL'"),
  'the generation chooser exposes StyleZero plus the server template, never the old Clean cuts look');
ok(!/Normal Clips|AI Edited Clips|Output style/u.test(panel + setup), 'the Normal/AI product fork is gone');
ok(setup.includes('data-component={category}') && setup.includes("<option value=''>From the look</option>") &&
  setup.includes("label='My styles'"), 'every component can be overridden, including with a saved style');
ok(setup.includes("data-testid='creative-brief'") && setup.includes('uploadReference(file, videoId)') &&
  setup.includes('referenceFromUrl('), 'brief and reference (file or URL) are optional inputs');
ok(preview.includes('Live preview on your uploaded video'), 'the preview identifies the uploaded source');
ok(/createClips\(video\.id, \{ requestedClipCount: count, outputStyle, generation: payload,\s*regenerate: analysis\.clipRequest\?\.status === 'COMPLETED' \}\)/u.test(panel),
  'the request carries the optional generation block, and pressing Create again regenerates');
ok(panel.includes(': restoreClipCount(loaded));') && panel.includes('restoreLook(loaded.clipRequest)') &&
  panel.includes('const pending = !loaded.clipRequest && autoRequest ? autoRequest : null;'),
  'look and count restore from the previous request (or the auto-started one before it exists)');
ok(panel.includes('disabled={!canCreate}') && panel.includes('canCreateClips({ analysisReady:'),
  'the button is driven by the shared rule');
ok((panel.match(/useState<GenerationChoices>/gu) ?? []).length === 1, 'one authoritative choice state');
// Found in the browser: the SSR render used SERVER_API_URL (http://backend:4000) for the source
// <video>; hydration does not patch attributes, so the preview was black and unplayable.
ok(!/getApiBaseUrl\(\)/u.test(read('src/lib/creative-generation.ts')) && !/getApiBaseUrl\(\)/u.test(panel) &&
  read('src/lib/creative-generation.ts').includes('getPublicApiBaseUrl()'),
  'DOM media URLs (source, poster, clip, export) use the public API base on both renders');
// 918fe9e folded the separate source player into the style preview, which plays the
// uploaded source (with its poster) under the chosen look.
ok(setup.includes('<StylePreview posterUrl={sourcePosterUrl(videoId)} sourceUrl={sourceFileUrl(videoId)}') &&
  preview.includes('poster={posterUrl}') && preview.includes('src={sourceUrl}'),
  'the uploaded source is previewable from the setup, with its poster');

// --- F. Result cards: Preview / Edit / Ask AI / Export ----------------------------
ok(panel.includes("{opening === 'EDIT' ? 'Opening…' : 'Edit'}") && panel.includes('Ask AI') && panel.includes('Export</a>'),
  'every clip exposes Edit, Ask AI and Export');
ok(panel.includes('clip.editUrl ?? (await materializeGeneratedClipForEditing(clip.id)).editUrl'),
  'an already-linked clip opens its project; an unlinked one materializes through the shared API');
ok(panel.includes("target === 'AI' ? `${editUrl}${editUrl.includes('?') ? '&' : '?'}panel=ai`"),
  'Ask AI opens the SAME project with the AI editor showing');
ok(editorPage.includes("initialRightTab={panel === 'ai' ? 'AI' : 'INSPECTOR'}") && editorPage.includes("useSearchParams().get('panel')") &&
  rightPanel.includes('useState<RightTab>(initialTab)'), 'the editor honours panel=ai');
ok(panel.includes('STYLE_READY_STATUSES.has(clip.style?.status') &&
  panel.includes('clip.style.playbackUrl'),
  'a styled clip previews and exports its styled render');
ok(panel.includes("clip.templateId === 'AUTOMATIC_2'") &&
  panel.includes('STYLE_READY_STATUSES.has(status)'),
  'Automatic 2 keeps polling while a base clip is waiting for its style state');
ok(api.includes('style?: ClipStyleState | null;') && api.includes('generation?: GenerationRequest | null'),
  'API types carry style state and the generation request');
ok(api.includes("export type OutputStyle = 'NORMAL' | 'AI_EDITED';") &&
  api.includes("'/videos/' + encodeURIComponent(videoId) + '/clip-selection'"), 'backend contract unchanged');
// Step 19 parity: a fitted frame previews on the backdrop the renderer draws
// (settings.fitBackground), not always black; BLUR is labelled, not faked.
const editPreview = read('src/components/edit-mode/edit-preview.tsx');
ok(editPreview.includes("fitBackground === 'WHITE' ? '#ffffff'") && editPreview.includes('Blurred backdrop appears in export') &&
  read('src/components/edit-mode/edit-mode-workspace.tsx').includes('fitBackground={'),
  'the editor preview draws the export fit background (white/black exact, blur labelled)');
const prisma = readFileSync(join(root, '../backend/prisma/schema.prisma'), 'utf8');
ok(/enum OutputStyle \{\s*NORMAL\s*AI_EDITED\s*\}/u.test(prisma.slice(prisma.indexOf('enum OutputStyle'))),
  'backend OutputStyle enum is still NORMAL | AI_EDITED');

console.log(`Unified clip creation UI tests passed (${checks} checks).`);
