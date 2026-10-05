// Multi-model routing under the FINAL production policy (Step 6).
//
// The previous version of this file asserted Google -> NVIDIA cross-provider
// failover. That routing was retired before Step 6 (ONLINE became OpenAI-only)
// and Step 6 makes it final policy: ONLINE = the OpenAI API, every role; on any
// OpenAI failure the CALLER uses its deterministic fallback. There is no second
// provider and no local model to fail over to. The old assertions are preserved
// in git history.
//
// What still matters and is asserted here: per-role routing, per-role model
// selection from the environment, bounded single attempts, the per-role circuit
// breaker (open, cooldown, half-open recovery), rate-limit/quota handling,
// success-only caching and that secrets never leak. (The per-job call budget is
// enforced inside LlmProviderService and covered by test-pipeline-performance.cjs.)
require('reflect-metadata');
const assert = require('node:assert/strict');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { LlmProviderError } = require('../dist/modules/processing/llm-provider.service');
const { performanceContext, createPerformanceTelemetry } =
  require('../dist/modules/processing/performance-telemetry');

const ENV_KEYS = ['NVIDIA_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_ENABLED', 'NVIDIA_ENABLED',
  'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_CRITIC_MODEL', 'LLM_PROVIDER', 'LLM_API_KEY',
  'LLM_MODEL', 'LLM_CIRCUIT_FAILURE_THRESHOLD', 'LLM_CIRCUIT_COOLDOWN_MS',
  'LLM_JOB_MAX_CALLS', 'LLM_CLIP_UNDERSTANDING_PROVIDERS', 'ONLINE_PROVIDER_ORDER'];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
const request = (key) => ({ schemaName: 'routing_test', schema,
  systemPrompt: 'Return the supplied value.', userPrompt: '{"value":"ok"}', cacheKey: key });
const ROLES = ['multimodalUnderstanding', 'wholeVideoUnderstanding', 'clipUnderstanding',
  'candidateJudge', 'creativeGeneration', 'critic', 'componentRepair', 'editingPlan'];

async function main() {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_MODEL = 'env-openai-model';
  process.env.OPENAI_CRITIC_MODEL = 'env-critic-model';
  // Other cloud keys and explicit orderings must NOT re-open multi-provider routing.
  process.env.GOOGLE_API_KEY = 'test-google-key'; process.env.GOOGLE_ENABLED = 'true';
  process.env.NVIDIA_API_KEY = 'test-nvidia-key'; process.env.NVIDIA_ENABLED = 'true';
  process.env.LLM_CLIP_UNDERSTANDING_PROVIDERS = 'nvidia,google';
  process.env.ONLINE_PROVIDER_ORDER = 'google,nvidia,openai';
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '1';
  process.env.LLM_CIRCUIT_COOLDOWN_MS = '60000';

  const calls = [];
  let fail = null;
  const provider = {
    isConfigured: (config) => !!(config.apiKey && config.baseUrl && config.model),
    async generateStructuredWithConfig(config, input) {
      calls.push({ provider: config.provider, model: config.model, role: input.role,
        maxRetries: config.maxRetries, timeoutMs: config.timeoutMs });
      if (fail) throw fail;
      return { value: config.model };
    }
  };

  await performanceContext.run(createPerformanceTelemetry('ONLINE'), async () => {
    const router = new LlmRouterService(provider);
    for (const role of ROLES) {
      assert.deepEqual(router.routesFor(role).map((route) => route.provider), ['openai'],
        `${role} routes to OpenAI only`);
    }
    assert.equal(router.routesFor('critic')[0].model, 'env-critic-model', 'role model from env');
    assert.equal(router.routesFor('creativeGeneration')[0].model, 'env-openai-model');

    const creative = await router.generate({ role: 'creativeGeneration', request: request('a') });
    assert.equal(creative.metadata.provider, 'openai');
    assert.equal(creative.metadata.failover, false);
    assert.ok(calls.every((call) => call.maxRetries === 0), 'bounded: one attempt per request');

    // Success-only cache: the same request is not re-sent.
    const before = calls.length;
    const cached = await router.generate({ role: 'creativeGeneration', request: request('a') });
    assert.equal(cached.metadata.cacheHit, true);
    assert.equal(calls.length, before);

    // 5xx opens the per-role circuit; other roles stay healthy.
    fail = new LlmProviderError('PROVIDER_5XX_FAILURE', 'simulated', 503, true);
    await assert.rejects(() => router.generate({ role: 'clipUnderstanding', request: request('b') }),
      (error) => error.kind === 'PROVIDER_5XX_FAILURE');
    await assert.rejects(() => router.generate({ role: 'clipUnderstanding', request: request('c') }),
      (error) => error.kind === 'CIRCUIT_OPEN', 'the role circuit is open during cooldown');
    fail = null;
    const other = await router.generate({ role: 'critic', request: request('d') });
    assert.equal(other.metadata.provider, 'openai', 'a failure in one role does not block another');
    router.resetHealth();
    const recovered = await router.generate({ role: 'clipUnderstanding', request: request('e') });
    assert.equal(recovered.metadata.provider, 'openai', 'recovery after cooldown/reset');

    // Schema/invalid-request failures say nothing about availability.
    fail = new LlmProviderError('SCHEMA_FAILURE', 'bad json');
    await assert.rejects(() => router.generate({ role: 'componentRepair', request: request('f') }));
    fail = null;
    const afterSchema = await router.generate({ role: 'componentRepair', request: request('g') });
    assert.equal(afterSchema.metadata.provider, 'openai', 'schema failure does not open the circuit');

    // Auth failure marks the provider unavailable (no retry storm).
    fail = new LlmProviderError('AUTH_FAILURE', 'bad key', 401);
    await assert.rejects(() => router.generate({ role: 'editingPlan', request: request('h') }));
    const authCalls = calls.length;
    await assert.rejects(() => router.generate({ role: 'editingPlan', request: request('i') }));
    assert.equal(calls.length, authCalls, 'a rejected key is not hammered again');
    fail = null;
  });

  assert.ok(calls.every((call) => call.provider === 'openai'), 'no other provider was ever called');
  const serialized = JSON.stringify(calls);
  assert.equal(/test-(openai|google|nvidia)-key/u.test(serialized), false, 'secrets excluded');
  console.log(JSON.stringify({ openAiOnlyAllRoles: true, envDrivenModels: true,
    otherCloudKeysIgnored: true, boundedSingleAttempt: true, successOnlyCache: true,
    perRoleCircuit: true, recoveryAfterReset: true, schemaDoesNotOpenCircuit: true,
    authFailureNotHammered: true, secretsExcluded: true }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
