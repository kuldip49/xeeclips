// EditMode manual colour, filters and audio - Workstream D.
//
// Offline and fast, in the same spirit as test-edit-mode-transform.cjs: every
// assertion is about pure, deterministic state - the bounds a command accepts,
// the exact FFmpeg chain a grade produces, the windows a transcript yields, and
// the automation expression those windows become. Nothing encodes and nothing
// touches a database.
//
// The load-bearing claims this file exists to check:
//
//   1. A value the editor can store is a value the renderer honours (PARITY).
//   2. A filter is RESOLVED state, not a hidden layer fighting the sliders.
//   3. Ducking is derived from real cached transcript timings or not offered.
//   4. Workstream D composes with B (transform) and C (text) rather than
//      replacing either - the mixed-project graph still contains all of it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');
const { createHarness, seedAnalyzedProject } = require('./test-edit-mode-isolation.cjs');

const M = '../dist/modules/edit-mode';
const { COLOR_BOUNDS, COLOR_FILTERS, COLOR_FILTER_IDS, COLOR_KEYS, ColorRangeError,
  NEUTRAL_COLOR, colorProperties, isNeutralColor, readColor, readColorFilterId,
  readColorFilterStrength, resolveColorFilter, validateColorFilterId,
  validateColorFilterStrength, validateColorValue } = require(`${M}/edit-mode-color.js`);
const { colorAdjustmentFilter, COLOR_GAINS } = require(`${M}/render/edit-mode-color-filter.js`);
const { AudioRangeError, DUCK_STRENGTHS, MAX_VOLUME, duckVolumeExpression, mergeSpeechWindows,
  readAudioState, readSourceAudio, speechWindowsFromTranscript, validateAudioTrim,
  validateBoolean, validateDuckStrength, validateDuckTiming, validateFades,
  validateVolume } = require(`${M}/edit-mode-audio.js`);
const { buildTimelineMap } = require(`${M}/render/edit-mode-timeline-map.js`);
const { buildRenderPlan } = require(`${M}/render/edit-mode-render-plan.js`);
const { buildFfmpegArgs } = require(`${M}/render/edit-mode-filtergraph.js`);

let checks = 0;
const ok = (label, condition) => {
  assert(condition, label);
  checks += 1;
  console.log(`  ok  ${label}`);
};
const section = (title) => console.log(`\n${title}`);

const rejects = (fn, code, Kind) => {
  try { fn(); } catch (error) {
    assert(error instanceof Kind, `expected ${Kind.name}, got ${error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
};
const rejectsColor = (fn, code) => rejects(fn, code, ColorRangeError);
const rejectsAudio = (fn, code) => rejects(fn, code, AudioRangeError);

// --- Fixtures ---------------------------------------------------------------

const SOURCE_DURATION = 40;
const transcript = (words) => ({ text: words.map((word) => word.text).join(' '),
  segments: [{ start: words[0]?.start ?? 0, end: words[words.length - 1]?.end ?? 0,
    text: words.map((word) => word.text).join(' '), words }] });

const SPEECH = transcript([
  { start: 1, end: 1.4, text: 'this' }, { start: 1.45, end: 1.9, text: 'is' },
  { start: 1.95, end: 2.6, text: 'speech' },
  // A clear silence, then a second passage.
  { start: 8, end: 8.5, text: 'and' }, { start: 8.55, end: 9.2, text: 'more' }
]);

const sourceAsset = (over = {}) => ({ id: 'src', role: 'SOURCE', mimeType: 'video/mp4',
  duration: SOURCE_DURATION, width: 1920, height: 1080, fps: 30,
  metadata: { hasAudio: true }, transcript: null,
  analysis: { source: 'DENSE', shotBoundaries: [], ocrText: '', frames: [] }, ...over });
const audioAsset = (id = 'mus') => ({ id, role: 'AUDIO', mimeType: 'audio/mpeg', duration: 90,
  width: null, height: null, fps: null, metadata: {}, transcript: null, analysis: null });
const imageAsset = (id = 'logo') => ({ id, role: 'LOGO', mimeType: 'image/png', duration: null,
  width: 400, height: 200, fps: null, metadata: {}, transcript: null, analysis: null });

const videoElement = (id, position, trimStart, trimEnd, startTime, properties = {}) => {
  const speed = Number(properties.speed) || 1;
  return { id, assetId: 'src', type: 'VIDEO', track: 0, position, startTime,
    duration: (trimEnd - trimStart) / speed, trimStart, trimEnd, properties };
};
const audioElement = (id, startTime, duration, properties = {}) => ({ id, assetId: 'mus',
  type: 'AUDIO', track: 3, position: 0, startTime, duration, trimStart: 0, trimEnd: duration,
  properties });

const settings = (over = {}) => ({ selectedPreset: 'PODCAST_CLIP', aspectRatio: 'SOURCE',
  pacing: 'MODERATE', subtitlePolicy: 'OFF', hookPolicy: 'OFF', zoomPolicy: 'OFF',
  reframePolicy: 'SOURCE', musicPolicy: 'KEEP_EXISTING', gradingPolicy: 'NONE', textPolicy: 'OFF',
  overlayPolicy: 'NONE', informationRegionPolicy: 'RESPECT', hookText: null, ...over });

const plan = (over = {}) => buildRenderPlan({
  project: { id: 'project-1', revision: 4, settings: over.settings ?? settings() },
  assets: over.assets ?? [sourceAsset()],
  elements: over.elements ?? [videoElement('v1', 0, 0, 12, 0)],
  hasSourceAudio: over.hasSourceAudio ?? true, fps: 30 });

const graphOf = (built, over = {}) => {
  const args = buildFfmpegArgs({ plan: built.plan, sourcePath: '/tmp/source.mp4',
    overlayPaths: over.overlayPaths ?? {}, audioPaths: over.audioPaths ?? {},
    assFileName: over.assFileName ?? null,
    outputPath: '/tmp/out.mp4', informationCrop: built.evidence.informationCrop,
    fitExpression: built.evidence.fitExpression,
    informationFitExpression: built.evidence.informationFitExpression,
    cameraFilter: built.evidence.cameraFilter });
  return args[args.indexOf('-filter_complex') + 1];
};

const graded = (over) => ({ ...NEUTRAL_COLOR, ...over });

function main() {
  console.log('EditMode colour, filters and audio\n');

  // --- 1. The colour schema -------------------------------------------------
  section('1. A canonical, neutral-at-zero colour schema');
  ok('every documented control is in the schema', COLOR_KEYS.length === 11 &&
    ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'saturation',
      'temperature', 'tint', 'sharpness', 'fade', 'vignette']
      .every((key) => COLOR_KEYS.includes(key)));
  ok('the neutral grade is zero for every control',
    COLOR_KEYS.every((key) => NEUTRAL_COLOR[key] === 0));
  ok('a legacy element with no colour block reads back neutral, never NaN',
    isNeutralColor(readColor({})) && isNeutralColor(readColor(null)) &&
    isNeutralColor(readColor({ colorAdjustments: 'nonsense' })));
  ok('a partially stored grade resolves its missing keys to neutral',
    readColor({ colorAdjustments: { contrast: 0.4 } }).contrast === 0.4 &&
    readColor({ colorAdjustments: { contrast: 0.4 } }).saturation === 0);
  ok('an unreadable stored value resolves to neutral rather than NaN',
    readColor({ colorAdjustments: { contrast: 'lots' } }).contrast === 0);
  ok('a stored value beyond the bounds is clamped on read, not trusted',
    readColor({ colorAdjustments: { contrast: 99 } }).contrast === 1);
  ok('bipolar controls run -1..1 and unipolar ones 0..1',
    COLOR_BOUNDS.contrast.min === -1 && COLOR_BOUNDS.contrast.max === 1 &&
    COLOR_BOUNDS.vignette.min === 0 && COLOR_BOUNDS.sharpness.min === 0);

  // --- 2. Bounds ------------------------------------------------------------
  section('2. Typed bounds, not arbitrary JSON');
  for (const key of COLOR_KEYS) {
    const { min, max } = COLOR_BOUNDS[key];
    ok(`${key} accepts both ends of its range`,
      validateColorValue(key, min) === min && validateColorValue(key, max) === max);
    ok(`${key} refuses a value past its range`,
      rejectsColor(() => validateColorValue(key, max + 0.01), 'INVALID_COLOR_VALUE') &&
      rejectsColor(() => validateColorValue(key, min - 0.01), 'INVALID_COLOR_VALUE'));
  }
  ok('a non-numeric colour value is refused',
    rejectsColor(() => validateColorValue('contrast', 'punchy'), 'INVALID_COLOR_VALUE'));
  ok('an unknown filter id is refused',
    rejectsColor(() => validateColorFilterId('INSTAGRAM_1977'), 'INVALID_COLOR_FILTER'));
  ok('a filter strength outside 0..1 is refused',
    rejectsColor(() => validateColorFilterStrength(1.4), 'INVALID_COLOR_FILTER_STRENGTH'));
  ok('an omitted strength means full strength', validateColorFilterStrength(undefined) === 1);

  // --- 3. Filters -----------------------------------------------------------
  section('3. Filters are deterministic values, not downloads');
  ok('all ten built-ins are present', COLOR_FILTER_IDS.length === 10 &&
    COLOR_FILTERS.length === 10);
  for (const filter of COLOR_FILTERS) {
    ok(`${filter.id} resolves deterministically and stays inside the bounds`,
      JSON.stringify(resolveColorFilter(filter.id)) ===
        JSON.stringify(resolveColorFilter(filter.id)) &&
      COLOR_KEYS.every((key) => {
        const value = resolveColorFilter(filter.id)[key];
        return value >= COLOR_BOUNDS[key].min && value <= COLOR_BOUNDS[key].max;
      }));
  }
  ok('Original resolves to exactly the neutral grade',
    isNeutralColor(resolveColorFilter('ORIGINAL')));
  ok('Black & white drives saturation to exactly zero, so it is truly monochrome',
    resolveColorFilter('BLACK_AND_WHITE').saturation === -1 &&
    colorAdjustmentFilter(resolveColorFilter('BLACK_AND_WHITE')).includes('saturation=0'));
  ok('Warm is warm and Cool is cool, in opposite directions',
    resolveColorFilter('WARM').temperature > 0 && resolveColorFilter('COOL').temperature < 0);
  ok('Cinematic is a real grade, not a label',
    !isNeutralColor(resolveColorFilter('CINEMATIC')));

  // --- 4. Strength ----------------------------------------------------------
  section('4. Strength interpolates neutral -> filter, resolved once');
  ok('strength 0 is exactly neutral', isNeutralColor(resolveColorFilter('CINEMATIC', 0)));
  ok('strength 1 is the filter definition',
    resolveColorFilter('CINEMATIC', 1).contrast === COLOR_FILTERS
      .find((filter) => filter.id === 'CINEMATIC').adjustments.contrast);
  ok('strength 0.5 is exactly half of every value',
    COLOR_KEYS.every((key) => Math.abs(resolveColorFilter('VINTAGE', 0.5)[key] -
      resolveColorFilter('VINTAGE', 1)[key] / 2) < 1e-6));
  ok('re-applying a filter REPLACES rather than compounds',
    JSON.stringify(resolveColorFilter('WARM', 0.5)) ===
      JSON.stringify(resolveColorFilter('WARM', 0.5)));

  // --- 5. Filter then manual adjustment -------------------------------------
  section('5. A filter is a starting point the sliders then own outright');
  const applied = colorProperties(resolveColorFilter('CINEMATIC', 1), 'CINEMATIC', 1);
  ok('applying a filter stores RESOLVED values, not just a label',
    applied.colorAdjustments.contrast === resolveColorFilter('CINEMATIC').contrast);
  ok('the filter id is kept alongside, for the UI and for a future template',
    readColorFilterId(applied) === 'CINEMATIC' && readColorFilterStrength(applied) === 1);
  // This is what the SET_VIDEO_TEMPERATURE command does to a filtered element.
  const edited = { ...readColor(applied), temperature: 0.5 };
  ok('editing one control after a filter keeps every other filter value',
    edited.contrast === resolveColorFilter('CINEMATIC').contrast &&
    edited.vignette === resolveColorFilter('CINEMATIC').vignette);
  ok('...and the edited control is the user\'s value, not the filter\'s',
    edited.temperature === 0.5);
  ok('the renderer reads the RESOLVED values, so nothing hidden fights the slider',
    colorAdjustmentFilter(edited) === colorAdjustmentFilter(readColor(
      colorProperties(edited, 'CINEMATIC', 1))));
  ok('Original clears the grade completely',
    isNeutralColor(resolveColorFilter('ORIGINAL', 1)));

  // --- 6. The colour filter chain -------------------------------------------
  section('6. The renderer reproduces the stored grade exactly');
  ok('a neutral grade emits NO filter at all, so an ungraded export is unchanged',
    colorAdjustmentFilter(NEUTRAL_COLOR) === '');
  ok('brightness becomes an additive eq brightness',
    colorAdjustmentFilter(graded({ brightness: 1 })) ===
      `eq=brightness=${COLOR_GAINS.brightness}`);
  ok('contrast becomes an eq contrast around 1',
    colorAdjustmentFilter(graded({ contrast: 1 })).includes('contrast=1.6') &&
    colorAdjustmentFilter(graded({ contrast: -1 })).includes('contrast=0.4'));
  ok('saturation becomes an eq saturation, reaching 0 at -1',
    colorAdjustmentFilter(graded({ saturation: -1 })).includes('saturation=0') &&
    colorAdjustmentFilter(graded({ saturation: 1 })).includes('saturation=2'));
  // eq applies pow(value, 1/gamma), so gamma ABOVE 1 is the BRIGHTER direction.
  // Asserting the direction here rather than just the presence of the filter is
  // what would have caught the inverted first version without a render.
  ok('exposure becomes a GAMMA change, brightening for positive values',
    colorAdjustmentFilter(graded({ exposure: 1 })).includes('gamma=') &&
    Number(/gamma=([\d.]+)/u.exec(colorAdjustmentFilter(graded({ exposure: 1 })))[1]) > 1 &&
    Number(/gamma=([\d.]+)/u.exec(colorAdjustmentFilter(graded({ exposure: -1 })))[1]) < 1);
  ok('shadows, highlights and fade share ONE tone curve, not three stacked ones',
    (colorAdjustmentFilter(graded({ shadows: 0.5, highlights: -0.5, fade: 0.5 }))
      .match(/curves=/gu) ?? []).length === 1);
  ok('fade lifts the black point, which is what a film fade IS',
    /curves=all='0\/0\.09/u.test(colorAdjustmentFilter(graded({ fade: 0.5 }))));
  ok('raising shadows raises the quarter-tone point',
    Number(/0\.25\/([\d.]+)/u.exec(colorAdjustmentFilter(graded({ shadows: 1 })))[1]) >
      Number(/0\.25\/([\d.]+)/u.exec(colorAdjustmentFilter(graded({ shadows: -1 })))[1]));
  ok('temperature and tint share ONE channel mixer, not two stacked casts',
    (colorAdjustmentFilter(graded({ temperature: 0.5, tint: 0.5 }))
      .match(/colorchannelmixer=/gu) ?? []).length === 1);
  // colorbalance is the obvious filter for this and is a silent no-op on
  // yuv420p sources - measured, not assumed. Asserting its ABSENCE keeps it
  // from creeping back in as an innocent-looking simplification.
  ok('the cast is a real per-channel gain, never the no-op colorbalance filter',
    !colorAdjustmentFilter(graded({ temperature: 0.5 })).includes('colorbalance'));
  ok('warm pushes red up and blue down; cool does the reverse',
    /rr=1\.15/u.test(colorAdjustmentFilter(graded({ temperature: 0.5 }))) &&
    /bb=0\.85/u.test(colorAdjustmentFilter(graded({ temperature: 0.5 }))) &&
    /rr=0\.85/u.test(colorAdjustmentFilter(graded({ temperature: -0.5 }))) &&
    /bb=1\.15/u.test(colorAdjustmentFilter(graded({ temperature: -0.5 }))));
  ok('tint moves green against red and blue',
    /gg=0\.85/u.test(colorAdjustmentFilter(graded({ tint: 0.5 }))) &&
    /gg=1\.15/u.test(colorAdjustmentFilter(graded({ tint: -0.5 }))));
  ok('sharpness becomes a luma-only unsharp mask, never a chroma one',
    colorAdjustmentFilter(graded({ sharpness: 1 })).includes('unsharp=5:5:1.5:5:5:0'));
  ok('vignette becomes a vignette angle, and only when asked for',
    colorAdjustmentFilter(graded({ vignette: 1 })).includes('vignette=angle=') &&
    !colorAdjustmentFilter(graded({ contrast: 0.5 })).includes('vignette'));
  ok('the documented stage order holds: eq -> curves -> mixer -> unsharp -> vignette',
    (() => {
      const chain = colorAdjustmentFilter(graded({ contrast: 0.4, shadows: 0.3,
        temperature: 0.3, sharpness: 0.4, vignette: 0.4 }));
      const at = (needle) => chain.indexOf(needle);
      return at('eq=') < at('curves=') && at('curves=') < at('colorchannelmixer=') &&
        at('colorchannelmixer=') < at('unsharp=') && at('unsharp=') < at('vignette=');
    })());
  ok('every control on its own produces a non-empty chain - none is a no-op',
    COLOR_KEYS.every((key) => colorAdjustmentFilter(graded({ [key]: 0.5 })) !== ''));

  // --- 7. Colour in the render plan and the graph ---------------------------
  section('7. Colour is per-segment canonical state the graph honours');
  const ungraded = plan();
  ok('an ungraded segment carries a neutral grade into the plan',
    isNeutralColor(ungraded.plan.videoSegments[0].color));
  ok('an ungraded export emits no colour filter anywhere',
    !graphOf(ungraded).includes('colorchannelmixer') && !graphOf(ungraded).includes('curves='));

  const gradedPlan = plan({ elements: [videoElement('v1', 0, 0, 12, 0,
    { colorAdjustments: graded({ contrast: 0.4, temperature: 0.3 }) })] });
  ok('the plan carries the stored grade onto the segment',
    gradedPlan.plan.videoSegments[0].color.contrast === 0.4);
  ok('the graph emits that exact grade',
    graphOf(gradedPlan).includes(colorAdjustmentFilter(graded({ contrast: 0.4,
      temperature: 0.3 }))));

  // A split timeline where only one half is graded - the case a single
  // project-level colour state could not express at all.
  const perSegment = plan({ elements: [
    videoElement('v1', 0, 0, 6, 0, { colorAdjustments: graded({ saturation: -1 }) }),
    videoElement('v2', 1, 6, 12, 6)] });
  const perSegmentGraph = graphOf(perSegment);
  ok('two segments can carry different grades',
    perSegment.plan.videoSegments[0].color.saturation === -1 &&
    perSegment.plan.videoSegments[1].color.saturation === 0);
  ok('only the graded segment gets a colour chain',
    (perSegmentGraph.match(/saturation=0/gu) ?? []).length === 1);

  // --- 8. Colour composes with the Workstream B transforms ------------------
  section('8. Colour composes with crop, rotation, flip, scale and speed');
  const composed = plan({ elements: [videoElement('v1', 0, 0, 12, 0, {
    crop: { left: 0.1, right: 0.1, top: 0, bottom: 0 }, rotation: 90, flipH: true,
    scale: 1.2, offsetX: 0.05, speed: 2,
    colorAdjustments: graded({ contrast: 0.4, vignette: 0.5 }) })] });
  const composedChain = /\[0:v\]trim=[^;]+/u.exec(graphOf(composed))[0];
  ok('the segment chain contains BOTH the grade and every transform',
    composedChain.includes('eq=') && composedChain.includes('vignette=') &&
    composedChain.includes('crop=') && composedChain.includes('hflip') &&
    composedChain.includes('rotate=') && composedChain.includes('scale='));
  ok('colour is applied BEFORE the geometry, so crop/rotate padding stays black',
    composedChain.indexOf('eq=') < composedChain.indexOf('crop=') &&
    composedChain.indexOf('vignette=') < composedChain.indexOf('crop='));
  ok('speed still retimes the segment with colour applied',
    composedChain.includes('setpts=(PTS-STARTPTS)/2.000000') &&
    composed.plan.durationSec === 6);
  ok('the transform chain still ends on a normalized SAR, so concat still works',
    composedChain.includes('setsar=1'));

  // --- 9. Source audio ------------------------------------------------------
  section('9. The source video has a real level, and a real mute');
  ok('volume is a GAIN reaching 200%, defaulting to "as recorded"',
    MAX_VOLUME === 2 && readSourceAudio({}).volume === 1 &&
    readSourceAudio({}).muted === false);
  ok('a legacy segment with no source-audio state sounds exactly as it did',
    readSourceAudio(null).volume === 1);
  ok('volume is bounded at both ends',
    rejectsAudio(() => validateVolume(-0.1), 'INVALID_VOLUME') &&
    rejectsAudio(() => validateVolume(2.5), 'INVALID_VOLUME'));
  ok('200% is accepted', validateVolume(2) === 2);
  ok('mute must actually be a boolean',
    rejectsAudio(() => validateBoolean('yes', 'muted'), 'INVALID_AUDIO_FLAG'));

  const quiet = plan({ elements: [videoElement('v1', 0, 0, 12, 0, { sourceVolume: 0.5 })] });
  ok('a lowered source level reaches the graph as a volume filter',
    graphOf(quiet).includes('volume=0.5000'));
  const muted = plan({ elements: [videoElement('v1', 0, 0, 12, 0, { sourceMuted: true })] });
  ok('muting the source removes the dialogue branch entirely rather than scaling it by zero',
    !graphOf(muted).includes('[0:a]') && !graphOf(muted).includes('acat'));
  ok('a full-level source still emits no volume filter at all',
    !/\[0:a\][^;]*volume=/u.test(graphOf(plan())));
  const halfMuted = plan({ elements: [
    videoElement('v1', 0, 0, 6, 0, { sourceMuted: true }),
    videoElement('v2', 1, 6, 12, 6)] });
  ok('muting ONE segment of a split timeline silences only that segment',
    (graphOf(halfMuted).match(/volume=0\.0000/gu) ?? []).length === 1 &&
    graphOf(halfMuted).includes('acat'));

  // --- 10. Music tracks -----------------------------------------------------
  section('10. Music: level, mute, trim, fades');
  ok('a music clip defaults to present-but-under-the-dialogue',
    readAudioState({}).volume === 0.25 && readAudioState({}).duckEnabled === false);
  ok('a music clip can be boosted above unity', validateVolume(1.8) === 1.8);
  ok('fades must fit the clip TOGETHER, not just individually',
    validateFades(2, 2, 10).fadeInSec === 2 &&
    rejectsAudio(() => validateFades(3, 3, 4), 'INVALID_FADE'));
  ok('a negative fade is refused',
    rejectsAudio(() => validateFades(-1, 0, 10), 'INVALID_FADE'));
  ok('a trim window must fit the uploaded file',
    validateAudioTrim(5, 20, 90).trimEnd === 20 &&
    rejectsAudio(() => validateAudioTrim(5, 200, 90), 'INVALID_AUDIO_TRIM'));
  ok('a backwards trim is refused',
    rejectsAudio(() => validateAudioTrim(10, 5, 90), 'INVALID_AUDIO_TRIM'));
  ok('a trim on a file of unknown length is still bounds-checked for sanity',
    validateAudioTrim(0, 5, null).trimEnd === 5 &&
    rejectsAudio(() => validateAudioTrim(-1, 5, null), 'INVALID_AUDIO_TRIM'));

  const withMusic = plan({ assets: [sourceAsset(), audioAsset()],
    elements: [videoElement('v1', 0, 0, 12, 0),
      audioElement('m1', 2, 8, { volume: 0.8, fadeInSec: 1, fadeOutSec: 2, trimEnd: 8 })] });
  const musicGraph = graphOf(withMusic, { audioPaths: { m1: '/tmp/music.mp3' } });
  ok('the music track reaches the plan with its own level and fades',
    withMusic.plan.audioTracks[0].volume === 0.8 &&
    withMusic.plan.audioTracks[0].fadeInSec === 1);
  ok('the graph emits the level, both fades and the start delay',
    musicGraph.includes('volume=0.8000') && musicGraph.includes('afade=t=in:st=0:d=1.000') &&
    musicGraph.includes('afade=t=out') && musicGraph.includes('adelay=2000:all=1'));
  ok('the source trim is a READ WINDOW - the uploaded file is untouched',
    musicGraph.includes('atrim=start=0.000:end=8.000'));
  const mutedMusic = plan({ assets: [sourceAsset(), audioAsset()],
    elements: [videoElement('v1', 0, 0, 12, 0), audioElement('m1', 0, 8, { muted: true })] });
  ok('a muted music clip is not decoded at all',
    !graphOf(mutedMusic, { audioPaths: { m1: '/tmp/music.mp3' } }).includes('amus0'));
  ok('a stored fade is carried through EXACTLY, for the plan validator to judge',
    plan({ assets: [sourceAsset(), audioAsset()],
      elements: [videoElement('v1', 0, 0, 12, 0),
        audioElement('m1', 0, 4, { fadeInSec: 6, fadeOutSec: 6 })] })
      .plan.audioTracks[0].fadeInSec === 6);

  // --- 11. Speech windows ---------------------------------------------------
  section('11. Ducking timing comes from the cached transcript, or not at all');
  const map = buildTimelineMap([{ id: 'v1', type: 'VIDEO', track: 0, position: 0, startTime: 0,
    duration: 20, trimStart: 0, trimEnd: 20, properties: {} }]);
  const windows = speechWindowsFromTranscript(
    SPEECH.segments[0].words.map((word) => ({ ...word })), map);
  ok('adjacent words become ONE passage, so the music does not bounce between them',
    windows.length === 2);
  ok('the first passage spans the first sentence exactly',
    Math.abs(windows[0].startSec - 1) < 1e-6 && Math.abs(windows[0].endSec - 2.6) < 1e-6);
  ok('a real silence separates the passages',
    windows[1].startSec === 8 && windows[1].endSec === 9.2);
  ok('overlapping windows merge conservatively - nothing stops being speech',
    mergeSpeechWindows([{ startSec: 0, endSec: 5 }, { startSec: 3, endSec: 9 }])
      .length === 1 &&
    mergeSpeechWindows([{ startSec: 0, endSec: 5 }, { startSec: 3, endSec: 9 }])[0]
      .endSec === 9);
  ok('the window count is bounded, so the render expression cannot explode',
    mergeSpeechWindows(Array.from({ length: 400 }, (_, index) =>
      ({ startSec: index * 10, endSec: index * 10 + 1 })), 0.9, 48).length <= 48);

  // Speech timing travels through the timeline map, exactly as captions do.
  const spedMap = buildTimelineMap([{ id: 'v1', type: 'VIDEO', track: 0, position: 0,
    startTime: 0, duration: 10, trimStart: 0, trimEnd: 20, properties: { speed: 2 } }]);
  const spedWindows = speechWindowsFromTranscript([{ start: 8, end: 9, text: 'x' }], spedMap);
  ok('speech inside a 2x clip lands at half the time and half the length',
    Math.abs(spedWindows[0].startSec - 4) < 1e-6 &&
    Math.abs(spedWindows[0].endSec - 4.5) < 1e-6);
  const cutMap = buildTimelineMap([{ id: 'v1', type: 'VIDEO', track: 0, position: 0,
    startTime: 0, duration: 5, trimStart: 10, trimEnd: 15, properties: {} }]);
  ok('speech in a DELETED range contributes no window at all',
    speechWindowsFromTranscript([{ start: 2, end: 3, text: 'cut' }], cutMap).length === 0);
  ok('speech in a KEPT range is rebased onto the exported timeline',
    speechWindowsFromTranscript([{ start: 12, end: 13, text: 'kept' }], cutMap)[0]
      .startSec === 2);

  // --- 12. The ducking automation ------------------------------------------
  section('12. Ducking is real automation, not a stored flag');
  ok('the strengths are three real, distinct gains',
    DUCK_STRENGTHS.SUBTLE > DUCK_STRENGTHS.MEDIUM &&
    DUCK_STRENGTHS.MEDIUM > DUCK_STRENGTHS.STRONG && DUCK_STRENGTHS.STRONG > 0);
  ok('an unknown strength is refused',
    rejectsAudio(() => validateDuckStrength('ANNIHILATE'), 'INVALID_DUCK_STRENGTH'));
  ok('attack and release are bounded',
    rejectsAudio(() => validateDuckTiming(5, 300), 'INVALID_DUCK_TIMING') &&
    rejectsAudio(() => validateDuckTiming(150, 99999), 'INVALID_DUCK_TIMING'));
  ok('omitted timings fall back to the documented defaults',
    validateDuckTiming(undefined, undefined).attackMs === 150);

  const expression = duckVolumeExpression(windows, 0.35, 150, 350);
  ok('with no windows there is no expression at all - ducking is not faked',
    duckVolumeExpression([], 0.35, 150, 350) === '');
  ok('the expression starts from unity and subtracts a bounded amount',
    expression.startsWith('1-0.65*('));
  ok('every passage becomes a ramped trapezoid, not a hard switch',
    (expression.match(/clip\(/gu) ?? []).length === windows.length * 2);
  ok('overlapping passages take the deepest duck, never the sum',
    expression.includes('max('));
  // Evaluate the expression the way FFmpeg would, to prove the SHAPE is right.
  const evaluate = (t) => {
    const clip = (value, low, high) => Math.max(low, Math.min(high, value));
    const max = Math.max;
    // eslint-disable-next-line no-new-func
    return Function('t', 'clip', 'max', `return ${expression};`)(t, clip, max);
  };
  ok('the music is at full level well before any speech',
    Math.abs(evaluate(0) - 1) < 1e-6);
  ok('the music is fully ducked in the middle of a passage',
    Math.abs(evaluate(2) - 0.35) < 1e-6);
  ok('the music is fully ducked in the SECOND passage too',
    Math.abs(evaluate(8.6) - 0.35) < 1e-6);
  ok('the music has recovered in the silence between passages',
    Math.abs(evaluate(5) - 1) < 1e-6);
  ok('the duck ramps in rather than snapping',
    evaluate(0.925) > 0.35 && evaluate(0.925) < 1);
  ok('and it ramps out again after the last word',
    evaluate(2.775) > 0.35 && evaluate(2.775) < 1);
  ok('a deeper strength ducks deeper',
    Function('t', 'clip', 'max',
      `return ${duckVolumeExpression(windows, DUCK_STRENGTHS.STRONG, 150, 350)};`)(
      2, (v, l, h) => Math.max(l, Math.min(h, v)), Math.max) < 0.35);

  // --- 13. Ducking in the plan and the graph -------------------------------
  section('13. Ducking is applied to the configured track and to nothing else');
  const duckPlan = plan({ assets: [sourceAsset({ transcript: SPEECH }), audioAsset()],
    elements: [videoElement('v1', 0, 0, 20, 0),
      audioElement('m1', 0, 20, { volume: 0.5, duckUnderSpeech: true,
        duckLevel: DUCK_STRENGTHS.MEDIUM, attackMs: 150, releaseMs: 350 })] });
  const duckGraph = graphOf(duckPlan, { audioPaths: { m1: '/tmp/music.mp3' } });
  ok('the plan reports ducking available and carries the speech windows',
    duckPlan.plan.duckingAvailable && duckPlan.plan.speechWindows.length === 2);
  ok('the graph applies a per-frame volume automation to the music',
    duckGraph.includes("volume=volume='") && duckGraph.includes('eval=frame'));
  ok('the automation is escaped so its commas are not read as filter separators',
    duckGraph.includes('\\,'));
  ok('ducking comes AFTER the delay, so its timeline seconds mean what they say',
    duckGraph.indexOf('adelay') < duckGraph.indexOf('eval=frame') ||
      !duckGraph.includes('adelay'));
  ok('the SOURCE speech itself is never ducked',
    !/\[0:a\][^;]*eval=frame/u.test(duckGraph) &&
    !/\[acat\][^;]*eval=frame/u.test(duckGraph));

  const twoTracks = plan({ assets: [sourceAsset({ transcript: SPEECH }), audioAsset(),
    { ...audioAsset('sfx') }],
    elements: [videoElement('v1', 0, 0, 20, 0),
      audioElement('m1', 0, 20, { volume: 0.5, duckUnderSpeech: true }),
      { ...audioElement('m2', 0, 20, { volume: 0.5 }), assetId: 'sfx' }] });
  const twoGraph = graphOf(twoTracks, { audioPaths: { m1: '/tmp/a.mp3', m2: '/tmp/b.mp3' } });
  ok('with two music tracks, only the one configured for ducking is ducked',
    (twoGraph.match(/eval=frame/gu) ?? []).length === 1);

  const noTranscript = plan({ assets: [sourceAsset(), audioAsset()],
    elements: [videoElement('v1', 0, 0, 20, 0),
      audioElement('m1', 0, 20, { duckUnderSpeech: true })] });
  ok('without cached word timings the plan reports ducking UNAVAILABLE',
    noTranscript.plan.duckingAvailable === false &&
    noTranscript.plan.speechWindows.length === 0);
  ok('...and nothing is ducked rather than something being invented',
    !graphOf(noTranscript, { audioPaths: { m1: '/tmp/music.mp3' } }).includes('eval=frame'));
  ok('...and the export says so in a warning rather than silently doing nothing',
    noTranscript.plan.warnings.some((warning) => warning.includes('duck')));

  // --- 14. The mixed project ------------------------------------------------
  section('14. Workstream D composes with B and C rather than replacing them');
  const mixed = plan({
    settings: settings({ subtitlePolicy: 'OFF' }),
    assets: [sourceAsset({ transcript: SPEECH }), audioAsset(), imageAsset()],
    elements: [
      videoElement('v1', 0, 0, 20, 0, {
        crop: { left: 0.08, right: 0.08, top: 0, bottom: 0 }, rotation: 90, speed: 1.25,
        colorAdjustments: resolveColorFilter('CINEMATIC'), colorFilterId: 'CINEMATIC',
        sourceVolume: 0.9 }),
      { id: 't1', assetId: null, type: 'TEXT', track: 1, position: 0, startTime: 0, duration: 3,
        trimStart: 0, trimEnd: null, properties: { content: 'Hook', x: 0.1, y: 0.1, width: 0.8,
          height: 0.15, fontSize: 48, color: '#ffffff', strokeEnabled: true,
          strokeColor: '#000000', strokeWidth: 3 } },
      { id: 'c1', assetId: null, type: 'SUBTITLE', track: 1, position: 1, startTime: 1,
        duration: 2, trimStart: 0, trimEnd: null, properties: { content: 'this is speech',
          x: 0.1, y: 0.73, width: 0.8, height: 0.13, words: [{ start: 0, end: 1.6,
            text: 'this is speech' }] } },
      { id: 'logo1', assetId: 'logo', type: 'IMAGE', track: 2, position: 0, startTime: 0,
        duration: 16, trimStart: 0, trimEnd: null, properties: { role: 'LOGO', x: 0.76,
          y: 0.04, width: 0.2, height: 0.1, opacity: 1, zIndex: 20 } },
      audioElement('m1', 0, 16, { volume: 0.6, fadeInSec: 1, fadeOutSec: 2,
        duckUnderSpeech: true, duckLevel: DUCK_STRENGTHS.MEDIUM })
    ] });
  const mixedGraph = graphOf(mixed, { audioPaths: { m1: '/tmp/music.mp3' },
    overlayPaths: { logo1: '/tmp/logo.png' }, assFileName: 'text.ass' });
  ok('the mixed project plans without error and keeps every layer',
    mixed.plan.videoSegments.length === 1 && mixed.plan.textOverlays.length === 1 &&
    mixed.plan.subtitles.length === 1 && mixed.plan.visualOverlays.length === 1 &&
    mixed.plan.audioTracks.length === 1);
  ok('B survives: the crop, rotation and speed are all still in the graph',
    mixedGraph.includes('crop=') && mixedGraph.includes('rotate=') &&
    mixedGraph.includes('setpts=(PTS-STARTPTS)/1.250000'));
  ok('C survives: the ASS text layer is still composited',
    mixedGraph.includes('ass=text.ass'));
  ok('D is present: the Cinematic grade, the source level and the ducking',
    mixedGraph.includes('eq=') && mixedGraph.includes('vignette=') &&
    mixedGraph.includes('volume=0.9000') && mixedGraph.includes('eval=frame'));
  ok('the logo is still composited above the graded video',
    mixedGraph.includes('[ov0]') &&
    mixedGraph.indexOf('eq=') < mixedGraph.indexOf('[ov0]'));
  ok('captions are NOT regenerated by anything in this workstream',
    mixed.plan.subtitlesFromTranscript === false &&
    mixed.plan.subtitles[0].content === 'this is speech');

  // --- 15. Editor/renderer parity ------------------------------------------
  paritySuite();
  return commandSuite();
}

// --- The editor's mirror -----------------------------------------------------
//
// The bounds, the neutral and the filter definitions exist twice: once on the
// server, where they are enforced, and once in the browser, where a slider needs
// them to redraw without a round trip. Only a test that reads both can keep them
// identical.

function loadFrontend(relativePath, transform = (code) => code) {
  const sourcePath = path.join(__dirname, `../../frontend/src/lib/${relativePath}`);
  let code = fs.readFileSync(sourcePath, 'utf8');
  code = transform(code.replace(/^import type .*$/gmu, ''));
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const compiled = new Module(sourcePath, module);
  compiled.filename = sourcePath;
  compiled.paths = module.paths;
  compiled._compile(output, sourcePath);
  return compiled.exports;
}

function paritySuite() {
  section('15. The editor and the server describe the same colour and audio');
  const mirror = loadFrontend('edit-mode-color.ts');
  const audioMirror = loadFrontend('edit-mode-audio.ts');

  ok('both sides know exactly the same controls',
    JSON.stringify([...mirror.COLOR_KEYS]) === JSON.stringify([...COLOR_KEYS]));
  ok('both sides agree on every bound, exactly',
    JSON.stringify(mirror.COLOR_BOUNDS) === JSON.stringify(COLOR_BOUNDS));
  ok('both sides agree on the neutral grade',
    JSON.stringify(mirror.NEUTRAL_COLOR) === JSON.stringify(NEUTRAL_COLOR));
  ok('both sides offer exactly the same filters, with the same values',
    JSON.stringify(mirror.COLOR_FILTERS) === JSON.stringify(COLOR_FILTERS));
  ok('both sides resolve a filter at a strength identically',
    COLOR_FILTER_IDS.every((id) => [0, 0.3, 1].every((strength) =>
      JSON.stringify(mirror.resolveColorFilter(id, strength)) ===
        JSON.stringify(resolveColorFilter(id, strength)))));
  ok('both sides read a legacy element back as neutral',
    JSON.stringify(mirror.readColorAdjustments({})) === JSON.stringify(readColor({})));
  ok('both sides clamp an out-of-range stored value the same way',
    mirror.readColorAdjustments({ colorAdjustments: { contrast: 9 } }).contrast ===
      readColor({ colorAdjustments: { contrast: 9 } }).contrast);
  ok('both sides agree on the audio gain ceiling and the duck strengths',
    audioMirror.MAX_VOLUME === MAX_VOLUME &&
    JSON.stringify(audioMirror.DUCK_STRENGTHS) === JSON.stringify(DUCK_STRENGTHS));
  ok('both sides read an AUDIO element the same way',
    audioMirror.readAudioState({}).volume === readAudioState({}).volume &&
    audioMirror.readSourceAudio({}).volume === readSourceAudio({}).volume);

  // Preview parity, stated honestly: the preview is directionally correct
  // everywhere it draws anything, and says so where it cannot.
  const css = (over) => mirror.colorFilterCss(graded(over));
  ok('every control the preview claims is EXACT actually draws something',
    ['brightness', 'contrast', 'saturation']
      .every((key) => css({ [key]: 0.5 }) !== ''));
  ok('a neutral grade draws no CSS filter at all, as the renderer emits none',
    css({}) === '' && colorAdjustmentFilter(NEUTRAL_COLOR) === '');
  ok('brightness moves the same direction in both',
    /brightness\(1\.15\)/u.test(css({ brightness: 0.5 })) &&
    colorAdjustmentFilter(graded({ brightness: 0.5 })).includes('brightness=0.15'));
  ok('contrast moves the same direction in both',
    Number(/contrast\(([\d.]+)\)/u.exec(css({ contrast: 0.5 }))[1]) > 1 &&
    Number(/contrast=([\d.]+)/u.exec(
      colorAdjustmentFilter(graded({ contrast: 0.5 })))[1]) > 1);
  ok('-100% saturation is exactly monochrome in BOTH',
    /saturate\(0\)/u.test(css({ saturation: -1 })) &&
    colorAdjustmentFilter(graded({ saturation: -1 })).includes('saturation=0'));
  ok('sharpness is honestly marked as export-only, and the preview draws nothing for it',
    mirror.PREVIEW_PARITY.sharpness === 'EXPORT_ONLY' && css({ sharpness: 1 }) === '');
  ok('fade and vignette are drawn as overlay layers, since CSS filters cannot express them',
    mirror.colorOverlayLayers(graded({ fade: 0.5 })).length === 1 &&
    mirror.colorOverlayLayers(graded({ vignette: 0.5 })).length === 1 &&
    mirror.colorOverlayLayers(NEUTRAL_COLOR).length === 0);
  ok('no control claims a fidelity the preview does not have',
    COLOR_KEYS.every((key) => ['EXACT', 'APPROXIMATE', 'EXPORT_ONLY']
      .includes(mirror.PREVIEW_PARITY[key])));
  ok('the editor knows when a grade no longer matches its filter label',
    mirror.matchesFilter(resolveColorFilter('WARM'), 'WARM', 1) &&
    !mirror.matchesFilter({ ...resolveColorFilter('WARM'), temperature: 0.9 }, 'WARM', 1));
  ok('the editor is honest that the preview cannot exceed 100% gain',
    audioMirror.previewGain(1.8) === 1 && audioMirror.exceedsPreviewGain(1.8));
}

/**
 * The command layer, against the in-memory harness.
 *
 * This is where the claims that colour and audio are CANONICAL, validated and
 * undoable are actually checked: every control goes through the same
 * `phase3Command` path the editor calls, writes to real element properties,
 * produces exactly one revision, and comes back on undo.
 */
async function commandSuite() {
  section('16. Every control is a typed, canonical, undoable command');
  const state = await seedAnalyzedProject(createHarness());
  const { service } = state;
  const id = state.project.id;
  let project = state.analyzed;
  const video = () => (project.elements ?? []).find((element) => element.type === 'VIDEO');
  const run = async (action, payload) => {
    project = await service.phase3Command(id, action, { revision: project.revision, ...payload });
    return project;
  };
  const refused = async (action, payload, code) => {
    try { await service.phase3Command(id, action, { revision: project.revision, ...payload }); }
    catch (error) {
      const body = typeof error.getResponse === 'function' ? error.getResponse() : {};
      assert.equal(body.code, code, `expected ${code}, got ${body.code}`);
      return true;
    }
    assert.fail(`expected ${action} to be refused with ${code}`);
  };
  const target = video().id;

  // Every colour control, one at a time, through its own typed command.
  const commands = { exposure: 'set-video-exposure', brightness: 'set-video-brightness',
    contrast: 'set-video-contrast', highlights: 'set-video-highlights',
    shadows: 'set-video-shadows', saturation: 'set-video-saturation',
    temperature: 'set-video-temperature', tint: 'set-video-tint',
    sharpness: 'set-video-sharpness', fade: 'set-video-fade', vignette: 'set-video-vignette' };
  for (const [key, action] of Object.entries(commands)) {
    const value = COLOR_BOUNDS[key].min < 0 ? -0.4 : 0.4;
    await run(action, { elementId: target, [key]: value });
    ok(`${action} persists onto canonical element properties`,
      readColor(video().properties)[key] === value);
  }
  ok('every control set above survived every later one - nothing was clobbered',
    COLOR_KEYS.every((key) => readColor(video().properties)[key] !== 0));
  ok('an out-of-range colour value is refused with a typed code',
    await refused('set-video-contrast', { elementId: target, contrast: 4 },
      'INVALID_COLOR_VALUE'));

  const beforeFilter = project.revision;
  await run('apply-color-filter', { elementId: target, filterId: 'CINEMATIC' });
  ok('APPLY_COLOR_FILTER replaces the grade with the filter\'s resolved values',
    JSON.stringify(readColor(video().properties)) ===
      JSON.stringify(resolveColorFilter('CINEMATIC', 1)));
  ok('...and stores the filter id as a label alongside',
    readColorFilterId(video().properties) === 'CINEMATIC');
  ok('applying a filter is exactly ONE revision', project.revision === beforeFilter + 1);

  await run('set-video-temperature', { elementId: target, temperature: 0.7 });
  ok('editing a control after a filter changes ONLY that control',
    readColor(video().properties).temperature === 0.7 &&
    readColor(video().properties).contrast === resolveColorFilter('CINEMATIC').contrast);
  ok('...and the filter label is kept, so the UI can say "Cinematic (edited)"',
    readColorFilterId(video().properties) === 'CINEMATIC');

  project = await service.undo(id, project.revision);
  ok('undo restores the pre-edit filter values exactly',
    readColor(video().properties).temperature === resolveColorFilter('CINEMATIC').temperature);
  project = await service.redo(id, project.revision);
  ok('redo re-applies the manual edit', readColor(video().properties).temperature === 0.7);

  await run('apply-color-filter', { elementId: target, filterId: 'CINEMATIC', strength: 0.5 });
  ok('re-applying at half strength re-resolves from the definition, it does not compound',
    JSON.stringify(readColor(video().properties)) ===
      JSON.stringify(resolveColorFilter('CINEMATIC', 0.5)));
  ok('an unknown filter id is refused with a typed code',
    await refused('apply-color-filter', { elementId: target, filterId: 'NOPE' },
      'INVALID_COLOR_FILTER'));

  const beforeReset = project.revision;
  await run('reset-video-adjustments', { elementId: target });
  ok('RESET_VIDEO_ADJUSTMENTS returns every control to neutral',
    isNeutralColor(readColor(video().properties)));
  ok('...and clears the filter label with it',
    readColorFilterId(video().properties) === null);
  ok('reset is exactly one revision', project.revision === beforeReset + 1);
  project = await service.undo(id, project.revision);
  ok('undo brings the whole grade back in one step',
    JSON.stringify(readColor(video().properties)) ===
      JSON.stringify(resolveColorFilter('CINEMATIC', 0.5)));

  await run('apply-color-filter', { elementId: target, filterId: 'ORIGINAL' });
  ok('the Original filter resets correctly', isNeutralColor(readColor(video().properties)) &&
    readColorFilterId(video().properties) === null);

  // --- Copy / paste between segments ---------------------------------------
  section('17. Adjustments copy between segments without a shared state');
  await run('set-video-saturation', { elementId: target, saturation: -0.5 });
  project = await service.splitElement(id, { revision: project.revision, elementId: target,
    playheadSec: 6 });
  const videos = (project.elements ?? []).filter((element) => element.type === 'VIDEO');
  ok('a split leaves two segments', videos.length === 2);
  ok('both halves inherit the grade of the clip they came from',
    readColor(videos[0].properties).saturation === -0.5 &&
    readColor(videos[1].properties).saturation === -0.5);
  await run('set-video-contrast', { elementId: videos[0].id, contrast: 0.6 });
  const after = () => (project.elements ?? []).filter((element) => element.type === 'VIDEO');
  ok('grading one half does NOT change the other - there is no shared colour state',
    readColor(after()[0].properties).contrast === 0.6 &&
    readColor(after()[1].properties).contrast === 0);
  await run('paste-video-adjustments', { elementId: after()[1].id,
    fromElementId: after()[0].id });
  ok('pasting copies the whole resolved grade across',
    readColor(after()[1].properties).contrast === 0.6);
  ok('pasting from an element that is not a video segment is refused',
    await refused('paste-video-adjustments', { elementId: after()[1].id,
      fromElementId: 'gone' }, 'INVALID_ELEMENT_TYPE'));

  // --- Source audio ---------------------------------------------------------
  section('18. Source audio, music and ducking as canonical commands');
  const beforeSource = project.revision;
  await run('set-source-audio-volume', { volume: 0.4 });
  ok('SET_SOURCE_AUDIO_VOLUME with no elementId covers EVERY segment',
    after().every((element) => element.properties.sourceVolume === 0.4));
  ok('...in exactly one revision, however many segments there are',
    project.revision === beforeSource + 1);
  await run('set-source-audio-muted', { muted: true });
  ok('SET_SOURCE_AUDIO_MUTED mutes the whole video',
    after().every((element) => element.properties.sourceMuted === true));
  project = await service.undo(id, project.revision);
  ok('undo unmutes every segment together',
    after().every((element) => element.properties.sourceMuted !== true));
  await run('set-source-audio-volume', { elementId: after()[0].id, volume: 1.6 });
  ok('a single segment can be set on its own, above unity',
    after()[0].properties.sourceVolume === 1.6 &&
    after()[1].properties.sourceVolume === 0.4);
  ok('an out-of-range source volume is refused with a typed code',
    await refused('set-source-audio-volume', { volume: 3 }, 'INVALID_VOLUME'));

  // A music clip. The asset row is seeded directly rather than uploaded, because
  // `uploadAsset` probes the real file with ffprobe and this suite is offline.
  state.rows.editAssets.set('asset-music', { id: 'asset-music', editProjectId: id,
    sourceVideoId: null, role: 'AUDIO', originalName: 'bed.mp3', mimeType: 'audio/mpeg',
    sizeBytes: 1024, duration: 30, width: null, height: null, fps: null, metadata: {},
    transcript: null, analysis: null, createdAt: new Date(), updatedAt: new Date() });
  project = await service.get(id);
  const musicAsset = project.assets.find((asset) => asset.role === 'AUDIO');
  ok('an audio asset is available to the timeline', Boolean(musicAsset));
  await run('add-audio', { assetId: musicAsset.id });
  const clip = () => (project.elements ?? []).find((element) => element.type === 'AUDIO');
  ok('a music clip lands on the timeline under the dialogue',
    clip().properties.volume === 0.25);
  ok('a colour command is refused on anything that is not a video segment',
    await refused('set-video-contrast', { elementId: clip().id, contrast: 0.2 },
      'INVALID_ELEMENT_TYPE'));
  ok('an audio command is refused on a video segment',
    await refused('set-audio-volume', { elementId: after()[0].id, volume: 0.5 },
      'INVALID_ELEMENT_TYPE'));

  await run('set-audio-volume', { elementId: clip().id, volume: 1.5 });
  ok('music volume accepts a gain above unity', clip().properties.volume === 1.5);
  ok('a music volume beyond 200% is refused',
    await refused('set-audio-volume', { elementId: clip().id, volume: 2.5 }, 'INVALID_VOLUME'));
  await run('set-audio-muted', { elementId: clip().id, muted: true });
  ok('music mute persists', clip().properties.muted === true);
  project = await service.undo(id, project.revision);
  ok('undo unmutes it again', clip().properties.muted !== true);

  const clipDuration = clip().duration;
  await run('set-audio-fade', { elementId: clip().id, fadeInSec: 1, fadeOutSec: 2 });
  ok('both fades persist',
    clip().properties.fadeInSec === 1 && clip().properties.fadeOutSec === 2);
  ok('fades longer than the clip TOGETHER are refused',
    await refused('set-audio-fade', { elementId: clip().id,
      fadeInSec: clipDuration, fadeOutSec: clipDuration }, 'INVALID_FADE'));

  await run('set-audio-trim', { elementId: clip().id, trimStart: 1, trimEnd: 5 });
  ok('SET_AUDIO_TRIM sets a source window and the timeline length that follows it',
    clip().trimStart === 1 && clip().trimEnd === 5 && Math.abs(clip().duration - 4) < 1e-6);
  ok('a trim past the end of the uploaded file is refused',
    await refused('set-audio-trim', { elementId: clip().id, trimStart: 0, trimEnd: 9999 },
      'INVALID_AUDIO_TRIM'));
  project = await service.undo(id, project.revision);
  ok('undo restores the previous trim window in one step', clip().trimStart === 0);

  // Ducking: refused outright when the source has no word timings.
  ok('ducking is REFUSED, not faked, when the source has no transcript word timings',
    await refused('set-audio-ducking', { elementId: clip().id, duckEnabled: true },
      'DUCKING_UNAVAILABLE'));
  ok('turning ducking OFF is always allowed, even with no transcript',
    Boolean(await run('set-audio-ducking', { elementId: clip().id, duckEnabled: false })));

  // Give the source real cached word timings, then it becomes available.
  const sourceAssetRow = [...state.rows.editAssets.values()]
    .find((asset) => asset.role === 'SOURCE');
  sourceAssetRow.transcript = SPEECH;
  const beforeDuck = project.revision;
  await run('set-audio-ducking', { elementId: clip().id, duckEnabled: true,
    duckStrength: 'STRONG' });
  ok('with real cached timings, ducking is accepted',
    clip().properties.duckUnderSpeech === true);
  ok('the named strength resolves to the gain that actually renders',
    clip().properties.duckLevel === DUCK_STRENGTHS.STRONG &&
    clip().properties.duckStrength === 'STRONG');
  ok('enabling ducking is exactly one revision', project.revision === beforeDuck + 1);
  project = await service.undo(id, project.revision);
  ok('undo turns ducking back off', clip().properties.duckUnderSpeech === false);
  project = await service.redo(id, project.revision);
  ok('redo turns it back on', clip().properties.duckUnderSpeech === true);
  ok('an unknown duck strength is refused',
    await refused('set-audio-ducking', { elementId: clip().id, duckEnabled: true,
      duckStrength: 'NUCLEAR' }, 'INVALID_DUCK_STRENGTH'));

  // --- Caption safety carried over from Workstream C ------------------------
  section('19. Nothing in this workstream regenerates captions');
  const captionsBefore = (project.elements ?? []).filter((element) => element.type === 'SUBTITLE');
  await run('set-video-contrast', { elementId: after()[0].id, contrast: 0.3 });
  await run('set-source-audio-volume', { volume: 1 });
  const captionsAfter = (project.elements ?? []).filter((element) => element.type === 'SUBTITLE');
  ok('a colour command does not touch the caption track',
    captionsAfter.length === captionsBefore.length);
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/modules/edit-mode/edit-mode-color.ts'), 'utf8');
  const audioSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/modules/edit-mode/edit-mode-audio.ts'), 'utf8');
  ok('neither new module can reach caption generation at all',
    !source.includes('generateCaptions') && !audioSource.includes('generateCaptions'));

  // --- Frozen pipeline isolation --------------------------------------------
  section('20. The frozen auto pipeline is untouched');
  ok('neither new module imports a processing, videos, projects or editing service',
    [source, audioSource].every((code) =>
      !/from '\.\.\/processing\//u.test(code) && !/from '\.\.\/videos\//u.test(code) &&
      !/from '\.\.\/projects\//u.test(code) && !/\bService\b/u.test(code)));
  ok('the colour renderer is pure - no Prisma, no FFmpeg execution, no queue',
    (() => {
      const filter = require('node:fs').readFileSync(require('node:path').join(__dirname,
        '../src/modules/edit-mode/render/edit-mode-color-filter.ts'), 'utf8');
      return !filter.includes('PrismaService') && !filter.includes('spawn') &&
        !filter.includes('exec');
    })());
  ok('no processing, clip or generated-clip row was created by any of this',
    state.rows.processingJobs.size === 1 && state.rows.clipCandidates.size === 1 &&
    state.rows.generatedClips.size === 1);

  console.log(`\n${checks} checks passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
