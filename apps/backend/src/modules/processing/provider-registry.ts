import { Injectable } from '@nestjs/common';
import { LlmApiStyle, LlmEndpointConfig, LlmFailureKind, LlmProviderService, LlmTaskRole,
  StructuredGenerationRequest } from './llm-provider.service';

export type NormalizedFailureCategory = 'AUTH_FAILURE' | 'QUOTA_EXHAUSTED' |
  'RATE_LIMIT_FAILURE' | 'PROVIDER_5XX_FAILURE' | 'PROVIDER_UNAVAILABLE' |
  'TIMEOUT_FAILURE' | 'TRUNCATED_RESPONSE_FAILURE' | 'SCHEMA_FAILURE' |
  'MODEL_NOT_FOUND' | 'CONNECTION_FAILURE' | 'UNKNOWN_PROVIDER_FAILURE';
export function normalizeFailureCategory(kind: LlmFailureKind): NormalizedFailureCategory {
  if (kind === 'AUTH_FAILURE') return 'AUTH_FAILURE';
  if (kind === 'QUOTA_FAILURE' || kind === 'QUOTA_EXHAUSTED_FAILURE') return 'QUOTA_EXHAUSTED';
  if (kind === 'RATE_LIMIT_FAILURE') return 'RATE_LIMIT_FAILURE';
  if (kind === 'PROVIDER_5XX_FAILURE') return 'PROVIDER_5XX_FAILURE';
  if (kind === 'PROVIDER_SATURATION_FAILURE' || kind === 'CIRCUIT_OPEN') return 'PROVIDER_UNAVAILABLE';
  if (kind === 'TIMEOUT_FAILURE') return 'TIMEOUT_FAILURE';
  if (kind === 'TRUNCATED_RESPONSE_FAILURE') return 'TRUNCATED_RESPONSE_FAILURE';
  if (kind === 'SCHEMA_FAILURE' || kind === 'MALFORMED_RESPONSE_FAILURE') return 'SCHEMA_FAILURE';
  if (kind === 'MODEL_NOT_FOUND') return 'MODEL_NOT_FOUND';
  if (kind === 'NETWORK_FAILURE') return 'CONNECTION_FAILURE';
  return 'UNKNOWN_PROVIDER_FAILURE';
}

export type ProviderState = 'HEALTHY' | 'DEGRADED' | 'COOLDOWN' | 'UNAVAILABLE' |
  'DISABLED' | 'UNCONFIGURED';
export type RoutingMode = 'PRIORITY' | 'LATENCY_AWARE' | 'COST_AWARE' |
  'QUALITY_AWARE' | 'BALANCED';
export type ProviderConfigView = { id: string; displayName: string; enabled: boolean;
  configured: boolean; priority: number; model: string; modelsByRole: Partial<Record<LlmTaskRole, string>>;
  capabilities: LlmTaskRole[]; concurrency: number; state: ProviderState };
export type ProviderUpdate = { enabled?: boolean; priority?: number; model?: string;
  modelsByRole?: Partial<Record<LlmTaskRole, string>>; capabilities?: LlmTaskRole[];
  concurrency?: number };

export interface LlmProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<LlmTaskRole>;
  isConfigured(role?: LlmTaskRole): boolean;
  supportsRole(role: LlmTaskRole): boolean;
  routeFor(role: LlmTaskRole): LlmEndpointConfig;
  generateStructured<T>(config: LlmEndpointConfig, request: StructuredGenerationRequest,
    service: LlmProviderService): Promise<T>;
}

// ONLINE is intentionally single-provider. The other adapters remain registered so
// they can still be inspected and used by future explicitly-scoped integrations, but
// they cannot enter the active ONLINE route pool.
export const ONLINE_PROVIDER_ALLOWLIST = new Set(['openai']);

const allRoles: LlmTaskRole[] = ['wholeVideoUnderstanding', 'multimodalUnderstanding',
  'clipUnderstanding', 'deepReasoning', 'candidateJudge', 'creativeGeneration',
  'hookGeneration', 'captionGeneration', 'titleGeneration', 'hashtagGeneration',
  'synopsisGeneration', 'critic', 'groundingVerification', 'componentRepair', 'editingPlan'];
const textRoles = allRoles.filter(role => role !== 'multimodalUnderstanding');
const flag = (name: string, fallback: boolean) => {
  const value = process.env[name]?.trim().toLowerCase();
  return value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value);
};
const bounded = (name: string, fallback: number, minimum = 1, maximum = 600000) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : fallback;
};
const prefixFor = (role: LlmTaskRole) => role.replace(/([a-z])([A-Z])/gu, '$1_$2').toUpperCase();
const policyRole = (role: LlmTaskRole): LlmTaskRole => {
  if (role === 'candidateJudge') return 'clipUnderstanding';
  if (role === 'deepReasoning') return 'wholeVideoUnderstanding';
  if (role === 'groundingVerification') return 'critic';
  if (['hookGeneration', 'captionGeneration', 'titleGeneration',
    'hashtagGeneration', 'synopsisGeneration'].includes(role)) return 'creativeGeneration';
  return role;
};

type Definition = { id: string; displayName: string; apiStyle: LlmApiStyle;
  baseUrl: string; defaultModel: string; capabilities: LlmTaskRole[];
  legacyModel?: (role: LlmTaskRole) => string; legacyConcurrency?: (role: LlmTaskRole) => number };

class EnvironmentProviderAdapter implements LlmProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ReadonlySet<LlmTaskRole>;
  constructor(private readonly definition: Definition,
    private readonly override: () => ProviderUpdate | undefined) {
    this.id = definition.id;
    this.displayName = definition.displayName;
    this.capabilities = new Set(definition.capabilities);
  }
  private get setting() { return this.id.toUpperCase().replace(/[^A-Z0-9]/gu, '_'); }
  private get update() { return this.override() ?? {}; }
  get enabled() {
    const defaultEnabled = this.id === 'openai';
    return this.update.enabled ?? flag(this.setting + '_ENABLED', defaultEnabled);
  }
  get priority() { return this.update.priority ?? bounded(this.setting + '_PRIORITY',
    this.id === 'google' ? 1 : this.id === 'nvidia' ? 2 : 100, 1, 10000); }
  get configured() { return !!((process.env[this.setting + '_API_KEY'] || '').trim()); }
  isConfigured(role?: LlmTaskRole) { return this.configured && (!role || !!this.modelFor(role)); }
  supportsRole(role: LlmTaskRole) {
    return this.capabilities.has(role) &&
      (!this.update.capabilities || this.update.capabilities.includes(role));
  }
  modelFor(role: LlmTaskRole) {
    const selectedRole = policyRole(role);
    if (this.id === 'nvidia' && role === 'multimodalUnderstanding' &&
      !this.update.modelsByRole?.[role] &&
      !process.env[this.setting + '_' + prefixFor(role) + '_MODEL'] &&
      !process.env.NVIDIA_MULTIMODAL_MODEL) return '';
    return (this.update.modelsByRole?.[role] || this.update.modelsByRole?.[selectedRole] ||
      process.env[this.setting + '_' + prefixFor(role) + '_MODEL'] ||
      process.env[this.setting + '_' + prefixFor(selectedRole) + '_MODEL'] ||
      this.update.model || this.definition.legacyModel?.(role) ||
      process.env[this.setting + '_MODEL'] || this.definition.defaultModel).trim();
  }
  routeFor(role: LlmTaskRole): LlmEndpointConfig {
    const multimodal = role === 'multimodalUnderstanding';
    const legacyConcurrency = this.definition.legacyConcurrency?.(role);
    return { provider: this.id, apiKey: (process.env[this.setting + '_API_KEY'] || '').trim(),
      baseUrl: (process.env[this.setting + '_BASE_URL'] || this.definition.baseUrl).replace(/\/+$/u, ''),
      // ONLINE is OpenAI only. The model is environment-driven (OPENAI_MODEL or
      // OPENAI_<ROLE>_MODEL) with the documented default when unset.
      model: this.modelFor(role), apiStyle: this.definition.apiStyle,
      timeoutMs: bounded(this.setting + '_TIMEOUT_MS', bounded('LLM_TIMEOUT_MS', 90000, 1000), 1000),
      maxRetries: 0, retryBaseDelayMs: bounded('LLM_RETRY_BASE_DELAY_MS', 1000),
      concurrency: this.update.concurrency ?? bounded(this.setting + '_CONCURRENCY',
        legacyConcurrency ?? (multimodal ? 1 : 2), 1, 16) };
  }
  async generateStructured<T>(config: LlmEndpointConfig, request: StructuredGenerationRequest,
    service: LlmProviderService) {
    return service.generateStructuredWithConfig<T>(config, request);
  }
  view(): ProviderConfigView {
    const modelsByRole = Object.fromEntries([...this.capabilities].map(role =>
      [role, this.modelFor(role)])) as Partial<Record<LlmTaskRole, string>>;
    const model = this.modelFor('creativeGeneration');
    return { id: this.id, displayName: this.displayName, enabled: this.enabled,
      configured: this.configured, priority: this.priority, model, modelsByRole,
      capabilities: [...this.capabilities].filter(role => this.supportsRole(role)),
      concurrency: this.routeFor('creativeGeneration').concurrency,
      state: !this.enabled ? 'DISABLED' : !this.configured ? 'UNCONFIGURED' : 'HEALTHY' };
  }
}

const definitions: Definition[] = [
  { id: 'google', displayName: 'Google Gemini', apiStyle: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: '',
    capabilities: allRoles, legacyModel: () => process.env.GOOGLE_CREATIVE_MODEL || '',
    legacyConcurrency: () => 1 },
  { id: 'nvidia', displayName: 'NVIDIA', apiStyle: 'chat_completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    capabilities: allRoles,
    legacyModel: role => role === 'multimodalUnderstanding'
      ? process.env.NVIDIA_MULTIMODAL_MODEL || ''
      : process.env.NVIDIA_REASONING_MODEL || process.env.NVIDIA_MODEL || '',
    legacyConcurrency: role => role === 'multimodalUnderstanding'
      ? bounded('NVIDIA_OMNI_CONCURRENCY', 1, 1, 16)
      : bounded('NVIDIA_SUPER_CONCURRENCY', 2, 1, 16) },
  { id: 'openai', displayName: 'OpenAI', apiStyle: 'responses',
    baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6-luna', capabilities: allRoles },
  { id: 'anthropic', displayName: 'Anthropic', apiStyle: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', defaultModel: '', capabilities: textRoles },
  { id: 'groq', displayName: 'Groq', apiStyle: 'chat_completions',
    baseUrl: 'https://api.groq.com/openai/v1', defaultModel: '', capabilities: textRoles },
  { id: 'openrouter', displayName: 'OpenRouter', apiStyle: 'chat_completions',
    baseUrl: 'https://openrouter.ai/api/v1', defaultModel: '', capabilities: textRoles }
];

@Injectable()
export class ProviderRegistry {
  private readonly providers = new Map<string, LlmProviderAdapter>();
  private readonly overrides = new Map<string, ProviderUpdate>();
  private manualOrder?: string[];
  constructor() {
    for (const definition of definitions) this.register(new EnvironmentProviderAdapter(definition,
      () => this.overrides.get(definition.id)));
  }
  register(provider: LlmProviderAdapter) {
    // Step 6 production policy: no local LLM provider can ever be registered.
    if (['ollama', 'local', 'qwen', 'lmstudio'].includes(provider.id.toLowerCase()))
      throw new Error('Local LLM providers are not supported in production');
    this.providers.set(provider.id, provider);
  }
  get(id: string) { return this.providers.get(id.toLowerCase()); }
  has(id: string) { return this.providers.has(id.toLowerCase()); }
  list() { return [...this.providers.values()]; }
  listConfigured() { return this.list().filter(provider => provider.isConfigured()); }
  listEnabled() { return this.list().filter(provider => this.isEnabled(provider.id)); }
  isEnabled(id: string) {
    const provider = this.get(id);
    return provider instanceof EnvironmentProviderAdapter ? provider.enabled :
      (this.overrides.get(id)?.enabled ?? true);
  }
  view() { return this.list().map(provider => provider instanceof EnvironmentProviderAdapter
    ? provider.view() : { id: provider.id, displayName: provider.displayName,
      enabled: this.isEnabled(provider.id), configured: provider.isConfigured(),
      priority: this.priority(provider.id), model: provider.routeFor('creativeGeneration').model,
      modelsByRole: {}, capabilities: [...provider.capabilities],
      concurrency: provider.routeFor('creativeGeneration').concurrency,
      state: this.isEnabled(provider.id) ? provider.isConfigured() ? 'HEALTHY' : 'UNCONFIGURED'
        : 'DISABLED' } as ProviderConfigView).sort((a, b) => a.priority - b.priority);
  }
  priority(id: string) {
    const provider = this.get(id);
    return provider instanceof EnvironmentProviderAdapter ? provider.priority :
      this.overrides.get(id)?.priority ?? 100;
  }
  update(id: string, patch: ProviderUpdate) {
    if (!this.has(id)) return false;
    this.overrides.set(id, { ...this.overrides.get(id), ...patch,
      modelsByRole: { ...this.overrides.get(id)?.modelsByRole, ...patch.modelsByRole } });
    if (patch.priority !== undefined) this.manualOrder = this.list()
      .sort((a, b) => this.priority(a.id) - this.priority(b.id))
      .map(provider => provider.id);
    return true;
  }
  reorder(ids: string[]) {
    if (new Set(ids).size !== ids.length || ids.some(id => !this.has(id))) return false;
    ids.forEach((id, index) => this.update(id, { priority: index + 1 }));
    this.manualOrder = [...ids, ...this.list().map(provider => provider.id)
      .filter(id => !ids.includes(id))];
    return true;
  }
  chain(role: LlmTaskRole) {
    // Do not allow role-specific or environment ordering to re-enable cross-provider
    // failover in ONLINE mode. A Luna failure is handled by the existing deterministic
    // fallback path in the caller.
    if (ONLINE_PROVIDER_ALLOWLIST.has('openai')) {
      const openai = this.get('openai');
      return openai && this.isEnabled('openai') && openai.supportsRole(role) ? [openai] : [];
    }
    const key = 'LLM_' + prefixFor(policyRole(role)) + '_PROVIDERS';
    const roleOrder = process.env[key];
    const globalOrder = process.env.ONLINE_PROVIDER_ORDER;
    const explicit = (roleOrder ? roleOrder.split(',') : this.manualOrder ??
      globalOrder?.split(','))?.map(id => id.trim().toLowerCase())
      .filter(Boolean);
    const ordered = explicit ?? this.list().sort((a, b) => this.priority(a.id) - this.priority(b.id))
      .map(provider => provider.id);
    return [...new Set(ordered)].map(id => this.get(id)).filter((provider): provider is LlmProviderAdapter =>
      !!provider && this.isEnabled(provider.id) && provider.supportsRole(role));
  }
}
