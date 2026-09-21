import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { assertLlmCallBudget, countLlmFailure, countLlmRequest, countLlmSuccess,
  countPerformance } from './performance-telemetry';

export type StrictJsonSchema = Readonly<Record<string, unknown>>;
export type LlmTaskRole = 'multimodalUnderstanding' | 'wholeVideoUnderstanding' |
  'clipUnderstanding' | 'deepReasoning' | 'candidateJudge' | 'creativeGeneration' |
  'hookGeneration' | 'captionGeneration' | 'titleGeneration' | 'hashtagGeneration' |
  'synopsisGeneration' | 'critic' | 'groundingVerification' | 'componentRepair' |
  'editingPlan';
export type LlmGenerationOptions = { temperature?: number; timeoutMs?: number;
  maxOutputTokens?: number };
export type StructuredGenerationRequest = { schemaName: string; schema: StrictJsonSchema;
  role?: LlmTaskRole; partialBatchField?: string;
  systemPrompt: string; userPrompt: string; maxOutputTokens?: number; cacheKey?: string;
  options?: LlmGenerationOptions;
  media?: Array<{ mimeType: string; data?: string; url?: string }>;
  local?: { schemaName: string; schema: StrictJsonSchema; systemPrompt?: string;
    userPrompt?: string; maxOutputTokens?: number; partialBatchField?: string } };
export type LlmApiStyle = 'responses' | 'chat_completions' | 'gemini' | 'anthropic' | 'ollama';
export type LlmEndpointConfig = { provider: string; apiKey: string; baseUrl: string;
  model: string; apiStyle: LlmApiStyle; timeoutMs: number; maxRetries: number;
  retryBaseDelayMs: number; concurrency: number };

export const LLM_DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';
export type LlmFailureKind = 'CONFIGURATION_FAILURE' | 'AUTH_FAILURE' |
  'QUOTA_FAILURE' | 'QUOTA_EXHAUSTED_FAILURE' | 'RATE_LIMIT_FAILURE' |
  'TRUNCATED_RESPONSE_FAILURE' | 'TIMEOUT_FAILURE' | 'NETWORK_FAILURE' |
  'PROVIDER_SATURATION_FAILURE' |
  'PROVIDER_5XX_FAILURE' | 'MALFORMED_RESPONSE_FAILURE' | 'SCHEMA_FAILURE' |
  'CONTENT_VALIDATION_FAILURE' | 'INVALID_REQUEST_FAILURE' | 'CIRCUIT_OPEN' |
  'CALL_BUDGET_EXCEEDED' | 'CONTENT_QUALITY_FAILURE' | 'PROVIDER_FAILURE' |
  'LOCAL_PROVIDER_UNAVAILABLE' | 'LOCAL_MODEL_NOT_FOUND' |
  'LOCAL_TIMEOUT_FAILURE' | 'LOCAL_CONNECTION_FAILURE' |
  'LOCAL_RESPONSE_FAILURE' | 'LOCAL_SCHEMA_FAILURE' | 'AI_MODE_FALLBACK_ONLY' |
  'MODEL_NOT_FOUND';

export class LlmProviderError extends Error {
  constructor(public readonly kind: LlmFailureKind, message: string,
    public readonly status?: number, public readonly retryable = false,
    public attempts = 1, public readonly retryAfterMs?: number,
    public readonly providerReason?: string) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

const trimSlash = (value: string) => value.replace(/\/+$/u, '');
const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const nonNegativeInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

function legacyConfig(): LlmEndpointConfig {
  const inferredProvider = process.env.NVIDIA_API_KEY?.trim() ? 'nvidia' : 'openai';
  const provider = (process.env.LLM_PROVIDER?.trim() ||
    process.env.CLIP_JUDGE_PROVIDER?.trim() || inferredProvider).toLowerCase();
  const common = {
    maxRetries: Math.min(1, nonNegativeInteger(process.env.LLM_MAX_RETRIES, 1)),
    retryBaseDelayMs: positiveInteger(process.env.LLM_RETRY_BASE_DELAY_MS, 1000)
  };
  if (provider === 'nvidia') return { provider,
    apiKey: (process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY || '').trim(),
    baseUrl: trimSlash(process.env.LLM_BASE_URL || process.env.NVIDIA_BASE_URL ||
      'https://integrate.api.nvidia.com/v1'),
    model: (process.env.LLM_MODEL || process.env.NVIDIA_MODEL ||
      'nvidia/nemotron-3-super-120b-a12b').trim(),
    apiStyle: process.env.LLM_API_STYLE === 'responses' ? 'responses' : 'chat_completions',
    timeoutMs: positiveInteger(process.env.LLM_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS, 90000),
    concurrency: positiveInteger(process.env.NVIDIA_CONCURRENCY, 2), ...common };
  if (provider === 'openai') return { provider,
    apiKey: (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim(),
    baseUrl: trimSlash(process.env.LLM_BASE_URL || 'https://api.openai.com/v1'),
    model: (process.env.LLM_MODEL || process.env.OPENAI_MODEL || LLM_DEFAULT_OPENAI_MODEL).trim(),
    apiStyle: process.env.LLM_API_STYLE === 'chat_completions' ? 'chat_completions' : 'responses',
    timeoutMs: positiveInteger(process.env.LLM_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS, 90000),
    concurrency: positiveInteger(process.env.LLM_PROVIDER_CONCURRENCY, 2), ...common };
  return { provider, apiKey: (process.env.LLM_API_KEY || '').trim(),
    baseUrl: trimSlash(process.env.LLM_BASE_URL || ''), model: (process.env.LLM_MODEL || '').trim(),
    apiStyle: process.env.LLM_API_STYLE === 'responses' ? 'responses' : 'chat_completions',
    timeoutMs: positiveInteger(process.env.LLM_TIMEOUT_MS, 90000),
    concurrency: positiveInteger(process.env.LLM_PROVIDER_CONCURRENCY, 2), ...common };
}

function responseApiText(response: Record<string, unknown>) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!item || typeof item !== 'object') continue;
    for (const part of Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content : []) {
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string')
        return (part as { text: string }).text;
    }
  }
  throw new LlmProviderError('MALFORMED_RESPONSE_FAILURE', 'LLM response contained no output text');
}
function chatApiText(response: Record<string, unknown>) {
  const first = (Array.isArray(response.choices) ? response.choices : [])[0];
  const message = first && typeof first === 'object' ? (first as { message?: unknown }).message : null;
  if (!message || typeof message !== 'object' ||
    typeof (message as { content?: unknown }).content !== 'string') {
    throw new LlmProviderError('MALFORMED_RESPONSE_FAILURE', 'LLM response contained no message content');
  }
  return (message as { content: string }).content;
}
function geminiApiText(response: Record<string, unknown>) {
  const candidate = (Array.isArray(response.candidates) ? response.candidates : [])[0];
  const content = candidate && typeof candidate === 'object'
    ? (candidate as { content?: unknown }).content : null;
  const parts = content && typeof content === 'object' &&
    Array.isArray((content as { parts?: unknown }).parts)
    ? (content as { parts: unknown[] }).parts : [];
  const text = parts.map((part) => part && typeof part === 'object' &&
    typeof (part as { text?: unknown }).text === 'string'
    ? (part as { text: string }).text : '').join('');
  if (!text) throw new LlmProviderError('MALFORMED_RESPONSE_FAILURE',
    'Gemini response contained no output text');
  return text;
}
function ollamaApiText(response: Record<string, unknown>) {
  const message = response.message && typeof response.message === 'object'
    ? response.message as Record<string, unknown> : null;
  if (!message || typeof message.content !== 'string' || !message.content.trim()) {
    throw new LlmProviderError('LOCAL_RESPONSE_FAILURE',
      'Ollama response contained no final message content');
  }
  // Ollama may return thinking separately. Only the final content is ever persisted.
  return message.content;
}

export function validateSchema(value: unknown, schema: Record<string, unknown>, path = '$'): void {
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new LlmProviderError('SCHEMA_FAILURE', path + ' must be an object');
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, Record<string, unknown>> : {};
    for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) {
      if (!(key in record)) throw new LlmProviderError('SCHEMA_FAILURE', path + '.' + key + ' is required');
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(record).find((key) => !(key in properties));
      if (unexpected) throw new LlmProviderError('SCHEMA_FAILURE', path + '.' + unexpected + ' is unexpected');
    }
    for (const [key, child] of Object.entries(properties))
      if (key in record) validateSchema(record[key], child, path + '.' + key);
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new LlmProviderError('SCHEMA_FAILURE', path + ' must be an array');
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      throw new LlmProviderError('SCHEMA_FAILURE', path + ' has too few items');
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      throw new LlmProviderError('SCHEMA_FAILURE', path + ' has too many items');
    if (schema.items && typeof schema.items === 'object') value.forEach((item, index) =>
      validateSchema(item, schema.items as Record<string, unknown>, path + '[' + index + ']'));
    return;
  }
  if (type === 'string' && typeof value !== 'string')
    throw new LlmProviderError('SCHEMA_FAILURE', path + ' must be a string');
  if (type === 'boolean' && typeof value !== 'boolean')
    throw new LlmProviderError('SCHEMA_FAILURE', path + ' must be a boolean');
  if ((type === 'number' || type === 'integer') &&
    (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))))
    throw new LlmProviderError('SCHEMA_FAILURE', path + ' must be a finite ' + type);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    throw new LlmProviderError('SCHEMA_FAILURE', path + ' is not an allowed value');
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      throw new LlmProviderError('SCHEMA_FAILURE', path + ' is below minimum');
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      throw new LlmProviderError('SCHEMA_FAILURE', path + ' exceeds maximum');
  }
}

// Only representation repairs: never invent missing facts or coerce arbitrary values.
export function normalizeSchema(value: unknown, schema: Record<string, unknown>): unknown {
  if (schema.type === 'object' && Array.isArray(value)) {
    const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    const keys = Object.keys(properties);
    if (keys.length === 1 && properties[keys[0]].type === 'array')
      return normalizeSchema({ [keys[0]]: value }, schema);
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    const record = { ...value } as Record<string, unknown>;
    for (const key of Object.keys(properties)) {
      if (key in record) continue;
      const aliases = Object.keys(record).filter(alias =>
        alias.replace(/_/gu, '').toLowerCase() === key.toLowerCase());
      if (aliases.length === 1) { record[key] = record[aliases[0]]; delete record[aliases[0]]; }
    }
    return Object.fromEntries(Object.entries(record).filter(([key]) =>
      schema.additionalProperties !== false || key in properties).map(([key, child]) =>
      [key, properties[key] ? normalizeSchema(child, properties[key]) : child]));
  }
  if (schema.type === 'array' && Array.isArray(value)) return value.map(item =>
    normalizeSchema(item, (schema.items || {}) as Record<string, unknown>));
  if ((schema.type === 'number' || schema.type === 'integer') && typeof value === 'string' &&
    /^-?\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value);
  if (schema.type === 'boolean' && typeof value === 'string' && /^(true|false)$/iu.test(value.trim()))
    return value.trim().toLowerCase() === 'true';
  if (typeof value === 'string' && Array.isArray(schema.enum)) {
    return schema.enum.find(item => typeof item === 'string' &&
      item.toLowerCase() === value.trim().toLowerCase()) ?? value;
  }
  return value;
}

export function validateStructuredOutput(value: unknown, request: StructuredGenerationRequest,
  onInvalid: (message: string) => void = () => {}) {
  const normalized = normalizeSchema(value, request.schema);
  if (JSON.stringify(normalized) !== JSON.stringify(value)) countPerformance('schemaRepairCount');
  const field = request.partialBatchField;
  const record = normalized as Record<string, unknown> | null;
  if (field && record && Array.isArray(record[field])) {
    const properties = request.schema.properties as Record<string, Record<string, unknown>>;
    const itemSchema = properties[field].items as Record<string, unknown>;
    record[field] = (record[field] as unknown[]).map((item, index) => {
      try { validateSchema(item, itemSchema, '$.' + field + '[' + index + ']'); return item; }
      catch (error) { countPerformance('schemaRepairCount');
        onInvalid(error instanceof Error ? error.message : 'Invalid batch item'); return null; }
    });
    validateSchema(record, { ...request.schema, properties: { ...properties,
      [field]: { ...properties[field], items: {} } } });
  } else validateSchema(normalized, request.schema);
  return normalized;
}

export function parseStructuredJson(response: string, field?: string): unknown {
  const source = response.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?\s*```$/iu.exec(source);
  // Strip fences only when they clearly wrap the entire response.
  const clean = fenced ? fenced[1].trim() : source;
  try { return JSON.parse(clean); } catch {
    // Salvage only complete JSON objects from a truncated batch. Never complete a partial item.
    if (!field || !/^[a-zA-Z]+$/u.test(field) || clean.length > 1000000) throw new Error('Invalid JSON');
    const prefix = new RegExp('^\\{\\s*"' + field + '"\\s*:\\s*\\[').exec(clean);
    if (!prefix) throw new Error('Invalid batch JSON');
    const items: unknown[] = [];
    let start = -1, depth = 0, quoted = false, escaped = false;
    for (let index = prefix[0].length; index < clean.length; index++) {
      const char = clean[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '{') { if (depth++ === 0) start = index; }
      else if (char === '}' && depth > 0 && --depth === 0) {
        items.push(JSON.parse(clean.slice(start, index + 1))); start = -1;
      } else if (depth === 0 && !/[\s,]/u.test(char)) break;
    }
    if (!items.length) throw new Error('No complete batch items');
    countPerformance('schemaRepairCount');
    return { [field]: items };
  }
}

/** One provider-neutral, representation-only pass for output that wraps valid JSON in prose. */
export function parseSafelyExtractedStructuredJson(response: string, field?: string): unknown {
  try { return parseStructuredJson(response, field); } catch { /* bounded extraction below */ }
  const source = response.trim();
  if (!source || source.length > 1000000) throw new Error('Invalid wrapped JSON');
  const start = source.search(/[\[{]/u);
  if (start < 0) throw new Error('Invalid wrapped JSON');
  const stack: string[] = [];
  let quoted = false, escaped = false, end = -1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.pop() !== expected) throw new Error('Invalid wrapped JSON');
      if (!stack.length) { end = index + 1; break; }
    }
  }
  if (end < 0) throw new Error('Invalid wrapped JSON');
  // Exactly one extraction parse: semantic content is never rewritten or completed.
  const value = JSON.parse(source.slice(start, end));
  countPerformance('schemaRepairCount');
  return value;
}

/** Backward-compatible name for callers/tests that describe the original Ollama behavior. */
export const parseLocalStructuredJson = parseSafelyExtractedStructuredJson;

class Semaphore {
  private active = 0;
  private readonly pending: Array<() => void> = [];
  constructor(private readonly maximum: number) {}
  get activeCount() { return this.active; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) await new Promise<void>((resolve) => this.pending.push(resolve));
    this.active += 1;
    try { return await operation(); } finally { this.active -= 1; this.pending.shift()?.(); }
  }
}

@Injectable()
export class LlmProviderService {
  private readonly logger = new Logger(LlmProviderService.name);
  private readonly responseUsage = new WeakMap<StructuredGenerationRequest,
    { finishReason: unknown; outputTokens: unknown }>();
  private readonly inFlightRequests = new Map<string, Promise<unknown>>();
  private readonly successfulRequests = new Map<string, unknown>();
  private readonly semaphores = new Map<string, Semaphore>();
  get providerName() { return legacyConfig().provider; }
  get modelName() { return legacyConfig().model; }
  isConfigured(config = legacyConfig()) {
    return !!(config.baseUrl && config.model && (config.apiStyle === 'ollama' || config.apiKey));
  }
  async generateStructured<T>(request: StructuredGenerationRequest): Promise<T> {
    return this.generateStructuredWithConfig<T>(legacyConfig(), request);
  }
  async generateStructuredWithConfig<T>(config: LlmEndpointConfig,
    request: StructuredGenerationRequest): Promise<T> {
    if (!this.isConfigured(config)) throw new LlmProviderError('CONFIGURATION_FAILURE',
      config.provider + '/' + (config.model || 'unconfigured') + ' is not fully configured');
    const key = this.requestKey(config, request);
    if (this.successfulRequests.has(key)) { countPerformance('cacheHits'); return this.successfulRequests.get(key) as T; }
    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) { countPerformance('cacheHits'); return inFlight as Promise<T>; }
    const semaphoreKey = config.provider + ':' + config.model;
    let semaphore = this.semaphores.get(semaphoreKey);
    if (!semaphore) { semaphore = new Semaphore(Math.max(1, Math.min(16, config.concurrency)));
      this.semaphores.set(semaphoreKey, semaphore); }
    const operation = semaphore.run(() => this.generateWithRetry<T>(config, request,
      semaphore.activeCount));
    this.inFlightRequests.set(key, operation);
    try {
      const result = await operation;
      this.successfulRequests.set(key, result);
      if (this.successfulRequests.size > 1000)
        this.successfulRequests.delete(this.successfulRequests.keys().next().value as string);
      return result;
    } finally { this.inFlightRequests.delete(key); }
  }
  private requestKey(config: LlmEndpointConfig, request: StructuredGenerationRequest) {
    return createHash('sha256').update(JSON.stringify({ provider: config.provider, model: config.model,
      schemaName: request.schemaName, schema: request.schema, partialBatchField: request.partialBatchField,
      cacheKey: request.cacheKey || '', role: request.role || '',
      promptVersion: createHash('sha256').update(request.systemPrompt).digest('hex'),
      schemaVersion: createHash('sha256').update(JSON.stringify(request.schema)).digest('hex'),
      systemPrompt: request.systemPrompt, userPrompt: request.userPrompt,
      media: request.media?.map((item) => ({ mimeType: item.mimeType, url: item.url || '',
        digest: item.data ? createHash('sha256').update(item.data).digest('hex') : '' })) || [],
      local: request.local || null,
      options: request.options || {} })).digest('hex');
  }
  private async generateWithRetry<T>(config: LlmEndpointConfig,
    request: StructuredGenerationRequest, providerConcurrency: number) {
    const effectiveRequest: StructuredGenerationRequest = config.apiStyle === 'ollama' && request.local
      ? { ...request, ...request.local, role: request.role, options: request.options,
        cacheKey: request.cacheKey, media: undefined, local: undefined }
      : request;
    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      const started = Date.now();
      const role = request.role || request.schemaName;
      try { assertLlmCallBudget(role, attempt > 0); } catch {
        throw new LlmProviderError('CALL_BUDGET_EXCEEDED', 'Per-job LLM call budget exceeded');
      }
      countLlmRequest(role, config.provider);
      if (role === 'critic') countPerformance('criticCount');
      if (role === 'componentRepair') countPerformance('repairCount');
      if (attempt) countPerformance('retryCount');
      try {
        const response = config.apiStyle === 'responses'
          ? await this.requestResponsesApi(config, effectiveRequest)
          : config.apiStyle === 'gemini' ? await this.requestGeminiApi(config, effectiveRequest)
            : config.apiStyle === 'anthropic' ? await this.requestAnthropicApi(config, effectiveRequest)
            : config.apiStyle === 'ollama' ? await this.requestOllamaApi(config, effectiveRequest)
              : await this.requestChatCompletionsApi(config, effectiveRequest);
        let parsed: unknown;
        try {
          const safeExtraction = config.apiStyle === 'ollama' ||
            config.provider.toLowerCase().includes('nvidia') ||
            /(?:^|\.)nvidia\.com(?:\/|$)/iu.test(config.baseUrl);
          parsed = safeExtraction
            ? parseSafelyExtractedStructuredJson(response, effectiveRequest.partialBatchField)
            : parseStructuredJson(response, effectiveRequest.partialBatchField);
        } catch {
          throw new LlmProviderError(config.apiStyle === 'ollama'
            ? 'LOCAL_RESPONSE_FAILURE' : 'MALFORMED_RESPONSE_FAILURE',
          'Structured generation output was not valid JSON');
        }
        try {
          parsed = validateStructuredOutput(parsed, effectiveRequest, message =>
            this.logger.warn(JSON.stringify({ event: 'llm_schema_repair',
              schema: effectiveRequest.schemaName, role: request.role, message })));
        } catch (error) {
          if (config.apiStyle === 'ollama') throw new LlmProviderError('LOCAL_SCHEMA_FAILURE',
            error instanceof Error ? error.message : 'Local structured output failed validation');
          throw error;
        }
        countLlmSuccess(role, config.provider);
        this.logTelemetry(config, effectiveRequest, attempt + 1, started, true,
          undefined, providerConcurrency);
        return parsed as T;
      } catch (error) {
        const normalized = this.normalizeFailure(error, config);
        countLlmFailure(config.provider);
        this.logger.warn(JSON.stringify({ event: 'llm_failure', provider: config.provider,
          model: config.model, schema: effectiveRequest.schemaName, role: request.role,
          status: normalized.status, message: config.apiKey
            ? normalized.message.split(config.apiKey).join('[REDACTED]') : normalized.message }));
        this.logTelemetry(config, effectiveRequest, attempt + 1, started, false,
          normalized.kind, providerConcurrency);
        if (!normalized.retryable || attempt === config.maxRetries) {
          normalized.attempts = attempt + 1;
          throw normalized;
        }
        const maximum = positiveInteger(process.env.LLM_RETRY_MAX_DELAY_MS, 5000);
        const jitterMaximum = nonNegativeInteger(process.env.LLM_RETRY_JITTER_MS, 750);
        const jitter = jitterMaximum ? Math.floor(Math.random() * (jitterMaximum + 1)) : 0;
        const delay = normalized.retryAfterMs ??
          Math.min(maximum, config.retryBaseDelayMs * (2 ** attempt)) + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new LlmProviderError('PROVIDER_FAILURE', 'Structured generation request failed');
  }
  private normalizeFailure(error: unknown, config: LlmEndpointConfig) {
    if (error instanceof LlmProviderError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' ||
      /timed?\s*out|timeout/iu.test(detail))) return new LlmProviderError(
        config.apiStyle === 'ollama' ? 'LOCAL_TIMEOUT_FAILURE' : 'TIMEOUT_FAILURE',
        config.apiStyle === 'ollama' ? 'Local structured generation timed out' :
          'Structured generation timed out', undefined, true);
    if (error instanceof TypeError || /fetch|network|dns|socket|connect/iu.test(detail))
      return new LlmProviderError(config.apiStyle === 'ollama'
        ? 'LOCAL_CONNECTION_FAILURE' : 'NETWORK_FAILURE', config.apiStyle === 'ollama'
        ? 'Local Ollama connection failed' : 'Structured generation network request failed',
      undefined, false);
    return new LlmProviderError('PROVIDER_FAILURE', 'Structured generation request failed',
      undefined, false);
  }
  private async requestResponsesApi(config: LlmEndpointConfig, request: StructuredGenerationRequest) {
    const response = await fetch(config.baseUrl + '/responses', { method: 'POST',
      headers: { authorization: 'Bearer ' + config.apiKey, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(request.options?.timeoutMs ?? config.timeoutMs),
      body: JSON.stringify({ model: config.model, store: false, reasoning: { effort: 'low' },
        instructions: request.systemPrompt, input: request.userPrompt,
        text: { verbosity: 'low', format: { type: 'json_schema', name: request.schemaName,
          strict: true, schema: request.schema } },
        max_output_tokens: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 12000 }) });
    return this.readResponse(response, config, request, responseApiText);
  }
  private async requestChatCompletionsApi(config: LlmEndpointConfig,
    request: StructuredGenerationRequest) {
    const response = await fetch(config.baseUrl + '/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer ' + config.apiKey, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(request.options?.timeoutMs ?? config.timeoutMs),
      body: JSON.stringify({ model: config.model,
        messages: [{ role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.media?.length ? [
            { type: 'text', text: request.userPrompt },
            ...request.media.map((item) => ({ type: 'image_url', image_url: {
              url: item.url || `data:${item.mimeType};base64,${item.data || ''}` } }))
          ] : request.userPrompt }],
        response_format: { type: 'json_schema', json_schema: { name: request.schemaName,
          strict: true, schema: request.schema } }, temperature: request.options?.temperature ?? 0.1,
        max_tokens: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 12000,
        stream: false }) });
    return this.readResponse(response, config, request, chatApiText);
  }
  private async requestGeminiApi(config: LlmEndpointConfig, request: StructuredGenerationRequest) {
    const model = config.model.startsWith('models/') ? config.model : 'models/' + config.model;
    const response = await fetch(config.baseUrl + '/' + encodeURI(model) + ':generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': config.apiKey, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(request.options?.timeoutMs ?? config.timeoutMs),
      body: JSON.stringify({ systemInstruction: { parts: [{ text: request.systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: request.userPrompt },
          ...(request.media || []).map((item) => item.data
            ? { inlineData: { mimeType: item.mimeType, data: item.data } }
            : { fileData: { mimeType: item.mimeType, fileUri: item.url } })] }],
        generationConfig: { responseMimeType: 'application/json',
          responseJsonSchema: geminiJsonSchema(request.schema, request.schemaName),
          temperature: request.options?.temperature ?? 0.1,
          maxOutputTokens: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 12000 } }) });
    return this.readResponse(response, config, request, geminiApiText);
  }
  private async requestAnthropicApi(config: LlmEndpointConfig,
    request: StructuredGenerationRequest) {
    const response = await fetch(config.baseUrl + '/messages', { method: 'POST',
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01',
        'content-type': 'application/json' },
      signal: AbortSignal.timeout(request.options?.timeoutMs ?? config.timeoutMs),
      body: JSON.stringify({ model: config.model,
        max_tokens: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 4096,
        system: request.systemPrompt + '\nReturn only valid JSON matching this schema: ' +
          JSON.stringify(request.schema),
        messages: [{ role: 'user', content: request.userPrompt }] }) });
    return this.readResponse(response, config, request, payload => {
      const content = payload.content;
      if (!Array.isArray(content)) throw new LlmProviderError('MALFORMED_RESPONSE_FAILURE',
        'Anthropic response contained no content');
      const text = content.filter((part): part is { type: string; text: string } =>
        !!part && typeof part === 'object' && part.type === 'text' &&
        typeof part.text === 'string').map(part => part.text).join('');
      if (!text) throw new LlmProviderError('MALFORMED_RESPONSE_FAILURE',
        'Anthropic response contained no text');
      return text;
    });
  }
  private async requestOllamaApi(config: LlmEndpointConfig, request: StructuredGenerationRequest) {
    const keepAlive = (process.env.LOCAL_LLM_KEEP_ALIVE || '').trim();
    const response = await fetch(config.baseUrl + '/api/chat', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(request.options?.timeoutMs ?? config.timeoutMs),
      body: JSON.stringify({ model: config.model, stream: false, think: false,
        messages: [{ role: 'system', content: request.systemPrompt +
          ' Return only the final JSON. Never include analysis, thinking, or markdown.' },
        { role: 'user', content: request.userPrompt }],
        format: ollamaJsonSchema(request.schema),
        options: { temperature: request.options?.temperature ?? 0.1,
          num_predict: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 6000 },
        ...(keepAlive ? { keep_alive: keepAlive } : {}) }) });
    return this.readResponse(response, config, request, ollamaApiText);
  }
  private async readResponse(response: Response, config: LlmEndpointConfig,
    request: StructuredGenerationRequest,
    extract: (payload: Record<string, unknown>) => string) {
    if (!response.ok) {
      const status = response.status;
      const detail = await response.text();
      const local = config.apiStyle === 'ollama';
      const googleFailure = config.provider === 'google' && status === 429
        ? parseGoogleResourceExhausted(detail, response.headers?.get('retry-after')) : null;
      const genericQuota = config.provider !== 'google' && status === 429 &&
        /quota|credit/iu.test(detail);
      const localModelMissing = local && status === 404 && /model[^\n]{0,160}not found/iu.test(detail);
      const kind: LlmFailureKind = localModelMissing ? 'LOCAL_MODEL_NOT_FOUND'
        : local && status === 408 ? 'LOCAL_TIMEOUT_FAILURE'
        : local && [502, 503, 504].includes(status) ? 'LOCAL_PROVIDER_UNAVAILABLE'
        : local ? 'LOCAL_RESPONSE_FAILURE'
        : status === 401 || status === 403 ? 'AUTH_FAILURE'
        : status === 408 ? 'TIMEOUT_FAILURE'
        : status === 404 ? 'MODEL_NOT_FOUND'
        : status === 402 || genericQuota ? 'QUOTA_FAILURE'
          : googleFailure?.hardQuota ? 'QUOTA_EXHAUSTED_FAILURE'
          : status === 429 ? 'RATE_LIMIT_FAILURE'
          : config.provider === 'google' && status === 503 ? 'PROVIDER_SATURATION_FAILURE'
          : status >= 500 ? 'PROVIDER_5XX_FAILURE'
            : status >= 400 && status < 500 ? 'INVALID_REQUEST_FAILURE' : 'PROVIDER_FAILURE';
      let providerCode = '';
      try {
        const payload = JSON.parse(detail) as { error?: { status?: unknown; code?: unknown } };
        const candidate = String(payload.error?.status ?? payload.error?.code ?? '').toUpperCase();
        providerCode = /^(?:RESOURCE_EXHAUSTED|UNAVAILABLE|NOT_FOUND|UNAUTHENTICATED|PERMISSION_DENIED|INVALID_ARGUMENT|MODEL_NOT_FOUND|RATE_LIMITED)$/u
          .test(candidate) ? candidate : '';
      } catch { /* Provider bodies can echo prompts; never copy arbitrary text into runtime logs. */ }
      this.logger.warn(JSON.stringify({ event: 'llm_provider_error', provider: config.provider,
        model: config.model, schema: request.schemaName, role: request.role, httpStatus: status,
        sanitizedBody: sanitizeProviderError(detail, config.apiKey) }));
      throw new LlmProviderError(kind,
        config.provider + ' structured generation request failed with HTTP ' + status +
          (providerCode ? ' (' + providerCode + ')' : ''),
        status, kind === 'TIMEOUT_FAILURE' || kind === 'LOCAL_TIMEOUT_FAILURE' ||
          kind === 'LOCAL_PROVIDER_UNAVAILABLE' || kind === 'PROVIDER_5XX_FAILURE' ||
          kind === 'PROVIDER_SATURATION_FAILURE',
        1, googleFailure?.retryAfterMs ?? (status === 429 ?
          retryAfterMilliseconds(response.headers?.get('retry-after')) : undefined),
        googleFailure?.reason ||
          (kind === 'PROVIDER_SATURATION_FAILURE' ? 'HIGH_DEMAND' : providerCode));
    }
    try {
      const payload = await response.json() as Record<string, unknown>;
      const first = (Array.isArray(payload.candidates) ? payload.candidates :
        Array.isArray(payload.choices) ? payload.choices : [])[0] as Record<string, unknown> | undefined;
      const message = first?.message && typeof first.message === 'object'
        ? first.message as Record<string, unknown> : null;
      const rawFinishReason = first?.finishReason ?? first?.finish_reason ??
        payload.stop_reason ?? payload.done_reason ?? payload.status ?? null;
      const finishReason = typeof rawFinishReason === 'string' &&
        /^(?:stop|end_turn|length|max[_ -]?(?:tokens|output_tokens)|complete|completed|tool_use)$/iu
          .test(rawFinishReason) ? rawFinishReason : null;
      const usage = payload.usageMetadata && typeof payload.usageMetadata === 'object'
        ? payload.usageMetadata as Record<string, unknown>
        : payload.usage && typeof payload.usage === 'object'
          ? payload.usage as Record<string, unknown> : {};
      const rawOutputTokens = usage.candidatesTokenCount ?? usage.output_tokens ??
        usage.completion_tokens ?? payload.eval_count ?? null;
      const outputTokens = typeof rawOutputTokens === 'number' &&
        Number.isFinite(rawOutputTokens) && rawOutputTokens >= 0 ? rawOutputTokens : null;
      this.logger.log(JSON.stringify({ event: 'llm_structured_response_diagnostic',
        provider: config.provider, model: config.model, upstreamModel: payload.model ?? null,
        schema: request.schemaName, httpStatus: response.status, finishReason,
        messageContentPresent: typeof message?.content === 'string' && !!message.content,
        messageReasoningPresent: typeof message?.reasoning === 'string' && !!message.reasoning,
        outputTokens, reasoningTokens: typeof (usage as Record<string, unknown>).reasoning_tokens === 'number'
          ? (usage as Record<string, unknown>).reasoning_tokens : null,
        requestedMaxOutputTokens: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 12000 }));
      this.responseUsage.set(request, { finishReason, outputTokens });
      this.logger.log(JSON.stringify({ event: 'llm_response', provider: config.provider,
        model: config.model, schema: request.schemaName, role: request.role,
        httpStatus: response.status, finishReason, outputTokens,
        requestedMaxOutputTokens: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 12000,
        providerMaxOutputTokens: request.options?.maxOutputTokens ?? request.maxOutputTokens ?? 12000 }));
      if (/^(?:length|max[_ -]?(?:tokens|output_tokens))$/iu.test(String(finishReason || ''))) {
        throw new LlmProviderError('TRUNCATED_RESPONSE_FAILURE',
          'Structured generation output was truncated by the provider token limit', response.status,
          false, 1, undefined, String(finishReason));
      }
      return extract(payload);
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      throw new LlmProviderError('MALFORMED_RESPONSE_FAILURE',
        'Structured generation response did not contain usable output');
    }
  }
  private logTelemetry(config: LlmEndpointConfig, request: StructuredGenerationRequest,
    attempt: number, started: number, success: boolean, failureCategory?: LlmFailureKind,
    providerConcurrency?: number) {
    const inputChars = request.systemPrompt.length + request.userPrompt.length;
    const responseUsage = this.responseUsage.get(request);
    const requestedMaxOutputTokens = request.options?.maxOutputTokens ??
      request.maxOutputTokens ?? (config.apiStyle === 'ollama' ? 6000 : 12000);
    this.logger.log(JSON.stringify({ event: 'llm_request', provider: config.provider,
      model: config.model, schema: request.schemaName, role: request.role, latencyMs: Date.now() - started,
      attempt, sameProviderRetry: attempt > 1, success, failureCategory: failureCategory || null,
      inputChars, inputTokenEstimate: Math.ceil(inputChars / 4), providerConcurrency,
      requestedMaxOutputTokens, providerMaxOutputTokens: requestedMaxOutputTokens,
      outputTokens: responseUsage?.outputTokens ?? null,
      finishReason: responseUsage?.finishReason ?? null }));
    this.responseUsage.delete(request);
  }
}

const GEMINI_SCHEMA_KEYS = new Set(['$id', '$defs', '$ref', '$anchor', 'type', 'format',
  'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems',
  'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties',
  'required', 'propertyOrdering']);

/** Keep Gemini's wire schema within its documented JSON Schema subset. Business rules remain local. */
export function geminiJsonSchema(schema: StrictJsonSchema, schemaName = ''): StrictJsonSchema {
  // Google rejects this large production schema when every repeated score bound is included.
  // The unchanged application schema is still enforced after generation.
  const omitNumericBounds = schemaName === 'clip_candidate_content_package' ||
    schemaName === 'video_understanding';
  // A live Gemini probe returns INVALID_ARGUMENT for this schema whenever repeated
  // minItems/maxItems constraints are present. Local validation still enforces them.
  const omitArrayBounds = schemaName === 'video_understanding';
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).filter(([key]) => GEMINI_SCHEMA_KEYS.has(key) &&
      !(omitNumericBounds && (key === 'minimum' || key === 'maximum')) &&
      !(omitArrayBounds && (key === 'minItems' || key === 'maxItems')))
      .map(([key, child]) => [key, key === 'properties' || key === '$defs'
        ? Object.fromEntries(Object.entries(child as Record<string, unknown>)
          .map(([name, item]) => [name, visit(item)])) : visit(child)]));
  };
  return visit(schema) as StrictJsonSchema;
}

const OLLAMA_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum',
  'minimum', 'maximum', 'minItems', 'maxItems', 'additionalProperties']);

/** Keep the provider-facing schema small; full application validation remains unchanged. */
export function ollamaJsonSchema(schema: StrictJsonSchema): StrictJsonSchema {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => OLLAMA_SCHEMA_KEYS.has(key))
      .map(([key, child]) => [key, key === 'properties'
        ? Object.fromEntries(Object.entries(child as Record<string, unknown>)
          .map(([name, item]) => [name, visit(item)])) : visit(child)]));
  };
  return visit(schema) as StrictJsonSchema;
}

export function sanitizeProviderError(detail: string, apiKey = '') {
  let safe = '';
  try {
    const payload = JSON.parse(detail) as Record<string, unknown>;
    const error = payload.error;
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const code = String(record.code ?? '').toUpperCase();
      const status = String(record.status ?? '').toUpperCase();
      const allowed = /^(?:RESOURCE_EXHAUSTED|UNAVAILABLE|NOT_FOUND|UNAUTHENTICATED|PERMISSION_DENIED|INVALID_ARGUMENT|MODEL_NOT_FOUND|RATE_LIMITED|401|403|404|429|500|503)$/u;
      safe = JSON.stringify({ code: allowed.test(code) ? code : '',
        status: allowed.test(status) ? status : '' });
    }
  } catch { /* Provider error bodies can echo credentials or prompts. */ }
  if (apiKey) safe = safe.split(apiKey).join('[REDACTED]');
  return safe;
}

function retryAfterMilliseconds(value: string | null | undefined, now = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function parseGoogleResourceExhausted(detail: string,
  retryAfter: string | null | undefined, now = Date.now()) {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(detail) as Record<string, unknown>; } catch { /* text fallback below */ }
  const error = payload.error && typeof payload.error === 'object'
    ? payload.error as Record<string, unknown> : {};
  const details = Array.isArray(error.details) ? error.details : [];
  const searchable = JSON.stringify({ message: error.message ?? detail, details });
  const retryInfo = details.find(item => item && typeof item === 'object' &&
    /RetryInfo$/u.test(String((item as Record<string, unknown>)['@type'] || ''))) as
    Record<string, unknown> | undefined;
  const retryDelay = typeof retryInfo?.retryDelay === 'string' &&
    /^(\d+)(?:\.(\d+))?s$/u.exec(retryInfo.retryDelay);
  const retryDelayMs = retryDelay ? Number(retryDelay[1]) * 1000 +
    Number(('0.' + (retryDelay[2] || '0'))) * 1000 : undefined;
  const hardQuota = /(?:billing|credit|daily|per day|quota[_ -]?exhausted|daily_limit_exceeded|limit[^0-9]{0,12}0\b)/iu
    .test(searchable);
  const reasonMatch = /"reason"\s*:\s*"([A-Z0-9_-]+)"/u.exec(searchable);
  return { hardQuota, retryAfterMs: retryAfterMilliseconds(retryAfter, now) ?? retryDelayMs,
    reason: reasonMatch?.[1] || String(error.status || 'RESOURCE_EXHAUSTED') };
}
