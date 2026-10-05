import { readSpeed } from '../edit-mode-transform';
import { EditExportError, type PlanElement } from './edit-mode-render-plan';

const MIN_VIDEO_SEC = .05;
/** Largest overrun corrected silently: container-vs-stream length and post-roll rounding
 * (observed 0.1-0.3 s). Anything larger is a broken timeline, not a probe mismatch, and
 * fails as INVALID_TIMELINE rather than exporting a truncated clip. */
const MAX_SAFE_OVERRUN_SEC = 1;
const round = (value: number) => Number(value.toFixed(6));

/** Reconcile persisted/pre-roll trims with the downloaded file's actual probe. */
export function normalizeProbedSourceTrims(elements: PlanElement[], sourceAssetId: string,
  probedDuration: number) {
  if (!Number.isFinite(probedDuration) || probedDuration <= 0)
    throw new EditExportError('UNSUPPORTED_MEDIA', 'The source duration could not be probed.');
  const corrections: Array<{ elementId: string; previousEnd: number; correctedEnd: number }> = [];
  const normalized = elements.map((element) => {
    if (element.type !== 'VIDEO' || element.track !== 0 || element.assetId !== sourceAssetId)
      return element;
    const start = element.trimStart;
    const rawEnd = element.trimEnd ?? start + element.duration * readSpeed(element.properties);
    if (!Number.isFinite(start) || !Number.isFinite(rawEnd) || start < 0 ||
      start >= probedDuration || rawEnd <= start || rawEnd - probedDuration > MAX_SAFE_OVERRUN_SEC)
      throw new EditExportError('INVALID_TIMELINE', 'The source trim cannot fit the probed video.',
        { elementId: element.id, start, rawEnd, probedDuration });
    // Never round a fractional probe duration upward past the actual file.
    const end = Math.min(rawEnd, Math.floor(probedDuration * 1e6) / 1e6);
    if (end - start < MIN_VIDEO_SEC)
      throw new EditExportError('INVALID_TIMELINE', 'The source trim is empty after clamping.',
        { elementId: element.id, start, end, probedDuration });
    if (rawEnd > end + 1e-6) corrections.push({ elementId: element.id,
      previousEnd: rawEnd, correctedEnd: end });
    return { ...element, trimEnd: round(end),
      duration: round((end - start) / readSpeed(element.properties)) };
  });
  return { elements: normalized, corrections };
}
