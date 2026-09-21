// Real eight-candidate throughput benchmark. Runs the production 1080x1920
// executor and full QA with the production bounded pool (concurrency = 2).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { VideoEditExecutorService } = require('../dist/modules/editing/video-edit-executor.service');
const { SubtitleRendererService } = require('../dist/modules/editing/subtitle-renderer.service');
const { ReframeService } = require('../dist/modules/editing/reframe.service');
const { EditQualityError } = require('../dist/modules/editing/edit-quality-gate');

const root = resolve(__dirname, '../../..');
const fixtureDir = join(root, '.real-qa-preview');
const referenceDir = join(fixtureDir, 'final-camera-cleanup');
const resultDir = join(fixtureDir, 'performance-benchmark');
const source = join(referenceDir, 'real-talking-head-40s.mp4');
const sourceWords = JSON.parse(readFileSync(join(fixtureDir, 'words-clean.json'), 'utf8'))
  .filter((word) => word.end > word.start && word.start < 20);
const words = [0, 20].flatMap((offset) => sourceWords.map((word) => ({
  start: word.start + offset, end: word.end + offset, text: word.text, audioEnergyScore: .35 })));
const faceTracks = Array.from({ length: 81 }, (_, index) => ({ timestamp: index * .5,
  x: .43, y: .08, w: .16, h: .33, confidence: .92, mouthActivity: .75,
  trackId: index < 40 ? 'speaker-a' : 'speaker-b' }));
const analysis = { source: 'DENSE', shotBoundaries: [20], ocrText: '', fallbackReason: '', runtimeMs: 0,
  frames: faceTracks.map((face) => ({ t: face.timestamp, faces: [face], persons: [],
    textBoxes: [], graphicBoxes: [], textCoverage: 0, ocrCoverage: 0, ocrLines: [] })) };
const smoke = process.argv.includes('--smoke');
const requestedClipCount = smoke ? 1 : 8;
// A real request has a ranked candidate pool larger than the requested count so
// a pre-render skip immediately backfills from the next candidate.
const candidates = Array.from({ length: smoke ? 1 : 14 }, (_, index) => {
  const start = index * .7;
  return [start, start + 30];
});

function contactSheet(inputPath, outputPath, duration) {
  const times = [0, 1, 3, duration / 2, Math.max(0, duration - 1)];
  const expression = times.map((time) => `eq(n\\,${Math.max(0, Math.round(time * 30))})`).join('+');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', inputPath, '-vf',
    `select=${expression},scale=216:384,tile=5x1:padding=4:margin=4`,
    '-frames:v', '1', outputPath]);
}

function ensureSource() {
  mkdirSync(referenceDir, { recursive: true });
  try { execFileSync('ffprobe', ['-v', 'error', source]); }
  catch {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '1',
      '-i', join(fixtureDir, 'clean-selected.mp4'), '-t', '40', '-c:v', 'libx264',
      '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', source]);
  }
}

async function renderCandidate(index, directory, batchStarted) {
  const candidateDirectory = join(directory, `candidate-${index}`);
  mkdirSync(candidateDirectory, { recursive: true });
  const [start, end] = candidates[index];
  const candidateWords = words.filter((word) => word.start >= start && word.end <= end)
    .map((word) => ({ ...word }));
  const peaks = [3, 8, 13, 18, 23, 28].map((offset) => [...candidateWords].sort((a, b) =>
    Math.abs(a.start - (start + offset)) - Math.abs(b.start - (start + offset)))[0]).filter(Boolean);
  for (const peak of peaks) peak.audioEnergyScore = .9;
  const plan = fallbackEditPlan(start, end, '9:16');
  Object.assign(plan, { platformPreset: 'INSTAGRAM_REELS', videoTemplate: 'EDITORIAL_FRAME',
    recommendedTemplate: 'EDITORIAL_FRAME', backgroundMode: 'SOURCE_MATCH_GRADIENT',
    gradePreset: 'NO_CHANGE', operations: [], onScreenHook: { enabled: true,
      text: 'Why Smart Investors Stop Buying Government Bonds', startSec: start, endSec: end,
      position: 'TOP', style: 'TOP_HEADLINE' }, subtitleEmphasis: peaks.map((word) => ({
      word: word.text, startSec: word.start, endSec: word.end, strength: 'STRONG' })) });
  const started = Date.now();
  const result = await new VideoEditExecutorService(new SubtitleRendererService(), new ReframeService())
    .execute(source, join(candidateDirectory, 'output.mp4'), plan, candidateWords,
      faceTracks, [], [], { analysis, seed: `throughput-${index}` });
  assert.notEqual(result.quality.status, 'FAILED');
  assert.equal(result.visual.hardCutTransitionClean, true);
  assert.equal(result.visual.cameraSettledAtEnd, true);
  const contactSheetPath = join(candidateDirectory, 'contact-sheet.png');
  contactSheet(join(candidateDirectory, 'output.mp4'), contactSheetPath, result.duration);
  return { index, startedMs: started - batchStarted, completedMs: Date.now() - batchStarted,
    candidateMs: Date.now() - started, fullRenderAttempts: result.quality.fullRenderAttempts,
    gradingRepairAttempts: result.quality.gradingRepairAttempts,
    gradingRepairRenderMs: result.quality.gradingRepairRenderMs,
    preRenderRepairCount: result.quality.preRenderRepairCount,
    wastedRenderMs: result.quality.wastedRenderMs,
    qaToolFailureCount: result.quality.qaToolFailureCount,
    qaNormalFrameCount: result.quality.qaNormalFrameCount,
    qaHardCutFrameCount: result.quality.qaHardCutFrameCount,
    qaDecodeBatchFrameLimit: result.quality.qaDecodeBatchFrameLimit,
    repairCount: result.quality.repairs.length, baseRenderMs: result.quality.baseRenderMs,
    qualityCheckMs: result.quality.qualityCheckMs, status: result.quality.status,
    outputPath: join(candidateDirectory, 'output.mp4'), contactSheetPath,
    hookPositionY: result.visual.hookBounds ? Math.round(
      result.visual.hookBounds.y + result.visual.hookBounds.height / 2) : null,
    hookVideoGapPx: result.visual.hookGapAboveVideoPx,
    hookBounds: result.visual.hookBounds,
    videoViewportBounds: result.visual.videoViewportBounds,
    nominalRequiredZoomCount: result.visual.nominalRequiredZoomCount,
    eligibleSafeZoomCount: result.visual.eligibleSafeZoomCount,
    effectiveRequiredZoomCount: result.visual.effectiveRequiredZoomCount,
    actualZoomCount: result.visual.zoomCount };
}

async function runBatch(concurrency, directory) {
  mkdirSync(directory, { recursive: true });
  const batchStarted = Date.now();
  let next = 0;
  const completed = [];
  const failures = [];
  let inFlight = 0;
  const worker = async () => {
    while (next < candidates.length) {
      if (completed.length + inFlight >= requestedClipCount) return;
      const index = next++;
      inFlight++;
      try { completed.push(await renderCandidate(index, directory, batchStarted)); }
      catch (error) {
        const report = error instanceof EditQualityError && error.report &&
          typeof error.report === 'object' ? error.report : {};
        failures.push({ index, completedMs: Date.now() - batchStarted,
          classification: report.preRenderClassification ?? 'FAILED',
          fullRenderAttempts: Number(report.fullRenderAttempts) || 0,
          gradingRepairAttempts: Number(report.gradingRepairAttempts) || 0,
          gradingRepairRenderMs: Number(report.gradingRepairRenderMs) || 0,
          preRenderRepairCount: Number(report.preRenderRepairCount) || 0,
          wastedRenderMs: Number(report.wastedRenderMs) || 0,
          sampling: report.measurements?.sampling ?? null,
          subtitleQa: report.measurements?.subtitle ?? null,
          reason: error instanceof Error ? error.message : String(error) });
      } finally { inFlight--; }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const ordered = [...completed].sort((a, b) => a.index - b.index);
  const byCompletion = [...completed].sort((a, b) => a.completedMs - b.completedMs);
  const all = [...completed, ...failures];
  return { concurrency, totalBatchMs: Date.now() - batchStarted,
    requestedClipCount, candidatePoolCount: candidates.length, deliveredCount: completed.length,
    failedCount: failures.filter((item) => item.classification !== 'SKIP_BEFORE_RENDER').length,
    skippedCount: failures.filter((item) => item.classification === 'SKIP_BEFORE_RENDER').length,
    timeToFirstClipMs: byCompletion[0]?.completedMs ?? null,
    timeToSecondClipMs: byCompletion[1]?.completedMs ?? null,
    timeToHalfRequestedMs: byCompletion[Math.ceil(requestedClipCount / 2) - 1]?.completedMs ?? null,
    timeToAllClipsMs: completed.length === requestedClipCount ?
      Math.max(...completed.map((item) => item.completedMs)) : null,
    fullRenderAttempts: all.reduce((sum, item) => sum + item.fullRenderAttempts, 0),
    gradingRepairAttempts: all.reduce((sum, item) => sum + item.gradingRepairAttempts, 0),
    gradingRepairRenderMs: all.reduce((sum, item) => sum + item.gradingRepairRenderMs, 0),
    preRenderRepairCount: all.reduce((sum, item) => sum + item.preRenderRepairCount, 0),
    wastedRenderMs: all.reduce((sum, item) => sum + item.wastedRenderMs, 0),
    qaToolFailureCount: all.reduce((sum, item) => sum + (item.qaToolFailureCount ?? 0), 0),
    maximumQaFrameCount: Math.max(0, ...completed.map((item) => item.qaNormalFrameCount ?? 0)),
    maximumQaDecodeBatchFrames: Math.max(0,
      ...completed.map((item) => item.qaDecodeBatchFrameLimit ?? 0)),
    repairs: completed.reduce((sum, item) => sum + item.repairCount, 0),
    candidates: ordered, failures };
}

async function main() {
  ensureSource();
  mkdirSync(resultDir, { recursive: true });
  process.env.AI_EDITED_RENDER_CONCURRENCY = '2';
  const after = await runBatch(2, join(resultDir, 'final-clips'));
  const result = { generatedAt: new Date().toISOString(), requestedClipCount,
    clipDurationSec: 30, renderConcurrency: 2,
    output: '1080x1920 H.264 with full production QA', after };
  writeFileSync(join(resultDir, 'final-performance-benchmark.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(after.deliveredCount, requestedClipCount,
    `delivered ${after.deliveredCount}/${requestedClipCount} clips from the candidate pool`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
