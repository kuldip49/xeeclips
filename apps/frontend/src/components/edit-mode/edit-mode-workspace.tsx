'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, ScanSearch } from 'lucide-react';
import {
  analyzeEditSource, EditModeApiError, getEditHistory, getEditProject, importEditSource,
  type ManualEditCommand, redoEdit, runManualEditCommand, undoEdit, uploadEditSource
} from '@/lib/edit-mode-api';
import { historyAvailability, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';
import type { EditElement, EditHistory, EditProject } from '@/lib/edit-mode-types';
import { EditAssetPicker } from './edit-asset-picker';
import { EditHistoryPanel } from './edit-history-panel';
import { EditInspector } from './edit-inspector';
import { EditPreview, type EditPreviewHandle } from './edit-preview';
import { EditTimeline } from './edit-timeline';

const fingerprint = (elements: EditElement[]) => JSON.stringify(videoTrack(elements).map((element) => ({
  id: element.id, assetId: element.assetId, position: element.position, startTime: element.startTime,
  duration: element.duration, trimStart: element.trimStart, trimEnd: element.trimEnd
})));

export function EditModeWorkspace({ initialProject, initialHistory }: {
  initialProject: EditProject;
  initialHistory: EditHistory[];
}) {
  const [project, setProjectState] = useState(initialProject);
  const projectRef = useRef(initialProject);
  const [history, setHistory] = useState(initialHistory);
  const [busy, setBusy] = useState<'upload' | 'import' | 'analyze' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const firstVideo = videoTrack(initialProject.elements ?? [])[0];
  const [selectedElementId, setSelectedElementId] = useState<string | null>(firstVideo?.id ?? null);
  const [currentPlayheadSec, setCurrentPlayheadSec] = useState(0);
  const previewRef = useRef<EditPreviewHandle>(null);
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const source = project.assets.find((asset) => asset.role === 'SOURCE');
  const selected = (project.elements ?? []).find((element) => element.id === selectedElementId);
  const availability = historyAvailability(history);

  const setProject = useCallback((next: EditProject | ((current: EditProject) => EditProject)) => {
    setProjectState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      projectRef.current = value;
      return value;
    });
  }, []);
  const refreshHistory = useCallback(async () => setHistory(await getEditHistory(initialProject.id)),
    [initialProject.id]);

  useEffect(() => () => { if (autosave.current) clearTimeout(autosave.current); }, []);

  const run = async (kind: 'upload' | 'import' | 'analyze', task: () => Promise<EditProject>) => {
    setBusy(kind); setError('');
    try { const next = await task(); setProject(next); await refreshHistory(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'EditMode action failed'); }
    finally { setBusy(null); }
  };

  const applyCommand = useCallback(async (command: ManualEditCommand, baseElements: EditElement[]) => {
    setBusy('saving'); setError('');
    try {
      let current = projectRef.current;
      let next: EditProject;
      try {
        next = await runManualEditCommand(current.id, current.revision, command);
      } catch (caught) {
        if (!(caught instanceof EditModeApiError) || caught.status !== 409) throw caught;
        const latest = await getEditProject(current.id);
        if (fingerprint(latest.elements ?? []) !== fingerprint(baseElements)) {
          setProject(latest);
          setError('This timeline changed in another session. The latest saved revision was restored; your pending edit was not overwritten.');
          return;
        }
        setProject(latest);
        next = await runManualEditCommand(latest.id, latest.revision, command);
      }
      setProject(next);
      if (selectedElementId && !(next.elements ?? []).some((element) => element.id === selectedElementId)) {
        setSelectedElementId(videoTrack(next.elements ?? [])[0]?.id ?? null);
      }
      setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(next.elements ?? [])));
      await refreshHistory();
    } catch (caught) {
      const latest = caught instanceof EditModeApiError && caught.status === 409
        ? await getEditProject(projectRef.current.id).catch(() => null) : null;
      if (latest) setProject(latest);
      setError(caught instanceof Error ? caught.message : 'Manual edit failed');
    } finally { setBusy(null); }
  }, [refreshHistory, selectedElementId, setProject]);

  const split = useCallback(() => {
    const elements = projectRef.current.elements ?? [];
    if (!selectedElementId) return;
    void applyCommand({ action: 'split', elementId: selectedElementId, playheadSec: currentPlayheadSec }, elements);
  }, [applyCommand, currentPlayheadSec, selectedElementId]);
  const remove = useCallback(() => {
    const elements = projectRef.current.elements ?? [];
    if (!selectedElementId) return;
    void applyCommand({ action: 'delete', elementId: selectedElementId }, elements);
  }, [applyCommand, selectedElementId]);
  const move = useCallback((delta: -1 | 1) => {
    const elements = projectRef.current.elements ?? [];
    const videos = videoTrack(elements);
    const position = videos.findIndex((element) => element.id === selectedElementId);
    if (!selectedElementId || position < 0) return;
    void applyCommand({ action: 'move', elementId: selectedElementId,
      toPosition: position + delta, track: 0 }, elements);
  }, [applyCommand, selectedElementId]);

  const travelHistory = useCallback(async (direction: 'undo' | 'redo') => {
    setBusy('saving'); setError('');
    try {
      const current = projectRef.current;
      const next = direction === 'undo' ? await undoEdit(current.id, current.revision)
        : await redoEdit(current.id, current.revision);
      setProject(next);
      const videos = videoTrack(next.elements ?? []);
      if (!videos.some((element) => element.id === selectedElementId)) setSelectedElementId(videos[0]?.id ?? null);
      setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(next.elements ?? [])));
      await refreshHistory();
    } catch (caught) {
      if (caught instanceof EditModeApiError && caught.status === 409) {
        const latest = await getEditProject(projectRef.current.id);
        setProject(latest);
        setError('Undo/redo stopped because a newer revision exists. The latest saved timeline was restored.');
      } else setError(caught instanceof Error ? caught.message : 'History action failed');
    } finally { setBusy(null); }
  }, [refreshHistory, selectedElementId, setProject]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault(); void travelHistory(event.shiftKey ? 'redo' : 'undo');
      } else if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault(); void travelHistory('redo');
      } else if (event.key === ' ') {
        event.preventDefault(); previewRef.current?.toggle();
      } else if (event.key.toLowerCase() === 's') {
        event.preventDefault(); split();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); remove();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [remove, split, travelHistory]);

  const commitTrim = (element: EditElement, before: EditElement[]) => {
    if (autosave.current) clearTimeout(autosave.current);
    setBusy('saving');
    autosave.current = setTimeout(() => {
      autosave.current = null;
      void applyCommand({ action: 'trim', elementId: element.id, trimStart: element.trimStart,
        trimEnd: element.trimEnd ?? element.trimStart + element.duration }, before);
    }, 500);
  };

  return <div className='grid gap-5'>
    <header className='flex flex-wrap items-center justify-between gap-4'>
      <div><p className='text-xs font-semibold uppercase tracking-[.18em] text-violet-300'>EditMode</p><h1 className='mt-1 text-2xl font-bold tracking-tight'>{project.name}</h1></div>
      <div className='flex items-center gap-2'>
        <span className='flex items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-xs text-slate-400'>{busy ? <LoaderCircle size={14} className='animate-spin' /> : <Check size={14} className='text-emerald-300' />}{busy === 'saving' ? 'Saving…' : busy ? 'Working…' : `Saved · r${project.revision}`}</span>
        <button disabled={!source || !!busy || !!source.analysis} onClick={() => void run('analyze', () => analyzeEditSource(project.id, project.revision))}
          className='flex items-center gap-2 rounded-xl bg-cyan-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40'><ScanSearch size={15} />Analyze source</button>
      </div>
    </header>
    {error && <div role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200'>{error}</div>}
    <div className='grid min-w-0 gap-5 xl:grid-cols-[250px_minmax(0,1fr)_280px]'>
      <EditAssetPicker source={source} busy={!!busy}
        onUpload={(file) => run('upload', () => uploadEditSource(project.id, project.revision, file))}
        onImport={(videoId) => run('import', () => importEditSource(project.id, project.revision, videoId))} />
      <EditPreview ref={previewRef} source={source} elements={project.elements ?? []}
        currentPlayheadSec={currentPlayheadSec} onPlayheadChange={setCurrentPlayheadSec}
        onSelect={setSelectedElementId} />
      <div className='grid content-start gap-5'><EditInspector project={project} source={source} selected={selected} /><EditHistoryPanel history={history} /></div>
    </div>
    <EditTimeline elements={project.elements ?? []} selectedElementId={selectedElementId}
      currentPlayheadSec={currentPlayheadSec} sourceDuration={source?.duration ?? 0} disabled={!!busy}
      canUndo={availability.canUndo} canRedo={availability.canRedo} onSelect={setSelectedElementId}
      onSeek={setCurrentPlayheadSec} onPreviewElements={(elements) => setProject((current) => ({ ...current, elements }))}
      onCommitTrim={commitTrim} onSplit={split} onDelete={remove} onMove={move}
      onUndo={() => void travelHistory('undo')} onRedo={() => void travelHistory('redo')} />
  </div>;
}
