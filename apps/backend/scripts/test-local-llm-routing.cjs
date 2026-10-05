// Step 6 - production model policy (this file historically tested Ollama routing;
// it now proves the opposite: there is NO local production LLM).
//
//   ONLINE         -> OpenAI API only (backend key), deterministic fallback on failure
//   FALLBACK_ONLY  -> no model at all
//   OFFLINE        -> legacy stored value, normalized to FALLBACK_ONLY
//
// Real HTTP: a local server impersonates the OpenAI Responses API so the actual
// LlmProviderService request/response/classification code is exercised for 200,
// 401, 429, timeout, 5xx and a network failure. Offline; no key, no network.
require('reflect-metadata');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LlmProviderService } = require('../dist/modules/processing/llm-provider.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { ProviderRegistry } = require('../dist/modules/processing/provider-registry');
const { createPerformanceTelemetry, performanceContext } =
  require('../dist/modules/processing/performance-telemetry');
const { normalizeAiProcessingMode, SELECTABLE_AI_PROCESSING_MODES } =
  require('../dist/modules/processing/ai-processing-mode');
const { classifyAiFailure } = require('../dist/modules/ai/ai-availability');
const { VideoUnderstandingService } =
  require('../dist/modules/processing/video-understanding.service');

let checks = 0;
const ok = (label, condition = true) => { assert.ok(condition, label); checks += 1;
  console.log(`  ok  ${label}`); };
const SECRET = 'fixture-key-not-real';
const ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'OPENAI_ENABLED',
  'LOCAL_LLM_ENABLED', 'LOCAL_LLM_BASE_URL', 'GOOGLE_API_KEY', 'NVIDIA_API_KEY',
  'GOOGLE_ENABLED', 'NVIDIA_ENABLED', 'LLM_CIRCUIT_FAILURE_THRESHOLD', 'OPENAI_TIMEOUT_MS',
  'LLM_EDITING_PLAN_TIMEOUT_MS'];
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
const schema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };
let seq = 0;
const request = () => ({ schemaName: 'policy_test', schema, role: 'editingPlan',
  systemPrompt: 'Return JSON.', userPrompt: `{"n":${++seq}}`, cacheKey: `policy-${seq}` });

function startServer() {
  const seen = [];
  let behaviour = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      if (behaviour === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', output_text: '{"value":"from-openai"}' }));
      } else if (behaviour === '401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: `Incorrect key ${SECRET}` } }));
      } else if (behaviour === '429') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
        res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }));
      } else if (behaviour === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'server exploded' } }));
      } else if (behaviour === 'hang') {
        setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch { /* closed */ } }, 5000);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, seen, port: server.address().port, set: (value) => { behaviour = value; } })));
}

async function main() {
  console.log('Step 6 production model policy');
  for (const key of ENV) delete process.env[key];

  // --- modes -------------------------------------------------------------------
  ok('only ONLINE and FALLBACK_ONLY are user-selectable',
    JSON.stringify([...SELECTABLE_AI_PROCESSING_MODES]) === JSON.stringify(['ONLINE', 'FALLBACK_ONLY']));
  ok('legacy OFFLINE normalizes to FALLBACK_ONLY', normalizeAiProcessingMode('OFFLINE') === 'FALLBACK_ONLY' &&
    normalizeAiProcessingMode('offline') === 'FALLBACK_ONLY');
  ok('unknown values never opt into a model', normalizeAiProcessingMode('LOCAL') === 'FALLBACK_ONLY' &&
    normalizeAiProcessingMode(undefined) === 'FALLBACK_ONLY');

  // --- no local route under any configuration ---------------------------------
  process.env.LOCAL_LLM_ENABLED = 'true';
  process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
  process.env.OPENAI_API_KEY = SECRET;
  const router = new LlmRouterService(new LlmProviderService());
  const roles = ['wholeVideoUnderstanding', 'multimodalUnderstanding', 'clipUnderstanding',
    'candidateJudge', 'creativeGeneration', 'critic', 'componentRepair', 'editingPlan'];
  for (const mode of ['ONLINE', 'OFFLINE', 'FALLBACK_ONLY']) {
    const providers = new Set(roles.flatMap((role) => router.routesFor(role, mode).map((r) => r.provider)));
    ok(`${mode}: routes are ${mode === 'ONLINE' ? 'OpenAI only' : 'empty'} even with LOCAL_LLM_ENABLED=true`,
      mode === 'ONLINE' ? [...providers].join() === 'openai' : providers.size === 0);
  }
  ok('no route of any mode is an Ollama/local API style', roles.every((role) =>
    ['ONLINE', 'OFFLINE'].every((mode) => router.routesFor(role, mode).every((r) =>
      r.apiStyle !== 'ollama' && !/11434|ollama|qwen/iu.test(`${r.baseUrl} ${r.model}`)))));
  ok('the registry refuses to register a local LLM provider', (() => {
    try { new ProviderRegistry().register({ id: 'ollama' }); return false; } catch { return true; }
  })());
  process.env.GOOGLE_API_KEY = 'g'; process.env.NVIDIA_API_KEY = 'n';
  process.env.GOOGLE_ENABLED = 'true'; process.env.NVIDIA_ENABLED = 'true';
  ok('ONLINE stays OpenAI-only even when other cloud keys are present',
    roles.every((role) => router.routesFor(role, 'ONLINE').map((r) => r.provider).join() === 'openai'));
  delete process.env.GOOGLE_API_KEY; delete process.env.NVIDIA_API_KEY;
  process.env.OPENAI_MODEL = 'env-selected-model';
  ok('the OpenAI model is environment-driven', router.routesFor('editingPlan', 'ONLINE')[0].model === 'env-selected-model');
  delete process.env.OPENAI_MODEL;

  const offline = createPerformanceTelemetry('OFFLINE');
  let offlineCalls = 0;
  const countingRouter = new LlmRouterService({ isConfigured: () => true,
    async generateStructuredWithConfig() { offlineCalls++; return { value: 'x' }; } });
  await performanceContext.run(offline, async () => {
    await assert.rejects(() => countingRouter.generate({ role: 'creativeGeneration', request: request() }),
      (error) => error.kind === 'AI_MODE_FALLBACK_ONLY');
  });
  ok('a legacy OFFLINE job makes zero model calls', offlineCalls === 0 && offline.localLlmCalls === 0);

  // --- real HTTP classification against a fake OpenAI -------------------------
  const fake = await startServer();
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.port}`;
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '20';
  const logs = [];
  const originalLog = console.log; const originalWarn = console.warn;
  const capture = (fn) => (...args) => { logs.push(args.join(' ')); fn(...args); };
  process.stdout.write = ((write) => function (chunk, ...rest) {
    logs.push(String(chunk)); return write.call(process.stdout, chunk, ...rest); })(process.stdout.write);
  console.warn = capture(originalWarn);

  const online = async (behaviour, options = {}) => {
    fake.set(behaviour);
    const liveRouter = new LlmRouterService(new LlmProviderService());
    const metrics = createPerformanceTelemetry('ONLINE');
    return performanceContext.run(metrics, async () => {
      try {
        const result = await liveRouter.generate({ role: 'editingPlan',
          request: { ...request(), options } });
        return { result };
      } catch (error) { return { error }; }
    });
  };

  const good = await online('ok');
  ok('ONLINE normal route: OpenAI Responses API answers', good.result?.data.value === 'from-openai' &&
    good.result.metadata.provider === 'openai');
  const last = fake.seen.at(-1);
  ok('the request went to /responses with the backend key as a bearer token',
    last.url === '/responses' && last.auth === `Bearer ${SECRET}` && last.body.store === false);

  const expectations = [
    ['401', 'AUTH_FAILURE', 'AUTH_FAILED', false],
    ['429', 'RATE_LIMIT_FAILURE', 'RATE_LIMITED', true],
    ['500', 'PROVIDER_5XX_FAILURE', 'PROVIDER_ERROR', true]
  ];
  for (const [behaviour, kind, state, retryable] of expectations) {
    const { error } = await online(behaviour);
    const availability = classifyAiFailure(error);
    ok(`HTTP ${behaviour} -> ${kind} -> ${state} (distinct, honest message)`, error?.kind === kind &&
      availability.state === state && availability.retryable === retryable &&
      /Manual editing and automatic generation are still available/u.test(availability.message));
  }
  // Found live (Step 21): after one 401 the model is parked (correctly - no pointless retries),
  // but later requests reported a generic "paused briefly, try again soon" (CIRCUIT_OPEN,
  // retryable) instead of the real cause. A rejected key must keep saying so.
  {
    fake.set('401');
    const sticky = new LlmRouterService(new LlmProviderService());
    const call = () => performanceContext.run(createPerformanceTelemetry('ONLINE'), async () => {
      try { await sticky.generate({ role: 'editingPlan', request: request() }); return null; }
      catch (error) { return error; }
    });
    await call();
    const hitsBefore = fake.seen.length;
    const again = await call();
    ok('after a 401, later requests still report AUTH_FAILED (not "try again soon") without re-calling OpenAI',
      again?.kind === 'AUTH_FAILURE' && classifyAiFailure(again).state === 'AUTH_FAILED' &&
      classifyAiFailure(again).retryable === false && fake.seen.length === hitsBefore);
  }
  const timeout = await online('hang', { timeoutMs: 300 });
  ok('timeout -> TIMEOUT_FAILURE -> TIMEOUT', timeout.error?.kind === 'TIMEOUT_FAILURE' &&
    classifyAiFailure(timeout.error).state === 'TIMEOUT');
  await new Promise((resolve) => fake.server.close(resolve));
  const network = await online('ok');
  ok('network failure (server gone) -> NETWORK_FAILURE -> NETWORK',
    network.error?.kind === 'NETWORK_FAILURE' && classifyAiFailure(network.error).state === 'NETWORK');
  ok('missing key -> NOT_CONFIGURED is honest', (() => {
    delete process.env.OPENAI_API_KEY;
    const r = new LlmRouterService(new LlmProviderService());
    return performanceContext.run(createPerformanceTelemetry('ONLINE'), () =>
      r.isAnyConfigured('editingPlan')) === false;
  })());
  console.warn = originalWarn;
  ok('the OpenAI key never appears in any log line', !logs.some((line) => line.includes(SECRET)));

  // --- deterministic fallback when OpenAI fails -------------------------------
  process.env.OPENAI_API_KEY = SECRET;
  const failing = new LlmRouterService({ isConfigured: () => true,
    async generateStructuredWithConfig() {
      const { LlmProviderError } = require('../dist/modules/processing/llm-provider.service');
      throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'down', 503); } });
  const understanding = await performanceContext.run(createPerformanceTelemetry('ONLINE'), () =>
    new VideoUnderstandingService(failing).analyzeWithFallback([
      { position: 0, startTime: 0, endTime: 10, text: 'Deterministic understanding still works offline.' }
    ], 'en'));
  ok('OpenAI failure -> deterministic understanding fallback (no job failure)',
    understanding.mainTopic === 'Deterministic understanding still works offline.');

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  console.log(`\nStep 6 production model policy tests passed (${checks} checks).`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
