import { getEditModeApiBaseUrl } from './edit-mode-api';
import type { EditProject } from './edit-mode-types';

/**
 * EditMode templates (Workstream F), frontend side.
 *
 * A template is a style POLICY applied into the same canonical EditProject the
 * manual editor writes to. Nothing here builds a timeline, and nothing here
 * writes an element: the panel asks the server for a bounded diff, shows it, and
 * then asks the server to apply it as one undoable revision.
 *
 * The types mirror apps/backend/src/modules/edit-mode/templates/edit-template-schema.ts.
 * They are deliberately a mirror rather than a shared package, exactly as the
 * text and colour catalogues are, and `GET /edit-mode/templates` returns the
 * server's own version and limits so the two cannot drift silently.
 */

export type TemplateSource = 'BUILTIN' | 'USER';
export type CaptionPlacement = 'PRESET' | 'LOWER' | 'CENTER' | 'UPPER';
export type LogoPlacement = 'KEEP' | 'TOP_LEFT' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_RIGHT';

export type EditTemplate = {
  version: number;
  id: string;
  name: string;
  description: string;
  source: TemplateSource;
  project: { aspectRatio: string; pacing: string };
  text: { defaultStyleId: string; hookStyleId: string; ctaStyleId: string };
  captions: { styleId: string; placement: CaptionPlacement; activeWord: boolean | null;
    uppercase: boolean | null };
  logo: { placement: LogoPlacement; scale: number };
  color: { filterId: string; strength: number };
  audio: { musicVolume: number; duckEnabled: boolean; duckStrength: string; fadeInSec: number;
    fadeOutSec: number };
  zoom: string;
  reframe: string;
  informationRegion: string;
  assets: { logoAssetId: string | null; musicAssetId: string | null };
};

export type TemplateLibrary = {
  version: number;
  scope: string;
  /** The honest note about template scope in a build with no user accounts. */
  scopeNote: string;
  limits: { maxUserTemplates: number; maxNameLength: number; maxDescriptionLength: number;
    maxPayloadBytes: number };
  builtin: EditTemplate[];
  user: EditTemplate[];
};

/** One line of the bounded diff. Never raw JSON — the server formats it. */
export type TemplateChange = { facet: string; label: string; from: string; to: string };
export type TemplatePreserved = { label: string; reason: string };

export type TemplateProposal = {
  templateId: string;
  templateName: string;
  source: TemplateSource;
  summary: string;
  changes: TemplateChange[];
  preserved: TemplatePreserved[];
  warnings: string[];
};

export type TemplatePreviewResult = TemplateProposal & { mode: 'PREVIEW' };
export type TemplateApplyResult = {
  mode: 'APPLY'; templateRunId: string; plan: TemplateProposal; project: EditProject;
};

export class EditTemplateApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'EditTemplateApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getEditModeApiBaseUrl()}${path}`, {
    credentials: 'include', ...init, cache: 'no-store',
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers
  });
  if (!response.ok) {
    let message = `Template request failed (${response.status})`;
    let code: string | undefined;
    try {
      const body = await response.json() as { message?: string | string[]; code?: string };
      if (Array.isArray(body.message)) message = body.message.join(', ');
      else if (body.message) message = body.message;
      code = body.code;
    } catch {}
    throw new EditTemplateApiError(message, response.status, code);
  }
  return response.json() as Promise<T>;
}

const encode = (value: string) => encodeURIComponent(value);

export const getTemplateLibrary = () => request<TemplateLibrary>('/edit-mode/templates');

export const previewTemplate = (editProjectId: string, revision: number, templateId: string) =>
  request<TemplatePreviewResult>(`/edit-mode/projects/${encode(editProjectId)}/template/preview`,
    { method: 'POST', body: JSON.stringify({ revision, templateId }) });

export const applyTemplate = (editProjectId: string, revision: number, templateId: string) =>
  request<TemplateApplyResult>(`/edit-mode/projects/${encode(editProjectId)}/template/apply`,
    { method: 'POST', body: JSON.stringify({ revision, templateId }) });

/** Saves the project's CURRENT style. Asset binding is opt-in, so by default the
 *  saved template is portable to any other project. */
export const saveTemplateFromProject = (input: {
  editProjectId: string; name: string; description?: string;
  includeLogo?: boolean; includeMusic?: boolean;
}) => request<EditTemplate>('/edit-mode/templates',
  { method: 'POST', body: JSON.stringify(input) });

export const renameTemplate = (templateId: string, input: { name?: string;
  description?: string }) =>
  request<EditTemplate>(`/edit-mode/templates/${encode(templateId)}`,
    { method: 'PATCH', body: JSON.stringify(input) });

export const duplicateTemplate = (templateId: string, name?: string) =>
  request<EditTemplate>(`/edit-mode/templates/${encode(templateId)}/duplicate`,
    { method: 'POST', body: JSON.stringify(name ? { name } : {}) });

export const deleteTemplate = (templateId: string) =>
  request<{ deleted: boolean; id: string }>(`/edit-mode/templates/${encode(templateId)}`,
    { method: 'DELETE' });

// --- Card hints --------------------------------------------------------------
//
// Short, plain labels for the template card. They describe the STYLE and never
// make a claim about the content of anyone's video.

const TITLE = (value: string) => value.replace(/_/gu, ' ').toLowerCase()
  .replace(/(^|\s)\S/gu, (match) => match.toUpperCase());

export const aspectHint = (template: EditTemplate) =>
  template.project.aspectRatio === 'SOURCE' ? 'Keeps source shape' : template.project.aspectRatio;

export const captionHint = (template: EditTemplate) => {
  const style = TITLE(template.captions.styleId);
  const where = template.captions.placement === 'PRESET' ? '' :
    ` · ${TITLE(template.captions.placement)}`;
  return `${style} captions${where}`;
};

export const colorHint = (template: EditTemplate) =>
  template.color.filterId === 'ORIGINAL' ? 'No colour change'
    : `${TITLE(template.color.filterId)}${template.color.strength < 1
      ? ` ${Math.round(template.color.strength * 100)}%` : ''}`;

export const motionHint = (template: EditTemplate) =>
  template.zoom === 'OFF' ? 'No zoom' : `${TITLE(template.zoom)} zoom`;

/**
 * A local, code-derived swatch for the card.
 *
 * Deliberately NOT a stock image or an external thumbnail: two colours computed
 * from the template's own filter, which is honest about what the template does
 * and costs nothing to ship.
 */
export const templateSwatch = (template: EditTemplate): [string, string] => {
  const swatches: Record<string, [string, string]> = {
    ORIGINAL: ['#334155', '#475569'], CLEAN: ['#1e293b', '#38bdf8'],
    WARM: ['#7c2d12', '#fbbf24'], COOL: ['#0c4a6e', '#67e8f9'],
    CINEMATIC: ['#0f172a', '#64748b'], VIBRANT: ['#581c87', '#f472b6'],
    SOFT: ['#3f3f46', '#e4e4e7'], HIGH_CONTRAST: ['#000000', '#f8fafc'],
    VINTAGE: ['#57534e', '#d6d3d1'], BLACK_AND_WHITE: ['#18181b', '#a1a1aa']
  };
  return swatches[template.color.filterId] ?? swatches.ORIGINAL;
};
