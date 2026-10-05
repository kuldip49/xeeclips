require('reflect-metadata');
const assert = require('node:assert/strict');
const {
  maxClipCountForDuration,
  defaultClipCountForMax,
  isVideoTooLong,
  validateRequestedClipCount,
  parseTargetPlatform,
  parseOutputStyle,
  processingTypeForOutputStyle,
  evaluateCandidateUsability,
  rankUsableCandidates,
  selectBestClips,
  userAiModeLabel,
  clipVariantKey,
  isReusableClipVariant
} = require('../dist/modules/processing/clip-selection-policy');
const {
  orderCandidatesForSelection,
  parseClipCreationRequest,
  toClipCard,
  clipRenderQueueJobId,
  RENDER_INTERRUPTED_MESSAGE,
  aiEditedRenderConcurrency,
  ClipSelectionService
} = require('../dist/modules/videos/clip-selection.service');
const { ClipInfrastructureError } = require('../dist/modules/videos/clip-export.service');
const { MediaProcessingError, isRetryableErrorCode } = require('../dist/modules/processing/media-probe');
const { forceLandscapeEditorialFrame } = require('../dist/modules/videos/clip-export.service');
const { fallbackEditPlan } = require('../dist/modules/editing/edit-plan');

const minutes = (value) => value * 60;

// Each candidate gets its own vocabulary so text similarity never marks them as duplicates.
function speech(tag, words = 60) {
  return Array.from({ length: words }, (_, index) => `${tag}term${index}`).join(' ') + '.';
}

function candidate(id, score, index, overrides = {}) {
  const startTime = index * 100;
  return {
    id, rangeKey: `${startTime}:${startTime + 30}`, startTime, endTime: startTime + 30,
    transcriptText: speech(id), contentPotential: score, rank: index + 1, reject: false,
    evidence: {}, ...overrides
  };
}

function testDurationMatrix() {
  const matrix = [
    [minutes(2), 8], [minutes(5), 8], [minutes(10), 8], [minutes(10) + 1, 8], [minutes(12), 8],
    [minutes(14) + 59, 8], [minutes(15), 20], [minutes(30), 20], [minutes(60), 20],
    [minutes(60) + 1, 30], [minutes(90), 30], [minutes(120), 30]
  ];
  for (const [duration, expected] of matrix)
    assert.equal(maxClipCountForDuration(duration), expected, `max clips for ${duration}s`);
  assert.equal(isVideoTooLong(minutes(120)), false);
  assert.equal(isVideoTooLong(minutes(120) + 1), true, '120:01 must be rejected');
  assert.equal(maxClipCountForDuration(minutes(120) + 1), 0);
  assert.equal(isVideoTooLong(null), false, 'unknown duration is decided by the worker probe');

  const tooLong = new MediaProcessingError('VIDEO_TOO_LONG');
  assert.equal(tooLong.retryable, false);
  assert.equal(isRetryableErrorCode('VIDEO_TOO_LONG'), false);
  assert.match(tooLong.message, /longer than the 2-hour limit/);

  assert.deepEqual([8, 20, 30].map(defaultClipCountForMax), [4, 8, 8]);
}

function testCountValidation() {
  assert.throws(() => validateRequestedClipCount(0, 12), /at least 1/);
  assert.throws(() => validateRequestedClipCount(-5, 12), /at least 1/);
  assert.throws(() => validateRequestedClipCount(2.5, 12), /at least 1/);
  assert.throws(() => validateRequestedClipCount('abc', 12), /at least 1/);
  assert.throws(() => validateRequestedClipCount(13, 12), /at most 12 clips/);
  assert.equal(validateRequestedClipCount(20, 20), 20);
  assert.equal(validateRequestedClipCount('4', 8), 4);

  assert.equal(parseTargetPlatform('TIKTOK'), 'TIKTOK');
  assert.equal(parseTargetPlatform('youtube_shorts'), 'YOUTUBE_SHORTS');
  assert.equal(parseTargetPlatform(undefined), null);
  assert.throws(() => parseTargetPlatform('SNAPCHAT'));
  assert.equal(parseOutputStyle('AI_EDITED'), 'AI_EDITED');
  assert.equal(parseOutputStyle('NORMAL_CLIPS'), 'NORMAL');
  assert.throws(() => parseOutputStyle('WHATEVER'));
  assert.equal(processingTypeForOutputStyle('AI_EDITED'), 'EDITED_CLIPS');
  assert.equal(processingTypeForOutputStyle('NORMAL'), 'NORMAL_CLIPS');
  assert.throws(() => parseClipCreationRequest({ outputStyle: 'NORMAL' }), /requestedClipCount/);
}

function testSelectionMatrix() {
  const twenty = Array.from({ length: 20 }, (_, index) => candidate(`c${index}`, 90 - index, index));
  assert.deepEqual(selectBestClips(twenty, 5).map(({ id }) => id), ['c0', 'c1', 'c2', 'c3', 'c4']);
  assert.equal(selectBestClips(twenty, 10).length, 10);

  const eightUsable = [
    ...Array.from({ length: 8 }, (_, index) => candidate(`u${index}`, 80 - index, index)),
    candidate('junk', 95, 8, { reject: true }),
    candidate('short', 94, 9, { endTime: 900 + 10 })
  ];
  const partial = selectBestClips(eightUsable, 10);
  assert.equal(partial.length, 8, 'returns only the usable moments, never padding');
  assert.ok(partial.every(({ id }) => id.startsWith('u')));

  // Historical PRIMARY/SECONDARY thresholds must not gate delivery; scores stay exact.
  const scores = [90, 84, 78, 73, 68, 62, 57, 52, 48];
  const scored = scores.map((score, index) => candidate(`s${index}`, score, index));
  const eight = selectBestClips(scored, 8);
  assert.deepEqual(eight.map(({ contentPotential }) => contentPotential), scores.slice(0, 8));
  const seven = selectBestClips(scored, 7);
  assert.deepEqual(seven.map(({ contentPotential }) => contentPotential), [90, 84, 78, 73, 68, 62, 57]);

  // Order stability: asking for 10 after 5 keeps the first five in place.
  const firstFive = selectBestClips(twenty, 5).map(({ id }) => id);
  const firstTen = selectBestClips(twenty, 10).map(({ id }) => id);
  assert.deepEqual(firstTen.slice(0, 5), firstFive);
  assert.deepEqual(selectBestClips([...twenty].reverse(), 10).map(({ id }) => id), firstTen,
    'input order must not change the ranking');
}

function testDedupAndUsability() {
  // 20–55, 28–65, 35–72 are one moment: only the strongest is kept.
  const overlapping = [
    candidate('a', 80, 0, { startTime: 20, endTime: 55 }),
    candidate('b', 78, 1, { startTime: 28, endTime: 65 }),
    candidate('c', 76, 2, { startTime: 35, endTime: 72 }),
    candidate('d', 60, 3)
  ];
  assert.deepEqual(selectBestClips(overlapping, 4).map(({ id }) => id), ['a', 'd']);
  const sameText = [candidate('x', 80, 0), candidate('y', 70, 1, { transcriptText: speech('x') })];
  assert.deepEqual(selectBestClips(sameText, 2).map(({ id }) => id), ['x']);

  const verdict = (overrides) => evaluateCandidateUsability(candidate('v', 70, 0, overrides), 600);
  assert.deepEqual(verdict({}), { usable: true });
  assert.equal(verdict({ endTime: 14 }).reason, 'TOO_SHORT');
  assert.equal(verdict({ endTime: 121 }).reason, 'TOO_LONG');
  assert.equal(verdict({ endTime: 120, transcriptText: speech('long', 250) }).usable, true,
    '120 s is inside the allowed range');
  assert.equal(verdict({ startTime: -1 }).reason, 'INVALID_TIMESTAMP_RANGE');
  assert.equal(verdict({ startTime: 590, endTime: 640 }).reason, 'OUTSIDE_SOURCE_DURATION');
  assert.equal(verdict({ rank: null }).reason, 'NOT_RANKED_OR_DUPLICATE');
  assert.equal(verdict({ transcriptText: 'too few words here.' }).reason,
    'SEVERE_TRANSCRIPT_FRAGMENTATION');
  assert.equal(verdict({ transcriptText: Array.from({ length: 40 }, () => 'um yeah like so').join(' ') })
    .reason, 'MEANINGLESS_FILLER');
  assert.equal(verdict({ endTime: 100, transcriptText: speech('sparse', 25) }).reason,
    'INSUFFICIENT_SPEECH');
}

function testExpansionOrdering() {
  const primary = [candidate('p0', 70, 0), candidate('p1', 60, 1)];
  // An expansion candidate never displaces what the analysis pool already provided.
  const expansion = [
    candidate('e0', 99, 2, { evidence: { candidateExpansion: true } }),
    candidate('dup', 99, 3, { startTime: 0, endTime: 30, evidence: { candidateExpansion: true } })
  ];
  const { ordered } = orderCandidatesForSelection([...expansion, ...primary], 3600);
  assert.deepEqual(ordered.map(({ id }) => id), ['p0', 'p1', 'e0']);
  assert.equal(rankUsableCandidates(primary).ordered.length, 2);
}

const storedContent = {
  id: 'cand', bestHook: 'Why the plan failed overnight', hookCandidate: 'unused',
  synopsis: 'One.\n\nTwo.\n\nThree.', caption: 'Caption text', captionCandidate: '',
  hashtags: ['#a', '#b', '#c', '#d', '#e'], generationMode: 'CLOUD_AI',
  contentPotential: 57, hookScore: 40, recommendationTier: null
};
const clipBase = { id: 'clip', startTime: 1, endTime: 31, duration: 30.04, sizeBytes: 10n,
  width: 1080, height: 1920, candidate: storedContent };

function testCleanCardsAndAiMode() {
  // The label follows the job's effectiveAiMode only.
  assert.equal(userAiModeLabel('ONLINE'), 'Online');
  assert.equal(userAiModeLabel('OFFLINE'), 'Local');
  assert.equal(userAiModeLabel('LOCAL_LLM'), 'Local');
  assert.equal(userAiModeLabel('FALLBACK_ONLY'), 'Fallback');
  assert.equal(userAiModeLabel(undefined), 'Fallback');

  const normal = toClipCard({ ...clipBase, processingType: 'NORMAL_CLIPS', aspectRatio: '9:16',
    editTelemetry: null }, 'ONLINE', 1);
  // Step 2 made every generated clip editable: cards carry editProjectId/editUrl/isEditable.
  assert.deepEqual(Object.keys(normal).sort(), ['aiModeUsed', 'caption', 'durationSec',
    'editProjectId', 'editUrl', 'effectiveTemplate', 'generationJobId', 'hashtags', 'height', 'hook', 'id', 'isEditable',
    'outputStyle', 'playbackUrl', 'posterUrl', 'position', 'requestedClipIndex', 'sourceRange',
    'requestedTemplate', 'style', 'styleVariant', 'synopsis', 'templateId', 'width'].sort());
  // No rendered cover stored: the player falls back to its own first frame.
  assert.equal(normal.posterUrl, null);
  assert.equal(normal.hook, 'Why the plan failed overnight');
  assert.equal(normal.aiModeUsed, 'Online');
  assert.equal(normal.outputStyle, 'NORMAL');
  assert.ok(!JSON.stringify(normal).match(/contentPotential|Score|PRIMARY|SECONDARY|provider|model/u));

  const edited = toClipCard({ ...clipBase, processingType: 'EDITED_CLIPS', aspectRatio: '9:16',
    editTelemetry: { hookRendered: true, hookFinalText: 'Who Pays For This Change?' } }, 'OFFLINE', 2);
  assert.equal(edited.hook, 'Who Pays For This Change?', 'edited card shows the rendered hook');
  assert.equal(edited.aiModeUsed, 'Local');
  // The designed cover carrying the same hook is what the player shows before play.
  const withPoster = toClipCard({ ...clipBase, processingType: 'EDITED_CLIPS', aspectRatio: '9:16',
    thumbnailObjectKey: 'clips/cover.jpg',
    editTelemetry: { hookRendered: true, hookFinalText: 'Who Pays For This Change?' } }, 'ONLINE', 2);
  assert.equal(withPoster.posterUrl, `/generated-clips/${clipBase.id}/poster`);

  // A) ONLINE job whose content package used deterministic repair/fallback is still Online.
  const repaired = toClipCard({ ...clipBase, processingType: 'NORMAL_CLIPS', aspectRatio: '9:16',
    editTelemetry: null, candidate: { ...storedContent, generationMode: 'DETERMINISTIC_FALLBACK',
      fallbackUsed: true } }, 'ONLINE', 3);
  assert.equal(repaired.aiModeUsed, 'Online');
  // B) / C)
  assert.equal(toClipCard({ ...clipBase, processingType: 'NORMAL_CLIPS', aspectRatio: '9:16',
    editTelemetry: null }, 'LOCAL_LLM', 1).aiModeUsed, 'Local');
  assert.equal(toClipCard({ ...clipBase, processingType: 'NORMAL_CLIPS', aspectRatio: '9:16',
    editTelemetry: null }, 'FALLBACK_ONLY', 1).aiModeUsed, 'Fallback');

  assert.equal(clipVariantKey('NORMAL_CLIPS', 'TIKTOK'), 'NORMAL_CLIPS:TIKTOK');
  assert.equal(clipVariantKey('EDITED_CLIPS', null), 'EDITED_CLIPS:DEFAULT');
  assert.equal(isReusableClipVariant({ processingType: 'NORMAL_CLIPS', aspectRatio: '9:16',
    width: 1080, height: 1920 }), true);
  assert.equal(isReusableClipVariant({ processingType: 'NORMAL_CLIPS', aspectRatio: 'SOURCE',
    width: 1920, height: 1080 }), false, 'source-aspect Normal renders are replaced');
}

function testPlatformAwareEditing() {
  const plan = fallbackEditPlan(0, 30, '9:16');
  assert.equal(forceLandscapeEditorialFrame(plan, 1920, 1080, 'TIKTOK').platformPreset, 'TIKTOK');
  assert.equal(forceLandscapeEditorialFrame(plan, 1080, 1920, 'YOUTUBE_SHORTS').platformPreset,
    'YOUTUBE_SHORTS');
  assert.equal(forceLandscapeEditorialFrame(plan, 1920, 1080).platformPreset, 'INSTAGRAM_REELS',
    'legacy videos without a platform keep the previous preset');
}

const video = { id: 'vid', duration: minutes(12), targetPlatform: 'YOUTUBE_SHORTS' };
const ago = (ms) => new Date(Date.now() - ms);

/** In-memory ProcessingJob store honoring the conditional updates the service relies on. */
function fakeStore(job, { candidates = [], clips = [], sourceVideo = video } = {}) {
  const store = { job: { id: 'job', videoId: 'vid', status: 'COMPLETED', aiMode: 'ONLINE',
    telemetry: { effectiveAiMode: 'ONLINE' }, processingType: 'NORMAL_CLIPS',
    selectedCandidateIds: [], clipRenderStatus: null, clipRequestedAt: null,
    clipRenderStartedAt: null, ...job }, updates: [] };
  const time = (value) => value instanceof Date ? value.getTime() : value ?? null;
  const matches = (where) => {
    if (where.id !== store.job.id) return false;
    if ('clipRequestedAt' in where && time(where.clipRequestedAt) !== time(store.job.clipRequestedAt))
      return false;
    if (where.clipRenderStatus?.in && !where.clipRenderStatus.in.includes(store.job.clipRenderStatus))
      return false;
    if (where.OR && !where.OR.some((condition) => condition.clipRenderStatus === null
      ? store.job.clipRenderStatus == null
      : store.job.clipRenderStatus != null &&
        !condition.clipRenderStatus.notIn.includes(store.job.clipRenderStatus))) return false;
    return true;
  };
  store.prisma = {
    video: {
      findUnique: async () => ({ ...sourceVideo, processingJobs: [store.job] }),
      findUniqueOrThrow: async () => sourceVideo
    },
    clipCandidate: { findMany: async () => candidates },
    generatedClip: {
      // getResults() scopes by generationJobId + processingType + targetPlatform (real, stable
      // columns), not by variantKey (a rendering-cache key whose format has changed over time).
      findMany: async ({ where }) => clips.filter((clip) =>
        clip.videoId === where.videoId && where.candidateId.in.includes(clip.candidateId) &&
        clip.generationJobId === where.generationJobId &&
        (where.processingType === undefined || clip.processingType === where.processingType) &&
        (where.targetPlatform === undefined || (clip.targetPlatform ?? null) === where.targetPlatform))
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
      updateMany: async () => ({ count: 1 })
    },
    processingJob: {
      updateMany: async ({ where, data }) => {
        if (!matches(where)) return { count: 0 };
        store.updates.push(data);
        store.job = { ...store.job, ...data };
        return { count: 1 };
      },
      update: async ({ data }) => { store.job = { ...store.job, ...data }; return store.job; },
      findUnique: async () => store.job,
      findUniqueOrThrow: async () => store.job,
      findMany: async ({ where }) =>
        where.clipRenderStatus.in.includes(store.job.clipRenderStatus) ? [store.job] : []
    },
    $transaction: async (operations) => Promise.all(operations)
  };
  return store;
}

function fakeDispatcher(pending = false) {
  const dispatcher = { dispatched: [], pending,
    dispatch: async (request) => { dispatcher.dispatched.push(request); },
    isPending: async () => {
      if (dispatcher.pending instanceof Error) throw dispatcher.pending;
      return dispatcher.pending;
    } };
  return dispatcher;
}

async function testCreateFlow() {
  const usable = Array.from({ length: 9 }, (_, index) => candidate(`k${index}`, 90 - index * 5, index));
  const exported = [];
  const store = fakeStore({ telemetry: { effectiveAiMode: 'OFFLINE' }, aiMode: 'OFFLINE' },
    { candidates: usable });
  const exporter = { export: async (_video, item, options) => {
    if (item.id === 'k2') throw new Error('render failed');
    exported.push({ id: item.id, options }); return { id: `clip-${item.id}` };
  } };
  const service = new ClipSelectionService(store.prisma, exporter);
  process.env.CLIP_SELECTION_SYNC = 'true';
  await assert.rejects(() => service.create('vid', { requestedClipCount: 9, outputStyle: 'NORMAL' }),
    /at most 8 clips/);
  await assert.rejects(() => service.create('vid', { requestedClipCount: 0, outputStyle: 'NORMAL' }));
  const state = await service.create('vid', { requestedClipCount: 4, outputStyle: 'AI_EDITED' });
  delete process.env.CLIP_SELECTION_SYNC;
  // k2 failed to render, so the next strongest usable moment (k4) fills its place.
  assert.deepEqual(exported.map(({ id }) => id), ['k0', 'k1', 'k3', 'k4']);
  // Rank is now forwarded so pre-render rejection cost can be attributed to the
  // exact selection position; the export format behavior is otherwise unchanged.
  assert.deepEqual(exported[0].options, { processingType: 'EDITED_CLIPS',
    targetPlatform: 'YOUTUBE_SHORTS', aspectRatio: '9:16', rank: 1,
    generationJobId: 'job', generationRequestKey:
      `job:${store.updates[0].clipRequestedAt.toISOString()}`,
    templateId: 'AUTOMATIC_1', styleVariant: 'AUTOMATIC_1' });
  // Persisted lifecycle: QUEUED before dispatch, RENDERING when the worker starts, then COMPLETED.
  const statuses = store.updates.map((update) => update.clipRenderStatus).filter(Boolean);
  assert.deepEqual(statuses, ['QUEUED', 'RENDERING', 'COMPLETED']);
  assert.ok(store.updates[0].clipRequestedAt instanceof Date);
  assert.equal(store.updates[0].clipRenderStartedAt, null);
  assert.ok(store.updates[1].clipRenderStartedAt instanceof Date);
  assert.deepEqual(store.updates[0].selectedCandidateIds, [], 'a new request clears the previous selection');
  assert.equal(store.job.clipRenderStatus, 'COMPLETED');
  assert.deepEqual(store.job.selectedCandidateIds, ['k0', 'k1', 'k3', 'k4']);
  const telemetry = store.job.telemetry.clipSelection;
  assert.equal(store.job.telemetry.effectiveAiMode, 'OFFLINE', 'job telemetry is preserved');
  assert.equal(telemetry.requestedClipCount, 4);
  assert.equal(telemetry.returnedClipCount, 4);
  assert.equal(telemetry.maxClipCount, 8);
  assert.equal(telemetry.candidateExpansionTriggered, false);
  assert.equal(telemetry.additionalSemanticCalls, 0);
  assert.equal(telemetry.renderFailures, 1);
  assert.equal(telemetry.highQualitySelectedCount + telemetry.mediumQualitySelectedCount +
    telemetry.fallbackUsableSelectedCount, 4);
  assert.equal(state.maxClipCount, 8);
  assert.equal(state.defaultClipCount, 4);
  assert.ok(!('recommendedClipCount' in state));

  const failing = fakeStore({}, { candidates: usable });
  const broken = new ClipSelectionService(failing.prisma,
    { export: async () => { throw new Error('ffmpeg exploded at /tmp/secret'); } });
  process.env.CLIP_SELECTION_SYNC = 'true';
  await broken.create('vid', { requestedClipCount: 2, outputStyle: 'NORMAL' });
  delete process.env.CLIP_SELECTION_SYNC;
  assert.equal(failing.job.clipRenderStatus, 'FAILED');
  assert.match(failing.job.clipRenderError, /Requested 2; delivered 0/u,
    'the persisted error explicitly reports an unsatisfied delivery contract');

  const pending = new ClipSelectionService({ video: { findUnique: async () => ({ ...video,
    processingJobs: [{ ...store.job, status: 'PROCESSING' }] }) } }, exporter);
  await assert.rejects(() => pending.create('vid', { requestedClipCount: 2, outputStyle: 'NORMAL' }),
    /not complete/);

  const unavailable = fakeStore({});
  const offline = new ClipSelectionService(unavailable.prisma, exporter,
    { dispatch: async () => { throw new Error('redis down'); }, isPending: async () => null });
  await assert.rejects(() => offline.create('vid', { requestedClipCount: 2, outputStyle: 'NORMAL' }),
    /could not be queued/);
  assert.equal(unavailable.job.clipRenderStatus, 'FAILED', 'a failed dispatch is never left QUEUED');
}

async function testPostRenderCandidateExpansion() {
  // The initial pool is numerically large enough, but edit-stage failures leave
  // a shortfall. Expansion must still run and continue from saved analysis.
  const candidates = Array.from({ length: 4 }, (_, index) =>
    candidate(`initial${index}`, 90 - index, index));
  const store = fakeStore({ telemetry: {}, aiMode: 'OFFLINE' }, { candidates });
  const attempted = [];
  const service = new ClipSelectionService(store.prisma, { export: async (_video, item) => {
    attempted.push(item.id);
    if (item.id === 'initial0' || item.id === 'initial1') throw new Error('candidate render failed');
    return { id: `clip-${item.id}` };
  } });
  let expansions = 0;
  service.expandCandidates = async () => {
    if (expansions++) return 0;
    candidates.push(candidate('expanded0', 70, 4, { evidence: { candidateExpansion: true } }),
      candidate('expanded1', 69, 5, { evidence: { candidateExpansion: true } }),
      candidate('expanded2', 68, 6, { evidence: { candidateExpansion: true } }));
    return 3;
  };
  process.env.CLIP_SELECTION_SYNC = 'true';
  try {
    await service.create('vid', { requestedClipCount: 4, outputStyle: 'AI_EDITED' });
  } finally { delete process.env.CLIP_SELECTION_SYNC; }
  assert.deepEqual(attempted, ['initial0', 'initial1', 'initial2', 'initial3',
    'expanded0', 'expanded1']);
  assert.deepEqual(store.job.selectedCandidateIds,
    ['initial2', 'initial3', 'expanded0', 'expanded1']);
  const telemetry = store.job.telemetry.clipSelection;
  assert.equal(telemetry.requestedClipCount, 4);
  assert.equal(telemetry.deliveredClipCount, 4);
  assert.equal(telemetry.candidateExpansionTriggered, true);
  assert.equal(telemetry.additionalCandidateCount, 3);
  assert.deepEqual(telemetry.originalRankOfDeliveredClips, [3, 4, 5, 6]);
  assert.equal(store.job.clipRenderError, null);
}

async function testExplicitDeliveryShortfall() {
  const candidates = Array.from({ length: 3 }, (_, index) =>
    candidate(`only${index}`, 80 - index, index));
  const store = fakeStore({ telemetry: {}, aiMode: 'OFFLINE' }, { candidates });
  process.env.CLIP_SELECTION_SYNC = 'true';
  try {
    await new ClipSelectionService(store.prisma, { export: async () => ({ id: 'clip' }) })
      .create('vid', { requestedClipCount: 4, outputStyle: 'AI_EDITED' });
  } finally { delete process.env.CLIP_SELECTION_SYNC; }
  assert.equal(store.job.clipRenderStatus, 'COMPLETED');
  assert.equal(store.job.selectedCandidateIds.length, 3);
  assert.match(store.job.clipRenderError, /Requested 4; delivered 3/u);
  const analysis = await new ClipSelectionService(store.prisma, {}).getAnalysis('vid');
  assert.match(analysis.clipRequest.error, /Requested 4; delivered 3/u,
    'a completed shortfall is returned to the user instead of being hidden');
}

async function testConcurrentRenderPool() {
  const usable = Array.from({ length: 6 }, (_, index) => candidate(`pool${index}`, 90 - index, index));
  const store = fakeStore({ telemetry: {}, aiMode: 'OFFLINE' }, { candidates: usable });
  let active = 0, maxActive = 0, preparations = 0, disposals = 0;
  const paths = [];
  const exporter = {
    prepareBatchSource: async () => { preparations++; return { sourcePath: 'shared-source.mp4',
      preparationMs: 7, dispose: async () => { disposals++; } }; },
    export: async (_video, item, options) => {
      active++; maxActive = Math.max(maxActive, active); paths.push(options.preparedSourcePath);
      await new Promise((resolve) => setTimeout(resolve, item.id === 'pool0' ? 30 : 8));
      active--;
      if (item.id === 'pool1') throw new Error('isolated candidate failure');
      return { id: `clip-${item.id}` };
    }
  };
  const oldConcurrency = process.env.AI_EDITED_RENDER_CONCURRENCY;
  process.env.AI_EDITED_RENDER_CONCURRENCY = '0';
  assert.equal(aiEditedRenderConcurrency(), 1);
  process.env.AI_EDITED_RENDER_CONCURRENCY = '99';
  assert.equal(aiEditedRenderConcurrency(), 4);
  process.env.AI_EDITED_RENDER_CONCURRENCY = '2';
  process.env.CLIP_SELECTION_SYNC = 'true';
  try {
    assert.equal(aiEditedRenderConcurrency(), 2);
    await new ClipSelectionService(store.prisma, exporter)
      .create('vid', { requestedClipCount: 4, outputStyle: 'AI_EDITED' });
  } finally {
    delete process.env.CLIP_SELECTION_SYNC;
    if (oldConcurrency == null) delete process.env.AI_EDITED_RENDER_CONCURRENCY;
    else process.env.AI_EDITED_RENDER_CONCURRENCY = oldConcurrency;
  }
  assert.equal(maxActive, 2, 'the AI Edited worker pool honors its bound');
  assert.equal(preparations, 1, 'the immutable source is prepared once per batch');
  assert.equal(disposals, 1, 'the shared source is released after every worker');
  assert(paths.every((path) => path === 'shared-source.mp4'));
  assert.deepEqual(store.job.selectedCandidateIds, ['pool0', 'pool2', 'pool3', 'pool4'],
    'completion order never changes rank order and a failure is backfilled');
  assert.equal(store.job.telemetry.clipSelection.renderConcurrency, 2);
  assert.equal(store.job.telemetry.clipSelection.failedCount, 1);
  assert.equal(store.job.telemetry.clipSelection.completedCount, 4);
  assert.equal(store.job.telemetry.clipSelection.sourcePreparationMs, 7);
  assert.ok(store.updates.some((update) => Array.isArray(update.selectedCandidateIds) &&
    update.selectedCandidateIds.length > 0 && update.selectedCandidateIds.length < 4),
  'successful clips are persisted incrementally');
}

async function testStrictCountLongSourceMatrix() {
  const oldConcurrency = process.env.AI_EDITED_RENDER_CONCURRENCY;
  process.env.AI_EDITED_RENDER_CONCURRENCY = '2';
  process.env.CLIP_SELECTION_SYNC = 'true';
  try {
    for (const durationMin of [20, 50, 60, 120]) {
      for (const requestedClipCount of [8, 12]) {
        const usable = Array.from({ length: 12 }, (_, index) =>
          candidate(`long${durationMin}m-${requestedClipCount}-${index}`, 100 - index, index));
        let preparations = 0;
        const sourceVideo = { ...video, duration: minutes(durationMin) };
        const store = fakeStore({ telemetry: {}, aiMode: 'OFFLINE' }, { candidates: usable, sourceVideo });
        const exporter = { prepareBatchSource: async () => {
          preparations++;
          return { sourcePath: `cached-${durationMin}m.mp4`, preparationMs: 1, dispose: async () => {} };
        }, export: async () => ({ editTelemetry: { analysisMs: 1, planMs: 1,
          preRenderValidationMs: 1, baseRenderMs: 1, qualityCheckMs: 1, storageMs: 1 } }) };
        await new ClipSelectionService(store.prisma, exporter)
          .create('vid', { requestedClipCount, outputStyle: 'AI_EDITED' });
        const telemetry = store.job.telemetry.clipSelection;
        assert.equal(store.job.selectedCandidateIds.length, requestedClipCount,
          `${durationMin}m ${requestedClipCount}->${requestedClipCount}`);
        assert.equal(telemetry.requestedClipCount, requestedClipCount);
        assert.equal(telemetry.deliveredClipCount, requestedClipCount);
        assert.equal(telemetry.sourceDurationSec, minutes(durationMin));
        assert.equal(telemetry.renderConcurrency, 2);
        assert.equal(preparations, 1, 'whole source preparation is reused for the batch');
        assert.notEqual(telemetry.timeToFirstClipMs, null);
        assert.notEqual(telemetry.timeToHalfRequestedMs, null);
        assert.notEqual(telemetry.timeToAllClipsMs, null);
      }
    }
  } finally {
    delete process.env.CLIP_SELECTION_SYNC;
    if (oldConcurrency == null) delete process.env.AI_EDITED_RENDER_CONCURRENCY;
    else process.env.AI_EDITED_RENDER_CONCURRENCY = oldConcurrency;
  }
}

async function testCanonicalTemplateCountMatrix() {
  process.env.CLIP_SELECTION_SYNC = 'true';
  try {
    for (const templateId of ['AUTOMATIC_1', 'AUTOMATIC_2']) {
      for (const requestedClipCount of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const usable = Array.from({ length: 24 }, (_, index) =>
          candidate(`${templateId}-${requestedClipCount}-${index}`, 100 - index, index));
        const store = fakeStore({ telemetry: {}, aiMode: 'OFFLINE' }, {
          candidates: usable, sourceVideo: { ...video, duration: minutes(60) }
        });
        await new ClipSelectionService(store.prisma, { export: async () => ({ editTelemetry: {} }) })
          .create('vid', { requestedClipCount, outputStyle: 'AI_EDITED', generation: {
            templateId, look: templateId, components: {}, brief: '', referenceId: null
          } });
        assert.equal(store.job.selectedCandidateIds.length, requestedClipCount,
          `${templateId} ${requestedClipCount}->${requestedClipCount}`);
        assert.equal(store.job.generationSettings.requestedTemplate, templateId);
        assert.equal(store.job.generationSettings.effectiveTemplate, templateId);
        assert.equal(store.job.telemetry.clipSelection.requestedTemplate, templateId);
        assert.equal(store.job.telemetry.clipSelection.deliveryStatus, 'COMPLETE');
      }
    }
  } finally { delete process.env.CLIP_SELECTION_SYNC; }
  assert.notEqual(clipVariantKey('EDITED_CLIPS', 'YOUTUBE_SHORTS', 'AUTOMATIC_1'),
    clipVariantKey('EDITED_CLIPS', 'YOUTUBE_SHORTS', 'AUTOMATIC_2'),
    'Automatic 1 and Automatic 2 never share a rendered variant');
}

async function testVariantResults() {
  // D) Normal and AI Edited renders of the same candidate coexist; results show the requested one.
  const clip = (id, processingType, targetPlatform) => ({ ...clipBase, id, videoId: 'vid',
    candidateId: 'cand', processingType, targetPlatform, generationJobId: 'job', aspectRatio: '9:16',
    editTelemetry: null, candidate: { ...storedContent, generationMode: 'DETERMINISTIC_FALLBACK' } });
  const clips = [clip('normal', 'NORMAL_CLIPS', 'YOUTUBE_SHORTS'),
    clip('edited', 'EDITED_CLIPS', 'YOUTUBE_SHORTS'),
    clip('other-platform', 'NORMAL_CLIPS', 'TIKTOK')];
  const results = async (job) => new ClipSelectionService(fakeStore({ selectedCandidateIds: ['cand'],
    clipRenderStatus: 'COMPLETED', requestedClipCount: 1, ...job }, { clips }).prisma, {})
    .getResults('vid');
  const normal = await results({ outputStyle: 'NORMAL' });
  assert.deepEqual(normal.clips.map(({ id, outputStyle }) => [id, outputStyle]), [['normal', 'NORMAL']]);
  assert.equal(normal.clips[0].aiModeUsed, 'Online', 'ONLINE job with fallback content says Online');
  const edited = await results({ outputStyle: 'AI_EDITED' });
  assert.deepEqual(edited.clips.map(({ id, outputStyle }) => [id, outputStyle]), [['edited', 'AI_EDITED']]);
  const local = await results({ outputStyle: 'NORMAL', telemetry: { effectiveAiMode: 'LOCAL_LLM' } });
  assert.equal(local.clips[0].aiModeUsed, 'Local');
  const fallback = await results({ outputStyle: 'NORMAL', aiMode: 'ONLINE',
    telemetry: { effectiveAiMode: 'FALLBACK_ONLY' } });
  assert.equal(fallback.clips[0].aiModeUsed, 'Fallback', 'effectiveAiMode wins over requested mode');
  const idle = await results({ outputStyle: null, clipRenderStatus: 'IDLE', selectedCandidateIds: [] });
  assert.equal(idle.status, null);
  assert.deepEqual(idle.clips, []);
}

async function testIdempotentRequests() {
  // E) An identical, fully delivered request does not dispatch or render again.
  const completed = fakeStore({ clipRenderStatus: 'COMPLETED', outputStyle: 'NORMAL',
    requestedClipCount: 2, selectedCandidateIds: ['a', 'b'], clipRequestedAt: ago(60_000) });
  const dispatcher = fakeDispatcher();
  const service = new ClipSelectionService(completed.prisma, {}, dispatcher);
  const same = await service.create('vid', { requestedClipCount: 2, outputStyle: 'NORMAL' });
  assert.equal(same.clipRequest.status, 'COMPLETED');
  assert.equal(dispatcher.dispatched.length, 0);
  assert.equal(completed.updates.length, 0);

  // Real bug (2026-10-03): pressing Create again with unchanged settings did nothing.
  // An explicit regenerate re-runs the finished identical request as a NEW request.
  const again = fakeStore({ clipRenderStatus: 'COMPLETED', outputStyle: 'NORMAL',
    requestedClipCount: 2, selectedCandidateIds: ['a', 'b'], clipRequestedAt: ago(60_000) });
  const againDispatcher = fakeDispatcher();
  const regenerated = await new ClipSelectionService(again.prisma, {}, againDispatcher)
    .create('vid', { requestedClipCount: 2, outputStyle: 'NORMAL', regenerate: true });
  assert.equal(regenerated.clipRequest.status, 'QUEUED');
  assert.equal(againDispatcher.dispatched.length, 1);
  assert.equal(again.updates.length, 1, 'regenerate claims a new request');
  assert.equal(parseClipCreationRequest({ requestedClipCount: 2, regenerate: true }).regenerate, true);
  assert.equal(parseClipCreationRequest({ requestedClipCount: 2 }).regenerate, false);

  // The other style is a new request for the same moments.
  const queued = await service.create('vid', { requestedClipCount: 2, outputStyle: 'AI_EDITED' });
  assert.equal(queued.clipRequest.status, 'QUEUED');
  assert.equal(dispatcher.dispatched.length, 1);
  const first = dispatcher.dispatched[0];
  assert.equal(first.requestedAt, completed.job.clipRequestedAt.toISOString());

  // Resent after a network error: no new request, same deterministic queue job id.
  const resent = await service.create('vid', { requestedClipCount: 2, outputStyle: 'AI_EDITED' });
  assert.equal(resent.clipRequest.status, 'QUEUED');
  assert.equal(completed.updates.length, 1, 'no second claim');
  assert.equal(clipRenderQueueJobId(dispatcher.dispatched[1]), clipRenderQueueJobId(first));
  assert.doesNotMatch(clipRenderQueueJobId(first), /:/u, 'BullMQ custom ids cannot contain ":"');

  await assert.rejects(() => service.create('vid', { requestedClipCount: 1, outputStyle: 'NORMAL' }),
    /already being created/);

  // A partially delivered request is retried (already rendered variants are reused by the exporter).
  const partial = fakeStore({ clipRenderStatus: 'COMPLETED', outputStyle: 'NORMAL',
    requestedClipCount: 3, selectedCandidateIds: ['a'] });
  const partialDispatcher = fakeDispatcher();
  await new ClipSelectionService(partial.prisma, {}, partialDispatcher)
    .create('vid', { requestedClipCount: 3, outputStyle: 'NORMAL' });
  assert.equal(partialDispatcher.dispatched.length, 1);
}

async function testStaleRenderRecovery() {
  // F) Backend restart: persisted RENDERING without live queue work becomes retryable.
  const old = ago(10 * 60_000);
  const rendering = () => fakeStore({ clipRenderStatus: 'RENDERING', outputStyle: 'NORMAL',
    requestedClipCount: 2, clipRequestedAt: old, clipRenderStartedAt: old });
  const statusWith = async (store, dispatcher) =>
    (await new ClipSelectionService(store.prisma, {}, dispatcher).getAnalysis('vid')).clipRequest.status;

  assert.equal(await statusWith(rendering(), fakeDispatcher(true)), 'RENDERING',
    'an active queue job is never recovered or duplicated');
  assert.equal(await statusWith(rendering(), fakeDispatcher(null)), 'RENDERING',
    'unknown queue state is left alone');
  assert.equal(await statusWith(rendering(), fakeDispatcher(new Error('redis down'))), 'RENDERING');
  const fresh = fakeStore({ clipRenderStatus: 'RENDERING', outputStyle: 'NORMAL', requestedClipCount: 2,
    clipRequestedAt: ago(5_000), clipRenderStartedAt: ago(1_000) });
  assert.equal(await statusWith(fresh, fakeDispatcher(false)), 'RENDERING', 'inside the grace window');

  const stale = rendering();
  const dispatcher = fakeDispatcher(false);
  const service = new ClipSelectionService(stale.prisma, {}, dispatcher);
  const recovered = await service.getAnalysis('vid');
  assert.equal(recovered.clipRequest.status, 'FAILED');
  assert.equal(recovered.clipRequest.error, RENDER_INTERRUPTED_MESSAGE);
  assert.equal(stale.job.clipRenderStatus, 'FAILED', 'recovery is persisted');

  // POST /clip-selection can simply be sent again.
  const retried = await service.create('vid', { requestedClipCount: 2, outputStyle: 'NORMAL' });
  assert.equal(retried.clipRequest.status, 'QUEUED');
  assert.equal(dispatcher.dispatched.length, 1);
  assert.ok(stale.job.clipRequestedAt.getTime() > old.getTime(), 'a new request identity');

  // A late failure event from the interrupted request never clobbers the new one.
  await service.markFailed({ videoId: 'vid', processingJobId: 'job', requestedAt: old.toISOString() },
    new Error('stalled'));
  assert.equal(stale.job.clipRenderStatus, 'QUEUED');

  // Startup sweep also recovers a QUEUED request whose dispatch was lost.
  const lost = fakeStore({ clipRenderStatus: 'QUEUED', outputStyle: 'NORMAL', requestedClipCount: 1,
    clipRequestedAt: old });
  await new ClipSelectionService(lost.prisma, {}, fakeDispatcher(false)).recoverStaleRenders();
  assert.equal(lost.job.clipRenderStatus, 'FAILED');

  // Queue redelivery after a restart: a RENDERING request resumes and completes.
  const usable = Array.from({ length: 3 }, (_, index) => candidate(`r${index}`, 80 - index, index));
  const redelivered = fakeStore({ clipRenderStatus: 'RENDERING', outputStyle: 'NORMAL',
    requestedClipCount: 2, maxClipCount: 8, clipRequestedAt: old, clipRenderStartedAt: old },
  { candidates: usable });
  const exported = [];
  const worker = new ClipSelectionService(redelivered.prisma,
    { export: async (_video, item) => { exported.push(item.id); } }, fakeDispatcher(true));
  await worker.processRequest({ videoId: 'vid', processingJobId: 'job',
    requestedAt: new Date(old.getTime() + 1).toISOString() });
  assert.deepEqual(exported, [], 'a superseded request is skipped');
  await worker.processRequest({ videoId: 'vid', processingJobId: 'job', requestedAt: old.toISOString() });
  assert.deepEqual(exported, ['r0', 'r1']);
  assert.equal(redelivered.job.clipRenderStatus, 'COMPLETED');
  assert.deepEqual(redelivered.job.selectedCandidateIds, ['r0', 'r1']);
  await worker.processRequest({ videoId: 'vid', processingJobId: 'job', requestedAt: old.toISOString() });
  assert.deepEqual(exported, ['r0', 'r1'], 'a completed request is not processed twice');
}

async function testInfrastructureFailureStopsSelection() {
  const requestedAt = new Date();
  const store = fakeStore({ outputStyle: 'AI_EDITED', requestedClipCount: 2,
    maxClipCount: 8, clipRenderStatus: 'QUEUED', clipRequestedAt: requestedAt },
  { candidates: [candidate('good0', 90, 0), candidate('good1', 80, 1)] });
  let attempts = 0;
  const exporter = { export: async () => {
    attempts++;
    throw new ClipInfrastructureError('PERSISTENCE_FAILED', 'unique object key');
  } };
  const service = new ClipSelectionService(store.prisma, exporter);
  await assert.rejects(() => service.processRequest({ videoId: 'vid',
    processingJobId: 'job', requestedAt: requestedAt.toISOString() }),
  (error) => error instanceof ClipInfrastructureError &&
    error.failureType === 'PERSISTENCE_FAILED');
  assert.equal(attempts, 2, 'in-flight work settles without backfilling a persistence failure');
  assert.equal(store.job.clipRenderStatus, 'RENDERING');
  assert.equal(store.job.telemetry.clipSelection, undefined,
    'infrastructure failure cannot become a content shortfall');
}

async function main() {
  testDurationMatrix();
  testCountValidation();
  testSelectionMatrix();
  testDedupAndUsability();
  testExpansionOrdering();
  testCleanCardsAndAiMode();
  testPlatformAwareEditing();
  await testCreateFlow();
  await testConcurrentRenderPool();
  await testStrictCountLongSourceMatrix();
  await testCanonicalTemplateCountMatrix();
  await testPostRenderCandidateExpansion();
  await testExplicitDeliveryShortfall();
  await testVariantResults();
  await testIdempotentRequests();
  await testStaleRenderRecovery();
  await testInfrastructureFailureStopsSelection();
  console.log(JSON.stringify({ clipSelectionFlow: true, jobLevelAiModeLabel: true,
    variantsCoexist: true, idempotentRequests: true, staleRenderRecovery: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
