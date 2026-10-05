// EditMode Phase 6 - AI chat editor coverage.
//
// Offline and fast: everything here is about the deterministic planning,
// grounding, resolution and safety layers that sit between a sentence and the
// canonical editor. No provider is called and no video is encoded. The real
// plan -> apply -> export flow against the live stack is covered by
// verify-edit-mode-chat.cjs.

const assert = require('node:assert/strict');

const C = '../dist/modules/edit-mode/chat';
const { validateChatIntent, CHAT_ELEMENT_ACTIONS, CHAT_SETTINGS_ACTIONS,
  requiredConfidenceFor, CHAT_DESTRUCTIVE_CONFIDENCE,
  CHAT_SAFE_CONFIDENCE } = require(`${C}/edit-chat-commands.js`);
const { buildChatContext } = require(`${C}/edit-chat-context.js`);
const { planDeterministicChat, fallbackUnsupported } = require(`${C}/edit-chat-deterministic.js`);
const { parseNaturalRequest } = require(`${C}/edit-chat-intents.js`);
const { resolveChatPlan } = require(`${C}/edit-chat-resolver.js`);
const { searchTranscript, resolveTranscriptSpan, topicTerms } =
  require(`${C}/edit-chat-transcript.js`);
const { rejectInventedTimestamps } = require(`${C}/edit-chat-planner.js`);
const { readChatThread, boundChatThread, proposalView,
  CHAT_MAX_MESSAGES } = require(`${C}/edit-chat.types.js`);
const { EditChatProposalStore } = require(`${C}/edit-chat-proposal-store.js`);

let passed = 0;
/** Assigned below; the proposal store is async since Phase 7. */
let proposalStoreChecks = async () => undefined;
const ok = (label) => { console.log(`  ok  ${label}`); passed += 1; };
const throws = (fn, code, label) => {
  try { fn(); assert.fail(`${label}: expected a rejection`); }
  catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    const body = error?.response ?? error?.getResponse?.() ?? {};
    if (code) assert.equal(body.code ?? error.code, code, `${label}: wrong code`);
  }
  ok(label);
};

// --- Fixtures ---------------------------------------------------------------

const SPEECH = 'Welcome back everyone. Today I want to talk about our pricing model and why ' +
  'we changed it. The old plan charged per seat which punished growing teams. Our new pricing ' +
  'is usage based instead. Later I will explain compound interest and how it applies to ' +
  'reinvesting your savings over many years.';

function transcriptFixture() {
  const sentences = SPEECH.split(/(?<=[.])\s+/u);
  let cursor = 0.5;
  const segments = sentences.map((sentence) => {
    const words = sentence.split(/\s+/u).map((text) => {
      const start = Number(cursor.toFixed(3));
      cursor += 0.4;
      return { word: text, start, end: Number((cursor - 0.05).toFixed(3)) };
    });
    cursor += 0.3;
    return { text: sentence, start: words[0].start, end: words[words.length - 1].end, words };
  });
  return { text: SPEECH, language: 'en', segments };
}

const SOURCE_DURATION = 40;

function evidenceFixture({ transcript = true } = {}) {
  const { wordsFromCache } = require('../dist/modules/edit-mode/presets/edit-preset-evidence.js');
  const parsed = transcript ? wordsFromCache(transcriptFixture()) : { words: [], text: '' };
  return {
    sourceDurationSec: SOURCE_DURATION, sourceWidth: 1280, sourceHeight: 720,
    sourceAspect: 16 / 9, hasAudioStream: true,
    transcriptAvailable: parsed.words.length > 0, wordTimingsAvailable: parsed.words.length > 0,
    analysisAvailable: true, analysisSource: 'DENSE', transcriptText: parsed.text,
    words: parsed.words, phrases: [], frames: [], shots: [], informationRegion: null,
    semanticPeaks: [], informationShotRatio: 0.2, faceShotRatio: 0.6, pairShotRatio: 0.3,
    leadInSilenceSec: 0.5, tailSilenceSec: 0.4, ocrText: ''
  };
}

const STYLE = {
  selectedPreset: 'SOURCE_MANUAL', aspectRatio: 'SOURCE', pacing: 'SOURCE',
  subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF', reframePolicy: 'SOURCE',
  musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: 'Old hook'
};

const EMPTY_THREAD = { messages: [], lastAffectedElementIds: [], lastAppliedSummary: '',
  lastAppliedAtRevision: -1 };

/** A project with one video segment, a logo, a text overlay and a music track. */
function contextFixture(overrides = {}) {
  const elements = overrides.elements ?? [
    { id: 'video-1', type: 'VIDEO', track: 0, position: 0, startTime: 0, duration: SOURCE_DURATION,
      assetId: 'asset-source', trimStart: 0, trimEnd: SOURCE_DURATION, properties: {} },
    { id: 'logo-1', type: 'IMAGE', track: 2, position: 0, startTime: 0, duration: SOURCE_DURATION,
      assetId: 'asset-logo', trimStart: 0, trimEnd: null,
      properties: { role: 'LOGO', x: 0.76, y: 0.04, width: 0.2, height: 0.12, opacity: 1,
        zIndex: 20, origin: 'USER' } },
    { id: 'text-1', type: 'TEXT', track: 1, position: 0, startTime: 0, duration: 5,
      assetId: null, trimStart: 0, trimEnd: null,
      properties: { content: 'Hello', x: 0.2, y: 0.42, width: 0.6, height: 0.16, opacity: 1,
        zIndex: 30, origin: 'USER' } },
    { id: 'audio-1', type: 'AUDIO', track: 3, position: 0, startTime: 0, duration: 20,
      assetId: 'asset-audio', trimStart: 0, trimEnd: 20,
      properties: { volume: 0.4, muted: false, fadeInSec: 0, fadeOutSec: 0 } }
  ];
  const assets = overrides.assets ?? [
    { id: 'asset-source', role: 'SOURCE', originalName: 'source.mp4',
      duration: SOURCE_DURATION, width: 1280, height: 720 },
    { id: 'asset-logo', role: 'LOGO', originalName: 'logo.png', duration: null,
      width: 400, height: 240 },
    { id: 'asset-audio', role: 'AUDIO', originalName: 'music.mp3', duration: 60,
      width: null, height: null }
  ];
  return buildChatContext({
    revision: overrides.revision ?? 4,
    settings: {}, style: { ...STYLE, ...(overrides.style ?? {}) },
    elements, assets,
    evidence: overrides.evidence ?? evidenceFixture(),
    thread: overrides.thread ?? EMPTY_THREAD,
    selection: overrides.selection ?? { selectedElementId: null, selectedTimeRange: null,
      playheadSec: 0 },
    message: overrides.message ?? ''
  });
}

/** The fixture's default elements, for tests that add one more. */
const baseElements = () => contextFixture().elements.filter((view) => !view.virtual)
  .map((view) => ({ id: view.id, type: view.type, track: view.track, position: view.position,
    startTime: view.startSec, duration: view.endSec - view.startSec,
    assetId: { 'video-1': 'asset-source', 'logo-1': 'asset-logo', 'audio-1': 'asset-audio' }[view.id]
      ?? null, trimStart: view.trimStartSec, trimEnd: view.trimEndSec,
    properties: view.type === 'IMAGE' ? { role: 'LOGO', x: 0.76, y: 0.04, width: 0.2,
      height: 0.12, opacity: 1, zIndex: 20, origin: 'USER' }
      : view.type === 'TEXT' ? { content: 'Hello', x: 0.2, y: 0.42, width: 0.6, height: 0.16,
        opacity: 1, zIndex: 30, origin: 'USER' }
        : view.type === 'AUDIO' ? { volume: 0.4, muted: false, fadeInSec: 0, fadeOutSec: 0 } : {} }));
const captionElement = () => ({ id: 'caption-1', type: 'SUBTITLE', track: 1, position: 2,
  startTime: 1, duration: 2, assetId: null, trimStart: 0, trimEnd: null,
  properties: { content: 'Welcome back everyone', y: 0.73 } });

/** The Workstream G natural-language layer, on the Phase 6 fixture. */
function natural(message, overrides = {}) {
  return parseNaturalRequest(message, contextFixture({ ...overrides, message }));
}

/** Plans a sentence and resolves it, the way the service does. */
function planAndResolve(message, overrides = {}) {
  const context = contextFixture({ ...overrides, message });
  const intent = planDeterministicChat(message, context);
  if (!intent) return { context, intent: null, resolution: null };
  if (intent.needsClarification) return { context, intent, resolution: null };
  return { context, intent, resolution: resolveChatPlan(intent.commands, intent.grounding, context) };
}

const handleOf = (context, id) =>
  context.elements.find((element) => element.id === id).handle;

console.log('EditMode Phase 6 AI chat editor:');

// --- 1. Command vocabulary and schema ---------------------------------------

{
  assert.ok(CHAT_ELEMENT_ACTIONS.includes('TRIM_ELEMENT'));
  assert.ok(CHAT_ELEMENT_ACTIONS.includes('SPLIT_ELEMENT'));
  assert.ok(CHAT_ELEMENT_ACTIONS.includes('SET_AUDIO_FADE'));
  assert.ok(CHAT_SETTINGS_ACTIONS.includes('SET_ASPECT_RATIO'));
  // Workstream G removed SET_HOOK: it wrote settings.hookText, which nothing
  // renders, so "change the hook" was accepted and changed nothing on screen.
  // The hook is a TEXT element and is edited with SET_TEXT_CONTENT.
  assert.ok(!CHAT_SETTINGS_ACTIONS.includes('SET_HOOK'));
  assert.ok(CHAT_ELEMENT_ACTIONS.includes('SET_TEXT_CONTENT'));

  const valid = validateChatIntent({
    intent: 'EDIT_PROJECT', summary: 'Do a thing',
    commands: [{ action: 'SET_ELEMENT_OPACITY', target: { kind: 'SELECTED' },
      parameters: { opacity: 0.5 }, reason: 'asked' }],
    grounding: [{ type: 'SELECTION', confidence: 0.9, evidence: 'selected' }],
    warnings: [], needsClarification: false, clarificationQuestion: ''
  });
  assert.equal(valid.commands.length, 1);
  assert.equal(valid.commands[0].kind, 'ELEMENT');
  ok('strict intent schema accepts a well-formed plan');

  // 27. malformed LLM JSON rejected
  throws(() => validateChatIntent('not json at all'), 'MALFORMED_PLAN',
    'malformed planner output is rejected');
  throws(() => validateChatIntent({}), 'MALFORMED_PLAN', 'empty planner output is rejected');
  throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', commands: [] }), 'EMPTY_PLAN',
    'a plan with no commands and no question is rejected');

  // 28. unsupported command rejected
  throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: '',
    commands: [{ action: 'RENDER_VIDEO', parameters: {}, reason: '' }],
    grounding: [], warnings: [], needsClarification: false, clarificationQuestion: '' }),
  'UNSUPPORTED_COMMAND', 'an invented action is rejected');
  throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: '',
    commands: [{ action: 'ADD_SUBTITLE', target: { kind: 'SELECTED' }, parameters: {}, reason: '' }],
    grounding: [], warnings: [], needsClarification: false, clarificationQuestion: '' }),
  'UNSUPPORTED_COMMAND', 'a preset-only action is not reachable from chat');

  // 29. LLM cannot inject raw FFmpeg
  const smuggled = validateChatIntent({
    intent: 'EDIT_PROJECT', summary: 'x',
    commands: [{ action: 'SET_ELEMENT_OPACITY', target: { kind: 'SELECTED' },
      parameters: { opacity: 0.5, ffmpegArgs: '-vf crop=1:1', command: 'rm -rf /',
        filtergraph: 'drawtext=...', elementId: 'a-real-uuid', assetId: 'another' },
      reason: '' }],
    grounding: [], warnings: [], needsClarification: false, clarificationQuestion: ''
  });
  assert.deepEqual(Object.keys(smuggled.commands[0].parameters), ['opacity']);
  ok('FFmpeg, shell and raw id parameters are stripped, never forwarded');

  throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: '',
    commands: Array.from({ length: 13 }, () => ({ action: 'ADD_TEXT', parameters: {}, reason: '' })),
    grounding: [], warnings: [], needsClarification: false, clarificationQuestion: '' }),
  'PLAN_TOO_LARGE', 'an oversized plan is rejected');

  throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: '',
    commands: [{ action: 'UPDATE_TEXT', target: { kind: 'REF', ref: 'ghost' },
      parameters: { content: 'x' }, reason: '' }],
    grounding: [], warnings: [], needsClarification: false, clarificationQuestion: '' }),
  'UNKNOWN_REF', 'a ref used before it is created is rejected');

  throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: '',
    commands: [{ action: 'ADD_LOGO', parameters: {}, reason: '' }],
    grounding: [], warnings: [], needsClarification: false, clarificationQuestion: '' }),
  'MISSING_ASSET', 'an ADD command with no asset handle is rejected');

  throws(() => validateChatIntent({ intent: 'EDIT_PROJECT', summary: '',
    commands: [{ action: 'SET_ASPECT_RATIO', parameters: { aspectRatio: '4:3' }, reason: '' }],
    grounding: [], warnings: [], needsClarification: false, clarificationQuestion: '' }),
  'INVALID_CHAT_COMMAND', 'an out-of-enum settings value is rejected');

  assert.equal(requiredConfidenceFor({ kind: 'ELEMENT', action: 'DELETE_ELEMENT' }),
    CHAT_DESTRUCTIVE_CONFIDENCE);
  assert.equal(requiredConfidenceFor({ kind: 'ELEMENT', action: 'SET_ELEMENT_OPACITY' }),
    CHAT_SAFE_CONFIDENCE);
  ok('destructive commands carry a stricter confidence bar than cosmetic ones');
}

// --- 2. Simple timeline language --------------------------------------------

{
  // 1. simple trim language
  const { resolution } = planAndResolve('Remove the first 3 seconds');
  assert.ok(resolution.ok);
  const trim = resolution.commands.find((command) => command.action === 'TRIM_ELEMENT');
  // The refit runs before the cut, so the timeline is never momentarily invalid.
  assert.equal(resolution.commands.at(-1).action, 'TRIM_ELEMENT');
  assert.equal(trim.payload.trimStart, 3);
  assert.equal(trim.payload.trimEnd, SOURCE_DURATION);
  ok('"remove the first 3 seconds" becomes an exact trim');

  // The logo covered the whole clip, so the shorter timeline no longer fits it.
  // The plan says so out loud rather than letting the canonical validator fail.
  const refit = resolution.commands.filter((command) =>
    command.action === 'SET_ELEMENT_TIMING');
  assert.equal(refit.length, 1);
  assert.equal(refit[0].payload.elementId, 'logo-1');
  assert.equal(refit[0].payload.duration, SOURCE_DURATION - 3);
  assert.ok(resolution.plannedChanges.some((line) => /Show logo/iu.test(line)));
  ok('a trim that shortens the timeline refits overflowing overlays, visibly');

  // An overlay that already fits is left completely alone.
  assert.ok(!resolution.commands.some((command) => command.payload.elementId === 'text-1'));
  assert.ok(!resolution.commands.some((command) => command.payload.elementId === 'audio-1'));
  ok('overlays that still fit are not touched by a trim');

  const last = planAndResolve('cut the last 2 seconds').resolution;
  const lastTrim = last.commands.find((command) => command.action === 'TRIM_ELEMENT');
  assert.equal(lastTrim.payload.trimStart, 0);
  assert.equal(Number(lastTrim.payload.trimEnd.toFixed(3)), SOURCE_DURATION - 2);
  ok('"cut the last 2 seconds" trims the tail, not the head');

  const spokenAmount = planAndResolve('remove the first second').resolution;
  assert.equal(spokenAmount.commands.find((command) =>
    command.action === 'TRIM_ELEMENT').payload.trimStart, 1);
  ok('"remove the first second" is understood as one second');

  const spokenTwo = planAndResolve('cut the last two seconds').resolution;
  assert.equal(Number(spokenTwo.commands.find((command) =>
    command.action === 'TRIM_ELEMENT').payload.trimEnd.toFixed(3)), SOURCE_DURATION - 2);
  ok('"cut the last two seconds" understands the spelled-out amount');

  // 24. timestamps validated / interior cut geometry
  const mid = planAndResolve('cut from 12 to 17 seconds').resolution;
  assert.deepEqual(mid.commands.slice(-3).map((command) => command.action),
    ['SPLIT_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT']);
  // The segment locator is `targetAtSec` (Workstream G): `atSec` is a real
  // SPLIT_CAPTION parameter and the bundle must not consume it.
  assert.equal(mid.commands.at(-3).payload.targetAtSec, 12);
  assert.equal(mid.commands.at(-2).payload.targetAtSec, 17);
  assert.equal(mid.commands.at(-1).payload.targetAtSec, 14.5);
  ok('an interior range becomes split/split/delete addressed by time');

  const past = planAndResolve('cut from 12 to 400 seconds');
  assert.equal(past.intent.needsClarification, true);
  assert.match(past.intent.clarificationQuestion, /past the end/u);
  ok('a timestamp beyond the timeline is refused, not clamped silently');

  // 3. split at playhead
  const split = planAndResolve('split here', {
    selection: { selectedElementId: 'video-1', selectedTimeRange: null, playheadSec: 8.25 }
  }).resolution;
  assert.equal(split.commands[0].action, 'SPLIT_ELEMENT');
  assert.equal(split.commands[0].payload.playheadSec, 8.25);
  ok('"split here" uses the playhead');

  const splitAt = planAndResolve('split at 6 seconds').resolution;
  assert.equal(splitAt.commands[0].payload.playheadSec, 6);
  ok('"split at 6 seconds" uses the stated time over the playhead');

  // 2. delete selected element
  const del = planAndResolve('delete this', {
    selection: { selectedElementId: 'logo-1', selectedTimeRange: null, playheadSec: 0 }
  }).resolution;
  assert.equal(del.commands[0].action, 'REMOVE_ELEMENT');
  assert.equal(del.commands[0].payload.elementId, 'logo-1');
  ok('"delete this" removes the selected overlay');

  const delVideo = planAndResolve('delete this', {
    selection: { selectedElementId: 'video-1', selectedTimeRange: null, playheadSec: 0 }
  }).resolution;
  assert.equal(delVideo.commands[0].action, 'DELETE_ELEMENT');
  ok('deleting a selected VIDEO uses the ripple delete, not overlay removal');
}

// --- 3. Overlays, text and assets -------------------------------------------

{
  // 4. add text + 5. update text
  const { resolution } = planAndResolve('Add text saying Subscribe');
  assert.deepEqual(resolution.commands.map((command) => command.action),
    ['ADD_TEXT', 'UPDATE_TEXT']);
  assert.equal(resolution.commands[0].ref, 'newtext');
  assert.equal(resolution.commands[1].payload.ref, 'newtext');
  assert.equal(resolution.commands[1].payload.content, 'Subscribe');
  ok('"add text saying Subscribe" creates the element and sets its exact wording');

  const retext = planAndResolve('change the text to Follow for more').resolution;
  assert.equal(retext.commands[0].action, 'UPDATE_TEXT');
  assert.equal(retext.commands[0].payload.elementId, 'text-1');
  assert.equal(retext.commands[0].payload.content, 'Follow for more');
  ok('"change the text to X" edits the existing text verbatim');

  // 6. add known logo
  const logo = planAndResolve('Add my logo top right');
  assert.ok(logo.resolution.ok);
  assert.equal(logo.resolution.commands[0].action, 'ADD_LOGO');
  assert.equal(logo.resolution.commands[0].payload.assetId, 'asset-logo');
  assert.equal(logo.resolution.commands[1].action, 'MOVE_ELEMENT');
  assert.equal(logo.resolution.commands[1].payload.x, 0.76);
  assert.equal(logo.resolution.commands[1].payload.y, 0.04);
  ok('"add my logo top right" resolves the uploaded asset and places it');

  // 7. unknown logo requires clarification
  const noLogo = planAndResolve('add my logo', {
    assets: [{ id: 'asset-source', role: 'SOURCE', originalName: 'source.mp4',
      duration: SOURCE_DURATION, width: 1280, height: 720 }]
  });
  assert.equal(noLogo.intent.needsClarification, true);
  assert.match(noLogo.intent.clarificationQuestion, /no logo uploaded/iu);
  ok('a logo that was never uploaded is reported, never invented');

  const twoLogos = planAndResolve('add my logo', {
    assets: [
      { id: 'asset-source', role: 'SOURCE', originalName: 'source.mp4', duration: SOURCE_DURATION,
        width: 1280, height: 720 },
      { id: 'logo-a', role: 'LOGO', originalName: 'brand-a.png', duration: null,
        width: 100, height: 100 },
      { id: 'logo-b', role: 'LOGO', originalName: 'brand-b.png', duration: null,
        width: 100, height: 100 }
    ]
  });
  assert.equal(twoLogos.intent.needsClarification, true);
  assert.match(twoLogos.intent.clarificationQuestion, /brand-a\.png/u);
  ok('two candidate logos produce a question listing both');

  const timed = planAndResolve('use music.mp3 at 5 seconds for 4 seconds').resolution;
  const timing = timed.commands.find((command) => command.action === 'SET_ELEMENT_TIMING');
  assert.equal(timing.payload.startTime, 5);
  assert.equal(timing.payload.duration, 4);
  ok('"at 5 seconds for 4 seconds" becomes an explicit on-screen window');

  // 25. invalid asset rejected (by name, at resolution time)
  const badAsset = resolveChatPlan([{ kind: 'ELEMENT', action: 'ADD_LOGO',
    assetHandle: 'asset99', parameters: {}, reason: '' }], [], contextFixture());
  assert.equal(badAsset.ok, false);
  assert.match(badAsset.question, /could not find that file/iu);
  ok('an asset handle that names nothing is refused');

  const wrongRole = resolveChatPlan([{ kind: 'ELEMENT', action: 'ADD_LOGO',
    assetHandle: handleOfAsset(contextFixture(), 'asset-audio'), parameters: {}, reason: '' }],
  [], contextFixture());
  assert.equal(wrongRole.ok, false);
  assert.match(wrongRole.question, /stored as a audio/iu);
  ok('an audio file offered as a logo is refused');
}

function handleOfAsset(context, id) {
  return context.assets.find((asset) => asset.id === id).handle;
}

// --- 4. Selection, ambiguity and follow-ups ---------------------------------

{
  // 8. ambiguous "make it smaller" requires clarification
  const ambiguous = planAndResolve('make it smaller');
  assert.equal(ambiguous.intent.needsClarification, true);
  assert.match(ambiguous.intent.clarificationQuestion, /which element/iu);
  ok('"make it smaller" with nothing selected asks instead of guessing');

  // 9. selected logo "make it smaller" resolves correctly
  const selected = planAndResolve('make it smaller', {
    selection: { selectedElementId: 'logo-1', selectedTimeRange: null, playheadSec: 0 }
  });
  assert.ok(selected.resolution.ok);
  assert.equal(selected.resolution.commands[0].action, 'RESIZE_ELEMENT');
  assert.equal(selected.resolution.commands[0].payload.elementId, 'logo-1');
  assert.ok(Math.abs(selected.resolution.commands[0].payload.width - 0.16) < 1e-6);
  ok('"make it smaller" with the logo selected resizes exactly that logo');

  const named = planAndResolve('make the logo smaller').resolution;
  assert.equal(named.commands[0].payload.elementId, 'logo-1');
  ok('naming the logo works without any selection');

  // 10. follow-up refers to last affected element
  const followUp = planAndResolve('make it smaller', {
    thread: { ...EMPTY_THREAD, lastAffectedElementIds: ['logo-1'] }
  });
  assert.ok(followUp.resolution.ok);
  assert.equal(followUp.resolution.commands[0].payload.elementId, 'logo-1');
  ok('a follow-up with no selection targets the last element the chat touched');

  const moveFollowUp = planAndResolve('move it a little lower', {
    thread: { ...EMPTY_THREAD, lastAffectedElementIds: ['text-1'] }
  });
  assert.equal(moveFollowUp.resolution.commands[0].action, 'MOVE_ELEMENT');
  assert.equal(moveFollowUp.resolution.commands[0].payload.elementId, 'text-1');
  assert.ok(moveFollowUp.resolution.commands[0].payload.y > 0.42);
  ok('"move it a little lower" nudges the same element the previous turn created');

  // A follow-up must not create a second copy of the thing.
  assert.ok(!followUp.resolution.commands.some((command) => command.action.startsWith('ADD_')));
  ok('a follow-up never adds a second element');

  // 11. move element / 12. opacity / 13-15 audio
  const moved = planAndResolve('move the logo down').resolution;
  assert.equal(moved.commands[0].action, 'MOVE_ELEMENT');
  assert.ok(moved.commands[0].payload.y > 0.04);
  ok('"move the logo down" changes only y');

  const faded = planAndResolve('make the logo more transparent').resolution;
  assert.equal(faded.commands[0].action, 'SET_ELEMENT_OPACITY');
  assert.ok(faded.commands[0].payload.opacity < 1);
  ok('"more transparent" lowers opacity');

  const front = planAndResolve('bring the text to front').resolution;
  assert.equal(front.commands[0].action, 'SET_ELEMENT_Z_INDEX');
  assert.equal(front.commands[0].payload.zIndex, 90);
  ok('"bring the text to front" raises the layer');

  const quieter = planAndResolve('lower the music').resolution;
  assert.equal(quieter.commands[0].action, 'SET_AUDIO_VOLUME');
  assert.ok(Math.abs(quieter.commands[0].payload.volume - 0.2) < 1e-6);
  ok('"lower the music" halves the current volume');

  const muted = planAndResolve('mute the music').resolution;
  assert.equal(muted.commands[0].action, 'SET_AUDIO_MUTED');
  assert.equal(muted.commands[0].payload.muted, true);
  ok('"mute the music" mutes the audio element');

  const fade = planAndResolve('fade the music in for 2 seconds').resolution;
  assert.equal(fade.commands[0].action, 'SET_AUDIO_FADE');
  assert.equal(fade.commands[0].payload.fadeInSec, 2);
  assert.equal(fade.commands[0].payload.fadeOutSec, 0);
  ok('"fade the music in for 2 seconds" sets only the fade-in');
}

// --- 5. Project style commands ----------------------------------------------

{
  // 16-21
  const aspect = planAndResolve('make it 9:16').resolution;
  assert.equal(aspect.commands[0].kind, 'SETTINGS');
  assert.equal(aspect.commands[0].action, 'SET_ASPECT_RATIO');
  assert.equal(aspect.commands[0].payload.aspectRatio, '9:16');
  ok('"make it 9:16" sets the aspect ratio');

  // Workstream G: caption on/off acts on the caption ELEMENTS. The Phase 6
  // version set subtitlePolicy, which does not hide caption elements that exist.
  const hide = natural('turn subtitles off', { elements: [...baseElements(), captionElement()] });
  assert.equal(hide.outcomes[0].commands[0].action, 'SET_CAPTIONS_VISIBLE');
  assert.equal(hide.outcomes[0].commands[0].parameters.visible, false);
  const add = natural('turn subtitles on');
  assert.ok(add.outcomes[0].type === 'QUESTION' ||
    add.outcomes[0].commands[0].action === 'GENERATE_CAPTIONS');
  assert.ok(!JSON.stringify(add).includes('SET_SUBTITLE_POLICY'));
  ok('"turn subtitles on/off" acts on caption elements, never on a policy that hides nothing');

  const zoom = planAndResolve('use subtle zoom').resolution;
  assert.equal(zoom.commands[0].action, 'SET_AUTO_ZOOM');
  assert.equal(zoom.commands[0].payload.zoomPolicy, 'SUBTLE');
  ok('"use subtle zoom" sets the zoom policy');

  const reframe = planAndResolve("don't crop the slide").resolution;
  assert.equal(reframe.commands[0].action, 'SET_AUTO_REFRAME');
  assert.equal(reframe.commands[0].payload.reframePolicy, 'INFORMATION_PRESERVING');
  ok('"don\'t crop the slide" preserves on-screen information');

  const pair = planAndResolve('keep both people visible').resolution;
  assert.equal(pair.commands[0].payload.reframePolicy, 'FACE_FOCUSED');
  ok('"keep both people visible" chooses face-focused framing');

  const grading = planAndResolve('use clean grading').resolution;
  assert.equal(grading.commands[0].action, 'SET_COLOR_GRADE');
  assert.equal(grading.commands[0].payload.gradingPolicy, 'CLEAN');
  ok('"use clean grading" sets the grade');

  // Workstream G: "remove the hook" removes the hook ELEMENT that is on
  // screen. The Phase 6 version cleared settings.hookText and left it there.
  const hookFixture = [...baseElements(), { id: 'hook-1', type: 'TEXT', track: 1, position: 1,
    startTime: 0, duration: 3, assetId: null, trimStart: 0, trimEnd: null,
    properties: { content: 'Old hook', presetRole: 'HOOK', origin: 'PRESET', x: 0.1, y: 0.1,
      width: 0.8, height: 0.15 } }];
  const hook = natural('remove the hook', { elements: hookFixture });
  const hookContext = contextFixture({ elements: hookFixture, message: 'remove the hook' });
  const removal = resolveChatPlan(hook.outcomes[0].commands, [], hookContext);
  assert.equal(removal.commands[0].action, 'REMOVE_ELEMENT');
  assert.equal(removal.commands[0].payload.elementId, 'hook-1');
  assert.equal(planDeterministicChat('remove the hook', hookContext)?.commands
    ?.some((command) => command.action === 'SET_HOOK') ?? false, false);
  ok('"remove the hook" removes the on-screen hook element');

  const noTranscriptSubs = natural('turn subtitles on', {
    evidence: evidenceFixture({ transcript: false })
  });
  assert.equal(noTranscriptSubs.outcomes[0].type, 'QUESTION');
  assert.match(noTranscriptSubs.outcomes[0].question, /Analyze source/u);
  ok('enabling captions without a transcript asks rather than pretending');
}

// --- 6. Transcript grounding ------------------------------------------------

{
  const words = evidenceFixture().words;

  // Terms come back stemmed, so "pricing" also matches "price" and "priced".
  assert.deepEqual(topicTerms('remove the part where I talk about pricing'), ['pric']);
  assert.deepEqual(topicTerms('cut the pricing'), topicTerms('cut the price'));
  ok('topic extraction strips stop words and editing verbs, and stems what remains');

  // 22. transcript-grounded range resolution
  const compound = resolveTranscriptSpan(words, 'cut the section about compound interest');
  assert.equal(compound.reason, 'RESOLVED');
  assert.ok(compound.span.text.toLowerCase().includes('compound'));
  assert.ok(compound.span.startSec > 0 && compound.span.endSec <= SOURCE_DURATION);
  ok('"the section about compound interest" resolves to a real transcript span');

  const savings = resolveTranscriptSpan(words, 'remove the bit about reinvesting savings');
  assert.equal(savings.reason, 'RESOLVED');
  assert.ok(savings.span.text.toLowerCase().includes('reinvesting'));
  ok('a second topic resolves to its own span');

  // The speaker mentions pricing in two different places, so a request naming
  // it has two equally good answers - which is a question, not a coin toss.
  const pricing = resolveTranscriptSpan(words, 'remove the part where I talk about pricing');
  assert.equal(pricing.span, null);
  assert.equal(pricing.reason, 'AMBIGUOUS');
  assert.ok(pricing.candidates.length >= 2);
  ok('a topic mentioned twice is reported ambiguous rather than guessed');

  // 23. low-confidence transcript match not applied
  const absent = resolveTranscriptSpan(words, 'remove the part about kubernetes networking');
  assert.equal(absent.span, null);
  assert.ok(['NO_MATCH', 'LOW_CONFIDENCE'].includes(absent.reason));
  ok('a topic that was never said resolves to nothing, not to a guess');

  const empty = searchTranscript([], 'anything');
  assert.deepEqual(empty, []);
  ok('searching an empty transcript returns no candidates');

  // A semantic delete with no transcript asks rather than falling through.
  const noTranscript = planAndResolve('remove the part where I talk about pricing', {
    evidence: evidenceFixture({ transcript: false })
  });
  assert.equal(noTranscript.intent.needsClarification, true);
  assert.match(noTranscript.intent.clarificationQuestion, /Analyze source/u);
  ok('a semantic cut without analysis asks for analysis first');

  // The deterministic planner defers semantic cuts to the model.
  const deferred = planDeterministicChat('remove the part where I talk about pricing',
    contextFixture({ message: 'remove the part where I talk about pricing' }));
  assert.equal(deferred, null);
  ok('the deterministic planner defers semantic cuts rather than guessing');

  // Model-invented ranges are discarded.
  const context = contextFixture({ message: 'cut the pricing part' });
  assert.ok(context.transcript.windows.length > 0);
  const invented = rejectInventedTimestamps({
    intent: 'EDIT_PROJECT', summary: 'cut', commands: [{ kind: 'ELEMENT',
      action: 'DELETE_ELEMENT', target: { kind: 'AT_TIME', atSec: 33 }, parameters: {},
      reason: '' }],
    grounding: [{ type: 'TRANSCRIPT', confidence: 0.95, evidence: 'made up',
      startSec: 33, endSec: 36 }],
    warnings: [], needsClarification: false, clarificationQuestion: ''
  }, context);
  assert.equal(invented.needsClarification, true);
  assert.equal(invented.commands.length, 0);
  ok('a transcript range the search never offered is discarded, not applied');

  const honest = rejectInventedTimestamps({
    intent: 'EDIT_PROJECT', summary: 'cut', commands: [{ kind: 'ELEMENT',
      action: 'DELETE_ELEMENT', target: { kind: 'AT_TIME', atSec: 1 }, parameters: {},
      reason: '' }],
    grounding: [{ type: 'TRANSCRIPT', confidence: 0.8, evidence: 'real',
      startSec: context.transcript.windows[0].startSec,
      endSec: context.transcript.windows[0].endSec }],
    warnings: [], needsClarification: false, clarificationQuestion: ''
  }, context);
  assert.equal(honest.needsClarification, false);
  assert.equal(honest.commands.length, 1);
  ok('a range that matches a supplied window survives');
}

// --- 7. Resolution safety ---------------------------------------------------

{
  const context = contextFixture();

  // 26. invalid element rejected
  const ghost = resolveChatPlan([{ kind: 'ELEMENT', action: 'SET_ELEMENT_OPACITY',
    target: { kind: 'ELEMENT', handle: 'el99' }, parameters: { opacity: 0.5 }, reason: '' }],
  [], context);
  assert.equal(ghost.ok, false);
  assert.match(ghost.question, /no longer on the timeline/iu);
  ok('a handle for an element that is not there is refused');

  const noSelection = resolveChatPlan([{ kind: 'ELEMENT', action: 'RESIZE_ELEMENT',
    target: { kind: 'SELECTED' }, parameters: { width: 0.1, height: 0.1 }, reason: '' }],
  [], context);
  assert.equal(noSelection.ok, false);
  ok('a SELECTED target with no selection becomes a question');

  const noLast = resolveChatPlan([{ kind: 'ELEMENT', action: 'RESIZE_ELEMENT',
    target: { kind: 'LAST' }, parameters: { width: 0.1, height: 0.1 }, reason: '' }],
  [], context);
  assert.equal(noLast.ok, false);
  ok('a LAST target with no history becomes a question');

  // 24. timestamps validated at resolution too
  const past = resolveChatPlan([{ kind: 'ELEMENT', action: 'SET_ELEMENT_TIMING',
    target: { kind: 'ELEMENT', handle: handleOf(context, 'text-1') },
    parameters: { startTime: 500, duration: 2 }, reason: '' }], [], context);
  assert.equal(past.ok, false);
  assert.match(past.question, /past the end/u);
  ok('a start time past the end of the timeline is refused');

  const overrun = resolveChatPlan([{ kind: 'ELEMENT', action: 'SET_ELEMENT_TIMING',
    target: { kind: 'ELEMENT', handle: handleOf(context, 'text-1') },
    parameters: { startTime: 38, duration: 10 }, reason: '' }], [], context);
  assert.ok(overrun.ok);
  assert.equal(overrun.commands[0].payload.duration, 2);
  assert.ok(overrun.warnings.some((warning) => /Shortened to fit/u.test(warning)));
  ok('a duration running past the end is shortened with a visible warning');

  // Destructive commands need stronger grounding.
  const weakCut = resolveChatPlan([{ kind: 'ELEMENT', action: 'DELETE_ELEMENT',
    target: { kind: 'ELEMENT', handle: handleOf(context, 'video-1') }, parameters: {},
    reason: '' }], [{ type: 'TRANSCRIPT', confidence: 0.5, evidence: 'maybe' }], context);
  assert.equal(weakCut.ok, false);
  assert.match(weakCut.question, /not confident enough/iu);
  ok('a weakly grounded delete is refused and turned into a question');

  const weakCosmetic = resolveChatPlan([{ kind: 'ELEMENT', action: 'SET_ELEMENT_OPACITY',
    target: { kind: 'ELEMENT', handle: handleOf(context, 'logo-1') }, parameters: { opacity: 0.5 },
    reason: '' }], [{ type: 'TRANSCRIPT', confidence: 0.65, evidence: 'probably' }], context);
  assert.ok(weakCosmetic.ok);
  ok('the same confidence is acceptable for a reversible cosmetic change');

  // Plain-language preview, never raw JSON.
  const described = resolveChatPlan([{ kind: 'ELEMENT', action: 'SET_AUDIO_VOLUME',
    target: { kind: 'ELEMENT', handle: handleOf(context, 'audio-1') }, parameters: { volume: 0.1 },
    reason: '' }], [], context);
  assert.match(described.plannedChanges[0], /volume to 10%/u);
  assert.ok(!described.plannedChanges[0].includes('{'));
  ok('planned changes read as sentences, not as command JSON');
}

// --- 8. Context bounding ----------------------------------------------------

{
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `text-${index}`, type: 'TEXT', track: 1, position: index, startTime: 0, duration: 1,
    assetId: null, trimStart: 0, trimEnd: null, properties: { content: `Line ${index}` }
  }));
  const context = contextFixture({ elements: [
    { id: 'video-1', type: 'VIDEO', track: 0, position: 0, startTime: 0,
      duration: SOURCE_DURATION, assetId: 'asset-source', trimStart: 0,
      trimEnd: SOURCE_DURATION, properties: {} },
    ...many
  ], selection: { selectedElementId: 'text-39', selectedTimeRange: null, playheadSec: 0 } });
  assert.ok(context.elements.length <= 26);
  // Workstream G reports truncation per kind ("Only 12 of 40 text elements...").
  assert.ok(context.notes.some((note) => /of 40 text elements are listed/u.test(note)));
  ok('a crowded project is bounded before it reaches the planner');

  const selected = context.elements.find((element) => element.selected);
  assert.equal(selected.id, 'text-39');
  ok('the selection stays addressable even when it falls outside the caps');

  assert.ok(context.transcript.excerpt.length <= 1200);
  ok('the transcript excerpt is bounded');

  const full = contextFixture();
  // Workstream G handles are opaque ROLE handles ("logo:main", "audio:music1",
  // "asset:logo1") rather than "el3" - readable, still never a database id.
  assert.ok(full.elements.every((element) => /^[a-z]+:[a-z0-9]+$/u.test(element.handle)));
  assert.ok(full.assets.every((asset) => /^asset:[a-z]+\d+$/u.test(asset.handle)));
  assert.ok(full.elements.every((element) => !element.handle.includes(element.id)));
  assert.ok(!JSON.stringify(full.elements.map((element) => element.properties))
    .includes('asset-logo'));
  ok('elements and assets are exposed only behind logical handles');
}

// --- 9. Thread state and proposal storage -----------------------------------

{
  const thread = readChatThread({ chat: { messages: [
    { id: 'a', role: 'USER', text: 'hi', createdAt: 'now' },
    { id: 'b', role: 'NOPE', text: 'x', createdAt: 'now' },
    { role: 'ASSISTANT', text: 'no id', createdAt: 'now' }
  ], lastAffectedElementIds: ['x'], lastAppliedSummary: 'did a thing' } });
  assert.equal(thread.messages.length, 1);
  assert.deepEqual(thread.lastAffectedElementIds, ['x']);
  ok('a malformed stored thread is read defensively');

  const long = boundChatThread({ ...EMPTY_THREAD,
    messages: Array.from({ length: 80 }, (_, index) => ({ id: `m${index}`, role: 'USER',
      text: 'x'.repeat(5000), createdAt: 'now' })),
    lastAffectedElementIds: Array.from({ length: 30 }, (_, index) => `e${index}`) });
  assert.equal(long.messages.length, CHAT_MAX_MESSAGES);
  assert.ok(long.messages[0].text.length <= 2000);
  assert.ok(long.lastAffectedElementIds.length <= 8);
  ok('the stored thread is bounded so settings cannot grow without limit');

  // Phase 7 made the store async and Redis-backed. These checks run against
  // the in-process fallback (REDIS_URL is unset for this offline suite), which
  // is the same code path a Redis outage takes.
  proposalStoreChecks = async () => {
    const store = new EditChatProposalStore();
    const base = { editProjectId: 'p1', baseRevision: 1, state: 'READY', userMessage: 'x',
      summary: 's', plannedChanges: [], warnings: [], needsClarification: false,
      clarificationQuestion: '', affectedElements: [], plannedDurationSec: 10, grounding: [],
      commands: [{ kind: 'ELEMENT', action: 'ADD_TEXT', payload: {}, reason: '' }],
      resolvedTargets: {}, planner: 'DETERMINISTIC' };
    const saved = await store.save({ ...base, proposalId: 'prop-1' });
    assert.equal((await store.get('prop-1', 'p1')).proposalId, 'prop-1');
    assert.equal(await store.get('prop-1', 'other-project'), null);
    ok('a proposal is only readable by the project that owns it');

    for (let index = 0; index < 10; index += 1) {
      await store.save({ ...base, proposalId: `bulk-${index}` });
    }
    assert.ok(await store.countFor('p1') <= 8);
    ok('per-project proposal storage is bounded');

    const view = proposalView(saved);
    assert.equal(view.commands, undefined);
    assert.equal(view.resolvedTargets, undefined);
    assert.equal(view.editProjectId, undefined);
    ok('the client-facing proposal never carries the command bundle');
    await store.onModuleDestroy();
  };
}

// --- 10. FALLBACK behaviour --------------------------------------------------

{
  // 38. FALLBACK deterministic simple command
  const simple = planDeterministicChat('mute the music', contextFixture());
  assert.ok(simple);
  assert.equal(simple.needsClarification, false);
  ok('FALLBACK_ONLY still handles a direct command with no provider');

  // 39. FALLBACK semantic unsupported handled safely
  // Workstream G, Part 21: the canned "I can still do direct edits - for
  // example ..." menu is gone - it was shown even to "change the on screen
  // hook". What reaches the fallback now genuinely was not understood, so it
  // proposes nothing and asks ONE question naming this project's own objects.
  const unsupported = fallbackUnsupported(contextFixture());
  assert.equal(unsupported.intent, 'NEEDS_CLARIFICATION');
  assert.equal(unsupported.commands.length, 0);
  assert.equal(unsupported.needsClarification, true);
  assert.match(unsupported.clarificationQuestion, /the logo, the music/u);
  assert.doesNotMatch(unsupported.clarificationQuestion, /I can still do direct edits/u);
  ok('an unparseable request proposes nothing and asks one question about this project');

  assert.equal(planDeterministicChat('', contextFixture()), null);
  assert.equal(planDeterministicChat('what do you think of my video?', contextFixture()), null);
  ok('chatter the planner does not understand produces no commands');
}

// --- 11. Isolation ----------------------------------------------------------

{
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = path.join(__dirname, '..', 'src', 'modules', 'edit-mode', 'chat');
  const sources = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'));
  const all = sources.join('\n');

  // 40-44
  for (const forbidden of ['ProcessingQueueService', 'VideoProcessorService',
    'ClipSelectionService', 'ClipRenderQueueService', 'ClipExportService',
    'processingJob', 'clipCandidate', 'generatedClip', 'BullMQ', 'bullmq']) {
    assert.ok(!all.includes(forbidden), `chat must not reference ${forbidden}`);
  }
  ok('the chat layer references no frozen pipeline service or model');

  // 44. no export triggered automatically
  assert.ok(!all.includes('EditModeRenderService') && !/startExport/u.test(all));
  ok('the chat layer never starts an export');

  // No second mutation path.
  for (const source of sources) {
    assert.ok(!/tx\.editElement|prisma\.editElement|editElement\.create/u.test(source),
      'chat must not write EditElement rows directly');
  }
  ok('nothing in the chat layer writes an EditElement');

  // FFmpeg stays out of the planning layer entirely.
  assert.ok(!/ffmpeg|execFile|spawn\(/u.test(all.replace(/FFmpeg/gu, '')),
    'chat must not reach FFmpeg or a shell');
  ok('the chat layer cannot reach FFmpeg or a shell');

  const service = fs.readFileSync(path.join(directory, 'edit-chat.service.ts'), 'utf8');
  assert.ok(service.includes('applyAssistantBundle'),
    'apply must go through the canonical bundle');
  ok('Apply goes through the canonical EditMode bundle, not a private path');

  // The canonical layer registers the assistant action for undo/redo.
  const canonical = fs.readFileSync(path.join(directory, '..', 'edit-mode.service.ts'), 'utf8');
  assert.ok(/MANUAL_ACTIONS[\s\S]{0,200}APPLY_ASSISTANT_EDIT/u.test(canonical));
  ok('APPLY_ASSISTANT_EDIT is an undoable user-level action');
  // Step 5 threads an execution actor through; AI turns still record ASSISTANT
  // (template runs record TEMPLATE).
  assert.ok(canonical.includes("actor: actor === 'TEMPLATE_ACTION' ? 'TEMPLATE' : 'ASSISTANT'"));
  ok('an applied chat turn is recorded with the ASSISTANT actor');
}

void proposalStoreChecks().then(() => {
  console.log(`EditMode chat tests passed (${passed} checks).`);
}).catch((error) => { console.error(error); process.exit(1); });
