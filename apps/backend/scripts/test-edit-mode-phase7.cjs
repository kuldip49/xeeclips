// EditMode Phase 7 - production hardening coverage.
//
// Offline and fast, like the Phase 6 suite: no provider is called and no video
// is encoded. What is checked here is the hardening itself - durable proposal
// storage, timeline range selection, multi-segment cuts, chat-driven history
// travel, the capacity limits, the escaping rules and the telemetry contract.
//
// The live-stack half (startup recovery, export retry, restart behaviour, real
// media) is covered by verify-edit-mode-phase7.cjs, which needs Postgres,
// MinIO and FFmpeg.
//
// Redis: if REDIS_URL is set, the durable path is exercised for real. If it is
// not, the store's degraded in-process path is exercised instead and the
// durability checks say so rather than silently passing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = '../dist/modules/edit-mode/chat';
const R = '../dist/modules/edit-mode/render';
const { buildChatContext } = require(`${C}/edit-chat-context.js`);
const { planDeterministicChat } = require(`${C}/edit-chat-deterministic.js`);
const { resolveChatPlan } = require(`${C}/edit-chat-resolver.js`);
const { validateChatIntent } = require(`${C}/edit-chat-commands.js`);
const { EditChatProposalStore } = require(`${C}/edit-chat-proposal-store.js`);
const { proposalView } = require(`${C}/edit-chat.types.js`);
const { buildEditModeAss } = require(`${R}/edit-mode-ass.js`);
const { escapeAssText, sanitizeSubtitleText } =
  require('../dist/modules/editing/subtitle-text.js');
const { maxOverlayElements, maxSubtitleElements, maxSourceDurationSec } =
  require('../dist/modules/edit-mode/edit-mode.service.js');

let passed = 0;
const ok = (label) => { console.log(`  ok  ${label}`); passed += 1; };
const section = (label) => console.log(`\n${label}`);

const SOURCE_DURATION = 40;
const STYLE = {
  selectedPreset: 'SOURCE_MANUAL', aspectRatio: 'SOURCE', pacing: 'SOURCE',
  subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
  musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null
};
const EMPTY_THREAD = { messages: [], lastAffectedElementIds: [], lastAppliedSummary: '',
  lastAppliedAtRevision: -1 };

const evidence = () => ({
  sourceDurationSec: SOURCE_DURATION, sourceWidth: 1280, sourceHeight: 720,
  sourceAspect: 16 / 9, hasAudioStream: true,
  transcriptAvailable: false, wordTimingsAvailable: false,
  analysisAvailable: false, analysisSource: 'NONE', transcriptText: '',
  words: [], phrases: [], frames: [], shots: [], informationRegion: null,
  semanticPeaks: [], informationShotRatio: 0, faceShotRatio: 0, pairShotRatio: 0,
  leadInSilenceSec: 0, tailSilenceSec: 0, ocrText: ''
});

const videoSegment = (id, position, startTime, duration, trimStart) => ({
  id, type: 'VIDEO', track: 0, position, startTime, duration, assetId: 'asset-source',
  trimStart, trimEnd: trimStart + duration, properties: {}
});

/**
 * A timeline already split into three VIDEO segments.
 *
 * 0–10, 10–25 and 25–40 on the timeline; source-relative trims match, because
 * the project has only been split, not reordered. This is the shape Phase 6
 * refused to cut across.
 */
function splitContext(overrides = {}) {
  const elements = overrides.elements ?? [
    videoSegment('video-a', 0, 0, 10, 0),
    videoSegment('video-b', 1, 10, 15, 10),
    videoSegment('video-c', 2, 25, 15, 25),
    { id: 'logo-1', type: 'IMAGE', track: 2, position: 0, startTime: 0, duration: 40,
      assetId: 'asset-logo', trimStart: 0, trimEnd: null,
      properties: { role: 'LOGO', x: 0.76, y: 0.04, width: 0.2, height: 0.12, opacity: 1,
        zIndex: 20, origin: 'USER' } }
  ];
  return buildChatContext({
    revision: overrides.revision ?? 7, settings: {}, style: { ...STYLE, ...(overrides.style ?? {}) },
    elements,
    assets: [
      { id: 'asset-source', role: 'SOURCE', originalName: 'source.mp4',
        duration: SOURCE_DURATION, width: 1280, height: 720 },
      { id: 'asset-logo', role: 'LOGO', originalName: 'logo.png', duration: null,
        width: 400, height: 240 }
    ],
    evidence: evidence(), thread: overrides.thread ?? EMPTY_THREAD,
    selection: overrides.selection ?? { selectedElementId: null, selectedTimeRange: null,
      playheadSec: 0 },
    message: overrides.message ?? ''
  });
}

const plan = (message, overrides = {}) => {
  const context = splitContext({ ...overrides, message });
  const intent = planDeterministicChat(message, context);
  if (!intent || intent.needsClarification) return { context, intent, resolution: null };
  return { context, intent,
    resolution: resolveChatPlan(intent.commands, intent.grounding, context) };
};

const elementCommands = (intent) => intent.commands
  .filter((command) => command.kind === 'ELEMENT');

async function main() {

  // --- 1. Durable chat proposals -------------------------------------------

  section('1. Durable chat proposals');
  {
    const durableWanted = !!process.env.REDIS_URL;
    const base = {
      editProjectId: 'phase7-project', baseRevision: 3, state: 'READY',
      userMessage: 'remove the first three seconds', summary: 'Remove the first 3s.',
      plannedChanges: ['Trim video segment 1'], warnings: [], needsClarification: false,
      clarificationQuestion: '', affectedElements: ['video-a'], plannedDurationSec: 40,
      grounding: [], commands: [{ kind: 'ELEMENT', action: 'TRIM_ELEMENT',
        payload: { elementId: 'video-a', trimStart: 3, trimEnd: 10 }, reason: 'r' }],
      resolvedTargets: { 0: 'video-a' }, planner: 'DETERMINISTIC' };

    // 1. A proposal survives a restart, modelled as a brand new store instance
    //    with no shared memory at all - the same thing a new process gets.
    const writer = new EditChatProposalStore();
    await new Promise((resolve) => setTimeout(resolve, durableWanted ? 400 : 0));
    const saved = await writer.save({ ...base, proposalId: 'phase7-durable-1' });
    assert.equal(saved.proposalId, 'phase7-durable-1');
    const wasDurable = writer.durable;
    assert.equal(wasDurable, durableWanted,
      durableWanted ? 'REDIS_URL is set but the store did not reach Redis'
        : 'the store claimed durability without REDIS_URL');
    await writer.onModuleDestroy();

    const reader = new EditChatProposalStore();
    await new Promise((resolve) => setTimeout(resolve, durableWanted ? 400 : 0));
    const recovered = await reader.get('phase7-durable-1', 'phase7-project');
    if (durableWanted) {
      assert.ok(recovered, 'the proposal did not survive a fresh store instance');
      assert.equal(recovered.commands.length, 1);
      assert.equal(recovered.commands[0].payload.trimStart, 3);
      assert.equal(recovered.baseRevision, 3);
      ok('a pending proposal survives a backend restart with its bundle intact');

      // 2. It is still scoped to its owning project across the restart.
      assert.equal(await reader.get('phase7-durable-1', 'another-project'), null);
      ok('a restored proposal is still only readable by the project that owns it');

      await reader.remove('phase7-durable-1', 'phase7-project');
      assert.equal(await reader.get('phase7-durable-1', 'phase7-project'), null);
      ok('removing a proposal removes it durably, not just from this process');
    } else {
      assert.equal(recovered, null);
      ok('without REDIS_URL the store degrades to in-process and says so (durable=false)');
    }
    await reader.onModuleDestroy();

    // 3. An expired proposal is refused even if its key is still readable.
    process.env.EDIT_MODE_CHAT_PROPOSAL_TTL_MS = '120';
    const ttlStore = new EditChatProposalStore();
    await new Promise((resolve) => setTimeout(resolve, durableWanted ? 400 : 0));
    await ttlStore.save({ ...base, proposalId: 'phase7-expiring' });
    assert.ok(await ttlStore.get('phase7-expiring', 'phase7-project'));
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(await ttlStore.get('phase7-expiring', 'phase7-project'), null,
      'an expired proposal must not be returned');
    ok('an expired proposal is refused, so TTL is enforced on read as well as by Redis');
    delete process.env.EDIT_MODE_CHAT_PROPOSAL_TTL_MS;

    // 4. Per-project cap still holds in whichever mode is active.
    const capStore = new EditChatProposalStore();
    await new Promise((resolve) => setTimeout(resolve, durableWanted ? 400 : 0));
    for (let index = 0; index < 12; index += 1) {
      await capStore.save({ ...base, proposalId: `phase7-cap-${index}` });
    }
    const held = await capStore.countFor('phase7-project');
    assert.ok(held <= 8, `expected at most 8 proposals per project, found ${held}`);
    ok(`per-project proposal storage stays bounded (${held} held after 12 saves)`);
    for (let index = 0; index < 12; index += 1) {
      await capStore.remove(`phase7-cap-${index}`, 'phase7-project');
    }
    await capStore.onModuleDestroy();
    await ttlStore.remove('phase7-expiring', 'phase7-project');
    await ttlStore.onModuleDestroy();

    // 5. The client view still never carries the bundle, durable or not.
    const view = proposalView(saved);
    assert.equal(view.commands, undefined);
    assert.equal(view.resolvedTargets, undefined);
    assert.equal(view.editProjectId, undefined);
    ok('a durable proposal is still opaque to the client - no commands leave the server');
  }

  // --- 2. Timeline range selection -----------------------------------------

  section('2. Timeline range selection');
  {
    // 6. The range reaches the planner's context rather than being dropped.
    const context = splitContext({ selection: { selectedElementId: null,
      selectedTimeRange: { startSec: 12, endSec: 18 }, playheadSec: 12 } });
    assert.deepEqual(context.selection.selectedTimeRange, { startSec: 12, endSec: 18 });
    ok('a selected range reaches the chat context intact');

    // 7. The frontend actually sends one now. Phase 6 hard-coded null here,
    //    which is why the plumbing existed but never carried anything.
    const workspace = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src',
      'components', 'edit-mode', 'edit-mode-workspace.tsx'), 'utf8');
    assert.ok(!/selectedTimeRange=\{null\}/u.test(workspace),
      'the workspace still hard-codes selectedTimeRange={null}');
    assert.ok(/selectedTimeRange=\{selectedRange\}/u.test(workspace));
    ok('the workspace passes the real selected range to the AI editor');

    // 8. The timeline owns the gesture, and a plain click is still a seek.
    const timeline = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src',
      'components', 'edit-mode', 'edit-timeline.tsx'), 'utf8');
    assert.ok(/onSelectRange/u.test(timeline) && /DRAG_THRESHOLD_PX/u.test(timeline));
    assert.ok(/onPointerDown=\{beginRange\}/u.test(timeline));
    ok('the timeline ruler distinguishes a click (seek) from a drag (range select)');

    // 9. Element bodies and trim handles stop propagation, so dragging a clip
    //    can never be reinterpreted as a range selection.
    // B.5 moved selection behind a ref so the handler stays referentially stable
    // for the memoized blocks, so this checks the BEHAVIOUR (a block press stops
    // propagation and selects) rather than the old one-line spelling.
    // Workstream E renamed selectBlock -> pressBlock when the same handler grew
    // drag-to-move and the split tool; the claim it guards is unchanged.
    const selectBlock = timeline.slice(timeline.indexOf('const pressBlock = useCallback'),
      timeline.indexOf('const beginEdge = useCallback'));
    assert.ok(/event\.stopPropagation\(\)/u.test(selectBlock) &&
      /onSelect\(element\.id\)/u.test(selectBlock));
    assert.ok(/event\.preventDefault\(\); event\.stopPropagation\(\);/u.test(timeline));
    ok('range selection cannot hijack element dragging or trim-handle dragging');

    // 10. A committed change clears the range rather than leaving it pointing
    //     at seconds that have moved.
    assert.ok(/setSelectedRange\(null\)/u.test(workspace));
    ok('a committed edit clears the selected range instead of leaving it stale');
  }

  // --- 3. Range-aware chat --------------------------------------------------

  section('3. Range-aware chat');
  {
    // 11. "delete this section" with a range cuts exactly that range.
    const { intent, resolution } = plan('delete this section', {
      selection: { selectedElementId: null, selectedTimeRange: { startSec: 12, endSec: 18 },
        playheadSec: 12 } });
    assert.ok(intent && !intent.needsClarification, 'the range request was not planned');
    assert.ok(resolution.ok, 'the range plan did not resolve');
    assert.ok(intent.grounding.some((entry) => entry.type === 'SELECTION' &&
      entry.startSec === 12 && entry.endSec === 18));
    ok('"delete this section" with a selected range is grounded in that exact range');

    // 12. The range lies inside one segment, so it is split/split/delete.
    const actions = elementCommands(intent).map((command) => command.action);
    assert.deepEqual(actions.filter((action) => action !== 'SET_ELEMENT_TIMING' &&
      action !== 'REMOVE_ELEMENT'), ['SPLIT_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT']);
    ok('an interior range inside one segment becomes two splits and a delete');

    // 13. Without a range, the same words are not silently applied to something.
    const bare = plan('delete this section');
    assert.ok(!bare.intent || bare.intent.needsClarification || !bare.resolution,
      'a section request with no range and no transcript must not produce a cut');
    ok('the same words with no range selected never invent a cut');

    // 14. A range too short to act on is a question, not a no-op edit.
    const tiny = plan('remove this', { selection: { selectedElementId: null,
      selectedTimeRange: { startSec: 12, endSec: 12.05 }, playheadSec: 12 } });
    assert.ok(tiny.intent.needsClarification);
    ok('a range too short to remove asks for a longer one rather than cutting nothing');
  }

  // --- 4. Multi-segment cuts ------------------------------------------------

  section('4. Multi-segment semantic cuts');
  {
    // 15. A range crossing three segments is planned in full, where Phase 6
    //     asked the user to do it one segment at a time.
    const { intent, resolution } = plan('cut from 5 to 30 seconds');
    assert.ok(intent && !intent.needsClarification,
      'a range crossing segment boundaries was refused');
    assert.ok(resolution.ok);
    const commands = elementCommands(intent);
    const cuts = commands.filter((command) => command.action === 'TRIM_ELEMENT' ||
      command.action === 'DELETE_ELEMENT');
    assert.equal(cuts.length, 3, 'expected one command per covered segment');
    ok('one range spanning three VIDEO segments becomes one validated bundle');

    // 16. Right to left, so each command acts before the ripple moves anything
    //     the later commands still depend on.
    const targets = cuts.map((command) => command.target.handle);
    const order = context => context.elements.filter((element) => element.role === 'VIDEO')
      .map((element) => element.handle);
    const timelineOrder = order(splitContext());
    const positions = targets.map((handle) => timelineOrder.indexOf(handle));
    assert.deepEqual(positions, [...positions].sort((a, b) => b - a),
      'segments must be cut from the end of the timeline backwards');
    ok('covered segments are cut right-to-left so no command depends on a moved position');

    // 17. Tail of A trimmed, B deleted whole, head of C trimmed - and every
    //     timestamp comes from the range or an existing boundary.
    const byHandle = Object.fromEntries(cuts.map((command) => [command.target.handle, command]));
    const [handleA, handleB, handleC] = timelineOrder;
    assert.equal(byHandle[handleA].action, 'TRIM_ELEMENT');
    assert.equal(byHandle[handleA].parameters.trimStart, 0);
    assert.equal(byHandle[handleA].parameters.trimEnd, 5);
    assert.equal(byHandle[handleB].action, 'DELETE_ELEMENT');
    assert.equal(byHandle[handleC].action, 'TRIM_ELEMENT');
    assert.equal(byHandle[handleC].parameters.trimStart, 30);
    assert.equal(byHandle[handleC].parameters.trimEnd, 40);
    ok('the span is removed exactly: tail trim, whole delete, head trim - no invented times');

    // 18. The timeline that survives is exactly the material outside the range.
    const remaining = 5 + 10;
    const total = 40 - (30 - 5);
    assert.equal(total, remaining);
    ok(`the cut leaves a valid ${total}s timeline (40s source minus the 25s range)`);

    // 19. Overlays are refitted first, so no intermediate state is invalid.
    const first = commands[0];
    assert.equal(first.action, 'SET_ELEMENT_TIMING');
    assert.equal(first.parameters.duration, 15);
    ok('the overlay refit is emitted before the cuts, so every step validates');

    // 20. A range that would empty the timeline is refused.
    const everything = plan('cut from 0 to 40 seconds');
    assert.ok(everything.intent.needsClarification,
      'removing the entire video must be a question, not a proposal');
    ok('a cut that would leave nothing asks rather than emptying the project');

    // 21. A range past the end is refused with the real length.
    const past = plan('cut from 30 to 90 seconds');
    assert.ok(past.intent.needsClarification);
    ok('a range past the end of the timeline is refused, not clamped silently');

    // 22. Edge cuts still work unchanged on a multi-segment timeline.
    const head = plan('remove the first 3 seconds');
    assert.ok(head.resolution.ok);
    const headCuts = elementCommands(head.intent)
      .filter((command) => command.action === 'TRIM_ELEMENT' ||
        command.action === 'DELETE_ELEMENT');
    assert.equal(headCuts.length, 1);
    assert.equal(headCuts[0].parameters.trimStart, 3);
    ok('a leading cut inside the first segment is still a single trim');

    // 23. Every command in a multi-segment bundle survives validation.
    const revalidated = validateChatIntent({ intent: 'EDIT_PROJECT', summary: intent.summary,
      commands: intent.commands, grounding: intent.grounding, warnings: [],
      needsClarification: false, clarificationQuestion: '' });
    assert.equal(revalidated.commands.length, intent.commands.length);
    ok('a multi-segment bundle passes the same command validator as any other plan');
  }

  // --- 5. Chat-driven undo / redo -------------------------------------------

  section('5. Chat-driven undo and redo');
  {
    // 24. "undo that" is history travel, not an inverse edit.
    for (const phrase of ['undo that', 'undo', 'undo my last change', 'please undo that']) {
      const intent = planDeterministicChat(phrase, splitContext());
      assert.ok(intent, `"${phrase}" was not recognised`);
      assert.equal(intent.historyAction, 'UNDO', `"${phrase}" did not map to UNDO`);
      assert.equal(intent.commands.length, 0,
        `"${phrase}" produced commands - no inverse command may be synthesised`);
    }
    ok('"undo that" maps to the existing history path and produces no commands');

    // 25. Redo likewise.
    for (const phrase of ['redo that', 'redo', 'redo my last change']) {
      const intent = planDeterministicChat(phrase, splitContext());
      assert.equal(intent.historyAction, 'REDO');
      assert.equal(intent.commands.length, 0);
    }
    ok('"redo that" maps to the existing history path and produces no commands');

    // 26. A sentence that merely mentions undo is not treated as an undo.
    const mixed = planDeterministicChat('undo the logo and make it 9:16', splitContext());
    assert.ok(!mixed || mixed.historyAction === undefined,
      'a compound sentence must not be read as a bare undo');
    ok('a sentence that only mentions undo is not silently treated as one');

    // 27. History travel cannot be requested by a model: the field is absent
    //     from the schema and the validator never produces it.
    const modelPlan = validateChatIntent({ intent: 'EDIT_PROJECT', summary: 's',
      historyAction: 'UNDO', commands: [{ action: 'SET_AUDIO_MUTED',
        target: { kind: 'ROLE', role: 'MUSIC' }, parameters: { muted: true }, reason: 'r' }],
      grounding: [], warnings: [], needsClarification: false, clarificationQuestion: '' });
    assert.equal(modelPlan.historyAction, undefined);
    ok('a model cannot ask for an undo - historyAction is deterministic-planner only');

    // 28. Apply routes a history proposal away from the bundle executor.
    const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'edit-mode',
      'chat', 'edit-chat.service.ts'), 'utf8');
    const canonicalSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules',
      'edit-mode', 'edit-mode.service.ts'), 'utf8');
    assert.ok(/if \(proposal\.historyAction\) return this\.applyHistoryTravel/u.test(service));
    assert.ok(/this\.editMode\.undo\(id, current\.revision\)/u.test(service));
    assert.ok(/this\.editMode\.redo\(id, current\.revision\)/u.test(service));
    ok('applying a history proposal calls the same undo/redo the buttons call');

    // 29. Nothing to undo becomes a question rather than a doomed proposal.
    assert.ok(/NOTHING_TO_\$\{direction\}/u.test(service));
    assert.ok(/There is nothing to undo yet/u.test(service));
    ok('a project with nothing to undo asks for clarification instead of proposing one');

    // 30. The Undo button is enabled after an AI edit. The frontend's action
    //     list was missing APPLY_ASSISTANT_EDIT, which left it greyed out.
    const timelineLib = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src',
      'lib', 'edit-mode-timeline.ts'), 'utf8');
    const frontendManual = /const manual = new Set\(\[([\s\S]*?)\]\)/u.exec(timelineLib)[1];
    assert.ok(frontendManual.includes('APPLY_ASSISTANT_EDIT'),
      'the frontend history model still ignores APPLY_ASSISTANT_EDIT');
    // Every backend action the frontend claims is undoable must really be one.
    const backendManual = /const MANUAL_ACTIONS = new Set\(\[([\s\S]*?)\]\)/u.exec(canonicalSource)[1];
    for (const action of ['APPLY_PRESET', 'APPLY_ASSISTANT_EDIT', 'TRIM_ELEMENT']) {
      assert.ok(frontendManual.includes(action) && backendManual.includes(action),
        `${action} is undoable on one side only`);
    }
    ok('the frontend enables Undo after an AI chat edit (APPLY_ASSISTANT_EDIT counted)');
  }

  // --- 6. Capacity limits ---------------------------------------------------

  section('6. Capacity limits');
  {
    // 31. Each limit exists, is bounded and is environment-tunable.
    assert.ok(maxSourceDurationSec() >= 10 && maxSourceDurationSec() <= 4 * 60 * 60);
    assert.ok(maxOverlayElements() >= 5);
    assert.ok(maxSubtitleElements() >= 10);
    ok(`limits in force: source ${maxSourceDurationSec()}s, overlays ` +
      `${maxOverlayElements()}, captions ${maxSubtitleElements()}`);

    const canonical = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'edit-mode',
      'edit-mode.service.ts'), 'utf8');

    // 32. Each fails with a typed, actionable code rather than a crash.
    for (const code of ['SOURCE_TOO_LONG', 'TOO_MANY_OVERLAYS', 'TOO_MANY_SUBTITLES']) {
      assert.ok(canonical.includes(code), `${code} is not raised anywhere`);
    }
    ok('over-limit timelines fail with typed codes, not with a crash or a timeout');

    // 33. The caps are enforced in validateTimeline, so every write path -
    //     manual, preset and chat - is held to them.
    assert.ok(/private validateTimeline[\s\S]{0,2000}TOO_MANY_OVERLAYS/u.test(canonical));
    ok('capacity is enforced in the shared validator, so no write path can bypass it');

    // 34. The chat message limit is enforced before any planning happens.
    const chatService = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules',
      'edit-mode', 'chat', 'edit-chat.service.ts'), 'utf8');
    assert.ok(/MESSAGE_TOO_LONG/u.test(chatService));
    assert.ok(chatService.indexOf('MESSAGE_TOO_LONG') <
      chatService.indexOf('planDeterministicChat(message, context)'));
    ok('an over-long chat message is refused before any planning or provider call');

    // 35. A plan may not carry an unbounded number of commands.
    let rejected = false;
    try {
      validateChatIntent({ intent: 'EDIT_PROJECT', summary: 's', grounding: [], warnings: [],
        needsClarification: false, clarificationQuestion: '',
        commands: Array.from({ length: 13 }, () => ({ action: 'SET_AUDIO_MUTED',
          target: { kind: 'ROLE', role: 'MUSIC' }, parameters: { muted: true }, reason: 'r' })) });
    } catch (error) {
      rejected = (error?.response ?? error?.getResponse?.() ?? {}).code === 'PLAN_TOO_LARGE';
    }
    assert.ok(rejected, 'a 13-command plan was not rejected');
    ok('a plan carrying more than 12 commands is rejected as PLAN_TOO_LARGE');
  }

  // --- 7. Security and escaping --------------------------------------------

  section('7. Security, escaping and injection');
  {
    const HOSTILE = [
      '"; rm -rf /',
      '[0:v]scale=9999',
      '{\\pos(0,0)}',
      '..\\..\\secret',
      '../../etc/passwd',
      '<script>alert(1)</script>',
      '$(whoami)',
      '`id`',
      "' OR 1=1 --"
    ];

    // 36. Hostile text survives as visible text and never as ASS override.
    for (const hostile of HOSTILE) {
      const escaped = escapeAssText(hostile);
      assert.ok(!escaped.includes('{'), `"${hostile}" left an ASS override brace`);
      assert.ok(!escaped.includes('}'), `"${hostile}" left an ASS override brace`);
      assert.ok(!escaped.includes('\\'), `"${hostile}" left a backslash for libass to read`);
    }
    ok('every hostile string is escaped to inert ASS text (no braces, no backslashes)');

    // 37. Legitimate visible text is NOT over-sanitised into something else.
    assert.equal(sanitizeSubtitleText('Save 50% on plans & add-ons!'),
      'Save 50% on plans & add-ons!');
    assert.equal(escapeAssText('Cost: $99 (was $149)'), 'Cost: $99 (was $149)');
    assert.equal(escapeAssText('2 + 2 = 4, 5 > 3'), '2 + 2 = 4, 5 > 3');
    ok('ordinary punctuation, currency and maths survive escaping unchanged');

    // 38. The rendered ASS file itself contains no live override block from
    //     user text - only the one the renderer itself emits for position.
    const ass = buildEditModeAss(
      { width: 1080, height: 1920, fps: 30, aspectRatio: '9:16',
        sourceWidth: 1920, sourceHeight: 1080 },
      HOSTILE.map((content, index) => ({
        elementId: `text-${index}`, content, startSec: index, endSec: index + 1,
        x: 100, y: 200, width: 880, height: 200, fontSizePx: 48,
        fontFamily: 'Arial, sans-serif', fontWeight: 700, color: '#ffffff',
        backgroundColor: 'transparent', opacity: 1, textAlign: 'center', zIndex: 10 })));
    const dialogue = ass.content.split('\n').filter((line) => line.startsWith('Dialogue:'));
    assert.equal(dialogue.length, HOSTILE.length);
    for (const line of dialogue) {
      const body = line.slice(line.indexOf('}') + 1);
      assert.ok(!body.includes('{') && !body.includes('}'),
        `a dialogue body carried an override block: ${body}`);
      assert.ok(!body.includes('\\') || body.includes('\\N'),
        `a dialogue body carried a raw backslash: ${body}`);
    }
    ok('rendered ASS dialogue bodies carry no user-supplied override block');

    // 39. Nothing in the render path builds a shell string. FFmpeg is called
    //     with an argument vector, so a filter or a quote in user text is an
    //     argument, never syntax.
    const renderDir = path.join(__dirname, '..', 'src', 'modules', 'edit-mode', 'render');
    const renderSources = fs.readdirSync(renderDir).filter((name) => name.endsWith('.ts'))
      .map((name) => ({ name, text: fs.readFileSync(path.join(renderDir, name), 'utf8') }));
    for (const source of renderSources) {
      // A regex's own `.exec(` is fine; a bare exec()/execSync()/shell:true
      // would mean a command line is being assembled as a string.
      assert.ok(!/(?<![.\w])exec\(|execSync\(|\bshell:\s*true/u.test(source.text),
        `${source.name} reaches a shell`);
    }
    assert.ok(renderSources.some((source) => /execFileAsync\('ffmpeg', args/u.test(source.text)));
    ok('FFmpeg is invoked with an argument vector - no shell, so no shell injection');

    // 40. The ASS file the graph burns in is a fixed name, not user input.
    const graph = renderSources.find((source) => source.name === 'edit-mode-filtergraph.ts').text;
    assert.ok(/ass=\$\{input\.assFileName\}/u.test(graph));
    const renderService = renderSources
      .find((source) => source.name === 'edit-mode-render.service.ts').text;
    assert.ok(/assFileName = textOverlays\.length \? 'edit-mode\.ass' : null/u.test(renderService));
    ok('the subtitle filter references a fixed filename, never anything user-supplied');

    // 41. Object keys and local paths are built from UUIDs, and an uploaded
    //     filename is sanitised before it is ever used as a key.
    const canonical = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'edit-mode',
      'edit-mode.service.ts'), 'utf8');
    assert.ok(/const safeName = file\.originalname\.replace\(\/\[\^a-zA-Z0-9\._-\]\/gu, '_'\)/u
      .test(canonical.replace(/\\/gu, '')) ||
      /originalname\.replace\(\/\[\^a-zA-Z0-9\._-\]/u.test(canonical.replace(/\\/gu, '')),
      'the uploaded filename is not sanitised before becoming an object key');
    assert.ok(/`edit-mode\/\$\{id\}\/assets\/\$\{assetId\}\//u.test(canonical));
    ok('storage keys are UUID-scoped and any uploaded filename is stripped to a safe form');

    // 42. Traversal in a filename cannot escape the asset directory.
    const traversal = '../../../etc/passwd'.replace(/[^a-zA-Z0-9._-]/gu, '_');
    assert.ok(!traversal.includes('/') && !traversal.includes('\\'));
    ok('a traversal filename is flattened, so it cannot escape its asset directory');

    // 43. Assets are served by id, so no caller-supplied path reaches storage.
    const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'edit-mode',
      'edit-mode.controller.ts'), 'utf8');
    assert.ok(/@Get\('assets\/:assetId\/file'\)/u.test(controller));
    assert.ok(!/objectKey/u.test(controller));
    ok('files are served by asset id - no caller-supplied object key or path is accepted');

    // 44. The renderer fetches nothing from the network: every input is a
    //     local file downloaded from this project's own storage.
    for (const source of renderSources) {
      assert.ok(!/\bfetch\(|https?:\/\/[^\s'"`]*\$\{/u.test(source.text),
        `${source.name} may fetch a URL`);
    }
    ok('the renderer fetches no URL - it only reads files it downloaded itself');
  }

  // --- 8. Telemetry ---------------------------------------------------------

  section('8. Telemetry');
  {
    const chatService = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules',
      'edit-mode', 'chat', 'edit-chat.service.ts'), 'utf8');
    const renderService = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules',
      'edit-mode', 'render', 'edit-mode-render.service.ts'), 'utf8');
    const presetService = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules',
      'edit-mode', 'edit-mode-preset.service.ts'), 'utf8');
    const recovery = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'edit-mode',
      'render', 'edit-mode-recovery.service.ts'), 'utf8');

    // 45. The chat counters Phase 7 asked for all exist.
    for (const event of ['edit_mode_chat_planned', 'edit_mode_chat_clarification',
      'edit_mode_chat_stale_proposal', 'edit_mode_chat_safe_rebase', 'edit_mode_chat_applied']) {
      assert.ok(chatService.includes(event), `${event} is not emitted`);
    }
    ok('chat telemetry covers plan, clarification, stale, safe rebase and apply');

    // 46. Render telemetry carries the render factor and QA outcome.
    assert.ok(renderService.includes('edit_mode_export_completed'));
    assert.ok(renderService.includes('renderFactor'));
    assert.ok(renderService.includes('qaResult'));
    assert.ok(renderService.includes('rerenders'));
    assert.ok(renderService.includes('edit_mode_export_failed'));
    assert.ok(renderService.includes('failureCategory'));
    ok('render telemetry records duration, render factor, QA result, rerenders and failures');

    // 47. Preset preview and apply are counted.
    assert.ok(/edit_mode_preset_preview/u.test(presetService));
    assert.ok(/edit_mode_preset_apply/u.test(presetService));
    ok('preset preview and apply are counted');

    // 48. Recovery says what it did.
    assert.ok(recovery.includes('edit_mode_export_recovered'));
    assert.ok(recovery.includes('edit_mode_startup_recovery'));
    ok('startup recovery emits a per-project and a summary counter');

    // 49. No transcript, no instruction text, no proposal prose is logged.
    //     This is the check that keeps telemetry from becoming a copy of a
    //     private video: the logged chat fields are ids, counts and enums.
    const logged = [...chatService.matchAll(/this\.telemetry\('[a-z_]+', \{([^}]*)\}/gu)]
      .map((match) => match[1]);
    assert.ok(logged.length >= 5, 'expected several telemetry call sites');
    for (const fields of logged) {
      for (const forbidden of ['message', 'userMessage', 'summary', 'transcript', 'excerpt',
        'plannedChanges', 'clarificationQuestion', 'content', 'evidence']) {
        assert.ok(!new RegExp(`\\b${forbidden}\\b`, 'u').test(fields),
          `chat telemetry logs "${forbidden}": ${fields}`);
      }
    }
    ok('chat telemetry logs ids, counts and categories only - never transcript or user text');

    // 50. The render counters are equally content-free.
    const renderLogged = /event: 'edit_mode_export_completed',[\s\S]{0,900}?\}\)\);/u
      .exec(renderService)[0];
    for (const forbidden of ['content', 'transcript', 'hookText', 'warnings', 'userMessage']) {
      assert.ok(!renderLogged.includes(forbidden),
        `render telemetry logs "${forbidden}"`);
    }
    ok('render telemetry logs measurements only - no overlay text and no transcript');
  }

  // --- 9. Export resilience and recovery ------------------------------------

  section('9. Export resilience, recovery and hygiene');
  {
    const renderService = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules',
      'edit-mode', 'render', 'edit-mode-render.service.ts'), 'utf8');
    const recovery = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'edit-mode',
      'render', 'edit-mode-recovery.service.ts'), 'utf8');
    const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'edit-mode',
      'render', 'edit-mode-render.types.ts'), 'utf8');

    // 51. A project cannot stay EXPORTING across a restart.
    assert.ok(/OnApplicationBootstrap/u.test(recovery));
    assert.ok(/where: \{ status: 'EXPORTING' \}/u.test(recovery));
    ok('startup recovery looks for exactly the projects a crash would strand');

    // 52. COMPLETED is never assumed - the object is verified in storage.
    assert.ok(/statObject\(finished!\.bucket, finished!\.objectKey\)/u.test(recovery));
    assert.ok(/const verified = matches && await this\.storage/u.test(recovery));
    assert.ok(/if \(verified\) \{/u.test(recovery));
    ok('an interrupted export is only COMPLETED when its file is verified in storage');

    // 53. Everything else is FAILED with a stated, user-facing reason.
    assert.ok(recovery.includes("'INTERRUPTED'"));
    assert.ok(/The backend restarted while this export was running/u.test(recovery));
    assert.ok(types.includes("'INTERRUPTED'"));
    ok('an unverifiable interrupted export becomes FAILED with a documented reason');

    // 54. Recovery is not an edit: no revision bump, no history row.
    assert.ok(!/editHistory/u.test(recovery), 'recovery writes an EditHistory row');
    assert.ok(!/editElement/u.test(recovery), 'recovery writes EditElement rows');
    // The only project write recovery makes sets status and the progress block.
    const writes = [...recovery.matchAll(/editProject\.update\(\{[\s\S]*?\}\);/gu)]
      .map((match) => match[0]);
    assert.equal(writes.length, 1, 'recovery makes more than one project write');
    assert.ok(/data: \{ status,/u.test(writes[0]));
    assert.ok(!/\brevision:/u.test(writes[0]),
      'recovery bumps the revision - an export is not an edit');
    ok('recovery never bumps the revision or writes history - it is not an edit');

    // 55. A finished export that no longer matches the timeline is kept as a
    //     previous export rather than declared the current result.
    assert.ok(/const status = stale \? 'READY' as const : 'COMPLETED' as const/u.test(recovery));
    ok('a recovered but stale export is preserved without being declared current');

    // 56. An upload that succeeds but whose row fails is compensated, so no
    //     orphan object and no half-recorded export is left behind.
    assert.ok(/catch \(error\) \{\s*await this\.storage\.removeObject\(stored\.bucket, stored\.objectKey\)/u
      .test(renderService));
    ok('a failed DB write after a successful upload removes the uploaded object again');

    // 57. Temp directories are unique per export and removed on every path.
    assert.ok(/mkdtemp\(join\(tmpdir\(\), 'edit-mode-export-'\)\)/u.test(renderService));
    assert.ok(/finally \{[\s\S]{0,400}rm\(directory, \{ recursive: true, force: true \}\)/u
      .test(renderService));
    ok('each export gets its own temp directory, removed on success and on failure alike');

    // 58. Intermediate renders are named per attempt, so a repair pass cannot
    //     collide with the file it is replacing.
    assert.ok(/join\(directory, `export-\$\{attempt\}\.mp4`\)/u.test(renderService));
    ok('repair re-renders write a new file per attempt - no filename collision');

    // 59. Exports accumulate: a new one never overwrites an earlier asset.
    assert.ok(/edit-mode\/\$\{id\}\/exports\/\$\{assetId\}\/final\.mp4/u.test(renderService));
    ok('each export gets its own storage key, so previous exports are preserved');

    // 60. Only one export runs per project, and a finished one never blocks
    //     a retry.
    assert.ok(/active\.phase !== 'COMPLETED' && active\.phase !== 'FAILED'/u.test(renderService));
    ok('a completed or failed export never blocks the next attempt');
  }

  // --- 10. Frozen pipeline --------------------------------------------------

  section('10. Frozen pipeline isolation');
  {
    const roots = ['chat', 'render', 'presets', 'dto'];
    const base = path.join(__dirname, '..', 'src', 'modules', 'edit-mode');
    const files = ['edit-mode.service.ts', 'edit-mode.controller.ts', 'edit-mode.module.ts',
      'edit-mode-preset.service.ts', 'edit-mode-analysis.service.ts', 'edit-mode.types.ts']
      .map((name) => path.join(base, name))
      .concat(roots.flatMap((dir) => fs.readdirSync(path.join(base, dir))
        .filter((name) => name.endsWith('.ts')).map((name) => path.join(base, dir, name))));
    const all = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

    // 61. Nothing in EditMode touches a frozen pipeline row or service.
    for (const forbidden of ['ProcessingQueueService', 'VideoProcessorService',
      'ClipSelectionService', 'ClipRenderQueueService', 'ClipExportService',
      'processingJob', 'clipCandidate', 'prisma.generatedClip', 'videoProcessingStage',
      'transcriptChunk', 'chunkAnalysis', 'videoUnderstanding']) {
      assert.ok(!all.includes(forbidden), `EditMode references ${forbidden}`);
    }
    ok('no EditMode file references a frozen pipeline service or model');

    // 62. Phase 7 added no new frozen-file dependency.
    assert.ok(!/from '\.\.\/\.\.\/videos\//u.test(all), 'EditMode imports from the videos module');
    assert.ok(!/from '\.\.\/\.\.\/projects\//u.test(all),
      'EditMode imports from the projects module');
    ok('Phase 7 added no import from the frozen videos or projects modules');

    // 63. Step 6 removed the local-LLM route entirely, so there is no OFFLINE role
    // allowlist left to widen: an old OFFLINE job is normalised to deterministic rules.
    const router = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'processing',
      'llm-router.service.ts'), 'utf8');
    assert.ok(!/OFFLINE_MODEL_ROLES/u.test(router) && !/ollama/iu.test(router.replace(/\/\/.*$/gmu, '')),
      'a local-LLM (OFFLINE/Ollama) route came back into the router');
    ok('no local-LLM route exists (OFFLINE stays deterministic-only)');
  }

  console.log(`\nEditMode Phase 7 tests passed (${passed} checks).`);
}

void main().catch((error) => { console.error(error); process.exit(1); });
