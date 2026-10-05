'use client';

import { memo, type ReactNode } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Magnet, Maximize2, MousePointer2,
  Redo2, Scissors, Trash2, Undo2, ZoomIn, ZoomOut
} from 'lucide-react';

/**
 * The timeline's toolbar.
 *
 * Every control here is an ordinary editing word — Split, Delete, Duplicate,
 * Snap, Zoom, Fit — and every one of them does something. Tooltips carry the
 * explanation (and, for Split, the reason it is currently unavailable) so the
 * buttons themselves stay short.
 */

export type TimelineTool = 'SELECT' | 'SPLIT';

const Button = ({ label, hint, onClick, disabled, active, danger, children }: {
  label: string; hint?: string; onClick: () => void; disabled?: boolean; active?: boolean;
  danger?: boolean; children: ReactNode;
}) => <button type='button' aria-label={label} title={hint ?? label} onClick={onClick}
  disabled={disabled} aria-pressed={active === undefined ? undefined : active}
  data-testid={`timeline-tool-${label.toLowerCase().replace(/[^a-z]+/gu, '-')}`}
  className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-30 ${
    active ? 'bg-cyan-400/20 text-cyan-100 ring-1 ring-cyan-300/40'
      : danger ? 'text-red-300 hover:bg-red-400/10' : 'text-slate-300 hover:bg-white/10'}`}>
  {children}</button>;

const Divider = () => <span aria-hidden className='mx-0.5 h-5 w-px shrink-0 bg-white/10' />;

const clock = (seconds: number) => {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`;
};

export const EditTimelineToolbar = memo(function EditTimelineToolbar({
  tool, snap, zoomPercent, playheadSec, durationSec, selectedCount, collapsed,
  canUndo, canRedo, canSplit, splitHint, canDelete, canDuplicate, canMoveBack, canMoveForward,
  canZoomIn, canZoomOut, disabled,
  onTool, onToggleSnap, onSplit, onDelete, onDuplicate, onMove, onZoomIn, onZoomOut, onFit,
  onUndo, onRedo, onToggleCollapsed
}: {
  tool: TimelineTool; snap: boolean; zoomPercent: number; playheadSec: number; durationSec: number;
  selectedCount: number; collapsed: boolean;
  canUndo: boolean; canRedo: boolean; canSplit: boolean; splitHint: string;
  canDelete: boolean; canDuplicate: boolean; canMoveBack: boolean; canMoveForward: boolean;
  canZoomIn: boolean; canZoomOut: boolean; disabled: boolean;
  onTool: (tool: TimelineTool) => void; onToggleSnap: () => void; onSplit: () => void;
  onDelete: () => void; onDuplicate: () => void; onMove: (delta: -1 | 1) => void;
  onZoomIn: () => void; onZoomOut: () => void; onFit: () => void;
  onUndo: () => void; onRedo: () => void; onToggleCollapsed: () => void;
}) {
  return <div data-testid='timeline-toolbar'
    className='flex shrink-0 flex-wrap items-center gap-x-0.5 gap-y-1'>
    <Button label='Select' hint='Select — click to pick, drag empty space to mark a range'
      active={tool === 'SELECT'} onClick={() => onTool('SELECT')}>
      <MousePointer2 size={14} /></Button>
    <Button label='Split tool' hint='Split tool — click a clip or caption to cut it there'
      active={tool === 'SPLIT'} disabled={disabled} onClick={() => onTool('SPLIT')}>
      <Scissors size={14} /></Button>
    <Divider />
    <Button label='Split' hint={splitHint} disabled={disabled || !canSplit} onClick={onSplit}>
      <Scissors size={13} />Split</Button>
    <Button label='Duplicate' hint='Duplicate (Ctrl+D)' disabled={disabled || !canDuplicate}
      onClick={onDuplicate}><Copy size={13} />Duplicate</Button>
    <Button label='Delete' danger hint='Delete (Del)' disabled={disabled || !canDelete}
      onClick={onDelete}><Trash2 size={13} />Delete</Button>
    <Divider />
    <Button label='Move earlier' hint='Move the selected clip earlier'
      disabled={disabled || !canMoveBack} onClick={() => onMove(-1)}><ChevronLeft size={14} /></Button>
    <Button label='Move later' hint='Move the selected clip later'
      disabled={disabled || !canMoveForward} onClick={() => onMove(1)}><ChevronRight size={14} /></Button>
    <Divider />
    <Button label='Snap' hint={snap ? 'Snap is on — edges stick to nearby items and the playhead'
      : 'Snap is off — drag freely'} active={snap} onClick={onToggleSnap}>
      <Magnet size={13} />Snap</Button>
    <Divider />
    <Button label='Zoom out' hint='Zoom out (−)' disabled={!canZoomOut} onClick={onZoomOut}>
      <ZoomOut size={14} /></Button>
    <span data-testid='timeline-zoom' className='min-w-[3.2rem] text-center text-[10px] tabular-nums text-slate-500'>
      {zoomPercent}%</span>
    <Button label='Zoom in' hint='Zoom in (+)' disabled={!canZoomIn} onClick={onZoomIn}>
      <ZoomIn size={14} /></Button>
    <Button label='Fit' hint='Fit the whole project in view' onClick={onFit}>
      <Maximize2 size={13} />Fit</Button>
    <Divider />
    <Button label='Undo' hint='Undo (Ctrl+Z)' disabled={disabled || !canUndo} onClick={onUndo}>
      <Undo2 size={14} /></Button>
    <Button label='Redo' hint='Redo (Ctrl+Shift+Z)' disabled={disabled || !canRedo} onClick={onRedo}>
      <Redo2 size={14} /></Button>

    <div className='ml-auto flex items-center gap-2 pl-2'>
      {selectedCount > 1 && <span data-testid='timeline-selection-count'
        className='rounded-md border border-cyan-300/25 px-1.5 py-0.5 text-[10px] font-medium text-cyan-200'>
        {selectedCount} selected</span>}
      <span data-testid='timeline-clock' className='text-[11px] tabular-nums text-slate-400'>
        <span className='text-slate-200'>{clock(playheadSec)}</span>
        <span className='text-slate-600'> / {clock(durationSec)}</span>
      </span>
      <Button label={collapsed ? 'Expand timeline' : 'Collapse timeline'}
        hint={collapsed ? 'Expand the timeline' : 'Collapse the timeline'}
        onClick={onToggleCollapsed}>
        {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</Button>
    </div>
  </div>;
});
