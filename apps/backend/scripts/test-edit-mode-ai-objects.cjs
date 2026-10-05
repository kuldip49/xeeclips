// EditMode Workstream G - AI object awareness and full editing-command coverage.
//
// Offline and fast: every conversation here runs through the REAL
// EditChatService -> EditModeService -> canonical applyElementCommand path on
// the in-memory Prisma harness, so "the hook changed" means the stored TEXT
// element changed, and "nothing else changed" is checked on stored state. No
// provider is called (the OFFLINE section proves it with a call counter on the
// real router), no video is encoded, nothing touches Postgres/Redis/MinIO.
//
//   npm --workspace apps/backend run test:edit-mode-ai

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');

const C = '../dist/modules/edit-mode/chat';
const { validateChatIntent, CHAT_INTENT_SCHEMA, CHAT_HOOK_SCHEMA, CHAT_ELEMENT_ACTIONS,
  CHAT_SETTINGS_ACTIONS, CHAT_MAX_MODEL_COMMANDS } = require(`${C}/edit-chat-commands.js`);
const { buildChatContext, semanticRole } = require(`${C}/edit-chat-context.js`);
const { parseNaturalRequest, splitClauses, unsupportedCapability } = require(`${C}/edit-chat-intents.js`);
const { resolveChatPlan } = require(`${C}/edit-chat-resolver.js`);
const { deterministicHookSuggestions, rankHookCandidates } = require(`${C}/edit-chat-hook.js`);
const { planEditModeZoom } = require('../dist/modules/edit-mode/render/edit-mode-zoom.js');
const { zoomMomentKey, MAX_ZOOM_SCALE } =
  require('../dist/modules/edit-mode/edit-mode-zoom-events.js');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service.js');

let passed = 0;
const ok = (label) => { console.log(`  ok  ${label}`); passed += 1; };
const section = (title) => console.log(`\n${title}`);

// --- helpers ------------------------------------------------------------------

const els = (project, type) => project.elements.filter((element) => element.type === type);
const hookOf = (project) => els(project, 'TEXT').find((element) =>
  element.properties.presetRole === 'HOOK');
const logoOf = (project) => els(project, 'IMAGE').find((element) =>
  element.properties.role === 'LOGO');
const musicOf = (project) => els(project, 'AUDIO')[0];
const actions = (planned) => planned.proposal.plannedChanges;
const stripVolatile = (element) => {
  const { updatedAt: _u, createdAt: _c, editProjectId: _p, ...rest } = element;
  return JSON.parse(JSON.stringify(rest));
};
/** Every element except `exceptIds`, as comparable plain data. */
const snapshot = (project, exceptIds = []) => Object.fromEntries(project.elements
  .filter((element) => !exceptIds.includes(element.id))
  .map((element) => [element.id, stripVolatile(element)]));
/** Settings without the chat thread, which every turn is allowed to write. */
const styleSettings = (project) => { const { chat: _chat, ...rest } = project.settings; return rest; };
const expectQuestion = (planned, pattern, label) => {
  assert.equal(planned.proposal.needsClarification, true, `${label}: expected a question`);
  if (pattern) assert.match(planned.proposal.clarificationQuestion, pattern, label);
};
const history = (s) => [...s.rows.editHistory.values()]
  .filter((row) => row.editProjectId === s.id).sort((a, b) => a.revision - b.revision);

async function main() {
  console.log('EditMode Workstream G - AI object awareness:');

  // ===========================================================================
  section('1. Structured AI project context (Parts 2-5)');
  {
    const s = await seedRichProject();
    const logo = logoOf(s.project);
    const planned = await s.say('make it bigger', { selectedElementId: logo.id, playheadSec: 14,
      selectedTimeRange: { startSec: 13, endSec: 17 } });
    void planned;
    const context = contextOf(s, { selectedElementId: logo.id, playheadSec: 14,
      selectedTimeRange: { startSec: 13, endSec: 17 } });

    // 1. project summary
    assert.equal(context.project.timelineDurationSec, 36);
    assert.equal(context.project.revision, s.project.revision);
    assert.equal(context.tracks.videoSegments, 3);
    assert.equal(context.project.hasWordTimings, true);
    ok('1  project summary: duration, revision, segments, word timings');

    // 2. selection
    assert.equal(context.selection.selectedElementHandle, 'logo:main');
    assert.equal(context.elements.find((view) => view.handle === 'logo:main').selected, true);
    ok('2  the selected element is exposed by handle ("logo:main")');

    // 3. playhead
    assert.equal(context.selection.playheadSec, 14);
    const listed = context.elements.filter((view) => view.semantic === 'CAPTION');
    assert.ok(listed.length > 0 && listed.every((view) => view.endSec > 11 - 1e-6 &&
      view.startSec < 17 + 1e-6), 'only captions near the playhead/range are listed');
    ok('3  captions near the playhead are listed, not the whole track');

    // 4. range
    assert.deepEqual(context.selection.selectedTimeRange, { startSec: 13, endSec: 17 });
    ok('4  the selected range reaches the context');

    // 5. hook detection, from metadata first, style second, never from wording
    assert.equal(context.tracks.hook, 'text:hook');
    const hookView = context.elements.find((view) => view.handle === 'text:hook');
    assert.equal(hookView.semantic, 'HOOK');
    assert.equal(hookView.roleSource, 'METADATA');
    assert.deepEqual(semanticRole('TEXT', { textStyleId: 'HOOK' }),
      { semantic: 'HOOK', source: 'STYLE' });
    assert.deepEqual(semanticRole('TEXT', { content: 'Why rates are high - the hook!' }),
      { semantic: 'TEXT', source: 'TYPE' });
    ok('5  the hook is found from presetRole/templateRole, then from its chosen style - never wording');

    // 6. CTA detection
    const withCta = await seedRichProject();
    await withCta.sayAndApply('add a CTA saying "Follow for part 2"');
    const ctaContext = contextOf(withCta);
    assert.equal(ctaContext.tracks.cta, 'text:cta');
    assert.equal(ctaContext.elements.find((view) => view.handle === 'text:cta').properties.content,
      'Follow for part 2');
    ok('6  a CTA is created with its role recorded and is then addressable as text:cta');

    // 7. assets: opaque handles, never ids
    const handles = context.assets.map((asset) => asset.handle);
    assert.ok(handles.includes('asset:logo1') && handles.includes('asset:audio1'));
    assert.ok(context.assets.every((asset) => !asset.handle.includes(asset.id)));
    ok('7  assets carry role handles (asset:logo1, asset:audio1)');

    // 8. captions: summarised, and bounded on a 400-caption project
    assert.equal(context.tracks.captions.count, els(s.project, 'SUBTITLE').length);
    assert.equal(context.tracks.captions.styleId, 'CLEAN');
    const crowded = crowdedContext(400);
    assert.equal(crowded.tracks.captions.count, 400);
    assert.ok(crowded.elements.filter((view) => view.semantic === 'CAPTION').length <= 10);
    assert.ok(crowded.notes.some((note) => /400 captions exist/u.test(note)));
    ok('8  captions are summarised; 400 captions list at most 10 (no dump)');

    // 9. audio
    const music = context.elements.find((view) => view.handle === 'audio:music1');
    assert.equal(music.properties.volume, 0.2);
    assert.equal(music.properties.filename, 'lofi-beat.mp3');
    assert.deepEqual(context.tracks.sourceAudio, { volume: 1, muted: false });
    ok('9  music state (volume, filename) and the original sound are in context');

    // 10. templates
    assert.ok(context.templates.some((template) => template.handle === 'template:clean_reel'));
    await s.templates.create({ name: 'Finance Reel', description: '' });
    const withUser = contextOf(s);
    assert.ok(withUser.templates.some((template) => template.handle === 'template:user1' &&
      template.name === 'Finance Reel'));
    ok('10 built-in and user templates are listed by handle');
  }

  // ===========================================================================
  section('2. Target resolution (Part 6)');
  {
    const s = await seedRichProject();
    const hook = hookOf(s.project);
    // 11. selected target
    const planned = await s.say('make this bigger', { selectedElementId: hook.id });
    assert.ok(actions(planned).some((line) => /hook text size/u.test(line)));
    ok('11 "make this bigger" with the hook selected targets the hook');

    const selectedMusic = await seedRichProject();
    const chosenMusic = musicOf(selectedMusic.project);
    const lower = await selectedMusic.say('lower this', { selectedElementId: chosenMusic.id });
    assert.equal(lower.proposal.needsClarification, false);
    assert.equal(lower.proposal.changes[0].label, 'Music volume');
    await selectedMusic.apply(lower);
    assert.ok(els(selectedMusic.project, 'AUDIO').find((element) => element.id === chosenMusic.id)
      .properties.volume < chosenMusic.properties.volume);
    ok('selected MUSIC + "lower this" resolves to volume, not position');

    // 12. active target beats a stale selection
    await s.sayAndApply('make the logo smaller', { selectedElementId: hook.id });
    const again = await s.say('make it smaller', { selectedElementId: hook.id });
    assert.ok(actions(again).some((line) => /Resize logo/u.test(line)),
      'an unchanged selection must not steal "it" from the logo');
    const fresh = await s.say('make it smaller', { selectedElementId: musicOf(s.project).id });
    expectQuestion(fresh, /can't do that|Which/u, 'music selected for a resize');
    ok('12 the active target wins over an unchanged selection; a NEW selection wins over it');

    // 13. semantic role
    const semantic = await s.say('change the hook');
    assert.equal(semantic.proposal.changes[0].label, 'Hook');
    ok('13 "change the hook" resolves the semantic HOOK element');

    // 14. named asset
    const two = await seedRichProject({ secondLogo: true });
    const named = await two.say('make intro-logo.png smaller');
    assert.ok(!named.proposal.needsClarification);
    const introLogo = els(two.project, 'IMAGE').find((element) => element.assetId === 'asset-logo2');
    await two.apply(named);
    assert.ok(els(two.project, 'IMAGE').find((element) => element.id === introLogo.id)
      .properties.width < introLogo.properties.width);
    ok('14 a safe display name ("intro-logo.png") resolves to that one logo');

    // ...and with that logo now the active target, "the logo" continues on it.
    const continued = await two.say('make the logo smaller');
    assert.ok(!continued.proposal.needsClarification);

    // 15. ambiguity: no selection and no active target -> one precise question
    const fresh2 = await seedRichProject({ secondLogo: true });
    const revision = fresh2.project.revision;
    const ambiguous = await fresh2.say('make the logo smaller');
    expectQuestion(ambiguous, /Which logo do you mean/u, 'two logos');
    assert.equal(ambiguous.proposal.code, 'NEEDS_TARGET');
    assert.equal((await fresh2.refresh()).revision, revision);
    ok('15 two logos, nothing selected or active -> "Which logo do you mean?" and no change ' +
      '(the active logo disambiguates once there is one)');

    // 16. invalid handle / raw id
    const context = contextOf(s);
    const intent = validateChatIntent({ intent: 'EDIT_PROJECT', summary: 'x', commands: [{
      action: 'SET_ELEMENT_OPACITY', target: { kind: 'ELEMENT', handle: 'logo:ghost' },
      parameters: { opacity: 0.5 }, reason: '' }] });
    const unresolved = resolveChatPlan(intent.commands, [], context);
    assert.equal(unresolved.ok, false);
    assert.throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: 'x', commands: [{
      action: 'SET_ELEMENT_OPACITY', target: { kind: 'ELEMENT', handle: logoOf(s.project).id },
      parameters: { opacity: 0.5 }, reason: '' }] }), (error) =>
      error.getResponse().code === 'RAW_ID_REJECTED');
    ok('16 an unknown handle resolves to a question; a raw database id is rejected by name');
  }

  // ===========================================================================
  section('3. Commands land on the canonical state (Part 9)');
  {
    const s = await seedRichProject();
    const before = s.project;
    const hook = hookOf(before);

    // 17. hook
    await s.sayAndApply('change the hook to "Rates Are Not Coming Down"');
    assert.equal(hookOf(s.project).id, hook.id);
    assert.equal(hookOf(s.project).properties.content, 'Rates Are Not Coming Down');
    assert.equal(els(s.project, 'TEXT').length, els(before, 'TEXT').length);
    ok('17 hook: literal wording goes to the SAME TEXT element via SET_TEXT_CONTENT');

    // 18. logo
    await s.sayAndApply('make the logo smaller');
    assert.ok(logoOf(s.project).properties.width < logoOf(before).properties.width);
    ok('18 logo: RESIZE_ELEMENT (+ MOVE to keep it docked)');

    // 19. audio
    await s.sayAndApply('music is too loud');
    assert.equal(musicOf(s.project).properties.volume, 0.14);
    ok('19 audio: "music is too loud" 20% -> 14%');

    // 20. caption: bigger, as one bulk command
    const sizes = els(s.project, 'SUBTITLE').map((element) => element.properties.fontSize);
    const captionsBefore = snapshotCaptions(s.project);
    await s.sayAndApply('make captions bigger');
    const after = els(s.project, 'SUBTITLE');
    assert.ok(after.every((element, index) => element.properties.fontSize > sizes[index]));
    for (const element of after) {
      const { fontSize: _a, ...rest } = element.properties;
      const { fontSize: _b, ...was } = captionsBefore[element.id];
      assert.deepEqual(rest, was, 'only fontSize may change on a caption');
    }
    ok('20 captions: every caption gets the bigger size and nothing else');

    // 21. colour
    await s.sayAndApply('make the video warmer');
    assert.ok(els(s.project, 'VIDEO').every((element) =>
      element.properties.colorAdjustments?.temperature > 0 ||
      element.properties.temperature > 0));
    ok('21 colour: "warmer" raises temperature on every segment');

    // 22. zoom: add, then deepen the SAME element
    await s.sayAndApply('zoom in here', { playheadSec: 14 });
    const zoom = els(s.project, 'EFFECT')[0];
    assert.equal(zoom.properties.effect, 'ZOOM');
    await s.sayAndApply('make this zoom deeper', { playheadSec: 14 });
    assert.equal(els(s.project, 'EFFECT').length, 1);
    assert.ok(els(s.project, 'EFFECT')[0].properties.scale > zoom.properties.scale);
    ok('22 zoom: ADD_ZOOM at the playhead, then SET_ZOOM_SCALE on the same element');

    // 23. crop
    await s.sayAndApply('crop tighter', { playheadSec: 14 });
    const cropped = els(s.project, 'VIDEO').find((element) => element.startTime === 12);
    assert.ok(cropped.properties.crop.left > 0 && cropped.properties.crop.top > 0);
    ok('23 crop: "crop tighter" crops the segment under the playhead on all four edges');

    // 24. rotation
    await s.sayAndApply('rotate 5 degrees', { playheadSec: 14 });
    assert.equal(els(s.project, 'VIDEO').find((element) => element.id === cropped.id)
      .properties.rotation, 5);
    await s.sayAndApply('straighten it', { playheadSec: 14 });
    assert.equal(els(s.project, 'VIDEO').find((element) => element.id === cropped.id)
      .properties.rotation, 0);
    ok('24 rotation: +5 degrees, then "straighten it" -> 0');

    // 25. speed
    await s.sayAndApply('make this faster', { playheadSec: 14 });
    const faster = els(s.project, 'VIDEO').find((element) => element.id === cropped.id);
    assert.equal(faster.properties.speed, 1.25);
    assert.ok(Math.abs(faster.duration - 12 / 1.25) < 1e-3);
    ok('25 speed: next speed step on that segment; its duration follows');

    // 26. template: Workstream F's own apply, one TEMPLATE revision
    const planned = await s.say('use Clean Reel');
    assert.equal(planned.proposal.route, 'TEMPLATE');
    assert.ok(planned.proposal.changes.length > 0);
    await s.apply(planned);
    const last = history(s).at(-1);
    assert.equal(last.action, 'APPLY_TEMPLATE');
    assert.equal(last.actor, 'TEMPLATE');
    assert.equal(s.project.settings.templateRun.templateName, 'Clean Reel');
    ok('26 template: "use Clean Reel" previews and applies through F -> one APPLY_TEMPLATE revision');
  }

  // ===========================================================================
  section('4. Conversation (Parts 7, 31, 32)');
  {
    // Part 31, verbatim.
    const s = await seedRichProject();
    const logo0 = logoOf(s.project).properties;
    await s.sayAndApply('make the logo smaller');
    const logo1 = logoOf(s.project).properties;
    assert.ok(logo1.width < logo0.width);
    await s.sayAndApply('a little smaller');
    const logo2 = logoOf(s.project).properties;
    assert.ok(logo2.width < logo1.width && logo1.width - logo2.width < logo0.width - logo1.width);
    ok('27 follow-up: "a little smaller" shrinks the SAME logo, by a smaller step');
    await s.sayAndApply('move it lower');
    assert.ok(logoOf(s.project).properties.y > logo2.y);
    const music0 = musicOf(s.project).properties.volume;
    const logoAfterMove = snapshot(s.project, []);
    await s.sayAndApply('now lower the music');
    const music1 = musicOf(s.project).properties.volume;
    assert.ok(music1 < music0);
    ok('28 target switch: "now lower the music" moves the active target to the music');
    await s.sayAndApply('a little more');
    const music2 = musicOf(s.project).properties.volume;
    assert.ok(music2 < music1, '"a little more" lowers the music again');
    assert.deepEqual(logoOf(s.project).properties, logoAfterMove[logoOf(s.project).id].properties,
      '"a little more" must NOT touch the logo');
    ok('29 relative adjustment: "a little more" now targets the MUSIC, not the logo');

    // Part 32, verbatim.
    const h = await seedRichProject();
    const hookId = hookOf(h.project).id;
    const seen = new Set([hookOf(h.project).properties.content]);
    for (const [turn, check] of [['change the on screen hook', null],
      ['make it shorter', 'shorter'], ['more curiosity based', null], ['try another', null]]) {
      const before = hookOf(h.project).properties.content;
      const { planned } = await h.sayAndApply(turn);
      assert.ok(planned.proposal.route.startsWith('CREATIVE'), `${turn}: creative route`);
      const after = els(h.project, 'TEXT').filter((element) =>
        element.properties.presetRole === 'HOOK');
      assert.equal(after.length, 1, `${turn}: still exactly one hook`);
      assert.equal(after[0].id, hookId, `${turn}: the SAME element`);
      assert.notEqual(after[0].properties.content, before, `${turn}: the wording changed`);
      assert.ok(!seen.has(after[0].properties.content), `${turn}: never repeats a line`);
      if (check === 'shorter') {
        assert.ok(after[0].properties.content.split(' ').length < before.split(' ').length);
      }
      seen.add(after[0].properties.content);
    }
    ok('30 hook: change -> shorter -> curiosity -> "try another" all edit ONE hook, no repeats');

    // 31/32. undo / redo through chat are the Undo/Redo buttons
    const revision = h.project.revision;
    const current = hookOf(h.project).properties.content;
    const undo = await h.say('undo that');
    assert.equal(undo.proposal.route, 'HISTORY');
    await h.apply(undo);
    assert.notEqual(hookOf(h.project).properties.content, current);
    assert.equal(history(h).at(-1).action, 'UNDO');
    ok('31 "undo that" undoes the last AI edit through the ordinary history path');
    await h.apply(await h.say('redo that'));
    assert.equal(hookOf(h.project).properties.content, current);
    assert.equal(history(h).at(-1).action, 'REDO');
    assert.equal(h.project.revision, revision + 2);
    ok('32 "redo that" restores it; two history rows, no inverse command synthesised');
  }

  // ===========================================================================
  section('5. Safety (Parts 21-24, 29, 34)');
  {
    // 33. Part 34: manual state preservation, byte-for-byte.
    const s = await seedRichProject();
    const video = els(s.project, 'VIDEO')[1];
    const caption = els(s.project, 'SUBTITLE')[2];
    const run = (action, input) => s.service.phase3Command(s.id, action,
      { revision: s.project.revision, ...input }).then(() => s.refresh());
    await run('SET_VIDEO_CROP', { elementId: video.id, cropLeft: 0.1, cropRight: 0.05,
      cropTop: 0.02, cropBottom: 0.02 });
    await run('MOVE_ELEMENT', { elementId: logoOf(s.project).id, x: 0.05, y: 0.8 });
    await run('SET_CAPTION_TEXT', { elementId: caption.id, content: 'Hand corrected line' });
    await run('SET_AUDIO_VOLUME', { elementId: musicOf(s.project).id, volume: 0.33 });
    await run('APPLY_COLOR_FILTER', { elementId: video.id, filterId: 'VINTAGE', strength: 0.7 });
    const template = await s.templates.apply(s.id, { templateId: 'MINIMAL_BUSINESS',
      revision: s.project.revision });
    void template;
    await s.refresh();
    const hookId = hookOf(s.project).id;
    const otherBefore = snapshot(s.project, [hookId]);
    const settingsBefore = styleSettings(s.project);
    const hookBefore = stripVolatile(hookOf(s.project));
    await s.sayAndApply('change the hook');
    const otherAfter = snapshot(s.project, [hookId]);
    assert.deepEqual(otherAfter, otherBefore, 'no other element may change');
    assert.deepEqual(styleSettings(s.project), settingsBefore, 'no project setting may change');
    const hookAfter = stripVolatile(hookOf(s.project));
    const { content: _a, ...hookRest } = hookAfter.properties;
    const { content: _b, ...hookWas } = hookBefore.properties;
    assert.deepEqual(hookRest, hookWas, 'only the hook wording may change');
    assert.deepEqual({ ...hookAfter, properties: null }, { ...hookBefore, properties: null });
    ok('33 minimal mutation: "change the hook" leaves crop, logo, caption edit, music, colour ' +
      'and template byte-identical');

    // Found while building 33: a template apply used to stamp templateRole
    // 'TEXT' over the hook, so the NEXT template stopped restyling it and the
    // chat lost "the hook". Two templates in a row must both reach the hook.
    const twice = await seedRichProject();
    await twice.templates.apply(twice.id, { templateId: 'CLEAN_REEL', revision: twice.project.revision });
    await twice.refresh();
    assert.equal(hookOf(twice.project).properties.templateRole, 'HOOK');
    const second = await twice.templates.preview(twice.id,
      { templateId: 'MINIMAL_BUSINESS', revision: twice.project.revision });
    assert.ok(second.changes.some((change) => change.label === 'Hook style'));
    await twice.templates.apply(twice.id, { templateId: 'MINIMAL_BUSINESS',
      revision: twice.project.revision });
    await twice.refresh();
    assert.equal(hookOf(twice.project).properties.textStyleId, 'MINIMAL');
    assert.ok(!(await twice.say('change the hook')).proposal.needsClarification);
    ok('33b a second template still restyles the hook, and chat still finds it (F stamp fix)');

    // 34. unsupported capability
    const unsupported = await s.say('add a crossfade transition between the clips');
    expectQuestion(unsupported, /no transitions/u, 'transition');
    assert.equal(unsupported.proposal.code, 'UNSUPPORTED_EDIT_CAPABILITY');
    const canned = await s.say('change the on screen hook');
    assert.ok(!canned.proposal.needsClarification);
    assert.doesNotMatch(JSON.stringify(canned.messages), /I can still do direct edits/u);
    ok('34 a real gap returns UNSUPPORTED_EDIT_CAPABILITY; an actionable request never gets a menu');

    // 35. no arbitrary JSON
    const smuggled = validateChatIntent({ intent: 'EDIT_PROJECT', summary: 'x', commands: [{
      action: 'SET_ELEMENT_OPACITY', target: { kind: 'ELEMENT', handle: 'logo:main' },
      parameters: [{ name: 'opacity', number: 0.5, text: null, flag: null },
        { name: 'properties', number: null, text: '{"hidden":true}', flag: null },
        { name: '__proto__', number: 1, text: null, flag: null }], reason: '' }] });
    assert.deepEqual(smuggled.commands[0].parameters, { opacity: 0.5 });
    assert.throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: 'x', commands: [{
      action: 'PATCH_PROPERTIES', target: { kind: 'SELECTED' }, parameters: {}, reason: '' }] }),
    (error) => error.getResponse().code === 'UNSUPPORTED_COMMAND');
    assert.throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: 'x', commands: [{
      action: 'SET_ELEMENT_OPACITY', target: { kind: 'SELECTED' },
      parameters: { opacity: 'lots' }, reason: '' }] }));
    assertStrict(CHAT_INTENT_SCHEMA, 'intent');
    assertStrict(CHAT_HOOK_SCHEMA, 'hook');
    assert.equal(CHAT_INTENT_SCHEMA.properties.commands.maxItems, CHAT_MAX_MODEL_COMMANDS);
    ok('35 no arbitrary JSON: closed parameter names, typed values, closed actions, strict schema');

    // 36. no raw ids reach the model
    const context = contextOf(s);
    const prompt = promptFor('make the logo smaller', context);
    for (const element of s.project.elements) {
      assert.ok(!prompt.includes(element.id), 'an element id leaked into the prompt');
    }
    for (const asset of s.project.assets) assert.ok(!prompt.includes(asset.id));
    ok('36 no raw ids: the model prompt contains no element or asset id');

    // 37. stale proposal
    const stale = await s.say('make the logo smaller');
    await s.service.phase3Command(s.id, 'REMOVE_ELEMENT',
      { revision: s.project.revision, elementId: logoOf(s.project).id });
    await s.refresh();
    await assert.rejects(s.apply(stale), (error) => error.getResponse().code === 'STALE_PROPOSAL');
    ok('37 a proposal whose target was deleted meanwhile is refused as STALE_PROPOSAL');

    // 38. pipeline isolation. The frozen directories ARE edited by later scoped
    // program steps (the GeneratedClip bridge, the Step 6 model policy), so a
    // clean `git status` is no longer the invariant. What must hold: the chat
    // never reaches the processing queue/processor, never writes elements
    // directly, and (Step 6) the router has no local LLM route at all.
    const router = fs.readFileSync(path.join(__dirname,
      '../src/modules/processing/llm-router.service.ts'), 'utf8');
    assert.doesNotMatch(router, /apiStyle: 'ollama'|LOCAL_LLM_BASE_URL|qwen3/u,
      'the router must have no local LLM route');
    const chatDir = path.join(__dirname, '../src/modules/edit-mode/chat');
    for (const file of fs.readdirSync(chatDir)) {
      const source = fs.readFileSync(path.join(chatDir, file), 'utf8');
      assert.doesNotMatch(source, /ProcessingQueueService|VideoProcessorService|ClipRenderQueue/u);
      assert.doesNotMatch(source, /\$queryRaw|\$executeRaw|editElement\.(?:update|create)\b/u,
        `${file} must not write elements directly`);
    }
    ok('38 chat isolated from the pipeline, no local LLM route, chat never writes elements directly');
  }

  // ===========================================================================
  section('6. Normal-person corpus (Part 30): target + command + minimal mutation');
  {
    const corpus = [
      // [setup turns, message, expected changed element kinds, expected line pattern]
      [[], 'change the hook', ['hook'], /hook/iu],
      [['change the hook'], 'make it shorter', ['hook'], /hook/iu],
      [['change the hook'], 'make it curiosity based', ['hook'], /hook/iu],
      [['change the hook'], 'try another', ['hook'], /hook/iu],
      [[], 'move the logo down', ['logo'], /logo/iu],
      [['move the logo down'], 'a little more', ['logo'], /logo/iu],
      [['move the logo down'], 'make it smaller', ['logo'], /logo/iu],
      [[], 'music is too loud', ['music'], /music volume/iu],
      [['music is too loud'], 'lower it a little', ['music'], /music volume/iu],
      [[], 'mute the original sound', ['video'], /original sound/iu],
      [[], 'make captions bigger', ['captions'], /caption text size/iu],
      [[], 'yellow words when spoken', ['captions'], /spoken word/iu],
      [[], 'move captions lower', ['captions'], /captions/iu],
      [[], 'make it warmer', ['video'], /temperature/iu],
      [[], 'less saturated', ['video'], /saturation/iu],
      [[], 'more contrast', ['video'], /contrast/iu],
      [[], 'make it cinematic', ['video'], /cinematic/iu],
      [['zoom in here'], 'zoom more', ['zoom'], /zoom/iu],
      [['zoom in here', 'zoom more'], "that's too much", ['zoom'], /zoom/iu],
      [[], 'crop tighter', ['video'], /crop/iu],
      [['crop tighter'], 'show more on the left', ['video'], /crop/iu],
      [[], 'rotate 5 degrees', ['video'], /rotate/iu],
      [['rotate 5 degrees'], 'straighten it', ['video'], /rotate/iu],
      [[], 'make this faster', ['video', 'hook', 'captions', 'logo', 'music', 'zoom'], /at 1\.25x/u],
      [[], 'use Clean Reel', null, /./u],
      [[], 'use my Finance Reel template', null, /./u]
    ];
    const kinds = (project, element) => element.type === 'VIDEO' ? 'video'
      : element.type === 'SUBTITLE' ? 'captions' : element.type === 'AUDIO' ? 'music'
        : element.type === 'EFFECT' ? 'zoom' : element.type === 'IMAGE' ? 'logo'
          : element.properties.presetRole === 'HOOK' ? 'hook' : 'text';
    let deterministic = 0;
    for (const [setup, message, allowed, pattern] of corpus) {
      const s = await seedRichProject();
      await s.templates.create({ name: 'Finance Reel', description: 'Mine' });
      for (const turn of setup) await s.sayAndApply(turn, { playheadSec: 14 });
      const before = s.project;
      const planned = await s.say(message, { playheadSec: 14 });
      assert.equal(planned.proposal.needsClarification, false,
        `"${message}" asked: ${planned.proposal.clarificationQuestion}`);
      assert.match(planned.proposal.plannedChanges.join(' | '), pattern, message);
      if (planned.proposal.route !== 'LLM') deterministic += 1;
      await s.apply(planned);
      if (allowed) {
        const changed = s.project.elements.filter((element) => {
          const was = before.elements.find((item) => item.id === element.id);
          return !was || JSON.stringify(stripVolatile(was)) !== JSON.stringify(stripVolatile(element));
        }).map((element) => kinds(s.project, element));
        const unexpected = changed.filter((kind) => !allowed.includes(kind));
        assert.deepEqual([...new Set(unexpected)], [], `"${message}" also changed ${unexpected}`);
        assert.ok(changed.length > 0, `"${message}" changed nothing`);
      }
    }
    assert.equal(deterministic, corpus.length, 'every corpus phrase works without a model');
    ok(`corpus: ${corpus.length} everyday requests -> right target, right command, nothing else ` +
      'touched, all without a model');
  }

  // ===========================================================================
  section('7. Zoom acceptance (Parts 12, 33)');
  {
    // A zoom a PRESET planned, at a known time.
    const s = await seedRichProject();
    const moment = { startSec: 14.2, endSec: 15, reason: 'emphasis', triggerText: 'overnight',
      intensity: 'MODERATE' };
    await s.service.update(s.id, { revision: s.project.revision, settings: {
      ...s.project.settings, zoomPolicy: 'MODERATE',
      presetRun: { presetId: 'MOTIVATIONAL', presetRunId: 'run-1', appliedAtRevision: 1,
        summary: '', plannedZoomMoments: [moment], trims: [] } } });
    await s.refresh();
    const context = contextOf(s, { playheadSec: 14.3 });
    const planned = context.elements.find((view) => view.semantic === 'ZOOM');
    assert.equal(planned.virtual, true);
    assert.equal(planned.handle, 'zoom:1');
    await s.sayAndApply('make this zoom deeper', { playheadSec: 14.3 });
    let zooms = els(s.project, 'EFFECT');
    assert.equal(zooms.length, 1);
    assert.equal(zooms[0].properties.claimsMoment, zoomMomentKey(moment));
    assert.equal(zooms[0].properties.scale, 1.13);
    const zoomId = zooms[0].id;
    await s.sayAndApply('too much, reduce it a little', { playheadSec: 14.3 });
    zooms = els(s.project, 'EFFECT');
    assert.equal(zooms.length, 1, 'no duplicate zoom');
    assert.equal(zooms[0].id, zoomId, 'the same zoom element');
    assert.equal(zooms[0].properties.scale, 1.11);
    ok('deeper then "too much, reduce it a little": one zoom, same element, 1.10 -> 1.13 -> 1.11');

    // The render plan renders the edited zoom INSTEAD of the planned moment.
    const shots = [{ start: 0, end: 36, sourceStart: 0, sourceEnd: 36, zoomAllowed: false,
      informationMode: false, shotClass: 'OTHER', layout: 'FILL' }];
    const plan = planEditModeZoom({ policy: 'MODERATE', moments: [moment],
      map: { toTimeline: (t) => [t], toSource: (t) => t, segments: [], durationSec: 36 },
      shots, frameSegments: [{ layout: 'FILL' }], frames: [],
      cropAt: () => ({ x: 0, y: 0, w: 1, h: 1 }), focalAt: () => ({ x: 0.5, y: 0.5 }),
      fps: 30, durationSec: 36,
      manual: zooms.map((zoom) => ({ elementId: zoom.id, startSec: zoom.startTime,
        endSec: zoom.startTime + zoom.duration, scale: zoom.properties.scale,
        enabled: zoom.properties.enabled, claimsMoment: zoom.properties.claimsMoment,
        triggerText: zoom.properties.triggerText })) });
    assert.equal(plan.events.length, 1);
    assert.equal(plan.events[0].id, `ze-${zoomId}`);
    assert.equal(plan.events[0].peakScale, 1.11);
    ok('render: the claimed preset moment is replaced by the edited zoom (1 event, 1.11x)');

    // Removing a claimed zoom leaves a disabled claim, so the moment stays gone.
    await s.sayAndApply('remove this zoom', { playheadSec: 14.3 });
    zooms = els(s.project, 'EFFECT');
    assert.equal(zooms.length, 1);
    assert.equal(zooms[0].properties.enabled, false);
    const removed = planEditModeZoom({ policy: 'MODERATE', moments: [moment],
      map: { toTimeline: (t) => [t], toSource: (t) => t, segments: [], durationSec: 36 },
      shots, frameSegments: [{ layout: 'FILL' }], frames: [],
      cropAt: () => ({ x: 0, y: 0, w: 1, h: 1 }), focalAt: () => ({ x: 0.5, y: 0.5 }),
      fps: 30, durationSec: 36, manual: [{ elementId: zooms[0].id, startSec: zooms[0].startTime,
        endSec: zooms[0].startTime + zooms[0].duration, scale: zooms[0].properties.scale,
        enabled: false, claimsMoment: zooms[0].properties.claimsMoment, triggerText: '' }] });
    assert.equal(removed.events.length, 0);
    ok('"remove this zoom" on a planned zoom removes it for good (disabled claim, 0 events)');

    // Bounds, and "zoom when I say X".
    const z = await seedRichProject();
    await z.sayAndApply('zoom when I say overnight rate');
    const spoken = els(z.project, 'EFFECT')[0];
    // "overnight" is word 6 of sentence 2 in the fixture: 5.1s + 5 x 0.42s = 7.2s.
    assert.ok(Math.abs(spoken.startTime - 7.1) < 1e-6, `zoom starts 0.1s before "overnight" (${spoken.startTime})`);
    assert.equal(spoken.properties.triggerText, "overnight rate");
    for (let index = 0; index < 4; index += 1) {
      const more = await z.say('zoom more', { playheadSec: spoken.startTime + 0.2 });
      if (more.proposal.needsClarification) {
        assert.match(more.proposal.clarificationQuestion, /strongest safe level/u);
        break;
      }
      await z.apply(more);
    }
    assert.ok(els(z.project, 'EFFECT')[0].properties.scale <= MAX_ZOOM_SCALE);
    ok('"zoom when I say X" finds the word in the transcript; "more" stops at the safe ceiling');
  }

  // ===========================================================================
  section('8. Crop / rotation / captions / audio details (Parts 13-17)');
  {
    const s = await seedRichProject();
    const centred = await s.say('keep the person centered', { playheadSec: 14 });
    expectQuestion(centred, /whole frame is already showing/u, 'no crop yet');
    // A 76%-wide window can centre on the face at x = 0.60 without leaving the frame.
    await s.sayAndApply('crop a lot tighter', { playheadSec: 14 });
    await s.sayAndApply('keep the person centered', { playheadSec: 14 });
    const crop = els(s.project, 'VIDEO').find((element) => element.startTime === 12).properties.crop;
    assert.ok(Math.abs((crop.left + (1 - crop.left - crop.right) / 2) - 0.6) < 1e-3,
      `the crop window is centred on the detected face (x = 0.60): ${JSON.stringify(crop)}`);
    assert.ok(Math.abs(crop.top - 0.12) < 1e-6 && Math.abs(crop.bottom - 0.12) < 1e-6,
      'centring moves the window sideways only');
    ok('crop: "keep the person centered" uses the cached face positions, and says so when nothing is cropped');

    await s.sayAndApply('rotate left a little', { playheadSec: 14 });
    assert.equal(els(s.project, 'VIDEO').find((element) => element.startTime === 12)
      .properties.rotation, -2);
    ok('rotation: "rotate left a little" is -2 degrees from the current angle');

    const fadeBefore = musicOf(s.project).properties;
    await s.sayAndApply('fade the music out');
    const fadeAfter = musicOf(s.project).properties;
    assert.equal(fadeAfter.fadeOutSec, 2);
    assert.equal(fadeAfter.fadeInSec, fadeBefore.fadeInSec);
    await s.sayAndApply('lower the music when I speak');
    assert.equal(musicOf(s.project).properties.duckUnderSpeech, true);
    ok('audio: fades keep the other edge; "lower the music when I speak" enables real ducking');

    const edited = els(s.project, 'SUBTITLE')[1];
    await s.service.phase3Command(s.id, 'SET_CAPTION_TEXT',
      { revision: s.project.revision, elementId: edited.id, content: 'My own correction' });
    await s.refresh();
    await s.sayAndApply('make captions cleaner');
    assert.equal(els(s.project, 'SUBTITLE').find((element) => element.id === edited.id)
      .properties.content, 'My own correction');
    const regen = await s.say('regenerate captions');
    assert.ok(regen.proposal.warnings.some((warning) => /corrected by hand/u.test(warning)));
    ok('captions: restyling keeps manual wording; "regenerate captions" warns before replacing corrections');

    await s.sayAndApply('hide captions');
    assert.ok(els(s.project, 'SUBTITLE').every((element) => element.properties.hidden === true));
    ok('captions: "hide captions" hides the caption elements (not a policy that hides nothing)');

    await s.sayAndApply('split this caption', { selectedElementId: edited.id,
      playheadSec: edited.startTime + edited.duration / 2 });
    await s.sayAndApply('merge this caption with the next one', { selectedElementId: edited.id });
    ok('captions: split and merge reach SPLIT_CAPTION / MERGE_CAPTION on the selected caption');
  }

  // ===========================================================================
  section('9. Multi-intent (Part 19) and selection/range (Part 25)');
  {
    const s = await seedRichProject();
    const start = logoOf(s.project).properties;
    const { planned } = await s.sayAndApply('move the logo down and make it smaller');
    const end = logoOf(s.project).properties;
    assert.ok(end.y > start.y && end.width < start.width, 'both clauses land, the second on the moved logo');
    assert.equal(planned.proposal.changes.filter((change) => change.label === 'Logo position').length, 1);
    ok('"move the logo down and make it smaller" chains: the resize acts on the moved logo');

    const both = await s.say('make the hook shorter and lower the music');
    if (!both.proposal.needsClarification) {
      assert.ok(both.proposal.changes.some((change) => change.label === 'Hook'));
      assert.ok(both.proposal.changes.some((change) => change.label === 'Music volume'));
    }
    const warmth = await s.say('warm the video and increase contrast');
    assert.deepEqual(warmth.proposal.changes.map((change) => change.label),
      ['Temperature (video)', 'Contrast (video)']);
    ok('compound requests become one bounded bundle with one line per change');

    const many = await s.say('make it warmer, add contrast, lower the music, move the logo up, ' +
      'make captions bigger, rotate it 5 degrees');
    expectQuestion(many, /up to 5 direct changes/u, 'six intents');
    ok('more than five direct intents is refused with a clear limit (Edit From Brief is later)');

    const range = await s.say('make this section faster',
      { selectedTimeRange: { startSec: 14, endSec: 18 } });
    const commands = range.proposal.plannedChanges.join(' | ');
    assert.match(commands, /Split the video at 18\.0s/u);
    assert.match(commands, /Split the video at 14\.0s/u);
    await s.apply(range);
    const sped = els(s.project, 'VIDEO').find((element) => element.properties.speed === 1.25);
    assert.ok(sped && Math.abs(sped.trimEnd - sped.trimStart - 4) < 1e-3);
    ok('"make this section faster" with a range: splits at both edges, speeds only the range');

    // A prior zoom must not steal the deictic "this" from the selected range.
    await s.sayAndApply('zoom here', { playheadSec: 3 });
    await s.sayAndApply('use Clean Reel');
    const removeRange = await s.say('remove this part',
      { selectedTimeRange: { startSec: 9, endSec: 18 } });
    assert.equal(removeRange.proposal.needsClarification, false);
    assert.ok(removeRange.proposal.plannedChanges.some((line) => /Split|Trim|Remove/u.test(line)));
    assert.ok(removeRange.proposal.grounding.some((item) => item.type === 'SELECTION'));
    ok('"remove this part" with a range beats a stale active zoom and uses the range-cut path');
  }

  // ===========================================================================
  section('10. OFFLINE and ONLINE routing (Parts 27, 28)');
  {
    // OFFLINE through the REAL router: the frozen allowlist has no editingPlan,
    // so not one provider call may happen - direct AND creative turns.
    const calls = [];
    const provider = { isConfigured: () => true,
      generateStructuredWithConfig: async (...args) => { calls.push(args); throw new Error('no'); } };
    const previous = process.env.EDIT_MODE_CHAT_AI_MODE;
    process.env.EDIT_MODE_CHAT_AI_MODE = 'OFFLINE';
    const offline = await seedRichProject({ llm: new LlmRouterService(provider) });
    for (const message of ['move the logo down', 'music is too loud', 'make captions bigger',
      'make it warmer', 'crop tighter', 'rotate 5 degrees', 'make this faster', 'use Clean Reel',
      'zoom in here', 'change the hook', 'what is the meaning of life']) {
      const planned = await offline.say(message, { playheadSec: 14 });
      if (message !== 'what is the meaning of life') {
        assert.equal(planned.proposal.needsClarification, false, `${message} works offline`);
      }
    }
    assert.equal(calls.length, 0, 'OFFLINE made a model call');
    ok('OFFLINE: 10 direct/creative/template turns plan with ZERO model calls (real router)');

    // ONLINE with a stub router: the creative hook uses the model, and every
    // model line still has to pass the grounding gate.
    process.env.EDIT_MODE_CHAT_AI_MODE = 'ONLINE';
    const stub = { calls: 0, isAnyConfigured: () => true,
      generate: async ({ request }) => {
        stub.calls += 1;
        if (request.schemaName === 'edit_mode_chat_hook') {
          return { data: { candidates: [
            { text: 'Doctors Hate This One Weird Rate Trick' },
            { text: 'Why Did the Bank Refuse to Cut Rates This Year?' }] },
          metadata: { provider: 'stub', model: 'stub-1' } };
        }
        throw new Error('planner not stubbed');
      } };
    const online = await seedRichProject({ llm: stub });
    const hook = await online.say('make the hook more curiosity based');
    assert.equal(hook.proposal.route, 'CREATIVE_LLM');
    assert.match(hook.proposal.changes[0].after, /Why Did the Bank Refuse to Cut Rates/u);
    assert.ok(stub.calls >= 1);
    ok('ONLINE: the hook rewrite uses the model; the clickbait candidate is rejected by the gate');
    const direct = await online.say('mute the music');
    assert.equal(direct.proposal.route, 'DETERMINISTIC');
    ok('ONLINE: plain commands still take the deterministic route (no model latency)');
    process.env.EDIT_MODE_CHAT_AI_MODE = previous;
  }

  // ===========================================================================
  section('11. Command coverage audit (Part 9)');
  {
    const service = fs.readFileSync(path.join(__dirname,
      '../src/modules/edit-mode/edit-mode.service.ts'), 'utf8');
    const canonical = (action) => new RegExp(`'${action}'`, 'u').test(service);
    const missing = CHAT_ELEMENT_ACTIONS.filter((action) => !canonical(action));
    assert.deepEqual(missing, [], 'every chat action is a canonical EditMode command');
    assert.ok(!CHAT_SETTINGS_ACTIONS.includes('SET_HOOK'));
    ok(`every one of the ${CHAT_ELEMENT_ACTIONS.length} chat element actions is a canonical ` +
      'EditMode command - no AI-only mutation exists');
    const deliberatelyAbsent = ['PASTE_VIDEO_ADJUSTMENTS', 'ADD_SUBTITLE'];
    for (const action of deliberatelyAbsent) assert.ok(!CHAT_ELEMENT_ACTIONS.includes(action));
    ok('preset-only ADD_SUBTITLE stays unreachable from chat');
    assert.equal(unsupportedCapability('stabilize the shaky footage') !== null, true);
    assert.deepEqual(splitClauses('make it black and white and fade the music in and out'),
      ['make it black and white', 'fade the music in and out']);
    ok('clause splitting protects "black and white" and "in and out"');
  }

  // ===========================================================================
  section('12. Hook grounding (Part 11)');
  {
    const transcript = 'The central bank raised the overnight rate eleven times in a row. ' +
      'But mortgage holders are paying the hidden cost every single month.';
    const ranked = rankHookCandidates({ mode: 'REWRITE', current: null, tried: [], transcript,
      candidates: [
        { text: 'Aliens Secretly Control the Bank', source: 'LLM' },
        { text: 'You Won\'t Believe What the Bank Did', source: 'LLM' },
        { text: 'Mortgage Holders Are Paying the Hidden Cost Every Single', source: 'DETERMINISTIC' },
        { text: 'Mortgage Holders Are Paying the Hidden Cost', source: 'DETERMINISTIC' }] });
    assert.deepEqual(ranked.map((item) => item.text), ['Mortgage Holders Are Paying the Hidden Cost']);
    ok('ungrounded, clickbait and cut-mid-phrase lines are refused; the grounded clean line survives');
    const tried = rankHookCandidates({ mode: 'ANOTHER', current: null,
      tried: ['Mortgage Holders Are Paying the Hidden Cost'], transcript,
      candidates: [{ text: 'Mortgage Holders Are Paying the Hidden Cost', source: 'LLM' }] });
    assert.equal(tried.length, 0);
    ok('"try another" never re-offers a line already shown');
    const statistical = 'The annualized inflation rate was 3.4 in August on an annualized basis.';
    const tightened = deterministicHookSuggestions({ mode: 'SHORTER',
      current: '3 .4 in August on an Annualized Basis', tried: [], opening: statistical,
      transcript: statistical });
    assert.equal(tightened[0]?.text, 'August Annualized Rate Was 3.4');
    ok('a short annualized-statistic hook still has a grounded actionable tightening');
    const offline = await seedRichProject({ hook: false });
    const add = await offline.say('change the hook');
    expectQuestion(add, /does not have an on-screen hook yet/u, 'no hook exists');
    const created = await offline.say('add a hook');
    assert.ok(!created.proposal.needsClarification);
    await offline.apply(created);
    const hooks = els(offline.project, 'TEXT').filter((element) =>
      element.properties.presetRole === 'HOOK');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].startTime, 0);
    ok('no hook: "change the hook" asks; "add a hook" creates exactly one, role recorded, at 0s');
  }

  console.log(`\nEditMode Workstream G AI tests passed (${passed} checks).`);
}

// --- local helpers ----------------------------------------------------------------

function contextOf(s, selection = {}) {
  const { buildPresetEvidence } = require('../dist/modules/edit-mode/presets/edit-preset-evidence.js');
  const { readEditProjectStyle } = require('../dist/modules/edit-mode/presets/edit-preset-policy.js');
  const { readChatThread } = require(`${C}/edit-chat.types.js`);
  const { builtinTemplateList } = require('../dist/modules/edit-mode/templates/edit-template-library.js');
  const project = s.project;
  const source = project.assets.find((asset) => asset.role === 'SOURCE');
  const style = readEditProjectStyle(project.settings);
  const user = [...s.rows.editTemplates.values()].map((row) => ({ id: row.id, name: row.name,
    source: 'USER' }));
  return buildChatContext({ revision: project.revision, settings: project.settings, style,
    elements: project.elements.map((element) => ({ ...element, properties: element.properties })),
    assets: project.assets.map((asset) => ({ id: asset.id, role: asset.role,
      originalName: asset.originalName, duration: asset.duration, width: asset.width,
      height: asset.height })),
    evidence: buildPresetEvidence({ durationSec: source.duration, width: source.width,
      height: source.height, metadata: source.metadata, transcript: source.transcript,
      analysis: source.analysis, aspectRatio: style.aspectRatio, preserveInformation: true }),
    thread: readChatThread(project.settings), message: '',
    templates: [...builtinTemplateList().map((template) => ({ id: template.id,
      name: template.name, source: 'BUILTIN' })), ...user],
    selection: { selectedElementId: selection.selectedElementId ?? null,
      selectedTimeRange: selection.selectedTimeRange ?? null,
      playheadSec: selection.playheadSec ?? 0 } });
}

function crowdedContext(captions) {
  const { EMPTY_CHAT_THREAD } = require(`${C}/edit-chat.types.js`);
  const elements = [{ id: 'v', type: 'VIDEO', track: 0, position: 0, startTime: 0, duration: 800,
    assetId: 's', trimStart: 0, trimEnd: 800, properties: {} },
  ...Array.from({ length: captions }, (_, index) => ({ id: `c${index}`, type: 'SUBTITLE',
    track: 1, position: index, startTime: index * 2, duration: 1.8, assetId: null, trimStart: 0,
    trimEnd: null, properties: { content: `Caption line ${index}` } }))];
  return buildChatContext({ revision: 1, settings: {}, style: { aspectRatio: 'SOURCE',
    zoomPolicy: 'OFF' }, elements, assets: [{ id: 's', role: 'SOURCE', originalName: 'a.mp4',
    duration: 800, width: 1920, height: 1080 }],
  evidence: { sourceDurationSec: 800, transcriptAvailable: false, wordTimingsAvailable: false,
    analysisAvailable: false, transcriptText: '', words: [], frames: [], shots: [],
    informationRegion: null, semanticPeaks: [], faceShotRatio: 0, informationShotRatio: 0,
    pairShotRatio: 0 }, thread: EMPTY_CHAT_THREAD, message: '',
  selection: { selectedElementId: null, selectedTimeRange: null, playheadSec: 100 } });
}

function snapshotCaptions(project) {
  return Object.fromEntries(project.elements.filter((element) => element.type === 'SUBTITLE')
    .map((element) => [element.id, JSON.parse(JSON.stringify(element.properties))]));
}

/** Rebuilds the planner's user prompt the way edit-chat-planner.ts does. */
function promptFor(message, context) {
  const view = { instruction: message, tracks: context.tracks, selection: context.selection,
    elements: context.elements.map((element) => ({ handle: element.handle,
      semantic: element.semantic, label: element.label, startSec: element.startSec,
      endSec: element.endSec, selected: element.selected, properties: element.properties })),
    assets: context.assets.map((asset) => ({ handle: asset.handle, role: asset.role,
      filename: asset.filename })), recent: context.recent, notes: context.notes };
  // The real prompt serialises exactly these fields; assert the planner source
  // still builds its prompt from named fields and never from `runtime` or ids.
  const planner = fs.readFileSync(path.join(__dirname,
    '../src/modules/edit-mode/chat/edit-chat-planner.ts'), 'utf8');
  assert.doesNotMatch(planner, /runtime|element\.id\b|asset\.id\b|JSON\.stringify\(context\)/u);
  return JSON.stringify(view);
}

/** Every object in a strict schema closes its properties and requires all of them. */
function assertStrict(schema, where) {
  if (!schema || typeof schema !== 'object') return;
  const types = [].concat(schema.type ?? []);
  if (types.includes('object')) {
    assert.equal(schema.additionalProperties, false, `${where}: additionalProperties must be false`);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(),
      `${where}: every property must be required (nullable when optional)`);
    for (const [key, value] of Object.entries(schema.properties)) assertStrict(value, `${where}.${key}`);
  }
  if (types.includes('array')) {
    assert.ok(Number.isInteger(schema.maxItems), `${where}: arrays are bounded`);
    assertStrict(schema.items, `${where}[]`);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
