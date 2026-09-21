'use client';

import { useRef } from 'react';
import { ChevronLeft, ChevronRight, Redo2, Scissors, Trash2, Undo2 } from 'lucide-react';
import { MIN_VIDEO_DURATION_SEC, normalizeVideoTrack, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';
import type { EditElement } from '@/lib/edit-mode-types';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function EditTimeline({ elements, selectedElementId, currentPlayheadSec, sourceDuration,
  disabled, canUndo, canRedo, onSelect, onSeek, onPreviewElements, onCommitTrim, onSplit,
  onDelete, onMove, onUndo, onRedo }: {
  elements: EditElement[]; selectedElementId: string | null; currentPlayheadSec: number;
  sourceDuration: number; disabled: boolean; canUndo: boolean; canRedo: boolean;
  onSelect: (id: string) => void; onSeek: (seconds: number) => void;
  onPreviewElements: (elements: EditElement[]) => void;
  onCommitTrim: (element: EditElement, before: EditElement[]) => void;
  onSplit: () => void; onDelete: () => void; onMove: (delta: -1 | 1) => void;
  onUndo: () => void; onRedo: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const duration = Math.max(MIN_VIDEO_DURATION_SEC, timelineDuration(elements));
  const videos = videoTrack(elements);
  const selectedIndex = videos.findIndex((element) => element.id === selectedElementId);
  const seekFromPointer = (clientX: number) => {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (bounds) onSeek(Math.max(0, Math.min(duration, (clientX - bounds.left) / bounds.width * duration)));
  };
  const beginTrim = (event: React.PointerEvent, element: EditElement, edge: 'left' | 'right') => {
    event.preventDefault(); event.stopPropagation();
    if (disabled) return;
    const bounds = trackRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const before = elements.map((item) => ({ ...item }));
    const startX = event.clientX;
    let latest = element;
    const move = (pointer: PointerEvent) => {
      const delta = (pointer.clientX - startX) / bounds.width * duration;
      const trimEnd = element.trimEnd ?? element.trimStart + element.duration;
      if (edge === 'left') {
        const nextStart = Math.max(0, Math.min(trimEnd - MIN_VIDEO_DURATION_SEC, element.trimStart + delta));
        latest = { ...element, trimStart: nextStart, duration: trimEnd - nextStart };
      } else {
        const nextEnd = Math.max(element.trimStart + MIN_VIDEO_DURATION_SEC,
          Math.min(sourceDuration, trimEnd + delta));
        latest = { ...element, trimEnd: nextEnd, duration: nextEnd - element.trimStart };
      }
      onPreviewElements(normalizeVideoTrack(elements.map((item) => item.id === element.id ? latest : item)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommitTrim(latest, before);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };
  return <section className='rounded-2xl border border-white/10 bg-[#0d111c] p-4'>
    <div className='flex flex-wrap items-center justify-between gap-3'>
      <div><h2 className='text-sm font-semibold'>Timeline</h2><p className='mt-1 text-[11px] text-slate-500'>Drag segment edges to trim. Click the ruler to seek.</p></div>
      <div className='flex items-center gap-1'>
        <button aria-label='Undo' title='Undo (Ctrl+Z)' disabled={disabled || !canUndo} onClick={onUndo} className='rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:opacity-30'><Undo2 size={15} /></button>
        <button aria-label='Redo' title='Redo (Ctrl+Shift+Z)' disabled={disabled || !canRedo} onClick={onRedo} className='rounded-lg p-2 text-slate-300 hover:bg-white/10 disabled:opacity-30'><Redo2 size={15} /></button>
        <span className='mx-1 h-5 w-px bg-white/10' />
        <button aria-label='Move selected left' disabled={disabled || selectedIndex <= 0} onClick={() => onMove(-1)} className='rounded-lg p-2 hover:bg-white/10 disabled:opacity-30'><ChevronLeft size={15} /></button>
        <button aria-label='Move selected right' disabled={disabled || selectedIndex < 0 || selectedIndex >= videos.length - 1} onClick={() => onMove(1)} className='rounded-lg p-2 hover:bg-white/10 disabled:opacity-30'><ChevronRight size={15} /></button>
        <button aria-label='Split at playhead' title='Split (S)' disabled={disabled || selectedIndex < 0} onClick={onSplit} className='flex items-center gap-1 rounded-lg px-2 py-2 text-xs hover:bg-white/10 disabled:opacity-30'><Scissors size={14} />Split</button>
        <button aria-label='Delete selected segment' title='Delete' disabled={disabled || selectedIndex < 0} onClick={onDelete} className='rounded-lg p-2 text-red-300 hover:bg-red-400/10 disabled:opacity-30'><Trash2 size={15} /></button>
        <span className='ml-2 text-xs tabular-nums text-slate-500'>{clock(duration)}</span>
      </div>
    </div>
    <div ref={trackRef} className='relative mt-4 h-24 overflow-hidden rounded-xl border border-white/[.08] bg-[#080b13] px-3 pt-3'
      onPointerDown={(event) => seekFromPointer(event.clientX)}>
      <div className='text-[10px] uppercase tracking-wider text-slate-600'>Video 1</div>
      <div className='relative mt-3 h-10'>
        {videos.map((element) => <button key={element.id} title={`VIDEO · ${clock(element.duration)}`}
          onPointerDown={(event) => { event.stopPropagation(); onSelect(element.id); seekFromPointer(event.clientX); }}
          className={`group absolute flex h-9 items-center justify-center overflow-hidden rounded-lg border px-3 text-[11px] font-medium ${selectedElementId === element.id ? 'border-cyan-300 bg-cyan-400/25 text-cyan-50 ring-2 ring-cyan-300/20' : 'border-violet-300/20 bg-violet-500/20 text-violet-100'}`}
          style={{ left: `${element.startTime / duration * 100}%`, width: `${Math.max(1, element.duration / duration * 100)}%` }}>
          <span onPointerDown={(event) => beginTrim(event, element, 'left')} aria-label='Trim segment start' className='absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/10 opacity-50 group-hover:opacity-100' />
          <span className='pointer-events-none truncate'>#{element.position + 1} · {clock(element.duration)}</span>
          <span onPointerDown={(event) => beginTrim(event, element, 'right')} aria-label='Trim segment end' className='absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/10 opacity-50 group-hover:opacity-100' />
        </button>)}
      </div>
      <div className='pointer-events-none absolute bottom-0 top-0 w-px bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,.8)]'
        style={{ left: `calc(${Math.min(100, currentPlayheadSec / duration * 100)}% + 0px)` }} aria-label={`Playhead at ${currentPlayheadSec.toFixed(2)} seconds`} />
    </div>
  </section>;
}
