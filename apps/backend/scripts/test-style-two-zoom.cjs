// Regression for the source19 acceptance failure: StyleTwo carried Automatic 1's 1.27 s punch-in.
//
// Root cause: StyleTwo's template had no ZOOM component, so the base edit's zoom events (Automatic 1's
// planner emits ~1.1-1.6 s envelopes) survived untouched instead of passing through the canonical
// phrase-timed emphasis policy (ZOOM_AUTOMATIC_2: 2.5-5 s, face-safe, spaced) that StyleOne uses.
// No providers, databases, servers or production writes.
process.env.EDIT_MODE_CHAT_PROPOSAL_REDIS = 'false';
process.env.EDIT_MODE_CHAT_AI_MODE = 'FALLBACK_ONLY';
const assert = require('node:assert/strict');
const { STYLE_TWO_ID: ID } = require('@ai-content-platform/shared/style-two.cjs');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { resolveCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-resolver');
const { compileCreativeStyle } = require('../dist/modules/edit-mode/styles/creative-style-commands');
const { buildRenderPlan } = require('../dist/modules/edit-mode/render/edit-mode-render-plan');
const { PHRASE_ZOOM_MIN_DURATION_SEC: MIN, PHRASE_ZOOM_MAX_DURATION_SEC: MAX } =
  require('../dist/modules/edit-mode/edit-mode-zoom-events');

/** The canonical automatic-zoom contract. Returns every violation (empty = compliant). */
function zoomPolicyViolations(zooms) {
  const found = [];
  const active = zooms.filter(z => z.enabled !== false).sort((a, b) => a.startSec - b.startSec);
  for (const z of active) {
    const length = z.endSec - z.startSec;
    if (length < MIN - 1e-6) found.push(`${z.startSec.toFixed(2)}s zoom lasts ${length.toFixed(3)}s (< ${MIN}s)`);
    if (length > MAX + 1e-6) found.push(`${z.startSec.toFixed(2)}s zoom lasts ${length.toFixed(3)}s (> ${MAX}s)`);
  }
  active.slice(1).forEach((z, i) => {
    if (z.startSec < active[i].endSec - 1e-6) found.push(`zooms at ${active[i].startSec.toFixed(2)}s and ${z.startSec.toFixed(2)}s overlap`);
  });
  return found;
}
const elementZooms = project => project.elements.filter(e => e.type === 'EFFECT' && e.properties.effect === 'ZOOM')
  .map(e => ({ startSec: e.startTime, endSec: e.startTime + e.duration, enabled: e.properties.enabled !== false }));
const addZoomCommands = compiled => compiled.commands.filter(c => c.action === 'ADD_ZOOM')
  .map(c => ({ start: c.payload.startTime, duration: c.payload.duration, scale: c.payload.scale, trigger: c.payload.triggerText }));

async function main() {
  // The checker itself must reject the exact source19 event.
  assert(zoomPolicyViolations([{ startSec: 5.7, endSec: 5.7 + 1.266667 }]).length > 0, 'a 1.267 s zoom violates the policy');
  assert(zoomPolicyViolations([{ startSec: 1, endSec: 2.2 }]).length > 0, 'a 1-2 s punch zoom violates the policy');
  assert(zoomPolicyViolations([{ startSec: 4, endSec: 6.5 }]).length === 0, 'a 2.5 s phrase zoom is compliant');
  assert(zoomPolicyViolations([{ startSec: 4, endSec: 6.5 }, { startSec: 6, endSec: 9 }]).length > 0, 'overlap is rejected');

  const fixture = await seedRichProject({ split: false });
  let project = await fixture.refresh();
  // The base (Automatic 1) edit's event, exactly as reconstructed from source19 telemetry.
  const legacy = await fixture.service.applyAssistantBundle(fixture.id, project.revision, {
    proposalId: 'legacy-zoom', summary: 'legacy zoom', userMessage: 'legacy zoom', actor: 'TEMPLATE_ACTION', onInvalid: 'FAIL',
    commands: [{ kind: 'ELEMENT', action: 'ADD_ZOOM', payload: { startTime: 5.7, duration: 1.266667, scale: 1.15,
      triggerText: 'humanity to be compensated', semanticReason: 'denied humanity emphasis' } }] });
  project = legacy.project;
  // A cropped (face-tracked) camera, as in the automatic flow: this is where emphasis zooms are rendered.
  project = (await fixture.service.applyAssistantBundle(fixture.id, project.revision, {
    proposalId: 'face-camera', summary: 'camera', userMessage: 'camera', actor: 'TEMPLATE_ACTION', onInvalid: 'FAIL',
    commands: [{ kind: 'SETTINGS', action: 'SET_AUTO_REFRAME', payload: { reframePolicy: 'FACE_FOCUSED', aspectRatio: '9:16' } }] })).project;
  const before = elementZooms(project);
  assert.equal(before.length, 1);
  assert(zoomPolicyViolations(before).length > 0, 'the inherited event violates the canonical policy');

  // StyleZero (no creative template) keeps the base edit's zoom exactly: nothing global changed.
  const unstyled = buildRenderPlan({ project, assets: project.assets, elements: project.elements }).plan;
  for (const event of unstyled.zoomEvents) assert(event.endSec - event.startSec < MIN, 'unstyled/StyleZero renderer path is untouched');

  const { context } = await fixture.chat.loadContext(fixture.id, 'StyleTwo', {});
  const hooks = { hookOptions: [{ text: 'Why are rates still high?' }], hasWordTimings: true };
  const two = compileCreativeStyle(resolveCreativeStyle({ templateId: ID }), context, hooks);
  const one = compileCreativeStyle(resolveCreativeStyle({ templateId: 'AUTOMATIC_2' }), context, hooks);
  assert(two.commands.some(c => c.action === 'REMOVE_ZOOM'), 'inherited punch-ins are replaced, not kept');
  const twoZooms = addZoomCommands(two);
  assert(twoZooms.length > 0, 'the fixture has a qualifying emphasis phrase (the test is not vacuous)');
  assert.deepEqual(twoZooms, addZoomCommands(one), 'StyleTwo consumes StyleOne\'s canonical zoom decisions');
  for (const zoom of twoZooms) assert(zoom.duration >= MIN && zoom.duration <= MAX, `${zoom.duration}s`);

  // Renderability: a candidate whose envelope straddles a real cut would be dropped by the renderer (preview would
  // play it, export would not). The compiler asks the renderer's own planner and never emits it.
  const cut = twoZooms[0].start + 1;
  const straddling = { ...context, runtime: { ...context.runtime, shotBoundaries: [cut] } };
  const dropped = compileCreativeStyle(resolveCreativeStyle({ templateId: ID }), straddling, hooks);
  assert(dropped.commands.some(c => c.action === 'REMOVE_ZOOM'), 'inherited punches are still cleared');
  assert(!dropped.commands.some(c => c.action === 'ADD_ZOOM' && Math.abs(c.payload.startTime - twoZooms[0].start) < .01),
    'a zoom the renderer cannot settle inside one shot is not written to the canonical timeline');
  assert(dropped.skipped.some(note => /dropped: the renderer cannot settle/.test(note)));
  assert(!dropped.lines.some(line => line.includes(twoZooms[0].trigger.slice(0, 20))), 'and it is not reported as applied');

  const applied = await fixture.service.applyAssistantBundle(fixture.id, project.revision, {
    proposalId: 'style-two-zoom', summary: 'StyleTwo', userMessage: 'StyleTwo', actor: 'TEMPLATE_ACTION',
    commands: two.commands, onInvalid: 'FAIL' });
  project = applied.project;
  const after = elementZooms(project);
  assert.deepEqual(zoomPolicyViolations(after), [], 'canonical timeline has no short or overlapping zoom');
  assert(!after.some(z => Math.abs(z.startSec - 5.7) < .01), 'the 1.27 s source19 event is gone from the canonical timeline');
  assert.equal(after.length, twoZooms.length);

  // What the renderer actually plays: it must not shorten a canonical event either.
  const rendered = buildRenderPlan({ project, assets: project.assets, elements: project.elements }).plan;
  assert.deepEqual(zoomPolicyViolations(rendered.zoomEvents), [], 'rendered zoom events obey the policy');
  assert.equal(rendered.zoomEvents.length, after.length, 'every canonical zoom is rendered (none is silently dropped)');
  assert.equal((rendered.zoomRejections ?? []).length, 0);
  for (const event of rendered.zoomEvents) {
    const element = after.find(z => Math.abs(z.startSec - event.startSec) < .06);
    assert(element, 'every rendered zoom corresponds to a canonical event');
    assert(Math.abs((event.endSec - event.startSec) - (element.endSec - element.startSec)) < .06,
      'the renderer neither truncates nor extends a canonical zoom');
  }
  // The fixture's landscape shot is fitted (no punch-in is rendered there), so also prove the
  // renderer's fidelity directly on a cropped (FILL) shot: it plays exactly the canonical duration.
  // That locates the source19 1.27 s in the canonical timeline, never in the renderer.
  const { planEditModeZoom } = require('../dist/modules/edit-mode/render/edit-mode-zoom');
  const plan = (startSec, endSec) => planEditModeZoom({ policy: 'OFF', moments: [], map: {},
    shots: [{ start: 0, end: 30, zoomAllowed: true, informationMode: false, shotClass: 'TALKING_HEAD' }],
    frameSegments: [{ layout: 'FILL' }], frames: [], cropAt: () => ({ x: 0, y: 0, w: 1, h: 1 }),
    focalAt: () => ({ x: .5, y: .5 }), fps: 30, durationSec: 30, minGapSec: 5, maxEvents: 3,
    manual: [{ elementId: 'z', startSec, endSec, scale: 1.08, enabled: true, claimsMoment: null, triggerText: '' }] }).events;
  const [legacyPlayed] = plan(5.7, 5.7 + 1.266667);
  assert(Math.abs((legacyPlayed.endSec - legacyPlayed.startSec) - 1.266667) < 1e-3, 'the renderer played the 1.27 s event it was given');
  const [phrasePlayed] = plan(11.23, 13.73);
  assert(Math.abs((phrasePlayed.endSec - phrasePlayed.startSec) - 2.5) < 1e-3, 'a 2.5 s canonical event plays for 2.5 s');
  assert.deepEqual(zoomPolicyViolations([phrasePlayed]), []);
  assert(zoomPolicyViolations([legacyPlayed]).length > 0);
  console.log('StyleTwo zoom: inherited 1.27 s punch removed, StyleOne-identical 2.5-5 s decisions, renderer faithful, StyleZero path untouched: PASS');
  console.log(JSON.stringify({ before, canonical: after, rendered: rendered.zoomEvents.map(e => ({ start: e.startSec, end: e.endSec, scale: e.peakScale })),
    rejections: rendered.zoomRejections ?? undefined }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
