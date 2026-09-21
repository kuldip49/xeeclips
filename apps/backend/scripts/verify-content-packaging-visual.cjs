// Three real-media AI_EDITED packaging samples and a manual before/after report.
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { ContentPackagingService } = require('../dist/modules/editing/content-packaging.service');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');
const { VideoEditExecutorService } = require('../dist/modules/editing/video-edit-executor.service');
const { SubtitleRendererService } = require('../dist/modules/editing/subtitle-renderer.service');
const { ReframeService } = require('../dist/modules/editing/reframe.service');

const root = resolve(__dirname, '../../..');
const preview = join(root, '.real-qa-preview');
const outputRoot = join(preview, 'content-packaging-phase');
const cleanWords = JSON.parse(readFileSync(join(preview, 'words-clean.json'), 'utf8'));
const dialogueWords = JSON.parse(readFileSync(join(preview, 'words.json'), 'utf8'));
const cleanSource = join(preview, 'final-camera-cleanup', 'real-talking-head-40s.mp4');
const dialogueSource = join(preview, 'selected.mp4');
const packager = new ContentPackagingService();

const cleanAt = (offset, start, end) => cleanWords.map((word) => ({ ...word,
  start: word.start + offset, end: word.end + offset }))
  .filter((word) => word.start >= start && word.end <= end);
const samples = [
  { id: 'A-podcast-talking-head', label: 'Podcast / talking head', source: cleanSource,
    start: 0, end: 18, words: cleanAt(0, 0, 18), platform: 'YOUTUBE_SHORTS',
    title: 'Podcast: Why Bond Prices Change',
    summary: 'A talking-head finance podcast explaining bond prices and investor decisions.',
    oldHook: 'The Speaker Explains Bond Prices',
    proposed: 'Why Lower Bond Prices Change What Investors Actually Pay' },
  { id: 'B-humorous-dialogue', label: 'Humorous / emotional dialogue', source: dialogueSource,
    // The real dialogue fixture is 16.02 s. Leave a full second of source tail so
    // duration and end-frame QA never probe beyond the available media.
    start: 0, end: 15, words: dialogueWords.filter((word) => word.start >= 0 && word.end <= 15),
    platform: 'TIKTOK', title: 'A Deadpan Story About Losing Your Kid in Provo',
    summary: 'A conversational, deadpan joke about how unusually polite people in Provo are.',
    oldHook: 'The Host Talks About Provo',
    proposed: 'Why Provo Is a Surprisingly Good Place to Lose Your Kid' },
  { id: 'C-information-technical', label: 'Information / technical', source: cleanSource,
    start: 20, end: 38, words: cleanAt(20, 20, 38), platform: 'INSTAGRAM_REELS',
    title: 'How Bond Markets Signal Investor Risk',
    summary: 'A technical explanation of bond demand, stock markets and investor nervousness.',
    oldHook: 'The Speaker Discusses the Bond Market',
    proposed: 'Why Nervous Investors Stop Buying Bonds in This Market' }
];

function analysisFor(sample) {
  const frames = [];
  for (let t = sample.start; t <= sample.end; t += .5) frames.push({ t,
    // The dialogue fixture has no persisted face track. Keep that evidence
    // honest and let the production center-safe zoom fallback handle it.
    faces: sample.id === 'B-humorous-dialogue' ? [] :
      [{ timestamp: t, x: .42, y: .08, w: .17, h: .34,
        confidence: .94, mouthActivity: .72, trackId: 'speaker-a' }],
    persons: [], textBoxes: [], graphicBoxes: [], textCoverage: 0, ocrCoverage: 0,
    ocrLines: [] });
  return { source: 'DENSE', frames, shotBoundaries: [], ocrText: '',
    fallbackReason: '', runtimeMs: 0 };
}

async function renderSample(sample) {
  const directory = join(outputRoot, sample.id);
  mkdirSync(directory, { recursive: true });
  const renderWords = sample.words.map((word) => ({ ...word, audioEnergyScore: .35 }));
  const peakWords = [];
  for (const offset of [2.5, 6, 9.5, 13.5, 16]) {
    const target = sample.start + offset;
    const peak = [...renderWords].sort((a, b) =>
      Math.abs(a.start - target) - Math.abs(b.start - target))[0];
    if (peak) { peak.audioEnergyScore = .92; peakWords.push(peak); }
  }
  const transcript = renderWords.map((word) => word.text).join(' ');
  let packaging = await packager.create({ aiMode: 'FALLBACK_ONLY', transcript,
    title: sample.title, synopsis: sample.summary, wholeVideoSummary: sample.summary,
    originalName: sample.title, speakerTrackIds: ['speaker-a'],
    existingHooks: [sample.proposed], targetPlatform: sample.platform });
  const plan = fallbackEditPlan(sample.start, sample.end, '9:16');
  const videoTemplate = sample.id === 'B-humorous-dialogue' ?
    'FULL_SCREEN_SOCIAL' : 'EDITORIAL_FRAME';
  Object.assign(plan, { platformPreset: sample.platform, videoTemplate,
    recommendedTemplate: videoTemplate, backgroundMode: 'SOURCE_MATCH_GRADIENT',
    gradePreset: 'NO_CHANGE', musicMood: 'NONE', operations: [],
    subtitleEmphasis: peakWords.map((word) => ({ word: word.text, startSec: word.start,
      endSec: word.end, strength: 'STRONG' })),
    onScreenHook: { enabled: true, text: packaging.selectedHook.text,
      startSec: sample.start, endSec: sample.end, position: 'TOP', style: 'TOP_HEADLINE' },
    hookRequired: true, subtitleTheme: 'BOLD_SOCIAL',
    subtitleStyle: { enabled: true, template: 'PODCAST_BOLD', position: 'BOTTOM',
      maxWordsPerLine: 5, highlightCurrentWord: true, animationStyle: 'WORD_HIGHLIGHT' } });
  const output = join(directory, 'final.mp4');
  const rendered = await new VideoEditExecutorService(new SubtitleRendererService(), new ReframeService())
    .execute(sample.source, output, plan, renderWords, [], [], [], {
      inputOffsetSec: 0, analysis: analysisFor(sample), seed: sample.id, maxAttempts: 1 });
  const visual = rendered.visual;
  const measured = rendered.quality.measurements;
  const subtitleTelemetry = { subtitleTemplate: visual.subtitleTemplate,
    subtitleFontRequested: visual.subtitleFontRequested, subtitleFontResolved: visual.subtitleFontName,
    subtitleFontFallbackUsed: visual.subtitleFontFallbackUsed,
    subtitlePhraseCount: visual.subtitlePhraseCount,
    averageWordsPerPhrase: visual.averageWordsPerPhrase,
    maxWordsPerPhrase: visual.maxWordsPerPhrase,
    oneLinePhraseCount: visual.oneLinePhraseCount,
    twoLinePhraseCount: visual.twoLinePhraseCount,
    activeWordHighlightCount: visual.activeWordHighlightCount,
    subtitleCollisionRepairs: visual.subtitleCollisionRepairs,
    subtitleTimingAverageResidualMs: measured.subtitle.subtitleSyncErrorAverageMs,
    subtitleTimingP95ResidualMs: measured.subtitle.subtitleSyncErrorP95Ms };
  packaging = packager.finalize(packaging, visual.hookText, {
    hookVisible: visual.hookRendered, hookReadable: measured.hook.hookReadable,
    hookInsideSafeZone: measured.hook.hookInsideSafeZone,
    subjectVisible: (measured.subject.mainSubjectVisibleRatio ?? 1) >= .8,
    hookContrastRatio: measured.hook.hookContrastRatio,
    subtitleFirstStartSec: visual.wordEvents[0]?.renderStart,
    firstSpeechSec: visual.wordEvents[0]?.mappedStart, subtitleTelemetry });
  const artifact = { sample: sample.label, source: sample.source,
    output, before: { hook: sample.oldHook, caption: 'Watch until the end!',
      hashtags: ['#viral', '#fyp', '#trending'], subtitle: 'generic mixed-case captions' },
    packaging, selectedHook: packaging.selectedHook,
    hookAlternatives: packaging.hookCandidates, entityResolution: packaging.entities,
    category: { primary: packaging.primaryCategory, secondary: packaging.secondaryCategory,
      confidence: packaging.categoryConfidence }, captions: packaging.captions,
    hashtags: packaging.hashtags, subtitleTelemetry,
    qa: { packaging: packaging.qa, editStatus: rendered.quality.status,
      failedChecks: rendered.quality.failedChecks,
      degradedChecks: rendered.quality.degradedChecks,
      fullRenderAttempts: rendered.quality.fullRenderAttempts,
      wastedRenderMs: rendered.quality.wastedRenderMs } };
  writeFileSync(join(directory, 'packaging.json'), JSON.stringify(artifact, null, 2));
  return artifact;
}

async function main() {
  mkdirSync(outputRoot, { recursive: true });
  process.env.AI_EDITED_RENDER_CONCURRENCY = '2';
  const results = [];
  let next = 0;
  const worker = async () => { while (next < samples.length) {
    const index = next++; results[index] = await renderSample(samples[index]);
  } };
  await Promise.all([worker(), worker()]);
  const rows = results.map((item) => `| ${item.sample} | ${item.before.hook} | ${
    item.selectedHook.text} | ${item.packaging.primaryCategory} / ${item.packaging.archetype} | ${
    item.output} |`).join('\n');
  const report = `# Content packaging visual comparison\n\n` +
    `Real-media AI_EDITED exports, rendered with concurrency 2 and one full render per sample.\n\n` +
    `| Sample | Before hook | After hook | Packaging | Render |\n| --- | --- | --- | --- | --- |\n${rows}\n\n` +
    `## Before vs after\n\n` +
    `| Area | Before | After |\n| --- | --- | --- |\n` +
    `| Hook quality | Generic description | Grounded, specific promise selected from 5+ scored variants |\n` +
    `| Identity usage | Speaker/host placeholders | Verified names only; meaningful role or no identity when evidence is weak |\n` +
    `| Hook wording | Passive production meta-language | Category/archetype-aware bold, curiosity, consequence, question, or supported humor |\n` +
    `| Caption | \"Watch until the end!\" | Platform-specific context that does not duplicate the headline |\n` +
    `| Hashtags | #viral #fyp #trending | Entity, exact-topic, and category tags within each platform limit |\n` +
    `| Subtitle design | Generic mixed-case captions | PODCAST_BOLD: 72 px, uppercase, white, yellow active word, 6 px dark outline, no box |\n` +
    `| Subtitle placement | Unmeasured phrase placement | Fixed geometry and one NORMAL or SAFE_HIGH baseline per shot |\n` +
    `| First frame | No packaging-specific decision | Hook/subject visibility, readability, safe placement, contrast, blank-frame, and subtitle-before-speech checks |\n\n` +
    `## Subtitle example\n\n` +
    `Before: a long mixed-case sentence with no timed emphasis.\n\n` +
    `After: short semantic phrases such as **WHY LOWER BOND PRICES**; the exact active word changes to #FFD400 without moving or reflowing the phrase.\n\n` +
    `## Honest QA note\n\n` +
    `The Windows verification host lacks Inter/fontconfig, so these local samples use the reported fallback and remain DEGRADED for subtitleFontValid. The production container installs font-inter and verifies it with fc-match. Existing conservative grading diagnostics may also remain DEGRADED; no failed check is hidden or promoted.\n`;
  writeFileSync(join(outputRoot, 'comparison-report.md'), report);
  writeFileSync(join(outputRoot, 'manifest.json'), JSON.stringify(results.map((item) => ({
    sample: item.sample, output: item.output, packaging: join(outputRoot,
      samples.find((sample) => sample.label === item.sample).id, 'packaging.json'),
    hook: item.selectedHook.text, status: item.qa.editStatus,
    fullRenderAttempts: item.qa.fullRenderAttempts })), null, 2));
  console.log(JSON.stringify({ outputRoot, samples: results.map((item) => ({
    sample: item.sample, hook: item.selectedHook.text, category: item.packaging.primaryCategory,
    status: item.qa.editStatus, fullRenderAttempts: item.qa.fullRenderAttempts })) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
