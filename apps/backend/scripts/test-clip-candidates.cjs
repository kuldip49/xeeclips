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
  OpenAiClipJudgeService,
  ensureSameVideoHookDiversity
} = require('../dist/modules/processing/openai-clip-judge.service');
const { VideosService, publicVideoMetadata } = require('../dist/modules/videos/videos.service');
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
  assert.equal(maximumClipCountForDuration(600), 8);
  assert.equal(maximumClipCountForDuration(601), 8);
  assert.equal(maximumClipCountForDuration(899), 8);
  assert.equal(maximumClipCountForDuration(900), 20);
  assert.equal(maximumClipCountForDuration(3600), 20);
  assert.equal(maximumClipCountForDuration(3601), 30);
  assert.equal(maximumClipCountForDuration(7200), 30);
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
    maximumClipCount: 20,
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
  const {deterministicCreative}=require('../dist/modules/content-intelligence/creative-package.service');
  const {performanceContext,createPerformanceTelemetry}=require('../dist/modules/processing/performance-telemetry');
  const fixture=require('./fixtures/content-intelligence.cjs')[0];
  const transcript=fixture.turns.map(t=>t[1]).join(' ');
  let calls=0;
  const router={isAnyConfigured:()=>true,async generate(input){calls++;
    const supplied=JSON.parse(input.request.userPrompt);
    assert(!JSON.stringify(supplied).includes('apiKey'));
    const data=input.role==='clipUnderstanding'?{}:input.role==='critic'?{supported:true,failures:[]}:deterministicCreative(supplied.evidence);
    return{data,metadata:{role:input.role,model:'configured-test-model',provider:'test',cacheHit:false,attempts:[]}};
  }};
  const input=candidates.slice(0,2).map((c,i)=>({...c,videoId:'candidate-shared-test-'+i,transcriptText:transcript,clipUnderstanding:undefined}));
  await performanceContext.run(createPerformanceTelemetry('ONLINE'),async()=>{
    const judge=new OpenAiClipJudgeService(router);
    const judged=await judge.judgeCandidates(input);
    const previous=calls;await judge.judgeCandidates(input);assert.equal(calls,previous,'shared package cache reused');
    assert(judged.every(c=>c.generationStatus==='GENERATED'));
    assert(judged.every(c=>c.bestHook && c.synopsis && c.caption && c.hashtags.length && c.hooks.length>=3));
    assert(judged.every(c=>c.sourceHookScore===c.hookScore));
    assert.deepEqual(judged.map(c=>c.heuristicScore),input.map(c=>c.heuristicScore));
    assert(judged.every(c=>c.creativeCandidates.sharedPackage.quality.passed));
    const distinct=ensureSameVideoHookDiversity(judged.map((c,i)=>({...c,overallScore:90-i,reject:false})));
    assert.notEqual(distinct[0].bestHook,distinct[1].bestHook,'same-video selection uses distinct shared recommendations');
    distinct.forEach(c=>{
      const p=c.creativeCandidates.sharedPackage;
      assert.equal(c.bestHook,p.selectedHook);
      assert.equal(p.hooks.filter(h=>h.recommended).length,1);
      assert.equal(p.hooks.find(h=>h.recommended).text,p.selectedHook);
      assert.deepEqual(p.captions,judged[0].creativeCandidates.sharedPackage.captions,'diversity preserves post copy');
    });
    const unavailable=new OpenAiClipJudgeService({isAnyConfigured:()=>true,generate:async()=>{throw Error('unavailable');}});
    const fallback=await unavailable.judgeCandidates(input.map(c=>({...c,videoId:c.videoId+'-offline'})));
    assert(fallback.every(c=>c.generationStatus==='FALLBACK' && c.fallbackUsed && c.bestHook && c.synopsis));
    assert(fallback.every(c=>c.creativeCandidates.sharedPackage.internal.routes.length===0));
    assert(fallback.every(c=>c.creativeCandidates.sharedPackage.hooks.every(h=>h.source==='LOCAL')),'unavailable provider uses grounded local hooks');
  });
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
    { requestedClipCount: 5, outputStyle: null, generation:null, regenerate:false });
  assert.deepEqual(parseClipSelection({ requestedClipCount: 3, outputStyle: 'AI_EDITED' }),
    { requestedClipCount: 3, outputStyle: 'AI_EDITED', generation:null, regenerate:false });
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
  assert.equal(recommendation.maximumClipCount, 20);
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
    requestedClipCount: 9, outputStyle: 'NORMAL'
  }), /at most 8 clips/);
  return { top5, top10 };
}

async function testExportRetryIsIdempotent(candidates) {
  const persisted = { id: 'existing-clip', sizeBytes: 1000n, processingType: 'NORMAL_CLIPS',
    aspectRatio: '9:16', width: 1080, height: 1920 };
  let lookupCount = 0;
  const prisma = { video:{findUniqueOrThrow:async()=>({transcript:null})},generatedClip: { findUnique: async (query) => {
    if(query.where.objectKey)return null;
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
  const persisted={sizeBytes:1n,createdAt:new Date(0),creativeCandidates:{sharedPackage:{selectedHook:'Grounded framing',internal:{routes:[{model:'private-model',provider:'private-provider'}]}}},model:'private-model'};
  const visible=publicVideoMetadata(persisted);
  assert.equal(visible.sizeBytes,1n);assert.equal(visible.createdAt,persisted.createdAt);
  assert.equal(visible.creativeCandidates.sharedPackage.selectedHook,'Grounded framing');
  assert.equal(visible.model,undefined);assert.equal(visible.creativeCandidates.sharedPackage.internal,undefined);
  assert(persisted.model && persisted.creativeCandidates.sharedPackage.internal,'stored diagnostics remain intact');
  testWeightedScoreMath();
  testRecommendationPolicy();
  const candidates = await testGenerationAndRanking();
  await testJudgeFallbackAndStrictRequest(candidates);
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
