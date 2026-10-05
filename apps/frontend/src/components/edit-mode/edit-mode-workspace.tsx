'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ScanSearch } from 'lucide-react';
import {
  analyzeEditSource, deleteEditAsset, editFailureMessage, EditModeApiError, getEditHistory, getEditProject,
  importEditSource, type ManualEditCommand, redoEdit, runManualEditCommand, undoEdit,
  uploadEditAsset, uploadEditSource
} from '@/lib/edit-mode-api';
import { historyAvailability, timelineDuration, videoTrack } from '@/lib/edit-mode-timeline';
import { cropInsetsFromRect, cropRectFromInsets, fitCropToAspect, inferCropPreset, setCropZoom,
  type CropAspectPreset, type CropRect } from '@/lib/edit-mode-crop';
import { readCropInsets } from '@/lib/edit-mode-transform';
import type { ChatApplyResult, EditAsset, EditElement, EditHistory, EditPresetApplyResult,
  EditProject, EditProjectStyle, EditTimeRange } from '@/lib/edit-mode-types';
import type { TemplateApplyResult } from '@/lib/edit-mode-templates';
import { EditPreview, type EditPreviewHandle } from './edit-preview';
import { EditTimeline } from './edit-timeline';
import { EditRightPanel, type RightTab } from './shell/edit-right-panel';
import { EditToolPanel } from './shell/edit-tool-panel';
import type { CropSession } from './shell/edit-crop-panel';
import { EditToolRail } from './shell/edit-tool-rail';
import { EditTopBar } from './shell/edit-top-bar';
import type { EditToolId } from '@/lib/edit-mode-tools';

/** Where a dragged timeline height is remembered (per browser, view state only). */
const TIMELINE_HEIGHT_KEY = 'edit-mode.timeline-height';
const TIMELINE_MIN_PX = 180;

const fingerprint = (elements: EditElement[]) => JSON.stringify(elements.map((element) => ({
  id: element.id, assetId: element.assetId, type: element.type, track: element.track,
  position: element.position, startTime: element.startTime, duration: element.duration,
  trimStart: element.trimStart, trimEnd: element.trimEnd, properties: element.properties
})).sort((a, b) => a.id.localeCompare(b.id)));

export function EditModeWorkspace({ initialProject, initialHistory, initialRightTab = 'INSPECTOR' }: {
  initialProject: EditProject;
  initialHistory: EditHistory[];
  initialRightTab?: RightTab;
}) {
  const [project, setProjectState] = useState(initialProject);
  const projectRef = useRef(initialProject);
  const savedElements = useRef(initialProject.elements ?? []);
  const [history, setHistory] = useState(initialHistory);
  const [busy, setBusy] = useState<'upload' | 'import' | 'analyze' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const firstVideo = videoTrack(initialProject.elements ?? [])[0];
  const [selectedElementId, setSelectedElementId] = useState<string | null>(firstVideo?.id ?? null);
  // The multi-selection foundation (Ctrl/Cmd-click on the timeline). It drives
  // Delete and Duplicate only: a group MOVE or TRIM would have to become one
  // canonical command per element, which is one undo step per element, so it is
  // deliberately not offered rather than faked.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Pure view state: the timeline band's height. Collapsing it gives the
  // preview the whole row on a short screen without changing anything stored.
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [currentPlayheadSec, setCurrentPlayheadSec] = useState(0);
  // Pure view state: a timeline height the user dragged to (null = the default band).
  const [timelineHeight, setTimelineHeight] = useState<number | null>(null);
  // The range dragged on the timeline ruler. It is passed straight to the AI
  // editor, so "delete this section" means the section the user pointed at.
  const [selectedRange, setSelectedRange] = useState<EditTimeRange | null>(null);
  const [exportPhase, setExportPhase] = useState<string | null>(null);
  // Which left category is open, and whether the export panel is showing. Both
  // are pure view state: neither touches the canonical project.
  const [activeTool, setActiveTool] = useState<EditToolId | null>('MEDIA');
  const [cropSession, setCropSession] = useState<CropSession | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // The colour clipboard. Pure view state: pasting is a normal typed command
  // that reads the SOURCE segment on the server, so a clipboard pointing at an
  // element that has since been deleted is refused rather than acted on.
  const [copiedAdjustmentsId, setCopiedAdjustmentsId] = useState<string | null>(null);
  const previewRef = useRef<EditPreviewHandle>(null);
  // Open on a frame that shows the clip as it will look - hook, speaker and a caption on screen -
  // rather than frame 0, which is often mid-transition or captionless.
  const openingFrameSet = useRef(false);
  useEffect(() => {
    const elements = project.elements ?? [];
    if (openingFrameSet.current || !elements.length) return;
    openingFrameSet.current = true;
    const end = timelineDuration(elements);
    const firstCaption = elements.filter((element) => element.type === 'SUBTITLE')
      .sort((a, b) => a.startTime - b.startTime)[0];
    const target = firstCaption ? firstCaption.startTime + Math.min(0.6, firstCaption.duration / 2)
      : Math.min(1, end / 2);
    setCurrentPlayheadSec((current) => current > 0 ? current : Math.max(0, Math.min(target, end - 0.05)));
  }, [project.elements]);
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(TIMELINE_HEIGHT_KEY));
      if (Number.isFinite(saved) && saved > 0) setTimelineHeight(saved);
    } catch { /* storage unavailable: keep the default band */ }
  }, []);
  const resizeTimeline = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const band = event.currentTarget.nextElementSibling as HTMLElement | null;
    const startHeight = band?.getBoundingClientRect().height ?? 280;
    let latest = startHeight;
    const move = (pointer: PointerEvent) => {
      // The preview keeps at least 260px; the band at least its toolbar and two rows.
      const max = Math.max(TIMELINE_MIN_PX, window.innerHeight - 52 - 260);
      latest = Math.round(Math.min(max, Math.max(TIMELINE_MIN_PX, startHeight + startY - pointer.clientY)));
      setTimelineHeight(latest);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { window.localStorage.setItem(TIMELINE_HEIGHT_KEY, String(latest)); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const autosave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const source = project.assets.find((asset) => asset.role === 'SOURCE');
  const selected = (project.elements ?? []).find((element) => element.id === selectedElementId);
  const availability = historyAvailability(history);
  // Ducking is built from the transcript already cached on this exact source by
  // "Analyze source". Nothing re-transcribes, so when that cache has no word
  // timings the Audio panel says ducking is unavailable instead of offering it.
  const duckingAvailable = Array.isArray((source?.transcript as {
    segments?: unknown[] } | null | undefined)?.segments)
    ? ((source?.transcript as { segments?: Array<{ words?: unknown[] }> }).segments ?? [])
      .some((segment) => Array.isArray(segment?.words) && segment.words.length > 0)
    : false;
  // The style block a preset persists on settings; absent until one is applied.
  const style = (project.settings && typeof project.settings === 'object' &&
    ('selectedPreset' in project.settings || 'aspectRatio' in project.settings)
    ? project.settings as unknown as EditProjectStyle : null);

  const beginCrop = useCallback((element: EditElement) => {
    const current = projectRef.current;
    const asset = current.assets.find((item) => item.id === element.assetId) ??
      current.assets.find((item) => item.role === 'SOURCE');
    const sourceWidth = asset?.width && asset.width > 0 ? asset.width : 1920;
    const sourceHeight = asset?.height && asset.height > 0 ? asset.height : 1080;
    const sourceAspect = sourceWidth / sourceHeight;
    const rect = cropRectFromInsets(readCropInsets(element.properties));
    const videos = videoTrack(current.elements ?? []);
    const compatible = videos.length <= 1 || Boolean(asset?.width && asset?.height) && videos.every((videoElement) => {
      const candidate = current.assets.find((item) => item.id === videoElement.assetId) ?? asset;
      return candidate?.width === asset?.width && candidate?.height === asset?.height;
    });
    previewRef.current?.pause();
    setCropSession({ elementId: element.id, sourceAssetId: asset?.id, rect,
      preset: inferCropPreset(rect, sourceAspect),
      sourceAspect, sourceWidth, sourceHeight, applyAll: false, applyAllCompatible: compatible });
  }, []);

  const selectTool = useCallback((tool: EditToolId | null) => {
    setActiveTool(tool);
    if (tool !== 'CROP') setCropSession(null);
    if (tool === 'CROP') {
      const current = projectRef.current.elements?.find((item) => item.id === selectedElementId);
      if (current?.type === 'VIDEO') beginCrop(current);
    }
  }, [beginCrop, selectedElementId]);

  useEffect(() => {
    if (activeTool !== 'CROP') return;
    const current = projectRef.current.elements?.find((item) => item.id === selectedElementId);
    if (current?.type === 'VIDEO' && cropSession?.elementId !== current.id) beginCrop(current);
  }, [activeTool, beginCrop, cropSession?.elementId, selectedElementId]);

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
    catch (caught) { setError(editFailureMessage(kind === 'analyze'
      ? 'ANALYSIS_FAILED' : 'EDIT_COMMAND_FAILED', caught)); }
    finally { setBusy(null); }
  };

  /**
   * Keeps the current selection across a server update.
   *
   * The selection is only dropped when the selected element is genuinely GONE -
   * not merely because it is not a VIDEO. The old rule sent the selection back
   * to the first clip after every undo, which made editing a caption or a text
   * element and then pressing Ctrl+Z close the inspector you were working in.
   */
  const keepSelection = useCallback((elements: EditElement[]) => {
    setSelectedElementId((current) => current &&
      elements.some((element) => element.id === current)
      ? current : videoTrack(elements)[0]?.id ?? null);
    // A multi-selection is pruned rather than kept: an id that no longer exists
    // would silently widen the next Delete.
    setSelectedIds((current) => {
      if (!current.length) return current;
      const alive = current.filter((id) => elements.some((element) => element.id === id));
      return alive.length === current.length ? current : alive;
    });
  }, []);

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
      // Generating captions creates hundreds of elements at once; selecting the
      // first of them is what makes the caption inspector immediately useful,
      // and it is also the only element the user could plausibly have meant.
      if (command.action === 'generate-captions') {
        const first = (next.elements ?? []).filter((element) => element.type === 'SUBTITLE')
          .sort((left, right) => left.startTime - right.startTime)[0];
        if (first) setSelectedElementId(first.id);
      }
      keepSelection(next.elements ?? []);
      setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(next.elements ?? [])));
      await refreshHistory();
    } catch (caught) {
      const latest = caught instanceof EditModeApiError && caught.status === 409
        ? await getEditProject(projectRef.current.id).catch(() => null) : null;
      if (latest) acceptServerProject(latest);
      setError(editFailureMessage('EDIT_COMMAND_FAILED', caught));
    } finally { setBusy(null); }
  }, [acceptServerProject, keepSelection, refreshHistory]);

  /** A group action runs as a SEQUENCE of ordinary commands, each with its own
   *  validation and its own undo step. Nothing here batches several elements
   *  into one revision, because no such command exists and inventing one would
   *  put a second, weaker mutation path beside applyElementCommand. */
  const applySequence = useCallback(async (commands: ManualEditCommand[]) => {
    for (const command of commands) await applyCommand(command);
  }, [applyCommand]);

  /** The elements a toolbar or keyboard action addresses: the multi-selection
   *  when there is one, otherwise the single selected element. Locked elements
   *  are dropped - that is what the lock is for. */
  const actionTargets = useCallback(() => {
    const elements = projectRef.current.elements ?? [];
    const ids = selectedIds.length > 1 ? selectedIds
      : selectedElementId ? [selectedElementId] : [];
    return ids.map((id) => elements.find((element) => element.id === id))
      .filter((element): element is EditElement => !!element &&
        element.properties.locked !== true);
  }, [selectedElementId, selectedIds]);

  /**
   * Split, wherever the cut was asked for.
   *
   * A clip and a caption are split by two different canonical commands, so the
   * timeline asks for "split this element here" and the dispatch happens once,
   * here, rather than in the toolbar, the razor tool and the keyboard shortcut.
   */
  const splitAt = useCallback((elementId: string, seconds: number) => {
    const elements = projectRef.current.elements ?? [];
    const target = elements.find((element) => element.id === elementId);
    if (!target || target.properties.locked === true) return;
    if (target.type === 'SUBTITLE') {
      void applyCommand({ action: 'split-caption', elementId, atSec: seconds }, elements);
      return;
    }
    if (target.type !== 'VIDEO') return;
    void applyCommand({ action: 'split', elementId, playheadSec: seconds }, elements);
  }, [applyCommand]);
  const split = useCallback(() => {
    if (selectedElementId) splitAt(selectedElementId, currentPlayheadSec);
  }, [currentPlayheadSec, selectedElementId, splitAt]);
  const remove = useCallback(() => {
    const targets = actionTargets();
    if (!targets.length) return;
    setSelectedIds([]);
    void applySequence(targets.map((target) => target.type === 'VIDEO'
      ? { action: 'delete', elementId: target.id }
      : { action: 'remove-element', elementId: target.id }));
  }, [actionTargets, applySequence]);
  const duplicate = useCallback(() => {
    // VIDEO is excluded because DUPLICATE_ELEMENT refuses it: a second copy of
    // a clip would have to be inserted into a sequential track at a position
    // nobody chose.
    const targets = actionTargets().filter((target) => target.type !== 'VIDEO');
    if (!targets.length) return;
    setSelectedIds([]);
    void applySequence(targets.map((target) =>
      ({ action: 'duplicate-element', elementId: target.id } as ManualEditCommand)));
  }, [actionTargets, applySequence]);
  const moveTo = useCallback((elementId: string, toPosition: number) => {
    const elements = projectRef.current.elements ?? [];
    const videos = videoTrack(elements);
    if (toPosition < 0 || toPosition >= videos.length) return;
    void applyCommand({ action: 'move', elementId, toPosition, track: 0 }, elements);
  }, [applyCommand]);

  const travelHistory = useCallback(async (direction: 'undo' | 'redo') => {
    setBusy('saving'); setError('');
    try {
      const current = projectRef.current;
      const next = direction === 'undo' ? await undoEdit(current.id, current.revision)
        : await redoEdit(current.id, current.revision);
      acceptServerProject(next);
      keepSelection(next.elements ?? []);
      setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(next.elements ?? [])));
      await refreshHistory();
    } catch (caught) {
      if (caught instanceof EditModeApiError && caught.status === 409) {
        const latest = await getEditProject(projectRef.current.id);
        acceptServerProject(latest);
        setError('Undo/redo stopped because a newer revision exists. The latest saved timeline was restored.');
      } else setError(caught instanceof Error ? caught.message : 'History action failed');
    } finally { setBusy(null); }
  }, [acceptServerProject, keepSelection, refreshHistory]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (cropSession) {
        if (event.key === 'Escape') { event.preventDefault(); setCropSession(null); setActiveTool(null); }
        return;
      }
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault(); void travelHistory(event.shiftKey ? 'redo' : 'undo');
      } else if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault(); void travelHistory('redo');
      } else if (command && event.key.toLowerCase() === 'd') {
        event.preventDefault(); duplicate();
      } else if (command) {
        // Every other Ctrl/Cmd chord belongs to the browser.
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
  }, [cropSession, duplicate, remove, split, travelHistory]);

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
  const setCropRect = useCallback((rect: CropRect) =>
    setCropSession((current) => current ? { ...current, rect } : current), []);
  const setCropPreset = useCallback((preset: CropAspectPreset) =>
    setCropSession((current) => current ? { ...current, preset,
      rect: fitCropToAspect(current.rect, preset, current.sourceAspect) } : current), []);
  const setCropEditorZoom = useCallback((zoom: number) =>
    setCropSession((current) => current ? { ...current,
      rect: setCropZoom(current.rect, current.preset, current.sourceAspect, zoom) } : current), []);
  const resetCrop = useCallback(() => setCropSession((current) => current ? { ...current,
    rect: fitCropToAspect({ x: 0, y: 0, width: 1, height: 1 },
      current.preset, current.sourceAspect) } : current), []);
  const cancelCrop = useCallback(() => { setCropSession(null); setActiveTool(null); }, []);
  const doneCrop = useCallback(() => {
    if (!cropSession) return;
    const crop = cropInsetsFromRect(cropSession.rect);
    void applyCommand({ action: 'set-video-crop', elementId: cropSession.elementId,
      scope: cropSession.applyAll ? 'ALL_VIDEO_SEGMENTS' : 'CURRENT_VIDEO_SEGMENT',
      cropLeft: crop.left, cropRight: crop.right, cropTop: crop.top, cropBottom: crop.bottom });
    setCropSession(null); setActiveTool(null);
  }, [applyCommand, cropSession]);
  /**
   * One pointer gesture in the preview becomes exactly one command, issued on
   * release. Rotation reuses the existing SET_VIDEO_ROTATION command, which now
   * accepts TEXT and captions too, rather than adding a parallel one.
   */
  const commitTransform = useCallback((kind: 'move' | 'resize' | 'rotate', element: EditElement,
    before: EditElement[]) => {
    const properties = element.properties;
    if (kind === 'rotate') {
      void applyCommand({ action: 'set-video-rotation', elementId: element.id,
        rotation: Number(properties.rotation ?? 0) }, before);
      return;
    }
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
    keepSelection(result.project.elements ?? []);
    setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(result.project.elements ?? [])));
    void refreshHistory();
  }, [acceptServerProject, keepSelection, refreshHistory]);

  /**
   * An applied TEMPLATE is one TEMPLATE revision, accepted exactly like a preset
   * application. There is no template-specific state to keep in sync, because a
   * template writes into the same canonical project everything else writes to.
   */
  const templateApplied = useCallback((result: TemplateApplyResult) => {
    setError('');
    acceptServerProject(result.project);
    keepSelection(result.project.elements ?? []);
    setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(result.project.elements ?? [])));
    void refreshHistory();
  }, [acceptServerProject, keepSelection, refreshHistory]);

  // An applied chat turn is one ASSISTANT revision, so it is accepted exactly
  // like a preset application: take the server's project and refresh history.
  const chatApplied = useCallback((result: ChatApplyResult) => {
    setError('');
    acceptServerProject(result.project);
    const created = result.affectedElementIds.find((id) =>
      (result.project.elements ?? []).some((element) => element.id === id));
    if (created) setSelectedElementId(created);
    else keepSelection(result.project.elements ?? []);
    setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(result.project.elements ?? [])));
    void refreshHistory();
  }, [acceptServerProject, keepSelection, refreshHistory]);

  // The agent edits the canonical project itself (one or more ASSISTANT/TEMPLATE
  // revisions). The workspace simply reloads the persisted project: persisted
  // state wins over anything the panel might believe.
  const agentEdited = useCallback(async () => {
    setError('');
    try {
      const fresh = await getEditProject(projectRef.current.id);
      acceptServerProject(fresh);
      keepSelection(fresh.elements ?? []);
      setCurrentPlayheadSec((time) => Math.min(time, timelineDuration(fresh.elements ?? [])));
      void refreshHistory();
    } catch (caught) { setError(editFailureMessage('PROJECT_LOAD_FAILED', caught)); }
  }, [acceptServerProject, keepSelection, refreshHistory]);

  const addAsset = (asset: EditAsset) => {
    const action = asset.role === 'AUDIO' ? 'add-audio' : asset.role === 'LOGO' ? 'add-logo' : 'add-image';
    void applyCommand({ action, assetId: asset.id });
  };

  return <div className='flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-[#070a12] text-[#f8fafc]'>
    <EditTopBar projectName={project.name} revision={project.revision} busy={busy}
      exportPhase={exportPhase} canUndo={availability.canUndo} canRedo={availability.canRedo}
      aspectRatio={style?.aspectRatio ?? 'SOURCE'}
      onUndo={() => void travelHistory('undo')} onRedo={() => void travelHistory('redo')}
      onExport={() => setExportOpen(true)} exportDisabled={!source || !!busy} />

    {error && <div role='alert'
      className='shrink-0 border-b border-red-400/20 bg-red-400/10 px-4 py-2 text-xs text-red-200'>
      {error}</div>}

    {/* Rail, optional tool panel, preview and inspector share one row; the
        timeline takes the bottom band. Only this row scrolls internally, so the
        editor itself never grows a page scrollbar. */}
    <div className='relative flex min-h-0 flex-1'>
      <EditToolRail active={activeTool} cropDisabled={!!busy || selected?.type !== 'VIDEO'}
        onSelect={selectTool} />
      {activeTool && <EditToolPanel tool={activeTool} assets={project.assets}
        elements={project.elements ?? []} busy={!!busy} hasSource={!!source}
        projectId={project.id} revision={project.revision}
        onTemplateApplied={templateApplied}
        onError={(message) => setError(`PREVIEW_LAYOUT_FAILED: ${message}`)}
        selectedElementId={selectedElementId} playheadSec={currentPlayheadSec}
        duckingAvailable={duckingAvailable} copiedAdjustmentsId={copiedAdjustmentsId}
        onClose={() => selectTool(null)}
        onSelectElement={setSelectedElementId}
        onCommand={(command) => void applyCommand(command)}
        onPreviewElement={previewElement} cropSession={cropSession}
        onCropPreset={setCropPreset} onCropZoom={setCropEditorZoom} onCropReset={resetCrop}
        onCropApplyAll={(checked) => setCropSession((current) => current
          ? { ...current, applyAll: checked && current.applyAllCompatible } : current)}
        onCropCancel={cancelCrop} onCropDone={doneCrop}
        onCopyAdjustments={setCopiedAdjustmentsId}
        onUploadSource={(file) => run('upload', () => uploadEditSource(project.id, project.revision, file))}
        onImportSource={(videoId) => run('import', () => importEditSource(project.id, project.revision, videoId))}
        onUploadAsset={(role, file) => void uploadLibraryAsset(role, file)}
        onAddAsset={addAsset} onDeleteAsset={(asset) => void deleteLibraryAsset(asset)} />}

      <main className='flex min-w-0 flex-1 flex-col bg-[#05070d]'>
        <div className='flex min-h-0 flex-1 items-center justify-center p-2'>
          <EditPreview ref={previewRef} source={source} assets={project.assets}
            aspectRatio={style?.aspectRatio} reframePolicy={style?.reframePolicy}
            fitBackground={typeof (project.settings as Record<string, unknown> | undefined)?.fitBackground === 'string'
              ? String((project.settings as Record<string, unknown>).fitBackground) : undefined}
            resolvedVisualLayout={(project.settings as Record<string, unknown> | undefined)
              ?.resolvedVisualLayout as { editingProfile?: string; videoFrame?: {
                x: number; y: number; width: number; height: number; mode: string };
                cameraPath?: Array<{ t: number; x: number; y: number; w: number; h: number }> } | undefined}
            elements={project.elements ?? []}
            selectedElementId={selectedElementId}
            currentPlayheadSec={currentPlayheadSec} onPlayheadChange={setCurrentPlayheadSec}
            onSelect={setSelectedElementId}
            onPreviewElements={(elements) => setProject((current) => ({ ...current, elements }))}
            onCommitTransform={commitTransform}
            cropEditor={cropSession ? { rect: cropSession.rect, preset: cropSession.preset,
              sourceAspect: cropSession.sourceAspect, sourceWidth: cropSession.sourceWidth,
              sourceHeight: cropSession.sourceHeight, sourceAssetId: cropSession.sourceAssetId,
              onChange: setCropRect } : null} />
        </div>
        {source && !source.analysis && <div className='shrink-0 border-t border-white/10 px-3 py-2'>
          <button disabled={!!busy}
            onClick={() => void run('analyze', () => analyzeEditSource(project.id, project.revision))}
            className='flex items-center gap-1.5 rounded-lg border border-cyan-300/25 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40'>
            <ScanSearch size={13} />Analyze source</button>
        </div>}
      </main>

      <EditRightPanel project={project} source={source} selected={selected} style={style}
        history={history} busy={!!busy} selectedElementId={selectedElementId}
        selectedTimeRange={selectedRange} playheadSec={currentPlayheadSec} exportOpen={exportOpen}
        onPreview={previewElement} onCommit={(command) => void applyCommand(command)}
        onDebounced={debouncedCommand}
        onDuplicate={duplicate} onDelete={remove} onPresetApplied={presetApplied} onChatApplied={chatApplied}
        onAgentEdited={() => void agentEdited()} initialTab={initialRightTab}
        onReviewPreview={(range) => { setSelectedRange(range); setCurrentPlayheadSec(range.startSec); }}
        onExportStatus={refreshProject} onExportPhase={setExportPhase} onError={setError}
        onCloseExport={() => setExportOpen(false)} />
    </div>

    {/* The timeline is a fixed bottom band rather than a card in the page flow:
        it is a primary editing surface, not a summary of one. It keeps the
        professional ~⅓-of-the-screen proportion, floors at a height that still
        shows every track on a 1366x768 screen, and can be collapsed to its
        toolbar when the preview needs the room. It never overlays the preview
        or the top bar - the three are siblings in one column. */}
    {!timelineCollapsed && <div role='separator' aria-orientation='horizontal' aria-label='Resize timeline'
      title='Drag to resize the preview and timeline' onPointerDown={resizeTimeline}
      onDoubleClick={() => { setTimelineHeight(null);
        try { window.localStorage.removeItem(TIMELINE_HEIGHT_KEY); } catch { /* ignore */ } }}
      className='group relative z-10 h-1.5 shrink-0 cursor-row-resize bg-transparent hover:bg-violet-400/30'>
      <span aria-hidden className='absolute left-1/2 top-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/15 group-hover:bg-violet-300/70' />
    </div>}
    <div style={!timelineCollapsed && timelineHeight ? { height: `${timelineHeight}px` } : undefined}
      className={`shrink-0 overflow-hidden border-t border-white/10 bg-[#0b0f1a] ${
      timelineCollapsed ? 'h-auto' : timelineHeight ? '' : 'h-[38vh] min-h-[248px] max-h-[440px]'}`}>
      <EditTimeline elements={project.elements ?? []} assets={project.assets}
        selectedElementId={selectedElementId} selectedIds={selectedIds}
        currentPlayheadSec={currentPlayheadSec} sourceDuration={source?.duration ?? 0}
        disabled={!!busy || !!cropSession}
        canUndo={availability.canUndo} canRedo={availability.canRedo}
        selectedRange={selectedRange} collapsed={timelineCollapsed}
        onSelectRange={setSelectedRange} onSelect={setSelectedElementId}
        onSelectMany={setSelectedIds} onSeek={setCurrentPlayheadSec}
        onPreviewElements={(elements) => setProject((current) => ({ ...current, elements }))}
        onCommitTrim={commitTrim} onCommitTiming={commitTiming} onSplitAt={splitAt}
        onDelete={remove} onDuplicate={duplicate} onMoveTo={moveTo}
        onCommand={(command) => void applyCommand(command)}
        onToggleCollapsed={() => setTimelineCollapsed((value) => !value)}
        onUndo={() => void travelHistory('undo')} onRedo={() => void travelHistory('redo')} />
    </div>
  </div>;
}
