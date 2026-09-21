'use client';

import { useRef } from 'react';
import { ChevronLeft, ChevronRight, Redo2, Scissors, Trash2, Undo2 } from 'lucide-react';
import { MIN_VIDEO_DURATION_SEC, normalizeVideoTrack, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';
import type { EditElement } from '@/lib/edit-mode-types';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;

export function EditTimeline({ elements, selectedElementId, currentPlayheadSec, sourceDuration,
  disabled, canUndo, canRedo, onSelect, onSeek, onPreviewElements, onCommitTrim, onSplit,
  onCommitTiming, onDelete, onMove, onUndo, onRedo }: {
  elements: EditElement[]; selectedElementId: string | null; currentPlayheadSec: number;
  sourceDuration: number; disabled: boolean; canUndo: boolean; canRedo: boolean;
  onSelect: (id: string) => void; onSeek: (seconds: number) => void;
  onPreviewElements: (elements: EditElement[]) => void;
  onCommitTrim: (element: EditElement, before: EditElement[]) => void;
  onCommitTiming: (element: EditElement, before: EditElement[]) => void;
  onSplit: () => void; onDelete: () => void; onMove: (delta: -1 | 1) => void;
  onUndo: () => void; onRedo: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const duration = Math.max(MIN_VIDEO_DURATION_SEC, timelineDuration(elements));
  const videos = videoTrack(elements);
  const selectedIndex = videos.findIndex((element) => element.id === selectedElementId);
  const selected = elements.find((element) => element.id === selectedElementId);
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
  const beginTiming = (event: React.PointerEvent, element: EditElement, edge: 'left' | 'right') => {
    event.preventDefault(); event.stopPropagation(); if (disabled) return;
    const bounds = trackRef.current?.getBoundingClientRect(); if (!bounds) return;
    const before = elements.map((item) => ({ ...item })); const startX = event.clientX; let latest = element;
    const move = (pointer: PointerEvent) => {
      const delta = (pointer.clientX - startX) / bounds.width * duration;
      if (edge === 'left') { const nextStart = Math.max(0, Math.min(element.startTime + element.duration - MIN_VIDEO_DURATION_SEC, element.startTime + delta)); const removed = nextStart - element.startTime; latest = { ...element, startTime: nextStart, duration: element.duration - removed, trimStart: element.type === 'AUDIO' ? element.trimStart + removed : element.trimStart }; }
      else { const nextEnd = Math.max(element.startTime + MIN_VIDEO_DURATION_SEC, Math.min(duration, element.startTime + element.duration + delta)); latest = { ...element, duration: nextEnd - element.startTime, trimEnd: element.type === 'AUDIO' ? element.trimStart + nextEnd - element.startTime : element.trimEnd }; }
      onPreviewElements(elements.map((item) => item.id === element.id ? latest : item));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onCommitTiming(latest, before); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up, { once: true });
  };
  const tracks = [
    { label: 'Video', items: videos, color: 'border-violet-300/20 bg-violet-500/20 text-violet-100' },
    { label: 'Text', items: elements.filter((item) => item.type === 'TEXT'), color: 'border-cyan-300/20 bg-cyan-500/20 text-cyan-100' },
    { label: 'Captions', items: elements.filter((item) => item.type === 'SUBTITLE'), color: 'border-sky-300/20 bg-sky-500/20 text-sky-100' },
    { label: 'Image / Logo', items: elements.filter((item) => item.type === 'IMAGE'), color: 'border-fuchsia-300/20 bg-fuchsia-500/20 text-fuchsia-100' },
    { label: 'Music', items: elements.filter((item) => item.type === 'AUDIO'), color: 'border-emerald-300/20 bg-emerald-500/20 text-emerald-100' }
  ];
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
        <button aria-label='Delete selected element' title='Delete' disabled={disabled || !selected} onClick={onDelete} className='rounded-lg p-2 text-red-300 hover:bg-red-400/10 disabled:opacity-30'><Trash2 size={15} /></button>
        <span className='ml-2 text-xs tabular-nums text-slate-500'>{clock(duration)}</span>
      </div>
    </div>
    <div ref={trackRef} className='relative mt-4 overflow-hidden rounded-xl border border-white/[.08] bg-[#080b13] px-3 py-2'
      onPointerDown={(event) => seekFromPointer(event.clientX)}>
      {tracks.map((track) => <div key={track.label} className='relative h-14 border-b border-white/[.04] last:border-0'>
        <div className='pt-1 text-[9px] uppercase tracking-wider text-slate-600'>{track.label}</div>
        <div className='absolute inset-x-0 bottom-1 h-8'>{track.items.map((element) => <button key={element.id} title={`${element.type} · ${clock(element.duration)}`}
          onPointerDown={(event) => { event.stopPropagation(); onSelect(element.id); seekFromPointer(event.clientX); }}
          className={`group absolute flex h-7 items-center justify-center overflow-hidden rounded-md border px-2 text-[10px] font-medium ${selectedElementId === element.id ? 'border-white bg-white/20 text-white ring-2 ring-cyan-300/30' : track.color}`}
          style={{ left: `${element.startTime / duration * 100}%`, width: `${Math.max(1, element.duration / duration * 100)}%` }}>
          <span onPointerDown={(event) => element.type === 'VIDEO' ? beginTrim(event, element, 'left') : beginTiming(event, element, 'left')} aria-label='Change element start' className='absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/10 opacity-50 group-hover:opacity-100' />
          <span className='pointer-events-none truncate'>{element.type === 'IMAGE' ? String(element.properties.role ?? 'IMAGE') : element.type} · {clock(element.duration)}</span>
          <span onPointerDown={(event) => element.type === 'VIDEO' ? beginTrim(event, element, 'right') : beginTiming(event, element, 'right')} aria-label='Change element end' className='absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/10 opacity-50 group-hover:opacity-100' />
        </button>)}</div>
      </div>)}
      <div className='pointer-events-none absolute bottom-0 top-0 w-px bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,.8)]'
        style={{ left: `calc(${Math.min(100, currentPlayheadSec / duration * 100)}% + 0px)` }} aria-label={`Playhead at ${currentPlayheadSec.toFixed(2)} seconds`} />
    </div>
  </section>;
}
