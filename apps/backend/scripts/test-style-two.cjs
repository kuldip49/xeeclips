// No providers, databases, servers or production writes. Canonical commands and renderer.
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const assert = require('node:assert/strict');
const { STYLE_TWO_ID: ID, STYLE_TWO: S, normalized, styleTwoText } = require('@ai-content-platform/shared/style-two.cjs');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { resolveCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-resolver');
const { compileCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-commands');
const { resolveVisualLayout } = require('../dist/modules/edit-mode/styles/resolved-visual-layout');
const { parseAutoGeneration } = require('../dist/modules/videos/auto-generation');
const { ClipSelectionService, resolveGenerationStyleReadiness } = require('../dist/modules/videos/clip-selection.service');
const { clipVariantKey } = require('../dist/modules/processing/clip-selection-policy');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const { buildEditModeAss } = require('../dist/modules/edit-mode/render/edit-mode-ass');
const copy = value => JSON.parse(JSON.stringify(value));
async function main() {
  const resolved = resolveCreativeStyle({ templateId: ID });
  assert.equal(resolved.templateId, ID);
  // Zoom is NOT StyleTwo's own policy: it resolves to StyleOne's canonical phrase-timed component.
  assert.equal(resolved.components.ZOOM.source, 'TEMPLATE');
  assert.equal(resolved.components.ZOOM.styleId, resolveCreativeStyle({ templateId: 'AUTOMATIC_2' }).components.ZOOM.styleId);
  assert.equal(resolved.components.FRAMING.source, 'DEFAULT');
  const request = parseAutoGeneration({ requestedClipCount: 1, generation: { look: ID } });
  assert.equal(request.generation.templateId, ID);
  const selector = new ClipSelectionService({}, {});
  const settings = await selector.buildGenerationSettings(request.generation);
  assert.equal(settings.requestedTemplate, ID); assert.equal(settings.effectiveTemplate, ID);
  for (const other of ['AUTOMATIC_1','AUTOMATIC_2','AUTOMATIC_RAW']) {
    const previous = await selector.buildGenerationSettings({ ...request.generation, templateId: other });
    assert.notEqual(settings.key, previous.key);
    assert.notEqual(clipVariantKey('EDITED_CLIPS','TIKTOK',ID), clipVariantKey('EDITED_CLIPS','TIKTOK',other));
  }
  const layout = resolveVisualLayout(resolved, { sourceWidth: 1920, sourceHeight: 1080 });
  assert.deepEqual(layout.videoFrame, { ...normalized(S.media), mode: 'CARD', cropPolicy: 'AUTO' });
  assert.equal(layout.background.color, '#FFFFFF');
  assert.deepEqual(layout, resolveVisualLayout(resolved, { sourceWidth: 720, sourceHeight: 1280 }));
  const ready = { templateId: ID, editProject: { settings: { generationStyle: {
    status: 'EXPORT_READY', exportAssetId: 'test', templateId: ID } } } };
  assert.equal(resolveGenerationStyleReadiness(ready).status, 'EXPORT_READY');
  assert.equal(resolveGenerationStyleReadiness({ ...ready, editProject: { settings: {
    generationStyle: { status: 'EXPORT_READY', exportAssetId: 'wrong', templateId: 'AUTOMATIC_2' } } } }).status, 'STYLE_FAILED');
  assert.equal(resolveGenerationStyleReadiness({ ...ready, editProject: { settings: {
    generationStyle: { status: 'EXPORT_READY', exportAssetId: 'legacy' } } } }).status, 'STYLE_FAILED');
  const fixture = await seedRichProject({ split: false });
  await fixture.sayAndApply('zoom in here', { playheadSec: 14 });
  await fixture.sayAndApply('crop tighter', { playheadSec: 14 });
  let project = await fixture.refresh();
  const before = copy(project);
  assert(before.elements.some(e => e.type === 'EFFECT' && e.properties.effect === 'ZOOM'));
  assert(before.elements.some(e => e.type === 'VIDEO' && e.properties.crop.left > 0));
  const { context } = await fixture.chat.loadContext(fixture.id, 'StyleTwo', {});
  const compiled = compileCreativeStyle(resolved, context, { hookOptions: [{ text: 'Why are rates still high?' }], hasWordTimings: true });
  assert(!compiled.commands.some(c => /REFRAME|AUDIO|FILTER|COLOR_ADJUST/.test(c.action || '')));
  // The only motion commands are the shared zoom stage's: it replaces inherited punch-ins.
  assert(compiled.commands.filter(c => /ZOOM/.test(c.action || '')).every(c => ['REMOVE_ZOOM','ADD_ZOOM'].includes(c.action)));
  const result = await fixture.service.applyAssistantBundle(fixture.id, project.revision, {
    proposalId: 'style-two-test', summary: 'StyleTwo', userMessage: 'StyleTwo', actor: 'TEMPLATE_ACTION',
    commands: compiled.commands, onInvalid: 'FAIL' });
  project = result.project;
  const keep = p => p.elements.filter(e => ['VIDEO','AUDIO','IMAGE'].includes(e.type));
  assert.deepEqual(keep(project), keep(before));
  // The base edit's short punch-in is gone; whatever zoom remains is the canonical 2.5-5 s emphasis.
  for (const zoom of project.elements.filter(e => e.type === 'EFFECT')) {
    assert(zoom.duration >= 2.5 - 1e-6 && zoom.duration <= 5 + 1e-6, `zoom ${zoom.duration}s outside the canonical 2.5-5 s`);
  }
  assert.deepEqual(project.elements.filter(e => e.type === 'SUBTITLE').map(e => [e.properties.content,e.startTime,e.duration]),
    before.elements.filter(e => e.type === 'SUBTITLE').map(e => [e.properties.content,e.startTime,e.duration]));
  const hook = project.elements.find(e => e.type === 'TEXT' && e.properties.presetRole === 'HOOK');
  assert.equal(hook.properties.fontFamily, S.hookFont);
  assert.equal(hook.properties.fontSize, S.hookSize, 'retain fractional measured headline size through canonical commands');
  const corrected = project.elements.find(e => e.type === 'SUBTITLE');
  await fixture.service.phase3Command(fixture.id, 'SET_CAPTION_TEXT', { revision: project.revision, elementId: corrected.id, content: 'My corrected phrase' });
  project = await fixture.refresh();
  await fixture.service.phase3Command(fixture.id, 'SET_TEXT_CONTENT', { revision: project.revision, elementId: hook.id,
    content: 'A longer manually corrected headline that still fits safely in the measured upper region' });
  project = await fixture.refresh();
  assert.equal(project.elements.find(e => e.id === corrected.id).properties.content, 'My corrected phrase');
  assert.equal(project.elements.find(e => e.id === hook.id).properties.fontFamily, S.hookFont);
  const built = buildRenderPlan({ project, assets: project.assets, elements: project.elements });
  assert.deepEqual(built.plan.frameSegments.map(({ startSec, endSec, layout }) => ({ startSec, endSec, layout })),
    project.settings.resolvedVisualLayout.frameSegments, 'preview fits reuse the export shot decisions');
  assert.deepEqual(built.evidence.punches, [], 'StyleTwo must never activate StyleOne sentence punches');
  // Preview/export text fit parity: the export sizes StyleTwo text from the UNROUNDED design size, like the preview.
  // (Rounded 95 px made "an environment and a dispensation" wrap in the export while the preview kept one line.)
  const { readTextStyle } = require('../dist/modules/edit-mode/edit-mode-text');
  const fit = (overlayOrElement, fromPlan) => {
    const common = { x: 0, y: 0, width: 1008, height: 192, uppercase: true, textAlign: 'center' };
    if (fromPlan) return styleTwoText({ ...common, ...overlayOrElement, fontSize: overlayOrElement.fontSizePx,
      lineHeight: overlayOrElement.lineSpacing, letterSpacing: overlayOrElement.letterSpacing * 1.8, boxed: overlayOrElement.background.enabled,
      padding: overlayOrElement.background.padding, radius: overlayOrElement.background.radius, scale: 1.8 });
    const style = readTextStyle(overlayOrElement.properties);
    return styleTwoText({ ...common, content: overlayOrElement.properties.content, fontFamily: style.fontFamily, fontSize: style.fontSize * 1.8,
      lineHeight: style.lineSpacing, letterSpacing: style.letterSpacing * 1.8, boxed: style.background.enabled,
      padding: style.background.padding, radius: style.background.radius, scale: 1.8 });
  };
  const captionElement = project.elements.find(e => e.type === 'SUBTITLE');
  for (const wording of ['an environment and a dispensation', "because money wasn't stolen opportunities", "there's no money to steal", 'humanity to be compensated']) {
    await fixture.service.phase3Command(fixture.id, 'SET_CAPTION_TEXT', { revision: (await fixture.refresh()).revision, elementId: captionElement.id, content: wording });
    const edited = await fixture.refresh();
    const plan = buildRenderPlan({ project: edited, assets: edited.assets, elements: edited.elements }).plan;
    const overlay = plan.subtitles.find(o => o.elementId === captionElement.id);
    assert(Math.abs(overlay.fontSizePx - S.captionSize * 1.8) < 1e-9, `export caption size ${overlay.fontSizePx} must be the unrounded ${S.captionSize * 1.8}`);
    assert.deepEqual(fit(overlay, true).lines, fit(edited.elements.find(e => e.id === captionElement.id), false).lines, `"${wording}" wraps identically in preview and export`);
  }
  const hookPlan = buildRenderPlan({ project: await fixture.refresh(), assets: project.assets, elements: (await fixture.refresh()).elements }).plan;
  assert(Math.abs(hookPlan.textOverlays.find(o => o.elementId === hook.id).fontSizePx - S.hookSize * 1.8) < 1e-9, 'export headline size is the unrounded 80.1 px');
  project = await fixture.refresh();
  const ass = buildEditModeAss(built.plan.canvas, [...built.plan.textOverlays, ...built.plan.subtitles]);
  assert(ass.content.includes('StyleTwoVector')); assert(!ass.parityNotes.some(n => /square/.test(n)));
  assert(ass.content.includes('YCbCr Matrix: None'), 'template colors retain their RGB values on BT.709 footage');
  assert.equal(ass.overflowed.length, 0);
  for (const key of project.settings.resolvedVisualLayout.cameraPath) {
    const crop = built.evidence.cropAt(key.t);
    for (const axis of ['x','y','w','h']) assert(Math.abs(crop[axis] - key[axis]) < .0001, `camera ${axis} at ${key.t}`);
  }
  const text = styleTwoText({ ...S.captions, content: "SOMALI ISN'T", fontFamily: S.captionFont,
    fontSize: S.captionSize * 1.8, uppercase: true, boxed: true, scale: 1.8 });
  assert(Math.abs(text.plate.width / 1.5 - 342) < 4);
  assert(Math.abs(text.plate.height / 1.5 - 98) < 4);
  const headline = styleTwoText({ ...S.hook, content: '“Being Somali-American is like bananas and rice...” - Wait for Crowder’s reaction',
    fontFamily: S.hookFont, fontSize: S.hookSize * 1.8, lineHeight: S.hookLineHeight, scale: 1.8 });
  assert.deepEqual(headline.lines, ['“Being Somali-American is like', 'bananas and rice...” - Wait for', 'Crowder’s reaction']);
  const left = styleTwoText({ ...S.captions, content: 'EDITED', fontFamily: S.captionFont,
    fontSize: S.captionSize * 1.8, textAlign: 'left', boxed: true, scale: 1.8 });
  assert.equal(left.plate.x, S.captions.x, 'manual text alignment remains editable');
  const hookOverlay = built.plan.textOverlays.find(o => o.elementId === hook.id);
  const unrotated = buildEditModeAss(built.plan.canvas, [hookOverlay]);
  const rotated = buildEditModeAss(built.plan.canvas, [{...hookOverlay, rotation: 15}]);
  assert.notEqual(unrotated.content, rotated.content, 'manual text rotation changes export paths');
  const emphasized = buildEditModeAss(built.plan.canvas, [{...hookOverlay, fontWeight: 900}]);
  assert(emphasized.content.includes('Style: Edit0,'), 'explicit weight changes use the existing text renderer');
  const undone = await fixture.service.undo(fixture.id, project.revision);
  const redone = await fixture.service.redo(fixture.id, undone.revision);
  assert.equal(redone.settings.resolvedVisualLayout.editingProfile, ID);
  console.log('StyleTwo: identity/cache isolation, fixed geometry, canonical commands, motion/audio isolation, captions/corrections, hook fitting, camera parity, rounded ASS and undo/redo: PASS');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
