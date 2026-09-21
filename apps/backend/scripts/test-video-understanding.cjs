require('reflect-metadata');
const assert = require('node:assert/strict');
const {
  LlmProviderService
} = require('../dist/modules/processing/llm-provider.service');
const {
  VIDEO_UNDERSTANDING_SCHEMA,
  VideoUnderstandingService,
  parseVideoUnderstanding,
  persistVideoUnderstanding
} = require('../dist/modules/processing/video-understanding.service');
const {
  generateCandidateRanges
} = require('../dist/modules/processing/clip-candidates');
const {
  OpenAiClipJudgeService
} = require('../dist/modules/processing/openai-clip-judge.service');
const { VideosService } = require('../dist/modules/videos/videos.service');
const {
  performanceContext, createPerformanceTelemetry
} = require('../dist/modules/processing/performance-telemetry');

function result(startTime, endTime) {
  const middle = startTime + (endTime - startTime) / 2;
  return {
    summary: 'A complete explanation of a practical system and its outcome.',
    mainTopic: 'Building a dependable content system',
    contentType: 'Educational interview',
    targetAudience: 'Content creators',
    language: 'English',
    chapters: [
      {
        startTime,
        endTime: middle,
        title: 'The problem',
        summary: 'The speaker establishes the problem and its consequences.',
        topics: ['workflow'],
        importanceScore: 75
      },
      {
        startTime: middle,
        endTime,
        title: 'The solution',
        summary: 'The speaker explains a practical solution and result.',
        topics: ['automation'],
        importanceScore: 90
      }
    ],
    topics: ['workflow', 'automation'],
    keyClaims: ['A repeatable workflow reduces avoidable work.'],
    questions: ['How can creators make production repeatable?'],
    stories: ['A creator replaces a fragile manual process.'],
    importantMoments: [{
      startTime: middle,
      endTime: Math.min(endTime, middle + 2),
      title: 'Core recommendation',
      description: 'The main workflow recommendation is stated.',
      importanceScore: 95
    }]
  };
}

function chunkSummaryFrom(request) {
  const match = request.userPrompt.match(/Required range: ([0-9.]+)-([0-9.]+)/u);
  assert(match, 'summary prompt includes its required timestamp range');
  const startTime = Number(match[1]);
  const endTime = Number(match[2]);
  return {
    startTime,
    endTime,
    summary: 'Condensed evidence from this chronological transcript range.',
    topics: ['workflow'],
    keyClaims: ['A concrete workflow is described.'],
    questions: [],
    stories: [],
    importantMoments: []
  };
}

function transcriptParts(count, seconds = 10) {
  return Array.from({ length: count }, (_, position) => ({
    position,
    startTime: position * seconds,
    endTime: position * seconds + seconds,
    text: 'This timestamped section explains a useful workflow, gives concrete evidence, ' +
      'and reaches a complete point for the audience. '.repeat(3)
  }));
}

async function testStrictProviderOutput() {
  const keys = [
    'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_STYLE',
    'NVIDIA_API_KEY', 'CLIP_JUDGE_PROVIDER'
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  let url;
  let body;
  try {
    process.env.LLM_PROVIDER = 'nvidia';
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_BASE_URL = 'https://provider.invalid/v1';
    process.env.LLM_MODEL = 'test/nemotron';
    process.env.LLM_API_STYLE = 'chat_completions';
    global.fetch = async (requestUrl, options) => {
      url = requestUrl;
      body = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(result(0, 60)) } }]
        })
      };
    };
    const provider = new LlmProviderService();
    const value = await provider.generateStructured({
      schemaName: 'video_understanding',
      schema: VIDEO_UNDERSTANDING_SCHEMA,
      systemPrompt: 'Analyze.',
      userPrompt: 'Transcript.',
      maxOutputTokens: 1000
    });
    assert.equal(value.mainTopic, result(0, 60).mainTopic);
    assert.equal(url, 'https://provider.invalid/v1/chat/completions');
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(body.response_format.json_schema.schema.properties.chapters.items
      .additionalProperties, false);
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function testLongTranscriptHierarchy() {
  const calls = [];
  const parts = transcriptParts(40);
  const llm = {
    providerName: 'test',
    modelName: 'test-model',
    async generateStructured(request) {
      calls.push(request);
      return request.schemaName === 'video_understanding_chunk'
        ? chunkSummaryFrom(request)
        : result(0, parts[parts.length - 1].endTime);
    }
  };
  const savedLimit = process.env.LLM_SAFE_INPUT_CHARS;
  process.env.LLM_SAFE_INPUT_CHARS = '4000';
  try {
    const understanding = await new VideoUnderstandingService(llm).analyze(parts, 'en');
    assert.equal(understanding.chapters.length, 2);
    assert(calls.filter((call) => call.schemaName === 'video_understanding_chunk').length > 1,
      'long transcripts must use multiple bounded summaries');
    assert.equal(calls[calls.length - 1].schemaName, 'video_understanding');
    assert(calls.every((call) => call.userPrompt.length < 4000),
      'every hierarchical request remains under the configured safe input size');
  } finally {
    if (savedLimit === undefined) delete process.env.LLM_SAFE_INPUT_CHARS;
    else process.env.LLM_SAFE_INPUT_CHARS = savedLimit;
  }
}

async function testCompactOnlineWholeVideoInput() {
  const calls = [];
  const parts = transcriptParts(500, 10);
  const rawTextChars = parts.reduce((sum, part) => sum + part.text.length, 0);
  const llm = {
    providerName: 'test',
    modelName: 'test-model',
    async generateStructured(request) {
      calls.push(request);
      return result(0, parts[parts.length - 1].endTime);
    }
  };
  const savedLimit = process.env.LLM_SAFE_INPUT_CHARS;
  const savedOnlineLimit = process.env.LLM_WHOLE_VIDEO_INPUT_CHARS;
  process.env.LLM_SAFE_INPUT_CHARS = '200000';
  delete process.env.LLM_WHOLE_VIDEO_INPUT_CHARS;
  try {
    await new VideoUnderstandingService(llm).analyze(parts, 'en');
    assert.equal(calls.length, 1, 'a transcript within the safe-input limit takes the single-shot path');
    const request = calls[0];
    assert.ok(rawTextChars > 80000, 'fixture must be large enough to exercise compaction');
    assert.ok(request.userPrompt.length < 18000,
      'the ONLINE request must send compact evidence, not the raw timestamped transcript');
    assert.ok(request.userPrompt.length < rawTextChars * 0.25,
      'compact ONLINE input must be materially smaller than the raw transcript text');
    assert.ok(request.maxOutputTokens < 10000,
      'requestedMaxOutputTokens must be reduced from the prior 10000 default');
    assert.ok(request.maxOutputTokens <= 5000, 'wholeVideoUnderstanding must not request a large output budget');
    assert.equal(request.schema.properties.chapters.maxItems, 10,
      'the ONLINE schema must be smaller than the 16-chapter maximum used by VIDEO_UNDERSTANDING_SCHEMA');
    assert.ok(request.local, 'the local/offline fallback request must still be supplied');
  } finally {
    if (savedLimit === undefined) delete process.env.LLM_SAFE_INPUT_CHARS;
    else process.env.LLM_SAFE_INPUT_CHARS = savedLimit;
    if (savedOnlineLimit === undefined) delete process.env.LLM_WHOLE_VIDEO_INPUT_CHARS;
    else process.env.LLM_WHOLE_VIDEO_INPUT_CHARS = savedOnlineLimit;
  }
}

async function testWholeVideoUnderstandingCanBeDisabled() {
  const calls = [];
  const llm = {
    providerName: 'test', modelName: 'test-model',
    async generateStructured(request) { calls.push(request); return result(0, 60); }
  };
  const saved = process.env.WHOLE_VIDEO_UNDERSTANDING_ENABLED;
  process.env.WHOLE_VIDEO_UNDERSTANDING_ENABLED = 'false';
  try {
    const service = new VideoUnderstandingService(llm);
    const understanding = await service.analyzeWithFallback(transcriptParts(6), 'en');
    assert.equal(calls.length, 0, 'a disabled whole-video understanding role must never call the model');
    assert.equal(service.providerName, 'deterministic');
    assert.ok(understanding.chapters.length > 0,
      'the deterministic extractive analysis must still produce usable chapters');
  } finally {
    if (saved === undefined) delete process.env.WHOLE_VIDEO_UNDERSTANDING_ENABLED;
    else process.env.WHOLE_VIDEO_UNDERSTANDING_ENABLED = saved;
  }
}

async function testRetryFallbackAndContext() {
  let attempts = 0;
  const retryLlm = {
    providerName: 'test',
    modelName: 'test-model',
    async generateStructured() {
      attempts += 1;
      if (attempts === 1) throw new Error('transient provider failure');
      return result(0, 60);
    }
  };
  const retried = await new VideoUnderstandingService(retryLlm)
    .analyze(transcriptParts(6), 'en');
  assert.equal(attempts, 2);
  assert.equal(retried.mainTopic, result(0, 60).mainTopic);

  const failing = new VideoUnderstandingService({
    providerName: 'test',
    modelName: 'test-model',
    async generateStructured() { throw new Error('provider unavailable'); }
  });
  const fallback = await failing.analyzeWithFallback(transcriptParts(6), 'en');
  assert.ok(fallback.summary.length > 0);
  assert.equal(failing.providerName, 'deterministic');
  assert.ok(fallback.chapters.length > 0);
  const analyzedChunks = transcriptParts(6).map((part) => ({
    ...part,
    duration: part.endTime - part.startTime,
    wordCount: part.text.split(/\s+/u).length,
    analysis: {
      questionCount: 0,
      exclamationCount: 0,
      keywordDensity: 12,
      averageSentenceLength: 12,
      speechRate: 145,
      informationDensity: 75,
      readabilityScore: 70
    }
  }));
  const heuristic = generateCandidateRanges('video', analyzedChunks);
  assert(heuristic.length > 0);
  assert(heuristic.every((candidate) => candidate.judgeSource === 'HEURISTIC_FALLBACK'));

  const contextual = generateCandidateRanges('video', analyzedChunks, {
    mainTopic: retried.mainTopic,
    topics: retried.topics,
    chapters: retried.chapters
  });
  assert(contextual[0].chapterSummary);
  assert.equal(contextual[0].overallVideoTopic, retried.mainTopic);
  assert(contextual[0].neighboringTranscriptContext !== undefined);
  let judgeRequest;
  const judge = new OpenAiClipJudgeService({
    providerName: 'nvidia',
    modelName: 'test/nemotron',
    isConfigured: () => true,
    async generateStructured(request) {
      judgeRequest = request;
      return { candidates: [{
        hooks: [
          { text: 'A dependable workflow turns evidence into a complete result.', style: 'strong claim' },
          { text: 'How does concrete evidence make a workflow dependable?', style: 'question' },
          { text: 'A fragile workflow needs evidence to reach a useful result.', style: 'problem/solution' }
        ],
        title: 'A Dependable Content Workflow',
        synopsis: 'The clip explains a useful workflow with concrete evidence.\n\nThat evidence supports the workflow as it develops.\n\nThe complete result shows why the concrete evidence matters.',
        caption: 'A useful workflow becomes dependable with concrete evidence.',
        hashtags: ['#Workflow', '#ContentSystem', '#PracticalAdvice', '#ConcreteEvidence',
          '#CreatorProcess']
      }] };
    }
  });
  const judged = await judge.judgeCandidates(contextual.slice(0, 1));
  const payload = JSON.parse(judgeRequest.userPrompt)[0];
  assert.equal(payload.exactClipTranscript, contextual[0].transcriptText);
  assert.equal(payload.chapterSummary, contextual[0].chapterSummary);
  assert.equal(payload.previousNearbyContext, contextual[0].previousTranscriptContext);
  assert.equal(payload.nextNearbyContext, contextual[0].nextTranscriptContext);
  assert.equal(payload.overallTopic, contextual[0].overallVideoTopic);
  assert.equal(judged[0].judgeSource, 'LLM');
  assert.equal(judged[0].alternateHooks.length, 2);
  assert.equal(judged[0].hooks.length, 3);
  assert.equal(judged[0].hashtags.length, 5);
  assert.equal(judged[0].synopsis.split(/\n\n/u).length, 3);
}

async function testSchemaTimestampsPersistenceAndApi() {
  const valid = result(0, 60);
  assert.deepEqual(parseVideoUnderstanding(valid, 0, 60), valid);
  assert.throws(() => parseVideoUnderstanding({ ...valid, unexpected: true }, 0, 60),
    /strict schema/);
  // A tiny boundary overlap (model rounding/drift) is now normalized rather than rejected.
  const tinyOverlap = parseVideoUnderstanding({
    ...valid,
    chapters: [
      valid.chapters[0],
      { ...valid.chapters[1], startTime: valid.chapters[0].endTime - 1 }
    ]
  }, 0, 60);
  assert.equal(tinyOverlap.chapters[0].endTime, tinyOverlap.chapters[1].startTime);
  // An out-of-bounds chapter timestamp (model rounding at the video edge) is clamped, not rejected.
  const clamped = parseVideoUnderstanding({
    ...valid,
    chapters: [{ ...valid.chapters[0], endTime: 61 }]
  }, 0, 60);
  assert.equal(clamped.chapters[0].endTime, 60);

  const calls = [];
  const prisma = {
    videoUnderstanding: {
      async upsert(args) {
        calls.push(args);
        return { id: 'understanding', videoId: 'video' };
      }
    }
  };
  await persistVideoUnderstanding(prisma, 'video', valid, 'nvidia', 'test/nemotron');
  await persistVideoUnderstanding(prisma, 'video', valid, 'nvidia', 'test/nemotron');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.where), [{ videoId: 'video' }, { videoId: 'video' }]);
  assert.deepEqual(calls[1].update.chapters.deleteMany, {});
  assert.equal(calls[1].update.chapters.create.length, valid.chapters.length);

  const stored = {
    id: 'understanding',
    videoId: 'video',
    ...valid,
    chapters: valid.chapters.map((chapter, position) => ({ id: String(position), position, ...chapter }))
  };
  const service = new VideosService({
    video: { findUnique: async () => ({ understanding: stored }) }
  }, {}, {});
  assert.equal(await service.getUnderstanding('video'), stored);
}

function makeChapter(startTime, endTime, overrides = {}) {
  return {
    startTime,
    endTime,
    title: 'Chapter title',
    summary: 'A chapter summary describing what happens in this range.',
    topics: ['topic'],
    importanceScore: 60,
    ...overrides
  };
}

function makeUnderstanding(chapters) {
  return {
    summary: 'A summary of the whole video covering its main points in full.',
    mainTopic: 'Main topic',
    contentType: 'Educational interview',
    targetAudience: 'General audience',
    language: 'English',
    chapters,
    topics: ['topic'],
    keyClaims: ['A claim.'],
    questions: ['A question?'],
    stories: ['A story.'],
    importantMoments: []
  };
}

function withTelemetry(fn) {
  const performance = createPerformanceTelemetry();
  return performanceContext.run(performance, () => { fn(); return performance; });
}

async function testChapterNormalization() {
  // Already-valid chronological, non-overlapping chapters pass through unchanged.
  {
    const chapters = [makeChapter(0, 20), makeChapter(20, 40), makeChapter(40, 60)];
    const performance = withTelemetry(() => {
      const parsed = parseVideoUnderstanding(makeUnderstanding(chapters), 0, 60);
      assert.deepEqual(parsed.chapters.map((chapter) => [chapter.startTime, chapter.endTime]),
        [[0, 20], [20, 40], [40, 60]]);
    });
    assert.equal(performance.wholeVideoNormalizationApplied, false);
    assert.equal(performance.chapterCountBefore, 3);
    assert.equal(performance.chapterCountAfter, 3);
    assert.equal(performance.chaptersReordered, false);
    assert.equal(performance.chapterOverlapRepairs, 0);
    assert.equal(performance.chapterBoundaryClamps, 0);
  }

  // Out-of-order chapters are sorted chronologically instead of rejected.
  {
    const chapters = [makeChapter(40, 60), makeChapter(0, 20), makeChapter(20, 40)];
    const performance = withTelemetry(() => {
      const parsed = parseVideoUnderstanding(makeUnderstanding(chapters), 0, 60);
      assert.deepEqual(parsed.chapters.map((chapter) => [chapter.startTime, chapter.endTime]),
        [[0, 20], [20, 40], [40, 60]]);
    });
    assert.equal(performance.chaptersReordered, true);
    assert.equal(performance.wholeVideoNormalizationApplied, true);
  }

  // A tiny overlap (boundary noise) is trimmed rather than rejecting the whole result.
  {
    const chapters = [makeChapter(0, 30), makeChapter(29, 60)];
    const performance = withTelemetry(() => {
      const parsed = parseVideoUnderstanding(makeUnderstanding(chapters), 0, 60);
      assert.deepEqual(parsed.chapters.map((chapter) => [chapter.startTime, chapter.endTime]),
        [[0, 30], [30, 60]]);
    });
    assert.equal(performance.chapterOverlapRepairs, 1);
    assert.equal(performance.wholeVideoNormalizationApplied, true);
  }

  // A large, genuinely contradictory overlap cannot be safely repaired and is rejected.
  {
    const chapters = [makeChapter(0, 30), makeChapter(15, 45)];
    assert.throws(() => parseVideoUnderstanding(makeUnderstanding(chapters), 0, 60),
      /large invalid overlap/);
  }

  // Timestamps outside the video bounds are clamped rather than rejecting the chapter.
  {
    const chapters = [makeChapter(-5, 65)];
    const performance = withTelemetry(() => {
      const parsed = parseVideoUnderstanding(makeUnderstanding(chapters), 0, 60);
      assert.deepEqual(parsed.chapters.map((chapter) => [chapter.startTime, chapter.endTime]),
        [[0, 60]]);
    });
    assert.equal(performance.chapterBoundaryClamps, 1);
    assert.equal(performance.wholeVideoNormalizationApplied, true);
  }

  // Duplicate and zero-length chapters are dropped deterministically.
  {
    const chapters = [makeChapter(0, 20), makeChapter(0, 20), makeChapter(20, 20), makeChapter(20, 40)];
    const performance = withTelemetry(() => {
      const parsed = parseVideoUnderstanding(makeUnderstanding(chapters), 0, 60);
      assert.deepEqual(parsed.chapters.map((chapter) => [chapter.startTime, chapter.endTime]),
        [[0, 20], [20, 40]]);
    });
    assert.equal(performance.chapterCountBefore, 4);
    assert.equal(performance.chapterCountAfter, 2);
    assert.equal(performance.wholeVideoNormalizationApplied, true);
  }

  // When nothing survives normalization, the whole result is rejected (deterministic fallback).
  {
    const chapters = [makeChapter(20, 20), makeChapter(30, 30)];
    assert.throws(() => parseVideoUnderstanding(makeUnderstanding(chapters), 0, 60),
      /no valid chapters/);
  }
}

async function testWholeVideoNormalizationPreservesLunaResult() {
  const chapters = [makeChapter(30, 60), makeChapter(0, 30)];
  const llm = {
    providerName: 'nvidia',
    modelName: 'test/nemotron',
    async generateStructured() { return makeUnderstanding(chapters); }
  };
  const service = new VideoUnderstandingService(llm);
  const understanding = await service.analyzeWithFallback(transcriptParts(6), 'en');
  assert.equal(service.providerName, 'nvidia',
    'an out-of-order but repairable Luna chapter set must not fall back to the deterministic path');
  assert.deepEqual(understanding.chapters.map((chapter) => [chapter.startTime, chapter.endTime]),
    [[0, 30], [30, 60]]);

  const contradictoryLlm = {
    providerName: 'nvidia',
    modelName: 'test/nemotron',
    async generateStructured() {
      return makeUnderstanding([makeChapter(0, 30), makeChapter(15, 45)]);
    }
  };
  const fallbackService = new VideoUnderstandingService(contradictoryLlm);
  const fallback = await fallbackService.analyzeWithFallback(transcriptParts(6), 'en');
  assert.equal(fallbackService.providerName, 'deterministic',
    'a genuinely contradictory chapter set must still fall back to the deterministic path');
  assert.ok(fallback.chapters.length > 0);
}

async function main() {
  await testStrictProviderOutput();
  await testLongTranscriptHierarchy();
  await testCompactOnlineWholeVideoInput();
  await testWholeVideoUnderstandingCanBeDisabled();
  await testRetryFallbackAndContext();
  await testSchemaTimestampsPersistenceAndApi();
  await testChapterNormalization();
  await testWholeVideoNormalizationPreservesLunaResult();
  console.log(JSON.stringify({
    strictStructuredOutput: true,
    hierarchicalLongTranscript: true,
    compactOnlineWholeVideoInput: true,
    wholeVideoUnderstandingCanBeDisabled: true,
    fallbackPreservesCandidates: true,
    chapterTimestampsValidated: true,
    chapterNormalization: true,
    wholeVideoNormalizationPreservesLunaResult: true,
    retryAndIdempotency: true,
    contextualJudgePayload: true,
    understandingApi: true
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

