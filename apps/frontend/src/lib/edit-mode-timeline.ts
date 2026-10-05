import type { EditElement } from './edit-mode-types';

export const MIN_VIDEO_DURATION_SEC = 0.05;

export function videoTrack(elements: EditElement[]) {
  return elements.filter((element) => element.type === 'VIDEO' && element.track === 0)
    .sort((left, right) => left.position - right.position || left.startTime - right.startTime);
}

export function normalizeVideoTrack(elements: EditElement[]) {
  let startTime = 0;
  const normalized = new Map<string, EditElement>();
  videoTrack(elements).forEach((element, position) => {
    normalized.set(element.id, { ...element, position, startTime });
    startTime += element.duration;
  });
  return elements.map((element) => normalized.get(element.id) ?? element)
    .sort((left, right) => left.track - right.track || left.position - right.position);
}

export function timelineDuration(elements: EditElement[]) {
  return videoTrack(elements).reduce((total, element) => total + element.duration, 0);
}

export function elementsAtTime(elements: EditElement[], time: number) {
  return elements.filter((element) => element.type !== 'VIDEO' && time >= element.startTime &&
    time < element.startTime + element.duration).sort((left, right) =>
    Number(left.properties.zIndex ?? 0) - Number(right.properties.zIndex ?? 0));
}

export function resolvePreviewPosition(elements: EditElement[], timelineTime: number) {
  const videos = videoTrack(elements);
  if (!videos.length) return null;
  const duration = timelineDuration(videos);
  const safeTime = Math.max(0, Math.min(timelineTime, Math.max(0, duration - 0.0001)));
  const element = videos.find((item) => safeTime >= item.startTime &&
    safeTime < item.startTime + item.duration) ?? videos.at(-1)!;
  // A sped-up segment covers more source seconds per timeline second, so the
  // mapping scales by the element's playback rate. At 1x this is unchanged.
  const speed = Number(element.properties.speed ?? 1) || 1;
  return { element, timelineTime: safeTime, speed,
    sourceTime: element.trimStart + Math.max(0, safeTime - element.startTime) * speed };
}

export function historyAvailability(history: Array<{ id: string; action: string; revision: number;
  command?: Record<string, unknown> | null }>) {
  // Must stay in step with MANUAL_ACTIONS in the backend's edit-mode.service.ts:
  // an action missing here leaves Undo greyed out for a step the backend would
  // happily undo. APPLY_ASSISTANT_EDIT is one AI chat turn, undone as one step.
  const manual = new Set(['TRIM_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT', 'MOVE_ELEMENT',
    'ADJUST_SOURCE_RANGE',
    'APPLY_PRESET', 'APPLY_ASSISTANT_EDIT', 'APPLY_TEMPLATE', 'SET_TEXT_CASE',
    'ADD_IMAGE', 'ADD_LOGO', 'ADD_TEXT', 'ADD_AUDIO', 'RESIZE_ELEMENT', 'SET_ELEMENT_TIMING',
    'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'UPDATE_TEXT', 'SET_AUDIO_VOLUME',
    'SET_AUDIO_MUTED', 'SET_AUDIO_FADE', 'DUPLICATE_ELEMENT', 'REMOVE_ELEMENT',
    'SET_VIDEO_CROP', 'SET_VIDEO_ROTATION', 'SET_VIDEO_FLIP', 'SET_VIDEO_SCALE',
    'SET_VIDEO_POSITION', 'SET_VIDEO_FRAMING', 'SET_SPEED',
    'SET_TEXT_CONTENT', 'SET_TEXT_FONT', 'SET_TEXT_SIZE', 'SET_TEXT_WEIGHT', 'SET_TEXT_COLOR',
    'SET_TEXT_ALIGNMENT', 'SET_TEXT_STROKE', 'SET_TEXT_SHADOW', 'SET_TEXT_BACKGROUND',
    'SET_TEXT_SPACING', 'SET_TEXT_STYLE_PRESET', 'SET_TEXT_RUNS',
    'GENERATE_CAPTIONS', 'REMOVE_CAPTIONS', 'SET_CAPTIONS_VISIBLE', 'SET_CAPTION_TEXT',
    'SPLIT_CAPTION', 'MERGE_CAPTION', 'SET_CAPTION_STYLE', 'SET_CAPTION_ACTIVE_WORD',
    'APPLY_CAPTION_STYLE_TO_ALL']);
  const active: string[] = [];
  let redo: string[] = [];
  [...history].sort((left, right) => left.revision - right.revision).forEach((entry) => {
    if (manual.has(entry.action)) { active.push(entry.id); redo = []; }
    else if (entry.action === 'UNDO') {
      const target = entry.command?.targetHistoryId;
      if (typeof target === 'string') { const index = active.lastIndexOf(target);
        if (index >= 0) active.splice(index, 1); redo.push(target); }
    } else if (entry.action === 'REDO') {
      const target = entry.command?.targetHistoryId;
      if (typeof target === 'string') { active.push(target); redo = redo.filter((id) => id !== target); }
    }
  });
  return { canUndo: active.length > 0, canRedo: redo.length > 0 };
}
