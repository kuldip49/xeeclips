// Unit tests for the mandatory-hook, information-framing and curated-music work
// (no database, no LLM; FFmpeg only for the curated-library fixtures).
//   npm run build && node scripts/test-hook-thumbnail-music.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const dist = (name) => require(`../dist/modules/editing/${name}`);
const { deterministicHook, scoreHook, chooseBestHook, titleCase, solemnSubject } = dist('hook-generator');
const { PLATFORM_LAYOUT_PRESETS, HOOK_PLACEMENT, validatePlatformLayout } = dist('platform-layout');
const { fitHookText } = dist('text-layout');
const { hookAccentCandidates, applyHookAccents, hookAccentFamily, hookAccentBudget,
  HOOK_ACCENT_FAMILY_COLORS, HOOK_TEXT_COLOR } = dist('hook-accent');
const { HOOK_LENGTH } = dist('hook-generator');
const { detectInformationRegion, regionCropRect, INFORMATION_FIT } = dist('information-region');
const { loadMusicLibrary, selectMusicTrack, musicGainDb, SUPPORTED_MUSIC_FORMATS,
  MUSIC_FOLDER_MOODS } = dist('music-library');
const { fitEnableExpression } = dist('shot-classifier');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const disposable = [];
const scratch = (prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  disposable.push(directory);
  return directory;
};

// ------------------------------------------------------------------- hooks
const MARKET = { transcript: 'There was a huge market for it and that was banned. People kept buying anyway.',
  title: 'Market rules', synopsis: '' };

test('deterministic hook rewrites a weak transcript line into a headline', () => {
  const hook = deterministicHook(MARKET);
  assert(hook, 'a hook must always be produced');
  const words = hook.text.split(/\s+/u).filter(Boolean);
  // A complete thought, never a tiny fragment.
  assert(words.length >= HOOK_LENGTH.min && words.length <= HOOK_LENGTH.max,
    `hook length ${words.length}: ${hook.text}`);
  assert(/banned/iu.test(hook.text), `hook must keep the clip's claim: ${hook.text}`);
  assert.notEqual(hook.mechanism, 'PLAIN');
});

test('deterministic hook never returns null for usable material', () => {
  const cases = [
    { transcript: 'The company lost 4 billion dollars in a single quarter because nobody checked the numbers.',
      title: 'Quarterly results', synopsis: '' },
    { transcript: 'Um so the regulator quietly approved the merger and nobody in the press noticed for six months.',
      title: 'Merger news', synopsis: '' },
    { transcript: 'The entire feature was rejected by the review board. Everyone had assumed it was already approved.',
      title: 'Review board', synopsis: '' },
    { transcript: 'We talked about the weather and then we had lunch. It was fine.',
      title: 'A quiet afternoon walk', synopsis: '' }
  ];
  for (const context of cases) {
    const hook = deterministicHook(context);
    assert(hook && hook.text.trim(), `no hook for: ${context.transcript}`);
    const words = hook.text.split(/\s+/u).filter(Boolean);
    // The headline band is 7-22 words: a longer line is kept when shortening it
    // would cost meaning, and the renderer fits it into the header space.
    assert(words.length >= HOOK_LENGTH.min && words.length <= HOOK_LENGTH.max,
      `${hook.text} (${words.length} words)`);
    // Never a fragment that opens or closes on a connective.
    assert(!/^(and|but|so|or|because|that|which)\b/iu.test(hook.text), hook.text);
    assert(!/\b(and|but|so|or|the|a|an|of|to|in|for|with|within|about)$/iu
      .test(hook.text.replace(/[?!.]$/u, '')), hook.text);
  }
});

test('hook scoring rejects clickbait, fragments and transcript copies', () => {
  const rejected = (text) => scoreHook(text, MARKET).rejected;
  assert.equal(rejected('This Changes Everything About How the Market Was Banned'),
    'FABRICATED_CLICKBAIT');
  // Below the floor a headline is not a complete thought, whatever it says.
  assert.equal(rejected('This Changes Everything'), 'INVALID_LENGTH');
  assert.equal(rejected('Huge Market That Was Banned'), '',
    'five-word grounded hooks are inside the compact first-frame band');
  // A longer line is no longer rejected on length alone - it is allowed to
  // compete and simply loses to a stronger framing of the same claim.
  assert.equal(rejected('There Was a Huge Market for It That Was Banned'), '');
  assert.equal(rejected('There Was a Huge Market for It and That Was Banned and People Kept ' +
    'Buying It Anyway Because Nobody Ever Told Them That It Was Actually Illegal Everywhere'),
  'INVALID_LENGTH');
  assert.equal(rejected('It Was This That They Had for It'), 'NO_SUBSTANCE');
  assert.equal(rejected('but the huge market collapsed after it was banned'), 'INCOMPLETE_SENTENCE');
  assert.equal(rejected(''), 'EMPTY_TEXT');
  assert.equal(rejected('Quantum Lattice Divergence Protocol Rebalancing Itself Continuously Forever'),
    'NOT_GROUNDED');
  assert.equal(rejected('Um Yeah the Market Was Banned and People Kept Buying'),
    'TRANSCRIPT_FRAGMENT');
  assert.equal(scoreHook('Why Was This Huge Market Banned by the Board?', MARKET).rejected, '');
});

test('hook scoring prefers the curious grounded option over the flat one', () => {
  const { best, scored } = chooseBestHook(['Huge Market That Was Banned',
    'Why Was This Huge Market Banned by the Regulator?',
    'This Changes Everything About How the Market Works',
    'There Was a Huge Market for It That Was Banned'], MARKET);
  assert.equal(best.text, 'Why Was This Huge Market Banned by the Regulator?');
  // The grounded five-word variant remains available; fabricated clickbait is out.
  assert.equal(scored.filter((item) => item.rejected).length, 1);
});

test('a strong long headline is kept rather than cut down to a weak short one', () => {
  const context = { transcript: 'Nobody expected this one decision to change everything about ' +
    'how the whole market was regulated after the ban.', title: 'Market rules', synopsis: '' };
  const long = scoreHook('Nobody Expected This One Decision to Change the Whole Market', context);
  assert.equal(long.rejected, '', long.rejected);
  assert.equal(long.wordCount, 10);
  assert(long.score > 0);
});

test('diversity penalises a mechanism already spent on an earlier clip', () => {
  const line = 'Why Was This Huge Market Banned by the Regulator?';
  const base = scoreHook(line, MARKET);
  const repeat = scoreHook(line, { ...MARKET, usedMechanisms: [base.mechanism, base.mechanism] });
  assert(repeat.score < base.score, `${repeat.score} !< ${base.score}`);
  // A headline already used verbatim on another clip is rejected outright.
  assert.equal(scoreHook(line,
    { ...MARKET, usedHooks: ['Why Was That Huge Market Banned by the Regulator'] }).rejected,
  'DUPLICATE_ACROSS_CLIPS');
});

test('platform intent nudges which truthful angle wins', () => {
  const text = 'Why Was This Huge Market Banned by the Regulator?';
  const tiktok = scoreHook(text, { ...MARKET, platform: 'TIKTOK' });
  const neutral = scoreHook(text, MARKET);
  assert.equal(tiktok.rejected, '');
  assert.notEqual(tiktok.score, neutral.score);
});

test('humour is withheld from solemn subjects', () => {
  assert.equal(solemnSubject({ transcript: 'Three people died in the fire.', title: '', synopsis: '' }), true);
  assert.equal(solemnSubject(MARKET), false);
});

test('title case keeps minor words lower and acronyms intact', () => {
  assert.equal(titleCase('why was the NASA budget cut'), 'Why Was the NASA Budget Cut');
});

// --------------------------------------------------------- hook placement
test('every preset anchors the hook a fixed gap above the video, not the canvas top', () => {
  for (const preset of Object.values(PLATFORM_LAYOUT_PRESETS)) {
    const bottom = preset.hookZone.y + preset.hookZone.height;
    const gap = preset.videoViewport.y - bottom;
    assert.equal(gap, HOOK_PLACEMENT.targetGapAboveVideo,
      `${preset.id}: gap ${gap}px`);
    assert(gap >= HOOK_PLACEMENT.minGapAboveVideo && gap <= HOOK_PLACEMENT.maxGapAboveVideo,
      `${preset.id}: gap ${gap}px outside ${HOOK_PLACEMENT.minGapAboveVideo}-${HOOK_PLACEMENT.maxGapAboveVideo}`);
    assert.equal(preset.hookGapAboveVideo, gap);
    // The zone must still start well below the platform UI band at the very top.
    assert.equal(preset.hookZone.y, HOOK_PLACEMENT.topSafe);
    assert(preset.hookZone.height >= HOOK_PLACEMENT.minZoneHeight, preset.id);
  }
});

test('one-, two- and three-line hooks end on the same baseline above the video', () => {
  const layout = PLATFORM_LAYOUT_PRESETS.UNIVERSAL;
  const zone = { ...layout.hookZone, height: layout.hookZone.height - 4 };
  const bottoms = new Set();
  for (const text of ['THEY BANNED IT', 'WHY WAS THIS HUGE MARKET BANNED',
    'WHY WAS THIS ENTIRE HUGE DOMESTIC MARKET SUDDENLY BANNED']) {
    const fit = fitHookText(text, zone);
    assert(fit, `no fit for: ${text}`);
    // The renderer bottom-anchors the fitted block inside the zone.
    const height = Math.round(fit.height);
    const bounds = { x: 0, y: layout.hookZone.y + layout.hookZone.height - height,
      width: Math.round(fit.width), height };
    bottoms.add(bounds.y + bounds.height);
    const gap = layout.videoViewport.y - (bounds.y + bounds.height);
    assert(gap >= HOOK_PLACEMENT.minGapAboveVideo && gap <= HOOK_PLACEMENT.maxGapAboveVideo,
      `${fit.lines.length} line(s): gap ${gap}px`);
  }
  assert.equal(bottoms.size, 1, `hook baselines drifted: ${[...bottoms].join(', ')}`);
});

test('platform validation reports a hook that is too high or crowds the video', () => {
  const layout = PLATFORM_LAYOUT_PRESETS.UNIVERSAL;
  const good = { x: 140, y: layout.hookZone.y + layout.hookZone.height - 150,
    width: 800, height: 150 };
  assert.equal(validatePlatformLayout(layout, good, null, null).hookGapAboveVideoValid, true);
  const tooHigh = { x: 140, y: 8, width: 800, height: 150 };
  const high = validatePlatformLayout(layout, tooHigh, null, null);
  assert.equal(high.hookNotTooHigh, false);
  assert.equal(high.hookGapAboveVideoValid, false, 'a hook near the top edge is too far from the video');
});

// ------------------------------------------------------------ hook accents
test('accent words share one colour family, within the budget for the length', () => {
  for (const text of ['Why Was This Huge Market Banned by the Regulator',
    'They Lost 4 Billion Dollars in a Single Quarter',
    'The Regulator Quietly Approved It Without Telling Anyone',
    'Nobody Checked the Numbers Before the Board Signed Off']) {
    const words = text.split(/\s+/u).filter(Boolean);
    const accents = hookAccentCandidates(text, []);
    assert(accents.length >= 1 && accents.length <= hookAccentBudget(words.length),
      `${text}: ${accents.length} accents`);
    assert(accents.length < words.length, 'never colour every word');
    // One family for the whole headline: every accent word gets that one colour,
    // and no other accent colour appears in the rendered line.
    const family = hookAccentFamily(text);
    const color = HOOK_ACCENT_FAMILY_COLORS[family];
    const applied = applyHookAccents([text], accents, HOOK_TEXT_COLOR, (value) => value, color);
    assert(applied.lines[0].includes(color), text);
    for (const [other, otherColor] of Object.entries(HOOK_ACCENT_FAMILY_COLORS))
      if (other !== family) assert(!applied.lines[0].includes(otherColor),
        `${text} mixes ${family} with ${other}`);
    assert.equal(applied.accentedWordCount, accents.length);
  }
  // The family is a deterministic function of the text, so a re-render of the
  // same headline always produces the same colour.
  assert.equal(hookAccentFamily('The Market Was Banned Overnight by the Regulator'), 'RED');
  assert.equal(hookAccentFamily('Revenue Grew Faster Than Anyone at the Company Expected'), 'GREEN');
  assert.equal(hookAccentFamily('How the Scheduler Decides Which Task to Run First'), 'BLUE');
});

// ----------------------------------------------------- information framing
const textBox = (x, y, w, h) => ({ x, y, w, h });
const infoFrame = (t) => ({ t, faces: [], persons: [], textCoverage: .2, ocrLines: [],
  textBoxes: [textBox(.30, .22, .18, .05), textBox(.30, .30, .34, .05), textBox(.30, .38, .30, .05),
    textBox(.30, .46, .32, .05), textBox(.30, .54, .22, .05)] });
const infoShot = { sourceStart: 0, sourceEnd: 10, start: 0, end: 10, layout: 'FIT',
  informationMode: true, shotClass: 'ARTICLE', zoomAllowed: false, faceCount: 0, personCount: 0,
  primaryFaceArea: 0, textCoverage: .2, sampleCount: 4, reason: 'TEST' };

test('information region maximises the readable area instead of fitting the whole frame', () => {
  const frames = [0, 2, 4, 6].map(infoFrame);
  const region = detectInformationRegion(frames, [infoShot], { width: 1080, height: 1248 },
    { width: 1920, height: 1080 });
  assert(region, 'a clustered article should produce a region');
  assert(region.readabilityGain >= INFORMATION_FIT.minGain,
    `gain ${region.readabilityGain} must beat a whole-frame fit`);
  assert.equal(region.coverage, 1, 'every detected box must stay inside the region');
  // Nothing is clipped: the region contains all the boxes with padding to spare.
  for (const box of frames[0].textBoxes) {
    assert(box.x >= region.x && box.x + box.w <= region.x + region.w, 'box clipped horizontally');
    assert(box.y >= region.y && box.y + box.h <= region.y + region.h, 'box clipped vertically');
  }
  const crop = regionCropRect(region, { width: 1920, height: 1080 });
  assert(crop.width % 2 === 0 && crop.height % 2 === 0, 'crop must be even for FFmpeg');
  assert(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 1920 && crop.y + crop.height <= 1080);
});

test('information region is skipped when the content already fills the frame', () => {
  const full = (t) => ({ t, faces: [], persons: [], textCoverage: .5, ocrLines: [],
    textBoxes: [textBox(.02, .02, .96, .2), textBox(.02, .4, .96, .2), textBox(.02, .75, .96, .2)] });
  const region = detectInformationRegion([0, 2, 4].map(full), [infoShot],
    { width: 1080, height: 1248 }, { width: 1920, height: 1080 });
  assert.equal(region, null, 'cropping buys nothing when the graphic already fills the frame');
});

test('information and plain FIT shots get separate enable expressions', () => {
  const plainFit = { ...infoShot, start: 10, end: 20, sourceStart: 10, sourceEnd: 20,
    informationMode: false, shotClass: 'GROUP_SHOT' };
  const shots = [infoShot, plainFit];
  const info = fitEnableExpression(shots, (shot) => shot.informationMode);
  const plain = fitEnableExpression(shots, (shot) => !shot.informationMode);
  assert(info.includes('0.000') && !info.includes('10.000'), info);
  assert(plain.includes('10.000') && !plain.includes('0.000,'), plain);
  assert.equal(fitEnableExpression(shots).split('+').length, 2, 'default still covers every FIT shot');
});

// -------------------------------------------------------------- music library
function silentTrack(path, seconds = 6) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', `aevalsrc=0.1*sin(2*PI*220*t):s=44100:d=${seconds}`, path]);
}

function buildLibrary() {
  const curatedDir = scratch('music-curated-');
  const generatedDir = scratch('music-generated-');
  for (const folder of ['tension', 'documentary', 'neutral']) mkdirSync(join(curatedDir, folder));
  const curated = [];
  for (const [folder, name, mood] of [['tension', 'storm.mp3', 'DOCUMENTARY_TENSION'],
    ['tension', 'pressure.wav', 'DOCUMENTARY_TENSION'],
    ['tension', 'unlicensed.flac', 'DOCUMENTARY_TENSION'],
    ['documentary', 'slow.m4a', 'SUBTLE_DOCUMENTARY']]) {
    const file = join(curatedDir, folder, name);
    silentTrack(file);
    curated.push({ id: `curated-${folder}-${name}`, file: `${folder}/${name}`, title: name,
      moods: [mood], license: name === 'unlicensed.flac' ? 'UNKNOWN' : 'ROYALTY_FREE_APPROVED',
      loudnessLufs: -20, energy: 'MEDIUM', texture: name === 'pressure.wav' ? 'PULSE' : 'PAD',
      enabled: true, weight: 1, format: `.${name.split('.').pop()}` });
  }
  writeFileSync(join(curatedDir, 'curated.json'), JSON.stringify({ tracks: curated }));
  const bed = join(generatedDir, 'bed.m4a');
  silentTrack(bed);
  writeFileSync(join(generatedDir, 'library.json'), JSON.stringify({ tracks: [
    { id: 'generated-tension', file: 'bed.m4a', title: 'Generated Tension',
      moods: ['DOCUMENTARY_TENSION'], license: 'GENERATED_IN_HOUSE', loudnessLufs: -20 }] }));
  return { curatedDir, generatedDir };
}

test('curated tracks and generated beds load from separate manifests', async () => {
  const { curatedDir, generatedDir } = buildLibrary();
  const library = await loadMusicLibrary(curatedDir, generatedDir);
  const ids = library.tracks.map((track) => track.id);
  assert(ids.includes('curated-tension-storm.mp3'), ids.join(','));
  assert(ids.includes('generated-tension'), 'the generated fallback must stay available');
  assert(!ids.some((id) => id.includes('unlicensed')), 'an unapproved license must be refused');
  assert(library.problems.some((problem) => problem.startsWith('UNLICENSED_TRACK')), library.problems.join(','));
  // Every supported extension decodes into the library.
  const formats = new Set(library.tracks.map((track) => track.format));
  for (const format of ['.mp3', '.wav', '.m4a']) assert(formats.has(format), `${format} missing`);
});

test('curated material outranks the generated bed for the same mood', async () => {
  const { curatedDir, generatedDir } = buildLibrary();
  const { tracks } = await loadMusicLibrary(curatedDir, generatedDir);
  const chosen = selectMusicTrack(tracks, 'DOCUMENTARY_TENSION', 'clip-1');
  assert(chosen.curated === true, `picked ${chosen.id}`);
  assert(chosen.priority > tracks.find((track) => track.id === 'generated-tension').priority);
});

test('music intent steers texture, and clips from one video vary their bed', async () => {
  const { curatedDir, generatedDir } = buildLibrary();
  const { tracks } = await loadMusicLibrary(curatedDir, generatedDir);
  const pulse = selectMusicTrack(tracks, 'DOCUMENTARY_TENSION', 'clip-1', 0, new Set(),
    { energy: 'MEDIUM', texture: 'PULSE' });
  assert.equal(pulse.texture, 'PULSE', `picked ${pulse.id}`);
  // Five clips from one source: the reuse penalty moves off an already-used bed.
  const used = new Set();
  for (let index = 0; index < 2; index++) {
    const track = selectMusicTrack(tracks, 'DOCUMENTARY_TENSION', `clip-${index}`, 0, used);
    assert(!used.has(track.id), `clip ${index} reused ${track.id}`);
    used.add(track.id);
  }
  // With nothing left unused the best match still wins over variety.
  const exhausted = selectMusicTrack(tracks, 'DOCUMENTARY_TENSION', 'clip-9', 0, used);
  assert(exhausted, 'a bed is still selected when every candidate was heard recently');
});

test('a mood with no library track borrows a related one, NONE stays silent', async () => {
  const { curatedDir, generatedDir } = buildLibrary();
  const { tracks } = await loadMusicLibrary(curatedDir, generatedDir);
  assert(selectMusicTrack(tracks, 'ATMOSPHERIC', 'clip-1'), 'related moods must be borrowed');
  assert.equal(selectMusicTrack(tracks, 'NONE', 'clip-1'), null);
});

test('a rhythmic bed is mixed lower than a pad at the same loudness', () => {
  const pad = { texture: 'PAD', loudnessLufs: -20 };
  const pulse = { texture: 'PULSE', loudnessLufs: -20 };
  assert(musicGainDb(pulse, 'SUBTLE_DOCUMENTARY') < musicGainDb(pad, 'SUBTLE_DOCUMENTARY'));
});

test('every documented mood folder maps to a real mood and format list is consistent', () => {
  for (const folder of ['documentary', 'podcast', 'tension', 'technology', 'motivational',
    'emotional', 'neutral', 'energetic', 'atmospheric'])
    assert(MUSIC_FOLDER_MOODS[folder], `folder ${folder} has no mood`);
  assert.deepEqual([...SUPPORTED_MUSIC_FORMATS].sort(),
    ['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (error) { failed++; console.error(`FAIL  ${name}\n      ${error.message}`); }
  }
  // Disposable fixtures never outlive the run.
  for (const directory of disposable) rmSync(directory, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
