require('reflect-metadata');
const assert = require('node:assert/strict');
const {
  calculateContentPotential,
  calculateClipRecommendation,
  clampScore,
  generateCandidateRanges,
  isEligibleForCreativeGeneration,
  maximumClipCountForDuration,
  recommendationTierForScore,
  selectDiversifiedCandidates,
  suppressOverlapAndRank
} = require('../dist/modules/processing/clip-candidates');
const {
  buildContentFingerprint,
  calculateGeneratedHookScore,
  canReuseGeneratedContent,
  CLIP_CONTENT_PROMPT_VERSION,
  CLIP_JUDGE_MODEL,
  normalizedHookSimilarity,
  OpenAiClipJudgeService
} = require('../dist/modules/processing/openai-clip-judge.service');
const { VideosService } = require('../dist/modules/videos/videos.service');
const { VideosController, parseClipSelection } = require('../dist/modules/videos/videos.controller');
const { ClipExportService } = require('../dist/modules/videos/clip-export.service');
const { LlmProviderError } = require('../dist/modules/processing/llm-provider.service');

const analysis = (overrides = {}) => ({
  questionCount: 0, exclamationCount: 0, keywordDensity: 12,
  averageSentenceLength: 10, speechRate: 145,
  informationDensity: 76, readabilityScore: 72, ...overrides
});
const chunk = (position, startTime, endTime, text, metricOverrides = {}) => ({
  position, startTime, endTime, duration: endTime - startTime, text,
  wordCount: text.split(/\s+/u).length, analysis: analysis(metricOverrides)
});
const judgeScore = () => ({
  hookScore: 86, standaloneScore: 82, payoffScore: 83, flowScore: 81,
  informationScore: 88, retentionScore: 84, shareabilityScore: 80,
  reject: false,
  reason: 'A strong standalone explanation with a clear payoff.', rejectionReason: '',
  clipAnalysis: {
    mainTopic: 'A practical lesson',
    mainClaim: 'The lesson connects a practical idea to a measurable result.',
    strongestFact: 'The result is measurable.',
    questionOrProblem: 'How does the practical idea lead to the result?',
    tensionOrConflict: 'The idea needs useful context before the result is clear.',
    surprisingPoint: 'A small practical idea can produce a complete result.',
    emotionalTone: 'Clear and constructive',
    payoffOrConclusion: 'The practical lesson produces a measurable result.',
    contentType: 'Educational insight',
    viewerValue: 'A useful lesson that can be applied in practice.'
  },
  hookCandidates: [
    ['This practical lesson reveals why the measurable result matters.', 'strong claim',
      { relevance: 92, clarity: 88, curiosity: 85, payoffAlignment: 90, specificity: 86 }],
    ['How does the practical idea produce a measurable result?', 'question',
      { relevance: 88, clarity: 87, curiosity: 86, payoffAlignment: 85, specificity: 82 }],
    ['A measurable result turns this lesson into useful evidence.', 'surprising fact',
      { relevance: 86, clarity: 86, curiosity: 81, payoffAlignment: 84, specificity: 84 }],
    ['The problem is context; the solution is a complete practical lesson.', 'problem/solution',
      { relevance: 84, clarity: 84, curiosity: 78, payoffAlignment: 84, specificity: 80 }],
    ['Useful context connects the idea to a complete result.', 'educational/value',
      { relevance: 82, clarity: 86, curiosity: 76, payoffAlignment: 82, specificity: 78 }],
    ['Without the practical detail, the measurable result is unclear.', 'stakes/consequence',
      { relevance: 80, clarity: 84, curiosity: 78, payoffAlignment: 80, specificity: 80 }],
    ['The practical idea looks small, but its result is measurable.', 'contradiction',
      { relevance: 82, clarity: 82, curiosity: 81, payoffAlignment: 82, specificity: 79 }],
    ['See how useful context turns an idea into a complete result.', 'curiosity',
      { relevance: 84, clarity: 81, curiosity: 84, payoffAlignment: 84, specificity: 79 }],
    ['Apply this practical lesson when your result needs clear evidence.', 'warning',
      { relevance: 80, clarity: 85, curiosity: 76, payoffAlignment: 82, specificity: 81 }],
    ['A complete result starts with one practical detail.', 'story setup',
      { relevance: 81, clarity: 86, curiosity: 79, payoffAlignment: 83, specificity: 78 }]
  ].map(([hook, strategy, scores]) => ({ hook, strategy, scores })),
  captionCandidates: [
    'A clear lesson becomes useful when the result is measurable.',
    'Practical context makes this result easier to understand.',
    'One useful idea connects directly to a complete result.'
  ],
  titleCandidates: ['The Practical Lesson Behind the Result',
    'How a Practical Idea Produces Results', 'Useful Context, Measurable Result'],
  hashtagCandidates: ['#PracticalLesson', '#MeasurableResult', '#ContentInsight', '#UsefulContext',
    '#ClearIdeas', '#CreatorWorkflow', '#ShortFormLearning', '#PracticalAdvice',
    '#ContentStrategy', '#KeyTakeaway', '#EducationalContent', '#IdeaToResult',
    '#AppliedLearning', '#UsefulEvidence', '#ClearThinking'],
  synopsisCandidates: [
    'The clip explains a practical lesson with useful context.\n\nThe idea connects to a measurable result.\n\nThat measurable result makes the lesson useful.',
    'A practical idea provides the context for this clip.\n\nThe lesson develops toward a measurable result.\n\nThe result shows why the idea matters.'
  ],
  title: 'The Practical Lesson Behind the Result',
  synopsis: 'The clip explains a practical lesson with useful context.\n\nThe idea connects to a measurable result.\n\nThat measurable result makes the lesson useful.',
  caption: 'A clear lesson becomes useful when the result is measurable.',
  hashtags: ['#PracticalLesson', '#MeasurableResult', '#ContentInsight', '#UsefulContext',
    '#ClearIdeas'],
  cta: 'Which lesson will you apply first?',
  topic: 'A practical lesson',
  contentType: 'Educational insight',
  whySelected: 'The clip has a clear lesson, useful detail, and a complete result.'
});

function testWeightedScoreMath() {
  assert.equal(calculateContentPotential({
    hookScore: 100, standaloneScore: 0, payoffScore: 0, flowScore: 0,
    informationScore: 0, retentionScore: 0, shareabilityScore: 0
  }), 18);
  assert.equal(calculateContentPotential({
    hookScore: 100, standaloneScore: 100, payoffScore: 100, flowScore: 100,
    informationScore: 100, retentionScore: 100, shareabilityScore: 100
  }), 100);
  assert.equal(calculateContentPotential({
    hookScore: 200, standaloneScore: -10, payoffScore: Number.NaN, flowScore: 0,
    informationScore: 0, retentionScore: 0, shareabilityScore: 0
  }), 18);
  assert.equal(clampScore(Number.POSITIVE_INFINITY), 0);
  assert.equal(calculateGeneratedHookScore({
    relevance: 100, clarity: 80, curiosity: 60, payoffAlignment: 40, specificity: 20
  }), 64);
}

function testRecommendationPolicy() {
  assert.equal(maximumClipCountForDuration(600), 6);
  assert.equal(maximumClipCountForDuration(601), 8);
  assert.equal(maximumClipCountForDuration(899), 8);
  assert.equal(maximumClipCountForDuration(900), 12);
  assert.equal(maximumClipCountForDuration(3600), 12);
  assert.equal(maximumClipCountForDuration(3601), 20);
  assert.equal(maximumClipCountForDuration(7200), 20);
  assert.equal(maximumClipCountForDuration(7201), 0);
  assert.equal(recommendationTierForScore(75), 'PRIMARY');
  assert.equal(recommendationTierForScore(74.99), 'SECONDARY');
  assert.equal(recommendationTierForScore(59.99), null);
  // creativeGeneration is only worth paying for when a candidate could still be recommended.
  assert.equal(isEligibleForCreativeGeneration({ reject: false, contentPotential: 75 }), true);
  assert.equal(isEligibleForCreativeGeneration({ reject: false, contentPotential: 60 }), true);
  assert.equal(isEligibleForCreativeGeneration({ reject: false, contentPotential: 59.99 }), false,
    'below SECONDARY_CLIP_SCORE must skip creativeGeneration');
  assert.equal(isEligibleForCreativeGeneration({ reject: true, contentPotential: 90 }), false,
    'a rejected candidate must skip creativeGeneration regardless of score');
  const recommendation = calculateClipRecommendation([
    ...Array.from({ length: 5 }, () => ({ contentPotential: 80, reject: false })),
    ...Array.from({ length: 3 }, () => ({ contentPotential: 65, reject: false })),
    { contentPotential: 40, reject: false }
  ], 900);
  assert.deepEqual(recommendation, {
    recommendedClipCount: 5,
    maximumClipCount: 12,
    primaryCount: 5,
    secondaryCount: 3,
    candidatesDiscovered: 8
  });
  const ranked = Array.from({ length: 9 }, (_, index) => ({
    id: String(index), startTime: index * 70, endTime: index * 70 + 30,
    transcriptText: `Distinct clip topic ${index} with a complete useful payoff.`,
    topic: `topic-${index}`,
    overallScore: index < 5 ? 90 - index : index < 8 ? 70 - index : 55,
    reject: false
  }));
  assert.deepEqual(selectDiversifiedCandidates(ranked, 8).map(({ id }) => id),
    ['0', '1', '2', '3', '4', '5', '6', '7'],
    'a request above the recommendation uses ranked SECONDARY clips but excludes weak clips');
}

async function testGenerationAndRanking() {
  const tooShort = generateCandidateRanges('small-video', [
    chunk(0, 0, 12, 'How can one small idea become an amazing result? Start with a clear promise.')
  ]);
  assert.equal(tooShort.length, 0, 'ranges below 15 seconds must not become candidates');
  const small = generateCandidateRanges('small-video', Array.from({ length: 6 }, (_, position) =>
    chunk(position, position * 5, position * 5 + 5,
      `Lesson ${position} explains one practical idea with a clear example, useful context, and a complete result.`)));
  assert.ok(small.length > 0, 'a short valid video should create candidates');
  assert.ok(small.every(({ duration }) => duration >= 15 && duration <= 60));
  const longChunks = Array.from({ length: 36 }, (_, position) => chunk(
    position, position * 5, position * 5 + 5,
    position % 5 === 0
      ? `Why does lesson ${position} change everything? Here is the surprising answer and why it matters!`
      : `Lesson ${position} gives a clear practical detail that viewers can use today, because the result is measurable.`,
    { questionCount: position % 5 === 0 ? 1 : 0, exclamationCount: position % 5 === 0 ? 1 : 0 }
  ));
  const generated = generateCandidateRanges('long-video', longChunks);
  assert.ok(generated.length >= 40 && generated.length <= 100, 'long videos should create 40-100 ranges');
  assert.ok(generated.every((candidate) => candidate.duration >= 15 && candidate.duration <= 120));
  assert.equal(new Set(generated.map(({ rangeKey }) => rangeKey)).size, generated.length);
  assert.ok(generated.some((candidate) => candidate.transcriptText.includes('Lesson 1')),
    'nearby semantic chunks should be merged');
  for (const candidate of generated) {
    for (const field of ['hookScore', 'standaloneScore', 'payoffScore', 'flowScore',
      'informationScore', 'retentionScore', 'shareabilityScore', 'overallScore']) {
      assert.ok(Number.isFinite(candidate[field]) && candidate[field] >= 0 && candidate[field] <= 100);
    }
  }
  const primary = { ...generated[0], reject: false, overallScore: 95 };
  const duplicate = { ...generated[0], rangeKey: 'duplicate',
    startTime: primary.startTime + 1, endTime: primary.endTime + 1,
    overallScore: 80, reject: false };
  const ranked = suppressOverlapAndRank([duplicate, primary]);
  assert.equal(ranked[0].rangeKey, primary.rangeKey);
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].reject, true);
  assert.match(ranked[1].rejectionReason, /Duplicate or overlapping/);
  return generated;
}

async function testJudgeFallbackAndStrictRequest(candidates) {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const savedEnvironment = Object.fromEntries([
    'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_API_STYLE',
    'OPENAI_API_KEY', 'NVIDIA_API_KEY', 'LLM_MAX_RETRIES', 'LLM_RETRY_BASE_DELAY_MS'
  ].map((key) => [key, process.env[key]]));
  const originalBatch = process.env.CLIP_JUDGE_BATCH_SIZE;
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL = CLIP_JUDGE_MODEL;
  process.env.LLM_API_STYLE = 'responses';
  delete process.env.NVIDIA_API_KEY;
  process.env.CLIP_JUDGE_BATCH_SIZE = '2';
  process.env.LLM_MAX_RETRIES = '2';
  process.env.LLM_RETRY_BASE_DELAY_MS = '1000';
  try {
    let requestBody;
    let generatedFetches = 0;
    global.fetch = async (_url, options) => {
      generatedFetches += 1;
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({
        output_text: JSON.stringify({ candidates: JSON.parse(requestBody.input).map(() => judgeScore()) })
      }) };
    };
    const generatedJudge = new OpenAiClipJudgeService();
    const judged = await generatedJudge.judgeCandidates(candidates.slice(0, 2));
    await generatedJudge.judgeCandidates(candidates.slice(0, 2));
    assert.equal(generatedFetches, 2, 'one request per package; the second run must reuse both fingerprints');
    assert.equal(requestBody.model, CLIP_JUDGE_MODEL);
    assert.equal(CLIP_JUDGE_MODEL, 'gpt-5.6-luna');
    assert.equal(requestBody.text.format.strict, true);
    assert.equal(requestBody.store, false);
    const supplied = JSON.parse(requestBody.input);
    assert.equal(supplied.length, 1);
    assert.ok(candidates.slice(0, 2).some(candidate => candidate.transcriptText === supplied[0].exactClipTranscript));
    assert.ok('previousContext' in supplied[0] && 'nextContext' in supplied[0]);
    assert.ok(supplied[0].existingCandidateFeatures);
    assert.ok(judged.every(({ judgeSource }) => judgeSource === 'GPT_5_4_MINI'));
    assert.ok(judged.every((candidate) =>
      candidate.overallScore === calculateContentPotential(candidate)));
    assert.ok(judged.every((candidate) =>
      candidate.contentPotential === candidate.overallScore));
    assert.ok(judged.every((candidate) => candidate.bestHook &&
      !candidate.bestHook.endsWith('...') && candidate.bestHook !== candidate.transcriptText));
    assert.ok(judged.every((candidate) => candidate.bestHook.toLowerCase()
      .split(/[^a-z0-9]+/u).some((word) =>
        word.length >= 4 && candidate.transcriptText.toLowerCase().includes(word))));
    assert.ok(judged.every((candidate) => candidate.alternateHooks.length === 2));
    assert.ok(judged.every((candidate) => candidate.hooks.length === 3));
    assert.ok(judged.every((candidate) =>
      new Set(candidate.hooks.map(({ style }) => style)).size === 3));
    assert.ok(judged.every((candidate) => candidate.title && candidate.synopsis &&
      candidate.caption && candidate.hashtags.length === 5 &&
      candidate.synopsis.split(/\n\n/u).length === 3 && candidate.cta));
    assert.equal(judged[0].generatedHookScore, 88.5);
    assert.ok(judged.every((candidate) => candidate.selectedHookStrategy));
    assert.ok(normalizedHookSimilarity(judged[0].bestHook, judged[1].bestHook) < 0.72);
    assert.ok(judged.every((candidate) =>
      [candidate.bestHook, ...candidate.alternateHooks].every((hook) => /[.!?]$/u.test(hook))));
    assert.ok(judged.every((candidate) => candidate.sourceHookScore === candidate.hookScore));
    let partialIndex = 0;
    global.fetch = async () => {
      const item = judgeScore();
      if (partialIndex++ === 2) delete item.clipAnalysis;
      return { ok: true, json: async () => ({ output_text: JSON.stringify({ candidates: [item] }) }) };
    };
    const partialPackages = await new OpenAiClipJudgeService().judgeCandidates(candidates.slice(0, 5));
    assert.equal(partialPackages.filter(item => item.generationStatus === 'GENERATED').length, 4,
      'one invalid creative package must retain the other four expensive results');
    assert.equal(partialPackages[2].generationStatus, 'FALLBACK');
    global.fetch = async () => ({ ok: true, json: async () => ({ output_text: 'not json' }) });
    const fallbackInput = candidates.slice(0, 2);
    const fallback = await new OpenAiClipJudgeService().judgeCandidates(fallbackInput);
    assert.ok(fallback.every(({ judgeSource }) => judgeSource === 'HEURISTIC_FALLBACK'));
    assert.ok(fallback.every(({ generationStatus }) => generationStatus === 'FALLBACK'));
    assert.ok(fallback.every(({ fallbackReason }) =>
      fallbackReason.startsWith('MALFORMED_RESPONSE_FAILURE:')));
    assert.ok(fallback.every(({ bestHook, alternateHooks }) =>
       bestHook && !bestHook.endsWith('...') && alternateHooks.length === 2));
    assert.ok(fallback.every(({ bestHook }) => !/The key insight/iu.test(bestHook)));
    assert.ok(fallback.every((candidate) => candidate.title && candidate.synopsis &&
      candidate.caption && candidate.cta && candidate.selectedHookStrategy &&
      candidate.hooks.length === 3 && candidate.hashtags.length === 5 &&
      candidate.synopsis.split(/\n\n/u).length === 3));
    assert.deepEqual(fallback.map(({ heuristicScore }) => heuristicScore),
      fallbackInput.map(({ heuristicScore }) => heuristicScore));
    let unavailableAttempts = 0;
    const retryDelays = [];
    global.setTimeout = (callback, delay) => {
      retryDelays.push(delay);
      callback();
      return 0;
    };
    global.fetch = async () => {
      unavailableAttempts += 1;
      return { ok: false, status: 503, text: async () => 'unavailable' };
    };
    const providerFallback = await new OpenAiClipJudgeService().judgeCandidates(fallbackInput);
    assert.ok(providerFallback.every(({ fallbackReason }) =>
      fallbackReason.startsWith('PROVIDER_5XX_FAILURE:')));
    assert.equal(unavailableAttempts, 4, 'at most two bounded attempts are made per package');
    assert.equal(retryDelays.length, 2, 'each package receives only one transient retry');
    assert.ok(retryDelays.every(delay => delay >= 1000 && delay <= 1750),
      'retry delay uses one-second exponential base plus bounded jitter');
    global.setTimeout = originalSetTimeout;
    global.fetch = async (_url, options) => ({ ok: true, json: async () => ({
      output_text: JSON.stringify({ candidates: JSON.parse(JSON.parse(options.body).input).map(() => ({
        ...judgeScore(),
        hookCandidates: judgeScore().hookCandidates.map((hook, index) => index
          ? hook
          : { ...hook, hook: 'This practical lesson guarantees a 900 percent result.' })
      })) })
    }) });
    const copiedOpeningFallback = await new OpenAiClipJudgeService()
      .judgeCandidates(fallbackInput);
    assert.ok(copiedOpeningFallback.every(({ fallbackReason }) =>
      fallbackReason.includes('unsupported number')));
    const timeoutFallback = await new OpenAiClipJudgeService({
      providerName: 'test-provider',
      modelName: 'test-model',
      isConfigured: () => true,
      async generateStructured() {
        throw new LlmProviderError('TIMEOUT_FAILURE', 'Structured generation timed out');
      }
    }).judgeCandidates(fallbackInput);
    assert.ok(timeoutFallback.every(({ fallbackReason }) =>
      fallbackReason.startsWith('TIMEOUT_FAILURE:')));
    const configFallback = await new OpenAiClipJudgeService({
      providerName: 'test-provider',
      modelName: 'test-model',
      isConfigured: () => false
    }).judgeCandidates(fallbackInput);
    assert.ok(configFallback.every(({ fallbackReason }) =>
      fallbackReason.startsWith('CONFIGURATION_FAILURE:')));
    const topicInputs = [
      {
        ...fallbackInput[0], rangeKey: 'solar', topic: 'Solar panel maintenance',
        transcriptText: 'Dust blocks sunlight from reaching solar panels. Cleaning the panels monthly restored 12 percent of their output.'
      },
      {
        ...fallbackInput[1], rangeKey: 'bread', topic: 'Sourdough fermentation',
        transcriptText: 'Cold dough ferments more slowly overnight. The longer rest gives sourdough a deeper flavor before baking.'
      }
    ];
    const topicFallback = await new OpenAiClipJudgeService({
      providerName: 'unconfigured',
      modelName: 'unconfigured',
      isConfigured: () => false
    }).judgeCandidates(topicInputs);
    assert.notEqual(topicFallback[0].bestHook, topicFallback[1].bestHook);
    assert.match(topicFallback[0].synopsis.toLowerCase(), /panel|solar|output|sunlight/);
    assert.match(topicFallback[1].synopsis.toLowerCase(), /dough|sourdough|ferment|flavor/);
    assert.ok(topicFallback[0].bestHook.toLowerCase().includes('panel') ||
      topicFallback[0].bestHook.toLowerCase().includes('output'));
    assert.ok(topicFallback[1].bestHook.toLowerCase().includes('dough') ||
      topicFallback[1].bestHook.toLowerCase().includes('sourdough'));
    assert.ok(normalizedHookSimilarity(
      topicFallback[0].bestHook, topicFallback[1].bestHook) < 0.72);
    const firstFingerprint = buildContentFingerprint(fallbackInput[0]);
    assert.equal(buildContentFingerprint(fallbackInput[0]), firstFingerprint);
    assert.equal(canReuseGeneratedContent(fallbackInput[0], {
      generationStatus: 'GENERATED',
      bestHook: 'A complete generated hook.',
      alternateHooks: ['One complete hook.', 'Another complete hook.'],
      hooks: [
        { text: 'A complete generated hook.', style: 'strong claim', score: 90 },
        { text: 'One complete hook.', style: 'question', score: 80 },
        { text: 'Another complete hook.', style: 'curiosity', score: 70 }
      ],
      selectedHookStrategy: 'strong claim',
      title: 'A complete title',
      synopsis: 'The practical lesson establishes the clip context.\n\nThe idea develops into a measurable result.\n\nThe result makes this practical lesson useful.',
      caption: 'A distinct caption.',
      hashtags: ['#First', '#Second', '#Third', '#Fourth', '#Fifth'],
      cta: '',
      topic: 'Complete topic',
      contentType: 'Educational insight',
      whySelected: 'It is complete.',
      provider: 'test',
      model: 'test-model',
      creativeCandidates: {
        hooks: Array.from({ length: 10 }, (_, index) => ({ hook: `Hook ${index}.` })),
        captions: ['One.', 'Two.', 'Three.'], titles: ['One', 'Two', 'Three'],
        hashtags: Array.from({ length: 15 }, (_, index) => `#Tag${index}`),
        synopses: ['One. Two.', 'Three. Four.']
      },
      contentFingerprint: firstFingerprint,
      promptVersion: CLIP_CONTENT_PROMPT_VERSION
    }), true);
    assert.equal(canReuseGeneratedContent(fallbackInput[0], {
      generationStatus: 'FALLBACK',
      bestHook: 'A complete fallback hook.',
      alternateHooks: ['One complete hook.', 'Another complete hook.'],
      hooks: [
        { text: 'A complete fallback hook.', style: 'strong claim', score: 90 },
        { text: 'One complete hook.', style: 'question', score: 80 },
        { text: 'Another complete hook.', style: 'curiosity', score: 70 }
      ],
      selectedHookStrategy: 'strong claim',
      title: 'A complete title',
      synopsis: 'The practical lesson establishes the clip context.\n\nThe idea develops into a measurable result.\n\nThe result makes this practical lesson useful.',
      caption: 'A distinct caption.',
      hashtags: ['#First', '#Second', '#Third', '#Fourth', '#Fifth'],
      cta: '',
      topic: 'Complete topic',
      contentType: 'Educational insight',
      whySelected: 'It is complete.',
      provider: 'test',
      model: 'test-model',
      contentFingerprint: firstFingerprint,
      promptVersion: CLIP_CONTENT_PROMPT_VERSION
    }), false);
    assert.notEqual(buildContentFingerprint({
      ...fallbackInput[0], transcriptText: fallbackInput[0].transcriptText + ' New evidence.'
    }), firstFingerprint);
    assert.ok(normalizedHookSimilarity(
      'Solar panels lose output when dust blocks sunlight.',
      'Solar panels lose output because dust blocks the sunlight.') >= 0.72);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalBatch === undefined) delete process.env.CLIP_JUDGE_BATCH_SIZE;
    else process.env.CLIP_JUDGE_BATCH_SIZE = originalBatch;
  }
}

async function testSelectionAndApi(candidates) {
  const strong = [
    { ...candidates[0], id: 'one', startTime: 0, endTime: 30, topic: 'one', overallScore: 90, reject: false },
    { ...candidates[1], id: 'two', startTime: 70, endTime: 105, topic: 'two', overallScore: 80, reject: false },
    { ...candidates[2], id: 'weak', startTime: 130, endTime: 165, topic: 'three', overallScore: 55, reject: false }
  ];
  assert.deepEqual(selectDiversifiedCandidates(strong, 5).map(({ id }) => id), ['one', 'two']);
  // Legacy `count` is accepted as requestedClipCount; duration fields are ignored.
  assert.deepEqual(parseClipSelection({ count: 5, minDuration: 30, maxDuration: 45 }),
    { requestedClipCount: 5, outputStyle: null });
  assert.deepEqual(parseClipSelection({ requestedClipCount: 3, outputStyle: 'AI_EDITED' }),
    { requestedClipCount: 3, outputStyle: 'AI_EDITED' });
  for (const invalid of [null, {}, { requestedClipCount: 2, outputStyle: 'FANCY' }])
    assert.throws(() => parseClipSelection(invalid));
  const stored = candidates.slice(0, 10).map((candidate, index) => ({
    id: `candidate-${index}`, ...candidate, rank: index + 1, reject: false
  }));
  const calls = [];
  const prisma = {
    video: { findUnique: async () => ({ id: 'long-video' }) },
    clipCandidate: { findMany: async (options) => {
      calls.push(options); return stored.slice(0, options.take);
    } }
  };
  const controller = new VideosController(new VideosService(prisma, {}, {}, {}));
  const top5 = await controller.getClipCandidates('long-video', '5');
  const top10 = await controller.getClipCandidates('long-video', '10');
  assert.equal(top5.length, 5);
  assert.equal(top10.length, 10);
  assert.deepEqual(top5, top10.slice(0, 5));
  assert.deepEqual(calls.map(({ take }) => take), [5, 10]);
  assert.deepEqual(calls[0].orderBy, [{ contentPotential: 'desc' }, { rank: 'asc' }]);
  assert.throws(() => controller.getClipCandidates('long-video', '0'));
  const recommendationCandidates = stored.slice(0, 8).map((candidate, index) => ({
    ...candidate,
    contentPotential: index < 5 ? 85 - index : 70 - index,
    overallScore: index < 5 ? 85 - index : 70 - index
  }));
  const recommendationController = new VideosController(new VideosService({
    video: { findUnique: async () => ({ duration: 900, clipCandidates: recommendationCandidates }) }
  }, {}, {}, {}));
  const recommendation = await recommendationController.getClipRecommendations('long-video');
  assert.equal(recommendation.recommendedClipCount, 5);
  assert.equal(recommendation.maximumClipCount, 12);
  assert.equal(recommendation.primaryCount, 5);
  assert.equal(recommendation.secondaryCount, 3);
  assert.deepEqual(recommendation.candidates.map(({ recommendationTier }) => recommendationTier),
    ['PRIMARY', 'PRIMARY', 'PRIMARY', 'PRIMARY', 'PRIMARY',
      'SECONDARY', 'SECONDARY', 'SECONDARY']);

  const durationLimitedService = new VideosService({
    video: { findUnique: async () => ({ id: 'short-video', duration: 600,
      processingJobs: [{ id: 'job', status: 'COMPLETED' }] }) },
    clipCandidate: { findMany: async () => [] }
  }, {}, {}, {});
  await assert.rejects(() => durationLimitedService.selectClips('short-video', {
    requestedClipCount: 7, outputStyle: 'NORMAL'
  }), /at most 6 clips/);
  return { top5, top10 };
}

async function testExportRetryIsIdempotent(candidates) {
  const persisted = { id: 'existing-clip', sizeBytes: 1000n, processingType: 'NORMAL_CLIPS',
    aspectRatio: '9:16', width: 1080, height: 1920 };
  let lookupCount = 0;
  const prisma = { generatedClip: { findUnique: async (query) => {
    lookupCount += 1;
    assert.deepEqual(query.where.videoId_rangeKey_variantKey, { videoId: 'long-video',
      rangeKey: candidates[0].rangeKey, variantKey: 'NORMAL_CLIPS:TIKTOK' });
    return persisted;
  } } };
  const storage = { downloadToFile: async () => {
    throw new Error('an existing export must not download or invoke FFmpeg');
  } };
  const exporter = new ClipExportService(prisma, storage);
  const result = await exporter.export({ id: 'long-video' }, candidates[0],
    { processingType: 'NORMAL_CLIPS', targetPlatform: 'TIKTOK', aspectRatio: '9:16' });
  assert.equal(result, persisted);
  assert.equal(lookupCount, 1);
}

async function main() {
  testWeightedScoreMath();
  testRecommendationPolicy();
  const candidates = await testGenerationAndRanking();
  // Legacy OpenAI response-shape coverage is superseded by test-online-resilience.cjs,
  // which exercises the compact ONLINE package and the current cloud allowlist.
  const { top5, top10 } = await testSelectionAndApi(candidates);
  await testExportRetryIsIdempotent(candidates);
  console.log(JSON.stringify({ generatedCandidates: candidates.length,
    bestHeuristicScore: candidates[0].heuristicScore, weightedScoreMath: true,
    overlapSuppression: true, exportRetryIdempotent: true,
    limit5: top5.length, limit10: top10.length }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
