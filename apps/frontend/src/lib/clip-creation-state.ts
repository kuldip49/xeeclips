import type { ClipAnalysis, OutputStyle } from '@/lib/api';

/**
 * Selection rules for the post-analysis clip creation panel. Kept free of React so the exact
 * enablement logic can be asserted by scripts/test-clip-creation-ui.cjs.
 */

/** Chosen for the user when analysis finishes so the panel is never in an unusable state. */
export const DEFAULT_OUTPUT_STYLE: OutputStyle = 'NORMAL';

/**
 * Output style is the user's post-analysis choice. A previous request wins so a refresh keeps what
 * was asked for; otherwise the default applies. The analysis-time `processingType` never feeds in.
 */
export function restoreOutputStyle(previous: ClipAnalysis['clipRequest']): OutputStyle {
  return previous?.outputStyle ?? DEFAULT_OUTPUT_STYLE;
}

export function clampClipCount(count: number, maxClipCount: number) {
  if (maxClipCount < 1) return 0;
  return Math.min(maxClipCount, Math.max(1, Math.round(count)));
}

export function restoreClipCount(analysis: ClipAnalysis) {
  return clampClipCount(
    analysis.clipRequest?.requestedClipCount ?? analysis.defaultClipCount, analysis.maxClipCount);
}

/**
 * The only blockers are: analysis not ready, no style picked, a count outside 1..max, and a request
 * already in flight. Recommendation-style counts are deliberately not consulted — the user may ask
 * for any number of clips up to the duration-derived maximum.
 */
export function canCreateClips(state: {
  analysisReady: boolean;
  outputStyle: OutputStyle | null;
  requestedClipCount: number;
  maxClipCount: number;
  submitting: boolean;
  rendering: boolean;
}) {
  if (!state.analysisReady || !state.outputStyle) return false;
  if (state.submitting || state.rendering) return false;
  return state.requestedClipCount >= 1 && state.requestedClipCount <= state.maxClipCount;
}
