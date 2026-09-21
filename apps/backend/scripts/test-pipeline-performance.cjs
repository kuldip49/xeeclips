require('reflect-metadata');
const assert = require('node:assert/strict');
const { aiShortlistLimit, shortlistForUnderstanding, shortlistForCreative } = require('../dist/modules/processing/clip-candidates');
const { ClipIntelligenceService } = require('../dist/modules/processing/clip-intelligence.service');
const { ClipJudgeService } = require('../dist/modules/processing/openai-clip-judge.service');
const { LlmProviderService, validateStructuredOutput, parseStructuredJson } = require('../dist/modules/processing/llm-provider.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { performanceContext, createPerformanceTelemetry, timingFields, PerformanceStageClock,
  assertLlmCallBudget, countPerformance } = require('../dist/modules/processing/performance-telemetry');

async function main() {
  const stageMetrics = createPerformanceTelemetry();
  let clock = 100;
  const stages = new PerformanceStageClock(stageMetrics, () => clock);
  stages.checkpoint('TRANSCRIBE', 'PROCESSING'); clock = 125;
  stages.checkpoint('WHOLE_VIDEO_UNDERSTANDING', 'PROCESSING'); clock = 150;
  stages.checkpoint('TRANSCRIBE', 'COMPLETED'); clock = 200;
  stages.checkpoint('WHOLE_VIDEO_UNDERSTANDING', 'FAILED');
  stages.checkpoint('TRANSCRIBE', 'COMPLETED');
  stages.checkpoint('CONTENT_GENERATION', 'SKIPPED');
  assert.equal(stageMetrics.transcriptionMs, 50);
  assert.equal(stageMetrics.wholeVideoUnderstandingMs, 75);
  assert.equal(stageMetrics.creativeGenerationMs, 0);
  assert.deepEqual(parseStructuredJson('{"candidates":[{"candidateId":"a","value":1},{"candidateId":"b","value":', 'candidates'),
    { candidates: [{ candidateId: 'a', value: 1 }] });

  // Role-aware call budget: critic/componentRepair now scale with batched and longer-video
  // volume (10 / 16) instead of the old fixed cap of 4 that hit CALL_BUDGET_EXCEEDED on a
  // normal ~9-candidate ONLINE run, while still enforcing a hard ceiling.
  performanceContext.run(createPerformanceTelemetry(), () => {
    for (let i = 0; i < 10; i++) { assertLlmCallBudget('critic', false); countPerformance('criticCount'); }
    assert.throws(() => assertLlmCallBudget('critic', false), /LLM_CALL_BUDGET_EXCEEDED/,
      'critic budget must still enforce its configured ceiling (default 10)');
  });
  // A denied call never reaches countLlmRequest (it is rejected before any provider call is
  // made), so without dedicated denial telemetry it would vanish from the job summary entirely.
  // callBudgetDeniedCount/callBudgetDeniedByRole make that pressure visible even though the
  // denied call itself is (correctly) excluded from totalLlmCalls/repairCount.
  performanceContext.run(createPerformanceTelemetry(), () => {
    for (let i = 0; i < 16; i++) { assertLlmCallBudget('componentRepair', false); countPerformance('repairCount'); }
    assert.throws(() => assertLlmCallBudget('componentRepair', false), /LLM_CALL_BUDGET_EXCEEDED/,
      'componentRepair budget must still enforce its configured ceiling (default 16)');
    const telemetry = performanceContext.getStore();
    assert.equal(telemetry.repairCount, 16, 'admitted calls are unaffected by the denial');
    assert.equal(telemetry.callBudgetDeniedCount, 1, 'a denied call must still be counted somewhere');
    assert.equal(telemetry.callBudgetDeniedByRole.componentRepair, 1,
      'denial telemetry must be attributable to the role that hit its sub-budget');
    assert.throws(() => assertLlmCallBudget('componentRepair', false), /LLM_CALL_BUDGET_EXCEEDED/);
    assert.equal(telemetry.callBudgetDeniedCount, 2, 'repeated denials keep accumulating, not just the first');
    assert.equal(telemetry.callBudgetDeniedByRole.componentRepair, 2);
  });
  const raw = Array.from({ length: 76 }, (_, i) => ({ videoId: 'test', rangeKey: 'range-' + i,
    startTime: i * 11, endTime: i * 11 + 10, duration: 10,
    transcriptText: Array.from({ length: 12 }, (_, j) => `topic${i}word${j}`).join(' '),
    topic: 'subject-' + i, overallScore: 95 - i * .2, heuristicScore: 95 - i * .2,
    // Kept below the Stage 5 high-confidence gate (see clip-intelligence.service.ts
    // isHighConfidenceClipCandidate) so this fixture still exercises the model call path
    // these assertions are testing, rather than being skipped as deterministically strong.
    hookScore: 65, standaloneScore: 65, payoffScore: 65, flowScore: 65, informationScore: 65,
    retentionScore: 65, shareabilityScore: 65, contentPotential: 65, reject: false,
    reason: 'test', rejectionReason: '', judgeSource: 'HEURISTIC_FALLBACK' }));
  assert.deepEqual([600, 900, 1800, 3600, 7200].map(aiShortlistLimit), [12, 21, 21, 25, 35]);
  const shortlist = shortlistForUnderstanding(raw, 900);
  assert.equal(shortlist.length, 21);
  assert.equal(shortlistForCreative(shortlist, 900).length, 12);
  assert.ok(shortlistForCreative(shortlist, 900).every(item => item.overallScore >= raw[11].overallScore));
  const duplicate = { ...raw[0], rangeKey: 'duplicate', overallScore: 99 };
  const deduped = shortlistForUnderstanding([...raw, duplicate], 900);
  assert.equal(deduped.filter(item => item.startTime === 0).length, 1);

  const fallbackService = new ClipIntelligenceService({ generate: async () => { throw new Error('offline'); } });
  const evidences = shortlist.map(item => fallbackService.fuse(item, [], []));
  const fallback = await fallbackService.understand(shortlist, evidences);
  let evaluated = 0, active = 0, peak = 0;
  const understanding = new ClipIntelligenceService({ async generate(input) {
    const batch = JSON.parse(input.request.userPrompt); evaluated += batch.length;
    assert.ok(batch.length <= 2); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { data: { candidates: batch.map((item, index) => index === 2 ? null : {
      ...fallback.understandings[shortlist.findIndex(candidate => candidate.rangeKey === item.candidateId)],
      mainClaim: 'preserved expensive response', candidateId: item.candidateId }) }, metadata: {} };
  } });
  const recovered = await understanding.understand(shortlist, evidences);
  assert.equal(evaluated, 21); assert.equal(peak, 1);
  assert.equal(recovered.understandings.filter(item => item.mainClaim === 'preserved expensive response').length, 21);

  // One missing middle ID cannot shift another candidate's understanding.
  const missing = new ClipIntelligenceService({ async generate(input) {
    const batch = JSON.parse(input.request.userPrompt);
    return { data: { candidates: batch.filter((_, i) => i !== 2).map(item => ({
      ...fallback.understandings[0], candidateId: item.candidateId, mainClaim: item.candidateId })) }, metadata: {} };
  } });
  const aligned = await missing.understand(shortlist.slice(0, 5), evidences.slice(0, 5));
  assert.equal(aligned.understandings[3].mainClaim, shortlist[3].rangeKey);

  // creativeGeneration batches CLIP_JUDGE_BATCH_SIZE (default 2) candidates per request so a
  // 12-candidate creative shortlist (a 15-minute video may request up to 12 clips) costs 6 calls
  // instead of 12 (see openai-clip-judge.service.ts).
  let packages = 0;
  const judge = new ClipJudgeService({ isAnyConfigured: () => true, routesFor: () => [],
    configuredRouteFor: () => undefined, async generate(input) {
      assert.equal(JSON.parse(input.request.userPrompt).length, 2); packages++;
      throw new Error('synthetic fallback');
    } });
  await judge.judgeCandidates(shortlistForCreative(shortlist, 900));
  assert.equal(packages, 6, 'twelve shortlisted candidates batch into six creativeGeneration calls');

  const itemSchema = { type: 'object', additionalProperties: false,
    properties: { value: { type: 'number' } }, required: ['value'] };
  const batchRequest = { schemaName: 'partial', partialBatchField: 'candidates',
    schema: { type: 'object', properties: { candidates: { type: 'array', items: itemSchema } }, required: ['candidates'] } };
  const partial = validateStructuredOutput({ candidates: [{ value: '1', extra: true }, { value: 2 }, {}, { value: 4 }, { value: 5 }] }, batchRequest);
  assert.deepEqual(partial.candidates, [{ value: 1 }, { value: 2 }, null, { value: 4 }, { value: 5 }]);
  const signals = Array.from({ length: 3 }, (_, position) => ({ position, startTime: position * 10,
    endTime: position * 10 + 10, sceneChangeCount: 0, averageMotion: 0, faceCount: 0,
    largestFaceRatio: 0, brightness: 0, contrast: 0, colorfulness: 0, ocrText: '', subtitleDetected: false }));
  const omni = new ClipIntelligenceService({ async generate() {
    return { data: { observations: [{ position: '0', visual_event: 'Retained visual evidence',
      visuallyInteresting: 'true', interestScore: '70', evidenceRefs: ['visualAnalysis:chunk:0'], extra: true },
      null, { position: 2, visualEvent: 'Other retained evidence', visuallyInteresting: false,
        interestScore: 20, evidenceRefs: ['visualAnalysis:chunk:2'] }] }, metadata: {} };
  } });
  const observations = (await omni.analyzeMultimodal('synthetic', signals)).observations;
  assert.equal(observations[0].visualEvent, 'Retained visual evidence');
  assert.equal(observations[2].visualEvent, 'Other retained evidence');
  assert.equal(observations.length, 3);

  // ONLINE is intentionally single-provider (see provider-registry.ts ONLINE_PROVIDER_ALLOWLIST):
  // a Luna failure never fails over to another cloud provider, it falls through to the caller's
  // deterministic fallback (covered by test-online-resilience.cjs). This section instead verifies
  // the router mechanics that stay in play for that single provider: request shape, response
  // caching, telemetry counters, and timeout-deadline enforcement.
  const originalFetch = global.fetch, originalTimeout = AbortSignal.timeout;
  const env = { ...process.env };
  try {
    process.env.LLM_API_KEY = 'secret-openai'; process.env.OPENAI_API_KEY = 'secret-openai';
    delete process.env.NVIDIA_API_KEY; delete process.env.GOOGLE_API_KEY;
    process.env.LLM_WHOLE_VIDEO_UNDERSTANDING_TIMEOUT_MS = '1000';
    const timeouts = []; AbortSignal.timeout = ms => { timeouts.push(ms); return new AbortController().signal; };
    let attempts = 0;
    global.fetch = async (url, options) => {
      attempts++;
      assert.ok(url.endsWith('/responses'));
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-5.6-luna');
      assert.equal(body.text.format.type, 'json_schema');
      assert.deepEqual(body.text.format.schema, itemSchema);
      return { ok: true, json: async () => ({ output_text: '{"value":1}' }) };
    };
    const metrics = createPerformanceTelemetry('ONLINE');
    await performanceContext.run(metrics, async () => {
      const router = new LlmRouterService(new LlmProviderService());
      const input = { role: 'wholeVideoUnderstanding', request: {
        schemaName: 'contract', schema: itemSchema, systemPrompt: 'Synthetic', userPrompt: 'Synthetic' } };
      const started = Date.now();
      const result = await router.generate(input);
      metrics.wholeVideoUnderstandingMs = Date.now() - started;
      assert.equal(result.metadata.failover, false);
      assert.equal(result.metadata.provider, 'openai');
      // An identical second request is served from the router cache without a new fetch.
      const cached = await router.generate(input);
      assert.equal(cached.metadata.cacheHit, true);
    });
    assert.equal(attempts, 1);
    assert.deepEqual(timeouts, [1000]);
    assert.equal(metrics.retryCount, 0); assert.equal(metrics.failoverCount, 0);
    assert.equal(metrics.cacheHits, 1);
    assert.ok(timingFields.every(key => Number.isFinite(metrics[key])));
    // A real abort verifies the fallback deadline, independently of the timeout-recording mock.
    AbortSignal.timeout = originalTimeout;
    global.fetch = (url, options) => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('deadline was not enforced')), 3000);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
    const started = Date.now();
    await assert.rejects(() => performanceContext.run(createPerformanceTelemetry('ONLINE'), () =>
      new LlmRouterService().generate({ role: 'wholeVideoUnderstanding', request: {
        schemaName: 'deadline', schema: itemSchema, systemPrompt: 'Synthetic', userPrompt: 'Synthetic' } })));
    assert.ok(Date.now() - started < 3000,
      'a Luna timeout must be enforced and surfaced within three seconds, not hang');
  } finally {
    global.fetch = originalFetch; AbortSignal.timeout = originalTimeout;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
  }
  console.log(JSON.stringify({ performanceRegression: true, raw: 76, understood: evaluated,
    creative: packages, partialRecovery: true, boundedTimeout: true,
    singleProviderOnlineContract: true, responseCaching: true, telemetry: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
