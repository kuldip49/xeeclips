export enum AiProcessingMode {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  FALLBACK_ONLY = 'FALLBACK_ONLY'
}

export const DEFAULT_AI_PROCESSING_MODE = AiProcessingMode.FALLBACK_ONLY;

/** Untrusted or legacy values must never opt a job into an LLM-enabled mode. */
export function normalizeAiProcessingMode(value: unknown): AiProcessingMode {
  if (typeof value !== 'string') return DEFAULT_AI_PROCESSING_MODE;
  const normalized = value.trim().toUpperCase();
  return Object.values(AiProcessingMode).includes(normalized as AiProcessingMode)
    ? normalized as AiProcessingMode
    : DEFAULT_AI_PROCESSING_MODE;
}
