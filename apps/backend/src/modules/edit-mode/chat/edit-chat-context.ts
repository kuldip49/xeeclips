// The bounded, structured view of a project that a chat turn reasons over.
//
// The whole project is never sent to a model. What goes out is a compact
// catalogue of addressable things - elements, assets, the selection, the
// playhead, and only the transcript windows the request actually implicates -
// each one behind a short logical handle like "el3" or "asset1". The model
// picks handles; the backend maps handles to real ids. That is what makes
// "do not expect the LLM to invent UUIDs" structurally true rather than a
// request in a prompt.

import type { EditElementType } from '@prisma/client';
import type { EditProjectStyle } from '../presets/edit-preset-policy';
import type { PresetEvidence } from '../presets/edit-preset-evidence';
import { searchTranscript, type TranscriptSpan } from './edit-chat-transcript';
import type { ChatTargetRole } from './edit-chat-commands';
import type { ChatThread } from './edit-chat.types';

/** How many of each kind survive into the context. Overlays matter most. */
const MAX_VIDEO_ELEMENTS = 12;
const MAX_OVERLAY_ELEMENTS = 24;
const MAX_ASSETS = 24;
const MAX_TRANSCRIPT_WINDOWS = 4;
const MAX_RECENT_MESSAGES = 6;
const TRANSCRIPT_EXCERPT_CHARS = 1200;

export type ChatElementView = {
  handle: string;
  id: string;
  type: EditElementType;
  role: ChatTargetRole;
  label: string;
  track: number;
  position: number;
  startSec: number;
  endSec: number;
  /** Source-relative range, for VIDEO and AUDIO elements that carry a trim. */
  trimStartSec: number;
  trimEndSec: number | null;
  selected: boolean;
  /** Only the properties a chat command can act on. */
  properties: Record<string, unknown>;
};

export type ChatAssetView = {
  handle: string;
  id: string;
  role: string;
  filename: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** True when this asset is already placed on the timeline. */
  inUse: boolean;
};

export type ChatContext = {
  project: {
    revision: number;
    timelineDurationSec: number;
    sourceDurationSec: number;
    style: EditProjectStyle;
    hasTranscript: boolean;
    hasAnalysis: boolean;
  };
  elements: ChatElementView[];
  assets: ChatAssetView[];
  selection: {
    selectedElementHandle: string | null;
    selectedTimeRange: { startSec: number; endSec: number } | null;
    playheadSec: number;
  };
  transcript: {
    available: boolean;
    /** Spans the request's own wording matched, strongest first. */
    windows: TranscriptSpan[];
    /** A short excerpt, only so the model can phrase a summary naturally. */
    excerpt: string;
  };
  analysis: {
    available: boolean;
    shotCount: number;
    faceShotRatio: number;
    informationShotRatio: number;
    pairShotRatio: number;
    hasInformationRegion: boolean;
    semanticPeaks: { startSec: number; endSec: number; triggerText: string }[];
  };
  recent: {
    lastAffectedHandles: string[];
    lastAppliedSummary: string;
    messages: { role: string; text: string }[];
  };
  /** Truncation notes, surfaced to the model so it does not assume completeness. */
  notes: string[];
};

export type ChatContextInput = {
  revision: number;
  settings: unknown;
  style: EditProjectStyle;
  elements: Array<{
    id: string; type: EditElementType; track: number; position: number;
    startTime: number; duration: number; assetId: string | null;
    trimStart: number; trimEnd: number | null;
    properties: Record<string, unknown>;
  }>;
  assets: Array<{
    id: string; role: string; originalName: string;
    duration: number | null; width: number | null; height: number | null;
  }>;
  evidence: PresetEvidence;
  thread: ChatThread;
  selection: {
    selectedElementId?: string | null;
    selectedTimeRange?: { startSec: number; endSec: number } | null;
    playheadSec?: number;
  };
  /** The user's message, used to pick which transcript windows are relevant. */
  message: string;
};

/** The role an element plays, as a chat request would name it. */
export function elementRole(type: EditElementType,
  properties: Record<string, unknown>): ChatTargetRole {
  if (type === 'VIDEO') return 'VIDEO';
  if (type === 'AUDIO') return 'MUSIC';
  if (type === 'SUBTITLE') return 'SUBTITLE';
  if (type === 'TEXT') return 'TEXT';
  return String(properties.role ?? '') === 'LOGO' ? 'LOGO' : 'IMAGE';
}

const labelFor = (role: ChatTargetRole, properties: Record<string, unknown>,
  filename: string, index: number) => {
  if (role === 'TEXT' || role === 'SUBTITLE') {
    const content = String(properties.content ?? '').trim();
    return content ? `${role === 'TEXT' ? 'Text' : 'Caption'} "${content.slice(0, 40)}"`
      : `${role === 'TEXT' ? 'Text' : 'Caption'} ${index + 1}`;
  }
  if (role === 'VIDEO') return `Video segment ${index + 1}`;
  if (role === 'MUSIC') return filename ? `Audio (${filename})` : `Audio ${index + 1}`;
  return filename ? `${role === 'LOGO' ? 'Logo' : 'Image'} (${filename})`
    : `${role === 'LOGO' ? 'Logo' : 'Image'} ${index + 1}`;
};

/** Only the fields a chat command may read or change. */
const visibleProperties = (role: ChatTargetRole, properties: Record<string, unknown>) => {
  const keep = (...keys: string[]) => Object.fromEntries(keys
    .filter((key) => properties[key] !== undefined)
    .map((key) => [key, properties[key]]));
  if (role === 'MUSIC') return keep('volume', 'muted', 'fadeInSec', 'fadeOutSec');
  if (role === 'VIDEO') return {};
  if (role === 'TEXT' || role === 'SUBTITLE') {
    return keep('content', 'x', 'y', 'width', 'height', 'opacity', 'zIndex', 'fontSize',
      'color', 'textAlign', 'origin');
  }
  return keep('x', 'y', 'width', 'height', 'opacity', 'zIndex', 'origin');
};

/**
 * Builds the context for one chat turn.
 *
 * Transcript windows are selected by deterministic search against the user's
 * own words before any model is involved, so a semantic request arrives with a
 * short list of real candidate spans attached rather than with the entire
 * transcript and an invitation to guess.
 */
export function buildChatContext(input: ChatContextInput): ChatContext {
  const notes: string[] = [];
  const timelineDurationSec = Number(input.elements
    .filter((element) => element.type === 'VIDEO' && element.track === 0)
    .reduce((total, element) => total + element.duration, 0).toFixed(3));

  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const usedAssetIds = new Set(input.elements.map((element) => element.assetId).filter(Boolean));

  const videos = input.elements
    .filter((element) => element.type === 'VIDEO' && element.track === 0)
    .sort((left, right) => left.position - right.position);
  const overlays = input.elements
    .filter((element) => !(element.type === 'VIDEO' && element.track === 0))
    .sort((left, right) => left.track - right.track || left.startTime - right.startTime);
  if (videos.length > MAX_VIDEO_ELEMENTS) {
    notes.push(`Only the first ${MAX_VIDEO_ELEMENTS} of ${videos.length} video segments are listed.`);
  }
  if (overlays.length > MAX_OVERLAY_ELEMENTS) {
    notes.push(`Only ${MAX_OVERLAY_ELEMENTS} of ${overlays.length} overlays are listed.`);
  }

  let handleIndex = 0;
  const toView = (element: ChatContextInput['elements'][number], index: number): ChatElementView => {
    handleIndex += 1;
    const role = elementRole(element.type, element.properties);
    const filename = element.assetId ? assetsById.get(element.assetId)?.originalName ?? '' : '';
    return {
      handle: `el${handleIndex}`,
      id: element.id,
      type: element.type,
      role,
      label: labelFor(role, element.properties, filename, index),
      track: element.track,
      position: element.position,
      startSec: Number(element.startTime.toFixed(3)),
      endSec: Number((element.startTime + element.duration).toFixed(3)),
      trimStartSec: Number((element.trimStart ?? 0).toFixed(3)),
      trimEndSec: element.trimEnd == null ? null : Number(element.trimEnd.toFixed(3)),
      selected: element.id === input.selection.selectedElementId,
      properties: visibleProperties(role, element.properties)
    };
  };
  const elements = [
    ...videos.slice(0, MAX_VIDEO_ELEMENTS).map(toView),
    ...overlays.slice(0, MAX_OVERLAY_ELEMENTS).map(toView)
  ];
  // The selection must always be addressable, even if it fell outside the caps.
  const selectedId = input.selection.selectedElementId ?? null;
  if (selectedId && !elements.some((element) => element.id === selectedId)) {
    const missing = input.elements.find((element) => element.id === selectedId);
    if (missing) elements.push(toView(missing, elements.length));
  }

  const assets: ChatAssetView[] = input.assets.slice(0, MAX_ASSETS).map((asset, index) => ({
    handle: `asset${index + 1}`,
    id: asset.id,
    role: asset.role,
    filename: asset.originalName,
    durationSec: asset.duration,
    width: asset.width,
    height: asset.height,
    inUse: usedAssetIds.has(asset.id)
  }));
  if (input.assets.length > MAX_ASSETS) {
    notes.push(`Only ${MAX_ASSETS} of ${input.assets.length} assets are listed.`);
  }

  const words = input.evidence.words;
  const windows = words.length
    ? searchTranscript(words, input.message, { limit: MAX_TRANSCRIPT_WINDOWS }) : [];

  const handleById = new Map(elements.map((element) => [element.id, element.handle]));
  const selectedElementHandle = selectedId ? handleById.get(selectedId) ?? null : null;

  return {
    project: {
      revision: input.revision,
      timelineDurationSec,
      sourceDurationSec: Number(input.evidence.sourceDurationSec.toFixed(3)),
      style: input.style,
      hasTranscript: input.evidence.transcriptAvailable,
      hasAnalysis: input.evidence.analysisAvailable
    },
    elements,
    assets,
    selection: {
      selectedElementHandle,
      selectedTimeRange: input.selection.selectedTimeRange ?? null,
      playheadSec: Number((input.selection.playheadSec ?? 0).toFixed(3))
    },
    transcript: {
      available: input.evidence.transcriptAvailable,
      windows,
      excerpt: input.evidence.transcriptText.slice(0, TRANSCRIPT_EXCERPT_CHARS)
    },
    analysis: {
      available: input.evidence.analysisAvailable,
      shotCount: input.evidence.shots.length,
      faceShotRatio: input.evidence.faceShotRatio,
      informationShotRatio: input.evidence.informationShotRatio,
      pairShotRatio: input.evidence.pairShotRatio,
      hasInformationRegion: !!input.evidence.informationRegion,
      semanticPeaks: input.evidence.semanticPeaks.slice(0, 6).map((peak) => ({
        startSec: Number(peak.timestamp.toFixed(3)),
        endSec: Number(peak.endSec.toFixed(3)),
        triggerText: String(peak.phrase ?? peak.word ?? '').slice(0, 120)
      }))
    },
    recent: {
      lastAffectedHandles: input.thread.lastAffectedElementIds
        .map((id) => handleById.get(id)).filter((handle): handle is string => !!handle),
      lastAppliedSummary: input.thread.lastAppliedSummary,
      messages: input.thread.messages.slice(-MAX_RECENT_MESSAGES)
        .map((message) => ({ role: message.role, text: message.text.slice(0, 300) }))
    },
    notes
  };
}

/** The element id behind a handle, or undefined. */
export const elementIdForHandle = (context: ChatContext, handle: string) =>
  context.elements.find((element) => element.handle === handle)?.id;

/** The asset id behind a handle, or undefined. */
export const assetIdForHandle = (context: ChatContext, handle: string) =>
  context.assets.find((asset) => asset.handle === handle)?.id;
