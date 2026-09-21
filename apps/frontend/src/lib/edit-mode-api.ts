import type { EditHistory, EditProject, SourceVideoOption } from './edit-mode-types';

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

export const editAssetPlaybackUrl = (assetId: string) =>
  `${getEditModeApiBaseUrl()}/edit-mode/assets/${encodeURIComponent(assetId)}/file`;

export type ManualEditCommand =
  | { action: 'trim'; elementId: string; trimStart: number; trimEnd: number }
  | { action: 'split'; elementId: string; playheadSec: number }
  | { action: 'delete'; elementId: string }
  | { action: 'move'; elementId: string; toPosition: number; track: 0 };

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
