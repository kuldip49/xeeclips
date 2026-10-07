require('reflect-metadata');
const assert = require('node:assert/strict');
const build = process.env.AI_MODE_TEST_BUILD || '../dist';
const { AiProcessingMode, normalizeAiProcessingMode } =
  require(build + '/modules/processing/ai-processing-mode');
const { LlmProviderError, LlmProviderService } =
  require(build + '/modules/processing/llm-provider.service');
const { AI_MODE_ROLE_TIMEOUTS, effectiveRoleTimeoutMs, LlmRouterService } =
  require(build + '/modules/processing/llm-router.service');
const { createPerformanceTelemetry, performanceContext } =
  require(build + '/modules/processing/performance-telemetry');
const { VideoUnderstandingService } =
  require(build + '/modules/processing/video-understanding.service');
const { ClipIntelligenceService } =
  require(build + '/modules/processing/clip-intelligence.service');
const { ClipJudgeService } = require(build + '/modules/processing/openai-clip-judge.service');
const { ClipCriticService } = require(build + '/modules/processing/clip-critic.service');
const { calculateClipRecommendation, suppressOverlapAndRank } =
  require(build + '/modules/processing/clip-candidates');
const { VideosService } = require(build + '/modules/videos/videos.service');

const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
const request = key => ({ schemaName: 'mode_test', schema, systemPrompt: 'Return JSON.',
  userPrompt: '{}', cacheKey: key });
const transcript = [{ position: 0, startTime: 0, endTime: 30,
  text: 'Grounded evidence makes this workflow reliable. Complete transcript sentences explain the practical result.' }];

function candidate() {
  return { videoId: 'video', rangeKey: '0:30', startTime: 0, endTime: 30, duration: 30,
    transcriptText: transcript[0].text, heuristicScore: 76, judgeSource: 'HEURISTIC_FALLBACK',
    rank: null, hookScore: 76, sourceHookScore: 76, standaloneScore: 78, payoffScore: 75,
    flowScore: 74, informationScore: 80, retentionScore: 73, shareabilityScore: 70,
    contentPotential: 75, overallScore: 75, reject: false, topic: 'grounded workflow',
    reason: 'A complete grounded explanation.', rejectionReason: '',
    evidence: { startTime: 0, endTime: 30, transcript: transcript[0].text,
      previousContext: '', nextContext: '', chapter: '', overallVideoTopic: 'workflow',
      speechSignals: {}, visualSignals: [], multimodalSignals: [],
      supportedFacts: [transcript[0].text], importantMoments: [] },
    clipUnderstanding: {}, providerMetadata: [] };
}

async function inMode(mode, work) {
  const telemetry = createPerformanceTelemetry(mode);
  const result = await performanceContext.run(telemetry, work);
  return { result, telemetry };
}

async function main() {
  process.env.NVIDIA_API_KEY = 'test';
  process.env.NVIDIA_MULTIMODAL_MODEL = 'nemotron-omni';
  process.env.NVIDIA_REASONING_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
  process.env.GOOGLE_API_KEY = 'test';
  process.env.GOOGLE_CREATIVE_MODEL = 'gemini-test';
  process.env.OPENAI_API_KEY = 'test';
  process.env.OPENAI_MODEL = 'gpt-5.6-luna';
  process.env.OPENAI_ENABLED = 'true';
  process.env.LOCAL_LLM_ENABLED = 'true';

  for (const value of [undefined, null, '', ' ', 'AUTO', 'google', 'invalid'])
    assert.equal(normalizeAiProcessingMode(value), AiProcessingMode.FALLBACK_ONLY);
  assert.deepEqual(Object.values(AiProcessingMode), ['ONLINE', 'OFFLINE', 'FALLBACK_ONLY']);

  const timeoutRoles = ['multimodalUnderstanding', 'wholeVideoUnderstanding',
    'clipUnderstanding', 'creativeGeneration', 'critic', 'componentRepair'];
  // Step 6: only ONLINE has model timeouts; there is no local (OFFLINE) model policy.
  assert.deepEqual(Object.keys(AI_MODE_ROLE_TIMEOUTS), ['ONLINE']);
  for (const role of timeoutRoles) assert.equal(effectiveRoleTimeoutMs('ONLINE', role),
    AI_MODE_ROLE_TIMEOUTS.ONLINE[role], `ONLINE/${role} timeout must match policy`);
  process.env.LLM_WHOLE_VIDEO_UNDERSTANDING_TIMEOUT_MS = '99999';
  process.env.LOCAL_LLM_WHOLE_VIDEO_UNDERSTANDING_TIMEOUT_MS = '99999';
  assert.equal(effectiveRoleTimeoutMs('ONLINE', 'wholeVideoUnderstanding'), 18000);

  const calls = [];
  const provider = { isConfigured: () => true, async generateStructuredWithConfig(config) {
    calls.push(config.provider); return { value: config.provider }; } };
  const router = new LlmRouterService(provider);
  assert.deepEqual(router.routesFor('creativeGeneration'), [],
    'router without a job mode must be fallback-only');
  for (const role of ['multimodalUnderstanding', 'wholeVideoUnderstanding',
    'clipUnderstanding', 'creativeGeneration', 'critic', 'groundingVerification',
    'componentRepair']) {
    assert.deepEqual(router.routesFor(role, 'ONLINE').map(route => route.provider), ['openai']);
    assert.equal(router.routesFor(role, 'ONLINE')[0].model, 'gpt-5.6-luna');
    assert.deepEqual(router.routesFor(role, 'OFFLINE'), [],
      'legacy OFFLINE has no model route (there is no local production LLM)');
    assert.deepEqual(router.routesFor(role, 'FALLBACK_ONLY'), []);
  }

  calls.length = 0;
  await inMode('ONLINE', () => router.generate({ role: 'creativeGeneration',
    request: request('online') }));
  assert.equal(calls[0], 'openai');
  assert.equal(calls.includes('ollama'), false);

  calls.length = 0;
  const offlineWhole = await inMode('OFFLINE', () =>
    new VideoUnderstandingService(router).analyzeWithFallback(transcript, 'en'));
  assert.match(offlineWhole.result.summary, /Grounded evidence/);
  const offlineVisual = await inMode('OFFLINE', () =>
    new ClipIntelligenceService(router).analyzeMultimodal('video', [{ position: 0,
      sceneChangeCount: 2, averageMotion: 20, largestFaceRatio: 5, faceCount: 1,
      ocrText: 'Grounded evidence' }]));
  assert.equal(offlineVisual.result.observations.length, 1);
  assert.deepEqual(calls, [], 'OFFLINE heavy roles must never call Ollama');
  assert.equal(offlineWhole.telemetry.localLlmCalls, 0);
  assert.equal(offlineVisual.telemetry.localLlmCalls, 0);
  const completeOfflineRoute = await inMode('OFFLINE', async () => {
    await new VideoUnderstandingService(router).analyzeWithFallback(transcript, 'en');
    await new ClipIntelligenceService(router).analyzeMultimodal('video', [{ position: 0,
      sceneChangeCount: 1, averageMotion: 10, largestFaceRatio: 0, faceCount: 0,
      ocrText: '' }]);
    await assert.rejects(() => router.generate({ role: 'clipUnderstanding',
      request: request('offline-clip') }), error => error.kind === 'AI_MODE_FALLBACK_ONLY');
    await assert.rejects(() => router.generate({ role: 'creativeGeneration',
      request: request('offline-creative') }), error => error.kind === 'AI_MODE_FALLBACK_ONLY');
  });
  assert.deepEqual(calls, [], 'legacy OFFLINE clip-level roles make no model call at all');
  assert.equal(completeOfflineRoute.telemetry.cloudLlmCalls, 0);

  const bounded = [];
  const timeoutRouter = new LlmRouterService({ isConfigured: () => true,
    async generateStructuredWithConfig(config, input) {
      bounded.push({ mode: 'ONLINE',
        role: input.role, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries,
        requestTimeoutMs: input.options.timeoutMs });
      return { value: 'ok' };
    } });
  for (const role of timeoutRoles) {
    await inMode('ONLINE', () => timeoutRouter.generate({ role,
      request: request(`timeout-ONLINE-${role}`) }));
  }
  for (const item of bounded) {
    assert.equal(item.timeoutMs, AI_MODE_ROLE_TIMEOUTS[item.mode][item.role]);
    assert.equal(item.requestTimeoutMs, item.timeoutMs);
    assert.equal(item.maxRetries, 0);
  }

  const failing = new LlmRouterService({ isConfigured: () => true,
    async generateStructuredWithConfig() {
      throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'synthetic failure', 503);
    } });
  for (const mode of ['ONLINE', 'OFFLINE']) {
    const { result } = await inMode(mode, () =>
      new VideoUnderstandingService(failing).analyzeWithFallback(transcript, 'en'));
    assert.match(result.mainTopic, /^Grounded evidence makes this workflow reliable\./u);
  }

  calls.length = 0;
  const { telemetry } = await inMode('FALLBACK_ONLY', async () => {
    await assert.rejects(() => router.generate({ role: 'creativeGeneration',
      request: request('fallback-skip') }), error => error.kind === 'AI_MODE_FALLBACK_ONLY');
    const intelligence = new ClipIntelligenceService(router);
    const base = candidate();
    const understood = await intelligence.understand([base], [base.evidence]);
    assert.equal(understood.understandings.length, 1);
    const generated = await new ClipJudgeService(router).judgeCandidates([base]);
    assert.equal(generated.length, 1);
    assert.ok(generated[0].hooks.length >= 1);
    assert.ok(generated[0].hashtags.length >= 1 && generated[0].hashtags.length <= 8);
    assert.ok(generated[0].synopsis.length > 20 && generated[0].synopsis.length < 1200);
    const reviewed = await new ClipCriticService(router).review([
      { ...generated[0], localValidationIssues: ['hooks'] }
    ]);
    assert.equal(reviewed.length, 1);
    const ranked = suppressOverlapAndRank(reviewed);
    assert.equal(ranked.length, 1);
    assert.ok(Number.isFinite(ranked[0].contentPotential));
    assert.equal(calculateClipRecommendation(ranked, 30).candidatesDiscovered, 1);
  });
  assert.deepEqual(calls, []);
  assert.deepEqual({ total: telemetry.totalLlmCalls, cloud: telemetry.cloudLlmCalls,
    local: telemetry.localLlmCalls }, { total: 0, cloud: 0, local: 0 });

  calls.length = 0;
  await Promise.all([
    inMode('ONLINE', () => router.generate({ role: 'wholeVideoUnderstanding',
      request: request('concurrent-online') })),
    inMode('OFFLINE', () => router.generate({ role: 'clipUnderstanding',
      request: request('concurrent-offline') }).catch(error => error.kind)),
    inMode('FALLBACK_ONLY', () => router.generate({ role: 'wholeVideoUnderstanding',
      request: request('concurrent-fallback') }).catch(error => error.kind))
  ]);
  assert.ok(calls.includes('openai'));
  assert.equal(calls.includes('ollama'), false);
  assert.equal(calls.includes('nvidia'), false);

  let resumed;
  const prisma = { video: { findUnique: async () => ({ id: 'video', processingJobs: [{
    id: 'job', videoId: 'video', aiMode: 'OFFLINE', status: 'FAILED' }] }) },
    processingJob: { update: async () => ({}), findUniqueOrThrow: async () => ({ id: 'job' }) } };
  const queue = { async resume(data, prepare) { resumed = data; await prepare(); } };
  await new VideosService(prisma, {}, queue, {}).retry('video');
  assert.equal(resumed.aiMode, 'FALLBACK_ONLY', 'a stored legacy OFFLINE job resumes deterministically');

  const endpoint = { provider: 'google', apiKey: 'test', baseUrl: 'https://example.test',
    model: 'gemini-test', apiStyle: 'gemini', timeoutMs: 25000, maxRetries: 1,
    retryBaseDelayMs: 1, concurrency: 1 };
  const originalFetch = global.fetch;
  process.env.LLM_RETRY_JITTER_MS = '0';
  process.env.LLM_RETRY_MAX_DELAY_MS = '1';
  const providerService = new LlmProviderService();
  let wireCalls = 0;
  global.fetch = async () => { wireCalls++;
    return new Response('{"error":{"message":"temporary"}}', { status: 503 }); };
  await assert.rejects(() => providerService.generateStructuredWithConfig(endpoint,
    request('retry-transient')), error => error.kind === 'PROVIDER_SATURATION_FAILURE');
  assert.equal(wireCalls, 2, 'cloud transient failures get at most one retry');

  for (const hardFailure of [
    { key: 'auth', status: 401, body: '{"error":{"message":"unauthorized"}}' },
    { key: 'quota', status: 429,
      body: '{"error":{"message":"daily quota exhausted","status":"RESOURCE_EXHAUSTED"}}' }
  ]) {
    wireCalls = 0;
    global.fetch = async () => { wireCalls++;
      return new Response(hardFailure.body, { status: hardFailure.status }); };
    await assert.rejects(() => providerService.generateStructuredWithConfig(endpoint,
      request('hard-' + hardFailure.key)));
    assert.equal(wireCalls, 1, `${hardFailure.key} failure must not retry`);
  }

  wireCalls = 0;
  global.fetch = async () => { wireCalls++;
    return new Response('{"candidates":[{"content":{"parts":[{"text":"{}"}]}}]}',
      { status: 200, headers: { 'content-type': 'application/json' } }); };
  await assert.rejects(() => providerService.generateStructuredWithConfig(endpoint,
    request('hard-schema')), error => error.kind === 'SCHEMA_FAILURE');
  assert.equal(wireCalls, 1, 'schema failures must not retry');
  global.fetch = originalFetch;

  console.log('AI processing mode tests passed: three isolated modes; fallback-only made zero LLM calls.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
