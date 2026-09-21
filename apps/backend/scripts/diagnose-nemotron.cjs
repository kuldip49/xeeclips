// Synthetic input only. Never prints credentials, headers, prompts, or provider response text.
const { resolve } = require('node:path');
process.loadEnvFile(resolve(__dirname, '../../../.env'));
const { parseStructuredJson, validateStructuredOutput } =
  require('../dist/modules/processing/llm-provider.service');
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { VIDEO_UNDERSTANDING_SCHEMA } =
  require('../dist/modules/processing/video-understanding.service');

async function main() {
  const config = new LlmRouterService().routesFor('wholeVideoUnderstanding')
    .find(route => route.provider === 'nvidia');
  if (!config?.apiKey) throw new Error('NVIDIA_API_KEY is not configured');
  const request = { role: 'wholeVideoUnderstanding', schemaName: 'video_understanding',
    schema: VIDEO_UNDERSTANDING_SCHEMA,
    systemPrompt: 'Analyze this synthetic timestamped transcript. Keep every field concise and return only the exact JSON schema.',
    userPrompt: 'Language hint: English\nTimestamped transcript:\n[0-10] A workflow begins with a clear plan.\n[10-20] Evidence is checked before publishing.\n[20-30] The result is a dependable process.',
    maxOutputTokens: 10000 };
  const started = Date.now();
  const response = await fetch(config.baseUrl + '/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer ' + config.apiKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(50000), body: JSON.stringify({ model: config.model,
      messages: [{ role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt }],
      response_format: { type: 'json_schema', json_schema: { name: request.schemaName,
        strict: true, schema: request.schema } }, temperature: 0.1,
      max_tokens: request.maxOutputTokens, stream: false }) });
  const payload = await response.json();
  const choice = payload.choices?.[0];
  let completeJson = false;
  if (response.ok) {
    try { validateStructuredOutput(parseStructuredJson(choice?.message?.content || ''), request);
      completeJson = true; } catch { /* reported without exposing model text */ }
  }
  console.log(JSON.stringify({ status: response.status, provider: config.provider, model: config.model,
    schema: request.schemaName, role: request.role, latencyMs: Date.now() - started,
    finishReason: choice?.finish_reason ?? null, completeJson,
    outputTokens: payload.usage?.completion_tokens ?? null,
    providerError: response.ok ? undefined : { code: payload.error?.code,
      type: payload.error?.type, status: payload.error?.status } }));
  if (!response.ok || !completeJson) process.exitCode = 1;
}
main().catch(error => { console.error((error.kind || error.name) + ': diagnostic failed');
  process.exitCode = 1; });
