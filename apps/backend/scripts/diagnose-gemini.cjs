// Synthetic input only. Never prints credentials, headers, or user media.
const { resolve } = require('node:path');
process.loadEnvFile(resolve(__dirname, '../../../.env'));
const { LlmRouterService } = require('../dist/modules/processing/llm-router.service');
const { geminiJsonSchema } = require('../dist/modules/processing/llm-provider.service');
const { CLIP_CONTENT_PACKAGE_SCHEMA } = require('../dist/modules/processing/openai-clip-judge.service');
const { VIDEO_UNDERSTANDING_SCHEMA } = require('../dist/modules/processing/video-understanding.service');
async function main() {
  const videoUnderstanding = process.argv.includes('--video-understanding');
  const role = videoUnderstanding ? 'wholeVideoUnderstanding' : 'creativeGeneration';
  const schemaName = videoUnderstanding ? 'video_understanding' :
    'clip_candidate_content_package';
  const config = new LlmRouterService().routesFor(role).find(r => r.apiStyle === 'gemini');
  if (!config?.apiKey) throw new Error('GOOGLE_API_KEY is not configured');
  const endpoint = config.baseUrl + '/models/' + config.model.replace(/^models\//, '') + ':generateContent';
  const stripKeywords = new Set((process.argv.find(value => value.startsWith('--strip='))?.slice(8) || '')
    .split(',').filter(Boolean));
  const simpleSchema = process.argv.includes('--simple-schema');
  const keepNumericBounds = process.argv.includes('--keep-numeric-bounds');
  const sourceSchema = videoUnderstanding ? VIDEO_UNDERSTANDING_SCHEMA :
    CLIP_CONTENT_PACKAGE_SCHEMA;
  const sanitizeSchema = (value) => Array.isArray(value) ? value.map(sanitizeSchema) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => !stripKeywords.has(key)).map(([key, child]) => [key, sanitizeSchema(child)])) : value;
  const response = await fetch(endpoint, { method: 'POST',
    headers: { 'x-goog-api-key': config.apiKey, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(45000), body: JSON.stringify({
      systemInstruction: { parts: [{ text: videoUnderstanding
        ? 'Analyze the synthetic timestamped transcript. Return compact schema-valid JSON only.'
        : 'Return one synthetic clip content package. Use no private data.' }] },
      contents: [{ role: 'user', parts: [{ text: videoUnderstanding
        ? '[0-15] A concise synthetic explanation introduces a workflow.\n' +
          '[15-30] The workflow reaches a grounded conclusion.'
        : JSON.stringify([{ startTime: 0, endTime: 30, duration: 30,
          exactClipTranscript: 'A concise synthetic explanation reaches a clear conclusion.' }]) }] }],
      generationConfig: { responseMimeType: 'application/json',
        responseJsonSchema: simpleSchema ? { type: 'object', properties: {
          candidates: { type: 'array', items: { type: 'object', properties: {
            title: { type: 'string' } }, required: ['title'] } } }, required: ['candidates'] } :
          sanitizeSchema(geminiJsonSchema(sourceSchema,
            keepNumericBounds ? '' : schemaName)),
        temperature: 0.1, maxOutputTokens: videoUnderstanding ? 2048 : 4096 }
    }) });
  const body = await response.text();
  let summary = {};
  if (response.ok) {
    const payload = JSON.parse(body);
    const candidate = payload.candidates?.[0];
    const text = candidate?.content?.parts?.map(part => part.text || '').join('') || '';
    let completeJson = false;
    try { completeJson = !!JSON.parse(text); } catch { /* reported below */ }
    summary = { finishReason: candidate?.finishReason || null, completeJson,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? null };
  } else summary = { sanitizedError: body.split(config.apiKey).join('[REDACTED]') };
  console.log(JSON.stringify({ status: response.status, model: config.model,
    schema: schemaName, role,
    schemaVariant: simpleSchema ? 'simple' : keepNumericBounds ? 'numeric-bounds' : 'production',
    stripKeywords: [...stripKeywords],
    ...summary }));
  if (!response.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.name + ': diagnostic failed'); process.exitCode = 1; });
