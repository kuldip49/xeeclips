import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { countPerformance, currentAiProcessingMode, isProviderModelUnavailable,
  recordProviderChain,
  markProviderModelUnavailable, resetProviderModelAvailability } from './performance-telemetry';
import {
  LlmEndpointConfig,
  LlmFailureKind,
  LlmProviderError,
  LlmProviderService,
  LlmTaskRole,
  StructuredGenerationRequest
} from './llm-provider.service';
import { AiProcessingMode, normalizeAiProcessingMode } from './ai-processing-mode';
import { normalizeFailureCategory, NormalizedFailureCategory, ProviderRegistry,
  ProviderState } from './provider-registry';

export type LlmRouteAttempt = {
  provider: string;
  model: string;
  success: boolean;
  failureCategory?: LlmFailureKind;
  normalizedFailureCategory?: NormalizedFailureCategory;
  latencyMs: number;
  priorityIndex?: number;
  providerState?: ProviderState;
};

export type LlmRouteMetadata = {
  role: LlmTaskRole;
  provider: string;
  model: string;
  failover: boolean;
  cacheHit: boolean;
  attempts: LlmRouteAttempt[];
};

export type NormalizedLlmResult<T> = { provider: string; model: string;
  role: LlmTaskRole; success: boolean; data?: T; latencyMs: number;
  inputTokenEstimate: number; requestedMaxOutputTokens: number;
  outputTokens: number | null; finishReason: string | null;
  failureCategory: NormalizedFailureCategory | null };
export type LlmRouteResult<T> = { data: T; metadata: LlmRouteMetadata;
  normalized?: NormalizedLlmResult<T> };

type Circuit = { failureTimes: number[]; cooldownUntil: number; halfOpenProbe: boolean };

const numberSetting = (name: string, fallback: number, minimum = 0, maximum = 600000) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.floor(parsed))) : fallback;
};
// Step 6 production model policy: ONLINE routes to the OpenAI API only; every
// other mode (FALLBACK_ONLY, and the legacy OFFLINE value, which is normalized to
// FALLBACK_ONLY) has NO model route and callers use their deterministic fallback.
// There is no local (Ollama/Qwen) LLM route.

const CREATIVE_ROLES = new Set<LlmTaskRole>(['creativeGeneration', 'hookGeneration',
  'captionGeneration', 'titleGeneration', 'hashtagGeneration', 'synopsisGeneration',
  'componentRepair']);
export const AI_MODE_ROLE_TIMEOUTS: Record<AiProcessingMode.ONLINE,
  Readonly<Record<'multimodalUnderstanding' | 'wholeVideoUnderstanding' |
  'clipUnderstanding' | 'creativeGeneration' | 'critic' | 'componentRepair' |
  'editingPlan', number>>> = {
  [AiProcessingMode.ONLINE]: {
    multimodalUnderstanding: 18000,
    wholeVideoUnderstanding: 18000,
    clipUnderstanding: 40000,
    creativeGeneration: 20000,
    critic: 12000,
    componentRepair: 15000,
    editingPlan: 40000
  }
};

function roleSettingPrefix(role: LlmTaskRole) {
  return role.replace(/([a-z])([A-Z])/gu, '$1_$2').toUpperCase();
}

type TimeoutRole = keyof typeof AI_MODE_ROLE_TIMEOUTS[AiProcessingMode.ONLINE];
function timeoutRole(role: LlmTaskRole): TimeoutRole {
  if (role === 'groundingVerification') return 'critic';
  if (role === 'componentRepair') return 'componentRepair';
  if (CREATIVE_ROLES.has(role)) return 'creativeGeneration';
  if (role === 'deepReasoning') return 'wholeVideoUnderstanding';
  if (role === 'candidateJudge') return 'clipUnderstanding';
  return role as TimeoutRole;
}

/** Role limits are fail-fast ceilings. Environment settings may shorten, never extend, them. */
export function effectiveRoleTimeoutMs(mode: AiProcessingMode.ONLINE,
  role: LlmTaskRole, providerMaximumMs = 600000) {
  const policyRole = timeoutRole(role);
  const ceiling = AI_MODE_ROLE_TIMEOUTS[mode][policyRole];
  const configured = numberSetting('LLM_' + roleSettingPrefix(policyRole) + '_TIMEOUT_MS',
    ceiling, 1000, ceiling);
  return Math.min(providerMaximumMs, configured, ceiling);
}

@Injectable()
export class LlmRouterService {
  private readonly logger = new Logger(LlmRouterService.name);
  private readonly circuits = new Map<string, Circuit>();
  private readonly successful = new Map<string, LlmRouteResult<unknown>>();
  private readonly successfulRouteKeys = new Map<string, string>();
  // `kind` keeps WHY a model is unavailable, so later requests report the real cause
  // (e.g. a rejected key) instead of a generic "paused briefly, try again soon".
  private readonly unavailable = new Map<string, { until: number; credentialHash?: string;
    kind?: LlmProviderError['kind'] }>();

  constructor(private readonly provider: LlmProviderService = new LlmProviderService(),
    readonly registry: ProviderRegistry = new ProviderRegistry()) {}

  routesFor(role: LlmTaskRole, requestedMode?: unknown): LlmEndpointConfig[] {
    const aiMode = requestedMode === undefined ? currentAiProcessingMode()
      : normalizeAiProcessingMode(requestedMode);
    if (aiMode !== AiProcessingMode.ONLINE) return [];
    return this.registry.chain(role).map(adapter => adapter.routeFor(role));
  }

  isAnyConfigured(role: LlmTaskRole) {
    if (currentAiProcessingMode() !== AiProcessingMode.ONLINE) {
      this.logger.log(JSON.stringify({ event: 'llm_skipped', role,
        reason: 'AI_MODE_FALLBACK_ONLY', aiMode: AiProcessingMode.FALLBACK_ONLY }));
      return false;
    }
    return this.routesFor(role).some((route) => this.provider.isConfigured(route));
  }

  configuredRouteFor(role: LlmTaskRole) {
    return this.routesFor(role).find((route) => this.provider.isConfigured(route));
  }

  async generate<T>(input: { role: LlmTaskRole; request: StructuredGenerationRequest }):
    Promise<LlmRouteResult<T>> {
    const aiMode = currentAiProcessingMode();
    if (aiMode !== AiProcessingMode.ONLINE) {
      this.logger.log(JSON.stringify({ event: 'llm_skipped', role: input.role,
        reason: 'AI_MODE_FALLBACK_ONLY', aiMode }));
      throw new LlmProviderError('AI_MODE_FALLBACK_ONLY',
        'Generative model routing is disabled for FALLBACK_ONLY');
    }
    const cacheKey = this.cacheKey(input.role, input.request, aiMode);
    const cachedRouteKey = this.successfulRouteKeys.get(cacheKey);
    const cached = cachedRouteKey ? this.successful.get(cachedRouteKey) : undefined;
    const routes = this.routesFor(input.role);
    const cachedRoute = cached && routes.find(route => route.provider === cached.metadata.provider &&
      route.model === cached.metadata.model && this.provider.isConfigured(route) &&
      this.stateFor(route, input.role) === 'HEALTHY');
    if (cached && cachedRoute) {
      countPerformance('cacheHits');
      this.logger.log(JSON.stringify({ event: 'llm_route_cache', role: input.role,
        provider: cached.metadata.provider, model: cached.metadata.model, cacheHit: true }));
      return { ...(cached as LlmRouteResult<T>),
        metadata: { ...(cached.metadata), cacheHit: true } };
    }
    this.logger.log(JSON.stringify({ event: 'llm_route_cache', role: input.role, cacheHit: false }));
    const attempts: LlmRouteAttempt[] = [];
    let lastError: LlmProviderError | undefined;
    for (const [routeIndex, route] of routes.entries()) {
      if (!this.provider.isConfigured(route)) continue;
      if (this.isUnavailable(route) || isProviderModelUnavailable(this.circuitKey(route)) ||
        this.isCircuitOpen(this.circuitKey(route))) {
        countPerformance('circuitOpenCount');
        attempts.push({ provider: route.provider, model: route.model, success: false,
          failureCategory: 'CIRCUIT_OPEN', normalizedFailureCategory: 'PROVIDER_UNAVAILABLE',
          latencyMs: 0, priorityIndex: routeIndex,
          providerState: 'COOLDOWN' });
        this.logger.warn(JSON.stringify({ event: 'llm_job_route_unavailable', role: input.role,
          provider: route.provider, model: route.model }));
        // A permanent cause (rejected key, exhausted quota, missing model) is reported as itself.
        const cause = this.unavailable.get(this.circuitKey(route))?.kind;
        if (cause) lastError = new LlmProviderError(cause, 'Provider unavailable: ' + cause);
        continue;
      }
      const circuitPermit = this.acquireCircuit(route, input.role);
      if (!circuitPermit) {
        countPerformance('circuitOpenCount');
        attempts.push({ provider: route.provider, model: route.model, success: false,
          failureCategory: 'CIRCUIT_OPEN', normalizedFailureCategory: 'PROVIDER_UNAVAILABLE',
          latencyMs: 0, priorityIndex: routeIndex,
          providerState: 'COOLDOWN' });
        this.logger.warn(JSON.stringify({ event: 'llm_circuit_open', role: input.role,
          provider: route.provider, model: route.model }));
        continue;
      }
      const started = Date.now();
      const timeoutMs = effectiveRoleTimeoutMs(AiProcessingMode.ONLINE, input.role, route.timeoutMs);
      // Interactive cloud roles fail over after one attempt per provider.
      const boundedRoute = { ...route, timeoutMs,
        maxRetries: 0 };
      if (attempts.length) countPerformance('failoverCount');
      recordProviderChain(route.provider);
      try {
        const request = {
          ...input.request,
          role: input.role,
          options: { ...this.settingsFor(input.role), ...input.request.options,
            timeoutMs: Math.min(input.request.options?.timeoutMs ?? timeoutMs, timeoutMs) }
        };
        const adapter = this.registry.get(route.provider);
        const data = adapter ? await adapter.generateStructured<T>(boundedRoute, request,
          this.provider) : await this.provider.generateStructuredWithConfig<T>(boundedRoute, request);
        attempts.push({ provider: route.provider, model: route.model, success: true,
          latencyMs: Date.now() - started, priorityIndex: routeIndex, providerState: 'HEALTHY' });
        this.recordSuccess(route, input.role, circuitPermit);
        const inputChars = input.request.systemPrompt.length + input.request.userPrompt.length;
        const result: LlmRouteResult<T> = { data, normalized: { provider: route.provider,
          model: route.model, role: input.role, success: true, data,
          latencyMs: Date.now() - started, inputTokenEstimate: Math.ceil(inputChars / 4),
          requestedMaxOutputTokens: request.options.maxOutputTokens ??
            request.maxOutputTokens ?? 12000, outputTokens: null, finishReason: null,
          failureCategory: null }, metadata: { role: input.role,
          provider: route.provider, model: route.model, failover: routeIndex > 0,
          cacheHit: false, attempts } };
        const successfulKey = this.routeCacheKey(cacheKey, route);
        this.successful.set(successfulKey, result);
        this.successfulRouteKeys.set(cacheKey, successfulKey);
        if (this.successful.size > 1000)
          this.successful.delete(this.successful.keys().next().value as string);
        this.log(input.role, route, true, routeIndex > 0, attempts);
        return result;
      } catch (error) {
        lastError = error instanceof LlmProviderError ? error :
          new LlmProviderError('PROVIDER_FAILURE', 'Provider request failed');
        attempts.push({ provider: route.provider, model: route.model, success: false,
          failureCategory: lastError.kind,
          normalizedFailureCategory: normalizeFailureCategory(lastError.kind),
          latencyMs: Date.now() - started,
          priorityIndex: routeIndex, providerState: 'DEGRADED' });
        this.recordFailure(route, input.role, lastError);
        this.log(input.role, route, false, routeIndex > 0, attempts, lastError.kind);
        if (lastError.kind === 'CALL_BUDGET_EXCEEDED') throw lastError;
      }
    }
    throw lastError || (attempts.some(item => item.failureCategory === 'CIRCUIT_OPEN')
      ? new LlmProviderError('CIRCUIT_OPEN', 'All configured providers are unavailable or circuit-open')
      : new LlmProviderError('CONFIGURATION_FAILURE',
        'No configured capable model is available for role ' + input.role));
  }

  resetHealth() { this.circuits.clear(); this.unavailable.clear();
    resetProviderModelAvailability(); }

  stateFor(route: LlmEndpointConfig, role: LlmTaskRole): ProviderState {
    if (!this.registry.isEnabled(route.provider)) return 'DISABLED';
    if (!this.provider.isConfigured(route)) return 'UNCONFIGURED';
    if (this.isUnavailable(route)) return 'UNAVAILABLE';
    if (this.isCircuitOpen(this.circuitKey(route)) ||
      this.isCircuitOpen(this.circuitKey(route, role))) return 'COOLDOWN';
    return 'HEALTHY';
  }

  private isUnavailable(route: LlmEndpointConfig) {
    const key = this.circuitKey(route);
    const state = this.unavailable.get(key);
    if (!state) return false;
    const credentialHash = createHash('sha256').update(route.apiKey).digest('hex');
    if (state.until <= Date.now() || state.credentialHash &&
      state.credentialHash !== credentialHash) {
      this.unavailable.delete(key);
      return false;
    }
    return true;
  }

  private settingsFor(role: LlmTaskRole) {
    if (role === 'creativeGeneration' || role === 'hookGeneration') return { temperature: 0.75 };
    if (role === 'captionGeneration' || role === 'titleGeneration') return { temperature: 0.45 };
    if (role === 'critic' || role === 'groundingVerification') return { temperature: 0 };
    if (role === 'componentRepair') return { temperature: 0.45 };
    return { temperature: 0.1 };
  }

  private cacheKey(role: LlmTaskRole, request: StructuredGenerationRequest,
    aiMode: AiProcessingMode) {
    return createHash('sha256').update(JSON.stringify({ aiMode, role, schema: request.schema,
      partialBatchField: request.partialBatchField,
      fingerprint: request.cacheKey || '', system: request.systemPrompt, input: request.userPrompt,
      media: request.media?.map((item) => ({ mimeType: item.mimeType, url: item.url || '',
        digest: item.data ? createHash('sha256').update(item.data).digest('hex') : '' })) || [] }))
      .digest('hex');
  }

  private routeCacheKey(cacheKey: string, route: LlmEndpointConfig) {
    return cacheKey + ':' + route.provider + ':' + route.model;
  }

  private circuitKey(route: LlmEndpointConfig, role?: LlmTaskRole) {
    return route.provider + ':' + route.model +
      (role ? ':' + timeoutRole(role) : '');
  }
  private acquireCircuit(route: LlmEndpointConfig, role: LlmTaskRole): 'closed' | 'half-open' | null {
    if (this.isCircuitOpen(this.circuitKey(route))) return null;
    const key = this.circuitKey(route, role);
    const state = this.circuits.get(key);
    if (!state || !state.cooldownUntil) return 'closed';
    if (state.cooldownUntil > Date.now() || state.halfOpenProbe) return null;
    state.halfOpenProbe = true;
    this.circuits.set(key, state);
    return 'half-open';
  }
  private isCircuitOpen(key: string) {
    const state = this.circuits.get(key);
    return !!state && state.cooldownUntil > Date.now();
  }
  private recordSuccess(route: LlmEndpointConfig, role: LlmTaskRole,
    permit: 'closed' | 'half-open') {
    const key = this.circuitKey(route, role);
    const state = this.circuits.get(key);
    if (!state || !state.cooldownUntil || permit === 'half-open' && state.halfOpenProbe)
      this.circuits.delete(key);
    // A request admitted before another request opened the circuit cannot close that circuit.
  }
  private recordFailure(route: LlmEndpointConfig, role: LlmTaskRole, error: LlmProviderError) {
    // Rate limits and exhausted quota describe provider availability. Prompt timeouts and
    // transient 5xx responses stay isolated to the role that sent the request.
    const key = this.circuitKey(route, error.kind === 'RATE_LIMIT_FAILURE' ? undefined : role);
    if (error.kind === 'AUTH_FAILURE' || error.kind === 'MODEL_NOT_FOUND' ||
      error.kind === 'QUOTA_EXHAUSTED_FAILURE' || error.kind === 'QUOTA_FAILURE') {
      markProviderModelUnavailable(this.circuitKey(route));
      const cooldown = error.kind === 'AUTH_FAILURE' || error.kind === 'MODEL_NOT_FOUND'
        ? 365 * 24 * 60 * 60 * 1000 : numberSetting('LLM_QUOTA_COOLDOWN_MS', 3600000, 1000, 86400000);
      this.unavailable.set(this.circuitKey(route), { until: Date.now() + cooldown,
        credentialHash: createHash('sha256').update(route.apiKey).digest('hex'), kind: error.kind });
      return;
    }
    if (!['TIMEOUT_FAILURE', 'NETWORK_FAILURE', 'RATE_LIMIT_FAILURE',
      'PROVIDER_5XX_FAILURE', 'PROVIDER_SATURATION_FAILURE'].includes(error.kind)) {
      // A non-health failure proves the provider answered; it must not strand a half-open probe.
      if (this.circuits.get(key)?.halfOpenProbe) this.circuits.delete(key);
      return;
    }
    const now = Date.now();
    const prior = this.circuits.get(key) || { failureTimes: [], cooldownUntil: 0,
      halfOpenProbe: false };
    const threshold = numberSetting('LLM_CIRCUIT_FAILURE_THRESHOLD', 3, 1, 20);
    const windowMs = numberSetting('LLM_CIRCUIT_WINDOW_MS', 60000, 1000);
    const failureTimes = [...prior.failureTimes.filter(time => now - time <= windowMs),
      ...Array.from({ length: Math.max(1, error.attempts) }, () => now)];
    const rateLimited = error.kind === 'RATE_LIMIT_FAILURE';
    const reopen = rateLimited || error.kind === 'PROVIDER_SATURATION_FAILURE' ||
      prior.halfOpenProbe || failureTimes.length >= threshold;
    const normalCooldown = numberSetting('LLM_CIRCUIT_COOLDOWN_MS', 45000, 1000);
    const rateLimitCooldown = numberSetting('GOOGLE_RATE_LIMIT_COOLDOWN_MS', 60000, 1000);
    this.circuits.set(key, { failureTimes, halfOpenProbe: false, cooldownUntil: reopen
      ? now + Math.max(rateLimited ? rateLimitCooldown : normalCooldown,
        error.retryAfterMs ?? 0) : 0 });
  }
  private log(role: LlmTaskRole, route: LlmEndpointConfig, success: boolean,
    failover: boolean, attempts: LlmRouteAttempt[], failureCategory?: LlmFailureKind) {
    const roleState = this.circuits.get(this.circuitKey(route, role));
    const providerState = this.circuits.get(this.circuitKey(route));
    const circuitState = [roleState, providerState].some(state =>
      !!state && state.cooldownUntil > Date.now()) ? 'OPEN' : 'CLOSED';
    this.logger.log(JSON.stringify({ event: 'llm_route', role, provider: route.provider,
      model: route.model, success, failover, failureCategory: failureCategory || null,
      latencyMs: attempts[attempts.length - 1]?.latencyMs ?? 0,
      circuitState, sameProviderRetry: false, attempt: attempts.length }));
  }
}
