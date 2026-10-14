// Which style a generated clip was delivered with - decided in ONE place so that
// first-time styling, retry-style and re-opening a clip whose EditProject is gone
// all reproduce the same canonical result.
//
// What a clip can prove about itself (no schema field needed):
//   * its template identity   templateId / requestedTemplate / effectiveTemplate
//   * its originating request `variantKey` ends in `:REQUEST:<jobId>:<clipRequestedAt ISO>`, written once
//                             by the exporter when the row is created and never updated afterwards
// `generationJobId` only names the ProcessingJob row, which is reused by every request for a video, and
// timestamps such as `updatedAt` change for unrelated reasons, so neither proves a request.
// The job holds the settings of its CURRENT request only (generationSettings and clipRequestedAt are
// written in the same update), so a clip may borrow them only when its request key equals the job's.
//
// Resolution order:
//   STYLE_SNAPSHOT    the resolved style written on the clip when it was first styled (authoritative)
//   EXACT_REQUEST     the job's settings, because the clip's request key is exactly the job's current one
//   TEMPLATE_FALLBACK the clip's own template with default components - never another request's
//
// Nothing here looks at current UI defaults, and nothing here calls a model.

import { readGenerationSettings } from '../../videos/clip-selection.service';
import { fullTemplate } from './creative-style-library';
import { resolveCreativeStyle, type ResolvedCreativeStyle } from './creative-style-resolver';

export type ClipStyleSource = 'STYLE_SNAPSHOT' | 'EXACT_REQUEST' | 'TEMPLATE_FALLBACK';
export type ClipStyleRequest = { templateId: string; resolved: ResolvedCreativeStyle; source: ClipStyleSource };

type ClipIdentity = {
  variantKey?: string | null; generationJobId?: string | null; templateId?: string | null;
  requestedTemplate?: string | null; effectiveTemplate?: string | null; editTelemetry?: unknown;
};
type JobIdentity = { id: string; generationSettings?: unknown; clipRequestedAt?: Date | null };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const REQUEST_MARKER = ':REQUEST:';

/** The request a clip was rendered for (`<jobId>:<clipRequestedAt ISO>`), or null for rows that predate it. */
export const clipRequestKey = (clip: Pick<ClipIdentity, 'variantKey'>) => {
  const at = clip.variantKey?.indexOf(REQUEST_MARKER) ?? -1;
  return at >= 0 ? clip.variantKey!.slice(at + REQUEST_MARKER.length) || null : null;
};

/** The request the job's stored generation settings belong to. */
export const jobRequestKey = (job: Pick<JobIdentity, 'id' | 'clipRequestedAt'> | null) =>
  job?.clipRequestedAt ? `${job.id}:${job.clipRequestedAt.toISOString()}` : null;

/** true = proven the job's current request; false = proven a different request; null = cannot tell. */
export const clipBelongsToJobRequest = (clip: ClipIdentity, job: JobIdentity | null): boolean | null => {
  const own = clipRequestKey(clip), current = jobRequestKey(job);
  if (!own || !current) return null;
  return own === current;
};

/** The template the clip was delivered with, from the clip's own persisted identity. */
export const clipTemplateId = (clip: ClipIdentity) =>
  clip.effectiveTemplate ?? clip.requestedTemplate ?? clip.templateId ?? null;

/**
 * Written once per clip (and style hash) so the style can be rebuilt without the job. Holds only what a
 * deterministic rebuild needs: the resolved style, its template and hash, and which request produced it.
 */
export type ClipStyleSnapshot = { snapshotVersion: 1; templateId: string; styleHash: string;
  requestKey?: string | null; resolved: ResolvedCreativeStyle };

export const readClipStyleSnapshot = (editTelemetry: unknown): ClipStyleSnapshot | null => {
  const value = record(record(editTelemetry).generationStyle);
  const resolved = record(value.resolved);
  return value.snapshotVersion === 1 && typeof value.templateId === 'string' &&
    typeof value.styleHash === 'string' && resolved.styled === true && record(resolved.components)
    ? value as unknown as ClipStyleSnapshot : null;
};

/** `null` means the clip was never styled by generation: nothing to reconstruct. */
export function resolveClipStyleRequest(clip: ClipIdentity, job: JobIdentity | null): ClipStyleRequest | null {
  const jobSettings = readGenerationSettings(job?.generationSettings);
  const jobTemplate = jobSettings
    ? jobSettings.effectiveTemplate ?? jobSettings.requestedTemplate ?? jobSettings.templateId ?? null : null;
  // The key embeds the job id, so equal keys also prove it is this job's row.
  const exact = clipBelongsToJobRequest(clip, job) === true;
  const template = clipTemplateId(clip) ?? (exact ? jobTemplate : null);

  const snapshot = readClipStyleSnapshot(clip.editTelemetry);
  if (snapshot && (!template || snapshot.templateId === template)) {
    return { templateId: snapshot.templateId, resolved: snapshot.resolved, source: 'STYLE_SNAPSHOT' };
  }
  // Same request is proven by the clip's own request key, and only counts while the job's template
  // agrees with the clip's (a contradiction means the pairing cannot be trusted).
  if (exact && jobSettings && template && jobTemplate === template && jobSettings.resolved.styled) {
    return { templateId: template, resolved: jobSettings.resolved, source: 'EXACT_REQUEST' };
  }
  if (template && fullTemplate(template)) {
    return { templateId: template, resolved: resolveCreativeStyle({ templateId: template }),
      source: 'TEMPLATE_FALLBACK' };
  }
  return null;
}
