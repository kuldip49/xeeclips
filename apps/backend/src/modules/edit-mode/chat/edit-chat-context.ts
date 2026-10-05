// The bounded, structured view of a project that a chat turn reasons over.
//
// The whole project is never sent to a model. What goes out is a compact
// catalogue of addressable OBJECTS - the hook, the logo, the music, the caption
// under the playhead, each video segment, each zoom - behind stable, readable
// opaque handles like "text:hook", "logo:main", "audio:music1", "caption:42" or
// "zoom:2". The model picks handles; the backend maps handles to real ids. That
// is what makes "do not expect the LLM to invent UUIDs" structurally true rather
// than a request in a prompt: an id never leaves this module, and an unknown
// handle resolves to nothing.
//
// Workstream G adds SEMANTIC ROLES. A TEXT element is not just "text": the one a
// preset or template wrote as the opening headline is the HOOK, the call to
// action is the CTA. Roles come from stored metadata first (presetRole,
// templateRole, the LOGO asset role), and only then, conservatively, from the
// built-in style the user explicitly picked for that element (a text styled
// with the "Hook" preset). Wording alone never makes something a hook.
//
// Bounded by construction. Captions are summarised and only the ones near the
// playhead, inside the selected range, selected, or recently touched are
// listed - never a 400-caption dump.

import type { EditElementType } from '@prisma/client';
import { readEditPresetRun, type EditProjectStyle } from '../presets/edit-preset-policy';
import type { PresetEvidence } from '../presets/edit-preset-evidence';
import { buildTimelineMap, type TimelineMap } from '../render/edit-mode-timeline-map';
import { EDIT_MODE_ZOOM, EDIT_MODE_ZOOM_SCALES } from '../render/edit-mode-zoom';
import { readColor, readColorFilterId, type ColorAdjustments } from '../edit-mode-color';
import { readAudioState, readSourceAudio } from '../edit-mode-audio';
import { readScale, readSpeed, readTransform } from '../edit-mode-transform';
import { readActiveWord, readTextStyle, type TextStyle } from '../edit-mode-text';
import { readZoomEffect, zoomMomentKey } from '../edit-mode-zoom-events';
import type { TimedWord } from '../../editing/edit-plan';
import type { AnalysisFrame } from '../../editing/edit-analysis';
import { searchTranscript, type TranscriptSpan } from './edit-chat-transcript';
import type { ChatTargetRole } from './edit-chat-commands';
import type { ChatActiveTarget, ChatThread } from './edit-chat.types';

/** How many of each kind survive into the context. */
const MAX_VIDEO_ELEMENTS = 12;
const MAX_TEXT_ELEMENTS = 12;
const MAX_IMAGE_ELEMENTS = 12;
const MAX_AUDIO_ELEMENTS = 6;
const MAX_ZOOM_ELEMENTS = 12;
const MAX_LISTED_CAPTIONS = 10;
const CAPTION_PLAYHEAD_WINDOW_SEC = 3;
const MAX_ASSETS = 24;
const MAX_TEMPLATES = 24;
const MAX_TRANSCRIPT_WINDOWS = 4;
const MAX_RECENT_MESSAGES = 6;
const TRANSCRIPT_EXCERPT_CHARS = 1200;
/** The opening a hook is written from: roughly the first half minute of speech. */
const HOOK_OPENING_SEC = 45;
const HOOK_OPENING_CHARS = 1500;
/** Grounding for a creative line is checked against this much of the transcript. */
const GROUNDING_TEXT_CHARS = 12000;

/**
 * What an element IS to someone editing. The legacy `role` (VIDEO, MUSIC,
 * SUBTITLE, TEXT, LOGO, IMAGE) is kept for the Phase 6 planner; `semantic` is
 * the Workstream G vocabulary a request is actually phrased in.
 */
export const SEMANTIC_ROLES = ['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD', 'TEXT', 'CAPTION', 'LOGO',
  'IMAGE', 'MUSIC', 'SOURCE_VIDEO', 'ZOOM'] as const;
export type SemanticRole = typeof SEMANTIC_ROLES[number];
/** METADATA: presetRole/templateRole/asset role. STYLE: the built-in style the
 *  user chose for it. TYPE: nothing more specific is known. */
export type RoleSource = 'METADATA' | 'STYLE' | 'TYPE';

export type ChatElementView = {
  handle: string;
  id: string;
  type: EditElementType;
  role: ChatTargetRole;
  semantic: SemanticRole;
  roleSource: RoleSource;
  label: string;
  track: number;
  position: number;
  startSec: number;
  endSec: number;
  /** Source-relative range, for VIDEO and AUDIO elements that carry a trim. */
  trimStartSec: number;
  trimEndSec: number | null;
  selected: boolean;
  locked: boolean;
  hidden: boolean;
  /** A preset-planned zoom that is not an element yet (see edit-mode-zoom-events). */
  virtual?: boolean;
  momentKey?: string;
  /** Current state, normalised - what a relative change is computed from. */
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

export type ChatTemplateView = { handle: string; id: string; name: string;
  source: 'BUILTIN' | 'USER' };

export type ChatContext = {
  project: {
    revision: number;
    timelineDurationSec: number;
    sourceDurationSec: number;
    aspectRatio: string;
    style: EditProjectStyle;
    currentTemplate: string | null;
    hasTranscript: boolean;
    hasWordTimings: boolean;
    hasAnalysis: boolean;
  };
  elements: ChatElementView[];
  assets: ChatAssetView[];
  templates: ChatTemplateView[];
  /** Whole-track summaries, so the model knows what exists without a dump. */
  tracks: {
    videoSegments: number;
    captions: { count: number; listed: number; hidden: number; manualEdited: number;
      styleId: string | null; activeWordOn: number; fontSize: number | null; y: number | null };
    sourceAudio: { volume: number; muted: boolean };
    hook: string | null;
    cta: string | null;
    zooms: number;
  };
  selection: {
    selectedElementHandle: string | null;
    selectedTimeRange: { startSec: number; endSec: number } | null;
    playheadSec: number;
  };
  transcript: {
    available: boolean;
    /** Spans the request's own wording matched, strongest first (SOURCE seconds). */
    windows: TranscriptSpan[];
    /** A short excerpt, only so the model can phrase a summary naturally. */
    excerpt: string;
    /** The opening a hook is written from. */
    opening: string;
  };
  analysis: {
    available: boolean;
    shotCount: number;
    faceShotRatio: number;
    informationShotRatio: number;
    pairShotRatio: number;
    hasInformationRegion: boolean;
    semanticPeaks: { startSec: number; endSec: number; triggerText: string;
      reason: string; score: number }[];
  };
  recent: {
    lastAffectedHandles: string[];
    lastAppliedSummary: string;
    /** The conversational active target, as handles, and what was done to it. */
    active: { handles: string[]; family: string; direction: number; task: string } | null;
    messages: { role: string; text: string }[];
  };
  /** Truncation notes, surfaced to the model so it does not assume completeness. */
  notes: string[];
  /**
   * Server-side only. Never serialised into a prompt (the planner builds its
   * prompt from named fields), never returned to the browser.
   */
  runtime: {
    map: TimelineMap;
    words: TimedWord[];
    groundingText: string;
    faceCentres: Array<{ sourceSec: number; x: number; y: number }>;
    analysisFrames: AnalysisFrame[];
    shotBoundaries: number[];
    sourceWidth: number;
    sourceHeight: number;
    thread: ChatThread;
    selectedElementId: string | null;
    captionIds: string[];
    /** Full text styles (stroke/shadow/plate objects) for text-like elements. */
    styles: Map<string, TextStyle>;
  };
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
  templates?: Array<{ id: string; name: string; source: 'BUILTIN' | 'USER' }>;
};

const TEXT_ROLES = new Set(['HOOK', 'CTA', 'TITLE', 'LOWER_THIRD']);
/** Built-in text styles that name a role outright. */
const STYLE_ROLES: Record<string, SemanticRole> = {
  HOOK: 'HOOK', CTA: 'CTA', TITLE: 'TITLE', LOWER_THIRD: 'LOWER_THIRD'
};

/** The role an element plays, as a Phase 6 request would name it. */
export function elementRole(type: EditElementType,
  properties: Record<string, unknown>): ChatTargetRole {
  if (type === 'VIDEO') return 'VIDEO';
  if (type === 'AUDIO') return 'MUSIC';
  if (type === 'SUBTITLE') return 'SUBTITLE';
  if (type === 'TEXT') return 'TEXT';
  if (type === 'EFFECT') return 'ZOOM';
  return String(properties.role ?? '') === 'LOGO' ? 'LOGO' : 'IMAGE';
}

/**
 * The semantic role, from metadata first.
 *
 * TEXT: presetRole/templateRole HOOK or CTA is authoritative - that is what a
 * preset or template recorded when it wrote the element. Failing that, the
 * built-in text STYLE the user picked is used, because choosing the "Hook"
 * style for a line is itself a statement of what the line is. Nothing is
 * inferred from the wording, position or size.
 */
export function semanticRole(type: EditElementType, properties: Record<string, unknown>):
  { semantic: SemanticRole; source: RoleSource } {
  if (type === 'VIDEO') return { semantic: 'SOURCE_VIDEO', source: 'TYPE' };
  if (type === 'AUDIO') return { semantic: 'MUSIC', source: 'TYPE' };
  if (type === 'SUBTITLE') return { semantic: 'CAPTION', source: 'TYPE' };
  if (type === 'EFFECT') return { semantic: 'ZOOM', source: 'TYPE' };
  if (type === 'IMAGE') {
    const logo = properties.role === 'LOGO' || properties.presetRole === 'LOGO';
    return { semantic: logo ? 'LOGO' : 'IMAGE', source: 'METADATA' };
  }
  // Either stamp may hold the role; older template runs stamped the facet name
  // 'TEXT' over templateRole while presetRole still says HOOK.
  const recorded = [properties.templateRole, properties.presetRole]
    .map((value) => String(value ?? '')).find((value) => TEXT_ROLES.has(value));
  if (recorded) return { semantic: recorded as SemanticRole, source: 'METADATA' };
  const styled = STYLE_ROLES[String(properties.textStyleId ?? '')];
  if (styled) return { semantic: styled, source: 'STYLE' };
  return { semantic: 'TEXT', source: 'TYPE' };
}

const SEMANTIC_LABEL: Record<SemanticRole, string> = {
  HOOK: 'Hook', CTA: 'Call to action', TITLE: 'Title', LOWER_THIRD: 'Lower third',
  TEXT: 'Text', CAPTION: 'Caption', LOGO: 'Logo', IMAGE: 'Image', MUSIC: 'Music',
  SOURCE_VIDEO: 'Video segment', ZOOM: 'Zoom'
};

const round3 = (value: number) => Number(value.toFixed(3));
const round4 = (value: number) => Number(value.toFixed(4));

/** Only non-neutral colour controls, so the context stays short. */
const colorSummary = (color: ColorAdjustments) => Object.fromEntries(Object.entries(color)
  .filter(([, value]) => Math.abs(value) > 1e-4).map(([key, value]) => [key, round4(value)]));

/** The current state a relative change is computed from, per role. */
function stateFor(semantic: SemanticRole, element: ChatContextInput['elements'][number],
  filename: string): Record<string, unknown> {
  const props = element.properties;
  const box = {
    x: round4(Number(props.x ?? 0)), y: round4(Number(props.y ?? 0)),
    width: round4(Number(props.width ?? 0.2)), height: round4(Number(props.height ?? 0.2)),
    rotation: round4(Number(props.rotation ?? 0)),
    opacity: round4(Number(props.opacity ?? 1)), zIndex: Number(props.zIndex ?? 0)
  };
  if (semantic === 'SOURCE_VIDEO') {
    const transform = readTransform(props);
    const source = readSourceAudio(props);
    return {
      speed: readSpeed(props), scale: readScale(props),
      offsetX: round4(Number(props.offsetX ?? 0)), offsetY: round4(Number(props.offsetY ?? 0)),
      rotation: transform.rotation, flipH: transform.flipH, flipV: transform.flipV,
      crop: transform.crop, color: readColor(props), colorChanged: colorSummary(readColor(props)),
      colorFilter: readColorFilterId(props), sourceVolume: source.volume,
      sourceMuted: source.muted
    };
  }
  if (semantic === 'MUSIC') {
    const audio = readAudioState(props);
    return { filename, volume: audio.volume, muted: audio.muted, fadeInSec: audio.fadeInSec,
      fadeOutSec: audio.fadeOutSec, duckEnabled: audio.duckEnabled,
      duckStrength: audio.duckStrength };
  }
  if (semantic === 'ZOOM') {
    const zoom = readZoomEffect(props);
    return { scale: zoom?.scale ?? 1, enabled: zoom?.enabled ?? false, source: 'EDITED',
      claimsMoment: zoom?.claimsMoment ?? null, triggerText: zoom?.triggerText ?? '' };
  }
  if (semantic === 'LOGO' || semantic === 'IMAGE') {
    const transform = readTransform(props);
    return { filename, ...box, crop: transform.crop, flipH: transform.flipH,
      flipV: transform.flipV };
  }
  // Text of every kind, captions included.
  const style = readTextStyle(props);
  return {
    content: String(props.content ?? '').slice(0, 300), ...box,
    fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
    color: style.color, textAlign: style.textAlign, uppercase: style.uppercase,
    stroke: style.stroke.enabled, shadow: style.shadow.enabled,
    background: style.background.enabled,
    textStyleId: props.textStyleId ?? null,
    ...(semantic === 'CAPTION' ? { manualEdited: props.manualEdited === true,
      captionStyleId: props.captionStyleId ?? null,
      activeWord: readActiveWord(props).enabled ? readActiveWord(props).color : null } : {}),
    origin: props.origin ?? 'USER'
  };
}

const labelFor = (semantic: SemanticRole, state: Record<string, unknown>, index: number) => {
  const content = typeof state.content === 'string' ? state.content.trim() : '';
  if (content) return `${SEMANTIC_LABEL[semantic]} "${content.slice(0, 50)}"`;
  if (typeof state.filename === 'string' && state.filename) {
    return `${SEMANTIC_LABEL[semantic]} (${state.filename})`;
  }
  return `${SEMANTIC_LABEL[semantic]} ${index + 1}`;
};

const overlaps = (startSec: number, endSec: number, from: number, to: number) =>
  endSec > from + 1e-6 && startSec < to - 1e-6;

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
  const selectedId = input.selection.selectedElementId ?? null;
  const playheadSec = Number((input.selection.playheadSec ?? 0).toFixed(3));
  const range = input.selection.selectedTimeRange ?? null;
  const assetsById = new Map(input.assets.map((asset) => [asset.id, asset]));
  const usedAssetIds = new Set(input.elements.map((element) => element.assetId).filter(Boolean));
  const active = input.thread.active;
  const pinned = new Set([selectedId, ...(active?.elementIds ?? []),
    ...input.thread.lastAffectedElementIds].filter((id): id is string => !!id));

  const map = buildTimelineMap(input.elements.map((element) => ({
    id: element.id, type: element.type, track: element.track, position: element.position,
    startTime: element.startTime, duration: element.duration, trimStart: element.trimStart ?? 0,
    trimEnd: element.trimEnd ?? null, properties: element.properties })));
  const timelineDurationSec = round3(input.elements
    .filter((element) => element.type === 'VIDEO' && element.track === 0)
    .reduce((total, element) => total + element.duration, 0));

  const byStart = <T extends { startTime: number; position: number }>(items: T[]) =>
    [...items].sort((left, right) => left.startTime - right.startTime ||
      left.position - right.position);
  const ofType = (type: EditElementType) => input.elements.filter((element) =>
    element.type === type && (type !== 'VIDEO' || element.track === 0));

  const views: ChatElementView[] = [];
  const view = (element: ChatContextInput['elements'][number], handle: string,
    index: number): ChatElementView => {
    const { semantic, source } = semanticRole(element.type, element.properties);
    const filename = element.assetId ? assetsById.get(element.assetId)?.originalName ?? '' : '';
    const state = stateFor(semantic, element, filename);
    return {
      handle, id: element.id, type: element.type,
      role: elementRole(element.type, element.properties), semantic, roleSource: source,
      label: labelFor(semantic, state, index), track: element.track, position: element.position,
      startSec: round3(element.startTime), endSec: round3(element.startTime + element.duration),
      trimStartSec: round3(element.trimStart ?? 0),
      trimEndSec: element.trimEnd == null ? null : round3(element.trimEnd),
      selected: element.id === selectedId,
      locked: element.properties.locked === true, hidden: element.properties.hidden === true,
      properties: state
    };
  };
  /** Keeps the first `limit` plus anything pinned (selected / active). */
  const bounded = <T extends { id: string }>(items: T[], limit: number, noun: string) => {
    if (items.length > limit) notes.push(`Only ${limit} of ${items.length} ${noun} are listed.`);
    return items.filter((item, index) => index < limit || pinned.has(item.id));
  };

  // --- Video segments: video:1..n in timeline order -------------------------
  const videos = [...ofType('VIDEO')].sort((left, right) => left.position - right.position);
  videos.forEach((element, index) => {
    if (index < MAX_VIDEO_ELEMENTS || pinned.has(element.id)) {
      views.push(view(element, `video:${index + 1}`, index));
    }
  });
  if (videos.length > MAX_VIDEO_ELEMENTS) {
    notes.push(`Only ${MAX_VIDEO_ELEMENTS} of ${videos.length} video segments are listed.`);
  }

  // --- Text: text:hook / text:cta / text:title, then text:1..n ---------------
  const texts = byStart(ofType('TEXT'));
  const textRoles = texts.map((element) => semanticRole('TEXT', element.properties));
  // Metadata beats style: if a preset/template recorded a HOOK, a second line
  // that merely wears the Hook style is not also "the hook".
  const authoritative = new Set(textRoles.filter((role) => role.source === 'METADATA')
    .map((role) => role.semantic));
  const counts = new Map<string, number>();
  texts.forEach((element, index) => {
    const role = textRoles[index];
    const demoted = role.source === 'STYLE' && authoritative.has(role.semantic);
    if (!demoted && role.semantic !== 'TEXT') {
      counts.set(role.semantic, (counts.get(role.semantic) ?? 0) + 1);
    }
  });
  const seen = new Map<string, number>();
  let plainIndex = 0;
  const textViews = texts.map((element, index) => {
    const role = textRoles[index];
    const demoted = role.source === 'STYLE' && authoritative.has(role.semantic);
    if (demoted || role.semantic === 'TEXT') {
      plainIndex += 1;
      const item = view(element, `text:${plainIndex}`, index);
      return demoted ? { ...item, semantic: 'TEXT' as SemanticRole, roleSource: 'TYPE' as RoleSource,
        label: labelFor('TEXT', item.properties, index) } : item;
    }
    const key = role.semantic.toLowerCase().replace('_', '');
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    return view(element, (counts.get(role.semantic) ?? 0) > 1 ? `text:${key}${nth}` : `text:${key}`,
      index);
  });
  views.push(...bounded(textViews, MAX_TEXT_ELEMENTS, 'text elements'));

  // --- Captions: caption:N is the global timeline index, but only a few are
  // listed - the selected one, the ones under the playhead, inside the selected
  // range, and the ones the last turn touched.
  const captions = byStart(ofType('SUBTITLE'));
  const captionIds = captions.map((element) => element.id);
  const wanted = new Set<number>();
  captions.forEach((element, index) => {
    const endSec = element.startTime + element.duration;
    if (pinned.has(element.id)) wanted.add(index);
    else if (overlaps(element.startTime, endSec, playheadSec - CAPTION_PLAYHEAD_WINDOW_SEC,
      playheadSec + CAPTION_PLAYHEAD_WINDOW_SEC)) wanted.add(index);
    else if (range && overlaps(element.startTime, endSec, range.startSec, range.endSec)) {
      wanted.add(index);
    }
  });
  const listedCaptions = [...wanted].sort((left, right) => left - right)
    .filter((index, position) => position < MAX_LISTED_CAPTIONS || pinned.has(captions[index].id))
    .map((index) => view(captions[index], `caption:${index + 1}`, index));
  views.push(...listedCaptions);
  if (captions.length > listedCaptions.length) {
    notes.push(`${captions.length} captions exist; only the ${listedCaptions.length} near the ` +
      'playhead, the selection or the last edit are listed. "captions:all" addresses the whole ' +
      'caption track.');
  }

  // --- Logos, images ------------------------------------------------------------
  const images = byStart(ofType('IMAGE'));
  const logos = images.filter((element) => semanticRole('IMAGE', element.properties).semantic ===
    'LOGO');
  const plainImages = images.filter((element) => !logos.includes(element));
  views.push(...bounded(logos.map((element, index) =>
    view(element, logos.length === 1 ? 'logo:main' : `logo:${index + 1}`, index)),
  MAX_IMAGE_ELEMENTS, 'logos'));
  views.push(...bounded(plainImages.map((element, index) =>
    view(element, `image:${index + 1}`, index)), MAX_IMAGE_ELEMENTS, 'images'));

  // --- Music ------------------------------------------------------------------
  views.push(...bounded(byStart(ofType('AUDIO')).map((element, index) =>
    view(element, `audio:music${index + 1}`, index)), MAX_AUDIO_ELEMENTS, 'music clips'));

  // --- Zooms: edited zoom elements, plus preset-planned moments that no
  // element has claimed yet. Both are addressable as zoom:N in timeline order.
  const zoomViews: ChatElementView[] = byStart(ofType('EFFECT'))
    .filter((element) => readZoomEffect(element.properties)?.enabled)
    .map((element, index) => view(element, 'zoom:?', index));
  const claimed = new Set(ofType('EFFECT').map((element) =>
    readZoomEffect(element.properties)?.claimsMoment).filter(Boolean));
  const presetRun = readEditPresetRun(input.settings);
  if (input.style.zoomPolicy !== 'OFF' && presetRun) {
    for (const moment of presetRun.plannedZoomMoments) {
      const key = zoomMomentKey(moment);
      if (claimed.has(key)) continue;
      const startSec = map.toTimeline(moment.startSec)[0];
      if (startSec === undefined) continue;
      const hold = Math.max(0.6, moment.endSec - moment.startSec);
      const endSec = Math.min(timelineDurationSec,
        startSec + EDIT_MODE_ZOOM.rampInSec + hold + EDIT_MODE_ZOOM.rampOutSec);
      zoomViews.push({
        handle: 'zoom:?', id: `moment:${key}`, type: 'EFFECT', role: 'ZOOM', semantic: 'ZOOM',
        roleSource: 'METADATA', label: `Zoom on "${moment.triggerText}"`, track: 4, position: 0,
        startSec: round3(startSec), endSec: round3(endSec), trimStartSec: 0, trimEndSec: null,
        selected: false, locked: false, hidden: false, virtual: true, momentKey: key,
        properties: { scale: EDIT_MODE_ZOOM_SCALES[moment.intensity], enabled: true,
          source: 'PLANNED', claimsMoment: null, triggerText: moment.triggerText }
      });
    }
  }
  zoomViews.sort((left, right) => left.startSec - right.startSec)
    .forEach((item, index) => {
      item.handle = `zoom:${index + 1}`;
      if (!item.virtual) {
        const text = String(item.properties.triggerText ?? '');
        item.label = text ? `Zoom on "${text}"` : `Zoom at ${item.startSec.toFixed(1)}s`;
      }
    });
  views.push(...bounded(zoomViews, MAX_ZOOM_ELEMENTS, 'zooms'));

  // --- Assets and templates ---------------------------------------------------
  const assetIndex = new Map<string, number>();
  const assets: ChatAssetView[] = input.assets.filter((asset) => asset.role !== 'EXPORT')
    .slice(0, MAX_ASSETS).map((asset) => {
      const key = asset.role.toLowerCase();
      const nth = (assetIndex.get(key) ?? 0) + 1;
      assetIndex.set(key, nth);
      return { handle: `asset:${key}${nth}`, id: asset.id, role: asset.role,
        filename: asset.originalName, durationSec: asset.duration, width: asset.width,
        height: asset.height, inUse: usedAssetIds.has(asset.id) };
    });
  if (input.assets.length > MAX_ASSETS) {
    notes.push(`Only ${MAX_ASSETS} of ${input.assets.length} assets are listed.`);
  }
  let userTemplate = 0;
  const templates: ChatTemplateView[] = (input.templates ?? []).slice(0, MAX_TEMPLATES)
    .map((template) => ({ ...template, handle: template.source === 'BUILTIN'
      ? `template:${template.id.toLowerCase()}` : `template:user${++userTemplate}` }));

  // --- Summaries ----------------------------------------------------------------
  const captionStyles = new Map<string, number>();
  for (const caption of captions) {
    const id = String(caption.properties.captionStyleId ?? '');
    if (id) captionStyles.set(id, (captionStyles.get(id) ?? 0) + 1);
  }
  const reference = captions[0] ? readTextStyle(captions[0].properties) : null;
  const firstVideo = videos[0];
  const hookView = views.find((item) => item.semantic === 'HOOK');
  const ctaView = views.find((item) => item.semantic === 'CTA');

  const words = input.evidence.words;
  const windows = words.length
    ? searchTranscript(words, input.message, { limit: MAX_TRANSCRIPT_WINDOWS }) : [];
  const openingWords = words.filter((word) => word.start <= (words[0]?.start ?? 0) +
    HOOK_OPENING_SEC);
  const opening = (openingWords.length ? openingWords.map((word) => word.text).join(' ')
    : input.evidence.transcriptText).slice(0, HOOK_OPENING_CHARS);

  const handleById = new Map(views.map((item) => [item.id, item.handle]));
  const selectedElementHandle = selectedId ? handleById.get(selectedId) ?? null : null;
  const handlesFor = (target: ChatActiveTarget | null) => (target?.elementIds ?? [])
    .map((id) => handleById.get(id)).filter((handle): handle is string => !!handle);
  const templateRun = (input.settings && typeof input.settings === 'object'
    ? (input.settings as Record<string, unknown>).templateRun : null) as
    { templateName?: unknown } | null;

  return {
    project: {
      revision: input.revision,
      timelineDurationSec,
      sourceDurationSec: round3(input.evidence.sourceDurationSec),
      aspectRatio: input.style.aspectRatio,
      style: input.style,
      currentTemplate: typeof templateRun?.templateName === 'string' ? templateRun.templateName
        : null,
      hasTranscript: input.evidence.transcriptAvailable,
      hasWordTimings: input.evidence.wordTimingsAvailable,
      hasAnalysis: input.evidence.analysisAvailable
    },
    elements: views,
    assets,
    templates,
    tracks: {
      videoSegments: videos.length,
      captions: { count: captions.length, listed: listedCaptions.length,
        hidden: captions.filter((item) => item.properties.hidden === true).length,
        manualEdited: captions.filter((item) => item.properties.manualEdited === true).length,
        styleId: [...captionStyles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        activeWordOn: captions.filter((item) => readActiveWord(item.properties).enabled).length,
        fontSize: reference?.fontSize ?? null,
        y: captions[0] ? round4(Number(captions[0].properties.y ?? 0.73)) : null },
      sourceAudio: firstVideo ? readSourceAudio(firstVideo.properties)
        : { volume: 1, muted: false },
      hook: hookView?.handle ?? null,
      cta: ctaView?.handle ?? null,
      zooms: zoomViews.length
    },
    selection: {
      selectedElementHandle,
      selectedTimeRange: range,
      playheadSec
    },
    transcript: {
      available: input.evidence.transcriptAvailable,
      windows,
      excerpt: input.evidence.transcriptText.slice(0, TRANSCRIPT_EXCERPT_CHARS),
      opening
    },
    analysis: {
      available: input.evidence.analysisAvailable,
      shotCount: input.evidence.shots.length,
      faceShotRatio: input.evidence.faceShotRatio,
      informationShotRatio: input.evidence.informationShotRatio,
      pairShotRatio: input.evidence.pairShotRatio,
      hasInformationRegion: !!input.evidence.informationRegion,
      semanticPeaks: input.evidence.semanticPeaks.slice(0, 6).map((peak) => ({
        startSec: round3(peak.timestamp),
        endSec: round3(peak.endSec),
        triggerText: String(peak.phrase ?? peak.word ?? '').slice(0, 120),
        reason: String(peak.reason || 'SEMANTIC_IMPORTANCE').slice(0, 120),
        score: Number(peak.combinedScore.toFixed(4))
      }))
    },
    recent: {
      lastAffectedHandles: input.thread.lastAffectedElementIds
        .map((id) => handleById.get(id)).filter((handle): handle is string => !!handle),
      lastAppliedSummary: input.thread.lastAppliedSummary,
      active: active ? { handles: handlesFor(active), family: active.family,
        direction: active.direction, task: active.task } : null,
      messages: input.thread.messages.slice(-MAX_RECENT_MESSAGES)
        .map((message) => ({ role: message.role, text: message.text.slice(0, 300) }))
    },
    notes,
    runtime: {
      map, words,
      groundingText: input.evidence.transcriptText.slice(0, GROUNDING_TEXT_CHARS),
      faceCentres: faceCentres(input.evidence),
      analysisFrames: input.evidence.frames,
      shotBoundaries: input.evidence.shots.slice(1).map((shot) => shot.sourceStart),
      sourceWidth: input.evidence.sourceWidth,
      sourceHeight: input.evidence.sourceHeight,
      thread: input.thread,
      selectedElementId: selectedId,
      captionIds,
      styles: new Map([...texts, ...(captions[0] ? [captions[0]] : []),
        ...listedCaptions.map((item) => captions.find((caption) => caption.id === item.id)!)]
        .map((element) => [element.id, readTextStyle(element.properties)]))
    }
  };
}

/** The largest face per sampled frame, in SOURCE seconds and frame fractions. */
function faceCentres(evidence: PresetEvidence) {
  return evidence.frames.flatMap((frame) => {
    const face = [...(frame.faces ?? [])].sort((left, right) =>
      right.w * right.h - left.w * left.h)[0];
    return face ? [{ sourceSec: frame.t, x: face.x + face.w / 2, y: face.y + face.h / 2 }] : [];
  });
}

/** Handles that address a whole track rather than one element. */
export const AGGREGATE_HANDLES = ['captions:all', 'video:all', 'audio:source'] as const;

/** The element id behind a handle, or undefined. Virtual zooms have no id. */
export const elementIdForHandle = (context: ChatContext, handle: string) => {
  const found = context.elements.find((element) => element.handle === handle);
  return found && !found.virtual ? found.id : undefined;
};

/** The view behind a handle, virtual zooms included. */
export const viewForHandle = (context: ChatContext, handle: string) =>
  context.elements.find((element) => element.handle === handle);

/** The asset id behind a handle, or undefined. */
export const assetIdForHandle = (context: ChatContext, handle: string) =>
  context.assets.find((asset) => asset.handle === handle)?.id;
