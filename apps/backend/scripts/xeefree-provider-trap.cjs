// Isolated acceptance preload only. Never enabled in production or Pro comparison.
require('reflect-metadata');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { LlmProviderService } = require('../dist/modules/processing/llm-provider.service');
function trap(surface) {
  return async function () {
    process.stderr.write(JSON.stringify({ event: 'xeefree_provider_trap', surface }) + '\n');
    throw Error('XEEFREE_ACCEPTANCE_PROVIDER_ENTRY_CALLED: ' + surface);
  };
}
LlmRouterService.prototype.generate = trap('router.generate');
for (const method of ['generateStructuredWithConfig', 'requestResponsesApi', 'requestChatCompletionsApi', 'requestGeminiApi', 'requestAnthropicApi'])
  LlmProviderService.prototype[method] = trap('provider.' + method);
process.stderr.write(JSON.stringify({ event: 'xeefree_provider_trap_ready', providerEntries: 6 }) + '\n');
