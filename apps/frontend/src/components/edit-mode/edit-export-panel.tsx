'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Film, LoaderCircle, Play, Upload } from 'lucide-react';
import { editExportFileUrl, EditModeApiError, listEditExports, getEditExportProgress,
  startEditExport } from '@/lib/edit-mode-api';
import type { EditExport, EditExportProgress } from '@/lib/edit-mode-types';

const PHASE_LABEL: Record<EditExportProgress['phase'], string> = {
  PREPARING: 'Preparing…', RENDERING: 'Rendering…', QA: 'Checking quality…',
  UPLOADING: 'Finalizing…', COMPLETED: 'Done', FAILED: 'Failed'
};

const bytes = (value: number) => value >= 1024 * 1024
  ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${
  Math.floor(seconds % 60).toString().padStart(2, '0')}`;

/**
 * Compact export controls.
 *
 * Exports accumulate rather than replace, so the list is versioned newest
 * first and each entry says whether it still matches the current timeline.
 */
export function EditExportPanel({ projectId, revision, hasSource, disabled, onStatusChange }: {
  projectId: string;
  revision: number;
  hasSource: boolean;
  disabled: boolean;
  onStatusChange?: () => void;
}) {
  const [exports, setExports] = useState<EditExport[]>([]);
  const [progress, setProgress] = useState<EditExportProgress | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const finished = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try { setExports(await listEditExports(projectId)); } catch { /* listed on next poll */ }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let cancelled = false;
    void getEditExportProgress(projectId).then((value) => { if (!cancelled) setProgress(value); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId]);

  const running = progress != null && progress.phase !== 'COMPLETED' && progress.phase !== 'FAILED';
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      void getEditExportProgress(projectId).then(setProgress).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [projectId, running]);

  // When a render finishes, pull the new asset list and let the workspace
  // refresh the project so its status badge stops saying "exporting".
  useEffect(() => {
    if (!progress || running || finished.current === progress.exportId) return;
    finished.current = progress.exportId;
    if (progress.phase === 'FAILED') setError(progress.message ?? 'The export failed.');
    void refresh();
    onStatusChange?.();
  }, [progress, running, refresh, onStatusChange]);

  const start = async () => {
    setStarting(true); setError('');
    try {
      const result = await startEditExport(projectId, revision);
      finished.current = null;
      setProgress(result.export);
      onStatusChange?.();
    } catch (caught) {
      setError(caught instanceof EditModeApiError && caught.code === 'EXPORT_ALREADY_RUNNING'
        ? 'An export is already running for this project.'
        : caught instanceof Error ? caught.message : 'The export could not be started.');
    } finally { setStarting(false); }
  };

  return <section className='rounded-2xl border border-white/10 bg-[#0d111c] p-4'>
    <div className='flex items-center gap-2'>
      <Upload size={16} className='text-violet-300' />
      <h2 className='text-sm font-semibold'>Export</h2>
      <span className='ml-auto text-[11px] text-slate-500'>r{revision}</span>
    </div>

    <button disabled={disabled || !hasSource || running || starting} onClick={() => void start()}
      className='mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-violet-500 px-3 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40'>
      {running || starting ? <LoaderCircle size={15} className='animate-spin' /> : <Film size={15} />}
      {running ? PHASE_LABEL[progress.phase] : starting ? 'Starting…' : 'Export video'}
    </button>

    {running && <div className='mt-3'>
      <div className='h-1 overflow-hidden rounded-full bg-white/10'>
        <div className='h-full rounded-full bg-violet-400 transition-all duration-500'
          style={{ width: `${progress.percent}%` }} />
      </div>
      <p className='mt-1.5 text-[11px] text-slate-500'>
        {PHASE_LABEL[progress.phase]}{progress.attempt > 1 ? ` · pass ${progress.attempt}` : ''}
        {' · '}from r{progress.sourceRevision}
      </p>
    </div>}

    {error && <p role='alert' className='mt-3 flex gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[11px] text-red-200'>
      <AlertTriangle size={13} className='mt-px shrink-0' />{error}</p>}

    {!hasSource && <p className='mt-3 text-[11px] text-slate-500'>
      Attach a source video before exporting.</p>}

    {exports.length > 0 && <ul className='mt-4 grid gap-2'>
      {exports.map((item, index) => {
        const meta = item.metadata;
        const version = exports.length - index;
        return <li key={item.id} className='rounded-xl border border-white/10 bg-black/20 p-3'>
          <div className='flex items-center gap-2'>
            <span className='text-xs font-semibold'>v{version}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${item.current
              ? 'bg-emerald-400/15 text-emerald-300' : 'bg-amber-400/15 text-amber-300'}`}>
              {item.current ? 'Current' : `From r${item.sourceRevision ?? '?'}`}
            </span>
            {meta?.qa?.result && meta.qa.result !== 'PASS' && <span className='rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-300'>
              {meta.qa.result === 'DEGRADED_ACCEPTABLE' ? 'Minor QA notes' : meta.qa.result}</span>}
          </div>
          <p className='mt-1.5 text-[11px] text-slate-400'>
            {meta?.resolution?.width ?? '—'}×{meta?.resolution?.height ?? '—'}
            {meta?.durationSec ? ` · ${clock(meta.durationSec)}` : ''}
            {item.sizeBytes ? ` · ${bytes(Number(item.sizeBytes))}` : ''}
            {meta?.codec?.video ? ` · ${meta.codec.video}${meta.codec.audio ? `/${meta.codec.audio}` : ''}` : ''}
          </p>
          {!item.current && <p className='mt-1 text-[11px] text-amber-300/80'>
            Rendered from an older revision of this timeline.</p>}
          <div className='mt-2 flex gap-2'>
            <button onClick={() => setPreview(preview === item.id ? null : item.id)}
              className='flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium'>
              <Play size={12} />{preview === item.id ? 'Hide' : 'Preview'}</button>
            <a href={editExportFileUrl(item.id)} download={item.originalName}
              className='flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] font-medium'>
              <Download size={12} />Download</a>
          </div>
          {preview === item.id && <video controls preload='metadata' className='mt-2 w-full rounded-lg bg-black'
            src={editExportFileUrl(item.id)} />}
        </li>;
      })}
    </ul>}
  </section>;
}
