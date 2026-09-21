// Golden benchmark for EDITED_CLIPS rendering quality.
// Synthetic, reproducible scenarios (generated with FFmpeg) exercise the real
// executor + render QA + quality gate. Metrics are compared with the stored
// baseline to catch regressions; `--update` rewrites the baseline.
//   npm run build && node scripts/test-editing-benchmark.cjs [--update] [--only name]
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { applyDeterministicEditorial } = require('../dist/modules/editing/deterministic-editorial');
const { optimizeEditBoundaries } = require('../dist/modules/editing/edit-boundaries');
const { buildEditedTimeline } = require('../dist/modules/editing/edit-timeline');
const { VideoEditExecutorService } = require('../dist/modules/editing/video-edit-executor.service');
const { SubtitleRendererService } = require('../dist/modules/editing/subtitle-renderer.service');
const { ReframeService } = require('../dist/modules/editing/reframe.service');

const BASELINE = join(__dirname, 'fixtures', 'editing-benchmark-baseline.json');
const update = process.argv.includes('--update');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const TEXT = 'So the budget grew by 40% last year and nobody noticed because the report was buried. ' +
  'That is the real scandal here. Every family pays for it now.';

// Words every 0.42 s with 0.3 s duration; sentence ends get a 0.5 s pause.
function makeWords(text, start = 1, whisperBias = 0) {
  const words = [];
  let t = start;
  text.split(' ').forEach((token, index) => {
    words.push({ start: t + whisperBias, end: t + .3 + whisperBias, text: token, trueStart: t });
    // Natural phrasing: short pauses every few words, longer ones at sentence ends.
    t += /[.!?]$/u.test(token) ? .92 : index % 3 === 2 ? .62 : .38;
  });
  return words;
}

const TEXTURE = 'gradients=c0=0x3a4a5a:c1=0x7a5a4a:c2=0x2a3a4a:n=3:speed=0.02:seed=7';
function makeVideo(path, { duration, width = 640, height = 360, base = TEXTURE, boxes = [],
  text = null, textX = .08, textWidth = .5, audioWords, eq = null }) {
  const draw = boxes.map((b) => `drawbox=x=${Math.round(b.x * width)}:y=${Math.round(b.y * height)}:` +
    `w=${Math.round(b.w * width)}:h=${Math.round(b.h * height)}:color=${b.color}:t=fill` +
    (b.enable ? `:enable='${b.enable}'` : ''));
  const lines = text ? text.map((line, i) => `drawbox=x=${Math.round(width * textX)}:y=${Math.round(height * (.12 + i * .07))}:` +
    `w=${Math.round(width * (textWidth - (i % 3) * .035))}:h=${Math.round(height * .03)}:color=white:t=fill`) : [];
  const filters = [`${base}${base.includes('=') ? ':' : '='}s=${width}x${height}:r=30:d=${duration}`, 'format=yuv420p',
    'noise=alls=6:allf=t', ...draw, ...lines, ...(eq ? [eq] : [])].join(',');
  // Speech stand-in: a tone burst per word, silence elsewhere.
  const bursts = audioWords.map((word) => `between(t\\,${word.trueStart.toFixed(3)}\\,${(word.trueStart + .3).toFixed(3)})`).join('+');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', filters,
    '-f', 'lavfi', '-i', `aevalsrc=0.4*sin(2*PI*180*t)*(${bursts}):s=48000:d=${duration}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
}

const faceAt = (t, x, y = .2, w = .12, h = .22, id = 'a') => ({ timestamp: t, x, y, w, h, trackId: id, confidence: .9 });
const frames = (duration, fn) => Array.from({ length: Math.floor(duration * 4) }, (_, i) => fn(i / 4));
const frame = (t, faces = [], extra = {}) => ({ t, faces, persons: [], textCoverage: 0, textBoxes: [], ocrLines: [], ...extra });

const SCENARIOS = [
  { name: 'single-speaker-weak-opening', duration: 30, text: `${TEXT} Nobody in charge wants to admit that today.`,
    video: { boxes: [{ x: .44, y: .2, w: .12, h: .22, color: '0xd9a78a' }] },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [faceAt(t, .44)])), shotBoundaries: [] }),
    expect: { layouts: ['FILL'], leadInRemoved: true, zoomCountMin: 1 } },
  { name: 'two-person-interview', duration: 18, video: { boxes: [
      { x: .12, y: .22, w: .11, h: .2, color: '0xd9a78a' }, { x: .76, y: .22, w: .11, h: .2, color: '0xc58f70' }] },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [faceAt(t, .12, .22, .11, .2, 'a'), faceAt(t, .76, .22, .11, .2, 'b')])),
      shotBoundaries: [] }),
    expect: { layouts: ['FIT'], twoPersonPreserved: true } },
  { name: 'shot-change-reframe', duration: 18, video: { boxes: [
      { x: .2, y: .2, w: .12, h: .22, color: '0xd9a78a', enable: 'lt(t,8)' },
      { x: .68, y: .25, w: .12, h: .22, color: '0xd9a78a', enable: 'gte(t,8)' }] },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [faceAt(t, t < 8 ? .2 : .68, t < 8 ? .2 : .25, .12, .22, t < 8 ? 'a' : 'b')])),
      shotBoundaries: [8] }),
    expect: { layouts: ['FILL', 'FILL'], shotReframes: 1 } },
  { name: 'webpage-article', duration: 16, video: { base: 'color=c=0xf2f2f2',
      text: Array.from({ length: 9 }, (_, i) => i), textX: .31, textWidth: .38 },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [], { textCoverage: .2, ocrLines: t === 0 ? [
      'www.news-site.com', 'Search', 'The budget grew by 40% last year according to the annual report',
      'Officials declined to comment on the findings released on Friday'] : [],
      textBoxes: [{ x: .3, y: .1, w: .4, h: .68 }] })), shotBoundaries: [] }),
    expect: { layouts: ['FIT'], informationPreserved: true, zoomCount: 0 } },
  { name: 'chart-presentation', duration: 16, video: { base: 'color=c=0x10243a', boxes: [
      { x: .15, y: .3, w: .1, h: .5, color: '0x4fb3ff' }, { x: .35, y: .45, w: .1, h: .35, color: '0x4fb3ff' },
      { x: .55, y: .2, w: .1, h: .6, color: '0x4fb3ff' }] },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [], { textCoverage: .12, ocrLines: t === 0 ?
      ['GDP 2021 2.1% 2022 3.4% 2023 1.9% 2024 2.7%'] : [],
      graphicBoxes: [{ x: .13, y: .18, w: .55, h: .65 }] })), shotBoundaries: [] }),
    expect: { layouts: ['FIT'], informationPreserved: true, zoomCount: 0 } },
  { name: 'poor-lighting', duration: 16, video: { base: 'gradients=c0=0x121216:c1=0x2a2320:n=2:speed=0.02:seed=7',
      boxes: [{ x: .44, y: .2, w: .12, h: .22, color: '0x4a3a32' }] },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [faceAt(t, .44)])), shotBoundaries: [] }),
    expect: { exposureUp: true } },
  { name: 'already-graded', duration: 16, video: { base: 'testsrc2', eq: 'eq=contrast=1.6:saturation=1.8' },
    analysis: () => ({ frames: [], shotBoundaries: [] }),
    expect: { preset: 'SOURCE_ALREADY_GRADED' } },
  { name: 'subtitle-timing-whisper-early', duration: 18, whisperBias: -.12,
    video: { boxes: [{ x: .44, y: .2, w: .12, h: .22, color: '0xd9a78a' }] },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [faceAt(t, .44)])), shotBoundaries: [] }),
    expect: { syncAverageMaxMs: 80 } },
  { name: 'strong-opening-dead-air-ending', duration: 20, text: 'Nobody noticed the 40% budget increase last year. ' +
      'The report was buried on purpose. Families pay for it now.',
    video: { boxes: [{ x: .44, y: .2, w: .12, h: .22, color: '0xd9a78a' }] },
    analysis: (d) => ({ frames: frames(d, (t) => frame(t, [faceAt(t, .44)])), shotBoundaries: [] }),
    expect: { leadInRemoved: false, deadAirAtEndMaxMs: 350 } }
];

async function runScenario(scenario, directory) {
  const text = scenario.text ?? TEXT;
  const words = makeWords(text, 1, scenario.whisperBias ?? 0);
  const source = join(directory, `${scenario.name}.mp4`);
  makeVideo(source, { duration: scenario.duration, audioWords: words, ...scenario.video });
  const candidateStart = .6;
  const candidateEnd = Math.min(scenario.duration - .5, words[words.length - 1].end + 2.5);
  const plan = applyDeterministicEditorial({ ...fallbackEditPlan(candidateStart, candidateEnd, '9:16'),
    platformPreset: 'INSTAGRAM_REELS', videoTemplate: 'EDITORIAL_FRAME', recommendedTemplate: 'EDITORIAL_FRAME',
    onScreenHook: { enabled: true, text: 'The Budget Scandal Nobody Noticed This Year', startSec: candidateStart,
      endSec: candidateEnd, position: 'TOP', style: 'TOP_HEADLINE' } }, words, text);
  plan.musicMood = 'DOCUMENTARY_TENSION';
  const boundary = optimizeEditBoundaries({ words, candidateStart, candidateEnd, windowStart: 0,
    windowEnd: scenario.duration });
  const timeline = buildEditedTimeline({ candidateStart, candidateEnd, editedStart: boundary.editedStart,
    editedEnd: boundary.editedEnd, cuts: boundary.cuts });
  const analysisParts = scenario.analysis(scenario.duration);
  const analysis = { source: 'DENSE', ocrText: '', fallbackReason: '', runtimeMs: 0, ...analysisParts };
  const started = Date.now();
  const result = await new VideoEditExecutorService(new SubtitleRendererService(), new ReframeService())
    .execute(source, join(directory, `${scenario.name}-edited.mp4`),
      { ...plan, clipStartSec: timeline.editedStart, clipEndSec: timeline.editedEnd },
      words.map(({ start, end, text: token }) => ({ start, end, text: token })), [], [], [],
      { inputOffsetSec: 0, timeline, analysis, boundary, seed: scenario.name });
  const v = result.visual;
  const m = result.quality.measurements;
  return {
    status: result.quality.status, renderAttempts: result.quality.renderAttempts,
    failed: result.quality.failedChecks, degraded: result.quality.degradedChecks,
    repairs: result.quality.repairs.map((item) => item.repairAction),
    rawDuration: timeline.rawDuration, editedDuration: timeline.editedDuration,
    leadInRemoved: boundary.removedLeadIn.length > 0, deadAirAtEndMs: boundary.deadAirAtEndMs,
    layouts: v.shots.map((shot) => shot.layout), shotClasses: v.shots.map((shot) => shot.shotClass),
    shotReframes: v.shotChangeReframeCount,
    hookRendered: m.hook.hookRendered, hookInsideSafeZone: m.hook.hookInsideSafeZone, hookFontSize: v.hookFontSize,
    hookLines: v.hookLines.length,
    subtitleRendered: m.subtitle.renderedRatio, animationVisible: m.subtitle.animationVisibleRatio,
    highlightVisible: m.subtitle.highlightVisibleRatio,
    syncMeasurement: m.subtitle.syncMeasurement, syncAverageMs: m.subtitle.subtitleSyncErrorAverageMs,
    syncResidualMs: m.subtitle.residualOffsetMs,
    whisperErrorMs: v.onsetRefinement?.whisperOnsetErrorAvgMs ?? null,
    subjectSafety: m.subject.subjectSafetyRatio, twoPersonPreserved: m.subject.twoPersonPreservedRatio,
    informationPreserved: m.subject.informationPreservedRatio,
    zoomCount: v.zoomCount, zoomVisible: m.zoom.map((item) => item.zoomVisible),
    backgroundApplied: m.background.backgroundApplied,
    preset: v.grading.colorPreset, gradingApplied: v.grading.gradingApplied,
    exposure: v.grading.exposureAdjustment, gradingDelta: v.grading.measuredDelta,
    gradingDirection: v.grading.directionMatched,
    musicRendered: v.music.musicRendered, speechToMusicDb: v.music.speechToMusicDb,
    renderMs: Date.now() - started
  };
}

function expectations(name, expect, r) {
  const fail = (message) => { throw new Error(`${name}: ${message}`); };
  if (r.status === 'FAILED') fail('quality gate failed');
  if (!r.hookRendered || !r.hookInsideSafeZone) fail('hook not verified in render');
  if ((r.subtitleRendered ?? 0) < .8) fail('subtitles not verified in render');
  if (expect.layouts && JSON.stringify(r.layouts) !== JSON.stringify(expect.layouts))
    fail(`layouts ${JSON.stringify(r.layouts)}`);
  if (expect.leadInRemoved != null && r.leadInRemoved !== expect.leadInRemoved) fail('lead-in decision');
  if (expect.twoPersonPreserved && r.twoPersonPreserved !== 1) fail('two-person not preserved');
  if (expect.informationPreserved && r.informationPreserved !== 1) fail('information not preserved');
  if (expect.zoomCount != null && r.zoomCount !== expect.zoomCount) fail(`zoomCount ${r.zoomCount}`);
  if (expect.zoomCountMin != null && r.zoomCount < expect.zoomCountMin) fail(`zoomCount ${r.zoomCount}`);
  if (expect.shotReframes != null && r.shotReframes < expect.shotReframes) fail('no shot-change reframe');
  if (expect.exposureUp && !(r.exposure > 0)) fail('dark source not brightened');
  if (expect.preset && r.preset !== expect.preset) fail(`preset ${r.preset}`);
  if (expect.syncAverageMaxMs != null && !(r.syncMeasurement === 'AUDIO_ONSET' && r.syncAverageMs <= expect.syncAverageMaxMs))
    fail(`sync ${r.syncMeasurement} ${r.syncAverageMs}`);
  if (expect.deadAirAtEndMaxMs != null && r.deadAirAtEndMs > expect.deadAirAtEndMaxMs) fail('dead air at end');
  if (r.musicRendered === false || (r.speechToMusicDb != null && r.speechToMusicDb < 10)) fail('music/speech balance');
}

// Regression: booleans/layouts must match; numeric quality may not get meaningfully worse.
function compare(name, base, r) {
  const problems = [];
  for (const key of ['status', 'layouts', 'shotClasses', 'leadInRemoved', 'hookRendered', 'backgroundApplied',
    'preset', 'zoomCount']) {
    if (JSON.stringify(base[key]) !== JSON.stringify(r[key]) && !(key === 'status' && r.status === 'PASSED'))
      problems.push(`${key}: ${JSON.stringify(base[key])} -> ${JSON.stringify(r[key])}`);
  }
  const worse = (key, tolerance, higherIsBetter = true) => {
    if (base[key] == null || r[key] == null) return;
    const delta = higherIsBetter ? base[key] - r[key] : r[key] - base[key];
    if (delta > tolerance) problems.push(`${key}: ${base[key]} -> ${r[key]}`);
  };
  worse('subjectSafety', .05); worse('subtitleRendered', .1); worse('animationVisible', .25);
  worse('syncAverageMs', 30, false); worse('hookFontSize', 12); worse('speechToMusicDb', 4);
  return problems.map((problem) => `${name}: ${problem}`);
}

async function main() {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error?.code === 'ENOENT') {
    console.log('SKIP editing benchmark: FFmpeg is unavailable.');
    return;
  }
  if (!process.env.EDIT_MUSIC_DIR) {
    const musicDir = join(tmpdir(), 'ai-content-benchmark-music');
    if (!existsSync(join(musicDir, 'library.json')))
      execFileSync('node', [join(__dirname, 'generate-music-library.cjs'), musicDir], { stdio: 'ignore' });
    process.env.EDIT_MUSIC_DIR = musicDir;
  }
  const directory = mkdtempSync(join(tmpdir(), 'editing-benchmark-'));
  const results = {};
  const failures = [];
  try {
    for (const scenario of SCENARIOS.filter((item) => !only || item.name === only)) {
      try {
        const result = await runScenario(scenario, directory);
        results[scenario.name] = result;
        expectations(scenario.name, scenario.expect, result);
        console.log(`ok   ${scenario.name} ${result.status} attempts=${result.renderAttempts} ` +
          `edited=${result.editedDuration}s sync=${result.syncMeasurement}:${result.syncAverageMs}ms ` +
          `layouts=${result.layouts.join('|')} zooms=${result.zoomCount} repairs=${result.repairs.join('|') || '-'}`);
      } catch (error) {
        failures.push(error.message);
        console.error(`FAIL ${scenario.name}: ${error.message}`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  if (update) {
    mkdirSync(join(__dirname, 'fixtures'), { recursive: true });
    const previous = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
    writeFileSync(BASELINE, JSON.stringify({ ...previous, ...results }, null, 2) + '\n');
    console.log(`Baseline written: ${BASELINE}`);
  } else if (existsSync(BASELINE)) {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
    for (const [name, result] of Object.entries(results))
      if (baseline[name]) failures.push(...compare(name, baseline[name], result));
  }
  console.log(JSON.stringify(results, null, 1));
  if (failures.length) {
    console.error(`Editing benchmark regressions/failures:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  } else console.log(`Editing benchmark passed (${Object.keys(results).length} scenarios).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
