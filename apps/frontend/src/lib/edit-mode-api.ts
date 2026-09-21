import type { ChatApplyResult, ChatMessage, ChatPlanResult, ChatThreadResult, EditAsset,
  EditAssetRole, EditExport, EditExportProgress, EditHistory, EditPresetApplyResult,
  EditPresetId, EditPresetProposal, EditPresetSummary, EditProject,
  SourceVideoOption } from './edit-mode-types';

export class EditModeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string,
    readonly currentRevision?: number) {
    super(message);
    this.name = 'EditModeApiError';
  }
}

export function getEditModeApiBaseUrl() {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  }
  return process.env.SERVER_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getEditModeApiBaseUrl()}${path}`, { ...init, cache: 'no-store' });
  if (!response.ok) {
    let message = `EditMode request failed (${response.status})`;
    let code: string | undefined;
    let currentRevision: number | undefined;
    try {
      const body = await response.json() as { message?: string | string[]; code?: string;
        currentRevision?: number };
      if (Array.isArray(body.message)) message = body.message.join(', ');
      else if (body.message) message = body.message;
      code = body.code;
      currentRevision = body.currentRevision;
    } catch {}
    throw new EditModeApiError(message, response.status, code, currentRevision);
  }
  return response.json() as Promise<T>;
}

export const listEditProjects = () => request<EditProject[]>('/edit-mode/projects');

export const getEditProject = (id: string) =>
  request<EditProject>(`/edit-mode/projects/${encodeURIComponent(id)}`);

export const createEditProject = (name: string) => request<EditProject>('/edit-mode/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name })
});

export const updateEditProject = (id: string, revision: number,
  changes: { name?: string; settings?: Record<string, unknown> }) =>
  request<EditProject>(`/edit-mode/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, ...changes })
  });

export const uploadEditSource = (id: string, revision: number, file: File) => {
  const form = new FormData();
  form.set('revision', String(revision));
  form.set('file', file);
  return request<EditProject>(`/edit-mode/projects/${encodeURIComponent(id)}/source/upload`, {
    method: 'POST', body: form
  });
};

export const importEditSource = (id: string, revision: number, sourceVideoId: string) =>
  request<EditProject>(`/edit-mode/projects/${encodeURIComponent(id)}/source/from-video`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, sourceVideoId })
  });

export const analyzeEditSource = (id: string, revision: number) =>
  request<EditProject>(`/edit-mode/projects/${encodeURIComponent(id)}/analyze`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision })
  });

export const getEditHistory = (id: string) =>
  request<EditHistory[]>(`/edit-mode/projects/${encodeURIComponent(id)}/history`);

export const listSourceVideos = () => request<SourceVideoOption[]>('/videos');

/**
 * The base URL a BROWSER must use. `getEditModeApiBaseUrl` falls back to
 * SERVER_API_URL during SSR, which inside Docker is `http://backend:4000` - a
 * hostname the browser cannot resolve. Any URL that ends up in the DOM (a
 * <video> src, a download link) has to be the public one on both renders, or it
 * hydrates to an unreachable address and the media silently never loads.
 */
export function getEditModePublicApiBaseUrl() {
  return process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
}

export const editAssetPlaybackUrl = (assetId: string) =>
  `${getEditModePublicApiBaseUrl()}/edit-mode/assets/${encodeURIComponent(assetId)}/file`;

export type ManualEditCommand =
  | { action: 'trim'; elementId: string; trimStart: number; trimEnd: number }
  | { action: 'split'; elementId: string; playheadSec: number }
  | { action: 'delete'; elementId: string }
  | { action: 'move'; elementId: string; toPosition: number; track: 0 }
  | { action: 'add-image' | 'add-logo' | 'add-audio'; assetId: string }
  | { action: 'add-text' }
  | { action: 'move-element'; elementId: string; x: number; y: number }
  | { action: 'resize-element'; elementId: string; width: number; height: number }
  | { action: 'set-element-timing'; elementId: string; startTime: number; duration: number;
      trimStart?: number; trimEnd?: number }
  | { action: 'set-element-opacity'; elementId: string; opacity: number }
  | { action: 'set-element-z-index'; elementId: string; zIndex: number }
  | { action: 'update-text'; elementId: string; content: string; fontSize?: number;
      fontWeight?: number; fontFamily?: string; textAlign?: 'left' | 'center' | 'right'; color?: string;
      backgroundColor?: string }
  | { action: 'set-audio-volume'; elementId: string; volume: number }
  | { action: 'set-audio-muted'; elementId: string; muted: boolean }
  | { action: 'set-audio-fade'; elementId: string; fadeInSec: number; fadeOutSec: number }
  | { action: 'duplicate-element' | 'remove-element'; elementId: string };

export const runManualEditCommand = (id: string, revision: number, command: ManualEditCommand) => {
  const { action, ...payload } = command;
  return request<EditProject>(`/edit-mode/projects/${encodeURIComponent(id)}/commands/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, ...payload })
  });
};

export const undoEdit = (id: string, revision: number) => request<EditProject>(
  `/edit-mode/projects/${encodeURIComponent(id)}/undo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision })
  });

export const redoEdit = (id: string, revision: number) => request<EditProject>(
  `/edit-mode/projects/${encodeURIComponent(id)}/redo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision })
  });

export const uploadEditAsset = (id: string, revision: number, role: Extract<EditAssetRole,
  'IMAGE' | 'LOGO' | 'AUDIO'>, file: File) => {
  const form = new FormData();
  form.set('revision', String(revision)); form.set('role', role); form.set('file', file);
  return request<{ asset: EditAsset; revision: number }>(
    `/edit-mode/projects/${encodeURIComponent(id)}/assets/upload`, { method: 'POST', body: form });
};

export const deleteEditAsset = (id: string, revision: number, assetId: string) =>
  request<{ id: string; deleted: true; revision: number }>(
    `/edit-mode/projects/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision })
    });

// --- EditMode Phase 4: presets ---------------------------------------------

export const listEditPresets = () => request<EditPresetSummary[]>('/edit-mode/presets');

/** PREVIEW never mutates the project. */
export const previewEditPreset = (id: string, revision: number, presetId: EditPresetId) =>
  request<EditPresetProposal>(`/edit-mode/projects/${encodeURIComponent(id)}/preset/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, presetId })
  });

/** APPLY commits the plan as one PRESET history revision. */
export const applyEditPreset = (id: string, revision: number, presetId: EditPresetId) =>
  request<EditPresetApplyResult>(`/edit-mode/projects/${encodeURIComponent(id)}/preset/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision, presetId })
  });

// --- EditMode Phase 5: render and export -----------------------------------

/** Starts a render. Returns as soon as the export is accepted, not when it ends. */
export const startEditExport = (id: string, revision: number) =>
  request<{ export: EditExportProgress; project: EditProject }>(
    `/edit-mode/projects/${encodeURIComponent(id)}/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision })
    });

export const getEditExportProgress = (id: string) =>
  request<EditExportProgress | null>(
    `/edit-mode/projects/${encodeURIComponent(id)}/export/progress`);

export const listEditExports = (id: string) =>
  request<EditExport[]>(`/edit-mode/projects/${encodeURIComponent(id)}/exports`);

export const getEditExport = (id: string, assetId: string) =>
  request<EditExport>(`/edit-mode/projects/${encodeURIComponent(id)}/exports/${
    encodeURIComponent(assetId)}`);

/** The finished MP4, served with range support for preview and download. */
export const editExportFileUrl = (assetId: string) => editAssetPlaybackUrl(assetId);

// --- EditMode Phase 6: AI chat editor ---------------------------------------

/** The stored conversation, so the panel survives a reload. */
export const getEditChatThread = (id: string) =>
  request<ChatThreadResult>(`/edit-mode/projects/${encodeURIComponent(id)}/chat`);

/**
 * PLAN never changes the timeline.
 *
 * The selection, the selected range and the playhead travel with the message so
 * that "split here" and "make this smaller" mean what the user is looking at.
 */
export const planEditChat = (id: string, input: {
  message: string;
  revision: number;
  selectedElementId?: string | null;
  selectedTimeRange?: { startSec: number; endSec: number } | null;
  playheadSec?: number;
}) => request<ChatPlanResult>(`/edit-mode/projects/${encodeURIComponent(id)}/chat/plan`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
});

/** APPLY sends only the proposal id; the server holds the commands. */
export const applyEditChat = (id: string, proposalId: string, revision: number) =>
  request<ChatApplyResult>(`/edit-mode/projects/${encodeURIComponent(id)}/chat/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposalId, revision })
  });

export const cancelEditChat = (id: string, proposalId: string) =>
  request<{ cancelled: true; messages: ChatMessage[] }>(
    `/edit-mode/projects/${encodeURIComponent(id)}/chat/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalId })
    });
