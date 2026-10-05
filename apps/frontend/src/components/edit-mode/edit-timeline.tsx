'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { MIN_VIDEO_DURATION_SEC, normalizeVideoTrack, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';
import {
  createViewport, DEFAULT_OVERSCAN_SEC, DEFAULT_PX_PER_SEC, fitPxPerSecond, initialPxPerSecond,
  MAX_PX_PER_SEC, MIN_PX_PER_SEC, rulerTicks, scrollForZoom, scrollToReveal, windowElements,
  ZOOM_FACTOR, type TimelineViewport
} from '@/lib/edit-mode-viewport';
import {
  canEdit, isHidden, isLocked, nextToggle, TIMELINE_TRACKS, trackElements, trackHidden,
  trackLocked, trackMuted, tracksHeightPx, type TimelineTrack
} from '@/lib/edit-mode-tracks';
import {
  snapCandidates, snapSeconds, type TimelineSnapCandidate
} from '@/lib/edit-mode-timeline-snap';
import {
  moveSpan, splitAvailability, trimSpan, trimVideo, type TrimEdge
} from '@/lib/edit-mode-timeline-gestures';
import type { ManualEditCommand } from '@/lib/edit-mode-api';
import type { EditAsset, EditElement, EditTimeRange } from '@/lib/edit-mode-types';
import { EditTimelineToolbar, type TimelineTool } from './edit-timeline-toolbar';
import { EditTimelineTrackHeader } from './edit-timeline-track-header';
import { ThumbnailStrip, WaveformStrip } from './edit-timeline-media';

const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
const stamp = (seconds: number) => `${seconds.toFixed(1)}s`;
/** Pointer travel below this is a click (seek/select), not a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Shorter than this is treated as a mis-drag and clears the range selection. */
const MIN_RANGE_SEC = 0.2;
/** Below this width a block has no room for trim handles; they would cover it. */
const MIN_HANDLE_WIDTH_PX = 18;
const HEADER_COLUMN_PX = 152;
/** Phones: the header column shrinks to a colour chip and a short name. */
const COMPACT_HEADER_COLUMN_PX = 60;
/** A finger that travels less than this between down and up is a tap. */
const TAP_SLOP_PX = 10;

/**
 * Touch screens scroll the timeline with the same finger that taps it, so on touch a press
 * only acts when it ends as a tap (it never fights the scroll). Mouse and pen are unchanged.
 */
function onTap(event: React.PointerEvent, action: () => void) {
  const startX = event.clientX; const startY = event.clientY;
  const finish = (pointer: PointerEvent) => {
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < TAP_SLOP_PX) action();
  };
  const cancel = () => {
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', cancel);
}
const RULER_HEIGHT_PX = 24;
/** The video lane splits into a frame strip above and an audio strip below. */
const VIDEO_WAVEFORM_PX = 14;

type BlockPointer = (event: React.PointerEvent, element: EditElement) => void;
type EdgeHandler = (event: React.PointerEvent, element: EditElement, edge: TrimEdge) => void;

/**
 * One timeline block. Memoized on purpose: the parent re-renders on every
 * playhead tick, and a caption track can hold hundreds of these. Every callback
 * it takes is stable (the parent reads live state through refs), so a block
 * only re-renders when its own element, zoom, or selected-ness actually change.
 *
 * Deliberately NOT given the viewport: scrolling must not re-render four
 * hundred captions. The media decorations that do need the viewport live in
 * their own lane layer beside the blocks.
 */
const TimelineBlock = memo(function TimelineBlock({ element, pxPerSecond, track, selected,
  primary, translucent, tool, onSelect, onEdge }: {
  element: EditElement; pxPerSecond: number; track: TimelineTrack; selected: boolean;
  primary: boolean; translucent: boolean; tool: TimelineTool;
  onSelect: BlockPointer; onEdge: EdgeHandler;
}) {
  const widthPx = Math.max(2, element.duration * pxPerSecond);
  const locked = isLocked(element);
  const showHandles = !locked && (selected || widthPx >= MIN_HANDLE_WIDTH_PX);
  const caption = element.type === 'SUBTITLE';
  // Captions are the dense track, so their blocks stay deliberately cheap: no
  // tooltip, no icon, one text node, and a label only once there is room for it.
  const label = caption
    ? String(element.properties.content ?? 'Caption')
    : `${element.type === 'IMAGE' ? String(element.properties.role ?? 'Image') : track.label} · ${clock(element.duration)}`;
  const cursor = locked ? 'cursor-not-allowed'
    : tool === 'SPLIT' ? 'cursor-crosshair'
      : track.canDragFreely ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer';
  return <div role='button' tabIndex={-1}
    aria-label={`${track.label} at ${element.startTime.toFixed(1)} seconds${locked ? ', locked' : ''}`}
    data-testid='timeline-block' data-element-type={element.type} data-element-id={element.id}
    data-locked={locked ? 'true' : 'false'} data-selected={selected ? 'true' : 'false'}
    title={caption ? undefined : `${track.label} · ${clock(element.duration)}`}
    onPointerDown={(event) => onSelect(event, element)}
    className={`group absolute inset-y-1 flex items-center overflow-hidden rounded-md border px-1.5 text-[10px] font-medium ${cursor} ${selected ? 'touch-none ' : ''}${
      selected ? `border-white text-white ring-2 ring-cyan-300/50 ${primary ? 'bg-white/25' : 'bg-white/15'}`
        : translucent ? `${track.color} bg-transparent` : track.color
    }${isHidden(element) ? ' opacity-40' : ''}`}
    style={{ left: `${element.startTime * pxPerSecond}px`, width: `${widthPx}px` }}>
    {showHandles && <span onPointerDown={(event) => onEdge(event, element, 'left')}
      aria-label='Change start' data-testid='timeline-trim-left'
      className='absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize touch-none rounded-l-md bg-white/25 opacity-70 group-hover:bg-cyan-300/70 group-hover:opacity-100 coarse:w-5 coarse:bg-white/35' />}
    {locked && widthPx >= 22 && <Lock size={9} className='pointer-events-none mr-1 shrink-0 opacity-70' />}
    {widthPx >= 30 && <span className='pointer-events-none w-full truncate text-center drop-shadow-[0_1px_2px_rgba(0,0,0,.9)]'>{label}</span>}
    {showHandles && <span onPointerDown={(event) => onEdge(event, element, 'right')}
      aria-label='Change end' data-testid='timeline-trim-right'
      className='absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize touch-none rounded-r-md bg-white/25 opacity-70 group-hover:bg-cyan-300/70 group-hover:opacity-100 coarse:w-5 coarse:bg-white/35' />}
  </div>;
});

/** Isolated so a playhead tick repaints one absolutely-positioned line rather
 *  than reconciling every mounted block. */
const Playhead = memo(function Playhead({ seconds, pxPerSecond, heightPx }: {
  seconds: number; pxPerSecond: number; heightPx: number;
}) {
  return <div data-testid='timeline-playhead' aria-hidden
    className='pointer-events-none absolute top-0 z-20 w-px bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,.8)]'
    style={{ height: `${heightPx}px`, transform: `translateX(${Math.max(0, seconds) * pxPerSecond}px)` }} />;
});

const Ruler = memo(function Ruler({ ticks, pxPerSecond }: { ticks: number[]; pxPerSecond: number }) {
  return <>{ticks.map((tick) => <span key={tick}
    className='absolute bottom-0 top-0 border-l border-white/10 pl-1 text-[9px] leading-6 tabular-nums text-slate-500'
    style={{ left: `${tick * pxPerSecond}px` }}>{clock(tick)}</span>)}</>;
});

export function EditTimeline({ elements, assets, selectedElementId, selectedIds, currentPlayheadSec,
  sourceDuration, disabled, canUndo, canRedo, selectedRange, collapsed, compact = false,
  onSelectRange, onSelect, onSelectMany, onSeek, onPreviewElements,
  onCommitTrim, onCommitTiming, onSplitAt, onDelete, onDuplicate, onMoveTo, onUndo, onRedo,
  onCommand, onToggleCollapsed }: {
  elements: EditElement[]; assets: EditAsset[]; selectedElementId: string | null;
  selectedIds: string[]; currentPlayheadSec: number;
  sourceDuration: number; disabled: boolean; canUndo: boolean; canRedo: boolean;
  selectedRange: EditTimeRange | null; collapsed: boolean;
  /** Phone layout: narrow header column, single-row scrolling toolbar. */
  compact?: boolean;
  onSelectRange: (range: EditTimeRange | null) => void;
  onSelect: (id: string) => void; onSelectMany: (ids: string[]) => void;
  onSeek: (seconds: number) => void;
  onPreviewElements: (elements: EditElement[]) => void;
  onCommitTrim: (element: EditElement, before: EditElement[]) => void;
  onCommitTiming: (element: EditElement, before: EditElement[]) => void;
  onSplitAt: (elementId: string, seconds: number) => void;
  onDelete: () => void; onDuplicate: () => void;
  onMoveTo: (elementId: string, toPosition: number) => void;
  onUndo: () => void; onRedo: () => void;
  onCommand: (command: ManualEditCommand) => void;
  onToggleCollapsed: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SEC);
  const [scrollLeft, setScrollLeft] = useState(0);
  // Seeded rather than 0 so the very first paint (before the ResizeObserver
  // reports) windows a plausible range instead of mounting nothing.
  const [viewportWidth, setViewportWidth] = useState(960);
  const [tool, setTool] = useState<TimelineTool>('SELECT');
  const [snapEnabled, setSnapEnabled] = useState(true);
  // Pure gesture feedback: the snap guide, the drag readout and the video
  // drop indicator exist only while a pointer is down and never touch
  // canonical state.
  const [overlay, setOverlay] = useState<{ guide: TimelineSnapCandidate | null; readout: string | null;
    dropSec: number | null }>({ guide: null, readout: null, dropSec: null });

  const duration = Math.max(MIN_VIDEO_DURATION_SEC, timelineDuration(elements));
  const videos = useMemo(() => videoTrack(elements), [elements]);
  const selected = elements.find((element) => element.id === selectedElementId);
  const selectedIndex = videos.findIndex((element) => element.id === selectedElementId);
  const selectedKey = selectedIds.join(',');
  const selectionSet = useMemo(() => new Set(selectedIds), [selectedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewport = useMemo(() => createViewport({ pxPerSecond, scrollLeft, viewportWidth, duration,
    overscanSec: DEFAULT_OVERSCAN_SEC }), [duration, pxPerSecond, scrollLeft, viewportWidth]);
  const source = assets.find((asset) => asset.role === 'SOURCE');
  const lanesHeight = tracksHeightPx();
  const split = splitAvailability(selected, currentPlayheadSec);

  // Live state for the pointer gestures. Reading these through refs is what
  // lets every handler below stay referentially stable across re-renders, which
  // is in turn what lets the memoized blocks skip playhead ticks entirely.
  const live = useRef({ elements, viewport, disabled, tool, snapEnabled, currentPlayheadSec,
    duration, sourceDuration, selectionSet, selectedElementId,
    onSeek, onSelect, onSelectMany, onSelectRange, onPreviewElements, onCommitTrim,
    onCommitTiming, onSplitAt, onMoveTo });
  live.current = { elements, viewport, disabled, tool, snapEnabled, currentPlayheadSec,
    duration, sourceDuration, selectionSet, selectedElementId,
    onSeek, onSelect, onSelectMany, onSelectRange, onPreviewElements, onCommitTrim,
    onCommitTiming, onSplitAt, onMoveTo };

  // The opening zoom needs the real band width, so it is chosen once the
  // element has actually been measured rather than guessed at module scope.
  const zoomInitialized = useRef(false);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      setViewportWidth(node.clientWidth);
      if (zoomInitialized.current || node.clientWidth <= 0) return;
      zoomInitialized.current = true;
      setPxPerSecond(initialPxPerSecond(node.clientWidth, live.current.viewport.duration));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [collapsed]);

  // Scroll is read back on an animation frame rather than per scroll event, so
  // a flick cannot queue dozens of window recalculations. The vertical offset
  // is written straight to the header column's transform instead of to state:
  // scrolling the tracks up and down must not re-render the lanes at all.
  const scrollFrame = useRef(0);
  const handleScroll = useCallback(() => {
    if (headerRef.current && scrollRef.current) {
      headerRef.current.style.transform = `translateY(${-scrollRef.current.scrollTop}px)`;
    }
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      if (scrollRef.current) setScrollLeft(scrollRef.current.scrollLeft);
    });
  }, []);
  useEffect(() => () => { if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current); }, []);

  // A zoom change moves the scroll offset and the content width together. The
  // DOM offset is therefore written after the render that widened the content,
  // otherwise the browser clamps it against the old (narrower) scroll range.
  const pendingScroll = useRef<number | null>(null);
  const applyScroll = useCallback((next: number) => {
    pendingScroll.current = next;
    setScrollLeft(next);
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll.current == null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
  });
  const zoomBy = useCallback((factor: number, anchorOffsetPx?: number) => {
    const current = live.current.viewport;
    const next = current.pxPerSecond * factor;
    applyScroll(scrollForZoom(current, next, anchorOffsetPx ?? current.viewportWidth / 2));
    setPxPerSecond(Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, next)));
  }, [applyScroll]);
  const zoomToFit = useCallback(() => {
    const current = live.current.viewport;
    applyScroll(0);
    setPxPerSecond(fitPxPerSecond(current.viewportWidth, current.duration));
  }, [applyScroll]);

  // Ctrl/Cmd + wheel zooms around the cursor; a plain wheel keeps scrolling
  // (vertically through the tracks, or horizontally with Shift — both native).
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const offset = event.clientX - node.getBoundingClientRect().left;
      zoomBy(event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR, offset);
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [zoomBy, collapsed]);

  // Follow the playhead only when it leaves the visible range. Because this
  // depends on the playhead, scrolling elsewhere while paused is never undone.
  useEffect(() => {
    const next = scrollToReveal(live.current.viewport, currentPlayheadSec);
    if (next != null) applyScroll(next);
  }, [applyScroll, currentPlayheadSec]);

  // Zoom shortcuts live here rather than in the workspace because they are the
  // timeline's own state. Everything else (space, split, delete, undo, redo,
  // duplicate) is owned by the workspace so it works with the timeline closed.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(ZOOM_FACTOR); }
      else if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomBy(1 / ZOOM_FACTOR); }
      else if (event.key === 'Escape') {
        live.current.onSelectRange(null);
        live.current.onSelectMany([]);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [zoomBy]);

  const secondsAt = useCallback((clientX: number) => {
    const node = scrollRef.current;
    if (!node) return null;
    const current = live.current.viewport;
    const offset = clientX - node.getBoundingClientRect().left + node.scrollLeft;
    return Math.max(0, Math.min(current.duration, offset / current.pxPerSecond));
  }, []);

  /** Overlay writes are coalesced onto an animation frame: a pointer move must
   *  not queue a React render each time it fires. */
  const overlayFrame = useRef(0);
  const overlayNext = useRef(overlay);
  const pushOverlay = useCallback((next: typeof overlay) => {
    overlayNext.current = next;
    if (overlayFrame.current) return;
    overlayFrame.current = requestAnimationFrame(() => {
      overlayFrame.current = 0;
      setOverlay(overlayNext.current);
    });
  }, []);
  const clearOverlay = useCallback(() => {
    if (overlayFrame.current) cancelAnimationFrame(overlayFrame.current);
    overlayFrame.current = 0;
    setOverlay({ guide: null, readout: null, dropSec: null });
  }, []);
  useEffect(() => () => { if (overlayFrame.current) cancelAnimationFrame(overlayFrame.current); }, []);

  /** Click the ruler to seek; drag it to scrub. */
  const beginScrub = useCallback((event: React.PointerEvent) => {
    const at = secondsAt(event.clientX);
    if (at == null) return;
    event.preventDefault();
    live.current.onSeek(at);
    const move = (pointer: PointerEvent) => {
      const next = secondsAt(pointer.clientX);
      if (next != null) live.current.onSeek(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  }, [secondsAt]);

  /** Click empty lane space to seek, drag it to mark a range. */
  const beginRange = useCallback((event: React.PointerEvent) => {
    const anchor = secondsAt(event.clientX);
    if (anchor == null) return;
    if (event.pointerType === 'touch') {
      onTap(event, () => { live.current.onSeek(anchor); live.current.onSelectMany([]); });
      return;
    }
    live.current.onSeek(anchor);
    live.current.onSelectMany([]);
    const startX = event.clientX;
    let dragging = false;
    const move = (pointer: PointerEvent) => {
      if (!dragging && Math.abs(pointer.clientX - startX) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      const at = secondsAt(pointer.clientX);
      if (at == null) return;
      live.current.onSelectRange({ startSec: Math.min(anchor, at), endSec: Math.max(anchor, at) });
    };
    const up = (pointer: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const at = secondsAt(pointer.clientX) ?? anchor;
      if (!dragging || Math.abs(at - anchor) < MIN_RANGE_SEC) live.current.onSelectRange(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }, [secondsAt]);

  /** The snap candidates for one gesture, built once on pointer-down. */
  const candidatesFor = useCallback((excludeIds: string[]) => snapCandidates(live.current.elements, {
    playheadSec: live.current.currentPlayheadSec, durationSec: live.current.duration, excludeIds
  }), []);
  const snapTo = useCallback((seconds: number, candidates: TimelineSnapCandidate[],
    override: boolean) => snapSeconds(seconds, candidates, live.current.viewport.pxPerSecond,
    { enabled: live.current.snapEnabled && !override }), []);

  /**
   * A pointer press on a block.
   *
   * Select tool: plain click selects (and seeks); Ctrl/Cmd-click adds to the
   * multi-selection; a drag moves the element. Split tool: the press cuts the
   * element where it landed.
   */
  const pressBlock = useCallback<BlockPointer>((event, element) => {
    event.stopPropagation();
    const at = secondsAt(event.clientX);
    if (live.current.tool === 'SPLIT') {
      event.preventDefault();
      if (at == null || !canEdit(element) || live.current.disabled) return;
      live.current.onSplitAt(element.id, at);
      return;
    }
    const additive = event.ctrlKey || event.metaKey;
    if (additive && element.type !== 'VIDEO') {
      // Multi-selection is a foundation: it drives Delete and Duplicate, and
      // the toolbar reports it. Group MOVE and group TRIM are deliberately not
      // offered - each would have to become one canonical command per element,
      // which is one undo step per element, and that is worse than doing them
      // one at a time on purpose.
      const current = new Set(live.current.selectionSet);
      // The first Ctrl-click has to bring the ALREADY selected element with it,
      // or "select this one, then add that one" quietly ends up meaning only
      // the second - and a following Delete then removes one thing instead of
      // the two on screen.
      if (!current.size) {
        const anchor = live.current.elements.find((item) =>
          item.id === live.current.selectedElementId);
        if (anchor && anchor.type !== 'VIDEO') current.add(anchor.id);
      }
      if (current.has(element.id)) current.delete(element.id); else current.add(element.id);
      live.current.onSelectMany(current.size > 1 ? [...current] : []);
      live.current.onSelect(element.id);
      return;
    }
    if (event.pointerType === 'touch' && live.current.selectedElementId !== element.id) {
      onTap(event, () => {
        live.current.onSelectMany([]);
        live.current.onSelect(element.id);
        if (at != null) live.current.onSeek(at);
      });
      return;
    }
    live.current.onSelectMany([]);
    live.current.onSelect(element.id);
    if (at != null) live.current.onSeek(at);
    if (live.current.disabled || !canEdit(element)) return;

    const track = TIMELINE_TRACKS.find((item) => item.elementType === element.type);
    const startX = event.clientX;
    const before = live.current.elements.map((item) => ({ ...item }));
    const candidates = candidatesFor([element.id]);
    const sequential = element.type === 'VIDEO';
    let dragging = false;
    let latest = element;
    let dropPosition = -1;
    const move = (pointer: PointerEvent) => {
      if (!dragging && Math.abs(pointer.clientX - startX) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      const view = live.current.viewport;
      const deltaSec = (pointer.clientX - startX) / view.pxPerSecond;
      if (sequential) {
        // The VIDEO track is laid end to end, so a clip does not slide - it
        // changes places. The drop indicator shows which boundary it lands on,
        // and the canonical MOVE command is what actually runs on release.
        const ordered = videoTrack(live.current.elements);
        const from = ordered.findIndex((item) => item.id === element.id);
        const at2 = secondsAt(pointer.clientX) ?? element.startTime;
        let target = ordered.findIndex((item) => at2 < item.startTime + item.duration / 2);
        if (target < 0) target = ordered.length - 1;
        dropPosition = Math.max(0, Math.min(ordered.length - 1, target));
        const boundary = ordered[dropPosition];
        pushOverlay({ guide: null, dropSec: dropPosition > from
          ? boundary.startTime + boundary.duration : boundary.startTime,
        readout: dropPosition === from ? null : `Move clip to #${dropPosition + 1}` });
        return;
      }
      if (!track?.canDragFreely) return;
      const wanted = element.startTime + deltaSec;
      const snappedStart = snapTo(wanted, candidates, pointer.shiftKey);
      const snappedEnd = snapTo(wanted + element.duration, candidates, pointer.shiftKey);
      // Both edges are offered to the magnet and the closer win is taken, so a
      // clip can be aligned by its tail as readily as by its head.
      const useEnd = snappedEnd.guide != null && (snappedStart.guide == null ||
        Math.abs(snappedEnd.seconds - (wanted + element.duration)) < Math.abs(snappedStart.seconds - wanted));
      const targetStart = useEnd ? snappedEnd.seconds - element.duration : snappedStart.seconds;
      latest = moveSpan(element, targetStart, live.current.duration);
      pushOverlay({ guide: useEnd ? snappedEnd.guide : snappedStart.guide, dropSec: null,
        readout: `${stamp(latest.startTime)} → ${stamp(latest.startTime + latest.duration)}` });
      live.current.onPreviewElements(live.current.elements.map((item) =>
        item.id === element.id ? latest : item));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      clearOverlay();
      if (!dragging) return;
      if (sequential) {
        const from = videoTrack(before).findIndex((item) => item.id === element.id);
        if (dropPosition >= 0 && dropPosition !== from) live.current.onMoveTo(element.id, dropPosition);
        return;
      }
      if (latest !== element) live.current.onCommitTiming(latest, before);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  }, [candidatesFor, clearOverlay, pushOverlay, secondsAt, snapTo]);

  /** VIDEO edges retrim the source; everything else resizes its timeline span. */
  const beginEdge = useCallback<EdgeHandler>((event, element, edge) => {
    event.preventDefault(); event.stopPropagation();
    if (live.current.disabled || !canEdit(element)) return;
    const before = live.current.elements.map((item) => ({ ...item }));
    const candidates = candidatesFor([element.id]);
    const trim = element.type === 'VIDEO';
    let latest = element;
    let moved = false;
    const move = (pointer: PointerEvent) => {
      moved = true;
      const at = secondsAt(pointer.clientX);
      if (at == null) return;
      const snapped = snapTo(at, candidates, pointer.shiftKey);
      latest = trim
        ? trimVideo(element, edge, snapped.seconds, live.current.sourceDuration)
        : trimSpan(element, edge, snapped.seconds, live.current.duration);
      pushOverlay({ guide: snapped.guide, dropSec: null,
        readout: `${stamp(latest.startTime)} → ${stamp(latest.startTime + latest.duration)} · ${stamp(latest.duration)}` });
      const next = live.current.elements.map((item) => item.id === element.id ? latest : item);
      // Retrimming a clip changes every later clip's start, so the VIDEO track
      // is re-laid for the live preview exactly as the server will re-lay it.
      live.current.onPreviewElements(trim ? normalizeVideoTrack(next) : next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      clearOverlay();
      if (!moved) return;
      // One completed gesture, one canonical command, one history revision.
      if (trim) live.current.onCommitTrim(latest, before);
      else live.current.onCommitTiming(latest, before);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  }, [candidatesFor, clearOverlay, pushOverlay, secondsAt, snapTo]);

  const ticks = useMemo(() => rulerTicks(viewport), [viewport]);

  /** A track header toggle. Each resolves to ONE canonical command covering the
   *  whole track, so hiding four hundred captions is one undoable step. */
  const toggleTrack = useCallback((track: TimelineTrack, kind: 'hidden' | 'locked' | 'muted',
    state: ReturnType<typeof trackHidden>) => {
    const on = nextToggle(state);
    if (kind === 'hidden') {
      onCommand(track.id === 'SUBTITLE'
        ? { action: 'set-captions-visible', visible: !on }
        : { action: 'set-element-visible', elementType: track.elementType, visible: !on });
      return;
    }
    if (kind === 'locked') {
      onCommand({ action: 'set-element-locked', elementType: track.elementType, locked: on });
      return;
    }
    onCommand(track.id === 'VIDEO'
      ? { action: 'set-source-audio-muted', muted: on }
      : { action: 'set-audio-muted', muted: on });
  }, [onCommand]);

  /**
   * The mounted track lanes. Built from element geometry, the (quantized)
   * window and the selection only — the playhead is deliberately not a
   * dependency, so a playhead tick re-uses this exact element tree and React
   * skips the whole subtree.
   */
  const laneNodes = useMemo(() => TIMELINE_TRACKS.map((track) => {
    const items = trackElements(elements, track);
    const mounted = windowElements(items, viewport, [selectedElementId, ...selectionSet]);
    const video = track.id === 'VIDEO';
    return <div key={track.id} className='relative border-b border-white/[.04] last:border-0'
      style={{ height: `${track.heightPx}px` }} data-testid={`timeline-track-${track.id}`}
      data-mounted={mounted.length} data-total={items.length}>
      {video && <div className='pointer-events-none absolute inset-x-0 overflow-hidden'
        style={{ top: '4px', bottom: `${VIDEO_WAVEFORM_PX + 4}px` }}>
        <ThumbnailStrip enabled viewport={viewport} blocks={mounted.map((element) => ({
          id: element.id, assetId: element.assetId, startTime: element.startTime,
          duration: element.duration, trimStart: element.trimStart,
          speed: Number(element.properties.speed ?? 1) || 1 }))} /></div>}
      {track.media === 'WAVEFORM' && mounted.map((element) =>
        <div key={`wave-${element.id}`} className='pointer-events-none absolute inset-y-1 overflow-hidden rounded-md'
          style={{ left: `${element.startTime * viewport.pxPerSecond}px`,
            width: `${Math.max(2, element.duration * viewport.pxPerSecond)}px` }}>
          <WaveformStrip enabled assetId={element.assetId} viewport={viewport}
            sizeBytes={assets.find((asset) => asset.id === element.assetId)?.sizeBytes}
            color='rgba(167,243,208,.85)'
            block={{ startTime: element.startTime, duration: element.duration,
              trimStart: element.trimStart }} /></div>)}
      {video && source && mounted.map((element) =>
        <div key={`vwave-${element.id}`} className='pointer-events-none absolute overflow-hidden'
          style={{ left: `${element.startTime * viewport.pxPerSecond}px`,
            width: `${Math.max(2, element.duration * viewport.pxPerSecond)}px`,
            bottom: '4px', height: `${VIDEO_WAVEFORM_PX}px` }}>
          <WaveformStrip enabled assetId={source.id} viewport={viewport} sizeBytes={source.sizeBytes}
            color='rgba(196,181,253,.8)'
            block={{ startTime: element.startTime, duration: element.duration,
              trimStart: element.trimStart,
              speed: Number(element.properties.speed ?? 1) || 1 }} /></div>)}
      {mounted.map((element) => <TimelineBlock key={element.id} element={element}
        pxPerSecond={viewport.pxPerSecond} track={track} tool={tool} translucent={video}
        selected={element.id === selectedElementId || selectionSet.has(element.id)}
        primary={element.id === selectedElementId}
        onSelect={pressBlock} onEdge={beginEdge} />)}
    </div>;
  }), [assets, beginEdge, elements, pressBlock, selectedElementId, selectionSet, source, tool, viewport]);

  const headerNodes = TIMELINE_TRACKS.map((track) => {
    const items = trackElements(elements, track);
    return <EditTimelineTrackHeader key={track.id} track={track} count={items.length}
      disabled={disabled} compact={compact} hidden={trackHidden(items)} locked={trackLocked(items)}
      muted={trackMuted(items)}
      onToggleHidden={() => toggleTrack(track, 'hidden', trackHidden(items))}
      onToggleLocked={() => toggleTrack(track, 'locked', trackLocked(items))}
      onToggleMuted={() => toggleTrack(track, 'muted', trackMuted(items))} />;
  });

  const editable = canEdit(selected);
  const multi = selectedIds.length > 1;

  return <section className={`flex h-full min-h-0 flex-col gap-1.5 ${compact ? 'px-2 py-1.5' : 'px-3 py-2'}`}>
    <EditTimelineToolbar tool={tool} snap={snapEnabled} collapsed={collapsed} compact={compact}
      zoomPercent={Math.round(viewport.pxPerSecond / DEFAULT_PX_PER_SEC * 100)}
      playheadSec={currentPlayheadSec} durationSec={duration}
      selectedCount={Math.max(selectedIds.length, selected ? 1 : 0)}
      canUndo={canUndo} canRedo={canRedo} canSplit={split.canSplit} splitHint={split.reason}
      canDelete={(multi || !!selected) && editable} canDuplicate={!!selected && editable &&
        selected.type !== 'VIDEO'}
      canMoveBack={selectedIndex > 0} canMoveForward={selectedIndex >= 0 && selectedIndex < videos.length - 1}
      canZoomIn={viewport.pxPerSecond < MAX_PX_PER_SEC} canZoomOut={viewport.pxPerSecond > MIN_PX_PER_SEC}
      disabled={disabled} onTool={setTool} onToggleSnap={() => setSnapEnabled((value) => !value)}
      onSplit={() => selectedElementId && onSplitAt(selectedElementId, currentPlayheadSec)}
      onDelete={onDelete} onDuplicate={onDuplicate}
      onMove={(delta) => selectedElementId && selectedIndex >= 0 &&
        onMoveTo(selectedElementId, selectedIndex + delta)}
      onZoomIn={() => zoomBy(ZOOM_FACTOR)} onZoomOut={() => zoomBy(1 / ZOOM_FACTOR)}
      onFit={zoomToFit} onUndo={onUndo} onRedo={onRedo} onToggleCollapsed={onToggleCollapsed} />

    {selectedRange && <div className='flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-300/25 bg-amber-300/5 px-3 py-1 text-[11px] text-amber-200'>
      <span className='font-semibold uppercase tracking-[.12em]'>Range</span>
      <span className='tabular-nums'>{stamp(selectedRange.startSec)} – {stamp(selectedRange.endSec)}</span>
      <span className='text-amber-200/60'>({stamp(selectedRange.endSec - selectedRange.startSec)})</span>
      <span className='text-amber-200/60'>· the AI editor acts on this range</span>
      <button type='button' onClick={() => onSelectRange(null)} aria-label='Clear the selected range'
        className='ml-auto flex items-center gap-1 rounded-md border border-amber-300/25 px-2 py-0.5 font-medium hover:bg-amber-300/10'>
        <X size={11} />Clear</button>
    </div>}

    {!collapsed && <div data-testid='timeline-surface'
      className='flex min-h-0 flex-1 overflow-hidden rounded-xl border border-white/[.08] bg-[#080b13]'>
      {/* The track headers are a fixed column beside the lanes rather than
          labels floating over them, so a dense caption track never has its name
          sitting on top of its own blocks. It follows the lanes' vertical
          scroll through a transform written straight to the DOM. */}
      <div className='shrink-0 overflow-hidden border-r border-white/[.07] bg-[#0a0e18]'
        style={{ width: `${compact ? COMPACT_HEADER_COLUMN_PX : HEADER_COLUMN_PX}px` }}>
        <div className='border-b border-white/[.06]' style={{ height: `${RULER_HEIGHT_PX}px` }} />
        <div ref={headerRef} className='will-change-transform'>{headerNodes}</div>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} data-testid='timeline-scroller'
        className='relative min-h-0 flex-1 overflow-auto'>
        <div className='relative' style={{ width: `${Math.max(viewport.contentWidthPx, viewportWidth)}px` }}>
          <div onPointerDown={beginScrub} data-testid='timeline-ruler'
            className='sticky top-0 z-30 cursor-ew-resize touch-none border-b border-white/[.06] bg-[#080b13]'
            style={{ height: `${RULER_HEIGHT_PX}px` }}>
            <Ruler ticks={ticks} pxPerSecond={viewport.pxPerSecond} />
            <div aria-hidden className='pointer-events-none absolute z-10 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-cyan-300'
              style={{ bottom: 0, transform: `translateX(${Math.max(0, currentPlayheadSec) * viewport.pxPerSecond - 5}px)` }} />
          </div>
          <div className='relative' style={{ height: `${lanesHeight}px` }} onPointerDown={beginRange}>
            {selectedRange && <div aria-hidden className='pointer-events-none absolute bottom-0 top-0 z-10 border-x border-amber-300/70 bg-amber-300/10'
              style={{ left: `${selectedRange.startSec * viewport.pxPerSecond}px`,
                width: `${Math.max(2, (selectedRange.endSec - selectedRange.startSec) * viewport.pxPerSecond)}px` }} />}
            {laneNodes}
            {overlay.guide && <div data-testid='timeline-snap-guide' aria-hidden
              className='pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,.9)]'
              style={{ transform: `translateX(${overlay.guide.atSec * viewport.pxPerSecond}px)` }} />}
            {overlay.dropSec != null && <div data-testid='timeline-drop-indicator' aria-hidden
              className='pointer-events-none absolute bottom-0 top-0 z-30 w-0.5 bg-violet-300'
              style={{ transform: `translateX(${overlay.dropSec * viewport.pxPerSecond}px)` }} />}
            <Playhead seconds={currentPlayheadSec} pxPerSecond={viewport.pxPerSecond}
              heightPx={lanesHeight} />
          </div>
        </div>
        {overlay.readout && <div data-testid='timeline-readout'
          className='pointer-events-none sticky bottom-1 left-2 z-40 inline-block rounded-md border border-cyan-300/30 bg-[#0b1220]/95 px-2 py-1 text-[10px] font-medium tabular-nums text-cyan-100'>
          {overlay.readout}{overlay.guide && <span className='ml-1 text-amber-300'>· {overlay.guide.label}</span>}
        </div>}
      </div>
    </div>}
  </section>;
}
