// XeePro provider-capacity behavior. A fake OpenAI (real HTTP) answers 200 / 429 quota / 429 rate limit / 5xx / 401.
//
// Proves: Free never reaches the provider; Pro reaches it and a busy answer ends the unit of work as XEEPRO_BUSY with a safe
// body (no provider text, no retries, no second attempt on a busy request); there is no sticky "Pro is down" state, so the
// next request succeeds once the short cooldown has passed, with no restart and no flag change.
require('reflect-metadata');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LlmProviderService, LlmProviderError } = require('../dist/modules/processing/llm-provider.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { createPerformanceTelemetry, performanceContext } = require('../dist/modules/processing/performance-telemetry');
const { runInProviderBusyScope, withProviderBusyGuard, currentProviderBusy, assertProviderNotBusy, XeeProBusyError,
  XEEPRO_BUSY_MESSAGE, providerBusyCategory, isXeeProEnabled } = require('../dist/modules/processing/generation-availability');
const { classifyAiFailure } = require('../dist/modules/ai/ai-availability');

let checks = 0;
const ok = (label, condition = true) => { assert.ok(condition, label); checks += 1; console.log('  ok  ' + label); };
const SECRET = 'fixture-key-not-real';
const ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'LLM_QUOTA_COOLDOWN_MS', 'XEEPRO_ENABLED',
  'LLM_CIRCUIT_FAILURE_THRESHOLD', 'GOOGLE_API_KEY', 'NVIDIA_API_KEY'];
const saved = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
const schema = { type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'] };
let seq = 0;
const request = () => ({ schemaName: 'busy_test', schema, role: 'creativeGeneration', systemPrompt: 'Return JSON.',
  userPrompt: '{"n":' + (++seq) + '}', cacheKey: 'busy-' + seq });

function startServer() {
  const seen = [];
  let behaviour = 'ok';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      const json = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };
      if (behaviour === 'ok') json(200, { status: 'completed', output_text: '{"value":"from-pro"}' });
      else if (behaviour === 'quota') json(429, { error: { code: 'insufficient_quota', type: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details. key ' + SECRET } });
      else if (behaviour === 'rate') json(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } }, { 'retry-after': '30' });
      else if (behaviour === '503') json(503, { error: { message: 'overloaded' } });
      else if (behaviour === '401') json(401, { error: { code: 'invalid_api_key', message: 'bad key ' + SECRET } });
      else if (behaviour === '400') json(400, { error: { message: 'invalid request' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ server, seen, port: server.address().port, set: (value) => { behaviour = value; } })));
}

async function main() {
  console.log('XeePro busy behavior');
  for (const key of ENV) delete process.env[key];
  process.env.OPENAI_API_KEY = SECRET;
  process.env.LLM_CIRCUIT_FAILURE_THRESHOLD = '20';
  const fake = await startServer();
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + fake.port;

  // A. XeeFree: the provider is never reached and nothing is flagged busy.
  {
    const router = new LlmRouterService(new LlmProviderService());
    const t = createPerformanceTelemetry('FALLBACK_ONLY');
    const before = fake.seen.length;
    await runInProviderBusyScope(() => performanceContext.run(t, async () => {
      await assert.rejects(() => router.generate({ role: 'creativeGeneration', request: request() }),
        (e) => e.code === 'XEEFREE_PROVIDER_VIOLATION' || e.kind === 'AI_MODE_FALLBACK_ONLY');
      assert.equal(currentProviderBusy(), null);
    }));
    ok('A XeeFree: zero provider requests, zero OpenAI/cloud/escalation, not flagged busy',
      fake.seen.length === before && t.openAiCalls === 0 && t.cloudLlmCalls === 0 && t.proEscalations === 0);
  }

  // B. XeePro + working provider: the Pro route is called and the unit of work is not busy.
  {
    fake.set('ok');
    const router = new LlmRouterService(new LlmProviderService());
    const t = createPerformanceTelemetry('ONLINE');
    const before = fake.seen.length;
    const out = await runInProviderBusyScope(() => performanceContext.run(t, async () => {
      const result = await router.generate({ role: 'creativeGeneration', request: request() });
      assertProviderNotBusy();
      return result;
    }));
    ok('B XeePro success: Pro route called once, result returned, no fallback used',
      fake.seen.length === before + 1 && out.data.value === 'from-pro' && t.openAiCalls === 1 && !t.deterministicFallbackUsed);
  }

  // C. 429 quota: no silent fallback, safe error, bounded, fail-fast for the rest of the request.
  const router = new LlmRouterService(new LlmProviderService());
  {
    fake.set('quota');
    const t = createPerformanceTelemetry('ONLINE');
    const before = fake.seen.length;
    let busyError;
    await runInProviderBusyScope(() => performanceContext.run(t, async () => {
      await assert.rejects(() => router.generate({ role: 'creativeGeneration', request: request() }),
        (e) => e instanceof LlmProviderError && e.kind === 'QUOTA_FAILURE');
      ok('C quota 429 is classified as a quota failure and flags the request busy', currentProviderBusy() === 'PROVIDER_QUOTA_UNAVAILABLE');
      const afterFirst = fake.seen.length;
      // Another role in the same request: must not spend more quota.
      await assert.rejects(() => router.generate({ role: 'critic', request: { ...request(), role: 'critic' } }));
      ok('C a busy request makes no further provider calls (no retry loop, no quota burn)',
        afterFirst === before + 1 && fake.seen.length === afterFirst);
      try { assertProviderNotBusy(); } catch (e) { busyError = e; }
    }));
    ok('C the stage check throws XEEPRO_BUSY as HTTP 503', busyError instanceof XeeProBusyError && busyError.getStatus() === 503);
    const body = busyError.getResponse();
    ok('C response is the stable product body', body.code === 'XEEPRO_BUSY' && body.message === XEEPRO_BUSY_MESSAGE && body.retryable === true);
    ok('C the message is short and non-technical', XEEPRO_BUSY_MESSAGE === 'XeePro is busy right now. Try XeeFree or try again later.');
    ok('C no provider internals reach the response', !/openai|gpt|quota|billing|429|api[ _-]?key|insufficient|fixture-key/iu.test(JSON.stringify(body) + busyError.message));
    ok('C internal category is the safe quota category', busyError.category === 'PROVIDER_QUOTA_UNAVAILABLE');
    ok('C a Pro quota failure did not fall back to Free (no deterministic fallback recorded by the router)', !t.deterministicFallbackUsed);
  }

  // D. Recovery without restart or flag change.
  {
    const key = [...router.unavailable.keys()][0];
    const remaining = router.unavailable.get(key).until - Date.now();
    ok('D the quota cooldown defaults to a short TTL (<= 60s), not an hour', remaining > 0 && remaining <= 60_000);
    const before = fake.seen.length;
    fake.set('ok');
    const t = createPerformanceTelemetry('ONLINE');
    await runInProviderBusyScope(() => performanceContext.run(t, async () => {
      await assert.rejects(() => router.generate({ role: 'creativeGeneration', request: request() }));
      ok('D inside the TTL a new request fails fast as busy without calling the provider',
        fake.seen.length === before && currentProviderBusy() === 'PROVIDER_QUOTA_UNAVAILABLE');
    }));
    // Same router instance (a running server), credit added later: shorten the TTL as an operator could, then retry.
    router.unavailable.get(key).until = Date.now() - 1;
    const t2 = createPerformanceTelemetry('ONLINE');
    const result = await runInProviderBusyScope(() => performanceContext.run(t2, async () => {
      const r = await router.generate({ role: 'creativeGeneration', request: request() });
      assertProviderNotBusy();
      return r;
    }));
    ok('D after the TTL the very next XeePro request succeeds on the same process (no restart, no flag, no deploy)',
      result.data.value === 'from-pro' && fake.seen.length === before + 1);
  }

  // E. Other capacity classes and non-capacity failures.
  {
    const cases = [['rate', 'PROVIDER_RATE_LIMITED'], ['503', 'PROVIDER_BUSY'], ['401', 'PROVIDER_UNAVAILABLE'], ['400', null]];
    for (const [behaviour, category] of cases) {
      fake.set(behaviour);
      const fresh = new LlmRouterService(new LlmProviderService());
      const before = fake.seen.length;
      const t = createPerformanceTelemetry('ONLINE');
      await runInProviderBusyScope(() => performanceContext.run(t, async () => {
        await assert.rejects(() => fresh.generate({ role: 'creativeGeneration', request: request() }));
        ok('E HTTP ' + behaviour + ' -> ' + (category ?? 'not a capacity failure (real error stays real)') + ', one request only',
          currentProviderBusy() === category && fake.seen.length === before + 1);
      }));
    }
    ok('E timeouts, network failures, schema and invalid-request failures are not mapped to busy',
      ['TIMEOUT_FAILURE', 'NETWORK_FAILURE', 'SCHEMA_FAILURE', 'MALFORMED_RESPONSE_FAILURE', 'INVALID_REQUEST_FAILURE', 'CONFIGURATION_FAILURE']
        .every((kind) => providerBusyCategory(kind) === null));
  }

  // F. Request-level guard: an explicit Pro call ends as 503 instead of returning a quiet local result.
  {
    fake.set('rate');
    const fresh = new LlmRouterService(new LlmProviderService());
    await assert.rejects(() => withProviderBusyGuard(() => performanceContext.run(createPerformanceTelemetry('ONLINE'), async () => {
      try { await fresh.generate({ role: 'hookGeneration', request: { ...request(), role: 'hookGeneration' } }); } catch { /* the caller's own fallback */ }
      return 'local fallback result';
    })), (e) => e instanceof XeeProBusyError);
    ok('F a caller that swallowed the provider error still ends as XEEPRO_BUSY at the request boundary');
    const free = await withProviderBusyGuard(() => performanceContext.run(createPerformanceTelemetry('FALLBACK_ONLY'), async () => 'free ok'));
    ok('F a XeeFree request through the same guard is untouched', free === 'free ok');
    ok('F outside any scope nothing is flagged and nothing throws', currentProviderBusy() === null && (assertProviderNotBusy(), true));
  }

  // G. Editor/Ask-AI availability states use the same product wording and expose the stable code.
  {
    const states = { RATE_LIMIT_FAILURE: 'RATE_LIMITED', QUOTA_FAILURE: 'QUOTA_EXHAUSTED', PROVIDER_5XX_FAILURE: 'PROVIDER_ERROR' };
    for (const [kind, state] of Object.entries(states)) {
      const a = classifyAiFailure(new LlmProviderError(kind, 'x'));
      ok('G ' + kind + ' -> ' + state + ' uses the busy message and code',
        a.state === state && a.message.startsWith(XEEPRO_BUSY_MESSAGE) && a.code === 'XEEPRO_BUSY');
      ok('G ' + state + ' tells the user manual editing still works', /Manual editing/u.test(a.message));
    }
    ok('G a rejected key is not shown as busy', classifyAiFailure(new LlmProviderError('AUTH_FAILURE', 'x')).code === null);
    ok('G a XeeFree editor state is unchanged', classifyAiFailure(new Error('x')).code === null);
  }

  // H. Kill switch semantics: default on; only an explicit off value disables.
  {
    delete process.env.XEEPRO_ENABLED; ok('H unset flag = Pro available', isXeeProEnabled());
    process.env.XEEPRO_ENABLED = 'true'; ok('H true = Pro available', isXeeProEnabled());
    process.env.XEEPRO_ENABLED = 'false'; ok('H false = emergency off', !isXeeProEnabled());
    delete process.env.XEEPRO_ENABLED;
  }

  fake.server.close();
  console.log('XeePro busy tests passed (' + checks + ' checks).');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
});
