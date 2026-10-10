/** Mandatory semantic verdicts for XeePro. A missing verdict is never a pass. */
export const HOOK_LANGUAGE_CHECKS = ['GRAMMAR_OK', 'MEANING_CLEAR', 'NATURAL_LANGUAGE', 'CONTEXT_COMPLETE',
  'NO_BROKEN_PHRASE', 'NO_WORD_SALAD', 'NO_DANGLING_PRONOUN', 'NO_STITCHED_TRANSCRIPT_FRAGMENT'] as const;
export type HookLanguage = Record<typeof HOOK_LANGUAGE_CHECKS[number], boolean>;
export const languageApproved = (value: unknown): value is HookLanguage => !!value && typeof value === 'object'
  && HOOK_LANGUAGE_CHECKS.every(key => (value as Record<string, unknown>)[key] === true);
export const languageComplete = (value: unknown): value is HookLanguage => !!value && typeof value === 'object'
  && HOOK_LANGUAGE_CHECKS.every(key => typeof (value as Record<string, unknown>)[key] === 'boolean');

/** Cheap rejection only. Arbitrary English semantics must still be checked by the reviewer. */
export function hookLanguageProblems(text: string): string[] {
  const value = text.replace(/[’‘]/gu, "'").trim();
  const problems: string[] = [];
  const joined = value.match(/^what(?:'s| is) behind\s+(\S+)\s+and\s+(\S+?)\??$/iu);
  if (joined && joined.slice(1).some(word => /^(?:tell|agree|clear|think|say|this|that)$/iu.test(word)))
    problems.push('NO_STITCHED_TRANSCRIPT_FRAGMENT');
  if (/^(?:why|how|what|when|where)\s+(?:does|did|do)\s+(?:think|say|tell|agree|explain|reason)\b/iu.test(value))
    problems.push('GRAMMAR_OK');
  if (/\b(?:and|or|because|although|with|from|of|the|a|an|to|is|does|did)\s*[?.!]*$/iu.test(value)
    || /^(?:why|how|what)\s+(?:does|did|do)\s+(?:(?:the|a|an|this|that|my|your)\s+)?\S+\??$/iu.test(value))
    problems.push('CONTEXT_COMPLETE');
  if (/^(?:he|she|they|him|her|his|their|it)\b/iu.test(value) || /\bthis and that\b/iu.test(value))
    problems.push('NO_DANGLING_PRONOUN');
  return [...new Set(problems)];
}

/** Reused immediately before XeePro hook installation/export; scores cannot override language failures. */
export function xeeProHookApproved(hook: { text: string; review?: { language?: unknown; approved?: boolean } } | undefined) {
  return !!hook && hookLanguageProblems(hook.text).length === 0 && hook.review?.approved === true
    && languageApproved(hook.review.language);
}

/** Persisted packages (including generated-clip lineage) declare which product owns the hook. */
export function xeeProPackage(settings: unknown): Record<string, unknown> | undefined {
  const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const s = rec(settings), origin = rec(s.origin);
  const packages = [rec(s.contentIntelligence), rec(rec(origin.contentPackaging).sharedPackage)];
  return packages.find(p => p.hookLanguageGate === 'XEEPRO_V1' ||
    (Array.isArray(p.hooks) && p.hooks.some(h => rec(h).source === 'OPENAI')))
    ?? (origin.aiMode === 'ONLINE' ? packages[0] : undefined);
}
