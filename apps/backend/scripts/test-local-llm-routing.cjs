require('reflect-metadata');
const assert = require('node:assert/strict');
const { LlmProviderError, LlmProviderService, geminiJsonSchema } =
  require('../dist/modules/processing/llm-provider.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { VIDEO_UNDERSTANDING_SCHEMA } =
  require('../dist/modules/processing/video-understanding.service');
const { VideoUnderstandingService } =
  require('../dist/modules/processing/video-understanding.service');
const { ClipIntelligenceService, compactVisualSignals, MAX_MULTIMODAL_OBSERVATIONS } =
  require('../dist/modules/processing/clip-intelligence.service');
const { processingModeFor } = require('../dist/modules/processing/clip-candidates');
const { ClipJudgeService } = require('../dist/modules/processing/openai-clip-judge.service');
const { createPerformanceTelemetry, performanceContext } =
  require('../dist/modules/processing/performance-telemetry');

const ENV_KEYS = ['NVIDIA_API_KEY', 'NVIDIA_REASONING_MODEL', 'NVIDIA_MODEL',
  'GOOGLE_API_KEY', 'GOOGLE_CREATIVE_MODEL', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL',
  'LOCAL_LLM_ENABLED', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'LOCAL_LLM_TIMEOUT_MS',
  'LOCAL_LLM_MAX_CONCURRENCY', 'LOCAL_LLM_KEEP_ALIVE',
  'LOCAL_LLM_CIRCUIT_FAILURE_THRESHOLD', 'LOCAL_LLM_CIRCUIT_COOLDOWN_MS',
  'LLM_CIRCUIT_FAILURE_THRESHOLD', 'LLM_CIRCUIT_COOLDOWN_MS'];
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
const request = key => ({ schemaName: 'local_test', schema, role: 'creativeGeneration',
  systemPrompt: 'Return final JSON only.', userPrompt: '{"value":"ok"}', cacheKey: key });
const configured = config => !!(config.baseUrl && config.model &&
  (config.apiStyle === 'ollama' || config.apiKey));

async function main() {
  process.env.NVIDIA_API_KEY = 'test-nvidia';
  process.env.NVIDIA_REASONING_MODEL = 'test-super';
  process.env.GOOGLE_API_KEY = 'test-google';
  process.env.GOOGLE_CREATIVE_MODEL = 'test-gemini';
  process.env.OPENAI_API_KEY = 'test-openai';
  process.env.OPENAI_MODEL = 'gpt-5.6-luna';
  process.env.OPENAI_ENABLED = 'true';
  delete process.env.LLM_PROVIDER; delete process.env.LLM_API_KEY; delete process.env.LLM_MODEL;
  process.env.LOCAL_LLM_BASE_URL = 'http://host.docker.internal:11434';
  process.env.LOCAL_LLM_MODEL = 'qwen3:4b';
  process.env.LOCAL_LLM_TIMEOUT_MS = '60000';
  process.env.LOCAL_LLM_MAX_CONCURRENCY = '1';
  process.env.LOCAL_LLM_KEEP_ALIVE = '5m';

  process.env.LOCAL_LLM_ENABLED = 'false';
  assert.equal(new LlmRouterService({ isConfigured: configured }).routesFor('creativeGeneration', 'OFFLINE')
    .some(route => route.provider === 'ollama'), false);

  process.env.LOCAL_LLM_ENABLED = 'true';
  const routeRouter = new LlmRouterService({ isConfigured: configured });
  const routes = routeRouter.routesFor('creativeGeneration', 'OFFLINE');
  assert.deepEqual(routes.map(route => route.provider), ['ollama']);
  assert.equal(routes[0].timeoutMs, 60000); assert.equal(routes[0].concurrency, 1);
  assert.deepEqual(routeRouter.routesFor('creativeGeneration', 'ONLINE')
    .map(route => route.provider), ['openai']);

  const cloudCalls = [];
  const cloudRouter = new LlmRouterService({ isConfigured: configured,
    async generateStructuredWithConfig(config) { cloudCalls.push(config.provider); return { value: 'cloud' }; } });
  const cloud = await performanceContext.run(createPerformanceTelemetry('ONLINE'), () =>
    cloudRouter.generate({ role: 'creativeGeneration', request: request('cloud') }));
  assert.equal(cloud.metadata.provider, 'openai');
  assert.deepEqual(cloudCalls, ['openai'], 'healthy cloud must not call local Ollama');

  const failoverCalls = [];
  const failoverRouter = new LlmRouterService({ isConfigured: configured,
    async generateStructuredWithConfig(config) {
      failoverCalls.push(config.provider);
      if (config.provider !== 'ollama')
        throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'synthetic cloud outage', 503, true);
      return { value: 'local' };
    } });
  await assert.rejects(() => performanceContext.run(createPerformanceTelemetry('ONLINE'), () =>
    failoverRouter.generate({ role: 'creativeGeneration', request: request('online-outage') })));
  assert.deepEqual(failoverCalls, ['openai'], 'ONLINE must never fail over to Ollama or another cloud provider');
  failoverCalls.length = 0;
  const local = await performanceContext.run(createPerformanceTelemetry('OFFLINE'), () =>
    failoverRouter.generate({ role: 'creativeGeneration', request: request('offline-local') }));
  assert.equal(local.metadata.provider, 'ollama'); assert.equal(local.data.value, 'local');
  assert.deepEqual(failoverCalls, ['ollama'], 'OFFLINE must never call a cloud provider');

  const wireRoles = [];
  const originalFetchForRoles = global.fetch;
  global.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    wireRoles.push(body.messages[0].content);
    if (wireRoles.length === 1) throw new DOMException('synthetic timeout', 'TimeoutError');
    return { ok: true, status: 200, json: async () => ({ done: true,
      message: { content: '{"value":"creative-ok"}' } }) };
  };
  const independent = await performanceContext.run(createPerformanceTelemetry('OFFLINE'), async () => {
    const metrics = performanceContext.getStore();
    const roleRouter = new LlmRouterService(new LlmProviderService());
    await assert.rejects(() => roleRouter.generate({ role: 'clipUnderstanding',
      request: request('clip-timeout') }), error => error.kind === 'LOCAL_TIMEOUT_FAILURE');
    const creative = await roleRouter.generate({ role: 'creativeGeneration',
      request: request('creative-after-timeout') });
    assert.equal(creative.metadata.provider, 'ollama');
    assert.equal(creative.metadata.model, 'qwen3:4b');
    assert.equal(creative.data.value, 'creative-ok');
    return metrics;
  });
  global.fetch = originalFetchForRoles;
  assert.equal(wireRoles.length, 2,
    'creativeGeneration must reach Ollama after clipUnderstanding times out');
  assert.equal(independent.llmRequestCountByRole.clipUnderstanding, 1);
  assert.equal(independent.llmRequestCountByRole.creativeGeneration, 1);
  assert.equal(independent.requestedAiMode, 'OFFLINE');
  assert.equal(independent.effectiveAiMode, 'OFFLINE');
  assert.equal(independent.cloudLlmCalls, 0);
  assert.equal(independent.circuitOpenCount, 0);
  let schemaCalls = 0;
  const schemaRouter = new LlmRouterService({ isConfigured: configured,
    async generateStructuredWithConfig() {
      schemaCalls++;
      if (schemaCalls === 1) throw new LlmProviderError('LOCAL_SCHEMA_FAILURE', 'bad JSON');
      return { value: 'creative-after-schema' };
    } });
  await performanceContext.run(createPerformanceTelemetry('OFFLINE'), async () => {
    await assert.rejects(() => schemaRouter.generate({ role: 'clipUnderstanding',
      request: request('schema-failure') }), error => error.kind === 'LOCAL_SCHEMA_FAILURE');
    const creative = await schemaRouter.generate({ role: 'creativeGeneration',
      request: request('creative-after-schema') });
    assert.equal(creative.data.value, 'creative-after-schema');
  });
  assert.equal(schemaCalls, 2, 'schema failure must not open provider availability circuit');

  const originalFetch = global.fetch;
  const localEndpoint = { provider: 'ollama', apiKey: '', baseUrl: 'http://ollama.invalid',
    model: 'qwen3:4b', apiStyle: 'ollama', timeoutMs: 1000, maxRetries: 0,
    retryBaseDelayMs: 1, concurrency: 1 };
  const provider = new LlmProviderService();
  let wireBody;
  global.fetch = async (_, options) => { wireBody = JSON.parse(options.body); return {
    ok: true, status: 200, json: async () => ({ model: 'qwen3:4b', done: true,
      done_reason: 'stop', eval_count: 12, message: { role: 'assistant',
        thinking: 'private reasoning', content: '{"value":"valid"}' } }) }; };
  assert.deepEqual(await provider.generateStructuredWithConfig(localEndpoint, request('valid')),
    { value: 'valid' });
  assert.equal(wireBody.stream, false); assert.equal(wireBody.think, false);
  assert.equal(wireBody.keep_alive, '5m'); assert.equal(wireBody.messages.some(m => m.images), false);

  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ done: true,
    message: { content: 'Here is the result:\n```json\n{"value":"wrapped"}\n```' } }) });
  assert.deepEqual(await provider.generateStructuredWithConfig(localEndpoint, request('wrapped')),
    { value: 'wrapped' });

  let invalidCalls = 0;
  global.fetch = async () => { invalidCalls++; return { ok: true, status: 200,
    json: async () => ({ done: true, message: { content: 'not json' } }) }; };
  await assert.rejects(() => provider.generateStructuredWithConfig(
    { ...localEndpoint, maxRetries: 2 }, request('invalid')), error =>
    error.kind === 'LOCAL_RESPONSE_FAILURE');
  assert.equal(invalidCalls, 1, 'invalid local output must not recursively regenerate');

  global.fetch = async () => ({ ok: false, status: 404,
    text: async () => JSON.stringify({ error: "model 'missing' not found" }) });
  await assert.rejects(() => provider.generateStructuredWithConfig(
    { ...localEndpoint, model: 'missing' }, request('missing')), error =>
    error.kind === 'LOCAL_MODEL_NOT_FOUND');

  global.fetch = (_, options) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('abort was not enforced')), 2000);
    options.signal.addEventListener('abort', () => { clearTimeout(timer);
      reject(options.signal.reason); }, { once: true });
  });
  await assert.rejects(() => provider.generateStructuredWithConfig(
    { ...localEndpoint, timeoutMs: 20 }, request('timeout')), error =>
    error.kind === 'LOCAL_TIMEOUT_FAILURE');

  let active = 0, peak = 0, wireCalls = 0;
  global.fetch = async () => { active++; peak = Math.max(peak, active); wireCalls++;
    await new Promise(resolve => setTimeout(resolve, 10)); active--; return { ok: true, status: 200,
      json: async () => ({ done: true, message: { content: '{"value":"queued"}' } }) }; };
  await Promise.all(Array.from({ length: 4 }, (_, index) =>
    provider.generateStructuredWithConfig(localEndpoint, request('queue-' + index))));
  assert.equal(peak, 1); assert.equal(wireCalls, 4);

  let cacheCalls = 0;
  global.fetch = async () => { cacheCalls++; return { ok: true, status: 200,
    json: async () => ({ output_text: '{"value":"cloud-cache"}' }) }; };
  const cloudEndpoint = { ...localEndpoint, provider: 'openai', apiKey: 'test',
    baseUrl: 'https://provider.invalid/v1', model: 'cloud', apiStyle: 'responses' };
  const sharedRequest = request('provider-cache');
  await provider.generateStructuredWithConfig(cloudEndpoint, sharedRequest);
  global.fetch = async () => { cacheCalls++; return { ok: true, status: 200,
    json: async () => ({ done: true, message: { content: '{"value":"local-cache"}' } }) }; };
  await provider.generateStructuredWithConfig(localEndpoint, sharedRequest);
  await provider.generateStructuredWithConfig(localEndpoint, sharedRequest);
  assert.equal(cacheCalls, 2, 'cloud and local caches must be isolated by provider/model');

  let recoveryCalls = 0;
  global.fetch = async () => { recoveryCalls++; if (recoveryCalls === 1) throw new TypeError('connect failed');
    return { ok: true, status: 200,
      json: async () => ({ done: true, message: { content: '{"value":"recovered"}' } }) }; };
  await assert.rejects(() => provider.generateStructuredWithConfig(localEndpoint, request('no-failure-cache')),
    error => error.kind === 'LOCAL_CONNECTION_FAILURE');
  assert.deepEqual(await provider.generateStructuredWithConfig(localEndpoint, request('no-failure-cache')),
    { value: 'recovered' });
  assert.equal(recoveryCalls, 2, 'failed local outputs must never be cached');

  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '1';
  process.env.LLM_CIRCUIT_COOLDOWN_MS = '60000';
  process.env.LOCAL_LLM_CIRCUIT_FAILURE_THRESHOLD = '2';
  process.env.LOCAL_LLM_CIRCUIT_COOLDOWN_MS = '1000';
  let now = 10000, localCalls = 0, localHealthy = false;
  const realNow = Date.now; Date.now = () => now;
  const circuit = new LlmRouterService({ isConfigured: configured,
    async generateStructuredWithConfig(config) {
      if (config.provider === 'ollama') { localCalls++;
        if (localHealthy) return { value: 'recovered' };
        throw new LlmProviderError('LOCAL_CONNECTION_FAILURE', 'offline'); }
      throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'cloud offline', 503);
    } });
  await performanceContext.run(createPerformanceTelemetry('OFFLINE'), async () => {
    await assert.rejects(() => circuit.generate({ role: 'creativeGeneration', request: request('circuit-1') }));
    await assert.rejects(() => circuit.generate({ role: 'creativeGeneration', request: request('circuit-2') }));
    await assert.rejects(() => circuit.generate({ role: 'creativeGeneration', request: request('circuit-skip') }),
      error => error.kind === 'CIRCUIT_OPEN');
    await assert.rejects(() => circuit.generate({ role: 'clipUnderstanding',
      request: request('availability-shared') }), error => error.kind === 'CIRCUIT_OPEN');
    assert.equal(localCalls, 2, 'open local circuit must skip later requests immediately');
    now += 1001; localHealthy = true;
    const recovered = await circuit.generate({ role: 'creativeGeneration', request: request('half-open') });
    assert.equal(recovered.metadata.provider, 'ollama'); assert.equal(localCalls, 3);
  });
  Date.now = realNow;

  const unavailable = new LlmRouterService({ isConfigured: configured,
    async generateStructuredWithConfig(config) { throw new LlmProviderError(config.provider === 'ollama'
      ? 'LOCAL_PROVIDER_UNAVAILABLE' : 'PROVIDER_5XX_FAILURE', 'offline', 503); } });
  const fallback = await performanceContext.run(createPerformanceTelemetry('OFFLINE'), () =>
    new VideoUnderstandingService(unavailable).analyzeWithFallback([
      { position: 0, startTime: 0, endTime: 10, text: 'A grounded transcript remains usable.' }
    ], 'en'));
  assert.ok(fallback.summary); assert.equal(fallback.chapters.length, 1);

  assert.equal(processingModeFor([{ provider: 'google' }], true), 'CLOUD_AI');
  assert.equal(processingModeFor([{ provider: 'ollama' }], true), 'LOCAL_AI');
  assert.equal(processingModeFor([{ provider: 'nvidia' }, { provider: 'ollama' }], true),
    'PARTIAL_CLOUD_AI');
  assert.equal(processingModeFor([{ provider: 'ollama' }], false), 'DETERMINISTIC_FALLBACK');

  let localCreativeRequest;
  const localJudge = new ClipJudgeService({ isAnyConfigured: () => true,
    routesFor: () => routes, configuredRouteFor: () => routes[0], async generate(input) {
      localCreativeRequest = input.request;
      return { data: { candidates: [{ hooks: [
        { text: 'A reliable workflow turns evidence into a clear result.', style: 'strong claim' },
        { text: 'How does grounded evidence keep this workflow reliable?', style: 'question' },
        { text: 'Without grounded claims, the workflow loses its useful conclusion.',
          style: 'stakes/consequence' }], title: 'A Reliable Evidence Workflow',
      caption: 'Grounded evidence keeps this workflow clear from process to conclusion.',
      synopsis: 'The clip explains a reliable workflow based on grounded evidence.\n\nThe process keeps its claims grounded as it produces a clear result.\n\nThat evidence supports the useful conclusion reached by the workflow.',
      hashtags: ['#ReliableWorkflow', '#GroundedEvidence', '#ClearResult', '#UsefulConclusion',
        '#WorkflowDesign'] }] }, metadata: { role: 'creativeGeneration',
        provider: 'ollama', model: 'qwen3:4b', failover: true, cacheHit: false, attempts: [] } };
    } });
  const localCandidate = { videoId: 'video', rangeKey: '0:30', startTime: 0, endTime: 30,
    duration: 30, transcriptText: 'A reliable workflow uses evidence to produce a clear result. ' +
      'The process keeps every claim grounded and finishes with a useful conclusion.',
    heuristicScore: 75, judgeSource: 'HEURISTIC_FALLBACK', rank: null, hookScore: 75,
    sourceHookScore: 75, standaloneScore: 75, payoffScore: 75, flowScore: 75,
    informationScore: 75, retentionScore: 75, shareabilityScore: 75,
    contentPotential: 75, overallScore: 75, reject: false, topic: 'reliable workflow',
    reason: 'Synthetic grounded candidate', rejectionReason: '' };
  const locallyGenerated = await localJudge.judgeCandidates([localCandidate]);
  assert.ok(localCreativeRequest.local, 'creative requests must define a compact local schema');
  assert.equal(localCreativeRequest.local.maxOutputTokens, 3000);
  assert.equal(locallyGenerated[0].generationMode, 'LOCAL_AI');
  assert.equal(locallyGenerated[0].fallbackUsed, false);
  assert.equal(locallyGenerated[0].hooks.length, 3);
  assert.equal(locallyGenerated[0].hashtags.length, 5);
  assert.equal(locallyGenerated[0].synopsis.split(/\n\n/u).length, 3);

  const videoWireSchema = geminiJsonSchema(VIDEO_UNDERSTANDING_SCHEMA, 'video_understanding');
  assert.equal(JSON.stringify(videoWireSchema).includes('minimum'), false);
  assert.equal(JSON.stringify(videoWireSchema).includes('maximum'), false);
  assert.equal(JSON.stringify(videoWireSchema).includes('minItems'), false);
  assert.equal(JSON.stringify(videoWireSchema).includes('maxItems'), false);
  assert.equal(JSON.stringify(VIDEO_UNDERSTANDING_SCHEMA).includes('minimum'), true,
    'backend validation bounds must remain unchanged');
  assert.equal(JSON.stringify(VIDEO_UNDERSTANDING_SCHEMA).includes('maxItems'), true);
  const manySignals = Array.from({ length: 80 }, (_, position) => ({ position,
    startTime: position * 10, endTime: position * 10 + 10, sceneChangeCount: position % 4,
    averageMotion: position, faceCount: 1, largestFaceRatio: 10, brightness: 50,
    contrast: 20, colorfulness: 30, ocrText: 'x'.repeat(500), subtitleDetected: false }));
  const compact = compactVisualSignals(manySignals);
  assert.ok(compact.length <= MAX_MULTIMODAL_OBSERVATIONS);
  assert.ok(compact.every(signal => signal.ocrText.length <= 160));
  let multimodalRequest;
  await new ClipIntelligenceService({ async generate(input) { multimodalRequest = input.request;
    return { data: { observations: [] }, metadata: { provider: 'google' } }; } })
    .analyzeMultimodal('compact-test', manySignals);
  assert.ok(JSON.parse(multimodalRequest.userPrompt).length <= MAX_MULTIMODAL_OBSERVATIONS);
  assert.equal(multimodalRequest.maxOutputTokens, 4096);
  assert.equal(multimodalRequest.schema.properties.observations.maxItems,
    MAX_MULTIMODAL_OBSERVATIONS);

  global.fetch = originalFetch;
  console.log(JSON.stringify({ localDisabled: true, cloudPreferred: true, strictModeIsolation: true,
    localStructuredJson: true, localWrappedJsonRepair: true, localTimeoutAbort: true,
    localCircuitAndHalfOpen: true, localConcurrencyOne: true, providerCacheIsolation: true,
    failureCacheIsolation: true, processingModes: true, geminiVideoWireSchema: true,
    compactMultimodalOutput: true, compactLocalCreativePackage: true,
    deterministicFallback: true }));
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
