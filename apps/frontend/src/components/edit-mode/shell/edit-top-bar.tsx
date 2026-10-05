'use client';

import Link from 'next/link';
import { ArrowLeft, Check, Download, LoaderCircle, Redo2, TriangleAlert, Undo2 } from 'lucide-react';
import type { EditAspectRatio } from '@/lib/edit-mode-types';

export type EditBusyKind = 'upload' | 'import' | 'analyze' | 'saving' | null;

const ASPECT_RATIOS: Array<{ id: EditAspectRatio; label: string }> = [
  { id: 'SOURCE', label: 'Source' },
  { id: '9:16', label: '9:16' },
  { id: '1:1', label: '1:1' },
  { id: '16:9', label: '16:9' }
];

/**
 * One status at a time, in a fixed order of precedence.
 *
 * Export runs in the background and the editor stays usable while it does, so
 * both an export phase and a local save can be true at once. Rather than show
 * two competing spinners, the more specific local action wins and the export
 * phase is shown only when nothing local is in flight.
 */
function SaveStatus({ busy, exportPhase, revision }: {
  busy: EditBusyKind; exportPhase: string | null; revision: number;
}) {
  const label = busy === 'saving' ? 'Saving…'
    : busy === 'analyze' ? 'Analyzing…'
      : busy === 'upload' ? 'Uploading…'
        : busy === 'import' ? 'Importing…'
          : busy ? 'Working…'
            : exportPhase === 'PREPARING' ? 'Preparing export…'
              : exportPhase === 'RENDERING' ? 'Exporting…'
                : exportPhase === 'QA' ? 'Checking quality…'
                  : exportPhase === 'UPLOADING' ? 'Finalizing export…'
                    : exportPhase === 'FAILED' ? 'Export failed'
                      : exportPhase === 'COMPLETED' ? `Exported · r${revision}`
                        : `Saved · r${revision}`;
  const working = !!busy || (!!exportPhase && exportPhase !== 'COMPLETED' && exportPhase !== 'FAILED');
  const failed = !busy && exportPhase === 'FAILED';
  return <span role='status' className={`flex shrink-0 items-center gap-1.5 text-xs ${
    failed ? 'text-red-300' : 'text-slate-400'}`}>
    {working ? <LoaderCircle size={13} className='animate-spin' />
      : failed ? <TriangleAlert size={13} />
        : <Check size={13} className='text-emerald-400' />}
    <span className='hidden sm:inline'>{label}</span>
  </span>;
}

const iconButton = 'grid h-8 w-8 place-items-center rounded-lg text-slate-300 ' +
  'transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30 ' +
  'disabled:hover:bg-transparent';

export function EditTopBar({ projectName, revision, busy, exportPhase, canUndo, canRedo,
  aspectRatio, onUndo, onRedo, onAspectRatio, onExport, exportDisabled }: {
  projectName: string;
  revision: number;
  busy: EditBusyKind;
  exportPhase: string | null;
  canUndo: boolean;
  canRedo: boolean;
  aspectRatio: EditAspectRatio;
  onUndo: () => void;
  onRedo: () => void;
  /** Absent until the aspect-ratio command exists; the control stays read-only. */
  onAspectRatio?: (ratio: EditAspectRatio) => void;
  onExport: () => void;
  exportDisabled: boolean;
}) {
  return <header className='flex h-12 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0d111c] px-3'>
    <Link href='/edit-mode' aria-label='Back to your edits'
      className='flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/10'>
      <ArrowLeft size={15} /><span className='hidden md:inline'>Projects</span>
    </Link>
    <span className='h-5 w-px shrink-0 bg-white/10' />
    <h1 className='min-w-0 flex-1 truncate text-sm font-semibold tracking-tight'>{projectName}</h1>
    <SaveStatus busy={busy} exportPhase={exportPhase} revision={revision} />
    <span className='h-5 w-px shrink-0 bg-white/10' />
    <div className='flex shrink-0 items-center gap-0.5'>
      <button className={iconButton} aria-label='Undo' title='Undo (Ctrl+Z)'
        disabled={!canUndo || !!busy} onClick={onUndo}><Undo2 size={16} /></button>
      <button className={iconButton} aria-label='Redo' title='Redo (Ctrl+Shift+Z)'
        disabled={!canRedo || !!busy} onClick={onRedo}><Redo2 size={16} /></button>
    </div>
    <span className='h-5 w-px shrink-0 bg-white/10' />
    <div className='hidden shrink-0 items-center gap-0.5 rounded-lg bg-black/30 p-0.5 lg:flex'
      role='group' aria-label='Aspect ratio'>
      {ASPECT_RATIOS.map((ratio) => {
        const active = ratio.id === aspectRatio;
        return <button key={ratio.id} disabled={!onAspectRatio}
          title={onAspectRatio ? undefined : 'Aspect ratio is set by the applied preset.'}
          aria-pressed={active} onClick={() => onAspectRatio?.(ratio.id)}
          className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
            active ? 'bg-white/15 text-white' : 'text-slate-400'} ${
            onAspectRatio ? 'hover:text-white' : 'cursor-default'}`}>{ratio.label}</button>;
      })}
    </div>
    <button onClick={onExport} disabled={exportDisabled}
      className='flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-40'>
      <Download size={14} />Export
    </button>
  </header>;
}
