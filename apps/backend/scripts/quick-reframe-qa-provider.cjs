// Explicit isolated-QA preload. No production entry point imports this file.
const fs = require('node:fs');
if (process.env.QUICK_REFRAME_QA !== '1' || !process.env.QUICK_REFRAME_QA_STATE) throw Error('Isolated QA configuration required');
require('reflect-metadata');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { LlmProviderService, LlmProviderError } = require('../dist/modules/processing/llm-provider.service');
const { currentExecutionPolicy, performanceContext } = require('../dist/modules/processing/performance-telemetry');
const { markProviderBusy } = require('../dist/modules/processing/generation-availability');
const review = require('./fixtures/hook-review.cjs');
const file = process.env.QUICK_REFRAME_QA_STATE;
const write = state => fs.writeFileSync(file, JSON.stringify(state, null, 2));
LlmRouterService.prototype.generate = async function(input) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const telemetry = performanceContext.getStore();
  if (currentExecutionPolicy().mode === 'XEEFREE') {
    state.freeAttempts = (state.freeAttempts || 0) + 1; write(state);
    throw Error('QA_FREE_CLOUD_ATTEMPT');
  }
  state.proCalls = (state.proCalls || 0) + 1;
  state.roles = [...(state.roles || []), input.role]; write(state);
  if (state.busy) { markProviderBusy('PROVIDER_QUOTA_UNAVAILABLE'); throw new LlmProviderError('QUOTA_FAILURE','QA_BUSY',429); }
  if (telemetry) { telemetry.openAiCalls++; telemetry.cloudLlmCalls++; }
  const hooks = [
    {text:'Credentials cannot win this argument',category:'CURIOSITY',support:'Arguments stand on their merits'},
    {text:'Why credentials cannot settle the debate',category:'QUESTION',support:'Arguments stand on their merits'}
  ];
  const data = input.role === 'critic' ? review(input) : input.role === 'clipUnderstanding' ? {}
    : {hooks, synopsis:'Arguments must stand on their own merits. Credentials cannot settle a debate.',
      captions:[{style:'Concise',text:'Arguments must stand on their own merits.'},{style:'Engaging',text:'Credentials cannot settle a debate. Arguments must stand on their own.'},
        {style:'Professional',text:'Judge arguments on their merits, regardless of credentials.'}],
      hashtagSets:['Focused','Niche','Broad'].map(label=>({label,hashtags:['#Arguments','#Credentials','#Debate','#Explanation','#Merits']})), supportingLine:''};
  return {data,metadata:{role:input.role,provider:'QA',model:'QA',cacheHit:false}};
};
for (const method of ['generateStructuredWithConfig','requestResponsesApi','requestChatCompletionsApi','requestGeminiApi','requestAnthropicApi'])
  LlmProviderService.prototype[method] = async function() {
    const state = JSON.parse(fs.readFileSync(file, 'utf8')); state.transportAttempts = (state.transportAttempts || 0) + 1; write(state);
    throw Error('QA_EXTERNAL_TRANSPORT_ATTEMPT');
  };
