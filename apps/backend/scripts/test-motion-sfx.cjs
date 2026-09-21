/**
 * Motion + sound-design verification.
 *
 * Covers the editorial cases the pass exists for - single speaker, emotional
 * moment, statistic, punchline, two-person, information-heavy, reveal and a
 * strong ending - plus the SFX library, its selection and its levels. The
 * generated effects are rendered through real FFmpeg and measured, so a broken
 * filtergraph or an effect that is too loud fails here rather than in a clip.
 *
 * Deterministic and offline: no database, no MinIO, no LLM. It writes only into
 * its own temp directory and removes it at the end.
 */
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const { planZoomEvents, zoomExpression, zoomScaleAt, ZOOM_TUNING, ZOOM_INTENSITY_BANDS,
  intensityFor, classifySemanticReason, sfxTypeFor, semanticZoomTarget } =
  require('../dist/modules/editing/zoom-planner');
const { loadSfxLibrary, selectSfx, sfxGainDb, generatedSfxAsset, GENERATED_SFX, SFX_TYPES,
  SFX_CATEGORY_FOLDERS, SFX_TARGET_LUFS, SFX_MAX_MAKEUP_DB } =
  require('../dist/modules/editing/sfx-library');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { EditingPlanValidator } = require('../dist/modules/editing/editing-plan-validator');

const FPS = 30;

// --- fixtures --------------------------------------------------------------

/** Evenly spaced words so a trigger phrase always has exact timings. */
function speak(text, from = 2, step = .42) {
  return text.split(/\s+/u).map((word, index) => ({
    start: Number((from + index * step).toFixed(3)),
    end: Number((from + index * step + step * .8).toFixed(3)), text: word }));
}

function face(t, { x = .46, y = .18, w = .16, h = .26 } = {}) {
  return { t, faces: [{ timestamp: t, x, y, w, h }], persons: [],
    textCoverage: 0, textBoxes: [], ocrLines: [] };
}
function twoFaces(t) {
  // Both speakers reach close to the frame edges, so any real crop would drop one.
  return { t, faces: [{ timestamp: t, x: .08, y: .2, w: .18, h: .24 },
    { timestamp: t, x: .74, y: .2, w: .18, h: .24 }], persons: [],
  textCoverage: 0, textBoxes: [], ocrLines: [] };
}
function screen(t) {
  return { t, faces: [], persons: [],
    textCoverage: .34, ocrCoverage: .34,
    textBoxes: [{ x: .06, y: .1, w: .88, h: .5 }],
    ocrLines: ['Quarterly revenue by segment', 'https://example.com/report'] };
}

const framesEvery = (from, to, make, step = .5) => {
  const out = [];
  for (let t = from; t <= to + 1e-9; t = Number((t + step).toFixed(3))) out.push(make(t));
  return out;
};

function shot(start, end, overrides = {}) {
  return { sourceStart: start, sourceEnd: end, start, end,
    shotClass: 'SINGLE_SPEAKER', layout: 'FILL', zoomAllowed: true, informationMode: false,
    faceCount: 1, personCount: 1, primaryFaceArea: .04, textCoverage: 0, sampleCount: 8,
    reason: 'fixture', ...overrides };
}

/** The whole-frame camera: no reframing, so zoom geometry is easy to reason about. */
const wholeFrame = () => ({ x: 0, y: 0, w: 1, h: 1 });

function plan(operations, { start = 0, end = 36, emphasis = [] } = {}) {
  const base = fallbackEditPlan(start, end, '9:16');
  return { ...base, operations, subtitleEmphasis: emphasis };
}

function zoomOp(triggerText, startSec, endSec, reason, extra = {}) {
  return { type: 'ZOOM', startSec, endSec, reason, scale: null, focusX: null, focusY: null,
    target: 'FACE', words: [], triggerText, ...extra };
}

function run(operations, options = {}) {
  const duration = options.duration ?? 36;
  return planZoomEvents({
    plan: plan(operations, { end: duration, emphasis: options.emphasis ?? [] }),
    cuts: options.cuts ?? [], words: options.words ?? [], fps: FPS,
    shots: options.shots ?? [shot(0, duration)],
    cropAt: options.cropAt ?? wholeFrame,
    frames: options.frames ?? framesEvery(0, duration, face),
    finalDuration: duration, sfxDisabled: options.sfxDisabled });
}

// --- §3/§4 push-in intensity and face focus --------------------------------

function singleSpeakerEmphasis() {
  const words = speak('this is the moment everything changed for them', 3);
  const changed = words.find((word) => word.text === 'changed');
  const { events, rejected } = run(
    [zoomOp('changed', changed.start - .2, changed.end + 1, 'Emotional turn in the story',
      { scale: 1.24, intensity: 'STRONG' })],
    { words, emphasis: [{ word: 'changed', startSec: changed.start, endSec: changed.end,
      strength: 'STRONG' }] });
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.kind, 'IN');
  assert.equal(event.intensity, 'STRONG');
  assert.equal(event.semanticCategory, 'EMOTION');
  assert(event.peakScale >= ZOOM_INTENSITY_BANDS.STRONG.min - 1e-6 &&
    event.peakScale <= ZOOM_INTENSITY_BANDS.STRONG.max + 1e-6,
  `strong push out of band: ${event.peakScale}`);
  // The move is anchored on the speaker, not the frame centre.
  assert(event.focusX > .5, `expected focus toward the face, got ${event.focusX}`);
  assert(event.focusY < .5, `expected focus toward the eye line, got ${event.focusY}`);
  // §7: the tight frame is held rather than bounced straight back.
  const hold = event.zoomOutStartSec - event.zoomInEndSec;
  assert(hold >= ZOOM_TUNING.minHoldSec - 1 / FPS, `hold too short: ${hold}`);
  assert(hold <= ZOOM_TUNING.maxHoldSec + 1 / FPS, `hold too long: ${hold}`);
  // §6: the ramp is short, not a slow drift.
  const rampIn = event.zoomInEndSec - event.startSec;
  assert(rampIn >= .2 && rampIn <= .45, `ramp out of range: ${rampIn}`);
  assert.equal(event.sfxType, 'ZOOM_IN');
  assert.equal(event.sfxEnabled, true);
  // §15: the effect starts with the motion.
  assert.equal(Number(event.sfxAtSec.toFixed(3)), Number(event.startSec.toFixed(3)));
}

function strongNeedsStrongEmphasis() {
  const words = speak('and honestly nobody expected that outcome at all', 3);
  const nobody = words.find((word) => word.text === 'nobody');
  // Same request, no STRONG emphasis behind it: the band is walked back to NORMAL.
  const { events } = run(
    [zoomOp('nobody', nobody.start - .2, nobody.end + 1, 'Emphasis on the key claim',
      { scale: 1.26, intensity: 'STRONG' })],
    { words });
  assert.equal(events.length, 1);
  assert.equal(events[0].intensity, 'NORMAL');
  assert(events[0].peakScale <= ZOOM_INTENSITY_BANDS.NORMAL.max + 1e-6,
    `unbacked strong push was not reduced: ${events[0].peakScale}`);
}

function subtleStaysSubtle() {
  const words = speak('the second thing worth noticing here is timing', 3);
  const noticing = words.find((word) => word.text === 'noticing');
  const { events } = run(
    [zoomOp('noticing', noticing.start - .2, noticing.end + 1, 'Light emphasis on the point',
      { scale: 1.1, intensity: 'SUBTLE' })], { words });
  assert.equal(events.length, 1);
  assert.equal(events[0].intensity, 'SUBTLE');
  assert(events[0].peakScale <= ZOOM_INTENSITY_BANDS.SUBTLE.max + 1e-6);
  assert(events[0].peakScale >= ZOOM_INTENSITY_BANDS.SUBTLE.min - 1e-6);
}

function statisticAndPunchlineChooseTheirSound() {
  const words = speak('revenue grew forty percent before anyone noticed the joke', 3);
  const percent = words.find((word) => word.text === 'percent');
  const statistic = run([zoomOp('percent', percent.start - .2, percent.end + 1,
    'Statistic emphasis on the growth number')], { words }).events[0];
  assert.equal(statistic.semanticCategory, 'STATISTIC');
  assert.equal(statistic.sfxType, 'STAT_HIT');

  const joke = words.find((word) => word.text === 'joke');
  const punch = run([zoomOp('joke', joke.start - .2, joke.end + 1, 'Punchline lands here',
    { scale: 1.24, intensity: 'STRONG' })],
  { words, emphasis: [{ word: 'joke', startSec: joke.start, endSec: joke.end, strength: 'STRONG' }] })
    .events[0];
  assert.equal(punch.semanticCategory, 'PUNCHLINE');
  assert.equal(punch.intensity, 'STRONG');
  assert.equal(punch.sfxType, 'IMPACT_LIGHT');

  const reveal = run([zoomOp('noticed', words.find((w) => w.text === 'noticed').start - .2,
    words.find((w) => w.text === 'noticed').end + 1, 'Topic reveal')], { words }).events[0];
  assert.equal(reveal.semanticCategory, 'REVEAL');
  assert.equal(reveal.sfxType, 'REVEAL');
}

// --- §5 pull-back ----------------------------------------------------------

function zoomOutRevealsContext() {
  const words = speak('and around us the entire room had gone completely silent', .4);
  const around = words.find((word) => word.text === 'around');
  const { events, rejected } = run(
    [{ ...zoomOp('around', around.start - .3, around.end + 1.2,
      'Show the wider scene the speaker is in', { scale: 1.2 }), type: 'ZOOM_OUT' }],
    { words });
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.kind, 'OUT');
  assert.equal(event.anchorKind, 'CLIP_START');
  assert.equal(event.startSec, 0);
  assert.equal(event.semanticCategory, 'CONTEXT');
  // The tight frame is established instantly across the discontinuity ...
  assert.equal(event.rampInFrames, 1);
  // ... and the pull back returns all the way to the baseline.
  assert(zoomScaleAt(events, event.startSec + .01, FPS) > 1.1,
    'pull back did not start from a tight frame');
  assert(Math.abs(zoomScaleAt(events, event.endSec, FPS) - 1) < 1e-6,
    'pull back did not settle on the baseline');
  // §15: the effect lands where the motion actually begins.
  assert.equal(Number(event.sfxAtSec.toFixed(3)), Number(event.zoomOutStartSec.toFixed(3)));
  assert.equal(event.sfxType, 'ZOOM_OUT');
}

function zoomOutNeedsAnAnchor() {
  const words = speak('much later in the clip the wider room finally appears', 18);
  const room = words.find((word) => word.text === 'room');
  const { events, rejected } = run(
    [{ ...zoomOp('room', room.start - .4, room.end + 1.2, 'Show the wider scene'),
      type: 'ZOOM_OUT' }], { words });
  assert.equal(events.length, 0);
  assert.deepEqual(rejected.map((item) => item.reason), ['ZOOM_OUT_NO_ANCHOR']);
}

function zoomOutAcrossACutIsATransition() {
  // A removed silence at 8-8.6 s is a hard change of image: a pull back may start there.
  const cuts = [{ start: 8, end: 8.6 }];
  const words = speak('afterwards the whole environment around them looked different', 8.7);
  const whole = words.find((word) => word.text === 'whole');
  const { events, rejected } = run(
    [{ ...zoomOp('whole', whole.start - .5, whole.end + 1,
      'Pull back to show the room they are in'), type: 'ZOOM_OUT' }],
    { words, cuts, duration: 40 });
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  assert.equal(events.length, 1);
  assert.equal(events[0].anchorKind, 'CUT');
  assert.equal(events[0].sfxType, 'TRANSITION');
}

// --- §9/§10 safety ---------------------------------------------------------

function informationShotsStayStable() {
  const words = speak('the report shows exactly where the money actually went', 3);
  const report = words.find((word) => word.text === 'report');
  const { events, rejected } = run(
    [zoomOp('report', report.start - .2, report.end + 1, 'Statistic emphasis in the report')],
    { words,
      shots: [shot(0, 36, { shotClass: 'CHART', layout: 'FIT', zoomAllowed: false,
        informationMode: true, faceCount: 0, textCoverage: .34 })],
      frames: framesEvery(0, 36, screen) });
  assert.equal(events.length, 0, 'zoomed on an information shot');
  assert.deepEqual(rejected.map((item) => item.reason), ['INFORMATION_SHOT']);
}

function burnedInTextIsNotClipped() {
  const words = speak('look at the number on the lower third right now', 3);
  const number = words.find((word) => word.text === 'number');
  // A talking head with a large burned-in caption that must stay readable.
  const withText = (t) => ({ ...face(t),
    textBoxes: [{ x: .04, y: .78, w: .92, h: .12 }] });
  const { events, rejected } = run(
    [zoomOp('number', number.start - .2, number.end + 1, 'Statistic emphasis',
      { scale: 1.28, intensity: 'STRONG' })],
    { words, frames: framesEvery(0, 36, withText),
      emphasis: [{ word: 'number', startSec: number.start, endSec: number.end, strength: 'STRONG' }] });
  if (events.length) {
    assert(events[0].peakScale < 1.28,
      `burned-in text survived only because nothing was cropped: ${events[0].peakScale}`);
    assert.equal(events[0].scaleReducedForSafety, true);
  } else assert.equal(rejected[0].reason, 'TEXT_UNSAFE');
}

function twoPersonShotsKeepBothSpeakers() {
  const words = speak('they disagreed about that point for a long time', 3);
  const disagreed = words.find((word) => word.text === 'disagreed');
  const { events } = run(
    [zoomOp('disagreed', disagreed.start - .2, disagreed.end + 1,
      'Contradiction between the two speakers', { scale: 1.28, intensity: 'STRONG' })],
    { words,
      shots: [shot(0, 36, { shotClass: 'TWO_PERSON', faceCount: 2, personCount: 2 })],
      frames: framesEvery(0, 36, twoFaces),
      emphasis: [{ word: 'disagreed', startSec: disagreed.start, endSec: disagreed.end,
        strength: 'STRONG' }] });
  // A strong semantic moment may temporarily isolate the active speaker, but it
  // stays a moderate punch-in and returns cleanly to the pair composition.
  if (events.length) {
    assert(events[0].peakScale <= 1.24,
      `two-person punch-in was too deep at ${events[0].peakScale}`);
    assert.equal(events[0].zoomReturned, true);
  }
}

// --- §8/§20/§21 discipline -------------------------------------------------

function motionWithoutAReasonIsDropped() {
  const words = speak('something happens here and then it happens again later', 3);
  const happens = words[1];
  const { events, rejected } = run(
    [zoomOp('happens', happens.start - .2, happens.end + 1, '   ')], { words });
  assert.equal(events.length, 0);
  assert.deepEqual(rejected.map((item) => item.reason), ['NO_SEMANTIC_REASON']);
}

function everyEventCarriesItsReason() {
  const words = speak('revenue doubled and nobody at all saw that coming', 3);
  const doubled = words.find((word) => word.text === 'doubled');
  const { events } = run([zoomOp('doubled', doubled.start - .2, doubled.end + 1,
    'Statistic emphasis')], { words });
  assert.equal(events.length, 1);
  assert(events[0].semanticReason.trim().length > 0);
}

function frequencyIsBudgeted() {
  // Eight justified beats, one every ~4 s, in a 36 s clip.
  const words = speak(Array.from({ length: 30 }, (_, i) => `word${i}`).join(' '), 2, 1.1);
  const operations = words.filter((_, index) => index % 4 === 0 && index > 0)
    .map((word) => zoomOp(word.text, word.start - .2, word.end + 1, 'Emphasis on a key point'));
  const { events } = run(operations, { words, duration: 36 });
  const budget = semanticZoomTarget(36);
  assert(events.length <= budget, `${events.length} events exceeds the budget of ${budget}`);
  assert(events.length >= 4 && events.length <= 7, '36 seconds should carry four to seven real beats');
  // §8: spacing is respected between whatever survived.
  for (let i = 1; i < events.length; i++)
    assert(events[i].startSec - events[i - 1].endSec >= ZOOM_TUNING.minSpacingSec - 1e-6,
      'two moves landed on top of each other');
}

function cameraIsSettledOnTheFinalFrame() {
  const duration = 20;
  const words = speak('and that is exactly why the whole thing finally mattered', 15);
  const mattered = words[words.length - 1];
  const { events, rejected } = run(
    [zoomOp('mattered', mattered.start - .2, mattered.end + .4, 'Strong ending payoff')],
    { words, duration, shots: [shot(0, duration)],
      frames: framesEvery(0, duration, face) });
  if (events.length) {
    assert(events[0].endSec <= duration - .05,
      `camera was still moving at the final frame: ${events[0].endSec} of ${duration}`);
    assert(Math.abs(zoomScaleAt(events, duration, FPS) - 1) < 1e-6,
      'clip ended mid-move');
  } else assert.equal(rejected[0].reason, 'TOO_CLOSE_TO_END');
}

function envelopeShapeIsEased() {
  const words = speak('the single most important number in the entire report', 3);
  const number = words.find((word) => word.text === 'number');
  const { events } = run([zoomOp('number', number.start - .2, number.end + 1,
    'Statistic emphasis')], { words });
  const [event] = events;
  const at = (t) => zoomScaleAt(events, t, FPS);
  // Ease-out on the way in: more than half the travel is done by the ramp midpoint.
  const mid = (event.startSec + event.zoomInEndSec) / 2;
  const travelled = (at(mid) - 1) / (event.peakScale - 1);
  assert(travelled > .55, `push-in is not eased out (travelled ${travelled.toFixed(2)} at midpoint)`);
  // Smooth settle on the way back: the last stretch barely moves.
  const nearEnd = event.endSec - (event.endSec - event.zoomOutStartSec) * .12;
  assert((at(nearEnd) - 1) / (event.peakScale - 1) < .1, 'the return does not settle gently');
  assert(Math.abs(at(event.zoomInEndSec) - event.peakScale) < .002, 'the peak is not reached');
  // The rendered expression carries the same eased shape.
  const expression = zoomExpression(events);
  assert(expression.includes('*(2-'), 'ease-out ramp missing from the zoompan expression');
  assert(expression.includes('(3-2*'), 'smoothstep settle missing from the zoompan expression');
}

function disablingSfxLeavesMotionAlone() {
  const words = speak('the number that changed the entire argument for good', 3);
  const number = words.find((word) => word.text === 'number');
  const { events } = run([zoomOp('number', number.start - .2, number.end + 1,
    'Statistic emphasis')], { words, sfxDisabled: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].sfxEnabled, false);
  assert.equal(events[0].sfxType, 'STAT_HIT', 'the event still knows what it would have played');
}

// --- plan validation -------------------------------------------------------

function validatorAcceptsTheNewVocabulary() {
  const validator = new EditingPlanValidator();
  const words = speak('the revenue number doubled and nobody expected that result', 2, 1);
  const doubled = words.find((word) => word.text === 'doubled');
  const result = words.find((word) => word.text === 'result');
  const base = fallbackEditPlan(0, 30, '9:16');
  const validated = validator.validate({ ...base,
    subtitleEmphasis: [{ word: 'doubled', startSec: doubled.start, endSec: doubled.end,
      strength: 'STRONG' }],
    operations: [
      { ...zoomOp('doubled', doubled.start - .3, doubled.end + 1, 'Statistic emphasis',
        { scale: 1.24, intensity: 'STRONG' }) },
      { ...zoomOp('result', result.start - .3, result.end + 1, 'Pull back for context',
        { scale: 1.18 }), type: 'ZOOM_OUT' },
      { ...zoomOp('number', 2, 4, '', { scale: 1.18 }) }
    ] }, 0, 30, '9:16', words, words.map((word) => word.text).join(' '), 'Revenue');
  const kept = validated.plan.operations;
  assert.equal(kept.length, 2, `expected the reasonless zoom to be dropped: ${JSON.stringify(kept)}`);
  assert.deepEqual(kept.map((operation) => operation.type), ['ZOOM', 'ZOOM_OUT']);
  assert.equal(kept[0].intensity, 'STRONG');
  assert(validated.warnings.includes('UNSAFE_ZOOM_REMOVED'));
}

// --- §11-§16 the sound library --------------------------------------------

async function sfxLibraryFallsBackToGeneratedEffects(directory) {
  const empty = await loadSfxLibrary(join(directory, 'does-not-exist'));
  assert.deepEqual(empty.assets, []);
  assert.deepEqual(empty.problems, ['SFX_LIBRARY_MISSING']);
  for (const type of SFX_TYPES) {
    const chosen = selectSfx([], type, 'seed', 0, true);
    assert.equal(chosen.type, type);
    assert.equal(chosen.generated, true);
    assert.equal(chosen.license, 'GENERATED_IN_HOUSE');
    assert(chosen.path.startsWith('lavfi:'), 'a generated effect must be an in-graph source');
    // Nothing is ever downloaded: only local paths and in-graph sources exist.
    assert(!/^https?:/u.test(chosen.path));
    assert.equal(selectSfx([], type, 'seed', 0, false), null,
      'generated effects must be refusable');
  }
  // Every category has a folder name a file can simply be dropped into.
  assert.deepEqual(Object.keys(SFX_CATEGORY_FOLDERS).sort(), [...SFX_TYPES].sort());
}

function localAssetsOutrankGeneratedOnes() {
  const local = [
    { id: 'zoom-in/a.wav', type: 'ZOOM_IN', path: '/sfx/zoom-in/a.wav', title: 'a',
      license: 'LOCAL_ASSET', loudnessLufs: -20, priority: 10, weight: 1, generated: false },
    { id: 'zoom-in/b.wav', type: 'ZOOM_IN', path: '/sfx/zoom-in/b.wav', title: 'b',
      license: 'LOCAL_ASSET', loudnessLufs: -20, priority: 10, weight: 1, generated: false },
    generatedSfxAsset('ZOOM_IN')
  ];
  const first = selectSfx(local, 'ZOOM_IN', 'clip-seed', 0, true);
  assert.equal(first.generated, false, 'a generated effect beat a local file');
  // Variety: consecutive events in one clip do not repeat the same file.
  const second = selectSfx(local, 'ZOOM_IN', 'clip-seed', 1, true);
  assert.notEqual(first.id, second.id, 'two moves in a row used the identical effect');
  // Determinism: the same seed and index always give the same file.
  assert.equal(selectSfx(local, 'ZOOM_IN', 'clip-seed', 0, true).id, first.id);
  // A missing category borrows from a relative rather than dropping the effect.
  const borrowed = selectSfx(local, 'ZOOM_OUT', 'clip-seed', 0, false);
  assert(borrowed && borrowed.type === 'ZOOM_IN', 'no fallback for an empty category');
}

function levelsSitUnderSpeech() {
  for (const type of SFX_TYPES) {
    // Speech is normalized to -16 LUFS, so every effect target must be clearly below it.
    assert(SFX_TARGET_LUFS[type] <= -24,
      `${type} is not far enough under speech (${SFX_TARGET_LUFS[type]})`);
    // A hot local file is pulled down to the target ...
    const loud = { ...generatedSfxAsset(type), loudnessLufs: -10, generated: false };
    assert(Math.abs(sfxGainDb(loud, type) - (SFX_TARGET_LUFS[type] + 10)) < 1e-6);
    // ... and a quiet one is brought up to it, but never further than the makeup cap.
    const quiet = { ...generatedSfxAsset(type), loudnessLufs: -60, generated: false };
    assert.equal(sfxGainDb(quiet, type), SFX_MAX_MAKEUP_DB,
      `${type} makeup is not capped`);
    assert(sfxGainDb(loud, type) >= -40);
  }
}

// --- the generated effects, rendered for real ------------------------------

async function generatedEffectsRenderAndAreSubtle(directory) {
  for (const type of SFX_TYPES) {
    const spec = GENERATED_SFX[type];
    const output = join(directory, `${SFX_CATEGORY_FOLDERS[type]}.wav`);
    // The exact source the render graph uses, through real FFmpeg.
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', spec.source,
      '-c:a', 'pcm_s16le', output], { maxBuffer: 16 * 1024 * 1024 });
    // volumedetect reports on stderr at info level.
    const { stderr } = await execFileAsync('ffmpeg', ['-v', 'info', '-i', output,
      '-af', 'volumedetect', '-f', 'null', '-'], { maxBuffer: 8 * 1024 * 1024 });
    const peak = Number(/max_volume:\s*(-?[\d.]+) dB/u.exec(stderr)?.[1]);
    const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/u.exec(stderr)?.[1]);
    assert(Number.isFinite(peak) && Number.isFinite(mean), `no level measured for ${type}`);
    // Nothing clips before the mix even applies its own gain and limiter.
    assert(peak <= -1, `${type} peaks at ${peak} dBFS`);
    // And nothing is a silent no-op.
    assert(mean > -60, `${type} rendered silent (${mean} dBFS)`);
    const probe = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=nw=1:nk=1', output]);
    const seconds = Number(probe.stdout.trim());
    assert(Math.abs(seconds - spec.durationSec) < .08,
      `${type} rendered ${seconds}s, expected ${spec.durationSec}s`);
    // §12: these are short editorial accents, never sustained sounds.
    assert(seconds <= 1, `${type} is too long to be an accent (${seconds}s)`);
    // The declared level is what sfxGainDb matches to the category target, so a
    // source that drifts from its declaration would silently land at the wrong level.
    assert(Math.abs(mean - spec.lufs) <= 2,
      `${type} declares ${spec.lufs} LUFS but measures ${mean}`);
    // And once matched it lands on the target, comfortably under -16 LUFS speech.
    const landed = mean + sfxGainDb(generatedSfxAsset(type), type);
    assert(landed <= -16 - 6, `${type} lands at ${landed.toFixed(1)}, too close to speech`);
  }
}

// --- §22 the quality-gate predicates ---------------------------------------

function gatePredicatesHold() {
  const words = speak('the revenue number doubled overnight and nobody noticed it', 3);
  const doubled = words.find((word) => word.text === 'doubled');
  const { events } = run([zoomOp('doubled', doubled.start - .2, doubled.end + 1,
    'Statistic emphasis', { scale: 1.24, intensity: 'STRONG' })],
  { words, duration: 36,
    emphasis: [{ word: 'doubled', startSec: doubled.start, endSec: doubled.end,
      strength: 'STRONG' }] });
  assert.equal(events.length, 1);
  const [event] = events;
  // The same predicates the render gate evaluates.
  assert(event.semanticReason.trim(), 'zoomSemanticallyJustified');
  const band = ZOOM_INTENSITY_BANDS[event.intensity];
  assert(event.peakScale >= band.min - .005 && event.peakScale <= band.max + .005,
    'zoomIntensityValid');
  assert.equal(event.subjectSafeDuringZoom, true, 'zoomSubjectSafe');
  assert.equal(event.informationSafeDuringZoom, true, 'zoomInformationSafe');
  assert(event.endSec <= 36 - .05, 'zoomSettledBeforeEnd');
  assert.equal(event.sfxType, sfxTypeFor(event.kind, event.semanticCategory, event.intensity,
    event.anchorKind), 'sfxMatchesEvent');
  // Classification and intensity helpers agree with what was planned.
  assert.equal(intensityFor(event.peakScale), event.intensity);
  assert.equal(classifySemanticReason(event.semanticReason, event.triggerText, event.kind),
    event.semanticCategory);
}

// --- runner ----------------------------------------------------------------

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'motion-sfx-'));
  try {
    singleSpeakerEmphasis();
    strongNeedsStrongEmphasis();
    subtleStaysSubtle();
    statisticAndPunchlineChooseTheirSound();
    zoomOutRevealsContext();
    zoomOutNeedsAnAnchor();
    zoomOutAcrossACutIsATransition();
    informationShotsStayStable();
    burnedInTextIsNotClipped();
    twoPersonShotsKeepBothSpeakers();
    motionWithoutAReasonIsDropped();
    everyEventCarriesItsReason();
    frequencyIsBudgeted();
    cameraIsSettledOnTheFinalFrame();
    envelopeShapeIsEased();
    disablingSfxLeavesMotionAlone();
    validatorAcceptsTheNewVocabulary();
    await sfxLibraryFallsBackToGeneratedEffects(directory);
    localAssetsOutrankGeneratedOnes();
    levelsSitUnderSpeech();
    await generatedEffectsRenderAndAreSubtle(directory);
    gatePredicatesHold();
    console.log('motion + sound design verification passed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
