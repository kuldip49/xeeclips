const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { VideoEditExecutorService } = require('../dist/modules/editing/video-edit-executor.service');
const { SubtitleRendererService } = require('../dist/modules/editing/subtitle-renderer.service');
const { ReframeService } = require('../dist/modules/editing/reframe.service');

const root = resolve(__dirname, '../../..');
const sourceDir = join(root, '.real-qa-preview');
const outputDir = join(sourceDir, 'final-camera-cleanup');
const baseSource = join(sourceDir, 'clean-selected.mp4');
const longSource = join(outputDir, 'real-talking-head-40s.mp4');
const output = join(outputDir, 'real-talking-head-40s-edited.mp4');

function contactSheet(video, outputPath, times, columns) {
  const expression = times.map((time) => `between(t\\,${Math.max(0, time - .017).toFixed(3)}\\,${(time + .017).toFixed(3)})`).join('+');
  const rows = Math.ceil(times.length / columns);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf',
    `select=${expression},scale=270:480,tile=${columns}x${rows}:padding=4:margin=4`, '-frames:v', '1', outputPath]);
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-stream_loop', '1', '-i', baseSource,
    '-t', '40', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', longSource]);
  const baseWords = JSON.parse(readFileSync(join(sourceDir, 'words-clean.json'), 'utf8'))
    .filter((word) => word.end > word.start && word.start < 20);
  const words = [0, 20].flatMap((offset) => baseWords.map((word) => ({
    start: word.start + offset, end: word.end + offset, text: word.text,
    audioEnergyScore: 0.35 })));
  const targetTimes = [3, 10, 17, 24, 31, 37];
  const peaks = targetTimes.map((time) => [...words].sort((a, b) =>
    Math.abs(a.start - time) - Math.abs(b.start - time))[0]);
  for (const peak of peaks) peak.audioEnergyScore = .9;

  const plan = fallbackEditPlan(0, 40, '9:16');
  plan.platformPreset = 'INSTAGRAM_REELS';
  plan.videoTemplate = 'EDITORIAL_FRAME';
  plan.recommendedTemplate = 'EDITORIAL_FRAME';
  plan.backgroundMode = 'SOURCE_MATCH_GRADIENT';
  plan.gradePreset = 'NO_CHANGE';
  plan.onScreenHook = { enabled: true, text: 'Why Smart Investors Stop Buying Government Bonds',
    startSec: 0, endSec: 3, position: 'TOP', style: 'TOP_HEADLINE' };
  plan.subtitleStyle = { ...plan.subtitleStyle, template: 'BOLD', maxWordsPerLine: 4,
    animationStyle: 'PUNCH' };
  plan.subtitleEmphasis = peaks.map((word) => ({ word: word.text, startSec: word.start,
    endSec: word.end, strength: 'STRONG' }));
  plan.operations = [];

  const faceTracks = Array.from({ length: 81 }, (_, index) => ({ timestamp: index * .5,
    x: .43, y: .08, w: .16, h: .33, confidence: .92, mouthActivity: .75,
    trackId: index < 40 ? 'speaker-a' : 'speaker-b' }));
  const frames = faceTracks.map((face) => ({ t: face.timestamp, faces: [face], persons: [],
    textBoxes: [], graphicBoxes: [], textCoverage: 0, ocrCoverage: 0, ocrLines: [] }));
  const analysis = { source: 'DENSE', frames, shotBoundaries: [20], ocrText: '' };
  const result = await new VideoEditExecutorService(new SubtitleRendererService(),
    new ReframeService()).execute(longSource, output, plan, words, faceTracks, [], [],
    { analysis, seed: 'final-camera-cleanup-real' });

  const zoomTimes = result.visual.zoomEvents.flatMap((event) => event.verificationFrameTimes);
  contactSheet(output, join(outputDir, 'zoom-events-contact-sheet.png'), zoomTimes, 5);
  contactSheet(output, join(outputDir, 'hard-cut-contact-sheet.png'),
    [19.9, 19.967, 20, 20.033, 20.1, 20.2], 6);
  writeFileSync(join(outputDir, 'final-telemetry.json'), JSON.stringify(result, null, 2));

  assert(result.visual.requiredZoomCount >= 5, `required ${result.visual.requiredZoomCount}`);
  assert(result.visual.semanticZoomCount >= result.visual.requiredZoomCount,
    `${result.visual.semanticZoomCount}/${result.visual.requiredZoomCount} rendered zooms`);
  assert(result.visual.actualRenderedZoomDeltas.every((delta) => delta == null || delta >= .12),
    JSON.stringify(result.visual.actualRenderedZoomDeltas));
  assert.equal(result.visual.hardCutTransitionClean, true);
  assert.equal(result.visual.cameraSettledAtEnd, true);
  console.log(JSON.stringify({ output, telemetry: join(outputDir, 'final-telemetry.json'),
    zoomContactSheet: join(outputDir, 'zoom-events-contact-sheet.png'),
    cutContactSheet: join(outputDir, 'hard-cut-contact-sheet.png'),
    eligibleEmphasisCount: result.visual.eligibleEmphasisCount,
    requiredZoomCount: result.visual.requiredZoomCount,
    semanticZoomCount: result.visual.semanticZoomCount,
    actualRenderedZoomDeltas: result.visual.actualRenderedZoomDeltas,
    hardCutTransitionClean: result.visual.hardCutTransitionClean,
    cameraSettledAtEnd: result.visual.cameraSettledAtEnd,
    quality: result.quality.status }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
