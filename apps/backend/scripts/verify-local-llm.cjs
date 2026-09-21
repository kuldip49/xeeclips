// Safe live verification: synthetic input only; never prints credentials or model reasoning.
require('reflect-metadata');
const { resolve } = require('node:path');
process.loadEnvFile(resolve(__dirname, '../../../.env'));
const { LlmProviderError, LlmProviderService } =
  require('../dist/modules/processing/llm-provider.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { ClipJudgeService } = require('../dist/modules/processing/openai-clip-judge.service');
const { createPerformanceTelemetry, performanceContext } =
  require('../dist/modules/processing/performance-telemetry');

async function main() {
  process.env.LOCAL_LLM_ENABLED = 'true';
  const baseUrl = (process.env.LOCAL_LLM_BASE_URL ||
    'http://host.docker.internal:11434').replace(/\/+$/, '');
  const model = process.env.LOCAL_LLM_MODEL || 'qwen3:4b';
  const tagsStarted = Date.now();
  const tagsResponse = await fetch(baseUrl + '/api/tags', { signal: AbortSignal.timeout(10000) });
  const tags = await tagsResponse.json();
  const tagsLatencyMs = Date.now() - tagsStarted;
  const installed = (tags.models || []).some(item => item.name === model || item.model === model);
  if (!tagsResponse.ok || !installed) throw new Error('Configured local model is unavailable');

  const provider = new LlmProviderService();
  const nativeFetch = global.fetch;
  let generationStatus = null, runtime = {};
  global.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (String(args[0]).endsWith('/api/chat')) {
      generationStatus = response.status;
      try {
        const payload = await response.clone().json();
        runtime = { loadDurationMs: Math.round(Number(payload.load_duration || 0) / 1e6),
          promptEvalDurationMs: Math.round(Number(payload.prompt_eval_duration || 0) / 1e6),
          evalDurationMs: Math.round(Number(payload.eval_duration || 0) / 1e6),
          outputTokens: payload.eval_count ?? null,
          tokensPerSecond: payload.eval_duration && payload.eval_count
            ? Math.round(payload.eval_count / (payload.eval_duration / 1e9) * 10) / 10 : null };
      } catch { /* Response-shape validation is performed by the provider. */ }
    }
    return response;
  };
  const simulatedCloudCalls = [];
  const router = new LlmRouterService({
    isConfigured: config => config.apiStyle === 'ollama' ? provider.isConfigured(config) :
      !!(config.baseUrl && config.model),
    async generateStructuredWithConfig(config, request) {
      if (config.apiStyle !== 'ollama') {
        simulatedCloudCalls.push(config.provider);
        throw new LlmProviderError('PROVIDER_5XX_FAILURE', 'Synthetic cloud outage', 503);
      }
      return provider.generateStructuredWithConfig(config, request);
    }
  });
  const started = Date.now();
  const result = await router.generate({ role: 'creativeGeneration', request: {
    role: 'creativeGeneration', schemaName: 'local_live_check', cacheKey: 'local-live-v1',
    schema: { type: 'object', additionalProperties: false,
      properties: { status: { type: 'string', enum: ['ok'] },
        message: { type: 'string' } }, required: ['status', 'message'] },
    systemPrompt: 'Return a minimal health-check object. Keep message under six words.',
    userPrompt: '{"requestedStatus":"ok"}', maxOutputTokens: 128,
    options: { temperature: 0, timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS || 60000) }
  } });
  const generationLatencyMs = Date.now() - started;
  let creative = null;
  if (process.argv.includes('--creative-package')) {
    const creativeStarted = Date.now();
    const candidate = { videoId: 'synthetic', rangeKey: '0:30', startTime: 0, endTime: 30,
      duration: 30, transcriptText: 'A reliable workflow uses evidence to produce a clear result. ' +
        'The process keeps every claim grounded and finishes with a useful conclusion.',
      heuristicScore: 75, judgeSource: 'HEURISTIC_FALLBACK', rank: null, hookScore: 75,
      sourceHookScore: 75, standaloneScore: 75, payoffScore: 75, flowScore: 75,
      informationScore: 75, retentionScore: 75, shareabilityScore: 75,
      contentPotential: 75, overallScore: 75, reject: false, topic: 'reliable workflow',
      reason: 'Synthetic grounded candidate', rejectionReason: '' };
    const generated = (await new ClipJudgeService(router).judgeCandidates([candidate]))[0];
    creative = { provider: generated.provider, model: generated.model,
      latencyMs: Date.now() - creativeStarted,
      fallbackUsed: generated.fallbackUsed, generationMode: generated.generationMode,
      hooks: generated.hooks?.length ?? 0, hashtags: generated.hashtags?.length ?? 0,
      validated: generated.generationStatus === 'GENERATED' && generated.hooks?.length === 3 &&
        generated.hashtags?.length === 5 && generated.synopsis?.split(/\n\n/u).length === 3 };
    if (!creative.validated || creative.fallbackUsed)
      throw new Error('Local creative package did not pass backend validation');
  }
  global.fetch = nativeFetch;
  console.log(JSON.stringify({ tagsHttpStatus: tagsResponse.status,
    tagsLatencyMs, generationHttpStatus: generationStatus,
    generationLatencyMs, model: result.metadata.model,
    provider: result.metadata.provider, jsonValid: result.data.status === 'ok' &&
      typeof result.data.message === 'string', simulatedCloudProviders: simulatedCloudCalls,
    deterministicFallbackUsed: false, creative, ...runtime }));
}

performanceContext.run(createPerformanceTelemetry('OFFLINE'), main).catch(error => {
  console.error(JSON.stringify({ error: error.name,
  message: String(error.message || error).slice(0, 300) })); process.exitCode = 1; });
