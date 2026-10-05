// Step 5 - canonical edit scope, caption provenance, framing, zoom/audio/hook/logo
// targeting, user constraints and bundle semantics. Offline / in-memory: runs
// against the real EditModeService with the shared Prisma harness.
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const assert = require('node:assert/strict');
const { createHarness } = require('./test-edit-mode-isolation.cjs');
const { installBridgeHarness } = require('./test-generated-clip-edit-project.cjs');
const { blockingEditConstraint, readEditCommandScope, readEditConstraints, rangeViolation } =
  require('../dist/modules/edit-mode/edit-command-scope.js');
const { aspectCropInsets, resolveReframePolicy } =
  require('../dist/modules/edit-mode/edit-mode-framing.js');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan.js');

let checks = 0;
const ok = (label, condition = true) => { assert.ok(condition, label); checks += 1;
  console.log(`  ok  ${label}`); };
const rejects = async (label, fn, code) => {
  let caught = null;
  try { await fn(); } catch (error) { caught = error; }
  const actual = caught?.response?.code ?? caught?.message;
  assert.ok(caught && (!code || actual === code), `${label} (got ${actual})`);
  checks += 1; console.log(`  ok  ${label}`);
};
const videos = (p) => p.elements.filter((e) => e.type === 'VIDEO')
  .sort((a, b) => a.position - b.position);
const captions = (p) => p.elements.filter((e) => e.type === 'SUBTITLE');
const zooms = (p) => p.elements.filter((e) => e.type === 'EFFECT');
const byId = (p, id) => p.elements.find((e) => e.id === id);
const run = (h, p, action, payload) => h.service.phase3Command(p.id, action,
  { revision: p.revision, ...payload });
const structure = (p) => JSON.stringify(videos(p).map((e) => ({ id: e.id, trimStart: e.trimStart,
  trimEnd: e.trimEnd, startTime: e.startTime, duration: e.duration, position: e.position,
  speed: e.properties.speed ?? 1 })));
const wording = (p) => JSON.stringify(captions(p).map((e) => ({ id: e.id,
  content: e.properties.content, startTime: e.startTime, duration: e.duration,
  textSource: e.properties.textSource })));
const historyRows = (h, p) => [...h.rows.editHistory.values()]
  .filter((row) => row.editProjectId === p.id);

async function seed() {
  const h = createHarness();
  let p = await h.service.create({ name: 'Step 5 scope (legacy manual project)' });
  p = await h.service.persistSource(p.id, p.revision, {
    id: 'scope-source', originalName: 'source.mp4', bucket: 'test', objectKey: 'source.mp4',
    mimeType: 'video/mp4', sizeBytes: 1000n, duration: 12, width: 1920, height: 1080,
    fps: 30, metadata: { hasVideo: true, hasAudio: true }
  });
  h.rows.editAssets.get('scope-source').transcript = { text: 'Open AI makes scoped edits safe',
    segments: [{ start: 0, end: 11, text: 'Open AI makes scoped edits safe for everyone here', words: [
      ['Open', 0, .7], ['AI', .7, 1.3], ['makes', 1.3, 2.1], ['scoped', 2.1, 3],
      ['edits', 3, 4], ['safe', 4, 5], ['for', 6, 6.6], ['everyone', 6.6, 7.8], ['here', 8.5, 9.5]
    ].map(([text, start, end]) => ({ text, start, end })) }] };
  // Audio + logo assets for targeting tests, attached directly as real EditAssets.
  for (const [assetId, role, extra] of [['music-a', 'AUDIO', { duration: 30 }],
    ['music-b', 'AUDIO', { duration: 30 }], ['logo-a', 'LOGO', { width: 200, height: 200 }]]) {
    h.rows.editAssets.set(assetId, { id: assetId, editProjectId: p.id, role,
      originalName: assetId, bucket: 'test', objectKey: assetId, mimeType: 'x', sizeBytes: 1n,
      duration: null, width: null, height: null, fps: null, metadata: {}, transcript: null,
      analysis: null, createdAt: new Date(), updatedAt: new Date(), ...extra });
  }
  p = await h.service.get(p.id);
  p = await h.service.splitElement(p.id,
    { revision: p.revision, elementId: videos(p)[0].id, playheadSec: 4 });
  p = await h.service.splitElement(p.id,
    { revision: p.revision, elementId: videos(p)[1].id, playheadSec: 8 });
  p = await run(h, p, 'generate-captions', { captionStyleId: 'CLEAN' });
  return { h, p };
}

async function captionTests(h, p) {
  console.log('\n-- captions: provenance, global vs selected, regeneration');
  ok('generated captions are TRANSCRIPT_GENERATED',
    captions(p).length >= 2 && captions(p).every((e) => e.properties.textSource === 'TRANSCRIPT_GENERATED'));
  const first = captions(p)[0];
  ok('first caption carries the transcript wording "Open AI"', /Open AI/u.test(first.properties.content));
  p = await run(h, p, 'set-caption-text', { elementId: first.id,
    content: first.properties.content.replace('Open AI', 'OpenAI') });
  ok('manual correction is MANUAL_EDITED', byId(p, first.id).properties.textSource === 'MANUAL_EDITED' &&
    /OpenAI/u.test(byId(p, first.id).properties.content));
  ok('manual command returns a structured DONE commandResult',
    p.commandResult?.status === 'DONE' && p.commandResult.affectedCount === 1 &&
    p.commandResult.revision === p.revision &&
    p.commandResult.changes.some((c) => c.field === 'properties.content'));

  const words = wording(p);
  const r0 = p.revision;
  p = await run(h, p, 'set-text-size', { elementType: 'SUBTITLE', scope: 'TRACK', fontSize: 42 });
  ok('"make captions smaller" (TRACK) sizes every caption', captions(p).every((e) => e.properties.fontSize === 42));
  ok('global caption style is ONE revision and ONE history row',
    p.revision === r0 + 1 && historyRows(h, p).filter((row) => row.revision === p.revision).length === 1);
  ok('global style preserves wording, timing and provenance ("OpenAI" survives)', wording(p) === words);
  ok('global result reports every caption as affected',
    p.commandResult.affectedCount === captions(p).length && p.commandResult.scope === 'TRACK');

  const second = captions(p)[1];
  p = await run(h, p, 'set-text-size', { elementId: second.id, scope: 'SELECTED_ELEMENT', fontSize: 52 });
  ok('"make this caption bigger" changes only the selected caption',
    byId(p, second.id).properties.fontSize === 52 &&
    captions(p).filter((e) => e.id !== second.id).every((e) => e.properties.fontSize === 42));
  ok('selected override is recorded in styleOverrides',
    JSON.stringify(byId(p, second.id).properties.styleOverrides) === '["fontSize"]');

  p = await run(h, p, 'set-text-color', { elementType: 'SUBTITLE', scope: 'TRACK', color: '#FFEE00' });
  ok('"make all captions yellow" colours every caption',
    captions(p).every((e) => String(e.properties.color).toLowerCase() === '#ffee00'));
  ok('the selected size override survives a later global colour change',
    byId(p, second.id).properties.fontSize === 52);
  ok('global style still preserves the corrected wording', wording(p) === words);

  p = await run(h, p, 'set-text-color', { elementId: first.id, scope: 'SELECTED_ELEMENT', color: '#FFFFFF' });
  ok('selected colour changes one caption only',
    String(byId(p, first.id).properties.color).toLowerCase() === '#ffffff' &&
    captions(p).filter((e) => e.id !== first.id).every((e) => String(e.properties.color).toLowerCase() === '#ffee00'));

  p = await run(h, p, 'set-text-size', { elementType: 'SUBTITLE', scope: 'TRACK', fontSize: 38 });
  ok('a global write of the SAME property wins and clears that override',
    captions(p).every((e) => e.properties.fontSize === 38) &&
    !(byId(p, second.id).properties.styleOverrides ?? []).includes('fontSize'));

  p = await run(h, p, 'move-element', { elementType: 'SUBTITLE', scope: 'TRACK', y: 0.62 });
  ok('caption position (TRACK) moves every caption', captions(p).every((e) => Math.abs(e.properties.y - 0.62) < 1e-9));
  ok('caption position preserves wording', wording(p) === words);

  p = await run(h, p, 'set-caption-active-word', { elementType: 'SUBTITLE', scope: 'TRACK',
    activeWordEnabled: true, activeWordColor: '#FFD400' });
  ok('active-word style applies to the whole track', captions(p).every((e) => e.properties.activeWord?.enabled === true));

  p = await run(h, p, 'set-element-visible', { elementType: 'SUBTITLE', visible: false });
  ok('caption visibility is one track operation', captions(p).every((e) => e.properties.hidden === true));
  const hiddenPlan = buildRenderPlan({ project: { ...p, settings: { ...p.settings, subtitlePolicy: 'AUTO' } },
    assets: p.assets, elements: p.elements, hasSourceAudio: true, fps: 30 }).plan;
  ok('5.18: hidden canonical captions are NOT replaced by a render-only transcript track',
    hiddenPlan.subtitles.length === 0 && !hiddenPlan.subtitles.some((s) => String(s.elementId).startsWith('transcript-')));
  p = await run(h, p, 'set-element-visible', { elementType: 'SUBTITLE', visible: true });
  const visiblePlan = buildRenderPlan({ project: { ...p, settings: { ...p.settings, subtitlePolicy: 'AUTO' } },
    assets: p.assets, elements: p.elements, hasSourceAudio: true, fps: 30 }).plan;
  ok('5.18: the renderer draws the canonical caption wording ("OpenAI")',
    visiblePlan.subtitles.some((s) => /OpenAI/u.test(s.content)) &&
    visiblePlan.subtitles.every((s) => !String(s.elementId).startsWith('transcript-')));

  await rejects('plain GENERATE_CAPTIONS over an edited track is refused',
    () => run(h, p, 'generate-captions', {}), 'CAPTIONS_HAVE_EDITS');
  const beforeRegen = p;
  p = await run(h, p, 'regenerate-captions', {});
  ok('explicit REGENERATE_CAPTIONS restores transcript wording',
    captions(p).some((e) => /Open AI/u.test(e.properties.content)) &&
    captions(p).every((e) => e.properties.textSource === 'TRANSCRIPT_GENERATED'));
  ok('regeneration keeps the current track style (colour + position)',
    captions(p).every((e) => String(e.properties.color).toLowerCase() === '#ffee00' &&
      Math.abs(e.properties.y - 0.62) < 0.2));
  p = await h.service.undo(p.id, p.revision);
  ok('undo of regeneration brings the manual correction back', wording(p) === wording(beforeRegen));
  p = await h.service.redo(p.id, p.revision);
  ok('redo re-applies the regeneration', captions(p).some((e) => /Open AI/u.test(e.properties.content)));
  p = await h.service.undo(p.id, p.revision);

  const aiTarget = captions(p)[1];
  const ai = await h.service.applyAssistantBundle(p.id, p.revision, { proposalId: 'ai-rewrite',
    summary: 'rewrite', userMessage: 'rewrite caption', commands: [
      { kind: 'ELEMENT', action: 'SET_CAPTION_TEXT', payload: { elementId: aiTarget.id, content: 'AI wording' } }] });
  p = ai.project;
  ok('an AI caption rewrite is recorded as AI_REWRITTEN', byId(p, aiTarget.id).properties.textSource === 'AI_REWRITTEN');
  return p;
}

async function framingTests(h, p) {
  console.log('\n-- framing, reframe, colour');
  const cuts = structure(p);
  const nonVideo = JSON.stringify(p.elements.filter((e) => e.type !== 'VIDEO'));
  const r0 = p.revision;
  p = await run(h, p, 'set-video-framing', { mode: 'ASPECT', aspectRatio: '9:16', scope: 'ALL_VIDEO_SEGMENTS' });
  ok('"crop whole video vertically" sets the canvas to 9:16', p.settings.aspectRatio === '9:16');
  ok('whole-project crop writes FILL framing to EVERY segment', videos(p).every((e) => e.properties.frameLayout === 'FILL'));
  ok('whole-project crop preserves trims, order, speed', structure(p) === cuts);
  ok('whole-project crop leaves captions, overlays, audio untouched',
    JSON.stringify(p.elements.filter((e) => e.type !== 'VIDEO')) === nonVideo);
  ok('whole-project crop is one revision with settings in its history row',
    p.revision === r0 + 1 && historyRows(h, p).find((row) => row.revision === p.revision)
      .afterState.settings.aspectRatio === '9:16');
  ok('commandResult reports the canvas change', p.commandResult.settingsChanged.includes('aspectRatio'));
  const plan = buildRenderPlan({ project: p, assets: p.assets, elements: p.elements, hasSourceAudio: true, fps: 30 }).plan;
  ok('the render plan honours the canvas and per-segment FILL', plan.canvas.aspectRatio === '9:16' &&
    plan.canvas.width < plan.canvas.height && plan.videoSegments.every((s) => s.frameLayout === 'FILL'));
  p = await h.service.undo(p.id, p.revision);
  ok('undo restores the previous canvas and framing',
    (p.settings.aspectRatio ?? 'SOURCE') !== '9:16' && videos(p).every((e) => !e.properties.frameLayout));
  p = await h.service.redo(p.id, p.revision);
  ok('redo reapplies it', p.settings.aspectRatio === '9:16');

  const fitRevision = p.revision;
  p = await run(h, p, 'set-video-framing', { mode: 'ASPECT', aspectRatio: '16:9', fitMode: 'FIT',
    scope: 'ALL_VIDEO_SEGMENTS' });
  ok('aspect and fit mode are independent: 16:9 FIT updates every cut atomically',
    p.settings.aspectRatio === '16:9' && videos(p).every((e) => e.properties.frameLayout === 'FIT') &&
    p.revision === fitRevision + 1 && p.commandResult.affectedCount === videos(p).length);
  await rejects('invalid fit mode is a structured validation error', () => run(h, p,
    'set-video-framing', { mode: 'ASPECT', aspectRatio: '9:16', fitMode: 'STRETCH',
      scope: 'ALL_VIDEO_SEGMENTS' }), 'INVALID_FIT_MODE');
  await rejects('current-segment crop never guesses a target', () => run(h, p,
    'set-video-framing', { mode: 'ASPECT', aspectRatio: '1:1', fitMode: 'FILL',
      scope: 'CURRENT_VIDEO_SEGMENT' }), 'NO_VIDEO_SELECTED');

  const target = videos(p)[1];
  p = await run(h, p, 'set-video-framing', { mode: 'ASPECT', aspectRatio: '1:1', elementId: target.id,
    fitMode: 'FILL', scope: 'CURRENT_VIDEO_SEGMENT' });
  const expected = aspectCropInsets(1920, 1080, '1:1');
  ok('"crop this segment to 1:1" crops ONLY that segment (centred, requested FILL mode)',
    Math.abs(byId(p, target.id).properties.crop.left - expected.left) < 1e-6 &&
    byId(p, target.id).properties.frameLayout === 'FILL' &&
    videos(p).filter((e) => e.id !== target.id).every((e) => !e.properties.crop?.left));
  ok('segment crop keeps the project canvas', p.settings.aspectRatio === '16:9');
  p = await run(h, p, 'set-video-framing', { mode: 'FIT', elementId: target.id });
  ok('FIT on one segment resets its crop and fits the whole frame',
    byId(p, target.id).properties.frameLayout === 'FIT' && byId(p, target.id).properties.crop.left === 0);
  p = await run(h, p, 'set-video-framing', { mode: 'FREE', scope: 'ALL_VIDEO_SEGMENTS',
    cropLeft: 0.1, cropRight: 0.1, cropTop: 0, cropBottom: 0 });
  ok('FREE crop over ALL_VIDEO_SEGMENTS writes explicit insets to every cut',
    videos(p).every((e) => e.properties.crop.left === 0.1));
  ok('framing never changed the cut structure', structure(p) === cuts);

  p = await run(h, p, 'set-reframe-policy', { policy: 'FACE_PRIORITY' });
  ok('FACE_PRIORITY maps to the renderer FACE_FOCUSED policy', p.settings.reframePolicy === 'FACE_FOCUSED');
  p = await run(h, p, 'set-reframe-policy', { policy: 'centered', clearSegmentOverrides: true });
  ok('CENTERED is a real renderer policy and clears segment overrides on request',
    p.settings.reframePolicy === 'CENTERED' && videos(p).every((e) => e.properties.frameLayout === null));
  const centred = buildRenderPlan({ project: p, assets: p.assets, elements: p.elements, hasSourceAudio: true, fps: 30 }).plan;
  ok('CENTERED renders every shot FILL', centred.frameSegments.every((s) => s.layout === 'FILL'));
  await rejects('TWO_PERSON_SAFE is honestly UNSUPPORTED', () => run(h, p, 'set-reframe-policy',
    { policy: 'TWO_PERSON_SAFE' }), 'UNSUPPORTED_REFRAME_POLICY');
  await rejects('a per-segment reframe POLICY is refused (camera is solved per project)',
    () => run(h, p, 'set-reframe-policy', { policy: 'AUTO', scope: 'CURRENT_VIDEO_SEGMENT' }),
    'UNSUPPORTED_EDIT_SCOPE');
  ok('policy aliases resolve deterministically', resolveReframePolicy('screen tutorial') === 'INFORMATION_PRESERVING' &&
    resolveReframePolicy('TALKING_HEAD') === 'FACE_FOCUSED');

  p = await run(h, p, 'set-video-temperature', { elementId: videos(p)[0].id,
    scope: 'CURRENT_VIDEO_SEGMENT', temperature: 0.15 });
  ok('"warm this shot" changes one segment',
    videos(p).filter((e) => e.properties.colorAdjustments?.temperature === 0.15).length === 1);
  p = await run(h, p, 'set-video-temperature', { scope: 'ALL_VIDEO_SEGMENTS', temperature: 0.2 });
  ok('"make the whole video warmer" changes every segment in one revision',
    videos(p).every((e) => e.properties.colorAdjustments?.temperature === 0.2) &&
    p.commandResult.affectedCount === videos(p).length);
  return p;
}

async function zoomAudioHookLogoTests(h, p) {
  console.log('\n-- zoom, audio, hook, logos');
  p = await run(h, p, 'add-zoom', { startTime: 1, duration: 1.2, scale: 1.1 });
  p = await run(h, p, 'add-zoom', { startTime: 6, duration: 1.2, scale: 1.12 });
  const [z1, z2] = zooms(p);
  p = await run(h, p, 'adjust-zoom-strength', { elementId: z1.id, direction: 'WEAKER' });
  ok('"make this zoom weaker" changes only the selected zoom',
    byId(p, z1.id).properties.scale < 1.1 && byId(p, z2.id).properties.scale === 1.12);
  const before = zooms(p).map((z) => z.properties.scale);
  p = await h.service.update(p.id, { revision: p.revision, settings: { ...p.settings, zoomPolicy: 'MODERATE' } });
  p = await run(h, p, 'adjust-zoom-strength', { direction: 'WEAKER' });
  ok('"make zooms weaker" weakens every canonical zoom', zooms(p).every((z, i) => z.properties.scale < before[i]));
  ok('...and steps the planned-zoom policy down too', p.settings.zoomPolicy === 'SUBTLE');
  p = await run(h, p, 'adjust-zoom-strength', { direction: 'STRONGER', step: 0.5 });
  ok('stronger is clamped to the renderer maximum', zooms(p).every((z) => z.properties.scale === 1.15));
  p = await run(h, p, 'remove-zoom', { elementId: z1.id });
  ok('"remove this zoom" removes one', zooms(p).length === 1 && zooms(p)[0].id === z2.id);
  p = await run(h, p, 'remove-zoom', {});
  ok('"remove all zooms" removes every zoom AND turns planned zooms off',
    zooms(p).length === 0 && p.settings.zoomPolicy === 'OFF');

  p = await run(h, p, 'add-audio', { assetId: 'music-a' });
  p = await run(h, p, 'add-audio', { assetId: 'music-b' });
  const music = p.elements.filter((e) => e.type === 'AUDIO');
  const sourceVolumes = JSON.stringify(videos(p).map((e) => e.properties.sourceVolume ?? 1));
  p = await run(h, p, 'set-audio-volume', { volume: 0.15 });
  ok('"lower the music" sets every music clip', p.elements.filter((e) => e.type === 'AUDIO').every((e) => e.properties.volume === 0.15));
  ok('...and never touches the source video audio',
    JSON.stringify(videos(p).map((e) => e.properties.sourceVolume ?? 1)) === sourceVolumes);
  p = await run(h, p, 'set-source-audio-muted', { muted: true });
  ok('"mute video audio" mutes the source only',
    videos(p).every((e) => e.properties.sourceMuted === true) &&
    p.elements.filter((e) => e.type === 'AUDIO').every((e) => e.properties.muted === false));
  p = await run(h, p, 'set-audio-volume', { elementId: music[1].id, volume: 0.4 });
  ok('"lower this audio clip" changes the selected AUDIO element only',
    byId(p, music[1].id).properties.volume === 0.4 && byId(p, music[0].id).properties.volume === 0.15);

  p = await run(h, p, 'add-text', { content: 'The real problem', origin: 'PRESET', presetRole: 'HOOK' });
  p = await run(h, p, 'add-text', { content: 'Other text' });
  const hook = p.elements.find((e) => e.type === 'TEXT' && e.properties.presetRole === 'HOOK');
  const other = p.elements.find((e) => e.type === 'TEXT' && e.id !== hook.id);
  p = await run(h, p, 'set-text-size', { semanticRole: 'HOOK', fontSize: 30 });
  ok('"make the hook smaller" changes the canonical HOOK only',
    byId(p, hook.id).properties.fontSize === 30 && byId(p, other.id).properties.fontSize !== 30);
  ok('...and never captions', captions(p).every((e) => e.properties.fontSize !== 30));
  p = await run(h, p, 'set-text-size', { elementType: 'TEXT', scope: 'TRACK', fontSize: 26 });
  ok('"make all text smaller" changes TEXT elements, not captions',
    p.elements.filter((e) => e.type === 'TEXT').every((e) => e.properties.fontSize === 26) &&
    captions(p).every((e) => e.properties.fontSize !== 26));

  p = await run(h, p, 'add-logo', { assetId: 'logo-a' });
  p = await run(h, p, 'add-logo', { assetId: 'logo-a' });
  const logos = p.elements.filter((e) => e.type === 'IMAGE');
  p = await run(h, p, 'move-element', { elementId: logos[0].id, x: 0.05, y: 0.05 });
  ok('"move this logo" moves one', byId(p, logos[0].id).properties.x === 0.05 && byId(p, logos[1].id).properties.x !== 0.05);
  p = await run(h, p, 'move-element', { semanticRole: 'LOGO', x: 0.7, y: 0.03 });
  ok('"move all logos" moves every LOGO overlay', p.elements.filter((e) => e.type === 'IMAGE').every((e) => e.properties.x === 0.7));
  return p;
}

async function constraintTests(h, p) {
  console.log('\n-- constraints, bundles, history');
  const caption = captions(p)[0];
  const r0 = p.revision;
  const mixed = await h.service.applyAssistantBundle(p.id, p.revision, {
    proposalId: 'mixed', summary: 'style allowed, wording protected', userMessage: 'test',
    constraints: [{ type: 'PROTECT_CAPTION_TEXT' }],
    commands: [
      { kind: 'ELEMENT', action: 'SET_TEXT_SIZE', payload: { elementType: 'SUBTITLE', scope: 'TRACK', fontSize: 36 } },
      { kind: 'ELEMENT', action: 'SET_CAPTION_TEXT', payload: { elementId: caption.id, content: 'Forbidden' } }
    ] });
  p = mixed.project;
  ok('PROTECT_CAPTION_TEXT: SET_CAPTION_STYLE-type command DONE, SET_CAPTION_TEXT BLOCKED',
    mixed.commandResults[0].status === 'DONE' && mixed.commandResults[1].status === 'BLOCKED_BY_CONSTRAINT' &&
    mixed.commandResults[1].constraint === 'PROTECT_CAPTION_TEXT');
  ok('the mixed bundle is ONE revision (one undo step)', p.revision === r0 + 1);
  ok('protected wording is untouched, style applied',
    byId(p, caption.id).properties.content !== 'Forbidden' && captions(p).every((e) => e.properties.fontSize === 36));
  ok('DONE result carries revision + changed values', mixed.commandResults[0].revision === p.revision &&
    mixed.commandResults[0].changes.some((c) => c.field === 'properties.fontSize' && c.after === 36));

  const beforeBlocked = JSON.stringify(p.elements);
  const blocked = await h.service.applyAssistantBundle(p.id, p.revision, {
    proposalId: 'crop', summary: 'AI crop', userMessage: 'test',
    constraints: [{ type: 'PROTECT_CROP' }],
    commands: [{ kind: 'ELEMENT', action: 'SET_VIDEO_FRAMING', payload: { mode: 'ASPECT', aspectRatio: '1:1' } }] });
  ok('AI task "don\'t change crop": AI crop is BLOCKED and consumes no revision',
    blocked.revision === p.revision && blocked.commandResults[0].status === 'BLOCKED_BY_CONSTRAINT' &&
    JSON.stringify(blocked.project.elements) === beforeBlocked);
  p = await run(h, blocked.project, 'set-video-framing', { mode: 'ASPECT', aspectRatio: '1:1' });
  ok('the user can still crop manually afterwards (task constraint does not bind manual)',
    p.settings.aspectRatio === '1:1');

  let lock = await h.service.setConstraints(p.id, { revision: p.revision,
    constraints: [{ type: 'PROTECT_CROP' }] });
  ok('a persistent PROJECT lock is stored', lock.projectConstraints[0].lifetime === 'PROJECT');
  await rejects('a PROJECT lock binds manual edits too', () => run(h, p, 'set-video-crop',
    { elementId: videos(p)[0].id, cropLeft: 0.2, cropRight: 0, cropTop: 0, cropBottom: 0 }), 'BLOCKED_BY_CONSTRAINT');
  await rejects('...and templates/presets', () => h.service.applyPresetBundle(p.id, p.revision, {
    presetId: 'MINIMAL', presetRunId: 'lock-test', summary: 'x', plannedZoomMoments: [],
    commands: [{ kind: 'ELEMENT', action: 'SET_VIDEO_CROP', payload: { elementId: videos(p)[0].id,
      cropLeft: 0.2, cropRight: 0, cropTop: 0, cropBottom: 0 } }] }), 'BLOCKED_BY_CONSTRAINT');
  const templated = await h.service.applyTemplateBundle(p.id, p.revision, {
    templateId: 'LOCK_TEST', templateName: 'Lock test', templateRunId: 'run-1', source: 'BUILTIN',
    summary: 'x', imprints: [], defaults: {},
    commands: [{ kind: 'SETTINGS', payload: { aspectRatio: '16:9', gradingPolicy: 'WARM' } },
      { kind: 'ELEMENT', action: 'SET_TEXT_COLOR', facet: 'CAPTIONS', elementId: caption.id,
        payload: { elementType: 'SUBTITLE', scope: 'TRACK', color: '#00FF00' } }] });
  p = templated;
  ok('5.17 template: crop lock strips the canvas change but keeps the rest of the style',
    p.settings.aspectRatio === '1:1' && p.settings.gradingPolicy === 'WARM' &&
    templated.commandResults.some((r) => r.status === 'BLOCKED_BY_CONSTRAINT' && r.constraint === 'PROTECT_CROP'));
  ok('5.17 template: caption styling applied, caption wording preserved',
    captions(p).every((e) => String(e.properties.color).toLowerCase() === '#00ff00') &&
    byId(p, caption.id).properties.content === byId(mixed.project, caption.id).properties.content);
  lock = await h.service.setConstraints(p.id, { revision: p.revision, constraints: [] });
  p = await run(h, p, 'set-video-crop', { elementId: videos(p)[0].id, scope: 'CURRENT_VIDEO_SEGMENT',
    cropLeft: 0.2, cropRight: 0, cropTop: 0, cropBottom: 0 });
  ok('removing the lock allows the manual crop', videos(p)[0].properties.crop.left === 0.2);

  // TARGET_RANGE_ONLY
  const range = [{ type: 'TARGET_RANGE_ONLY', target: { kind: 'RANGE', startSec: 0, endSec: 4 } }];
  const inRange = await h.service.applyAssistantBundle(p.id, p.revision, {
    proposalId: 'range', summary: 'range', userMessage: 'only fix the opening', constraints: range,
    onInvalid: 'CONTINUE', commands: [
      { kind: 'ELEMENT', action: 'SET_VIDEO_TEMPERATURE', payload: { elementId: videos(p)[0].id, temperature: -0.1 } },
      { kind: 'ELEMENT', action: 'SET_VIDEO_TEMPERATURE', payload: { scope: 'ALL_VIDEO_SEGMENTS', temperature: 0.3 } },
      { kind: 'ELEMENT', action: 'TRIM_ELEMENT', payload: { elementId: videos(p)[0].id,
        trimStart: videos(p)[0].trimStart + 0.5, trimEnd: videos(p)[0].trimEnd } }
    ] });
  p = inRange.project;
  ok('TARGET_RANGE_ONLY: an edit inside the range is DONE', inRange.commandResults[0].status === 'DONE');
  ok('TARGET_RANGE_ONLY: a whole-video edit is BLOCKED', inRange.commandResults[1].status === 'BLOCKED_BY_CONSTRAINT');
  ok('TARGET_RANGE_ONLY: a trim that ripples later elements is BLOCKED by the post-execution diff',
    inRange.commandResults[2].status === 'BLOCKED_BY_CONSTRAINT');
  ok('range constraint validation refuses a malformed range', (() => {
    try { readEditConstraints([{ type: 'TARGET_RANGE_ONLY', startSec: 5, endSec: 2 }]); return false; }
    catch (e) { return e.response?.code === 'INVALID_CONSTRAINT'; } })());

  // Bundle status semantics.
  const r1 = p.revision;
  const statuses = await h.service.applyAssistantBundle(p.id, p.revision, {
    proposalId: 'statuses', summary: 'mixed', userMessage: 'several clauses', onInvalid: 'CONTINUE',
    constraints: [{ type: 'PROTECT_AUDIO' }], commands: [
      { kind: 'ELEMENT', action: 'SET_TEXT_WEIGHT', payload: { elementType: 'SUBTITLE', scope: 'TRACK', fontWeight: 800 } },
      { kind: 'ELEMENT', action: 'SET_AUDIO_VOLUME', payload: { volume: 0.05 } },
      { kind: 'ELEMENT', action: 'SET_REFRAME_POLICY', payload: { policy: 'PRODUCT_CENTER' } },
      { kind: 'ELEMENT', action: 'SET_TEXT_SIZE', payload: { elementType: 'SUBTITLE', scope: 'TRACK', fontSize: 9999 } },
      { kind: 'ELEMENT', action: 'ADD_TEXT', ref: 'new-text', payload: { content: 'x', textStyleId: 'NOPE' } },
      { kind: 'ELEMENT', action: 'SET_TEXT_COLOR', payload: { ref: 'new-text', color: '#FF0000' } }
    ] });
  ok('every clause gets a status: DONE / BLOCKED / UNSUPPORTED / INVALID / INVALID / SKIPPED',
    JSON.stringify(statuses.commandResults.map((r) => r.status)) ===
    JSON.stringify(['DONE', 'BLOCKED_BY_CONSTRAINT', 'UNSUPPORTED', 'INVALID', 'INVALID', 'SKIPPED']));
  ok('the partially-successful bundle is still ONE revision', statuses.revision === r1 + 1);
  p = statuses.project;
  await rejects('onInvalid ABORT (default) keeps the historic all-or-nothing behaviour',
    () => h.service.applyAssistantBundle(p.id, statuses.revision, { proposalId: 'abort',
      summary: 'x', userMessage: 'x', commands: [
        { kind: 'ELEMENT', action: 'SET_TEXT_SIZE', payload: { elementType: 'SUBTITLE', scope: 'TRACK', fontSize: 9999 } }] }));

  // Pure-function checks.
  ok('task-only logo protection binds AI, not manual',
    blockingEditConstraint('MOVE_ELEMENT', 'AI_ACTION', [{ type: 'PROTECT_LOGO_POSITION', lifetime: 'TASK' }],
      [{ id: 'l', type: 'IMAGE', startTime: 0, duration: 2, properties: { role: 'LOGO' } }])?.type === 'PROTECT_LOGO_POSITION' &&
    blockingEditConstraint('MOVE_ELEMENT', 'MANUAL_USER_ACTION', [{ type: 'PROTECT_LOGO_POSITION', lifetime: 'TASK' }],
      [{ id: 'l', type: 'IMAGE', startTime: 0, duration: 2, properties: { role: 'LOGO' } }]) === null);
  ok('PROTECT_HOOK_TEXT blocks hook rewrites but not hook styling',
    blockingEditConstraint('SET_TEXT_CONTENT', 'AI_ACTION', [{ type: 'PROTECT_HOOK_TEXT' }],
      [{ id: 'h', type: 'TEXT', startTime: 0, duration: 2, properties: { presetRole: 'HOOK' } }])?.type === 'PROTECT_HOOK_TEXT' &&
    blockingEditConstraint('SET_TEXT_SIZE', 'AI_ACTION', [{ type: 'PROTECT_HOOK_TEXT' }],
      [{ id: 'h', type: 'TEXT', startTime: 0, duration: 2, properties: { presetRole: 'HOOK' } }]) === null);
  ok('PROTECT_CUTS blocks trims/splits', blockingEditConstraint('SPLIT_ELEMENT', 'AI_ACTION',
    [{ type: 'PROTECT_CUTS' }], [{ id: 'v', type: 'VIDEO', startTime: 0, duration: 4 }])?.type === 'PROTECT_CUTS');
  ok('PROTECT_COLOR blocks grading', blockingEditConstraint('APPLY_COLOR_FILTER', 'AI_ACTION',
    [{ type: 'PROTECT_COLOR' }], [{ id: 'v', type: 'VIDEO', startTime: 0, duration: 4 }])?.type === 'PROTECT_COLOR');
  ok('PROTECT_CAPTION_STYLE blocks caption styling, not TEXT styling',
    blockingEditConstraint('SET_TEXT_COLOR', 'AI_ACTION', [{ type: 'PROTECT_CAPTION_STYLE' }],
      [{ id: 'c', type: 'SUBTITLE', startTime: 0, duration: 1 }])?.type === 'PROTECT_CAPTION_STYLE' &&
    blockingEditConstraint('SET_TEXT_COLOR', 'AI_ACTION', [{ type: 'PROTECT_CAPTION_STYLE' }],
      [{ id: 't', type: 'TEXT', startTime: 0, duration: 1 }]) === null);
  ok('SYSTEM_ACTION is never bound', blockingEditConstraint('SET_VIDEO_CROP', 'SYSTEM_ACTION',
    [{ type: 'PROTECT_CROP', lifetime: 'PROJECT' }], [{ id: 'v', type: 'VIDEO', startTime: 0, duration: 4 }]) === null);
  ok('rangeViolation ignores unchanged elements', rangeViolation('AI_ACTION', range,
    [{ id: 'a', type: 'TEXT', startTime: 8, duration: 1 }], [{ id: 'a', type: 'TEXT', startTime: 8, duration: 1 }]) === null);
  ok('legacy scope aliases normalize', readEditCommandScope('CURRENT_SEGMENT', 'PROJECT') === 'CURRENT_VIDEO_SEGMENT');
  return p;
}

async function lineageTests() {
  console.log('\n-- NORMAL / reconstructed AI_EDITED / flattened fallback projects');
  const h = installBridgeHarness();
  const normal = h.seedClip({ id: 'n', processingType: 'NORMAL_CLIPS', variantKey: 'NORMAL_CLIPS:YT' });
  const flat = h.seedClip({ id: 'f', processingType: 'EDITED_CLIPS', variantKey: 'EDITED_CLIPS:YT',
    editPlan: { cuts: [{ start: 10, end: 22 }] }, editTelemetry: { editQualityStatus: 'PASSED' } });
  const recon = h.seedClip({ id: 'r', processingType: 'EDITED_CLIPS', variantKey: 'EDITED_CLIPS:YT:R',
    startTime: 100, endTime: 112, duration: 10,
    transcriptSegments: [{ start: 100, end: 112, text: 'One clear idea survives this edit', words: [
      { start: 100, end: 100.5, text: 'One' }, { start: 100.5, end: 101, text: 'clear' },
      { start: 101, end: 101.5, text: 'idea' }, { start: 106, end: 106.5, text: 'survives' },
      { start: 106.5, end: 107, text: 'this' }, { start: 107, end: 107.5, text: 'edit' }] }],
    editPlan: { version: 1, clipStartSec: 100, clipEndSec: 112, aspectRatio: '9:16',
      openingStrategy: { hookStartSec: 100, removeWeakLeadIn: false, reason: 'Context' },
      endingStrategy: { payoffEndSec: 112, reason: 'Payoff' }, musicMood: 'NONE', preserveInformation: false,
      onScreenHook: { enabled: true, text: 'One clear idea', startSec: 100, endSec: 103, position: 'TOP', style: 'CLEAN' },
      operations: [], retentionMoments: [], onScreenText: [],
      subtitleStyle: { enabled: true, template: 'EDUCATION_CLEAN', position: 'BOTTOM', maxWordsPerLine: 5,
        highlightCurrentWord: true, animationStyle: 'WORD_HIGHLIGHT' }, subtitleTheme: 'CLEAN_WHITE',
      subtitleEmphasis: [], platformPreset: 'YOUTUBE_SHORTS', gradePreset: 'CLEAN_SOCIAL',
      audio: { normalize: false, removeLongPauses: true }, pacingNotes: [] },
    editTelemetry: { timelineSegments: [{ sourceStart: 100, sourceEnd: 104, finalStart: 0, finalEnd: 4 },
      { sourceStart: 106, sourceEnd: 112, finalStart: 4, finalEnd: 10 }],
    zoomEvents: [{ startSec: 4.3, endSec: 6, peakScale: 1.1, focusX: 0.5, focusY: 0.45,
      triggerText: 'survives', semanticReason: 'Key claim' }], grading: { selectedPreset: 'CLEAN_SOCIAL' },
    reframeSource: 'FACE' } });
  for (const [label, clip] of [['NORMAL', normal], ['reconstructed AI_EDITED', recon], ['flattened AI_EDITED', flat]]) {
    const { editProjectId } = await h.materializer.materialize(clip.id);
    let p = await h.service.get(editProjectId);
    const cuts = structure(p);
    if (label === 'NORMAL') {
      await rejects('NORMAL: "make the hook smaller" with no hook is an honest NO_HOOK (no invented target)',
        () => run(h, p, 'set-text-size', { semanticRole: 'HOOK', fontSize: 30 }), 'NO_HOOK');
    }
    p = await run(h, p, 'set-video-framing', { mode: 'ASPECT', aspectRatio: '9:16', scope: 'ALL_VIDEO_SEGMENTS' });
    ok(`${label}: whole-clip crop covers every VIDEO segment and keeps cuts`,
      videos(p).every((e) => e.properties.frameLayout === 'FILL') && structure(p) === cuts);
    p = await run(h, p, 'set-video-temperature', { scope: 'ALL_VIDEO_SEGMENTS', temperature: 0.1 });
    ok(`${label}: global colour covers every segment`, videos(p).every((e) => e.properties.colorAdjustments?.temperature === 0.1));
    if (captions(p).length) {
      const wordsBefore = wording(p);
      p = await run(h, p, 'set-text-size', { elementType: 'SUBTITLE', scope: 'TRACK', fontSize: 40 });
      ok(`${label}: global caption size preserves wording`, wording(p) === wordsBefore);
    }
    if (zooms(p).length) {
      p = await run(h, p, 'adjust-zoom-strength', { direction: 'WEAKER' });
      ok(`${label}: global zoom weaker touches the reconstructed zoom`, zooms(p).every((z) => z.properties.scale < 1.1));
    }
    if (label === 'reconstructed AI_EDITED') {
      ok('multi-cut reconstruction still has 2 cuts after global framing', videos(p).length === 2);
      await rejects('COMPLEX_SOURCE_RANGE_UNSUPPORTED safety rule is intact', () => h.service.adjustSourceRange(p.id,
        { revision: p.revision, startDelta: -1 }), 'COMPLEX_SOURCE_RANGE_UNSUPPORTED');
    }
    const plan = buildRenderPlan({ project: p, assets: p.assets, elements: p.elements, hasSourceAudio: true, fps: 30 }).plan;
    ok(`${label}: export plan is valid with the scoped edits`, plan.videoSegments.length === videos(p).length &&
      plan.canvas.aspectRatio === '9:16');
    p = await h.service.undo(p.id, p.revision);
    ok(`${label}: undo works after scoped edits`, p.revision > 0);
  }
}

async function main() {
  console.log('EditMode Step 5 scope and constraints');
  const { h, p: seeded } = await seed();
  let p = await captionTests(h, seeded);
  p = await framingTests(h, p);
  p = await zoomAudioHookLogoTests(h, p);
  p = await constraintTests(h, p);
  const reloaded = await h.service.get(p.id);
  ok('reload returns the same canonical state', JSON.stringify(reloaded.elements) === JSON.stringify(p.elements));
  await lineageTests();
  console.log(`\nEditMode Step 5 scope/constraint tests passed (${checks} checks).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
