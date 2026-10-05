import type { DuckStrengthId } from './edit-mode-audio';
import { getApiBaseUrl, getPublicApiBaseUrl, isProcessingServerUnavailableStatus } from './api';
import type { ColorFilterId } from './edit-mode-color';
import type { CaptionStylePresetId, TextStylePresetId } from './edit-mode-text';
import type { AgentAutonomy, AgentRun, AgentState, EditConstraintInput, EditTimeRange as AgentTimeRange,
  ChatApplyResult, ChatMessage, ChatPlanResult, ChatThreadResult, EditAsset,
  EditAssetRole, EditElementType, EditExport, EditExportProgress, EditHistory,
  EditPresetApplyResult, EditPresetId, EditPresetProposal, EditPresetSummary, EditProject,
  SourceVideoOption } from './edit-mode-types';

export class EditModeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string,
    readonly currentRevision?: number) {
    super(message);
    this.name = 'EditModeApiError';
  }
}

export type EditFailureCode = 'MEDIA_LOAD_FAILED' | 'PROJECT_LOAD_FAILED' |
  'PREVIEW_LAYOUT_FAILED' | 'AGENT_FAILED' | 'ANALYSIS_FAILED' | 'EDIT_COMMAND_FAILED';

/** User-visible editor failures keep their subsystem identity even when an
 * upstream proxy supplied only the unhelpful "Internal server error" text. */
export function editFailureMessage(code: EditFailureCode, caught: unknown) {
  const detail = caught instanceof Error && caught.message && caught.message !== 'Internal server error'
    ? caught.message : ({
      MEDIA_LOAD_FAILED: 'Preview media could not be loaded',
      PROJECT_LOAD_FAILED: 'The edit project could not be loaded',
      PREVIEW_LAYOUT_FAILED: 'The preview layout could not be updated',
      AGENT_FAILED: 'The AI editor could not complete that edit',
      ANALYSIS_FAILED: 'Source analysis could not be completed',
      EDIT_COMMAND_FAILED: 'The edit could not be saved'
    } satisfies Record<EditFailureCode, string>)[code];
  return `${code}: ${detail}`;
}

export function getEditModeApiBaseUrl() {
  return getApiBaseUrl();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getEditModeApiBaseUrl()}${path}`, {
    credentials: 'include', ...init, cache: 'no-store'
  })
    .catch((error: unknown) => {
      if (error instanceof TypeError) {
        throw new Error('Processing server is currently unavailable.', { cause: error });
      }
      throw error;
    });
  if (!response.ok) {
    if (isProcessingServerUnavailableStatus(response.status)) {
      throw new EditModeApiError('Processing server is currently unavailable.', response.status);
    }
    if (response.status === 413) {
      throw new EditModeApiError('This file exceeds the public upload size limit.', 413);
    }
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

export const getEditProject = (id: string, init?: RequestInit) =>
  request<EditProject>(`/edit-mode/projects/${encodeURIComponent(id)}`, init);

export const createEditProject = (name: string) => request<EditProject>('/edit-mode/projects', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name })
});

export type GeneratedClipMaterialization = {
  editProjectId: string;
  generatedClipId: string;
  revision: number;
  editUrl: string;
};

export const materializeGeneratedClipForEditing = (generatedClipId: string) =>
  request<GeneratedClipMaterialization>(
    `/edit-mode/projects/from-generated-clip/${encodeURIComponent(generatedClipId)}`,
    { method: 'POST' }
  );

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

export const getEditHistory = (id: string, init?: RequestInit) =>
  request<EditHistory[]>(`/edit-mode/projects/${encodeURIComponent(id)}/history`, init);

export const listSourceVideos = () => request<SourceVideoOption[]>('/videos');

/**
 * The base URL a BROWSER must use. `getEditModeApiBaseUrl` falls back to
 * SERVER_API_URL during SSR, which inside Docker is `http://backend:4000` - a
 * hostname the browser cannot resolve. Any URL that ends up in the DOM (a
 * <video> src, a download link) has to be the public one on both renders, or it
 * hydrates to an unreachable address and the media silently never loads.
 */
export function getEditModePublicApiBaseUrl() {
  return getPublicApiBaseUrl();
}

export const editAssetPlaybackUrl = (assetId: string) =>
  `${getEditModePublicApiBaseUrl()}/edit-mode/assets/${encodeURIComponent(assetId)}/file`;

export const editSourcePosterUrl = (sourceVideoId: string) =>
  `${getEditModePublicApiBaseUrl()}/videos/${encodeURIComponent(sourceVideoId)}/poster`;

export type EditCommandScope = 'SELECTED_ELEMENT' | 'SELECTED_ELEMENTS' | 'TRACK' |
  'CURRENT_VIDEO_SEGMENT' | 'ALL_VIDEO_SEGMENTS' | 'PROJECT';

type ManualEditCommandValue =
  | { action: 'adjust-source-range'; start?: number; end?: number;
      startDelta?: number; endDelta?: number }
  | { action: 'trim'; elementId: string; trimStart: number; trimEnd: number }
  | { action: 'split'; elementId: string; playheadSec: number }
  | { action: 'delete'; elementId: string }
  | { action: 'move'; elementId: string; toPosition: number; track: 0 }
  | { action: 'add-image' | 'add-logo' | 'add-audio'; assetId: string }
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
  // elementId is OPTIONAL: without one the command mutes every music clip, so
  // the timeline's track header costs one revision rather than one per clip.
  | { action: 'set-audio-muted'; elementId?: string; muted: boolean }
  | { action: 'set-audio-fade'; elementId: string; fadeInSec: number; fadeOutSec: number }
  | { action: 'duplicate-element' | 'remove-element'; elementId: string }
  // Workstream E: timeline track state. Either one elementId or one
  // elementType - the bulk form is what a track header uses, so hiding or
  // locking a 400-caption track is a single command and a single undo step.
  | { action: 'set-element-visible'; elementId?: string; elementType?: EditElementType;
      visible: boolean }
  | { action: 'set-element-locked'; elementId?: string; elementType?: EditElementType;
      locked: boolean }
  // Manual transform. Crop, rotation and flip accept VIDEO and IMAGE/LOGO;
  // scale, position and speed are VIDEO-only.
  | { action: 'set-video-crop'; elementId: string; cropLeft: number; cropRight: number;
      cropTop: number; cropBottom: number }
  | { action: 'set-video-rotation'; elementId: string; rotation: number }
  | { action: 'set-video-flip'; elementId: string; flipH: boolean; flipV: boolean }
  | { action: 'set-video-scale'; elementId: string; scale: number }
  | { action: 'set-video-position'; elementId: string; x: number; y: number }
  | { action: 'set-speed'; elementId: string; speed: number }
  // --- Workstream C: professional text ---------------------------------------
  // One typed command per property rather than a JSON patch, so every change is
  // independently validated, independently undoable and reusable by the AI editor.
  | { action: 'add-text'; textStyleId?: TextStylePresetId; content?: string }
  | { action: 'set-text-content'; elementId: string; content: string }
  | { action: 'set-text-font'; elementId: string; fontFamily: string }
  | { action: 'set-text-size'; elementId: string; fontSize: number }
  | { action: 'set-text-weight'; elementId: string; fontWeight: number }
  | { action: 'set-text-color'; elementId: string; color: string }
  | { action: 'set-text-alignment'; elementId: string; textAlign: 'left' | 'center' | 'right' }
  | { action: 'set-text-stroke'; elementId: string; strokeEnabled: boolean; strokeColor: string;
      strokeWidth: number }
  | { action: 'set-text-shadow'; elementId: string; shadowEnabled: boolean; shadowColor: string;
      shadowOpacity: number; shadowBlur: number; shadowOffsetX: number; shadowOffsetY: number }
  | { action: 'set-text-background'; elementId: string; backgroundEnabled: boolean;
      backgroundColor: string; backgroundOpacity: number; backgroundPadding: number;
      backgroundRadius: number }
  | { action: 'set-text-spacing'; elementId: string; letterSpacing: number; lineSpacing: number }
  // Letter case is STYLE, not content: the stored wording is untouched and the
  // renderer upper-cases at draw time, so turning it off restores it exactly.
  | { action: 'set-text-case'; elementId: string; uppercase: boolean }
  | { action: 'set-text-style-preset'; elementId: string; textStyleId: TextStylePresetId;
      applyBox?: boolean }
  // --- Workstream C: captions ------------------------------------------------
  | { action: 'generate-captions'; captionStyleId?: CaptionStylePresetId }
  | { action: 'remove-captions' }
  | { action: 'set-captions-visible'; visible: boolean }
  | { action: 'set-caption-text'; elementId: string; content: string }
  | { action: 'split-caption'; elementId: string; atSec: number }
  | { action: 'merge-caption'; elementId: string; direction: 'PREVIOUS' | 'NEXT' }
  | { action: 'set-caption-style'; elementId: string; captionStyleId: CaptionStylePresetId }
  | { action: 'set-caption-active-word'; elementId: string; activeWordEnabled: boolean;
      activeWordColor: string }
  | { action: 'apply-caption-style-to-all'; elementId: string }
  // --- Workstream D: colour ---------------------------------------------------
  // One typed command per control. There is deliberately no generic
  // "set these colour properties" patch: every value is separately validated,
  // separately undoable, and addressable by name from a later assistant turn.
  | { action: 'set-video-exposure'; elementId: string; exposure: number }
  | { action: 'set-video-brightness'; elementId: string; brightness: number }
  | { action: 'set-video-contrast'; elementId: string; contrast: number }
  | { action: 'set-video-highlights'; elementId: string; highlights: number }
  | { action: 'set-video-shadows'; elementId: string; shadows: number }
  | { action: 'set-video-saturation'; elementId: string; saturation: number }
  | { action: 'set-video-temperature'; elementId: string; temperature: number }
  | { action: 'set-video-tint'; elementId: string; tint: number }
  | { action: 'set-video-sharpness'; elementId: string; sharpness: number }
  | { action: 'set-video-fade'; elementId: string; fade: number }
  | { action: 'set-video-vignette'; elementId: string; vignette: number }
  | { action: 'reset-video-adjustments'; elementId: string }
  | { action: 'apply-color-filter'; elementId: string; filterId: ColorFilterId;
      strength?: number }
  | { action: 'paste-video-adjustments'; elementId: string; fromElementId: string }
  // --- Workstream D: audio -----------------------------------------------------
  // `elementId` is omitted on the two source-audio commands to cover every
  // segment at once, which is what "mute the original video" means.
  | { action: 'set-source-audio-volume'; elementId?: string; volume: number }
  | { action: 'set-source-audio-muted'; elementId?: string; muted: boolean }
  | { action: 'set-audio-trim'; elementId: string; trimStart: number; trimEnd: number }
  | { action: 'set-audio-ducking'; elementId: string; duckEnabled: boolean;
      duckStrength?: DuckStrengthId; attackMs?: number; releaseMs?: number }
  | { action: 'set-zoom-scale'; elementId?: string; scale: number }
  | { action: 'remove-zoom'; elementId?: string }
  // --- Step 5: canonical scope primitives --------------------------------------
  | { action: 'set-video-framing'; elementId?: string; mode: 'FIT' | 'FILL' | 'ASPECT' | 'FREE';
      aspectRatio?: '9:16' | '16:9' | '1:1'; cropLeft?: number; cropRight?: number;
      cropTop?: number; cropBottom?: number; fitMode?: 'FIT' | 'FILL' }
  | { action: 'set-reframe-policy'; policy: string; clearSegmentOverrides?: boolean }
  | { action: 'adjust-zoom-strength'; elementId?: string; direction: 'WEAKER' | 'STRONGER';
      step?: number }
  | { action: 'regenerate-captions'; captionStyleId?: string };

/** Structured verification metadata the backend returns with every direct command. */
export type EditCommandResult = {
  index: number; action: string;
  status: 'DONE' | 'BLOCKED_BY_CONSTRAINT' | 'UNSUPPORTED' | 'INVALID' | 'FAILED' | 'SKIPPED';
  scope: EditCommandScope; affectedElementIds: string[]; affectedCount: number;
  revision?: number; constraint?: string; code?: string; message?: string;
  changes?: Array<{ field: string; before: unknown; after: unknown }>;
  settingsChanged?: string[];
};

/** Scope travels with the command to the canonical backend; it is never UI-only state. */
export type ManualEditCommand = ManualEditCommandValue & { scope?: EditCommandScope };

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

// --- Step 7/8: the AI editor agent (edits through validated tools) ----------

export const getEditAgent = (id: string) =>
  request<AgentState>(`/edit-mode/projects/${encodeURIComponent(id)}/agent`);

export const runEditAgent = (id: string, input: { message: string; revision: number;
  selectedElementId?: string | null; selectedTimeRange?: AgentTimeRange | null;
  playheadSec?: number; autonomy?: AgentAutonomy; constraints?: EditConstraintInput[] }) =>
  request<AgentRun>(`/edit-mode/projects/${encodeURIComponent(id)}/agent/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input) });

export const setEditAgentAutonomy = (id: string, autonomy: AgentAutonomy) =>
  request<{ autonomy: AgentAutonomy }>(`/edit-mode/projects/${encodeURIComponent(id)}/agent/autonomy`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autonomy }) });

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

// --- Workstream H: AI review ------------------------------------------------

export const getLatestEditReview = (id: string) =>
  request<import('./edit-mode-types').EditReview | null>(
    `/edit-mode/projects/${encodeURIComponent(id)}/review`);

export const reviewEdit = (id: string, input: { message: string; revision: number;
  selectedElementId?: string | null; selectedTimeRange?: { startSec: number; endSec: number } | null;
  playheadSec?: number }) => request<import('./edit-mode-types').EditReview>(
    `/edit-mode/projects/${encodeURIComponent(id)}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    });

export const proposeReviewSuggestion = (id: string, input: { findingId: string; revision: number;
  selectedElementId?: string | null; selectedTimeRange?: { startSec: number; endSec: number } | null;
  playheadSec?: number }) => request<ChatPlanResult>(
    `/edit-mode/projects/${encodeURIComponent(id)}/review/propose`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    });

// --- Workstream I: supervised edit from brief -------------------------------

export const getEditBriefPlan = (id: string) =>
  request<import('./edit-mode-types').BriefPlan | null>(
    `/edit-mode/projects/${encodeURIComponent(id)}/brief`);

export const createEditBriefPlan = (id: string, input: { brief: string; revision: number;
  selectedElementId?: string | null; selectedTimeRange?: { startSec: number; endSec: number } | null;
  playheadSec?: number }) => request<import('./edit-mode-types').BriefPlan>(
    `/edit-mode/projects/${encodeURIComponent(id)}/brief`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    });

export const respondEditBriefPlan = (id: string, input: { message: string; revision: number;
  selectedElementId?: string | null; selectedTimeRange?: { startSec: number; endSec: number } | null;
  playheadSec?: number }) => request<import('./edit-mode-types').BriefRespondResult>(
    `/edit-mode/projects/${encodeURIComponent(id)}/brief/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    });

// --- EditMode Workstream C: text and caption style catalogues ---------------

/** The server's own catalogues. The editor mirrors them in `edit-mode-text.ts`
 * for instant preview; this is what a parity check reads. */
/** The server's colour catalogue and bounds. The editor mirrors them in
 * `edit-mode-color.ts`/`edit-mode-audio.ts`; this is what a parity check reads. */
export const listEditColor = () => request<{
  filters: Array<{ id: string; label: string; description: string;
    adjustments: Record<string, number> }>;
  bounds: Record<string, { min: number; max: number }>;
  neutral: Record<string, number>;
  duckStrengths: Record<string, number>;
  maxVolume: number;
}>('/edit-mode/color');

export const listEditTextStyles = () => request<{
  textStyles: Array<{ id: string; label: string; description: string;
    box: { x: number; y: number; width: number; height: number };
    style: Record<string, unknown> }>;
  captionStyles: Array<{ id: string; label: string; description: string;
    box: { x: number; y: number; width: number; height: number };
    style: Record<string, unknown> }>;
  fontFamilies: string[];
}>('/edit-mode/text-styles');
