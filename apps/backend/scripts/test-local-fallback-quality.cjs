require('reflect-metadata');
const assert = require('node:assert/strict');
const { LlmProviderError, LlmProviderService } =
  require('../dist/modules/processing/llm-provider.service');
const { LlmRouterService, effectiveLocalTimeoutMs } =
  require('../dist/modules/processing/llm-router.service');
const { createPerformanceTelemetry, performanceContext, countLlmRequest } =
  require('../dist/modules/processing/performance-telemetry');
const { VideoUnderstandingService } =
  require('../dist/modules/processing/video-understanding.service');
const { ClipIntelligenceService } =
  require('../dist/modules/processing/clip-intelligence.service');
const { ClipCriticService } = require('../dist/modules/processing/clip-critic.service');
const { LOCAL_CREATIVE_SYSTEM_PROMPT, parseLocalCreativeBatch } =
  require('../dist/modules/processing/openai-clip-judge.service');

const ENV_KEYS = ['NVIDIA_API_KEY', 'NVIDIA_REASONING_MODEL', 'OPENAI_API_KEY', 'GOOGLE_API_KEY',
  'GOOGLE_CREATIVE_MODEL', 'LOCAL_LLM_ENABLED', 'LOCAL_LLM_TIMEOUT_MS',
  'LOCAL_LLM_MULTIMODAL_UNDERSTANDING_TIMEOUT_MS',
  'LOCAL_LLM_WHOLE_VIDEO_UNDERSTANDING_TIMEOUT_MS',
  'LOCAL_LLM_CLIP_UNDERSTANDING_TIMEOUT_MS', 'LOCAL_LLM_CREATIVE_GENERATION_TIMEOUT_MS',
  'LOCAL_LLM_CRITIC_TIMEOUT_MS', 'LOCAL_LLM_COMPONENT_REPAIR_TIMEOUT_MS',
  'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_CIRCUIT_FAILURE_THRESHOLD',
  'LLM_CIRCUIT_COOLDOWN_MS'];
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
const request = key => ({ schemaName: 'quality_test', schema, role: 'creativeGeneration',
  systemPrompt: 'Return JSON.', userPrompt: '{}', cacheKey: key });
const metadata = (role, provider = 'ollama') => ({ role, provider, model: 'test-model',
  failover: false, cacheHit: false, attempts: [] });

function candidate() {
  return { videoId: 'video', rangeKey: '0:30', startTime: 0, endTime: 30, duration: 30,
    transcriptText: 'Grounded evidence makes the workflow reliable. The workflow keeps every claim clear and reaches a useful conclusion.',
    heuristicScore: 75, judgeSource: 'LLM', rank: null, hookScore: 75, sourceHookScore: 75,
    standaloneScore: 75, payoffScore: 75, flowScore: 75, informationScore: 75,
    retentionScore: 75, shareabilityScore: 75, contentPotential: 75, overallScore: 75,
    reject: false, topic: 'reliable workflow', reason: 'grounded', rejectionReason: '',
    evidence: { speechSignals: {}, visualSignals: [], multimodalSignals: [],
      supportedFacts: ['Grounded evidence makes the workflow reliable.'], importantMoments: [] },
    clipUnderstanding: {}, providerMetadata: [{ provider: 'ollama' }], generationMode: 'LOCAL_AI',
    fallbackUsed: false, failureCategory: '', generationStatus: 'GENERATED' };
}

function localPackage(hooks) {
  return { candidates: [{ hooks, title: 'A Reliable Evidence Workflow',
    caption: 'Grounded claims keep the workflow clear through its useful conclusion.',
    synopsis: 'The clip explains a reliable workflow built on grounded evidence.\n\nThe process keeps its claims clear through that evidence.\n\nThe workflow reaches a useful conclusion supported by those claims.',
    hashtags: ['#ReliableWorkflow', '#GroundedEvidence', '#ClearClaims', '#UsefulConclusion',
      '#WorkflowDesign'] }] };
}

const repairedHooks = [
  { text: 'Grounded evidence makes the workflow reliable.', style: 'strong claim', score: 82 },
  { text: 'Why does this workflow need grounded claims?', style: 'question', score: 80 },
  { text: 'Without evidence, this workflow loses its useful conclusion.',
    style: 'stakes/consequence', score: 78 }
];

async function testTimeoutsAndFallback() {
  process.env.LOCAL_LLM_TIMEOUT_MS = '60000';
  for (const key of ENV_KEYS.filter(key => key.startsWith('LOCAL_LLM_') &&
    key.endsWith('_UNDERSTANDING_TIMEOUT_MS') || key.includes('CREATIVE_GENERATION_TIMEOUT') ||
    key.includes('CRITIC_TIMEOUT') || key.includes('COMPONENT_REPAIR_TIMEOUT'))) delete process.env[key];
  const expected = { multimodalUnderstanding: 20000, wholeVideoUnderstanding: 30000,
    clipUnderstanding: 45000, creativeGeneration: 45000, critic: 35000,
    componentRepair: 30000 };
  for (const [role, timeout] of Object.entries(expected))
    assert.equal(effectiveLocalTimeoutMs(role), timeout);
  process.env.LOCAL_LLM_CREATIVE_GENERATION_TIMEOUT_MS = '45000';
  assert.equal(effectiveLocalTimeoutMs('creativeGeneration', 20000), 20000,
    'the role setting must never exceed the global local ceiling');

  delete process.env.NVIDIA_API_KEY; delete process.env.GOOGLE_API_KEY;
  delete process.env.LLM_PROVIDER; delete process.env.LLM_API_KEY; delete process.env.LLM_MODEL;
  process.env.LOCAL_LLM_ENABLED = 'true';
  let calls = 0;
  const router = new LlmRouterService({ isConfigured: config => config.apiStyle === 'ollama',
    async generateStructuredWithConfig(config) { calls++;
      assert.equal(config.maxRetries, 0); assert.equal(config.timeoutMs, 30000);
      throw new LlmProviderError('LOCAL_TIMEOUT_FAILURE', 'synthetic timeout'); } });
  const fallback = await performanceContext.run(createPerformanceTelemetry('OFFLINE'), () =>
    new VideoUnderstandingService(router).analyzeWithFallback([
      { position: 0, startTime: 0, endTime: 10, text: 'Grounded transcript fallback remains available.' }
    ], 'en'));
  assert.equal(calls, 0, 'OFFLINE whole-video analysis must bypass Ollama');
  assert.equal(fallback.mainTopic, 'Grounded transcript fallback remains available.');
}

async function testNvidiaExtraction() {
  const originalFetch = global.fetch;
  const endpoint = { provider: 'nvidia', apiKey: 'test', baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'nemotron-omni', apiStyle: 'chat_completions', timeoutMs: 1000, maxRetries: 0,
    retryBaseDelayMs: 1, concurrency: 1 };
  const provider = new LlmProviderService();
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content:
      'Result follows:\n```json\n{"value":"recovered"}\n```' } }] }) }; };
  assert.deepEqual(await provider.generateStructuredWithConfig(endpoint, request('nvidia-good')),
    { value: 'recovered' });
  global.fetch = async () => { calls++; return { ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content:
      'Result {broken} then {"value":"must-not-use-second-object"}' } }] }) }; };
  await assert.rejects(() => provider.generateStructuredWithConfig(endpoint,
    request('nvidia-invalid')), error => error.kind === 'MALFORMED_RESPONSE_FAILURE');
  assert.equal(calls, 2, 'invalid NVIDIA output gets one request and one extraction attempt');
  global.fetch = originalFetch;
}

async function testLocalRepair() {
  assert.match(LOCAL_CREATIVE_SYSTEM_PROMPT, /unsupported statistics, numbers, dates, names/iu);
  assert.match(LOCAL_CREATIVE_SYSTEM_PROMPT, /silently verify/iu);
  assert.match(LOCAL_CREATIVE_SYSTEM_PROMPT, /exactly 5 unique/iu);
  const validHooks = [
    { text: 'Grounded evidence makes the workflow reliable.', style: 'strong claim' },
    { text: 'Why does grounded evidence keep this workflow reliable?', style: 'question' },
    { text: 'Without clear claims, the workflow loses its useful conclusion.', style: 'stakes/consequence' }
  ];
  const valid = parseLocalCreativeBatch(localPackage(validHooks), [candidate()])[0];
  assert.equal(valid.synopsis.split(/\n\n/u).length, 3);
  assert.equal(valid.hashtags.length, 5);
  const oneParagraph = localPackage(validHooks);
  oneParagraph.candidates[0].synopsis = oneParagraph.candidates[0].synopsis.replace(/\n\n/gu, ' ');
  assert.ok(parseLocalCreativeBatch(oneParagraph, [candidate()])[0]
    .localValidationIssues.includes('synopsis'));
  const duplicateTags = localPackage(validHooks);
  duplicateTags.candidates[0].hashtags[4] = '#ReliableWorkflow';
  assert.ok(parseLocalCreativeBatch(duplicateTags, [candidate()])[0]
    .localValidationIssues.includes('hashtags'));
  const extraTag = localPackage(validHooks);
  extraTag.candidates[0].hashtags.push('#ExtraTag');
  assert.throws(() => parseLocalCreativeBatch(extraTag, [candidate()]), /exactly five hashtags/u);
  const duplicate = [
    { text: 'Grounded evidence makes the workflow reliable.', style: 'strong claim' },
    { text: 'Grounded evidence makes the workflow reliable.', style: 'question' },
    { text: 'Grounded evidence makes the workflow reliable.', style: 'stakes/consequence' }
  ];
  const parsed = parseLocalCreativeBatch(localPackage(duplicate), [candidate()])[0];
  assert.deepEqual(parsed.localValidationIssues, ['hooks']);
  const originalTitle = parsed.title;
  let repairs = 0;
  const critic = new ClipCriticService({ async generate(input) {
    assert.equal(input.role, 'componentRepair', 'known local checks must bypass a full critic call');
    assert.deepEqual(input.request.schema.required, ['hooks']); repairs++;
    return { data: { hooks: repairedHooks }, metadata: metadata('componentRepair') };
  } });
  const [repaired] = await critic.review([parsed]);
  assert.equal(repairs, 1); assert.equal(repaired.title, originalTitle);
  assert.equal(repaired.hooks[1].text, repairedHooks[1].text);
  assert.deepEqual(repaired.localValidationIssues, []);

  let failedRepairs = 0;
  const invalidRepair = new ClipCriticService({ async generate() { failedRepairs++;
    return { data: { hooks: duplicate.map(item => ({ ...item, score: 70 })) },
      metadata: metadata('componentRepair') }; } });
  const [deterministicallyRepaired] = await invalidRepair.review([parsed]);
  assert.equal(failedRepairs, 1, 'component repair must never recurse');
  assert.equal(deterministicallyRepaired.title, originalTitle,
    'valid components survive failed hook repair');
  assert.notEqual(deterministicallyRepaired.hooks[0].text, duplicate[0].text,
    'only the invalid component falls back deterministically');
}

async function testCircuitConcurrency() {
  // ONLINE routes only ever resolve to the single allow-listed openai/Luna provider
  // (see provider-registry.ts ONLINE_PROVIDER_ALLOWLIST); the fixture must be configured
  // for that provider or the router never reaches this circuit at all.
  process.env.LOCAL_LLM_ENABLED = 'false'; delete process.env.GOOGLE_API_KEY;
  delete process.env.LLM_PROVIDER; delete process.env.LLM_API_KEY; delete process.env.LLM_MODEL;
  delete process.env.NVIDIA_API_KEY; process.env.OPENAI_API_KEY = 'test';
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '1'; process.env.LLM_CIRCUIT_COOLDOWN_MS = '60000';
  let calls = 0, releaseFirst, releaseSecond;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  const provider = { isConfigured: config => config.provider === 'openai',
    async generateStructuredWithConfig() { const call = ++calls;
      if (call === 1) { await firstGate; throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'open', 503); }
      if (call === 2) { await secondGate; return { value: 'already-in-flight' }; }
      return { value: 'unexpected-new-call' }; } };
  const router = new LlmRouterService(provider);
  await performanceContext.run(createPerformanceTelemetry('ONLINE'), async () => {
    const first = router.generate({ role: 'creativeGeneration', request: request('race-first') });
    const second = router.generate({ role: 'creativeGeneration', request: request('race-second') });
    while (calls < 2) await new Promise(resolve => setImmediate(resolve));
    releaseFirst(); await assert.rejects(() => first);
    releaseSecond(); assert.equal((await second).data.value, 'already-in-flight');
    await assert.rejects(() => router.generate({ role: 'creativeGeneration',
      request: request('after-open') }), error => error.kind === 'CIRCUIT_OPEN');
    assert.equal(calls, 2, 'an in-flight success must not admit a new request after circuit-open');
  });
}

async function testTelemetryAndPromptSizes() {
  const metrics = createPerformanceTelemetry();
  await performanceContext.run(metrics, async () => {
    countLlmRequest('creativeGeneration', 'google');
    countLlmRequest('critic', 'nvidia');
    countLlmRequest('componentRepair', 'ollama');
  });
  assert.deepEqual({ total: metrics.totalLlmCalls, cloud: metrics.cloudLlmCalls,
    local: metrics.localLlmCalls, legacyCloud: metrics.totalCloudLlmCalls },
  { total: 3, cloud: 2, local: 1, legacyCloud: 2 });

  let wholeRequest;
  const parts = Array.from({ length: 90 }, (_, position) => ({ position,
    startTime: position * 10, endTime: position * 10 + 10,
    text: ('This section explains a grounded workflow with concrete evidence and a useful conclusion. ')
      .repeat(8) }));
  const videoResult = { summary: 'Grounded workflow summary.', mainTopic: 'Grounded workflow',
    contentType: 'Educational', targetAudience: 'Creators', language: 'en', chapters: [{
      startTime: 0, endTime: 900, title: 'Grounded workflow', summary: 'A useful workflow.',
      topics: ['workflow'], importanceScore: 80 }], topics: ['workflow'], keyClaims: [],
    questions: [], stories: [], importantMoments: [] };
  await new VideoUnderstandingService({ routesFor: () => [], async generate(input) {
    wholeRequest = input.request; return { data: videoResult,
      metadata: metadata('wholeVideoUnderstanding') }; } }).analyze(parts, 'en');
  const wholeBefore = wholeRequest.systemPrompt.length + wholeRequest.userPrompt.length;
  const wholeAfter = wholeRequest.local.systemPrompt.length + wholeRequest.local.userPrompt.length;
  assert.ok(wholeAfter < wholeBefore); assert.ok(wholeRequest.local.userPrompt.length <= 12200);

  const evidence = { startTime: 0, endTime: 30, transcript: candidate().transcriptText,
    previousContext: 'previous context '.repeat(100), nextContext: 'next context '.repeat(100),
    chapter: 'chapter summary '.repeat(100), overallVideoTopic: 'workflow topic '.repeat(50),
    speechSignals: { hook: 75 }, visualSignals: Array.from({ length: 8 }, (_, position) => ({
      position, startTime: 0, endTime: 30, sceneChangeCount: 2, averageMotion: 30,
      faceCount: 1, largestFaceRatio: 20, brightness: 50, contrast: 40, colorfulness: 60,
      ocrText: 'verbose OCR '.repeat(40), subtitleDetected: true })),
    multimodalSignals: [], supportedFacts: [], importantMoments: [] };
  let clipRequest;
  await new ClipIntelligenceService({ async generate(input) { clipRequest = input.request;
    throw new LlmProviderError('LOCAL_TIMEOUT_FAILURE', 'synthetic'); } })
    .understand([candidate()], [evidence]);
  const clipBefore = clipRequest.systemPrompt.length + clipRequest.userPrompt.length;
  const clipAfter = clipRequest.local.systemPrompt.length + clipRequest.local.userPrompt.length;
  assert.ok(clipAfter < clipBefore);

  let multimodalRequest;
  await new ClipIntelligenceService({ async generate(input) { multimodalRequest = input.request;
    throw new LlmProviderError('LOCAL_TIMEOUT_FAILURE', 'synthetic'); } })
    .analyzeMultimodal('video', evidence.visualSignals, [{ mimeType: 'image/jpeg', data: 'raw-video' }]);
  const multimodalBefore = multimodalRequest.systemPrompt.length + multimodalRequest.userPrompt.length;
  const multimodalAfter = multimodalRequest.local.systemPrompt.length +
    multimodalRequest.local.userPrompt.length;
  assert.ok(multimodalAfter < multimodalBefore);
  assert.equal(multimodalRequest.local.media, undefined);
  return { wholeVideo: [wholeBefore, wholeAfter], clip: [clipBefore, clipAfter],
    multimodal: [multimodalBefore, multimodalAfter] };
}

async function main() {
  try {
    await testTimeoutsAndFallback();
    await testNvidiaExtraction();
    await testLocalRepair();
    await testCircuitConcurrency();
    const promptSizes = await testTelemetryAndPromptSizes();
    console.log(JSON.stringify({ roleLocalTimeouts: true, immediateTimeoutFallback: true,
      nvidiaSafeJsonExtraction: true, invalidNvidiaStillMalformed: true,
      qwenValidatorPrompt: true, componentOnlyRepair: true, validComponentsPreserved: true,
      noRecursiveRepair: true, circuitOpenSkipsNew: true, inFlightSafe: true,
      separatedTelemetry: true, promptSizes }));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
