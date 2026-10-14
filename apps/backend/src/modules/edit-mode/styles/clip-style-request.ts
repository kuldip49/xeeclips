// Which style a generated clip was delivered with - decided in ONE place so that
// first-time styling, retry-style and re-opening a clip whose EditProject is gone
// all reproduce the same canonical result.
//
// A clip persists its own template identity (templateId / requestedTemplate /
// effectiveTemplate / generationJobId). The component choices behind it (brief,
// picked component styles, reference) live on the ProcessingJob, which is ONE row
// reused by every request for a video, so it only describes the clip when the clip
// belongs to the job's current request. Sources, strongest first:
//
//   CLIP_SNAPSHOT    the resolved style written on the clip when it was first styled
//   REQUEST_SETTINGS the job's settings, when the clip provably belongs to that request
//   TEMPLATE_DEFAULT the clip's own template with no extra components (older clips)
//
// Nothing here looks at current UI defaults, and nothing here calls a model.

import { readGenerationSettings } from '../../videos/clip-selection.service';
import { fullTemplate } from './creative-style-library';
import { resolveCreativeStyle, type ResolvedCreativeStyle } from './creative-style-resolver';

export type ClipStyleSource = 'CLIP_SNAPSHOT' | 'REQUEST_SETTINGS' | 'TEMPLATE_DEFAULT';
export type ClipStyleRequest = { templateId: string; resolved: ResolvedCreativeStyle; source: ClipStyleSource };

type ClipIdentity = {
  generationJobId?: string | null; templateId?: string | null;
  requestedTemplate?: string | null; effectiveTemplate?: string | null;
  editTelemetry?: unknown; updatedAt?: Date | null;
};
type JobIdentity = { id: string; generationSettings?: unknown; clipRequestedAt?: Date | null };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The template the clip was delivered with, from the clip's own persisted identity. */
export const clipTemplateId = (clip: ClipIdentity) =>
  clip.effectiveTemplate ?? clip.requestedTemplate ?? clip.templateId ?? null;

/** Written once per clip (and style hash) so the style can be rebuilt without the job. */
export type ClipStyleSnapshot = { snapshotVersion: 1; templateId: string; styleHash: string;
  resolved: ResolvedCreativeStyle };

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
  const ownJob = !!job && !!clip.generationJobId && clip.generationJobId === job.id;
  const template = clipTemplateId(clip) ?? (ownJob ? jobTemplate : null);

  const snapshot = readClipStyleSnapshot(clip.editTelemetry);
  if (snapshot && (!template || snapshot.templateId === template)) {
    return { templateId: snapshot.templateId, resolved: snapshot.resolved, source: 'CLIP_SNAPSHOT' };
  }
  // Same request = same job row, same template, and not rendered before the job's current request
  // began (a later regenerate rewrites the settings but not older clips).
  const requestedAt = job?.clipRequestedAt?.getTime();
  const sameRequest = !!jobSettings && ownJob && !!template && jobTemplate === template &&
    (requestedAt == null || !clip.updatedAt || clip.updatedAt.getTime() >= requestedAt);
  if (sameRequest && jobSettings.resolved.styled) {
    return { templateId: template, resolved: jobSettings.resolved, source: 'REQUEST_SETTINGS' };
  }
  if (template && fullTemplate(template)) {
    return { templateId: template, resolved: resolveCreativeStyle({ templateId: template }),
      source: 'TEMPLATE_DEFAULT' };
  }
  return null;
}
