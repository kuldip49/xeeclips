require('reflect-metadata');
const assert = require('node:assert/strict');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { LlmProviderError } = require('../dist/modules/processing/llm-provider.service');
const { ClipIntelligenceService } = require('../dist/modules/processing/clip-intelligence.service');
const { ClipJudgeService } = require('../dist/modules/processing/openai-clip-judge.service');
const { ClipCriticService } = require('../dist/modules/processing/clip-critic.service');
const { performanceContext, createPerformanceTelemetry } =
  require('../dist/modules/processing/performance-telemetry');

const transcript = 'Cleaning solar panels removes dust that blocks sunlight. ' +
  'Clean panels receive more light and can restore energy output.';
const candidate = {
  videoId: 'short-online-fixture', rangeKey: '0:20', startTime: 0, endTime: 20,
  duration: 20, transcriptText: transcript, heuristicScore: 62, hookScore: 60,
  sourceHookScore: 60, standaloneScore: 63, payoffScore: 61, flowScore: 60,
  informationScore: 64, retentionScore: 60, shareabilityScore: 58,
  contentPotential: 61, overallScore: 61, reject: false, rank: null,
  topic: 'solar panel cleaning', reason: 'The clip explains a concrete payoff.',
  rejectionReason: '', overallVideoTopic: 'solar panel maintenance',
  previousTranscriptContext: '', nextTranscriptContext: '', providerMetadata: [],
  evidence: { startTime: 0, endTime: 20, transcript,
    previousContext: '', nextContext: '', chapter: 'Dust blocks sunlight.',
    overallVideoTopic: 'solar panel maintenance', speechSignals: {},
    visualSignals: [], multimodalSignals: [], supportedFacts: [transcript],
    importantMoments: [] }
};
const simpleSchema = { type: 'object', additionalProperties: false,
  properties: { value: { type: 'string' } }, required: ['value'] };

/**
 * ONLINE is single-provider by design (see provider-registry.ts ONLINE_PROVIDER_ALLOWLIST):
 * every role routes to openai/Luna only, and a Luna failure falls back to that stage's
 * deterministic path while the job stays ONLINE — it must never reach another cloud
 * provider or Ollama. This exercises exactly that failure/fallback contract end to end.
 */
async function main() {
  const saved = Object.fromEntries(['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'NVIDIA_API_KEY',
    'LOCAL_LLM_ENABLED'].map(key => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = 'fixture-openai';
  delete process.env.GOOGLE_API_KEY; delete process.env.NVIDIA_API_KEY;
  process.env.LOCAL_LLM_ENABLED = 'true';
  const wireProviders = [];
  const failingProvider = { isConfigured: config => config.provider === 'openai',
    async generateStructuredWithConfig(config) {
      wireProviders.push(config.provider);
      throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'Luna is unavailable', 503);
    } };
  try {
    const metrics = createPerformanceTelemetry('ONLINE');
    await performanceContext.run(metrics, async () => {
      const router = new LlmRouterService(failingProvider);
      assert.deepEqual(router.routesFor('creativeGeneration').map(route => route.provider),
        ['openai'], 'ONLINE must only ever resolve to the single allow-listed provider');
      await assert.rejects(() => router.generate({ role: 'wholeVideoUnderstanding', request: {
        schemaName: 'short_fixture_whole', schema: simpleSchema,
        systemPrompt: 'Summarize this short video.', userPrompt: transcript } }));

      const understood = await new ClipIntelligenceService(router)
        .understand([candidate], [candidate.evidence]);
      assert.equal(understood.failureCategories[0], 'PROVIDER_5XX_FAILURE');
      assert.equal(understood.decisionSources[0], 'DETERMINISTIC_FALLBACK');
      assert.equal(understood.routesByCandidate[0], null,
        'a failed Luna call must leave no route, not silently reroute to another provider');
      assert.ok(understood.understandings[0].mainTopic,
        'the deterministic understanding fallback must still produce a usable result');

      const generated = await new ClipJudgeService(router).judgeCandidates([
        { ...candidate, clipUnderstanding: understood.understandings[0] }]);
      assert.equal(generated[0].generationStatus, 'FALLBACK');
      assert.ok(generated[0].hashtags.length >= 1 && generated[0].hashtags.length <= 8);
      assert.ok(generated[0].synopsis.length > 20 && generated[0].synopsis.length < 1200);

      const reviewed = await new ClipCriticService(router).review(generated);
      assert.equal(reviewed[0].criticResult.validationMode, 'DETERMINISTIC');

      assert.equal(metrics.requestedAiMode, 'ONLINE');
      assert.equal(metrics.effectiveAiMode, 'ONLINE',
        'a Luna failure must never demote the job out of ONLINE');
      assert.equal(metrics.localLlmCalls, 0, 'ONLINE must never invoke Ollama on failure');
      assert.ok(wireProviders.every(provider => provider === 'openai'),
        'every attempted call must target openai, never a fallback cloud provider');
      assert.ok(wireProviders.length > 0, 'the fixture must have actually attempted Luna');
      console.log(JSON.stringify({ fixture: 'short-online-fixture', event: 'online_luna_failure_fallback',
        requestedAiMode: metrics.requestedAiMode, effectiveAiMode: metrics.effectiveAiMode,
        localLlmCalls: metrics.localLlmCalls, wireProviders,
        clipDecisionSource: understood.decisionSources[0],
        generationStatus: generated[0].generationStatus,
        validationMode: reviewed[0].criticResult.validationMode }));
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
if (require.main === module)
  main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { candidate, transcript };
