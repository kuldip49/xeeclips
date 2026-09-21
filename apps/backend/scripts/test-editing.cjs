const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parseProcessingType, parseOutputAspectRatio } =
  require('../dist/modules/processing/processing-type');
const { EDIT_PLAN_SCHEMA, fallbackEditPlan } =
  require('../dist/modules/editing/edit-plan');
const { EditingPlanValidator } =
  require('../dist/modules/editing/editing-plan-validator');
const { EditPlanService } = require('../dist/modules/editing/edit-plan.service');
const { SubtitleRendererService, PODCAST_BOLD_STYLE, editedTime } =
  require('../dist/modules/editing/subtitle-renderer.service');
const { ReframeService, OUTPUT_DIMENSIONS, CAMERA_TUNING } =
  require('../dist/modules/editing/reframe.service');
const { buildZoomExpression, buildZoomEvents, ambientBackgroundFilter } =
  require('../dist/modules/editing/video-edit-executor.service');
const { ZOOM_TUNING } = require('../dist/modules/editing/zoom-planner');
const { paletteTrackFilter, tintAt } = require('../dist/modules/editing/source-palette');
const { sourceToViewport, viewportToCanvas, sourceToCanvas } =
  require('../dist/modules/editing/composition-coordinates');
const { forceLandscapeEditorialFrame } =
  require('../dist/modules/videos/clip-export.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { createPerformanceTelemetry } = require('../dist/modules/processing/performance-telemetry');
const { VideosService } = require('../dist/modules/videos/videos.service');
const { buildSubtitlePhrases } = require('../dist/modules/editing/subtitle-phrases');
const { createTimelineMapper } = require('../dist/modules/editing/timeline-remap');
const { SUBTITLE_THEMES, PLATFORM_SAFE_ZONES } =
  require('../dist/modules/editing/visual-style-tokens');
const { sanitizeSubtitleText, escapeAssText } =
  require('../dist/modules/editing/subtitle-text');
const { PLATFORM_LAYOUT_PRESETS, HOOK_PLACEMENT, validatePlatformLayout } =
  require('../dist/modules/editing/platform-layout');
const { HOOK_ACCENT_FAMILY_COLORS, hookAccentFamily, hookAccentCandidates } =
  require('../dist/modules/editing/hook-accent');

async function main() {
  assert.equal(parseProcessingType(undefined), 'NORMAL_CLIPS');
  assert.equal(parseProcessingType('EDITED_CLIPS'), 'EDITED_CLIPS');
  assert.throws(() => parseProcessingType('AUTO'));
  assert.equal(parseOutputAspectRatio(undefined), '9:16');
  assert.throws(() => parseOutputAspectRatio('3:2'));
  const normalTelemetry = createPerformanceTelemetry('ONLINE', 'NORMAL_CLIPS');
  assert.equal(normalTelemetry.editingRequested, false);
  assert.equal(normalTelemetry.editingExecuted, false);
  assert.equal(normalTelemetry.outputAspectRatio, 'SOURCE');
  assert.deepEqual(normalTelemetry.llmRequestCountByRole, {});
  const uploads = [];
  const queueJobs = [];
  const prisma = {
    project: { findUnique: async () => ({ id: 'project' }) },
    video: { create: async ({ data }) => {
      uploads.push(data);
      return { id: `video-${uploads.length}`, sizeBytes: 100n,
        processingJobs: [{ id: `job-${uploads.length}` }] };
    } }
  };
  const storage = { uploadVideo: async () => ({ bucket: 'source', objectKey: 'source.mp4' }) };
  const queue = { enqueue: async (data) => { queueJobs.push(data); } };
  const videos = new VideosService(prisma, storage, queue, {});
  const file = { buffer: Buffer.from('fixture'), originalname: 'source.mp4',
    mimetype: 'video/mp4', size: 100 };
  await videos.createFromUpload('project', file, 'ONLINE');
  await videos.createFromUpload('project', file, 'ONLINE', 'EDITED_CLIPS', '4:5');
  assert.equal(uploads[0].processingJobs.create.processingType, 'NORMAL_CLIPS');
  assert.equal(uploads[0].processingJobs.create.outputAspectRatio, null);
  assert.equal(uploads[1].processingJobs.create.processingType, 'EDITED_CLIPS');
  assert.equal(uploads[1].processingJobs.create.outputAspectRatio, '4:5');
  assert.equal(queueJobs.length, 2);
  assert.equal(EDIT_PLAN_SCHEMA.additionalProperties, false);
  assert(EDIT_PLAN_SCHEMA.required.includes('operations'));
  assert(EDIT_PLAN_SCHEMA.required.includes('subtitleEmphasis'));
  assert.equal(Object.keys(SUBTITLE_THEMES).length, 5);
  assert(PLATFORM_SAFE_ZONES.UNIVERSAL.bottom < .8);
  assert.equal(sanitizeSubtitleText('“Price”\u00a0—\u00a0now\u2026\uFFFD'), '"Price" - now…');
  assert.equal(escapeAssText('100% {safe}\\path'), '100% ｛safe｝＼path');
  // The hook now sits low in the header: safe top padding above it, a clear gap
  // to the video below it.
  const reelsHook = validatePlatformLayout(PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS,
    { x: 120, y: 90, width: 840, height: 230 },
    PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.subtitleZone, null);
  assert.equal(reelsHook.platformLayoutSafe, true);
  assert.equal(reelsHook.hookNotTooHigh, true);
  assert.equal(reelsHook.hookGapAboveVideoValid, true);
  assert.equal(reelsHook.hookPositionValid, true);
  assert(reelsHook.hookGapAboveVideoPx >= HOOK_PLACEMENT.minGapAboveVideo);
  // A hook pinned near the top edge is now a layout violation.
  const highHook = validatePlatformLayout(PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS,
    { x: 120, y: 20, width: 840, height: 180 },
    PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.subtitleZone, null);
  assert.equal(highHook.hookNotTooHigh, false);
  assert(highHook.violations.includes('HOOK_TOO_HIGH'));
  assert.equal(PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.hookZone.y, 64);
  assert(PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.hookGapAboveVideo >= HOOK_PLACEMENT.minGapAboveVideo);
  // Accent picking: deterministic, at most two words, never the whole headline.
  const accents = hookAccentCandidates('THE REAL REASON 90% OF STARTUPS FAIL', []);
  assert(accents.length >= 1 && accents.length <= 2);
  assert(accents.every((accent) => accent.index >= 0));
  assert.deepEqual(accents, hookAccentCandidates('THE REAL REASON 90% OF STARTUPS FAIL', []));
  // Function words are never accented.
  assert(!accents.some((accent) => ['THE', 'OF'].includes(accent.word)));
  assert.equal(hookAccentCandidates('The of a an', []).length, 0);
  assert.deepEqual(PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.headerBounds,
    { x: 0, y: 0, width: 1080, height: 340 });
  assert.deepEqual(PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.videoViewport,
    { x: 0, y: 360, width: 1080, height: 1180 });
  assert.deepEqual(PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.footerBounds,
    { x: 0, y: 1540, width: 1080, height: 380 });
  const sourceRect = { x: .4, y: .2, width: .2, height: .3 };
  const sourceCrop = { x: .25, y: 0, width: .5, height: 1 };
  const viewport = PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.videoViewport;
  assert.deepEqual(sourceToViewport(sourceRect, sourceCrop, viewport),
    { x: 324.00000000000006, y: 236, width: 432, height: 354 });
  assert.deepEqual(viewportToCanvas({ x: 324, y: 236, width: 432, height: 354 }, viewport),
    { x: 324, y: 596, width: 432, height: 354 });
  assert.equal(sourceToCanvas(sourceRect, sourceCrop, viewport).y, 596);
  // Scene palettes cross-fade at scene changes; too-short scenes do not get their own fade.
  const tint = paletteTrackFilter([{ start: 0, colors: ['#243044', '#4A3020'] },
    { start: 4, colors: ['#402818', '#302010'] }, { start: 4.3, colors: ['#101010', '#101010'] }], 10, 30, 'tint');
  assert.deepEqual(tint.boundaries, [4]);
  assert(tint.graph.some((part) => part.includes('xfade=transition=fade:duration=0.4000:offset=3.8000[tint]')));
  assert.deepEqual(tintAt(tint, 1, 0), [0x24, 0x30, 0x44]);
  assert.deepEqual(tintAt(tint, 4, 0).map(Math.round), [50, 44, 46]);
  assert.deepEqual(tintAt(tint, 5, 1), [0x30, 0x20, 0x10]);
  assert(ambientBackgroundFilter('vbgsrc', 'tint', 'vbg', { width: 1080, height: 1920 })
    .join(';').includes('blend=all_mode=average'));

  const validator = new EditingPlanValidator();
  const words = [
    { start: 10, end: 10.4, text: 'A' },
    { start: 10.5, end: 11, text: 'strong' },
    { start: 11.1, end: 11.5, text: 'opening' },
    { start: 12.5, end: 13, text: 'matters' }
  ];
  const plan = fallbackEditPlan(10, 30, '9:16');
  plan.onScreenHook = { enabled: true, text: 'Why This Opening Matters For Anyone Watching',
    startSec: 10, endSec: 12.5, position: 'TOP', style: 'CLEAN' };
  plan.subtitleEmphasis = [
    { word: 'strong', startSec: 10.5, endSec: 11, strength: 'MEDIUM' },
    { word: 'A', startSec: 10, endSec: 10.4, strength: 'STRONG' }
  ];
  plan.operations = [
    { type: 'REMOVE_SILENCE', startSec: 11.6, endSec: 12.3,
      reason: 'pause', scale: null, focusX: null, focusY: null, target: null, words: [] },
    { type: 'TRIM', startSec: 10.1, endSec: 10.3,
      reason: 'unsafe speech cut', scale: null, focusX: null, focusY: null, target: null, words: [] },
    { type: 'ZOOM', startSec: 12.35, endSec: 14.5, reason: 'emphasis',
      triggerText: 'matters', scale: 1.14, focusX: .5, focusY: .5, target: null, words: [] },
    { type: 'ZOOM', startSec: 16, endSec: 17, reason: 'too strong',
      scale: 1.5, focusX: .5, focusY: .5, target: null, words: [] }
  ];
  const forcedPlan = forceLandscapeEditorialFrame({ ...plan,
    platformPreset: 'UNIVERSAL', videoTemplate: 'FULL_SCREEN_SOCIAL' }, 1920, 1080);
  assert.equal(forcedPlan.platformPreset, 'INSTAGRAM_REELS');
  assert.equal(forcedPlan.videoTemplate, 'EDITORIAL_FRAME');
  assert.equal(forcedPlan.backgroundMode, 'SOURCE_MATCH_GRADIENT');
  assert.equal(forcedPlan.onScreenHook.startSec, 10);
  assert.equal(forcedPlan.onScreenHook.endSec, 30);
  const checked = validator.validate(plan, 10, 30, '9:16', words);
  assert.equal(checked.fallback, false);
  assert.deepEqual(checked.plan.operations.map((op) => op.type), ['REMOVE_SILENCE', 'ZOOM']);
  assert(checked.warnings.includes('UNSAFE_CUT_REMOVED'));
  assert.deepEqual(checked.plan.subtitleEmphasis.map((item) => item.word), ['strong']);
  assert.equal(validator.validate({ ...plan, onScreenHook: {
    ...plan.onScreenHook, text: 'This Changes Everything'
  } }, 10, 30, '9:16', words, 'This changes everything').plan.onScreenHook.enabled, false);
  // 1.23 is now inside the visible NORMAL band (1.18-1.24).
  assert.equal(validator.validate({ ...plan, operations: [{ ...plan.operations[2], scale: 1.23 }] },
    10, 30, '9:16', words).plan.operations.length, 1);
  const crossingZoom = validator.validate({ ...plan, operations: [
    { ...plan.operations[2], startSec: 14, endSec: 16 },
    { ...plan.operations[0], startSec: 15, endSec: 15.5 }
  ] }, 10, 30, '9:16', words);
  assert.equal(crossingZoom.plan.operations.some((operation) => operation.type === 'ZOOM'), false);
  assert.equal(validator.validate({ ...plan, clipEndSec: 50 }, 10, 30, '9:16', words).fallback, true);
  assert(Math.abs(editedTime(13, 10, [{ start: 11.6, end: 12.3 }]) - 2.3) < 1e-8);
  const mapper = createTimelineMapper(10, [{ start: 11.6, end: 12.3 }]);
  assert.equal(mapper.removed(11.8, 12), true);
  assert(Math.abs(mapper.range(12.5, 13).start - 1.8) < 1e-8);
  const phrases = buildSubtitlePhrases([
    { start: 0, end: .2, text: 'This' }, { start: .2, end: .4, text: 'is' },
    { start: .4, end: .6, text: 'the' }, { start: .6, end: .8, text: 'most' },
    { start: .8, end: 1, text: 'important' }, { start: 1, end: 1.2, text: 'thing' }
  ], 5);
  assert(phrases.every((phrase) => phrase.lines.length <= 2));
  assert(phrases.some((phrase) => phrase.words.some((word) => word.text === 'important') &&
    phrase.words.some((word) => word.text === 'thing')));

  let llmCalls = 0;
  const router = { generate: async () => {
    llmCalls++;
    return { data: plan, metadata: { provider: 'openai', model: 'gpt-5.6-luna' } };
  } };
  const service = new EditPlanService(router, validator);
  const context = { start: 10, end: 30, aspectRatio: '9:16',
    transcript: 'A strong opening matters', words, title: 'Opening', synopsis: '',
    wholeVideoSummary: '', visualEvidence: {}, clipUnderstanding: {} };
  assert.equal((await service.create({ ...context, aiMode: 'OFFLINE' })).source,
    'DETERMINISTIC_FALLBACK');
  assert.equal((await service.create({ ...context, aiMode: 'FALLBACK_ONLY' })).source,
    'DETERMINISTIC_FALLBACK');
  assert.equal(llmCalls, 0);
  assert.equal((await service.create({ ...context, aiMode: 'ONLINE' })).source, 'LUNA');
  // Two Luna calls now: the edit plan, then the headline candidate set to score.
  assert.equal(llmCalls, 2);

  // A rejected in-plan hook is replaced by the best scored candidate.
  let repairCalls = 0;
  const repairService = new EditPlanService({ generate: async () => {
    repairCalls++;
    return { data: repairCalls === 1 ? { ...plan, onScreenHook: {
      ...plan.onScreenHook, text: 'This Changes Everything' } } :
      { hookCuriosity: 'Why A Strong Opening Matters More Than Anything',
        hookTension: 'This Changes Everything About How A Strong Opening Works',
        hookDirect: 'and the opening', hookEmotion: '', hookHumor: '', hookInsight: '' },
    metadata: { provider: 'openai', model: 'gpt-5.6-luna' } };
  } }, validator);
  const repaired = await repairService.create({ ...context, aiMode: 'ONLINE' });
  assert.equal(repairCalls, 2);
  assert.equal(repaired.hookValidationFailureReason, 'GENERIC_HOOK');
  assert.equal(repaired.hookRepairAttempted, true);
  assert.equal(repaired.hookRepairSucceeded, true);
  assert.equal(repaired.hookFinalText, 'Why A Strong Opening Matters More Than Anything');
  assert(repaired.hookWordCount >= 7, 'a headline is a complete thought, not a fragment');
  assert.equal(repaired.hookSource, 'LUNA_CANDIDATE');
  // Clickbait and fragments are rejected rather than chosen.
  const rejections = repaired.hookCandidates.filter((item) => item.rejected)
    .map((item) => item.rejected);
  assert(rejections.includes('FABRICATED_CLICKBAIT'), rejections.join(','));

  // Luna unavailable: the headline is mandatory, so a deterministic one appears.
  const failing = new EditPlanService({ generate: async () => {
    throw new Error('synthetic outage');
  } }, validator);
  const failedPlan = await failing.create({ ...context, aiMode: 'ONLINE' });
  assert.equal(failedPlan.source, 'DETERMINISTIC_FALLBACK');
  assert.equal(failedPlan.plan.operations.length, 0);
  assert.equal(failedPlan.plan.hookRequired, true);
  assert.equal(failedPlan.plan.onScreenHook.enabled, true, 'a hook is never optional for AI_EDITED');
  assert(failedPlan.hookFinalText.trim(), 'the deterministic hook must have text');
  assert(['DETERMINISTIC', 'TITLE_LAST_RESORT'].includes(failedPlan.hookSource), failedPlan.hookSource);
  // Offline modes reach the same guarantee without calling a model at all.
  const offline = await service.create({ ...context, aiMode: 'OFFLINE' });
  assert.equal(offline.plan.onScreenHook.enabled, true);
  assert(offline.hookFinalText.trim());
  const routes = new LlmRouterService();
  assert.deepEqual(routes.routesFor('editingPlan', 'OFFLINE'), []);
  assert.deepEqual(routes.routesFor('editingPlan', 'FALLBACK_ONLY'), []);
  assert(routes.routesFor('editingPlan', 'ONLINE').every((route) =>
    route.provider === 'openai' && route.model === 'gpt-5.6-luna'));

  const directory = await mkdtemp(join(tmpdir(), 'editing-test-'));
  try {
    const path = join(directory, 'edit.ass');
    const subtitleStats = await new SubtitleRendererService().write(path, checked.plan, words,
      [{ start: 11.6, end: 12.3 }], 1080, 1920);
    assert.equal(subtitleStats.highlightedWordCount, 1);
    assert.equal(subtitleStats.subtitleTheme, 'BOLD_SOCIAL');
    assert(subtitleStats.subtitlePhraseCount >= 2);
    const ass = await readFile(path, 'utf8');
    assert.equal(subtitleStats.hookLines.join(' '), 'Why This Opening Matters For Anyone Watching');
    // The headline keeps its exact wording; one or two strong words are wrapped
    // in an accent colour, so the raw line no longer appears verbatim.
    for (const word of 'Why This Opening Matters For Anyone Watching'.split(' ')) assert(ass.includes(word));
    assert(subtitleStats.hookAccentWordCount >= 1 && subtitleStats.hookAccentWordCount <= 2);
    assert(subtitleStats.hookAccentWordCount < subtitleStats.hookWordCount);
    assert(subtitleStats.hookAccentWords.every((word) =>
      'Why This Opening Matters For Anyone Watching'.split(' ').includes(word)));
    // One accent family per headline, and every accent word uses that one colour.
    assert.equal(subtitleStats.hookAccentColorSingleFamily, true);
    assert(ass.includes(HOOK_ACCENT_FAMILY_COLORS[subtitleStats.hookAccentFamily]));
    assert.equal(subtitleStats.hookAccentFamily, hookAccentFamily('Why This Opening Matters For Anyone Watching'));
    // The headline sits on a white plate in dark charcoal, not white on video.
    assert.equal(subtitleStats.hookBackgroundRendered, true);
    assert(ass.includes('Style: HookPlate'));
    assert(ass.includes(',HookPlate,'));
    assert(ass.includes(subtitleStats.hookTextColor));
    assert.equal(subtitleStats.hookRendered, true);
    assert(ass.includes('Style: Subtitle'));
    // The caption face is whatever fontconfig actually resolved, reported back.
    assert(ass.includes(`Style: Subtitle,${subtitleStats.subtitleFontName},`));
    assert(ass.includes(`Style: Subtitle,${subtitleStats.subtitleFontName},${PODCAST_BOLD_STYLE.baselineFontPx}`));
    // No scale animation anywhere: the active word changes colour only, so the
    // caption block can never be re-flowed sideways (§31).
    assert(!ass.includes('\\fscx'), 'captions must not scale');
    assert.equal(subtitleStats.subtitleFontSize, PODCAST_BOLD_STYLE.baselineFontPx);
    assert.equal(subtitleStats.subtitleGeometryStable, true);
    assert.equal(subtitleStats.hookRendered, true);
    assert(Math.abs(subtitleStats.hookPosition.y - .17) < .01);
    assert(ass.includes('Style: Hook'));
    assert(ass.includes('Dialogue: 3,'));
    assert(ass.includes('0:00:01.80'));
    const animated = { ...checked.plan,
      subtitleStyle: { ...checked.plan.subtitleStyle, animationStyle: 'POP' } };
    const faceStats = await new SubtitleRendererService().write(path, animated, words, [], 1080, 1920,
      undefined, [{ timestamp: 10, x: .4, y: .70, w: .2, h: .05 }]);
    assert(faceStats.faceAvoidanceAdjustments >= 1);
    const faceAware = await readFile(path, 'utf8');
    assert(!faceAware.includes('\\t(0,150'));
    assert(faceAware.includes('\\pos(540,1152)') || faceAware.includes('\\pos(540,1248)'));
    const fadePlan = { ...checked.plan,
      subtitleStyle: { ...checked.plan.subtitleStyle, animationStyle: 'FADE' } };
    await new SubtitleRendererService().write(path, fadePlan, words, [], 1080, 1920);
    assert((await readFile(path, 'utf8')).includes('\\fad(120,0)'));
    const crowded = await new SubtitleRendererService().write(path, checked.plan, words,
      [], 1080, 1920, undefined, [
        { timestamp: 10, x: .4, y: .14, w: .2, h: .13 },
        { timestamp: 10, x: .4, y: .25, w: .2, h: .13 },
        { timestamp: 10, x: .4, y: .36, w: .2, h: .13 }
      ]);
    // A valid hook is never dropped: it takes the least-occupied zone and reports the overlap.
    assert.equal(crowded.hookRendered, true);
    assert.equal(crowded.hookWordCount, 7);
    assert.equal(crowded.hookFaceOverlap, true);
    const sideHook = { ...checked.plan, onScreenHook: { ...checked.plan.onScreenHook,
      text: 'A Real Context Hook Worth Reading Twice' } };
    const sideStats = await new SubtitleRendererService().write(path, sideHook, words,
      [], 1080, 1920, undefined,
      [{ timestamp: 10, x: .58, y: .13, w: .2, h: .28 }]);
    assert.equal(sideStats.hookPlaced, true);
    const upperFace = await new SubtitleRendererService().write(path, sideHook, words,
      [], 1080, 1920, undefined,
      [{ timestamp: 10, x: .4, y: .08, w: .2, h: .34 }]);
    assert.equal(upperFace.hookRendered, true);
    assert(upperFace.subtitlePositions.every((item) => item.y >= .60));
    const editorialPlan = forceLandscapeEditorialFrame(checked.plan, 1920, 1080);
    const editorialStats = await new SubtitleRendererService().write(path, editorialPlan,
      words, [], 1080, 1920, undefined,
      [{ timestamp: 10, x: .35, y: .35, w: .3, h: .25 }], [], true,
      PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS);
    assert.equal(editorialStats.hookRendered, true);
    assert.equal(editorialStats.hookSuppressionReason, '');
    assert.equal(editorialStats.hookStartSec, 0);
    assert.equal(editorialStats.hookEndSec, 20);
    assert(editorialStats.hookBounds.y >=
      PLATFORM_LAYOUT_PRESETS.INSTAGRAM_REELS.hookZone.y);
    const editorialAss = await readFile(path, 'utf8');
    assert(!editorialAss.split(/\r?\n/u).find((line) => line.includes(',Hook,'))
      .includes('\\fad(70,0)'));
    const adjacentPlan = { ...checked.plan, clipStartSec: 0, clipEndSec: 2,
      onScreenHook: { ...checked.plan.onScreenHook, enabled: false },
      subtitleStyle: { ...checked.plan.subtitleStyle, maxWordsPerLine: 2 } };
    const adjacentWords = [
      { start: 0, end: .2, text: 'First' },
      { start: .2, end: .4, text: 'phrase' },
      { start: .4, end: .6, text: 'Second' },
      { start: .6, end: .8, text: 'phrase' }
    ];
    await new SubtitleRendererService().write(path, adjacentPlan, adjacentWords,
      [], 1080, 1920);
    const adjacentEvents = (await readFile(path, 'utf8')).split(/\r?\n/u)
      .filter((line) => line.startsWith('Dialogue: 3,'));
    const atBoundary = adjacentEvents.filter((line) => {
      const fields = line.split(',');
      return fields[1] <= '0:00:00.40' && fields[2] > '0:00:00.40';
    });
    assert.equal(atBoundary.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(OUTPUT_DIMENSIONS['4:5'], { width: 1080, height: 1350 });
  assert(new ReframeService().filter('9:16').includes('crop=1080:1920'));
  const trackedFilter = new ReframeService().filter('9:16', [
    { timestamp: 10, x: .1, y: .1, w: .2, h: .2 },
    { timestamp: 12, x: .5, y: .2, w: .2, h: .2 }
  ], 10, [], 1920, 1080);
  assert(!trackedFilter.includes('if(lt(t'));
  assert(trackedFilter.includes('iw*('));
  const sampled = (timestamp, x) => ({ timestamp, x, y: .2, w: .12, h: .18 });
  const camera = new ReframeService();
  const steady = camera.plan('9:16', [sampled(10, .27), sampled(12.7, .28),
    sampled(15.4, .26), sampled(18.1, .29)], [], 10, [], 1920, 1080);
  assert.equal(steady.reframeAdjustmentCount, 0);
  assert.equal(steady.speakerSwitchCount, 0);
  const outlier = camera.plan('9:16', [sampled(10, .27), sampled(12.7, .28),
    sampled(15.4, .72), sampled(18.1, .29)], [], 10, [], 1920, 1080);
  assert.equal(outlier.speakerSwitchCount, 0);
  assert.equal(outlier.reframeAdjustmentCount, 0);
  const switchPlan = camera.plan('9:16', [sampled(10, .27), sampled(12.7, .28),
    sampled(15.4, .72), sampled(18.1, .71)], [], 10, [], 1920, 1080);
  assert.equal(switchPlan.speakerSwitchCount, 1);
  assert.equal(switchPlan.reframeAdjustmentCount, 1);
  assert(switchPlan.filter.includes('if(lt(t'));
  const twoFaces = [10, 12.7, 15.4, 18.1].flatMap((timestamp) => [
    sampled(timestamp, .23), sampled(timestamp, .68)
  ]);
  const signaledSwitch = camera.plan('9:16', twoFaces, [], 10, [], 1920, 1080,
    [14.9]);
  assert.equal(signaledSwitch.speakerSwitchCount, 1);
  assert.equal(signaledSwitch.speakerSegments.length, 2);
  assert(Math.abs(signaledSwitch.speakerSegments[1].startSec - 4.9) < .05);
  assert.equal(CAMERA_TUNING.deadZoneWidth, .56);
  const zoom = buildZoomExpression(checked.plan, [{ start: 11.6, end: 12.3 }], 30, words);
  assert(zoom.includes('max(0\\,min(1\\,'));
  assert(zoom.includes('*(3-2*'));
  assert(zoom.includes('on-'));
  const zoomEvents = buildZoomEvents(checked.plan, [{ start: 11.6, end: 12.3 }],
    () => ({ x: .62, y: .43 }), 30, words);
  assert.equal(zoomEvents.length, 1);
  assert.equal(zoomEvents[0].focusX, .62);
  assert(zoomEvents[0].rampFrames >= 8);
  assert(zoomEvents[0].zoomOutStartSec > zoomEvents[0].zoomInEndSec);
  assert.equal(camera.plan('9:16', [], [], 0, [], 1080, 1920, [], 60)
    .filter.includes('fps=60'), true);
  // Zoom timing leads the trigger word: the push starts ~130 ms BEFORE the word
  // onset, so it is already moving when the word lands (§6), and peaks just after.
  const leading = buildZoomEvents(checked.plan, [], undefined, 60, words)[0];
  assert.equal(leading.startFrame,
    Math.round((12.5 - ZOOM_TUNING.preOnsetSec - 10) * 60));
  assert.equal(leading.zoomStartsBeforeWord, true);
  assert(leading.peakOffsetFromWordMs >= 0 && leading.peakOffsetFromWordMs <= 180,
    `peak lands ${leading.peakOffsetFromWordMs}ms after the word`);
  assert.equal(leading.motionKind, 'SEMANTIC_ZOOM');
  assert.equal(buildZoomEvents(checked.plan, [], undefined, 60).length, 0);
  const cutReframe = new ReframeService().filter('9:16', [
    { timestamp: 10, x: .1, y: .1, w: .2, h: .2 },
    { timestamp: 11.8, x: .9, y: .2, w: .1, h: .2 },
    { timestamp: 12.5, x: .4, y: .2, w: .2, h: .2 }
  ], 10, [{ start: 11.6, end: 12.3 }], 1920, 1080);
  assert(!cutReframe.includes('0.9500'));
  console.log('Editing tests passed: selection defaults, mode isolation, schema, safety, subtitles, reframe.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
