import { AiProcessingMode, normalizeAiProcessingMode } from './ai-processing-mode';

/**
 * The single place that says what a product tier may reach.
 *
 *   XEEFREE  local ASR/vision and deterministic reasoning only: no cloud LLM, no OpenAI, no Pro escalation.
 *   XEEPRO   unchanged behaviour: OpenAI routing, review and escalation as configured.
 *
 * The tier is derived from the job's AI mode (ONLINE is XeePro; FALLBACK_ONLY and the legacy OFFLINE value are XeeFree), so
 * a stored or untrusted value can never opt a job into cloud routing. A missing context is treated as XeeFree: fail closed.
 *
 * Enforcement does not rely on UI selection. The router (`LlmRouterService.generate`) and the provider
 * (`LlmProviderService.generateStructuredWithConfig`) both consult this policy before any network request is built.
 */
export type ExecutionMode = 'XEEFREE' | 'XEEPRO';
export type ExecutionPolicy = Readonly<{
  mode: ExecutionMode;
  cloudLLMAllowed: boolean;
  openAiAllowed: boolean;
  proEscalationAllowed: boolean;
}>;

export const XEEFREE_POLICY: ExecutionPolicy = Object.freeze({
  mode: 'XEEFREE', cloudLLMAllowed: false, openAiAllowed: false, proEscalationAllowed: false });
export const XEEPRO_POLICY: ExecutionPolicy = Object.freeze({
  mode: 'XEEPRO', cloudLLMAllowed: true, openAiAllowed: true, proEscalationAllowed: true });

export const XEEFREE_PROVIDER_VIOLATION = 'XEEFREE_PROVIDER_VIOLATION';

export function executionPolicyFor(aiMode: unknown): ExecutionPolicy {
  return normalizeAiProcessingMode(aiMode) === AiProcessingMode.ONLINE ? XEEPRO_POLICY : XEEFREE_POLICY;
}

export const isXeeFree = (aiMode: unknown) => executionPolicyFor(aiMode).mode === 'XEEFREE';

/**
 * The product tier of a persisted EditProject / generated clip, read from its recorded origin. Standalone editor projects
 * carry no origin mode and return null: the caller's own consent rules apply to them.
 */
export function projectExecutionPolicy(settings: unknown): ExecutionPolicy | null {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const origin = record(record(settings).origin);
  const telemetry = record(origin.editTelemetry);
  const mode = origin.aiMode ?? telemetry.effectiveAiMode ?? telemetry.requestedAiMode;
  if (typeof mode === 'string' && mode) return executionPolicyFor(mode);
  // Legacy generated projects have provenance but may predate the tier field.
  // Unknown generated provenance fails closed; a true standalone project keeps
  // its existing explicit consent behavior.
  return origin.originKind === 'GENERATED_CLIP' || typeof origin.generatedClipId === 'string' ? XEEFREE_POLICY : null;
}

/** Roles whose provider route is a Pro-only escalation (a second, stronger model on a rejected draft). */
export const isProEscalationTier = (tier: unknown) => tier === 'ESCALATION';

export type ProviderViolationDetail = { surface: 'router' | 'provider'; role: string; provider?: string; model?: string };

/**
 * Returns the violation detail when the current policy forbids a cloud call, else null. Pure: it reads the policy it is given.
 */
export function providerViolation(policy: ExecutionPolicy, call: ProviderViolationDetail & { escalation?: boolean }):
  ProviderViolationDetail | null {
  const provider = (call.provider ?? '').toLowerCase();
  const forbidden = !policy.cloudLLMAllowed || (provider.includes('openai') && !policy.openAiAllowed)
    || (!!call.escalation && !policy.proEscalationAllowed);
  return forbidden ? { surface: call.surface, role: call.role, provider: call.provider, model: call.model } : null;
}
