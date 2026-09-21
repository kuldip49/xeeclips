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
  return { element, timelineTime: safeTime,
    sourceTime: element.trimStart + Math.max(0, safeTime - element.startTime) };
}

export function historyAvailability(history: Array<{ id: string; action: string; revision: number;
  command?: Record<string, unknown> | null }>) {
  const manual = new Set(['TRIM_ELEMENT', 'SPLIT_ELEMENT', 'DELETE_ELEMENT', 'MOVE_ELEMENT',
    'APPLY_PRESET',
    'ADD_IMAGE', 'ADD_LOGO', 'ADD_TEXT', 'ADD_AUDIO', 'RESIZE_ELEMENT', 'SET_ELEMENT_TIMING',
    'SET_ELEMENT_OPACITY', 'SET_ELEMENT_Z_INDEX', 'UPDATE_TEXT', 'SET_AUDIO_VOLUME',
    'SET_AUDIO_MUTED', 'SET_AUDIO_FADE', 'DUPLICATE_ELEMENT', 'REMOVE_ELEMENT']);
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
