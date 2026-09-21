'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Plus, ScanSearch, TriangleAlert } from 'lucide-react';
import {
  analyzeEditSource, deleteEditAsset, EditModeApiError, getEditHistory, getEditProject,
  importEditSource, type ManualEditCommand, redoEdit, runManualEditCommand, undoEdit,
  uploadEditAsset, uploadEditSource
} from '@/lib/edit-mode-api';
import { historyAvailability, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';
import type { ChatApplyResult, EditAsset, EditElement, EditHistory, EditPresetApplyResult,
  EditProject, EditProjectStyle, EditTimeRange } from '@/lib/edit-mode-types';
import { EditAssetPicker } from './edit-asset-picker';
import { EditChatPanel } from './edit-chat-panel';
import { EditExportPanel } from './edit-export-panel';
import { EditPresetPanel } from './edit-preset-panel';
import { EditHistoryPanel } from './edit-history-panel';
import { EditInspector } from './edit-inspector';
import { EditPreview, type EditPreviewHandle } from './edit-preview';
import { EditTimeline } from './edit-timeline';

/**
 * One status at a time, in a fixed order of precedence.
 *
 * Export runs in the background and the editor stays usable while it does, so
 * both an export phase and a local save can be true at once. Rather than show
 * two competing spinners, the more specific local action wins and the export
 * phase is shown only when nothing local is in flight.
 */
function StatusBadge({ busy, exportPhase, revision }: {
  busy: 'upload' | 'import' | 'analyze' | 'saving' | null;
  exportPhase: string | null;
  revision: number;
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
  const working = !!busy || (!!exportPhase && exportPhase !== 'COMPLETED' &&
    exportPhase !== 'FAILED');
  const failed = !busy && exportPhase === 'FAILED';
  return <span role='status' className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs ${
    failed ? 'border-red-400/25 text-red-200' : 'border-white/10 text-slate-400'}`}>
    {working ? <LoaderCircle size={14} className='animate-spin' />
      : failed ? <TriangleAlert size={14} className='text-red-300' />
        : <Check size={14} className='text-emerald-300' />}{label}</span>;
}

const fingerprint = (elements: EditElement[]) => JSON.stringify(elements.map((element) => ({
  id: element.id, assetId: element.assetId, type: element.type, track: element.track,
  position: element.position, startTime: element.startTime, duration: element.duration,
  trimStart: element.trimStart, trimEnd: element.trimEnd, properties: element.properties
})).sort((a, b) => a.id.localeCompare(b.id)));

export function EditModeWorkspace({ initialProject, initialHistory }: {
  initialProject: EditProject;
  initialHistory: EditHistory[];
}) {
  const [project, setProjectState] = useState(initialProject);
  const projectRef = useRef(initialProject);
  const savedElements = useRef(initialProject.elements ?? []);
  const [history, setHistory] = useState(initialHistory);
  const [busy, setBusy] = useState<'upload' | 'import' | 'analyze' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const firstVideo = videoTrack(initialProject.elements ?? [])[0];
  const [selectedElementId, setSelectedElementId] = useState<string | null>(firstVideo?.id ?? null);
  const [currentPlayheadSec, setCurrentPlayheadSec] = useState(0);
  // The range dragged on the timeline ruler. It is passed straight to the AI
  // editor, so "delete this section" means the section the user pointed at.
  const [selectedRange, setSelectedRange] = useState<EditTimeRange | null>(null);
  const [exportPhase, setExportPhase] = useState<string | null>(null);
  const previewRef = useRef<EditPreviewHandle>(null);
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const source = project.assets.find((asset) => asset.role === 'SOURCE');
  const selected = (project.elements ?? []).find((element) => element.id === selectedElementId);
  const availability = historyAvailability(history);
  // The style block a preset persists on settings; absent until one is applied.
  const style = (project.settings && typeof project.settings === 'object' &&
    'selectedPreset' in project.settings
    ? project.settings as unknown as EditProjectStyle : null);

  const setProject = useCallback((next: EditProject | ((current: EditProject) => EditProject)) => {
    setProjectState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      projectRef.current = value;
      return value;
    });
  }, []);
  const acceptServerProject = useCallback((next: EditProject) => {
    savedElements.current = next.elements ?? [];
    // Any committed change can move the seconds a range referred to, so the
    // selection is dropped rather than left pointing somewhere it no longer
    // means. Re-dragging it is one gesture; acting on a stale one is a bad cut.
    setSelectedRange(null);
    setProject(next);
  }, [setProject]);
  const refreshHistory = useCallback(async () => setHistory(await getEditHistory(initialProject.id)),
    [initialProject.id]);
  // An export changes the project's status but never its revision or elements,
  // so it is refreshed on its own rather than through the edit-command path.
  const refreshProject = useCallback(() => {
    void getEditProject(initialProject.id)
      .then((next) => setProject((current) => ({ ...next, elements: current.elements })))
      .catch(() => undefined);
  }, [initialProject.id, setProject]);

  useEffect(() => () => { if (autosave.current) clearTimeout(autosave.current); }, []);

  const run = async (kind: 'upload' | 'import' | 'analyze', task: () => Promise<EditProject>) => {
    setBusy(kind); setError('');
    try { const next = await task(); acceptServerProject(next); await refreshHistory(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'EditMode action failed'); }
    finally { setBusy(null); }
  };

  const applyCommand = useCallback(async (command: ManualEditCommand, baseElements = savedElements.current) => {
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
          acceptServerProject(latest);
          setError('This timeline changed in another session. The latest saved revision was restored; your pending edit was not overwritten.');
          return;
        }
        acceptServerProject(latest);
        next = await runManualEditCommand(latest.id, latest.revision, command);
      }
      const priorIds = new Set(baseElements.map((element) => element.id));
      acceptServerProject(next);
      if (command.action.startsWith('add-') || command.action === 'duplicate-element') {
        const created = (next.elements ?? []).find((element) => !priorIds.has(element.id));
        if (created) setSelectedElementId(created.id);
      }
      if (selectedElementId && !(next.elements ?? []).some((element) => element.id === selectedElementId)) {
        setSelectedElementId(videoTrack(next.elements ?? [])[0]?.id ?? null);
      }
      setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(next.elements ?? [])));
      await refreshHistory();
    } catch (caught) {
      const latest = caught instanceof EditModeApiError && caught.status === 409
        ? await getEditProject(projectRef.current.id).catch(() => null) : null;
      if (latest) acceptServerProject(latest);
      setError(caught instanceof Error ? caught.message : 'Manual edit failed');
    } finally { setBusy(null); }
  }, [acceptServerProject, refreshHistory, selectedElementId]);

  const split = useCallback(() => {
    const elements = projectRef.current.elements ?? [];
    if (!selectedElementId) return;
    void applyCommand({ action: 'split', elementId: selectedElementId, playheadSec: currentPlayheadSec }, elements);
  }, [applyCommand, currentPlayheadSec, selectedElementId]);
  const remove = useCallback(() => {
    const elements = projectRef.current.elements ?? [];
    if (!selectedElementId) return;
    const target = elements.find((element) => element.id === selectedElementId);
    if (!target) return;
    void applyCommand(target.type === 'VIDEO' ? { action: 'delete', elementId: selectedElementId }
      : { action: 'remove-element', elementId: selectedElementId });
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
      acceptServerProject(next);
      const videos = videoTrack(next.elements ?? []);
      if (!videos.some((element) => element.id === selectedElementId)) setSelectedElementId(videos[0]?.id ?? null);
      setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(next.elements ?? [])));
      await refreshHistory();
    } catch (caught) {
      if (caught instanceof EditModeApiError && caught.status === 409) {
        const latest = await getEditProject(projectRef.current.id);
        acceptServerProject(latest);
        setError('Undo/redo stopped because a newer revision exists. The latest saved timeline was restored.');
      } else setError(caught instanceof Error ? caught.message : 'History action failed');
    } finally { setBusy(null); }
  }, [acceptServerProject, refreshHistory, selectedElementId]);

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

  const previewElement = useCallback((element: EditElement) => setProject((current) => ({ ...current,
    elements: (current.elements ?? []).map((item) => item.id === element.id ? element : item)
  })), [setProject]);
  const commitTransform = useCallback((kind: 'move' | 'resize', element: EditElement,
    before: EditElement[]) => {
    const properties = element.properties;
    void applyCommand(kind === 'move'
      ? { action: 'move-element', elementId: element.id, x: Number(properties.x), y: Number(properties.y) }
      : { action: 'resize-element', elementId: element.id, width: Number(properties.width),
          height: Number(properties.height) }, before);
  }, [applyCommand]);
  const commitTiming = useCallback((element: EditElement, before: EditElement[]) => {
    void applyCommand({ action: 'set-element-timing', elementId: element.id,
      startTime: element.startTime, duration: element.duration, trimStart: element.trimStart,
      ...(element.trimEnd == null ? {} : { trimEnd: element.trimEnd }) }, before);
  }, [applyCommand]);
  const debouncedCommand = useCallback((command: ManualEditCommand) => {
    if (autosave.current) clearTimeout(autosave.current);
    autosave.current = setTimeout(() => { autosave.current = null; void applyCommand(command); }, 500);
  }, [applyCommand]);
  const uploadLibraryAsset = async (role: 'IMAGE' | 'LOGO' | 'AUDIO', file: File) => {
    setBusy('upload'); setError('');
    try { const current = projectRef.current; await uploadEditAsset(current.id, current.revision, role, file);
      acceptServerProject(await getEditProject(current.id)); await refreshHistory(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Asset upload failed'); }
    finally { setBusy(null); }
  };
  const deleteLibraryAsset = async (asset: EditAsset) => {
    setBusy('saving'); setError('');
    try { const current = projectRef.current; await deleteEditAsset(current.id, current.revision, asset.id);
      acceptServerProject(await getEditProject(current.id)); await refreshHistory(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Asset delete failed'); }
    finally { setBusy(null); }
  };
  const presetApplied = useCallback((result: EditPresetApplyResult) => {
    setError('');
    acceptServerProject(result.project);
    const videos = videoTrack(result.project.elements ?? []);
    if (!videos.some((element) => element.id === selectedElementId)) {
      setSelectedElementId(videos[0]?.id ?? null);
    }
    setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(result.project.elements ?? [])));
    void refreshHistory();
  }, [acceptServerProject, refreshHistory, selectedElementId]);

  // An applied chat turn is one ASSISTANT revision, so it is accepted exactly
  // like a preset application: take the server's project and refresh history.
  const chatApplied = useCallback((result: ChatApplyResult) => {
    setError('');
    acceptServerProject(result.project);
    const created = result.affectedElementIds.find((id) =>
      (result.project.elements ?? []).some((element) => element.id === id));
    const videos = videoTrack(result.project.elements ?? []);
    if (created) setSelectedElementId(created);
    else if (!videos.some((element) => element.id === selectedElementId)) {
      setSelectedElementId(videos[0]?.id ?? null);
    }
    setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(result.project.elements ?? [])));
    void refreshHistory();
  }, [acceptServerProject, refreshHistory, selectedElementId]);

  const addAsset = (asset: EditAsset) => {
    const action = asset.role === 'AUDIO' ? 'add-audio' : asset.role === 'LOGO' ? 'add-logo' : 'add-image';
    void applyCommand({ action, assetId: asset.id });
  };

  return <div className='grid gap-5'>
    <header className='flex flex-wrap items-center justify-between gap-4'>
      <div><p className='text-xs font-semibold uppercase tracking-[.18em] text-violet-300'>EditMode</p><h1 className='mt-1 text-2xl font-bold tracking-tight'>{project.name}</h1></div>
      <div className='flex items-center gap-2'>
        <StatusBadge busy={busy} exportPhase={exportPhase} revision={project.revision} />
        <button disabled={!source || !!busy || !!source.analysis} onClick={() => void run('analyze', () => analyzeEditSource(project.id, project.revision))}
          className='flex items-center gap-2 rounded-xl bg-cyan-400 px-3 py-2 text-xs font-bold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40'><ScanSearch size={15} />Analyze source</button>
        <button disabled={!source || !!busy} onClick={() => void applyCommand({ action: 'add-text' })}
          className='flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold disabled:opacity-40'><Plus size={14} />Text</button>
      </div>
    </header>
    {error && <div role='alert' className='rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200'>{error}</div>}
    <div className='grid min-w-0 gap-5 xl:grid-cols-[250px_minmax(0,1fr)_320px]'>
      <EditAssetPicker assets={project.assets} busy={!!busy}
        onUploadSource={(file) => run('upload', () => uploadEditSource(project.id, project.revision, file))}
        onImport={(videoId) => run('import', () => importEditSource(project.id, project.revision, videoId))}
        onUploadAsset={uploadLibraryAsset} onAdd={addAsset} onDelete={(asset) => void deleteLibraryAsset(asset)} />
      <EditPreview ref={previewRef} source={source} assets={project.assets}
        aspectRatio={style?.aspectRatio} elements={project.elements ?? []}
        selectedElementId={selectedElementId}
        currentPlayheadSec={currentPlayheadSec} onPlayheadChange={setCurrentPlayheadSec}
        onSelect={setSelectedElementId} onPreviewElements={(elements) => setProject((current) => ({ ...current, elements }))}
        onCommitTransform={commitTransform} />
      <div className='grid content-start gap-5'><EditChatPanel projectId={project.id}
        revision={project.revision} hasSource={!!source} disabled={!!busy}
        selectedElementId={selectedElementId} selectedTimeRange={selectedRange}
        playheadSec={currentPlayheadSec} onApplied={chatApplied} onError={setError} /><EditPresetPanel projectId={project.id}
        revision={project.revision} style={style} disabled={!!busy} hasSource={!!source}
        onApplied={presetApplied} onError={setError} /><EditExportPanel projectId={project.id}
        revision={project.revision} hasSource={!!source} disabled={!!busy}
        onStatusChange={refreshProject} onPhaseChange={setExportPhase} /><EditInspector project={project} source={source} selected={selected}
        onPreview={previewElement} onCommit={(command) => void applyCommand(command)} onDebounced={debouncedCommand}
        onDuplicate={() => selectedElementId && void applyCommand({ action: 'duplicate-element', elementId: selectedElementId })}
        onDelete={remove} /><EditHistoryPanel history={history} /></div>
    </div>
    <EditTimeline elements={project.elements ?? []} selectedElementId={selectedElementId}
      currentPlayheadSec={currentPlayheadSec} sourceDuration={source?.duration ?? 0} disabled={!!busy}
      canUndo={availability.canUndo} canRedo={availability.canRedo}
      selectedRange={selectedRange} onSelectRange={setSelectedRange} onSelect={setSelectedElementId}
      onSeek={setCurrentPlayheadSec} onPreviewElements={(elements) => setProject((current) => ({ ...current, elements }))}
      onCommitTrim={commitTrim} onCommitTiming={commitTiming} onSplit={split} onDelete={remove} onMove={move}
      onUndo={() => void travelHistory('undo')} onRedo={() => void travelHistory('redo')} />
  </div>;
}
