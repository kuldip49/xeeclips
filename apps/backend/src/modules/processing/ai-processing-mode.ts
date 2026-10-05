// Step 6 production model policy:
//   ONLINE         semantic AI through the OpenAI API (backend-only key), with the
//                  deterministic fallback whenever OpenAI is unavailable;
//   FALLBACK_ONLY  deterministic built-in rules/templates only.
// There is no local production LLM. OFFLINE remains in the enum ONLY because
// existing database rows may carry it; it is normalized to FALLBACK_ONLY on
// every read, so no code path can ever route a job to a local model.
export enum AiProcessingMode {
  ONLINE = 'ONLINE',
  /** @deprecated Legacy stored value only; always normalized to FALLBACK_ONLY. */
  OFFLINE = 'OFFLINE',
  FALLBACK_ONLY = 'FALLBACK_ONLY'
}

export const DEFAULT_AI_PROCESSING_MODE = AiProcessingMode.FALLBACK_ONLY;
/** The modes a user can choose. */
export const SELECTABLE_AI_PROCESSING_MODES = [AiProcessingMode.ONLINE,
  AiProcessingMode.FALLBACK_ONLY] as const;

/** Untrusted or legacy values must never opt a job into an LLM-enabled mode. */
export function normalizeAiProcessingMode(value: unknown): AiProcessingMode {
  if (typeof value !== 'string') return DEFAULT_AI_PROCESSING_MODE;
  const normalized = value.trim().toUpperCase();
  if (normalized === AiProcessingMode.OFFLINE) return AiProcessingMode.FALLBACK_ONLY;
  return Object.values(AiProcessingMode).includes(normalized as AiProcessingMode)
    ? normalized as AiProcessingMode
    : DEFAULT_AI_PROCESSING_MODE;
}
