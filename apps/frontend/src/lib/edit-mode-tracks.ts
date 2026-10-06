import type { EditElement, EditElementType } from './edit-mode-types';

/**
 * The timeline's track model.
 *
 * Pure — no DOM, no React — so what a track can do is one table rather than a
 * set of conditionals spread through the component. Every capability here is
 * backed by a real canonical command; a track that cannot do something simply
 * does not offer the control, rather than offering a disabled decoration.
 */

export type TimelineTrackId = 'VIDEO' | 'TEXT' | 'SUBTITLE' | 'IMAGE' | 'AUDIO';

export type TimelineTrack = {
  id: TimelineTrackId;
  /** What the track is called on screen. Plain words, no editor jargon. */
  label: string;
  /** The element type it holds. VIDEO is additionally pinned to track 0. */
  elementType: EditElementType;
  /** Tailwind classes for an unselected block on this track. */
  color: string;
  /** The track header's colour chip. */
  chip: string;
  /** Row height in pixels. Footage and music are taller because they carry a
   *  thumbnail strip and a waveform respectively. The five rows have to total
   *  less than the band gives them at 1920x1080 (34vh minus the toolbar), so
   *  every track is reachable there without scrolling; at 1366x768 the surface
   *  scrolls, which is why it is a scroller and not a fixed stack. */
  heightPx: number;
  /** Hide/show, through SET_ELEMENT_VISIBLE (or SET_CAPTIONS_VISIBLE). */
  canHide: boolean;
  /** Mute, through SET_AUDIO_MUTED or SET_SOURCE_AUDIO_MUTED. */
  canMute: boolean;
  /** Whether an element may be dragged freely along the track. The VIDEO track
   *  is sequential — its elements are laid end to end and reordered by
   *  position — so a free drag there would be a lie. */
  canDragFreely: boolean;
  /** Whether an element's edges retrim it. True everywhere; VIDEO retrims the
   *  source, the rest resize their timeline span. */
  canTrim: boolean;
  /** The media decoration drawn behind the blocks. */
  media: 'THUMBNAILS' | 'WAVEFORM' | null;
};

export const TIMELINE_TRACKS: TimelineTrack[] = [
  { id: 'VIDEO', label: 'Video', elementType: 'VIDEO', heightPx: 56,
    color: 'border-track-video/40 bg-track-video/25 text-foreground',
    chip: 'bg-track-video', canHide: false, canMute: true, canDragFreely: false,
    canTrim: true, media: 'THUMBNAILS' },
  { id: 'TEXT', label: 'Text', elementType: 'TEXT', heightPx: 36,
    color: 'border-track-text/40 bg-track-text/20 text-foreground',
    chip: 'bg-track-text', canHide: true, canMute: false, canDragFreely: true,
    canTrim: true, media: null },
  { id: 'SUBTITLE', label: 'Captions', elementType: 'SUBTITLE', heightPx: 36,
    color: 'border-track-caption/40 bg-track-caption/25 text-foreground',
    chip: 'bg-track-caption', canHide: true, canMute: false, canDragFreely: true,
    canTrim: true, media: null },
  { id: 'IMAGE', label: 'Images', elementType: 'IMAGE', heightPx: 36,
    color: 'border-track-image/40 bg-track-image/20 text-foreground',
    chip: 'bg-track-image', canHide: true, canMute: false, canDragFreely: true,
    canTrim: true, media: null },
  { id: 'AUDIO', label: 'Music', elementType: 'AUDIO', heightPx: 48,
    color: 'border-track-audio/40 bg-track-audio/20 text-foreground',
    chip: 'bg-track-audio', canHide: false, canMute: true, canDragFreely: true,
    canTrim: true, media: 'WAVEFORM' }
];

export const trackById = (id: TimelineTrackId) =>
  TIMELINE_TRACKS.find((track) => track.id === id) ?? TIMELINE_TRACKS[0];

/** The track an element belongs to, or null for a type the timeline has no row
 *  for (EFFECT, and a VIDEO parked off track 0). */
export function trackForElement(element: EditElement): TimelineTrack | null {
  if (element.type === 'VIDEO') return element.track === 0 ? TIMELINE_TRACKS[0] : null;
  return TIMELINE_TRACKS.find((track) => track.elementType === element.type) ?? null;
}

/** Stored state, read defensively: an element created before these properties
 *  existed reads as visible and unlocked rather than as undefined. */
export const isHidden = (element: EditElement) => element.properties.hidden === true;
export const isLocked = (element: EditElement) => element.properties.locked === true;
export const isMuted = (element: EditElement) => element.type === 'VIDEO'
  ? element.properties.sourceMuted === true
  : element.properties.muted === true;

export type TrackToggleState = 'ALL' | 'NONE' | 'MIXED' | 'EMPTY';

const aggregate = (items: EditElement[], predicate: (element: EditElement) => boolean):
TrackToggleState => {
  if (!items.length) return 'EMPTY';
  const on = items.filter(predicate).length;
  if (on === items.length) return 'ALL';
  if (on === 0) return 'NONE';
  return 'MIXED';
};

/** ALL = every element on the track is hidden/locked/muted. A MIXED track's
 *  toggle turns everything ON, which is the least surprising resolution. */
export const trackHidden = (items: EditElement[]) => aggregate(items, isHidden);
export const trackLocked = (items: EditElement[]) => aggregate(items, isLocked);
export const trackMuted = (items: EditElement[]) => aggregate(items, isMuted);

/** What a toggle in state `current` should set next. MIXED resolves to "on",
 *  so one click makes a half-hidden track fully hidden rather than guessing. */
export const nextToggle = (current: TrackToggleState) => current !== 'ALL';

/**
 * Whether a timeline gesture may touch this element.
 *
 * Lock is canonical state (SET_ELEMENT_LOCKED) that the timeline enforces: a
 * locked element refuses drag, trim, split, delete and duplicate. It is
 * deliberately NOT enforced on the server, so the inspector, a preset and an
 * assistant turn still reach a locked element — a lock protects you from the
 * timeline's own big gestures, it does not freeze the element out of the
 * project. A locked element still renders and still exports.
 */
export const canEdit = (element: EditElement | undefined | null) =>
  !!element && !isLocked(element);

/** The elements a track shows, in timeline order. */
export function trackElements(elements: EditElement[], track: TimelineTrack) {
  if (track.id === 'VIDEO') {
    return elements.filter((element) => element.type === 'VIDEO' && element.track === 0)
      .sort((left, right) => left.position - right.position || left.startTime - right.startTime);
  }
  return elements.filter((element) => element.type === track.elementType)
    .sort((left, right) => left.startTime - right.startTime);
}

/** Total height of the visible track rows — what the lane column has to be. */
export const tracksHeightPx = (tracks: TimelineTrack[] = TIMELINE_TRACKS) =>
  tracks.reduce((total, track) => total + track.heightPx, 0);
