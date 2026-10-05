// Workstreams H/I - read-only review and supervised semantic brief plans.
// Runs on the real canonical in-memory harness; no provider, Redis, database or FFmpeg required.

const assert = require('node:assert/strict');
const { seedRichProject } = require('./lib-edit-mode-ai-fixture.cjs');
const { EditReviewService } = require('../dist/modules/edit-mode/review/edit-review.service.js');
const { EditReviewStore } = require('../dist/modules/edit-mode/review/edit-review-store.js');
const { EditBriefService } = require('../dist/modules/edit-mode/brief/edit-brief.service.js');
const { EditBriefPlanStore } = require('../dist/modules/edit-mode/brief/edit-brief-plan-store.js');

let passed = 0;
const ok = (label) => { console.log(`  ok  ${label}`); passed += 1; };
const stripChat = (settings) => { const { chat: _chat, ...rest } = settings; return rest; };

async function services(options = {}) {
  const fixture = await seedRichProject(options);
  const reviews = new EditReviewService(fixture.harness.prisma, new EditReviewStore(), fixture.chat);
  const briefs = new EditBriefService(fixture.harness.prisma, new EditBriefPlanStore(), fixture.chat,
    reviews);
  return { ...fixture, reviews, briefs };
}

async function main() {
  console.log('EditMode Workstreams H/I:');

  {
    const s = await services(); const before = await s.refresh();
    const review = await s.reviews.review(s.id, { revision: before.revision,
      message: 'review my edit', playheadSec: 0 });
    const after = await s.refresh();
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.elements, before.elements);
    assert.deepEqual(stripChat(after.settings), stripChat(before.settings));
    assert.ok(review.findings.length >= 7);
    assert.ok(review.findings.every((finding) => Array.isArray(finding.evidence) &&
      !('editProjectId' in finding) && !('targetElementId' in finding)));
    assert.ok(!JSON.stringify(review).includes(s.id));
    ok('whole-project review is bounded, evidence-separated, id-opaque and non-mutating');

    const hook = before.elements.find((element) => element.type === 'TEXT' &&
      element.properties.presetRole === 'HOOK');
    const selection = await s.reviews.review(s.id, { revision: before.revision,
      message: 'review this', selectedElementId: hook.id });
    assert.equal(selection.scope, 'SELECTION');
    assert.ok(selection.findings.some((finding) => finding.dimension === 'HOOK'));
    ok('selected text review stays scoped to the selected canonical object');

    const range = await s.reviews.review(s.id, { revision: before.revision,
      message: 'review this section', selectedTimeRange: { startSec: 10, endSec: 16 } });
    assert.equal(range.scope, 'RANGE');
    assert.ok(range.sampledMomentsSec.length <= 6);
    ok('range review uses a bounded representative sample');

    const audio = await s.reviews.review(s.id, { revision: before.revision,
      message: 'review audio' });
    assert.deepEqual([...new Set(audio.findings.map((finding) => finding.dimension))], ['AUDIO']);
    assert.ok(audio.findings[0].evidence.length > 0);
    ok('audio-only review reports stored facts without a fake score');
  }

  {
    const s = await services();
    await s.sayAndApply('change the hook to "This Is A Very Long Hook With Far Too Many Words To Read Quickly Before The Viewer Can Understand The Important Point"');
    const before = await s.refresh();
    const review = await s.reviews.review(s.id, { revision: before.revision, message: 'check my hook' });
    const finding = review.findings.find((item) => item.dimension === 'HOOK');
    assert.equal(finding.severity, 'NEEDS_ATTENTION');
    assert.ok(finding.applyInstruction);
    const planned = await s.reviews.propose(s.id, finding.id, { revision: before.revision });
    assert.equal((await s.refresh()).revision, before.revision, 'proposal must not mutate');
    assert.equal(planned.proposal.needsClarification, false);
    const beforeHook = before.elements.find((element) => element.type === 'TEXT' &&
      element.properties.presetRole === 'HOOK').properties.content;
    const applied = await s.chat.apply(s.id, { proposalId: planned.proposal.proposalId,
      revision: before.revision });
    assert.equal(applied.project.revision, before.revision + 1);
    const undone = await s.service.undo(s.id, applied.project.revision);
    assert.equal(undone.elements.find((element) => element.type === 'TEXT' &&
      element.properties.presetRole === 'HOOK').properties.content, beforeHook);
    ok('review suggestion becomes a G proposal, applies canonically, and is undoable');
  }

  {
    const s = await services(); const project = await s.refresh();
    const brief = 'Make this into a clean professional Reel. Make the hook shorter and more ' +
      'curiosity based, keep the captions readable, use subtle zooms only when something important ' +
      'is said, keep the music low under speech, make the colors slightly warmer, and don\'t change ' +
      'my manual crop or speed.';
    let plan = await s.briefs.create(s.id, { brief, revision: project.revision });
    assert.deepEqual(plan.protectedConstraints.sort(), ['Preserve manual crop', 'Preserve speed']);
    assert.deepEqual(plan.steps.map((step) => step.label),
      ['Hook', 'Captions', 'Zoom', 'Audio', 'Color', 'Final review']);
    assert.equal(plan.status, 'AWAITING_CONFIRMATION');
    assert.ok(plan.activeProposal && plan.activeProposal.affectedElements.length === 0);
    assert.ok(!JSON.stringify(plan).includes('proposalId":null'));
    ok('long brief accounts for every requested facet and protected constraint');

    const first = await s.briefs.respond(s.id, { message: 'yes', revision: project.revision });
    assert.equal(first.plan.steps[0].status, 'APPLIED');
    assert.ok(first.project);
    const manuallyChanged = await s.service.phase3Command(s.id, 'SET_VIDEO_ROTATION', {
      revision: first.project.revision, elementId: first.project.elements.find((e) => e.type === 'VIDEO').id,
      rotation: 2 });
    plan = (await s.briefs.respond(s.id, { message: 'continue',
      revision: manuallyChanged.revision })).plan;
    assert.equal(plan.steps[1].projectRevision, manuallyChanged.revision);
    assert.equal(manuallyChanged.elements.find((e) => e.type === 'VIDEO').properties.rotation, 2);
    ok('manual edit between steps wins and the next step re-grounds at its revision');

    plan = (await s.briefs.respond(s.id, { message: 'more subtle',
      revision: manuallyChanged.revision })).plan;
    assert.equal(plan.steps[1].status, 'AWAITING_CONFIRMATION');
    assert.match(plan.steps[1].resultSummary, /caption/i);
    plan = (await s.briefs.respond(s.id, { message: 'skip', revision: manuallyChanged.revision })).plan;
    assert.equal(plan.steps[1].status, 'SKIPPED');
    ok('current step supports revision language and skip');

    const reloaded = await s.briefs.current(s.id);
    assert.equal(reloaded.planId, plan.planId);
    assert.equal(reloaded.currentStepIndex, plan.currentStepIndex);
    const stopped = await s.briefs.respond(s.id, { message: 'stop', revision: plan.revision });
    assert.equal(stopped.plan.status, 'STOPPED');
    ok('plan survives remount reads and stop preserves accepted edits');
  }

  {
    const missing = await services({ hook: false }); const project = await missing.refresh();
    const plan = await missing.briefs.create(missing.id, { revision: project.revision,
      brief: 'Use my logo, add a 3D particle explosion, and make the colors warmer.' });
    assert.ok(plan.steps.some((step) => step.label === 'Unsupported capability' &&
      step.status === 'SKIPPED'));
    assert.ok(plan.steps.some((step) => step.label === 'Color'));
    ok('unsupported work is explicit while supported steps continue');
  }

  console.log(`\n${passed} Workstream H/I checks passed.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
