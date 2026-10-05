// Step 6: there is no local production LLM any more. This script used to verify a
// live Ollama/Qwen endpoint; it now verifies the opposite against the CURRENT
// environment (run it inside the backend container to check a real deployment):
// no AI mode, under any LOCAL_LLM_* leftovers, routes any role to a local model,
// and ONLINE routes only to the OpenAI API. It never calls a provider.
require('reflect-metadata');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { LlmProviderService } = require('../dist/modules/processing/llm-provider.service');

const roles = ['wholeVideoUnderstanding', 'multimodalUnderstanding', 'clipUnderstanding',
  'candidateJudge', 'creativeGeneration', 'critic', 'componentRepair', 'editingPlan'];
const router = new LlmRouterService(new LlmProviderService());
const report = {};
let failed = false;
for (const mode of ['ONLINE', 'OFFLINE', 'FALLBACK_ONLY']) {
  const routes = roles.flatMap((role) => router.routesFor(role, mode));
  const providers = [...new Set(routes.map((route) => route.provider))];
  const local = routes.filter((route) => route.apiStyle === 'ollama' ||
    /ollama|qwen|:11434|localhost|127\.0\.0\.1|host\.docker\.internal/iu
      .test(`${route.provider} ${route.baseUrl} ${route.model}`));
  report[mode] = { providers, localRoutes: local.length };
  if (local.length || (mode === 'ONLINE' && providers.some((provider) => provider !== 'openai')) ||
    (mode !== 'ONLINE' && routes.length)) failed = true;
}
const leftovers = Object.keys(process.env).filter((key) => key.startsWith('LOCAL_LLM_'));
console.log(JSON.stringify({ event: 'verify_no_local_llm', report,
  ignoredLegacyEnv: leftovers, openAiKeyConfigured: !!process.env.OPENAI_API_KEY?.trim() }));
if (failed) {
  console.error('FAILED: a local or non-OpenAI model route exists.');
  process.exitCode = 1;
} else {
  console.log('PASSED: no local LLM route; ONLINE is OpenAI only' +
    (leftovers.length ? ` (legacy ${leftovers.join(', ')} ignored)` : '') + '.');
}
