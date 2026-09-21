require('reflect-metadata');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
process.loadEnvFile(resolve(__dirname, '../../../.env'));
const { candidate, transcript } = require('./test-online-resilience.cjs');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { ClipIntelligenceService } = require('../dist/modules/processing/clip-intelligence.service');
const { ClipJudgeService } = require('../dist/modules/processing/openai-clip-judge.service');
const { ClipCriticService } = require('../dist/modules/processing/clip-critic.service');
const { performanceContext, createPerformanceTelemetry } =
  require('../dist/modules/processing/performance-telemetry');

async function main() {
  const metrics = createPerformanceTelemetry('ONLINE');
  await performanceContext.run(metrics, async () => {
    const router = new LlmRouterService();
    assert.ok(router.configuredRouteFor('creativeGeneration'),
      'At least one enabled ONLINE creative provider needs a key and model');
    const schema = { type: 'object', additionalProperties: false,
      properties: { summary: { type: 'string' } }, required: ['summary'] };
    let whole = null;
    let wholeFailure = null;
    try {
      whole = await router.generate({ role: 'wholeVideoUnderstanding', request: {
        schemaName: 'short_fixture_whole_live', schema,
        systemPrompt: 'Summarize the supplied clip in one short sentence. Return JSON only.',
        userPrompt: transcript, maxOutputTokens: 350 } });
    } catch (error) { wholeFailure = error.kind || 'UNKNOWN_PROVIDER_FAILURE'; }
    const understood = await new ClipIntelligenceService(router)
      .understand([candidate], [candidate.evidence]);
    const generated = await new ClipJudgeService(router).judgeCandidates([
      { ...candidate, clipUnderstanding: understood.understandings[0] }]);
    const reviewed = await new ClipCriticService(router).review(generated);
    const result = { requestedAiMode: metrics.requestedAiMode,
      effectiveAiMode: metrics.effectiveAiMode,
      cloudLlmCalls: metrics.cloudLlmCalls, localLlmCalls: metrics.localLlmCalls,
      successfulByRoleProvider: metrics.llmSuccessCountByRoleProvider,
      attemptedByRoleProvider: metrics.llmRequestCountByRoleProvider,
      retryCount: metrics.retryCount, failoverCount: metrics.failoverCount,
      circuitOpenCount: metrics.circuitOpenCount,
      configuredCreativeOrder: router.routesFor('creativeGeneration')
        .filter(route => route.apiKey).map(route => route.provider),
      wholeProvider: whole?.metadata.provider || null,
      wholeAttempts: whole?.metadata.attempts || [], wholeFailure,
      clipUnderstandingFallback: understood.routesByCandidate[0] === null,
      generationStatus: reviewed[0].generationStatus,
      provider: reviewed[0].provider, title: reviewed[0].title,
      synopsisParagraphs: reviewed[0].synopsis.split(/\n\n/u).length,
      hashtagCount: reviewed[0].hashtags.length,
      validationMode: reviewed[0].criticResult?.validationMode };
    console.log(JSON.stringify(result));
    assert.equal(metrics.localLlmCalls, 0);
    assert.equal(reviewed[0].synopsis.split(/\n\n/u).length, 3);
    assert.equal(reviewed[0].hashtags.length, 5);
    assert.ok(metrics.cloudLlmCalls > 0, 'ONLINE verifier must make a cloud attempt');
    assert.deepEqual(router.routesFor('creativeGeneration').map(route => route.provider), ['openai']);
    for (const provider of ['google', 'nvidia', 'openrouter', 'anthropic', 'groq', 'ollama']) {
      assert.equal(metrics.llmRequestCountByProvider[provider] || 0, 0,
        `${provider} must not receive ONLINE calls`);
    }
    // A live credential/network failure is reported in the JSON result; routing
    // isolation remains verifiable without requiring a successful external call.
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
