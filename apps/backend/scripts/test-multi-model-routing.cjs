require('reflect-metadata');
const assert = require('node:assert/strict');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { LlmProviderError, LlmProviderService } = require('../dist/modules/processing/llm-provider.service');
const { performanceContext, createPerformanceTelemetry } = require('../dist/modules/processing/performance-telemetry');
const { CLIP_CONTENT_PACKAGE_SCHEMA } = require('../dist/modules/processing/openai-clip-judge.service');

const ENV_KEYS = ['NVIDIA_API_KEY', 'NVIDIA_MODEL', 'NVIDIA_MULTIMODAL_PROVIDER',
  'NVIDIA_MULTIMODAL_MODEL', 'NVIDIA_REASONING_PROVIDER', 'NVIDIA_REASONING_MODEL',
  'GOOGLE_API_KEY', 'GOOGLE_CREATIVE_PROVIDER', 'GOOGLE_CREATIVE_MODEL',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_MODEL',
  'LLM_CIRCUIT_FAILURE_THRESHOLD', 'LLM_CIRCUIT_COOLDOWN_MS', 'LLM_CIRCUIT_WINDOW_MS',
  'GOOGLE_RATE_LIMIT_COOLDOWN_MS', 'LLM_RETRY_JITTER_MS', 'LLM_RETRY_BASE_DELAY_MS',
  'LLM_JOB_MAX_CALLS', 'LLM_CLIP_UNDERSTANDING_PROVIDERS',
  'LLM_WHOLE_VIDEO_UNDERSTANDING_PROVIDERS'];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
const request = (key) => ({ schemaName: 'routing_test', schema,
  systemPrompt: 'Return the supplied value.', userPrompt: '{"value":"ok"}', cacheKey: key });

async function main() {
  return performanceContext.run(createPerformanceTelemetry('ONLINE'), async () => {
  process.env.NVIDIA_API_KEY = 'test-nvidia-key';
  process.env.NVIDIA_MULTIMODAL_PROVIDER = 'nvidia';
  process.env.NVIDIA_MULTIMODAL_MODEL = 'configured-omni-model';
  process.env.NVIDIA_REASONING_PROVIDER = 'nvidia';
  process.env.NVIDIA_REASONING_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
  process.env.GOOGLE_API_KEY = 'test-google-key';
  process.env.GOOGLE_CREATIVE_PROVIDER = 'google';
  process.env.GOOGLE_CREATIVE_MODEL = 'configured-gemini-flash-model';
  process.env.OPENAI_API_KEY = 'stale-openai-key';
  process.env.OPENAI_MODEL = 'stale-openai-model';
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '1';
  process.env.LLM_CIRCUIT_COOLDOWN_MS = '60000';

  const calls = [];
  let failOmni = false;
  let failSuper = false;
  let failGoogle = false;
  const provider = {
    isConfigured: (config) => !!(config.apiKey && config.baseUrl && config.model),
    async generateStructuredWithConfig(config) {
      calls.push([config.provider, config.model]);
      if ((config.model === 'configured-omni-model' && failOmni) ||
        (config.model.includes('nemotron-3-super') && failSuper) ||
        (config.model === 'configured-gemini-flash-model' && failGoogle)) {
        throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'simulated failure', 503, true);
      }
      return { value: config.model };
    }
  };
  const router = new LlmRouterService(provider);
  const expectedRoutes = {
    multimodalUnderstanding: ['google', 'nvidia'],
    wholeVideoUnderstanding: ['google', 'nvidia'],
    clipUnderstanding: ['google', 'nvidia'],
    candidateJudge: ['google', 'nvidia'],
    creativeGeneration: ['google', 'nvidia'],
    critic: ['google', 'nvidia']
  };
  for (const [role, providers] of Object.entries(expectedRoutes)) {
    assert.deepEqual(router.routesFor(role).map(({ provider: name }) => name), providers,
      role + ' must use the production primary and failover order');
  }
  const timeoutCalls = [];
  const timeoutProvider = { isConfigured: provider.isConfigured,
    async generateStructuredWithConfig(config, input) {
      timeoutCalls.push([input.role, config.provider, config.maxRetries]);
      if (config.provider === 'google' && input.role === 'wholeVideoUnderstanding' ||
        config.provider === 'nvidia' && input.role === 'clipUnderstanding')
        throw new LlmProviderError('TIMEOUT_FAILURE', 'synthetic deadline');
      return { value: config.provider };
    } };
  const timeoutRouter = new LlmRouterService(timeoutProvider);
  const googleTimeout = await timeoutRouter.generate({ role: 'wholeVideoUnderstanding',
    request: request('google-timeout') });
  assert.equal(googleTimeout.metadata.provider, 'nvidia');
  process.env.LLM_CLIP_UNDERSTANDING_PROVIDERS = 'nvidia,google';
  const nvidiaTimeout = await timeoutRouter.generate({ role: 'clipUnderstanding',
    request: request('nvidia-timeout') });
  assert.equal(nvidiaTimeout.metadata.provider, 'google');
  delete process.env.LLM_CLIP_UNDERSTANDING_PROVIDERS;
  const unrelated = await timeoutRouter.generate({ role: 'creativeGeneration',
    request: request('after-other-role-timeout') });
  assert.equal(unrelated.metadata.provider, 'google');
  assert.ok(timeoutCalls.every(([, , retries]) => retries === 0));
  assert.equal(router.configuredRouteFor('creativeGeneration').provider, 'google',
    'normal production configuration must select Google for creative generation');
  assert.equal(router.routesFor('creativeGeneration').some(({ provider: name }) => name === 'openai'),
    false, 'OPENAI_* variables alone must not opt into the legacy production route');

  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_API_KEY = 'explicit-openai-key';
  process.env.LLM_MODEL = 'explicit-openai-model';
  assert.deepEqual(new LlmRouterService(provider).routesFor('creativeGeneration')
    .map(({ provider: name }) => name), ['google', 'nvidia'],
  'ONLINE must exclude explicit legacy providers outside the cloud allowlist');
  assert.equal(new LlmRouterService(provider).configuredRouteFor('creativeGeneration').provider,
    'google', 'Google remains primary when explicit legacy OpenAI is also configured');
  delete process.env.NVIDIA_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  assert.equal(new LlmRouterService(provider).configuredRouteFor('creativeGeneration'),
    undefined, 'ONLINE must not escape to OpenAI when Google and NVIDIA are unavailable');
  process.env.NVIDIA_API_KEY = 'test-nvidia-key';
  process.env.GOOGLE_API_KEY = 'test-google-key';
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;

  const omni = await router.generate({ role: 'multimodalUnderstanding', request: request('omni') });
  assert.equal(omni.metadata.model, 'configured-gemini-flash-model');
  const superResult = await router.generate({ role: 'wholeVideoUnderstanding', request: request('super') });
  assert.equal(superResult.metadata.model, 'configured-gemini-flash-model');
  const creative = await router.generate({ role: 'creativeGeneration', request: request('creative') });
  assert.equal(creative.metadata.model, 'configured-gemini-flash-model');

  failGoogle = true;
  const omniFailover = await router.generate({ role: 'multimodalUnderstanding', request: request('omni-fail') });
  assert.equal(omniFailover.metadata.provider, 'nvidia');
  assert.equal(omniFailover.metadata.failover, true);
  failGoogle = false;
  const stillHealthySuper = await router.generate({ role: 'critic', request: request('super-still-healthy') });
  assert.equal(stillHealthySuper.metadata.provider, 'google');

  process.env.LLM_CLIP_UNDERSTANDING_PROVIDERS = 'nvidia,google';
  failSuper = true;
  const healthRouter = new LlmRouterService(provider);
  const superFailover = await healthRouter.generate({
    role: 'candidateJudge', request: request('super-fail') });
  assert.equal(superFailover.metadata.provider, 'google');
  failSuper = false;
  const duringCooldown = await healthRouter.generate({
    role: 'candidateJudge', request: request('super-cooldown') });
  assert.equal(duringCooldown.metadata.provider, 'google');
  healthRouter.resetHealth();
  const recovered = await healthRouter.generate({
    role: 'candidateJudge', request: request('super-recovered') });
  assert.equal(recovered.metadata.provider, 'nvidia');
  delete process.env.LLM_CLIP_UNDERSTANDING_PROVIDERS;
  failGoogle = true;
  const creativeFailover = await new LlmRouterService(provider).generate({
    role: 'creativeGeneration', request: request('google-fail') });
  assert.equal(creativeFailover.metadata.provider, 'nvidia');

  failOmni = true; failSuper = true; failGoogle = true;
  await assert.rejects(() => new LlmRouterService(provider).generate({
    role: 'critic', request: request('all-fail') }), /simulated failure/);

  const originalFetch = global.fetch;
  const rawProvider = new LlmProviderService();
  const endpoint = { provider: 'test', apiKey: 'server-key', baseUrl: 'https://provider.invalid/v1',
    model: 'test-model', apiStyle: 'responses', timeoutMs: 1000, maxRetries: 0,
    retryBaseDelayMs: 1, concurrency: 1 };
  const expectFailure = async (key, fetcher, kind) => {
    global.fetch = fetcher;
    await assert.rejects(() => rawProvider.generateStructuredWithConfig(endpoint, request(key)),
      (error) => error.kind === kind);
  };
  await expectFailure('auth', async () => ({ ok: false, status: 401, text: async () => '' }),
    'AUTH_FAILURE');
  await expectFailure('quota', async () => ({ ok: false, status: 429, text: async () => 'quota exhausted' }),
    'QUOTA_FAILURE');
  await expectFailure('rate', async () => ({ ok: false, status: 429, text: async () => 'slow down' }),
    'RATE_LIMIT_FAILURE');
  await expectFailure('network', async () => { throw new TypeError('network unavailable'); },
    'NETWORK_FAILURE');
  await expectFailure('timeout', async () => { const error = new Error('timed out');
    error.name = 'TimeoutError'; throw error; }, 'TIMEOUT_FAILURE');
  await expectFailure('json', async () => ({ ok: true, json: async () => ({ output_text: 'not json' }) }),
    'MALFORMED_RESPONSE_FAILURE');

  let invalidCalls = 0;
  await expectFailure('invalid-400', async () => { invalidCalls++; return {
    ok: false, status: 400, text: async () => 'INVALID_ARGUMENT schema rejected' }; },
  'INVALID_REQUEST_FAILURE');
  assert.equal(invalidCalls, 1, 'an invalid 400 request must not be retried unchanged');

  process.env.LLM_RETRY_JITTER_MS = '0';
  const geminiEndpoint = { ...endpoint, provider: 'google', apiStyle: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test',
    maxRetries: 1, retryBaseDelayMs: 1 };
  let transientCalls = 0;
  global.fetch = async () => {
    transientCalls++;
    if (transientCalls === 1) return { ok: false, status: 503, text: async () => 'UNAVAILABLE' };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [
      { text: '{"value":"ok"}' }] } }] }) };
  };
  await rawProvider.generateStructuredWithConfig(geminiEndpoint, request('gemini-503-retry'));
  assert.equal(transientCalls, 2, 'Gemini 503 should receive one bounded retry');

  const sampleFor = (wireSchema) => {
    if (wireSchema.type === 'object') return Object.fromEntries((wireSchema.required || [])
      .map(key => [key, sampleFor(wireSchema.properties[key])]));
    if (wireSchema.type === 'array') return Array.from({ length: wireSchema.minItems || 0 },
      () => sampleFor(wireSchema.items));
    if (wireSchema.type === 'number' || wireSchema.type === 'integer') return wireSchema.minimum || 0;
    if (wireSchema.type === 'boolean') return false;
    return wireSchema.enum?.[0] || 'x';
  };
  let geminiBody;
  global.fetch = async (_, options) => { geminiBody = JSON.parse(options.body); return {
    ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [
      { text: JSON.stringify(sampleFor(CLIP_CONTENT_PACKAGE_SCHEMA)) }] } }] }) }; };
  await rawProvider.generateStructuredWithConfig({ ...geminiEndpoint, maxRetries: 0 }, {
    ...request('gemini-schema'), schemaName: 'clip_candidate_content_package',
    schema: CLIP_CONTENT_PACKAGE_SCHEMA, partialBatchField: 'candidates' });
  assert.equal(geminiBody.generationConfig.responseMimeType, 'application/json');
  assert.equal(geminiBody.generationConfig.responseSchema, undefined);
  assert.equal(JSON.stringify(geminiBody.generationConfig.responseJsonSchema).includes('minLength'), false);
  assert.equal(JSON.stringify(geminiBody.generationConfig.responseJsonSchema).includes('maxLength'), false);
  assert.equal(JSON.stringify(geminiBody.generationConfig.responseJsonSchema).includes('minimum'), false,
    'the proven Gemini complexity trigger is omitted from this wire schema only');
  assert.equal(JSON.stringify(geminiBody.generationConfig.responseJsonSchema).includes('maximum'), false);
  assert.equal(JSON.stringify(CLIP_CONTENT_PACKAGE_SCHEMA).includes('minimum'), true,
    'local score-bound validation must remain intact');

  global.fetch = async () => ({ ok: false, status: 400,
    text: async () => JSON.stringify({ error: { code: 400,
      message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }) });
  await assert.rejects(() => rawProvider.generateStructuredWithConfig(
    { ...geminiEndpoint, maxRetries: 0 }, request('gemini-invalid-400')), error =>
    error.kind === 'INVALID_REQUEST_FAILURE' && error.providerReason === 'INVALID_ARGUMENT');
  let temporary429;
  global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => '7' },
    text: async () => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'Too many requests', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com' }] } }) });
  await assert.rejects(() => rawProvider.generateStructuredWithConfig(
    { ...geminiEndpoint, maxRetries: 0 }, request('google-temporary-429')), error => {
    temporary429 = error; return error.kind === 'RATE_LIMIT_FAILURE';
  });
  assert.equal(temporary429.retryAfterMs, 7000, 'Retry-After must be preserved for the route gate');
  global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null },
    text: async () => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded for metric daily requests; limit: 0',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }] } }) });
  await assert.rejects(() => rawProvider.generateStructuredWithConfig(
    { ...geminiEndpoint, maxRetries: 0 }, request('google-hard-quota')), error =>
    error.kind === 'QUOTA_EXHAUSTED_FAILURE');

  // A temporary Google 429 opens immediately, honors Retry-After, and skips later creative calls.
  process.env.GOOGLE_RATE_LIMIT_COOLDOWN_MS = '1000';
  let gateNow = 5000, rateCalls = 0, rateLimited = true;
  const gateRealNow = Date.now; Date.now = () => gateNow;
  const rateRouter = new LlmRouterService({ isConfigured: provider.isConfigured,
    async generateStructuredWithConfig(config) {
      if (config.provider === 'google') { rateCalls++;
        if (rateLimited) throw new LlmProviderError('RATE_LIMIT_FAILURE', '429', 429,
          false, 1, 7000, 'RATE_LIMIT_EXCEEDED'); }
      return { value: config.model };
    } });
  await rateRouter.generate({ role: 'creativeGeneration', request: request('rate-gate-one') });
  await rateRouter.generate({ role: 'creativeGeneration', request: request('rate-gate-two') });
  assert.equal(rateCalls, 1, 'later creative requests must skip rate-limited Gemini');
  gateNow += 6999; rateLimited = false;
  await rateRouter.generate({ role: 'creativeGeneration', request: request('rate-before-retry-after') });
  assert.equal(rateCalls, 1, 'Retry-After gate must remain closed for its full duration');
  gateNow += 2;
  await rateRouter.generate({ role: 'creativeGeneration', request: request('rate-after-retry-after') });
  assert.equal(rateCalls, 2, 'one half-open request may run after Retry-After');

  // Hard quota exhaustion is scoped to the current processing job and never half-opens in that job.
  let quotaCalls = 0;
  const quotaRouter = new LlmRouterService({ isConfigured: provider.isConfigured,
    async generateStructuredWithConfig(config) {
      if (config.provider === 'google') { quotaCalls++;
        throw new LlmProviderError('QUOTA_EXHAUSTED_FAILURE', 'quota exhausted', 429); }
      return { value: config.model };
    } });
  await performanceContext.run(createPerformanceTelemetry('ONLINE'), async () => {
    await quotaRouter.generate({ role: 'creativeGeneration', request: request('quota-job-one') });
    await quotaRouter.generate({ role: 'creativeGeneration', request: request('quota-job-two') });
    assert.equal(quotaCalls, 1, 'hard quota must disable Gemini for the remainder of the job');
  });
  Date.now = gateRealNow;

  // A valid HTTP 200 cut off by the output limit is truncation, not malformed JSON or provider health.
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{
    finish_reason: 'length', message: { content: '{\"value\":' } }],
    usage: { completion_tokens: 12000 } }) });
  await assert.rejects(() => rawProvider.generateStructuredWithConfig(
    { ...endpoint, apiStyle: 'chat_completions' }, request('truncated-json')), error =>
    error.kind === 'TRUNCATED_RESPONSE_FAILURE');
  let truncationCalls = 0;
  const truncationRouter = new LlmRouterService({ isConfigured: provider.isConfigured,
    async generateStructuredWithConfig(config) {
      if (config.provider === 'nvidia') { truncationCalls++;
        throw new LlmProviderError('TRUNCATED_RESPONSE_FAILURE', 'length', 200); }
      return { value: config.model };
    } });
  await truncationRouter.generate({ role: 'wholeVideoUnderstanding', request: request('trunc-one') });
  await truncationRouter.generate({ role: 'wholeVideoUnderstanding', request: request('trunc-two') });
  assert.equal(truncationCalls, 0, 'Google-primary routing does not invoke NVIDIA');

  // Three health failures open only Google; open skips, one half-open success closes.
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '3';
  process.env.LLM_CIRCUIT_COOLDOWN_MS = '1000';
  let now = 10000, googleCalls = 0, googleFails = true;
  const realNow = Date.now; Date.now = () => now;
  const breakerProvider = { isConfigured: provider.isConfigured,
    async generateStructuredWithConfig(config) {
      if (config.provider === 'google') { googleCalls++;
        if (googleFails) throw new LlmProviderError('PROVIDER_5XX_FAILURE', '503', 503, true); }
      return { value: config.model };
    } };
  const breaker = new LlmRouterService(breakerProvider);
  for (let i = 0; i < 3; i++) await breaker.generate({ role: 'creativeGeneration',
    request: request('breaker-' + i) });
  assert.equal(googleCalls, 3);
  await breaker.generate({ role: 'creativeGeneration', request: request('breaker-open') });
  assert.equal(googleCalls, 3, 'open circuit must skip Gemini');
  now += 1001; googleFails = false;
  const probe = await breaker.generate({ role: 'creativeGeneration', request: request('half-open-ok') });
  assert.equal(probe.metadata.provider, 'google');
  await breaker.generate({ role: 'creativeGeneration', request: request('closed-again') });
  assert.equal(googleCalls, 5, 'successful half-open probe must close the circuit');

  const reopen = new LlmRouterService(breakerProvider); googleFails = true; googleCalls = 0;
  for (let i = 0; i < 3; i++) await reopen.generate({ role: 'creativeGeneration',
    request: request('reopen-' + i) });
  now += 1001;
  await reopen.generate({ role: 'creativeGeneration', request: request('half-open-fail') });
  assert.equal(googleCalls, 4);
  await reopen.generate({ role: 'creativeGeneration', request: request('reopened-skip') });
  assert.equal(googleCalls, 4, 'failed half-open probe must reopen the circuit');

  // Content/schema failures answer successfully at transport level and never poison health.
  let schemaCalls = 0;
  const schemaRouter = new LlmRouterService({ isConfigured: provider.isConfigured,
    async generateStructuredWithConfig(config) { if (config.provider === 'google') {
      schemaCalls++; throw new LlmProviderError('SCHEMA_FAILURE', 'bad content'); }
      return { value: 'fallback' }; } });
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '1';
  await schemaRouter.generate({ role: 'creativeGeneration', request: request('schema-one') });
  await schemaRouter.generate({ role: 'creativeGeneration', request: request('schema-two') });
  assert.equal(schemaCalls, 2);
  Date.now = realNow;

  // Role deadlines and attempts are fixed per attempt and configurable independently.
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '3';
  const roleSettings = {};
  const settingsRouter = new LlmRouterService({ isConfigured: provider.isConfigured,
    async generateStructuredWithConfig(config, input) {
      roleSettings[input.role] = [config.timeoutMs, config.maxRetries + 1,
        input.options.timeoutMs]; return { value: 'ok' }; } });
  for (const role of ['multimodalUnderstanding', 'wholeVideoUnderstanding', 'clipUnderstanding',
    'creativeGeneration', 'critic', 'componentRepair']) {
    await settingsRouter.generate({ role, request: request('setting-' + role) });
  }
  assert.deepEqual(roleSettings.multimodalUnderstanding, [18000, 1, 18000]);
  assert.deepEqual(roleSettings.wholeVideoUnderstanding, [18000, 1, 18000]);
  assert.deepEqual(roleSettings.clipUnderstanding, [18000, 1, 18000]);
  assert.deepEqual(roleSettings.creativeGeneration, [20000, 1, 20000]);
  assert.deepEqual(roleSettings.critic, [12000, 1, 12000]);
  assert.deepEqual(roleSettings.componentRepair, [15000, 1, 15000]);

  // Provider semaphore respects the configured concurrency and only valid success is cached.
  let active = 0, peak = 0, wireCalls = 0;
  global.fetch = async () => { wireCalls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return { ok: true, status: 200,
      json: async () => ({ output_text: '{"value":"ok"}' }) }; };
  const concurrentProvider = new LlmProviderService();
  await Promise.all(Array.from({ length: 5 }, (_, index) => concurrentProvider
    .generateStructuredWithConfig({ ...endpoint, concurrency: 2 }, request('concurrency-' + index))));
  assert.equal(peak, 2);
  const cachedRequest = request('successful-cache');
  await concurrentProvider.generateStructuredWithConfig(endpoint, cachedRequest);
  await concurrentProvider.generateStructuredWithConfig(endpoint, cachedRequest);
  const afterSuccessCache = wireCalls;
  assert.equal(wireCalls, 6);
  let failOnce = true;
  global.fetch = async () => { wireCalls++; if (failOnce) { failOnce = false;
    return { ok: false, status: 503, text: async () => 'busy' }; }
    return { ok: true, status: 200, json: async () => ({ output_text: '{"value":"ok"}' }) }; };
  await assert.rejects(() => concurrentProvider.generateStructuredWithConfig(endpoint,
    request('failed-not-cache')), error => error.kind === 'PROVIDER_5XX_FAILURE');
  await concurrentProvider.generateStructuredWithConfig(endpoint, request('failed-not-cache'));
  assert.equal(wireCalls, afterSuccessCache + 2, 'failed responses must not be cached');

  // Per-job budget blocks optional/request amplification before another wire call.
  process.env.LLM_JOB_MAX_CALLS = '1';
  const budgetMetrics = createPerformanceTelemetry();
  const budgetProvider = new LlmProviderService();
  let budgetWireCalls = 0;
  global.fetch = async () => { budgetWireCalls++; return { ok: true, status: 200,
    json: async () => ({ output_text: '{"value":"ok"}' }) }; };
  await performanceContext.run(budgetMetrics, async () => {
    await budgetProvider.generateStructuredWithConfig(endpoint, request('budget-one'));
    await assert.rejects(() => budgetProvider.generateStructuredWithConfig(endpoint,
      request('budget-two')), error => error.kind === 'CALL_BUDGET_EXCEEDED');
  });
  assert.equal(budgetWireCalls, 1);
  global.fetch = originalFetch;

  const serializedCalls = JSON.stringify(calls);
  assert.equal(serializedCalls.includes('test-nvidia-key'), false);
  assert.equal(serializedCalls.includes('test-google-key'), false);
  console.log(JSON.stringify({ omniRoute: true, superRoute: true, geminiRoute: true,
    productionRoleTable: true, implicitOpenAiDisabled: true, strictOnlineAllowlist: true,
    perTaskFailover: true, independentNvidiaHealth: true, recoveryAfterCooldown: true,
    failureCategories: true, invalid400NoRetry: true, gemini503Retry: true,
    geminiProductionSchema: true, googleRateLimitGate: true, googleHardQuotaJobGate: true,
    retryAfterRespected: true, truncationClassification: true, truncationNotProviderHealth: true,
    circuitOpenAndHalfOpen: true, schemaDoesNotOpenCircuit: true, allPathsFailure: true,
    roleTimeouts: true, concurrencyLimits: true, successOnlyCache: true,
    callBudget: true, secretsExcluded: true }));
  });
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
