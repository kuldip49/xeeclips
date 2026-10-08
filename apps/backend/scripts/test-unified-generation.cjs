// Steps 9-17: unified generation - style library + precedence resolver, brief
// interpretation, INTENT-AWARE selection through the real ClipSelectionService,
// canonical style compilation applied to a real EditProject, render-side
// fitBackground, reference-derived styles, semantic boundaries and saved styles.
// Offline / in-memory.
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
process.env.CLIP_SELECTION_SYNC = 'true';
require('reflect-metadata');
const assert = require('node:assert/strict');
const lib = require('../dist/modules/edit-mode/styles/creative-style-library.js');
const { resolveCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-resolver.js');
const { resolveVisualLayout } = require('../dist/modules/edit-mode/styles/resolved-visual-layout.js');
const { interpretBriefDeterministic } = require('../dist/modules/edit-mode/styles/creative-brief.js');
const { rankByIntent } = require('../dist/modules/edit-mode/styles/creative-intent.js');
const { compileCreativeStyle, chooseHook, semanticHookRuns } = require('../dist/modules/edit-mode/styles/creative-style-commands.js');
const { deriveReferenceStyle } = require('../dist/modules/edit-mode/styles/reference-analysis.service.js');
const { resolveSemanticBoundary, boundaryRequest } = require('../dist/modules/edit-mode/agent/edit-agent-boundary.js');
const { ClipSelectionService, parseClipCreationRequest } = require('../dist/modules/videos/clip-selection.service.js');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan.js');
const { buildFfmpegArgs } = require('../dist/modules/edit-mode/render/edit-mode-filtergraph.js');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { EditAgentService } = require('../dist/modules/edit-mode/agent/edit-agent.service.js');
const { EditReviewService } = require('../dist/modules/edit-mode/review/edit-review.service.js');
const { EditReviewStore } = require('../dist/modules/edit-mode/review/edit-review-store.js');
const { SavedStylesService } = require('../dist/modules/edit-mode/styles/saved-styles.service.js');

let checks = 0;
const ok = (label, condition = true) => { assert.ok(condition, label); checks += 1;
  console.log(`  ok  ${label}`); };
const els = (p, type) => p.elements.filter((e) => e.type === type);

function catalogTests() {
  console.log('-- Step 10 catalogue');
  ok('legacy templates remain available internally and automatic styles are added', lib.FULL_TEMPLATES.length === 22 &&
    lib.fullTemplate('PODCAST_PRO') && lib.fullTemplate('AUTOMATIC_2'));
  ok('new-generation catalogue exposes StyleOne and StyleTwo',
    JSON.stringify(lib.creativeCatalog().templates.map((item) => item.id).sort()) === '["AUTOMATIC_2","AUTOMATIC_3_STYLE_TWO"]');
  const automatic2 = lib.fullTemplate('AUTOMATIC_2');
  // 2026-10-03: no supporting line under the picture (TEXT component removed by request).
  ok('Automatic 2 keeps its style identity and owns only framing/zoom behaviour', automatic2 &&
    JSON.stringify(Object.keys(automatic2.components).sort()) ===
      '["BACKGROUND","CAPTIONS","FRAMING","HOOK","ZOOM"]');
  const counts = Object.fromEntries(lib.STYLE_CATEGORIES.map((c) => [c, lib.componentStylesFor(c).length]));
  ok('component libraries: HOOK>=10 CAPTIONS>=20 COLOR>=20 ZOOM>=12 FRAMING>=10 AUDIO>=8 BACKGROUND>=8',
    counts.HOOK >= 10 && counts.CAPTIONS >= 20 && counts.COLOR >= 20 && counts.ZOOM >= 12 &&
    counts.FRAMING >= 10 && counts.AUDIO >= 8 && counts.BACKGROUND >= 8);
  ok('every template component references a real style of the right category', lib.FULL_TEMPLATES.every((t) =>
    Object.entries(t.components).every(([cat, id]) => lib.componentStyle(id)?.category === cat)));
  ok('unsupported styles are flagged honestly, not faked', lib.componentStyle('BG_SPLIT').supported === false &&
    /multi-view/u.test(lib.componentStyle('BG_SPLIT').note));
}

function resolverTests() {
  console.log('\n-- Step 10.1 precedence');
  const combo = resolveCreativeStyle({ templateId: 'PODCAST_PRO',
    components: { CAPTIONS: 'CAP_YELLOW_ACTIVE', COLOR: 'COLOR_CINEMATIC', ZOOM: 'ZOOM_SUBTLE', BACKGROUND: 'BG_BLACK' } });
  ok('Podcast Pro + Yellow active + Cinematic + Subtle zoom + Black background combine',
    combo.components.CAPTIONS.styleId === 'CAP_YELLOW_ACTIVE' && combo.components.COLOR.styleId === 'COLOR_CINEMATIC' &&
    combo.components.BACKGROUND.styleId === 'BG_BLACK' && combo.components.HOOK.styleId === 'HOOK_PODCAST' &&
    combo.components.FRAMING.source === 'TEMPLATE');
  const all = resolveCreativeStyle({ templateId: 'CINEMATIC',
    reference: { COLOR: { styleId: 'COLOR_VIBRANT' }, ZOOM: { styleId: 'ZOOM_STRONG' } },
    components: { COLOR: 'COLOR_WARM' },
    instruction: { COLOR: { styleId: 'COLOR_BW' } } });
  ok('1 instruction > 2 component > 3 reference > 4 template', all.components.COLOR.styleId === 'COLOR_BW' &&
    all.components.COLOR.source === 'INSTRUCTION' &&
    all.components.COLOR.overridden.map((o) => o.source).join() === 'COMPONENT,REFERENCE,TEMPLATE');
  ok('reference beats template where the user chose nothing', all.components.ZOOM.styleId === 'ZOOM_STRONG' &&
    all.components.ZOOM.source === 'REFERENCE');
  ok('5 defaults: nothing chosen = not styled', resolveCreativeStyle({}).styled === false);
  const refine = resolveCreativeStyle({ components: { CAPTIONS: 'CAP_PODCAST' },
    instruction: { CAPTIONS: { overrides: { color: '#FFD400' } } } });
  ok('an instruction that only refines keeps the chosen base style',
    refine.components.CAPTIONS.spec.preset === 'PODCAST' && refine.components.CAPTIONS.spec.color === '#FFD400' &&
    refine.components.CAPTIONS.source === 'INSTRUCTION');
}

function briefTests() {
  console.log('\n-- Steps 9/11 brief interpretation');
  const funny = interpretBriefDeterministic('find the funniest moments');
  ok('"funny moments" -> FUNNY intent', funny.intent.modes.includes('FUNNY'));
  const only = interpretBriefDeterministic('only the AI and jobs discussion');
  ok('"only AI and jobs" -> strict topics', only.intent.strict && only.intent.topics.includes('ai') &&
    only.intent.topics.some((t) => /job/u.test(t)));
  const context = interpretBriefDeterministic('controversial statements but keep full context');
  ok('"controversial ... keep full context"', context.intent.modes.includes('CONTROVERSIAL') && context.intent.keepFullContext);
  const style = interpretBriefDeterministic('educational moments, yellow captions, no zooms, black background, cinematic look');
  ok('style hints are separated from content intent', style.intent.modes.includes('EDUCATIONAL') &&
    style.styleHints.CAPTIONS.overrides.color === '#FFD400' && style.styleHints.ZOOM.styleId === 'ZOOM_NONE' &&
    style.styleHints.BACKGROUND.styleId === 'BG_BLACK' && style.styleHints.COLOR.styleId === 'COLOR_CINEMATIC');
  ok('"a cool story" does not recolour the clip', !interpretBriefDeterministic('find a cool story').styleHints.COLOR);
  ok('Hinglish "sirf" means only', interpretBriefDeterministic('sirf about crypto').intent.strict);
  // Found on real media: this once became a strict topic "serious explanations",
  // excluded every candidate and delivered zero clips.
  const kind = interpretBriefDeterministic('only the serious explanations, educational, keep full context');
  ok('"only the serious explanations" is a KIND of moment, not a topic filter',
    kind.intent.modes.includes('EDUCATIONAL') && kind.intent.topics.length === 0 && !kind.intent.strict &&
    kind.intent.keepFullContext);
  ok('"just the best funny bits" is a mode, not a topic',
    interpretBriefDeterministic('just the best funny bits').intent.topics.length === 0);
  const mixed = interpretBriefDeterministic('only the most interesting parts about inflation');
  ok('descriptors are dropped but the real topic survives', mixed.intent.strict &&
    JSON.stringify(mixed.intent.topics) === '["inflation"]');

  // Restriction vs topic vs editing style: "only"/"just" restrict, they are never topic tokens.
  const b = (text) => interpretBriefDeterministic(text).intent;
  const aiJobs = b('only AI and job discussion');
  ok('"only AI and job discussion" -> topics AI + job discussion, strict',
    JSON.stringify(aiJobs.topics) === '["ai","job discussion"]' && aiJobs.strict && !aiJobs.strictModes);
  const justFunny = b('just funny moments');
  ok('"just funny moments" -> FUNNY, restricted by kind, no topic',
    justFunny.modes.includes('FUNNY') && !justFunny.topics.length && justFunny.strictModes && !justFunny.strict);
  const please = b('please give me educational clips');
  ok('"please give me educational clips" -> EDUCATIONAL preference, no restriction',
    please.modes.includes('EDUCATIONAL') && !please.topics.length && !please.strict && !please.strictModes);
  const serious = b('only the serious explanations');
  ok('"only the serious explanations" -> EDUCATIONAL, restricted by kind, "only" is not a topic',
    serious.modes.includes('EDUCATIONAL') && !serious.topics.length && serious.strictModes);
  const hiring = b('give me only the part about hiring');
  ok('"give me only the part about hiring" -> strict topic "hiring"',
    JSON.stringify(hiring.topics) === '["hiring"]' && hiring.strict);
  const cleaner = interpretBriefDeterministic('just make it cleaner');
  ok('"just make it cleaner" is editing style, not a content filter',
    !cleaner.intent.topics.length && !cleaner.intent.strict && !cleaner.intent.strictModes && !cleaner.intent.modes.length);
  const production = interpretBriefDeterministic('Make it professional. Background black. Clean normal hook. Simple captions. Don\'t over-edit.');
  ok('production prompt explicitly overrides template styling',
    production.styleHints.BACKGROUND.styleId === 'BG_BLACK' &&
    production.styleHints.HOOK.styleId === 'HOOK_CLEAN' &&
    production.styleHints.CAPTIONS.styleId === 'CAP_CLEAN_LOWER_THIRD' &&
    production.styleHints.ZOOM.styleId === 'ZOOM_NONE' &&
    production.styleHints.FRAMING.styleId === 'FRAME_FACE_PRIORITY');
}

const speech = (tag, extra) => Array.from({ length: 50 }, (_, i) => `${tag}w${i}`).join(' ') + ' ' + extra;
function pool() {
  const base = (id, extra, index, more = {}) => ({ id, rangeKey: `${index * 100}:${index * 100 + 30}`,
    startTime: index * 100, endTime: index * 100 + 30, duration: 30, transcriptText: speech(id, extra),
    contentPotential: 80 - index, rank: index + 1, reject: false, evidence: {}, ...more });
  return [
    base('generic1', 'we talked about the weather and plans for the weekend.', 0),
    base('generic2', 'the office moved to a new building last month.', 1),
    base('funny', 'haha that joke was hilarious, i was laughing so hard, lol he was kidding.', 2),
    base('edu', 'here is how it works: because the model learns, for example it means the key is data.', 3,
      { informationScore: 90 }),
    base('aijobs', 'ai will replace some jobs; artificial intelligence and jobs in the labour market.', 4),
    base('hot', 'everyone thinks this but actually it is a myth and the truth is they are wrong.', 5,
      { controversyScore: 85 })
  ];
}

async function intentTests() {
  console.log('\n-- Step 11 intent-aware selection');
  const candidates = pool();
  const top = (brief) => rankByIntent(candidates, interpretBriefDeterministic(brief).intent).ordered[0]?.id;
  ok('"funny moments" picks the funny moment first', top('find funny moments') === 'funny');
  ok('"educational moments" picks the explanation first', top('educational moments') === 'edu');
  ok('"controversial statements" picks the hot take first', top('controversial statements') === 'hot');
  const strict = rankByIntent(candidates, interpretBriefDeterministic('only AI and jobs').intent);
  ok('"only AI and jobs" keeps only matching moments', strict.ordered.map((c) => c.id).join() === 'aijobs' &&
    strict.excludedCount === candidates.length - 1);
  const kind = rankByIntent(candidates, interpretBriefDeterministic('just funny moments').intent);
  ok('"just funny moments" keeps only moments with funny evidence', kind.ordered.map((c) => c.id).join() === 'funny');
  const noKind = rankByIntent(candidates.filter((c) => c.id !== 'funny'),
    interpretBriefDeterministic('just funny moments').intent);
  ok('a kind restriction nothing shows degrades to ranking, never to zero clips',
    noKind.ordered.length === candidates.length - 1 && noKind.excludedCount === 0);
  const words = rankByIntent([{ ...candidates[0], id: 'said', transcriptText: 'he said it again, certainly' }],
    interpretBriefDeterministic('only AI and job discussion').intent);
  ok('topic "ai" is a whole word: it does not match "said"/"again"', words.ordered.length === 0);
  ok('no brief = the existing quality order is untouched',
    rankByIntent(candidates, interpretBriefDeterministic('').intent).ordered.map((c) => c.id).join() ===
    candidates.map((c) => c.id).join());

  // Through the real ClipSelectionService render loop.
  const deliver = async (brief, count = 2) => {
    const exported = []; let delivered = null;
    const store = fakeStore(candidates);
    const service = new ClipSelectionService(store.prisma, { export: async (_video, item) => {
      exported.push(item.id); return { id: `clip-${item.id}` }; } }, undefined,
    { afterDelivery: async (videoId) => { delivered = videoId; } });
    await service.create('vid', { requestedClipCount: count, outputStyle: 'NORMAL',
      generation: brief === null ? null : { templateId: null, components: {}, brief, referenceId: null } });
    return { exported, job: store.job, delivered };
  };
  // The user's SELECTED look is configuration and persists apart from the resolved plan.
  const { parseClipCreationRequest: parseReq } = require('../dist/modules/videos/clip-selection.service.js');
  const parsedLook = parseReq({ requestedClipCount: 2, outputStyle: 'NORMAL',
    generation: { templateId: null, components: {}, brief: 'warm colour', referenceId: null, look: 'AI_EDITED' } });
  ok('the selected look is parsed into a canonical template id',
    parsedLook.generation.look === 'AUTOMATIC_1' && parsedLook.generation.templateId === 'AUTOMATIC_1');
  const lookService = new ClipSelectionService(fakeStore(candidates).prisma, { export: async () => ({}) });
  const keyAuto = (await lookService.buildGenerationSettings({ ...parsedLook.generation })).key;
  const keyAutomatic2 = (await lookService.buildGenerationSettings({ ...parsedLook.generation,
    templateId: 'AUTOMATIC_2', look: 'AUTOMATIC_2' })).key;
  const storedLook = (await lookService.buildGenerationSettings({ ...parsedLook.generation })).look;
  ok('the canonical template persists in generation settings and a changed template is a new request',
    storedLook === 'AUTOMATIC_1' && keyAuto !== keyAutomatic2);
  const funny = await deliver('find funny moments');
  const edu = await deliver('educational moments');
  const plain = await deliver(null);
  ok('the same source yields materially different selections per brief',
    funny.exported[0] === 'funny' && edu.exported[0] === 'edu' && plain.exported[0] === 'generic1');
  ok('generation settings (brief, intent, resolved style) persist on the job',
    funny.job.generationSettings.brief === 'find funny moments' &&
    funny.job.generationSettings.interpreted.intent.modes.includes('FUNNY'));
  ok('post-delivery styling hook fires', funny.delivered === 'vid');
  const strictRun = await deliver('only AI and jobs', 3);
  ok('strict brief delivers honestly short rather than padding with off-topic clips',
    strictRun.exported.join() === 'aijobs' && /did not match your brief/u.test(strictRun.job.clipRenderError ?? '') &&
    strictRun.job.telemetry.clipSelection.deliveryStopReason !== 'REQUESTED_COUNT_DELIVERED');
  const styled = parseClipCreationRequest({ requestedClipCount: 2, generation: { templateId: 'PODCAST_PRO' } });
  ok('the request parser accepts the generation block', styled.generation.templateId === 'PODCAST_PRO');
}

function fakeStore(candidates) {
  const video = { id: 'vid', duration: 30 * 60, targetPlatform: 'YOUTUBE_SHORTS' };
  const store = { job: { id: 'job', videoId: 'vid', status: 'COMPLETED', aiMode: 'FALLBACK_ONLY',
    telemetry: {}, processingType: 'NORMAL_CLIPS', selectedCandidateIds: [], clipRenderStatus: null,
    clipRequestedAt: null, clipRenderStartedAt: null } };
  store.prisma = {
    video: { findUnique: async () => ({ ...video, processingJobs: [store.job] }),
      findUniqueOrThrow: async (args) => args?.select ? { chunks: [], understanding: null, transcript: null } : video },
    clipCandidate: { findMany: async () => candidates },
    generatedClip: { findMany: async () => [], updateMany: async () => ({ count: 1 }) },
    processingJob: {
      updateMany: async ({ data }) => { store.job = { ...store.job, ...data }; return { count: 1 }; },
      findUnique: async () => store.job, findUniqueOrThrow: async () => store.job,
      findMany: async () => [] },
    $transaction: async (operations) => Promise.all(operations)
  };
  require('./lib-usage-fixture.cjs')(store.prisma);
  return store;
}

async function compileTests() {
  console.log('\n-- Step 10 canonical style compilation');
  const s = await seedRichProject();
  // Production regression: stress the same bundle with 30+ caption elements.
  const originals = [...s.rows.editElements.values()].filter((row) => row.type === 'SUBTITLE');
  for (let index = originals.length; index < 36; index += 1) {
    const source = originals[index % originals.length];
    s.rows.editElements.set(`stress-caption-${index}`, { ...source, id: `stress-caption-${index}`,
      position: index, properties: { ...source.properties, content: `Stress caption ${index}` } });
  }
  const before = await s.refresh();
  const wording = JSON.stringify(els(before, 'SUBTITLE').map((e) => e.properties.content));
  const cuts = JSON.stringify(els(before, 'VIDEO').map((e) => [e.trimStart, e.trimEnd]));
  const { context } = await s.chat.loadContext(s.id, 'style', {});
  const resolved = resolveCreativeStyle({ templateId: 'PODCAST_PRO',
    components: { CAPTIONS: 'CAP_YELLOW_ACTIVE', COLOR: 'COLOR_CINEMATIC', ZOOM: 'ZOOM_SUBTLE', BACKGROUND: 'BG_BLACK' } });
  const compiled = compileCreativeStyle(resolved, context, { hookOptions: [
    { text: 'Why are rates still high?', style: 'question' }, { text: 'Rates stay high.', style: 'strong claim' }],
  hasWordTimings: true });
  ok('compiles to canonical commands only (no FFmpeg, no raw state)', compiled.commands.length > 5 &&
    compiled.commands.every((command) => ['ELEMENT', 'SETTINGS'].includes(command.kind) &&
      /^[A-Z_]+$/u.test(command.action)));
  const historyBefore = [...s.rows.editHistory.values()].filter((row) => row.editProjectId === s.id).length;
  const mutationStarted = performance.now();
  const applied = await s.service.applyAssistantBundle(s.id, before.revision, { proposalId: 'style',
    summary: 'style', userMessage: 'style', commands: compiled.commands, actor: 'TEMPLATE_ACTION', onInvalid: 'CONTINUE' });
  const mutationMs = performance.now() - mutationStarted;
  const after = applied.project;
  ok('the whole style is ONE revision', applied.revision === before.revision + 1);
  ok('30+ caption/style stress completes well below the old 5s timeout',
    els(after, 'SUBTITLE').length >= 30 && mutationMs < 1000);
  ok('the style bundle creates exactly one history row',
    [...s.rows.editHistory.values()].filter((row) => row.editProjectId === s.id).length === historyBefore + 1);
  ok('every intended command reports a terminal result',
    applied.commandResults.length === compiled.commands.length &&
    applied.commandResults.every((result) => ['DONE', 'SKIPPED', 'INVALID', 'BLOCKED_BY_CONSTRAINT'].includes(result.status)));
  ok('captions: yellow active word on every caption', els(after, 'SUBTITLE').every((e) =>
    e.properties.activeWord?.enabled === true && String(e.properties.activeWord.color).toUpperCase() === '#FFD400'));
  ok('colour: cinematic look on every segment', els(after, 'VIDEO').every((e) => e.properties.colorFilterId === 'CINEMATIC'));
  ok('background: black fitted frame', after.settings.fitBackground === 'BLACK' &&
    els(after, 'VIDEO').every((e) => e.properties.frameLayout === 'FIT'));
  ok('framing from the template (face-focused)', after.settings.reframePolicy === 'FACE_FOCUSED');
  ok('caption wording and cuts are never touched by styling',
    JSON.stringify(els(after, 'SUBTITLE').map((e) => e.properties.content)) === wording &&
    JSON.stringify(els(after, 'VIDEO').map((e) => [e.trimStart, e.trimEnd])) === cuts);
  ok('history attributes it to TEMPLATE, not AI', [...s.rows.editHistory.values()].some((row) =>
    row.editProjectId === s.id && row.revision === applied.revision && row.actor === 'TEMPLATE'));
  ok('grounded hook wording is chosen by writing style', chooseHook([{ text: 'A claim.', style: 'strong claim' },
    { text: 'Why?', style: 'question' }], 'QUESTION') === 'Why?');
  const automatic2 = resolveCreativeStyle({ templateId: 'AUTOMATIC_2' });
  const automatic2Compiled = compileCreativeStyle(automatic2, context, { hookOptions: [
    { text: 'Why did OpenAI invest 100 million dollars?', style: 'question' },
    { text: 'The investment changes how small teams compete.', style: 'strong claim' }],
  hasWordTimings: true });
  const structuralActions = ['SET_REFRAME_POLICY', 'SET_VIDEO_FRAMING', 'ADD_ZOOM',
    'ADJUST_ZOOM_STRENGTH', 'APPLY_COLOR_FILTER', 'SET_SOURCE_AUDIO_VOLUME', 'SET_AUDIO_VOLUME'];
  ok('Automatic 2 changes camera/zoom only, never selection/colour/audio',
    automatic2Compiled.commands.some((command) => command.action === 'SET_REFRAME_POLICY') &&
    automatic2Compiled.commands.every((command) => !['APPLY_COLOR_FILTER',
      'SET_SOURCE_AUDIO_VOLUME', 'SET_AUDIO_VOLUME'].includes(command.action)));
  ok('Automatic 2 persists semantic red hook runs and lime timed captions',
    automatic2Compiled.commands.some((command) => command.action === 'SET_TEXT_RUNS' ||
      command.action === 'ADD_TEXT' && Array.isArray(command.payload.textRuns)) &&
    automatic2Compiled.commands.some((command) => command.action === 'SET_CAPTION_ACTIVE_WORD' &&
      command.payload.activeWordColor === '#B7F000'));
  const runs = semanticHookRuns('Why did OpenAI invest 100 million dollars?', '#FFFFFF', '#D52B1E');
  ok('semantic hook runs reconstruct wording exactly and emphasize entities/numbers',
    runs.map((run) => run.text).join('') === 'Why did OpenAI invest 100 million dollars?' &&
    runs.some((run) => run.color === '#D52B1E' && /OpenAI|100/u.test(run.text)));
  const streetLayout = resolveVisualLayout(automatic2, { sourceWidth: 1920, sourceHeight: 1080,
    faceShotRatio: 1, hookText: 'Why did OpenAI invest 100 million dollars?' });
  const { AUTOMATIC_2_STREET3_LAYOUT: STREET3 } = require('../dist/modules/edit-mode/styles/automatic-2-street3-layout.js');
  ok('Automatic 2 uses the measured street3.mp4 geometry', ['x', 'y', 'width', 'height'].every((key) =>
    streetLayout.videoFrame[key] === STREET3.mediaBox[key] && streetLayout.hook[key] === STREET3.hookBox[key] &&
    streetLayout.captions[key] === STREET3.captionSafeBox[key] &&
    streetLayout.supportingText[key] === STREET3.supportingTextBox[key]) &&
    Math.round(streetLayout.videoFrame.y * 1920) === 610 && Math.round(streetLayout.videoFrame.height * 1920) === 700 &&
    streetLayout.hook.maxLines === 2 && streetLayout.background.color === '#000000' &&
    streetLayout.background.type === 'SOLID');
  const outer = (layoutValue) => JSON.stringify({ frame: layoutValue.videoFrame, hook: { x: layoutValue.hook.x,
    y: layoutValue.hook.y, width: layoutValue.hook.width, height: layoutValue.hook.height },
  captions: layoutValue.captions, support: layoutValue.supportingText, background: layoutValue.background });
  const outerVariants = [
    { sourceWidth: 1920, sourceHeight: 1080, faceShotRatio: 1 }, { sourceWidth: 1080, sourceHeight: 1920, faceShotRatio: 0 },
    { sourceWidth: 1280, sourceHeight: 1024, faceShotRatio: .4 }, { sourceWidth: 3840, sourceHeight: 800, faceShotRatio: .9 },
    {}
  ].map((evidence) => outer(resolveVisualLayout(automatic2, { ...evidence, hookText: 'Short hook' })));
  ok('Automatic 2 outer geometry never varies with source aspect, resolution or face count',
    new Set(outerVariants.map((value) => value.replace(/"fontSize":\d+,?/gu, ''))).size === 1);
  const { chooseSupportingLine } = require('../dist/modules/edit-mode/styles/creative-style-commands.js');
  ok('Automatic 2 omits filler supporting lines instead of showing them',
    chooseSupportingLine([{ text: 'The clip examines So you are pushing them to increase rates on.' },
      { text: 'This video is about interest rates and your mortgage payments' },
      { text: 'The speaker says rates will stay high for a long time' },
      { text: 'When we need to talk about it,' }], 'Why are rates high?') === null &&
    chooseSupportingLine([{ text: 'Your mortgage payment keeps climbing while savings finally pay more.' }],
      'Why are rates so high?') === 'Your mortgage payment keeps climbing while savings finally pay more.');
  const exactPrompt = interpretBriefDeterministic('Make it professional. Background black. Clean normal hook. Simple captions. Don\'t over-edit.');
  const exactResolved = resolveCreativeStyle({ templateId: 'PODCAST_PRO', instruction: exactPrompt.styleHints });
  const layout = resolveVisualLayout(exactResolved, { sourceWidth: 1920, sourceHeight: 1080,
    faceShotRatio: 1, hookText: 'This is a deliberately long professional hook that must never become a giant paragraph' });
  ok('Automatic 2 persists its face-safe card profile without affecting other layouts',
    streetLayout.editingProfile === 'AUTOMATIC_2' && streetLayout.faceSafeRegion?.y === 0.1 &&
    !layout.editingProfile);
  ok('professional black layout is balanced and collision-free', layout.videoFrame.mode === 'CARD' &&
    layout.videoFrame.height >= 0.55 && layout.hook.maxLines === 3 && layout.captions.maxLines === 2 &&
    layout.hook.y + layout.hook.height < layout.captions.y && layout.hook.fontSize <= 52);
  const plan = buildRenderPlan({ project: after, assets: after.assets, elements: after.elements, hasSourceAudio: true, fps: 30 });
  const args = buildFfmpegArgs({ plan: plan.plan, sourcePath: 's.mp4', overlayPaths: {}, audioPaths: {},
    assFileName: null, outputPath: 'o.mp4', informationCrop: plan.evidence.informationCrop,
    fitExpression: plan.evidence.fitExpression, informationFitExpression: plan.evidence.informationFitExpression,
    cameraFilter: plan.evidence.cameraFilter });
  const graph = args[args.indexOf('-filter_complex') + 1] ?? '';
  ok('the renderer draws a solid black backdrop behind the fitted frame (not blur)',
    plan.plan.canvas.fitBackground === 'BLACK' && /color=c=[^;]*000000[^;]*\[vlayoutbg\]/u.test(graph) &&
    !/boxblur/u.test(graph));
  ok('renderer consumes the exact persisted card geometry',
    plan.plan.canvas.visualLayout?.videoFrame.mode === 'CARD' && /\[vlayoutbg\]\[vlayoutfg\]overlay=/u.test(graph) &&
    !/\[vfitted\]/u.test(graph) && !/\[vfillsrc\]/u.test(graph) && !/\[vfill\]/u.test(graph));
}

function referenceTests() {
  console.log('\n-- Step 12 reference -> principles -> our styles');
  const derived = deriveReferenceStyle({ durationSec: 60, width: 1080, height: 1920, aspectRatio: '9:16',
    cutCount: 24, cutsPerMinute: 24, averageShotSec: 2.4, brightness: 120, saturation: 60, contrast: 150,
    warmth: 2, letterboxed: false, contentRatio: 1, loudnessLufs: -14, silenceRatio: 0.05,
    wordsPerMinute: 170, faceShare: 0.8, faceSize: 0.12, captionBandY: 0.62, captionFrameShare: 0.9,
    hookTopTextInOpening: true });
  ok('fast cuts -> energetic zoom; captions band -> caption y; hook text -> hook style; faces -> talking head',
    derived.choices.ZOOM.styleId === 'ZOOM_ENERGETIC' && derived.choices.CAPTIONS.overrides.y === 0.62 &&
    derived.choices.HOOK.styleId === 'HOOK_BOLD_QUESTION' && derived.choices.FRAMING.styleId === 'FRAME_TALKING_HEAD' &&
    derived.choices.COLOR.styleId === 'COLOR_VIBRANT');
  ok('what cannot be measured is listed, not guessed', derived.notMeasured.some((item) => /zoom/u.test(item)));
  const unknown = deriveReferenceStyle({ durationSec: 30, width: 1920, height: 1080, aspectRatio: '16:9',
    cutCount: 1, cutsPerMinute: 2, averageShotSec: 15, brightness: null, saturation: null, contrast: null,
    warmth: null, letterboxed: true, contentRatio: 0.6, loudnessLufs: null, silenceRatio: null,
    wordsPerMinute: null, faceShare: null, faceSize: null, captionBandY: null, captionFrameShare: null,
    hookTopTextInOpening: null });
  ok('missing AI-service measurements degrade to "not measured"', !unknown.choices.COLOR &&
    unknown.notMeasured.some((item) => /caption/u.test(item)) && unknown.choices.BACKGROUND.styleId === 'BG_BLACK');
  const resolved = resolveCreativeStyle({ reference: derived.choices, templateId: 'CLEAN_REEL',
    components: { ZOOM: 'ZOOM_NONE' } });
  ok('reference sits between explicit components and the template', resolved.components.ZOOM.styleId === 'ZOOM_NONE' &&
    resolved.components.COLOR.styleId === 'COLOR_VIBRANT' && resolved.components.COLOR.source === 'REFERENCE');
}

async function boundaryTests() {
  console.log('\n-- Step 16 semantic boundaries');
  const words = [['So', 10], ['here', 10.3], ['is', 10.6], ['context.', 10.9], ['This', 12], ['is', 12.3],
    ['the', 12.5], ['real', 12.7], ['problem.', 13], ['Nobody', 14.5], ['talks', 14.9], ['about', 15.2],
    ['it', 15.5], ['though', 15.8], ['and', 16.2], ['that', 16.5], ['matters.', 16.8], ['Next', 18.5], ['point.', 19]]
    .map(([text, start]) => ({ text, start, end: start + 0.28 }));
  const at = (req) => resolveSemanticBoundary({ words, clipStart: 12, clipEnd: 16, sourceDuration: 60, ...req });
  ok('start when he says "this is the real problem"', Math.abs(at({ edge: 'START', anchor: 'PHRASE',
    phrase: 'this is the real problem' }).sec - 11.92) < 0.01);
  ok('include the previous sentence', Math.abs(at({ edge: 'START', anchor: 'PREVIOUS_SENTENCE' }).sec - 9.92) < 0.01);
  ok('ending feels cut off -> end of the sentence', Math.abs(at({ edge: 'END', anchor: 'COMPLETE_SENTENCE' }).sec - 17.23) < 0.01);
  ok('end after the next sentence', Math.abs(at({ edge: 'END', anchor: 'NEXT_SENTENCE' }).sec - 19.43) < 0.01);
  ok('an unknown phrase is an honest question', 'question' in at({ edge: 'START', anchor: 'PHRASE', phrase: 'not said' }));
  ok('phrasing is recognised', boundaryRequest('start when he says "this is the real problem"').anchor === 'PHRASE' &&
    boundaryRequest('the ending feels cut off').anchor === 'COMPLETE_SENTENCE' &&
    boundaryRequest('include the previous sentence').anchor === 'PREVIOUS_SENTENCE');

  // Multi-cut project through the agent: only the outer segment moves; internal cuts are kept.
  const s = await seedRichProject();
  const agent = new EditAgentService(s.harness.prisma, s.service, s.chat, s.templates,
    new EditReviewService(s.harness.prisma, new EditReviewStore(), s.chat),
    { startExport: async () => ({ export: { exportId: 'x' } }) },
    { isAnyConfigured: () => false, generate: async () => { throw new Error('none'); } });
  let project = await s.refresh();
  // Shorten the last segment first so there is room to extend its end.
  const last = els(project, 'VIDEO').sort((a, b) => a.position - b.position).at(-1);
  project = await s.service.trimElement(s.id, { revision: project.revision, elementId: last.id,
    trimStart: last.trimStart, trimEnd: last.trimStart + 0.6 });
  const inner = JSON.stringify(els(project, 'VIDEO').sort((a, b) => a.position - b.position).slice(0, -1)
    .map((e) => [e.trimStart, e.trimEnd]));
  const lastBefore = els(project, 'VIDEO').sort((a, b) => a.position - b.position).at(-1);
  const run = await agent.run(s.id, { message: 'end after the next sentence', revision: project.revision });
  project = await s.refresh();
  const after = els(project, 'VIDEO').sort((a, b) => a.position - b.position);
  ok('multi-cut: "end after the next sentence" extends ONLY the last segment; internal cuts kept',
    run.ledger[0].status === 'DONE' && run.ledger[0].verification === 'VERIFIED' &&
    after.at(-1).trimEnd > lastBefore.trimEnd &&
    JSON.stringify(after.slice(0, -1).map((e) => [e.trimStart, e.trimEnd])) === inner);
  // Found in the browser E2E: on a simple contiguous clip the move runs through the
  // lineage-aware outer range (no bundle results), and the generic verifier reported
  // "not verified" even though the end moved. The tool now verifies the reloaded edge.
  const single = await seedRichProject({ split: false });
  const outerAgent = (adjust) => new EditAgentService(single.harness.prisma,
    new Proxy(single.service, { get: (target, key) => key === 'adjustSourceRange' ? adjust
      : typeof target[key] === 'function' ? target[key].bind(target) : target[key] }),
    single.chat, single.templates, new EditReviewService(single.harness.prisma, new EditReviewStore(), single.chat),
    { startExport: async () => ({ export: { exportId: 'x' } }) },
    { isAnyConfigured: () => false, generate: async () => { throw new Error('none'); } });
  let one = await single.refresh();
  const clip = els(one, 'VIDEO')[0];
  one = await single.service.trimElement(single.id, { revision: one.revision, elementId: clip.id,
    trimStart: clip.trimStart, trimEnd: 12.4 });
  // A no-op "success" must NOT verify: tool success != task success.
  const lying = await outerAgent(async () => single.refresh())
    .run(single.id, { message: 'end after the next sentence', revision: one.revision });
  ok('outer-range move that changed nothing is reported as not verified',
    lying.ledger[0].verification === 'FAILED', lying.ledger[0]);
  one = await single.refresh();
  const moved = await outerAgent(async (id, input) => {
    const current = await single.refresh();
    const video = els(current, 'VIDEO')[0];
    return single.service.trimElement(id, { revision: input.revision, elementId: video.id,
      trimStart: input.start ?? video.trimStart, trimEnd: input.end ?? video.trimEnd });
  }).run(single.id, { message: 'end after the next sentence', revision: one.revision });
  ok('single clip: "end after the next sentence" moves the outer range and VERIFIES it',
    moved.ledger[0].status === 'DONE' && moved.ledger[0].verification === 'VERIFIED' &&
    els(await single.refresh(), 'VIDEO')[0].trimEnd > 12.4, moved.ledger[0]);
  const cutOff = await agent.run(s.id, { message: 'the ending feels cut off', revision: project.revision });
  ok('a clip that already ends on a sentence gets an honest question, not a guess',
    cutOff.ledger[0].status === 'NEEDS_INPUT' && /already ends/u.test(cutOff.ledger[0].detail));
}

async function aiStateTests() {
  console.log('\n-- Step 6/21 production policy: OpenAI by default, honest reasons');
  const { chatPlannerAiMode } = require('../dist/modules/edit-mode/chat/edit-chat-planner.js');
  const { interpretBrief } = require('../dist/modules/edit-mode/styles/creative-brief.js');
  const saved = { chat: process.env.EDIT_MODE_CHAT_AI_MODE, mode: process.env.AI_PROCESSING_MODE };
  delete process.env.EDIT_MODE_CHAT_AI_MODE; delete process.env.AI_PROCESSING_MODE;
  // Found live: with neither variable set the editor silently stayed rules-only with a valid key.
  ok('unset -> the AI editor uses OpenAI (ONLINE)', chatPlannerAiMode() === 'ONLINE');
  process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
  ok('FALLBACK_ONLY still forces rules-only explicitly', chatPlannerAiMode() === 'FALLBACK_ONLY');
  if (saved.chat === undefined) delete process.env.EDIT_MODE_CHAT_AI_MODE; else process.env.EDIT_MODE_CHAT_AI_MODE = saved.chat;
  if (saved.mode !== undefined) process.env.AI_PROCESSING_MODE = saved.mode;
  const noProvider = { isAnyConfigured: () => false, generate: async () => { throw new Error('unreachable'); } };
  const disabled = await interpretBrief({ brief: 'find funny moments', llm: noProvider, aiMode: 'FALLBACK_ONLY' });
  ok('rules-only by choice is reported as DISABLED, not "no OpenAI API key"', disabled.ai.state === 'DISABLED' &&
    disabled.intent.modes.includes('FUNNY'));
  const missing = await interpretBrief({ brief: 'find funny moments', llm: noProvider, aiMode: 'ONLINE' });
  ok('ONLINE with no usable provider is NOT_CONFIGURED', missing.ai.state === 'NOT_CONFIGURED');
}

async function savedStyleTests() {
  console.log('\n-- Step 17 saved styles');
  const s = await seedRichProject();
  const rows = new Map(); let seq = 0;
  s.harness.prisma.savedStyle = {
    findMany: async ({ where }) => [...rows.values()].filter((r) => (!where?.category || r.category === where.category) &&
      (!where?.id?.in || where.id.in.includes(r.id))),
    findUnique: async ({ where }) => rows.get(where.id) ?? null,
    count: async () => rows.size,
    create: async ({ data }) => { const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, ...data,
      createdAt: new Date(), updatedAt: new Date() }; rows.set(row.id, row); return row; },
    delete: async ({ where }) => rows.delete(where.id)
  };
  const saved = new SavedStylesService(s.harness.prisma);
  let project = await s.refresh();
  project = await s.service.phase3Command(s.id, 'set-text-color', { revision: project.revision,
    elementType: 'SUBTITLE', scope: 'TRACK', color: '#22D3EE' });
  const mine = await saved.create({ category: 'CAPTIONS', name: 'My Podcast Captions', fromProjectId: s.id });
  ok('captions captured from the project into a reusable spec with a stable id',
    /^[0-9a-f-]{36}$/u.test(mine.id) && mine.spec.color.toUpperCase() === '#22D3EE');
  await saved.create({ category: 'COLOR', name: 'My Finance Color', styleId: 'COLOR_COOL' });
  project = await s.service.phase3Command(s.id, 'set-text-color', { revision: project.revision,
    elementType: 'SUBTITLE', scope: 'TRACK', color: '#FFFFFF' });
  const agent = new EditAgentService(s.harness.prisma, s.service, s.chat, s.templates,
    new EditReviewService(s.harness.prisma, new EditReviewStore(), s.chat),
    { startExport: async () => ({ export: { exportId: 'x' } }) },
    { isAnyConfigured: () => false, generate: async () => { throw new Error('none'); } }, saved);
  const run = await agent.run(s.id, { message: 'use my usual podcast captions', revision: project.revision });
  project = await s.refresh();
  ok('"use my usual podcast captions" applies that saved style by id',
    run.ledger[0].status === 'DONE' && run.ledger[0].intent.includes(mine.id) &&
    els(project, 'SUBTITLE').every((e) => String(e.properties.color).toUpperCase() === '#22D3EE'));
  const missing = await agent.run(s.id, { message: 'use my usual gaming captions', revision: project.revision });
  ok('an unknown saved style is a question listing what exists', missing.ledger[0].status === 'NEEDS_INPUT' &&
    /My Podcast Captions/u.test(missing.ledger[0].detail));
  const resolved = resolveCreativeStyle({ components: { COLOR: [...rows.values()].find((r) => r.category === 'COLOR').id },
    saved: Object.fromEntries([...rows.values()].map((r) => [r.id, { category: r.category, spec: r.spec, name: r.name }])) });
  ok('generation can select a saved style by id', resolved.components.COLOR.spec.filterId === 'COOL' &&
    resolved.components.COLOR.name === 'My Finance Color');
}

(async () => {
  console.log('Steps 9-17 unified generation\n');
  catalogTests(); resolverTests(); briefTests();
  await intentTests(); await compileTests(); referenceTests(); await boundaryTests(); await aiStateTests(); await savedStyleTests();
  console.log(`\nSteps 9-17 unified generation tests passed (${checks} checks).`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
