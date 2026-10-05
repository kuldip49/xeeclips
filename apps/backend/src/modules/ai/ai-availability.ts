// Step 6: honest, distinct user-facing states for semantic-AI failures.
//
// Production semantic AI is the OpenAI API (backend-only key). When it cannot be
// used, the product keeps working - upload, project load, automatic generation
// (deterministic fallback), the manual editor, render and export never depend on
// it - and the user is told plainly which of these happened. Messages never echo
// provider bodies, prompts or credentials.

import { LlmProviderError, type LlmFailureKind } from '../processing/llm-provider.service';

export const AI_AVAILABILITY_STATES = ['AVAILABLE', 'NOT_REQUESTED', 'NOT_CONFIGURED', 'DISABLED', 'AUTH_FAILED',
  'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'TIMEOUT', 'NETWORK', 'PROVIDER_ERROR', 'CIRCUIT_OPEN',
  'INVALID_RESPONSE', 'UNKNOWN'] as const;
export type AiAvailabilityState = typeof AI_AVAILABILITY_STATES[number];

export type AiAvailability = {
  state: AiAvailabilityState;
  /** True when trying again later may succeed without any configuration change. */
  retryable: boolean;
  /** One sentence for the UI. */
  message: string;
  failureKind: LlmFailureKind | null;
};

const STILL_WORKS = 'Manual editing and automatic generation are still available.';

const MESSAGES: Record<Exclude<AiAvailabilityState, 'AVAILABLE'>, string> = {
  // The caller chose built-in rules on purpose (e.g. the live style preview). Not an outage.
  NOT_REQUESTED: 'The AI editor was not needed for this step.',
  NOT_CONFIGURED: 'The AI editor is unavailable right now.',
  DISABLED: 'The AI editor is unavailable right now.',
  AUTH_FAILED: 'The AI editor is unavailable right now.',
  RATE_LIMITED: 'The AI editor is busy. Try again in a minute.',
  QUOTA_EXHAUSTED: 'The AI editor is unavailable right now.',
  TIMEOUT: 'The AI editor took too long to respond. Try again.',
  NETWORK: 'The AI editor could not connect. Try again.',
  PROVIDER_ERROR: 'The AI editor is temporarily unavailable. Try again.',
  CIRCUIT_OPEN: 'The AI editor is paused briefly. Try again soon.',
  INVALID_RESPONSE: 'The AI editor could not use that result, so nothing was changed.',
  UNKNOWN: 'The AI editor is temporarily unavailable.'
};

const STATE_FOR_KIND: Partial<Record<LlmFailureKind, Exclude<AiAvailabilityState, 'AVAILABLE'>>> = {
  AI_MODE_FALLBACK_ONLY: 'DISABLED',
  CONFIGURATION_FAILURE: 'NOT_CONFIGURED',
  AUTH_FAILURE: 'AUTH_FAILED',
  RATE_LIMIT_FAILURE: 'RATE_LIMITED',
  QUOTA_FAILURE: 'QUOTA_EXHAUSTED',
  QUOTA_EXHAUSTED_FAILURE: 'QUOTA_EXHAUSTED',
  TIMEOUT_FAILURE: 'TIMEOUT',
  NETWORK_FAILURE: 'NETWORK',
  PROVIDER_5XX_FAILURE: 'PROVIDER_ERROR',
  PROVIDER_SATURATION_FAILURE: 'PROVIDER_ERROR',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  MALFORMED_RESPONSE_FAILURE: 'INVALID_RESPONSE',
  SCHEMA_FAILURE: 'INVALID_RESPONSE',
  TRUNCATED_RESPONSE_FAILURE: 'INVALID_RESPONSE',
  CONTENT_VALIDATION_FAILURE: 'INVALID_RESPONSE',
  MODEL_NOT_FOUND: 'NOT_CONFIGURED'
};

const RETRYABLE = new Set<AiAvailabilityState>(['RATE_LIMITED', 'TIMEOUT', 'NETWORK',
  'PROVIDER_ERROR', 'CIRCUIT_OPEN', 'INVALID_RESPONSE', 'UNKNOWN']);

export function aiAvailable(): AiAvailability {
  return { state: 'AVAILABLE', retryable: false, message: 'AI editor available.', failureKind: null };
}

export function aiUnavailable(state: Exclude<AiAvailabilityState, 'AVAILABLE'>,
  failureKind: LlmFailureKind | null = null): AiAvailability {
  return { state, retryable: RETRYABLE.has(state), failureKind,
    message: state === 'NOT_REQUESTED' ? MESSAGES[state] : `${MESSAGES[state]} ${STILL_WORKS}` };
}

/** Maps any thrown provider error to one honest availability state. */
export function classifyAiFailure(error: unknown): AiAvailability {
  if (error instanceof LlmProviderError) {
    return aiUnavailable(STATE_FOR_KIND[error.kind] ?? 'UNKNOWN', error.kind);
  }
  return aiUnavailable('UNKNOWN');
}
