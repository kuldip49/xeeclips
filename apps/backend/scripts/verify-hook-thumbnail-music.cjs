// Real-media verification for the mandatory hook, the designed cover and the
// curated music library. Renders actual clips with FFmpeg and inspects the
// resulting pixels - logs alone are not evidence that a hook is on screen.
//
//   npm run build && node scripts/verify-hook-thumbnail-music.cjs
//
// Scenarios: single speaker, two people, an information-heavy screen, a clip
// whose hook came from Luna, a clip where Luna is deliberately unavailable, and
// several clips from one source to check music variety. Every fixture is
// disposable and removed at the end of the run.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { VideoEditExecutorService } = require('../dist/modules/editing/video-edit-executor.service');
const { SubtitleRendererService } = require('../dist/modules/editing/subtitle-renderer.service');
const { ReframeService } = require('../dist/modules/editing/reframe.service');
const { EditPlanService } = require('../dist/modules/editing/edit-plan.service');
const { EditingPlanValidator } = require('../dist/modules/editing/editing-plan-validator');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { PLATFORM_LAYOUT_PRESETS, HOOK_PLACEMENT } = require('../dist/modules/editing/platform-layout');

const root = mkdtempSync(join(tmpdir(), 'verify-hook-music-'));
const observations = [];
const failures = [];
const note = (line) => { observations.push(line); console.log(`  ${line}`); };
const expect = (condition, message) => {
  if (condition) return true;
  failures.push(message);
  console.error(`  FAIL ${message}`);
  return false;
};

// --------------------------------------------------------------- fixtures
function makeSource(name, filter, seconds) {
  const path = join(root, `${name}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter,
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path]);
  return path;
}

function makeMusicLibrary() {
  const curated = join(root, 'music');
  const generated = join(root, 'music-generated');
  mkdirSync(generated, { recursive: true });
  const tracks = [];
  for (const [folder, name, note] of [['neutral', 'calm_one.mp3', 196],
    ['neutral', 'calm_two.mp3', 220], ['neutral', 'calm_three.m4a', 247]]) {
    mkdirSync(join(curated, folder), { recursive: true });
    const file = join(curated, folder, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `aevalsrc=0.12*sin(2*PI*${note}*t):s=44100:d=40`, file]);
    tracks.push({ id: `curated-${name}`, file: `${folder}/${name}`, title: name,
      moods: ['CLEAN_NEUTRAL'], license: 'ROYALTY_FREE_APPROVED', loudnessLufs: -20,
      energy: 'LOW', texture: 'PAD', enabled: true, weight: 1 });
  }
  writeFileSync(join(curated, 'curated.json'), JSON.stringify({ tracks }));
  writeFileSync(join(generated, 'library.json'), JSON.stringify({ tracks: [] }));
  return { curated, generated };
}

const words = (texts, start, step) => texts.map((text, index) =>
  ({ start: start + index * step, end: start + index * step + step * .8, text }));

const face = (t, x, y, w = .18, h = .22) => ({ timestamp: t, x, y, w, h, confidence: .9 });
const analysisFrame = (t, faces, textBoxes = []) => ({ t, faces, persons: [],
  textCoverage: textBoxes.reduce((sum, box) => sum + box.w * box.h, 0),
  textBoxes, ocrLines: textBoxes.length ? ['Quarterly report', 'Revenue fell 12 percent'] : [] });

// ------------------------------------------------------------ measurement
/** Bounding box of bright glyph pixels inside a region of one rendered frame. */
// The headline is white plus one or two accent words; the primary accent (red)
// is much darker than white, so the threshold has to sit below it.
function glyphBounds(videoPath, atSec, region, threshold = 110) {
  const frame = join(root, `frame-${Math.random().toString(36).slice(2)}.pgm`);
  // A still image has no timeline to seek in.
  const seek = atSec > 0 ? ['-ss', atSec.toFixed(3)] : [];
  const run = spawnSync('ffmpeg', ['-v', 'error', '-y', ...seek, '-i', videoPath,
    '-frames:v', '1', '-vf', `crop=${region.width}:${region.height}:${region.x}:${region.y},format=gray`,
    frame], { encoding: 'utf8' });
  if (run.status !== 0 || !existsSync(frame)) return null;
  const { readFileSync } = require('node:fs');
  const buffer = readFileSync(frame);
  rmSync(frame, { force: true });
  // Minimal binary PGM reader: P5, width height, maxval, then raw bytes.
  const header = buffer.subarray(0, 64).toString('latin1');
  const match = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/u.exec(header);
  if (!match) return null;
  const [, w, h] = match.map(Number);
  const offset = match[0].length;
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (buffer[offset + y * w + x] < threshold) continue;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || count < 200) return null;
  return { x: region.x + minX, y: region.y + minY,
    width: maxX - minX + 1, height: maxY - minY + 1, pixels: count };
}

// ------------------------------------------------------------------ render
const executor = new VideoEditExecutorService(new SubtitleRendererService(), new ReframeService());

async function render(label, options) {
  const output = join(root, `out-${label}.mp4`);
  const plan = { ...fallbackEditPlan(0, options.duration, '9:16'),
    platformPreset: 'UNIVERSAL', videoTemplate: 'EDITORIAL_FRAME',
    recommendedTemplate: 'EDITORIAL_FRAME', musicMood: options.musicMood ?? 'CLEAN_NEUTRAL',
    musicEnergy: 'LOW', musicTexture: 'PAD',
    preserveInformation: options.preserveInformation === true,
    hookRequired: true,
    onScreenHook: { enabled: true, text: options.hook, startSec: 0,
      endSec: options.duration, position: 'TOP', style: 'TOP_HEADLINE' } };
  const result = await executor.execute(options.source, output, plan, options.words,
    options.frames.flatMap((frame) => frame.faces), [], [], {
      inputOffsetSec: 0, qa: true, maxAttempts: 2, seed: options.seed ?? label,
      musicDirectory: options.musicDirectory,
      avoidMusicTrackIds: options.avoidMusicTrackIds ?? [],
      analysis: { source: 'DENSE', frames: options.frames, shotBoundaries: [], ocrText: '' } });
  return { output, result, plan };
}

/** Every AI_EDITED clip: a rendered hook, just above the video, on a real cover. */
function verifyHook(label, result, output, duration) {
  const layout = PLATFORM_LAYOUT_PRESETS.UNIVERSAL;
  const checks = result.quality.checks;
  expect(checks.hookTextPresent === true, `${label}: hookTextPresent is ${checks.hookTextPresent}`);
  expect(checks.hookRendered === true, `${label}: hookRendered is ${checks.hookRendered}`);
  expect(checks.hookRendered !== 'N/A' && checks.hookGapAboveVideoValid !== 'N/A',
    `${label}: hook checks must never report N/A for an edited clip`);
  expect(result.visual.hookFinalText.trim().length > 0, `${label}: hook text is empty`);
  expect(checks.thumbnailGenerated === true, `${label}: no cover was generated`);
  expect(checks.thumbnailMatchesHookText === true, `${label}: cover does not carry the hook`);
  expect(result.visual.hookAccentWordCount >= 1 && result.visual.hookAccentWordCount <= 2,
    `${label}: ${result.visual.hookAccentWordCount} accent words`);

  // Measure the rendered pixels at the first settled frame and the last frame.
  const header = { x: 0, y: 0, width: 1080, height: layout.videoViewport.y };
  note(`${label} planned: hookBounds=${JSON.stringify(result.visual.hookBounds)} ` +
    `zone=${JSON.stringify(result.visual.hookZone)} gap=${result.visual.hookGapAboveVideoPx}px ` +
    `lines=${result.visual.hookLines.length} font=${result.visual.hookFontSize}`);
  for (const [when, atSec] of [['first', Math.max(.4, result.visual.hookSettleSec + .1)],
    ['final', Math.max(.5, duration - .3)]]) {
    const bounds = glyphBounds(output, atSec, header);
    if (!expect(bounds, `${label}: no headline glyphs in the ${when} frame`)) continue;
    const gap = layout.videoViewport.y - (bounds.y + bounds.height);
    note(`${label} ${when} frame: hook ink bottom y=${bounds.y + bounds.height}, ` +
      `video top y=${layout.videoViewport.y}, gap=${gap}px, ink=${bounds.width}x${bounds.height}`);
    // The measured gap is to the last row of ink; the laid-out block bottom sits
    // a little lower because a text line reserves descender space below the
    // glyphs. INK_SLACK covers that difference.
    const INK_SLACK = 20;
    expect(gap >= HOOK_PLACEMENT.minGapAboveVideo &&
      gap <= HOOK_PLACEMENT.maxGapAboveVideo + INK_SLACK,
    `${label} ${when}: measured gap ${gap}px outside ${HOOK_PLACEMENT.minGapAboveVideo}-${HOOK_PLACEMENT.maxGapAboveVideo + INK_SLACK}`);
    const planned = result.visual.hookBounds;
    expect(planned && Math.abs((planned.y + planned.height) - (bounds.y + bounds.height)) <= 25,
      `${label} ${when}: rendered bottom ${bounds.y + bounds.height} does not match the planned ` +
      `${planned && planned.y + planned.height}`);
    expect(bounds.y > layout.topSafeZone.height,
      `${label} ${when}: hook starts at y=${bounds.y}, too close to the top edge`);
  }
  // The cover exists on disk and carries the same headline.
  const cover = result.thumbnail?.path;
  expect(cover && existsSync(cover) && statSync(cover).size > 2000,
    `${label}: cover file missing or empty`);
  if (cover && existsSync(cover)) {
    const bounds = glyphBounds(cover, 0, header);
    expect(bounds, `${label}: cover has no headline glyphs`);
    if (bounds) note(`${label} cover: hook glyphs ${bounds.width}x${bounds.height} at y=${bounds.y}`);
  }
}

async function main() {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error?.code === 'ENOENT') {
    console.log('SKIP: FFmpeg is unavailable on this host.');
    return;
  }
  const music = makeMusicLibrary();
  const spoken = words(['This', 'is', 'the', 'strong', 'opening', 'line', 'that', 'matters'], .5, .55);

  // 1) Single speaker.
  console.log('\n[1] single-speaker AI_EDITED clip');
  const single = makeSource('single', 'testsrc2=size=640x360:rate=30', 9);
  const singleFrames = [0, 2, 4, 6, 8].map((t) => analysisFrame(t, [face(t, .4, .3)]));
  const one = await render('single', { source: single, duration: 8, hook: 'Why This Opening Matters',
    words: spoken, frames: singleFrames, musicDirectory: music.curated });
  verifyHook('single-speaker', one.result, one.output, 8);

  // 2) Two people in frame.
  console.log('\n[2] two-person AI_EDITED clip');
  const twoFrames = [0, 2, 4, 6].map((t) =>
    analysisFrame(t, [face(t, .18, .32, .16, .2), face(t, .62, .32, .16, .2)]));
  const two = await render('two', { source: single, duration: 8, hook: 'They Never Agreed On This',
    words: spoken, frames: twoFrames, musicDirectory: music.curated,
    avoidMusicTrackIds: [one.result.visual.music?.trackId].filter(Boolean) });
  verifyHook('two-person', two.result, two.output, 8);

  // 3) Information-heavy screen: the readable region, not the whole frame.
  console.log('\n[3] information-heavy clip');
  const screen = makeSource('screen',
    'color=c=0xF2F2F2:size=1280x720:rate=30,drawbox=x=380:y=150:w=520:h=420:color=0x202020:t=fill', 9);
  const infoBoxes = [{ x: .30, y: .22, w: .34, h: .05 }, { x: .30, y: .30, w: .38, h: .05 },
    { x: .30, y: .38, w: .30, h: .05 }, { x: .30, y: .46, w: .36, h: .05 },
    { x: .30, y: .54, w: .26, h: .05 }];
  const infoFrames = [0, 2, 4, 6, 8].map((t) => analysisFrame(t, [], infoBoxes));
  const info = await render('info', { source: screen, duration: 8,
    hook: 'Why Was This Report Buried?', words: spoken, frames: infoFrames,
    preserveInformation: true, musicDirectory: music.curated,
    avoidMusicTrackIds: [one.result.visual.music?.trackId, two.result.visual.music?.trackId].filter(Boolean) });
  verifyHook('information', info.result, info.output, 8);
  const framing = info.result.information;
  note(`information: shots=${framing.informationShotCount} region=${JSON.stringify(framing.informationRegion)} ` +
    `gain=${framing.informationReadabilityGain} renderedHeight=${framing.informationRenderedHeightPx}px`);
  if (framing.informationShotCount > 0) {
    expect(framing.informationRegion != null,
      'information: no readable region was detected for a screen-heavy clip');
    if (framing.informationRegion) {
      expect(framing.informationReadabilityGain > 1,
        `information: region gain ${framing.informationReadabilityGain} is no better than a whole-frame fit`);
      expect(framing.informationRegionCoverage === 1,
        `information: only ${framing.informationRegionCoverage} of the detected content fits the region`);
      // A whole-frame fit of a 16:9 source is 1080x608; the region must beat it.
      expect(framing.informationRenderedHeightPx > 608,
        `information: rendered height ${framing.informationRenderedHeightPx}px is no larger than a whole-frame fit`);
    }
    expect(info.result.quality.checks.informationPreserved !== false,
      'information: content was clipped');
  }

  // 4/5) Luna hook pipeline, and Luna deliberately unavailable.
  console.log('\n[4/5] hook generation with and without Luna');
  const validator = new EditingPlanValidator();
  const context = { start: 0, end: 8, aspectRatio: '9:16', aiMode: 'ONLINE', words: spoken,
    transcript: 'There was a huge market for it and that was banned. People kept buying anyway.',
    title: 'Market rules', synopsis: '', wholeVideoSummary: '', visualEvidence: {}, clipUnderstanding: {} };
  let call = 0;
  const lunaPlan = { ...fallbackEditPlan(0, 8, '9:16'), version: 1,
    onScreenHook: { enabled: true, text: 'Who Really Paid For This Ban', startSec: 0, endSec: 8,
      position: 'TOP', style: 'TOP_HEADLINE' } };
  const withLuna = await new EditPlanService({ generate: async () => {
    call++;
    return { data: call === 1 ? lunaPlan : { hookA: 'Why Was This Huge Market Banned?',
      hookB: 'They Banned an Entire Market', hookC: 'Well, That Market Is Gone' },
    metadata: { provider: 'openai', model: 'gpt-5.6-luna' } };
  } }, validator).create(context);
  note(`luna available: "${withLuna.hookFinalText}" via ${withLuna.hookSource} ` +
    `(${withLuna.hookMechanism}, score ${withLuna.hookScore})`);
  expect(withLuna.plan.onScreenHook.enabled === true, 'luna: hook must be enabled');
  expect(withLuna.hookFinalText.trim().length > 0, 'luna: hook must have text');

  const withoutLuna = await new EditPlanService({ generate: async () => {
    throw new Error('synthetic Luna outage');
  } }, validator).create(context);
  note(`luna unavailable: "${withoutLuna.hookFinalText}" via ${withoutLuna.hookSource} ` +
    `(${withoutLuna.hookMechanism})`);
  expect(withoutLuna.plan.hookRequired === true, 'no-luna: hookRequired must stay true');
  expect(withoutLuna.plan.onScreenHook.enabled === true,
    'no-luna: a hook is mandatory even with no model available');
  expect(withoutLuna.hookFinalText.trim().length > 0, 'no-luna: deterministic hook is empty');
  expect(!context.transcript.toLowerCase()
    .includes(withoutLuna.hookFinalText.toLowerCase().replace(/[?!.]+$/u, '')),
  'no-luna: the fallback must not be a copied transcript sentence');

  // The deterministic hook must survive an actual render.
  const rendered = await render('nolluna', { source: single, duration: 8,
    hook: withoutLuna.hookFinalText, words: spoken, frames: singleFrames,
    musicDirectory: music.curated });
  verifyHook('deterministic-hook', rendered.result, rendered.output, 8);

  // 6) Music variety across clips from one source.
  console.log('\n[6] music variety across clips from one source');
  const chosen = [one, two, info, rendered].map((item) => item.result.visual.music?.trackId ?? null);
  note(`tracks chosen: ${chosen.join(', ')}`);
  const curatedUsed = [one, two, info, rendered]
    .map((item) => item.result.visual.music?.license).filter(Boolean);
  expect(curatedUsed.every((license) => license === 'ROYALTY_FREE_APPROVED'),
    `music: expected curated tracks, got licenses ${curatedUsed.join(',')}`);
  expect(new Set(chosen.filter(Boolean)).size >= 2,
    `music: every clip used the same bed (${chosen.join(', ')})`);
  for (const item of [one, two, info, rendered])
    expect(item.result.quality.checks.speechDominant !== false,
      'music: speech must stay dominant over the bed');

  console.log(`\n${observations.length} observations, ${failures.length} failure(s)`);
  if (failures.length) { failures.forEach((item) => console.error(` - ${item}`)); process.exit(1); }
  console.log('Hook / cover / information / music verification passed on real renders.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => rmSync(root, { recursive: true, force: true }));
