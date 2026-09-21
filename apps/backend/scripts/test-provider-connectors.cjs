require('reflect-metadata');
const assert = require('node:assert/strict');
const { ProviderRegistry } = require('../dist/modules/processing/provider-registry');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { LlmProviderError } = require('../dist/modules/processing/llm-provider.service');
const { createPerformanceTelemetry, performanceContext, countLlmRequest } =
  require('../dist/modules/processing/performance-telemetry');

const roles = ['wholeVideoUnderstanding', 'multimodalUnderstanding', 'clipUnderstanding',
  'deepReasoning', 'candidateJudge', 'creativeGeneration', 'hookGeneration',
  'captionGeneration', 'titleGeneration', 'hashtagGeneration', 'synopsisGeneration',
  'critic', 'groundingVerification', 'componentRepair'];
const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
const request = key => ({ schemaName: 'provider_simplification', schema,
  systemPrompt: 'Return JSON.', userPrompt: key, cacheKey: key });

async function main() {
  process.env.OPENAI_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'fixture-openai-key';
  process.env.OPENAI_MODEL = 'gpt-5.6-luna';
  for (const provider of ['GOOGLE', 'NVIDIA', 'ANTHROPIC', 'GROQ', 'OPENROUTER']) {
    process.env[provider + '_API_KEY'] = 'fixture-' + provider.toLowerCase() + '-key';
    process.env[provider + '_ENABLED'] = 'true';
  }
  process.env.ONLINE_PROVIDER_ORDER = 'google,nvidia,openrouter,anthropic,groq,openai';
  process.env.LOCAL_LLM_ENABLED = 'true';

  const registry = new ProviderRegistry();
  assert.deepEqual(registry.chain('creativeGeneration').map(provider => provider.id), ['openai']);
  assert.deepEqual(registry.list().map(provider => provider.id),
    ['google', 'nvidia', 'openai', 'anthropic', 'groq', 'openrouter']);

  const calls = [];
  const service = { isConfigured: config => config.apiStyle === 'ollama' ||
      !!(config.apiKey && config.model),
    async generateStructuredWithConfig(config, input) {
      calls.push({ provider: config.provider, model: config.model, role: input.role });
      countLlmRequest(input.role, config.provider);
      return { value: config.provider };
    } };
  const router = new LlmRouterService(service, registry);
  const onlineMetrics = createPerformanceTelemetry('ONLINE');
  await performanceContext.run(onlineMetrics, async () => {
    for (const role of roles) {
      assert.deepEqual(router.routesFor(role, 'ONLINE').map(route => route.provider), ['openai']);
      assert.equal(router.routesFor(role, 'ONLINE')[0].model, 'gpt-5.6-luna');
      await router.generate({ role, request: request('online-' + role) });
    }
  });
  assert.ok(onlineMetrics.cloudLlmCalls > 0);
  assert.equal(onlineMetrics.localLlmCalls, 0);
  assert.deepEqual([...new Set(calls.map(call => call.provider))], ['openai']);
  assert.equal(calls.some(call => call.model !== 'gpt-5.6-luna'), false);
  for (const provider of ['google', 'nvidia', 'openrouter', 'anthropic', 'groq', 'ollama'])
    assert.equal(calls.some(call => call.provider === provider), false);

  calls.length = 0;
  const offlineMetrics = createPerformanceTelemetry('OFFLINE');
  await performanceContext.run(offlineMetrics, () => router.generate({
    role: 'creativeGeneration', request: request('offline')
  }));
  assert.equal(offlineMetrics.cloudLlmCalls, 0);
  assert.equal(offlineMetrics.localLlmCalls, 1);
  assert.deepEqual(calls.map(call => call.provider), ['ollama']);

  calls.length = 0;
  const fallbackMetrics = createPerformanceTelemetry('FALLBACK_ONLY');
  await performanceContext.run(fallbackMetrics, async () => {
    await assert.rejects(() => router.generate({ role: 'creativeGeneration',
      request: request('fallback') }), error => error.kind === 'AI_MODE_FALLBACK_ONLY');
  });
  assert.equal(fallbackMetrics.cloudLlmCalls, 0);
  assert.equal(fallbackMetrics.localLlmCalls, 0);
  assert.deepEqual(calls, []);

  const failing = new LlmRouterService({
    isConfigured: () => true,
    async generateStructuredWithConfig() {
      throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'Luna fixture failure');
    }
  }, registry);
  const failMetrics = createPerformanceTelemetry('ONLINE');
  await performanceContext.run(failMetrics, () => assert.rejects(() => failing.generate({
    role: 'creativeGeneration', request: request('no-cross-provider-failover')
  })));
  assert.deepEqual(failing.routesFor('creativeGeneration', 'ONLINE')
    .map(route => route.provider), ['openai']);
  console.log('Provider connector tests passed: ONLINE is OpenAI Luna only; adapters preserved; modes isolated.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
